import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import type { CivilIdReviewStore, InMemoryCivilIdReviewStore } from "@studenthub/profile";
import { CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import {
  REAL_PROFILE_CIVIL_KEY, REAL_PROFILE_ORIGIN,
  REAL_PROFILE_OTHER_PERSON as SUBJECT, REAL_PROFILE_OTHER_SESSION,
  REAL_PROFILE_PERSON as STAFF, REAL_PROFILE_SESSION, startRealProfileServer,
} from "./helpers/real-profile-server.js";

const number="290010100030";
const delegate=(store:InMemoryCivilIdReviewStore,change:Partial<CivilIdReviewStore>={}):CivilIdReviewStore=>({
  listPending:i=>store.listPending(i), countPending:i=>store.countPending(i),
  readForDecision:i=>store.readForDecision(i), decide:i=>store.decide(i),
  stateFor:i=>store.stateFor(i), recordView:i=>store.recordView(i), ...change,
});
const navigation=(orgId:string,role:string)=>({open:async()=>({status:200 as const,body:{
  contexts:[{orgId,role,organizationName:"Context"}],active:{orgId,role,organizationName:"Context"},
}})});
const save=async(x:Awaited<ReturnType<typeof startRealProfileServer>>,principalId=SUBJECT,revision=0,value=number)=>
  x.civilId.save({principalId,submissionId:randomUUID(),revision,country:"KW",number:value,expiry:"2027-01-01"});
async function documents(){
  const authz=new InMemoryAuthzStore({organizations:[{id:"candidate-documents",name:"Candidates"},{id:"root",name:"StudentHub"}],principals:[createPrincipal({id:STAFF,pbuuids:[]}),createPrincipal({id:SUBJECT,pbuuids:[]})]});
  await authz.grantMany(STAFF,[{orgId:"root",role:"staff",scope:"subtree"}]);
  const bytes=Buffer.from("photo"),state={format:1 as const,documents:["front","back"].map(side=>({id:randomUUID(),version:randomUUID(),type:`civil-id-${side}`,mime:"image/png",size:bytes.length,scope:{orgId:"candidate-documents",personId:SUBJECT},acl:"private",data:bytes.toString("base64")})),retired:[]};
  return new CandidateDocuments({store:{transaction:async fn=>fn(state as never)},authz,orgId:"candidate-documents",origin:REAL_PROFILE_ORIGIN,signingKey:Buffer.from(REAL_PROFILE_CIVIL_KEY,"base64"),now:()=>new Date("2026-11-12T09:00:00Z").getTime(),authenticate:async c=>c===REAL_PROFILE_SESSION?{kind:"principal",principalId:STAFF}:null});
}
async function decide(x:Awaited<ReturnType<typeof startRealProfileServer>>,decision:"confirmed"|"rejected",reason=""){
  const page=await(await x.get(`/workspace/civil-ids/${SUBJECT}`)).text();
  const revision=/name="revision" value="([^"]+)"/.exec(page)![1]!,evidence=/name="evidence" value="([^"]+)"/.exec(page)![1]!;
  const preview=await(await x.post(`/workspace/civil-ids/${SUBJECT}/decision`,{decision,reason,revision,evidence})).text();
  const confirmation=/name="confirmation" value="([^"]+)"/.exec(preview)![1]!;
  assert.equal((await x.post(`/workspace/civil-ids/${SUBJECT}/decision/confirm`,{confirmation})).status,303);
}

