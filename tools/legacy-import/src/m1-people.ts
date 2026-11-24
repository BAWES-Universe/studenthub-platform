// M-1 people, first slice: legacy `candidate` rows to the approved profile snapshot that My profile
// reads for a linked person (ApprovedProfileAdapter.readCandidate, projectApprovedProfile). Pure.
// Every value is checked with the platform's own code: the snapshot projector decides what a
// column may hold, and the self-edit rules decide names and the minimum age (queue 13: a value
// that fails a platform rule is imported as "not recorded" with a reconciliation row, never forced
// through and never dropped silently). So an imported snapshot never makes a profile unavailable.
// Issues carry legacy ids, rule codes and column names only: never a name, date or other value.
//
// Out of this slice: the store and adapter that serve the snapshot, and the queue 13/14 columns
// (phone, handle, civil ID) that load into person_profiles for linked people at cutover.

import { createHash } from "node:crypto";
import {
  PROFILE_PARITY_REVISION,
  isPersonProfileMinimumAge,
  projectApprovedProfile,
  validPersonBirthDate,
  validatePersonSelfEditValue,
} from "@studenthub/profile";

/**
 * Every legacy table and column M-1 reads. A column outside this list is never selected: no
 * password hash, token, email, phone, IBAN, civil ID number or document location.
 */
export const M1_SOURCES = {
  candidate: [
    "candidate_id", "deleted", "candidate_name", "candidate_name_ar", "candidate_gender", "candidate_birth_date",
    "country_id", "university_id", "candidate_area_uuid", "candidate_objective", "candidate_intro",
    "candidate_preferred_time", "candidate_language_pref", "candidate_driving_license", "candidate_job_search_status",
    "candidate_committed", "is_incomplete_profile", "candidate_pending_profile", "candidate_civil_expiry_date",
  ],
  country: ["country_id", "country_nationality_name_en"],
  university: ["university_id", "university_name_en"],
  area: ["area_uuid", "area_name_en"],
} as const satisfies Record<string, readonly string[]>;
export type M1Table = keyof typeof M1_SOURCES;

/** The snapshot keys the profile projector reads (`readField` in packages/profile). */
export const PERSON_SNAPSHOT_KEYS = [
  "candidate_id", "candidate_name", "candidate_name_ar", "candidate_gender", "candidate_birth_date", "nationality_name",
  "university_name", "candidate_objective", "candidate_intro", "candidate_preferred_time", "candidate_language_pref",
  "area_name", "candidate_driving_license", "candidate_job_search_status", "candidate_committed",
  "is_incomplete_profile", "candidate_pending_profile", "candidate_civil_expiry_date",
] as const;
export type PersonSnapshotKey = (typeof PERSON_SNAPSHOT_KEYS)[number];
export type PersonSnapshot = Readonly<Record<PersonSnapshotKey, string | number | null>>;

export interface PersonImportRow {
  readonly legacyId: string;
  readonly snapshot: PersonSnapshot;
  readonly digest: string;
}

export type PersonIssueRule =
  | "candidate.badId"
  | "candidate.duplicateId"
  | "candidate.archived" // deleted in legacy (a duplicate account is also deleted); not imported
  | "candidate.badValue" // one column unusable; imported with that value not recorded
  | "candidate.nameRule" // a name the platform's name rule refuses (one word, digits); not recorded
  | "candidate.underMinimumAge" // birth date under the platform's minimum age of 16; not recorded
  | "candidate.unknownReference" // country, university or area id not in its legacy table; not recorded
  | "candidate.completenessMismatch"; // complete marker disagrees with the pending list; both not recorded

export interface PersonIssue {
  readonly rule: PersonIssueRule;
  readonly legacyId: string;
  /** The legacy column, never its value. */
  readonly field?: string;
}

type Row = Readonly<Record<string, unknown>>;
export interface M1People {
  readonly people: readonly PersonImportRow[];
  readonly issues: readonly PersonIssue[];
}

function legacyId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value.trim()) ? value.trim() : null;
}

const isUnset = (raw: unknown) => raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
const isTrue = (raw: unknown) => raw === true || raw === 1 || raw === "1";

