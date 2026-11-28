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
 *   tools/legacy-import/m4 keycheck   (once per target: the civil ID key check)
 *   tools/legacy-import/m4 promote    (after a write: linked people's staged contacts, see `promote`)
 *   tools/legacy-import/m4 linkreport (M-3: the identity link report for staff, see `linkReport`)
 *   tools/legacy-import/m4 doccheck   (M-2: each imported person's legacy documents, read-only, see `docCheck`)
 *   tools/legacy-import/m4 staffwork  (M-5: legacy staff time, stand-up and hours per day, see `staffWorkRun`)
 *   tools/legacy-import/m4 candidatework  (M-5: legacy candidates' placements, hours and decisions, see `candidateWorkRun`)
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
 *          (migration 0652), the operator organization exists there, migration 0656 (after
 *          0653 people snapshots, 0654 staged contacts and 0655) is applied there, the civil ID
 *          key opens the target's provisioned check, and no other writer holds the target. Then it publishes `started`, imports in order (catalogues, companies,
 *          brand links, stores, contacts, people, person contacts) and publishes the outcome. A failure lists the steps
 *          whose results were confirmed and the ones that were not; the first unconfirmed step
 *          may have committed in part.
 *
 *   keycheck  Once per target: seals a fixed, non-personal check value under
 *          M4_CIVIL_ID_ENCRYPTION_KEY into legacy_import_target.civil_key_check (set once), or
 *          confirms the key against it. Reads no legacy data and writes nothing else.
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
 * For doccheck only (the read-only legacy bucket credential: GetObject and ListBucket on that bucket):
 *   M4_LEGACY_BUCKET, M4_LEGACY_BUCKET_REGION, M4_LEGACY_BUCKET_ACCESS_KEY_ID, M4_LEGACY_BUCKET_SECRET_ACCESS_KEY
 * For write only:
 *   M4_EXPECTED_PLAN       the plan identity from the reviewed plan receipt
 *   M4_DATABASE_URL        staging PostgreSQL
 *   M4_IMPORT_ACTOR        sha256 hex recorded as the creator of imported rows
 *   M4_CIVIL_ID_ENCRYPTION_KEY  canonical base64 of 32 bytes: the platform's civil ID key, which
 *                          seals staged civil IDs; must differ from M4_CONTACT_DIGEST_KEY
 */

import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { CIVIL_KEY_CHECK, civilKeyOpens, linkReportCounts, readLinkReport, type LinkReport, PostgresCatalogueImportStore, ContactPromotionError, PostgresContactPromotion, type ContactPromotionResult, PostgresContactImportStore, PostgresOrganizationImportStore, PostgresPersonContactImportStore, PostgresPersonSnapshotImportStore, PostgresStoreImportStore, personContactDigest } from "@studenthub/db/import";
import { CivilIdVault, PROFILE_PARITY_REVISION } from "@studenthub/profile";
import { ORGANIZATION_PARITY_REVISION } from "@studenthub/organizations";
import { copyCounts, copyLegacyDocuments, M2_DOCUMENT_COPY_REVISION, M2CopyError, selectApproved, type CopyCheckpointStore, type CopyRule, type DocumentStagingStore, type StagingObjects } from "./m2-copy.js";
import { postgresCopyCheckpoints, postgresDocumentStaging, stagingBucket, stagingFingerprint, stagingIdentity } from "./m2-staging.js";
import { DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH, GENERATION, lockPathFrom, MIRROR_GENERATION_TABLE, parseDatabaseUrl } from "./refresh.js";
import { refreshIdentity } from "./twin/cli.js";
import type { RefreshIdentity } from "./twin/report.js";
import type { LegacyReader } from "./twin/journey.js";
import { mirrorReader } from "./twin/staging.js";
import { legacyBucketReader } from "./m2-bucket.js";
import { checkLegacyDocuments, documentCheckCounts, documentSetDigest, M2_DOCUMENT_CHECK_REVISION, type CheckedDocument, type DocumentCheckRule, type LegacyObjectReader } from "./m2-document-check.js";
import { M2_DOCUMENT_MAPPER_REVISION, type DocumentIssueRule } from "./m2-documents.js";
import { M2InputError, planM2, readM2Sources } from "./m2-run.js";
import { M5_STAFF_REVISION, M5InputError, planStaffWork, readM5StaffSources, resolveStaff, runStaffWork, staffCandidates, STAFF_MATCH_SQL,
  type StaffMatcher, type StaffUnresolved, type StaffWorkOutcome } from "./m5-staff.js";
import { CANDIDATE_LINK_SQL, M5_CANDIDATE_REVISION, M5CandidateInputError, STORE_MAP_SQL, candidateLookupIds, planCandidateWork, readM5CandidateSources,
  runCandidateWork, type CandidateLinkLookup, type CandidateWorkOutcome, type MappedStore, type StoreLookup } from "./m5-candidate.js";
import { PostgresWorkImportStore } from "@studenthub/db/work";
import { DocumentPromotionError, LegacyDocumentPromotion, type DocumentPromotionOutcome, type StagedLegacyDocument } from "../../../packages/private-documents/src/legacy-promotion.js";
import { PostgresDocumentPartitions, R2Objects } from "../../../packages/private-documents/src/r2-storage.js";
import type { StagedDocument } from "./m2-copy.js";
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
  readonly kind: "plan" | "write" | "keycheck" | "promote" | "linkreport" | "doccheck" | "doccopy" | "docpromote" | "staffwork" | "candidatework";
  readonly status: "ok" | "started" | "refused_rows" | "incomplete" | "failed" | "refused";
  readonly at: string;
  /** Set once the run got as far as computing them. */
  readonly revision?: string;
  readonly artifact?: string;
  readonly refresh?: RefreshIdentity;
  readonly target?: string;
  readonly operator?: string;
  /** The run's Kuwait date; the plan identity binds it (M-1's age rule). */
  readonly today?: string;
  /**
   * For `doccheck`: the mirror generation the run verified (refresh report and the mirror's own
   * marker agree), bound only after every equality check. Absent when the result is diagnostic.
   */
  readonly mirror?: { readonly generation: string };
  readonly plan?: string;
  /** Steps whose results were confirmed, in order. */
  readonly steps: readonly ReceiptStep[];
  /** For a failed write: the steps not confirmed; the first may have committed in part. */
  readonly unconfirmed?: readonly string[];
  /** For a refused or failed run: the fixed code. */
  readonly code?: string;
  /** For `promote`: counts only, never a principal or legacy id. */
  readonly promotion?: PromotionCounts;
  /**
   * For `write`: the staged contact set the plan writes (contactSetDigest over every planned
   * candidate_contact row's legacy id and keyed digest) and the digest key's fingerprint. A
   * `promote` requires both to match: the staged table holds exactly that set, under that key.
   */
  readonly contacts?: string;
  readonly digestKey?: string;
  /** For `promote`: the accepted write invocation it consumed. */
  readonly acceptedWrite?: string;
  /** For `linkreport`: totals and counts per rule only; the ids are in the private report. */
  readonly links?: ReturnType<typeof linkReportCounts>;
  /** For `doccheck`: counts only and the checked set's digest; ids, kinds and hashes are in the private report. */
  readonly documents?: DocCheckCounts;
  /** For `doccopy`: the accepted doccheck it consumed. */
  readonly acceptedDoccheck?: string;
  /** For `doccopy`: an opaque fingerprint of the staging account and bucket it wrote to. */
  readonly staging?: string;
  /** For `doccopy`: counts per outcome, the staged set's digest and whether every approved document was handled. */
  readonly copy?: DocCopyCounts;
  /** For `docpromote`: the accepted doccopy it consumed. */
  readonly acceptedCopy?: string;
  /** For `docpromote`: an opaque fingerprint of the destination account, bucket and organization it promoted into. */
  readonly promotionDestination?: string;
  /** For `docpromote`: counts per outcome only, never a principal or legacy id. */
  readonly docPromotion?: DocPromotionCounts;
  /** For `staffwork` (M-5): staff resolution counts per reason, and per table counts per code only. */
  readonly staffWork?: StaffWorkCounts;
  /** For `candidatework` (M-5): people and store lookup counts, and per table counts per code only. */
  readonly candidateWork?: CandidateWorkCounts;
}

/** What `candidatework` publishes: counts only, never a legacy ref, principal, time or place. */
export interface CandidateWorkCounts {
  readonly candidates: { readonly looked: number; readonly linked: number; readonly people: number; readonly unplaced: number };
  readonly stores: { readonly looked: number; readonly mapped: number };
  readonly tables: CandidateWorkOutcome["tables"];
  readonly clean: boolean;
  readonly complete: boolean;
}

/** What `staffwork` publishes: counts only, never a legacy ref, principal, address or time. */
export interface StaffWorkCounts {
  readonly staff: { readonly rows: number; readonly resolved: number; readonly unresolved: Readonly<Partial<Record<StaffUnresolved, number>>> };
  readonly tables: StaffWorkOutcome["tables"];
  readonly clean: boolean;
  readonly complete: boolean;
}

/** Outcomes of one `docpromote` run. Terminal ones are recorded in legacy_document_promotions. */
export type DocPromotionRule = DocumentPromotionOutcome | "stagingUnreadable";
export interface DocPromotionCounts {
  /** Documents in the accepted copy (the selected set). */
  readonly selected: number;
  /** (person, kind) pairs this run handled. */
  readonly handled: number;
  readonly rules: Readonly<Record<DocPromotionRule, number>>;
  /** The staged set the run promoted from (equals the accepted copy's staged digest). */
  readonly staged: string;
  /** True when the walk reached the end and nothing it met is left to try again. */
  readonly complete: boolean;
  /** True when the walk stopped at M4_DOCPROMOTE_MAX_DOCS or M4_DOCPROMOTE_MAX_MS. */
  readonly bounded: boolean;
}

export interface DocCopyCounts {
  /** Approved documents in the accepted doccheck. */
  readonly approved: number;
  /** Documents this run handled. */
  readonly handled: number;
  /** Approved bytes this run handled against M4_DOCCOPY_MAX_APPROVED_BYTES. */
  readonly approvedBytes: number;
  /** Rule counts over the checkpoint. */
  readonly rules: Readonly<Record<CopyRule, number>>;
  /** How the run started: no checkpoint, an untrusted one (no credit), or resumed, from which canonical index to which. */
  readonly checkpoint: { readonly credit: "none" | "untrusted" | "resumed"; readonly from: number; readonly next: number };
  /** documentSetDigest over the documents the checkpoint verified; equals the accepted set only when all verified. */
  readonly staged: string;
  /** Whether staged equals the accepted doccheck's documents.set. */
  readonly matchesAccepted: boolean;
  readonly complete: boolean;
  /** Objects under this generation that no approved document accounts for ((legacy id, kind) pairs in the private report). */
  readonly orphans: number;
  /** True when the orphan scan stopped at its page bound before the last page. */
  readonly orphansTruncated: boolean;
}

export interface DocCheckCounts {
  /** Candidate rows read (the whole table, counted before and after). */
  readonly candidates: number;
  /** Documents the mapper names for imported people. */
  readonly mapped: number;
  readonly checked: number;
  readonly bytes: number;
  readonly rules: Readonly<Record<DocumentIssueRule | DocumentCheckRule, number>>;
  /** documentSetDigest over the checked documents: what a copy step must find again. */
  readonly set: string;
  /**
   * Present (true) when the refresh report predates mirror provenance (server, schema, generation,
   * lock and counts), so this run could not prove it read the copy the report describes.
   * Diagnostic only: never authorizes a copy.
   */
  readonly diagnostic?: true;
}

/** The mirror's own identity, read through the same reader as the sources. */
export const MIRROR_IDENTITY_SQL = "SELECT JSON_OBJECT('id', @@server_uuid, 'schema', DATABASE(), "
  + `'generation', (SELECT MAX(generation) FROM \`${MIRROR_GENERATION_TABLE}\`), 'markers', (SELECT COUNT(*) FROM \`${MIRROR_GENERATION_TABLE}\`))`;

/** What an ok refresh report says about the copy it made; undefined when the report predates it. */
export function refreshProvenance(last: unknown): { serverId: string; schema: string; generation: string; lock: string; candidates: number } | undefined {
  if (!last || typeof last !== "object") return undefined;
  const r = last as { mirror?: { serverId?: unknown; schema?: unknown; generation?: unknown }; lock?: unknown; tables?: Record<string, unknown> };
  const { serverId, schema, generation } = r.mirror ?? {};
  const candidates = r.tables?.candidate;
  if (typeof serverId !== "string" || !serverId || typeof schema !== "string" || !schema
    || typeof generation !== "string" || !GENERATION.test(generation) || typeof r.lock !== "string" || !r.lock
    || !Number.isSafeInteger(candidates) || (candidates as number) < 0) return undefined;
  return { serverId, schema, generation, lock: r.lock, candidates: candidates as number };
}

export { documentSetDigest };

/**
 * A digest of a staged contact set: sha256 over its (legacy id, keyed row digest) pairs, sorted
 * by id. No value and no key; the same function reads the plan (write) and the table (promote).
 */
export function contactSetDigest(pairs: readonly (readonly [string, string])[]): string {
  const sorted = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(["m4-contact-set-v1", sorted])).digest("hex");
}

