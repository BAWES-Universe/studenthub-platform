import assert from "node:assert/strict";
import test from "node:test";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
import { applyProfileCompleteness } from "../src/profile-completeness.js";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";

const base = (): OwnProfileProjection => {
  const fields: Record<string, unknown> = {};
  for (const key of OWN_PROFILE_FIELD_NAMES) fields[key] = { state:"unavailable", reason:"not_recorded", provenance:{system:"studenthub-production-approved-import",revision:PROFILE_PARITY_REVISION,sourceField:key}, freshness:{kind:"not_imported",observedAt:""} };
  Object.assign(fields, { language:{...fields.language as object,state:"available",value:"en",freshness:{kind:"written_by_person",observedAt:"2026-11-11"}}, displayName:{...fields.displayName as object,state:"available",value:"Student",freshness:{kind:"written_by_person",observedAt:"2026-11-11"}} });
  return { version:OWN_PROFILE_VERSION, asOfDate:"2026-11-11", fields } as OwnProfileProjection;
};
const login = { browserEdit:{}, profileEdit:{ choices:async()=>({countries:[],universities:[]}) } } as unknown as BrowserLoginApplication;

test("Q14_4_CHECKLIST words and exact targets render directly after summary without detail rows", async()=>{
  const pending = ["display_name","location","civil_id","personal_photo","education","email"] as const;
  const profile = applyProfileCompleteness(base(),{kind:"available",pendingFields:pending});
  const {html}=await profileDocument({status:200,body:profile},login);
  assert.ok(html.indexOf("profile-summary") < html.indexOf("To finish your profile"));
  for(const [words,target] of [["Display name","/profile/edit/displayName"],["Location","#field-area"],["Civil ID","#field-civilId"],["Personal photo","/profile/documents"],["Education","/profile/background"]]) assert.match(html,new RegExp(`<a href="${target}">${words}</a>`));
  assert.match(html,/Email <span>comes from your Universe account<\/span>/); assert.doesNotMatch(html,/href="[^"]+">Email/);
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
