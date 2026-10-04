import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository } from "@studenthub/profile";
import {
  InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES,
} from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createCompanyDirectory } from "../src/company-directory.js";
import { createContextNavigation } from "../src/context-navigation.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "d".repeat(43);
const headers = { cookie: `__Host-studenthub_session=${SESSION}` };
const STAFF_LIST = "/workspace/companies?org_id=root&role=staff";

async function fixture(t: TestContext, options: { readonly withDirectory?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const store = new InMemoryAuthzStore({
    principals: [{ id: "person-1", pbuuids: ["one@example.invalid"] }],
    organizations: [
      { id: "root", name: "StudentHub" },
      { id: "org-a", name: "Organization A", parentOrgId: "root" },
      { id: "org-a1", name: "Organization A1", parentOrgId: "org-a" },
      { id: "org-b", name: "Organization B", parentOrgId: "root" },
    ],
  });
  await store.grantMany("person-1", [
    { orgId: "root", role: "staff", scope: "subtree" }, { orgId: "org-b", role: "recruiter" },
  ]);
  const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
  const organizations = new OrganizationRepository({ store, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", parentA], ["org-a1", childA1], ["org-b", unrelatedB],
  ])) });
  const login: BrowserLoginApplication = { ...rig.app,
    navigation: createContextNavigation(rig.sessions, store, organizations),
    ...(options.withDirectory === false ? {} : { companies: createCompanyDirectory(rig.sessions, store, organizations) }),
    web: { origin: "https://studenthub.example.invalid", returnTo: rig.config.allowedReturnUrls[1],
      profiles: new OwnProfileRepository({ principals: store, source: new InMemoryApprovedProfileAdapter({ links: [], rows: new Map() }),
        today: () => "2026-10-04" }) },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path = STAFF_LIST, extraHeaders = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { ...headers, ...extraHeaders },
  });
  return { get, store, rig, login };
}

const html = { accept: "text/html" };

test("SHU-163/AC-07 PAGE staff open a read-only company list from their workspace", async (t) => {
  const f = await fixture(t);
  const workspace = await (await f.get("/workspace?org_id=root&role=staff", html)).text();
  assert.match(workspace, /href="\/workspace\/companies\?org_id=root&amp;role=staff">Companies<\/a>/);
  const recruiter = await (await f.get("/workspace?org_id=org-b&role=recruiter", html)).text();
  assert.doesNotMatch(recruiter, /\/workspace\/companies/, "employers have no company list");

  const response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.active, { orgId: "root", role: "staff", organizationName: "StudentHub" });
  assert.deepEqual(body.directory.entries.map((entry: { orgId: string }) => entry.orgId), ["org-a", "org-b"]);
  assert.doesNotMatch(JSON.stringify(body), /SENSITIVE-|example\.invalid|hourly|commission|one@example/);

  const page = await f.get(STAFF_LIST, html);
  const text = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.match(text, /<a href="\/workspace\?org_id=org-a&amp;role=staff">Synthetic Retail Group<\/a>/);
  assert.match(text, /Under review/);
  assert.match(text, /aria-current="page">Companies<\/a>/);
  assert.match(text, /Companies 1–2 of 2/);
  assert.doesNotMatch(text, /Organization A1|Synthetic Retail Kuwait City|SENSITIVE-/, "sub-companies open from their parent");
});

