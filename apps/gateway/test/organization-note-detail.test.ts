import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository } from "@studenthub/profile";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import type { SafeWriteStore } from "@studenthub/safe-write-contract";
import type { OrganizationNoteRow } from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createOrganizationNotes, type OrganizationNotes, type OrganizationNotesStore } from "../src/organization-notes.js";
import { renderError, type BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "s".repeat(43), ADMIN = "a".repeat(43), OWNER = "o".repeat(43), RECRUITER = "r".repeat(43), OTHER = "x".repeat(43);
const ORIGIN = "https://studenthub.example.invalid";
const rows = new Map<string, OrganizationNoteRow[]>([
  ["org-a", [
    { id: "1", author_principal_id: "staff", body: "First", created_at: "2026-11-01T09:00:00.000Z", note_type: "phone_call" },
    { id: "2", author_principal_id: "staff", body: "<b>& hello</b>\nSecond line", created_at: "2026-11-20T09:00:00.000Z", note_type: "meeting" },
  ]],
  ["org-b", [{ id: "9", author_principal_id: "other", body: "Private", created_at: "2026-11-21T09:00:00.000Z", note_type: "email" }]],
]);

interface Options { noService?: boolean; throwing?: boolean; malformed?: boolean; unavailable?: boolean }
async function fixture(t: TestContext, options: Options = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "staff" });
  await rig.sessions.put({ id: ADMIN, personId: "admin" });
  await rig.sessions.put({ id: OWNER, personId: "owner" });
  await rig.sessions.put({ id: RECRUITER, personId: "recruiter" });
  await rig.sessions.put({ id: OTHER, personId: "other" });
  const calls = { list: [] as string[], preview: 0, confirm: 0, receipt: 0 };
  const store: OrganizationNotesStore = {
    forPrincipal(): SafeWriteStore { throw new Error("writes must not be reached"); },
    async readReceipt() { calls.receipt++; return null; },
    async list(personId, orgId) {
      calls.list.push(`${personId}:${orgId}`);
      return (personId === "staff" || personId === "admin") && orgId === "org-a" ? [...rows.get(orgId)!] : null;
    },
  };
  const real = createOrganizationNotes({ sessions: rig.sessions, store, secret: "note-detail-test-secret-at-least-32-bytes" });
  const service: OrganizationNotes = {
    async list(session, orgId) {
      if (options.throwing) throw new Error("private list stack");
      if (options.malformed) return { status: 200, body: { secret: rows.get("org-b") } };
      if (options.unavailable) return { status: 503, body: { error: "safe_write_unavailable" } };
      return real.list(session, orgId);
    },
    async preview(session, body) { calls.preview++; return real.preview(session, body); },
    async confirm(session, body) { calls.confirm++; return real.confirm(session, body); },
    async receipt(session, orgId, ref) { calls.receipt++; return real.receipt(session, orgId, ref); },
  };
  const login: BrowserLoginApplication & { organizationNotes?: OrganizationNotes } = {
    ...rig.app,
    ...(options.noService ? {} : { organizationNotes: service }),
    web: { origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1], profiles: new OwnProfileRepository({
      principals: new InMemoryAuthzStore(), source: new InMemoryApprovedProfileAdapter({ links: [], rows: new Map() }), today: () => "2026-11-27",
    }) },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, session: string | null = SESSION, method = "GET") => fetch(`${base}${path}`, {
    method, redirect: "manual", headers: { accept: "text/html", ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}) },
  });
  return { request, calls, login };
}

test("NOTEDET_SHOW a staff member reads one escaped note and HEAD has no body", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/organization/org-a/notes/2"); const body = await response.text();
  assert.equal(response.status, 200, "NOTEDET_SHOW detail is 200");
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /<h1>Meeting<\/h1>/, "NOTEDET_SHOW type label is the heading");
  assert.match(body, /<time datetime="2026-11-20T09:00:00\.000Z">2026-11-20T09:00:00\.000Z<\/time>/, "NOTEDET_SHOW written time");
  assert.ok(body.includes("&lt;b&gt;&amp; hello&lt;/b&gt;\nSecond line"), "NOTEDET_SHOW note text is escaped");
  assert.doesNotMatch(body, /<b>& hello<\/b>/);
  assert.match(body, /white-space: pre-wrap/, "NOTEDET_SHOW line breaks are kept");
  assert.match(body, /href="\/organization\/org-a">Company<\/a>/, "NOTEDET_SHOW company breadcrumb");
  assert.match(body, /href="\/organization\/org-a\/notes">Notes<\/a>/, "NOTEDET_SHOW Notes link");
  const head = await f.request("/organization/org-a/notes/2", SESSION, "HEAD");
  assert.equal(head.status, 200); assert.match(head.headers.get("content-type") ?? "", /^text\/html\b/); assert.equal(head.headers.get("cache-control"), "no-store"); assert.equal(await head.text(), "");
  const admin = await f.request("/organization/org-a/notes/2", ADMIN);
  assert.equal(admin.status, 200, "NOTEDET_SHOW admin reader sees the note");
});

