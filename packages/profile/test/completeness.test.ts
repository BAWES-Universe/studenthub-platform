import assert from "node:assert/strict";
import test from "node:test";
import { deriveProfileCompleteness, unavailableProfileCompleteness, projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES, type OwnProfileProjection } from "../src/index.js";

const projection = (): OwnProfileProjection => {
  const profile = projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated, "2026-11-10");
  return { ...profile, fields: { ...profile.fields,
    nationality: { ...profile.fields.nationality, editValue: "kw" } as typeof profile.fields.nationality,
    phone: { state:"available", value:"+96555551234", provenance:profile.fields.nationality.provenance, freshness:{kind:"written_by_person",observedAt:"2026-11-10T00:00:00.000Z"} },
  } };
};
const evidence = (extra: Partial<Parameters<typeof deriveProfileCompleteness>[1]> = {}) => ({
  emailPresent:true, documents:[{type:"personal-photo"},{type:"civil-id-front"},{type:"civil-id-back"}], hasEducation:true, hasSkill:true,
  civilIdRecorded:true, civilExpiryRecorded:true, countries:[{id:"kw",code:"KW"}], observedAt:"2026-11-10T00:00:00.000Z", ...extra,
});

test("Q14_4_RULES requirements use live answers, documents and active records in fixed order",()=>{
  const complete=deriveProfileCompleteness(projection(),evidence());
  assert.equal(complete.fields.isProfileCompleted.state,"available");
  assert.equal(complete.fields.isProfileCompleted.state==="available"&&complete.fields.isProfileCompleted.value,true);
  const missing=deriveProfileCompleteness(projection(),evidence({documents:[{type:"civil-id-front"},{type:"civil-id-back"}],hasSkill:false}));
  assert.deepEqual(missing.fields.pendingFields.state==="available"?missing.fields.pendingFields.value:[],["personal_photo","skill"]);
  assert.ok(!String(missing.fields.pendingFields.state==="available"&&missing.fields.pendingFields.value).includes("identity_reference"));
});

test("Q14_4_RULES false answers count as answered and non-KW requires a mother answer",()=>{
  const base=projection();
  const fields={...base.fields,drivingLicence:{...base.fields.drivingLicence,state:"available" as const,value:false},kuwaitiMother:{state:"available" as const,value:false,provenance:base.fields.nationality.provenance,freshness:{kind:"written_by_person" as const,observedAt:"2026-11-10T00:00:00.000Z"}}};
  const result=deriveProfileCompleteness({...base,fields:fields as never},evidence({countries:[{id:"kw",code:"JO"}]}));
  assert.deepEqual(result.fields.pendingFields.state==="available"?result.fields.pendingFields.value:[],[]);
});

test("Q14_4_DERIVED failures can never report complete",()=>{
  const failed=unavailableProfileCompleteness(projection());
  assert.equal(failed.fields.isProfileCompleted.state,"unavailable");
  assert.equal(failed.fields.pendingFields.state,"unavailable");
  assert.equal(failed.fields.isProfileCompleted.state==="unavailable"&&failed.fields.isProfileCompleted.reason,"check_failed");
});
