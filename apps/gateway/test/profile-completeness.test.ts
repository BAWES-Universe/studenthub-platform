import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { OwnProfileRepository, UnconfiguredApprovedProfileAdapter, type OwnProfileProjection, type PendingProfileRequirement } from "@studenthub/profile";
import { createLoginApplication } from "../src/login-application.js";
import { PROFILE_COPY, type ProfileLanguage } from "../src/ui/profile-copy.js";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";
const { createGatewayServer } = await import(process.env.SHU581_GATEWAY_MODULE ?? "../src/index.js");

const SESSION = "c".repeat(43);
const requirements: readonly PendingProfileRequirement[] = ["nationality","display_name","arabic_name","gender","objective","personal_photo","email","phone","birth_date","civil_id","civil_expiry","civil_front","civil_back","driving_licence","location","education","skill"];
type Options = { language?: ProfileLanguage; missing?: PendingProfileRequirement; empty?: boolean; mother?: boolean; records?: number; fail?: "documents"|"background"|"choices"|"civil"; noCivil?: boolean };

async function baseProfile(): Promise<OwnProfileProjection> {
  const authz = new InMemoryAuthzStore({ principals: [{ id: "person-1", pbuuids: [] }], organizations: [] });
  const repository = new OwnProfileRepository({ principals: authz, source: new UnconfiguredApprovedProfileAdapter() });
  const result = await repository.readOwn({ requesterPrincipalId: "person-1", targetPersonId: "person-1" });
  assert.equal(result.kind, "found"); return (result as { profile: OwnProfileProjection }).profile;
}

async function projection(options: Options): Promise<OwnProfileProjection> {
  const base = await baseProfile();
  const available = (name: string, value: unknown) => ({ ...(base.fields as Record<string, object>)[name], state: "available", value, editValue: value, freshness: { kind: "written_by_person", observedAt: "2026-11-11T00:00:00.000Z" } });
  const fields = { ...base.fields } as Record<string, unknown>;
  if (!options.empty) Object.assign(fields, { language: available("language", options.language ?? "en"), displayName: available("displayName", "Noor"), arabicName: available("arabicName", "نور"), gender: available("gender", "female"), objective: available("objective", "Build things"), phone: available("phone", "+96512345678"), birthDate: available("birthDate", "2000-01-01"), nationality: available("nationality", "kw"), drivingLicence: available("drivingLicence", false), area: available("area", "Kuwait City") });
  else if (options.language) fields.language = available("language", options.language);
  if (options.mother) fields.nationality = available("nationality", "other");
  if (options.missing) {
    const names: Partial<Record<PendingProfileRequirement,string>> = { nationality:"nationality",display_name:"displayName",arabic_name:"arabicName",gender:"gender",objective:"objective",phone:"phone",birth_date:"birthDate",driving_licence:"drivingLicence",location:"area" };
    const name = names[options.missing]; if (name) fields[name] = { ...(base.fields as Record<string, object>)[name], state: "unavailable", reason: "not_recorded", freshness: { kind: "written_by_person", observedAt: "2026-11-11T00:00:00.000Z" } };
  }
  return { ...base, fields } as OwnProfileProjection;
}

