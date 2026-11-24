import assert from "node:assert/strict";
import test from "node:test";

import { projectApprovedProfile } from "@studenthub/profile";
import { isValidPersonSnapshotRow } from "../../../packages/db/src/import/person-snapshot-contract.js";
import { M1_SOURCES, PERSON_SNAPSHOT_KEYS, approvedSnapshotRow, mapLegacyCandidates, type M1Sources } from "../src/m1-people.js";

// Synthetic rows only, shaped like the legacy candidate, country, university and area tables.
const TODAY = "2026-11-24";
const AREA = "6f1c2b9e-0000-4000-8000-00000000000a";
const candidate = (id: number | string, extra: Record<string, unknown> = {}) => ({
  candidate_id: id, deleted: 0, candidate_name: "Test Person", candidate_name_ar: "اسم تجربة", candidate_gender: "2",
  candidate_birth_date: "2001-05-17", country_id: 7, university_id: "3", candidate_area_uuid: AREA.toUpperCase(),
  candidate_objective: "Retail work", candidate_intro: "Synthetic intro.", candidate_preferred_time: "Evenings",
  candidate_language_pref: "ar", candidate_driving_license: "1", candidate_job_search_status: "0", candidate_committed: 1,
  is_incomplete_profile: 1, candidate_pending_profile: "civil id,skill", candidate_civil_expiry_date: "2027-03-01",
  ...extra,
});
const sources = (rows: readonly Record<string, unknown>[]): M1Sources => ({
  candidate: rows,
  country: [{ country_id: 7, country_nationality_name_en: "Synthetic" }, { country_id: 8, country_nationality_name_en: "" }],
  university: [{ university_id: 3, university_name_en: "Synthetic University", deleted: 0 }],
  area: [{ area_uuid: AREA, area_name_en: "Synthetic Area" }],
});
const map = (rows: readonly Record<string, unknown>[]) => mapLegacyCandidates(sources(rows), TODAY);

test("a legacy candidate maps to a snapshot the profile projector reads in full", () => {
  const { people, issues } = map([candidate(42)]);
  assert.deepEqual(issues, []);
  assert.equal(people.length, 1);
  const person = people[0]!;
  assert.deepEqual(Object.keys(person.snapshot).sort(), [...PERSON_SNAPSHOT_KEYS].sort());
  assert.equal(person.snapshot.candidate_gender, 2);
  assert.equal(person.snapshot.candidate_job_search_status, 0);
  assert.equal(person.snapshot.nationality_name, "Synthetic");
  assert.equal(person.snapshot.area_name, "Synthetic Area");
  const profile = projectApprovedProfile(approvedSnapshotRow(person, "2026-11-24T00:30:00.000Z"), TODAY);
  const states = Object.fromEntries(Object.entries(profile.fields).map(([name, field]) => [name, field.state]));
  assert.deepEqual(Object.values(states).filter((state) => state !== "available"), [], JSON.stringify(states));
  assert.equal((profile.fields.employeeIdentifier as { value: string }).value, "C00042");
  assert.equal((profile.fields.gender as { value: string }).value, "female");
  assert.equal((profile.fields.jobSearchStatus as { value: string }).value, "not_looking");
  assert.deepEqual((profile.fields.pendingFields as unknown as { value: readonly string[] }).value, ["civil_id", "skill"]);
});

test("ids: bad, duplicate and archived rows are reported and never imported; order is by id", () => {
  const { people, issues } = map([candidate(10), candidate("x"), candidate(9), candidate(" 10"), candidate(11, { deleted: "1" }), candidate(8)]);
  assert.deepEqual(people.map((p) => p.legacyId), ["8", "9"]);
  assert.deepEqual(issues, [
    { rule: "candidate.duplicateId", legacyId: "10" },
    { rule: "candidate.badId", legacyId: "?" },
    { rule: "candidate.duplicateId", legacyId: "10" },
    { rule: "candidate.archived", legacyId: "11" },
  ]);
});

