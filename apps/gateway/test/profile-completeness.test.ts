import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SYNTHETIC_PROFILE_FIXTURES } from "@studenthub/profile";
import { createGatewayServer } from "../src/index.js";
import { createLoginApplication } from "../src/login-application.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";
import { PROFILE_COPY } from "../src/ui/profile-copy.js";

const SESSION = "s".repeat(43);

interface FixtureOptions {
  readonly complete?: boolean;
  readonly email?: string;
  readonly language?: "en" | "ar";
  readonly clearDisplayName?: boolean;
  readonly itemCount?: number;
  readonly civilConfigured?: boolean;
  readonly missingPhoto?: boolean;
  readonly allMissing?: boolean;
  readonly nationalityMissing?: boolean;
}

async function fixture(t: TestContext, failure?: "background" | "choices" | "civil" | "documents", options: FixtureOptions = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  (rig.authorization as typeof rig.authorization & { principalFor(personId: string): Promise<{ role: string; email?: string }> }).principalFor = async personId => ({ role: await rig.authorization.roleFor(personId), ...(options.email === "" ? {} : { email: options.email ?? "person@example.invalid" }) });
  const principals = new InMemoryAuthzStore({ principals: [createPrincipal({ id: "person-1", pbuuids: [], email: "person@example.invalid" })] });
  const repository = new OwnProfileRepository({
    principals,
    source: new InMemoryApprovedProfileAdapter({ links: [{ principalId: "person-1", candidateRef: "candidate-1" }], rows: new Map([["candidate-1", SYNTHETIC_PROFILE_FIXTURES.populated]]) }),
    today: () => "2026-11-11",
  });
  const counts = { profile: 0, background: 0, choices: 0, civil: 0, documents: 0, writes: 0 };
  const language = options.language ?? "en";
  const login: BrowserLoginApplication = {
    ...rig.app,
    browserEdit: { async notice() { return {}; } } as never,
    profileEdit: {
      async choices() { counts.choices++; if (failure === "choices") throw new Error("choices"); return { countries: options.allMissing ? [{ id: "US", code: "US", name: "United States" }] : [], universities: [] }; },
      async preview() { counts.writes++; throw new Error("write"); }, async confirm() { counts.writes++; throw new Error("write"); }, async receipt() { counts.writes++; throw new Error("write"); },
    },
    ...(options.civilConfigured === false ? {} : { civilId: { async readOwn() { counts.civil++; if (failure === "civil") throw new Error("civil"); return options.allMissing ? null : { maskedNumber: "***", expiry: "2030-01-01" }; } } as never }),
    web: { origin: "https://profile.test.invalid", returnTo: "https://profile.test.invalid/profile", profiles: { async readOwn(request) { counts.profile++; const found = await repository.readOwn(request); if (found.kind !== "found") return found; const written = { kind: "written_by_person" as const, observedAt: found.profile.asOfDate }; const unavailable = (name: keyof typeof found.profile.fields) => ({ state: "unavailable" as const, reason: "not_recorded" as const, provenance: found.profile.fields[name]!.provenance, freshness: written }); const fields = { ...found.profile.fields, language: { state: "available" as const, value: language, provenance: found.profile.fields.language.provenance, freshness: found.profile.fields.language.freshness }, ...(options.clearDisplayName ? { displayName: { state: "available" as const, value: " ", provenance: found.profile.fields.displayName.provenance, freshness: written } } : {}), ...(options.allMissing ? { displayName: unavailable("displayName"), arabicName: unavailable("arabicName"), gender: unavailable("gender"), objective: unavailable("objective"), phone: unavailable("phone"), birthDate: unavailable("birthDate"), nationality: options.nationalityMissing ? unavailable("nationality") : { state: "available" as const, value: "United States", editValue: "US", provenance: found.profile.fields.nationality.provenance, freshness: written }, civilId: unavailable("civilId"), drivingLicence: unavailable("drivingLicence"), area: unavailable("area"), kuwaitiMother: unavailable("kuwaitiMother") } : {}) }; return { kind: "found" as const, profile: { ...found.profile, fields } as never }; } } },
  };
  const documentTypes = options.complete && !options.allMissing ? options.missingPhoto ? ["civil-id-front", "civil-id-back"] : ["personal-photo", "civil-id-front", "civil-id-back"] : [];
  const documents = { async list() { counts.documents++; if (failure === "documents") throw new Error("documents"); return Array.from({ length: options.itemCount ?? documentTypes.length }, (_, index) => ({ id: `document-${index}`, type: documentTypes[index % Math.max(1, documentTypes.length)] ?? "resume" })); }, async issueDelivery() { throw new Error("delivery"); } };
  const profileRecords = { service: { async background() { counts.background++; if (failure === "background") throw new Error("background"); const size = options.complete ? Math.max(1, options.itemCount ?? 1) : 0; return { education: Array.from({ length: size }, () => ({})), skill: Array.from({ length: size }, () => ({})), experience: [], link: [] }; } }, sessions: rig.sessions, origin: "https://profile.test.invalid", async options() { return []; } };
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, documents as never, undefined, profileRecords as never);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const get = (accept: string) => fetch(`http://127.0.0.1:${address.port}/profile`, { headers: { accept, cookie: `__Host-studenthub_session=${SESSION}` } });
  return { get, counts };
}

