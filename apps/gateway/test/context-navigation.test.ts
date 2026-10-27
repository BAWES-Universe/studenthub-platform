import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SYNTHETIC_PROFILE_FIXTURES } from "@studenthub/profile";
import { InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES,
  type OrganizationDeletionRecords, type OrganizationReader } from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";
import { renderWorkspace, type BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "n".repeat(43);
const headers = { cookie: `__Host-studenthub_session=${SESSION}` };

async function fixture(t: TestContext) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: ["one@example.invalid"] }, { id: "person-2", pbuuids: [] }],
    organizations: [
      { id: "org-a", name: "Organization A" },
      { id: "org-b", name: "Organization B" },
      { id: "org-private", name: "Secret Organization" },
      { id: "org-child", name: "Child organization", parentOrgId: "org-a" },
    ],
  });
  await store.grantMany("person-1", [
    { orgId: "org-a", role: "candidate" }, { orgId: "org-a", role: "staff" },
    { orgId: "org-b", role: "recruiter" },
  ]);
  await store.grantMany("person-2", [{ orgId: "org-private", role: "admin" }]);
  const login: BrowserLoginApplication = { ...rig.app,
    navigation: createContextNavigation(rig.sessions, store),
    web: { origin: "https://studenthub.example.invalid", returnTo: rig.config.allowedReturnUrls[1],
      profiles: new OwnProfileRepository({ principals: store, source: new InMemoryApprovedProfileAdapter({
        links: [{ principalId: "person-1", candidateRef: "candidate-navigation" }],
        rows: new Map([["candidate-navigation", SYNTHETIC_PROFILE_FIXTURES.populated]]),
      }), today: () => "2026-09-13" }) },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path = "/workspace", extraHeaders = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { ...headers, ...extraHeaders },
  });
  return { get, store, rig, login };
}

class CountingDeletions implements OrganizationDeletionRecords {
  isDeletedCalls = 0;
  deletedAmongCalls = 0;

  constructor(readonly deleted: ReadonlySet<string>) {}

  async isDeleted(orgId: string): Promise<boolean> {
    this.isDeletedCalls++;
    return this.deleted.has(orgId);
  }

  async deletedAmong(orgIds: readonly string[]): Promise<ReadonlySet<string>> {
    this.deletedAmongCalls++;
    assert.equal(new Set(orgIds).size, orgIds.length, "organization ids are queried once each");
    return new Set(orgIds.filter((orgId) => this.deleted.has(orgId)));
  }
}

async function deletionFixture(deletions: OrganizationDeletionRecords) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: [] }],
    organizations: [
      { id: "parent", name: "Parent" },
      { id: "deleted-child", name: "Deleted child", parentOrgId: "parent" },
      { id: "live-child", name: "Live child", parentOrgId: "parent" },
    ],
  });
  await store.grantMany("person-1", [{ orgId: "parent", role: "admin", scope: "subtree" }]);
  return { navigation: createContextNavigation(rig.sessions, store, undefined, deletions), store };
}

test("SHU328_NAV_ACTIVE deleted subtree organization cannot be selected while a live sibling still works", async () => {
  const deletions = new CountingDeletions(new Set(["deleted-child"]));
  const { navigation } = await deletionFixture(deletions);
  const deleted = await navigation.open(SESSION, new URLSearchParams({ org_id: "deleted-child", role: "admin" }));
  assert.deepEqual(deleted, { status: 403, body: { error: "context_forbidden" } });
  const live = await navigation.open(SESSION, new URLSearchParams({ org_id: "live-child", role: "admin" }));
  assert.equal(live.status, 200);
  if (live.status === 200) {
    assert.deepEqual(live.body.active, { orgId: "live-child", role: "admin", organizationName: "Live child" });
  }
  assert.equal(deletions.isDeletedCalls, 2);
});

test("SHU328_NAV_LIST deleted subtree organization is omitted with one batch call and empty grants skip it", async () => {
  const deletions = new CountingDeletions(new Set(["deleted-child"]));
  const { navigation, store } = await deletionFixture(deletions);
  const listed = await navigation.open(SESSION, new URLSearchParams());
  assert.equal(listed.status, 200);
  if (listed.status === 200) {
    assert.deepEqual(listed.body.contexts.map(({ orgId }) => orgId), ["live-child", "parent"]);
  }
  assert.equal(deletions.deletedAmongCalls, 1);
  await store.clearGrantsForPrincipal("person-1");
  const empty = await navigation.open(SESSION, new URLSearchParams());
  assert.deepEqual(empty, { status: 200, body: { contexts: [], active: null } });
  assert.equal(deletions.deletedAmongCalls, 1, "an empty context list must not query deletions");
});

