import assert from "node:assert/strict";
import test from "node:test";
import { projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES } from "../src/index.js";
import type { OwnProfileProjection, PendingProfileRequirement, ProfileField } from "../src/types.js";
import * as builtInCompleteness from "../src/completeness.js";

const implementation = process.env.SHU576_TEST_MODULE
  ? await import(process.env.SHU576_TEST_MODULE) as typeof builtInCompleteness
  : builtInCompleteness;
const { deriveProfileCompleteness } = implementation;

function profile(pending: readonly PendingProfileRequirement[] = []): OwnProfileProjection {
  const legacy = new Map<PendingProfileRequirement, string>([
    ["nationality", "country"], ["display_name", "name"], ["arabic_name", "Name Arabic"],
    ["gender", "gender"], ["objective", "objective"], ["personal_photo", "personal photo"],
    ["email", "email"], ["phone", "phone"], ["birth_date", "birth date"], ["civil_id", "civil id"],
    ["civil_expiry", "civil expiry date"], ["civil_front", "civil photo front"],
    ["civil_back", "civil photo back"], ["driving_licence", "driving license"], ["location", "location"],
    ["kuwaiti_mother", "candidate_mom_kuwaiti"], ["education", "education"], ["skill", "skill"],
  ]);
  return projectApprovedProfile({ ...SYNTHETIC_PROFILE_FIXTURES.populated,
    is_incomplete_profile: pending.length ? 1 : 0,
    candidate_pending_profile: pending.map((item) => legacy.get(item)).join(","),
  }, "2026-09-13");
}

function withField<T>(base: OwnProfileProjection, name: string, field: ProfileField<T>): OwnProfileProjection {
  return { ...base, fields: { ...base.fields, [name]: field } } as OwnProfileProjection;
}

function missingField(base: OwnProfileProjection, name: string, kind: "imported_snapshot" | "written_by_person" = "written_by_person") {
  const original = base.fields.displayName;
  return withField(base, name, { state: "unavailable", reason: "not_recorded",
    provenance: original.provenance, freshness: { kind, observedAt: "2026-09-14T00:00:00.000Z" } });
}

function writtenField<T>(base: OwnProfileProjection, name: string, value: T, editValue?: string) {
  const original = base.fields.displayName;
  return withField(base, name, { state: "available", value, provenance: original.provenance,
    freshness: { kind: "written_by_person", observedAt: "2026-09-14T00:00:00.000Z" }, ...editValue ? { editValue } : {} });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    profile: { state: "available", value: profile() },
    principalEmailPresent: { state: "available", value: true },
    activeBackground: { state: "available", value: { educationCount: 1, skillCount: 1 } },
    documentTypesOnFile: { state: "available", value: ["personal-photo", "civil-id-front", "civil-id-back"] },
    civilIdRecorded: { state: "available", value: { number: true, expiry: true } },
    writtenNationalityCode: { state: "available", value: "KW" },
    ...overrides,
  } as Parameters<typeof deriveProfileCompleteness>[0];
}

function pending(overrides: Record<string, unknown> = {}) {
  const result = deriveProfileCompleteness(input(overrides));
  assert.equal(result.kind, "available");
  return result.kind === "available" ? result.pendingFields : [];
}

test("Q14_4_RULES every legacy requirement has positive and negative fixtures in fixed order", () => {
  const base = profile();
  const fieldCases = [
    ["nationality", "nationality"], ["display_name", "displayName"], ["arabic_name", "arabicName"],
    ["gender", "gender"], ["objective", "objective"], ["birth_date", "birthDate"],
    ["driving_licence", "drivingLicence"], ["location", "area"],
  ] as const;
  for (const [requirement, field] of fieldCases) {
    assert.ok(!pending().includes(requirement), `${requirement} positive`);
    assert.ok(pending({ profile: { state: "available", value: missingField(base, field) } }).includes(requirement), `${requirement} negative`);
  }
  for (const [type, requirement] of [["personal-photo", "personal_photo"], ["civil-id-front", "civil_front"], ["civil-id-back", "civil_back"]] as const) {
    assert.ok(pending({ documentTypesOnFile: { state: "available", value: ["personal-photo", "civil-id-front", "civil-id-back"].filter(v => v !== type) } }).includes(requirement));
  }
  assert.deepEqual(pending({ principalEmailPresent: { state: "available", value: false },
    activeBackground: { state: "available", value: { educationCount: 0, skillCount: 0 } },
    civilIdRecorded: { state: "available", value: { number: false, expiry: false } },
    documentTypesOnFile: { state: "available", value: [] },
    profile: { state: "available", value: missingField(missingField(profile(["phone", "civil_id", "civil_expiry"]), "phone", "imported_snapshot"), "area", "imported_snapshot") },
  }), ["personal_photo", "email", "phone", "civil_id", "civil_expiry", "civil_front", "civil_back", "location", "education", "skill"]);
  assert.ok(!pending().includes("identity_reference"));
});

