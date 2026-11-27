import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES } from "@studenthub/organizations";
import { PlacementService, type Assignment, type WorkGrant } from "../../../packages/work/src/index.js";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";

// O-07 a company's candidates. Synthetic people, companies and stores only.
const sessions = { owner: "a".repeat(43), groupOwner: "b".repeat(43), recruiter: "c".repeat(43), staff: "d".repeat(43), finance: "e".repeat(43), candidate: "g".repeat(43), sibling: "h".repeat(43) };
const GRANTS: Record<string, WorkGrant[]> = {
  owner: [{ orgId: "org-a", role: "org-owner", scope: "self" }], groupOwner: [{ orgId: "org-a", role: "org-owner", scope: "subtree" }],
  recruiter: [{ orgId: "org-a", role: "recruiter", scope: "self" }], staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  finance: [{ orgId: "org-a", role: "finance", scope: "self" }], candidate: [{ orgId: "org-a", role: "candidate", scope: "self" }], sibling: [{ orgId: "org-b", role: "org-owner", scope: "self" }],
};
const PARENT: Record<string, string> = { "org-a": "root", "org-a1": "org-a", "org-b": "root" };
const S = { a: "123e4567-e89b-42d3-a456-426614174001", second: "123e4567-e89b-42d3-a456-426614174002", kids: "123e4567-e89b-42d3-a456-426614174003", b: "123e4567-e89b-42d3-a456-426614174004" };
const CONTRACT = "c0ffee00-0000-4000-8000-000000000001";
let n = 0;
const placed = (personId: string, orgId: string, storeId: string, startDate: string, endDate: string | null): Assignment => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, personId, orgId, storeId, payContractId: CONTRACT, contractResolution: {} as never,
  startDate, endDate, warnings: [], source: "staff" as never, requestId: null, recruitCardId: null, recruitRequestId: null,
} as unknown as Assignment);
const ASSIGNMENTS = [
  placed("badr", "org-a", S.second, "2020-01-01", "2020-06-30"),
  placed("amal", "org-a", S.second, "2020-01-01", "2020-06-30"),
  placed("amal", "org-a", S.a, "2021-01-01", null),
  placed("zaid", "org-a", S.a, "2999-01-01", null),
  placed("carl", "org-a1", S.kids, "2022-01-01", null),
  placed("dina", "org-b", S.b, "2022-01-01", null),
];
const NAMES = new Map([["amal", "Amal <Synthetic>"], ["badr", "Badr"], ["carl", "Carl"], ["dina", "Dina"]]);
const STORES = new Map([[S.a, "A <Store>"], [S.second, "Second"], [S.kids, "Kids store"], [S.b, "Outside store"]]);

async function fixture(t: TestContext, option: { configured?: boolean; failing?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "Root" }, { id: "org-a", name: "A", parentOrgId: "root" }, { id: "org-b", name: "B", parentOrgId: "root" }] });
  const calls: string[] = [];
  const ancestors = (org: string): string[] => PARENT[org] ? [PARENT[org]!, ...ancestors(PARENT[org]!)] : [];
  const store = {
    organizationAncestors: async (org: string) => org === "root" || PARENT[org] ? ancestors(org) : undefined,
    listAssignments: async (f: { orgIds?: readonly string[]; includeSubtree?: boolean }) => {
      calls.push(`list:${f.orgIds?.join(",")}:${f.includeSubtree}`);
      if (option.failing) throw new Error("database down");
      return ASSIGNMENTS.filter((a) => f.orgIds!.includes(a.orgId) || (f.includeSubtree && ancestors(a.orgId).some((o) => f.orgIds!.includes(o))));
    },
  };
  const placements = new PlacementService({ store: store as never, grants: { listGrantsForPrincipal: async (id) => GRANTS[id] ?? [] }, newId: () => "unused" });
  const work = {
    personFor: async (s: string) => (await rig.sessions.get(s))?.personId, placements,
    personNames: async (ids: readonly string[]) => new Map(ids.flatMap((id) => NAMES.has(id) ? [[id, NAMES.get(id)!] as const] : [])),
    storeNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, STORES.get(id)!] as const)),
  };
  const organizations = new OrganizationRepository({ store: authz, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA], ["org-b", SYNTHETIC_ORGANIZATION_FIXTURES.unrelatedB]])) });
  const login = { ...rig.app, navigation: createContextNavigation(rig.sessions, authz, organizations), ...(option.configured === false ? {} : { work }), web: { origin: "https://studenthub.example.invalid", returnTo: "https://studenthub.example.invalid/workspace" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls };
}

const rowsOf = (html: string) => [...html.matchAll(/<tr><th scope="row">(.*?)<\/tr>/g)].map((m) => m[1]!);

