import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OwnProfileRepository, SHU372_RULES, normalizePersonSelfEditValue } from "../src/index.js";
import { SYNTHETIC_PROFILE_FIXTURES } from "../src/fixtures.js";

test("SHU392_RULES every shared rule example has the specified result", () => {
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
