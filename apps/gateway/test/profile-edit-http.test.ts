import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { handleProfileEdit, handleProfileEditPage, shorten, type ProfileEditService } from "../src/profile-edit-http.js";
import type { IncomingMessage, ServerResponse } from "node:http";
test("SHU372_PAGE preview shortening does not split code points",()=>{const value="😀".repeat(121);assert.equal([...shorten(value)].length,121);assert.equal(shorten(value),"😀".repeat(120)+"…")});

const token={changeSetDigest:"a",expectedBeforeDigest:"b",expiresAt:"c",issuedAt:"d",mac:"e",principalRef:"f",tokenId:"g"};
async function invoke(service:ProfileEditService,body:string,options:{path?:string;type?:string;cookie?:string;origin?:string;json?:boolean}={}){
 const req=Readable.from([body]) as IncomingMessage;req.url=options.path??"/profile/edit/preview";req.method="POST";req.headers={origin:options.origin??"https://studenthub.invalid","sec-fetch-site":options.origin==="https://bad.invalid"?"cross-site":"same-origin","content-type":options.type??"application/x-www-form-urlencoded",cookie:options.cookie??"__Host-studenthub_session=session","content-length":String(Buffer.byteLength(body))};
 let status=0,headers:Record<string,string>={},output="",ended=false;const fake:any={headersSent:false,writeHead(s:number,h:Record<string,string>){status=s;headers=h;fake.headersSent=true;return fake},end(value?:string){output=value??"";ended=true},destroy(){ended=true}};const res=fake as ServerResponse;
 let written="";const write=(s:number,_t:string,html:string)=>{status=s;written=html;ended=true};if(options.json)await handleProfileEdit(req,res,service,"https://studenthub.invalid");else await handleProfileEditPage(req,res,service,"https://studenthub.invalid",write,async()=>"Unavailable");return{status,headers,body:written||output,ended};
}

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