/** A non-secret fingerprint of the contact digest key: an HMAC of a fixed label under it. */
export function digestKeyFingerprint(key: Buffer): string {
  return createHmac("sha256", key).update("m4-contact-digest-key-check-v1").digest("hex");
}

/** What a `promote` run did, as counts per outcome; the per-principal record is in the database. */
export interface PromotionCounts {
  promoted: number;
  skipped: Record<string, number>;
  phone: Record<string, number>;
  handle: Record<string, number>;
  civilId: Record<string, number>;
  email: Record<string, number>;
}

/** Adds one promotion result to the counts. */
export function countPromotion(counts: PromotionCounts, result: ContactPromotionResult): void {
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  if (result.kind === "skipped") { bump(counts.skipped, result.reason); return; }
  counts.promoted++;
  bump(counts.phone, result.outcomes.phone);
  bump(counts.handle, result.outcomes.handle);
  bump(counts.civilId, result.outcomes.civilId);
  bump(counts.email, result.outcomes.email);
}

/** The promotion step, on the writer session. */
export interface ContactPromoter {
  /** Pending principals in id order, strictly after `after` when given. */
  pending(limit: number, after?: string): Promise<readonly string[]>;
  promote(principalId: string): Promise<ContactPromotionResult>;
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
  /**
   * Whether this civil ID key opens the target's provisioned check value (migration 0656):
   * "missing" when none is provisioned, "mismatch" when the key does not open it.
   */
  civilKey(key: Buffer): Promise<"ok" | "missing" | "mismatch">;
  /**
   * The `keycheck` step: provisions the check value under this key when the staging marker has
   * none (set once), else checks the key against it. Never replaces a provisioned value.
   */
  provisionCivilKeyCheck(key: Buffer, targetId: string): Promise<"set" | "ok" | "mismatch">;
  /** Takes the one-writer lock for this database without waiting; held until close. */
  claimWriter(): Promise<boolean>;
  /** Writers bound to the lock-holding session; only after claimWriter. */
  writers(): M4Writers;
  /** Whether the promotion schema is migrated (M4_PROMOTE_REQUIRED_MIGRATION applied, its table present). */
  promotionReady(): Promise<boolean>;
  /** The promotion step bound to the lock-holding session; only after claimWriter. */
  promoter(): ContactPromoter;
  /** contactSetDigest over every staged legacy_candidate_contacts row, read on the writer session. */
  stagedContacts(): Promise<string>;
  /** Whether the link report's tables are migrated (LINK_REPORT_READY_SQL). */
  linkReportReady(): Promise<boolean>;
  /** The M-3 link report, read in one read-only snapshot; needs no writer lock. */
  linkReport(): Promise<LinkReport>;
  /** Whether the document staging schema is migrated (M4_DOCCOPY_REQUIRED_MIGRATION applied, its table present). */
  documentsReady(): Promise<boolean>;
  /** The staging document account and bucket recorded on the staging marker row, or null when none is recorded. */
  documentBucket(): Promise<{ readonly account: string; readonly bucket: string } | null>;
  /** The staging table bound to the lock-holding session; only after claimWriter. */
  documentStaging(): DocumentStagingStore;
  /** The copy's checkpoint table on the same session; only after claimWriter. */
  copyCheckpoints(): CopyCheckpointStore;
  /** Whether the promotion record (0662) and the per-owner document store (0661, authoritative) are migrated. */
  docPromotionReady(): Promise<boolean>;
  /** The promotion destination recorded on the staging marker row (0662), or null when none is recorded. */
  promotionDestination(): Promise<PromotionDestination | null>;
  /** Every staged row of one generation, read on the writer session; only after claimWriter. */
  stagedGeneration(generation: string): Promise<readonly StagedDocument[]>;
  /**
   * Linked (person, staged document) pairs of one generation with no promotion record, in
   * (principal, kind) C order strictly after `after`, at most `limit`; on the writer session.
   */
  pendingDocPromotions(generation: string, limit: number, after?: { readonly principalId: string; readonly kind: string }): Promise<readonly PendingDocPromotion[]>;
  /** Re-checks, on the lock session itself, that it is alive and still holds the lock. */
  stillHeld(): Promise<boolean>;
  /** Whether the M-5 staff tables (0505, 0506, 0508, 0509) and the address key (0658) are migrated. */
  staffWorkReady(): Promise<boolean>;
  /** Matches legacy staff addresses to principals by the one address key; ids and flags come back. */
  staffMatcher(): StaffMatcher;
  /** The work lane's import store on the lock-holding session; only after claimWriter. */
  workImport(): Pick<PostgresWorkImportStore, "importStandupQuestions" | "importStaffSessions" | "importStandupAnswers" | "importStaffHours" | "reconcileStaffImport"
    | "importPlacements" | "importSessions" | "importDecisions" | "reconcileCandidateImport">;
  /** Whether the work tables and import digests (0500 to 0504), the account links (0215) and the id maps (0650) are migrated. */
  candidateWorkReady(): Promise<boolean>;
  /** Legacy candidate ids to the principals that linked them; ids only. */
  candidateLinks(): CandidateLinkLookup;
  /** Legacy store ids to the platform store and its organization, through the M-4 id map. */
  storeMap(): StoreLookup;
  /** Whether the lock session was lost or broken at any point. Once true, stays true. */
  lost(): boolean;
  /** Releases the writer lock and the connections. */
  close(): Promise<void>;
}

/**
 * The newest migration a write needs: the civil ID key check (0656, after the people snapshot
 * table 0653, the contact table 0654 and its verified-address column 0655). Checked before
 * `started`, so a target that lacks it refuses before any step instead of failing at the last
 * steps after the others committed.
 */
export const M4_REQUIRED_MIGRATION = "0656_legacy_import_civil_key_check";
export const SCHEMA_READY_SQL = `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${M4_REQUIRED_MIGRATION}')
  AND to_regclass('public.legacy_candidate_snapshots') IS NOT NULL
  AND to_regclass('public.legacy_candidate_contacts') IS NOT NULL AS ready`;

/**
 * The newest migration `promote` needs: 0659 (after the promotion record 0657 and the shared ASCII
 * address key 0658). Without it the promotion would decide addresses by the old rule.
 */
export const M4_PROMOTE_REQUIRED_MIGRATION = "0659_drop_principal_email_rekey";
/** The newest migration `doccopy` needs: the staging table and the target's document bucket (0660). */
export const M4_DOCCOPY_REQUIRED_MIGRATION = "0660_legacy_candidate_documents";
export const DOCUMENTS_READY_SQL = `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${M4_DOCCOPY_REQUIRED_MIGRATION}')
  AND to_regclass('public.legacy_candidate_documents') IS NOT NULL AS ready`;
export const PROMOTION_READY_SQL = `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${M4_PROMOTE_REQUIRED_MIGRATION}')
  AND to_regclass('public.legacy_contact_promotions') IS NOT NULL
  AND to_regprocedure('public.principal_email_key(text)') IS NOT NULL AS ready`;
/**
 * What `linkreport` reads: the snapshots (0653), the links (0215) and the promotion record (0657),
 * at the promotion's schema (0659), so its outcome codes are the ones the report names.
 */
export const LINK_REPORT_READY_SQL = `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${M4_PROMOTE_REQUIRED_MIGRATION}')
  AND to_regclass('public.legacy_candidate_snapshots') IS NOT NULL
  AND to_regclass('public.legacy_account_links') IS NOT NULL
  AND to_regclass('public.legacy_account_link_events') IS NOT NULL
  AND to_regclass('public.legacy_contact_promotions') IS NOT NULL AS ready`;
/** What `docpromote` needs: the promotion record (0662) on the per-owner document store (0661). */
export const M4_DOCPROMOTE_REQUIRED_MIGRATION = "0662_legacy_document_promotions";
/** The migrations `staffwork` needs: the work lane's staff tables and import digests, and the address key. */
export const M5_STAFF_REQUIRED_MIGRATIONS = ["0505_work_staff_time", "0506_work_standup", "0508_work_staff_import", "0509_work_staff_hours_per_day", "0658_principal_email_ascii_key"] as const;
export const STAFF_WORK_READY_SQL = `SELECT (SELECT count(*) FROM schema_migrations WHERE version = ANY($1::text[])) = ${M5_STAFF_REQUIRED_MIGRATIONS.length}
  AND to_regclass('public.work_staff_hours_per_day') IS NOT NULL AND to_regprocedure('principal_email_key(text)') IS NOT NULL AS ready`;
/** The migrations `candidatework` needs: stores, account links, the work tables with import digests, and the id maps. */
export const M5_CANDIDATE_REQUIRED_MIGRATIONS = ["0202_organization_stores", "0215_legacy_account_links", "0500_work_assignments", "0501_work_sessions",
  "0502_work_decisions", "0504_work_legacy_import", "0650_legacy_id_maps"] as const;
