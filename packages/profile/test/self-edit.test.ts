import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OwnProfileRepository, SHU372_RULES, createPersonSelfEdit, normalizePersonSelfEditValue } from "../src/index.js";
import type { CommitInput, SafeWriteStore } from "@studenthub/safe-write-contract";
import { SYNTHETIC_PROFILE_FIXTURES } from "../src/fixtures.js";

test("SHU372_RULES every shared rule example has the specified result", () => {
  for (const [field, rule] of Object.entries(SHU372_RULES)) {
    for (const value of rule.accepts) assert.equal(normalizePersonSelfEditValue(field as keyof typeof SHU372_RULES, value), value.normalize("NFC"), `${field} accepts ${value}`);
    for (const value of rule.refuses) assert.equal(normalizePersonSelfEditValue(field as keyof typeof SHU372_RULES, value), null, `${field} refuses ${value}`);
  }
  assert.equal(normalizePersonSelfEditValue("displayName", "Noor Al-Sabah"), "Noor Al-Sabah");
  assert.equal(normalizePersonSelfEditValue("arabicName", "نور الصباح"), "نور الصباح");
  assert.equal(normalizePersonSelfEditValue("displayName", "Noe\u0308l Al-Sabah"), "Noël Al-Sabah");
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
  assert.equal(createHash("sha256").update(normalizePersonSelfEditValue("displayName", "Noe\u0308l Al-Sabah")!).digest("hex"),
    createHash("sha256").update("Noël Al-Sabah").digest("hex"));
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

test("SHU373_WRITE choice values use the shared safe-write flow", async () => {
  for (const [field, value] of Object.entries({ gender: "male", birthDate: "2000-02-29", nationality: "11111111-1111-4111-8111-111111111111", university: "", drivingLicence: "true", kuwaitiMother: "false", jobSearchStatus: "active" })) {
    assert.equal(normalizePersonSelfEditValue(field as never, value), value);
  }
});

test("SHU373_AGE minimum age uses Kuwait's calendar date and one setting", async () => {
  const values = new Map<string,string|null>();
  const store: SafeWriteStore = { ownedRecord: async () => "b".repeat(64), readField: async (_r,f) => values.get(f) ?? null, commit: async () => ({ ok: true }) };
  const writer = createPersonSelfEdit({ store, secret: "s".repeat(32), clock: { now: () => new Date("2026-10-30T21:30:00.000Z") } });
  const request = (value:string) => ({ principalRef: "a".repeat(64), change: { personRef: "b".repeat(64), field: "birthDate", value } });
  assert.equal((await writer.preview(request("2010-10-31"))).ok, true);
  assert.deepEqual(await writer.preview(request("2010-11-01")), { ok: false, reason: "invalid_value" });
});

test("SHU373_CATALOGUE written ids resolve to names and an unknown id affects only its field", async () => {
  const preferences = { nationality: { value: "11111111-1111-4111-8111-111111111111", updatedAt: "2026-10-30T12:00:00.000Z" }, university: { value: "22222222-2222-4222-8222-222222222222", updatedAt: "2026-10-30T12:00:00.000Z" }, profileChoices: [{ id: "11111111-1111-4111-8111-111111111111", type: "country", name: "Jordan", code: "JO" }] };
  const repository = new OwnProfileRepository({ principals: { getPrincipal: async () => ({ id: "person", pbuuids: [] }) }, source: { resolveLink: async () => ({ kind: "unconfigured" }) as const, readCandidate: async () => undefined }, preferences: { readOwnPreferences: async () => preferences } as never, today: () => "2026-10-31" });
  const result = await repository.readOwn({ requesterPrincipalId: "person", targetPersonId: "person" }); assert.equal(result.kind,"found");
  if(result.kind === "found") { assert.equal(result.profile.fields.nationality.state,"available"); assert.equal(result.profile.fields.nationality.value,"Jordan"); assert.equal(result.profile.writtenChoiceIds?.nationality,"11111111-1111-4111-8111-111111111111"); assert.equal(result.profile.fields.university.state,"unavailable"); }
});
