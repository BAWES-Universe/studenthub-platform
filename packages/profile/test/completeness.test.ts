import assert from "node:assert/strict";
import test from "node:test";
import { projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES, type OwnProfileProjection } from "../src/index.js";
import type { deriveProfileCompleteness as Derive } from "../src/completeness.js";
const completeness=await import(process.env.SHU570_COMPLETENESS_MODULE??"../src/completeness.js");
const deriveProfileCompleteness:typeof Derive=completeness.deriveProfileCompleteness;
const unavailableProfileCompleteness=completeness.unavailableProfileCompleteness;

const projection = (): OwnProfileProjection => {
  const profile = projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated, "2026-11-10");
  return { ...profile, fields: { ...profile.fields,
    nationality: { ...profile.fields.nationality, editValue: "kw" } as typeof profile.fields.nationality,
    phone: { state:"available", value:"+96555551234", provenance:profile.fields.nationality.provenance, freshness:{kind:"written_by_person",observedAt:"2026-11-10T00:00:00.000Z"} },
  } };
};
const value = <T>(base: OwnProfileProjection, v: T) => ({ state:"available" as const, value:v,
  provenance:base.fields.nationality.provenance, freshness:{kind:"written_by_person" as const,observedAt:"2026-11-10T00:00:00.000Z"} });
const evidence = (extra: Partial<Parameters<typeof deriveProfileCompleteness>[1]> = {}) => ({
  emailPresent:true, documents:[{type:"personal-photo"},{type:"civil-id-front"},{type:"civil-id-back"}], hasEducation:true, hasSkill:true,
  countries:[{id:"kw",code:"KW",name:"Kuwaiti"}], observedAt:"2026-11-10T00:00:00.000Z", ...extra,
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

test("Q14_4_RULES KW never requires the mother answer",()=>{
  const base=projection(),pending={...base.fields.pendingFields,state:"unavailable" as const,reason:"not_recorded" as const};
  const result=deriveProfileCompleteness({...base,fields:{...base.fields,pendingFields:pending}},evidence());
  assert.deepEqual(result.fields.pendingFields.state==="available"?result.fields.pendingFields.value:[],["civil_id","civil_expiry"]);
});

test("Q14_4_DERIVED failures can never report complete",()=>{
  const failed=unavailableProfileCompleteness(projection());
  assert.equal(failed.fields.isProfileCompleted.state,"unavailable");
  assert.equal(failed.fields.pendingFields.state,"unavailable");
  assert.equal(failed.fields.isProfileCompleted.state==="unavailable"&&failed.fields.isProfileCompleted.reason,"check_failed");
});

test("Q14_4_RULES a real imported nationality is resolved through the catalogue code",()=>{
  const imported=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-11-10");
  assert.equal(imported.fields.nationality.state,"available");
  assert.equal(imported.fields.nationality.state==="available"&&imported.fields.nationality.editValue,undefined);
  const result=deriveProfileCompleteness(imported,evidence());
  assert.deepEqual(result.fields.pendingFields.state==="available"?result.fields.pendingFields.value:[],[]);
  assert.throws(()=>deriveProfileCompleteness(imported,evidence({countries:[{id:"x",code:"KW",name:"Unknown"}]})),/nationality choice unavailable/);
});

test("Q14_4_RULES imported pending fallback is limited to imported-only live values",()=>{
  const imported=projectApprovedProfile({...SYNTHETIC_PROFILE_FIXTURES.populated,is_incomplete_profile:1,
    candidate_pending_profile:"phone,civil id,civil expiry date"},"2026-11-10");
  const missing=deriveProfileCompleteness(imported,evidence());
  assert.deepEqual(missing.fields.pendingFields.state==="available"?missing.fields.pendingFields.value:[],["phone","civil_id","civil_expiry"]);
  const fields={...imported.fields,phone:value(imported,"+96555551234"),civilId:value(imported,{country:"KW" as const,maskedNumber:"•••• 1234",expiry:"2028-01-01",needsReview:false})};
  const live=deriveProfileCompleteness({...imported,fields},evidence());
  assert.deepEqual(live.fields.pendingFields.state==="available"?live.fields.pendingFields.value:[],[]);
});

test("Q14_4_RULES documents never inherit presence and written blanks stay missing",()=>{
  const base=projection();
  const fields={...base.fields,displayName:value(base,"   ")};
  const result=deriveProfileCompleteness({...base,fields},evidence({documents:[]}));
  assert.deepEqual(result.fields.pendingFields.state==="available"?result.fields.pendingFields.value:[],["display_name","personal_photo","civil_front","civil_back"]);
});

test("Q14_4_RULES no snapshot has no imported-only values and non-KW No is answered",()=>{
  const base=projection();
  const unavailable={...base.fields.pendingFields,state:"unavailable" as const,reason:"not_recorded" as const};
  const fields={...base.fields,pendingFields:unavailable,phone:undefined,civilId:undefined,
    kuwaitiMother:value(base,false),drivingLicence:value(base,false)} as unknown as OwnProfileProjection["fields"];
  const result=deriveProfileCompleteness({...base,fields},evidence({countries:[{id:"kw",code:"JO",name:"Jordanian"}]}));
  assert.deepEqual(result.fields.pendingFields.state==="available"?result.fields.pendingFields.value:[],["phone","civil_id","civil_expiry"]);
});