export const CANDIDATE_WORK_READY_SQL = `SELECT (SELECT count(*) FROM schema_migrations WHERE version = ANY($1::text[])) = ${M5_CANDIDATE_REQUIRED_MIGRATIONS.length}
  AND to_regclass('public.legacy_id_maps') IS NOT NULL AND to_regclass('public.legacy_account_links') IS NOT NULL AS ready`;
export const DOC_PROMOTION_READY_SQL = `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${M4_DOCPROMOTE_REQUIRED_MIGRATION}')
  AND EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0661_candidate_document_partitions')
  AND to_regclass('public.legacy_document_promotions') IS NOT NULL
  AND to_regclass('public.candidate_document_partitions') IS NOT NULL
  AND EXISTS (SELECT 1 FROM candidate_document_store_authority WHERE singleton AND store = 'partitioned') AS ready`;
/** The document store a promotion writes into: account, bucket and the candidate documents' organization. */
export interface PromotionDestination { readonly account: string; readonly bucket: string; readonly org: string }
const DESTINATION_ACCOUNT = /^[a-f0-9]{32}$/, DESTINATION_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, DESTINATION_ORG = /^[A-Za-z0-9_-]{1,128}$/;
/** An opaque fingerprint of a promotion destination, for receipts. */
export const promotionDestinationFingerprint = (d: PromotionDestination): string =>
  createHash("sha256").update(`m2-promotion-destination-v1\n${d.account}/${d.bucket}\n${d.org}`).digest("hex");
export interface PendingDocPromotion { readonly principalId: string; readonly legacyId: string; readonly kind: string }
/** How many pending principals `promote` takes at a time. */
export const PROMOTE_BATCH = 500;

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
    civilKey: async (key) => {
      let check: Buffer | null | undefined;
      try { check = (await pool.query<{ check: Buffer | null }>("SELECT civil_key_check AS check FROM legacy_import_target")).rows[0]?.check; } catch { return "missing"; }
      if (!check) return "missing";
      return civilKeyOpens(new CivilIdVault(key), check) ? "ok" : "mismatch";
    },
    provisionCivilKeyCheck: async (key, targetId) => {
      const vault = new CivilIdVault(key);
      const sealed = vault.seal(CIVIL_KEY_CHECK.ref, CIVIL_KEY_CHECK.country, CIVIL_KEY_CHECK.number);
      const { rowCount } = await pool.query(
        `UPDATE legacy_import_target SET civil_key_check = $1, civil_key_check_version = $2, civil_key_check_set_at = clock_timestamp()
          WHERE civil_key_check IS NULL AND environment = 'staging' AND target_id = $3`, [sealed.ciphertext, sealed.keyVersion, targetId]);
      if (rowCount === 1) return "set";
      const { rows: [row] } = await pool.query<{ check: Buffer | null }>(
        "SELECT civil_key_check AS check FROM legacy_import_target WHERE environment = 'staging' AND target_id = $1", [targetId]);
      return row?.check && civilKeyOpens(vault, row.check) ? "ok" : "mismatch";
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
    promotionReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(PROMOTION_READY_SQL)).rows[0]?.ready === true; } catch { return false; }
    },
    promoter: () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      if (!keys?.civilId) throw new Error("m4.contactKeys");
      const promotion = new PostgresContactPromotion(writer, new CivilIdVault(keys.civilId), keys.digest);
      return { pending: (limit, after) => promotion.pending(limit, after), promote: (id) => promotion.promote(id) };
    },
    stagedContacts: async () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      const { rows } = await writer.query<{ id: string; digest: string }>("SELECT legacy_candidate_id AS id, digest FROM legacy_candidate_contacts");
      return contactSetDigest(rows.map((r) => [r.id, r.digest] as const));
    },
    linkReportReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(LINK_REPORT_READY_SQL)).rows[0]?.ready === true; } catch { return false; }
    },
    linkReport: () => readLinkReport(pool),
    documentsReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(DOCUMENTS_READY_SQL)).rows[0]?.ready === true; } catch { return false; }
    },
    documentBucket: async () => {
      try {
        const { rows } = await pool.query<{ account: string | null; bucket: string | null }>(
          "SELECT document_account AS account, document_bucket AS bucket FROM legacy_import_target WHERE environment = 'staging'");
        const r = rows.length === 1 ? rows[0]! : null;
        return r?.account && r.bucket ? { account: r.account, bucket: r.bucket } : null;
      } catch { return null; }
    },
    documentStaging: () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      return postgresDocumentStaging(writer);
    },
    copyCheckpoints: () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      return postgresCopyCheckpoints(writer);
    },
    promotionDestination: async () => {
      try {
        const { rows } = await pool.query<{ account: string | null; bucket: string | null; org: string | null }>(
          "SELECT promotion_account AS account, promotion_bucket AS bucket, promotion_org AS org FROM legacy_import_target WHERE environment = 'staging'");
        const r = rows.length === 1 ? rows[0]! : null;
        return r?.account && r.bucket && r.org ? { account: r.account, bucket: r.bucket, org: r.org } : null;
      } catch { return null; }
    },
    docPromotionReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(DOC_PROMOTION_READY_SQL)).rows[0]?.ready === true; } catch { return false; }
    },
    stagedGeneration: async (generation) => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      const { rows } = await writer.query<{ id: string; kind: StagedDocument["kind"]; mime: StagedDocument["mime"]; size: number; sha256: string; object_key: string }>(
        `SELECT legacy_candidate_id AS id, kind, mime, size, sha256, object_key FROM legacy_candidate_documents WHERE generation = $1`, [generation]);
      return rows.map((r) => ({ legacyId: r.id, kind: r.kind, generation, mime: r.mime, size: Number(r.size), sha256: r.sha256, objectKey: r.object_key }));
    },
    pendingDocPromotions: async (generation, limit, after) => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("limit must be 1 to 10000");
      const { rows } = await writer.query<{ principal_id: string; legacy_candidate_id: string; kind: string }>(
        `SELECT l.principal_id, d.legacy_candidate_id, d.kind FROM legacy_candidate_documents d
           JOIN legacy_account_links l ON l.legacy_candidate_id = d.legacy_candidate_id
          WHERE d.generation = $1
            AND NOT EXISTS (SELECT 1 FROM legacy_document_promotions p WHERE p.principal_id = l.principal_id AND p.kind = d.kind)
            AND ($3::text IS NULL OR (l.principal_id COLLATE "C", d.kind COLLATE "C") > ($3::text COLLATE "C", $4::text COLLATE "C"))
          ORDER BY l.principal_id COLLATE "C", d.kind COLLATE "C" LIMIT $2`, [generation, limit, after?.principalId ?? null, after?.kind ?? null]);
      return rows.map((r) => ({ principalId: r.principal_id, legacyId: r.legacy_candidate_id, kind: r.kind }));
    },
    stillHeld: async () => (writer ? writer.fence() : false),
    staffWorkReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(STAFF_WORK_READY_SQL, [M5_STAFF_REQUIRED_MIGRATIONS])).rows[0]?.ready === true; } catch { return false; }
    },
    staffMatcher: () => async (candidates, operatorOrgId) => {
      const { rows } = await pool.query<{ staff_id: string; principal_id: string; verified: boolean; operator_staff: boolean }>(
        STAFF_MATCH_SQL, [JSON.stringify(candidates.map((c) => ({ staff_id: c.staffId, email: c.email }))), operatorOrgId]);
      return rows.map((r) => ({ staffId: r.staff_id, principalId: r.principal_id, verified: r.verified === true, operatorStaff: r.operator_staff === true }));
    },
    candidateWorkReady: async () => {
      try { return (await pool.query<{ ready: boolean }>(CANDIDATE_WORK_READY_SQL, [M5_CANDIDATE_REQUIRED_MIGRATIONS])).rows[0]?.ready === true; } catch { return false; }
    },
    candidateLinks: () => async (ids) => {
      const { rows } = await pool.query<{ legacy_candidate_id: string; principal_id: string }>(CANDIDATE_LINK_SQL, [[...ids]]);
      return new Map(rows.map((r) => [r.legacy_candidate_id, r.principal_id]));
    },
    storeMap: () => async (ids) => {
      const { rows } = await pool.query<{ legacy_id: string; store_id: string; org_id: string }>(STORE_MAP_SQL, [[...ids]]);
      return new Map<string, MappedStore>(rows.map((r) => [r.legacy_id, { storeId: r.store_id, orgId: r.org_id }]));
    },
    workImport: () => {
      if (!writer) throw new Error("m4.writerNotClaimed");
      return new PostgresWorkImportStore(writer);
    },
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
  /** The legacy bucket, read-only (doccheck only; default envBucket). Throws m2.bucket.config on a bad setting. */
  readonly bucket?: (env: NodeJS.ProcessEnv) => LegacyObjectReader;
  /** The staging document bucket (doccopy only; default envStaging). Throws on a bad setting. */
  readonly staging?: (env: NodeJS.ProcessEnv) => StagingObjects;
  /** The promotion step over the live document store (docpromote only; default envPromoter). Throws on a bad setting. */
  readonly promoter?: (env: NodeJS.ProcessEnv) => DocumentPromoter;
  /**
   * Ends the process at once (default process.exit). Used only when a storage write did not settle
   * after it was aborted: the locks are then not released in-process, and ending the process
   * closes their connections.
   */
  readonly halt?: (code: number) => void;
  readonly provenance: () => Provenance;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** The legacy bucket adapter from the run's environment (doccheck only). */
export const envBucket = (e: NodeJS.ProcessEnv): LegacyObjectReader => legacyBucketReader({ bucket: e.M4_LEGACY_BUCKET ?? "",
  region: e.M4_LEGACY_BUCKET_REGION ?? "", accessKeyId: e.M4_LEGACY_BUCKET_ACCESS_KEY_ID ?? "", secretAccessKey: e.M4_LEGACY_BUCKET_SECRET_ACCESS_KEY ?? "" });

/** The staging document bucket from the run's environment (doccopy only). */
export const envStaging = (e: NodeJS.ProcessEnv): StagingObjects => stagingBucket({ accountId: e.M4_STAGING_DOCUMENT_ACCOUNT_ID ?? "",
  bucket: e.M4_STAGING_DOCUMENT_BUCKET ?? "", accessKeyId: e.M4_STAGING_DOCUMENT_ACCESS_KEY_ID ?? "", secretAccessKey: e.M4_STAGING_DOCUMENT_SECRET_ACCESS_KEY ?? "" });

/** The promotion step `docpromote` drives: one staged document into one person's slot. */
export interface DocumentPromoter {
  promote(principalId: string, staged: StagedLegacyDocument, bytes: Buffer, binding: { readonly acceptedCopy: string; readonly invocation: string }): Promise<DocumentPromotionOutcome>;
  close(): Promise<void>;
}

/**
 * The promotion over the target's per-owner document store and the live document bucket
 * (M4_LIVE_DOCUMENT_ACCOUNT_ID, _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY) for the candidate
 * documents' organization (M4_DOCUMENT_ORG_ID). Throws on a bad setting.
 */