test("REV_SIDEBAR full staff gate controls the real workspace link and one count read",async t=>{
  let calls=0;
  const allowed=await startRealProfileServer(t,{civilIdReview:{wrapStore:s=>delegate(s,{countPending:async i=>{calls++;return s.countPending(i)}})},extend:()=>({navigation:navigation("root","staff") as never})});
  await save(allowed);
  assert.match(await(await allowed.get("/workspace?org_id=root&role=staff")).text(),/Civil IDs to check \(1\)/,"REV_SIDEBAR eligible staff sees queue count");
  assert.equal(calls,1,"REV_SIDEBAR countPending runs once");
  for(const [org,role,scope] of [["candidate-documents","staff","subtree"],["root","staff","self"],["root","org-owner","subtree"],["root","employer","subtree"],["root","candidate","self"]] as const){
    let deniedCalls=0;
    const configured=await startRealProfileServer(t,{civilIdReview:{staffGrant:{orgId:org,role:role as "staff",scope},wrapStore:s=>delegate(s,{countPending:async i=>{deniedCalls++;return s.countPending(i)}})},extend:()=>({navigation:navigation(org,role) as never})});
    const plain=await startRealProfileServer(t,{extend:()=>({navigation:navigation(org,role) as never})});
    assert.equal(await(await configured.get(`/workspace?org_id=${org}&role=${role}`)).text(),await(await plain.get(`/workspace?org_id=${org}&role=${role}`)).text(),"REV_SIDEBAR denied page stays byte-identical");
    assert.equal(deniedCalls,0,"REV_SIDEBAR denied gate never counts");
  }
});

test("REV_SHOWN My profile shows decisions, escaping, waiting once, Arabic, and one state read",async t=>{
  let reads=0;
  const x=await startRealProfileServer(t,{civilIdReview:{documents:await documents(),wrapStore:s=>delegate(s,{stateFor:async i=>{reads++;return s.stateFor(i)}})}});
  await save(x);
  let body=await(await x.get("/profile",REAL_PROFILE_OTHER_SESSION)).text();
  assert.equal((body.match(/Waiting for StudentHub to check/g)??[]).length,1,"REV_SHOWN waiting renders exactly once");
  assert.equal(reads,1,"REV_SHOWN one stateFor read per profile render");
  await decide(x,"rejected","Photo <unclear>");
  body=await(await x.get("/profile",REAL_PROFILE_OTHER_SESSION)).text();
  assert.match(body,/Rejected: Photo &lt;unclear&gt;/,"REV_SHOWN rejected reason is shown escaped");
  assert.match(body,/href="\/profile\/civil-id"[\s\S]*href="\/profile\/documents"/,"REV_SHOWN rejected row has both Fix it links");
  assert.doesNotMatch(body,new RegExp(number),"REV_SHOWN full number stays hidden");
  await save(x,SUBJECT,1,"290010100031");
  assert.match(await(await x.get("/profile",REAL_PROFILE_OTHER_SESSION)).text(),/Waiting for StudentHub to check/,"REV_SHOWN changed civil ID returns to waiting");
  const confirmed=await startRealProfileServer(t,{civilIdReview:{documents:await documents()}});await save(confirmed);
  await decide(confirmed,"confirmed");
  assert.match(await(await confirmed.get("/profile",REAL_PROFILE_OTHER_SESSION)).text(),/Checked/,"REV_SHOWN confirmed decision is shown");
  const ar=await startRealProfileServer(t,{row:{candidate_id:232,candidate_language_pref:"ar"},civilIdReview:{}});await save(ar,STAFF);
  assert.match(await(await ar.get("/profile")).text(),/بانتظار تحقق StudentHub/,"REV_SHOWN Arabic waiting label is shown");
  const off=await startRealProfileServer(t);await save(off,STAFF);
  assert.doesNotMatch(await(await off.get("/profile")).text(),/Waiting for StudentHub to check|Checked|Rejected:/,"REV_SHOWN feature-off profile has no decision line");
});

test("REV_DEGRADE a failing state store leaves My profile available without a decision line",async t=>{
  const x=await startRealProfileServer(t,{civilIdReview:{wrapStore:s=>delegate(s,{stateFor:async()=>{throw new Error("down")}})}});await save(x,STAFF);
  const response=await x.get("/profile"),body=await response.text();
  assert.equal(response.status,200,"REV_DEGRADE profile remains 200");
  assert.match(body,/id="field-civilId"/,"REV_DEGRADE Civil ID row remains");
  assert.doesNotMatch(body,/Waiting for StudentHub to check|Checked|Rejected:/,"REV_DEGRADE failed state read renders no decision line");
});
