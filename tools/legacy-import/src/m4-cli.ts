/**
 * M-4 importer CLI: organizations, stores, contacts and catalogues from the refreshed legacy copy.
 *
 * On the staging host (a Hermes card runs it, with a fresh M4_INVOCATION each time):
 *   node dist/tools/legacy-import/src/m4-cli.js plan
 *   node dist/tools/legacy-import/src/m4-cli.js write
 *   node dist/tools/legacy-import/src/m4-cli.js provenance   (read-only; CI prints it per commit)
 *
 * Build provenance. Plan and write run only from a clean git checkout whose HEAD is M4_REVISION
 * and whose built closure (the entrypoint, every relative and workspace module it imports, and
 * package-lock.json) hashes to M4_ARTIFACT_DIGEST, the digest CI printed for that same commit.
 * A missing file in the closure, a dirty tree or any mismatch refuses (`refused.provenance`).
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
 * can never overlap on one staging database. Every import transaction runs on that same session
 * (WriterSessionPool), each checkout first re-checking there that the lock is still held, and
 * exclusivity is re-checked before the outcome is published: if the session is lost, the
 * transaction in flight dies with it, no later batch starts, and the run ends `failed` with
 * `m4.writerLost`.
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
 *   M4_ARTIFACT_DIGEST     the digest CI's "Pin the M-4 importer build" step printed for it
 *   M4_TARGET_ID           the staging database's legacy_import_target.target_id
 *   M4_OPERATOR_ORG_ID     the operator organization top-level companies hang under
 *   LEGACY_REFRESH_REPORT  the refresh's last-run.json; the run refuses unless it says ok
 *   LEGACY_REFRESH_LOCK    the refresh's lock file
 * For write only:
 *   M4_EXPECTED_PLAN       the plan identity from the reviewed plan receipt
 *   M4_DATABASE_URL        staging PostgreSQL
 *   M4_IMPORT_ACTOR        sha256 hex recorded as the creator of imported rows
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

export const ENTRYPOINT = "dist/tools/legacy-import/src/m4-cli.js";
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/**
 * The built closure the importer runs: from the entrypoint, every relative import and every
 * `@studenthub/*` workspace import (through its package's `exports`), plus package-lock.json,
 * which pins every other dependency. The digest is a sha256 over each file's relative path and
 * content. Any file the closure names that is missing, outside the repository, or unresolvable
 * is listed, and then there is no digest: the run refuses rather than hash a partial build.
 */
export function artifactDigest(root: string, entry = ENTRYPOINT): { readonly digest: string | null; readonly files: number; readonly missing: readonly string[] } {
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  const inside = (file: string) => { const rel = path.relative(realRoot, file); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };
  const seen = new Set<string>();
  const missing: string[] = [];
  const queue: string[] = [];
  const add = (file: string, label: string) => {
    let real: string;
    try { real = realpathSync(file); } catch { missing.push(label); return; }
    if (!inside(real) || !statSync(real).isFile()) { missing.push(label); return; }
    if (!seen.has(real)) { seen.add(real); queue.push(real); }
  };
  const workspace = (spec: string): string | null => {
    const [, name, sub] = /^@studenthub\/([a-z0-9-]+)(\/.*)?$/.exec(spec) ?? [];
    if (!name) return null;
    try {
      const dir = realpathSync(path.join(realRoot, "node_modules/@studenthub", name));
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { exports?: Record<string, unknown> };
      const target = manifest.exports?.[sub ? `.${sub}` : "."];
      const file = typeof target === "string" ? target : (target as { import?: unknown } | undefined)?.import;
      return typeof file === "string" ? path.join(dir, file) : null;
    } catch { return null; }
  };
  add(path.join(realRoot, entry), entry);
  add(path.join(realRoot, "package-lock.json"), "package-lock.json");
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(SPECIFIER)) {
      if (spec!.startsWith(".")) add(path.resolve(path.dirname(file), spec!), `${path.relative(realRoot, file)} -> ${spec}`);
      else if (spec!.startsWith("@studenthub/")) {
        const resolved = workspace(spec!);
        if (resolved) add(resolved, spec!); else missing.push(spec!);
      }
      // node: builtins and registry packages are pinned by package-lock.json.
    }
  }
  if (missing.length > 0) return { digest: null, files: seen.size, missing: [...new Set(missing)].sort() };
  const hash = createHash("sha256");
  for (const rel of [...seen].map((f) => path.relative(realRoot, f)).sort()) {
    hash.update(`${rel}\0`).update(readFileSync(path.join(realRoot, rel))).update("\0");
  }
  return { digest: hash.digest("hex"), files: seen.size, missing: [] };
}

/** What the running build can prove about itself. */
export interface Provenance {
  /** The checkout's HEAD commit, or null when it is not a git checkout. */
  readonly head: string | null;
  /** No tracked file differs from HEAD. */
  readonly clean: boolean;
  /** The built closure's digest, or null when the closure is incomplete. */
  readonly artifact: string | null;
}

export function buildProvenance(root: string): Provenance {
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C" } });
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return {
    head: head.status === 0 && /^[0-9a-f]{40}\n?$/.test(head.stdout) ? head.stdout.trim() : null,
    clean: status.status === 0 && status.stdout.trim() === "",
    artifact: artifactDigest(root).digest,
  };
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
  /** Writers bound to the lock-holding session; only after claimWriter. */
  writers(): M4Writers;
  /** Re-checks, on the lock session itself, that it is alive and still holds the lock. */
  stillHeld(): Promise<boolean>;
  /** Whether the lock session was lost or broken at any point. Once true, stays true. */
  lost(): boolean;
  /** Releases the writer lock and the connections. */
  close(): Promise<void>;
}

