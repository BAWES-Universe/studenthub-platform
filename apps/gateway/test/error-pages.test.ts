import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import { ERROR_KINDS, errorPage } from "../src/shell/error-pages.js";

const ORIGIN = "https://studenthub.example";
async function rig(t: TestContext, login?: unknown) {
  const server = createGatewayServer(undefined, undefined, undefined, login as never);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, accept = "text/html", method = "GET", cookie?: string) =>
    fetch(base + path, { method, headers: { accept, ...(cookie ? { cookie } : {}) }, redirect: "manual" });
}

test("U07_ERROR every kind is an accessible page with its own status, no account data and no caching", async (t) => {
  const call = await rig(t);
  const expected = { "not-found": 404, server: 503, "app-error": 500, offline: 503 } as const;
  assert.deepEqual([...ERROR_KINDS], Object.keys(expected));
  for (const kind of ERROR_KINDS) {
    const r = await call(`/error/${kind}`, "text/html", "GET", "__Host-studenthub_session=someone");
    assert.equal(r.status, expected[kind], kind);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
    const html = await r.text();
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<a class="skip" href="#main">/);
    assert.equal((html.match(/<main id="main"/g) ?? []).length, 1);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.match(html, /<a class="button primary" href="\/">Start again from StudentHub/);
    assert.doesNotMatch(html, /someone|Sign out/, "no session is read, nothing about the account is shown");
    assert.equal(html, errorPage(kind).html);
  }
  assert.notEqual(errorPage("server").html, errorPage("offline").html);
});

test("U07_ERROR an unknown kind is not found; API callers get JSON; other methods 405", async (t) => {
  const call = await rig(t);
  const unknown = await call("/error/whatever");
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), errorPage("not-found").html);
  const json = await call("/error/app-error", "application/json");
  assert.equal(json.status, 500);
  assert.deepEqual(await json.json(), { ok: false, error: "app_error" });
  assert.equal((await call("/error/server", "text/html", "POST")).status, 405);
  assert.equal((await call("/error/server", "text/html", "HEAD")).status, 503);
  assert.equal((await call("/error/server/extra")).status, 404, "a deeper path is the wildcard");
});

test("U07_ERROR the wildcard is the not-found page for a browser and the same JSON as before for an API caller", async (t) => {
  const call = await rig(t);
  const page = await call("/no/such/page?x=<script>");
  assert.equal(page.status, 404);
  const html = await page.text();
  assert.equal(html, errorPage("not-found").html);
  assert.doesNotMatch(html, /<script>|no\/such/, "the request is never echoed");
  for (const accept of ["application/json", "*/*", ""]) {
    const api = await call("/no/such/page", accept);
    assert.equal(api.status, 404, accept);
    assert.deepEqual(await api.json(), { ok: false, error: "not_found" }, accept);
  }
  const head = await call("/no/such/page", "text/html", "HEAD");
  assert.equal(head.status, 404); assert.match(head.headers.get("content-type") ?? "", /^text\/html/, "HEAD matches GET");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const write = await call("/no/such/page", "text/html", method);
    assert.equal(write.status, 404, method);
    assert.equal(await write.text(), errorPage("not-found").html, `${method} from a browser is the page too, so a refused write looks like an unknown path`);
    const api = await call("/no/such/page", "application/json", method);
    assert.equal(api.headers.get("content-type"), "application/json", `${method} API keeps the JSON`);
    assert.equal(await api.text(), '{"ok":false,"error":"not_found"}', `${method} API keeps the bytes`);
  }
});

test("U07_ERROR an unhandled failure is the server page for a browser and the same JSON as before for an API caller", async (t) => {
  const call = await rig(t, { web: { origin: ORIGIN }, notifications: { open: async () => { throw new Error("boom"); } } });
  const page = await call("/notifications");
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.equal(html, errorPage("server").html);
  assert.doesNotMatch(html, /boom/);
  const api = await call("/notifications", "application/json");
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { ok: false, error: "service_unavailable" });
});
