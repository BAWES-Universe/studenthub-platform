import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import {
  InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES,
  ORGANIZATION_FIELD_CONTRACT, ORGANIZATION_FIELDS_BY_AUDIENCE, type OrganizationDeletionRecords,
} from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation, type ContextNavigation } from "../src/context-navigation.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "o".repeat(43);
const cookie = { cookie: `__Host-studenthub_session=${SESSION}`, accept: "text/html" };

async function fixture(t: TestContext, options: { calls?: URLSearchParams[]; unavailable?: boolean; throwing?: boolean; serviceUnavailable?: boolean; evilNames?: boolean; deleted?: readonly string[] } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: ["one@example.invalid"] }],
    organizations: [{ id: "root", name: "Root" }, { id: "org-a", name: "Registry A", parentOrgId: "root" },
      { id: "org-a1", name: "Registry Child", parentOrgId: "org-a" }, { id: "org-b", name: "Registry B", parentOrgId: "root" }],
  });
  await store.grantMany("person-1", [{ orgId: "org-a", role: "org-owner", scope: "subtree" }, { orgId: "org-a", role: "recruiter" },
    { orgId: "root", role: "staff", scope: "subtree" }, { orgId: "root", role: "admin", scope: "subtree" }]);
  const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
  const organizations = new OrganizationRepository({ store, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", options.evilNames ? { ...parentA, company_name: "<script>x</script>", company_common_name_en: "<script>x</script>" } : parentA], ["org-a1", childA1], ["org-b", unrelatedB],
  ])) });
  const deleted = new Set(options.deleted ?? []);
  const deletions: OrganizationDeletionRecords = { isDeleted: async (orgId) => deleted.has(orgId), deletedAmong: async (orgIds) => new Set(orgIds.filter((orgId) => deleted.has(orgId))) };
  const actual = createContextNavigation(rig.sessions, store, organizations, deletions);
  const navigation: ContextNavigation = { async open(session, selection) {
    options.calls?.push(new URLSearchParams(selection));
    if (options.throwing) throw new Error("private navigation detail");
    if (options.serviceUnavailable) return { status: 503, body: { error: "private service detail" } };
    const result = await actual.open(session, selection);
    if (options.unavailable && selection.size > 0 && result.status === 200) return { ...result, body: { ...result.body, organization: { kind: "unavailable" } } };
    return result;
  } };
  const login: BrowserLoginApplication = { ...rig.app, navigation };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const get = (path: string, authenticated = true) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: authenticated ? cookie : { accept: "text/html" } });
  return { get, store };
}

test("OVW_READ member sees exactly the audience projection", async (t) => {
  const f = await fixture(t);
  const owner = await f.get("/organization/org-a1"); const body = await owner.text();
  assert.equal(owner.status, 200); assert.equal(owner.headers.get("cache-control"), "no-store");
  assert.match(body, /<h1>Synthetic Retail Kuwait City<\/h1>/);
  for (const field of ORGANIZATION_FIELDS_BY_AUDIENCE.employer) {
    assert.ok(body.includes(`>${ORGANIZATION_FIELD_CONTRACT[field].label}<`), `OVW_READ shows ${field}`);
  }
  assert.match(body, /data-state="unavailable">Unavailable</); assert.doesNotMatch(body, />Company email<|>Status set by staff<|>Bonus commission \(%\)</);
  const staff = await (await f.get("/organization/org-a?role=staff")).text();
  assert.match(staff, />Company email</, "OVW_READ staff sees company email");
});

test("OVW_ROLE role selection is complete, deterministic and strict", async (t) => {
  const calls: URLSearchParams[] = []; const f = await fixture(t, { calls });
  assert.equal((await f.get("/organization/org-a")).status, 200);
  assert.deepEqual(calls.map(String), ["", "org_id=org-a&role=org-owner"], "OVW_ROLE default opens list then first held role");
  calls.length = 0; assert.equal((await f.get("/organization/org-a?role=staff")).status, 200);
  assert.deepEqual(calls.map(String), ["", "org_id=org-a&role=staff"], "OVW_ROLE explicit opens exact pair");
  calls.length = 0; assert.equal((await f.get("/organization/org-a?role=&x=1")).status, 400); assert.equal(calls.length, 0, "OVW_ROLE invalid query reads nothing");
});

