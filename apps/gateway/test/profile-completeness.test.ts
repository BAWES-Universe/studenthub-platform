import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
import { applyProfileCompleteness } from "../src/profile-completeness.js";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";
import { PROFILE_COPY } from "../src/ui/profile-copy.js";
import { createGatewayServer } from "../src/index.js";
import { observeCivilIdFailure, observeProfilePrincipal } from "../src/profile-completeness.js";

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

async function route(t: TestContext, options: { fail?: "records"|"choices"|"documents"|"civil" } = {}) {
  const counts={principal:0,preferences:0,records:0,documents:0,choices:0,civil:0,delivery:0};
  const projection=base();
  (projection.fields as Record<string,unknown>).civilId={state:"available",value:{country:"KW",maskedNumber:"••••1234",expiry:"2030-01-01",needsReview:false},provenance:(projection.fields.displayName as never as {provenance:unknown}).provenance,freshness:{kind:"written_by_person",observedAt:"2026-11-11"}};
  const app={profile:async()=>{counts.principal++;return{status:200,body:{personId:"person-1"}}},logout:async()=>({status:204}),start:async()=>({status:404}),callback:async()=>({status:404}),
    web:{origin:"https://example.invalid",profiles:{readOwn:async()=>{counts.preferences++;observeProfilePrincipal("person-1","person@universe.invalid");if(options.fail==="civil")observeCivilIdFailure();return{kind:"found",profile:projection}}},},
    profileEdit:{choices:async()=>{counts.choices++;if(options.fail==="choices")throw Error("choices");return{countries:[],universities:[]}}},
    civilId:{readOwn:async()=>{counts.civil++;if(options.fail==="civil")throw Error("civil");return null}},
  } as unknown as BrowserLoginApplication;
  const documents={list:async()=>{counts.documents++;if(options.fail==="documents")throw Error("documents");return[]},issueDelivery:async()=>{counts.delivery++;return{url:"/never",expiresAt:1}}} as never;
  const records={service:{background:async()=>{counts.records++;if(options.fail==="records")throw Error("records");return{education:[],skill:[]}}}} as never;
  const server=createGatewayServer(undefined,undefined,undefined,app,undefined,undefined,documents,undefined,records);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();server.close()});
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const get=(accept:string)=>fetch(`http://127.0.0.1:${address.port}/profile`,{headers:{accept,cookie:`__Host-studenthub_session=${"s".repeat(43)}`}});
  return{counts,get,projection};
}

test("Q14_4_JSON real route leaves repository completeness untouched and reads no evidence",async t=>{const f=await route(t);const response=await f.get("application/json");assert.equal(response.status,200);const body=await response.json() as OwnProfileProjection;assert.deepEqual(body.fields.pendingFields,f.projection.fields.pendingFields);assert.deepEqual(f.counts,{principal:1,preferences:1,records:0,documents:0,choices:0,civil:0,delivery:0});});

test("Q14_4_STATUS evidence failures keep the real HTML route at 200",async t=>{for(const fail of ["records","choices","documents","civil"] as const){const f=await route(t,{fail});const response=await f.get("text/html");assert.equal(response.status,200,fail);assert.match(await response.text(),/Couldn&#39;t check right now/,fail);}});

test("Q14_4_SHOWN one HTML page uses fixed-count evidence reads",async t=>{const f=await route(t);const response=await f.get("text/html");assert.equal(response.status,200);const html=await response.text();assert.doesNotMatch(html,/Checked once your documents are on file|Couldn&#39;t check right now/);assert.match(html,/To finish your profile/);assert.deepEqual(f.counts,{principal:1,preferences:1,records:1,documents:1,choices:1,civil:0,delivery:0});});

test("Q14_4_COMPAT fixed closed-name order follows the real derivation",()=>{const derived=applyProfileCompleteness(base(),{kind:"available",pendingFields:["nationality","display_name","email"]});assert.deepEqual(derived.fields.pendingFields.state==="available"?derived.fields.pendingFields.value:[],["nationality","display_name","email"]);});

test("Q14_4_LABELS detail labels come from bilingual profile copy",async()=>{for(const language of ["en","ar"] as const){const html=(await profileDocument({status:200,body:base(language)},login)).html;assert.ok(html.includes(PROFILE_COPY[language]["field.isProfileCompleted"]));assert.ok(html.includes(PROFILE_COPY[language]["field.pendingFields"]));}});
