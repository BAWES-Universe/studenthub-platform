import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { CivilIdVault, InMemoryCivilIdStore, OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, createCivilId, type CivilIdCountry, type OwnProfileProjection } from "@studenthub/profile";
import { renderCivilIdRow } from "../src/civil-id-http.js";
import { handleCivilIdSuggestion, renderCivilIdSuggestion, type CivilIdSuggestionService, type CivilIdSuggestionView } from "../src/civil-id-suggestion-http.js";
import { pageDocument, profileDocument, writeHtml } from "../src/web-ui.js";

const PERSON="person", OTHER="other", SESSION="s".repeat(43), ID="11111111-1111-4111-8111-111111111111", ID2="22222222-2222-4222-8222-222222222222", NOW=new Date("2026-11-11T10:00:00.000Z"), PLAIN="290010101234";
const suggestion=(overrides:Partial<CivilIdSuggestionView>={}):CivilIdSuggestionView=>({id:ID,state:"read",last4:"1234",country:"KW",expiry:"2027-03-01",expired:false,...overrides});

test("OCRP_LINE rendered states contain only the last four digits and expired has no accept",async()=>{
  const read=renderCivilIdSuggestion("en",suggestion());assert.match(read,/We read a number ending 1234, expiring 2027-03-01\. Is this right\?/);assert.equal((read.match(/<form/g)??[]).length,2);assert.match(read,/action="\/profile\/civil-id\/suggestion\/accept"/);assert.match(read,/action="\/profile\/civil-id\/suggestion\/dismiss"/);assert.equal((read.match(/name="suggestionId"/g)??[]).length,2);assert.doesNotMatch(read,new RegExp(PLAIN));
  const expired=renderCivilIdSuggestion("en",suggestion({expired:true,expiry:"2020-01-05"}));assert.match(expired,/The date we read \(2020-01-05\) has passed/);assert.doesNotMatch(expired,/suggestion\/accept/);assert.equal((expired.match(/<form/g)??[]).length,1);assert.match(expired,/href="\/profile\/documents"/);
  for(const state of["pending","running"]as const)assert.match(renderCivilIdSuggestion("en",suggestion({state})),/We are reading your photo/);for(const state of["unreadable","failed"]as const){const html=renderCivilIdSuggestion("en",suggestion({state}));assert.match(html,/We could not read your photo/);assert.match(html,/href="\/profile\/civil-id"/);}
  assert.doesNotMatch(renderCivilIdSuggestion("en",suggestion({last4:null})),/null/);assert.doesNotMatch(renderCivilIdSuggestion("en",suggestion({expiry:null})),/null/);assert.equal(renderCivilIdSuggestion("en",null),"");
  const profile=emptyProfile(),without=await profileDocument({status:200,body:profile}as never,{}),answered={...profile};Object.defineProperty(answered,"civilIdSuggestion",{value:null,enumerable:false});const withAnswered=await profileDocument({status:200,body:answered}as never,{});assert.equal(withAnswered.html,without.html);assert.equal((without.html.match(/data-state="unavailable"/g)??[]).length,19);
});

function fixture(options:{current?:CivilIdSuggestionView|null;number?:string;country?:CivilIdCountry;owner?:string;replayAnswered?:boolean}={}) {
  const vault=new CivilIdVault(Buffer.alloc(32,9)),civilStore=new InMemoryCivilIdStore(),civilId=createCivilId({store:civilStore,vault,clock:{now:()=>NOW}}),owner=options.owner??PERSON,country=options.country??"KW",sealed=vault.seal(owner,country,options.number??PLAIN);
  let current:CivilIdSuggestionView|null="current" in options?options.current??null:suggestion({country}),resolved:string|null=null,opens=0,reads=0;const answered=new Set<string>();
  const service:CivilIdSuggestionService={civilId,vault,clock:{now:()=>NOW},store:{async currentSuggestion(person){reads++;return person===owner&&current&&(options.replayAnswered||!answered.has(current.id))?current:null;},async openForAccept(id,person){opens++;return current?.id===id&&person===owner&&(options.replayAnswered||!answered.has(id))?{country,ciphertext:sealed.ciphertext}:null;},async resolve(id,person,how){if(id!==current?.id||person!==owner||answered.has(id))return false;answered.add(id);resolved=how;return true;}}};
  return{service,civilStore,setCurrent(value:CivilIdSuggestionView|null){current=value;},get resolved(){return resolved;},get opens(){return opens;},get reads(){return reads;}};
}