async function route(t: TestContext, options: Options = {}) {
  const profile = await projection(options); let principals=0,preferences=0,lists=0,deliveries=0,backgrounds=0,choices=0,civil=0;
  const rig = createSyntheticLoginRig(createLoginApplication); await rig.sessions.put({ id:SESSION, personId:"person-1" });
  const login = { ...rig.app, async profile(request: Parameters<typeof rig.app.profile>[0]) { principals++; const result=await rig.app.profile(request); return result.status===200&&!options.empty?{...result,body:{...result.body,email:"noor@example.test"}}:result; }, browserEdit:{ async notice(){return {};} }, profileEdit:{ async choices(){ choices++; if(options.fail==="choices")throw Error("choices"); return { countries:[{id:"kw",code:"KW",name:"Kuwait"},{id:"other",code:"SA",name:"Saudi Arabia"}], universities:[] }; } }, ...(options.noCivil?{}:{civilId:{async readOwn(){civil++;if(options.fail==="civil")throw Error("civil");return options.empty?null:{maskedNumber:"••••1234",expiry:"2030-01-01"};}}}), web:{origin:"https://profile.invalid",profiles:{async readOwn(request:{targetPersonId:string}){preferences++;return request.targetPersonId==="person-1"?{kind:"found",profile}:{kind:"not_found"};}}} } as unknown as BrowserLoginApplication;
  const count=options.records??1, rows=Array.from({length:count},(_,index)=>({id:String(index)}));
  const docs = options.empty?[]:[{id:"photo",version:"v",type:"personal-photo",mime:"image/png",size:1},{id:"front",version:"v",type:"civil-id-front",mime:"image/png",size:1},{id:"back",version:"v",type:"civil-id-back",mime:"image/png",size:1}]; if(options.missing==="personal_photo")docs.shift();
  const documents={async list(){lists++;if(options.fail==="documents")throw Error("documents");return docs;},async issueDelivery(){deliveries++;return{url:"/delivery",expiresAt:1};}};
  const profileRecords={service:{async background(){backgrounds++;if(options.fail==="background")throw Error("background");return{education:options.empty||options.missing==="education"?[]:rows,experience:[],skill:options.empty||options.missing==="skill"?[]:rows,link:[],removed:[]};}},sessions:rig.sessions,origin:"https://profile.invalid",async options(){return[];}};
  const server=createGatewayServer(undefined,undefined,undefined,login,null,undefined,documents as never,undefined,profileRecords as never); await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); t.after(()=>{server.closeAllConnections();server.close();}); const address=server.address();assert.ok(address&&typeof address!=="string");
  const get=(accept="text/html",query="")=>fetch(`http://127.0.0.1:${address.port}/profile${query}`,{headers:{accept,cookie:`__Host-studenthub_session=${SESSION}`}}); return{get,profile,counts:()=>({principals,preferences,lists,deliveries,backgrounds,choices,civil})};
}

const re=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const target=(r:PendingProfileRequirement)=>({nationality:"/profile/edit/nationality",display_name:"/profile/edit/displayName",arabic_name:"/profile/edit/arabicName",gender:"/profile/edit/gender",objective:"/profile/edit/objective",personal_photo:"/profile/documents",phone:"/profile/edit/phone",birth_date:"/profile/edit/birthDate",civil_id:"#field-civilId",civil_expiry:"#field-civilId",civil_front:"/profile/documents",civil_back:"/profile/documents",driving_licence:"/profile/edit/drivingLicence",location:"#field-area",education:"/profile/background",skill:"/profile/background"} as Partial<Record<PendingProfileRequirement,string>>)[r];

for(const language of ["en","ar"] as const)test(`Q14_4_CHECKLIST real profile route joins every ${language} item to its target`,async t=>{const f=await route(t,{empty:true,language});const response=await f.get(),html=await response.text();assert.equal(response.status,200);for(const requirement of requirements){const words=re(PROFILE_COPY[language][`pending.${requirement}`]),href=target(requirement);if(href)assert.match(html,new RegExp(`<li><a href="${re(href)}">${words}</a></li>`),`${requirement} words must carry their own target`);else assert.match(html,new RegExp(`<li>${words} — ${re(PROFILE_COPY[language]["profile.emailUniverse"])}</li>`),"email words must have Universe explanation and no link");}const at=html.indexOf('class="p-card p-checklist"'),checklist=html.slice(at,html.indexOf("</section>",at));assert.doesNotMatch(checklist,/<dt|data-state="unavailable"/);});
for(const language of ["en","ar"] as const)test(`Q14_4_CHECKLIST real profile route joins ${language} Kuwaiti-mother item to its target`,async t=>{const f=await route(t,{mother:true,language});const html=await(await f.get()).text();assert.match(html,new RegExp(`<li><a href="/profile/edit/kuwaitiMother">${re(PROFILE_COPY[language]["pending.kuwaiti_mother"])}</a></li>`),"kuwaiti_mother words must carry their own target");});

