import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OwnProfileRepository, SHU372_RULES, createPersonSelfEdit, normalizePersonSelfEditValue } from "../src/index.js";
import type { CommitInput, SafeWriteStore } from "@studenthub/safe-write-contract";
import { SYNTHETIC_PROFILE_FIXTURES } from "../src/fixtures.js";
const TODAY = "2026-10-30";

test("SHU372_RULES every shared rule example has the specified result", () => {
  for (const [field, rule] of Object.entries(SHU372_RULES)) {
    for (const value of rule.accepts) assert.equal(normalizePersonSelfEditValue(field as keyof typeof SHU372_RULES, value, TODAY), value.normalize("NFC"), `${field} accepts ${value}`);
    for (const value of rule.refuses) assert.equal(normalizePersonSelfEditValue(field as keyof typeof SHU372_RULES, value, TODAY), null, `${field} refuses ${value}`);
  }
  assert.equal(normalizePersonSelfEditValue("displayName", "Noor Al-Sabah", TODAY), "Noor Al-Sabah");
  assert.equal(normalizePersonSelfEditValue("arabicName", "نور الصباح", TODAY), "نور الصباح");
  assert.equal(normalizePersonSelfEditValue("displayName", "Noe\u0308l Al-Sabah", TODAY), "Noël Al-Sabah");
});

test("SHU392_S1 each written value is read into its own profile field with its own date", async () => {
  const dates = ["2026-10-01T01:00:00.000Z", "2026-10-02T02:00:00.000Z", "2026-10-03T03:00:00.000Z", "2026-10-04T04:00:00.000Z", "2026-10-05T05:00:00.000Z"];
  const values = { displayName: "Noor Al-Sabah", arabicName: "نور الصباح", objective: "A new objective", intro: "A new introduction", preferredTime: "Early mornings" };
  const preferences = Object.fromEntries(Object.entries(values).map(([field, value], index) => [field, { value, updatedAt: dates[index] }]));
  const repository = new OwnProfileRepository({
    principals: { getPrincipal: async () => ({ id: "person", pbuuids: [], email: "person@example.invalid" }) },
    source: { resolveLink: async () => ({ kind: "linked", candidateRef: "candidate" }), readCandidate: async () => SYNTHETIC_PROFILE_FIXTURES.populated },
    preferences: { readOwnPreferences: async () => preferences } as never,
    today: () => "2026-10-30",
  });
  const result = await repository.readOwn({ requesterPrincipalId: "person", targetPersonId: "person" });
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  for (const [index, [field, value]] of Object.entries(values).entries()) {
    const shown: { state: string; value?: unknown; freshness: { observedAt: string } } = result.profile.fields[field as keyof typeof values] as never;
    assert.equal(shown.state, "available");
    if (shown.state === "available") { assert.equal(shown.value, value); assert.equal(shown.freshness.observedAt, dates[index]); }
  }
});

test("SHU392_DIGEST normalization is deterministic before safe-write digesting", () => {
  assert.equal(createHash("sha256").update(normalizePersonSelfEditValue("displayName", "Noe\u0308l Al-Sabah", TODAY)!).digest("hex"),
    createHash("sha256").update("Noël Al-Sabah").digest("hex"));
});

test("SHU415_WRITE accepts ids and the two explicitly clearable origin fields", () => {
  const country = "11111111-1111-4111-8111-111111111111";
  assert.equal(normalizePersonSelfEditValue("nationality", country, TODAY), country);
  assert.equal(normalizePersonSelfEditValue("nationality", "Kuwait", TODAY), null);
  assert.equal(normalizePersonSelfEditValue("university", "", TODAY), "");
  assert.equal(normalizePersonSelfEditValue("kuwaitiMother", "", TODAY), "");
  assert.equal(normalizePersonSelfEditValue("kuwaitiMother", "false", TODAY), "false");
});

