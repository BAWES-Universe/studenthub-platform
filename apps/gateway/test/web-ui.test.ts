import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createRuntimeLoginFromEnv } from "../src/login-runtime.js";
import { PostgresAuthzStore } from "@studenthub/db";
import { type BrowserLoginApplication, wantsHtml } from "../src/web-ui.js";

const SESSION = "s".repeat(43);
const OTHER_SESSION = "t".repeat(43);
const ORIGIN = "https://studenthub.test.invalid";
const BROWSER = { accept: "text/html", cookie: `__Host-studenthub_session=${SESSION}` };

async function fixture(t: TestContext) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  await rig.sessions.put({ id: OTHER_SESSION, personId: "person-2" });
  const reads: string[] = [];
  const people = new Map([
    ["person-1", { id: "person-1", displayName: "Synthetic Noor", email: "noor@example.invalid" }],
    ["person-2", { id: "person-2", displayName: "Other Person", email: "other@example.invalid" }],
  ]);
  const login: BrowserLoginApplication = { ...rig.app, web: {
    origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1],
    async readProfile(id) { reads.push(id); return people.get(id); },
  } };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { rig, login, people, reads, url };
}

test("HTML negotiation is opt-in and preserves JSON defaults and preferences", () => {
  for (const accept of [undefined, "*/*", "application/json", "text/html;q=0", "text/html;q=0.5, application/json", "application/json, text/html", "text/html;q=bogus", "text/html;q=2"]) {
    assert.equal(wantsHtml(accept), false, accept);
  }
  for (const accept of ["text/html", "TEXT/HTML; Q=1", "text/html,application/xhtml+xml,*/*;q=0.8", "text/html;q=0.9,application/json;q=0.2"]) {
    assert.equal(wantsHtml(accept), true, accept);
  }
});

test("landing is public HTML with an exact configured login link and no profile reads", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/?return_to=https://attacker.invalid`, {
    headers: { ...BROWSER, host: "attacker.invalid", "x-forwarded-host": "attacker.invalid" },
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /^text\/html/);
  assert.match(body, /Continue with Universe/);
  assert.ok(body.includes(encodeURIComponent(f.rig.config.allowedReturnUrls[1]!)));
  assert.doesNotMatch(body, /Synthetic Noor|noor@example|person-1|attacker|synthetic-secret|<script/);
  assert.deepEqual(f.reads, []);
  assert.equal(response.headers.get("set-cookie"), null);
  const css = await fetch(`${f.url}/assets/studenthub.css`);
  assert.match(css.headers.get("content-type")!, /^text\/css/);
  assert.match(await css.text(), /@media\(max-width:480px\)/);
});

test("real login application renders only the session owner's profile and leaves JSON unchanged", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Synthetic Noor/);
  assert.match(body, /noor@example.invalid/);
  assert.match(body, /person-1/);
  assert.doesNotMatch(body, /Other Person|other@example|person-2|synthetic-secret|candidate|admin/);
  assert.deepEqual(f.reads, ["person-1"]);
  assert.match(body, /method="post"/);
  assert.match(body, /editing isn’t enabled/);
  for (const accept of ["application/json", "*/*", "text/html;q=0, application/json"]) {
    const api = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, accept } });
    assert.deepEqual(await api.json(), { personId: "person-1", role: "candidate" });
    assert.equal(api.headers.get("cache-control"), "no-store");
    assert.equal(api.headers.get("vary"), "Accept");
  }
  assert.deepEqual(f.reads, ["person-1"], "JSON never reads browser-only fields");
});

test("private HTML is non-cacheable, has a restrictive CSP and loads no remote assets", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Accept");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy")!, /form-action 'self'/);
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.doesNotMatch(await response.text(), /(?:src|href)="https?:\/\//);
});

