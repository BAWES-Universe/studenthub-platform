import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES, type OwnProfileProjection, type PendingProfileRequirement } from "@studenthub/profile";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";
import { enterProfileCompletenessRequest, handleProfileCompleteness, recordProfileCompletenessPrincipal } from "../src/profile-completeness.js";
import { enterProfileAvatarRequest, prepareProfileAvatar } from "../src/profile-avatar.js";
import type { GatewayRouteContext } from "../src/routes/context.js";

const projection=(pending:readonly PendingProfileRequirement[]):OwnProfileProjection=>{const value=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-09-13");const field={...value.fields.pendingFields,state:"available" as const,value,freshness:{kind:"derived" as const,observedAt:"2026-09-13T00:00:00.000Z"}};const language={state:"available" as const,value:"en" as const,provenance:value.fields.language.provenance,freshness:{kind:"derived" as const,observedAt:"2026-09-13T00:00:00.000Z"}};return {...value,fields:{...value.fields,language,pendingFields:{...field,value:pending},isProfileCompleted:{...field,value:pending.length===0}}};};
const login=(browser=false)=>({profile:async()=>({status:503 as const,body:{error:"login_unavailable" as const}}),...(browser?{browserEdit:{}}:{})}) as unknown as BrowserLoginApplication;

test("Q14_4_CHECKLIST checklist is directly after summary and every target is exact",async()=>{
  const items=["display_name","arabic_name","objective","gender","birth_date","phone","driving_licence","nationality","kuwaiti_mother","location","civil_id","civil_expiry","personal_photo","civil_front","civil_back","education","skill","email"] as const;
  const html=(await profileDocument({status:200,body:projection(items)},login(true))).html;
  assert.ok(html.indexOf('id="profile-summary"')<html.indexOf("To finish your profile"));
  assert.ok(html.indexOf("To finish your profile")<html.indexOf('class="p-sections"'));
  const targets:Record<string,string>={display_name:"/profile/edit/displayName",arabic_name:"/profile/edit/arabicName",objective:"/profile/edit/objective",gender:"/profile/edit/gender",birth_date:"/profile/edit/birthDate",phone:"/profile/edit/phone",driving_licence:"/profile/edit/drivingLicence",nationality:"/profile/edit/nationality",kuwaiti_mother:"/profile/edit/kuwaitiMother",location:"#field-area",civil_id:"#field-civilId",civil_expiry:"#field-civilId",personal_photo:"/profile/documents",civil_front:"/profile/documents",civil_back:"/profile/documents",education:"/profile/background",skill:"/profile/background"};
  const words:Record<string,string>={display_name:"Display name",arabic_name:"Arabic name",objective:"Objective",gender:"Gender",birth_date:"Birth date",phone:"Phone number",driving_licence:"Driving licence",nationality:"Nationality",kuwaiti_mother:"Kuwaiti mother",location:"Location",civil_id:"Civil ID",civil_expiry:"Civil ID expiry",personal_photo:"Personal photo",civil_front:"Civil ID front",civil_back:"Civil ID back",education:"Education",skill:"Skill"};
  for(const [item,target] of Object.entries(targets))assert.match(html,new RegExp(`<a href="${target.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}">${words[item]}</a>`),item);
  assert.match(html,/Email[^<]*<span class="p-meta">comes from your Universe account<\/span>/);
  const section=html.slice(html.indexOf('class="p-card p-completeness"'),html.indexOf('class="p-sections"'));
  assert.doesNotMatch(section,/<dt>|data-state="unavailable"/);
});

test("Q14_4_CHECKLIST row anchors are used without browser edit and complete state has no list",async()=>{
  const missing=(await profileDocument({status:200,body:projection(["display_name","nationality"])},login())).html;
  assert.match(missing,/href="#field-displayName"/);assert.match(missing,/href="#field-nationality"/);
  const complete=(await profileDocument({status:200,body:projection([])},login())).html;
  assert.match(complete,/Profile complete/);assert.doesNotMatch(complete,/To finish your profile/);
});

test("Q14_4_DERIVED unavailable completeness is escaped and never claims complete",async()=>{
  const value=projection([]);const failed={...value.fields.pendingFields,state:"unavailable" as const,reason:"check_failed" as const};
  const html=(await profileDocument({status:200,body:{...value,fields:{...value.fields,pendingFields:failed,isProfileCompleted:failed}}},login())).html;
  assert.match(html,/Couldn&#39;t check right now/);assert.doesNotMatch(html,/>Profile complete</);
});

async function gatewayProfile(format:"json"|"html",size:number,fail?:"documents"|"records"|"choices",change?:"photo"|"objective") {
  const SESSION="s".repeat(43), projected=projection([]), available=<T>(value:T)=>({state:"available" as const,value,provenance:projected.fields.pendingFields.provenance,freshness:{kind:"written_by_person" as const,observedAt:"2026-09-13T12:00:00.000Z"}}),initial={...projected,fields:{...projected.fields,nationality:{...projected.fields.nationality,editValue:"kw"},phone:available("+96512345678"),civilId:available({country:"KW" as const,maskedNumber:"••••1234",expiry:"2030-01-01",needsReview:false})}}, unavailable={...initial.fields.objective,state:"unavailable" as const,reason:"not_recorded" as const},profile=change==="objective"?{...initial,fields:{...initial.fields,objective:unavailable}}:initial; let principalReads=0,preferencesReads=0,backgroundReads=0,documentReads=0,choiceReads=0;
  const request=Readable.from([]) as unknown as IncomingMessage; request.method="GET";request.url="/profile";request.headers={accept:format==="html"?"text/html":"application/json",cookie:`__Host-studenthub_session=${SESSION}`};
  const response=new EventEmitter() as EventEmitter&{statusCode:number;body:string;headers:Record<string,string>;writeHead(s:number,h?:Record<string,string>):void;end(v?:unknown):void};
  response.statusCode=0;response.body="";response.headers={};response.writeHead=(s,h={})=>{response.statusCode=s;response.headers=h};response.end=v=>{response.body+=v??""};
  const rows=[{id:"education",kind:"education"},{id:"skill",kind:"skill"},...Array.from({length:size},(_,index)=>({id:String(index),kind:index%2?"skill":"education"}))];
  const documents=[...change==="photo"?[]:[{id:"photo",type:"personal-photo"}],{id:"front",type:"civil-id-front"},{id:"back",type:"civil-id-back"},...Array.from({length:size},(_,index)=>({id:String(index),type:"resume"}))];
  const documentService={async list(){documentReads++;if(fail==="documents")throw new Error("documents");return documents},async issueDelivery(){return{url:"/avatar"}}};
  enterProfileAvatarRequest(request);
  if(format==="html")await prepareProfileAvatar(request,response as unknown as ServerResponse,documentService as never);
  enterProfileCompletenessRequest();
  const nationality=profile.fields.nationality, nationalityId=nationality.state==="available"?nationality.editValue:"kw";
  const login={profile:async()=>({status:200 as const,body:{personId:"person-1"}}),web:{profiles:{async readOwn(){principalReads++;preferencesReads++;recordProfileCompletenessPrincipal({id:"person-1",email:"person@example.invalid",pbuuids:[]});return{kind:"found" as const,profile}}}},profileEdit:{async choices(){choiceReads++;if(fail==="choices")throw new Error("choices");return{countries:[{id:nationalityId??"kw",code:"KW",name:"Kuwait"}],universities:[]}}}};
  const context={request,response,login,documents:documentService,profileRecords:{service:{async background(){backgroundReads++;if(fail==="records")throw new Error("records");return{education:rows.filter(x=>x.kind==="education"),skill:rows.filter(x=>x.kind==="skill")}}}},authz:{store:{getPrincipal:async()=>{throw new Error("second principal read")}},writeHtml:undefined},writeHtml:(res:ServerResponse,status:number,html:string)=>{response.statusCode=status;response.body=html},renderError:()=>"error",pageDocument:()=>"",catalogue:undefined,organizationDocuments:undefined} as unknown as GatewayRouteContext;
  assert.equal(await handleProfileCompleteness(context),true);return{response,counts:{principalReads,preferencesReads,backgroundReads,documentReads,choiceReads}};
}

test("Q14_4_DERIVED GET profile JSON and HTML expose derived fields and failures fail closed",async()=>{
  for(const format of ["json","html"] as const){const ok=await gatewayProfile(format,3);assert.equal(ok.response.statusCode,200);if(format==="json"){const body=JSON.parse(ok.response.body) as OwnProfileProjection;assert.equal(body.fields.pendingFields.freshness.kind,"derived");assert.equal(body.fields.isProfileCompleted.freshness.kind,"derived");assert.equal(body.fields.isProfileCompleted.state==="available"&&body.fields.isProfileCompleted.value,true)}else{assert.match(ok.response.body,/Profile complete/);assert.doesNotMatch(ok.response.body,/Checked once your documents are on file/)}
    for(const source of ["documents","records","choices"] as const){const failed=await gatewayProfile(format,3,source);if(format==="json"){const body=JSON.parse(failed.response.body) as OwnProfileProjection;assert.equal(body.fields.pendingFields.state,"unavailable");assert.equal(body.fields.pendingFields.state==="unavailable"&&body.fields.pendingFields.reason,"check_failed")}else{assert.match(failed.response.body,/Couldn&#39;t check right now/);assert.doesNotMatch(failed.response.body,/>Profile complete</)}}}
});

test("Q14_4_SHOWN S1 and S2 render changes and keep read counts fixed for 0, 1, and 40 rows",async()=>{
  for(const format of ["json","html"] as const)for(const size of [0,1,40]){const result=await gatewayProfile(format,size);assert.deepEqual(result.counts,{principalReads:1,preferencesReads:1,backgroundReads:1,documentReads:1,choiceReads:1})}
  const complete=await gatewayProfile("html",3);assert.match(complete.response.body,/Profile complete/);
  const noPhoto=await gatewayProfile("html",3,undefined,"photo");assert.match(noPhoto.response.body,/Personal photo/);assert.doesNotMatch(noPhoto.response.body,/>Profile complete</);assert.doesNotMatch(noPhoto.response.body,/Civil ID front|Civil ID back/);
  const noObjective=await gatewayProfile("html",3,undefined,"objective");assert.match(noObjective.response.body,/Objective/);assert.doesNotMatch(noObjective.response.body,/Personal photo/);
});
