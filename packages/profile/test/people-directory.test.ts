import assert from "node:assert/strict";import test from "node:test";import * as builtIn from "../src/people-directory.js";
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
 assert.deepEqual(new Set([...PEOPLE_DETAILS_KEYS,...PEOPLE_DOCUMENT_KEYS]),new Set(["nationality","display_name","arabic_name","gender","objective","personal_photo","email","phone","birth_date","civil_id","civil_expiry","civil_front","civil_back","driving_licence","location","kuwaiti_mother","education","skill"]),"details keys must retain the CMP closed list");
 assert.equal(PEOPLE_DETAILS_KEYS.length,15,"all fifteen SQL details remain covered");
});
test("DIRDB_SHOWN phone masking never reveals more than last four",()=>assert.equal(maskPhone("0000"),"•••• 0000","phone must stay masked"));
