import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import test from "node:test";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
import { PROFILE_COPY, type ProfileLanguage } from "../src/ui/profile-copy.js";
import { PROFILE_KIT_CSS } from "../src/ui/profile-kit.js";
import { createGatewayServer } from "../src/index.js";
import { profileDocument, pageDocument, renderLanding, renderError, renderWorkspace, renderCompanyDirectory, type BrowserLoginApplication } from "../src/web-ui.js";

const country = "22222222-2222-4222-8222-222222222222";
function fixture(language: ProfileLanguage, empty = false): OwnProfileProjection {
  const fields: Record<string, unknown> = {};
  for (const key of [...OWN_PROFILE_FIELD_NAMES,"phone","handle","kuwaitiMother"]) fields[key] = {
    state:"unavailable",freshness:{kind:"imported_snapshot",observedAt:"2026-11-04T00:00:00.000Z"},provenance:{system:"studenthub-production-approved-import",revision:PROFILE_PARITY_REVISION,sourceField:key},
  };
  const put = (key: string, value: unknown, written = false, editValue?: string) => { fields[key] = {...fields[key] as object,state:"available",value,...(editValue ? {editValue} : {}),freshness:{kind:written ? "written_by_person" : "imported_snapshot",observedAt:"2026-11-04T00:00:00.000Z"}}; };
  put("language",language,true);
  fields.preferredTime = {...fields.preferredTime as object,freshness:{kind:"written_by_person",observedAt:"2026-11-04T00:00:00.000Z"}};
  if (!empty) {
    put("displayName","Noor Al-Sabah",true); put("arabicName","نور الصباح",true); put("objective","Build better experiences",true);
    put("intro", "A long readable introduction ".repeat(80),true);put("gender","female");put("jobSearchStatus","open_to_offers",true);
    put("phone","+96550001234",true);put("handle","noor-profile",true);put("nationality","Jordan",true,country);put("university","Kuwait University",true,country);put("kuwaitiMother",false,true);
    put("birthDate","2000-01-05",true);put("age",26,true);put("pendingFields",["civil_front","nationality"]);put("drivingLicence",true);put("committed",false);put("civilExpired",false);
  }
  return {version:OWN_PROFILE_VERSION,fields} as unknown as OwnProfileProjection;
}
const login = {browserEdit:{},profileEdit:{async choices(){return {countries:[{id:country,name:"Jordan",code:"JO"}],universities:[]};}},preferences:{},navigation:{}} as unknown as BrowserLoginApplication;
const render = (language: ProfileLanguage, empty = false) => profileDocument({status:200,body:fixture(language,empty)},login);

function shell(html: string, language: ProfileLanguage) {
  assert.ok(html.includes(`<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">`),"U3A_SHELL document locale");
  assert.equal((html.match(/<main\b/g) ?? []).length,1,"U3A_SHELL one main");
  assert.equal((html.match(/class="skip"/g) ?? []).length,1,"U3A_SHELL one skip link");
}
function journey(html: string, language: ProfileLanguage) {
  const ids = ["profile-summary","section-work","section-personal","section-background","section-details"];
  let before = -1;
  for (const id of ids) { const at = html.indexOf(`id="${id}"`);assert.ok(at > before,`U3A_JOURNEY ${id} order`);before=at; }
  assert.equal((html.match(/id="field-jobSearchStatus"/g) ?? []).length,1,"U3A_JOURNEY single work status");
  for (const key of ["displayName","arabicName","objective","intro","preferredTime","gender","birthDate","drivingLicence","jobSearchStatus","phone","handle","nationality","university","kuwaitiMother"]) {
    assert.ok(html.includes(`href="/profile/edit/${key}"`),`U3A_JOURNEY edit ${key}`);
    assert.ok(html.includes(`aria-label="${PROFILE_COPY[language]["action.editField"].replace("{field}",PROFILE_COPY[language][`field.${key}` as keyof typeof PROFILE_COPY.en])}"`),`U3A_JOURNEY edit name ${key}`);
  }
  assert.match(html,/<bdi[^>]*dir="auto"[^>]*>Noor Al-Sabah<\/bdi>/,"U3A_JOURNEY isolated person name");
  assert.match(html,/<bdi[^>]*dir="ltr"[^>]*>\+965 5000 1234<\/bdi>/,"U3A_JOURNEY isolated phone");
  assert.ok(html.includes(PROFILE_COPY[language]["profile.sources"]),"U3A_JOURNEY provenance available");
  assert.match(html,/id="field-language"[^]*?href="#profile-language"/,"U3A_JOURNEY language points to real control");
}
function truthful(html: string) {assert.doesNotMatch(html,/Read-only|editing isn.t enabled yet|Approved imported snapshot/,"U3A_COPY no contradictory profile copy");}

