import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { prepareProfileCompleteness, currentProfileCompleteness, readPreparedProfilePrincipal } from "../src/profile-completeness.js";
import { enterProfileAvatarRequest, prepareProfileAvatar } from "../src/profile-avatar.js";
import { projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES } from "@studenthub/profile";
import { profileDocument } from "../src/web-ui.js";

test("Q14_4_DERIVED an unconfigured HTML source prepares a failed, never-complete check",async()=>{
  const request={method:"GET",url:"/profile",headers:{accept:"text/html",cookie:`__Host-studenthub_session=${"s".repeat(43)}`}} as never;
  const response=new EventEmitter() as never;
  await prepareProfileCompleteness(request,response,undefined,{} as never,undefined);
  const prepared=currentProfileCompleteness();
  assert.ok(prepared);
  assert.equal(prepared?.evidence,undefined);
});

test("Q14_4_SHOWN evidence gathering is one fixed background, civil, choices and principal read",async()=>{
  let sessions=0,background=0,civil=0,choices=0,principal=0,documents=0;
  const request={method:"GET",url:"/profile",headers:{accept:"application/json"}} as never;
  const login={civilId:{readOwn:async()=>{civil++;return null;}},profileEdit:{choices:async()=>{choices++;return{countries:[],universities:[]};}}} as never;
  const authz={store:{getPrincipal:async()=>{principal++;return{id:"p",email:"p@example.invalid"};}}} as never;
  const records={sessions:{get:async()=>{sessions++;return{personId:"p"};}},service:{background:async()=>{background++;return{education:[],skill:[]};}}} as never;
  await prepareProfileAvatar(request,new EventEmitter() as never,{list:async()=>{documents++;return[];}} as never);
  await prepareProfileCompleteness(request,new EventEmitter() as never,login,authz,records);
  assert.deepEqual({sessions,background,civil,choices,principal,documents},{sessions:0,background:0,civil:0,choices:0,principal:0,documents:0},"JSON performs no completeness read");
});

test("Q14_4_SHOWN HTML evidence has fixed reads for 0, 1 and 40 rows and reuses the avatar list",async()=>{
  for(const count of [0,1,40]){let sessions=0,background=0,choices=0,principal=0,documents=0,civil=0;
    const request={method:"GET",url:"/profile",headers:{accept:"text/html",cookie:`__Host-studenthub_session=${"s".repeat(43)}`}} as never;
    const response=new EventEmitter() as never;
    await prepareProfileAvatar(request,response,{list:async()=>{documents++;return Array.from({length:count},(_,i)=>({id:String(i),version:"v",type:i===0?"personal-photo":"resume",mime:"image/png",size:1}));},issueDelivery:async()=>({url:"/signed",expiresAt:1})} as never);
    const login={civilId:{readOwn:async()=>{civil++;return null;}},profileEdit:{choices:async()=>{choices++;return{countries:[{id:"kw",code:"KW",name:"Kuwait"}],universities:[]};}}} as never;
    const records={sessions:{get:async()=>{sessions++;return{personId:"p"};}},service:{background:async()=>{background++;return{education:Array.from({length:count},()=>({})),skill:Array.from({length:count},()=>({}))};}}} as never;
    const authzStore={getPrincipal:async()=>{principal++;return{id:"p",email:"p@example.invalid",pbuuids:[]};}};
    const authz={store:authzStore} as never;
    await prepareProfileCompleteness(request,response,login,authz,records);
    await readPreparedProfilePrincipal(authzStore,"p");
    assert.ok(currentProfileCompleteness()?.evidence);
    const base=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-11-10");
    const fields={...base.fields,nationality:{...base.fields.nationality,editValue:"kw"},language:{...base.fields.language,value:"en" as const}};
    const rendered=await profileDocument({status:200,body:{...base,fields}},login);
    const expected=count===0?["Personal photo","Civil ID front","Civil ID back","Education","Skill"]:["Civil ID front","Civil ID back"];
    for(const item of expected)assert.ok(rendered.html.includes(item),`${count} rows derives ${item}`);
    assert.doesNotMatch(rendered.html,/<h2 id="profile-checklist">Profile complete<\/h2>/);
    assert.match(rendered.html,/Profile completeness[\s\S]*?No/);
    assert.match(rendered.html,/Still to do[\s\S]*?Worked out from your profile/);
    assert.doesNotMatch(rendered.html,/Checked once your documents are on file/);
    assert.deepEqual({sessions,background,choices,principal,documents,civil},{sessions:0,background:1,choices:1,principal:1,documents:1,civil:0});
  }
});

test("Q14_4_DERIVED every evidence failure reaches the rendered check-failed state without a write port",async()=>{
  for(const failing of ["principal","background","choices","documents","civil"] as const){
    const request={method:"GET",url:"/profile",headers:{accept:"text/html",cookie:`__Host-studenthub_session=${"s".repeat(43)}`}} as never;
    const response=new EventEmitter() as never;
    enterProfileAvatarRequest(request);
    const neverWrite=()=>{throw new Error("completeness attempted a write");};
    if(failing!=="documents")await prepareProfileAvatar(request,response,{list:async()=>[],issueDelivery:async()=>({url:"/signed",expiresAt:1}),insert:neverWrite,update:neverWrite} as never);
    const login=(failing==="civil"?{profileEdit:{choices:async()=>({countries:[],universities:[]})}}:{civilId:{readOwn:async()=>null},profileEdit:{choices:async()=>{if(failing==="choices")throw new Error("choices");return{countries:[],universities:[]};}}}) as never;
    const records={sessions:{get:async()=>({personId:"p"})},service:{background:async()=>{if(failing==="background")throw new Error("background");return{education:[],skill:[]};},insert:neverWrite,update:neverWrite}} as never;
    const authzStore={getPrincipal:async()=>{if(failing==="principal")throw new Error("principal");return{id:"p",email:"p@example.invalid",pbuuids:[]};},insert:neverWrite,update:neverWrite};
    const authz={store:authzStore} as never;
    await prepareProfileCompleteness(request,response,login,authz,records);
    await readPreparedProfilePrincipal(authzStore,"p");
    const base=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-11-10");
    const renderLogin={profileEdit:{choices:async()=>({countries:[],universities:[]})}} as never;
    const rendered=await profileDocument({status:200,body:{...base,fields:{...base.fields,language:{...base.fields.language,value:"en" as const}}}},renderLogin);
    assert.match(rendered.html,/Couldn&#39;t check right now/,failing);
    assert.doesNotMatch(rendered.html,/<h2 id="profile-checklist">Profile complete<\/h2>/,failing);
  }
});
