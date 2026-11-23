/**
 * M-4 importer CLI: organizations, stores, contacts and catalogues from the refreshed legacy copy.
 *
 * On the staging host (a Hermes card runs it):
 *   node dist/tools/legacy-import/src/m4-cli.js plan
 *   node dist/tools/legacy-import/src/m4-cli.js write
 *
 * The CLI takes the refresh's lock itself, shared and without waiting, and holds it until it
 * exits: the refresh identity and every legacy table are read under it, so the copy cannot
 * change mid-run. A refresh holding the lock makes the run refuse (exit 2).
 *
 *   plan   Reads the legacy copy and maps every table. Writes nothing to the platform. Publishes
 *          the plan receipt with the plan identity: a sha256 over the importer revision, the
 *          refresh read, and every mapped row's legacy id and digest.
 *   write  Refuses unless M4_EXPECTED_PLAN equals the plan identity it finds now (so it imports
 *          exactly what the reviewed plan showed) and the target database's
 *          legacy_import_target row says staging (migration 0652). Then it replaces the write
 *          receipt with `started` before the first write, imports in order (catalogues,
 *          companies, brand links, stores, contacts) and replaces it with the outcome. A run
 *          that fails after some steps committed ends `failed`, naming the steps that did, so
 *          it can never read as an earlier pass.
 *
 * Receipts (M4_PLAN_RECEIPT, M4_WRITE_RECEIPT) carry the revision, refresh identity, plan
 * identity, status and per-step counts and rule codes; no legacy id or value. The private report
 * (M4_REPORT_PATH) also lists legacy ids by rule and stays on the host. All files are written
 * whole (temporary file, then rename), mode 600. Errors print fixed codes only.
 * Exit 0 ok, 3 when a write step refused rows or found conflicts, 2 refused before any write,
 * 1 failed.
 *
 * Environment:
 *   M4_LEGACY_MIRROR_URL   mysql://user:pass@host:port/legacy_mirror (read-only account)
 *   M4_REVISION            the 40-character platform commit this importer was built from
 *   LEGACY_REFRESH_REPORT  the refresh's last-run.json; the run refuses unless it says ok
 *   LEGACY_REFRESH_LOCK    the refresh's lock file
 *   M4_REPORT_PATH, M4_PLAN_RECEIPT, M4_WRITE_RECEIPT   defaults under /var/lib/legacy-import
 * For write only:
 *   M4_EXPECTED_PLAN       the plan identity from the reviewed plan receipt
 *   M4_DATABASE_URL        staging PostgreSQL
 *   M4_IMPORT_ACTOR        sha256 hex recorded as the creator of imported rows
 *   M4_OPERATOR_ORG_ID     the operator organization top-level companies hang under
 */

import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PostgresCatalogueImportStore, PostgresContactImportStore, PostgresOrganizationImportStore, PostgresStoreImportStore } from "@studenthub/db/import";
import { ORGANIZATION_PARITY_REVISION } from "@studenthub/organizations";
import { DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH, lockPathFrom, parseDatabaseUrl } from "./refresh.js";
import { refreshIdentity } from "./twin/cli.js";
import type { RefreshIdentity } from "./twin/report.js";
import type { LegacyReader } from "./twin/journey.js";
import { mirrorReader } from "./twin/staging.js";
import { planIdentity, planM4, readM4Sources, receiptSafe, receiptStep, runM4, type M4Report, type M4Step, type M4Writers, type ReceiptStep } from "./m4-run.js";

export const DEFAULT_M4_REPORT_PATH = "/var/lib/legacy-import/m4-last-run.json";
export const DEFAULT_M4_PLAN_RECEIPT = "/var/lib/legacy-import/m4-plan-receipt.json";
export const DEFAULT_M4_WRITE_RECEIPT = "/var/lib/legacy-import/m4-write-receipt.json";

