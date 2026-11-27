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
// - The staged set is computed only from documents verified in this chain of runs.
// - Bounds (desk #393, GPT AMEND 7217915701): every bound is enforced as written. A run stops
//   between documents at its count, byte or time bound and returns a continuation bound to the
//   generation, the build and the accepted set, so the next run starts after what this one handled
//   instead of validating the same prefix again. Each run handles at least one document, so a chain
//   under fixed bounds always ends. Each port call has a timeout; the orphan scan is page-bounded.
//
// Outcomes, continuations and the orphan scan carry legacy ids, kinds, indexes and rule codes only:
// never a key, name or byte.

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
  get(legacyId: string, kind: DocumentKind, generation: string): Promise<StagedDocument | null>;
  insert(row: StagedDocument, invocations: { readonly doccheck: string; readonly copy: string }): Promise<"inserted" | "exists">;
}

export type StagingObjectRead = { readonly kind: "found"; readonly bytes: Buffer } | { readonly kind: "missing" } | { readonly kind: "tooLarge" };

/**
 * Staging object storage, separate from legacy's bucket and from the live document bucket. It
 * writes only new keys (`put` answers "exists" instead of replacing an object) and never deletes.
 */
export interface StagingObjects {
  read(key: string, maxBytes: number): Promise<StagingObjectRead>;
  put(key: string, bytes: Buffer, mime: DocumentMime): Promise<"written" | "exists">;
  /** One page of keys under the prefix, in key order, starting after `after`; `next` when more remain. */
  list(prefix: string, page: { readonly after?: string; readonly limit: number }): Promise<StagingListPage>;
}
export interface StagingListPage { readonly keys: readonly string[]; readonly next?: string }

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
 * - `maxObjectBytes` is the hard cap per object: a document above it is never read or written
 *   (`overCap`). It may not exceed `maxBytes`, so every admissible document fits a run.
 * - `maxDocuments` and `maxBytes` meter every document a run handles, validation of an existing row
 *   included (it reads the object back), so a run's reads are bounded whatever earlier runs did.
 * - `maxMs` is the run deadline, checked between documents once the run has handled one.
 * - `opTimeoutMs` bounds each single port call; `maxListPages` x `listPageSize` bounds the orphan scan.
 * Progress: each run handles at least one document and returns a continuation past it, so a chain
 * of runs under the same bounds reaches the end in at most `selection.length` runs.
 */
export interface CopyBounds {
  readonly maxDocuments: number;
  readonly maxBytes: number;
  readonly maxObjectBytes: number;
  readonly maxMs: number;
  readonly opTimeoutMs: number;
  readonly maxListPages: number;
  readonly listPageSize: number;
  /** Milliseconds, monotonic enough for a deadline. */
  readonly now: () => number;
}

/** What a run is bound to. A continuation from another generation, build or accepted set is refused. */
export interface CopyRun {
  readonly generation: string;
  /** The build artifact digest of the tool doing the copy. */
  readonly build: string;
  readonly invocations: { readonly doccheck: string; readonly copy: string };
}

/**
 * Where a chain of runs stands: documents `[0, next)` of the selection were handled by earlier runs
 * bound to the same generation, build and accepted set. Ids, counts and indexes only.
 */
export interface CopyContinuation {
  readonly version: typeof CONTINUATION_VERSION;
  readonly generation: string;
  readonly build: string;
  /** documentSetDigest of the approved selection. */
  readonly acceptedSet: string;
  readonly next: number;
  /** Rule counts over `[0, next)`. */
  readonly rules: Readonly<Record<CopyRule, number>>;
  /** Indexes in `[0, next)` whose rule was not a verified one, ascending. */
  readonly unverified: readonly number[];
  /** Approved bytes of `[0, next)`. */
  readonly bytes: number;
}
export const CONTINUATION_VERSION = "m2-copy-continuation-v1";

/** The orphan scan, sanitized: (legacy id, kind) tuples and counts, never a key. */
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
  /** This run's documents, by selection index. */
  readonly outcomes: readonly { readonly index: number; readonly legacyId: string; readonly kind: DocumentKind; readonly rule: CopyRule }[];
  /** Verified documents of the whole chain (earlier runs' prefix and this run), for the staged-set digest. */
  readonly verified: readonly ApprovedDocument[];
  /** True when the chain has handled every approved document. */
  readonly complete: boolean;
  /** Bytes this run read against `maxBytes` (an `overCap` document reads nothing). */
  readonly bytes: number;
  /** Feed to the next run; `next === selection.length` when complete. */
  readonly continuation: CopyContinuation;
  readonly orphans: OrphanScan;
}

