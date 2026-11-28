import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES } from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation } from "../src/context-navigation.js";
import { createRecruitInterviews, type RecruitInterviewsStore } from "../src/recruit/interviews-http.js";

// O-10 a company's interviews. Synthetic people, companies and stores only.
const sessions = { owner: "a".repeat(43), staff: "d".repeat(43), sibling: "h".repeat(43), stranger: "s".repeat(43) };
const REQ = "123e4567-e89b-42d3-a456-426614174001";
const row = (id: string, person: string | null, scheduledAt: string, mode: "in_person" | "phone" | "video", status: "scheduled" | "completed" | "cancelled", outcome: "passed" | "not_passed" | "no_show" | null) => ({
  id, request_id: REQ, position_title: "Cashier <Evening>", store_name: "Avenues <A>", person_name: person, scheduled_at: scheduledAt, duration_minutes: 30, mode, status, outcome,
});
const PAGE_ONE = [row("i-2", "Noor <Synthetic>", "2026-12-02T09:00:00.000Z", "video", "scheduled", null), row("i-1", null, "2026-12-01T06:30:00.000Z", "in_person", "completed", "passed")];
const PAGE_TWO = [row("i-0", "Badr", "2026-11-20T10:00:00.000Z", "phone", "cancelled", null)];

async function fixture(t: TestContext, option: { configured?: boolean; failing?: boolean; empty?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const authz = new InMemoryAuthzStore({ principals: Object.keys(sessions).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })), organizations: [{ id: "root", name: "Root" }, { id: "org-a", name: "A", parentOrgId: "root" }, { id: "org-b", name: "B", parentOrgId: "root" }] });
  await authz.grantMany("owner", [{ orgId: "org-a", role: "org-owner" }]);
  await authz.grantMany("sibling", [{ orgId: "org-b", role: "org-owner" }]);
  await authz.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const calls: string[] = [];
  const store = {
    forOrganization: async (principalId: string, orgId: string, page: number) => {
      calls.push(`${principalId}:${orgId}:${page}`);
      if (option.failing) throw new Error("database down");
      if (orgId !== "org-a" || (principalId !== "owner" && principalId !== "staff")) return null;
      return { org_name: "A <Co>", page, more: page === 1 && !option.empty, interviews: option.empty ? [] : page === 1 ? PAGE_ONE : page === 2 ? PAGE_TWO : [] };
    },
  } as unknown as RecruitInterviewsStore;
  const organizations = new OrganizationRepository({ store: authz, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([["org-a", SYNTHETIC_ORGANIZATION_FIXTURES.parentA], ["org-b", SYNTHETIC_ORGANIZATION_FIXTURES.unrelatedB]])) });
  const recruitInterviews = option.configured === false ? undefined : createRecruitInterviews({ sessions: rig.sessions, store });
  const login = { ...rig.app, navigation: createContextNavigation(rig.sessions, authz, organizations), ...(recruitInterviews ? { recruitInterviews } : {}), web: { origin: "https://studenthub.example.invalid", returnTo: "https://studenthub.example.invalid/workspace" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls };
}

const rowsOf = (html: string) => [...html.matchAll(/<tr><th scope="row">(.*?)<\/tr>/g)].map((m) => m[1]!);