test("SHU328_NAV_LIST deletion lookup failures return context_unavailable", async () => {
  const { navigation } = await deletionFixture({
    async isDeleted() { return false; },
    async deletedAmong() { throw new Error("private deletion store diagnostic"); },
  });
  assert.deepEqual(await navigation.open(SESSION, new URLSearchParams()), {
    status: 503, body: { error: "context_unavailable" },
  });
});

test("workspace lists only this session's granted contexts and never defaults to a privileged role", async (t) => {
  const f = await fixture(t);
  const response = await f.get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.active, null);
  assert.deepEqual(body.contexts.map((c: { orgId: string; role: string }) => [c.orgId, c.role]), [
    ["org-a", "candidate"], ["org-a", "staff"], ["org-b", "recruiter"],
  ]);
  assert.doesNotMatch(JSON.stringify(body), /Secret|org-private|person-2|one@example|org-child/);
  const profile = await f.get("/profile", { accept: "text/html" });
  const profileHtml = await profile.text();
  assert.match(profileHtml, /href="\/workspace"/);
  assert.match(profileHtml, /Approved imported snapshot/);
  assert.match(profileHtml, /StudentHub snapshot/);
  assert.doesNotMatch(profileHtml, /one@example.invalid|Email address|StudentHub account ID/);
});

test("one session switches between candidate, staff and recruiter across two organizations", async (t) => {
  const f = await fixture(t);
  for (const [orgId, role] of [["org-a", "candidate"], ["org-a", "staff"], ["org-b", "recruiter"]]) {
    const path = `/workspace?org_id=${orgId}&role=${role}`;
    // Repeat URLs as bookmarks, refreshes and browser-back requests.
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await f.get(path);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.active, { orgId, role, organizationName: orgId === "org-a" ? "Organization A" : "Organization B" });
      assert.equal(response.headers.get("set-cookie"), null);
    }
  }
});

test("forged roles and direct cross-organization requests are denied, including parent-to-child without subtree grants", async (t) => {
  const f = await fixture(t);
  for (const query of ["org_id=org-a&role=admin", "org_id=org-b&role=staff", "org_id=org-private&role=admin", "org_id=org-child&role=staff", "org_id=unknown&role=staff", "org_id=org-a&role=superadmin"]) {
    const response = await f.get(`/workspace?${query}`);
    assert.equal(response.status, 403, query);
    assert.deepEqual(await response.json(), { error: "context_forbidden" });
  }
});