test("U3A_SHELL: Arabic preference sets the document, English is explicit, one main and skip",async()=>{
  for(const language of ["en","ar"] as const){shell((await render(language)).html,language);shell(pageDocument("Editor",'<main id="main">Safe editor</main>',language),language);}
});
test("U3A_SHELL: actual asset endpoint serves all kit CSS",async t=>{
  const server=createGatewayServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert.ok(address&&typeof address!=="string");const response=await fetch(`http://127.0.0.1:${address.port}/assets/studenthub.css`);assert.equal(response.status,200);assert.ok((await response.text()).includes(PROFILE_KIT_CSS),"U3A_SHELL kit CSS served");
});
test("U3A_JOURNEY: coherent grouped profile, one work status, full current editable model and bidi",async()=>{for(const language of ["en","ar"] as const)journey((await render(language)).html,language);});
test("U3A_COPY: truthful current profile and localized ready/empty strings",async()=>{
  for(const language of ["en","ar"] as const)for(const empty of [false,true]){const {html}=await render(language,empty);truthful(html);shell(html,language);assert.ok(html.includes(PROFILE_COPY[language]["value.missing"]));if(language==="ar")assert.doesNotMatch(html,/>\s*(?:My profile|Edit|Save|Cancel|Personal details|About my work|Sources and update history|Not recorded|Unavailable|Read-only|Looking for work|Change language)\s*</,"U3A_COPY Arabic journey has no English UI labels");}
});
test("U3A_PROVENANCE: never-imported fields disclose no invented import date in either language",async()=>{
  for(const language of ["en","ar"] as const){
    const profile=fixture(language,true);
    const fields={...profile.fields,objective:{...profile.fields.objective,freshness:{kind:"not_imported" as const,observedAt:""}}};
    const {html}=await profileDocument({status:200,body:{...profile,fields}},login);
    assert.ok(html.includes(`<dt>${PROFILE_COPY[language]["field.objective"]}</dt><dd>${PROFILE_COPY[language]["meta.notImported"]}</dd>`),"U3A_PROVENANCE never imported is explicit");
    assert.ok(!html.includes(PROFILE_COPY[language]["meta.imported"].replace("{date}","")+"<"),"U3A_PROVENANCE no empty imported date");
  }
});
test("U3A_JOURNEY: person markup is escaped, supplementary characters and long text survive",async()=>{
  const p=fixture("ar");const attack='<script>alert("x")</script>😀';const fields={...p.fields,displayName:{...p.fields.displayName,state:"available",value:attack}};
  const {html}=await profileDocument({status:200,body:{...p,fields}},login);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;😀/);assert.ok(html.includes("A long readable introduction ".repeat(80)));
});

// Frozen from the merged U2b baseline (7a8bd3a). A profile change must not rewrite other pages.
test("U3A_SHELL: non-profile pages render byte-identically to the merged baseline",()=>{
  const pages:[string,string,string][]=[
    ["landing",renderLanding(),"e8db83616e9f2a3d2510738634e6a966b55ba9602f9bc03ea907137f255ceda9"],
    ["401",renderError(401),"50129e049eb9c98b63ea9f3cc409df7a87dd73fee3f0a297e890cf029f3b7284"],
    ["403",renderError(403),"3c09f9780103ce8a41799492b79f71886990778ef11e57541750dd0eff751e5f"],
    ["404",renderError(404),"e8e5034a396c4bc39ed91d1e0d46abda9f0edb3feb17b20390ee68e475ed82ee"],
    ["503",renderError(503),"2254b54d9db5d17a120df8bc367b06a65cd2ca5f5cd53757724e7c523f00e90b"],
    ["legacy document",pageDocument("Legacy",'<main id="main">Unchanged</main>'),"6db26e72bc70a7fff1a5d6b9acabf0bd76353d4818128642097535ea932ff6f9"],
    ["workspace",renderWorkspace({status:200,body:{contexts:[]}} as never,{} as BrowserLoginApplication),"e2d12c13c99236b59f897b4d326cb5aa4c69fd281a9f6e252902d5cf2cf17041"],
    ["directory success",renderCompanyDirectory({status:200,body:{active:{orgId:"org-one",organizationName:"Example Company",role:"admin"},filters:{},directory:{entries:[],total:0,page:1,pageSize:20}}} as never,{} as BrowserLoginApplication),"119a56f0f2aaa5b48b8bd27bf6dba413b3b657f9e057cb17df0090e910420048"],
    ["directory",renderCompanyDirectory({status:503,body:{error:"unavailable"}} as never,{} as BrowserLoginApplication),"2254b54d9db5d17a120df8bc367b06a65cd2ca5f5cd53757724e7c523f00e90b"],
  ];for(const[name,html,hash]of pages)assert.equal(createHash("sha256").update(html).digest("hex"),hash,`U3A_SHELL byte identity ${name}`);
});

test("U3A mutants: wrong document direction, missing work section, contradictory copy die at named assertions",async()=>{
  const sourceUrl=new URL("../src/web-ui.js",import.meta.url),source=readFileSync(sourceUrl,"utf8");
  const cases=[
    {from:'language === "ar" ? "rtl" : "ltr"',to:'language === "ar" ? "ltr" : "ltr"',probe:(html:string)=>shell(html,"ar"),error:/U3A_SHELL document locale/},
    {from:'section("work", ["objective", "intro", "preferredTime"])',to:'""',probe:(html:string)=>journey(html,"ar"),error:/U3A_JOURNEY section-work order/},
    {from:'<header class="p-header"><h1 id="profile-heading">',to:'<span>Read-only</span><header class="p-header"><h1 id="profile-heading">',probe:truthful,error:/U3A_COPY no contradictory/},
  ];
  for(const item of cases){const original=(await render("ar")).html;item.probe(original);assert.equal(source.split(item.from).length,2,`one mutation point: ${item.from}`);const url=new URL(`./u3a-mutant-${randomUUID()}.mjs`,sourceUrl);try{writeFileSync(url,source.replace(item.from,item.to));const mod=await import(url.href) as {profileDocument:typeof profileDocument};const changed=await mod.profileDocument({status:200,body:fixture("ar")},login);assert.throws(()=>item.probe(changed.html),{name:"AssertionError",message:item.error});}finally{unlinkSync(url);}}
});
