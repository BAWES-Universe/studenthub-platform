// M-2 documents, copy step: stage each document an accepted doccheck approved into staging object
// storage, read again from the same mirror generation, and record it in `legacy_candidate_documents`
// bound to the legacy candidate. Nothing here touches a person's documents: promotion on link is a
// later step that only a complete copy receipt can feed.
//
// Proof rules (desk #393, GPT AMEND 7213552855, design 7216305767):
// - The approved subset is exactly the accepted report's (legacyId, kind) rows. A duplicate, an
//   unknown kind, a malformed id or a tuple the fresh plan does not name refuses the run before any
//   object is read (`selectApproved`). No legacy key is recorded or compared: equality is proven
//   on the bytes (sha256, size, admitted type) instead.
// - Rows and objects are per generation. `unchanged` means this generation's row with the same
//   sha256 and an object that reads back to it. An existing row whose object is missing or differs
//   is `objectMismatch`; nothing is ever overwritten or deleted.
// - An object written before a crash, with no row, is adopted only when it reads back to the
//   approved bytes. Every write is read back and verified before its row commits.
// - Order: documents are handled in canonical order (legacy id by length then value, then kind),
//   the order `documentSetDigest` sorts by, whatever order the report listed them in.
// - Resume (desk #393, GPT AMEND 7219113911): a run takes credit for earlier work only from the
//   checkpoint the copy itself writes to the target after each document, keyed by the accepted
//   doccheck invocation, the target database and bucket, the generation, the build and the canonical
//   order. Each credited verified entry records the exact row and object binding it was verified
//   with. A missing checkpoint, or one that fails any check, grants no credit: the run starts from
//   the first document and validates everything again. Caller-supplied progress is never accepted.
// - Bounds (GPT AMEND 7217915701): every bound is enforced as written. `maxApprovedBytes` is a logical
//   budget over approved document sizes, not a meter of bytes moved (read-back and fallback reads
//   move more). A run stops between documents at a bound, and handles at least one document, so a
//   chain of runs under fixed bounds always ends.
// - Writes in flight: each port call gets an AbortSignal and a timeout. On timeout the call is
//   aborted and the run waits up to `settleMs` for it to settle before failing (`m2.copy.timeout`),
//   so no write is still in flight when the caller releases its locks. If it does not settle, the
//   run fails `m2.copy.unsettled`: the caller must end the process instead of releasing its locks
//   or retrying in-process. Writes are create-only, so the next run reconciles any uncertain write
//   (an object with no row is adopted only if it reads back; a row is verified against its object;
//   an uncertain checkpoint save is resolved by its revision).
//
// Outcomes and the orphan scan carry legacy ids, kinds, indexes and rule codes only: never a key,
// name or byte. Only the checkpoint, in the target database, holds object keys.

import { createHash } from "node:crypto";

import { CANDIDATE_DOCUMENT_ADMISSION } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { documentSetDigest, readLegacyDocument, type DocumentMime, type LegacyObjectReader } from "./m2-document-check.js";
import { DOCUMENT_COLUMNS, type DocumentKind, type DocumentSourceRow } from "./m2-documents.js";

export const M2_DOCUMENT_COPY_REVISION = "m2-document-copy-v1";

const KINDS = new Set<string>(DOCUMENT_COLUMNS.map(([kind]) => kind));
const MIMES = new Set<string>(["image/png", "image/jpeg", "application/pdf"]);
const LEGACY_ID = /^[1-9][0-9]{0,17}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One document the accepted doccheck admitted, as its private report recorded it. */
export interface ApprovedDocument {
  readonly legacyId: string;
  readonly kind: DocumentKind;
  readonly mime: DocumentMime;
  readonly size: number;
  readonly sha256: string;
}

/** A staged copy: one row per (legacy candidate, kind, generation). */
export interface StagedDocument extends ApprovedDocument {
  readonly generation: string;
  readonly objectKey: string;
}

/** The staging table. `insert` never replaces a row; "exists" when one is already there. */
export interface DocumentStagingStore {
  get(legacyId: string, kind: DocumentKind, generation: string, signal: AbortSignal): Promise<StagedDocument | null>;
  insert(row: StagedDocument, invocations: { readonly doccheck: string; readonly copy: string }, signal: AbortSignal): Promise<"inserted" | "exists">;
}