test("NOTEDET_MINE selects the requested note from exactly one list call", async (t) => {
  const f = await fixture(t);
  const found = await f.request("/organization/org-a/notes/1");
  assert.equal(found.status, 200); assert.match(await found.text(), /<h1>Phone call<\/h1>/, "NOTEDET_MINE requested note is selected");
  assert.deepEqual(f.calls.list, ["staff:org-a"], "NOTEDET_MINE list is called once");
  const notFoundBody = renderError(404, f.login);
  for (const path of ["/organization/org-a/notes/9", "/organization/org-a/notes/999", "/organization/org-b/notes/9"]) {
    const response = await f.request(path); assert.equal(response.status, 404); assert.equal(await response.text(), notFoundBody, "NOTEDET_MINE hidden and unknown notes share the 404 body");
  }
  const before = f.calls.list.length;
  for (const id of ["0", "01", "-1", "abc", "12345678901234567890"]) {
    const response = await f.request(`/organization/org-a/notes/${id}`); assert.equal(response.status, 404); assert.equal(await response.text(), notFoundBody);
  }
  assert.equal(f.calls.list.length, before, "NOTEDET_MINE malformed ids do not call list");
  assert.deepEqual([f.calls.preview, f.calls.confirm, f.calls.receipt], [0, 0, 0], "NOTEDET_MINE detail never writes or reads receipts");
});

test("NOTEDET_DENY preserves authentication, query and method refusals", async (t) => {
  const f = await fixture(t);
  const none = await f.request("/organization/org-a/notes/2", null);
  assert.equal(none.status, 401); assert.equal(await none.text(), renderError(401, f.login), "NOTEDET_DENY no session is renderError(401)");
  for (const session of [OWNER, RECRUITER, OTHER]) {
    const denied = await f.request("/organization/org-a/notes/2", session); assert.equal(denied.status, 404); assert.equal(await denied.text(), renderError(404, f.login));
  }
  const query = await f.request("/organization/org-a/notes/2?x=1");
  assert.equal(query.status, 400, "NOTEDET_DENY a query string is 400");
  const malformedQuery = await f.request("/organization/org-a/notes/abc?x=1");
  assert.equal(malformedQuery.status, 400, "NOTEDET_DENY malformed id with a query is 400");
  const post = await f.request("/organization/org-a/notes/2", SESSION, "POST"); assert.equal(post.status, 404, "NOTEDET_DENY POST retains fallback response");
});

test("NOTEDET_PASSTHROUGH existing and deeper paths retain their dispatch", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/organization/org-a/notes")).status, 200, "NOTEDET_PASSTHROUGH notes list remains served");
  assert.equal((await f.request("/organization/org-a/notes?saved=note")).status, 200);
  assert.equal((await f.request("/organization/org-a/notes/preview")).status, 404, "NOTEDET_PASSTHROUGH GET preview stays unserved");
  assert.equal((await f.request("/organization/org-a/notes/confirm")).status, 404);
  const receipts = await f.request("/organization/org-a/notes/receipts");
  assert.equal(receipts.status, 404, "NOTEDET_PASSTHROUGH receipts keeps the gateway fallback");
  assert.match(receipts.headers.get("content-type") ?? "", /^application\/json\b/);
  const reserved = await f.request("/organization/onboarding/notes");
  assert.equal(reserved.status, 404, "NOTEDET_PASSTHROUGH reserved list path keeps the HTML error");
  assert.equal(await reserved.text(), renderError(404, f.login));
  assert.equal((await f.request("/organization/org-a/notes/2/x")).status, 404, "NOTEDET_PASSTHROUGH deeper paths stay unserved");
});

test("NOTEDET_UNAVAILABLE list failures stay private 503 pages", async (t) => {
  for (const options of [{ noService: true }, { throwing: true }, { malformed: true }, { unavailable: true }]) {
    const f = await fixture(t, options); const response = await f.request("/organization/org-a/notes/2"); const body = await response.text();
    assert.equal(response.status, 503, "NOTEDET_UNAVAILABLE detail is 503");
    assert.match(body, /Notes unavailable/); assert.doesNotMatch(body, /private list stack|Private|notes.*\[/i, "NOTEDET_UNAVAILABLE leaks no notes or stack");
  }
});
