import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { formatSize, readOwnDocuments, renderDocumentsPage } from "../src/documents-page.js";
import { LifecycleError, type CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "d".repeat(43);
const BROWSER = { accept: "text/html", cookie: `__Host-studenthub_session=${SESSION}` };

type Listed = Awaited<ReturnType<CandidateDocuments["list"]>>;

async function serve(t: TestContext, list: (credential: unknown) => Promise<Listed>) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  const login: BrowserLoginApplication = { ...rig.app };
  const calls: unknown[] = [];
  const documents = { async list(credential: unknown) { calls.push(credential); return list(credential); } } as unknown as CandidateDocuments;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, documents);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

const RESUME = { id: "doc-1", version: "v-secret", type: "resume", mime: "application/pdf", size: 245760 } as Listed[number];
const PHOTO = { id: "doc-2", version: "v-2", type: "personal-photo", mime: "image/jpeg", size: 900 } as Listed[number];

test("my documents lists the four slots with on-file and missing states", async (t) => {
  const f = await serve(t, async () => [PHOTO, RESUME]);
  const response = await fetch(`${f.url}/profile/documents`, { headers: BROWSER });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /My documents/);
  assert.match(html, /2 of 4 documents on file\./);
  assert.equal((html.match(/class="doc-slot"/g) ?? []).length, 4);
  assert.match(html, /data-type="resume"><div class="doc-icon" aria-hidden="true">PDF<\/div><div class="doc-body"><h3>CV<\/h3><span class="doc-state on-file">On file<\/span><p class="doc-meta">PDF · 240 KB/);
  assert.match(html, /data-type="civil-id-front">.*?Not uploaded/);
  assert.match(html, /aria-current="page">My documents/);
  // Internal identifiers and versions never reach the page.
  assert.doesNotMatch(html, /doc-1|v-secret/);
  assert.deepEqual(f.calls, [SESSION]);
});

test("all documents on file says so", async (t) => {
  const all = ["personal-photo", "resume", "civil-id-front", "civil-id-back"].map((type, i) =>
    ({ id: `d${i}`, version: "v", type, mime: type === "resume" ? "application/pdf" : "image/png", size: 2048 }) as Listed[number]);
  const f = await serve(t, async () => all);
  const html = await (await fetch(`${f.url}/profile/documents`, { headers: BROWSER })).text();
  assert.match(html, /All four documents are on file\./);
  assert.doesNotMatch(html, /Not uploaded/);
});

test("no session never reads the list and asks to sign in", async (t) => {
  const f = await serve(t, async () => [RESUME]);
  const response = await fetch(`${f.url}/profile/documents`, { headers: { accept: "text/html" } });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Sign in to see your documents\./);
  assert.deepEqual(f.calls, []);
});

test("a denied session is treated as signed out", async (t) => {
  const f = await serve(t, async () => { throw new LifecycleError(403, "denied"); });
  const response = await fetch(`${f.url}/profile/documents`, { headers: BROWSER });
  assert.equal(response.status, 401);
});

test("a failing store shows unavailable without leaking the error", async (t) => {
  const f = await serve(t, async () => { throw new Error("postgres://user:secret@db/broken"); });
  const response = await fetch(`${f.url}/profile/documents`, { headers: BROWSER });
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /aren’t available right now/);
  assert.doesNotMatch(html, /secret|postgres/);
});

test("JSON callers get the same own list without ids or versions", async (t) => {
  const f = await serve(t, async () => [RESUME]);
  const response = await fetch(`${f.url}/profile/documents`, { headers: { cookie: BROWSER.cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { documents: [{ type: "resume", mime: "application/pdf", size: 245760 }] });
});

test("unconfigured documents report unavailable", async () => {
  assert.deepEqual(await readOwnDocuments(undefined, SESSION), { status: 503 });
  assert.deepEqual(await readOwnDocuments(undefined, undefined), { status: 401 });
  assert.match(renderDocumentsPage({ status: 503 }, { navigation: false }), /Back to my profile/);
});

test("unknown types from the store are dropped", async () => {
  const reader = { async list() { return [{ ...RESUME, type: "organization-licence" }] as unknown as Listed; } };
  assert.deepEqual(await readOwnDocuments(reader, SESSION), { status: 200, documents: [] });
});

test("sizes read naturally", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(3 * 1024 * 1024 + 100), "3.0 MB");
  assert.equal(formatSize(-1), "Unknown size");
});
