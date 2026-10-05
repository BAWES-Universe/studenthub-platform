import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { LoginSession, SessionStore } from "@studenthub/login-contract";
import { InMemoryProfileRecordStore, InMemoryReferenceResolver, ProfileRecords } from "@studenthub/profile-records";
import { createGatewayServer } from "../src/index.js";

const SESSION_P = "p".repeat(43);
const SESSION_Q = "q".repeat(43);
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
  const holder: { origin: string } = { origin: "" };
  const runtime = {
    service: new ProfileRecords(store, references, () => new Date("2026-10-04T12:00:00.000Z")),
    sessions: new FixedSessions(),
    get origin() { return holder.origin; },
    options: async (type: string) => type === "university" ? [{ id: UNIVERSITY, name: "Synthetic University" }] : [],
  };
  const server = createGatewayServer(undefined, undefined, undefined, undefined, null, undefined, undefined, undefined, runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  holder.origin = `http://127.0.0.1:${address.port}`;
  return { store, origin: holder.origin };
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
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get("location"), "/profile/background?error=invalid_link_url&on=link#link");
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
