/**
 * M-4 importer CLI: organizations, stores, contacts and catalogues from the refreshed legacy copy.
 *
 * On the staging host (a Hermes card runs it, with a fresh M4_INVOCATION each time):
 *   node dist/tools/legacy-import/src/m4-cli.js plan
 *   node dist/tools/legacy-import/src/m4-cli.js write
 *
 * Every invocation is named by M4_INVOCATION (a fresh UUID) and owns its own files in
 * M4_OUTPUT_DIR: `<invocation>.<mode>.receipt.json` and `<invocation>.<mode>.report.json`. It
 * claims the name first (`<invocation>.claim`, created exclusively), so a reused name is refused
 * and nothing it writes can be mistaken for another run's. After the claim every outcome,
 * refusals included, ends in a terminal receipt for that invocation.
 *
 * A write counts as passed only when `acceptWrite` holds: the invocation's own terminal receipt
 * says ok for the expected plan, and that same invocation exited 0. An older receipt never counts.
 *
 * Locks. The CLI takes the refresh's lock itself, shared and without waiting, and holds it until
 * it exits: the refresh identity and every legacy table are read under it. A write also takes the
 * target database's one-writer lock (a session advisory lock, independent of the refresh lock)
 * before its first write and holds it until its terminal receipt is published, so two writers
 * can never overlap on one staging database.
 *
 *   plan   Reads the legacy copy and maps every table. Writes nothing to the platform. Publishes
 *          the plan identity: a sha256 over the stated revision, the built artifact's digest,
 *          the refresh read, the destination (M4_TARGET_ID, M4_OPERATOR_ORG_ID) and every
 *          mapped row's legacy id and digest.
 *   write  Refuses unless M4_EXPECTED_PLAN equals the identity it computes now, the target
 *          database's legacy_import_target row says staging with target_id = M4_TARGET_ID
 *          (migration 0652), the operator organization exists there, and no other writer holds
 *          the target. Then it publishes `started`, imports in order (catalogues, companies,
 *          brand links, stores, contacts) and publishes the outcome. A failure lists the steps
 *          whose results were confirmed and the ones that were not; the first unconfirmed step
 *          may have committed in part.
 *
 * Receipts carry the invocation, revision, artifact, refresh, destination, plan identity, status
 * and per-step counts and rule codes; no legacy id or value. The private report also lists
 * legacy ids by rule and stays on the host. Files are written whole (temporary file, rename),
 * mode 600. Errors print fixed codes only.
 * Exit 0 ok, 3 when a write step refused rows or found conflicts, 2 refused before any write,
 * 1 failed.
 *
 * Environment:
 *   M4_INVOCATION          a fresh UUID for this run
 *   M4_OUTPUT_DIR          default /var/lib/legacy-import/m4
 *   M4_LEGACY_MIRROR_URL   mysql://user:pass@host:port/legacy_mirror (read-only account)
 *   M4_REVISION            the 40-character platform commit this importer was built from
 *   M4_TARGET_ID           the staging database's legacy_import_target.target_id
 *   M4_OPERATOR_ORG_ID     the operator organization top-level companies hang under
 *   LEGACY_REFRESH_REPORT  the refresh's last-run.json; the run refuses unless it says ok
 *   LEGACY_REFRESH_LOCK    the refresh's lock file
 * For write only:
 *   M4_EXPECTED_PLAN       the plan identity from the reviewed plan receipt
 *   M4_DATABASE_URL        staging PostgreSQL
 *   M4_IMPORT_ACTOR        sha256 hex recorded as the creator of imported rows
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { PostgresCatalogueImportStore, PostgresContactImportStore, PostgresOrganizationImportStore, PostgresStoreImportStore } from "@studenthub/db/import";
import { ORGANIZATION_PARITY_REVISION } from "@studenthub/organizations";
import { DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH, lockPathFrom, parseDatabaseUrl } from "./refresh.js";
import { refreshIdentity } from "./twin/cli.js";
import type { RefreshIdentity } from "./twin/report.js";
import type { LegacyReader } from "./twin/journey.js";
import { mirrorReader } from "./twin/staging.js";
import { planIdentity, planM4, readM4Sources, receiptSafe, receiptStep, runM4, type M4Report, type M4Step, type M4Writers, type ReceiptStep } from "./m4-run.js";

export const DEFAULT_M4_OUTPUT_DIR = "/var/lib/legacy-import/m4";

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
  readonly schemaVersion: 2;
  readonly invocation: string;
  readonly kind: "plan" | "write";
  readonly status: "ok" | "started" | "refused_rows" | "failed" | "refused";
  readonly at: string;
  /** Set once the run got as far as computing them. */
  readonly revision?: string;
  readonly artifact?: string;
  readonly refresh?: RefreshIdentity;
  readonly target?: string;
  readonly operator?: string;
  readonly plan?: string;
  /** Steps whose results were confirmed, in order. */
  readonly steps: readonly ReceiptStep[];
  /** For a failed write: the steps not confirmed; the first may have committed in part. */
  readonly unconfirmed?: readonly string[];
  /** For a refused or failed run: the fixed code. */
  readonly code?: string;
}

