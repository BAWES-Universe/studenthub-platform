import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES, organizationStoreReadDecision, type OrganizationStoreRow } from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";
import { createOrganizationStores, type OrganizationStores, type OrganizationStoresStore } from "../src/organization-stores.js";

const sessions = { owner: "a".repeat(43), recruiter: "b".repeat(43), staff: "c".repeat(43), finance: "d".repeat(43), candidate: "e".repeat(43), sibling: "f".repeat(43) };
const STORE_A = "123e4567-e89b-42d3-a456-426614174000", STORE_B = "223e4567-e89b-42d3-a456-426614174000", STORE_C = "323e4567-e89b-42d3-a456-426614174000";
const active: OrganizationStoreRow[] = [
  { store_id: STORE_B, name: "Other", location: null, status: "active", brand_id: null, brand_name: null, brand_status: null, mall_id: null, mall_name: null, mall_status: null },
  { store_id: STORE_A, name: "A <Store>", location: "Kuwait & City", status: "active", brand_id: STORE_B, brand_name: "Brand <A>", brand_status: "active", mall_id: STORE_C, mall_name: "Mall & A", mall_status: "active" },
  { store_id: STORE_C, name: "Inactive secret", location: "Hidden", status: "inactive", brand_id: null, brand_name: null, brand_status: null, mall_id: null, mall_name: null, mall_status: null },
];

async function fixture(t: TestContext, option: { configured?: boolean; service?: OrganizationStores; malformed?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "Root" }, { id: "org-a", name: "A", parentOrgId: "root" }, { id: "org-b", name: "B", parentOrgId: "root" }] });
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("recruiter", [{ orgId: "org-a", role: "recruiter" }]);
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany("finance", [{ orgId: "org-a", role: "finance" }]);
  await authz.grantMany("candidate", [{ orgId: "org-a", role: "candidate" }]);
  await authz.grantMany("sibling", [{ orgId: "org-b", role: "org-owner" }]);
  const calls = { list: [] as string[], create: 0, update: 0, remove: 0 };
  const store: OrganizationStoresStore = {
    async create() { calls.create++; return { kind: "not_found" }; }, async update() { calls.update++; return { kind: "not_found" }; }, async remove() { calls.remove++; return { kind: "not_found" }; }, childOrganizations: async () => [],
    async list(principalId, orgId) { calls.list.push(`${principalId}:${orgId}`); const grants = (await authz.listGrantsForPrincipal(principalId)).map((g) => ({ org_id: g.orgId, role: g.role, scope: g.scope })); if (!organizationStoreReadDecision(grants, orgId, orgId === "root" ? [] : ["root"])) return null; return orgId === "org-a" ? active : []; },
  };
  const service = option.service ?? (option.malformed ? { list: async () => ({ status: 200, body: { stores: [{ nope: true }] } }) } as unknown as OrganizationStores : createOrganizationStores({ sessions: rig.sessions, store }));
  const organizations = new OrganizationRepository({ store: authz, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA], ["org-b", SYNTHETIC_ORGANIZATION_FIXTURES.unrelatedB]])) });
  const login = { ...rig.app, navigation: createContextNavigation(rig.sessions, authz, organizations), ...(option.configured === false ? {} : { organizationStores: service }), web: { origin: "https://studenthub.example.invalid", returnTo: "https://studenthub.example.invalid/workspace" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls };
}