/** Thrown with a fixed code only: a staging error could carry values. */
export class M2CopyError extends Error {
  constructor(readonly code: "m2.copy.staging" | "m2.copy.timeout" | "m2.copy.bounds" | "m2.copy.continuation") { super(code); this.name = "M2CopyError"; }
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: ApprovedDocument, b: ApprovedDocument) => a.sha256 === b.sha256 && a.size === b.size && a.mime === b.mime;
const HEX64 = SHA256;
const positive = (n: number) => Number.isSafeInteger(n) && n >= 1;

/** One port call under the operation timeout. Any failure becomes a fixed code. */
async function timed<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new M2CopyError("m2.copy.timeout")), ms); });
  try { return await Promise.race([Promise.resolve().then(fn), timeout]); }
  catch (e) { throw e instanceof M2CopyError ? e : new M2CopyError("m2.copy.staging"); }
  finally { clearTimeout(timer); }
}

interface Ports { readonly legacy: LegacyObjectReader; readonly objects: StagingObjects; readonly store: DocumentStagingStore }

async function readsBack(ports: Ports, ms: number, key: string, want: ApprovedDocument): Promise<boolean> {
  const read = await timed(ms, () => ports.objects.read(key, want.size));
  return read?.kind === "found" && Buffer.isBuffer(read.bytes) && read.bytes.length === want.size && sha(read.bytes) === want.sha256;
}

async function copyOne(approved: ApprovedDocument, source: DocumentSourceRow, ports: Ports, run: CopyRun, ms: number): Promise<CopyRule> {
  const { generation } = run;
  const verifyRow = async (row: StagedDocument): Promise<CopyRule> => {
    if (!same(row, approved) || row.objectKey !== stagingKey(generation, approved.legacyId, approved.kind, approved.sha256)) return "conflict";
    return await readsBack(ports, ms, row.objectKey, approved) ? "unchanged" : "objectMismatch";
  };

  const existing = await timed(ms, () => ports.store.get(approved.legacyId, approved.kind, generation));
  if (existing) return verifyRow(existing);

  // A legacy read that hangs past the operation timeout is a failed read of that document.
  const legacy: LegacyObjectReader = { read: (key, max) => timed(ms, () => ports.legacy.read(key, max)) };
  const read = await readLegacyDocument(source, legacy);
  if ("rule" in read) return read.rule;
  if (!same(read.ok, approved)) return "document.changed";

  const key = stagingKey(generation, approved.legacyId, approved.kind, approved.sha256);
  const put = await timed(ms, () => ports.objects.put(key, read.bytes, approved.mime));
  if (!await readsBack(ports, ms, key, approved)) return "objectMismatch";
  const row: StagedDocument = { ...approved, generation, objectKey: key };
  const inserted = await timed(ms, () => ports.store.insert(row, run.invocations));
  if (inserted === "exists") {
    const now = await timed(ms, () => ports.store.get(approved.legacyId, approved.kind, generation));
    return now ? verifyRow(now) : "conflict";
  }
  return put === "exists" ? "adopted" : "staged";
}

const emptyRules = () => Object.fromEntries(COPY_RULES.map((r) => [r, 0])) as Record<CopyRule, number>;

/** The chain's starting point: a fresh one, or the given continuation after it is checked whole. */
function startFrom(continuation: CopyContinuation | undefined, selection: readonly { readonly approved: ApprovedDocument }[],
  run: CopyRun, acceptedSet: string): CopyContinuation {
  if (continuation === undefined) return { version: CONTINUATION_VERSION, generation: run.generation, build: run.build, acceptedSet, next: 0, rules: emptyRules(), unverified: [], bytes: 0 };
  const c = continuation as Partial<CopyContinuation> | null;
  const refuse = () => { throw new M2CopyError("m2.copy.continuation"); };
  if (!c || typeof c !== "object" || c.version !== CONTINUATION_VERSION || c.generation !== run.generation || c.build !== run.build || c.acceptedSet !== acceptedSet) refuse();
  const next = c!.next as number;
  if (!Number.isSafeInteger(next) || next < 0 || next > selection.length) refuse();
  const rules = c!.rules as Record<string, unknown> | undefined;
  if (!rules || typeof rules !== "object" || Object.keys(rules).length !== COPY_RULES.length) refuse();
  let total = 0, verifiedCount = 0;
  for (const rule of COPY_RULES) {
    const n = rules![rule];
    if (!Number.isSafeInteger(n) || (n as number) < 0) refuse();
    total += n as number;
    if (VERIFIED.has(rule)) verifiedCount += n as number;
  }
  const unverified = c!.unverified as readonly number[];
  if (!Array.isArray(unverified) || total !== next || unverified.length !== next - verifiedCount
    || unverified.some((i, at) => !Number.isSafeInteger(i) || i < 0 || i >= next || (at > 0 && i <= unverified[at - 1]!))) refuse();
  const bytes = selection.slice(0, next).reduce((sum, { approved }) => sum + approved.size, 0);
  if (c!.bytes !== bytes) refuse();
  return { version: CONTINUATION_VERSION, generation: run.generation, build: run.build, acceptedSet, next, rules: { ...rules } as Record<CopyRule, number>, unverified: [...unverified], bytes };
}