export type StagingObjectRead = { readonly kind: "found"; readonly bytes: Buffer } | { readonly kind: "missing" } | { readonly kind: "tooLarge" };

/**
 * Staging object storage, separate from legacy's bucket and from the live document bucket. It
 * writes only new keys (`put` answers "exists" instead of replacing an object) and never deletes.
 * Every call honours its AbortSignal.
 */
export interface StagingObjects {
  read(key: string, maxBytes: number, signal: AbortSignal): Promise<StagingObjectRead>;
  put(key: string, bytes: Buffer, mime: DocumentMime, signal: AbortSignal): Promise<"written" | "exists">;
  /** One page of keys under the prefix, in key order, starting after `after`; `next` when more remain. */
  list(prefix: string, page: { readonly after?: string; readonly limit: number }, signal: AbortSignal): Promise<StagingListPage>;
}
export interface StagingListPage { readonly keys: readonly string[]; readonly next?: string }

/** What a checkpoint belongs to. A checkpoint is only ever loaded and saved under its exact key. */
export interface CheckpointKey {
  readonly acceptedDoccheck: string;
  readonly targetId: string;
  readonly bucket: string;
  readonly generation: string;
  readonly build: string;
  /** documentSetDigest of the approved selection: the set in canonical order. */
  readonly order: string;
}

/** One handled document, by canonical index. A verified entry records what it was verified against. */
export interface CheckpointEntry {
  readonly index: number;
  readonly legacyId: string;
  readonly kind: DocumentKind;
  readonly rule: CopyRule;
  /** Verified rules only: the row and object binding proven by read-back. */
  readonly binding?: { readonly mime: DocumentMime; readonly size: number; readonly sha256: string; readonly objectKey: string };
  /** The copy invocation that handled it. */
  readonly invocation: string;
}

export interface CopyCheckpoint {
  readonly version: typeof CHECKPOINT_VERSION;
  readonly key: CheckpointKey;
  /** Entries for canonical indexes [0, next), in order. */
  readonly entries: readonly CheckpointEntry[];
}
export const CHECKPOINT_VERSION = "m2-copy-checkpoint-v1";

/**
 * The copy's own checkpoint table in the target database. `load` returns what is stored under the
 * key with its revision (the copy checks the content itself); `save` replaces it only when the
 * stored revision is still `expected` (null: none stored), storing revision `(expected ?? 0) + 1`,
 * and answers "stale" otherwise. Rows are never deleted by the copy.
 */
export interface CopyCheckpointStore {
  load(key: CheckpointKey, signal: AbortSignal): Promise<{ readonly revision: number; readonly checkpoint: unknown } | null>;
  save(checkpoint: CopyCheckpoint, expected: number | null, signal: AbortSignal): Promise<"saved" | "stale">;
}

/** Content-addressed and per generation: the same bytes for the same slot always land on one key. */
export function stagingKey(generation: string, legacyId: string, kind: DocumentKind, sha256: string): string {
  if (!GENERATION.test(generation) || !LEGACY_ID.test(legacyId) || !KINDS.has(kind) || !SHA256.test(sha256)) throw new Error("m2.copy.key");
  return `${stagingPrefix(generation)}${legacyId}/${kind}/${sha256}`;
}
export const stagingPrefix = (generation: string): string => {
  if (!GENERATION.test(generation)) throw new Error("m2.copy.key");
  return `legacy-import/${generation}/`;
};

/**
 * The approved subset: the accepted report's documents, each checked for shape, with no duplicate
 * and each named by the fresh plan of the same generation. Returns null (refuse `selection`) on any
 * fault; the rows come back paired with the plan's source row, in the report's order.
 */
