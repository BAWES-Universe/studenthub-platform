import assert from "node:assert/strict";import test from "node:test";import * as builtIn from "../src/people-directory.js";
import {deriveProfileCompleteness} from "../src/completeness.js";import {projectApprovedProfile,SYNTHETIC_PROFILE_FIXTURES} from "../src/index.js";
const implementation=process.env.SHU633_TEST_MODULE?await import(process.env.SHU633_TEST_MODULE) as typeof builtIn:builtIn;
const {classifySearchTerm,civilStateOf,maskPhone,PEOPLE_DETAILS_KEYS,PEOPLE_DOCUMENT_KEYS}=implementation;
test("DIRDB_SEARCH classifier safely separates every SQL search class",()=>{
 assert.equal(classifySearchTerm("C00123").employeeId,"123","employee ids normalize");
 assert.equal(classifySearchTerm("00965-5000-0000").phone,"+96550000000","full phones normalize");
 assert.equal(classifySearchTerm("٥٠٠٠٠٠٠٠").phone,"+96550000000","Arabic phones normalize");
 assert.equal(classifySearchTerm("0000").phoneSuffix,"0000","four digits are a suffix");
 assert.equal(classifySearchTerm("123").phoneSuffix,null,"short digits are not a suffix");
 assert.equal(classifySearchTerm("@Noor.One").handle,"noor.one","handles lowercase");
 assert.deepEqual(classifySearchTerm("Noor & نور | x7").nameTokens,["noor","نور","x7"],"name tokens contain letters and digits only");
 assert.deepEqual(classifySearchTerm(" & | ! : * ( ) ' \" < > ").nameTokens,[],"operators produce no query tokens");
});
test("DIRDB_FILTERS civil state precedence and current expiry are exact",()=>{
 const base={released:false,number:true,expiry:"2025-12-31",needsReview:false,decision:null as "confirmed"|"rejected"|null};
 assert.equal(civilStateOf({...base,released:true},"2026-01-01"),"none","released is none");
 assert.equal(civilStateOf({...base,needsReview:true,decision:"rejected"},"2026-01-01"),"waiting","waiting precedes decisions");
 assert.equal(civilStateOf({...base,decision:"rejected"},"2026-01-01"),"rejected","rejected precedes expiry");
 assert.equal(civilStateOf(base,"2026-01-01"),"expired","past expiry is expired");
 assert.equal(civilStateOf({...base,expiry:"2026-01-01",decision:"confirmed"},"2026-01-01"),"checked","today is not expired");
 assert.equal(civilStateOf({...base,expiry:null},"2026-01-01"),"recorded","otherwise recorded");
});
test("DIRDB_DETAILS directory and document keys form CMP closed list",()=>{
 // CMP conditionally asks for kuwaiti_mother, so its closed list requires the union of Kuwaiti and non-Kuwaiti inputs.
 const empty=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.unavailable,"2026-01-01"),seed=empty.fields.displayName;
 const profile={...empty,fields:{...empty.fields,nationality:{state:"available" as const,value:"Written country",editValue:"country",provenance:seed.provenance,freshness:{kind:"written_by_person" as const,observedAt:"2026-01-01T00:00:00.000Z"}}}};
 const common={profile:{state:"available" as const,value:profile},principalEmailPresent:{state:"available" as const,value:false},activeBackground:{state:"available" as const,value:{educationCount:0,skillCount:0}},documentTypesOnFile:{state:"available" as const,value:[]},civilIdRecorded:{state:"available" as const,value:{number:false,expiry:false}}};
 const kw=deriveProfileCompleteness({...common,profile:{state:"available",value:empty},writtenNationalityCode:{state:"available",value:"KW"}}),nonKw=deriveProfileCompleteness({...common,writtenNationalityCode:{state:"available",value:"JO"}});
 assert.equal(kw.kind,"available");assert.equal(nonKw.kind,"available");
 const reported=new Set([...(kw.kind==="available"?kw.pendingFields:[]),...(nonKw.kind==="available"?nonKw.pendingFields:[])]);
 assert.deepEqual(new Set([...PEOPLE_DETAILS_KEYS,...PEOPLE_DOCUMENT_KEYS]),reported,"details keys must retain the CMP closed list");
 for(const key of PEOPLE_DETAILS_KEYS)assert.ok(reported.has(key),`${key} CMP unmet fixture agrees with SQL key`);
 const met=deriveProfileCompleteness({profile:{state:"available",value:projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-01-01")},principalEmailPresent:{state:"available",value:true},activeBackground:{state:"available",value:{educationCount:1,skillCount:1}},documentTypesOnFile:{state:"available",value:["personal-photo","civil-id-front","civil-id-back"]},civilIdRecorded:{state:"available",value:{number:true,expiry:true}},writtenNationalityCode:{state:"available",value:"KW"}});
 assert.deepEqual(met,{kind:"available",pendingFields:[]},"CMP met fixture agrees with every SQL key");
 assert.equal(PEOPLE_DETAILS_KEYS.length,15,"all fifteen SQL details remain covered");
});
test("DIRDB_SHOWN phone masking never reveals more than last four",()=>assert.equal(maskPhone("0000"),"•••• 0000","phone must stay masked"));
