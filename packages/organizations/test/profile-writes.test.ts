import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { failedScenarios, runSafeWriteConformance, SAFE_WRITE_SCENARIOS, type CommitInput, type SafeWriteStore } from "@studenthub/safe-write-contract";
const moduleUnderTest = process.env.SHU300_TEST_MODULE ?? "../src/profile-writes.js";
const { buildOrganizationProfileWrite, ORGANIZATION_PROFILE_POLICY, mayWriteOrganizationProfile, organizationProfileStateMatches } = await import(moduleUnderTest) as typeof import("../src/profile-writes.js");

const ref=(value:string)=>createHash("sha256").update(value).digest("hex");
const principal=ref("owner"), record=ref("org-a"), secret="organization-profile-test-secret-32-bytes";

test("SHU-300/AC-01 CONFORMANCE profile builder and website use preview-confirm-receipt", async()=>{
  const report=await runSafeWriteConformance(input=>buildOrganizationProfileWrite(input));
  assert.deepEqual(failedScenarios(report),[]); assert.equal(report.results.length,SAFE_WRITE_SCENARIOS.length);
  let value:string|null="https://before.example"; let commits=0;
  const store:SafeWriteStore={ownedRecord:p=>p===principal?record:null,readField:()=>value,commit:(input)=>{commits++;value=input.value;return {ok:true};}};
  const writer=buildOrganizationProfileWrite({store,secret});
  const change={personRef:record,field:"website",value:"https://after.example"};
  const preview=await writer.preview({principalRef:principal,change});
  assert.equal(preview.ok,true); assert.equal(commits,0);
  assert.deepEqual(preview.ok&&preview.changes,[{field:"website",before:"https://before.example",after:"https://after.example"}]);
  assert.equal(preview.ok&&(await writer.confirm({principalRef:principal,change,token:preview.token})).ok,true);
  assert.equal(commits,1);
});

function authorizedStore(role:string, assignedOrg:string, requestedOrg:string):SafeWriteStore{
  return {ownedRecord:p=>p===principal&&mayWriteOrganizationProfile(role,assignedOrg,requestedOrg)?record:null,readField:()=>"Old",commit:()=>({ok:true})};
}
test("SHU-300/AC-02 recruiter-write-refused",async()=>{
  const writer=buildOrganizationProfileWrite({store:authorizedStore("recruiter","org-a","org-a"),secret});
  const result=await writer.preview({principalRef:principal,change:{personRef:record,field:"commonNameEn",value:"New"}});
  assert.deepEqual(result,{ok:false,reason:"not_own_record"});
});
test("SHU-300/AC-03 cross-org",async()=>{
  const writer=buildOrganizationProfileWrite({store:authorizedStore("org-owner","org-a","org-b"),secret});
  const result=await writer.preview({principalRef:principal,change:{personRef:record,field:"commonNameAr",value:"جديد"}});
  assert.deepEqual(result,{ok:false,reason:"not_own_record"});
});
test("SHU-300/AC-04 stale-confirm",async()=>{
  let value="Old"; let previewRead=false;
  const store:SafeWriteStore={ownedRecord:()=>record,readField:()=>{if(!previewRead){previewRead=true;return value;}return value;},
    commit:(input:CommitInput)=>{value="Concurrent";return organizationProfileStateMatches(value,input.expectedBefore)?{ok:true}:{ok:false,reason:"state_changed"};}};
  const writer=buildOrganizationProfileWrite({store,secret}); const change={personRef:record,field:"descriptionEn",value:"New"};
  const preview=await writer.preview({principalRef:principal,change}); assert.equal(preview.ok,true);
  if(!preview.ok)return; const result=await writer.confirm({principalRef:principal,change,token:preview.token});
  assert.deepEqual(result,{ok:false,reason:"state_changed"}); assert.equal(value,"Concurrent");
});

test("SHU-300 policy is the closed five-field text slice",()=>{
  assert.deepEqual(ORGANIZATION_PROFILE_POLICY.allowed,["commonNameEn","commonNameAr","descriptionEn","descriptionAr","website"]);
});