class TrackingBody extends Readable { reads=0; constructor(private readonly value:string){super();} _read(){this.reads++;this.push(this.value);this.push(null);} }
async function post(f:ReturnType<typeof fixture>,path:string,fields:Record<string,string>={suggestionId:ID},headers:Record<string,string>={},principal=PERSON){
  const encoded=new URLSearchParams(fields).toString(),request=new TrackingBody(encoded) as TrackingBody&{method?:string;url?:string;headers:Record<string,string>};request.method="POST";request.url=path;request.headers={cookie:`__Host-studenthub_session=${SESSION}`,origin:"https://studenthub.test","content-type":"application/x-www-form-urlencoded","content-length":String(Buffer.byteLength(encoded)),...headers};
  const response=new EventEmitter() as EventEmitter&{status:number;headers:Record<string,string>;body:string;writeHead(status:number,headers:Record<string,string>):void;end(value?:unknown):void};response.status=0;response.headers={};response.body="";response.writeHead=(status,h)=>{response.status=status;response.headers=Object.fromEntries(Object.entries(h).map(([k,v])=>[k.toLowerCase(),String(v)]));};response.end=value=>{response.body+=value===undefined?"":String(value);};
  await handleCivilIdSuggestion(request as never,response as never,f.service,"https://studenthub.test",async token=>token===SESSION?principal:undefined,(status,title,body)=>writeHtml(response as never,status,pageDocument(title,body)));
  return{status:response.status,headers:response.headers,body:response.body,bodyReads:request.reads};
}

test("OCRP_ACCEPT accept uses CIV and pins success, duplicate, expiry, Kuwait and Bahrain rules",async()=>{
  const f=fixture(),result=await post(f,"/profile/civil-id/suggestion/accept");assert.equal(result.status,303);assert.equal(result.headers.location,"/profile#field-civilId");assert.equal(f.opens,1);assert.equal(f.resolved,"accepted");const saved=await f.service.civilId.readOwn(PERSON);assert.equal(saved?.maskedNumber,"•••• •••• 1234");assert.equal(saved?.expiry,"2027-03-01");assert.equal(saved?.needsReview,true);const after=renderCivilIdRow("en",saved)+renderCivilIdSuggestion("en",null);assert.match(after,/Waiting for StudentHub to check/);assert.doesNotMatch(after,/We read a number/);
  const duplicate=fixture();await duplicate.service.civilId.save({principalId:OTHER,submissionId:"33333333-3333-4333-8333-333333333333",revision:0,country:"KW",number:PLAIN,expiry:"2027-03-01"});await refused(duplicate,/already in use/);
  await refused(fixture({current:suggestion({expiry:"2020-01-05",expired:true})}),/This civil ID has expired/);await refused(fixture({number:"12345678901"}),/Enter a valid civil ID number/);await refused(fixture({country:"BH",number:"12345678",current:suggestion({country:"BH",last4:"5678"})}),/Enter a valid civil ID number/);
});
async function refused(f:ReturnType<typeof fixture>,message:RegExp){const result=await post(f,"/profile/civil-id/suggestion/accept");assert.match(result.body,message);assert.equal(f.resolved,null);assert.equal(f.civilStore.events.filter(e=>e.principalId===PERSON).length,0);assert.equal((await f.service.store.currentSuggestion(PERSON,"2026-11-11"))?.id,ID);assert.doesNotMatch(JSON.stringify(result),new RegExp(PLAIN));}

test("OCRP_STALE retries save once and every stale or foreign suggestion is refused",async()=>{
  const retry=fixture({replayAnswered:true});assert.equal((await post(retry,"/profile/civil-id/suggestion/accept")).status,303);assert.equal((await post(retry,"/profile/civil-id/suggestion/accept")).status,409);assert.equal(retry.civilStore.events.length,1);
  for(const f of[fixture({current:null}),fixture({current:suggestion({id:ID2})}),fixture({owner:OTHER})]){const result=await post(f,"/profile/civil-id/suggestion/accept");assert.equal(result.status,409);assert.equal(f.opens,0);assert.equal(f.civilStore.events.length,0);}
  const answered=fixture();await post(answered,"/profile/civil-id/suggestion/dismiss");assert.equal((await post(answered,"/profile/civil-id/suggestion/accept")).status,409);assert.equal(answered.civilStore.events.length,0);const foreign=fixture({owner:OTHER});assert.equal((await post(foreign,"/profile/civil-id/suggestion/dismiss")).status,409);assert.equal(foreign.resolved,null);
});

