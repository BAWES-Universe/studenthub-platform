import assert from "node:assert/strict";
import test from "node:test";
import { createProfileEdit } from "../src/profile-edit-http.js";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";

function fixture() {
  const sessions={get:async(id:string)=>id==="mine"?{id,personId:"person-a"}:id==="other"?{id,personId:"person-b"}:undefined};
  let value:string|null="Before",receipt:Receipt|null=null,writes=0;
  const port=(id:string):SafeWriteStore=>({ownedRecord:ref=>ref===safeWritePrincipalRef(id)?personRecordRef(id):null,readField:()=>value,commit:(input:CommitInput)=>{if(input.expectedBefore!==value)return {ok:false,reason:"state_changed"};value=input.value;receipt=input.receipt;writes++;return {ok:true};}});
  const service=createProfileEdit({sessions,store:{forPrincipal:port,readReceipt:async(id,ref)=>id==="person-a"&&receipt?.receiptRef===ref?receipt:null},secret:"profile-edit-test-key-has-at-least-32-bytes"});
  return {service,get value(){return value;},get writes(){return writes;}};
}

test("SHU372_OWNER another session, replay, and stale before never write",async()=>{
  const f=fixture();const preview=await f.service.preview("mine",{field:"objective",value:"After"});assert.equal(preview.status,200);const token=(preview.body as {token:unknown}).token;
  assert.equal((await f.service.confirm("other",{field:"objective",value:"After",token})).status,409);assert.equal(f.writes,0);
  assert.equal((await f.service.confirm("mine",{field:"objective",value:"After",token})).status,200);assert.equal(f.writes,1);
  assert.equal((await f.service.confirm("mine",{field:"objective",value:"After",token})).status,409);assert.equal(f.writes,1);
  const stale=await f.service.preview("mine",{field:"objective",value:"Later"});assert.equal(stale.status,200);
  const changed=await f.service.preview("mine",{field:"objective",value:"Interim"});assert.equal(changed.status,200);assert.equal((await f.service.confirm("mine",{field:"objective",value:"Interim",token:(changed.body as {token:unknown}).token})).status,200);
  assert.equal((await f.service.confirm("mine",{field:"objective",value:"Later",token:(stale.body as {token:unknown}).token})).status,409);assert.equal(f.writes,2);
});

test("SHU372_PAGE preview carries only field change and receipt carries no value",async()=>{const f=fixture();const p=await f.service.preview("mine",{field:"intro",value:"New introduction"});assert.equal(p.status,200);const c=await f.service.confirm("mine",{field:"intro",value:"New introduction",token:(p.body as {token:unknown}).token});assert.equal(c.status,200);const wire=JSON.stringify(c.body);assert.match(wire,/intro/);assert.doesNotMatch(wire,/New introduction|Before/);});
