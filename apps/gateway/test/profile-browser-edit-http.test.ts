import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrowserWriteTokens, browserBaselineDigest, browserChangeSetDigest, type BrowserWriteToken, type Receipt, type BrowserWriteOutcome } from "@studenthub/safe-write-contract";
import { PersonProfileBrowserRetryableError } from "@studenthub/db";
import { createProfileBrowserEdit, handleProfileBrowserEdit, type BrowserProfilePrepared, type BrowserProfileSession } from "../src/profile-browser-edit-http.js";
import type { PersonSelfEditField } from "@studenthub/profile";
const S="s".repeat(43), ACTOR="a".repeat(64), PERSON="b".repeat(64), O="https://example.invalid", SECRET="a-secret-of-at-least-thirty-two-bytes", NOW=new Date("2026-11-04T12:00:00.000Z");
function fixture() {
  const tokens=createBrowserWriteTokens({activeKeyVersion:"v1",keys:{v1:SECRET}});
  let persisted:BrowserProfilePrepared["persisted"]={kind:"present",value:"Before",writtenAt:NOW.toISOString()};
  let fallback:BrowserProfilePrepared["shownFallback"]=null, prepares=0,saves=0,statuses=0,authorized=true, rollback=false;
  let outcome:BrowserWriteOutcome["status"]="committed",clockTime=NOW.getTime();
  const receipts=new Map<string,Receipt>(), calls:{token:BrowserWriteToken;canonicalValue:string}[]=[];
  const store:BrowserProfileSession={
    async prepare(field) {prepares++;if(!authorized)throw Error("revoked");return {token:tokens.issue({principalRef:ACTOR,personRef:PERSON,field,normalizationVersion:"v1"},browserBaselineDigest({persisted,shownFallback:fallback?.evidence??null}),NOW),persisted,shownFallback:fallback};},
    async save(input) {saves++;calls.push(input);if(rollback)throw new PersonProfileBrowserRetryableError();if(outcome!=="committed"&&outcome!=="already_committed")return {status:outcome};
      const receipt:Receipt={contractVersion:"1.0.0",receiptRef:"c".repeat(64),principalRef:ACTOR,personRef:PERSON,fields:[input.token.field],changeSetDigest:browserChangeSetDigest(input.token,input.canonicalValue),committedAt:NOW.toISOString()};
      persisted={kind:input.canonicalValue===""?"null":"present",value:input.canonicalValue,writtenAt:NOW.toISOString()} as BrowserProfilePrepared["persisted"];
      receipts.set(input.token.tokenRef,receipt);return{status:outcome,receipt};
    },
    async receiptStatus(token) {statuses++;return receipts.has(token.tokenRef)?{status:"committed",receipt:receipts.get(token.tokenRef)!}:{status:"not_found"};},
  };
  const service=createProfileBrowserEdit({authorize:async session=>authorized&&session===S?{actorRef:ACTOR,store}:null,secret:SECRET,secure:true,clock:{now:()=>new Date(clockTime)},choices:async()=>({countries:[{id:"11111111-1111-4111-8111-111111111111",name:"Country label"}],universities:[]})});
  return {service,store,calls,receipts,advance(ms:number){clockTime+=ms;},get prepares(){return prepares;},get saves(){return saves;},get statuses(){return statuses;},set persisted(v:typeof persisted){persisted=v;},set fallback(v:typeof fallback){fallback=v;},set outcome(v:typeof outcome){outcome=v;},revoke(){authorized=false;},rollback(){rollback=true;}};
}
const decode=(s:string)=>s.replaceAll("&quot;",'"').replaceAll("&#39;","'").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&amp;","&");
function tokenFrom(html:string):BrowserWriteToken {return JSON.parse(decode(/name="token" value="([^"]+)"/.exec(html)![1]!)) as BrowserWriteToken;}
async function open(x:ReturnType<typeof fixture>,field:PersonSelfEditField="objective") {return tokenFrom((await x.service.edit(S,field)).html);}
const proofFrom=(html:string)=>decode(/name="recovery" value="([^"]+)"/.exec(html)![1]!);
const body=(token:BrowserWriteToken,value:string)=>({token:JSON.stringify(token),value});

