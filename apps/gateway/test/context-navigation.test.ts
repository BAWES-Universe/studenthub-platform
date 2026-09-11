import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

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
      readProfile: (id) => store.getPrincipal(id) },
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
  assert.match(await profile.text(), /href="\/workspace"/);
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
  const body = await (await f.get()).json();
  assert.equal(body.contexts.some((c: { role: string }) => c.role === "staff"), false);
  assert.equal((await f.get("/workspace?org_id=org-b&role=recruiter")).status, 200);
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

test("HTML escapes labels, preserves URL selections, and is private without executable scripts", async (t) => {
  const f = await fixture(t);
  await f.store.upsertOrganization({ id: "org-a", name: '<script>alert("org")</script>' });
  const response = await f.get("/workspace?org_id=org-a&role=staff", { accept: "text/html" });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="\/workspace\?org_id=org-a&amp;role=staff" aria-current="page"/);
  assert.match(html, /href="\/workspace\?org_id=org-b&amp;role=recruiter"/);
  assert.match(html, /href="\/profile"/);
  assert.doesNotMatch(html, /<script|Secret Organization|person-2|one@example/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Accept");
  assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
});
