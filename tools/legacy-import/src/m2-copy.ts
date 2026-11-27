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
// - The staged set is computed only from documents verified in this run.
// - The run stops between documents at its bounds (count, bytes, time) and says it is incomplete.
//
// Outcomes carry the legacy id, kind and a rule code only: never a key, name or byte.

import { createHash } from "node:crypto";

import { CANDIDATE_DOCUMENT_ADMISSION } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { readLegacyDocument, type DocumentMime, type LegacyObjectReader } from "./m2-document-check.js";
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
  /** Every key under the prefix. */
  list(prefix: string): Promise<readonly string[]>;
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
  | "document.changed" // legacy's bytes no longer match what the doccheck approved
  | "document.missing" | "document.tooLarge" | "document.admission" | "document.readFailed"
  | "objectMismatch" // a staged object is missing or differs from its row or the approved bytes
  | "conflict"; // this generation already has a row with other bytes

export const COPY_RULES: readonly CopyRule[] = ["staged", "adopted", "unchanged", "document.changed", "document.missing",
  "document.tooLarge", "document.admission", "document.readFailed", "objectMismatch", "conflict"];
const VERIFIED = new Set<CopyRule>(["staged", "adopted", "unchanged"]);

export interface CopyBounds {
  readonly maxDocuments: number;
  readonly maxBytes: number;
  readonly maxMs: number;
  /** Milliseconds, monotonic enough for a deadline. */
  readonly now: () => number;
}

export interface CopyResult {
  readonly outcomes: readonly { readonly legacyId: string; readonly kind: DocumentKind; readonly rule: CopyRule }[];
  /** The documents verified in this run (staged, adopted or unchanged), for the staged-set digest. */
  readonly verified: readonly ApprovedDocument[];
  /** False when a bound stopped the run before every approved document was handled. */
  readonly complete: boolean;
  /** Approved bytes handled. */
  readonly bytes: number;
  /** Keys under this generation's prefix that no approved document accounts for. Listed only when complete. */
  readonly orphans: readonly string[];
}

/** Thrown with a fixed code only: a staging error could carry values. */
export class M2CopyError extends Error {
  constructor(readonly code: "m2.copy.staging") { super(code); this.name = "M2CopyError"; }
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: ApprovedDocument, b: ApprovedDocument) => a.sha256 === b.sha256 && a.size === b.size && a.mime === b.mime;

async function readsBack(objects: StagingObjects, key: string, want: ApprovedDocument): Promise<boolean> {
  let read: StagingObjectRead;
  try { read = await objects.read(key, want.size); } catch { throw new M2CopyError("m2.copy.staging"); }
  return read?.kind === "found" && Buffer.isBuffer(read.bytes) && read.bytes.length === want.size && sha(read.bytes) === want.sha256;
}

async function copyOne(approved: ApprovedDocument, source: DocumentSourceRow, legacy: LegacyObjectReader, objects: StagingObjects,
  store: DocumentStagingStore, generation: string, invocations: { doccheck: string; copy: string }): Promise<CopyRule> {
  const staging = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw e instanceof M2CopyError ? e : new M2CopyError("m2.copy.staging"); } };
  const verifyRow = async (row: StagedDocument): Promise<CopyRule> => {
    if (!same(row, approved) || row.objectKey !== stagingKey(generation, approved.legacyId, approved.kind, approved.sha256)) return "conflict";
    return await readsBack(objects, row.objectKey, approved) ? "unchanged" : "objectMismatch";
  };

  const existing = await staging(() => store.get(approved.legacyId, approved.kind, generation));
  if (existing) return verifyRow(existing);

  const read = await readLegacyDocument(source, legacy);
  if ("rule" in read) return read.rule;
  if (!same(read.ok, approved)) return "document.changed";

  const key = stagingKey(generation, approved.legacyId, approved.kind, approved.sha256);
  const put = await staging(() => objects.put(key, read.bytes, approved.mime));
  if (!await readsBack(objects, key, approved)) return "objectMismatch";
  const row: StagedDocument = { ...approved, generation, objectKey: key };
  const inserted = await staging(() => store.insert(row, invocations));
  if (inserted === "exists") {
    const now = await staging(() => store.get(approved.legacyId, approved.kind, generation));
    return now ? verifyRow(now) : "conflict";
  }
  return put === "exists" ? "adopted" : "staged";
}

/**
 * Copies the approved documents in order, one object in memory at a time. Stops between documents
 * when a bound is reached. A staging failure (database or object storage) ends the run with
 * M2CopyError; what was recorded before it stays recorded and verifies on retry.
 */
export async function copyLegacyDocuments(selection: ReturnType<typeof selectApproved> & object, legacy: LegacyObjectReader,
  objects: StagingObjects, store: DocumentStagingStore, generation: string, invocations: { doccheck: string; copy: string },
  bounds: CopyBounds): Promise<CopyResult> {
  const started = bounds.now();
  const outcomes: { legacyId: string; kind: DocumentKind; rule: CopyRule }[] = [];
  const verified: ApprovedDocument[] = [];
  let bytes = 0;
  let complete = true;
  for (const { approved, source } of selection) {
    if (outcomes.length >= bounds.maxDocuments || bytes + approved.size > bounds.maxBytes || bounds.now() - started >= bounds.maxMs) {
      complete = false;
      break;
    }
    const rule = await copyOne(approved, source, legacy, objects, store, generation, invocations);
    outcomes.push({ legacyId: approved.legacyId, kind: approved.kind, rule });
    bytes += approved.size;
    if (VERIFIED.has(rule)) verified.push(approved);
  }
  let orphans: string[] = [];
  if (complete) {
    const expected = new Set(selection.map(({ approved: a }) => stagingKey(generation, a.legacyId, a.kind, a.sha256)));
    let listed: readonly string[];
    try { listed = await objects.list(stagingPrefix(generation)); } catch { throw new M2CopyError("m2.copy.staging"); }
    orphans = [...listed].filter((key) => !expected.has(key)).sort();
  }
  return { outcomes, verified, complete, bytes, orphans };
}

/** Counts per rule, every rule present. */
export function copyCounts(result: CopyResult): Record<CopyRule, number> {
  const counts = Object.fromEntries(COPY_RULES.map((r) => [r, 0])) as Record<CopyRule, number>;
  for (const o of result.outcomes) counts[o.rule]++;
  return counts;
}