test("SHU392_CLEAR a cleared field is shown as written and not recorded", async () => {
  const updatedAt = "2026-10-30T05:00:00.000Z";
  const repository = new OwnProfileRepository({
    principals: { getPrincipal: async () => ({ id: "person", pbuuids: [], email: "person@example.invalid" }) },
    source: { resolveLink: async () => ({ kind: "linked", candidateRef: "candidate" }), readCandidate: async () => SYNTHETIC_PROFILE_FIXTURES.populated },
    preferences: { readOwnPreferences: async () => ({ arabicName: { value: null, updatedAt } }) } as never,
    today: () => "2026-10-30",
  });
  const result = await repository.readOwn({ requesterPrincipalId: "person", targetPersonId: "person" });
  assert.equal(result.kind, "found");
  if (result.kind === "found") assert.deepEqual(result.profile.fields.arabicName, {
    state: "unavailable", reason: "not_recorded",
    provenance: { system: "studenthub-production-approved-import", revision: "c2ce255695eabc7e3a0f23b162f5996274234c63", sourceField: "candidate_name_ar" },
    freshness: { kind: "written_by_person", observedAt: updatedAt },
  });
});

function writeFixture() {
  const principalRef = "a".repeat(64), personRef = "b".repeat(64), spent = new Set<string>();
  let value: string | null = null;
  let owner = true;
  const store: SafeWriteStore = {
    ownedRecord: async ref => owner && ref === principalRef ? personRef : null,
    readField: async (ref, field) => ref === personRef && field === "objective" ? value : null,
    commit: async (input: CommitInput) => {
      if (!owner) return { ok: false, reason: "not_own_record" };
      if (spent.has(input.tokenId)) return { ok: false, reason: "token_already_used" };
      if (value !== input.expectedBefore) return { ok: false, reason: "state_changed" };
      value = input.value; spent.add(input.tokenId); return { ok: true };
    },
  };
  const writer = createPersonSelfEdit({ store, secret: "s".repeat(32) });
  const request = (after: string) => ({ principalRef, change: { personRef, field: "objective", value: after } });
  return { writer, request, value: () => value, loseOwner: () => { owner = false; }, change: (next: string) => { value = next; } };
}

test("SHU372_WRITE writes, clears, refuses replay, and detects stale state", async () => {
  const x = writeFixture(), first = x.request("Build teams");
  const preview = await x.writer.preview(first); assert.ok(preview.ok);
  if (!preview.ok) return;
  assert.ok((await x.writer.confirm({ ...first, token: preview.token })).ok);
  assert.equal(x.value(), "Build teams");
  assert.deepEqual(await x.writer.confirm({ ...first, token: preview.token }), { ok: false, reason: "token_already_used" });
  const clear = x.request(""), clearing = await x.writer.preview(clear); assert.ok(clearing.ok);
  if (!clearing.ok) return;
  x.change("concurrent");
  assert.deepEqual(await x.writer.confirm({ ...clear, token: clearing.token }), { ok: false, reason: "state_changed" });
});

test("SHU372_OWNER another record and ownership lost after preview are refused", async () => {
  const x = writeFixture();
  assert.deepEqual(await x.writer.preview({ ...x.request("Build teams"), change: { ...x.request("Build teams").change, personRef: "c".repeat(64) } }), { ok: false, reason: "not_own_record" });
  const request = x.request("Build teams"), preview = await x.writer.preview(request); assert.ok(preview.ok);
  if (!preview.ok) return;
  x.loseOwner();
  assert.deepEqual(await x.writer.confirm({ ...request, token: preview.token }), { ok: false, reason: "not_own_record" });
});

test("SHU413_AGE uses the service clock and the single minimum-age setting", async () => {
  const x = writeFixture();
  const store = x.writer;
  void store;
  const principalRef = "a".repeat(64), personRef = "b".repeat(64);
  const values = new Map<string, string | null>();
  const writer = createPersonSelfEdit({
    store: { ownedRecord: async () => personRef, readField: async (_r, f) => values.get(f) ?? null, commit: async () => ({ ok: true }) },
    secret: "s".repeat(32), clock: { now: () => new Date("2026-10-30T23:59:59.000Z") },
  });
  const preview = (value: string) => writer.preview({ principalRef, change: { personRef, field: "birthDate", value } });
  assert.equal((await preview("2010-10-30")).ok, true);
  assert.equal((await preview("2010-10-31")).ok, true);
  assert.deepEqual(await preview("2010-11-01"), { ok: false, reason: "invalid_value" });
  assert.deepEqual(await preview("2010-02-30"), { ok: false, reason: "invalid_value" });
});