test("partial, duplicate and unknown selections cannot silently select another context", async (t) => {
  const f = await fixture(t);
  for (const query of ["role=admin", "org_id=org-a", "org_id=&role=staff", "org_id=org-a&role=", "org_id=org-a&role=staff&role=admin", "org_id=org-a&org_id=org-b&role=staff", "person_id=person-2", "return_to=https://evil.invalid"]) {
    const response = await f.get(`/workspace?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_context_selection" });
  }
});

test("revocation denies the very next bookmarked request while unrelated grants remain usable", async (t) => {
  const f = await fixture(t);
  const path = "/workspace?org_id=org-a&role=staff";
  assert.equal((await f.get(path)).status, 200);
  await f.store.revokeMany("person-1", [{ orgId: "org-a", role: "staff" }]);
  assert.equal((await f.get(path)).status, 403);
  const deniedPage = await f.get(path, { accept: "text/html" });
  assert.equal(deniedPage.status, 403);
  const deniedHtml = await deniedPage.text();
  assert.match(deniedHtml, /Choose a workspace/);
  assert.doesNotMatch(deniedHtml, /Organization A|Staff workspace|context-option/);
  const body = await (await f.get()).json();
  assert.equal(body.contexts.some((c: { role: string }) => c.role === "staff"), false);
  assert.equal((await f.get("/workspace?org_id=org-b&role=recruiter")).status, 200);
});

test("navigation cannot confer private-document authority or replace its runtime route", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get("/workspace?org_id=org-b&role=recruiter")).status, 200);
  // The existing route must still be mounted and fail closed until configured.
  const documents = await f.get("/candidate-documents");
  assert.equal(documents.status, 503, "SHU91_DOCUMENT_ROUTE: preserve the private-document handler");
  assert.deepEqual(await documents.json(), { error: "unavailable" });
  const profile = await f.get("/profile");
  const body = await profile.json();
  assert.equal(body.version, "studenthub.own-profile.v1");
  assert.ok(body.fields.displayName, "SHU91_PROFILE: retain typed own-profile fields");
  assert.equal(body.fields.organizationName, undefined, "workspace selection must not contaminate own profile");
});

test("subtree selection follows existing grant semantics and revocation", async (t) => {
  const f = await fixture(t);
  await f.store.grantMany("person-1", [{ orgId: "org-a", role: "staff", scope: "subtree" }]);
  const path = "/workspace?org_id=org-child&role=staff";
  assert.equal((await f.get(path)).status, 200);
  const body = await (await f.get()).json();
  assert.ok(body.contexts.some((c: { orgId: string; role: string }) => c.orgId === "org-child" && c.role === "staff"));
  await f.store.revokeMany("person-1", [{ orgId: "org-a", role: "staff" }]);
  assert.equal((await f.get(path)).status, 403);
});

test("anonymous, expired, logged-out and unknown-principal sessions cannot read organization details", async (t) => {
  const f = await fixture(t);
  for (const cookie of ["", `__Host-studenthub_session=${"z".repeat(43)}`]) {
    assert.equal((await f.get("/workspace", { cookie })).status, 401);
  }
  await f.rig.sessions.put({ id: SESSION, personId: "missing" });
  assert.equal((await f.get()).status, 401);
  await f.rig.sessions.put({ id: SESSION, personId: "person-1" });
  await f.login.logout(SESSION);
  assert.equal((await f.get("/workspace?org_id=org-a&role=staff")).status, 401);
});

test("no grants leaves own-profile access available without inventing a candidate grant", async (t) => {
  const f = await fixture(t);
  await f.store.clearGrantsForPrincipal("person-1");
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { contexts: [], active: null });
  assert.equal((await f.get("/profile")).status, 200);
  const html = await (await f.get("/workspace", { accept: "text/html" })).text();
  assert.match(html, /No workspaces assigned/);
  assert.doesNotMatch(html, /Organization A|Secret Organization/);
});

test("dependency failures return a private 503 without partial organization data", async (t) => {
  const f = await fixture(t);
  f.store.listGrantsForPrincipal = async () => { throw new Error("private database diagnostic"); };
  const response = await f.get("/workspace?org_id=org-a&role=staff");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "context_unavailable" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("missing runtime navigation fails closed for both HTML and JSON", async (t) => {
  const server = createGatewayServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const accept of ["application/json", "text/html"]) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/workspace`, { headers: { ...headers, accept } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /Organization A|Secret Organization/);
  }
});

test("HTML escapes labels, preserves URL selections, and allows only the external history guard", async (t) => {
  const f = await fixture(t);
  await f.store.upsertOrganization({ id: "org-a", name: '<script>alert("org")</script>' });
  const response = await f.get("/workspace?org_id=org-a&role=staff", { accept: "text/html" });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="\/workspace\?org_id=org-a&amp;role=staff" aria-current="page"/);
  assert.match(html, /href="\/workspace\?org_id=org-b&amp;role=recruiter"/);
  assert.match(html, /href="\/profile"/);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.match(html, /<script src="\/assets\/workspace-history.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>alert|Secret Organization|person-2|one@example/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Accept");
  assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.doesNotMatch(response.headers.get("content-security-policy")!, /unsafe-inline|unsafe-eval/);
});