test("U2B_SAVE one Save canonicalizes and redirects, with no preview or general reads",async()=>{
  const x=fixture(), token=await open(x);const result=await x.service.submit(S,"objective",body(token,"Cafe\u0301"),"save");
  assert.equal(result.status,303,"U2B_SAVE redirect");assert.equal(result.location,"/profile#field-objective");assert.equal(x.saves,1);assert.equal(x.calls[0]!.canonicalValue,"Café","U2B_SAVE canonical string");
  assert.match(result.setCookie!,/Path=\/profile; HttpOnly; SameSite=Strict; Secure/);assert.doesNotMatch(result.setCookie!,/Café/);assert.equal(x.prepares,1);
  const boolean=await open(x,"drivingLicence");await x.service.submit(S,"drivingLicence",body(boolean,"false"),"save");assert.equal(x.calls[1]!.canonicalValue,"false");
  const clear=await open(x,"intro");await x.service.submit(S,"intro",body(clear,""),"save");assert.equal(x.calls[2]!.canonicalValue,"");
});
test("U2B_NOTICE shared-cookie two-tab handoff is receipt-verified and never names a field or value",async()=>{
  const x=fixture(),token=await open(x),saved=await x.service.submit(S,"objective",body(token,"Saved value"),"save");
  const before=x.prepares,notice=await x.service.notice(S,saved.setCookie);
  const generic="A profile change was saved. Your current profile is shown below.";
  assert.equal(notice.notice?.message,generic,"U2B_NOTICE generic receipt confirmation");assert.match(notice.clearCookie!,/Max-Age=0/);
  assert.equal(x.prepares,before,"U2B_NOTICE receipt-only notice");
  const tabB=await open(x,"intro"),savedB=await x.service.submit(S,"intro",body(tabB,"other tab secret"),"save");
  // Browser cookie jar now contains B's cookie even when A's redirected GET wins.
  const tabARender=await x.service.notice(S,savedB.setCookie);
  assert.equal(tabARender.notice?.message,generic,"U2B_NOTICE two-tab generic only");
  assert.doesNotMatch(JSON.stringify(tabARender.notice),/Objective|Introduction|Saved value|other tab secret/);
  assert.match(tabARender.clearCookie!,/Max-Age=0/);
  // A's first render clears the shared jar; B's subsequent render has no notice.
  assert.equal((await x.service.notice(S,undefined)).notice,undefined);
  assert.equal((await x.service.notice("other-session",saved.setCookie)).notice,undefined);
  assert.equal((await x.service.notice(S,saved.setCookie!.replace("studenthub_profile_notice=","studenthub_profile_notice=x"))).notice,undefined);
  const duplicate=await x.service.notice(S,`${saved.setCookie}; ${saved.setCookie}`);assert.equal(duplicate.notice,undefined);assert.match(duplicate.clearCookie!,/Max-Age=0/);
  const malformed=await x.service.notice(S,"studenthub_profile_notice=not.a.valid.notice");assert.equal(malformed.notice,undefined);assert.match(malformed.clearCookie!,/Max-Age=0/);
  x.advance(120000);const expired=await x.service.notice(S,saved.setCookie);assert.equal(expired.notice,undefined);assert.match(expired.clearCookie!,/Max-Age=0/);
  x.revoke();assert.equal((await x.service.notice(S,saved.setCookie)).notice,undefined);
});
test("U2B_NOTICE_AUTH notice authorization outage clears cookie without receipt disclosure",async()=>{
  const x=fixture(),token=await open(x),saved=await x.service.submit(S,"objective",body(token,"Saved value"),"save");
  let receiptReads=0;x.store.receiptStatus=async()=>{receiptReads++;throw Error("must not read receipt");};
  const unavailable=createProfileBrowserEdit({authorize:async()=>{throw Error("authorization database unavailable");},secret:SECRET,secure:true,clock:{now:()=>NOW}});
  const result=await unavailable.notice(S,saved.setCookie);
  assert.equal(result.notice,undefined,"U2B_NOTICE_AUTH no notice");assert.match(result.clearCookie!,/Max-Age=0/,"U2B_NOTICE_AUTH cookie consumed");assert.equal(receiptReads,0);
});
test("U2B_INVALID correction retains escaped draft but never phone, without saving",async()=>{
  const x=fixture(),token=await open(x),result=await x.service.submit(S,"objective",body(token," bad  <draft> "),"save");
  assert.equal(result.status,400);assert.equal(x.saves,0,"U2B_INVALID no save");assert.match(result.html,/ bad  &lt;draft&gt; /);assert.match(result.html,/aria-invalid="true"/);assert.match(result.html,/id="profile-error-summary"/);assert.match(result.html,/href="#field-objective"/);assert.deepEqual(tokenFrom(result.html),token);
  const phone=await open(x,"phone"),failed=await x.service.submit(S,"phone",body(phone,"phone-secret-123"),"save");assert.doesNotMatch(failed.html,/phone-secret-123/);assert.match(failed.html,/Enter your phone number again/);
});
test("U2B_RADIO omitted choices get linked correction without saving or repairing proof retries",async()=>{
  for (const field of ["gender","drivingLicence","jobSearchStatus","kuwaitiMother"] as const) {
    const x=fixture(),page=await x.service.edit(S,field),token=tokenFrom(page.html);
    const radios=[...page.html.matchAll(/<input[^>]+type="radio"[^>]*>/g)];assert.ok(radios.length);assert.ok(radios.every(match=>/ required(?: |>|=)/.test(match[0])),"U2B_RADIO required inputs");
    const r=await x.service.submit(S,field,{token:JSON.stringify(token)},"save");
    assert.equal(r.status,400);assert.match(r.html,/id="profile-error-summary"/,"U2B_RADIO correction summary");assert.match(r.html,new RegExp(`href="#field-${field}"`));assert.match(r.html,/Choose one of the available options/);assert.deepEqual(tokenFrom(r.html),token);assert.equal(x.saves,0);
    const extra=await x.service.submit(S,field,{token:JSON.stringify(token),unexpected:"x"},"save");assert.doesNotMatch(extra.html,/id="profile-error-summary"/);
    const incompleteRetry=await x.service.submit(S,field,{token:JSON.stringify(token),recovery:"invalid-proof"},"save");assert.doesNotMatch(incompleteRetry.html,/id="profile-error-summary"/);assert.equal(x.saves,0);
  }
});
test("U2B_CONFLICT_LABELS current choices show labels while submitted draft remains canonical",async()=>{
  const country="11111111-1111-4111-8111-111111111111",unknown="33333333-3333-4333-8333-333333333333";
  const cases:readonly [PersonSelfEditField,string,string,string][]=[
    ["nationality",country,country,"Country label"],["university",unknown,"","Current selection unavailable"],
    ["gender","female","male","Female"],["drivingLicence","false","true","No"],
    ["kuwaitiMother","false","true","No"],["jobSearchStatus","open_to_offers","active","Open to offers"],
  ];
  for(const [field,current,draft,label] of cases){const x=fixture(),token=await open(x,field);x.outcome="state_changed";x.persisted={kind:"present",value:current,writtenAt:NOW.toISOString()};const r=await x.service.submit(S,field,body(token,draft),"save");assert.equal(r.status,409);assert.ok(r.html.includes(`Current value: <bdi>${label}</bdi>`),`U2B_CONFLICT_LABELS ${field} display label`);assert.equal(x.calls[0]!.canonicalValue,draft);}
});
test("U2B_CONFLICT reloads atomic snapshot and preserves draft for explicit review",async()=>{
  const x=fixture(),token=await open(x);x.outcome="state_changed";x.persisted={kind:"present",value:"Fresh current",writtenAt:NOW.toISOString()};
  const r=await x.service.submit(S,"objective",body(token,"My draft"),"save");assert.equal(r.status,409);assert.match(r.html,/Current value: <bdi>Fresh current/);assert.match(r.html,/value="My draft"/);assert.notEqual(tokenFrom(r.html).tokenRef,token.tokenRef,"U2B_CONFLICT fresh token");assert.equal(x.saves,1);
  x.persisted={kind:"null",writtenAt:NOW.toISOString()};x.fallback={sourceField:"objective",value:"Hidden import",evidence:{sourceRef:"e".repeat(64),valueDigest:"f".repeat(64),revision:"1"}};
  assert.doesNotMatch((await x.service.edit(S,"objective")).html,/Hidden import/);
  x.persisted={kind:"null",writtenAt:null};const fallback=await x.service.edit(S,"objective");assert.match(fallback.html,/Hidden import/);
  const nationality=await x.service.edit(S,"nationality");assert.match(nationality.html,/value="11111111-1111-4111-8111-111111111111"/);assert.doesNotMatch(nationality.html,/value="Country label"/);
  x.persisted={kind:"present",value:"22222222-2222-4222-8222-222222222222",writtenAt:NOW.toISOString()};assert.match((await x.service.edit(S,"university")).html,/value="22222222-2222-4222-8222-222222222222" selected>Current selection \(unavailable\)/);
  const phone=await open(x,"phone");x.persisted={kind:"present",value:"+96511112222",writtenAt:NOW.toISOString()};const phoneR=await x.service.submit(S,"phone",body(phone,"+96555556666"),"save");assert.doesNotMatch(phoneR.html,/11112222|55556666/);
});
test("U2B_UNKNOWN status is receipt-only, retry retains token payload and phone requires reentry",async()=>{
  const x=fixture(),token=await open(x);x.outcome="unknown";const r=await x.service.submit(S,"objective",body(token,"Original draft"),"save");assert.equal(r.status,503);assert.match(r.html,/Check save status/);assert.match(r.html,/name="value" value="Original draft"/);assert.deepEqual(tokenFrom(r.html),token);
  const proof=proofFrom(r.html);const before=x.prepares;await x.service.submit(S,"objective",{...body(token,"Original draft"),recovery:proof},"status");assert.equal(x.prepares,before,"U2B_UNKNOWN no prepare on status");assert.equal(x.saves,1,"U2B_UNKNOWN no save on status");assert.equal(x.statuses,1);
  await x.service.submit(S,"objective",{...body(token,"Original draft"),recovery:proof},"save");assert.deepEqual(x.calls[0],x.calls[1],"U2B_UNKNOWN original retry");
  const phone=await open(x,"phone"),phoneR=await x.service.submit(S,"phone",body(phone,"+96555556666"),"save");assert.doesNotMatch(phoneR.html,/55556666/);assert.match(phoneR.html,/Enter the same phone number again/);
  await x.service.submit(S,"phone",{token:JSON.stringify(phone),recovery:proofFrom(phoneR.html)},"status");assert.equal(x.statuses,2);
  const count=x.saves;assert.equal((await x.service.submit(S,"phone",{...body(phone,"+96599998888"),recovery:proofFrom(phoneR.html)},"save")).status,409);assert.equal(x.saves,count,"U2B_UNKNOWN changed phone never submitted");
  const during=fixture(),dt=await open(during);during.store.validate=async()=>{during.revoke();return "choice";};const denied=await during.service.submit(S,"objective",body(dt,"revoked while validating"),"save");assert.equal(denied.status,401);assert.doesNotMatch(denied.html,/revoked while validating/);
  const revoked=fixture(),rt=await open(revoked);revoked.store.validate=async()=>"contact_unavailable";revoked.store.receiptStatus=async()=>({status:"not_authorized"});const refused=await revoked.service.submit(S,"objective",body(rt,"private revoked draft"),"save");assert.equal(refused.status,401);assert.doesNotMatch(refused.html,/private revoked draft/);
  const y=fixture(),yt=await open(y);y.rollback();assert.match((await y.service.submit(S,"objective",body(yt,"Retry"),"save")).html,/Nothing was saved, try again/);
});
async function request(x:ReturnType<typeof fixture>,options:{path?:string;data?:string;origin?:string;method?:string;cookie?:string;contentLength?:string}={}) {
  const req=Readable.from([options.data??""]) as IncomingMessage;req.url=options.path??(options.method==="GET"?"/profile/edit/objective":"/profile/edit/objective/save");req.method=options.method??"POST";req.headers={origin:options.origin??O,"content-type":"application/x-www-form-urlencoded",cookie:options.cookie??`__Host-studenthub_session=${S}`,...options.contentLength?{"content-length":options.contentLength}:{}};
  let status=0,html="";const headers:Record<string,unknown>={};const res={headersSent:false,setHeader(k:string,v:unknown){headers[k]=v;},writeHead(s:number,h:Record<string,unknown>){status=s;Object.assign(headers,h);},end(){},destroy(){}};
  const handled=await handleProfileBrowserEdit(req,res as unknown as ServerResponse,x.service,O,(s,_t,h)=>{status=s;html=h;});return{handled,status,html,headers};
}
test("U2B_SECURITY strict routes origin duplicates bounded body and revoked session fail closed",async()=>{
  const x=fixture(),token=await open(x),data=new URLSearchParams(body(token,"Draft")).toString();
  assert.equal((await request(x,{data,origin:"https://evil.invalid"})).status,403,"U2B_SECURITY origin");assert.equal(x.saves,0);
  assert.equal((await request(x,{data:data+"&value=duplicate"})).status,400);assert.equal((await request(x,{data,contentLength:"65537"})).status,400);
  assert.equal((await request(x,{data:"x="+"a".repeat(65537)})).status,400);
  for(const path of ["/profile/edit/preview","/profile/edit/confirm","/profile/edit/receipts/"+"a".repeat(64)])assert.equal((await request(x,{path,data})).handled,false);
  const ok=await request(x,{method:"GET"});assert.equal(ok.headers["cache-control"],"no-store");assert.doesNotMatch(ok.html,/\?token=/);
  const before=x.prepares;x.revoke();assert.equal((await request(x,{method:"GET"})).status,401);assert.equal(x.prepares,before);assert.equal((await request(x,{data})).status,401);assert.equal(x.saves,0);
});

