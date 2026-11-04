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
function fixture(language: "en" | "ar" = "en", options: { authorizeThrows?: boolean; choicesThrow?: boolean; reauthorizeThrows?: boolean } = {}) {
  let authorizationCalls=0;
  const tokens=createBrowserWriteTokens({activeKeyVersion:"v1",keys:{v1:SECRET}});
  let persisted:BrowserProfilePrepared["persisted"]={kind:"present",value:"Before",writtenAt:NOW.toISOString()};
  let fallback:BrowserProfilePrepared["shownFallback"]=null, prepares=0,saves=0,statuses=0,authorized=true, rollback=false;
  let outcome:BrowserWriteOutcome["status"]="committed",clockTime=NOW.getTime();
  const receipts=new Map<string,Receipt>(), calls:{token:BrowserWriteToken;canonicalValue:string}[]=[];
  const store:BrowserProfileSession={
    async canEdit() {return true;},
    async prepare(field) {prepares++;if(!authorized)throw Error("revoked");return {token:tokens.issue({principalRef:ACTOR,personRef:PERSON,field,normalizationVersion:"v1"},browserBaselineDigest({persisted,shownFallback:fallback?.evidence??null}),NOW),persisted,shownFallback:fallback};},
    async save(input) {saves++;calls.push(input);if(rollback)throw new PersonProfileBrowserRetryableError();if(outcome!=="committed"&&outcome!=="already_committed")return {status:outcome};
      const receipt:Receipt={contractVersion:"1.0.0",receiptRef:"c".repeat(64),principalRef:ACTOR,personRef:PERSON,fields:[input.token.field],changeSetDigest:browserChangeSetDigest(input.token,input.canonicalValue),committedAt:NOW.toISOString()};
      persisted={kind:input.canonicalValue===""?"null":"present",value:input.canonicalValue,writtenAt:NOW.toISOString()} as BrowserProfilePrepared["persisted"];
      receipts.set(input.token.tokenRef,receipt);return{status:outcome,receipt};
    },
    async receiptStatus(token) {statuses++;return receipts.has(token.tokenRef)?{status:"committed",receipt:receipts.get(token.tokenRef)!}:{status:"not_found"};},
  };
  const service=createProfileBrowserEdit({authorize:async session=>{authorizationCalls++;if(options.authorizeThrows || options.reauthorizeThrows && authorizationCalls>1)throw Error("private authorization detail");return authorized&&session===S?{actorRef:ACTOR,store,language}:null;},secret:SECRET,secure:true,clock:{now:()=>new Date(clockTime)},choices:async()=>{if(options.choicesThrow)throw Error("private catalogue detail");return {countries:[{id:"11111111-1111-4111-8111-111111111111",name:"Country label"}],universities:[]};}});
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
test("U2B_MOTHER_ELIGIBILITY direct GET refuses Kuwaiti or missing nationality before issuing a token",async()=>{
  for(const nationality of ["KW",null,"BH"]){const x=fixture();x.store.canEdit=async field=>field!=="kuwaitiMother"||nationality==="BH";const r=await request(x,{method:"GET",path:"/profile/edit/kuwaitiMother"});
    if(nationality==="BH"){assert.equal(r.status,200);assert.match(r.html,/name="token"/);assert.equal(x.prepares,1);}else{assert.equal(r.status,403,"U2B_MOTHER_ELIGIBILITY refusal");assert.match(r.html,/This question applies only when your nationality is not Kuwaiti/);assert.doesNotMatch(r.html,/name="token"/);assert.equal(x.prepares,0,"U2B_MOTHER_ELIGIBILITY no prepare");}}
});
test("U2B_IMPORTED_CONFLICT current imported reference label is display-only and explicit clear hides it",async()=>{
  for(const field of ["nationality","university"] as const){const x=fixture(),token=await open(x,field),draft="11111111-1111-4111-8111-111111111111";x.outcome="state_changed";x.persisted={kind:"null",writtenAt:null};x.fallback={sourceField:field,value:"Imported <label>",evidence:{sourceRef:"e".repeat(64),valueDigest:"f".repeat(64),revision:"2"}};
    const r=await x.service.submit(S,field,body(token,draft),"save");assert.match(r.html,/Current value: <bdi dir="auto">Imported &lt;label&gt; \(imported\)<\/bdi>/,"U2B_IMPORTED_CONFLICT imported display");assert.equal(x.calls[0]!.canonicalValue,draft);assert.doesNotMatch(r.html,/value="Imported/);
    x.persisted={kind:"null",writtenAt:NOW.toISOString()};const cleared=await x.service.submit(S,field,body(token,draft),"save");assert.match(cleared.html,/Current value: <bdi dir="auto">Not recorded<\/bdi>/);assert.doesNotMatch(cleared.html,/Imported &lt;label&gt;/);assert.equal(x.calls[1]!.canonicalValue,draft);
  }
});
test("U2B_CONFLICT_LABELS current choices show labels while submitted draft remains canonical",async()=>{
  const country="11111111-1111-4111-8111-111111111111",unknown="33333333-3333-4333-8333-333333333333";
  const cases:readonly [PersonSelfEditField,string,string,string][]=[
    ["nationality",country,country,"Country label"],["university",unknown,"","Current selection unavailable"],
    ["gender","female","male","Female"],["drivingLicence","false","true","No"],
    ["kuwaitiMother","false","true","No"],["jobSearchStatus","open_to_offers","active","Open to offers"],
  ];
  for(const [field,current,draft,label] of cases){const x=fixture(),token=await open(x,field);x.outcome="state_changed";x.persisted={kind:"present",value:current,writtenAt:NOW.toISOString()};const r=await x.service.submit(S,field,body(token,draft),"save");assert.equal(r.status,409);assert.ok(r.html.includes(`Current value: <bdi dir="auto">${label}</bdi>`),`U2B_CONFLICT_LABELS ${field} display label`);assert.equal(x.calls[0]!.canonicalValue,draft);}
});
test("U2B_CONFLICT reloads atomic snapshot and preserves draft for explicit review",async()=>{
  const x=fixture(),token=await open(x);x.outcome="state_changed";x.persisted={kind:"present",value:"Fresh current",writtenAt:NOW.toISOString()};
  const r=await x.service.submit(S,"objective",body(token,"My draft"),"save");assert.equal(r.status,409);assert.match(r.html,/Current value: <bdi dir="auto">Fresh current/);assert.match(r.html,/value="My draft"/);assert.notEqual(tokenFrom(r.html).tokenRef,token.tokenRef,"U2B_CONFLICT fresh token");assert.equal(x.saves,1);
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
  let status=0,html="",language: "en" | "ar" | undefined;const headers:Record<string,unknown>={};const res={headersSent:false,setHeader(k:string,v:unknown){headers[k]=v;},writeHead(s:number,h:Record<string,unknown>){status=s;Object.assign(headers,h);},end(){},destroy(){}};
  const handled=await handleProfileBrowserEdit(req,res as unknown as ServerResponse,x.service,O,(s,_t,h,l)=>{status=s;html=h;language=l;});return{handled,status,html,headers,language};
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
      ["U2B_MOTHER_ELIGIBILITY",'field === "kuwaitiMother" && await auth.store.canEdit?.(field) !== true',"false"],
      ["U2B_IMPORTED_CONFLICT","options.currentImportedLabel !== undefined","false"],
      ["U2B_RADIO","RADIO_FIELDS.includes(field)","false"],
      ["U2B_CONFLICT_LABELS",'current: displayCurrent(field, options.current, choices, live.language ?? "en")',"current: options.current"],
      ["U2B_SAVE","canonicalValue: validation.value","canonicalValue: body.value"],
      ["U2B_NOTICE",'message: profileCopyText(auth.language ?? "en", "editor.noticeMessage")','message: `Saved ${token.field}`'],
      ["U2B_INVALID","const validation = validatePersonSelfEditValue(field, body.value, kuwaitDate(new Date(now())));","const validation = {ok:true,value:body.value};"],
      ["U2B_CONFLICT","render(session, field, fresh.token, body.value","render(session, field, token, body.value"],
      ["U2B_UNKNOWN",'if (mode === "status") {','if (mode === "status") { await auth.store.prepare(field);'],
      ["U2B_SECURITY","request.headers.origin !== origin || request.headers[\"sec-fetch-site\"] === \"cross-site\"","false"],
    ];
    try {for(const [name,from,to] of mutations){assert.equal(original.split(from!).length-1,1,`${name} mutation anchor`);await writeFile(target,original.replace(from!,to!));const run=spawnSync(process.execPath,[suite],{encoding:"utf8",env:{...process.env,U2B_MUTATIONS:"0"}});assert.notEqual(run.status,0,`${name} survived`);assert.match(run.stdout+run.stderr,new RegExp(`not ok \\d+ - ${name} `));assert.match(run.stdout+run.stderr,/ERR_ASSERTION/);console.log(`Killed ${name} mutant at its named assertion`);}}
    finally {await writeFile(target,original);}
  });
}


