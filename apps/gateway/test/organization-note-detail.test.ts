import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import type { SafeWriteStore } from "@studenthub/safe-write-contract";
import type { OrganizationNoteRow } from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createOrganizationNotes, type OrganizationNotes, type OrganizationNotesStore } from "../src/organization-notes.js";
import { renderError, type BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "s".repeat(43), ADMIN = "a".repeat(43), OWNER = "o".repeat(43);
const RECRUITER = "r".repeat(43), UNRELATED = "u".repeat(43);
const ROWS: OrganizationNoteRow[] = [
  { id: "7", author_principal_id: "staff", body: "Line one\n<script>& goodbye", created_at: "2026-11-20T09:00:00.000Z", note_type: "phone_call" },
  { id: "8", author_principal_id: "admin", body: "Other note", created_at: "2026-11-21T09:00:00.000Z", note_type: "task" },
];

async function fixture(t: TestContext, option: "normal" | "throw" | "bad-body" | "off" = "normal") {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "staff" });
  await rig.sessions.put({ id: ADMIN, personId: "admin" });
  await rig.sessions.put({ id: OWNER, personId: "owner" });
  await rig.sessions.put({ id: RECRUITER, personId: "recruiter" });
  await rig.sessions.put({ id: UNRELATED, personId: "unrelated" });
  const calls = { list: [] as string[], preview: 0, confirm: 0, receipt: 0 };
  const store: OrganizationNotesStore = {
    forPrincipal: () => ({}) as SafeWriteStore,
    readReceipt: async () => null,
    list: async (person, org) => (person === "staff" || person === "admin") && org === "org-a" ? ROWS : null,
  };
  const real = createOrganizationNotes({ sessions: rig.sessions, store, secret: "note-detail-test-secret-at-least-thirty-two-bytes" });
  const organizationNotes: OrganizationNotes = {
    async list(session, org) {
      calls.list.push(org);
      if (option === "throw") throw new Error("private list failure");
      if (option === "bad-body") return { status: 200, body: {} };
      return real.list(session, org);
    },
    async preview(session, body) { calls.preview++; return real.preview(session, body); },
    async confirm(session, body) { calls.confirm++; return real.confirm(session, body); },
    async receipt(session, org, ref) { calls.receipt++; return real.receipt(session, org, ref); },
  };
  const login: BrowserLoginApplication & { organizationNotes?: OrganizationNotes } = {
    ...rig.app,
    ...(option === "off" ? {} : { organizationNotes }),
    web: { origin: "https://studenthub.example.invalid", returnTo: rig.config.allowedReturnUrls[1], profiles: undefined as never },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, session: string | null = SESSION, method = "GET", accept = "text/html") => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, redirect: "manual", headers: { accept, ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}) },
  });
  return { request, calls, login };
}

test("NOTEDET_SHOW a listed note has a read-only escaped detail page", async (t) => {
  const f = await fixture(t);
  for (const session of [SESSION, ADMIN]) {
    const response = await f.request("/organization/org-a/notes/7", session); const body = await response.text();
    assert.equal(response.status, 200, "NOTEDET_SHOW detail is 200");
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /<h1>Phone call<\/h1>/, "NOTEDET_SHOW type label is the heading");
    assert.match(body, /<time datetime="2026-11-20T09:00:00\.000Z">2026-11-20T09:00:00\.000Z<\/time>/, "NOTEDET_SHOW time is rendered");
    assert.ok(body.includes('<p style="white-space: pre-wrap">Line one\n&lt;script&gt;&amp; goodbye</p>'), "NOTEDET_SHOW note text is escaped with line breaks kept");
    assert.doesNotMatch(body, /<script>/, "NOTEDET_SHOW raw text never renders");
    assert.match(body, /href="\/organization\/org-a">Company<\/a>/); assert.match(body, /href="\/organization\/org-a\/notes">Notes<\/a>/);
  }
  const head = await f.request("/organization/org-a/notes/7", SESSION, "HEAD");
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("NOTEDET_MINE selects only the requested note from one list call", async (t) => {
  const f = await fixture(t);
  const found = await f.request("/organization/org-a/notes/7");
  assert.equal(found.status, 200); const foundBody = await found.text();
  assert.match(foundBody, /Line one/); assert.doesNotMatch(foundBody, /Other note/, "NOTEDET_MINE only the requested note is rendered");
  assert.deepEqual(f.calls.list, ["org-a"], "NOTEDET_MINE list is called once for the company");
  const expected = renderError(404, f.login);
  for (const path of ["/organization/org-a/notes/999", "/organization/org-b/notes/7"]) {
    const response = await f.request(path); assert.equal(response.status, 404); assert.equal(await response.text(), expected, "NOTEDET_MINE hidden and unknown notes share renderError(404)");
  }
  const before = f.calls.list.length;
  for (const id of ["0", "01", "abc", "12345678901234567890"]) {
    const response = await f.request(`/organization/org-a/notes/${id}`); assert.equal(response.status, 404); assert.equal(await response.text(), expected);
  }
  assert.equal(f.calls.list.length, before, "NOTEDET_MINE malformed ids do not call list");
  assert.deepEqual([f.calls.preview, f.calls.confirm, f.calls.receipt], [0, 0, 0]);
});

test("NOTEDET_DENY authorization query and methods retain their contracts", async (t) => {
  const f = await fixture(t);
  const noSession = await f.request("/organization/org-a/notes/7", null);
  assert.equal(noSession.status, 401); assert.equal(await noSession.text(), renderError(401, f.login));
  for (const session of [OWNER, RECRUITER, UNRELATED]) {
    const denied = await f.request("/organization/org-a/notes/7", session);
    assert.equal(denied.status, 404); assert.equal(await denied.text(), renderError(404, f.login));
  }
  const query = await f.request("/organization/org-a/notes/7?x=1");
  assert.equal(query.status, 400, "NOTEDET_DENY a query string is 400");
  assert.equal(f.calls.list.length, 4, "NOTEDET_DENY invalid query does not call list");
  const post = await f.request("/organization/org-a/notes/7", SESSION, "POST");
  assert.equal(post.status, 404, "NOTEDET_DENY POST remains the shared fallback");
});

test("NOTEDET_PASSTHROUGH non-detail paths retain the shared handlers", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/organization/org-a/notes")).status, 200);
  assert.equal((await f.request("/organization/org-a/notes?saved=note")).status, 200);
  assert.equal((await f.request("/organization/org-a/notes/7/x")).status, 404);
  const receipts = await f.request("/organization/org-a/notes/receipts");
  const unknown = await f.request("/organization/org-a/notes-unknown-path");
  assert.equal(receipts.status, unknown.status); assert.equal(receipts.headers.get("content-type"), unknown.headers.get("content-type"));
  assert.equal(await receipts.text(), await unknown.text(), "NOTEDET_PASSTHROUGH receipts stays the shared HTML fallback");
  const json = await f.request("/organization/org-a/notes/receipts", SESSION, "GET", "application/json");
  assert.equal(json.status, 404); assert.match(json.headers.get("content-type") ?? "", /^application\/json\b/);
});

test("NOTEDET_UNAVAILABLE list failures use the notes unavailable page", async (t) => {
  for (const option of ["throw", "bad-body", "off"] as const) {
    const f = await fixture(t, option); const response = await f.request("/organization/org-a/notes/7"); const body = await response.text();
    assert.equal(response.status, 503, "NOTEDET_UNAVAILABLE detail is 503");
    assert.match(body, /Notes unavailable/); assert.doesNotMatch(body, /private list failure|Error:|notes\s*:/, "NOTEDET_UNAVAILABLE leaks no list or stack");
  }
});
