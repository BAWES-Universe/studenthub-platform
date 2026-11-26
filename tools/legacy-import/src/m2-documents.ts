// M-2 documents, first slice: which legacy storage object each imported person's four document
// kinds come from (queue 14: personal photo, CV, civil ID front and back; video is excluded, D3).
// Pure: no storage read, no copy. Later slices fetch each object read-only from legacy's
// permanent bucket, check it with the platform's own admission rules (validateCandidateContent),
// record its sha256 and store it apart from the person-owned documents until the person links.
//
// Legacy stores an object name per kind on `candidate` and builds the bucket key itself; this
// mapper repeats legacy's own key rules (common/models/Candidate.php, legacy main 55119d3):
//   - personal photo: a value already under `candidate-profile-photos/` or `photos/` is the key;
//     otherwise legacy probes `candidate-profile-photos/<basename>`, then `photos/<basename>`
//     (personalPhotoS3KeysToProbe);
//   - civil ID front and back: `photos/...` as is, `candidate-civil-id/<x>` as `photos/<basename>`,
//     anything else as `photos/<value>` (normalizeCivilIdPermanentS3Key);
//   - CV: `candidate-resume/<value>` (updateResume, deleteResume).
//
// Only candidates M-1 imports are mapped. A value that cannot name an object safely (not a
// string, a path step, a backslash, a control character, too long) is `document.badKey`, and so
// is a CV value legacy would key verbatim but that has outer spaces or a leading slash: it is held,
// never rewritten. An object any other candidate row could resolve to (archived, duplicate-id and
// unimported rows too, by legacy's own lenient rules and every probe) is recorded for neither
// imported claimant (`document.sharedObject`), because a document belongs to one person. Object
// names can hold personal words (a file called after its owner), so they stay in memory: issues
// carry legacy ids, rule codes and column names only.

import type { PersonImportRow } from "./m1-people.js";

export const M2_DOCUMENT_SOURCES = {
  candidate: ["candidate_id", "candidate_personal_photo", "candidate_resume", "candidate_civil_photo_front", "candidate_civil_photo_back"],
} as const satisfies Record<string, readonly string[]>;

/** Names this mapper's rules, for the run plan that will pin it. */
export const M2_DOCUMENT_MAPPER_REVISION = "m2-documents-v1";

/** The platform's document types (CANDIDATE_DOCUMENT_ADMISSION in @studenthub/private-documents). */
export type DocumentKind = "personal-photo" | "resume" | "civil-id-front" | "civil-id-back";

/** Each kind's legacy column, in the order rows and issues are listed. */
export const DOCUMENT_COLUMNS: readonly (readonly [DocumentKind, string])[] = [
  ["personal-photo", "candidate_personal_photo"],
  ["resume", "candidate_resume"],
  ["civil-id-front", "candidate_civil_photo_front"],
  ["civil-id-back", "candidate_civil_photo_back"],
];

export interface DocumentSourceRow {
  readonly legacyId: string;
  readonly kind: DocumentKind;
  /** Bucket keys to try, in legacy's order; the first that exists is the object. Never reported. */
  readonly keys: readonly string[];
}

export type DocumentIssueRule =
  | "document.badKey" // the value cannot name an object safely; not recorded
  | "document.sharedObject"; // another imported person's value names the same object; recorded for neither

export interface DocumentIssue {
  readonly rule: DocumentIssueRule;
  readonly legacyId: string;
  /** The legacy column, never its value. */
  readonly field: string;
  /** For a shared object: the lowest other legacy id claiming it, when that row has a usable id. */
  readonly target?: string;
}

export interface M2Documents {
  readonly documents: readonly DocumentSourceRow[];
  readonly issues: readonly DocumentIssue[];
}

type Row = Readonly<Record<string, unknown>>;

const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const canonicalId = (raw: unknown) => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? String(raw)
  : typeof raw === "string" && /^[1-9][0-9]{0,17}$/.test(raw.trim()) ? raw.trim() : null;

/** S3 allows 1024 bytes; the longest prefix added here is 25 characters. */
const MAX_VALUE_BYTES = 960;

/** PHP's trim(): space, tab, newline, carriage return, NUL and vertical tab only. */
const phpTrim = (v: string) => v.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
/** Legacy's photo and civil ID reading of a stored value: ltrim(trim(v), '/'). */
const legacyRead = (v: string) => phpTrim(v).replace(/^\/+/, "");
/** PHP's basename() for the plain paths here: trailing slashes dropped, then the last segment. */
const phpBasename = (v: string) => { const t = v.replace(/\/+$/, ""); return t.slice(t.lastIndexOf("/") + 1); };
const basename = (v: string) => v.slice(v.lastIndexOf("/") + 1);