test("SHU413_WRITE accepts only platform enums for the four choice fields", () => {
  for (const [field, accepted, refused] of [
    ["gender", ["male", "female", "other"], ["1", "Male"]],
    ["drivingLicence", ["true", "false"], ["yes", "1"]],
    ["jobSearchStatus", ["not_looking", "active", "open_to_offers"], ["looking", "1"]],
  ] as const) {
    for (const value of accepted) assert.equal(normalizePersonSelfEditValue(field, value, "2026-10-30"), value);
    for (const value of refused) assert.equal(normalizePersonSelfEditValue(field, value, "2026-10-30"), null);
  }
});

test("SHU413_AGE an implausibly old stored birth date keeps the date and makes only age unavailable", async () => {
  const principalRef = "a".repeat(64), personRef = "b".repeat(64);
  let birthDate: string | null = null;
  const writer = createPersonSelfEdit({
    store: {
      ownedRecord: async () => personRef,
      readField: async () => birthDate,
      commit: async input => { birthDate = input.value; return { ok: true }; },
    },
    secret: "s".repeat(32), clock: { now: () => new Date("2026-10-30T12:00:00.000Z") },
  });
  const request = { principalRef, change: { personRef, field: "birthDate", value: "1800-01-01" } } as const;
  const preview = await writer.preview(request);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal((await writer.confirm({ ...request, token: preview.token })).ok, true);
  const repository = new OwnProfileRepository({
    principals: { getPrincipal: async () => ({ id: "person", pbuuids: [], email: "person@example.invalid" }) },
    source: { resolveLink: async () => ({ kind: "linked", candidateRef: "candidate" }), readCandidate: async () => SYNTHETIC_PROFILE_FIXTURES.populated },
    preferences: { readOwnPreferences: async () => ({ birthDate: { value: birthDate!, updatedAt: "2026-10-30T00:00:00.000Z" } }) } as never,
    today: () => "2026-10-30",
  });
  const result = await repository.readOwn({ requesterPrincipalId: "person", targetPersonId: "person" });
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  assert.equal(result.profile.fields.birthDate.state, "available");
  assert.equal(result.profile.fields.age.state, "unavailable");
  assert.equal(result.profile.fields.gender.state, "available");
});

test("SHU374_PHONE normalises Arabic digits and accepts canonical international phone values", () => {
  for (const value of ["+96550000000", "+442071838750", ""]) assert.equal(normalizePersonSelfEditValue("phone", value, TODAY), value);
  assert.equal(normalizePersonSelfEditValue("phone", "00442071838750", TODAY), "+442071838750");
  for (const value of ["50000000", "+965 5000 0000", "00965-50000000", "+965 (5000) 0000"]) assert.equal(normalizePersonSelfEditValue("phone", value, TODAY), "+96550000000");
  assert.equal(normalizePersonSelfEditValue("phone", "+٩٦٥ ٥٠٠٠ ٠٠٠٠", TODAY), "+96550000000");
  assert.equal(normalizePersonSelfEditValue("phone", "+۹۶۵ ۵۰۰۰ ۰۰۰۰", TODAY), "+96550000000");
  for (const value of ["+1234567", "+1234567890123456", "phone"]) assert.equal(normalizePersonSelfEditValue("phone", value, TODAY), null);
});

test("SHU374_HANDLE stores lowercase handles with the complete public alphabet", () => {
  for (const value of ["noor-al-sabah", "noor_2026", "noor.sabah", ""]) assert.equal(normalizePersonSelfEditValue("handle", value, TODAY), value);
  assert.equal(normalizePersonSelfEditValue("handle", "Noor.Sabah", TODAY), "noor.sabah");
  for (const value of ["no", "1noor", "noor al-sabah", "-noor"]) assert.equal(normalizePersonSelfEditValue("handle", value, TODAY), null);
});