test("references: a deleted university and an id on two lookup rows are not recorded, with a row each", () => {
  const AREA_B = "6f1c2b9e-0000-4000-8000-00000000000b";
  const rows = [candidate(1, { university_id: 4 }), candidate(2, { country_id: 5, candidate_area_uuid: AREA_B }), candidate(3, { university_id: 6 }),
    candidate(4, { university_id: 8 }), candidate(5, { university_id: 9 })];
  const { people, issues } = mapLegacyCandidates({
    candidate: rows,
    country: [{ country_id: 5, country_nationality_name_en: "One" }, { country_id: "5", country_nationality_name_en: "Two" }, { country_id: 7, country_nationality_name_en: "Synthetic" }],
    university: [{ university_id: 3, university_name_en: "Synthetic University", deleted: 0 }, { university_id: 4, university_name_en: "Closed", deleted: 1 },
      { university_id: 6, university_name_en: "Open", deleted: "0" }, { university_id: 8, university_name_en: "No marker", deleted: null },
      { university_id: 9, university_name_en: "Odd marker", deleted: 2 }],
    area: [{ area_uuid: AREA, area_name_en: "Synthetic Area" }, { area_uuid: AREA_B, area_name_en: "B" }, { area_uuid: AREA_B.toUpperCase(), area_name_en: "B again" }],
  }, TODAY);
  assert.deepEqual(issues, [
    { rule: "candidate.inactiveReference", legacyId: "1", field: "university_id" },
    { rule: "candidate.ambiguousReference", legacyId: "2", field: "country_id" },
    { rule: "candidate.ambiguousReference", legacyId: "2", field: "candidate_area_uuid" },
    { rule: "candidate.inactiveReference", legacyId: "4", field: "university_id" },
    { rule: "candidate.inactiveReference", legacyId: "5", field: "university_id" },
  ]);
  assert.equal(people[0]!.snapshot.university_name, null);
  assert.equal(people[1]!.snapshot.nationality_name, null);
  assert.equal(people[1]!.snapshot.area_name, null);
  assert.equal(people[2]!.snapshot.university_name, "Open");
});

test("platform rules: one-word names and under-16 birth dates are not recorded, with a row each", () => {
  const { people, issues } = map([
    candidate(1, { candidate_name: "Mononym", candidate_name_ar: "Latin Only" }),
    candidate(2, { candidate_birth_date: "2011-01-01" }),
    candidate(3, { candidate_birth_date: "2030-01-01" }),
    candidate(4, { candidate_name: "  Two   Words ", candidate_birth_date: "2010-11-24 00:00:00" }),
  ]);
  assert.deepEqual(issues, [
    { rule: "candidate.nameRule", legacyId: "1", field: "candidate_name" },
    { rule: "candidate.nameRule", legacyId: "1", field: "candidate_name_ar" },
    { rule: "candidate.underMinimumAge", legacyId: "2", field: "candidate_birth_date" },
    { rule: "candidate.badValue", legacyId: "3", field: "candidate_birth_date" },
  ]);
  const byId = new Map(people.map((p) => [p.legacyId, p.snapshot]));
  assert.equal(byId.get("1")!.candidate_name, null);
  assert.equal(byId.get("1")!.candidate_name_ar, null);
  assert.equal(byId.get("2")!.candidate_birth_date, null);
  assert.equal(byId.get("4")!.candidate_name, "Two Words");
  // Exactly 16 on the run date is allowed.
  assert.equal(byId.get("4")!.candidate_birth_date, "2010-11-24");
});

test("unset values are not recorded without a row; unusable values are not recorded with one", () => {
  const unset = map([candidate(1, {
    candidate_name_ar: "", candidate_gender: 0, candidate_driving_license: "0", candidate_birth_date: "0000-00-00",
    candidate_civil_expiry_date: null, country_id: 0, university_id: null, candidate_area_uuid: "", candidate_objective: "  ",
    candidate_language_pref: null, is_incomplete_profile: null, candidate_pending_profile: null,
  })]);
  assert.deepEqual(unset.issues, []);
  const blank = unset.people[0]!.snapshot;
  for (const key of ["candidate_name_ar", "candidate_gender", "candidate_driving_license", "candidate_birth_date", "nationality_name", "area_name", "candidate_objective"] as const) {
    assert.equal(blank[key], null, key);
  }

  const bad = map([candidate(2, {
    candidate_gender: "9", candidate_language_pref: "fr", candidate_job_search_status: "x", candidate_committed: 4,
    candidate_civil_expiry_date: "2027-02-30", candidate_objective: "o".repeat(101), country_id: 99, university_id: 3,
    candidate_area_uuid: "unknown-area", candidate_pending_profile: "civil id,something new",
  })]);
  assert.deepEqual(bad.issues.map((i) => `${i.rule}:${i.field}`), [
    "candidate.badValue:candidate_objective", "candidate.badValue:candidate_language_pref",
    "candidate.badValue:candidate_gender", "candidate.badValue:candidate_job_search_status",
    "candidate.badValue:candidate_committed", "candidate.badValue:candidate_civil_expiry_date",
    "candidate.unknownReference:country_id", "candidate.unknownReference:candidate_area_uuid",
    "candidate.badValue:candidate_pending_profile",
  ]);
  const snapshot = bad.people[0]!.snapshot;
  assert.equal(snapshot.university_name, "Synthetic University");
  assert.equal(snapshot.is_incomplete_profile, 1);
  assert.equal(snapshot.candidate_pending_profile, null);

  const emptyName = map([candidate(3, { country_id: 8 })]);
  assert.deepEqual(emptyName.issues, [{ rule: "candidate.badValue", legacyId: "3", field: "country_id" }]);
});

