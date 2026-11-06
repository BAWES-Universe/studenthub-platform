import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import type { LoginSession, SessionStore } from "@studenthub/login-contract";
import { InMemoryProfileRecordStore, InMemoryReferenceResolver, ProfileRecords, ProfileRecordError, type ProfileRecordKind } from "@studenthub/profile-records";
import { handleProfileRecords } from "../src/profile-records-http.js";
import { createGatewayServer } from "../src/index.js";

const SESSION_P = "p".repeat(43);
const SESSION_Q = "q".repeat(43);
const DEGREE = "22222222-2222-4222-8222-222222222222";
const MAJOR = "33333333-3333-4333-8333-333333333333";
const UNIVERSITY = "11111111-1111-4111-8111-111111111111";

class FixedSessions implements SessionStore {
  readonly #rows = new Map<string, LoginSession>([
    [SESSION_P, { id: SESSION_P, personId: "person-p" }],
    [SESSION_Q, { id: SESSION_Q, personId: "person-q" }],
  ]);
  async put(record: LoginSession): Promise<void> { this.#rows.set(record.id, record); }
  async get(id: string): Promise<LoginSession | undefined> { return this.#rows.get(id); }
  async delete(id: string): Promise<void> { this.#rows.delete(id); }
}

async function rig(context: TestContext) {
  const store = new InMemoryProfileRecordStore();
  const references = new InMemoryReferenceResolver();
  references.set("university", UNIVERSITY);
  references.set("degree", DEGREE);
  references.set("major", MAJOR);
  const holder: { origin: string } = { origin: "" };
  const runtime = {
    service: new ProfileRecords(store, references, () => new Date("2026-10-04T12:00:00.000Z")),
    sessions: new FixedSessions(),
    get origin() { return holder.origin; },
    options: async (type: string) => type === "university" ? [{ id: UNIVERSITY, name: "Synthetic University" }] : type === "degree" ? [{ id: DEGREE, name: "Synthetic Degree" }] : [{ id: MAJOR, name: "Synthetic Major" }],
  };
  const server = createGatewayServer(undefined, undefined, undefined, undefined, null, undefined, undefined, undefined, runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  holder.origin = `http://127.0.0.1:${address.port}`;
  return { store, runtime, origin: holder.origin };
}

function cookie(session: string): Record<string, string> {
  return { cookie: `__Host-studenthub_session=${session}` };
}

test("SHU144_HTTP the JSON API scopes every route to the session's own principal", async (context) => {
  const { origin, store } = await rig(context);
  const write = (session: string) => ({ ...cookie(session), origin, "content-type": "application/json" });

  const created = await fetch(`${origin}/profile/records/experience`, {
    method: "POST", headers: write(SESSION_P), body: JSON.stringify({ title: "Barista", employer: "Synthetic Cafe", startYear: 2024 }),
  });
  assert.equal(created.status, 201);
  const record = await created.json() as { id: string; ownerId?: string };
  assert.equal(record.ownerId, undefined, "owner never leaves the store");

  const qView = await (await fetch(`${origin}/profile/records`, { headers: cookie(SESSION_Q) })).json() as { experience: unknown[] };
  assert.deepEqual(qView.experience, []);
  const qRemove = await fetch(`${origin}/profile/records/experience/${record.id}/remove`, { method: "POST", headers: write(SESSION_Q) });
  assert.equal(qRemove.status, 404);

  // An owner field in the body is refused, not honoured.
  const smuggled = await fetch(`${origin}/profile/records/skill`, { method: "POST", headers: write(SESSION_Q), body: JSON.stringify({ name: "Excel", ownerId: "person-p" }) });
  assert.equal(smuggled.status, 400);

  const replaced = await fetch(`${origin}/profile/records/skill`, { method: "PUT", headers: write(SESSION_P), body: JSON.stringify({ skills: ["Excel", "Arabic"] }) });
  assert.equal(replaced.status, 200);
  assert.equal((await (await fetch(`${origin}/profile/records`, { headers: cookie(SESSION_P) })).json() as { skill: unknown[] }).skill.length, 2);
  assert.equal(store.auditLog.length, 2);
});

test("SHU144_HTTP_AUTH signed-out and cross-site requests change nothing", async (context) => {
  const { origin, store } = await rig(context);
  assert.equal((await fetch(`${origin}/profile/records`)).status, 401);
  const crossSite = await fetch(`${origin}/profile/records/skill`, {
    method: "POST", headers: { ...cookie(SESSION_P), origin: "https://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ name: "Excel" }),
  });
  assert.equal(crossSite.status, 403);
  const noOrigin = await fetch(`${origin}/profile/background/skill`, {
    method: "POST", headers: { ...cookie(SESSION_P), "content-type": "application/x-www-form-urlencoded" }, body: "name=Excel", redirect: "manual",
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(store.auditLog.length, 0);
});

test("SHU144_HTTP_PAGE the page adds, removes and restores through native forms", async (context) => {
  const { origin } = await rig(context);
  const form = { ...cookie(SESSION_P), origin, "content-type": "application/x-www-form-urlencoded" };
  const added = await fetch(`${origin}/profile/background/education`, {
    method: "POST", headers: form, redirect: "manual",
    body: new URLSearchParams({ educationType: "standard", universityId: UNIVERSITY, graduationYear: "2027", currentlyStudying: "true", customMajor: "" }).toString(),
  });
  assert.equal(added.status, 303);
  assert.equal(added.headers.get("location"), "/profile/background?saved=education#education");

  const page = await fetch(`${origin}/profile/background`, { headers: { ...cookie(SESSION_P), accept: "text/html" } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Synthetic University/);
  assert.match(html, /Studying now/);
  const id = /\/profile\/background\/education\/([0-9a-f-]{36})\/remove/.exec(html)?.[1];
  assert.ok(id);

  const bad = await fetch(`${origin}/profile/background/link`, { method: "POST", headers: form, redirect: "manual", body: "title=x&url=javascript%3Aalert(1)" });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("location"), null);
  assert.match(await bad.text(), /full web address/);
  const shown = await (await fetch(`${origin}/profile/background?error=invalid_link_url&on=link`, { headers: cookie(SESSION_P) })).text();
  assert.match(shown, /full web address/);

  assert.equal((await fetch(`${origin}/profile/background/education/${id}/remove`, { method: "POST", headers: form, redirect: "manual", body: "" })).status, 303);
  const afterRemove = await (await fetch(`${origin}/profile/background`, { headers: cookie(SESSION_P) })).text();
  assert.match(afterRemove, /Recently removed/);
  assert.equal((await fetch(`${origin}/profile/background/education/${id}/restore`, { method: "POST", headers: form, redirect: "manual", body: "" })).status, 303);
  assert.doesNotMatch(await (await fetch(`${origin}/profile/background`, { headers: cookie(SESSION_P) })).text(), /Recently removed/);

  const signedOut = await fetch(`${origin}/profile/background`);
  assert.equal(signedOut.status, 401);
});

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function addForm(html: string, kind: ProfileRecordKind): string {
  const form = html.match(new RegExp(`<form[^>]*action="/profile/background/${kind}"[^>]*>([^]*?)</form>`))?.[1];
  assert.ok(form, `RECOVERY_FORM ${kind} Add form present`);
  return form;
}
function retained(html: string, kind: ProfileRecordKind, fields: Record<string, string>): void {
  const form = addForm(html, kind);
  for (const [name, value] of Object.entries(fields)) {
    const input = form.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`))?.[0];
    assert.ok(input?.includes(`value="${escaped(value)}"`), `RECOVERY_RETAIN ${kind}.${name} exact raw draft`);
  }
}
function selected(html: string, name: string, value: string): void {
  const select = addForm(html, "education").match(new RegExp(`<select[^>]*name="${name}"[^>]*>([^]*?)</select>`))?.[1];
  assert.ok(select?.match(new RegExp(`<option[^>]*value="${value}"[^>]*selected(?:[\\s=>])`)), `RECOVERY_SELECT ${name}`);
}
async function postForm(origin: string, kind: ProfileRecordKind, fields: Record<string, string> | string, headers: Record<string, string> = {}) {
  return fetch(`${origin}/profile/background/${kind}`, {
    method: "POST", redirect: "manual",
    headers: { ...cookie(SESSION_P), origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: typeof fields === "string" ? fields : new URLSearchParams(fields).toString(),
  });
}

for (const text of ["  Ａda   Example  ", "  نور   الصباح  "]) {
  const cases: { kind: ProfileRecordKind; draft: Record<string, string>; correction: Record<string, string>; error: RegExp; normalized: Record<string, unknown> }[] = [
    { kind: "education", draft: { educationType: "studying_abroad", institutionName: text, customMajor: text, graduationYear: " 2027 ", currentlyStudying: "true" }, correction: { graduationYear: "2027" }, error: /graduation year between/, normalized: { institutionName: text.trim().replace(/\s+/g, " ").normalize("NFKC"), graduationYear: 2027 } },
    { kind: "experience", draft: { title: text, employer: text, startYear: "2025", endYear: "2024" }, correction: { endYear: "2026" }, error: /end year can’t be before/, normalized: { title: text.trim().replace(/\s+/g, " ").normalize("NFKC"), employer: text.trim().replace(/\s+/g, " ").normalize("NFKC"), startYear: 2025, endYear: 2026 } },
    { kind: "skill", draft: { name: text.repeat(20) }, correction: { name: text }, error: /skill, up to 128/, normalized: { name: text.trim().replace(/\s+/g, " ").normalize("NFKC") } },
    { kind: "link", draft: { title: text, url: `javascript:alert('${text}')` }, correction: { url: " https://example.com " }, error: /full web address/, normalized: { title: text.trim().replace(/\s+/g, " ").normalize("NFKC"), url: "https://example.com/" } },
  ];
  for (const item of cases) test(`RECOVERY_RETAIN ${item.kind} ${text.includes("نور") ? "Arabic" : "English"} input corrects once without premature normalization`, async (context) => {
    const { origin, store, runtime } = await rig(context);
    const refused = await postForm(origin, item.kind, item.draft, { "accept-language": "ar" });
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get("location"), null);
    assert.match(refused.headers.get("cache-control") ?? "", /no-store/);
    const html = await refused.text();
    const rawInputs = Object.fromEntries(Object.entries(item.draft).filter(([key]) => !["educationType", "currentlyStudying"].includes(key)));
    retained(html, item.kind, rawInputs);
    assert.match(html, item.error);
    assert.match(html, /Education and experience/);
    assert.match(html, /role="alert"/);
    assert.match(html, new RegExp(`id="${item.kind}"[^]*?<details[^>]* open`));
    assert.deepEqual(await store.listAll("person-p"), []);
    assert.equal(store.auditLog.length, 0);
    const saved = await postForm(origin, item.kind, { ...item.draft, ...item.correction });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get("location"), `/profile/background?saved=${item.kind}#${item.kind}`);
    const background = await runtime.service.background("person-p");
    assert.equal(background[item.kind].length, 1);
    for (const [key, value] of Object.entries(item.normalized)) assert.equal((background[item.kind][0].fields as unknown as Record<string, unknown>)[key], value);
    assert.equal(store.auditLog.length, 1);
    assert.equal(store.auditLog[0].operation, "profile_record.create");
    assert.deepEqual(await store.listAll("person-q"), []);
  });
}

test("RECOVERY_SELECT education catalogue, enum and checkbox survive invalid year; blank and whitespace remain exact", async (context) => {
  const { origin, store } = await rig(context);
  const draft = { educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, majorId: MAJOR, institutionName: "  ", customMajor: "", graduationYear: "nope", currentlyStudying: "on" };
  const refused = await postForm(origin, "education", draft);
  assert.equal(refused.status, 400);
  const html = await refused.text();
  for (const name of ["educationType", "universityId", "degreeId", "majorId"] as const) selected(html, name, draft[name]);
  retained(html, "education", { institutionName: "  ", customMajor: "", graduationYear: "nope" });
  assert.match(addForm(html, "education"), /<input[^>]*name="currentlyStudying"[^>]*checked(?:[\s=>])/);
  const unchecked = await postForm(origin, "education", { ...draft, currentlyStudying: "false" });
  assert.doesNotMatch(addForm(await unchecked.text(), "education"), /<input[^>]*name="currentlyStudying"[^>]*checked/);
  assert.equal(store.auditLog.length, 0);
  const blank = await postForm(origin, "experience", { title: "", employer: " \t ", startYear: "", endYear: "  " });
  retained(await blank.text(), "experience", { title: "", employer: " \t ", startYear: "", endYear: "  " });
});

test("RECOVERY_ESCAPE malicious draft is escaped text and never an executable URL or attribute", async (context) => {
  const { origin, store } = await rig(context);
  const draft = { title: `"><script>alert('draft')</script><img src=x onerror="boom"> & نور`, url: `javascript:alert("draft")` };
  const response = await postForm(origin, "link", draft);
  assert.equal(response.status, 400);
  const html = await response.text();
  retained(html, "link", draft);
  assert.doesNotMatch(html, /<script>|<img src=x|href="javascript:|\sonerror="boom"/);
  assert.equal(store.auditLog.length, 0);
});

test("RECOVERY_CONFLICT duplicate skill preserves raw draft; limit refusal retains each kind without another write", async (context) => {
  const { origin, runtime, store } = await rig(context);
  await runtime.service.create("person-p", "skill", { name: "Excel" });
  const duplicate = await postForm(origin, "skill", { name: "  EXCEL  " });
  assert.equal(duplicate.status, 409);
  const html = await duplicate.text(); retained(html, "skill", { name: "  EXCEL  " });
  assert.match(html, /already have that skill/);
  assert.equal(store.auditLog.length, 1);
  assert.equal((await postForm(origin, "skill", { name: "Arabic" })).status, 303);
  assert.equal(store.auditLog.length, 2);
  const drafts: Record<ProfileRecordKind, Record<string, string>> = {
    education: { educationType: "custom_university", institutionName: "  Another school  " },
    experience: { title: "  Another role  ", employer: " Employer ", startYear: "2024" },
    skill: { name: "  Another skill  " }, link: { title: " Another link ", url: "https://example.com/new" },
  };
  for (const kind of ["education", "experience", "skill", "link"] as const) {
    const count = (await runtime.service.background("person-p"))[kind].length;
    for (let i = count; i < 50; i++) await runtime.service.create("person-p", kind, kind === "skill" ? { name: `Skill ${i}` } : drafts[kind]);
    const before: number = store.auditLog.length;
    const refused = await postForm(origin, kind, drafts[kind]);
    assert.equal(refused.status, 409);
    const html = await refused.text();
    retained(html, kind, Object.fromEntries(Object.entries(drafts[kind]).filter(([key]) => key !== "educationType")));
    assert.match(html, /limit of 50/);
    assert.equal(store.auditLog.length, before);
    assert.equal((await runtime.service.background("person-p"))[kind].length, 50);
  }
});

const PRIVATE_DRAFT = "PRIVATE_DRAFT_CANARY";
test("RECOVERY_BOUNDARY malformed, extra, duplicate and oversized forms never partially echo or write", async (context) => {
  const { origin, store } = await rig(context);
  for (const body of [
    `name=${PRIVATE_DRAFT}&ownerId=person-q`, `name=${PRIVATE_DRAFT}&extra=x`,
    `name=${PRIVATE_DRAFT}&name=second`, `name=&name=${PRIVATE_DRAFT}`, `name=++&name=${PRIVATE_DRAFT}`,
    `name=${PRIVATE_DRAFT}%ZZ`, `name=${PRIVATE_DRAFT}%C3%28`, `name=${PRIVATE_DRAFT}%`,
    `name=${PRIVATE_DRAFT}${"x".repeat(17 * 1024)}`,
  ]) {
    const response = await postForm(origin, "skill", body);
    assert.ok(response.status === 400 || response.status === 303);
    assert.ok(!(await response.text()).includes(PRIVATE_DRAFT), "RECOVERY_BOUNDARY no partial draft");
    assert.ok(!response.headers.get("location")?.includes(PRIVATE_DRAFT));
    assert.equal(store.auditLog.length, 0);
  }
  const rejectedHeaders: Record<string, string>[] = [{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }, { cookie: "" }];
  for (const headers of rejectedHeaders) {
    const response = await postForm(origin, "skill", { name: PRIVATE_DRAFT }, headers);
    assert.ok([401, 403].includes(response.status));
    assert.ok(!(await response.text()).includes(PRIVATE_DRAFT));
    assert.equal(store.auditLog.length, 0);
  }
  assert.deepEqual(await store.listAll("person-p"), []);
  assert.deepEqual(await store.listAll("person-q"), []);
});

for (const failure of ["revoked", "swapped", "session-failed", "background-failed"] as const) {
  test(`RECOVERY_PRINCIPAL ${failure} during refusal never discloses draft or either current profile`, async (context) => {
    const { origin, runtime, store } = await rig(context);
    await runtime.service.create("person-p", "skill", { name: "CURRENT_P_CANARY" });
    await runtime.service.create("person-q", "skill", { name: "CURRENT_Q_CANARY" });
    const create = runtime.service.create.bind(runtime.service);
    runtime.service.create = async (...args) => {
      if (failure === "revoked") await runtime.sessions.delete(SESSION_P);
      if (failure === "swapped") await runtime.sessions.put({ id: SESSION_P, personId: "person-q" });
      if (failure === "session-failed") runtime.sessions.get = async () => { throw new Error("session unavailable"); };
      if (failure === "background-failed") runtime.service.background = async () => { throw new Error("background unavailable"); };
      return create(...args);
    };
    const response = await postForm(origin, "link", { title: PRIVATE_DRAFT, url: "javascript:bad" });
    assert.ok([401, 403, 503].includes(response.status));
    assert.doesNotMatch(await response.text(), /PRIVATE_DRAFT_CANARY|CURRENT_[PQ]_CANARY/);
    assert.equal(store.auditLog.length, 2);
  });
}

test("RECOVERY_FAILURE unknown and unavailable failures do not recover or replay uncertain writes", async (context) => {
  const { origin, runtime, store } = await rig(context);
  const create = runtime.service.create.bind(runtime.service);
  for (const mode of ["unknown", "503", "unknown400", "unknown409", "audit", "uncertain"] as const) {
    let calls = 0;
    runtime.service.create = async (...args) => {
      calls++;
      if (mode === "unknown") throw new Error("unknown");
      if (mode === "503") throw new ProfileRecordError("reference_unavailable", 503);
      if (mode === "unknown400") throw new ProfileRecordError("future_validation_code", 400);
      if (mode === "unknown409") throw new ProfileRecordError("future_conflict_code", 409);
      if (mode === "audit") store.failNextAudit = true;
      const result = await create(...args);
      if (mode === "uncertain") throw new Error("connection lost after commit");
      return result;
    };
    const before: number = store.auditLog.length;
    const response = await postForm(origin, "skill", { name: `${PRIVATE_DRAFT}_${mode}` });
    assert.ok([303, 400, 409, 503].includes(response.status));
    assert.ok(!(await response.text()).includes(PRIVATE_DRAFT));
    assert.equal(calls, 1, "RECOVERY_FAILURE no automatic replay");
    assert.equal(store.auditLog.length, before + (mode === "uncertain" ? 1 : 0));
  }
});

function uncertainCopy(response: Response, html: string): void {
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(html, /We couldn’t complete that request\./);
  assert.match(html, /Return to education and experience to check your entries before trying again\./);
  assert.doesNotMatch(html, /Nothing was changed|PRIVATE_DRAFT_CANARY/);
  assert.ok(!html.includes(SESSION_P));
}

test("RECOVERY_UNCERTAINTY read failure and committed-but-unacknowledged save use truthful503 without replay", async (context) => {
  const { origin, runtime, store } = await rig(context);
  const background = runtime.service.background.bind(runtime.service);
  runtime.service.background = async () => { throw new Error("read unavailable"); };
  const readFailure = await fetch(`${origin}/profile/background`, { headers: cookie(SESSION_P) });
  uncertainCopy(readFailure, await readFailure.text());
  runtime.service.background = background;
  const create = runtime.service.create.bind(runtime.service);
  let calls = 0;
  runtime.service.create = async (...args) => { calls++; await create(...args); throw new Error("acknowledgement lost after commit"); };
  const response = await postForm(origin, "skill", { name: PRIVATE_DRAFT });
  uncertainCopy(response, await response.text());
  assert.equal(calls, 1);
  assert.equal(store.auditLog.length, 1, "RECOVERY_UNCERTAINTY committed write is durable, not a rollback");
  assert.equal((await background("person-p")).skill[0].fields.name, PRIVATE_DRAFT);
});

for (const boundary of ["background", "catalogue"] as const) for (const change of ["revoked", "swapped", "failed"] as const) {
  test(`RECOVERY_FINAL_PRINCIPAL ${change} during ${boundary} read prevents redisclosure`, async (context) => {
    const { origin, runtime, store } = await rig(context);
    await runtime.service.create("person-p", "skill", { name: "CURRENT_P_CANARY" });
    await runtime.service.create("person-q", "skill", { name: "CURRENT_Q_CANARY" });
    const changeSession = async () => {
      if (change === "revoked") await runtime.sessions.delete(SESSION_P);
      if (change === "swapped") await runtime.sessions.put({ id: SESSION_P, personId: "person-q" });
      if (change === "failed") runtime.sessions.get = async () => { throw new Error("session unavailable"); };
    };
    if (boundary === "background") {
      const original = runtime.service.background.bind(runtime.service);
      runtime.service.background = async (owner) => { const result = await original(owner); await changeSession(); return result; };
    } else {
      const original = runtime.options;
      runtime.options = async (type) => { const result = await original(type); await changeSession(); return result; };
    }
    const response = await postForm(origin, "link", { title: PRIVATE_DRAFT, url: "javascript:bad" });
    assert.ok([401, 403, 503].includes(response.status));
    assert.doesNotMatch(await response.text(), /PRIVATE_DRAFT_CANARY|CURRENT_[PQ]_CANARY/);
    assert.equal(store.auditLog.length, 2);
  });
}

test("RECOVERY_CATALOGUE unavailable recovery catalogue does not expose drafts or current records", async (context) => {
  const { origin, runtime, store } = await rig(context);
  await runtime.service.create("person-p", "skill", { name: "CURRENT_P_CANARY" });
  runtime.options = async () => { throw new Error("catalogue unavailable"); };
  const response = await postForm(origin, "link", { title: PRIVATE_DRAFT, url: "javascript:bad" });
  const html = await response.text();
  uncertainCopy(response, html);
  assert.doesNotMatch(html, /CURRENT_P_CANARY/);
  assert.equal(store.auditLog.length, 1);
});

test("RECOVERY_MUTANT dropping recovered draft fails named retention assertion while baseline HTTP control passes", async (context) => {
  const { runtime, store } = await rig(context);
  const sourceUrl = new URL("../src/profile-records-http.js", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const from = 'new URLSearchParams({ error: code, on: recovery.kind }), recovery)';
  assert.equal(source.split(from).length, 2, "RECOVERY_MUTANT exactly one draft render seam");
  const mutantUrl = new URL(`./recovery-mutant-${randomUUID()}.mjs`, sourceUrl);
  async function exercise(handler: typeof handleProfileRecords): Promise<string> {
    let origin = "";
    const server = createServer((request, response) => {
      void handler(request, response, { ...runtime, get origin() { return origin; } }, (status, html) => {
        response.writeHead(status, { "content-type": "text/html", "cache-control": "no-store" }); response.end(html);
      }).catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await postForm(origin, "experience", { title: "  Retain my role  ", employer: " My employer ", startYear: "2025", endYear: "2024" });
      assert.equal(response.status, 400, "RECOVERY_MUTANT handler executes refusal path");
      const html = await response.text();
      assert.match(html, /end year can’t be before/, "RECOVERY_MUTANT error control remains present");
      return html;
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
  const probe = (html: string) => retained(html, "experience", { title: "  Retain my role  ", employer: " My employer ", startYear: "2025", endYear: "2024" });
  probe(await exercise(handleProfileRecords));
  try {
    writeFileSync(mutantUrl, source.replace(from, 'new URLSearchParams({ error: code, on: recovery.kind }))'));
    const mutant = await import(mutantUrl.href) as { handleProfileRecords: typeof handleProfileRecords };
    const changed = await exercise(mutant.handleProfileRecords);
    assert.throws(() => probe(changed), { name: "AssertionError", message: /RECOVERY_RETAIN experience.title exact raw draft/ });
    assert.equal(store.auditLog.length, 0);
  } finally { unlinkSync(mutantUrl); }
});

test("RECOVERY_SELECT stale catalogue and invalid enum choices retain exact escaped submitted values", async (context) => {
  const { origin, runtime, store } = await rig(context);
  const invalid = `"><img src=x onerror="boom"> & نور`;
  const response = await postForm(origin, "education", { educationType: invalid, institutionName: " My school ", graduationYear: "2028" });
  assert.equal(response.status, 400);
  const html = await response.text();
  const select = addForm(html, "education").match(/<select[^>]*name="educationType"[^>]*>([^]*?)<\/select>/)?.[1];
  assert.ok(select?.includes(`value="${escaped(invalid)}" selected`), "RECOVERY_SELECT invalid enum exact escaped choice");
  assert.doesNotMatch(html, /<img src=x|\sonerror="boom"/);
  retained(html, "education", { institutionName: " My school ", graduationYear: "2028" });
  const staleDegree = "44444444-4444-4444-8444-444444444444";
  const stale = await postForm(origin, "education", { educationType: "standard", universityId: UNIVERSITY, degreeId: staleDegree, customMajor: " My major " });
  assert.equal(stale.status, 400);
  const staleHtml = await stale.text();
  selected(staleHtml, "degreeId", staleDegree);
  selected(staleHtml, "universityId", UNIVERSITY);
  assert.match(staleHtml, /That degree isn’t in the list/);
  runtime.options = async () => [];
  const emptyCatalogue = await postForm(origin, "education", { educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, majorId: MAJOR, graduationYear: "wrong" });
  assert.equal(emptyCatalogue.status, 400);
  const emptyHtml = await emptyCatalogue.text();
  for (const [name, value] of Object.entries({ educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, majorId: MAJOR })) selected(emptyHtml, name, value);
  assert.equal(store.auditLog.length, 0);
});

test("RECOVERY_BOUNDARY literal malformed UTF8 bytes are rejected without partial draft or writes", async (context) => {
  const { origin, store } = await rig(context);
  for (const invalid of [[0xc3, 0x28], [0xff], [0xe2, 0x82]]) {
    const body = Buffer.concat([Buffer.from(`name=${PRIVATE_DRAFT}`), Buffer.from(invalid)]);
    const response = await fetch(`${origin}/profile/background/skill`, {
      method: "POST", redirect: "manual", body,
      headers: { ...cookie(SESSION_P), origin, "content-type": "application/x-www-form-urlencoded" },
    });
    assert.ok([303, 400].includes(response.status));
    assert.ok(!(await response.text()).includes(PRIVATE_DRAFT));
    assert.ok(!response.headers.get("location")?.includes(PRIVATE_DRAFT));
    assert.equal(store.auditLog.length, 0);
  }
  assert.deepEqual(await store.listAll("person-p"), []);
});