export const envPromoter = (e: NodeJS.ProcessEnv): DocumentPromoter => {
  const objects = new R2Objects({ accountId: e.M4_LIVE_DOCUMENT_ACCOUNT_ID ?? "", bucket: e.M4_LIVE_DOCUMENT_BUCKET ?? "",
    accessKeyId: e.M4_LIVE_DOCUMENT_ACCESS_KEY_ID ?? "", secretAccessKey: e.M4_LIVE_DOCUMENT_SECRET_ACCESS_KEY ?? "" });
  if (!e.M4_DATABASE_URL) throw new Error("m2.promote.config");
  const partitions = new PostgresDocumentPartitions(e.M4_DATABASE_URL);
  const promotion = new LegacyDocumentPromotion({ partitions, objects, orgId: e.M4_DOCUMENT_ORG_ID ?? "" });
  return { promote: (p, s, b, binding) => promotion.promote(p, s, b, binding), close: async () => { objects.close(); await partitions.close(); } };
};

/** `built` is the provenance tools/legacy-import/m4-launch.mjs verified before loading this module. */
export const defaultDeps = (env: NodeJS.ProcessEnv, built: Provenance): CliDeps => ({
  env,
  lock: acquireSharedLock,
  reader: (e) => mirrorReader(parseDatabaseUrl(e.M4_LEGACY_MIRROR_URL, "mirror")),
  target: (e) => postgresTarget(e.M4_DATABASE_URL ?? "", e.M4_IMPORT_ACTOR ?? "", e.M4_OPERATOR_ORG_ID ?? "", contactKeysFrom(e, "write")),
  bucket: envBucket,
  staging: envStaging,
  promoter: envPromoter,
  halt: (code) => process.exit(code),
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
  if (mode !== "plan" && mode !== "write" && mode !== "keycheck" && mode !== "promote" && mode !== "linkreport" && mode !== "doccheck" && mode !== "doccopy" && mode !== "docpromote" && mode !== "staffwork" && mode !== "candidatework") { deps.error("m4: refused.usage"); return 2; }
  const invocation = env.M4_INVOCATION ?? "";
  // Without a fresh, unclaimed name there is nowhere this run's outcome could be published.
  if (!UUID.test(invocation)) { deps.error("m4: refused.invocation"); return 2; }
  const dir = env.M4_OUTPUT_DIR || DEFAULT_M4_OUTPUT_DIR;
  if (!claimInvocation(dir, invocation)) { deps.error("m4: refused.invocationUsed"); return 2; }

  const receiptPath = path.join(dir, `${invocation}.${mode}.receipt.json`);
  const reportPath = path.join(dir, `${invocation}.${mode}.report.json`);
  let abandon = false;
  let bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps"> = {};
  const confirmed: M4Step[] = [];
  let order: readonly string[] = [];
  let links: M4Receipt["links"];
  let documents: M4Receipt["documents"];
  let copy: M4Receipt["copy"];
  let docPromotion: M4Receipt["docPromotion"];
  let staffWork: M4Receipt["staffWork"];
  let candidateWork: M4Receipt["candidateWork"];
  const publish = (status: M4Receipt["status"], code?: string, promotion?: PromotionCounts) => {
    const unconfirmed = status === "failed" && mode !== "promote" ? order.slice(confirmed.length) : undefined;
    writeWhole(receiptPath, { schemaVersion: 2, invocation, kind: mode, status, at: deps.now().toISOString(), ...bound,
      steps: confirmed.map(receiptStep), ...(unconfirmed ? { unconfirmed } : {}), ...(code ? { code } : {}),
      ...(promotion ? { promotion } : {}), ...(links ? { links } : {}), ...(documents ? { documents } : {}), ...(copy ? { copy } : {}), ...(docPromotion ? { docPromotion } : {}), ...(staffWork ? { staffWork } : {}), ...(candidateWork ? { candidateWork } : {}) } satisfies M4Receipt);
  };
  const refuse = (code: string): never => { throw new Refusal(code); };

  let lock: SharedLock = { held: false };
  let target: WriteTarget | undefined;
  let writing = false;
  try {
    const revision = env.M4_REVISION ?? "";
    if (!/^[0-9a-f]{40}$/.test(revision)) refuse("revision");
    const targetId = env.M4_TARGET_ID ?? "";
    if (mode === "keycheck") return await keycheck(deps, revision, targetId, publish, (b) => { bound = b; }, (t) => { target = t; });
    if (mode === "linkreport") return await linkReport(deps, revision, targetId, publish, reportPath, (b, l) => { bound = b; links = l; }, (t) => { target = t; });
    if (mode === "doccheck") {
      return await docCheck(deps, revision, publish, reportPath, (b, d) => { bound = b; documents = d; }, (l) => { lock = l; });
    }
    if (mode === "doccopy") {
      return await docCopy(deps, revision, publish, reportPath, (b, c) => { bound = b; copy = c; }, (l) => { lock = l; }, (t) => { target = t; }, () => { abandon = true; });
    }
    if (mode === "docpromote") {
      return await docPromote(deps, revision, publish, (b, c) => { bound = b; docPromotion = c; }, (t) => { target = t; });
    }
    if (mode === "staffwork") {
      return await staffWorkRun(deps, revision, targetId, publish, reportPath, (b, w) => { bound = b; staffWork = w; }, (l) => { lock = l; }, (t) => { target = t; });
    }
    if (mode === "candidatework") {
      return await candidateWorkRun(deps, revision, targetId, publish, reportPath, (b, w) => { bound = b; candidateWork = w; }, (l) => { lock = l; }, (t) => { target = t; });
    }
    if (mode === "promote") return await promote(deps, revision, targetId, publish, (b) => { bound = b; }, (t) => { target = t; });
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
    bound = { ...bound, today, plan: identity,
      contacts: contactSetDigest(plan.personContacts.contacts.map((r) => [r.legacyId, personContactDigest(keys!.digest, r)] as const)),
      digestKey: digestKeyFingerprint(keys!.digest) };
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
    // The supplied civil ID key must open the target's provisioned check (the `keycheck` step),
    // so a well-formed wrong key is refused before any write.
    if (await target.civilKey(keys!.civilId!) !== "ok") refuse("civilKey");
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
    // The writer lock is held until the terminal receipt above is published. After an unsettled
    // storage write nothing is released in-process: the process ends and its connections close.
    if (abandon) (deps.halt ?? ((code: number) => process.exit(code)))(1);
    else {
      await target?.close();
      if (lock.held) lock.release();
    }
  }
}

/**
 * `keycheck`: provisions, once, the target's civil ID key check (migration 0656), or confirms the
 * supplied key against it. The key comes from staging's platform configuration (the gateway's
 * CIVIL_ID_ENCRYPTION_KEY), never from a card. It reads no legacy data and writes nothing else.
 * Exit 0 when the check was set or the key opens it; 2 when refused (a mismatch is `civilKey`).
 */
async function keycheck(deps: CliDeps, revision: string, targetId: string,
  publish: (status: M4Receipt["status"], code?: string) => void,
  bind: (bound: { revision: string; artifact: string; target: string }) => void, track: (target: WriteTarget) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  if (!UUID.test(targetId)) return refuse("destination");
  if (!env.M4_DATABASE_URL) return refuse("writeConfig");
  const key = keyFrom(env.M4_CIVIL_ID_ENCRYPTION_KEY);
  if (!key) return refuse("contactKeys");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  // From here every receipt names the verified build and the target it ran against: the evidence
  // a staging write's review requires that the check was provisioned by this exact artifact.
  bind({ revision, artifact, target: targetId });
  const target = deps.target(env);
  track(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.schemaReady()) return refuse("schema");
  const result = await target.provisionCivilKeyCheck(key, targetId);
  if (result === "mismatch") return refuse("civilKey");
  publish("ok");
  deps.log(`m4 keycheck ok invocation=${env.M4_INVOCATION} target=${targetId} revision=${revision} artifact=${artifact} check=${result === "set" ? "set" : "matched"}`);
  return 0;
}

/**
 * `promote`: moves linked people's staged contact values into the person-owned tables
 * (PostgresContactPromotion, migrations 0657-0659), one principal per transaction, under the
 * target's one-writer lock, so it never runs beside a `write`. It reads no legacy data.
 *
 * It consumes one accepted write only: M4_ACCEPTED_WRITE names a write invocation whose own
 * terminal receipt in M4_OUTPUT_DIR says ok for M4_EXPECTED_PLAN, for this target, revision and
 * artifact. Its contact digest key must have the fingerprint that write recorded (so a wrong but
 * well-formed key never records `mismatch`), and the staged table must hold exactly the contact
 * set that write recorded (so rows left by a partial, failed or other write are never consumed).
 * The civil ID key must open the target's check. Then it walks every pending principal once, in
 * id order with a cursor, so repeats and skipped principals never end the walk early. The receipt
 * carries counts per outcome only. Exit 0 when the walk finished, 1 when it failed part way (a
 * re-run promotes only the rest), 2 when refused before any promotion.
 */
async function promote(deps: CliDeps, revision: string, targetId: string,
  publish: (status: M4Receipt["status"], code?: string, promotion?: PromotionCounts) => void,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">) => void, track: (target: WriteTarget) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  if (!UUID.test(targetId)) return refuse("destination");
  const accepted = env.M4_ACCEPTED_WRITE ?? "";
  const expected = env.M4_EXPECTED_PLAN ?? "";
  if (!env.M4_DATABASE_URL || !UUID.test(accepted) || accepted === env.M4_INVOCATION || !HEX64.test(expected)) return refuse("writeConfig");
  const keys = contactKeysFrom(env, "write");
  if (!keys) return refuse("contactKeys");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  bind({ revision, artifact, target: targetId });
  // The accepted write, by its own terminal receipt: ok for the reviewed plan, same target and build.
  let write: Partial<M4Receipt> | undefined;
  try {
    write = JSON.parse(readFileSync(path.join(env.M4_OUTPUT_DIR || DEFAULT_M4_OUTPUT_DIR, `${accepted}.write.receipt.json`), "utf8")) as Partial<M4Receipt>;
  } catch { write = undefined; }
  if (!write || write.schemaVersion !== 2 || write.kind !== "write" || write.invocation !== accepted || write.status !== "ok" || write.plan !== expected
    || write.target !== targetId || write.revision !== revision || write.artifact !== artifact
    || typeof write.contacts !== "string" || !HEX64.test(write.contacts) || typeof write.digestKey !== "string") return refuse("acceptedWrite");
  bind({ revision, artifact, target: targetId, plan: expected, acceptedWrite: accepted });
  if (digestKeyFingerprint(keys.digest) !== write.digestKey) return refuse("digestKey");
  const target = deps.target(env);
  track(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.promotionReady()) return refuse("promotionSchema");
  if (await target.civilKey(keys.civilId!) !== "ok") return refuse("civilKey");
  if (!await target.claimWriter()) return refuse("writerBusy");
  // Under the writer lock, so no write can change the staged set from here to the end.
  let staged: string;
  try { staged = await target.stagedContacts(); } catch { staged = ""; }
  if (staged !== write.contacts) return refuse("stagedInput");
  const counts: PromotionCounts = { promoted: 0, skipped: {}, phone: {}, handle: {}, civilId: {}, email: {} };
  publish("started", undefined, counts);
  try {
    const promoter = target.promoter();
    let after: string | undefined;
    for (;;) {
      const batch = await promoter.pending(PROMOTE_BATCH, after);
      if (batch.length === 0) break;
      for (const id of batch) {
        if (after !== undefined && !(id > after)) throw new Error("m4.promoteOrder");
        countPromotion(counts, await promoter.promote(id));
        after = id;
      }
    }
    if (!await target.stillHeld()) throw new Error("m4.writerLost");
  } catch (error) {
    const code = target.lost() ? "m4.writerLost" : error instanceof ContactPromotionError ? error.code : errorCode(error);
    deps.error(`m4: ${code}`);
    try { publish("failed", code, counts); } catch { /* the exit code still says failed */ }
    return 1;
  }
  publish("ok", undefined, counts);
  const line = (name: string, m: Record<string, number>) => `${name} ${Object.entries(m).sort().map(([k, n]) => `${k}=${n}`).join(" ")}`.trimEnd();
  for (const l of [line("phone", counts.phone), line("handle", counts.handle), line("civilId", counts.civilId), line("email", counts.email), line("skipped", counts.skipped)]) deps.log(l);
  deps.log(`m4 promote ok invocation=${env.M4_INVOCATION} target=${targetId} revision=${revision} artifact=${artifact} write=${accepted} promoted=${counts.promoted}`);
  return 0;
}

/**
 * `linkreport` (M-3): the identity link report for staff follow-up (readLinkReport): imported
 * candidates with no link, links to candidates the import does not carry, candidates linked to
 * more than one person over time, and promoted people whose contact values another person holds or
 * whose address did not match. It reads the target only, in one read-only snapshot, takes no lock
 * and writes nothing to the database. The private report (mode 600, never attached anywhere) holds
 * legacy candidate ids by rule; the receipt holds totals and counts per rule only. Exit 0 when the
 * report was written, 2 when refused, 1 when the read failed (`m3.link.reportFailed`).
 */
async function linkReport(deps: CliDeps, revision: string, targetId: string,
  publish: (status: M4Receipt["status"], code?: string) => void, reportPath: string,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">, links?: M4Receipt["links"]) => void,
  track: (target: WriteTarget) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  if (!UUID.test(targetId)) return refuse("destination");
  if (!env.M4_DATABASE_URL) return refuse("writeConfig");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  const bound = { revision, artifact, target: targetId };
  bind(bound);
  const target = deps.target(env);
  track(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.linkReportReady()) return refuse("schema");
  let report: LinkReport;
  try { report = await target.linkReport(); } catch {
    deps.error("m4: m3.link.reportFailed");
    try { publish("failed", "m3.link.reportFailed"); } catch { /* the exit code still says failed */ }
    return 1;
  }
  const counts = linkReportCounts(report);
  writeWhole(reportPath, { schemaVersion: 2, invocation: env.M4_INVOCATION, kind: "linkreport", at: deps.now().toISOString(), ...bound, ...report });
  bind(bound, counts);
  publish("ok");
  deps.log(`links imported=${counts.imported} linked=${counts.linked} ${Object.entries(counts.rules).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  deps.log(`m4 linkreport ok invocation=${env.M4_INVOCATION} target=${targetId} revision=${revision} artifact=${artifact}`);
  return 0;
}

/**
 * `doccheck` (M-2): checks each imported person's legacy documents, read-only, and records what a
 * copy step must find again. Under the refresh lock and bound to the refresh identity, it reads
 * the whole candidate table (counted before and after, readM2Sources), maps the documents of the
 * people M-1 imports with ownership over every row (planM2), then reads each object once through
 * the legacy bucket adapter (ranged GetObject only) and admits it with the platform's own rules.
 * It writes nothing to any database and copies nothing.
 *
 * When the refresh report carries provenance (mirror server id, schema and generation, lock path,
 * candidate count), the run refuses unless it holds the same lock file (`lockMismatch`), reads the
 * same server and schema (`mirrorMismatch`), finds the same generation in the mirror's own marker
 * (`generationMismatch`) and the candidate count the refresh recorded (`staleCount`), all before
 * any object read. A report without that provenance yields `documents.diagnostic: true`, which no
 * copy accepts.
 *
 * The private report (mode 600, on the staging host only) lists each checked document's legacy id,
 * kind, type, size and sha256, and each issue's legacy id, column and rule; never a key, name or
 * byte. The receipt holds counts per rule and the checked set's digest only.
 * Exit 0 when the report was written, 2 when refused before any object was read, 1 when failed.
 */
async function docCheck(deps: CliDeps, revision: string,
  publish: (status: M4Receipt["status"], code?: string) => void, reportPath: string,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">, documents?: DocCheckCounts) => void,
  track: (lock: SharedLock) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  const fail = (code: string): number => {
    deps.error(`m4: ${code}`);
    try { publish("failed", code); } catch { /* the exit code still says failed */ }
    return 1;
  };
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  let bucket: LegacyObjectReader;
  try { bucket = (deps.bucket ?? envBucket)(env); } catch { return refuse("bucketConfig"); }

  const lock = await deps.lock(lockPathFrom(env));
  track(lock);
  if (!lock.held) return refuse("locked");
  // Under the lock: the refresh identity and the copy it describes are read together.
  let last: unknown;
  try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
  const refresh = refreshIdentity(last);
  if (!refresh) return refuse("refreshNotOk");
  const today = kuwaitDay(deps.now().toISOString());
  const bound = { revision, artifact, refresh, today };
  bind(bound);

  // Bind the report to the mirror actually read: the same lock file the refresh held, the same
  // server it copied into, and the candidate table it counted. All before any object read.
  const provenance = refreshProvenance(last);
  const reader = deps.reader(env);
  if (provenance) {
    const bad = await mirrorBinding(env, reader, provenance);
    if (bad) return "refuse" in bad ? refuse(bad.refuse) : fail(bad.fail);
  }
  let sources;
  try { sources = await readM2Sources(reader); } catch (error) {
    if (error instanceof M2InputError && error.code === "m2.ownershipIncomplete") return refuse("ownershipIncomplete");
    return fail(error instanceof M2InputError ? error.code : "m2.read");
  }
  if (provenance && sources.candidate.length !== provenance.candidates) return refuse("staleCount");
  // Every equality check passed: only now is the generation this run read bound to its outcome.
  const verified = provenance ? { generation: provenance.generation } : undefined;
  const plan = planM2(sources, today);
  let check;
  try { check = await checkLegacyDocuments(plan.documents, bucket); } catch { return fail("m2.check"); }

  const counts = documentCheckCounts(check);
  const rules = { "document.badKey": 0, "document.sharedObject": 0, ...counts.rules } as Record<DocumentIssueRule | DocumentCheckRule, number>;
  for (const issue of plan.issues) rules[issue.rule]++;
  const documents: DocCheckCounts = { candidates: plan.candidates, mapped: plan.documents.length, checked: counts.checked,
    bytes: counts.bytes, rules, set: documentSetDigest(check.checked), ...(provenance ? {} : { diagnostic: true as const }) };
  // The private report names the whole verified mirror; the receipt carries the generation only.
  // A diagnostic result names none, and says so.
  writeWhole(reportPath, { schemaVersion: 2, invocation: env.M4_INVOCATION, kind: "doccheck", at: deps.now().toISOString(), ...bound,
    revisions: { mapper: M2_DOCUMENT_MAPPER_REVISION, check: M2_DOCUMENT_CHECK_REVISION }, set: documents.set,
    ...(provenance ? { mirror: { serverId: provenance.serverId, schema: provenance.schema, generation: provenance.generation } } : { diagnostic: true }),
    documents: check.checked.map(({ legacyId, kind, mime, size, sha256 }) => ({ legacyId, kind, mime, size, sha256 })),
    issues: [...plan.issues, ...check.issues].map(({ rule, legacyId, field }) => ({ rule, legacyId, field })) });
  bind(verified ? { ...bound, mirror: verified } : bound, documents);
  publish("ok");
  deps.log(`documents candidates=${documents.candidates} mapped=${documents.mapped} checked=${documents.checked} bytes=${documents.bytes} ${Object.entries(rules).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  deps.log(`m4 doccheck ok invocation=${env.M4_INVOCATION} set=${documents.set}${verified ? ` generation=${verified.generation}` : " diagnostic=true"} revision=${revision} artifact=${artifact}`);
  return 0;
}

/**
 * Binds a refresh report's provenance to the mirror actually read: the same lock file the refresh
 * held, the same server and schema it copied into, and the generation it wrote into the mirror's
 * own marker (exactly one row). Null when all hold.
 */
async function mirrorBinding(env: NodeJS.ProcessEnv, reader: LegacyReader, provenance: NonNullable<ReturnType<typeof refreshProvenance>>):
  Promise<{ refuse: string } | { fail: string } | null> {
  if (path.resolve(lockPathFrom(env)) !== provenance.lock) return { refuse: "lockMismatch" };
  let mirror: Readonly<Record<string, unknown>> | undefined;
  try { mirror = (await reader.rows(MIRROR_IDENTITY_SQL, []))[0]; } catch { return { fail: "m2.read.mirror" }; }
  if (mirror?.id !== provenance.serverId || mirror?.schema !== provenance.schema) return { refuse: "mirrorMismatch" };
  if (Number(mirror?.markers) !== 1 || mirror?.generation !== provenance.generation) return { refuse: "generationMismatch" };
  return null;
}

/** Positive whole number from the environment, or the default; null when set but invalid. */
function envBound(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return /^[1-9][0-9]{0,12}$/.test(value) && Number.isSafeInteger(n) ? n : null;
}

/**
 * `doccopy` (M-2): stages the documents an accepted doccheck approved into the staging bucket and
 * `legacy_candidate_documents` (migration 0660), read again from the same mirror generation
 * (m2-copy). Nothing reaches a person's documents; promotion is a later step that takes only a
 * complete receipt whose staged set equals the accepted set.
 *
 * Before any object is read it requires:
 * - the accepted doccheck (`M4_ACCEPTED_DOCCHECK`): its ok receipt and private report, both for that
 *   invocation, with this run's verified build, a verified generation (never diagnostic), and the
 *   same set in the receipt, the report and recomputed from the report's documents (`acceptedDoccheck`);
 * - the staging database by its marker (`target`), the 0660 schema (`schema`), and a staging
 *   identity (`M4_STAGING_DOCUMENT_ACCOUNT_ID` and `M4_STAGING_DOCUMENT_BUCKET` together) that is the
 *   account and bucket both recorded on the marker, compared under the target gate before any object
 *   I/O, with a bucket that differs from legacy's and the live document bucket
 *   (`M4_LIVE_DOCUMENT_BUCKET`, required) (`documentBucket`), then the one-writer lock (`writerBusy`);
 * - under the refresh lock, a refresh whose generation is the accepted one, bound to the mirror read
 *   (`generationMismatch`, `lockMismatch`, `mirrorMismatch`), the whole candidate table at the
 *   refresh's count (`ownershipIncomplete`, `staleCount`), and an approved subset the fresh plan
 *   names exactly (`selection`).
 * The refresh lock is held from selection through the last source read. The run is bounded by
 * M4_DOCCOPY_MAX_DOCS (200), M4_DOCCOPY_MAX_APPROVED_BYTES (256 MiB of approved sizes),
 * M4_DOCCOPY_MAX_OBJECT_BYTES (10 MiB, hard per object, at most the approved-byte budget),
 * M4_DOCCOPY_MAX_MS (15 min), M4_DOCCOPY_OP_TIMEOUT_MS (60 s per storage call), M4_DOCCOPY_SETTLE_MS
 * (30 s for an aborted call to settle) and M4_DOCCOPY_MAX_LIST_PAGES (100 pages of 1000 keys).
 * It resumes only from its own checkpoint in the target (`legacy_document_copy_checkpoints`), keyed
 * by the accepted doccheck, target, staging account and bucket, generation, build and order. The
 * receipt carries only an opaque fingerprint of that identity (`staging`), never the account or bucket. A storage call that does
 * not settle publishes `failed` (`m2.copy.unsettled`) and ends the process without releasing locks.
 * Exit 0 when the checkpoint is complete, the staged set equals the accepted set and the orphan scan was
 * not truncated; 3 otherwise (resume with a fresh M4_INVOCATION and the same M4_ACCEPTED_DOCCHECK,
 * target, staging account and bucket, and build, never the invocation that already claimed the run);
 * 2 refused; 1 failed.
 */
async function docCopy(deps: CliDeps, revision: string,
  publish: (status: M4Receipt["status"], code?: string) => void, reportPath: string,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">, copy?: DocCopyCounts) => void,
  trackLock: (lock: SharedLock) => void, trackTarget: (target: WriteTarget) => void, abandonLocks: () => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  const fail = (code: string): number => {
    deps.error(`m4: ${code}`);
    try { publish("failed", code); } catch { /* the exit code still says failed */ }
    return 1;
  };
  const targetId = env.M4_TARGET_ID ?? "";
  if (!UUID.test(targetId) || !env.M4_DATABASE_URL) return refuse("destination");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  const limits = { maxDocuments: envBound(env.M4_DOCCOPY_MAX_DOCS, 200), maxApprovedBytes: envBound(env.M4_DOCCOPY_MAX_APPROVED_BYTES, 256 * 1024 * 1024),
    maxObjectBytes: envBound(env.M4_DOCCOPY_MAX_OBJECT_BYTES, 10 * 1024 * 1024), maxMs: envBound(env.M4_DOCCOPY_MAX_MS, 15 * 60 * 1000),
    opTimeoutMs: envBound(env.M4_DOCCOPY_OP_TIMEOUT_MS, 60 * 1000), settleMs: envBound(env.M4_DOCCOPY_SETTLE_MS, 30 * 1000),
    maxListPages: envBound(env.M4_DOCCOPY_MAX_LIST_PAGES, 100) };
  if (Object.values(limits).some((n) => n === null) || limits.maxObjectBytes! > limits.maxApprovedBytes!) return refuse("bounds");

  // The accepted doccheck, by its own receipt and private report.
  const accepted = env.M4_ACCEPTED_DOCCHECK ?? "";
  if (!UUID.test(accepted) || accepted === env.M4_INVOCATION) return refuse("acceptedDoccheck");
  const dir = env.M4_OUTPUT_DIR || DEFAULT_M4_OUTPUT_DIR;
  let check: Partial<M4Receipt> | undefined, checkReport: Record<string, unknown> | undefined;
  try {
    check = JSON.parse(readFileSync(path.join(dir, `${accepted}.doccheck.receipt.json`), "utf8")) as Partial<M4Receipt>;
    checkReport = JSON.parse(readFileSync(path.join(dir, `${accepted}.doccheck.report.json`), "utf8")) as Record<string, unknown>;
  } catch { check = undefined; }
  const generation = check?.mirror?.generation;
  const reportMirror = checkReport?.mirror as { generation?: unknown } | undefined;
  if (!check || !checkReport || check.schemaVersion !== 2 || check.kind !== "doccheck" || check.invocation !== accepted || check.status !== "ok"
    || checkReport.kind !== "doccheck" || checkReport.invocation !== accepted
    || check.revision !== revision || check.artifact !== artifact || checkReport.revision !== revision || checkReport.artifact !== artifact
    || typeof generation !== "string" || !GENERATION.test(generation) || reportMirror?.generation !== generation
    || check.documents?.diagnostic || checkReport.diagnostic !== undefined
    || typeof check.documents?.set !== "string" || checkReport.set !== check.documents.set || !Array.isArray(checkReport.documents)) return refuse("acceptedDoccheck");
  const acceptedSet = check.documents.set;
  let recomputed: string;
  try { recomputed = documentSetDigest(checkReport.documents as never); } catch { recomputed = ""; }
  if (recomputed !== acceptedSet) return refuse("acceptedDoccheck");
  const base = { revision, artifact, target: targetId, acceptedDoccheck: accepted, mirror: { generation } };
  bind(base);


  // The staging side: its account and bucket, distinct from legacy's and the live one, and the
  // staging database. The account and bucket together are the staging identity.
  const bucketName = env.M4_STAGING_DOCUMENT_BUCKET ?? "";
  const accountId = env.M4_STAGING_DOCUMENT_ACCOUNT_ID ?? "";
  const identity = stagingIdentity(accountId, bucketName);
  // The operator names the live document bucket too, so the run can prove it is not writing there.
  const live = env.M4_LIVE_DOCUMENT_BUCKET ?? "";
  if (!identity || !live || bucketName === live || bucketName === env.M4_LEGACY_BUCKET) return refuse("documentBucket");
  let objects: StagingObjects, legacy: LegacyObjectReader;
  try { objects = (deps.staging ?? envStaging)(env); } catch { return refuse("stagingConfig"); }
  try { legacy = (deps.bucket ?? envBucket)(env); } catch { return refuse("bucketConfig"); }
  const target = deps.target(env);
  trackTarget(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.documentsReady()) return refuse("schema");
  // Under the target gate, before any object I/O: the recorded account and bucket, both.
  const recorded = await target.documentBucket();
  if (!recorded || recorded.account !== accountId || recorded.bucket !== bucketName) return refuse("documentBucket");
  const bound = { ...base, staging: stagingFingerprint(identity) };
  bind(bound);
  if (!await target.claimWriter()) return refuse("writerBusy");

  const lock = await deps.lock(lockPathFrom(env));
  trackLock(lock);
  if (!lock.held) return refuse("locked");
  let last: unknown;
  try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
  const refresh = refreshIdentity(last);
  if (!refresh) return refuse("refreshNotOk");
  const provenance = refreshProvenance(last);
  if (!provenance || provenance.generation !== generation) return refuse("generationMismatch");
  const today = kuwaitDay(deps.now().toISOString());
  bind({ ...bound, refresh, today });
  const reader = deps.reader(env);
  const bad = await mirrorBinding(env, reader, provenance);
  if (bad) return "refuse" in bad ? refuse(bad.refuse) : fail(bad.fail);
  let sources;
  try { sources = await readM2Sources(reader); } catch (error) {
    if (error instanceof M2InputError && error.code === "m2.ownershipIncomplete") return refuse("ownershipIncomplete");
    return fail(error instanceof M2InputError ? error.code : "m2.read");
  }
  if (sources.candidate.length !== provenance.candidates) return refuse("staleCount");
  const selection = selectApproved(checkReport.documents, planM2(sources, today).documents);
  if (!selection) return refuse("selection");

  publish("started");
  let result;
  try {
    result = await copyLegacyDocuments(selection, { legacy, objects, store: target.documentStaging(), checkpoints: target.copyCheckpoints() },
      { generation, build: artifact, target: { id: targetId, bucket: identity }, invocations: { doccheck: accepted, copy: env.M4_INVOCATION! } },
      { maxDocuments: limits.maxDocuments!, maxApprovedBytes: limits.maxApprovedBytes!, maxObjectBytes: limits.maxObjectBytes!, maxMs: limits.maxMs!,
        opTimeoutMs: limits.opTimeoutMs!, settleMs: limits.settleMs!, maxListPages: limits.maxListPages!, listPageSize: 1000, now: () => Date.now() });
  } catch (error) {
    if (error instanceof M2CopyError && error.code === "m2.copy.unsettled") abandonLocks();
    return fail(error instanceof M2CopyError ? error.code : "m2.copy");
  }
  if (!await target.stillHeld()) return fail("m4.writerLost");

  const rules = copyCounts(result);
  const staged = documentSetDigest(result.verified);
  const counts: DocCopyCounts = { approved: selection.length, handled: result.outcomes.length, approvedBytes: result.approvedBytes, rules,
    checkpoint: result.checkpoint, staged, matchesAccepted: staged === acceptedSet, complete: result.complete,
    orphans: result.orphans.count, orphansTruncated: result.orphans.truncated };
  writeWhole(reportPath, { schemaVersion: 2, invocation: env.M4_INVOCATION, kind: "doccopy", at: deps.now().toISOString(), ...bound, refresh, today,
    revisions: { copy: M2_DOCUMENT_COPY_REVISION }, accepted: acceptedSet, staged, complete: result.complete, checkpoint: result.checkpoint,
    outcomes: result.outcomes, orphans: result.orphans });
  bind({ ...bound, refresh, today }, counts);
  const done = result.complete && counts.matchesAccepted && !result.orphans.truncated;
  publish(done ? "ok" : "incomplete");
  deps.log(`copy approved=${counts.approved} handled=${counts.handled} from=${result.checkpoint.from} credit=${result.checkpoint.credit} approvedBytes=${counts.approvedBytes} orphans=${counts.orphans} ${Object.entries(rules).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  deps.log(`m4 doccopy ${done ? "ok" : "incomplete"} invocation=${env.M4_INVOCATION} accepted=${accepted} generation=${generation} staged=${staged} complete=${result.complete}`);
  return done ? 0 : 3;
}

const DOC_PROMOTION_RULES: readonly DocPromotionRule[] = ["promoted", "personHeld", "alreadyPromoted", "notLinked", "linkChanged", "stagedChanged", "uploadInProgress", "ineligible", "stagingUnreadable"];
/**
 * Outcomes nothing later changes: recorded (promoted, personHeld, alreadyPromoted), or a principal
 * id the document store cannot own (ineligible, counted on every run, never a stall).
 */
const SETTLED = new Set<DocPromotionRule>(["promoted", "personHeld", "alreadyPromoted", "ineligible"]);
/** The database's C order (byte order of UTF-8), which JavaScript's UTF-16 comparison does not always match. */
const cOrder = (a: { principalId: string; kind: string }, b: { principalId: string; kind: string }): number =>
  Buffer.compare(Buffer.from(a.principalId), Buffer.from(b.principalId)) || Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind));

/**
 * `staffwork` (M-5 staff time): the legacy internal staff's work sessions, stand-up questions and
 * answers, and hours per day, through the work lane's mapper and import store (m5-staff.ts).
 *
 * Before any mirror read it requires the verified build (`provenance`), the operator organization
 * (`destination`, `operator`), the staging marker and target (`target`), migrations 0505, 0506,
 * 0508, 0509 and 0658 (`schema`) and the one-writer lock (`writerBusy`). Under the refresh lock
 * (`locked`) it requires an ok refresh with provenance (`refreshNotOk`, `refreshProvenance`) and
 * the mirror it names (`lockMismatch`, `mirrorMismatch`, `generationMismatch`), then reads the four
 * tables whole (`m5.inputIncomplete` refuses a read that is not the whole, unchanged table).
 *
 * Legacy staff resolve to principals by the one rule in m5-staff.ts (verified address key and an
 * operator staff or admin grant, one to one); everything else is reported. The writes are keyed by
 * legacy reference with a digest, so a re-run writes nothing new and a changed row is held, never
 * overwritten; nothing sends a notice. The private report (mode 600, on the staging host only)
 * holds legacy staff ids by reason and legacy refs per table by code; the receipt holds counts.
 * Exit 0 when nothing is unexplained (no missing, extra or held row in any table), 3 when something
 * is, 2 refused, 1 failed.
 */
async function staffWorkRun(deps: CliDeps, revision: string, targetId: string,
  publish: (status: M4Receipt["status"], code?: string) => void, reportPath: string,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">, staffWork?: StaffWorkCounts) => void,
  trackLock: (lock: SharedLock) => void, trackTarget: (target: WriteTarget) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  const fail = (code: string): number => {
    deps.error(`m4: ${code}`);
    try { publish("failed", code); } catch { /* the exit code still says failed */ }
    return 1;
  };
  const operator = env.M4_OPERATOR_ORG_ID ?? "";
  if (!UUID.test(targetId) || !ORG_ID.test(operator) || !env.M4_DATABASE_URL) return refuse("destination");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  const base = { revision, artifact, target: targetId, operator };
  bind(base);
  const target = deps.target(env);
  trackTarget(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.hasOperator(operator)) return refuse("operator");
  if (!await target.staffWorkReady()) return refuse("schema");
  if (!await target.claimWriter()) return refuse("writerBusy");

  const lock = await deps.lock(lockPathFrom(env));
  trackLock(lock);
  if (!lock.held) return refuse("locked");
  let last: unknown;
  try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
  const refresh = refreshIdentity(last);
  if (!refresh) return refuse("refreshNotOk");
  const provenance = refreshProvenance(last);
  if (!provenance) return refuse("refreshProvenance");
  const reader = deps.reader(env);
  const bad = await mirrorBinding(env, reader, provenance);
  if (bad) return "refuse" in bad ? refuse(bad.refuse) : fail(bad.fail);
  const bound = { ...base, refresh, mirror: { generation: provenance.generation } };
  bind(bound);
  let sources;
  try { sources = await readM5StaffSources(reader); } catch (error) {
    if (error instanceof M5InputError && error.code === "m5.inputIncomplete") return refuse("inputIncomplete");
    return fail(error instanceof M5InputError ? error.code : "m5.read");
  }

  publish("started");
  const { candidates, badIds } = staffCandidates(sources.staff);
  let resolution;
  try { resolution = await resolveStaff(candidates, target.staffMatcher(), operator); } catch { return fail("m5.staff.resolve"); }
  const plan = planStaffWork(sources, resolution);
  let outcome: StaffWorkOutcome;
  try { outcome = await runStaffWork(target.workImport(), plan); } catch { return fail(await target.stillHeld() ? "m5.staff.write" : "m4.writerLost"); }
  if (!await target.stillHeld()) return fail("m4.writerLost");

  const unresolved: Partial<Record<StaffUnresolved, number>> = badIds ? { badId: badIds } : {};
  const byReason: Partial<Record<StaffUnresolved, string[]>> = {};
  for (const [id, why] of [...resolution.unresolved].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    unresolved[why] = (unresolved[why] ?? 0) + 1;
    (byReason[why] ??= []).push(id);
  }
  const counts: StaffWorkCounts = { staff: { rows: sources.staff.length, resolved: resolution.principals.size, unresolved },
    tables: outcome.tables, clean: outcome.clean, complete: outcome.complete };
  writeWhole(reportPath, { schemaVersion: 2, invocation: env.M4_INVOCATION, kind: "staffwork", at: deps.now().toISOString(), ...bound,
    revisions: { staff: M5_STAFF_REVISION }, staff: { unresolved: byReason }, tables: outcome.refs });
  bind(bound, counts);
  publish(outcome.complete ? "ok" : "incomplete");
  for (const [table, t] of Object.entries(outcome.tables)) {
    deps.log(`staffwork ${table} legacy=${t.legacy} inserted=${t.inserted} unchanged=${t.unchanged} updated=${t.updated} conflicts=${t.conflicts} skipped=${t.skipped} missing=${t.missing} extra=${t.extra} held=${t.held} clean=${t.clean}`);
  }
  deps.log(`m4 staffwork ${outcome.complete ? "ok" : "incomplete"} invocation=${env.M4_INVOCATION} staff=${counts.staff.rows} resolved=${counts.staff.resolved} generation=${provenance.generation} revision=${revision} artifact=${artifact}`);
  return outcome.complete ? 0 : 3;
}

/**
 * `candidatework` (M-5 candidate hours): legacy candidates' placements, work sessions and employer
 * decisions, through the work lane's mapper and import store (m5-candidate.ts).
 *
 * It has the gates of `staffwork`, with migrations 0202, 0215, 0500 to 0502, 0504 and 0650
 * (`schema`), and reads `candidate`, `candidate_working_hour`, `candidate_work_log_feedback` and
 * `candidate_working_date` whole (`m5.inputIncomplete`). A candidate imports only through the link
 * its person made (`legacy_account_links`) and a store only through the M-4 id map; everything else
 * is reported. The writes are keyed by legacy reference with a digest, so a re-run writes nothing
 * new and a changed row is held, never overwritten; nothing sends a notice. The private report
 * (mode 600, on the staging host only) holds legacy refs per table by code and the candidates whose
 * current store could not be placed; the receipt holds counts. Exit 0 when nothing is unexplained,
 * 3 when something is, 2 refused, 1 failed.
 */
async function candidateWorkRun(deps: CliDeps, revision: string, targetId: string,
  publish: (status: M4Receipt["status"], code?: string) => void, reportPath: string,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">, candidateWork?: CandidateWorkCounts) => void,
  trackLock: (lock: SharedLock) => void, trackTarget: (target: WriteTarget) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  const fail = (code: string): number => {
    deps.error(`m4: ${code}`);
    try { publish("failed", code); } catch { /* the exit code still says failed */ }
    return 1;
  };
  const operator = env.M4_OPERATOR_ORG_ID ?? "";
  if (!UUID.test(targetId) || !ORG_ID.test(operator) || !env.M4_DATABASE_URL) return refuse("destination");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  const base = { revision, artifact, target: targetId, operator };
  bind(base);
  const target = deps.target(env);
  trackTarget(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.hasOperator(operator)) return refuse("operator");
  if (!await target.candidateWorkReady()) return refuse("schema");
  if (!await target.claimWriter()) return refuse("writerBusy");

  const lock = await deps.lock(lockPathFrom(env));
  trackLock(lock);
  if (!lock.held) return refuse("locked");
  let last: unknown;
  try { last = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { last = undefined; }
  const refresh = refreshIdentity(last);
  if (!refresh) return refuse("refreshNotOk");
  const provenance = refreshProvenance(last);
  if (!provenance) return refuse("refreshProvenance");
  const reader = deps.reader(env);
  const bad = await mirrorBinding(env, reader, provenance);
  if (bad) return "refuse" in bad ? refuse(bad.refuse) : fail(bad.fail);
  const bound = { ...base, refresh, mirror: { generation: provenance.generation } };
  bind(bound);
  let sources;
  try { sources = await readM5CandidateSources(reader); } catch (error) {
    if (error instanceof M5CandidateInputError && error.code === "m5.inputIncomplete") return refuse("inputIncomplete");
    return fail(error instanceof M5CandidateInputError ? error.code : "m5.read");
  }

  publish("started");
  const ids = candidateLookupIds(sources);
  let links: ReadonlyMap<string, string>, stores: ReadonlyMap<string, MappedStore>;
  try { links = await target.candidateLinks()(ids.candidates); stores = await target.storeMap()(ids.stores); } catch { return fail("m5.candidate.resolve"); }
  const plan = planCandidateWork(sources, links, stores);
  let outcome: CandidateWorkOutcome;
  try { outcome = await runCandidateWork(target.workImport(), plan); } catch { return fail(await target.stillHeld() ? "m5.candidate.write" : "m4.writerLost"); }
  if (!await target.stillHeld()) return fail("m4.writerLost");

  const counts: CandidateWorkCounts = {
    candidates: { looked: ids.candidates.length, linked: links.size, people: plan.people, unplaced: plan.unplaced.length },
    stores: { looked: ids.stores.length, mapped: stores.size },
    tables: outcome.tables, clean: outcome.clean, complete: outcome.complete,
  };
  writeWhole(reportPath, { schemaVersion: 2, invocation: env.M4_INVOCATION, kind: "candidatework", at: deps.now().toISOString(), ...bound,
    revisions: { candidate: M5_CANDIDATE_REVISION }, unplaced: plan.unplaced, tables: outcome.refs });
  bind(bound, counts);
  publish(outcome.complete ? "ok" : "incomplete");
  for (const [table, t] of Object.entries(outcome.tables)) {
    deps.log(`candidatework ${table} legacy=${t.legacy} inserted=${t.inserted} unchanged=${t.unchanged} updated=${t.updated} conflicts=${t.conflicts} skipped=${t.skipped} missing=${t.missing} extra=${t.extra} held=${t.held} clean=${t.clean}`);
  }
  deps.log(`m4 candidatework ${outcome.complete ? "ok" : "incomplete"} invocation=${env.M4_INVOCATION} linked=${links.size} people=${plan.people} unplaced=${plan.unplaced.length} generation=${provenance.generation} revision=${revision} artifact=${artifact}`);
  return outcome.complete ? 0 : 3;
}

/**
 * `docpromote` (M-2): promotes the staged documents of one complete doccopy into linked people's
 * empty slots (legacy-promotion, migration 0662). It reads no legacy data and needs no refresh lock.
 *
 * Before any object read it requires:
 * - the verified build (`provenance`) and bounds (`bounds`);
 * - the accepted doccopy (`M4_ACCEPTED_DOCCOPY`): its version-2 receipt and private report, status
 *   ok, complete, staged set equal to its accepted set, orphan scan not truncated, the same build and
 *   target, and a staged digest equal to `M4_EXPECTED_STAGED`, the digest the operator accepted; and
 *   the doccheck it consumed, whose report's documents recompute to that digest: that is the selected
 *   set (`acceptedCopy`);
 * - the staging identity (`M4_STAGING_DOCUMENT_ACCOUNT_ID` and `_BUCKET`) whose fingerprint is the
 *   receipt's and which the marker records, and a live bucket (`M4_LIVE_DOCUMENT_BUCKET`) that is
 *   neither the staging nor the legacy bucket (`documentBucket`), and the live store's settings
 *   (`promoterConfig`);
 * - the staging marker and target (`target`), migrations 0661 (authoritative) and 0662 (`schema`);
 * - the destination (M4_LIVE_DOCUMENT_ACCOUNT_ID, M4_LIVE_DOCUMENT_BUCKET, M4_DOCUMENT_ORG_ID) equal
 *   to the one this database records for its staging environment (0662), account, bucket and
 *   organization, never the staging copy's (`promotionDestination`); the receipt carries its
 *   fingerprint only;
 * - then the one-writer lock (`writerBusy`), and under it every selected document staged in the
 *   receipt's generation exactly as selected (`stagedInput`).
 * It then walks the linked, unrecorded (person, kind) pairs of that generation in C order with a
 * cursor, only those the selected set names, reads each staged object back from staging (bounded by
 * its recorded size) and hands it to the promotion, which rechecks link, staged row and slot under
 * the person's lock. Bounded by M4_DOCPROMOTE_MAX_DOCS (500) and M4_DOCPROMOTE_MAX_MS (15 min).
 * The receipt carries counts per outcome only. Exit 0 when the walk reached the end and every pair
 * it met is settled; 3 when bounded or a pair is left to retry (an upload in progress, a link that
 * changed, a staged object that did not read back); 2 refused; 1 failed (the promotion's fixed
 * code; each person commits on their own, so a re-run takes only the rest).
 */
async function docPromote(deps: CliDeps, revision: string, publish: (status: M4Receipt["status"], code?: string) => void,
  bind: (bound: Omit<M4Receipt, "schemaVersion" | "invocation" | "kind" | "status" | "at" | "steps">, counts?: DocPromotionCounts) => void,
  trackTarget: (target: WriteTarget) => void): Promise<number> {
  const { env } = deps;
  const refuse = (code: string): number => {
    deps.error(`m4: refused.${code}`);
    try { publish("refused", code); } catch { return 1; }
    return 2;
  };
  const fail = (code: string): number => {
    deps.error(`m4: ${code}`);
    try { publish("failed", code); } catch { /* the exit code still says failed */ }
    return 1;
  };
  const targetId = env.M4_TARGET_ID ?? "";
  if (!UUID.test(targetId) || !env.M4_DATABASE_URL) return refuse("destination");
  const artifact = env.M4_ARTIFACT_DIGEST ?? "";
  const built = deps.provenance();
  if (!HEX64.test(artifact) || built.head !== revision || !built.clean || built.artifact !== artifact) return refuse("provenance");
  const maxDocs = envBound(env.M4_DOCPROMOTE_MAX_DOCS, 500), maxMs = envBound(env.M4_DOCPROMOTE_MAX_MS, 15 * 60 * 1000);
  if (maxDocs === null || maxMs === null) return refuse("bounds");

  // The accepted copy, by its own receipt and report, and the selection its doccheck approved.
  const accepted = env.M4_ACCEPTED_DOCCOPY ?? "";
  const expected = env.M4_EXPECTED_STAGED ?? "";
  if (!UUID.test(accepted) || accepted === env.M4_INVOCATION || !HEX64.test(expected)) return refuse("acceptedCopy");
  const dir = env.M4_OUTPUT_DIR || DEFAULT_M4_OUTPUT_DIR;
  const readJson = (name: string): Record<string, any> | undefined => {
    try { return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, any>; } catch { return undefined; }
  };
  const copy = readJson(`${accepted}.doccopy.receipt.json`) as Partial<M4Receipt> | undefined;
  const copyReport = readJson(`${accepted}.doccopy.report.json`);
  const generation = copy?.mirror?.generation;
  const doccheck = copy?.acceptedDoccheck;
  const c = copy?.copy;
  if (!copy || !copyReport || copy.schemaVersion !== 2 || copy.kind !== "doccopy" || copy.invocation !== accepted || copy.status !== "ok"
    || copy.revision !== revision || copy.artifact !== artifact || copy.target !== targetId
    || typeof generation !== "string" || !GENERATION.test(generation) || typeof doccheck !== "string" || !UUID.test(doccheck)
    || typeof copy.staging !== "string" || !HEX64.test(copy.staging)
    || !c || c.complete !== true || c.matchesAccepted !== true || c.orphansTruncated !== false || c.staged !== expected
    || copyReport.kind !== "doccopy" || copyReport.invocation !== accepted || copyReport.acceptedDoccheck !== doccheck
    || copyReport.mirror?.generation !== generation || copyReport.staging !== copy.staging || copyReport.target !== targetId
    || copyReport.complete !== true || copyReport.staged !== expected || copyReport.accepted !== expected) return refuse("acceptedCopy");
  const checkReport = readJson(`${doccheck}.doccheck.report.json`);
  if (!checkReport || checkReport.kind !== "doccheck" || checkReport.invocation !== doccheck || checkReport.mirror?.generation !== generation
    || checkReport.diagnostic !== undefined || !Array.isArray(checkReport.documents)) return refuse("acceptedCopy");
  const selected = checkReport.documents as CheckedDocument[];
  let recomputed: string;
  try { recomputed = documentSetDigest(selected); } catch { recomputed = ""; }
  if (recomputed !== expected) return refuse("acceptedCopy");
  const tuple = (legacyId: string, kind: string) => `${legacyId}\u0000${kind}`;
  const selection = new Map(selected.map((d) => [tuple(d.legacyId, d.kind), d] as const));
  if (selection.size !== selected.length) return refuse("acceptedCopy");
  let base: Parameters<typeof bind>[0] = { revision, artifact, target: targetId, acceptedCopy: accepted, acceptedDoccheck: doccheck, mirror: { generation }, staging: copy.staging };
  bind(base);

  // The staging identity the copy wrote to, the live bucket apart from it and from legacy's.
  const bucketName = env.M4_STAGING_DOCUMENT_BUCKET ?? "";
  const accountId = env.M4_STAGING_DOCUMENT_ACCOUNT_ID ?? "";
  const identity = stagingIdentity(accountId, bucketName);
  const live = env.M4_LIVE_DOCUMENT_BUCKET ?? "";
  if (!identity || stagingFingerprint(identity) !== copy.staging || !live || live === bucketName || live === env.M4_LEGACY_BUCKET) return refuse("documentBucket");
  // The destination as configured for this run: account, bucket and organization, all well formed.
  const destination: PromotionDestination = { account: env.M4_LIVE_DOCUMENT_ACCOUNT_ID ?? "", bucket: live, org: env.M4_DOCUMENT_ORG_ID ?? "" };
  if (!DESTINATION_ACCOUNT.test(destination.account) || !DESTINATION_BUCKET.test(destination.bucket) || !DESTINATION_ORG.test(destination.org)
    || (destination.account === accountId && destination.bucket === bucketName)) return refuse("promotionDestination");
  let objects: StagingObjects;
  try { objects = (deps.staging ?? envStaging)(env); } catch { return refuse("stagingConfig"); }
  const target = deps.target(env);
  trackTarget(target);
  const marker = await target.marker();
  if (marker?.environment !== "staging" || marker.targetId !== targetId) return refuse("target");
  if (!await target.docPromotionReady()) return refuse("schema");
  const recorded = await target.documentBucket();
  if (!recorded || recorded.account !== accountId || recorded.bucket !== bucketName) return refuse("documentBucket");
  // The destination must be exactly the one this database records for its own environment (0662):
  // the same account, not only a bucket of the same name, and the same organization. Checked before
  // any storage read or write and before the writer lock, so a mismatch reads, writes and records nothing.
  const bound = await target.promotionDestination();
  if (!bound || bound.account !== destination.account || bound.bucket !== destination.bucket || bound.org !== destination.org) return refuse("promotionDestination");
  base = { ...base, promotionDestination: promotionDestinationFingerprint(destination) };
  bind(base);
  if (!await target.claimWriter()) return refuse("writerBusy");

  // Under the writer lock: every selected document is staged in this generation exactly as selected.
  const staged = new Map<string, StagedDocument>();
  try {
    for (const row of await target.stagedGeneration(generation)) staged.set(tuple(row.legacyId, row.kind), row);
  } catch { return fail("m4.stagedRead"); }
  const rows: StagedDocument[] = [];
  for (const [key, d] of selection) {
    const row = staged.get(key);
    if (!row || row.mime !== d.mime || row.size !== d.size || row.sha256 !== d.sha256) return refuse("stagedInput");
    rows.push(row);
  }
  if (documentSetDigest(rows) !== expected) return refuse("stagedInput");

  let promoter: DocumentPromoter;
  try { promoter = (deps.promoter ?? envPromoter)(env); } catch { return refuse("promoterConfig"); }
  const rules = Object.fromEntries(DOC_PROMOTION_RULES.map((r) => [r, 0])) as Record<DocPromotionRule, number>;
  let handled = 0, ended = false, bounded = false, open = 0;
  const counts = (): DocPromotionCounts => ({ selected: selection.size, handled, rules: { ...rules }, staged: expected,
    complete: ended && !bounded && open === 0, bounded });
  publish("started");
  const startedAt = Date.now();
  const binding = { acceptedCopy: accepted, invocation: env.M4_INVOCATION! };
  try {
    let after: { principalId: string; kind: string } | undefined;
    walk: for (;;) {
      const batch = await target.pendingDocPromotions(generation, PROMOTE_BATCH, after);
      if (batch.length === 0) { ended = true; break; }
      for (const pair of batch) {
        if (after && cOrder(pair, after) <= 0) throw new Error("m4.promoteOrder");
        after = { principalId: pair.principalId, kind: pair.kind };
        const row = staged.get(tuple(pair.legacyId, pair.kind));
        if (!row || !selection.has(tuple(pair.legacyId, pair.kind))) continue;
        if (handled >= maxDocs || Date.now() - startedAt >= maxMs) { bounded = true; break walk; }
        handled++;
        const bytes = await objects.read(row.objectKey, row.size, AbortSignal.timeout(60_000)).catch(() => null);
        if (!bytes || bytes.kind !== "found" || bytes.bytes.length !== row.size || createHash("sha256").update(bytes.bytes).digest("hex") !== row.sha256) {
          rules.stagingUnreadable++; open++; continue;
        }
        const outcome = await promoter.promote(pair.principalId, row as StagedLegacyDocument, bytes.bytes, binding);
        rules[outcome]++;
        if (!SETTLED.has(outcome)) open++;
      }
    }
  } catch (error) {
    bind(base, counts());
    await promoter.close().catch(() => {});
    return fail(error instanceof DocumentPromotionError ? error.code : error instanceof Error && error.message === "m4.promoteOrder" ? "m4.promoteOrder" : "m2.promote");
  }
  await promoter.close().catch(() => {});
  if (!await target.stillHeld()) { bind(base, counts()); return fail("m4.writerLost"); }
  const result = counts();
  bind(base, result);
  publish(result.complete ? "ok" : "incomplete");
  deps.log(`docpromote selected=${result.selected} handled=${result.handled} ${DOC_PROMOTION_RULES.map((r) => `${r}=${rules[r]}`).join(" ")} bounded=${bounded}`);
  deps.log(`m4 docpromote ${result.complete ? "ok" : "incomplete"} invocation=${env.M4_INVOCATION} accepted=${accepted} generation=${generation} staged=${expected}`);
  return result.complete ? 0 : 3;
}