/**
 * Whether a write invocation passed: its own terminal receipt says ok for the expected plan and
 * that invocation exited 0. The Hermes card applies exactly this; nothing else counts as a pass.
 */
export function acceptWrite(receiptJson: unknown, invocation: string, expectedPlan: string, exitCode: number | null): boolean {
  if (exitCode !== 0 || !receiptJson || typeof receiptJson !== "object") return false;
  const r = receiptJson as Partial<M4Receipt>;
  return r.schemaVersion === 2 && r.kind === "write" && r.invocation === invocation && r.status === "ok" && r.plan === expectedPlan;
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

/** Claims an invocation name: true only for the first claimant. */
export function claimInvocation(dir: string, invocation: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path.join(dir, `${invocation}.claim`), "wx", 0o600)); return true; } catch { return false; }
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

/**
 * sha256 over every built .js file the importer can load: the repository's dist tree and each
 * workspace package's dist tree, by relative path and content. A plan is bound to the code that
 * actually runs, whatever revision the operator states.
 */
export function artifactDigest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); } else if (e.isFile() && e.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(root, "dist"));
  for (const group of ["packages", "apps", "tools"]) {
    let names: string[];
    try { names = readdirSync(path.join(root, group)); } catch { continue; }
    for (const name of names) walk(path.join(root, group, name, "dist"));
  }
  const hash = createHash("sha256");
  for (const file of files.map((f) => path.relative(root, f)).sort()) {
    hash.update(`${file}\0`).update(readFileSync(path.join(root, file))).update("\0");
  }
  return hash.digest("hex");
}

/** The repository root of the built CLI: dist/tools/legacy-import/src/m4-cli.js is four levels down. */
const BUILT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface WriteTarget {
  /** The legacy_import_target row, or null when the database has none or cannot be read. */
  marker(): Promise<{ readonly environment: string; readonly targetId: string } | null>;
  /** Whether the operator organization exists in this database. */
  hasOperator(orgId: string): Promise<boolean>;
  /** Takes the one-writer lock for this database without waiting; held until close. */
  claimWriter(): Promise<boolean>;
  writers(): M4Writers;
  /** Releases the writer lock and the connections. */
  close(): Promise<void>;
}

/** One writer per target database, across every batch and the terminal receipt. */
export const WRITER_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtextextended('legacy-import:m4-writer', 0)) AS held";

