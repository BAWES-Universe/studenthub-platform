import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import type { OrganizationNotes } from "../src/organization-notes.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSION = "s".repeat(43);
const TOKEN = { changeSetDigest: "a", expectedBeforeDigest: "b", expiresAt: "c", issuedAt: "d", mac: "e", principalRef: "f", tokenId: "g" };
const NOTE = { noteId: "1", text: "<script>x</script>", authorPrincipalId: "secret-author", createdAt: "2026-11-23T10:00:00.000Z", noteType: "internal_note" };

async function fixture(t: TestContext, options: { deny?: boolean; unavailable?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "staff" });
  const calls = { preview: 0, confirm: 0 };
  const notes = [NOTE];
  const service: OrganizationNotes = {
    async list(session, orgId) { if (!session) return { status: 401, body: { error: "unauthorized" } }; if (options.deny || orgId !== "org-a") return { status: 404, body: { error: "not_found" } }; return { status: 200, body: { notes } }; },
    async preview(session, body) { calls.preview++; if (!session) return { status: 401, body: { error: "unauthorized" } }; if (options.deny) return { status: 404, body: { error: "not_found" } }; const value = (body as { value: string }).value; if (value.length > 2000 || /[\x00-\x08]/.test(value)) return { status: 400, body: { error: "invalid_value" } }; return { status: 200, body: { changes: [], token: TOKEN } }; },
    async confirm(session, body) { calls.confirm++; if (!session) return { status: 401, body: { error: "unauthorized" } }; if (options.deny) return { status: 404, body: { error: "not_found" } }; if ((body as { token: { mac: string } }).token.mac !== TOKEN.mac) return { status: 409, body: { error: "token_invalid" } }; notes.unshift({ ...NOTE, noteId: "2", text: (body as { value: string }).value }); return { status: 200, body: { receipt: {} } }; },
    async receipt() { return { status: 404, body: { error: "not_found" } }; },
  };
  const login: BrowserLoginApplication & { organizationNotes?: OrganizationNotes } = { ...rig.app, ...(options.unavailable ? {} : { organizationNotes: service }), web: { origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1], profiles: {} as never } };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { accept: "text/html", cookie: `__Host-studenthub_session=${SESSION}`, ...(init.headers ?? {}) } });
  const post = (path: string, body: URLSearchParams | string, headers: Record<string, string> = {}) => request(path, { method: "POST", body: String(body), headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers } });
  const form = (html: string) => new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => [match[1]!, match[2]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")]));
  return { request, post, form, calls, notes };
}

test("NOTES_LIST staff sees escaped newest-first notes and the typed note form", async (t) => {
  const f = await fixture(t); const response = await f.request("/organization/org-a/notes"); const body = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /<h1>Notes<\/h1>/); assert.match(body, /Internal note/); assert.match(body, /<time datetime="2026-11-23T10:00:00.000Z">/);
  assert.match(body, /&lt;script&gt;x&lt;\/script&gt;/, "NOTES_LIST note text is escaped"); assert.doesNotMatch(body, /<script>x<\/script>/); assert.doesNotMatch(body, /secret-author/);
  assert.match(body, /href="\/organization\/org-a">Company<\/a>/); assert.equal([...body.matchAll(/<option value=/g)].length, 6); assert.match(body, /textarea[^>]+name="value"[^>]+maxlength="2000"/);
});

test("NOTES_DENY refusals are hidden and store nothing", async (t) => {
  const f = await fixture(t, { deny: true });
  for (const [path, init] of [["/organization/org-a/notes", undefined], ["/organization/org-a/notes/preview", new URLSearchParams({ field: "note", value: "x" })], ["/organization/org-a/notes/confirm", new URLSearchParams({ field: "note", value: "x" })]] as const) {
    const response = init ? await f.post(path, init) : await f.request(path);
    assert.equal(response.status, 404, "NOTES_DENY service 404 stays 404");
  }
  assert.equal(f.notes.length, 1);
});

test("NOTES_PREVIEW validates then renders an escaped token-carrying preview", async (t) => {
  const f = await fixture(t); const response = await f.post("/organization/org-a/notes/preview", new URLSearchParams({ field: "note_email", value: "<b>Hello</b>" })); const body = await response.text();
  assert.equal(response.status, 200); assert.match(body, /Email/); assert.match(body, /&lt;b&gt;Hello&lt;\/b&gt;/); assert.equal(f.calls.preview, 1);
  assert.match(body, /Save note/); assert.match(body, /href="\/organization\/org-a\/notes">Cancel<\/a>/); assert.equal([...f.form(body).keys()].length, 9);
  const whitespace = await f.post("/organization/org-a/notes/preview", new URLSearchParams({ field: "note", value: "   " }));
  assert.equal(whitespace.status, 400, "NOTES_PREVIEW whitespace never reaches the service"); assert.equal(f.calls.preview, 1);
});

test("NOTES_CONFIRM saves once, redirects, and reports token conflicts", async (t) => {
  const f = await fixture(t); const preview = await f.post("/organization/org-a/notes/preview", new URLSearchParams({ field: "note", value: "new" })); const values = f.form(await preview.text());
  const response = await f.post("/organization/org-a/notes/confirm", values);
  assert.equal(response.status, 303, "NOTES_CONFIRM successful confirm redirects"); assert.equal(response.headers.get("location"), "/organization/org-a/notes?saved=note");
  assert.equal(f.calls.confirm, 1, "NOTES_CONFIRM calls confirm once");
  values.set("token.mac", "tampered"); const conflict = await f.post("/organization/org-a/notes/confirm", values);
  assert.equal(conflict.status, 409, "NOTES_CONFIRM service conflict stays 409"); assert.match(await conflict.text(), /already saved or its preview expired/);
});

test("NOTES_ORIGIN rejects cross-origin posts before service work", async (t) => {
  const f = await fixture(t);
  for (const path of ["/organization/org-a/notes/preview", "/organization/org-a/notes/confirm"]) {
    const response = await f.post(path, "field=note&value=x", { origin: "https://evil.invalid" });
    assert.equal(response.status, 403, "NOTES_ORIGIN a wrong Origin is 403");
  }
  assert.deepEqual(f.calls, { preview: 0, confirm: 0 });
});

test("NOTES_UNAVAILABLE missing notes service is a plain 503", async (t) => {
  const f = await fixture(t, { unavailable: true }); const response = await f.request("/organization/org-a/notes");
  assert.equal(response.status, 503); assert.match(await response.text(), /Notes are unavailable right now\./);
});

test("NOTES_PASSTHROUGH unrelated methods and paths pass through", async (t) => {
  const f = await fixture(t); assert.equal((await f.request("/organization/org-a/notes", { method: "DELETE" })).status, 404);
  assert.notEqual((await f.request("/organization/org-a")).status, 200, "NOTES_PASSTHROUGH overview remains owned by its existing prerequisites");
});