/** One writer per target database, across every batch and the terminal receipt. */
export const WRITER_LOCK_KEY = "hashtextextended('legacy-import:m4-writer', 0)";
export const WRITER_LOCK_SQL = `SELECT pg_try_advisory_lock(${WRITER_LOCK_KEY}) AS held`;
/** True only on the session that holds the writer lock. */
export const WRITER_FENCE_SQL = `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
  AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = ${WRITER_LOCK_KEY}) AS held`;

/**
 * A pool of exactly one session: the one holding the writer lock. Every import transaction runs
 * on it, so the lock and the writes share one session: if the session is lost, the transaction in
 * flight dies with it and no later write can start, because every checkout first re-checks on
 * that session that it still holds the lock. A store that releases the session as broken marks
 * it lost. A subclass so the import stores accept it as a pool.
 */
export class WriterSessionPool extends pg.Pool {
  #session: pg.PoolClient | null;
  #busy = false;
  #lost = false;
  constructor(session: pg.PoolClient) {
    super({ max: 1 });
    this.#session = session;
    session.on("error", () => { this.#lost = true; });
    const self = this;
    Object.defineProperty(this, "connect", { value: async () => self.#checkout() });
    Object.defineProperty(this, "query", { value: async (...args: unknown[]) => {
      const client = await self.#checkout();
      try { return await (client.query as (...a: unknown[]) => Promise<unknown>)(...args); } finally { client.release(); }
    } });
    Object.defineProperty(this, "end", { value: async () => undefined });
  }

  get lost(): boolean { return this.#lost; }

  async fence(): Promise<boolean> {
    if (this.#lost || !this.#session) return false;
    try {
      const { rows: [row] } = await this.#session.query<{ held: boolean }>(WRITER_FENCE_SQL);
      if (row?.held === true) return true;
    } catch { /* lost below */ }
    this.#lost = true;
    return false;
  }

  async #checkout(): Promise<pg.PoolClient> {
    if (this.#busy) throw new Error("m4.writerSessionBusy");
    this.#busy = true;
    if (!await this.fence()) { this.#busy = false; throw new Error("m4.writerLost"); }
    const session = this.#session!;
    let released = false;
    const client = {
      query: (...args: unknown[]) => (session.query as (...a: unknown[]) => Promise<unknown>)(...args),
      release: (broken?: unknown) => {
        if (released) return;
        released = true;
        this.#busy = false;
        if (broken) this.#lost = true;
      },
    };
    return client as unknown as pg.PoolClient;
  }

  /** Ends the session, which also releases its advisory lock. */
  close(): void {
    const session = this.#session;
    this.#session = null;
    this.#lost = true;
    session?.release(true);
  }
}

export function postgresTarget(url: string, actorRef: string, operatorOrgId: string): WriteTarget {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  let writer: WriterSessionPool | undefined;
  let wasLost = false;
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
      if (writer) return !writer.lost;
      let client: pg.PoolClient;
      try { client = await pool.connect(); } catch { return false; }
      client.on("error", () => { wasLost = true; });
      try {
        const { rows: [row] } = await client.query<{ held: boolean }>(WRITER_LOCK_SQL);
        if (row?.held) { writer = new WriterSessionPool(client); return true; }
      } catch { /* refused below */ }
      client.release(true);
      return false;
    },
    writers: () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      return m4Writers(writer, actorRef, operatorOrgId);
    },
    stillHeld: async () => (writer ? writer.fence() : false),
    lost: () => wasLost || (writer?.lost ?? false),
    close: async () => {
      if (writer) { wasLost ||= writer.lost; writer.close(); writer = undefined; }
      await pool.end();
    },
  };
}

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly lock: (lockPath: string) => Promise<SharedLock>;
  readonly reader: (env: NodeJS.ProcessEnv) => LegacyReader;
  readonly target: (env: NodeJS.ProcessEnv) => WriteTarget;
  readonly provenance: () => Provenance;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export const defaultDeps = (env: NodeJS.ProcessEnv): CliDeps => ({
  env,
  lock: acquireSharedLock,
  reader: (e) => mirrorReader(parseDatabaseUrl(e.M4_LEGACY_MIRROR_URL, "mirror")),
  target: (e) => postgresTarget(e.M4_DATABASE_URL ?? "", e.M4_IMPORT_ACTOR ?? "", e.M4_OPERATOR_ORG_ID ?? ""),
  provenance: () => buildProvenance(BUILT_ROOT),
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
  if (mode === "provenance") {
    // Read-only: what an independent build of a revision pins (CI prints it for every head).
    const built = deps.provenance();
    deps.log(`m4 provenance head=${built.head ?? "none"} clean=${built.clean} artifact=${built.artifact ?? "incomplete"}`);
    return built.head && built.artifact ? 0 : 1;
  }
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
    // The approved build: a clean checkout at the stated revision whose built closure matches the
    // digest pinned for that revision by an independent build (CI's `m4-cli.js provenance` line).
    const artifact = env.M4_ARTIFACT_DIGEST ?? "";
    if (!HEX64.test(artifact)) refuse("provenance");
    const built = deps.provenance();
    if (built.head !== revision || !built.clean || built.artifact !== artifact) refuse("provenance");

    lock = await deps.lock(lockPathFrom(env));
    if (!lock.held) refuse("locked");
    // Under the lock: the refresh identity and the copy it describes are read together.
    let last: unknown;
    try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
    const refresh = refreshIdentity(last);
    if (!refresh) refuse("refreshNotOk");
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
    // Exclusivity must still hold when the outcome is published.
    if (!await target.stillHeld()) throw new Error("m4.writerLost");
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
    const code = target?.lost() ? "m4.writerLost" : errorCode(error);
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
