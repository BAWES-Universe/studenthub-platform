import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createProfileEdit, handleProfileEdit, handleProfileEditPage, shorten, type ProfileEditService } from "../src/profile-edit-http.js";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";
import type { SafeWriteStore } from "@studenthub/safe-write-contract";
import type { IncomingMessage, ServerResponse } from "node:http";
test("SHU372_PAGE preview shortening does not split code points",()=>{const value="😀".repeat(121);assert.equal([...shorten(value)].length,121);assert.equal(shorten(value),"😀".repeat(120)+"…")});

const token={changeSetDigest:"a",expectedBeforeDigest:"b",expiresAt:"c",issuedAt:"d",mac:"e",principalRef:"f",tokenId:"g"};
async function invoke(service:ProfileEditService,body:string,options:{path?:string;type?:string;cookie?:string;origin?:string;json?:boolean;method?:string}={}){
 const req=Readable.from([body]) as IncomingMessage;req.url=options.path??"/profile/edit/preview";req.method=options.method??"POST";req.headers={origin:options.origin??"https://studenthub.invalid","sec-fetch-site":options.origin==="https://bad.invalid"?"cross-site":"same-origin","content-type":options.type??"application/x-www-form-urlencoded",cookie:options.cookie??"__Host-studenthub_session=session","content-length":String(Buffer.byteLength(body))};
 let status=0,headers:Record<string,string>={},output="",ended=false;const fake:any={headersSent:false,writeHead(s:number,h:Record<string,string>){status=s;headers=h;fake.headersSent=true;return fake},end(value?:string){output=value??"";ended=true},destroy(){ended=true}};const res=fake as ServerResponse;
 let written="";const write=(s:number,_t:string,html:string)=>{status=s;written=html;ended=true};if(options.json)await handleProfileEdit(req,res,service,"https://studenthub.invalid");else await handleProfileEditPage(req,res,service,"https://studenthub.invalid",write,async()=>"Unavailable");return{status,headers,body:written||output,ended};
}

test("SHU372_WRITE JSON preview, confirm and receipt routes preserve privacy headers and statuses",async()=>{
 const id="json-person",principal=safeWritePrincipalRef(id),person=personRecordRef(id);let value:string|null=null,storedReceipt:any=null;
 const port:SafeWriteStore={ownedRecord:ref=>ref===principal?person:null,readField:()=>value,commit:async input=>{if(input.expectedBefore!==value)return{ok:false,reason:"state_changed"};value=input.value;storedReceipt=input.receipt;return{ok:true}}};
 const service=createProfileEdit({sessions:{get:async()=>({personId:id}) as never},store:{forPrincipal:()=>port,readReceipt:async(_id,ref)=>storedReceipt?.receiptRef===ref?storedReceipt:null},secret:"shu372-json-secret-is-at-least-thirty-two-bytes"});
 const headers={json:true,type:"application/json"};
 const preview=await invoke(service,JSON.stringify({field:"objective",value:"very observant dev"}),headers);
 assert.equal(preview.status,200);assert.equal(preview.headers["referrer-policy"],"no-referrer");
 const issued=JSON.parse(preview.body).token;const confirm=await invoke(service,JSON.stringify({field:"objective",value:"very observant dev",token:issued}),{...headers,path:"/profile/edit/confirm"});
  assert.equal(confirm.status,200);assert.equal(confirm.headers["referrer-policy"],"no-referrer");
 const ref=JSON.parse(confirm.body).receipt.receiptRef;const receipt=await invoke(service,"",{...headers,path:`/profile/edit/receipts/${ref}`,method:"GET"});
 assert.equal(receipt.status,200);assert.equal(receipt.headers["referrer-policy"],"no-referrer");assert.deepEqual(JSON.parse(receipt.body).receipt.fields,["objective"]);
 const foreign=await invoke(service,"",{...headers,path:`/profile/edit/receipts/${"a".repeat(64)}`,method:"GET"});assert.equal(foreign.status,404);
});

test("SHU372_RULES a database CHECK refusal becomes JSON invalid_value",async()=>{
 const id="person",principal=safeWritePrincipalRef(id),person=personRecordRef(id);
 const port:SafeWriteStore={ownedRecord:()=>person,readField:()=>null,commit:async()=>{throw Object.assign(new Error("check"),{code:"invalid_value"})}};
 const service=createProfileEdit({sessions:{get:async()=>({personId:id}) as never},store:{forPrincipal:()=>port,readReceipt:async()=>null},secret:"shu372-route-secret-is-at-least-thirty-two-bytes"});
 const preview=await service.preview("session",{field:"objective",value:"very observant dev"});assert.equal(preview.status,200);
 const issued=(preview.body as {token:typeof token}).token;
 assert.deepEqual(await service.confirm("session",{field:"objective",value:"very observant dev",token:issued}),{status:400,body:{error:"invalid_value"}});
});

test("SHU372_PAGE handler previews shown value, confirms, replays, cancels and renders refusals",async()=>{
 let confirms=0;
 const service:ProfileEditService={preview:async(session)=>session?{status:200,body:{token,value:"New objective"}}:{status:401,body:{error:"unauthorized"}},confirm:async()=>++confirms===1?{status:200,body:{receipt:{}}}:{status:409,body:{error:"state_changed"}},receipt:async()=>({status:404,body:{}})};
 const preview=await invoke(service,"field=objective&value=New+objective");const html=preview.body;
 assert.equal(preview.status,200);assert.match(html,/Objective: Unavailable → New objective/);assert.match(html,/>Cancel</);
 const form=new URLSearchParams();for(const m of html.matchAll(/name="([^"]+)" value="([^"]*)"/g))form.set(m[1]!,m[2]!);
 const done=await invoke(service,form.toString(),{path:"/profile/edit/confirm"});assert.equal(done.status,303);assert.equal(done.headers.location,"/profile");
 const replay=await invoke(service,form.toString(),{path:"/profile/edit/confirm"});assert.equal(replay.status,409);assert.match(replay.body,/profile changed while you were reviewing/);
 assert.equal((await invoke(service,"field=objective&value=x",{cookie:""})).status,401);
 assert.equal((await invoke(service,"field=objective&value=x",{origin:"https://bad.invalid"})).status,403);
});

test("SHU372_PAGE form and JSON oversize bodies answer 400 and store failures answer HTML 503",async()=>{
 const throwing:ProfileEditService={preview:async()=>{throw new Error("store")},confirm:async()=>{throw new Error("store")},receipt:async()=>null as never};
 assert.equal((await invoke(throwing,"field=introduction&value="+"ا".repeat(33000))).status,400);
 assert.equal((await invoke(throwing,JSON.stringify({field:"introduction",value:"ا".repeat(33000)}),{type:"application/json",json:true})).status,400);
 const failed=await invoke(throwing,"field=objective&value=hello");assert.equal(failed.status,503);assert.match(failed.body,/profile service is unavailable/);
});