test("U3A_EDITOR_COPY uses authorized Arabic across edit validation conflict recovery and notice without translating payloads",async()=>{
  const x=fixture("ar");
  const ready=await x.service.edit(S,"objective");
  assert.equal(ready.language,"ar","U3A_EDITOR_COPY authorized locale");
  assert.match(ready.html,/العودة إلى ملفي الشخصي/);assert.match(ready.html,/>حفظ<|>احفظ</);assert.doesNotMatch(ready.html,/>Save<|>Cancel<|Edit Objective/);
  const token=tokenFrom(ready.html),invalid=await x.service.submit(S,"objective",body(token," Draft  double "),"save");
  assert.match(invalid.html,/أزل المسافات/);assert.match(invalid.html,/value=" Draft  double "/);assert.equal(x.saves,0);
  const radio=await x.service.edit(S,"gender");assert.match(radio.html,/value="male"/);assert.match(radio.html,/ذكر/);assert.doesNotMatch(radio.html,/>Male</);
  x.persisted={kind:"present",value:"New <name>",writtenAt:NOW.toISOString()};x.outcome="state_changed";
  const conflict=await x.service.submit(S,"objective",body(token,"My draft"),"save");assert.match(conflict.html,/New &lt;name&gt;/);assert.match(conflict.html,/value="My draft"/);assert.match(conflict.html,/تغيّرت هذه القيمة/);assert.doesNotMatch(conflict.html,/Current value|Your draft/);
  x.outcome="unknown";const unknown=await x.service.submit(S,"objective",body(token,"Same draft"),"save");assert.match(unknown.html,/التحقق من حالة الحفظ/);assert.doesNotMatch(unknown.html,/Check save status|Save not confirmed/);
  const phone=await open(x,"phone"),phoneFailure=await x.service.submit(S,"phone",body(phone,"+96555556666"),"save");assert.doesNotMatch(phoneFailure.html,/55556666/);assert.match(phoneFailure.html,/رقم الهاتف نفسه/);
  const y=fixture("ar"),saved=await y.service.submit(S,"objective",body(await open(y),"Saved value"),"save"),notice=await y.service.notice(S,saved.setCookie);
  assert.equal(notice.notice?.title,"تم تأكيد الحفظ");assert.equal(notice.notice?.message,"تم حفظ تغيير في الملف الشخصي. يظهر ملفك الشخصي الحالي أدناه.");assert.doesNotMatch(notice.notice!.message,/Saved value/);
});
test("U3A_EDITOR_SHELL passes the resolved locale to the document writer",async()=>{
  for(const language of ["en","ar"] as const){const response=await request(fixture(language),{method:"GET"});assert.equal(response.language,language,"U3A_EDITOR_SHELL writer locale");assert.equal((response.html.match(/<main /g)??[]).length,1);assert.doesNotMatch(response.html,/<html|class="skip"/);}
});
test("U3A_EDITOR_EXPIRED preserves the last authorized locale without disclosing drafts",async()=>{
  const x=fixture("ar"),prepare=x.store.prepare.bind(x.store);
  x.store.prepare=async field=>{const result=await prepare(field);x.revoke();return result;};
  const result=await x.service.edit(S,"objective");
  assert.equal(result.status,401);assert.equal(result.language,"ar");assert.match(result.html,/سجّل الدخول|سجل الدخول/);assert.doesNotMatch(result.html,/Before|name="token"/);
  const firstExpired=fixture("ar");firstExpired.revoke();const unknownLocale=await firstExpired.service.edit(S,"objective");assert.equal(unknownLocale.status,401);assert.equal(unknownLocale.language,"en","U3A_EDITOR_EXPIRED no trusted locale defaults English");
});