export function selectApproved(reported: unknown, planned: readonly DocumentSourceRow[]):
  readonly { readonly approved: ApprovedDocument; readonly source: DocumentSourceRow }[] | null {
  if (!Array.isArray(reported)) return null;
  const plan = new Map(planned.map((row) => [`${row.legacyId}/${row.kind}`, row]));
  const seen = new Set<string>();
  const out: { approved: ApprovedDocument; source: DocumentSourceRow }[] = [];
  for (const raw of reported as unknown[]) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const { legacyId, kind, mime, size, sha256 } = r;
    if (typeof legacyId !== "string" || !LEGACY_ID.test(legacyId) || typeof kind !== "string" || !KINDS.has(kind)
      || typeof mime !== "string" || !MIMES.has(mime) || typeof sha256 !== "string" || !SHA256.test(sha256)
      || !Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > CANDIDATE_DOCUMENT_ADMISSION[kind as DocumentKind].maxBytes) return null;
    const id = `${legacyId}/${kind}`;
    const source = plan.get(id);
    if (seen.has(id) || !source) return null;
    seen.add(id);
    out.push({ approved: { legacyId, kind: kind as DocumentKind, mime: mime as DocumentMime, size: size as number, sha256 }, source });
  }
  return out;
}

export type CopyRule =
  | "staged" // read from legacy, written, read back and recorded
  | "adopted" // an object from an interrupted run read back to the approved bytes and was recorded
  | "unchanged" // this generation's row and object already hold the approved bytes
  | "overCap" // the approved size is above this run's hard object cap: not read, not written
  | "document.changed" // legacy's bytes no longer match what the doccheck approved
  | "document.missing" | "document.tooLarge" | "document.admission" | "document.readFailed"
  | "objectMismatch" // a staged object is missing or differs from its row or the approved bytes
  | "conflict"; // this generation already has a row with other bytes

export const COPY_RULES: readonly CopyRule[] = ["staged", "adopted", "unchanged", "overCap", "document.changed", "document.missing",
  "document.tooLarge", "document.admission", "document.readFailed", "objectMismatch", "conflict"];
const VERIFIED = new Set<CopyRule>(["staged", "adopted", "unchanged"]);

/**
 * Every bound is enforced as written; none is waived for a first document.
 * - `maxObjectBytes`: hard cap per object. A document above it is never read or written (`overCap`).
 *   It may not exceed `maxApprovedBytes`, so every admissible document fits a run.
 * - `maxDocuments`, `maxApprovedBytes`: per run, over every handled document (validation included).
 *   `maxApprovedBytes` sums approved sizes (`overCap` counts 0); it does not meter bytes moved.
 * - `maxMs`: run deadline, checked between documents once the run has handled one.
 * - `opTimeoutMs`: each port call; `settleMs`: how long an aborted call may take to settle.
 * - `maxListPages` x `listPageSize`: the orphan scan.
 */
export interface CopyBounds {
  readonly maxDocuments: number;
  readonly maxApprovedBytes: number;
  readonly maxObjectBytes: number;
  readonly maxMs: number;
  readonly opTimeoutMs: number;
  readonly settleMs: number;
  readonly maxListPages: number;
  readonly listPageSize: number;
  /** Milliseconds, monotonic enough for a deadline. */
  readonly now: () => number;
}

/** What a run is bound to; with the canonical order it makes the checkpoint key. */
export interface CopyRun {
  readonly generation: string;
  /** The build artifact digest of the tool doing the copy. */
  readonly build: string;
  readonly target: { readonly id: string; readonly bucket: string };
  readonly invocations: { readonly doccheck: string; readonly copy: string };
}

/** The orphan scan, sanitized: (legacy id, kind) pairs and counts, never a key. */
export interface OrphanScan {
  /** False when the run was incomplete and no scan ran. */
  readonly scanned: boolean;
  /** True when the page bound stopped the scan before the last page. */
  readonly truncated: boolean;
  readonly count: number;
  readonly tuples: readonly { readonly legacyId: string; readonly kind: DocumentKind }[];
  /** Keys under the prefix that do not have the staging key shape. */
  readonly unparsed: number;
}

export interface CopyResult {
  /** This run's documents, by canonical index. */
  readonly outcomes: readonly { readonly index: number; readonly legacyId: string; readonly kind: DocumentKind; readonly rule: CopyRule }[];
  /** How the run started: no checkpoint, one that failed a check (no credit), or resumed from one. */
  readonly checkpoint: { readonly credit: "none" | "untrusted" | "resumed"; readonly from: number; readonly next: number };
  /** Rule counts over the checkpoint, every rule present. */
  readonly rules: Readonly<Record<CopyRule, number>>;
  /** Verified documents over the checkpoint, for the staged-set digest. */
  readonly verified: readonly ApprovedDocument[];
  /** True when the checkpoint covers every approved document. A run that is not complete is never promotion-grade. */
  readonly complete: boolean;
  /** Approved bytes this run handled against `maxApprovedBytes`. */
  readonly approvedBytes: number;
  readonly orphans: OrphanScan;
}

