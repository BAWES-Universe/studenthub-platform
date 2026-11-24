// Cutover lane M-1: the one contract the people mapper (tools/legacy-import/src/m1-people.ts) and
// the snapshot store share. A snapshot has exactly these keys, each a string, a number or null;
// its candidate_id is its own canonical legacy id; and its digest is sha256 over the canonical
// JSON of { legacyId, snapshot }. The store checks all of it before it reads or writes anything.
// No pg import: the pure mapper uses this file too.

import { createHash } from "node:crypto";

/** The snapshot keys the profile projector reads (`readField` in packages/profile). */
export const PERSON_SNAPSHOT_KEYS = [
  "candidate_id", "candidate_name", "candidate_name_ar", "candidate_gender", "candidate_birth_date", "nationality_name",
  "university_name", "candidate_objective", "candidate_intro", "candidate_preferred_time", "candidate_language_pref",
  "area_name", "candidate_driving_license", "candidate_job_search_status", "candidate_committed",
  "is_incomplete_profile", "candidate_pending_profile", "candidate_civil_expiry_date",
] as const;
export type PersonSnapshotKey = (typeof PERSON_SNAPSHOT_KEYS)[number];
export type PersonSnapshot = Readonly<Record<PersonSnapshotKey, string | number | null>>;

/** A canonical legacy candidate id: positive digits, no padding, at most 18 digits. */
export const CANONICAL_CANDIDATE_ID = /^[1-9][0-9]{0,17}$/;

function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]))
      : value;
}

export function personSnapshotDigest(legacyId: string, snapshot: PersonSnapshot): string {
  return createHash("sha256").update(JSON.stringify(canonical({ legacyId, snapshot }))).digest("hex");
}

/** True only for a row the mapper could have produced: closed shape, own canonical id, matching digest. */
export function isValidPersonSnapshotRow(row: unknown): row is { readonly legacyId: string; readonly snapshot: PersonSnapshot; readonly digest: string } {
  if (row === null || typeof row !== "object") return false;
  const { legacyId, snapshot, digest } = row as Record<string, unknown>;
  if (typeof legacyId !== "string" || !CANONICAL_CANDIDATE_ID.test(legacyId)) return false;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return false;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const keys = Object.keys(snapshot);
  if (keys.length !== PERSON_SNAPSHOT_KEYS.length || !PERSON_SNAPSHOT_KEYS.every((key) => Object.hasOwn(snapshot, key))) return false;
  for (const key of PERSON_SNAPSHOT_KEYS) {
    const value = (snapshot as Record<string, unknown>)[key];
    if (!(value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) return false;
  }
  if ((snapshot as Record<string, unknown>).candidate_id !== legacyId) return false;
  return personSnapshotDigest(legacyId, snapshot as PersonSnapshot) === digest;
}