test("SHU91_HISTORY: cached history hides the old context and revalidates before display", async (t) => {
  const f = await fixture(t);
  const page = await f.get("/workspace?org_id=org-a&role=staff", { accept: "text/html" });
  assert.match(await page.text(), /src="\/assets\/workspace-history.js"/, "SHU91_HISTORY: history guard must be loaded");
  const response = await f.get("/assets/workspace-history.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/javascript/);
  const events = new Map<string, (event?: { persisted: boolean }) => void>();
  const document = { documentElement: { hidden: false } };
  let reloads = 0;
  runInNewContext(await response.text(), {
    addEventListener: (name: string, callback: (event?: { persisted: boolean }) => void) => events.set(name, callback),
    document, location: { reload() { reloads++; } },
  }, { timeout: 1000 });
  events.get("pageshow")!({ persisted: false });
  assert.equal(document.documentElement.hidden, false);
  assert.equal(reloads, 0, "ordinary requests must not reload in a loop");
  events.get("pagehide")!();
  assert.equal(document.documentElement.hidden, true, "SHU91_HISTORY: outgoing protected snapshot must be concealed");
  await f.store.revokeMany("person-1", [{ orgId: "org-a", role: "staff" }]);
  events.get("pageshow")!({ persisted: true });
  assert.equal(reloads, 1, "SHU91_HISTORY: restored snapshot must request fresh authorization");
  assert.equal(document.documentElement.hidden, true, "old snapshot must stay concealed until replacement");
  assert.equal((await f.get("/workspace?org_id=org-a&role=staff")).status, 403);
  const profile = await f.get("/profile", { accept: "text/html" });
  assert.doesNotMatch(profile.headers.get("content-security-policy")!, /script-src/, "profile CSP remains unchanged");
});

test("SHU-159/AC-09 CARD the selected workspace shows only the active role's company projection", async (t) => {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: [] }],
    organizations: [
      { id: "root", name: "StudentHub" },
      { id: "org-a", name: "Organization A", parentOrgId: "root" },
      { id: "org-b", name: "Organization B", parentOrgId: "root" },
    ],
  });
  await store.grantMany("person-1", [
    { orgId: "org-a", role: "org-owner" }, { orgId: "org-a", role: "candidate" }, { orgId: "org-b", role: "staff" },
  ]);
  const organizations = new OrganizationRepository({ store, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA],
  ])) });
  const login: BrowserLoginApplication = { ...rig.app, navigation: createContextNavigation(rig.sessions, store, organizations) };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path: string, extra = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { ...headers, ...extra } });

  const owner = await (await get("/workspace?org_id=org-a&role=org-owner")).json();
  assert.equal(owner.organization.kind, "found");
  assert.equal(owner.organization.view.audience, "employer");
  assert.equal(owner.organization.view.fields.legalName.value, "Synthetic Retail Group");
  assert.equal(Object.hasOwn(owner.organization.view.fields, "email"), false, "SHU-159/AC-09 employer card has no staff fields");
  const html = await (await get("/workspace?org_id=org-a&role=org-owner", { accept: "text/html" })).text();
  assert.match(html, /Synthetic Retail Group/);
  assert.match(html, /Hourly rate<\/dt><dd>1\.500/);
  assert.doesNotMatch(html, /SENSITIVE-|hello@synthetic-retail|Company email/);

  // A role without a company projection gets no card; the selection still works.
  const candidate = await (await get("/workspace?org_id=org-a&role=candidate")).json();
  assert.deepEqual(candidate.organization, { kind: "not_applicable" });
  // Staff at an organization with no imported snapshot sees the registry name and unavailable fields.
  const staff = await (await get("/workspace?org_id=org-b&role=staff")).json();
  assert.equal(staff.organization.view.audience, "staff");
  assert.deepEqual(staff.organization.view.snapshot, { kind: "not_imported" });
  assert.equal(staff.organization.view.fields.email.state, "unavailable");
  const staffHtml = await (await get("/workspace?org_id=org-b&role=staff", { accept: "text/html" })).text();
  assert.match(staffHtml, /Organization B/);
  assert.match(staffHtml, /haven’t been imported yet/);
  // No selection means no organization read at all.
  const none = await (await get("/workspace")).json();
  assert.equal(Object.hasOwn(none, "organization"), false);
});

