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
  { store_id: STORE_B, name: "Zulu", location: null, status: "active", brand_id: null, brand_name: null, brand_status: null, mall_id: null, mall_name: null, mall_status: null },
  { store_id: STORE_A, name: "Alpha", location: "Kuwait City", status: "active", brand_id: STORE_B, brand_name: "Brand A", brand_status: "active", mall_id: STORE_C, mall_name: "Mall A", mall_status: "active" },
  { store_id: STORE_C, name: "Removed", location: "Hidden", status: "inactive", brand_id: null, brand_name: null, brand_status: null, mall_id: null, mall_name: null, mall_status: null },
];

async function fixture(t: TestContext, option: { configured?: boolean; service?: OrganizationStores; rows?: OrganizationStoreRow[] } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({
    principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })),
    organizations: [{ id: "root", name: "StudentHub" }, { id: "org-a", name: "A", parentOrgId: "root" }, { id: "org-b", name: "B", parentOrgId: "root" }, { id: "org-empty", name: "Empty", parentOrgId: "root" }],
  });
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("recruiter", [{ orgId: "org-a", role: "recruiter" }]);
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany("finance", [{ orgId: "org-a", role: "finance" }]);
  await authz.grantMany("candidate", [{ orgId: "org-a", role: "candidate" }]);
  await authz.grantMany("sibling", [{ orgId: "org-b", role: "org-owner" }]);
  const reads: string[] = [];
  const store: OrganizationStoresStore = {
    create: async () => ({ kind: "not_found" }), update: async () => ({ kind: "not_found" }), remove: async () => ({ kind: "not_found" }), childOrganizations: async () => [],
    async list(principalId, orgId) {
      reads.push(`${principalId}:${orgId}`);
      if (!["root", "org-a", "org-b", "org-empty"].includes(orgId)) return null;
      const grants = (await authz.listGrantsForPrincipal(principalId)).map((g) => ({ org_id: g.orgId, role: g.role, scope: g.scope }));
      const ancestors = orgId === "root" ? [] : ["root"];
      if (!organizationStoreReadDecision(grants, orgId, ancestors)) return null;
      return orgId === "org-a" ? (option.rows ?? active) : [];
    },
  };
  const service = option.service ?? createOrganizationStores({ sessions: rig.sessions, store });
  const organizations = new OrganizationRepository({ store: authz, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA], ["org-b", SYNTHETIC_ORGANIZATION_FIXTURES.unrelatedB]])) });
  const login = { ...rig.app, navigation: createContextNavigation(rig.sessions, authz, organizations), ...(option.configured === false ? {} : { organizationStores: service }), web: { origin: "https://studenthub.example.invalid", returnTo: "https://studenthub.example.invalid/workspace" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, reads };
}

test("STORES_LIST authorized company people see the sorted active store list", async (t) => {
  const f = await fixture(t);
  for (const who of ["owner", "recruiter", "staff"] as const) {
    const response = await f.request("/organization/org-a/stores", who), body = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(body.indexOf("Alpha") < body.indexOf("Zulu"), "STORES_LIST stores use service order");
    for (const value of ["Kuwait City", "Brand A", "Mall A", "None", 'href="/organization/org-a"']) assert.match(body, new RegExp(value));
    assert.doesNotMatch(body, /Removed|Hidden/);
  }
  assert.deepEqual(f.reads, ["owner:org-a", "recruiter:org-a", "staff:org-a"], "STORES_LIST exactly one service read per GET");
});

test("STORES_EMPTY a company without active stores has an explicit empty state", async (t) => {
  const f = await fixture(t, { rows: active.filter((row) => row.status !== "active") });
  const body = await (await f.request("/organization/org-a/stores", "owner")).text();
  assert.match(body, /No stores yet\./); assert.doesNotMatch(body, /<table/);
});

test("STORES_DENY refusals are private and no session stays unauthorized", async (t) => {
  const f = await fixture(t);
  const unauthorized = await f.request("/organization/org-a/stores"), unauthorizedText = await unauthorized.text();
  assert.equal(unauthorized.status, 401); assert.match(unauthorizedText, /Sign in/);
  const denied: Array<[string, keyof typeof sessions]> = [["/organization/org-a/stores", "finance"], ["/organization/org-a/stores", "candidate"], ["/organization/org-a/stores", "sibling"], ["/organization/unknown/stores", "staff"], ["/organization/root/stores", "staff"], ["/organization/%20/stores", "staff"]];
  let refusal: string | undefined;
  for (const [path, who] of denied) { const response = await f.request(path, who), body = await response.text(); assert.equal(response.status, 404, "STORES_DENY refused response is 404"); refusal ??= body; assert.equal(body, refusal, "STORES_DENY every refusal has one body"); }
  assert.equal(f.reads.length, 5, "STORES_DENY malformed ids do not read and each valid request reads once");
});

test("STORES_QUERY queries are invalid and write methods still fall through", async (t) => {
  const f = await fixture(t);
  const query = await f.request("/organization/org-a/stores?x=1", "owner"); assert.equal(query.status, 400, "STORES_QUERY query is 400"); assert.equal(f.reads.length, 0, "STORES_QUERY does not read");
  for (const method of ["POST", "PUT", "DELETE"]) { const response = await f.request("/organization/org-a/stores", "owner", { method }); const unknown = await f.request("/not-a-route", "owner", { method }); assert.equal(response.status, unknown.status); assert.equal(await response.text(), await unknown.text()); }
});

test("STORES_ESCAPE store names and locations are HTML escaped", async (t) => {
  const unsafe = "<img src=x onerror=1>";
  const f = await fixture(t, { rows: [{ ...active[0]!, name: unsafe, location: unsafe }] });
  const body = await (await f.request("/organization/org-a/stores", "owner")).text();
  assert.equal((body.match(/&lt;img src=x onerror=1&gt;/g) ?? []).length, 2, "STORES_ESCAPE both unsafe values are escaped"); assert.doesNotMatch(body, /<img src=x onerror=1>/);
});

test("STORES_DEGRADE unavailable and failed store services render a safe 503", async (t) => {
  for (const option of [{ configured: false }, { service: { list: async () => { throw new Error("private stack"); } } as unknown as OrganizationStores }, { service: { list: async () => ({ status: 503, body: { error: "down" } }) } as unknown as OrganizationStores }]) {
    const f = await fixture(t, option), response = await f.request("/organization/org-a/stores", "owner"), body = await response.text();
    assert.equal(response.status, 503, "STORES_DEGRADE failure is 503"); assert.match(body, /Stores unavailable/); assert.doesNotMatch(body, /No stores yet|private stack/);
  }
});
