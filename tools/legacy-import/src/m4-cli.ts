/**
 * M-4 importer CLI: organizations, stores, contacts and catalogues from the refreshed legacy copy,
 * then M-1's approved profile snapshots (people) and their staged contact values (phone, handle,
 * civil ID sealed with the platform's civil ID key, verified address as an HMAC), in the same plan
 * and write.
 *
 * On the staging host (a Hermes card runs it, with a fresh M4_INVOCATION each time), only
 * through the launcher, which verifies the runtime before this module is loaded:
 *   tools/legacy-import/m4 plan
 *   tools/legacy-import/m4 write
 * (a shell entry that clears the environment and starts Node on tools/legacy-import/m4-launch.mjs).
 * This module is not an entry point: run directly, it evaluates its imports but never calls `main`.
 *
 * Build provenance. The launcher loads this module only from a clean git checkout whose HEAD is
 * M4_REVISION, with nothing untracked outside .gitignore, after a clean Node start, from a tree
 * the running user cannot change (owned by another user, no write bits, protected parent path,
 * links inside it) whose every file and symlink outside .git, together with the platform and Node
 * major version, hashes to M4_ARTIFACT_DIGEST, the digest CI printed for that same commit.
 * It hands the verified provenance in, and plan and write check it again against the pins.
 *
 * Every invocation is named by M4_INVOCATION (a fresh UUID) and owns its own files in
 * M4_OUTPUT_DIR: `<invocation>.<mode>.receipt.json` and `<invocation>.<mode>.report.json`. It
 * claims the name first (`<invocation>.claim`, created exclusively), so a reused name is refused
 * and nothing it writes can be mistaken for another run's. After the claim every outcome,
 * refusals included, tries to publish a terminal receipt for that invocation; if that write fails,
 * the exit code still says so and the receipt may stay `started` (never a pass).
 *
 * A write counts as passed only when `acceptWrite` holds: the invocation's own terminal receipt
 * says ok for the expected plan, and that same invocation exited 0. An older receipt never counts.
 *
 * Locks. The CLI takes the refresh's lock itself, shared and without waiting, and holds it until
 * it exits: the refresh identity and every legacy table are read under it. A write also takes the
 * target database's one-writer lock (a session advisory lock, independent of the refresh lock)
 * before its first write and holds it until its terminal receipt is published, so two writers
 * can never overlap on one staging database. Every import transaction runs on that same session
 * (WriterSessionPool), each checkout first re-checking there that the lock is still held, and the
 * lock is checked once more immediately before the outcome is published: if the session is lost,
 * the transaction in flight dies with it, no later batch starts, and the run ends `failed` with
 * `m4.writerLost`. That last check and the receipt file are not one atomic step; the database
 * lock is not held across the filesystem write.
 *
 *   plan   Reads the legacy copy and maps every table. Writes nothing to the platform. Publishes
 *          the plan identity: a sha256 over the stated revision, the runtime digest,
 *          the refresh read, the destination (M4_TARGET_ID, M4_OPERATOR_ORG_ID), the run's
 *          Kuwait date with the M-1 mapper revision, the rows read per legacy table, and every
 *          mapped row's legacy id and digest and every issue's rule, legacy id and column, so the
 *          reconciliation a reviewer saw is part of what the write must match.
 *          The date is part of the identity because M-1's minimum-age rule is applied on it, so a
 *          write on another Kuwait day is refused as planMismatch and needs a fresh plan.
 *   write  Refuses unless M4_EXPECTED_PLAN equals the identity it computes now, the target
 *          database's legacy_import_target row says staging with target_id = M4_TARGET_ID
 *          (migration 0652), the operator organization exists there, migration 0655 (after
 *          0653 people snapshots and 0654 staged contacts) is applied there, and no other writer holds the target. Then it publishes `started`, imports in order (catalogues, companies,
 *          brand links, stores, contacts, people, person contacts) and publishes the outcome. A failure lists the steps
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
 *   M4_ARTIFACT_DIGEST     the runtime digest CI's "Pin the M-4 importer build" step printed for it
 *   M4_TARGET_ID           the staging database's legacy_import_target.target_id
 *   M4_OPERATOR_ORG_ID     the operator organization top-level companies hang under
 *   LEGACY_REFRESH_REPORT  the refresh's last-run.json; the run refuses unless it says ok
 *   LEGACY_REFRESH_LOCK    the refresh's lock file
 *   M4_CONTACT_DIGEST_KEY  canonical base64 of 32 bytes: the HMAC key for staged contact digests
 *                          and verified-address HMACs; the plan identity binds those HMACs only
 * For write only:
 *   M4_EXPECTED_PLAN       the plan identity from the reviewed plan receipt
 *   M4_DATABASE_URL        staging PostgreSQL
 *   M4_IMPORT_ACTOR        sha256 hex recorded as the creator of imported rows
 *   M4_CIVIL_ID_ENCRYPTION_KEY  canonical base64 of 32 bytes: the platform's civil ID key, which
 *                          seals staged civil IDs; must differ from M4_CONTACT_DIGEST_KEY
 */