export type M2CopyCode = "m2.copy.staging" | "m2.copy.timeout" | "m2.copy.unsettled" | "m2.copy.bounds" | "m2.copy.checkpoint";

/** Thrown with a fixed code only: a staging error could carry values. */
export class M2CopyError extends Error {
  constructor(readonly code: M2CopyCode) { super(code); this.name = "M2CopyError"; }
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Pick<ApprovedDocument, "sha256" | "size" | "mime">, b: Pick<ApprovedDocument, "sha256" | "size" | "mime">) =>
  a.sha256 === b.sha256 && a.size === b.size && a.mime === b.mime;
const positive = (n: number) => Number.isSafeInteger(n) && n >= 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One port call under the operation timeout. On timeout the call is aborted and awaited up to
 * `settleMs`: settled, the run fails `m2.copy.timeout`; still running, `m2.copy.unsettled`.
 * Any other failure becomes `m2.copy.staging`. No value from the error is kept.
 */
async function call<T>(bounds: CopyBounds, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = new AbortController();
  const op = Promise.resolve().then(() => fn(control.signal));
  const settled = op.then(() => true, () => true);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), bounds.opTimeoutMs); });
  try {
    const first = await Promise.race([settled.then(() => "settled" as const), expired]);
    if (first === "settled") return await op;
  } catch { throw new M2CopyError("m2.copy.staging"); } finally { clearTimeout(timer); }
  control.abort();
  let grace: NodeJS.Timeout | undefined;
  const done = await Promise.race([settled, new Promise<false>((resolve) => { grace = setTimeout(() => resolve(false), bounds.settleMs); })]);
  clearTimeout(grace);
  throw new M2CopyError(done ? "m2.copy.timeout" : "m2.copy.unsettled");
}

interface Ports {
  readonly legacy: LegacyObjectReader;
  readonly objects: StagingObjects;
  readonly store: DocumentStagingStore;
  readonly checkpoints: CopyCheckpointStore;
}

async function readsBack(ports: Ports, bounds: CopyBounds, key: string, want: ApprovedDocument): Promise<boolean> {
  const read = await call(bounds, (signal) => ports.objects.read(key, want.size, signal));
  return read?.kind === "found" && Buffer.isBuffer(read.bytes) && read.bytes.length === want.size && sha(read.bytes) === want.sha256;
}

async function copyOne(approved: ApprovedDocument, source: DocumentSourceRow, ports: Ports, run: CopyRun, bounds: CopyBounds): Promise<CopyRule> {
  const { generation } = run;
  const key = stagingKey(generation, approved.legacyId, approved.kind, approved.sha256);
  const verifyRow = async (row: StagedDocument): Promise<CopyRule> => {
    if (!same(row, approved) || row.objectKey !== key) return "conflict";
    return await readsBack(ports, bounds, key, approved) ? "unchanged" : "objectMismatch";
  };

  const existing = await call(bounds, (signal) => ports.store.get(approved.legacyId, approved.kind, generation, signal));
  if (existing) return verifyRow(existing);

  // Legacy reads change nothing: one that runs out of time is a failed read of that document.
  const legacy: LegacyObjectReader = { read: (k, max) => call(bounds, () => ports.legacy.read(k, max)) };
  const read = await readLegacyDocument(source, legacy);
  if ("rule" in read) return read.rule;
  if (!same(read.ok, approved)) return "document.changed";

  const put = await call(bounds, (signal) => ports.objects.put(key, read.bytes, approved.mime, signal));
  if (!await readsBack(ports, bounds, key, approved)) return "objectMismatch";
  const row: StagedDocument = { ...approved, generation, objectKey: key };
  const inserted = await call(bounds, (signal) => ports.store.insert(row, run.invocations, signal));
  if (inserted === "exists") {
    const now = await call(bounds, (signal) => ports.store.get(approved.legacyId, approved.kind, generation, signal));
    return now ? verifyRow(now) : "conflict";
  }
  return put === "exists" ? "adopted" : "staged";
}