test("foreign person query, missing session and expired session never read private fields", async (t) => {
  const f = await fixture(t);
  for (const [path, headers, status] of [
    ["/profile?person_id=person-2", BROWSER, 404],
    ["/profile", { accept: "text/html" }, 401],
    ["/profile", { accept: "text/html", cookie: `__Host-studenthub_session=${"e".repeat(43)}` }, 401],
  ] as const) {
    const response = await fetch(f.url + path, { headers });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /noor@example|Other Person|person-2|Synthetic Noor/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(f.reads, []);
  const second = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, cookie: `__Host-studenthub_session=${OTHER_SESSION}` } });
  assert.match(await second.text(), /Other Person/);
  assert.deepEqual(f.reads, ["person-2"]);
});

test("a misbound private-profile adapter fails closed instead of displaying another person's details", async (t) => {
  const f = await fixture(t);
  f.people.set("person-1", f.people.get("person-2")!);
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /Other Person|other@example|person-2/);
});

test("HTML escapes hostile stored values and shows absent fields honestly", async (t) => {
  const f = await fixture(t);
  f.people.set("person-1", { id: "person-1", displayName: '<img src=x onerror="alert(1)"> & name', email: '<script>alert("private")</script>' });
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  const body = await response.text();
  assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; name/);
  assert.match(body, /&lt;script&gt;/);
  assert.doesNotMatch(body, /<img|<script/);
  f.people.set("person-1", { id: "person-1", displayName: "", email: "" });
  const empty = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal((await empty.text()).match(/Not available yet/g)?.length, 2);
});

test("unavailable profile dependencies render a safe retry state without killing the gateway", async (t) => {
  const f = await fixture(t);
  f.login.web!.readProfile = async () => { throw new Error("database password=do-not-display"); };
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /Try my profile again/);
  assert.doesNotMatch(body, /password|do-not-display|noor@example/);
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
});