test("OVW_DENY every authenticated refusal has the same 404 body", async (t) => {
  const calls: URLSearchParams[] = []; const f = await fixture(t, { calls }); const bodies: string[] = [];
  for (const path of ["/organization/missing", "/organization/org-b?role=org-owner", "/organization/org-a?role=candidate", "/organization/%20"]) {
    const response = await f.get(path); assert.equal(response.status, 404, `OVW_DENY ${path} is hidden`); bodies.push(await response.text());
    if (path.includes("org-b")) assert.equal(calls.length, 2, "OVW_DENY /organization/org-b?role=org-owner is hidden");
  }
  assert.ok(bodies.every((body) => body === bodies[0]), "OVW_DENY refusal bodies are byte-identical");
  const deleted = await fixture(t, { deleted: ["org-a"] }); const deletedResponse = await deleted.get("/organization/org-a");
  assert.equal(deletedResponse.status, 404); assert.equal(await deletedResponse.text(), bodies[0], "OVW_DENY deleted organization is byte-identical");
  assert.equal((await f.get("/organization/org-a", false)).status, 401);
});

test("OVW_LINKS actions and sub-organizations follow the active role", async (t) => {
  const f = await fixture(t); const owner = await (await f.get("/organization/org-a")).text();
  assert.match(owner, /href="\/organization\/org-a\/edit">Edit company details</, "OVW_LINKS owner sees Edit");
  assert.match(owner, /href="\/organization\/org-a\/stores">Stores</); assert.match(owner, /href="\/organization\/org-a1">/);
  const staff = await (await f.get("/organization/org-a?role=staff")).text();
  assert.doesNotMatch(staff, />Edit company details</, "OVW_LINKS staff has no Edit"); assert.match(staff, />Stores</);
  for (const role of ["recruiter", "admin"]) {
    const body = await (await f.get(`/organization/org-a?role=${role}`)).text();
    assert.doesNotMatch(body, />Edit company details</); assert.match(body, />Stores</);
  }
});

test("OVW_ESCAPE company names are escaped", async (t) => {
  const f = await fixture(t, { evilNames: true }); const body = await (await f.get("/organization/org-a")).text();
  assert.match(body, /<h1>&lt;script&gt;x&lt;\/script&gt;<\/h1>/, "OVW_ESCAPE heading is escaped"); assert.doesNotMatch(body, /<script>x<\/script>/);
});

test("OVW_DEGRADE unavailable data is a notice and failures are plain 503 pages", async (t) => {
  const notice = await (await (await fixture(t, { unavailable: true })).get("/organization/org-a")).text();
  assert.match(notice, /Company details couldn’t be loaded\./, "OVW_DEGRADE unavailable is a notice"); assert.doesNotMatch(notice, /profile-fields/);
  const response = await (await fixture(t, { throwing: true })).get("/organization/org-a"); const body = await response.text();
  assert.equal(response.status, 503); assert.doesNotMatch(body, /private navigation detail|Error:/);
  const unavailable = await (await fixture(t, { serviceUnavailable: true })).get("/organization/org-a");
  assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /private service detail/);
});

test("OVW_PASSTHROUGH reserved and nested organization routes pass through", async (t) => {
  const calls: URLSearchParams[] = []; const f = await fixture(t, { calls });
  for (const path of ["/organization/create", "/organization/assigned-companies", "/organization/onboarding", "/organization/org-a/edit", "/organization/org-a/stores"]) {
    const response = await f.get(path); const body = await response.text();
    assert.equal(calls.length, 0, `OVW_PASSTHROUGH ${path}`);
    if (path === "/organization/onboarding") {
      assert.equal(response.status, 404, "OVW_PASSTHROUGH /organization/onboarding status");
      assert.equal(body, '{"ok":false,"error":"not_found"}', "OVW_PASSTHROUGH /organization/onboarding bytes");
    }
  }
  await f.get("/organization/org-a/work"); assert.equal(calls.length, 0, "OVW_PASSTHROUGH work reaches its own lane");
});
