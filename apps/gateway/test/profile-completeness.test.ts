import assert from "node:assert/strict";
import test from "node:test";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
const { gatherProfileCompleteness } = await import(process.env.SHU594_COMPLETENESS_MODULE ?? "../src/profile-completeness.js");
const { profileDocument } = await import(process.env.SHU594_WEB_UI_MODULE ?? "../src/web-ui.js");

const provenance = (sourceField: string) => ({ system: "studenthub-production-approved-import" as const, revision: PROFILE_PARITY_REVISION, sourceField });
function completeProfile(language: "en"|"ar" = "en"): OwnProfileProjection {
  const fields: Record<string, unknown> = {};
  for (const key of OWN_PROFILE_FIELD_NAMES) fields[key] = { state:"unavailable", reason:"not_recorded", provenance:provenance(key), freshness:{kind:"not_imported",observedAt:""} };
  const available = (key:string,value:unknown, editValue?:string) => fields[key]={state:"available",value,provenance:provenance(key),freshness:{kind:"written_by_person",observedAt:"2026-11-12T00:00:00Z"},...(editValue?{editValue}:{})};
  available("displayName","Noor"); available("arabicName","نور"); available("gender","female"); available("objective","Work"); available("birthDate","2000-01-01"); available("nationality","Bahraini","bh"); available("drivingLicence",false); available("area","Kuwait City"); available("phone","+96550000000"); available("kuwaitiMother",false); available("language",language);
  return { version:OWN_PROFILE_VERSION, asOfDate:"2026-11-12", fields } as unknown as OwnProfileProjection;
}
function evidence(profile=completeProfile()) {
  const counts={background:0,choices:0,civil:0};
  return { counts, input:{principalId:"person",email:"person@universe.invalid",profile,
    avatar:{documents:[{type:"personal-photo"},{type:"civil-id-front"},{type:"civil-id-back"}] as never[]},
    records:{service:{async background(){counts.background++;return {education:[{}],skill:[{}]};}}} as never,
    dependencies:{async choices(){counts.choices++;return {countries:[{id:"bh",code:"BH"}]};},civilId:{async readOwn(){counts.civil++;return {maskedNumber:"••••1234",expiry:"2030-01-01"} as never;}}},
  }};
}

test("Q14_4_DERIVED Q14_4_NOWRITE derives available fields once and never stores", async()=>{
  const fixture=evidence(), gathered=await gatherProfileCompleteness(fixture.input);
  assert.deepEqual(fixture.counts,{background:1,choices:1,civil:1});
  assert.deepEqual(gathered.result,{kind:"available",pendingFields:[]}, "Q14_4_DERIVED cached documents");
  assert.equal(gathered.profile.fields.isProfileCompleted.state,"available");
  assert.equal(gathered.profile.fields.isProfileCompleted.state === "available" && gathered.profile.fields.isProfileCompleted.value,true);
  assert.equal(gathered.profile.fields.pendingFields.freshness.kind,"derived");
  const rendered=await profileDocument({status:200,body:gathered.profile},{civilId:{} as never},undefined,true,undefined,gathered.result);
  assert.match(rendered.html,/<h2>Profile complete<\/h2>/, "Q14_4_DERIVED complete heading");
});

test("Q14_4_STATUS failed evidence is unavailable without claiming complete",async()=>{
  const fixture=evidence(); fixture.input.dependencies.civilId.readOwn=async()=>{throw Error("down")};
  const gathered=await gatherProfileCompleteness(fixture.input);
  assert.deepEqual(gathered.result,{kind:"unavailable",reason:"check_failed"}, "Q14_4_STATUS unavailable result");
  assert.equal(gathered.profile.fields.isProfileCompleted.state,"unavailable");
  const {html}=await profileDocument({status:200,body:gathered.profile},{civilId:{} as never},undefined,false,undefined,gathered.result);
  assert.match(html,/<h2>Couldn&#39;t check right now<\/h2>/, "Q14_4_STATUS failure heading"); assert.doesNotMatch(html,/<h2>Profile complete<\/h2>/);
});

test("Q14_4_CHECKLIST Q14_4_ORDER words and targets stay paired",async()=>{
  const pending=["display_name","phone","civil_front","education","email"] as const;
  const profile=completeProfile(); const {html}=await profileDocument({status:200,body:profile},{browserEdit:{} as never,civilId:{} as never},undefined,true,undefined,{kind:"available",pendingFields:pending});
  assert.match(html,/<h2>To finish your profile<\/h2><ul><li><a href="\/profile\/edit\/displayName">Display name<\/a><\/li><li><a href="\/profile\/edit\/phone">Phone number<\/a><\/li><li><a href="\/profile\/documents">Civil ID front<\/a><\/li><li><a href="\/profile\/background">Education<\/a><\/li><li>Email <span>comes from your Universe account<\/span><\/li><\/ul>/, "Q14_4_CHECKLIST exact links");
  const arabic=completeProfile("ar"), rendered=await profileDocument({status:200,body:arabic},{browserEdit:{} as never,civilId:{} as never},undefined,true,undefined,{kind:"available",pendingFields:["personal_photo"]});
  assert.match(rendered.html,/<li><a href="\/profile\/documents">الصورة الشخصية<\/a><\/li>/);
});

test("Q14_4_RENDER_PURE no result adds no checklist and preserves imported freshness",async()=>{
  const profile=completeProfile(); const {html}=await profileDocument({status:200,body:profile},{});
  assert.doesNotMatch(html,/p-checklist/); assert.equal(profile.fields.isProfileCompleted.freshness.kind,"not_imported");
});
