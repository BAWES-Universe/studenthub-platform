import assert from "node:assert/strict";
import test from "node:test";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
import { applyProfileCompleteness } from "../src/profile-completeness.js";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";
import { PROFILE_COPY } from "../src/ui/profile-copy.js";

const base = (language: "en" | "ar" = "en"): OwnProfileProjection => {
  const fields: Record<string, unknown> = {};
  for (const key of OWN_PROFILE_FIELD_NAMES) fields[key] = { state:"unavailable", reason:"not_recorded", provenance:{system:"studenthub-production-approved-import",revision:PROFILE_PARITY_REVISION,sourceField:key}, freshness:{kind:"not_imported",observedAt:""} };
  Object.assign(fields, { language:{...fields.language as object,state:"available",value:language,freshness:{kind:"written_by_person",observedAt:"2026-11-11"}}, displayName:{...fields.displayName as object,state:"available",value:"Student",freshness:{kind:"written_by_person",observedAt:"2026-11-11"}} });
  return { version:OWN_PROFILE_VERSION, asOfDate:"2026-11-11", fields } as OwnProfileProjection;
};
const login = { browserEdit:{}, profileEdit:{ choices:async()=>({countries:[],universities:[]}) } } as unknown as BrowserLoginApplication;

test("Q14_4_CHECKLIST words and exact targets render directly after summary without detail rows", async()=>{
  const pending = ["display_name","arabic_name","gender","objective","personal_photo","phone","birth_date","nationality","civil_id","civil_expiry","civil_front","civil_back","driving_licence","location","kuwaiti_mother","education","skill","email"] as const;
  const targets: Record<string,string|undefined>={display_name:"/profile/edit/displayName",arabic_name:"/profile/edit/arabicName",gender:"/profile/edit/gender",objective:"/profile/edit/objective",personal_photo:"/profile/documents",phone:"/profile/edit/phone",birth_date:"/profile/edit/birthDate",nationality:"/profile/edit/nationality",civil_id:"#field-civilId",civil_expiry:"#field-civilId",civil_front:"/profile/documents",civil_back:"/profile/documents",driving_licence:"/profile/edit/drivingLicence",location:"#field-area",kuwaiti_mother:"/profile/edit/kuwaitiMother",education:"/profile/background",skill:"/profile/background",email:undefined};
  const profile = applyProfileCompleteness(base(),{kind:"available",pendingFields:pending});
  const {html}=await profileDocument({status:200,body:profile},login);
  assert.ok(html.indexOf("profile-summary") < html.indexOf("To finish your profile"));
  for(const language of ["en","ar"] as const){const rendered=(await profileDocument({status:200,body:applyProfileCompleteness(base(language),{kind:"available",pendingFields:pending})},login)).html;for(const requirement of pending){const words=PROFILE_COPY[language][`pending.${requirement}`];const target=targets[requirement];if(target)assert.ok(rendered.includes(`<a href="${target}">${words}</a>`),`${language} ${requirement} words and target`);else{assert.ok(rendered.includes(words));assert.doesNotMatch(rendered,new RegExp(`href="[^"]+">${words}`));}}}
  assert.match(html,/Email <span>comes from your Universe account<\/span>/);
  for(const key of OWN_PROFILE_FIELD_NAMES) assert.match(html,new RegExp(`id="field-${key}"`));
  const section=html.match(/<section class="p-card p-checklist">[\s\S]*?<\/section>/)?.[0]??""; assert.doesNotMatch(section,/<dt>|data-state="unavailable"/);
});

test("Q14_4_DERIVED complete and failed states are exclusive and derived",async()=>{
  const complete=applyProfileCompleteness(base(),{kind:"available",pendingFields:[]});
  assert.equal(complete.fields.isProfileCompleted.state,"available"); assert.equal(complete.fields.isProfileCompleted.freshness.kind,"derived");
  assert.match((await profileDocument({status:200,body:complete},login)).html,/Profile complete/);
  const failed=applyProfileCompleteness(base(),{kind:"unavailable",reason:"check_failed"});
  const html=(await profileDocument({status:200,body:failed},login)).html;
  assert.match(html,/Couldn&#39;t check right now/); assert.doesNotMatch(html,/<h2>Profile complete<\/h2>/);
});