/** Canonical order: the order documentSetDigest sorts by. */
const canonical = (a: ApprovedDocument, b: ApprovedDocument) =>
  a.legacyId.length - b.legacyId.length || (a.legacyId < b.legacyId ? -1 : a.legacyId > b.legacyId ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);

const sameKey = (a: CheckpointKey, b: unknown) => {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return Object.keys(o).length === 6 && (Object.keys(a) as (keyof CheckpointKey)[]).every((k) => o[k] === a[k]);
};

/** The entries a stored checkpoint may be credited with, or null when any check fails. */
function trusted(stored: unknown, key: CheckpointKey, ordered: readonly { readonly approved: ApprovedDocument }[]): CheckpointEntry[] | null {
  if (!stored || typeof stored !== "object") return null;
  const c = stored as Partial<CopyCheckpoint>;
  if (c.version !== CHECKPOINT_VERSION || !sameKey(key, c.key) || !Array.isArray(c.entries) || c.entries.length > ordered.length) return null;
  const out: CheckpointEntry[] = [];
  for (const [i, raw] of (c.entries as unknown[]).entries()) {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Partial<CheckpointEntry>;
    const want = ordered[i]!.approved;
    if (e.index !== i || e.legacyId !== want.legacyId || e.kind !== want.kind || typeof e.rule !== "string" || !COPY_RULES.includes(e.rule)
      || typeof e.invocation !== "string" || !UUID.test(e.invocation)) return null;
    if (VERIFIED.has(e.rule)) {
      const b = e.binding;
      if (!b || typeof b !== "object" || !same(b, want) || b.objectKey !== stagingKey(key.generation, want.legacyId, want.kind, want.sha256)) return null;
      out.push({ index: i, legacyId: want.legacyId, kind: want.kind, rule: e.rule, binding: { mime: want.mime, size: want.size, sha256: want.sha256, objectKey: b.objectKey }, invocation: e.invocation });
    } else {
      if (e.binding !== undefined) return null;
      out.push({ index: i, legacyId: want.legacyId, kind: want.kind, rule: e.rule, invocation: e.invocation });
    }
  }
  return out;
}

const ORPHAN_KEY = /^([1-9][0-9]{0,17})\/([a-z-]+)\/[0-9a-f]{64}$/;

/** Lists this generation's prefix within the page bound and reports what no approved document accounts for. */
async function scanOrphans(objects: StagingObjects, generation: string, expected: ReadonlySet<string>, bounds: CopyBounds): Promise<OrphanScan> {
  const prefix = stagingPrefix(generation);
  const tuples: { legacyId: string; kind: DocumentKind }[] = [];
  let count = 0, unparsed = 0, after: string | undefined, truncated = false;
  for (let page = 0; ; page++) {
    if (page >= bounds.maxListPages) { truncated = true; break; }
    const from = after;
    const listed = await call(bounds, (signal) => objects.list(prefix, from === undefined ? { limit: bounds.listPageSize } : { after: from, limit: bounds.listPageSize }, signal));
    const keys = listed?.keys;
    if (!Array.isArray(keys) || keys.length > bounds.listPageSize || (listed.next !== undefined && (typeof listed.next !== "string" || keys.length === 0))) throw new M2CopyError("m2.copy.staging");
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(prefix) || (after !== undefined && key <= after)) throw new M2CopyError("m2.copy.staging");
      after = key;
      if (expected.has(key)) continue;
      count++;
      const m = ORPHAN_KEY.exec(key.slice(prefix.length));
      if (m && KINDS.has(m[2]!)) tuples.push({ legacyId: m[1]!, kind: m[2] as DocumentKind });
      else unparsed++;
    }
    if (listed.next === undefined) break;
    after = listed.next;
  }
  return { scanned: true, truncated, count, tuples, unparsed };
}

/**
 * Copies the approved documents in canonical order, one object in memory at a time, from where this
 * key's trusted checkpoint left off (from the start without one), saving the checkpoint after each
 * document. Stops between documents at a bound. A staging failure, timeout or stale checkpoint ends
 * the run with M2CopyError; what was recorded before it stays recorded and is reconciled next run.
 */
