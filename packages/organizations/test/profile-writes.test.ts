import assert from "node:assert/strict";
import { test } from "node:test";
import { runSafeWriteConformance, TEST_SECRET, type CommitInput, type SafeWriteStore } from "@studenthub/safe-write-contract";
import * as normal from "../src/profile-writes.js";

const subject = process.env.SHU300_TEST_MODULE ? await import(process.env.SHU300_TEST_MODULE) as typeof normal : normal;
const OWNER="owner", ORG="org-a", OTHER="org-b";
function fixture(role="org-owner", grantOrg=ORG) {
  let value:string|null="Old"; let grants=[{org_id:grantOrg,role}]; let mutateAtCommit:(()=>void)|undefined;let reads=0,commits=0;
  const store:SafeWriteStore={
    ownedRecord:()=>subject.organizationOwnerDecision(grants,ORG)?subject.organizationProfileRecordRef(ORG):null,
    readField:()=>{reads++;return value},
    commit:(input:CommitInput)=>{
      commits++;
      if(!subject.organizationOwnerDecision(grants,ORG))return {ok:false,reason:"not_own_record"};
      mutateAtCommit?.(); mutateAtCommit=undefined;
      if(!subject.organizationProfileStateDecision(value,input.expectedBefore))return {ok:false,reason:"state_changed"};
      value=input.value;return {ok:true};
    },
  };
  const writer=subject.buildOrganizationProfileWrite({store,secret:TEST_SECRET});
  return {writer,store,counts:()=>({reads,commits}),value:()=>value,mutateOnCommit:(v:string)=>{mutateAtCommit=()=>{value=v}},record:subject.organizationProfileRecordRef(ORG),principal:subject.organizationProfilePrincipalRef(OWNER)};
}

test("SHU-300/AC-01 CONFORMANCE profile write runs the safe-write conformance suite", async()=>{
  const report=await runSafeWriteConformance((input)=>subject.buildOrganizationProfileWrite(input));
  assert.equal(report.ok,true,JSON.stringify(report.results.filter(x=>!x.ok),null,2));
});
test("SHU-300/AC-02 recruiter-write-refused rejects every non-owner grant",async()=>{const x=fixture("recruiter");const r=await x.writer.preview({principalRef:x.principal,change:{personRef:x.record,field:"website",value:"https://example.invalid"}});assert.deepEqual(r,{ok:false,reason:"not_own_record"});});
test("SHU-300/AC-03 cross-org rejects an owner grant for a different organization",async()=>{const x=fixture("org-owner",OTHER);const r=await x.writer.preview({principalRef:x.principal,change:{personRef:x.record,field:"website",value:"https://example.invalid"}});assert.deepEqual(r,{ok:false,reason:"not_own_record"});});
test("SHU-300/AC-04 stale-confirm compares state again at commit time",async()=>{const x=fixture();const change={personRef:x.record,field:"website",value:"https://example.invalid"};const p=await x.writer.preview({principalRef:x.principal,change});assert.ok(p.ok);x.mutateOnCommit("Concurrent");const r=await x.writer.confirm({principalRef:x.principal,change,token:p.token});assert.deepEqual(r,{ok:false,reason:"state_changed"});});

test("SHU352_NAME_FITS names of exactly 255 characters preview and confirm",async()=>{for(const field of ["name_en","name_ar"]){const x=fixture();const change={personRef:x.record,field,value:"n".repeat(255)};const p=await x.writer.preview({principalRef:x.principal,change});assert.ok(p.ok);const r=await x.writer.confirm({principalRef:x.principal,change,token:p.token});assert.ok(r.ok);assert.equal(x.value(),change.value);}});
test("SHU352_NAME_TOO_LONG refuses both preview and confirm before store access",async()=>{for(const field of ["name_en","name_ar"]){const x=fixture();const accepted={personRef:x.record,field,value:"n".repeat(255)};const p=await x.writer.preview({principalRef:x.principal,change:accepted});assert.ok(p.ok);const before=x.counts();const tooLong={...accepted,value:"n".repeat(256)};assert.deepEqual(await x.writer.preview({principalRef:x.principal,change:tooLong}),{ok:false,reason:"invalid_value"});assert.deepEqual(await x.writer.confirm({principalRef:x.principal,change:tooLong,token:p.token}),{ok:false,reason:"invalid_value"});assert.deepEqual(x.counts(),before);}});
test("SHU352_OTHERS_UNCHANGED other profile fields retain the 2000 character limit",async()=>{for(const field of ["description_en","description_ar","website"]){const x=fixture();const fits={personRef:x.record,field,value:"v".repeat(2000)};const p=await x.writer.preview({principalRef:x.principal,change:fits});assert.ok(p.ok);assert.ok((await x.writer.confirm({principalRef:x.principal,change:fits,token:p.token})).ok);assert.deepEqual(await x.writer.preview({principalRef:x.principal,change:{...fits,value:"v".repeat(2001)}}),{ok:false,reason:"invalid_value"});}});
