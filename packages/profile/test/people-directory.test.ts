import assert from "node:assert/strict";
import test from "node:test";
import * as builtIn from "../src/people-directory.js";
import { deriveProfileCompleteness, projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES } from "../src/index.js";

const implementation = process.env.SHU624_TEST_MODULE ? await import(process.env.SHU624_TEST_MODULE) as typeof builtIn : builtIn;
const { classifySearchTerm, civilStateOf, maskPhone, PEOPLE_DETAILS_KEYS, PEOPLE_DOCUMENT_KEYS } = implementation;

test("DIRDB_SEARCH classifier normalises safe applicable search classes", () => {
  assert.equal(classifySearchTerm("c00123").employeeId, "123", "employee ids must discard display padding");
  for (const value of ["+965 5000 0000", "50000000", "٥٠٠٠٠٠٠٠", "00965-5000-0000"]) assert.equal(classifySearchTerm(value).fullPhone, "+96550000000", "full phones must use self-edit normalisation");
  assert.equal(classifySearchTerm("1234").phoneSuffix, "1234", "four digits must be a phone suffix");
  assert.equal(classifySearchTerm("123").phoneSuffix, null, "short digit terms must not be phone suffixes");
  assert.equal(classifySearchTerm("@Noor.Sabah").handle, "noor.sabah", "profile handles must be lower-cased");
  assert.deepEqual(classifySearchTerm(" Noor & نور!* ").nameTokens, ["noor", "نور"], "name tokens must contain letters and digits only");
});

test("DIRDB_FILTERS civil state follows the documented precedence", () => {
  const today="2026-11-13";
  assert.equal(civilStateOf({number:true,expiry:"2020-01-01",needsReview:true,decision:"rejected"},today),"waiting","waiting must precede rejected and expired");
  assert.equal(civilStateOf({number:true,expiry:"2020-01-01",decision:"rejected"},today),"rejected","rejected must precede expired");
  assert.equal(civilStateOf({number:true,expiry:"2020-01-01",decision:"confirmed"},today),"expired","expired must precede checked");
  assert.equal(civilStateOf({number:true,expiry:today,decision:"confirmed"},today),"checked","today must not count as expired");
  assert.equal(civilStateOf({number:true,expiry:"2027-01-01"},today),"recorded");
  assert.equal(civilStateOf({released:true,number:true,expiry:"2020-01-01"},today),"none");
  assert.equal(civilStateOf({},today),"none");
});

test("DIRDB_DETAILS directory and document keys exactly partition CMP requirements", () => {
  const profile=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.unavailable,"2026-11-13");
  const result=deriveProfileCompleteness({profile:{state:"available",value:profile},principalEmailPresent:{state:"available",value:false},activeBackground:{state:"available",value:{educationCount:0,skillCount:0}},documentTypesOnFile:{state:"available",value:[]},civilIdRecorded:{state:"available",value:{number:false,expiry:false}},writtenNationalityCode:{state:"available",value:null}});
  assert.equal(result.kind,"available");
  const populated=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-11-13");const nationality=populated.fields.nationality;const nonKuwaiti={...populated,fields:{...populated.fields,nationality:{...nationality,value:"Jordanian",freshness:{kind:"written_by_person" as const,observedAt:"2026-11-13T00:00:00.000Z"}},kuwaitiMother:{state:"unavailable" as const,reason:"not_recorded" as const,provenance:populated.fields.displayName.provenance,freshness:{kind:"written_by_person" as const,observedAt:"2026-11-13T00:00:00.000Z"}}}};const conditional=deriveProfileCompleteness({profile:{state:"available",value:nonKuwaiti},principalEmailPresent:{state:"available",value:true},activeBackground:{state:"available",value:{educationCount:1,skillCount:1}},documentTypesOnFile:{state:"available",value:["personal-photo","civil-id-front","civil-id-back"]},civilIdRecorded:{state:"available",value:{number:true,expiry:true}},writtenNationalityCode:{state:"available",value:"JO"}});
  assert.equal(conditional.kind,"available");
  const reported=new Set([...(result.kind==="available"?result.pendingFields:[]),...(conditional.kind==="available"?conditional.pendingFields:[])]);
  assert.deepEqual(reported,new Set([...PEOPLE_DETAILS_KEYS,...PEOPLE_DOCUMENT_KEYS]),"directory plus document keys must equal CMP's closed list");
  assert.equal(PEOPLE_DETAILS_KEYS.length,15,"all fifteen SQL-covered requirements must remain");
});

test("DIRDB_SHOWN phone masking never reveals more than the final four digits",()=>assert.equal(maskPhone("0000"),"•••• 0000","phone must remain masked"));