test("Q14_4_STATUS real GET keeps 200 when each gatherer source throws synchronously", async t => {
  for (const source of ["background", "choices", "civil", "documents"] as const) {
    const f = await fixture(t, source);
    const response = await f.get("text/html"); const html = await response.text();
    assert.equal(response.status, 200, `${source} failure must preserve profile status`);
    assert.match(html, /Couldn&#39;t check right now/);
    assert.doesNotMatch(html, /Profile complete/);
    assert.equal(f.counts.profile, 1);
  }
});

test("Q14_4_CHECKLIST real GET renders linked missing items in fixed order", async t => {
  const f = await fixture(t);
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200);
  const expected = [
    ['Personal photo', '/profile/documents'], ['Civil ID front', '/profile/documents'],
    ['Civil ID back', '/profile/documents'], ['Education', '/profile/background'], ['Skill', '/profile/background'],
  ] as const;
  let cursor = -1;
  for (const [words, href] of expected) {
    const item = new RegExp(`<li><a href="${href}">${words}</a></li>`).exec(html);
    assert.ok(item, `${words} must carry its own target ${href}`);
    assert.ok(item.index > cursor, `${words} must follow the fixed requirement order`); cursor = item.index;
  }
  const checklist = html.match(/<section class="p-card p-checklist">[^]*?<\/section>/)?.[0] ?? "";
  assert.equal(checklist.match(/<li>/g)?.length, expected.length, "checklist must contain exactly the required item set");
  assert.doesNotMatch(checklist, /<dt>|data-state="unavailable"/);
});

test("Q14_4_ORDER real GET asserts every requirement word and target in English and Arabic", async t => {
  const requirements = ["display_name", "arabic_name", "gender", "objective", "personal_photo", "email", "phone", "birth_date", "civil_id", "civil_expiry", "civil_front", "civil_back", "driving_licence", "location", "kuwaiti_mother", "education", "skill"] as const;
  const editable: Readonly<Record<string, string>> = { nationality: "nationality", display_name: "displayName", arabic_name: "arabicName", gender: "gender", objective: "objective", phone: "phone", birth_date: "birthDate", driving_licence: "drivingLicence", kuwaiti_mother: "kuwaitiMother" };
  const target = (requirement: string) => editable[requirement] ? `/profile/edit/${editable[requirement]}` : requirement === "location" ? "#field-area" : requirement === "civil_id" || requirement === "civil_expiry" ? "#field-civilId" : requirement === "personal_photo" || requirement === "civil_front" || requirement === "civil_back" ? "/profile/documents" : requirement === "education" || requirement === "skill" ? "/profile/background" : undefined;
  for (const language of ["en", "ar"] as const) {
    const f = await fixture(t, undefined, { allMissing: true, email: "", language });
    const response = await f.get("text/html"); const html = await response.text(); assert.equal(response.status, 200);
    const checklist = html.match(/<section class="p-card p-checklist">[^]*?<\/section>/)?.[0] ?? "";
    let cursor = -1;
    for (const requirement of requirements) {
      const words = PROFILE_COPY[language][`pending.${requirement}`]; const href = target(requirement);
      const fragment = href ? `<li><a href="${href}">${words}</a></li>` : `<li>${words} <span>${PROFILE_COPY[language]["check.emailSource"]}</span></li>`;
      const index = checklist.indexOf(fragment); assert.ok(index >= 0, `${language} ${words} must carry exactly ${href ?? "no link"}`); assert.ok(index > cursor, `${language} ${words} must follow fixed order`); cursor = index;
    }
    assert.equal(checklist.match(/<li>/g)?.length, requirements.length, `${language} checklist has the exact requirement set`);
    const nationality = await fixture(t, undefined, { allMissing: true, nationalityMissing: true, email: "", language });
    const nationalityHtml = await (await nationality.get("text/html")).text();
    const nationalityChecklist = nationalityHtml.match(/<section class="p-card p-checklist">[^]*?<\/section>/)?.[0] ?? "";
    assert.ok(nationalityChecklist.includes(`<li><a href="/profile/edit/nationality">${PROFILE_COPY[language]["pending.nationality"]}</a></li>`), `${language} nationality must carry its own edit target`);
    assert.ok(!nationalityChecklist.includes(PROFILE_COPY[language]["pending.kuwaiti_mother"]), `${language} Kuwaiti-mother requirement is not guessed without nationality`);
  }
});

test("Q14_4_DERIVED source failure derives unavailable fields without changing route status", async t => {
  const f = await fixture(t, "background");
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /Couldn&#39;t check right now/);
  assert.match(html, /Profile completeness[^]*?data-state="unavailable"/);
  assert.equal(f.counts.writes, 0);
});

test("Q14_4_JSON real GET performs no completeness or document reads", async t => {
  const f = await fixture(t);
  const response = await f.get("application/json");
  assert.equal(response.status, 200); assert.ok(await response.json());
  assert.deepEqual({ background: f.counts.background, choices: f.counts.choices, civil: f.counts.civil, documents: f.counts.documents }, { background: 0, choices: 0, civil: 0, documents: 0 });
});

