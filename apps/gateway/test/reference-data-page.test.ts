import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { CATALOGUE_TYPES, InMemoryCatalogueStore, ReferenceCatalogue } from "@studenthub/reference-catalogue";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";

const sessions = { staff: "s".repeat(43), admin: "a".repeat(43), owner: "o".repeat(43), recruiter: "r".repeat(43), local: "l".repeat(43), none: "n".repeat(43) };
const actor = { principalRef: "seed", orgId: "root", role: "staff" as const };

async function fixture(t: TestContext, options: { missing?: boolean; navigationThrows?: boolean; listThrows?: boolean; seed?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "StudentHub" }, { id: "org-a", name: "A", parentOrgId: "root" }] });
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("recruiter", [{ orgId: "org-a", role: "recruiter" }]);
  await authz.grantMany("local", [{ orgId: "org-a", role: "staff" }]);
  const catalogue = new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date("2026-11-23T00:00:00.000Z"));
  if (options.seed !== false) {
    await catalogue.create(actor, "bank", { name: "Alpha", code: "ALP" });
    await catalogue.create(actor, "bank", { name: "No code" });
    await catalogue.create(actor, "bank", { name: "<script>x</script>" });
    const removed = await catalogue.create(actor, "bank", { name: "Removed" }); await catalogue.remove(actor, "bank", removed.id);
  }
  const originalList = catalogue.list.bind(catalogue); let reads = 0;
  catalogue.list = (async (...args: Parameters<ReferenceCatalogue["list"]>) => { reads++; if (options.listThrows) throw new Error("private list detail"); return originalList(...args); }) as ReferenceCatalogue["list"];
  const actual = createContextNavigation(rig.sessions, authz);
  const navigation = options.navigationThrows ? { open: async () => { throw new Error("private navigation detail"); } } : actual;
  const login = { ...rig.app, navigation, web: { origin: "https://studenthub.invalid", returnTo: "https://studenthub.invalid/" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, undefined, options.missing ? undefined : catalogue);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, catalogue, reads: () => reads };
}

test("REF_INDEX staff and admins see every reference catalogue in order", async (t) => {
  const f = await fixture(t); const labels = ["Countries", "Currencies", "Banks", "Tags", "Brands", "Malls", "Universities", "Majors", "Degrees", "Degree groups", "Areas"];
  for (const who of ["staff", "admin"] as const) { const response = await f.request("/reference-data", who), body = await response.text(); assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(body, /<h1>Reference data<\/h1>/); let at = -1; CATALOGUE_TYPES.forEach((type, i) => { const found = body.indexOf(`href="/reference-data/${type}">${labels[i]}</a>`); assert.ok(found > at, "REF_INDEX catalogue links use the specified order"); at = found; }); }
});

test("REF_LIST lists escaped active entries, empty state, and cursor pages", async (t) => {
  const f = await fixture(t); let response = await f.request("/reference-data/bank", "staff"), body = await response.text(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(body, /<h1>Banks<\/h1>/); assert.match(body, /href="\/reference-data">Reference data<\/a>/); assert.match(body, /Alpha/); assert.match(body, /ALP/); assert.match(body, /No code<\/th><td>None/); assert.doesNotMatch(body, /Removed/); assert.match(body, /&lt;script&gt;x&lt;\/script&gt;/, "REF_LIST entry names are escaped"); assert.doesNotMatch(body, /<script>x<\/script>/);
  const empty = await fixture(t, { seed: false }); body = await (await empty.request("/reference-data/bank", "staff")).text(); assert.match(body, /No entries yet\./); assert.doesNotMatch(body, /<table/);
  for (let i = 0; i < 51; i++) await f.catalogue.create(actor, "bank", { name: `Paged ${String(i).padStart(2, "0")}` });
  response = await f.request("/reference-data/bank", "staff"); body = await response.text(); const href = body.match(/href="(\/reference-data\/bank\?cursor=[^"]+)">Next page/)?.[1]; assert.ok(href, "REF_LIST a full page links to the next page"); const second = await (await f.request(href.replace(/&amp;/g, "&"), "staff")).text(); assert.match(second, /Paged 50/); assert.doesNotMatch(second, /Paged 00/, "REF_LIST following the cursor does not repeat first-page entries");
});

test("REF_STAFF only operator staff contexts may read either page", async (t) => {
  const f = await fixture(t); const noSession = await f.request("/reference-data"); assert.equal(noSession.status, 401); const bodies: string[] = [];
  for (const who of ["none", "owner", "recruiter", "local"] as const) for (const path of ["/reference-data", "/reference-data/bank"]) { const response = await f.request(path, who); assert.equal(response.status, 404, "REF_STAFF non-operator context is hidden"); bodies.push(await response.text()); }
  assert.ok(bodies.every((body) => body === bodies[0]), "REF_STAFF every signed-in refusal has the same body"); assert.equal(f.reads(), 0, "REF_STAFF refused people never read the catalogue");
});

test("REF_QUERY rejects unknown catalogues and malformed queries", async (t) => {
  const f = await fixture(t); const unknown = await f.request("/reference-data/planets", "staff"); assert.equal(unknown.status, 404); const secondKey = await f.request("/reference-data/bank?x=1&y=2", "staff"); assert.equal(secondKey.status, 400, "REF_QUERY a second query key is rejected"); for (const path of ["/reference-data?x=1", "/reference-data/bank?x=1", "/reference-data/bank?cursor=", "/reference-data/bank?cursor=a&cursor=b", "/reference-data/bank?cursor=bad"]) { const response = await f.request(path, "staff"); assert.equal(response.status, 400, `REF_QUERY rejects ${path}`); assert.match(await response.text(), /class="error-page"/); }
});

test("REF_UNAVAILABLE missing and failed dependencies are safe 503 pages", async (t) => {
  for (const options of [{ missing: true }, { listThrows: true }, { navigationThrows: true }]) { const f = await fixture(t, options); for (const path of options.listThrows ? ["/reference-data/bank"] : ["/reference-data", "/reference-data/bank"]) { const response = await f.request(path, "staff"), body = await response.text(); assert.equal(response.status, 503, "REF_UNAVAILABLE dependency failure is 503"); assert.match(body, /Reference data is unavailable right now\./); assert.doesNotMatch(body, /private .* detail|Error:|\n\s+at /); } }
});

test("REF_PASSTHROUGH routing preserves catalogue JSON and unrelated requests", async (t) => {
  const f = await fixture(t); const json = await f.request("/catalogue/bank"); assert.equal(json.status, 200); assert.match(json.headers.get("content-type")!, /application\/json/); assert.deepEqual(Object.keys(await json.json() as object), ["items", "nextCursor"]);
  for (const [path, method] of [["/reference-data/bank/x", "GET"], ["/reference-datax", "GET"], ["/reference-data", "POST"], ["/reference-data/bank", "DELETE"]]) { const response = await f.request(path, "staff", { method }); assert.equal(response.status, 404, `REF_PASSTHROUGH ${method} ${path} falls through`); }
  const server = createGatewayServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); const address = server.address(); assert.ok(address && typeof address !== "string"); assert.equal((await fetch(`http://127.0.0.1:${address.port}/reference-data`)).status, 404, "REF_PASSTHROUGH no browser login falls through");
});