// Run explicitly after build: U2B_MUTATIONS=1 node dist/apps/gateway/test/profile-browser-edit-http.test.js
// Mutate only generated JS, restore in finally, and require each named acceptance assertion to fail.
if (process.env.U2B_MUTATIONS === "1") {
  test("U2B_MUTANTS each acceptance guard kills its named mutant",async()=>{
    const target=new URL("../src/profile-browser-edit-http.js",import.meta.url),suite=fileURLToPath(import.meta.url),original=await readFile(target,"utf8");
    const mutations=[
      ["U2B_RADIO","RADIO_FIELDS.includes(field)","false"],
      ["U2B_CONFLICT_LABELS","current: displayCurrent(field, options.current, choices)","current: options.current"],
      ["U2B_SAVE","canonicalValue: validation.value","canonicalValue: body.value"],
      ["U2B_NOTICE",'message: "A profile change was saved. Your current profile is shown below."','message: `Saved ${LABELS[token.field]}`'],
      ["U2B_INVALID","const validation = validatePersonSelfEditValue(field, body.value, kuwaitDate(new Date(now())));","const validation = {ok:true,value:body.value};"],
      ["U2B_CONFLICT","render(session, field, fresh.token, body.value","render(session, field, token, body.value"],
      ["U2B_UNKNOWN",'if (mode === "status") {','if (mode === "status") { await auth.store.prepare(field);'],
      ["U2B_SECURITY","request.headers.origin !== origin || request.headers[\"sec-fetch-site\"] === \"cross-site\"","false"],
    ];
    try {for(const [name,from,to] of mutations){assert.equal(original.split(from!).length-1,1,`${name} mutation anchor`);await writeFile(target,original.replace(from!,to!));const run=spawnSync(process.execPath,[suite],{encoding:"utf8",env:{...process.env,U2B_MUTATIONS:"0"}});assert.notEqual(run.status,0,`${name} survived`);assert.match(run.stdout+run.stderr,new RegExp(`not ok \\d+ - ${name} `));assert.match(run.stdout+run.stderr,/ERR_ASSERTION/);console.log(`Killed ${name} mutant at its named assertion`);}}
    finally {await writeFile(target,original);}
  });
}