import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { PostgresCatalogueImportStore, PostgresContactImportStore, PostgresOrganizationImportStore, PostgresPersonContactImportStore, PostgresPersonSnapshotImportStore, PostgresStoreImportStore, personContactDigest } from "@studenthub/db/import";
import { CivilIdVault, PROFILE_PARITY_REVISION } from "@studenthub/profile";
import { ORGANIZATION_PARITY_REVISION } from "@studenthub/organizations";
import { DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH, lockPathFrom, parseDatabaseUrl } from "./refresh.js";
import { refreshIdentity } from "./twin/cli.js";
import type { RefreshIdentity } from "./twin/report.js";
import type { LegacyReader } from "./twin/journey.js";
import { mirrorReader } from "./twin/staging.js";
import { kuwaitDay, planIdentity, planM4, readM4Sources, receiptSafe, receiptStep, runM4, type M4Report, type M4Step, type M4Writers, type ReceiptStep } from "./m4-run.js";

export const DEFAULT_M4_OUTPUT_DIR = "/var/lib/legacy-import/m4";

/**
 * The two keys the contact step needs, from the operator's environment only. Neither is ever
 * written to a receipt, report, log or process argument.
 */
export interface ContactKeys {
  /** HMAC key for the staged rows' digests and the verified-address HMAC (M4_CONTACT_DIGEST_KEY). */
  readonly digest: Buffer;
  /** The platform's civil ID key (CIVIL_ID_ENCRYPTION_KEY there), write only (M4_CIVIL_ID_ENCRYPTION_KEY). */
  readonly civilId: Buffer | null;
}

/** A 32-byte key given as canonical base64, or null. */
export function keyFrom(raw: string | undefined): Buffer | null {
  if (typeof raw !== "string" || raw === "") return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 && key.toString("base64") === raw ? key : null;
}

export function contactKeysFrom(env: NodeJS.ProcessEnv, mode: "plan" | "write"): ContactKeys | null {
  const digest = keyFrom(env.M4_CONTACT_DIGEST_KEY);
  const civilId = keyFrom(env.M4_CIVIL_ID_ENCRYPTION_KEY);
  if (digest === null || (mode === "write" && civilId === null)) return null;
  // Separate keys: a digest must never be computable from the civil ID key or the other way round.
  if (civilId !== null && civilId.equals(digest)) return null;
  return { digest, civilId };
}