test("STOREDET_SHOW authorized company people see one escaped store and HEAD works", async (t) => {
  const f = await fixture(t);
  for (const who of ["owner", "recruiter", "staff"] as const) { const response = await f.request(`/organization/org-a/stores/${STORE_A}`, who), body = await response.text(); assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(body, /<h1>A &lt;Store&gt;<\/h1>/, "STOREDET_SHOW store name is escaped"); for (const value of ["Kuwait &amp; City", "Brand &lt;A&gt;", "Mall &amp; A", 'href="/organization/org-a"', 'href="/organization/org-a/stores"']) assert.match(body, new RegExp(value)); assert.doesNotMatch(body, /Other|Inactive secret|<Store>/); }
  const none = await (await f.request(`/organization/org-a/stores/${STORE_B}`, "owner")).text(); assert.equal((none.match(/<dd>None<\/dd>/g) ?? []).length, 3);
  const head = await f.request(`/organization/org-a/stores/${STORE_A}`, "owner", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("STOREDET_MINE detail selects the requested visible store from exactly one list read", async (t) => {
  const f = await fixture(t); const missingBodies: string[] = [];
  for (const path of [`/organization/org-a/stores/${STORE_C}`, `/organization/org-a/stores/423e4567-e89b-42d3-a456-426614174000`, `/organization/org-b/stores/${STORE_A}`]) { const response = await f.request(path, path.includes("org-b") ? "sibling" : "owner"); assert.equal(response.status, 404, "STOREDET_MINE hidden store is 404"); missingBodies.push(await response.text()); }
  const before = f.calls.list.length; const malformed = await f.request("/organization/org-a/stores/not-a-store", "owner"); assert.equal(malformed.status, 404); assert.equal(f.calls.list.length, before, "STOREDET_MINE malformed store id does not call list"); missingBodies.push(await malformed.text()); assert.ok(missingBodies.every((body) => body === missingBodies[0]), "STOREDET_MINE private refusals have byte-identical bodies"); assert.equal(f.calls.list.length, 3, "STOREDET_MINE each valid detail calls list once"); assert.deepEqual([f.calls.create, f.calls.update, f.calls.remove], [0, 0, 0]);
});

test("STOREDET_DENY authentication query and methods preserve existing answers", async (t) => {
  const f = await fixture(t); const unauth = await f.request(`/organization/org-a/stores/${STORE_A}`); assert.equal(unauth.status, 401); assert.match(await unauth.text(), /Sign in/);
  for (const who of ["finance", "candidate", "sibling"] as const) assert.equal((await f.request(`/organization/org-a/stores/${STORE_A}`, who)).status, 404);
  const before = f.calls.list.length; const query = await f.request(`/organization/org-a/stores/${STORE_A}?x=1`, "owner"); assert.equal(query.status, 400, "STOREDET_DENY query is 400"); assert.equal(f.calls.list.length, before);
  for (const method of ["POST", "PUT", "DELETE"]) { const detail = await f.request(`/organization/org-a/stores/${STORE_A}`, "owner", { method }); const unknown = await f.request("/not-a-route", "owner", { method }); assert.equal(detail.status, unknown.status); assert.equal(await detail.text(), await unknown.text()); }
});

test("STOREDET_PASSTHROUGH existing and deeper paths are not captured", async (t) => {
  const f = await fixture(t); for (const path of ["/organization/org-a/stores", "/organization/org-a", "/organization/org-a/notes", "/organization/org-a/edit", "/organization/stores/org-a", `/organization/org-a/stores/${STORE_A}/x`]) { const response = await f.request(path, "owner"); assert.notEqual(response.status, 500, `STOREDET_PASSTHROUGH ${path}`); } assert.equal(f.calls.list.length, 2, "STOREDET_PASSTHROUGH only list page and stores API read");
});

test("STOREDET_UNAVAILABLE detail failures use the safe stores unavailable page", async (t) => {
  for (const option of [{ configured: false }, { malformed: true }, { service: { list: async () => { throw new Error("private stack"); } } as unknown as OrganizationStores }, { service: { list: async () => ({ status: 503, body: { error: "down" } }) } as unknown as OrganizationStores }]) { const f = await fixture(t, option), response = await f.request(`/organization/org-a/stores/${STORE_A}`, "owner"), body = await response.text(); assert.equal(response.status, 503, "STOREDET_UNAVAILABLE failure is 503"); assert.match(body, /Stores unavailable/); assert.doesNotMatch(body, /private stack|A &lt;Store&gt;/); }
});
