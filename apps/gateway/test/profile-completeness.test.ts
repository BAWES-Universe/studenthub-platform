import assert from "node:assert/strict";
import test from "node:test";
import { projectApprovedProfile, SYNTHETIC_PROFILE_FIXTURES, type OwnProfileProjection, type PendingProfileRequirement } from "@studenthub/profile";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";

const projection=(pending:readonly PendingProfileRequirement[]):OwnProfileProjection=>{const value=projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated,"2026-09-13");const field={...value.fields.pendingFields,state:"available" as const,value,freshness:{kind:"derived" as const,observedAt:"2026-09-13T00:00:00.000Z"}};const language={state:"available" as const,value:"en" as const,provenance:value.fields.language.provenance,freshness:{kind:"derived" as const,observedAt:"2026-09-13T00:00:00.000Z"}};return {...value,fields:{...value.fields,language,pendingFields:{...field,value:pending},isProfileCompleted:{...field,value:pending.length===0}}};};
const login=(browser=false)=>({profile:async()=>({status:503 as const,body:{error:"login_unavailable" as const}}),...(browser?{browserEdit:{}}:{})}) as unknown as BrowserLoginApplication;

test("Q14_4_CHECKLIST checklist is directly after summary and every target is exact",async()=>{
  const items=["display_name","arabic_name","objective","gender","birth_date","phone","driving_licence","nationality","kuwaiti_mother","location","civil_id","civil_expiry","personal_photo","civil_front","civil_back","education","skill","email"] as const;
  const html=(await profileDocument({status:200,body:projection(items)},login(true))).html;
  assert.ok(html.indexOf('id="profile-summary"')<html.indexOf("To finish your profile"));
  assert.ok(html.indexOf("To finish your profile")<html.indexOf('class="p-sections"'));
  const targets:Record<string,string>={display_name:"/profile/edit/displayName",arabic_name:"/profile/edit/arabicName",objective:"/profile/edit/objective",gender:"/profile/edit/gender",birth_date:"/profile/edit/birthDate",phone:"/profile/edit/phone",driving_licence:"/profile/edit/drivingLicence",nationality:"/profile/edit/nationality",kuwaiti_mother:"/profile/edit/kuwaitiMother",location:"#field-area",civil_id:"#field-civilId",civil_expiry:"#field-civilId",personal_photo:"/profile/documents",civil_front:"/profile/documents",civil_back:"/profile/documents",education:"/profile/background",skill:"/profile/background"};
  for(const [item,target] of Object.entries(targets))assert.match(html,new RegExp(`href="${target.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}"[^>]*>[^<]*${item==="personal_photo"?"Personal photo":""}`),item);
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