export function m4Writers(pool: pg.Pool, actorRef: string, operatorOrgId: string, keys: ContactKeys): M4Writers {
  if (keys.civilId === null) throw new Error("m4.contactKeys");
  const catalogue = new PostgresCatalogueImportStore(pool, actorRef);
  const organizations = new PostgresOrganizationImportStore(pool, ORGANIZATION_PARITY_REVISION, operatorOrgId);
  const stores = new PostgresStoreImportStore(pool, actorRef);
  const contacts = new PostgresContactImportStore(pool, actorRef);
  const people = new PostgresPersonSnapshotImportStore(pool, PROFILE_PARITY_REVISION);
  const personContacts = new PostgresPersonContactImportStore(pool, new CivilIdVault(keys.civilId), keys.digest);
  return {
    catalogue: (_table, items, now) => catalogue.importItems(items, now),
    companies: (rows) => organizations.importOrganizations(rows),
    brandLinks: (rows) => stores.importBrandLinks(rows),
    stores: (rows, now) => stores.importStores(rows, now),
    contacts: (rows, now) => contacts.importContacts(rows, now),
    people: (rows) => people.importPeople(rows),
    personContacts: (rows) => personContacts.importContacts(rows),
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
  /** The run's Kuwait date; the plan identity binds it (M-1's age rule). */
  readonly today?: string;
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

/** What the running build can prove about itself. */
export interface Provenance {
  /** The checkout's HEAD commit, or null when it is not a git checkout. */
  readonly head: string | null;
  /** No tracked file differs from HEAD. */
  readonly clean: boolean;
  /** The installed runtime digest the launcher computed, or null when the runtime is incomplete. */
  readonly artifact: string | null;
}


export interface WriteTarget {
  /** The legacy_import_target row, or null when the database has none or cannot be read. */
  marker(): Promise<{ readonly environment: string; readonly targetId: string } | null>;
  /** Whether the operator organization exists in this database. */
  hasOperator(orgId: string): Promise<boolean>;
  /** Whether every table the write needs is migrated (M4_REQUIRED_MIGRATION applied, its table present). */
  schemaReady(): Promise<boolean>;
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

/**
 * The newest migration a write needs: the contact step's verified-address column (0655, after the
 * people snapshot table 0653 and the contact table 0654). Checked before `started`, so a target
 * that lacks it refuses before any step instead of failing at the last steps after the others
 * committed.
 */
export const M4_REQUIRED_MIGRATION = "0655_legacy_candidate_verified_email";
export const SCHEMA_READY_SQL = `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${M4_REQUIRED_MIGRATION}')
  AND to_regclass('public.legacy_candidate_snapshots') IS NOT NULL
  AND to_regclass('public.legacy_candidate_contacts') IS NOT NULL AS ready`;

/** One writer per target database, across every batch and the terminal receipt. */
export const WRITER_LOCK_KEY = "hashtextextended('legacy-import:m4-writer', 0)";
export const WRITER_LOCK_SQL = `SELECT pg_try_advisory_lock(${WRITER_LOCK_KEY}) AS held`;
/** Waits on the writer session are bounded: a lock wait, a statement or an idle transaction. */
export const WRITER_SESSION_LIMITS_SQL = "SET lock_timeout = '60s'; SET statement_timeout = '15min'; SET idle_in_transaction_session_timeout = '15min'";
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

/** `sessionLimits` exists for tests that need a shorter wait; production uses the default. */
export function postgresTarget(url: string, actorRef: string, operatorOrgId: string, keys: ContactKeys | null, sessionLimits = WRITER_SESSION_LIMITS_SQL): WriteTarget {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  let writer: WriterSessionPool | undefined;
  let wasLost = false;
  let closed = false;
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
    schemaReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(SCHEMA_READY_SQL)).rows[0]?.ready === true; } catch { return false; }
    },
    claimWriter: async () => {
      if (writer) return !writer.lost;
      let client: pg.PoolClient;
      try { client = await pool.connect(); } catch { return false; }
      client.on("error", () => { wasLost = true; });
      try {
        const { rows: [row] } = await client.query<{ held: boolean }>(WRITER_LOCK_SQL);
        if (row?.held) {
          // Bounded waits on the writer session: a batch blocked by another transaction fails,
          // rolls back and ends the run `failed` instead of holding both run-wide locks forever.
          await client.query(sessionLimits);
          writer = new WriterSessionPool(client);
          return true;
        }
      } catch { /* refused below */ }
      client.release(true);
      return false;
    },
    writers: () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      if (!keys) throw new Error("m4.contactKeys");
      return m4Writers(writer, actorRef, operatorOrgId, keys);
    },
    stillHeld: async () => (writer ? writer.fence() : false),
    lost: () => wasLost || (writer?.lost ?? false),
    close: async () => {
      if (writer) { wasLost ||= writer.lost; writer.close(); writer = undefined; }
      if (closed) return;
      closed = true;
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

/** `built` is the provenance tools/legacy-import/m4-launch.mjs verified before loading this module. */
export const defaultDeps = (env: NodeJS.ProcessEnv, built: Provenance): CliDeps => ({
  env,
  lock: acquireSharedLock,
  reader: (e) => mirrorReader(parseDatabaseUrl(e.M4_LEGACY_MIRROR_URL, "mirror")),
  target: (e) => postgresTarget(e.M4_DATABASE_URL ?? "", e.M4_IMPORT_ACTOR ?? "", e.M4_OPERATOR_ORG_ID ?? "", contactKeysFrom(e, "write")),
  provenance: () => built,
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
    const keys = contactKeysFrom(env, mode);
    if (!keys) refuse("contactKeys");
    // The approved build, as the launcher verified it before loading this module: a clean checkout
    // at the stated revision whose installed runtime matches the digest CI pinned for that commit.
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
    // One date for the whole run, taken once: a write on another Kuwait day computes another
    // identity and is refused as planMismatch, so it needs a fresh, reviewed plan.
    const today = kuwaitDay(deps.now().toISOString());
    const plan = planM4(sources, today);
    const identity = planIdentity(plan, { revision, artifact, refresh: refresh!, target: targetId, operator, today },
      (row) => personContactDigest(keys!.digest, row));
    bound = { ...bound, today, plan: identity };
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
    if (!await target.schemaReady()) refuse("schema");
    if (!await target.claimWriter()) refuse("writerBusy");
    order = planned.steps.map((s) => s.step);
    publish("started");
    writing = true;
    const report = await runM4(sources, target.writers(), deps.now().toISOString(), (s) => confirmed.push(s), plan);
    if (!receiptSafe(report)) throw new Error("m4.report.unsafe");
    // The lock is checked once more immediately before the outcome is published.
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
