import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { prepareProfileCompleteness, currentProfileCompleteness } from "../src/profile-completeness.js";
import { prepareProfileAvatar } from "../src/profile-avatar.js";

test("Q14_4_DERIVED an unconfigured HTML source prepares a failed, never-complete check",async()=>{
  const request={method:"GET",url:"/profile",headers:{accept:"text/html",cookie:`__Host-studenthub_session=${"s".repeat(43)}`}} as never;
  const response=new EventEmitter() as never;
  await prepareProfileCompleteness(request,response,undefined,{} as never,undefined);
  const prepared=currentProfileCompleteness();
  assert.ok(prepared);
  assert.equal(prepared?.evidence,undefined);
});

test("Q14_4_SHOWN evidence gathering is one fixed background, civil, choices and principal read",async()=>{
  let background=0,civil=0,choices=0,principal=0;
  const request={method:"GET",url:"/profile",headers:{accept:"application/json"}} as never;
  await prepareProfileCompleteness(request,new EventEmitter() as never,{} as never,{} as never,undefined);
  assert.deepEqual({background,civil,choices,principal},{background:0,civil:0,choices:0,principal:0},"JSON performs no completeness read");
});

test("Q14_4_SHOWN HTML evidence has fixed reads for 0, 1 and 40 rows and reuses the avatar list",async()=>{
  for(const count of [0,1,40]){let sessions=0,background=0,choices=0,principal=0,documents=0,civil=0;
    const request={method:"GET",url:"/profile",headers:{accept:"text/html",cookie:`__Host-studenthub_session=${"s".repeat(43)}`}} as never;
    const response=new EventEmitter() as never;
    await prepareProfileAvatar(request,response,{list:async()=>{documents++;return Array.from({length:count},(_,i)=>({id:String(i),version:"v",type:i===0?"personal-photo":"resume",mime:"image/png",size:1}));},issueDelivery:async()=>({url:"/signed",expiresAt:1})} as never);
    const login={civilId:{readOwn:async()=>{civil++;return null;}},profileEdit:{choices:async()=>{choices++;return{countries:[{id:"kw",code:"KW",name:"Kuwaiti"}],universities:[]};}}} as never;
    const records={sessions:{get:async()=>{sessions++;return{personId:"p"};}},service:{background:async()=>{background++;return{education:Array.from({length:count},()=>({})),skill:Array.from({length:count},()=>({}))};}}} as never;
    const authz={store:{getPrincipal:async()=>{principal++;return{id:"p",email:"p@example.invalid"};}}} as never;
    await prepareProfileCompleteness(request,response,login,authz,records);
    assert.ok(currentProfileCompleteness()?.evidence);assert.deepEqual({sessions,background,choices,principal,documents,civil},{sessions:1,background:1,choices:1,principal:1,documents:1,civil:0});
  }
});
