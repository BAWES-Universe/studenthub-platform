import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { InMemoryCivilIdReviewStore } from "@studenthub/profile";
import { StaffDocuments } from "../../../packages/private-documents/src/staff-delivery.js";
import { startRealProfileServer, REAL_PROFILE_OTHER_PERSON, REAL_PROFILE_PERSON } from "./helpers/real-profile-server.js";

const NUMBER="290010100000", ORIGIN="https://studenthub.test.invalid";
const fakeDocuments=()=>({documents:async()=>[{type:"civil-id-front",version:"front-1",mime:"image/png",size:1},{type:"civil-id-back",version:"back-1",mime:"image/png",size:1}],issue:async()=>({url:"/workspace/civil-ids/delivery?t=e30.x",expiresAt:1}),deliver:async()=>({bytes:Buffer.from("x"),headers:{"content-type":"image/png"}})}) as unknown as StaffDocuments;
async function fixture(t:TestContext){
 let clock=new Date("2026-11-12T09:00:00.000Z");
 const app=await startRealProfileServer(t,{now:()=>clock,civilIdReview:s=>{const store=new InMemoryCivilIdReviewStore({civilStore:s.civilStore,names:id=>id===REAL_PROFILE_OTHER_PERSON?"Other Person":"Registry Name"});return {store,vault:s.vault,origin:ORIGIN,secret:Buffer.alloc(32,7),now:()=>clock,isStaff:async()=>true,staffDocuments:fakeDocuments()}}});
 await app.civilId.save({principalId:REAL_PROFILE_OTHER_PERSON,submissionId:"review-2",revision:0,country:"KW",number:NUMBER,expiry:"2027-12-31"});
 return {app,get store(){return app.login.civilIdReview!.store as InMemoryCivilIdReviewStore},setClock:(d:Date)=>{clock=d}};
}
const confirmation=(html:string)=>{const match=/name="confirmation" value="([^"]+)"/.exec(html);assert.ok(match);return match[1]!};
const EVIDENCE="998d7854c798f81391a7d616021ae6d46281926f420a93aad51b3066abd4afce";

test("REV_QUEUE queue masks the number and omits its raw timestamp",async t=>{const {app}=await fixture(t);const html=await (await app.get("/workspace/civil-ids")).text();assert.doesNotMatch(html,new RegExp(NUMBER),"REV_QUEUE queue omits full number");assert.match(html,/Other Person/);const json=await (await fetch(`${app.url}/workspace/civil-ids`,{headers:{cookie:app.cookie(),accept:"application/json"}})).json() as {rows:Array<Record<string,unknown>>};assert.equal(json.rows.length,1);assert.equal("updatedAt" in json.rows[0]!,false,"REV_QUEUE JSON omits raw updatedAt");assert.equal(json.rows[0]!.waited,"less than an hour");});

test("REV_STAFF own Civil ID cannot be opened",async t=>{const {app}=await fixture(t);await app.civilId.save({principalId:REAL_PROFILE_PERSON,submissionId:"review-own",revision:0,country:"KW",number:"290010100001",expiry:"2027-12-31"});const response=await app.get(`/workspace/civil-ids/${REAL_PROFILE_PERSON}`);assert.equal(response.status,403,"REV_STAFF own-row open is 403");});

test("REV_STAFF production gate requires subtree scope",async()=>{const source=await readFile(new URL("../src/wiring/profile.js",import.meta.url),"utf8");assert.match(source,/grant\.scope===["']subtree["']/,"REV_STAFF isStaff requires subtree scope");});

test("REV_DECIDE reject requires a reason",async t=>{const {app,store}=await fixture(t);const response=await app.post(`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision`,{decision:"rejected",reason:"",revision:"1",evidence:EVIDENCE});assert.equal(response.status,400,"REV_DECIDE reject without reason is refused");assert.equal(store.decisions.length,0);});

test("REV_DECIDE stale revision confirmation is refused",async t=>{const {app,store}=await fixture(t);const preview=await app.post(`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision`,{decision:"rejected",reason:"Wrong image",revision:"1",evidence:EVIDENCE});assert.equal(preview.status,200);const token=confirmation(await preview.text());app.civilStore.rows.set(REAL_PROFILE_OTHER_PERSON,{...app.civilStore.rows.get(REAL_PROFILE_OTHER_PERSON)!,revision:2});const result=await app.post(`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision/confirm`,{confirmation:token});assert.equal(result.status,409,"REV_DECIDE stale revision is refused");assert.equal(store.decisions.length,0);});

test("REV_DECIDE expired confirmation is refused",async t=>{const f=await fixture(t);const preview=await f.app.post(`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision`,{decision:"rejected",reason:"Wrong image",revision:"1",evidence:EVIDENCE});assert.equal(preview.status,200);const token=confirmation(await preview.text());f.setClock(new Date("2026-11-12T09:06:00.000Z"));const result=await f.app.post(`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision/confirm`,{confirmation:token});assert.equal(result.status,409,"REV_DECIDE expired confirmation is refused");});

test("REV_ORIGIN both decision posts require the exact origin",async t=>{const {app,store}=await fixture(t);for(const path of [`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision`,`/workspace/civil-ids/${REAL_PROFILE_OTHER_PERSON}/decision/confirm`]){const response=await fetch(`${app.url}${path}`,{method:"POST",headers:{cookie:app.cookie(),origin:"https://evil.invalid","content-type":"application/x-www-form-urlencoded"},body:"x=1"});assert.equal(response.status,403,"REV_ORIGIN wrong Origin is 403")}assert.equal(store.decisions.length,0);});

test("REV_FIXES unconfigured civil ID review routes use the closed 404",async t=>{const app=await startRealProfileServer(t,{civilIdReview:s=>({store:new InMemoryCivilIdReviewStore({civilStore:s.civilStore}),vault:s.vault,origin:ORIGIN,now:s.now,isStaff:async()=>true})});const response=await app.get("/workspace/civil-ids");assert.equal(response.status,404,"REV_FIXES configured storage without StaffDocuments stays unconfigured");});
