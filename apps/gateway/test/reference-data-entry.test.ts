import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryCatalogueStore, ReferenceCatalogue, type CatalogueItem } from "@studenthub/reference-catalogue";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";

const sessions = { staff: "s".repeat(43), admin: "a".repeat(43), owner: "o".repeat(43), recruiter: "r".repeat(43), local: "l".repeat(43) };
const actor = { principalRef: "seed", orgId: "root", role: "staff" as const };
const methods = ["list", "resolveHistorical", "create", "update", "remove", "submit", "submissions", "moderate", "bankPaymentDetails", "currencyDetails"] as const;

async function fixture(t: TestContext, options: { missing?: boolean; navigationThrows?: boolean; resolveThrows?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "StudentHub" }, { id: "org-a", name: "A", parentOrgId: "root" }] });
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("recruiter", [{ orgId: "org-a", role: "recruiter" }]);
  await authz.grantMany("local", [{ orgId: "org-a", role: "staff" }]);
  const catalogue = new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date("2026-11-23T00:00:00.000Z"));
  const active = await catalogue.create(actor, "bank", { name: `<b>Bank & \"one\"</b>`, code: "ESC" });
  const noCode = await catalogue.create(actor, "bank", { name: "No code" });
  const removedCreated = await catalogue.create(actor, "bank", { name: "Old bank", code: "OLD" });
  const removed = await catalogue.remove(actor, "bank", removedCreated.id);
  const other = await catalogue.create(actor, "country", { name: "Elsewhere" });
  const calls = Object.fromEntries(methods.map((name) => [name, 0])) as Record<typeof methods[number], number>;
  for (const name of methods) {
    const original = catalogue[name].bind(catalogue) as (...args: never[]) => unknown;
    Object.defineProperty(catalogue, name, { value: async (...args: never[]) => {
      calls[name]++;
      if (name === "resolveHistorical" && options.resolveThrows) throw new Error("private catalogue detail");
      return original(...args);
    } });
  }
  const actualNavigation = createContextNavigation(rig.sessions, authz);
  const navigation = options.navigationThrows ? { open: async () => { throw new Error("private navigation detail"); } } : actualNavigation;
  const login = { ...rig.app, navigation, web: { origin: "https://studenthub.invalid", returnTo: "https://studenthub.invalid/" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, undefined, options.missing ? undefined : catalogue);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls, active, noCode, removed, other };
}

function onlyResolve(calls: Record<typeof methods[number], number>, count = 1) {
  assert.equal(calls.resolveHistorical, count, "REFENTRY_FIND resolves the historical entry exactly once");
  for (const name of methods) if (name !== "resolveHistorical") assert.equal(calls[name], 0, `REFENTRY_FIND does not call ${name}`);
}

test("REFENTRY_SHOW operator staff see escaped active and removed entry details", async (t) => {
  const f = await fixture(t);
  for (const who of ["staff", "admin"] as const) {
    const response = await f.request(`/reference-data/bank/${f.active.id}`, who), body = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /<h1>&lt;b&gt;Bank &amp; &quot;one&quot;&lt;\/b&gt;<\/h1>/, "REFENTRY_SHOW entry names are escaped");
    assert.doesNotMatch(body, /<b>Bank/); assert.match(body, /<dt>Code<\/dt><dd>ESC<\/dd>/); assert.match(body, /<dt>State<\/dt><dd>Active<\/dd>/);
    assert.match(body, /2026-11-23T00:00:00\.000Z/); assert.match(body, /href="\/reference-data">Reference data<\/a>/); assert.match(body, /href="\/reference-data\/bank">Back to Banks<\/a>/);
  }
  let body = await (await f.request(`/reference-data/bank/${f.noCode.id}`, "staff")).text(); assert.match(body, /<dt>Code<\/dt><dd>None<\/dd>/);
  body = await (await f.request(`/reference-data/bank/${f.removed.id}`, "staff")).text(); assert.match(body, /<h1>Old bank<\/h1>/); assert.match(body, /<dt>State<\/dt><dd>Removed<\/dd>/); assert.match(body, /<dt>Removed<\/dt><dd>2026-11-23T00:00:00\.000Z<\/dd>/);
  const head = await f.request(`/reference-data/bank/${f.active.id}`, "staff", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("REFENTRY_FIND reads only resolveHistorical and gives identical 404 pages", async (t) => {
  const good = await fixture(t); assert.equal((await good.request(`/reference-data/bank/${good.active.id}`, "staff")).status, 200); onlyResolve(good.calls);
  const paths = (f: Awaited<ReturnType<typeof fixture>>) => [`/reference-data/bank/00000000-0000-4000-8000-000000000099`, `/reference-data/bank/${f.other.id}`, "/reference-data/bank/not-a-uuid", `/reference-data/unknown/${f.active.id}`];
  let expected: string | undefined;
  for (let i = 0; i < 4; i++) { const f = await fixture(t); const response = await f.request(paths(f)[i]!, "staff"), body = await response.text(); assert.equal(response.status, 404, "REFENTRY_FIND missing and invalid entries are 404"); expected ??= body; assert.equal(body, expected, "REFENTRY_FIND every missing entry has the same body"); onlyResolve(f.calls, i < 2 ? 1 : 0); }
});

test("REFENTRY_DENY preserves staff authorization, query, and method behavior", async (t) => {
  const f = await fixture(t); const path = `/reference-data/bank/${f.active.id}`;
  const noSession = await f.request(path); assert.equal(noSession.status, 401); const indexNoSession = await f.request("/reference-data"); assert.equal(await noSession.text(), await indexNoSession.text(), "REFENTRY_DENY no session matches the list refusal");
  for (const who of ["owner", "recruiter", "local"] as const) { const response = await f.request(path, who); assert.equal(response.status, 404, "REFENTRY_DENY non-operator entry is hidden"); }
  assert.equal(f.calls.resolveHistorical, 0, "REFENTRY_DENY authorization happens before the entry read");
  assert.equal((await f.request(`${path}?x=1`, "staff")).status, 400); assert.equal((await f.request(path, "staff", { method: "POST" })).status, 404);
});

test("REFENTRY_PASSTHROUGH keeps existing reference-data and catalogue routes", async (t) => {
  const f = await fixture(t);
  for (const path of ["/reference-data", "/reference-data/bank", "/reference-data/bank?cursor=bad"]) assert.notEqual((await f.request(path, "staff")).status, 404, `REFENTRY_PASSTHROUGH ${path} remains handled`);
  assert.equal((await f.request(`/reference-data/bank/${f.active.id}/x`, "staff")).status, 404); const json = await f.request("/catalogue/bank"); assert.equal(json.status, 200); assert.match(json.headers.get("content-type")!, /application\/json/);
});

test("REFENTRY_UNAVAILABLE dependency failures are safe 503 pages", async (t) => {
  for (const options of [{ missing: true }, { navigationThrows: true }, { resolveThrows: true }]) { const f = await fixture(t, options); const response = await f.request(`/reference-data/bank/${f.active.id}`, "staff"), body = await response.text(); assert.equal(response.status, 503, "REFENTRY_UNAVAILABLE entry dependency failure is 503"); assert.match(body, /Reference data is unavailable right now\./); assert.doesNotMatch(body, /private .* detail|Error:|\n\s+at /); }
});