test("Q14_4_RULES No booleans are answers and blank text is missing without throwing", () => {
  let value = writtenField(profile(), "drivingLicence", false);
  value = writtenField(value, "kuwaitiMother", false);
  value = writtenField(value, "nationality", "Jordanian", "country-jo");
  assert.ok(!pending({ profile: { state: "available", value }, writtenNationalityCode: { state: "available", value: "JO" } }).includes("driving_licence"));
  assert.ok(!pending({ profile: { state: "available", value }, writtenNationalityCode: { state: "available", value: "JO" } }).includes("kuwaiti_mother"));
  for (const blank of ["", "  \t"] as const) {
    const result = pending({ profile: { state: "available", value: writtenField(profile(), "objective", blank) } });
    assert.ok(result.includes("objective"));
  }
  for (const value of [false, true, 0, 1, "No", "Yes", null, undefined, {}, []]) {
    assert.doesNotThrow(() => pending({ profile: { state: "available", value: writtenField(profile(), "drivingLicence", value) } }));
  }
});

test("Q14_4_RULES written values win and imported-only fallback ends after a platform write", () => {
  const imported = profile(["phone", "civil_id", "civil_expiry"]);
  assert.deepEqual(pending({ profile: { state: "available", value: imported },
    civilIdRecorded: { state: "available", value: { number: false, expiry: false } } }).filter(x => ["phone", "civil_id", "civil_expiry"].includes(x)),
  ["phone", "civil_id", "civil_expiry"]);
  const absentFromList = profile();
  assert.deepEqual(pending({ profile: { state: "available", value: absentFromList },
    civilIdRecorded: { state: "available", value: { number: false, expiry: false } } }).filter(x => ["phone", "civil_id", "civil_expiry"].includes(x)), []);
  let written = missingField(absentFromList, "phone");
  written = missingField(written, "pendingFields");
  assert.deepEqual(pending({ profile: { state: "available", value: written },
    civilIdRecorded: { state: "available", value: { number: false, expiry: false } } }).filter(x => ["phone", "civil_id", "civil_expiry"].includes(x)),
  ["phone", "civil_id", "civil_expiry"]);
  written = writtenField(written, "phone", "+96512345678");
  assert.ok(!pending({ profile: { state: "available", value: written } }).includes("phone"));
});

test("Q14_4_RULES documents and active records never use the imported pending list", () => {
  const importedComplete = profile();
  assert.deepEqual(pending({ profile: { state: "available", value: importedComplete }, documentTypesOnFile: { state: "available", value: [] },
    activeBackground: { state: "available", value: { educationCount: 0, skillCount: 0 } } }).filter(x => ["personal_photo", "civil_front", "civil_back", "education", "skill"].includes(x)),
  ["personal_photo", "civil_front", "civil_back", "education", "skill"]);
});

test("Q14_4_RULES no snapshot treats imported-only requirements as missing", () => {
  const unavailable = projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.unavailable, "2026-09-13");
  const result = pending({ profile: { state: "available", value: unavailable },
    principalEmailPresent: { state: "available", value: false },
    civilIdRecorded: { state: "available", value: { number: false, expiry: false } } });
  for (const requirement of ["phone", "civil_id", "civil_expiry"] as const) assert.ok(result.includes(requirement));
});

test("Q14_4_RULES Kuwaiti mother uses code KW, never name, with imported fallback", () => {
  let jordan = writtenField(profile(), "nationality", "Kuwaiti", "country-jo");
  jordan = missingField(jordan, "kuwaitiMother");
  assert.ok(pending({ profile: { state: "available", value: jordan }, writtenNationalityCode: { state: "available", value: "JO" } }).includes("kuwaiti_mother"));
  assert.ok(!pending({ profile: { state: "available", value: jordan }, writtenNationalityCode: { state: "available", value: "KW" } }).includes("kuwaiti_mother"));
  assert.ok(pending({ profile: { state: "available", value: profile(["kuwaiti_mother"]) } }).includes("kuwaiti_mother"));
  assert.ok(!pending({ profile: { state: "available", value: profile() } }).includes("kuwaiti_mother"));
  const wiped = missingField(profile(), "pendingFields");
  assert.ok(!pending({ profile: { state: "available", value: wiped } }).includes("kuwaiti_mother"));
});

test("Q14_4_DERIVED every failed or unconfigured source is unavailable and unknown catalogue ids fail", () => {
  for (const key of ["profile", "principalEmailPresent", "activeBackground", "documentTypesOnFile", "civilIdRecorded", "writtenNationalityCode"] as const) {
    for (const state of ["failed", "unconfigured"] as const) {
      assert.deepEqual(deriveProfileCompleteness(input({ [key]: { state } })), { kind: "unavailable", reason: "check_failed" });
    }
  }
  const written = writtenField(profile(), "nationality", "Jordanian", "missing-id");
  assert.deepEqual(deriveProfileCompleteness(input({ profile: { state: "available", value: written },
    writtenNationalityCode: { state: "available", value: null } })), { kind: "unavailable", reason: "check_failed" });
});

test("Q14_4_COMPAT derivation is pure and does not alter repository projection fields", () => {
  const value = profile();
  const before = structuredClone(value);
  assert.deepEqual(deriveProfileCompleteness(input({ profile: { state: "available", value } })), { kind: "available", pendingFields: [] });
  assert.deepEqual(value, before);
  assert.equal(value.fields.isProfileCompleted.freshness.kind, "imported_snapshot");
});
