import assert from "node:assert/strict";
import test from "node:test";

// Recruit legacy value maps, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC_LEGACY_MAPS_MODULE ?? new URL("../src/legacy-maps.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/legacy-maps.js");
const values = <R,>(f: (raw: R) => { readonly kind: string; readonly value: unknown }, raws: readonly R[]) => raws.map((r) => { const x = f(r); return x.kind === "mapped" ? x.value : `?${String(x.value)}`; });

test("REC_LEGACY_INVITE invitations and interviews: seen invitations stay seen; evaluated interviews are completed; unknown codes are reported", () => {
  assert.deepEqual(values((s: number) => m.legacyInvitationStatus(s, false), [1, 2, 3, 4]), ["sent", "declined", "accepted", "?4"]);
  assert.deepEqual(m.legacyInvitationStatus(1, true), { kind: "mapped", value: "seen" });
  assert.deepEqual(m.legacyInvitationStatus(3, true), { kind: "mapped", value: "accepted" }, "an answer outranks seen");
  assert.deepEqual(values((s: number) => m.legacyInterviewStatus(s, false), [0, 1, 2, 3, 9]), ["scheduled", "scheduled", "cancelled", "cancelled", "?9"]);
  assert.deepEqual(values((s: number) => m.legacyInterviewStatus(s, true), [0, 1, 2, 3]), ["completed", "completed", "cancelled", "cancelled"]);
  assert.deepEqual(values(m.legacyRequestApplicationStatus, [0, 1, 2, 3, -1]), ["applied", "accepted", "accepted", "rejected", "?-1"]);
});

test("REC_LEGACY_JOBS jobs, interests and full-timers map every documented code and report the rest", () => {
  assert.deepEqual(values(m.legacyJobStatus, [10, 0, 1, 2, 3]), ["draft", "draft", "active", "closed", "?3"]);
  assert.deepEqual(values(m.legacyJobGender, [1, 2, 3, 4, 0]), ["male", "female", "other", "any", "?0"]);
  assert.deepEqual(values(m.legacyJobCompensationType, ["FIXED_PRICE", "HOURLY", "MONTHLY_SALARY", "DAILY"]), ["Fixed price", "Hourly", "Monthly salary", "?DAILY"]);
  assert.deepEqual(values(m.legacyJobInterestStatus, ["INTERESTED", "SHORTLISTED", "REJECTED", "interested"]), ["interested", "shortlisted", "rejected", "?interested"]);
  assert.deepEqual(values(m.legacyFulltimerGender, [1, 2, 3, null, 4]), ["male", "female", "other", null, "?4"]);
  assert.deepEqual(values(m.legacyYesNo, [1, 2, null, 0]), [true, false, null, "?0"]);
  assert.deepEqual(m.legacyJobStatus(7), { kind: "unmapped", value: 7 });
});
