import assert from "node:assert/strict";
import test from "node:test";
import * as builtIn from "../src/people-directory.js";
import { deriveProfileCompleteness, projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES } from "../src/index.js";

const implementation=process.env.SHU618_TEST_MODULE?await import(process.env.SHU618_TEST_MODULE) as typeof builtIn:builtIn;
const {classifySearchTerm,civilStateOf,maskPhone,PEOPLE_DETAILS_KEYS,PEOPLE_DOCUMENT_KEYS}=implementation;

test("DIRDB_SEARCH classifier recognizes identifiers and makes safe name tokens",()=>{
  assert.equal(classifySearchTerm("c00123").employeeId,"123");
  for(const value of ["+965 5000 0000","50000000","٥٠٠٠٠٠٠٠","00965-5000-0000"])assert.equal(classifySearchTerm(value).phone,"+96550000000","full phone normalization");
  assert.equal(classifySearchTerm("0000").phoneSuffix,"0000");
  assert.equal(classifySearchTerm("123").phoneSuffix,null,"short digit term must not become a phone suffix");
  assert.equal(classifySearchTerm("https://studenthub.test/people/Noor_26").handle,"noor_26");
  assert.deepEqual(classifySearchTerm(`Noor & | ! : * ( ) ' " < > نور`).nameTokens,["noor","نور"],"name tokens must contain letters and digits only");
});

test("DIRDB_FILTERS civil state precedence and today's expiry",()=>{
  assert.equal(civilStateOf({},"2026-11-13"),"none");
  assert.equal(civilStateOf({numberPresent:true,needsReview:true,newestDecision:"rejected",expiry:"2020-01-01"},"2026-11-13"),"waiting","waiting must precede review and expiry");
  assert.equal(civilStateOf({numberPresent:true,newestDecision:"rejected",expiry:"2020-01-01"},"2026-11-13"),"rejected");
  assert.equal(civilStateOf({numberPresent:true,newestDecision:"confirmed",expiry:"2020-01-01"},"2026-11-13"),"expired");
  assert.equal(civilStateOf({numberPresent:true,newestDecision:"confirmed",expiry:"2026-11-13"},"2026-11-13"),"checked","today must not be expired");
  assert.equal(civilStateOf({numberPresent:true},"2026-11-13"),"recorded");
  assert.equal(civilStateOf({released:true,numberPresent:true},"2026-11-13"),"none");
});

test("DIRDB_DETAILS SQL coverage is exactly CMP minus document requirements",()=>{
  const allMissing=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.unavailable,"2026-11-13");
  const result=deriveProfileCompleteness({profile:{state:"available",value:allMissing},principalEmailPresent:{state:"available",value:false},activeBackground:{state:"available",value:{educationCount:0,skillCount:0}},documentTypesOnFile:{state:"available",value:[]},civilIdRecorded:{state:"available",value:{number:false,expiry:false}},writtenNationalityCode:{state:"available",value:null}});
  assert.equal(result.kind,"available");
  const importedMother=projectApprovedProfile({...SYNTHETIC_PROFILE_FIXTURES.populated,is_incomplete_profile:1,candidate_pending_profile:"candidate_mom_kuwaiti"},"2026-11-13");
  const mother=deriveProfileCompleteness({profile:{state:"available",value:importedMother},principalEmailPresent:{state:"available",value:true},activeBackground:{state:"available",value:{educationCount:1,skillCount:1}},documentTypesOnFile:{state:"available",value:["personal-photo","civil-id-front","civil-id-back"]},civilIdRecorded:{state:"available",value:{number:true,expiry:true}},writtenNationalityCode:{state:"available",value:"KW"}});
  // An entirely missing projection cannot express the conditional Kuwaiti-mother answer, so add the
  // dedicated imported pending fixture before comparing CMP's closed set with directory coverage.
  assert.deepEqual(new Set([...(result.kind==="available"?result.pendingFields:[]),...(mother.kind==="available"?mother.pendingFields:[])]),new Set([...PEOPLE_DETAILS_KEYS,...PEOPLE_DOCUMENT_KEYS]),"directory and document keys must equal CMP's closed list");
});

test("DIRDB_DETAILS every SQL-covered key has matching CMP met and unmet fixtures",()=>{
  const legacyNames:Record<string,string>={phone:"phone",civil_id:"civil id",civil_expiry:"civil expiry date",kuwaiti_mother:"candidate_mom_kuwaiti"};
  const rawColumns:Record<string,string>={nationality:"nationality_name",display_name:"candidate_name",arabic_name:"candidate_name_ar",gender:"candidate_gender",objective:"candidate_objective",birth_date:"candidate_birth_date",driving_licence:"candidate_driving_license",location:"area_name"};
  const evaluate=(key:string,missing:boolean)=>{
    const raw:Record<string,unknown>={...SYNTHETIC_PROFILE_FIXTURES.populated};
    if(missing&&rawColumns[key])raw[rawColumns[key]]=null;
    if(missing&&legacyNames[key]){raw.is_incomplete_profile=1;raw.candidate_pending_profile=legacyNames[key];}
    const profile=projectApprovedProfile(raw,"2026-11-13");
    const input:Parameters<typeof deriveProfileCompleteness>[0]={
      profile:{state:"available",value:profile},principalEmailPresent:{state:"available",value:!(missing&&key==="email")},
      activeBackground:{state:"available",value:{educationCount:missing&&key==="education"?0:1,skillCount:missing&&key==="skill"?0:1}},
      documentTypesOnFile:{state:"available",value:["personal-photo","civil-id-front","civil-id-back"]},
      civilIdRecorded:{state:"available",value:{number:!(missing&&key==="civil_id"),expiry:!(missing&&key==="civil_expiry")}},
      writtenNationalityCode:{state:"available",value:"KW"},
    };
    const completeness=deriveProfileCompleteness(input);assert.equal(completeness.kind,"available",`${key} fixture is evaluable`);
    return completeness.kind==="available"&&completeness.pendingFields.includes(key as never);
  };
  for(const key of PEOPLE_DETAILS_KEYS){assert.equal(evaluate(key,false),false,`${key} CMP met fixture agrees with SQL`);assert.equal(evaluate(key,true),true,`${key} CMP unmet fixture agrees with SQL`);}
});

test("DIRDB_SHOWN phone masking never reveals more than the final four digits",()=>{
  assert.equal(maskPhone("0000"),"•••• 0000","phone must remain masked");
});