test("ORGCAND_LIST the company's owners and recruiters, and staff, see who is placed at its stores, working now first", async (t) => {
  const f = await fixture(t);
  for (const who of ["owner", "recruiter"] as const) {
    const response = await f.request("/organization/org-a/candidates", who), body = await response.text();
    assert.equal(response.status, 200, who); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(rowsOf(body), [
      '<a href="/organization/org-a/candidates/amal">Amal &lt;Synthetic&gt;</a></th><td>A &lt;Store&gt;</td><td>Working now</td>',
      '<a href="/organization/org-a/candidates/badr">Badr</a></th><td>Second</td><td>1 January 2020 to 30 June 2020</td>',
      '<a href="/organization/org-a/candidates/zaid">Unnamed person</a></th><td>A &lt;Store&gt;</td><td>From 1 January 2999</td>'], who);
    assert.match(body, /<nav aria-label="Breadcrumb"><a href="\/organization\/org-a">Company<\/a><\/nav><h1>Candidates<\/h1>/);
    for (const hidden of ["Carl", "Kids store", "Dina", "Outside store", CONTRACT, "<Synthetic>"]) assert.equal(body.includes(hidden), false, `${who}: ${hidden}`);
  }
  for (const who of ["groupOwner", "staff"] as const) {
    const body = await (await f.request("/organization/org-a/candidates", who)).text();
    assert.ok(body.includes('<a href="/organization/org-a/candidates/carl">Carl</a></th><td>Kids store</td><td>Working now</td>'), `${who} reaches the sub-company`);
    assert.equal(body.includes("Dina"), false);
  }
  const head = await f.request("/organization/org-a/candidates", "owner", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
  assert.match(await (await f.request("/organization/org-b/candidates", "sibling")).text(), /<td>Outside store<\/td><td>Working now<\/td>/);
});

test("ORGCAND_DETAIL one person shows each placement at the company, latest first; nobody else's", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/organization/org-a/candidates/amal", "owner"), body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /<a href="\/organization\/org-a">Company<\/a><a href="\/organization\/org-a\/candidates">Candidates<\/a><\/nav><h1>Amal &lt;Synthetic&gt;<\/h1>/);
  assert.deepEqual(rowsOf(body), ["A &lt;Store&gt;</th><td>From 1 January 2021</td><td>Working now</td>", "Second</th><td>1 January 2020 to 30 June 2020</td><td>Ended</td>"], "only this person, latest first");
  assert.equal(body.includes(CONTRACT), false);
  assert.deepEqual(rowsOf(await (await f.request("/organization/org-a/candidates/zaid", "recruiter")).text()), ["A &lt;Store&gt;</th><td>From 1 January 2999</td><td>Starts later</td>"], "only this person, latest first");
  assert.equal((await f.request("/organization/org-a/candidates/carl", "groupOwner")).status, 200);
});

test("ORGCAND_DENY sign in first; any other role, another company, a person not placed there and bad input are the same not found", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/organization/org-a/candidates")).status, 401);
  assert.equal((await f.request("/organization/org-a/candidates/amal")).status, 401);
  const bodies: string[] = [];
  for (const [path, who] of [["/organization/org-a/candidates", "finance"], ["/organization/org-a/candidates", "candidate"], ["/organization/org-a/candidates", "sibling"],
    ["/organization/org-a/candidates/amal", "sibling"], ["/organization/org-a/candidates/dina", "owner"], ["/organization/org-a/candidates/carl", "owner"],
    ["/organization/org-a/candidates/nobody", "staff"], ["/organization/unknown/candidates", "staff"], ["/organization/org-a/candidates/%E0%A4%A", "owner"],
    ["/organization/org-a/candidates/a%20b", "owner"]] as const) {
    const response = await f.request(path, who); assert.equal(response.status, 404, `${who} ${path}`); bodies.push(await response.text());
  }
  assert.ok(bodies.every((b) => b === bodies[0]), "every refusal reads the same");
  const before = f.calls.length;
  assert.equal((await f.request("/organization/org-a/candidates?x=1", "owner")).status, 400, "a query is refused");
  assert.equal((await f.request("/organization/org-a/candidates/a%20b", "owner")).status, 404);
  assert.equal(f.calls.length, before, "bad input never reads placements");
  for (const method of ["POST", "PUT", "DELETE"]) {
    const page = await f.request("/organization/org-a/candidates", "owner", { method }), unknown = await f.request("/not-a-route", "owner", { method });
    assert.equal(page.status, unknown.status); assert.equal(await page.text(), await unknown.text());
  }
});

test("ORGCAND_UNAVAILABLE no work service or a failing read is unavailable, never an empty list", async (t) => {
  for (const option of [{ configured: false }, { failing: true }]) {
    const f = await fixture(t, option);
    for (const path of ["/organization/org-a/candidates", "/organization/org-a/candidates/amal"]) {
      const response = await f.request(path, "owner"); assert.equal(response.status, 503, path); assert.match(await response.text(), /Candidates unavailable/);
    }
  }
});
