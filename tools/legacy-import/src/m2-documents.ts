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
// string, a path step, a backslash, a control character, too long) is `document.badKey`; one
// object named by two imported people is recorded for neither (`document.sharedObject`), because
// a document belongs to one person. Object names can hold personal words (a file called after
// its owner), so they stay in memory: issues carry legacy ids, rule codes and column names only.

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
  /** For a shared object: the lowest other legacy id naming it. */
  readonly target?: string;
}

export interface M2Documents {
  readonly documents: readonly DocumentSourceRow[];
  readonly issues: readonly DocumentIssue[];
}

type Row = Readonly<Record<string, unknown>>;

const isUnset = (raw: unknown) => raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const canonicalId = (raw: unknown) => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? String(raw)
  : typeof raw === "string" && /^[1-9][0-9]{0,17}$/.test(raw.trim()) ? raw.trim() : null;

/** S3 allows 1024 bytes; the longest prefix added here is 25 characters. */
const MAX_VALUE_BYTES = 960;

/**
 * The stored value as legacy reads it (outer spaces and leading slashes removed), or null when it
 * cannot name one object safely: no path step (`.` or `..` segment), no empty segment, no
 * backslash, no control or format character, at most MAX_VALUE_BYTES of UTF-8.
 */
function objectName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^\/+/, "");
  if (v === "" || Buffer.byteLength(v, "utf8") > MAX_VALUE_BYTES) return null;
  if (/[\\\p{Cc}\p{Cf}]/u.test(v)) return null;
  if (v.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return v;
}
const basename = (v: string) => v.slice(v.lastIndexOf("/") + 1);

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
 * Maps the document columns of the candidates M-1 imports, ordered by legacy id, then kind. `people`
 * is `mapLegacyCandidates(...).people` for the same candidate rows. An unset value gets no row.
 */
export function mapLegacyDocuments(candidates: readonly Row[], people: readonly Pick<PersonImportRow, "legacyId">[]): M2Documents {
  const imported = new Set(people.map((p) => p.legacyId));
  const issues: DocumentIssue[] = [];
  const drafts: DocumentSourceRow[] = [];
  const seen = new Set<string>();

  for (const row of candidates) {
    const id = canonicalId(row.candidate_id);
    // M-1 imports an id only when it is on exactly one usable, active row.
    if (id === null || !imported.has(id) || seen.has(id)) continue;
    seen.add(id);
    for (const [kind, column] of DOCUMENT_COLUMNS) {
      const raw = row[column];
      if (isUnset(raw)) continue;
      const name = objectName(raw);
      if (name === null) { issues.push({ rule: "document.badKey", legacyId: id, field: column }); continue; }
      drafts.push({ legacyId: id, kind, keys: legacyDocumentKeys(kind, name) });
    }
  }

  // One object, one owner: any bucket key two imported people could resolve to is recorded for
  // neither, so no person can be given another's document whichever probe finds the object.
  const holders = new Map<string, Set<string>>();
  for (const d of drafts) for (const key of d.keys) (holders.get(key) ?? holders.set(key, new Set()).get(key)!).add(d.legacyId);
  const shared = new Map<DocumentSourceRow, string>();
  for (const d of drafts) {
    const others = d.keys.flatMap((key) => [...holders.get(key)!].filter((other) => other !== d.legacyId));
    if (others.length) shared.set(d, others.sort(byId)[0]!);
  }
  const column = new Map(DOCUMENT_COLUMNS);
  for (const [d, target] of shared) issues.push({ rule: "document.sharedObject", legacyId: d.legacyId, field: column.get(d.kind)!, target });

  const order = new Map(DOCUMENT_COLUMNS.map(([kind], i) => [kind, i]));
  const kindOrder = (k: DocumentKind) => order.get(k)!;
  const fieldOrder = (f: string) => DOCUMENT_COLUMNS.findIndex(([, c]) => c === f);
  return {
    documents: drafts.filter((d) => !shared.has(d)).sort((a, b) => byId(a.legacyId, b.legacyId) || kindOrder(a.kind) - kindOrder(b.kind)),
    issues: issues.sort((a, b) => byId(a.legacyId, b.legacyId) || fieldOrder(a.field) - fieldOrder(b.field) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)),
  };
}