test("SHU353_SHOWN company card renders the written currency in its closed projection", async (t) => {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: [] }],
    organizations: [{ id: "org-a", name: "Organization A" }],
  });
  await store.grantMany("person-1", [{ orgId: "org-a", role: "org-owner" }]);
  const commercialTerms = { async read() { return {
    hourlyRate: { kind: "absent" as const }, bonusCommission: { kind: "absent" as const },
    currencyCode: { kind: "value" as const, value: "USD" },
  }; }, async readMany() { return new Map(); } };
  const organizations = new OrganizationRepository({
    store,
    source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
      ["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA],
    ])),
    commercialTerms,
  });
  const login: BrowserLoginApplication = { ...rig.app, navigation: createContextNavigation(rig.sessions, store, organizations) };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/workspace?org_id=org-a&role=org-owner`, {
    headers: { ...headers, accept: "text/html" },
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Currency<\/dt><dd>USD<\/dd>/);
});

test("SHU352_SHOWN maximum-length saved company names render on every company card audience", async () => {
  const rig=createSyntheticLoginRig(createLoginApplication);await rig.sessions.put({id:SESSION,personId:"person-1"});
  const store=new InMemoryAuthzStore({principals:[{id:"person-1",pbuuids:[]}],organizations:[{id:"org-a",name:"Organization A"}]});
  const savedNameEn="N".repeat(255),savedNameAr="ن".repeat(255);
  const profiles={async read(){return{name_en:savedNameEn,name_ar:savedNameAr}}};
  const organizations=new OrganizationRepository({store,source:new InMemoryApprovedOrganizationAdapter(new Map([
    ["org-a",SYNTHETIC_ORGANIZATION_FIXTURES.parentA],
  ])),profiles});
  for(const role of ["org-owner","staff","admin"] as const){
    await store.grantMany("person-1",[{orgId:"org-a",role}]);
    const navigation=createContextNavigation(rig.sessions,store,organizations);
    const page=await navigation.open(SESSION,new URLSearchParams({org_id:"org-a",role}));
    const html=renderWorkspace(page,{...rig.app,navigation});
    assert.match(html,new RegExp(`Common name<\\/dt><dd>${savedNameEn}<\\/dd>`));
    assert.match(html,new RegExp(`Common name \\(Arabic\\)<\\/dt><dd>${savedNameAr}<\\/dd>`));
  }
});

test("SHU355_SHOWN_GRANT company card hides a revoked manager and restores the retained assignment",async()=>{
  const rig=createSyntheticLoginRig(createLoginApplication);await rig.sessions.put({id:SESSION,personId:"person-1"});
  const store=new InMemoryAuthzStore({principals:[{id:"person-1",pbuuids:[]},{id:"person-2",pbuuids:[]}],organizations:[{id:"org-a",name:"Organization A"}]});
  await store.grantMany("person-1",[{orgId:"org-a",role:"staff"}]);
  await store.grantMany("person-2",[{orgId:"org-a",role:"staff"}]);
  const managers={manager:async()=>({manager:(await store.listGrantsForPrincipal("person-2")).some(grant=>grant.orgId==="org-a"&&grant.role==="staff")?{principalId:"hidden-manager-id",displayName:"Staff One"}:null})};
  const organizations=Object.assign(new OrganizationRepository({store,source:new InMemoryApprovedOrganizationAdapter(new Map())}),{accountManagers:managers});
  const open=()=>createContextNavigation(rig.sessions,store,organizations).open(SESSION,new URLSearchParams({org_id:"org-a",role:"staff"}));
  const render=async()=>renderWorkspace(await open(),{...rig.app,navigation:createContextNavigation(rig.sessions,store)});
  const shown=await render();assert.match(shown,/Account manager<\/dt><dd>Staff One/);assert.doesNotMatch(shown,/hidden-manager-id/);
  await store.revokeMany("person-2",[{orgId:"org-a",role:"staff"}]);
  assert.match(await render(),/Account manager<\/dt><dd>None/);
  await store.grantMany("person-2",[{orgId:"org-a",role:"staff"}]);
  assert.match(await render(),/Account manager<\/dt><dd>Staff One/);
});

async function shu332Rig(options: {
  scope?: "self" | "subtree";
  deletions?: OrganizationDeletionRecords;
  childName?: string;
} = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: [] }],
    organizations: [
      { id: "root", name: "StudentHub" },
      { id: "org-a", name: "Organization A", parentOrgId: "root" },
      { id: "org-a1", name: options.childName ?? "Alpha Sub-company", parentOrgId: "org-a" },
      { id: "org-a2", name: "Beta Sub-company", parentOrgId: "org-a" },
    ],
  });
  await store.grantMany("person-1", [
    { orgId: "org-a", role: "org-owner", scope: options.scope ?? "subtree" },
    { orgId: "org-a", role: "candidate" },
    { orgId: "root", role: "admin", scope: "subtree" },
  ]);
  const repository = new OrganizationRepository({
    store,
    source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
      ["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA],
      ["org-a1", SYNTHETIC_ORGANIZATION_FIXTURES.childA1],
    ])),
    deletions: options.deletions,
    storeCounts: { async countMany(ids) { return new Map(ids.map((id) => [id, 4])); } },
  });
  return { rig, store, repository };
}

test("SHU332_NAV_SUBS top-level workspaces list only authorized live sub-companies", async () => {
  const subtree = await shu332Rig();
  let calls = 0;
  const counting: OrganizationReader = {
    read: (request) => subtree.repository.read(request),
    listSubOrganizations(request) {
      calls++;
      return subtree.repository.listSubOrganizations(request);
    },
  };
  const navigation = createContextNavigation(subtree.rig.sessions, subtree.store, counting);
  const owner = await navigation.open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  assert.equal(owner.status, 200);
  if (owner.status === 200) {
    assert.equal(owner.body.subOrganizations?.kind, "found");
    assert.deepEqual(owner.body.subOrganizations?.kind === "found"
      ? owner.body.subOrganizations.subOrganizations.map((child) => child.orgId) : [], ["org-a1", "org-a2"]);
  }
  assert.equal(calls, 1, "one list call per top-level company card");

  const child = await navigation.open(SESSION, new URLSearchParams({ org_id: "org-a1", role: "org-owner" }));
  assert.equal(child.status, 200);
  if (child.status === 200) assert.equal(Object.hasOwn(child.body, "subOrganizations"), false);
  const candidate = await navigation.open(SESSION, new URLSearchParams({ org_id: "org-a", role: "candidate" }));
  assert.equal(candidate.status, 200);
  if (candidate.status === 200) assert.equal(Object.hasOwn(candidate.body, "subOrganizations"), false);
  const none = await navigation.open(SESSION, new URLSearchParams());
  assert.equal(none.status, 200);
  if (none.status === 200) {
    assert.equal(Object.hasOwn(none.body, "organization"), false);
    assert.equal(Object.hasOwn(none.body, "subOrganizations"), false);
  }
  assert.equal(calls, 1, "non-top-level and absent cards never list sub-companies");

  const self = await shu332Rig({ scope: "self" });
  const selfResult = await createContextNavigation(self.rig.sessions, self.store, self.repository)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  assert.equal(selfResult.status, 200);
  if (selfResult.status === 200) assert.deepEqual(selfResult.body.subOrganizations, { kind: "found", subOrganizations: [] });

  const deleted = new CountingDeletions(new Set(["org-a2"]));
  const live = await shu332Rig({ deletions: deleted });
  const liveResult = await createContextNavigation(live.rig.sessions, live.store, live.repository, deleted)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  assert.equal(liveResult.status, 200);
  if (liveResult.status === 200) {
    assert.deepEqual(liveResult.body.subOrganizations?.kind === "found"
      ? liveResult.body.subOrganizations.subOrganizations.map((entry) => entry.orgId) : [], ["org-a1"]);
  }
});

test("SHU332_NAV_SUBS_UNAVAILABLE unavailable child data preserves the company card and renders a retry notice", async () => {
  const f = await shu332Rig();
  const reader: OrganizationReader = {
    read: (request) => f.repository.read(request),
    async listSubOrganizations() { return { kind: "unavailable" }; },
  };
  const result = await createContextNavigation(f.rig.sessions, f.store, reader)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.deepEqual(result.body.subOrganizations, { kind: "unavailable" });
  assert.equal(result.body.organization?.kind, "found");
  if (result.body.organization?.kind === "found") {
    const legalName = result.body.organization.view.fields.legalName;
    assert.equal(legalName.state, "available");
    if (legalName.state === "available") assert.equal(legalName.value, "Synthetic Retail Group");
  }
  const html = renderWorkspace(result, f.rig.app);
  assert.match(html, /Sub-companies couldn’t be loaded/);
  assert.match(html, /Please try again in a moment/);
  assert.match(html, /Synthetic Retail Group/);
});

test("SHU332_NAV_SUBS_HTML child names and links are escaped and an empty panel is explained", async () => {
  const f = await shu332Rig({ childName: "<b>Sub & Co</b>" });
  const navigation = createContextNavigation(f.rig.sessions, f.store, f.repository);
  const result = await navigation.open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  const html = renderWorkspace(result, f.rig.app);
  assert.match(html, /href="\/workspace\?org_id=org-a1&amp;role=org-owner"/);
  assert.match(html, /&lt;b&gt;Sub &amp; Co&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Sub & Co<\/b>/);

  const empty = await shu332Rig({ scope: "self" });
  const emptyResult = await createContextNavigation(empty.rig.sessions, empty.store, empty.repository)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  const emptyHtml = renderWorkspace(emptyResult, empty.rig.app);
  assert.match(emptyHtml, /No sub-companies you can open/);
});

test("SHU334_NAV_COUNTS only an admin card requests counts", async () => {
  const f = await shu332Rig();
  let calls = 0;
  const reader: OrganizationReader = {
    read: (request) => f.repository.read(request),
    listSubOrganizations: (request) => f.repository.listSubOrganizations(request),
    readCounts(request) { calls++; return f.repository.readCounts(request); },
  };
  const navigation = createContextNavigation(f.rig.sessions, f.store, reader);
  const admin = await navigation.open(SESSION, new URLSearchParams({ org_id: "org-a", role: "admin" }));
  assert.equal(admin.status, 200);
  if (admin.status === 200) assert.deepEqual(admin.body.counts, { kind: "found", counts: { stores: 4, subOrganizations: 2 } });
  assert.equal(calls, 1);
  const owner = await navigation.open(SESSION, new URLSearchParams({ org_id: "org-a", role: "org-owner" }));
  assert.equal(owner.status, 200);
  if (owner.status === 200) assert.equal(Object.hasOwn(owner.body, "counts"), false);
  const none = await navigation.open(SESSION, new URLSearchParams());
  assert.equal(none.status, 200);
  if (none.status === 200) assert.equal(Object.hasOwn(none.body, "counts"), false);
  assert.equal(calls, 1);
  const without = { read: reader.read, listSubOrganizations: reader.listSubOrganizations };
  const noMethod = await createContextNavigation(f.rig.sessions, f.store, without)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "admin" }));
  if (noMethod.status === 200) assert.equal(Object.hasOwn(noMethod.body, "counts"), false);
});

test("SHU334_NAV_COUNTS_UNAVAILABLE unavailable counts preserve the company card", async () => {
  const f = await shu332Rig();
  const reader: OrganizationReader = {
    read: (request) => f.repository.read(request),
    listSubOrganizations: (request) => f.repository.listSubOrganizations(request),
    async readCounts() { return { kind: "unavailable" }; },
  };
  const result = await createContextNavigation(f.rig.sessions, f.store, reader)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "admin" }));
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.deepEqual(result.body.counts, { kind: "unavailable" });
  assert.equal(result.body.organization?.kind, "found");
  const html = renderWorkspace(result, f.rig.app);
  assert.match(html, /Company counts couldn’t be loaded/);
  assert.match(html, /Synthetic Retail Group/);
});

test("SHU334_NAV_COUNTS_HTML renders both counts and the unavailable store marker", async () => {
  const f = await shu332Rig();
  const result = await createContextNavigation(f.rig.sessions, f.store, f.repository)
    .open(SESSION, new URLSearchParams({ org_id: "org-a", role: "admin" }));
  const html = renderWorkspace(result, f.rig.app);
  assert.match(html, /At a glance/);
  assert.match(html, /<dt>Stores<\/dt><dd>4<\/dd>/);
  assert.match(html, /<dt>Sub-companies<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(html, /<dd>null<\/dd>/);
  if (result.status !== 200) return;
  const unavailable = { ...result, body: { ...result.body, counts: { kind: "found" as const, counts: { stores: null, subOrganizations: 2 } } } };
  const unavailableHtml = renderWorkspace(unavailable, f.rig.app);
  assert.match(unavailableHtml, /<dt>Stores<\/dt><dd><span class="missing" data-state="unavailable">Unavailable<\/span><\/dd>/);
  assert.doesNotMatch(unavailableHtml, />null</);
});

test("SHU356_SHOWN company card shows only five staff history changes and no ids to employer audiences",async()=>{const f=await shu332Rig(),history=Array.from({length:7},(_,i)=>({from_principal_id:i?`secret-from-${i}`:null,from_display_name:i?`Manager ${i}`:null,from_principal_exists:!!i,to_principal_id:`secret-to-${i}`,to_display_name:`Manager ${i+1}`,to_principal_exists:true,occurred_at:`2026-10-${String(25-i).padStart(2,"0")}T12:00:00.000Z`}));let historyCalls=0;const reader={read:(request:Parameters<typeof f.repository.read>[0])=>f.repository.read(request),listSubOrganizations:(request:Parameters<typeof f.repository.listSubOrganizations>[0])=>f.repository.listSubOrganizations(request),readCounts:(request:Parameters<NonNullable<typeof f.repository.readCounts>>[0])=>f.repository.readCounts!(request),accountManagers:{manager:async()=>({manager:null}),history:async()=>{historyCalls++;return history}}};const navigation=createContextNavigation(f.rig.sessions,f.store,reader);const result=await navigation.open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(result.status,200);if(result.status!==200)return;assert.equal(result.body.accountManagerHistory?.length,5);const html=renderWorkspace(result,f.rig.app);assert.match(html,/Account manager history/);assert.match(html,/Manager 1/);assert.match(html,/2026-10-25/);assert.doesNotMatch(html,/secret-(?:from|to)/);assert.equal((html.match(/<li>/g)??[]).length,5);assert.doesNotMatch(html,/Manager 6|Manager 7/);const owner=await navigation.open(SESSION,new URLSearchParams({org_id:"org-a",role:"org-owner"}));assert.equal(owner.status,200);assert.equal(historyCalls,1);if(owner.status===200){assert.equal(owner.body.accountManagerHistory,undefined);assert.doesNotMatch(renderWorkspace(owner,f.rig.app),/Account manager history/)}});

test("SHU357_CARD_DEGRADES account-manager reads degrade independently after staff authorization",async()=>{const f=await shu332Rig();const base={read:(request:Parameters<typeof f.repository.read>[0])=>f.repository.read(request),listSubOrganizations:(request:Parameters<typeof f.repository.listSubOrganizations>[0])=>f.repository.listSubOrganizations(request),readCounts:(request:Parameters<NonNullable<typeof f.repository.readCounts>>[0])=>f.repository.readCounts!(request)};const failedManager=await createContextNavigation(f.rig.sessions,f.store,{...base,accountManagers:{manager:async()=>{throw new Error("down")},history:async()=>[]}}).open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(failedManager.status,200);assert.match(renderWorkspace(failedManager,f.rig.app),/<dt>Account manager<\/dt><dd><span[^>]+>Unavailable/);const failedHistory=await createContextNavigation(f.rig.sessions,f.store,{...base,accountManagers:{manager:async()=>({manager:null}),history:async()=>{throw new Error("down")}}}).open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(failedHistory.status,200);const html=renderWorkspace(failedHistory,f.rig.app);assert.match(html,/<dt>Account manager<\/dt><dd>None/);assert.match(html,/Account manager history couldn’t be loaded/);const refused=await createContextNavigation(f.rig.sessions,f.store,{...base,accountManagers:{manager:async()=>null,history:async()=>null}}).open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.doesNotMatch(renderWorkspace(refused,f.rig.app),/Account manager(?: history)?<\/|Account manager history couldn’t/)});

test("SHU358_SHOWN staff company card shows five status changes without receipt or principal references",async()=>{const f=await shu332Rig(),events=Array.from({length:7},(_,i)=>({from_status:i===0?null:"under_review",to_status:i===0?"active":"inactive",occurred_at:`2026-10-${String(25-i).padStart(2,"0")}T12:00:00.000Z`,receipt_ref:`secret-receipt-${i}`,principal_id:`secret-principal-${i}`}));let calls=0;const status={history:async()=>{calls++;return events}};const navigation=createContextNavigation(f.rig.sessions,f.store,f.repository,undefined,status);const result=await navigation.open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(result.status,200);if(result.status!==200)return;assert.equal(result.body.statusHistory?.length,5);const html=renderWorkspace(result,f.rig.app);assert.match(html,/Status history/);assert.match(html,/Not set → Active/);assert.match(html,/2026-10-25/);assert.equal((html.match(/<li>/g)??[]).length,5);assert.doesNotMatch(html,/secret-(?:receipt|principal)|2026-10-(?:20|19)/);const owner=await navigation.open(SESSION,new URLSearchParams({org_id:"org-a",role:"org-owner"}));assert.equal(owner.status,200);assert.equal(calls,1);if(owner.status===200){assert.equal(owner.body.statusHistory,undefined);assert.doesNotMatch(renderWorkspace(owner,f.rig.app),/Status history/)}});

test("SHU358_UNAVAILABLE status history refusal is hidden, empty history is explicit, and failure degrades only its panel",async()=>{const f=await shu332Rig();const refused=await createContextNavigation(f.rig.sessions,f.store,f.repository,undefined,{history:async()=>null}).open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(refused.status,200);assert.doesNotMatch(renderWorkspace(refused,f.rig.app),/Status history/);const empty=await createContextNavigation(f.rig.sessions,f.store,f.repository,undefined,{history:async()=>[]}).open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(empty.status,200);const emptyHtml=renderWorkspace(empty,f.rig.app);assert.match(emptyHtml,/Status history/);assert.match(emptyHtml,/No status changes recorded\./);const failed=await createContextNavigation(f.rig.sessions,f.store,f.repository,undefined,{history:async()=>{throw new Error("down")}}).open(SESSION,new URLSearchParams({org_id:"org-a",role:"admin"}));assert.equal(failed.status,200);const html=renderWorkspace(failed,f.rig.app);assert.match(html,/Synthetic Retail Group/);assert.match(html,/Status history couldn’t be loaded/)});