export function m4Writers(pool: pg.Pool, actorRef: string, operatorOrgId: string): M4Writers {
  const catalogue = new PostgresCatalogueImportStore(pool, actorRef);
  const organizations = new PostgresOrganizationImportStore(pool, ORGANIZATION_PARITY_REVISION, operatorOrgId);
  const stores = new PostgresStoreImportStore(pool, actorRef);
  const contacts = new PostgresContactImportStore(pool, actorRef);
  return {
    catalogue: (_table, items, now) => catalogue.importItems(items, now),
    companies: (rows) => organizations.importOrganizations(rows),
    brandLinks: (rows) => stores.importBrandLinks(rows),
    stores: (rows, now) => stores.importStores(rows, now),
    contacts: (rows, now) => contacts.importContacts(rows, now),
  };
}

/** Our own fixed codes (`m4.read.store`, `m4.report.unsafeRefusal`) pass; anything else, which may quote legacy values, prints as `m4.failed`. */
export function errorCode(error: unknown): string {
  return error instanceof Error && /^m4(?:\.[A-Za-z_]+)+$/.test(error.message) ? error.message : "m4.failed";
}

/** One line per step: counts and rule codes only. */
export function receipt(report: M4Report): string[] {
  return report.steps.map((s) => {
    const rules = Object.entries(s.rules).map(([rule, n]) => `${rule}=${n}`).join(" ");
    const w = s.write;
    const write = w ? ` inserted=${w.inserted} merged=${w.merged} adopted=${w.adopted} unchanged=${w.unchanged} conflicts=${w.conflicts.length} refused=${Object.values(w.refused).reduce((n, ids) => n + ids.length, 0)}` : "";
    return `${s.step} legacy=${s.legacy} mapped=${s.mapped}${write}${rules ? ` ${rules}` : ""}`;
  });
}

export interface M4Receipt {
  readonly schemaVersion: 1;
  readonly kind: "plan" | "write";
  readonly status: "ok" | "started" | "refused_rows" | "failed";
  readonly revision: string;
  readonly refresh: RefreshIdentity;
  readonly plan: string;
  readonly at: string;
  readonly steps: readonly ReceiptStep[];
  /** For a failed run: the fixed code. */
  readonly code?: string;
}