test("browser logout deletes the actual session, clears its cookie and returns to the landing page", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/logout`, { method: "POST", headers: { ...BROWSER, origin: ORIGIN }, redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(await f.rig.sessions.get(SESSION), undefined);
  assert.equal((await fetch(`${f.url}/profile`, { headers: BROWSER })).status, 401);
});

/**
 * What a browser puts in the Origin header of a same-origin, non-GET request
 * from a document served with `policy` (Fetch, "append a request Origin
 * header"). Only the policy decides; the guard the gateway runs cannot see the
 * page, so the page must be served in a way that lets the guard succeed.
 */
function originHeaderForSameOriginPost(policy: string | null, pageOrigin: string): string {
  const effective = policy && policy.trim() !== "" ? policy.trim().toLowerCase() : "strict-origin-when-cross-origin";
  const trustworthy = pageOrigin.startsWith("https:");
  switch (effective) {
    case "no-referrer": return "null";
    case "same-origin": return pageOrigin;
    case "no-referrer-when-downgrade":
    case "strict-origin":
    case "strict-origin-when-cross-origin": return trustworthy ? pageOrigin : "null";
    default: return pageOrigin;
  }
}

/** The Referer a browser sends when the page navigates to another origin. */
function refererForCrossOriginNavigation(policy: string | null, pageUrl: string): string | undefined {
  const effective = policy && policy.trim() !== "" ? policy.trim().toLowerCase() : "strict-origin-when-cross-origin";
  switch (effective) {
    case "no-referrer":
    case "same-origin": return undefined;
    case "unsafe-url":
    case "no-referrer-when-downgrade": return pageUrl;
    default: return `${new URL(pageUrl).origin}/`;
  }
}

test("the sign-out form succeeds under the referrer policy the profile page is actually served with", async (t) => {
  // SHU-132: the page was served with `referrer-policy: no-referrer`, so the
  // browser sent `Origin: null` with the sign-out POST and /logout refused it
  // with 403. The earlier logout test hand-set the Origin header and never
  // read the policy, so it kept passing while every real sign-out failed.
  const f = await fixture(t);
  const profile = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal(profile.status, 200);
  const policy = profile.headers.get("referrer-policy");
  const origin = originHeaderForSameOriginPost(policy, ORIGIN);
  const response = await fetch(`${f.url}/logout`, {
    method: "POST", redirect: "manual",
    headers: { ...BROWSER, origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  assert.equal(response.status, 303, `a same-origin sign-out under "${policy}" sends Origin "${origin}"`);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(await f.rig.sessions.get(SESSION), undefined, "sign-out must end the session");
  // The privacy property the old header was chosen for still holds: leaving
  // for Universe never carries the page path.
  const referer = refererForCrossOriginNavigation(policy, `${ORIGIN}/profile`);
  assert.ok(referer === undefined || !referer.includes("/profile"), `"${policy}" leaks the page path cross-origin`);
});

test("cross-site or originless browser logout cannot delete a session even with forged Host", async (t) => {
  const f = await fixture(t);
  for (const additional of [{}, { origin: "https://attacker.invalid", host: "attacker.invalid" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    const response = await fetch(`${f.url}/logout`, { method: "POST", headers: { ...BROWSER, ...additional }, redirect: "manual" });
    assert.equal(response.status, 403);
    assert.ok(await f.rig.sessions.get(SESSION));
  }
  assert.equal((await fetch(`${f.url}/logout`, { method: "POST", headers: { cookie: BROWSER.cookie } })).status, 204);
});

test("browser start/callback reuse real OIDC state, PKCE and session creation", async (t) => {
  const f = await fixture(t);
  const start = await fetch(`${f.url}/login/universe?return_to=${encodeURIComponent(f.rig.config.allowedReturnUrls[1]!)}`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(start.status, 302);
  const browserCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
  const request = f.rig.provider.authorizationRequests.at(-1)!;
  const code = f.rig.provider.authorize();
  const callback = await fetch(`${f.url}/login/callback?state=${request.state}&code=${code}`, { headers: { accept: "text/html", cookie: browserCookie }, redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), f.rig.config.allowedReturnUrls[1]);
  const cookie = callback.headers.get("set-cookie")!.split(";", 1)[0]!;
  assert.equal((await fetch(`${f.url}/profile`, { headers: { accept: "text/html", cookie } })).status, 200);
  for (const url of ["/login/universe", "/login/callback?state=secret-state&code=secret-code"]) {
    const rejected = await fetch(f.url + url, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(await rejected.text(), /secret-state|secret-code/);
  }
});

test("runtime wires the browser reader to the authorized principal and uses only the exact same-origin profile return", async (t) => {
  const env = {
    DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic", OIDC_ISSUER: "https://identity.test.invalid/",
    OIDC_CLIENT_ID: "synthetic", OIDC_CLIENT_SECRET: "synthetic", OIDC_CALLBACK_URL: `${ORIGIN}/login/callback`,
    OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize", OIDC_TOKEN_URL: "https://identity.test.invalid/token",
    OIDC_JWKS_URL: "https://identity.test.invalid/jwks", LOGIN_ALLOWED_RETURN_URLS: `${ORIGIN}/profile`,
  };
  const seen: string[] = [];
  t.mock.method(PostgresAuthzStore.prototype, "getPrincipal", async (id: string) => {
    seen.push(id); return { id, displayName: "Stored Name", email: "stored@example.invalid", pbuuids: [] };
  });
  const runtime = createRuntimeLoginFromEnv(env)!;
  t.after(() => runtime.close());
  assert.equal(runtime.application.web?.origin, ORIGIN);
  assert.equal(runtime.application.web?.returnTo, `${ORIGIN}/profile`);
  assert.equal((await runtime.application.web?.readProfile("authorized-person"))?.displayName, "Stored Name");
  assert.deepEqual(seen, ["authorized-person"]);
  const other = createRuntimeLoginFromEnv({ ...env, LOGIN_ALLOWED_RETURN_URLS: "https://other.test.invalid/profile" })!;
  t.after(() => other.close());
  assert.equal(other.application.web?.returnTo, undefined);
});

test("unconfigured browser login gives a truthful unavailable page and leaves machine routes disabled", async (t) => {
  const server = createGatewayServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  assert.match(await (await fetch(url)).text(), /Sign-in is temporarily unavailable/);
  assert.equal((await fetch(`${url}/profile`, { headers: { accept: "text/html" } })).status, 503);
  assert.equal((await fetch(`${url}/profile`)).status, 404);
  assert.equal((await fetch(`${url}/assets/missing.css`)).status, 404);
});