test("OCRP_DISMISS changes no civil ID and a later photo starts again",async()=>{const f=fixture(),result=await post(f,"/profile/civil-id/suggestion/dismiss");assert.equal(result.status,303);assert.equal(result.headers.location,"/profile/civil-id");assert.equal(f.resolved,"dismissed");assert.equal(f.opens,0);assert.equal(f.civilStore.events.length,0);assert.equal(await f.service.store.currentSuggestion(PERSON,"2026-11-11"),null);f.setCurrent(suggestion({id:ID2}));assert.equal((await f.service.store.currentSuggestion(PERSON,"2026-11-11"))?.id,ID2);});

test("OCRP_ORIGIN cookie origin fetch metadata and closed fields are enforced no-store",async()=>{
  const attempts=[{headers:{origin:"https://evil.test"},fields:{suggestionId:ID},status:403,unread:true},{headers:{"sec-fetch-site":"cross-site"},fields:{suggestionId:ID},status:403,unread:true},{headers:{cookie:"",authorization:"Bearer token"},fields:{suggestionId:ID},status:401},{headers:{},fields:{},status:400},{headers:{},fields:{suggestionId:ID,number:PLAIN},status:400}] as const;
  for(const attempt of attempts){const f=fixture(),result=await post(f,"/profile/civil-id/suggestion/dismiss",attempt.fields,attempt.headers);assert.equal(result.status,attempt.status);assert.equal(result.headers["cache-control"],"no-store");assert.equal(f.reads,0);assert.equal(f.civilStore.events.length,0);if("unread"in attempt)assert.equal(result.bodyReads,0);}
});

test("OCRP_SECRECY plain and sealed numbers stay server-side and open exists only in accept",async()=>{
  assert.doesNotMatch(renderCivilIdSuggestion("en",suggestion()),new RegExp(PLAIN));
  for(const [f,path]of[[fixture(),"/profile/civil-id/suggestion/dismiss"],[fixture({current:null}),"/profile/civil-id/suggestion/accept"],[fixture({number:"12345678901"}),"/profile/civil-id/suggestion/accept"]]as const){const result=await post(f,path);assert.doesNotMatch(JSON.stringify(result),new RegExp(PLAIN));assert.equal(result.headers.location?.includes(PLAIN)??false,false);if(path.endsWith("dismiss"))assert.equal(f.opens,0);}
  const files=readdirSync("apps/gateway/src",{recursive:true}).filter(file=>String(file).endsWith(".ts"));const hits=files.flatMap(file=>readFileSync(`apps/gateway/src/${String(file)}`,"utf8").includes("service.vault.open(")?[String(file)]:[]);assert.deepEqual(hits,["civil-id-suggestion-http.ts"]);const source=readFileSync("apps/gateway/src/civil-id-suggestion-http.ts","utf8");assert.ok(source.indexOf("service.vault.open(")>source.indexOf('path.endsWith("/dismiss")'));
});

test("OCRP_SHOWN suggestion is directly below Civil ID, absent from JSON, and one projection read supplies one render",async()=>{const profile=emptyProfile();let reads=0;Object.defineProperty(profile,"civilIdSuggestion",{get(){reads++;return suggestion();},enumerable:false});const rendered=await profileDocument({status:200,body:profile}as never,{civilId:{}as never});assert.ok(rendered.html.indexOf('id="field-civilId"')<rendered.html.indexOf("We read a number ending 1234"));assert.equal((rendered.html.match(/We read a number ending 1234/g)??[]).length,1);assert.doesNotMatch(JSON.stringify(profile),/civilIdSuggestion|1234/);assert.equal((rendered.html.match(/data-state="unavailable"/g)??[]).length,19);assert.equal(reads,1);});

function emptyProfile(){const fields:Record<string,unknown>={};for(const key of OWN_PROFILE_FIELD_NAMES)fields[key]={state:"unavailable",freshness:{kind:"not_imported"},provenance:{system:"studenthub-production-approved-import",revision:PROFILE_PARITY_REVISION,sourceField:key}};return{version:OWN_PROFILE_VERSION,fields}as unknown as OwnProfileProjection;}