test("Q14_4_NOWRITE real GET gathers each source once and never invokes a write", async t => {
  const f = await fixture(t);
  const response = await f.get("text/html"); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.counts, { profile: 1, background: 1, choices: 1, civil: 1, documents: 1, writes: 0 }, "whole page must make one documents list and no writes");
});

test("Q14_4_COMPAT real GET replaces imported placeholders with derived rows", async t => {
  const f = await fixture(t, undefined, { complete: true });
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Profile completeness[^]*?Profile complete/, "derived result must replace the stored completeness field");
  assert.match(html, /Still to do[^]*?None/);
  assert.match(html, /Worked out from your profile/);
  assert.doesNotMatch(html, /Checked once your documents are on file/);
});

test("Q14_4_EMAIL real login profile email completes the page and omission lists an unlinked email item", async t => {
  const withEmail = await fixture(t, undefined, { complete: true });
  const complete = await withEmail.get("text/html"); const completeHtml = await complete.text();
  assert.equal(complete.status, 200); assert.match(completeHtml, /<h2>Profile complete<\/h2>/);
  const withoutEmail = await fixture(t, undefined, { complete: true, email: "" });
  const missing = await withoutEmail.get("text/html"); const missingHtml = await missing.text();
  assert.equal(missing.status, 200);
  assert.match(missingHtml, /<li>Email <span>comes from your Universe account<\/span><\/li>/);
  assert.doesNotMatch(missingHtml, /<a[^>]*>Email/);
});

test("Q14_4_SHOWN real GET is complete, reacts to one removed document and one cleared field, with fixed reads", async t => {
  for (const itemCount of [0, 1, 40]) {
    const f = await fixture(t, undefined, { complete: true, itemCount });
    const response = await f.get("text/html"); const html = await response.text();
    assert.equal(response.status, 200);
    if (itemCount === 0) assert.match(html, /Personal photo/); else assert.equal(f.counts.documents, 1);
    assert.deepEqual({ profile: f.counts.profile, background: f.counts.background, choices: f.counts.choices, civil: f.counts.civil, documents: f.counts.documents }, { profile: 1, background: 1, choices: 1, civil: 1, documents: 1 });
  }
  const removed = await fixture(t, undefined, { complete: true, missingPhoto: true });
  const removedResponse = await removed.get("text/html"); const removedHtml = await removedResponse.text();
  const removedChecklist = removedHtml.match(/<section class="p-card p-checklist">[^]*?<\/section>/)?.[0] ?? "";
  assert.match(removedChecklist, /Personal photo/); assert.equal(removedChecklist.match(/<li>/g)?.length, 1, "removing one photo must show exactly that item");
  const cleared = await fixture(t, undefined, { complete: true, clearDisplayName: true });
  const response = await cleared.get("text/html"); const html = await response.text();
  assert.match(html, /<li><a href="\/profile\/edit\/displayName">Display name<\/a><\/li>/);
});

test("Q14_4_ROUTE Arabic real GET keeps each translated checklist word with its target", async t => {
  const f = await fixture(t, undefined, { language: "ar" });
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200);
  for (const [words, href] of [["الصورة الشخصية", "/profile/documents"], ["التعليم", "/profile/background"], ["المهارة", "/profile/background"]] as const) {
    assert.match(html, new RegExp(`<li><a href="${href}">${words}</a></li>`), `${words} must carry ${href}`);
  }
});

test("Q14_4_LABELS real GET takes the two derived row labels from translated copy", async t => {
  const f = await fixture(t, undefined, { complete: true, language: "ar" });
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /اكتمال الملف/); assert.match(html, /المتبقي/);
});

test("Q14_4_RENDER_PURE direct renderer without a result adds no checklist", async () => {
  const profile = new OwnProfileRepository({ principals: new InMemoryAuthzStore({ principals: [createPrincipal({ id: "person-1", pbuuids: [] })] }), source: new InMemoryApprovedProfileAdapter({ links: [{ principalId: "person-1", candidateRef: "candidate-1" }], rows: new Map([["candidate-1", SYNTHETIC_PROFILE_FIXTURES.populated]]) }), today: () => "2026-11-11" });
  const found = await profile.readOwn({ requesterPrincipalId: "person-1", targetPersonId: "person-1" }); assert.equal(found.kind, "found");
  const rendered = await import("../src/web-ui.js").then(({ profileDocument }) => profileDocument({ status: 200, body: found.profile }, {}));
  assert.doesNotMatch(rendered.html, /p-checklist/);
  assert.match(rendered.html, /Imported profile completeness|اكتمال الملف الشخصي/);
  assert.doesNotMatch(rendered.html, /Worked out from your profile/);
});

test("Q14_4_STATUS unconfigured civil ID yields unavailable without a dead civil link", async t => {
  const f = await fixture(t, undefined, { civilConfigured: false });
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /Couldn&#39;t check right now/); assert.doesNotMatch(html, /#field-civilId/);
});