const ORPHAN_KEY = /^([1-9][0-9]{0,17})\/([a-z-]+)\/[0-9a-f]{64}$/;

/** Lists this generation's prefix within the page bound and reports what no approved document accounts for. */
async function scanOrphans(objects: StagingObjects, generation: string, expected: ReadonlySet<string>, bounds: CopyBounds): Promise<OrphanScan> {
  const prefix = stagingPrefix(generation);
  const tuples: { legacyId: string; kind: DocumentKind }[] = [];
  let count = 0, unparsed = 0, after: string | undefined, truncated = false;
  for (let page = 0; ; page++) {
    if (page >= bounds.maxListPages) { truncated = true; break; }
    const listed = await timed(bounds.opTimeoutMs, () => objects.list(prefix, after === undefined ? { limit: bounds.listPageSize } : { after, limit: bounds.listPageSize }));
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
 * Copies the approved documents in order, one object in memory at a time, from where the
 * continuation left off (from the start without one). Stops between documents at a bound and
 * returns the continuation for the next run. A staging failure or timeout ends the run with
 * M2CopyError; what was recorded before it stays recorded and verifies again on a fresh chain.
 */
export async function copyLegacyDocuments(selection: ReturnType<typeof selectApproved> & object, ports: Ports, run: CopyRun,
  bounds: CopyBounds, continuation?: CopyContinuation): Promise<CopyResult> {
  if (![bounds.maxDocuments, bounds.maxBytes, bounds.maxObjectBytes, bounds.maxMs, bounds.opTimeoutMs, bounds.maxListPages, bounds.listPageSize].every(positive)
    || bounds.maxObjectBytes > bounds.maxBytes || !GENERATION.test(run.generation) || !HEX64.test(run.build)) throw new M2CopyError("m2.copy.bounds");
  const acceptedSet = documentSetDigest(selection.map(({ approved }) => approved));
  const from = startFrom(continuation, selection, run, acceptedSet);
  const started = bounds.now();
  const rules = { ...from.rules };
  const unverified = [...from.unverified];
  const outcomes: { index: number; legacyId: string; kind: DocumentKind; rule: CopyRule }[] = [];
  let index = from.next, bytes = 0, approvedBytes = 0;
  while (index < selection.length) {
    const { approved, source } = selection[index]!;
    const over = approved.size > bounds.maxObjectBytes;
    const cost = over ? 0 : approved.size;
    if (outcomes.length > 0 && (outcomes.length >= bounds.maxDocuments || bytes + cost > bounds.maxBytes || bounds.now() - started >= bounds.maxMs)) break;
    const rule: CopyRule = over ? "overCap" : await copyOne(approved, source, ports, run, bounds.opTimeoutMs);
    outcomes.push({ index, legacyId: approved.legacyId, kind: approved.kind, rule });
    rules[rule]++;
    if (!VERIFIED.has(rule)) unverified.push(index);
    bytes += cost;
    approvedBytes += approved.size;
    index++;
  }
  const complete = index === selection.length;
  const skipped = new Set(unverified);
  const verified = selection.slice(0, index).filter((_, i) => !skipped.has(i)).map(({ approved }) => approved);
  const next: CopyContinuation = { ...from, next: index, rules, unverified, bytes: from.bytes + approvedBytes };
  const orphans = complete
    ? await scanOrphans(ports.objects, run.generation, new Set(selection.map(({ approved: a }) => stagingKey(run.generation, a.legacyId, a.kind, a.sha256))), bounds)
    : { scanned: false, truncated: false, count: 0, tuples: [], unparsed: 0 };
  return { outcomes, verified, complete, bytes, continuation: next, orphans };
}

/** Rule counts over the whole chain, every rule present. */
export function copyCounts(result: CopyResult): Record<CopyRule, number> {
  return { ...emptyRules(), ...result.continuation.rules };
}
