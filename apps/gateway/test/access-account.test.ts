import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import type { AccessPorts } from "../src/access/admin-access.js";
import type { AccountSession, AccountSessionsStore } from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const DANA = "d".repeat(43), DANA_PHONE = "p".repeat(43), OMAR = "o".repeat(43);

function world(extraLive = 0) {
  // Cookie -> person, and each session's start (null = before the record).
  const live = new Map<string, { personId: string; signedInAt: string | null }>([
    [DANA, { personId: "dana", signedInAt: "2026-11-24T06:00:00.000Z" }],
    [DANA_PHONE, { personId: "dana", signedInAt: null }],
    [OMAR, { personId: "omar", signedInAt: "2026-11-20T06:00:00.000Z" }],
  ]);
  const ended: string[] = [];
  const account: AccountSessionsStore = {
    async list(personId, current) {
      const sessions = [...live].filter(([, row]) => row.personId === personId)
        .map(([token, row]): AccountSession => ({ current: token === current, signedInAt: row.signedInAt, expiresAt: "2026-12-01T06:00:00.000Z" }))
        .sort((a, b) => Number(b.current) - Number(a.current));
      // extraLive: live sessions beyond the store's cap, counted but not listed.
      return { sessions, live: sessions.length + (personId === "dana" ? extraLive : 0) };
    },
    async endAll(personId) {
      ended.push(personId);
      let count = 0;
      for (const [token, row] of live) if (row.personId === personId) { live.delete(token); count++; }
      return count;
    },
  };
  const ports = {
    sessions: { get: async (id: string) => (live.has(id) ? { id, personId: live.get(id)!.personId } : undefined) },
    reads: { ownGrants: async () => [] } as never,
    account,
  } as AccessPorts;
  return { ports, live, ended };
}

async function serve(t: TestContext, ports: AccessPorts) {
  const server = createGatewayServer(undefined, undefined, undefined, { access: ports, web: { origin: ORIGIN } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (token?: string): Record<string, string> => (token ? { cookie: `__Host-studenthub_session=${token}` } : {});
  const get = (path: string, token?: string, accept = "text/html") => fetch(base + path, { headers: { accept, ...cookie(token) }, redirect: "manual" });
  const post = (path: string, token: string | undefined, body = "", headers: Record<string, string> = { origin: ORIGIN }) =>
    fetch(base + path, { method: "POST", redirect: "manual", body,
      headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", ...headers, ...cookie(token) } });
  return { get, post };
}

async function sameAsUnknown(actual: Response, unknown: Response, message: string) {
  assert.equal(actual.status, unknown.status, `${message} status`);
  assert.equal(await actual.text(), await unknown.text(), `${message} body`);
}

test("U03_PAGE a signed-in person sees where they are signed in, this browser first, in Kuwait time", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  const response = await http.get("/account", DANA);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Account<span class="accent">\.<\/span><\/h1>/);
  assert.match(html, /You are signed in to StudentHub in this browser and 1 other\./);
  assert.match(html, /<tr><th scope="row">This browser<\/th><td>24 Nov 2026, 09:00<\/td>/);
  assert.match(html, /<tr><th scope="row">Another browser or device<\/th><td>Not recorded<\/td>/);
  assert.match(html, /<form action="\/account\/sign-out-everywhere" method="post"><button type="submit">Sign out everywhere<\/button><\/form>/);
  assert.match(html, /<a class="nav-item active" href="\/account" aria-current="page">Account<\/a>/);
  assert.doesNotMatch(html, /20 Nov 2026/, "another person's session is never listed");
  assert.match(await (await http.get("/account", OMAR)).text(), /signed in to StudentHub only in this browser\./);
  assert.match(await (await http.get("/profile/access", DANA)).text(), /<a class="nav-item" href="\/account">Account<\/a>/, "Your access links to the account page");
  assert.doesNotMatch(html, /Showing the latest/, "under the cap nothing is left out");
});

test("U03_OVER_LIMIT past the store's cap the page counts every live sign-in, not just the listed ones", async (t) => {
  const { ports } = world(58);
  const http = await serve(t, ports);
  const html = await (await http.get("/account", DANA)).text();
  assert.match(html, /You are signed in to StudentHub in this browser and 59 others\./);
  assert.match(html, /Showing the latest 2 of your 60 sign-ins\. Signing out everywhere ends all 60\./);
});

test("U03_SIGNED_OUT signed out, an unknown session and other methods get the unknown-path 404", async (t) => {
  const { ports, ended } = world();
  const http = await serve(t, ports);
  for (const token of [undefined, "x".repeat(43)]) {
    await sameAsUnknown(await http.get("/account", token), await http.get("/definitely-unknown", token), `GET ${token ?? "signed out"}`);
    await sameAsUnknown(await http.post("/account/sign-out-everywhere", token), await http.get("/definitely-unknown", token), `POST ${token ?? "signed out"}`);
  }
  await sameAsUnknown(await http.post("/account", DANA), await http.get("/definitely-unknown", DANA), "POST /account");
  await sameAsUnknown(await http.get("/account/sign-out-everywhere", DANA), await http.get("/definitely-unknown", DANA), "GET sign-out-everywhere");
  const { ports: { reads, sessions } } = world();
  const without = await serve(t, { reads, sessions } as AccessPorts);
  await sameAsUnknown(await without.get("/account", DANA), await without.get("/definitely-unknown", DANA), "no port");
  assert.deepEqual(ended, []);
});

test("U03_EVERYWHERE signing out everywhere ends all of the person's sessions, clears the cookie and goes to the signed-out page", async (t) => {
  const { ports, live, ended } = world();
  const http = await serve(t, ports);
  const response = await http.post("/account/sign-out-everywhere", DANA_PHONE);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/signed-out");
  assert.match(response.headers.get("set-cookie") ?? "", /^__Host-studenthub_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(ended, ["dana"]);
  assert.deepEqual([...live.keys()], [OMAR], "both of Dana's sessions end; Omar's stays");
  await sameAsUnknown(await http.get("/account", DANA), await http.get("/definitely-unknown", DANA), "the other browser is signed out on its next request");
});

test("U03_SAME_ORIGIN a cross-site or foreign-origin post, or one with fields, changes nothing", async (t) => {
  const { ports, live, ended } = world();
  const http = await serve(t, ports);
  for (const headers of [{ origin: "https://evil.example.invalid" }, {} as Record<string, string>, { origin: ORIGIN, "sec-fetch-site": "cross-site" }]) {
    const response = await http.post("/account/sign-out-everywhere", DANA, "", headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.match(await response.text(), /That request did not come from this page\. Nothing changed\./);
  }
  for (const body of ["personId=omar", "__proto__=x", "constructor=x"]) {
    const extra = await http.post("/account/sign-out-everywhere", DANA, body);
    assert.equal(extra.status, 400, body);
    assert.match(await extra.text(), /Nothing changed\./);
  }
  assert.deepEqual(ended, []);
  assert.equal(live.size, 3);
});