/** Writes the whole file or nothing: a temporary file beside it, mode 600, then a rename. */
export function writeWhole(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export type SharedLock = { readonly held: true; readonly release: () => void } | { readonly held: false };

/** The refresh's lock, shared and without waiting: the refresh takes it exclusively. Kept until release. */
export function acquireSharedLock(lockPath: string): Promise<SharedLock> {
  return new Promise((resolve) => {
    let fd: number;
    try { fd = openSync(lockPath, "r"); } catch { return resolve({ held: false }); }
    let settled = false;
    const settle = (held: boolean) => {
      if (settled) return;
      settled = true;
      if (!held) { closeSync(fd); return resolve({ held: false }); }
      resolve({ held: true, release: () => closeSync(fd) });
    };
    const helper = spawn("flock", ["--shared", "--nonblock", "3"], { env: { PATH: process.env.PATH, LANG: "C" }, stdio: ["ignore", "ignore", "ignore", fd] });
    helper.on("error", () => settle(false));
    helper.on("close", (code) => settle(code === 0));
  });
}

export interface WriteTarget {
  /** The legacy_import_target row's environment, or null when the database has none. */
  environment(): Promise<string | null>;
  writers(): M4Writers;
  close(): Promise<void>;
}

export function postgresTarget(url: string, actorRef: string, operatorOrgId: string): WriteTarget {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  return {
    environment: async () => {
      try {
        const { rows } = await pool.query<{ environment: string }>("SELECT environment FROM legacy_import_target");
        return rows.length === 1 ? rows[0]!.environment : null;
      } catch { return null; }
    },
    writers: () => m4Writers(pool, actorRef, operatorOrgId),
    close: () => pool.end(),
  };
}

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly lock: (lockPath: string) => Promise<SharedLock>;
  readonly reader: (env: NodeJS.ProcessEnv) => LegacyReader;
  readonly target: (env: NodeJS.ProcessEnv) => WriteTarget;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export const defaultDeps = (env: NodeJS.ProcessEnv): CliDeps => ({
  env,
  lock: acquireSharedLock,
  reader: (e) => mirrorReader(parseDatabaseUrl(e.M4_LEGACY_MIRROR_URL, "mirror")),
  target: (e) => postgresTarget(e.M4_DATABASE_URL ?? "", e.M4_IMPORT_ACTOR ?? "", e.M4_OPERATOR_ORG_ID ?? ""),
  now: () => new Date(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { env } = deps;
  const mode = argv[0];
  const refuse = (code: string) => { deps.error(`m4: refused.${code}`); return 2; };
  if (mode !== "plan" && mode !== "write") return refuse("usage");
  const revision = env.M4_REVISION ?? "";
  if (!/^[0-9a-f]{40}$/.test(revision)) return refuse("revision");
  const expected = env.M4_EXPECTED_PLAN ?? "";
  if (mode === "write" && (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(env.M4_IMPORT_ACTOR ?? "")
    || !env.M4_OPERATOR_ORG_ID || !env.M4_DATABASE_URL)) return refuse("writeConfig");

  const lock = await deps.lock(lockPathFrom(env));
  if (!lock.held) return refuse("locked");
  let target: WriteTarget | undefined;
  try {
    // Under the lock: the refresh identity and the copy it describes are read together.
    let last: unknown;
    try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
    const refresh = refreshIdentity(last);
    if (!refresh) return refuse("refreshNotOk");
    const sources = await readM4Sources(deps.reader(env));
    const plan = planM4(sources);
    const identity = planIdentity(plan, revision, refresh);
    const base = { schemaVersion: 1 as const, revision, refresh, plan: identity };
    const reportPath = env.M4_REPORT_PATH || DEFAULT_M4_REPORT_PATH;

    if (mode === "plan") {
      const report = await runM4(sources, null, deps.now().toISOString(), undefined, plan);
      if (!receiptSafe(report)) throw new Error("m4.report.unsafe");
      writeWhole(reportPath, { ...base, ...report });
      writeWhole(env.M4_PLAN_RECEIPT || DEFAULT_M4_PLAN_RECEIPT, { ...base, kind: "plan", status: "ok", at: deps.now().toISOString(), steps: report.steps.map(receiptStep) } satisfies M4Receipt);
      for (const line of receipt(report)) deps.log(line);
      deps.log(`m4 plan ok plan=${identity}`);
      return 0;
    }

    if (identity !== expected) return refuse("planMismatch");
    target = deps.target(env);
    if (await target.environment() !== "staging") return refuse("target");
    const receiptPath = env.M4_WRITE_RECEIPT || DEFAULT_M4_WRITE_RECEIPT;
    const done: M4Step[] = [];
    const write = (status: M4Receipt["status"], code?: string) => writeWhole(receiptPath,
      { ...base, kind: "write", status, at: deps.now().toISOString(), steps: done.map(receiptStep), ...(code ? { code } : {}) } satisfies M4Receipt);
    // Before the first write: any earlier receipt is gone, so nothing can read it as this run's.
    write("started");
    try {
      const report = await runM4(sources, target.writers(), deps.now().toISOString(), (s) => done.push(s), plan);
      if (!receiptSafe(report)) throw new Error("m4.report.unsafe");
      writeWhole(reportPath, { ...base, ...report });
      write(report.ok ? "ok" : "refused_rows");
      for (const line of receipt(report)) deps.log(line);
      deps.log(`m4 write ok=${report.ok} plan=${identity}`);
      return report.ok ? 0 : 3;
    } catch (error) {
      write("failed", errorCode(error));
      throw error;
    }
  } catch (error) {
    deps.error(`m4: ${errorCode(error)}`);
    return 1;
  } finally {
    await target?.close();
    lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), defaultDeps(process.env)).then((code) => { process.exitCode = code; });
}
