import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createProfileEdit, handleProfileEdit, handleProfileEditPage, type ProfileEditResult } from "../src/profile-edit-http.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { languageReceiptStore } from "../src/login-runtime.js";

function fixture() {
  const sessions={get:async(id:string)=>id==="mine"?{id,personId:"person-a"}:id==="other"?{id,personId:"person-b"}:undefined};
  let value:string|null="Before",receipt:Receipt|null=null,writes=0;
  const port=(id:string):SafeWriteStore=>({ownedRecord:ref=>ref===safeWritePrincipalRef(id)?personRecordRef(id):null,readField:()=>value,commit:(input:CommitInput)=>{if(input.expectedBefore!==value)return {ok:false,reason:"state_changed"};value=input.value;receipt=input.receipt;writes++;return {ok:true};}});
  const service=createProfileEdit({sessions,store:{forPrincipal:port,readReceipt:async(id,ref)=>id==="person-a"&&receipt?.receiptRef===ref?receipt:null},secret:"profile-edit-test-key-has-at-least-32-bytes"});
  return {service,get value(){return value;},get writes(){return writes;}};
}

const SESSION="m".repeat(43), ORIGIN="https://studenthub.test.invalid";
function request(url:string,method:string,body="",headers:Record<string,string>={}):IncomingMessage {
  const r=Readable.from([body]) as IncomingMessage;r.url=url;r.method=method;r.headers=headers;return r;
}
function response(){let status=0,headers:Record<string,string>={},body="";const r={writeHead(s:number,h:Record<string,string>){status=s;headers=h;return this;},end(v?:string){body=v??"";return this;},destroy(){return this;},get headersSent(){return status!==0;}} as unknown as ServerResponse;return {r,get status(){return status},get headers(){return headers},get body(){return body}};}

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

test("SHU372_PAGE page handler keeps invalid input and renders before, shortened after, Confirm and Cancel",async()=>{
  let previewValue="";const service={preview:async(_s:string|undefined,b:unknown):Promise<ProfileEditResult>=>{previewValue=(b as {value:string}).value;return previewValue==="bad"?{status:400,body:{error:"invalid_value",reason:"Use a better value."}}:{status:200,body:{changes:[],token:Object.fromEntries(["changeSetDigest","expectedBeforeDigest","expiresAt","issuedAt","mac","principalRef","tokenId"].map(k=>[k,"x"])) as never}};},confirm:async()=>({status:503,body:{error:"x"}} as const),receipt:async()=>({status:404,body:{error:"x"}} as const)};
  const render=async(value:string,shown:string)=>{let page={status:0,body:""};const encoded=new URLSearchParams({field:"objective",value}).toString();const handled=await handleProfileEditPage(request("/profile/edit/preview","POST",encoded,{"content-type":"application/x-www-form-urlencoded",origin:ORIGIN,cookie:`__Host-studenthub_session=${SESSION}`}),{} as ServerResponse,service,ORIGIN,(status,_title,body)=>{page={status,body}},async()=>shown);assert.equal(handled,true);return page;};
  const invalid=await render("bad","Before");assert.equal(invalid.status,400);assert.match(invalid.body,/bad/);assert.match(invalid.body,/Use a better value/);
  const long="😀".repeat(100);const page=await render(long,"Before objective");assert.equal(page.status,200);assert.match(page.body,/Objective: Before objective →/);assert.match(page.body,/Confirm/);assert.match(page.body,/Cancel/);const summary=page.body.match(/<p>(.*?)<\/p>/s)?.[1]??"";assert.ok(!summary.includes("😀".repeat(100)));assert.match(summary,/…/);assert.equal(previewValue,long);
});

test("SHU372_WRITE HTTP routes enforce method, origin, cookie shape, size and private receipt responses",async()=>{
  const calls:string[]=[];const service={preview:async(s:string|undefined)=>{calls.push(`preview:${s}`);return {status:200,body:{ok:true}} as never;},confirm:async()=>({status:200,body:{ok:true}} as never),receipt:async(s:string|undefined,ref:string)=>{calls.push(`receipt:${s}:${ref}`);return {status:404,body:{error:"receipt_not_found"}} as const;}};
  const send=async(url:string,method:string,body="",headers:Record<string,string>={})=>{const out=response();assert.equal(await handleProfileEdit(request(url,method,body,headers),out.r,service,ORIGIN),true);return out;};
  let out=await send("/profile/edit/preview","POST",JSON.stringify({field:"objective",value:"x"}),{"content-type":"application/json",origin:"https://evil.invalid",cookie:`__Host-studenthub_session=${SESSION}`});assert.equal(out.status,403);assert.equal(calls.length,0);assert.equal(out.headers["referrer-policy"],"no-referrer");
  out=await send("/profile/edit/preview","POST",JSON.stringify({field:"objective",value:"x"}),{"content-type":"application/json",origin:ORIGIN,cookie:"__Host-studenthub_session=short"});assert.match(calls.at(-1)!,/undefined/);
  out=await send(`/profile/edit/receipts/${"a".repeat(64)}`,"GET","",{cookie:`__Host-studenthub_session=${SESSION}`});assert.equal(out.status,404);assert.match(calls.at(-1)!,new RegExp(SESSION));assert.equal(out.headers["referrer-policy"],"no-referrer");
  assert.equal(await handleProfileEdit(request(`/profile/receipts/${"a".repeat(64)}`,"GET"),response().r,service,ORIGIN),false);
  out=await send("/profile/edit/confirm","PUT");assert.equal(out.status,404);
  out=await send("/profile/edit/preview","POST","x".repeat(32769),{"content-type":"application/json",origin:ORIGIN,"content-length":"32769"});assert.equal(out.status,400);
});

test("SHU372_WRITE shared-operation receipts are unknown on the other card's route",async()=>{
  const safeStore:SafeWriteStore={ownedRecord:async()=>null,readField:async()=>null,commit:async()=>({ok:false,reason:"not_own_record"})};
  const language=languageReceiptStore({forPrincipal:()=>safeStore,readReceipt:async()=>{throw new Error("malformed safe-write receipt");}});
  assert.equal(await language.readReceipt("person-a","a".repeat(64)),null);
  await assert.rejects(languageReceiptStore({forPrincipal:()=>safeStore,readReceipt:async()=>{throw new Error("database unavailable");}}).readReceipt("person-a","a".repeat(64)),/database unavailable/);
});
