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

test("Q14_4_RULES every live requirement has a positive and negative case", () => {
  const liveCases = [
    ["personal_photo", "personal-photo"], ["civil_front", "civil-id-front"], ["civil_back", "civil-id-back"],
  ] as const;
  for (const [requirement, type] of liveCases) {
    const result = deriveProfileCompleteness(base(), {...evidence, documents:evidence.documents.filter(row=>row.type!==type)});
    assert.equal(result.fields.pendingFields.state === "available" && result.fields.pendingFields.value.includes(requirement), true, requirement);
  }
  for (const [requirement, patch] of [
    ["email", {emailPresent:false}], ["education", {educationPresent:false}], ["skill", {skillPresent:false}],
  ] as const) {
    const result=deriveProfileCompleteness(base(),{...evidence,...patch});
    assert.equal(result.fields.pendingFields.state === "available" && result.fields.pendingFields.value.includes(requirement),true,requirement);
  }
  const no = deriveProfileCompleteness(base(), {...evidence,nationalityCode:"JO"});
  assert.equal(no.fields.pendingFields.state === "available" && no.fields.pendingFields.value.includes("kuwaiti_mother"),false,"stored No is answered");
  const licence=base();
  const driving={state:"available" as const,value:false,provenance:licence.fields.pendingFields.provenance,freshness:{kind:"written_by_person" as const,observedAt:"2026-09-13T12:00:00.000Z"}};
  const noLicence=deriveProfileCompleteness({...licence,fields:{...licence.fields,drivingLicence:driving}},evidence);
  assert.equal(noLicence.fields.pendingFields.state === "available" && noLicence.fields.pendingFields.value.includes("driving_licence"),false,"driving licence No is answered");
  const kw = deriveProfileCompleteness(base(),evidence);
  assert.equal(kw.fields.pendingFields.state === "available" && kw.fields.pendingFields.value.includes("kuwaiti_mother"),false,"KW does not require mother answer");
});

test("Q14_4_RULES blank nationality is missing while an unknown nationality fails closed", () => {
  const blank=base();
  const unavailable={...blank.fields.nationality,state:"unavailable" as const,reason:"not_recorded" as const};
  const missing=deriveProfileCompleteness({...blank,fields:{...blank.fields,nationality:unavailable}}, {...evidence,nationalityCode:undefined});
  assert.equal(missing.fields.pendingFields.state === "available" && missing.fields.pendingFields.value.includes("nationality"),true);
  assert.equal(missing.fields.pendingFields.state === "available" && missing.fields.pendingFields.value.includes("kuwaiti_mother"),false);
  const unknown=deriveProfileCompleteness(base(),{...evidence,nationalityCode:undefined});
  assert.equal(unknown.fields.pendingFields.state,"unavailable");
});

test("Q14_4_RULES every projected text or answer field has positive, empty, and whitespace cases", () => {
  const cases = [
    ["display_name","displayName"],["arabic_name","arabicName"],["gender","gender"],["objective","objective"],
    ["birth_date","birthDate"],["location","area"],["nationality","nationality"],
  ] as const;
  for (const [requirement,key] of cases) {
    const original=base(), field=original.fields[key];
    const positive=deriveProfileCompleteness(original,evidence).fields.pendingFields;
    assert.equal(positive.state === "available" && positive.value.includes(requirement),false,`${requirement} positive`);
    for(const value of ["","   "]){const changed={...field,state:"available" as const,value,editValue:value};const result=deriveProfileCompleteness({...original,fields:{...original.fields,[key]:changed}},evidence);assert.equal(result.fields.pendingFields.state==="available"&&result.fields.pendingFields.value.includes(requirement),true,`${requirement} ${JSON.stringify(value)}`)}
  }
});

test("Q14_4_RULES written projected values win over different imported pending values",()=>{
  const profile=base(), imported={...profile.fields.pendingFields,value:["objective","display_name"] as const,freshness:{kind:"imported_snapshot" as const,observedAt:"2026-01-01"}};
  const result=deriveProfileCompleteness({...profile,fields:{...profile.fields,pendingFields:imported}},evidence);
  assert.equal(result.fields.pendingFields.state==="available"&&result.fields.pendingFields.value.includes("objective"),false);
  assert.equal(result.fields.pendingFields.state==="available"&&result.fields.pendingFields.value.includes("display_name"),false);
});

test("Q14_4_RULES no snapshot leaves imported-only requirements missing",()=>{
  const profile=base(), absent={...profile.fields.pendingFields,state:"unavailable" as const,reason:"not_imported" as const,freshness:{kind:"not_imported" as const,observedAt:"" as const}};
  const result=deriveProfileCompleteness({...profile,fields:{...profile.fields,pendingFields:absent,phone:undefined,civilId:undefined,kuwaitiMother:undefined}},{...evidence,nationalityCode:"JO"});
  assert.deepEqual(result.fields.pendingFields.state==="available"&&result.fields.pendingFields.value.filter(x=>["phone","civil_id","civil_expiry","kuwaiti_mother"].includes(x)),["phone","civil_id","civil_expiry","kuwaiti_mother"]);
});

test("Q14_4_RULES imported pending list is fallback only for unprojected values", () => {
  const profile=base();
  const imported={...profile.fields.pendingFields,value:["phone","civil_id","civil_expiry","kuwaiti_mother","personal_photo"] as const,
    freshness:{kind:"imported_snapshot" as const,observedAt:"2026-01-01"}};
  const fields={...profile.fields,pendingFields:imported,phone:undefined,civilId:undefined,kuwaitiMother:undefined};
  const result=deriveProfileCompleteness({...profile,fields},{...evidence,nationalityCode:"JO"});
  assert.deepEqual(result.fields.pendingFields.state === "available" && result.fields.pendingFields.value.filter(x=>["phone","civil_id","civil_expiry","kuwaiti_mother"].includes(x)),["phone","civil_id","civil_expiry","kuwaiti_mother"]);
  assert.equal(result.fields.pendingFields.state === "available" && result.fields.pendingFields.value.includes("personal_photo"),false,"documents, not import, decide photos");
});

test("Q14_4_DERIVED unavailable evidence fails closed and derived values agree", () => {
  const failed=deriveProfileCompleteness(base(),{...evidence,sourcesAvailable:false});
  assert.equal(failed.fields.pendingFields.state,"unavailable"); assert.equal(failed.fields.isProfileCompleted.state,"unavailable");
  const complete=deriveProfileCompleteness(base(),evidence);
  assert.equal(complete.fields.isProfileCompleted.state === "available" && complete.fields.isProfileCompleted.value,true);
  assert.equal(complete.fields.pendingFields.freshness.kind,"derived");
});