/** No path step (`.` or `..`), no empty segment, no backslash, no control or format character, bounded. */
function isSafeName(v: string): boolean {
  if (v === "" || Buffer.byteLength(v, "utf8") > MAX_VALUE_BYTES) return false;
  if (/[\\\p{Cc}\p{Cf}]/u.test(v)) return false;
  return !v.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** Whether legacy treats the stored value as no document. The CV is unset only when null or empty. */
function isUnset(kind: DocumentKind, raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  return kind !== "resume" && typeof raw === "string" && legacyRead(raw) === "";
}

/**
 * The object name this importer records, or null when the value cannot name one object safely.
 * Photo and civil ID are read as legacy reads them (PHP trim, leading slashes removed). The CV key
 * is `candidate-resume/` plus the stored value verbatim, so a CV value is never rewritten: one
 * that would need trimming or slash removal is refused, not altered.
 */
function objectName(kind: DocumentKind, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (kind === "resume") return raw.trim() === raw && phpTrim(raw) === raw && !raw.startsWith("/") && isSafeName(raw) ? raw : null;
  const v = legacyRead(raw);
  return isSafeName(v) ? v : null;
}

/** Legacy's bucket keys for one stored value, in its probe order. */
export function legacyDocumentKeys(kind: DocumentKind, value: string): readonly string[] {
  switch (kind) {
    case "personal-photo":
      return value.startsWith("candidate-profile-photos/") || value.startsWith("photos/") ? [value]
        : [`candidate-profile-photos/${basename(value)}`, `photos/${basename(value)}`];
    case "civil-id-front":
    case "civil-id-back":
      return value.startsWith("photos/") ? [value]
        : value.startsWith("candidate-civil-id/") ? [`photos/${basename(value.slice("candidate-civil-id/".length))}`]
        : [`photos/${value}`];
    case "resume":
      return [`candidate-resume/${value}`];
  }
}

/**
 * Every bucket key legacy could resolve any stored value to, with legacy's own lenient rules and
 * no safety refusal: used only to find who else claims an object, never to record one.
 */
function claimedKeys(kind: DocumentKind, raw: unknown): readonly string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") return [];
  const s = String(raw);
  if (kind === "resume") return [`candidate-resume/${s}`];
  const v = legacyRead(s);
  if (v === "") return [];
  if (kind === "personal-photo") {
    if (v.startsWith("candidate-profile-photos/") || v.startsWith("photos/")) return [v];
    const b = phpBasename(v);
    return b === "" ? [] : [`candidate-profile-photos/${b}`, `photos/${b}`];
  }
  if (v.startsWith("photos/")) return [v];
  if (v.startsWith("candidate-civil-id/")) { const b = phpBasename(v.slice("candidate-civil-id/".length)); return b === "" ? [] : [`photos/${b}`]; }
  return [`photos/${v}`];
}

/** A candidate row claiming objects: its position in the input and its legacy id when usable. */
interface Owner { readonly row: number; readonly id: string | null }
/** Usable ids in numeric order, then rows without one, by position. */
const ownerOrder = (a: Owner, b: Owner) => a.id !== null && b.id !== null ? byId(a.id, b.id) || a.row - b.row
  : a.id !== null ? -1 : b.id !== null ? 1 : a.row - b.row;

/**
 * Maps the document columns of the candidates M-1 imports, ordered by legacy id, then kind. `people`
 * is `mapLegacyCandidates(...).people` for the same candidate rows. An unset value gets no row.
 * `candidates` must be every candidate row (archived, duplicate and unusable ones too): any of
 * them claiming an object blocks it for the imported person.
 */
export function mapLegacyDocuments(candidates: readonly Row[], people: readonly Pick<PersonImportRow, "legacyId">[]): M2Documents {
  const imported = new Set(people.map((p) => p.legacyId));
  const issues: DocumentIssue[] = [];
  const drafts: { readonly doc: DocumentSourceRow; readonly row: number }[] = [];
  const seen = new Set<string>();

  // One object, one owner. For each bucket key, the two first distinct claiming rows in owner
  // order: enough to tell whether anyone besides a person claims it, and who comes first.
  const claims = new Map<string, Owner[]>();
  const claim = (key: string, owner: Owner) => {
    const list = claims.get(key) ?? claims.set(key, []).get(key)!;
    if (list.some((o) => o.row === owner.row)) return;
    list.push(owner);
    if (list.length > 1) list.sort(ownerOrder);
    if (list.length > 2) list.pop();
  };

  candidates.forEach((row, index) => {
    const id = canonicalId(row.candidate_id);
    const owner: Owner = { row: index, id };
    for (const [kind, column] of DOCUMENT_COLUMNS) for (const key of claimedKeys(kind, row[column])) claim(key, owner);
    // M-1 imports an id only when it is on exactly one usable, active row.
    if (id === null || !imported.has(id) || seen.has(id)) return;
    seen.add(id);
    for (const [kind, column] of DOCUMENT_COLUMNS) {
      const raw = row[column];
      if (isUnset(kind, raw)) continue;
      const name = objectName(kind, raw);
      if (name === null) { issues.push({ rule: "document.badKey", legacyId: id, field: column }); continue; }
      const doc = { legacyId: id, kind, keys: legacyDocumentKeys(kind, name) };
      for (const key of doc.keys) claim(key, owner);
      drafts.push({ doc, row: index });
    }
  });

  // Any key another row could resolve to is recorded for neither, whichever probe finds the object.
  const column = new Map(DOCUMENT_COLUMNS);
  const shared = new Set<DocumentSourceRow>();
  for (const { doc, row } of drafts) {
    const others = doc.keys.map((key) => claims.get(key)!.find((o) => o.row !== row)).filter((o): o is Owner => o !== undefined);
    if (!others.length) continue;
    shared.add(doc);
    const first = others.sort(ownerOrder)[0]!;
    issues.push({ rule: "document.sharedObject", legacyId: doc.legacyId, field: column.get(doc.kind)!,
      ...(first.id !== null && first.id !== doc.legacyId ? { target: first.id } : {}) });
  }

  const order = new Map(DOCUMENT_COLUMNS.map(([kind], i) => [kind, i]));
  const kindOrder = (k: DocumentKind) => order.get(k)!;
  const fieldOrder = (f: string) => DOCUMENT_COLUMNS.findIndex(([, c]) => c === f);
  return {
    documents: drafts.map((d) => d.doc).filter((d) => !shared.has(d)).sort((a, b) => byId(a.legacyId, b.legacyId) || kindOrder(a.kind) - kindOrder(b.kind)),
    issues: issues.sort((a, b) => byId(a.legacyId, b.legacyId) || fieldOrder(a.field) - fieldOrder(b.field) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)),
  };
}