export async function copyLegacyDocuments(selection: ReturnType<typeof selectApproved> & object, ports: Ports, run: CopyRun,
  bounds: CopyBounds): Promise<CopyResult> {
  if (![bounds.maxDocuments, bounds.maxApprovedBytes, bounds.maxObjectBytes, bounds.maxMs, bounds.opTimeoutMs, bounds.settleMs, bounds.maxListPages, bounds.listPageSize].every(positive)
    || bounds.maxObjectBytes > bounds.maxApprovedBytes || !GENERATION.test(run.generation) || !SHA256.test(run.build)
    || !UUID.test(run.invocations.doccheck) || !UUID.test(run.invocations.copy) || run.invocations.doccheck === run.invocations.copy
    || !UUID.test(run.target.id) || typeof run.target.bucket !== "string" || run.target.bucket.length === 0) throw new M2CopyError("m2.copy.bounds");
  const ordered = [...selection].sort((x, y) => canonical(x.approved, y.approved));
  const key: CheckpointKey = { acceptedDoccheck: run.invocations.doccheck, targetId: run.target.id, bucket: run.target.bucket,
    generation: run.generation, build: run.build, order: documentSetDigest(ordered.map(({ approved }) => approved)) };

  const loaded = await call(bounds, (signal) => ports.checkpoints.load(key, signal));
  const credited = loaded ? trusted(loaded.checkpoint, key, ordered) : null;
  const credit = !loaded ? "none" : credited ? "resumed" : "untrusted";
  const entries: CheckpointEntry[] = credited ?? [];
  let revision = loaded ? loaded.revision : null;
  const from = entries.length;

  const started = bounds.now();
  const outcomes: { index: number; legacyId: string; kind: DocumentKind; rule: CopyRule }[] = [];
  let approvedBytes = 0;
  for (let index = from; index < ordered.length; index++) {
    const { approved, source } = ordered[index]!;
    const over = approved.size > bounds.maxObjectBytes;
    const cost = over ? 0 : approved.size;
    if (outcomes.length > 0 && (outcomes.length >= bounds.maxDocuments || approvedBytes + cost > bounds.maxApprovedBytes || bounds.now() - started >= bounds.maxMs)) break;
    const rule: CopyRule = over ? "overCap" : await copyOne(approved, source, ports, run, bounds);
    outcomes.push({ index, legacyId: approved.legacyId, kind: approved.kind, rule });
    approvedBytes += cost;
    entries.push(VERIFIED.has(rule)
      ? { index, legacyId: approved.legacyId, kind: approved.kind, rule, invocation: run.invocations.copy,
          binding: { mime: approved.mime, size: approved.size, sha256: approved.sha256, objectKey: stagingKey(run.generation, approved.legacyId, approved.kind, approved.sha256) } }
      : { index, legacyId: approved.legacyId, kind: approved.kind, rule, invocation: run.invocations.copy });
    const checkpoint: CopyCheckpoint = { version: CHECKPOINT_VERSION, key, entries: [...entries] };
    const expected = revision;
    if (await call(bounds, (signal) => ports.checkpoints.save(checkpoint, expected, signal)) !== "saved") throw new M2CopyError("m2.copy.checkpoint");
    revision = (revision ?? 0) + 1;
  }

  const rules = Object.fromEntries(COPY_RULES.map((r) => [r, 0])) as Record<CopyRule, number>;
  for (const e of entries) rules[e.rule]++;
  const verified = entries.filter((e) => VERIFIED.has(e.rule)).map((e) => ordered[e.index]!.approved);
  const complete = entries.length === ordered.length;
  const orphans = complete
    ? await scanOrphans(ports.objects, run.generation, new Set(ordered.map(({ approved: a }) => stagingKey(run.generation, a.legacyId, a.kind, a.sha256))), bounds)
    : { scanned: false, truncated: false, count: 0, tuples: [], unparsed: 0 };
  return { outcomes, checkpoint: { credit, from, next: entries.length }, rules, verified, complete, approvedBytes, orphans };
}

/** Rule counts over the checkpoint, every rule present. */
export function copyCounts(result: CopyResult): Record<CopyRule, number> {
  return { ...result.rules };
}
