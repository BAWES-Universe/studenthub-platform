import assert from "node:assert/strict";
import test from "node:test";
import { deriveProfileCompleteness, projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES, type OwnProfileProjection } from "../src/index.js";

const base = (): OwnProfileProjection => {
  const projected = projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated, "2026-09-13");
  const available = <T>(value:T) => ({state:"available" as const,value,provenance:projected.fields.phone?.provenance ?? projected.fields.pendingFields.provenance,freshness:{kind:"written_by_person" as const,observedAt:"2026-09-13T12:00:00.000Z"}});
  return { ...projected, fields: { ...projected.fields,
    nationality:{...available("Kuwaiti"),editValue:"kw"}, phone:available("+96512345678"), kuwaitiMother:available(false),
    civilId:available({country:"KW" as const,maskedNumber:"••••1234",expiry:"2030-01-01",needsReview:false}) } };
};
const evidence = {emailPresent:true,documents:[{type:"personal-photo"},{type:"civil-id-front"},{type:"civil-id-back"}],educationPresent:true,skillPresent:true,nationalityCode:"KW",sourcesAvailable:true};

test("Q14_4_RULES requirements follow the closed legacy list and No is answered", () => {
  const result=deriveProfileCompleteness(base(),evidence);
  assert.deepEqual(result.fields.pendingFields.state === "available" && result.fields.pendingFields.value, []);
  assert.equal(JSON.stringify(result).includes("identity_reference"),false);
  const removed=deriveProfileCompleteness(base(),{...evidence,documents:evidence.documents.filter(d=>d.type!=="personal-photo")});
  assert.deepEqual(removed.fields.pendingFields.state === "available" && removed.fields.pendingFields.value,["personal_photo"]);
});

test("Q14_4_DERIVED unavailable evidence fails closed and derived values agree", () => {
  const failed=deriveProfileCompleteness(base(),{...evidence,sourcesAvailable:false});
  assert.equal(failed.fields.pendingFields.state,"unavailable"); assert.equal(failed.fields.isProfileCompleted.state,"unavailable");
  const complete=deriveProfileCompleteness(base(),evidence);
  assert.equal(complete.fields.isProfileCompleted.state === "available" && complete.fields.isProfileCompleted.value,true);
  assert.equal(complete.fields.pendingFields.freshness.kind,"derived");
});
