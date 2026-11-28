import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryCatalogueStore, ReferenceCatalogue, type CatalogueItem } from "@studenthub/reference-catalogue";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";

const ids = { active: "11111111-1111-4111-8111-111111111111", removed: "22222222-2222-4222-8222-222222222222", other: "33333333-3333-4333-8333-333333333333", missing: "44444444-4444-4444-8444-444444444444" };
const sessions = { staff: "s".repeat(43), admin: "a".repeat(43), owner: "o".repeat(43), recruiter: "r".repeat(43), local: "l".repeat(43) };
const items: CatalogueItem[] = [
  { id: ids.active, type: "bank", name: "<Active & bank>", code: "A&B", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z" },
  { id: ids.removed, type: "bank", name: "Removed bank", status: "deleted", createdAt: "2026-03-03T00:00:00.000Z", updatedAt: "2026-04-04T00:00:00.000Z", deletedAt: "2026-05-05T00:00:00.000Z" },
  { id: ids.other, type: "country", name: "Other catalogue", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

async function fixture(t: TestContext, options: { missing?: boolean; navigationThrows?: boolean; resolveThrows?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "StudentHub" }, { id: "org-a", name: "A", parentOrgId: "root" }] });
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("recruiter", [{ orgId: "org-a", role: "recruiter" }]);
  await authz.grantMany("local", [{ orgId: "org-a", role: "staff" }]);
  const store = new InMemoryCatalogueStore();
  for (const item of items) await store.createItem({ ...item, actorRef: "seed" });
  const catalogue = new ReferenceCatalogue(store); let resolves = 0;
  const original = catalogue.resolveHistorical.bind(catalogue);
  catalogue.resolveHistorical = (async (...args: Parameters<ReferenceCatalogue["resolveHistorical"]>) => { resolves++; if (options.resolveThrows) throw new Error("private resolve detail"); return original(...args); }) as ReferenceCatalogue["resolveHistorical"];
  const actual = createContextNavigation(rig.sessions, authz);
  const navigation = options.navigationThrows ? { open: async () => { throw new Error("private navigation detail"); } } : actual;
  const login = { ...rig.app, navigation, web: { origin: "https://studenthub.invalid", returnTo: "https://studenthub.invalid/" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, undefined, options.missing ? undefined : catalogue);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, resolves: () => resolves };
}

test("REFENTRY_SHOW staff and admins see active and removed entry details", async (t) => {
  const f = await fixture(t);
  for (const who of ["staff", "admin"] as const) {
    const response = await f.request(`/reference-data/bank/${ids.active}`, who), body = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /<h1>&lt;Active &amp; bank&gt;<\/h1>/, "REFENTRY_SHOW entry names are escaped"); assert.doesNotMatch(body, /<Active & bank>/);
    assert.match(body, /A&amp;B/); assert.match(body, /<dd>Active<\/dd>/); assert.match(body, /2026-01-01T00:00:00.000Z/); assert.match(body, /2026-02-02T00:00:00.000Z/);
    assert.match(body, /href="\/reference-data">Reference data/); assert.match(body, /href="\/reference-data\/bank">Back to Banks/);
  }
  const removed = await (await f.request(`/reference-data/bank/${ids.removed}`, "staff")).text(); assert.match(removed, /<dd>None<\/dd>/); assert.match(removed, /<dd>Removed<\/dd>/); assert.match(removed, /2026-05-05T00:00:00.000Z/);
  const head = await f.request(`/reference-data/bank/${ids.active}`, "staff", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("REFENTRY_FIND reads once and gives identical 404 pages without unrelated reads", async (t) => {
  const f = await fixture(t); const good = await f.request(`/reference-data/bank/${ids.active}`, "staff"); assert.equal(good.status, 200); assert.equal(f.resolves(), 1, "REFENTRY_FIND resolveHistorical is called exactly once");
  const bodies: string[] = [];
  for (const path of [`/reference-data/bank/${ids.missing}`, `/reference-data/bank/${ids.other}`, "/reference-data/bank/not-a-uuid", `/reference-data/unknown/${ids.active}`]) { const before = f.resolves(); const response = await f.request(path, "staff"); assert.equal(response.status, 404, "REFENTRY_FIND unknown entries are 404"); bodies.push(await response.text()); if (path.includes("not-a-uuid") || path.includes("/unknown/")) assert.equal(f.resolves(), before, "REFENTRY_FIND invalid paths do not resolve"); }
  assert.ok(bodies.every((body) => body === bodies[0]), "REFENTRY_FIND all missing entries have byte-identical bodies");
});

test("REFENTRY_DENY authenticates before reading and preserves query and method behavior", async (t) => {
  const f = await fixture(t); const unauthenticated = await f.request(`/reference-data/bank/${ids.active}`); assert.equal(unauthenticated.status, 401);
  for (const who of ["owner", "recruiter", "local"] as const) assert.equal((await f.request(`/reference-data/bank/${ids.active}`, who)).status, 404);
  assert.equal(f.resolves(), 0, "REFENTRY_DENY refused people never resolve an entry");
  assert.equal((await f.request(`/reference-data/bank/${ids.active}?x=1`, "staff")).status, 400); assert.equal((await f.request(`/reference-data/bank/${ids.active}`, "staff", { method: "POST" })).status, 404);
});

test("REFENTRY_UNAVAILABLE dependency and entry read failures are safe 503 pages", async (t) => {
  for (const options of [{ missing: true }, { navigationThrows: true }, { resolveThrows: true }]) { const f = await fixture(t, options); const response = await f.request(`/reference-data/bank/${ids.active}`, "staff"), body = await response.text(); assert.equal(response.status, 503, "REFENTRY_UNAVAILABLE dependency failure is 503"); assert.match(body, /Reference data is unavailable right now\./); assert.doesNotMatch(body, /private .* detail|Error:|\n\s+at /); }
});
