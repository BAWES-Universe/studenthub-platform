import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryCatalogueStore, ReferenceCatalogue } from "@studenthub/reference-catalogue";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";

const sessions = { staff: "s".repeat(43), admin: "a".repeat(43), owner: "o".repeat(43), recruiter: "r".repeat(43), local: "l".repeat(43) };
const actor = { principalRef: "seed", orgId: "root", role: "staff" as const };

async function fixture(t: TestContext, options: { missing?: boolean; navigationThrows?: boolean; resolveThrows?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "StudentHub" }, { id: "org-a", name: "A", parentOrgId: "root" }] });
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("recruiter", [{ orgId: "org-a", role: "recruiter" }]);
  await authz.grantMany("local", [{ orgId: "org-a", role: "staff" }]);
  let clock = 0;
  const catalogue = new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date(clock++ ? "2026-11-24T05:06:07.000Z" : "2026-11-23T01:02:03.000Z"));
  const active = await catalogue.create(actor, "bank", { name: "A <bank> & co", code: "SAFE" });
  const noCode = await catalogue.create(actor, "bank", { name: "No code" });
  const removed = await catalogue.create(actor, "bank", { name: "Removed" });
  await catalogue.remove(actor, "bank", removed.id);
  const other = await catalogue.create(actor, "currency", { name: "Other" });
  const calls: Record<string, number> = {};
  for (const name of ["list", "resolveHistorical", "create", "update", "remove", "submit", "submissions", "moderate", "bankPaymentDetails", "currencyDetails"] as const) {
    const original = catalogue[name].bind(catalogue) as (...args: unknown[]) => unknown;
    (catalogue as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => { calls[name] = (calls[name] ?? 0) + 1; if (name === "resolveHistorical" && options.resolveThrows) throw new Error("private read detail"); return original(...args); };
  }
  const actual = createContextNavigation(rig.sessions, authz);
  const navigation = options.navigationThrows ? { open: async () => { throw new Error("private navigation detail"); } } : actual;
  const login = { ...rig.app, navigation, web: { origin: "https://studenthub.invalid", returnTo: "https://studenthub.invalid/" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, undefined, options.missing ? undefined : catalogue);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls, active, noCode, removed, other };
}

test("REFENTRY_SHOW staff and admin see escaped active and removed entry details", async (t) => {
  const f = await fixture(t);
  for (const who of ["staff", "admin"] as const) {
    const response = await f.request(`/reference-data/bank/${f.active.id}`, who), body = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /<h1>A &lt;bank&gt; &amp; co<\/h1>/, "REFENTRY_SHOW entry name is escaped"); assert.doesNotMatch(body, /<h1>A <bank>/);
    for (const value of ["SAFE", "Active", "2026-11-23T01:02:03.000Z", "2026-11-23T01:02:03.000Z"]) assert.match(body, new RegExp(value.replaceAll(".", "\\.")));
    assert.match(body, /href="\/reference-data">Reference data<\/a>/); assert.match(body, /href="\/reference-data\/bank">Back to Banks<\/a>/);
  }
  let body = await (await f.request(`/reference-data/bank/${f.noCode.id}`, "staff")).text(); assert.match(body, /<dt>Code<\/dt><dd>None<\/dd>/);
  body = await (await f.request(`/reference-data/bank/${f.removed.id}`, "staff")).text(); assert.match(body, /<dt>State<\/dt><dd>Removed<\/dd>/); assert.match(body, /<dt>Removed<\/dt><dd>2026-11-24T05:06:07.000Z<\/dd>/);
  const head = await f.request(`/reference-data/bank/${f.active.id}`, "staff", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("REFENTRY_FIND reads only resolveHistorical and returns identical not-found pages", async (t) => {
  const f = await fixture(t); const unknown = "00000000-0000-4000-8000-000000000000";
  const ok = await f.request(`/reference-data/bank/${f.active.id}`, "staff"); assert.equal(ok.status, 200); assert.equal(f.calls.resolveHistorical, 1, "REFENTRY_FIND resolveHistorical is called exactly once");
  assert.deepEqual(Object.fromEntries(Object.entries(f.calls).filter(([name]) => name !== "resolveHistorical")), {}, "REFENTRY_FIND no other catalogue method is called");
  const bodies: string[] = [];
  for (const path of [`/reference-data/bank/${unknown}`, `/reference-data/bank/${f.other.id}`, "/reference-data/bank/not-a-uuid", `/reference-data/unknown/${unknown}`]) { const response = await f.request(path, "staff"); assert.equal(response.status, 404, "REFENTRY_FIND unknown entries are 404"); bodies.push(await response.text()); }
  assert.ok(bodies.every((body) => body === bodies[0]), "REFENTRY_FIND every not-found body is byte-identical");
  assert.equal(f.calls.resolveHistorical, 3, "REFENTRY_FIND malformed ids and catalogues do not read");
});

test("REFENTRY_DENY preserves authorization query and method behavior", async (t) => {
  const f = await fixture(t), path = `/reference-data/bank/${f.active.id}`;
  assert.equal((await f.request(path)).status, 401);
  for (const who of ["owner", "recruiter", "local"] as const) assert.equal((await f.request(path, who)).status, 404);
  assert.equal(f.calls.resolveHistorical ?? 0, 0, "REFENTRY_DENY refused people never read the entry");
  assert.equal((await f.request(`${path}?x=1`, "staff")).status, 400);
  for (const method of ["POST", "DELETE"]) assert.equal((await f.request(path, "staff", { method })).status, 404);
});

test("REFENTRY_PASSTHROUGH leaves lists index longer paths and JSON API working", async (t) => {
  const f = await fixture(t);
  for (const path of ["/reference-data", "/reference-data/bank", "/reference-data/bank?cursor=bad", `/reference-data/bank/${f.active.id}/x`]) assert.notEqual((await f.request(path, "staff")).status, 500, `REFENTRY_PASSTHROUGH ${path} is handled normally`);
  const json = await f.request("/catalogue/bank"); assert.equal(json.status, 200); assert.match(json.headers.get("content-type")!, /application\/json/);
});

test("REFENTRY_UNAVAILABLE dependency failures are safe 503 pages", async (t) => {
  for (const options of [{ missing: true }, { navigationThrows: true }, { resolveThrows: true }]) {
    const f = await fixture(t, options), response = await f.request(`/reference-data/bank/${f.active.id}`, "staff"), body = await response.text();
    assert.equal(response.status, 503, "REFENTRY_UNAVAILABLE thrown reads are 503"); assert.match(body, /Reference data is unavailable right now\./); assert.doesNotMatch(body, /private .* detail|Error:|\n\s+at /);
  }
});
