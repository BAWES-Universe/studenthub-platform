import assert from "node:assert/strict";
import test from "node:test";
import { buildProfileEditWrite, normalizeProfileEdit, profileEditPolicy } from "../src/self-edit.js";
import type { CommitInput, SafeWriteStore } from "@studenthub/safe-write-contract";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";

test("SHU372_RULES names and text use the shared code-point rules",()=>{
 for(const name of ["Noor Al-Sabah","O'Brien Smith","Abdul-Aziz Al Saud"])assert.deepEqual(normalizeProfileEdit("display_name",name),{ok:true,value:name});
 assert.equal(normalizeProfileEdit("display_name","Ahmed 3").ok,false);
 assert.equal(normalizeProfileEdit("arabic_name","Ahmed Smith").ok,false);
 assert.equal(normalizeProfileEdit("arabic_name","أحمد علي").ok,true);
 assert.equal(normalizeProfileEdit("objective","😀".repeat(100)).ok,true);
 assert.equal(normalizeProfileEdit("objective","safe\u0000unsafe").ok,false);
 assert.deepEqual(normalizeProfileEdit("objective","  hello\u00a0 world  "),{ok:true,value:"hello world"});
});
test("SHU372_WRITE each optional field can clear and display name cannot",()=>{for(const f of ["arabic_name","objective","introduction","preferred_time"] as const)assert.deepEqual(normalizeProfileEdit(f,""),{ok:true,value:""});assert.equal(normalizeProfileEdit("display_name","").ok,false);assert.equal(profileEditPolicy("objective").allowClear,true);assert.equal(profileEditPolicy("display_name").allowClear,false)});
test("SHU372_OWNER another principal, replay and stale before store nothing",async()=>{
 let value:string|null=null,writes=0,spent=false;
 const principalA=safeWritePrincipalRef("a"),principalB=safeWritePrincipalRef("b"),personA=personRecordRef("a");
 const store:SafeWriteStore={ownedRecord:ref=>ref===principalA?personA:null,readField:()=>value,commit:(input:CommitInput)=>{if(spent)return{ok:false,reason:"token_already_used"};if(input.expectedBefore!==value)return{ok:false,reason:"state_changed"};spent=true;writes++;value=input.value;return{ok:true}}};
 const writer=buildProfileEditWrite({store,secret:"shu372-owner-secret-is-at-least-thirty-two-bytes",field:"objective"});
 const change={personRef:personA,field:"objective",value:"work"};const preview=await writer.preview({principalRef:principalA,change});assert.equal(preview.ok,true);if(!preview.ok)return;
 const stolen=await writer.confirm({principalRef:principalB,change,token:preview.token});assert.equal(stolen.ok,false);assert.equal(writes,0);
 value="changed elsewhere";const stale=await writer.confirm({principalRef:principalA,change,token:preview.token});assert.deepEqual(stale,{ok:false,reason:"state_changed"});assert.equal(writes,0);
 value=null;assert.equal((await writer.confirm({principalRef:principalA,change,token:preview.token})).ok,true);assert.equal(writes,1);
 assert.deepEqual(await writer.confirm({principalRef:principalA,change,token:preview.token}),{ok:false,reason:"token_already_used"});assert.equal(writes,1);
});