/** MySQL tinyint and enum-like columns arrive as numbers, digit strings or booleans. */
function code(raw: unknown): number | null {
  if (typeof raw === "boolean") return Number(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d{1,3}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** A DATE or DATETIME column as YYYY-MM-DD, or null when it is not a calendar date. */
function calendarDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)?$/.exec(raw.trim());
  return match && validPersonBirthDate(match[1]!) ? match[1]! : null;
}
const ZERO_DATE = /^0000-00-00(?:[ T]00:00:00)?$/;

/** Names keep their letters; outer spaces and runs of spaces are legacy entry artifacts. */
const tidyName = (raw: string) => raw.normalize("NFC").trim().replace(/[ \t]+/g, " ");

const SNAPSHOT_HEAD = { imported_at: "2000-01-01T00:00:00.000Z", source_revision: PROFILE_PARITY_REVISION };

/** True when the profile projector reads this one key without error: the platform decides. */
function projectorAccepts(key: PersonSnapshotKey, value: string | number, today: string): boolean {
  try {
    const fields = projectApprovedProfile({ ...SNAPSHOT_HEAD, [key]: value }, today).fields as Record<string, { state: string }>;
    return Object.values(fields).some((field) => field.state === "available");
  } catch {
    return false;
  }
}

function digestOf(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function nameIndex(rows: readonly Row[], idColumn: string, nameColumn: string, uuid: boolean): ReadonlyMap<string, unknown> {
  const index = new Map<string, unknown>();
  for (const row of rows) {
    const raw = row[idColumn];
    const id = uuid ? (typeof raw === "string" && raw.trim() !== "" ? raw.trim().toLowerCase() : null) : legacyId(raw);
    if (id !== null && !index.has(id)) index.set(id, row[nameColumn]);
  }
  return index;
}

export interface M1Sources {
  readonly candidate: readonly Row[];
  readonly country: readonly Row[];
  readonly university: readonly Row[];
  readonly area: readonly Row[];
}

/**
 * Maps legacy candidates to approved profile snapshots, ordered by legacy id. The first row of
 * each id decides it; a later row with the same id is a duplicate and never imported. `today`
 * is the Kuwait date of the run (YYYY-MM-DD): the minimum-age rule is applied as of that day.
 */
export function mapLegacyCandidates(sources: M1Sources, today: string): M1People {
  if (!validPersonBirthDate(today)) throw new Error("m1.badToday");
  const countries = nameIndex(sources.country, "country_id", "country_nationality_name_en", false);
  const universities = nameIndex(sources.university, "university_id", "university_name_en", false);
  const areas = nameIndex(sources.area, "area_uuid", "area_name_en", true);
  const issues: PersonIssue[] = [];
  const people = new Map<string, PersonImportRow>();
  const seen = new Set<string>();

  for (const row of sources.candidate) {
    const id = legacyId(row.candidate_id);
    if (id === null) { issues.push({ rule: "candidate.badId", legacyId: "?" }); continue; }
    if (seen.has(id)) { issues.push({ rule: "candidate.duplicateId", legacyId: id }); continue; }
    seen.add(id);
    if (isTrue(row.deleted)) { issues.push({ rule: "candidate.archived", legacyId: id }); continue; }

    const snapshot = Object.fromEntries(PERSON_SNAPSHOT_KEYS.map((key) => [key, null])) as Record<PersonSnapshotKey, string | number | null>;
    const report = (rule: PersonIssueRule, field: string) => issues.push({ rule, legacyId: id, field });
    /** Keeps the value when the projector reads it; otherwise not recorded, with a row. */
    const keep = (key: PersonSnapshotKey, value: string | number | null, field: string) => {
      if (value === null) return report("candidate.badValue", field);
      if (projectorAccepts(key, value, today)) snapshot[key] = value;
      else report("candidate.badValue", field);
    };

    snapshot.candidate_id = id;

    for (const [key, field, rule] of [
      ["candidate_name", "displayName", "candidate_name"],
      ["candidate_name_ar", "arabicName", "candidate_name_ar"],
    ] as const) {
      const raw = row[rule];
      if (isUnset(raw)) continue;
      if (typeof raw !== "string") { report("candidate.badValue", rule); continue; }
      const checked = validatePersonSelfEditValue(field, tidyName(raw), today);
      if (!checked.ok) { report(checked.reason === "length" || checked.reason === "characters" ? "candidate.badValue" : "candidate.nameRule", rule); continue; }
      keep(key, checked.value, rule);
    }

    for (const key of ["candidate_objective", "candidate_intro", "candidate_preferred_time"] as const) {
      const raw = row[key];
      if (isUnset(raw)) continue;
      keep(key, typeof raw === "string" ? raw : null, key);
    }

    const language = row.candidate_language_pref;
    if (!isUnset(language)) keep("candidate_language_pref", typeof language === "string" ? language.trim().toLowerCase() : null, "candidate_language_pref");

    // Codes: 0 means "not set" for gender and driving licence; for job search and committed, 0 is a value.
    for (const [key, zeroUnset] of [
      ["candidate_gender", true], ["candidate_driving_license", true],
      ["candidate_job_search_status", false], ["candidate_committed", false],
    ] as const) {
      const raw = row[key];
      if (isUnset(raw)) continue;
      const value = code(raw);
      if (value === 0 && zeroUnset) continue;
      keep(key, value, key);
    }

    const birth = row.candidate_birth_date;
    if (!isUnset(birth) && !(typeof birth === "string" && ZERO_DATE.test(birth.trim()))) {
      const date = calendarDate(birth);
      if (date === null || date > today) report("candidate.badValue", "candidate_birth_date");
      else if (!isPersonProfileMinimumAge(date, today)) report("candidate.underMinimumAge", "candidate_birth_date");
      else keep("candidate_birth_date", date, "candidate_birth_date");
    }

    const expiry = row.candidate_civil_expiry_date;
    if (!isUnset(expiry) && !(typeof expiry === "string" && ZERO_DATE.test(expiry.trim()))) {
      keep("candidate_civil_expiry_date", calendarDate(expiry), "candidate_civil_expiry_date");
    }

    for (const [key, field, index, uuid] of [
      ["nationality_name", "country_id", countries, false],
      ["university_name", "university_id", universities, false],
      ["area_name", "candidate_area_uuid", areas, true],
    ] as const) {
      const raw = row[field];
      if (isUnset(raw) || raw === 0 || raw === "0") continue;
      const ref = uuid ? (typeof raw === "string" ? raw.trim().toLowerCase() : null) : legacyId(raw);
      if (ref === null || !index.has(ref)) { report("candidate.unknownReference", field); continue; }
      const name = index.get(ref);
      if (isUnset(name)) { report("candidate.badValue", field); continue; }
      keep(key, typeof name === "string" ? name.trim() : null, field);
    }

    const incomplete = row.is_incomplete_profile;
    if (!isUnset(incomplete)) keep("is_incomplete_profile", code(incomplete), "is_incomplete_profile");
    const pending = row.candidate_pending_profile;
    if (pending !== null && pending !== undefined) keep("candidate_pending_profile", typeof pending === "string" ? pending.trim() : null, "candidate_pending_profile");
    if (snapshot.is_incomplete_profile !== null && snapshot.candidate_pending_profile !== null
      && (snapshot.is_incomplete_profile === 1) !== (snapshot.candidate_pending_profile !== "")) {
      snapshot.is_incomplete_profile = null;
      snapshot.candidate_pending_profile = null;
      report("candidate.completenessMismatch", "is_incomplete_profile");
    }

    const frozen = Object.freeze(snapshot);
    people.set(id, Object.freeze({ legacyId: id, snapshot: frozen, digest: digestOf({ legacyId: id, snapshot: frozen }) }));
  }

  const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return Object.freeze({
    people: Object.freeze([...people.keys()].sort(byId).map((id) => people.get(id)!)),
    issues: Object.freeze(issues),
  });
}

/** The row the approved profile adapter serves: the snapshot plus its import time and revision. */
export function approvedSnapshotRow(person: PersonImportRow, importedAt: string): Readonly<Record<string, unknown>> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(importedAt) || !Number.isFinite(Date.parse(importedAt))) {
    throw new Error("m1.badImportedAt");
  }
  return Object.freeze({ ...person.snapshot, imported_at: importedAt, source_revision: PROFILE_PARITY_REVISION });
}