test("completeness: a complete marker with pending items (or the reverse) records neither", () => {
  const { people, issues } = map([
    candidate(1, { is_incomplete_profile: 0, candidate_pending_profile: "skill" }),
    candidate(2, { is_incomplete_profile: "1", candidate_pending_profile: "" }),
    candidate(3, { is_incomplete_profile: "0", candidate_pending_profile: "" }),
  ]);
  assert.deepEqual(issues, [
    { rule: "candidate.completenessMismatch", legacyId: "1", field: "is_incomplete_profile" },
    { rule: "candidate.completenessMismatch", legacyId: "2", field: "is_incomplete_profile" },
  ]);
  assert.equal(people[0]!.snapshot.is_incomplete_profile, null);
  assert.equal(people[0]!.snapshot.candidate_pending_profile, null);
  assert.equal(people[2]!.snapshot.is_incomplete_profile, 0);
  assert.equal(people[2]!.snapshot.candidate_pending_profile, "");
});

test("re-running is idempotent: same rows, same snapshots and digests; a changed value changes the digest", () => {
  const first = map([candidate(5), candidate(6)]);
  const again = map([candidate(5), candidate(6)]);
  assert.deepEqual(again, first);
  const changed = map([candidate(5, { candidate_objective: "Other work" }), candidate(6)]);
  assert.notEqual(changed.people[0]!.digest, first.people[0]!.digest);
  assert.equal(changed.people[1]!.digest, first.people[1]!.digest);
  assert.match(first.people[0]!.digest, /^[0-9a-f]{64}$/);
});

test("issues carry ids, rule codes and column names only, never legacy values", () => {
  const secret = "Zz Secretvalue";
  const { issues } = map([candidate(7, { candidate_name_ar: secret, candidate_objective: `${secret}${"x".repeat(200)}` })]);
  assert.ok(issues.length > 0);
  assert.ok(!JSON.stringify(issues).includes("Secretvalue"));
  for (const issue of issues) assert.deepEqual(Object.keys(issue).sort(), ["field", "legacyId", "rule"]);
});

test("the source list never selects credentials, contact details, bank or civil ID numbers", () => {
  const columns = Object.values(M1_SOURCES).flat() as string[];
  for (const forbidden of ["candidate_password_hash", "candidate_auth_key", "candidate_password_reset_token", "candidate_email",
    "candidate_phone", "candidate_iban", "bank_account_name", "candidate_civil_id", "candidate_personal_photo", "candidate_resume",
    "candidate_civil_photo_front", "candidate_civil_photo_back", "candidate_latitude", "candidate_longitude"]) {
    assert.ok(!columns.includes(forbidden), forbidden);
  }
  // Every column the mapper reads from a candidate row is on the list.
  const read = new Set<string>();
  const probe = new Proxy(candidate(1), { get: (target, key) => { if (typeof key === "string") read.add(key); return Reflect.get(target, key); } });
  map([probe]);
  for (const key of read) assert.ok((M1_SOURCES.candidate as readonly string[]).includes(key), key);
});

test("every mapped snapshot projects without error, whatever legacy holds (synthetic fuzz)", () => {
  const values: unknown[] = [null, "", " ", 0, 1, 2, 3, "1", "2", "9", -1, true, false, "en", "AR", "2000-01-01", "1900-01-01",
    "0000-00-00", "2026-11-24 10:00:00", "not a date", "One", "Two Words", "اسم تجربة", "x".repeat(300), "a\nb", {}, [], 1.5];
  const keys = M1_SOURCES.candidate.filter((key) => key !== "candidate_id" && key !== "deleted");
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed; };
  const rows = Array.from({ length: 400 }, (_, i) => Object.fromEntries([["candidate_id", i + 1], ["deleted", 0],
    ...keys.map((key) => [key, values[next() % values.length]])]));
  const { people } = map(rows);
  assert.equal(people.length, 400);
  for (const person of people) {
    projectApprovedProfile(approvedSnapshotRow(person, "2026-11-24T00:30:00.000Z"), TODAY);
    assert.ok(isValidPersonSnapshotRow(person), person.legacyId);
  }
});

test("the run date and import time are checked", () => {
  assert.throws(() => mapLegacyCandidates(sources([]), "2026-02-30"), /m1.badToday/);
  const person = map([candidate(1)]).people[0]!;
  assert.throws(() => approvedSnapshotRow(person, "2026-11-24"), /m1.badImportedAt/);
});