test("Q14_4_SHOWN real profile route shows complete, then exactly one removed photo and one cleared field",async t=>{const complete=await route(t);assert.match(await(await complete.get()).text(),/>Profile complete<\/h2>/,"complete evidence must show Profile complete");const photo=await route(t,{missing:"personal_photo"});assert.match(await(await photo.get()).text(),/<ul><li><a href="\/profile\/documents">Personal photo<\/a><\/li><\/ul>/,"removed photo must be sole item");const field=await route(t,{missing:"display_name"});assert.match(await(await field.get()).text(),/<ul><li><a href="\/profile\/edit\/displayName">Display name<\/a><\/li><\/ul>/,"cleared field must be sole item");});
test("Q14_4_DERIVED Q14_4_LABELS real profile route exposes derived values and provenance without storing",async t=>{const f=await route(t,{missing:"display_name"});const response=await f.get(),html=await response.text();assert.equal(response.status,200);assert.match(html,/Profile completeness/);assert.match(html,/Still to do/);assert.match(html,/Worked out from your profile/);assert.doesNotMatch(html,/Checked once your documents are on file/);assert.equal("storedCompleteness" in f.profile,false,"derived result must not be stored on the source projection");assert.deepEqual(f.counts(),{principals:1,preferences:1,lists:1,deliveries:1,backgrounds:1,choices:1,civil:1},"derivation uses fixed read seams and performs no write");});
for(const failed of ["documents","background","choices","civil"] as const)test(`Q14_4_STATUS real profile route keeps 200 when ${failed} fails`,async t=>{const f=await route(t,{fail:failed});const response=await f.get(),html=await response.text();assert.equal(response.status,200);assert.match(html,/Couldn't check right now/);assert.doesNotMatch(html,/>Profile complete<\/h2>|>Complete<\/bdi>/,"failed evidence must not claim complete");});
test("Q14_4_STATUS real profile route without civil ID is unavailable and has no dead civil link",async t=>{const f=await route(t,{noCivil:true}),html=await(await f.get()).text();assert.match(html,/Couldn't check right now/);assert.doesNotMatch(html,/href="#field-civilId"/);});
test("Q14_4_SHOWN counting fakes stay fixed for 0, 1 and 40 records",async t=>{for(const records of [0,1,40]){const f=await route(t,{records});await f.get();assert.deepEqual(f.counts(),{principals:1,preferences:1,lists:1,deliveries:1,backgrounds:1,choices:1,civil:1},`fixed reads for ${records} records`);}});
test("Q14_4_JSON real profile route leaves repository JSON unchanged and performs no completeness reads",async t=>{const f=await route(t),response=await f.get("application/json"),body=await response.json() as {fields:Record<string,{state:string}>};assert.equal(body.fields.isProfileCompleted.state,"unavailable");assert.equal(body.fields.pendingFields.state,"unavailable");assert.deepEqual(f.counts(),{principals:1,preferences:1,lists:0,deliveries:0,backgrounds:0,choices:0,civil:0});});
test("Q14_4_COMPAT real profile route rejects another person",async t=>{const f=await route(t);assert.equal((await f.get("text/html","?person_id=other")).status,404);});
test("Q14_4_RENDER_PURE renderer without gathered completeness adds no checklist or derived freshness",async()=>{const profile=await projection({});const page=await profileDocument({status:200,body:profile},{browserEdit:{async notice(){return{};}}} as never);assert.doesNotMatch(page.html,/p-checklist|Worked out from your profile/);});