test("ORGINT_LIST the company and staff see every interview on its requests, latest first, with the Kuwait time and the outcome only", async (t) => {
  const f = await fixture(t);
  for (const who of ["owner", "staff"] as const) {
    const response = await f.request("/organization/org-a/interviews", who), body = await response.text();
    assert.equal(response.status, 200, who); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(rowsOf(body), [
      `Noor &lt;Synthetic&gt;</th><td><a class="text-link" href="/recruit/requests/${REQ}/interviews">Cashier &lt;Evening&gt;</a></td><td>Avenues &lt;A&gt;</td><td>2026-12-02 12:00 (Kuwait) · 30 min · Video</td><td>Scheduled</td><td></td>`,
      `Unnamed person</th><td><a class="text-link" href="/recruit/requests/${REQ}/interviews">Cashier &lt;Evening&gt;</a></td><td>Avenues &lt;A&gt;</td><td>2026-12-01 09:30 (Kuwait) · 30 min · In person</td><td>Completed</td><td>Passed</td>`], who);
    assert.equal(body.includes("<Synthetic>") || body.includes("<Co>"), false, "escaped");
    assert.match(body, /<nav aria-label="Breadcrumb"><a href="\/organization\/org-a">Company<\/a><\/nav><h1>Interviews<\/h1><p>Every interview on A &lt;Co&gt;'s hiring requests/);
    assert.match(body, /<nav aria-label="Pages"><a href="\/organization\/org-a\/interviews\?page=2">Earlier interviews<\/a><\/nav>/, "the first page links earlier interviews");
  }
  const head = await f.request("/organization/org-a/interviews", "owner", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("ORGINT_PAGES page two lists older interviews and links back; past the end says so", async (t) => {
  const f = await fixture(t);
  const two = await (await f.request("/organization/org-a/interviews?page=2", "owner")).text();
  assert.deepEqual(rowsOf(two).map((r) => r.slice(0, r.indexOf("</th>"))), ["Badr"], "page two lists the older interviews");
  assert.match(two, /<td>2026-11-20 13:00 \(Kuwait\) · 30 min · Phone<\/td><td>Cancelled<\/td>/);
  assert.match(two, /<nav aria-label="Pages"><a href="\/organization\/org-a\/interviews">Later interviews<\/a><\/nav>/, "page two links back to the first page");
  const three = await (await f.request("/organization/org-a/interviews?page=3", "owner")).text();
  assert.match(three, /<p>No more interviews\.<\/p><nav aria-label="Pages"><a href="\/organization\/org-a\/interviews\?page=2">Later interviews<\/a><\/nav>/);
  assert.deepEqual(f.calls, ["owner:org-a:2", "owner:org-a:3"], "each page reads its own page");
  const empty = await fixture(t, { empty: true });
  const none = await (await empty.request("/organization/org-a/interviews", "owner")).text();
  assert.match(none, /<p>No interviews have been scheduled for this company yet\.<\/p><\/main>/);
});

test("ORGINT_DENY sign in first; another company, a stranger, an unknown company and bad input are the same not found or a bad request", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/organization/org-a/interviews")).status, 401);
  const bodies: string[] = [];
  for (const [path, who] of [["/organization/org-a/interviews", "sibling"], ["/organization/org-a/interviews", "stranger"], ["/organization/unknown/interviews", "staff"], ["/organization/%E0%A4%A/interviews", "owner"]] as const) {
    const response = await f.request(path, who); assert.equal(response.status, 404, `${who} ${path}`); bodies.push(await response.text());
  }
  assert.ok(bodies.every((b) => b === bodies[0]), "every refusal reads the same");
  const before = f.calls.length;
  for (const query of ["?x=1", "?page=0", "?page=01", "?page=abc", "?page=1&page=2", "?page=1234567"]) assert.equal((await f.request(`/organization/org-a/interviews${query}`, "owner")).status, 400, query);
  assert.equal(f.calls.length, before, "bad input never reads interviews");
  for (const method of ["POST", "PUT", "DELETE"]) {
    const page = await f.request("/organization/org-a/interviews", "owner", { method }), unknown = await f.request("/not-a-route", "owner", { method });
    assert.equal(page.status, unknown.status); assert.equal(await page.text(), await unknown.text());
  }
});

test("ORGINT_UNAVAILABLE no interviews service or a failing read is unavailable, never an empty list", async (t) => {
  for (const option of [{ configured: false }, { failing: true }]) {
    const f = await fixture(t, option);
    const response = await f.request("/organization/org-a/interviews", "owner"); assert.equal(response.status, 503, "a failing read is unavailable"); assert.match(await response.text(), /Interviews unavailable/);
  }
});

test("ORGINT_JOURNEY the company overview links Interviews and each row links the request's interviews page", async (t) => {
  const f = await fixture(t);
  const overview = await (await f.request("/organization/org-a", "owner")).text();
  const list = /href="(\/organization\/org-a\/interviews)">Interviews</.exec(overview)?.[1];
  assert.equal(list, "/organization/org-a/interviews", "the overview links Interviews");
  const page = await f.request(list!, "owner");
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`href="/recruit/requests/${REQ}/interviews">Cashier`), "a row links the request's interviews, where the evaluation lives");
});