test("U3A_EDITOR_BIDI imported selection isolates escaped data without interpreting placeholders",async()=>{
  for(const language of ["en","ar"] as const){
    const x=fixture(language);x.persisted={kind:"null",writtenAt:null};
    x.fallback={sourceField:"nationality",value:"جامعة <Mixed> {value} & label",evidence:{sourceRef:"e".repeat(64),valueDigest:"f".repeat(64),revision:"1"}};
    const page=await x.service.edit(S,"nationality");
    assert.match(page.html,/<bdi dir="auto">جامعة &lt;Mixed&gt; \{value\} &amp; label<\/bdi>/,"U3A_EDITOR_BIDI isolated imported label");
    assert.equal((page.html.match(/<bdi dir="auto">/g)??[]).length,1);
    assert.match(page.html,/<option dir="auto" value="11111111-1111-4111-8111-111111111111">Country label<\/option>/,"U3A_EDITOR_BIDI native option direction");
    assert.doesNotMatch(page.html,/<Mixed>|value="جامعة/);
  }
});


test("U3A_EDITOR_UNAVAILABLE HTTP preserves only an already-authorized locale through unexpected failures",async()=>{
  const unavailable="خدمة الملف الشخصي غير متاحة. حاول مجدداً.";
  const check=(response:Awaited<ReturnType<typeof request>>,language:"en"|"ar")=>{
    assert.equal(response.status,503,"U3A_EDITOR_UNAVAILABLE unchanged failure status");
    assert.equal(response.language,language,"U3A_EDITOR_UNAVAILABLE trusted locale");
    assert.ok(response.html.includes(language==="ar"?unavailable:"The profile service is unavailable. Please try again."));
    assert.doesNotMatch(response.html,/private |secret-draft|Before|name="token"|name="value"/,"U3A_EDITOR_UNAVAILABLE generic no disclosure");
  };
  const prepare=fixture("ar");prepare.store.prepare=async()=>{throw Error("private prepare detail");};check(await request(prepare,{method:"GET"}),"ar");assert.equal(prepare.saves,0);
  const choices=fixture("ar",{choicesThrow:true});check(await request(choices,{method:"GET",path:"/profile/edit/nationality"}),"ar");assert.equal(choices.saves,0);
  const receipts=fixture("ar"),receiptToken=await open(receipts);receipts.outcome="unknown";
  const pending=await receipts.service.submit(S,"objective",body(receiptToken,"secret-draft"),"save");
  receipts.store.receiptStatus=async()=>{throw Error("private receipt detail");};
  check(await request(receipts,{path:"/profile/edit/objective/status",data:new URLSearchParams({...body(receiptToken,"secret-draft"),recovery:proofFrom(pending.html)}).toString()}),"ar");assert.equal(receipts.saves,1,"U3A_EDITOR_UNAVAILABLE status never writes");
  const recovery=fixture("ar",{reauthorizeThrows:true});const recoveryToken=(await recovery.store.prepare("objective")).token;recovery.outcome="unknown";
  check(await request(recovery,{data:new URLSearchParams(body(recoveryToken,"secret-draft")).toString()}),"ar");assert.equal(recovery.saves,1,"U3A_EDITOR_UNAVAILABLE no retry on failed recovery authorization");
  const initial=fixture("ar",{authorizeThrows:true});check(await request(initial,{method:"GET"}),"en");assert.equal(initial.prepares,0);assert.equal(initial.saves,0);
  // A later request cannot inherit the locale of an earlier Arabic request.
  check(await request(fixture("en",{choicesThrow:true}),{method:"GET",path:"/profile/edit/nationality"}),"en");
});