export function postgresTarget(url: string, actorRef: string, operatorOrgId: string): WriteTarget {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  let writer: pg.PoolClient | undefined;
  return {
    marker: async () => {
      try {
        const { rows } = await pool.query<{ environment: string; target_id: string }>("SELECT environment, target_id::text FROM legacy_import_target");
        return rows.length === 1 ? { environment: rows[0]!.environment, targetId: rows[0]!.target_id } : null;
      } catch { return null; }
    },
    hasOperator: async (orgId) => {
      try { return (await pool.query("SELECT 1 FROM organizations WHERE id = $1", [orgId])).rowCount === 1; } catch { return false; }
    },
    claimWriter: async () => {
      if (writer) return true;
      let client: pg.PoolClient;
      try { client = await pool.connect(); } catch { return false; }
      try {
        const { rows: [row] } = await client.query<{ held: boolean }>(WRITER_LOCK_SQL);
        if (row?.held) { writer = client; return true; }
      } catch { /* refused below */ }
      client.release();
      return false;
    },
    writers: () => m4Writers(pool, actorRef, operatorOrgId),
    close: async () => {
      // Ending the session releases its advisory lock even if the unlock fails.
      if (writer) { writer.release(true); writer = undefined; }
      await pool.end();
    },
  };
}

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly lock: (lockPath: string) => Promise<SharedLock>;
  readonly reader: (env: NodeJS.ProcessEnv) => LegacyReader;
  readonly target: (env: NodeJS.ProcessEnv) => WriteTarget;
  readonly artifact: () => string;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export const defaultDeps = (env: NodeJS.ProcessEnv): CliDeps => ({
  env,
  lock: acquireSharedLock,
  reader: (e) => mirrorReader(parseDatabaseUrl(e.M4_LEGACY_MIRROR_URL, "mirror")),
  target: (e) => postgresTarget(e.M4_DATABASE_URL ?? "", e.M4_IMPORT_ACTOR ?? "", e.M4_OPERATOR_ORG_ID ?? ""),
  artifact: () => artifactDigest(BUILT_ROOT),
  now: () => new Date(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class Refusal extends Error {}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { env } = deps;
  const mode = argv[0];
  if (mode !== "plan" && mode !== "write") { deps.error("m4: refused.usage"); return 2; }
  const invocation = env.M4_INVOCATION ?? "";
  // Without a fresh, unclaimed name there is nowhere this run's outcome could be published.
  if (!UUID.test(invocation)) { deps.error("m4: refused.invocation"); return 2; }
  const dir = env.M4_OUTPUT_DIR || DEFAULT_M4_OUTPUT_DIR;
  if (!claimInvocation(dir, invocation)) { deps.error("m4: refused.invocationUsed"); return 2; }

  const receiptPath = path.join(dir, `${invocation}.${mode}.receipt.json`);
  const reportPath = path.join(dir, `${invocation}.${mode}.report.json`);
  let bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps"> = {};
  const confirmed: M4Step[] = [];
  let order: readonly string[] = [];
  const publish = (status: M4Receipt["status"], code?: string) => {
    const unconfirmed = status === "failed" ? order.slice(confirmed.length) : undefined;
    writeWhole(receiptPath, { schemaVersion: 2, invocation, kind: mode, status, at: deps.now().toISOString(), ...bound,
      steps: confirmed.map(receiptStep), ...(unconfirmed ? { unconfirmed } : {}), ...(code ? { code } : {}) } satisfies M4Receipt);
  };
  const refuse = (code: string): never => { throw new Refusal(code); };

  let lock: SharedLock = { held: false };
  let target: WriteTarget | undefined;
  let writing = false;
  try {
    const revision = env.M4_REVISION ?? "";
    if (!/^[0-9a-f]{40}$/.test(revision)) refuse("revision");
    const targetId = env.M4_TARGET_ID ?? "";
    const operator = env.M4_OPERATOR_ORG_ID ?? "";
    if (!UUID.test(targetId) || !ORG_ID.test(operator)) refuse("destination");
    const expected = env.M4_EXPECTED_PLAN ?? "";
    if (mode === "write" && (!HEX64.test(expected) || !HEX64.test(env.M4_IMPORT_ACTOR ?? "") || !env.M4_DATABASE_URL)) refuse("writeConfig");

    lock = await deps.lock(lockPathFrom(env));
    if (!lock.held) refuse("locked");
    // Under the lock: the refresh identity and the copy it describes are read together.
    let last: unknown;
    try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
    const refresh = refreshIdentity(last);
    if (!refresh) refuse("refreshNotOk");
    const artifact = deps.artifact();
    bound = { revision, artifact, refresh, target: targetId, operator };
    const sources = await readM4Sources(deps.reader(env));
    const plan = planM4(sources);
    const identity = planIdentity(plan, { revision, artifact, refresh: refresh!, target: targetId, operator });
    bound = { ...bound, plan: identity };
    const planned = await runM4(sources, null, deps.now().toISOString(), undefined, plan);
    if (!receiptSafe(planned)) throw new Error("m4.report.unsafe");

    if (mode === "plan") {
      writeWhole(reportPath, { ...planned, schemaVersion: 2, invocation, ...bound });
      confirmed.push(...planned.steps);
      publish("ok");
      for (const line of receipt(planned)) deps.log(line);
      deps.log(`m4 plan ok invocation=${invocation} plan=${identity}`);
      return 0;
    }

    if (identity !== expected) refuse("planMismatch");
    target = deps.target(env);
    const marker = await target.marker();
    if (marker?.environment !== "staging" || marker.targetId !== targetId) refuse("target");
    if (!await target.hasOperator(operator)) refuse("operator");
    if (!await target.claimWriter()) refuse("writerBusy");
    order = planned.steps.map((s) => s.step);
    publish("started");
    writing = true;
    const report = await runM4(sources, target.writers(), deps.now().toISOString(), (s) => confirmed.push(s), plan);
    if (!receiptSafe(report)) throw new Error("m4.report.unsafe");
    writeWhole(reportPath, { ...report, schemaVersion: 2, invocation, ...bound });
    publish(report.ok ? "ok" : "refused_rows");
    for (const line of receipt(report)) deps.log(line);
    deps.log(`m4 write ok=${report.ok} invocation=${invocation} plan=${identity}`);
    return report.ok ? 0 : 3;
  } catch (error) {
    if (error instanceof Refusal && !writing) {
      deps.error(`m4: refused.${error.message}`);
      try { publish("refused", error.message); } catch { return 1; }
      return 2;
    }
    const code = errorCode(error);
    deps.error(`m4: ${code}`);
    try { publish("failed", code); } catch { /* the exit code still says failed */ }
    return 1;
  } finally {
    // The writer lock is held until the terminal receipt above is published.
    await target?.close();
    if (lock.held) lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), defaultDeps(process.env)).then((code) => { process.exitCode = code; });
}