test("SHU-163/AC-07 PAGE filters reach the directory and survive paging links", async (t) => {
  const f = await fixture(t);
  const filtered = await (await f.get(`${STAFF_LIST}&q=%20cafe%20&status=under_review&approved=yes&currency=KWD`)).json();
  assert.deepEqual(filtered.filters, { query: "cafe", status: "under_review", approvedToHire: true, currencyCode: "KWD" });
  assert.deepEqual(filtered.directory.entries.map((entry: { orgId: string }) => entry.orgId), ["org-b"]);
  // Empty form fields mean "any", as a GET form submits them.
  const empty = await (await f.get(`${STAFF_LIST}&q=&status=&approved=&currency=`)).json();
  assert.deepEqual(empty.filters, {});
  for (let index = 0; index < 25; index++) {
    await f.store.upsertOrganization({ id: `org-x${String(index).padStart(2, "0")}`, name: `Extra ${index}`, parentOrgId: "root" });
  }
  const first = await (await f.get(`${STAFF_LIST}&q=Extra`, html)).text();
  assert.match(first, /href="\/workspace\/companies\?org_id=root&amp;role=staff&amp;q=Extra&amp;page=2"/);
  const second = await (await f.get(`${STAFF_LIST}&q=Extra&page=2`, html)).text();
  assert.match(second, /Companies 21–25 of 25/);
  assert.match(second, /rel="prev" href="\/workspace\/companies\?org_id=root&amp;role=staff&amp;q=Extra&amp;page=1"/);
  assert.doesNotMatch(second, /rel="next"/);
});

test("SHU-163/AC-08 ACCESS only a current staff or admin context opens the list", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/workspace/companies?org_id=org-b&role=recruiter", "/workspace/companies?org_id=root&role=admin",
    "/workspace/companies?org_id=root&role=org-owner", "/workspace/companies?org_id=missing&role=staff",
  ]) {
    const response = await f.get(path);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "context_forbidden" });
  }
  for (const query of [
    "", "org_id=root", "role=staff", "org_id=root&role=staff&role=admin", "org_id=root&role=staff&staff_id=77",
    "org_id=root&role=staff&status=approved", "org_id=root&role=staff&approved=1", "org_id=root&role=staff&currency=kwd",
    "org_id=root&role=staff&page=0", "org_id=root&role=staff&page=1.5", `org_id=root&role=staff&q=${"x".repeat(101)}`,
  ]) {
    const response = await f.get(`/workspace/companies?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_directory_query" });
  }
  for (const cookie of ["", `__Host-studenthub_session=${"z".repeat(43)}`]) {
    assert.equal((await f.get(STAFF_LIST, { cookie })).status, 401);
  }
  const forbidden = await f.get("/workspace/companies?org_id=org-b&role=recruiter", html);
  assert.equal(forbidden.status, 403);
  assert.match(await forbidden.text(), /This company list isn’t available/);
  // Revocation applies to the very next request.
  assert.equal((await f.get()).status, 200);
  await f.store.revokeMany("person-1", [{ orgId: "root", role: "staff" }]);
  assert.equal((await f.get()).status, 403);
});

test("SHU-163/AC-08 ACCESS failures stay private and HTML escapes registry names", async (t) => {
  const f = await fixture(t);
  await f.store.upsertOrganization({ id: "org-b", name: '<script>alert("org")</script>', parentOrgId: "root" });
  // B's approved snapshot supplies its legal name; the registry name is shown only where no legal name exists.
  await f.store.upsertOrganization({ id: "org-c", name: '<img src=x onerror="x">', parentOrgId: "root" });
  const page = await (await f.get(STAFF_LIST, html)).text();
  assert.match(page, /&lt;img src=x onerror=&quot;x&quot;&gt;/);
  assert.doesNotMatch(page, /<img src=x|<script>alert/);
  assert.equal((page.match(/<script\b/g) ?? []).length, 1);
  f.store.listGrantsForPrincipal = async () => { throw new Error("private database diagnostic"); };
  const failed = await f.get();
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "directory_unavailable" });
  assert.doesNotMatch(await (await f.get(STAFF_LIST, html)).text(), /private database diagnostic|Synthetic/);
  const missing = await fixture(t, { withDirectory: false });
  for (const accept of ["application/json", "text/html"]) {
    const response = await missing.get(STAFF_LIST, { accept });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Synthetic|Organization A/);
  }
  const workspace = await (await missing.get("/workspace?org_id=root&role=staff", html)).text();
  assert.doesNotMatch(workspace, /\/workspace\/companies/, "no link without a configured directory");
});
