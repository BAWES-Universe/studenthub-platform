// M-2 documents, second slice: check each mapped document against legacy's permanent bucket,
// read-only, and record what the copy step will need: which key held it, its content type, its
// size and its sha256. Nothing is copied or stored here; the copy step reads each object again
// and refuses it unless the bytes still hash to the digest recorded here.
//
// The bucket is reached through `LegacyObjectReader`, a read-only port: this slice holds no
// credential and no bucket name. Its adapter (staging only, credentials outside the repository)
// is a later slice. A reader must read at most `maxBytes + 1` bytes of an object, so an
// oversized object never fills memory.
//
// Each object passes the platform's own admission rules (validateCandidateContent: PNG or JPEG
// for photos and civil IDs, PDF for a CV, 10 MB at most, checked by content, not by name).
// Issues carry the legacy id, the rule code and the column only: never a key, a byte or an
// error detail, because object names and contents can hold personal words.

import { createHash } from "node:crypto";

import { CANDIDATE_DOCUMENT_ADMISSION } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { validateCandidateContent } from "../../../packages/private-documents/src/candidate-content.js";
import { DOCUMENT_COLUMNS, type DocumentKind, type DocumentSourceRow } from "./m2-documents.js";

/** Names this step's rules, for the run plan that will pin it. */
export const M2_DOCUMENT_CHECK_REVISION = "m2-document-check-v1";

/** One read of one bucket key. `tooLarge` when the object holds more than `maxBytes`. */
export type LegacyObjectRead =
  | { readonly kind: "found"; readonly bytes: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "tooLarge" };

/** Read-only access to legacy's permanent bucket. It must never write, copy or delete. */
export interface LegacyObjectReader {
  read(key: string, maxBytes: number): Promise<LegacyObjectRead>;
}

export type DocumentMime = "image/png" | "image/jpeg" | "application/pdf";

export interface CheckedDocument {
  readonly legacyId: string;
  readonly kind: DocumentKind;
  /** The first key in legacy's probe order that held the object. Never reported. */
  readonly key: string;
  readonly mime: DocumentMime;
  readonly size: number;
  /** Lowercase hex sha256 of the object's bytes. */
  readonly sha256: string;
}

export type DocumentCheckRule =
  | "document.missing" // no probed key holds an object
  | "document.tooLarge" // the object exceeds the kind's size limit
  | "document.admission" // the bytes are not an admitted PNG, JPEG or PDF for the kind
  | "document.readFailed"; // the reader failed; nothing is known about the object, retry later

export interface DocumentCheckIssue {
  readonly rule: DocumentCheckRule;
  readonly legacyId: string;
  /** The legacy column, never its value. */
  readonly field: string;
}

export interface M2DocumentCheck {
  readonly checked: readonly CheckedDocument[];
  readonly issues: readonly DocumentCheckIssue[];
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** The content type the bytes claim by their signature, for the kinds the platform admits. */
function sniff(kind: DocumentKind, bytes: Buffer): DocumentMime | null {
  if (kind === "resume") return bytes.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : null;
  if (bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return null;
}

type Outcome = { readonly ok: CheckedDocument; readonly bytes: Buffer } | { readonly rule: DocumentCheckRule };

/**
 * Reads one mapped document the way the check does (probe order, size cap, admission) and returns
 * its bytes with what was recorded about them. The copy step uses it to read an approved document again.
 */
export async function readLegacyDocument(row: DocumentSourceRow, reader: LegacyObjectReader): Promise<Outcome> {
  const maxBytes = CANDIDATE_DOCUMENT_ADMISSION[row.kind].maxBytes;
  for (const key of row.keys) {
    let read: LegacyObjectRead | null | undefined;
    try { read = await reader.read(key, maxBytes); } catch { return { rule: "document.readFailed" }; }
    if (read === null || typeof read !== "object") return { rule: "document.readFailed" };
    if (read.kind === "missing") continue;
    if (read.kind === "tooLarge") return { rule: "document.tooLarge" };
    if (read.kind !== "found" || !Buffer.isBuffer(read.bytes)) return { rule: "document.readFailed" };
    const bytes = read.bytes;
    if (bytes.length > maxBytes) return { rule: "document.tooLarge" };
    const mime = sniff(row.kind, bytes);
    if (mime === null) return { rule: "document.admission" };
    try { validateCandidateContent(row.kind, mime, bytes); } catch { return { rule: "document.admission" }; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { ok: { legacyId: row.legacyId, kind: row.kind, key, mime, size: bytes.length, sha256 }, bytes };
  }
  return { rule: "document.missing" };
}

/**
 * Checks each mapped document (`mapLegacyDocuments(...).documents`) in order, one read at a time,
 * so the run holds at most one object in memory. The first probed key that exists is the object,
 * as in legacy; a later key is never read once one is found. Output keeps the input order.
 */
export async function checkLegacyDocuments(documents: readonly DocumentSourceRow[], reader: LegacyObjectReader): Promise<M2DocumentCheck> {
  const column = new Map(DOCUMENT_COLUMNS);
  const checked: CheckedDocument[] = [];
  const issues: DocumentCheckIssue[] = [];
  for (const row of documents) {
    const outcome = await readLegacyDocument(row, reader);
    if ("ok" in outcome) checked.push(outcome.ok);
    else issues.push({ rule: outcome.rule, legacyId: row.legacyId, field: column.get(row.kind)! });
  }
  return { checked, issues };
}

/** Counts per rule, for a receipt that must carry no id. */
export function documentCheckCounts(result: M2DocumentCheck): { checked: number; bytes: number; rules: Record<DocumentCheckRule, number> } {
  const rules: Record<DocumentCheckRule, number> = { "document.missing": 0, "document.tooLarge": 0, "document.admission": 0, "document.readFailed": 0 };
  for (const issue of result.issues) rules[issue.rule]++;
  return { checked: result.checked.length, bytes: result.checked.reduce((sum, d) => sum + d.size, 0), rules };
}

/**
 * A digest of a checked document set: sha256 over each document's legacy id, kind, type, size and
 * sha256, sorted by id then kind. No key or byte.
 */
export function documentSetDigest(documents: readonly Pick<CheckedDocument, "legacyId" | "kind" | "mime" | "size" | "sha256">[]): string {
  const rows = documents.map((d) => [d.legacyId, d.kind, d.mime, d.size, d.sha256] as const)
    .sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(["m2-document-set-v1", rows])).digest("hex");
}
