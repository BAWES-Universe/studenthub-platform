import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import {
  InMemoryApprovedProfileAdapter,
  OwnProfileRepository,
  OWN_PROFILE_FIELD_NAMES,
  PROFILE_PARITY_REVISION,
  PERSON_SELF_EDIT_FIELDS,
  SYNTHETIC_PROFILE_FIXTURES,
} from "@studenthub/profile";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createRuntimeLoginFromEnv } from "../src/login-runtime.js";
import { PostgresAuthzStore } from "@studenthub/db/access";
import { type BrowserLoginApplication, wantsHtml, profileDocument, renderAssignedCompanies, renderWorkspace, writeHtml, pageDocument, WORKSPACE_HISTORY_JS } from "../src/web-ui.js";
import type { ServerResponse } from "node:http";
import type { CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import type { OrganizationAccountManager } from "../src/organization-account-manager.js";
import { organizationAssignedCompaniesView } from "@studenthub/organizations";

const SESSION = "s".repeat(43);
const OTHER_SESSION = "t".repeat(43);
const ORIGIN = "https://studenthub.test.invalid";
const BROWSER = { accept: "text/html", cookie: `__Host-studenthub_session=${SESSION}` };

async function fixture(t: TestContext, options: {
  readonly links?: readonly { readonly principalId: string; readonly candidateRef: string }[];
  readonly nationalityId?: string | null;
  readonly documents?: CandidateDocuments;
} = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  await rig.sessions.put({ id: OTHER_SESSION, personId: "person-2" });
  const reads: string[] = [];
  const authz = new InMemoryAuthzStore({ principals: [
    createPrincipal({ id: "person-1", pbuuids: ["pbuuid-1"], displayName: "Registry Name", email: "registry@example.invalid" }),
    createPrincipal({ id: "person-2", pbuuids: ["pbuuid-2"] }),
  ] });
  await authz.grantMany("person-1", [
    { orgId: "candidate:person-1", role: "candidate", scope: "self" },
    { orgId: "company:synthetic", role: "recruiter", scope: "subtree" },
  ]);
  const rows = new Map<string, unknown>([
    ["candidate-1", SYNTHETIC_PROFILE_FIXTURES.populated],
    ["candidate-2", { ...SYNTHETIC_PROFILE_FIXTURES.partial, candidate_id: 232, candidate_name: "Other Person" }],
  ]);
  const repository = new OwnProfileRepository({
    principals: authz,
    source: new InMemoryApprovedProfileAdapter({
      links: options.links ?? [
        { principalId: "person-1", candidateRef: "candidate-1" },
        { principalId: "person-2", candidateRef: "candidate-2" },
      ],
      rows,
    }),
    ...(Object.hasOwn(options, "nationalityId") ? { preferences: { async readOwnPreferences() {
      return { language: "en", updatedAt: "2026-09-13T00:00:00.000Z", nationality: { value: options.nationalityId ? "Country" : null, updatedAt: "2026-09-13T00:00:00.000Z", ...(options.nationalityId ? { editValue: options.nationalityId } : {}) } };
    } } } : {}),
    today: () => "2026-09-13",
  });
  const profiles = {
    async readOwn(request: Parameters<typeof repository.readOwn>[0]) {
      reads.push(request.targetPersonId);
      return repository.readOwn(request);
    },
  };
  const login: BrowserLoginApplication = { ...rig.app,
    ...(Object.hasOwn(options, "nationalityId") ? { profileEdit: {
      async preview() { throw new Error("unexpected preview"); }, async confirm() { throw new Error("unexpected confirm"); }, async receipt() { throw new Error("unexpected receipt"); },
      async choices() { return { countries: [{ id: "11111111-1111-4111-8111-111111111111", name: "Kuwait", code: "KW" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other country", code: "JO" }], universities: [] }; },
    } } : {}), web: {
    origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1],
    profiles,
  } };
  const server = createGatewayServer(undefined, undefined, undefined, login, undefined, undefined, options.documents);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { rig, login, rows, profiles, reads, url };
}

test("HTML negotiation is opt-in and preserves JSON defaults and preferences", () => {
  for (const accept of [undefined, "*/*", "application/json", "text/html;q=0", "text/html;q=0.5, application/json", "application/json, text/html", "text/html;q=bogus", "text/html;q=2"]) {
    assert.equal(wantsHtml(accept), false, accept);
  }
  for (const accept of ["text/html", "TEXT/HTML; Q=1", "text/html,application/xhtml+xml,*/*;q=0.8", "text/html;q=0.9,application/json;q=0.2"]) {
    assert.equal(wantsHtml(accept), true, accept);
  }
});

test("PAGE_DOCUMENT_HISTORY_OPT_IN keeps default documents script-free and pairs the explicit guard with CSP", () => {
  for (const language of [undefined, "en", "ar"] as const) {
    for (const historyGuard of [undefined, false, true]) {
      const html = pageDocument("Review language", '<main id="main">Review</main>', language, historyGuard);
      assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [],
        historyGuard ? ['<script src="/assets/workspace-history.js" defer></script>'] : []);
      assert.match(html, language === "ar" ? /<html lang="ar" dir="rtl">/
        : language === "en" ? /<html lang="en" dir="ltr">/ : /<html lang="en">/);
      let headers: Record<string, string> = {}, written = "";
      const response = {
        writeHead(status: number, value: Record<string, string>) { assert.equal(status, 200); headers = value; },
        end(body: string) { written = body; },
      } as unknown as ServerResponse;
      writeHtml(response, 200, html, {}, historyGuard);
      assert.equal(written, html);
      assert.equal(headers["cache-control"], "no-store");
      assert.equal(headers["content-security-policy"],
        "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
          + (historyGuard ? "; script-src 'self'" : ""));
    }
  }
});

test("WORKSPACE_HISTORY_UNIT hides outgoing snapshots and reloads only persisted pageshow", () => {
  // Synthetic callbacks test the unchanged script, not real browser BFCache use.
  const listeners = new Map<string, (event: { persisted: boolean }) => void>();
  const document = { documentElement: { hidden: false } };
  const hiddenAtReload: boolean[] = [];
  new Function("addEventListener", "document", "location", WORKSPACE_HISTORY_JS)(
    (name: string, listener: (event: { persisted: boolean }) => void) => { listeners.set(name, listener); },
    document, { reload() { hiddenAtReload.push(document.documentElement.hidden); } },
  );
  assert.deepEqual([...listeners.keys()], ["pagehide", "pageshow"]);
  listeners.get("pageshow")!({ persisted: false });
  assert.equal(document.documentElement.hidden, false); assert.deepEqual(hiddenAtReload, []);
  for (const persisted of [false, true]) {
    listeners.get("pagehide")!({ persisted });
    assert.equal(document.documentElement.hidden, true, "every outgoing snapshot is concealed");
    assert.deepEqual(hiddenAtReload, []);
    listeners.get("pageshow")!({ persisted: false });
    assert.equal(document.documentElement.hidden, false, "ordinary pageshow reveals without reloading");
  }
  listeners.get("pagehide")!({ persisted: true });
  listeners.get("pageshow")!({ persisted: true });
  assert.deepEqual(hiddenAtReload, [true], "restored snapshot stays hidden while a fresh request reloads");
  assert.equal(document.documentElement.hidden, true);
});

test("WORKSPACE_HISTORY_ASSET gateway serves the same unchanged script checked by the unit test", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/assets/workspace-history.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), WORKSPACE_HISTORY_JS);
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

test("real login application serves the same typed projection to HTML and JSON with multiple grants", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Noor Al-Sabah/);
  assert.match(body, /C00231/);
  assert.match(body, /أرحّب بعروض العمل/);
  assert.doesNotMatch(body, /Other Person|registry@example|person-1|person-2|SENSITIVE-|candidate_civil_id|candidate_resume/);
  assert.deepEqual(f.reads, ["person-1"]);
  assert.match(body, /method="post"/);
  assert.doesNotMatch(body, /editing isn’t enabled/);
  for (const accept of ["application/json", "*/*", "text/html;q=0, application/json"]) {
    const api = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, accept } });
    const projection = await api.json();
    assert.equal(projection.version, "studenthub.own-profile.v1");
    assert.equal(projection.fields.displayName.value, "Noor Al-Sabah");
    assert.equal(projection.fields.age.value, 23);
    assert.equal(projection.fields.civilExpired.value, false);
    assert.ok(!JSON.stringify(projection).includes("SENSITIVE-"));
    assert.equal(api.headers.get("cache-control"), "no-store");
    assert.equal(api.headers.get("vary"), "Accept");
  }
  assert.deepEqual(f.reads, ["person-1", "person-1", "person-1", "person-1"]);
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
  assert.doesNotMatch(response.headers.get("content-security-policy")!, /script-src/);
  const document = await response.text();
  assert.doesNotMatch(document, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(document, /<script\b/i);
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
    assert.doesNotMatch(await response.text(), /registry@example|Other Person|person-2|Noor Al-Sabah/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(f.reads, []);
  const second = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, cookie: `__Host-studenthub_session=${OTHER_SESSION}` } });
  assert.match(await second.text(), /Other Person/);
  assert.deepEqual(f.reads, ["person-2"]);
});

test("missing and conflicted approved linkage return the same closed not_found response", async (t) => {
  const cases = [
    [] as const,
    [
      { principalId: "person-1", candidateRef: "candidate-1" },
      { principalId: "person-1", candidateRef: "candidate-2" },
    ] as const,
    [
      { principalId: "person-1", candidateRef: "candidate-1" },
      { principalId: "person-2", candidateRef: "candidate-1" },
    ] as const,
  ];
  for (const links of cases) {
    const f = await fixture(t, { links });
    const response = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, accept: "application/json" } });
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.equal(body, JSON.stringify({ error: "profile_not_found" }));
    assert.doesNotMatch(body, /candidate-|person-|registry|SENSITIVE/);
  }
});

test("a malformed approved profile fails closed instead of exposing imported values", async (t) => {
  const f = await fixture(t);
  f.rows.set("candidate-1", {
    ...SYNTHETIC_PROFILE_FIXTURES.populated,
    candidate_gender: "SENSITIVE-MALFORMED-GENDER",
    candidate_civil_id: "SENSITIVE-CIVIL-SENTINEL",
  });
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /SENSITIVE|Noor Al-Sabah/);
  const json = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, accept: "application/json" } });
  assert.equal(json.status, 503);
  assert.deepEqual(await json.json(), { error: "profile_unavailable" });
});

test("HTML escapes hostile imported values and renders unavailable fields explicitly", async (t) => {
  const f = await fixture(t);
  f.rows.set("candidate-1", {
    ...SYNTHETIC_PROFILE_FIXTURES.partial,
    candidate_id: 1,
    candidate_name: '<img src=x onerror="alert(1)"> & name',
    candidate_intro: '<script>alert("private")</script>',
  });
  const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
  const body = await response.text();
  assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; name/);
  assert.match(body, /&lt;script&gt;/);
  assert.doesNotMatch(body, /<img|<script/);
  f.rows.set("candidate-1", SYNTHETIC_PROFILE_FIXTURES.unavailable);
  const empty = await fetch(`${f.url}/profile`, { headers: BROWSER });
  assert.equal((await empty.text()).match(/data-state="unavailable"/g)?.length, 19);
  assert.match(await (await fetch(`${f.url}/profile`, { headers: BROWSER })).text(), /Unavailable means/);
});

test("SHU188_FEED notifications page shows bell count and safe current-data item",async()=>{const {renderNotifications}=await import("../src/web-ui.js");const html=renderNotifications({page:1,unreadCount:1,items:[{id:"opaque-id",text:"Renamed & Co status changed to Active.",href:"/workspace?org_id=org",createdAt:"2026-01-01T00:00:00.000Z",read:false}]});assert.match(html,/aria-label="Notifications \(1 unread\)"/);assert.match(html,/<span class="badge">1<\/span>/);assert.match(html,/Renamed &amp; Co/);assert.match(html,/notifications\/opaque-id\/read/)});
test("SHU188_S1 status event renders current company name and bell changes from one to zero",async()=>{const [{NotificationsService},{renderNotifications,addNotificationBell}]=await Promise.all([import("../../../packages/notifications/src/notifications.js"),import("../src/web-ui.js")]);let readAt:string|null=null;const events={async list(){return[{id:"opaque",recipientPrincipalId:"owner",kind:"organization.status_changed" as const,subjectReference:"organization:org" as const,parameters:{status:"active" as const},createdAt:"2026-01-01T00:00:00Z",readAt}]},async countVisibleUnread(){return readAt?0:1},async markRead(recipient:string,id:string){if(recipient!=="owner"||id!=="opaque")return false;readAt="2026-01-02T00:00:00Z";return true},async markAllRead(){}};const service=new NotificationsService(events,{async readOrganizations(){return[{id:"org",name:"Current company name"}]},async liveOrganizationIds(){return new Set(["org"])}},{async listGrantsForPrincipal(){return[{id:"grant",principalId:"owner",orgId:"org",role:"org-owner" as const,scope:"self" as const}]}});const before=await service.list("owner");const shown=addNotificationBell(renderNotifications(before),await service.count("owner"));assert.match(shown,/Current company name status changed to Active/);assert.match(shown,/Notifications \(1 unread\)/);assert.equal(await service.markRead("owner","opaque"),true);const after=addNotificationBell(renderNotifications(await service.list("owner")),await service.count("owner"));assert.doesNotMatch(after,/Notifications \(1 unread\)/)});

test("unavailable profile dependencies render a safe retry state without killing the gateway", async (t) => {
  const f = await fixture(t);
  f.profiles.readOwn = async () => { throw new Error("database password=do-not-display"); };
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

test("runtime wires the approved-data repository to the authorized principal and exact same-origin return", async (t) => {
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
  const approved = new InMemoryApprovedProfileAdapter({
    links: [{ principalId: "authorized-person", candidateRef: "candidate-authorized" }],
    rows: new Map([["candidate-authorized", SYNTHETIC_PROFILE_FIXTURES.populated]]),
  });
  const runtime = createRuntimeLoginFromEnv(env, approved)!;
  t.after(() => runtime.close());
  assert.equal(runtime.application.web?.origin, ORIGIN);
  assert.equal(runtime.application.web?.returnTo, `${ORIGIN}/profile`);
  const profile = await runtime.application.web?.profiles.readOwn({
    requesterPrincipalId: "authorized-person", targetPersonId: "authorized-person",
  });
  assert.equal(profile?.kind, "found");
  if (profile?.kind === "found") assert.equal(profile.profile.fields.displayName.state === "available" && profile.profile.fields.displayName.value, "Noor Al-Sabah");
  assert.deepEqual(seen, ["authorized-person"]);
  const other = createRuntimeLoginFromEnv({ ...env, LOGIN_ALLOWED_RETURN_URLS: "https://other.test.invalid/profile" })!;
  t.after(() => other.close());
  assert.equal(other.application.web?.returnTo, undefined);
  const unconfigured = await other.application.web?.profiles.readOwn({
    requesterPrincipalId: "authorized-person", targetPersonId: "authorized-person",
  });
  assert.ok(unconfigured?.kind === "found", "runtime unconfigured profile must be found");
  assert.equal(Object.keys(unconfigured.profile.fields).length, 19);
  assert.deepEqual(Object.keys(unconfigured.profile.fields), OWN_PROFILE_FIELD_NAMES);
  for (const [name, field] of Object.entries(unconfigured.profile.fields)) {
    assert.equal(field.state, "unavailable", `runtime unconfigured ${name} must be unavailable`);
    if (field.state === "unavailable") assert.equal(field.reason, "not_imported");
    assert.equal(Object.hasOwn(field, "value"), false);
    assert.deepEqual(field.freshness, { kind: "not_imported", observedAt: "" });
  }
  assert.doesNotMatch(JSON.stringify(unconfigured.profile), /Stored Name|stored@example|Noor/);
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

test("SHU354_PAGE renders a read-only My companies page and workspace link", () => {
  const login={organizationAccountManager:{} as OrganizationAccountManager} as BrowserLoginApplication;
  const active={orgId:"employer",organizationName:"Employer",role:"staff" as const};
  const body=renderAssignedCompanies({status:200,body:{companies:[]}},login,active);
  assert.match(body,/My companies/);assert.match(body,/Read-only/);assert.match(body,/No companies assigned/);assert.match(body,/href="\/workspace\/my-companies\?org_id=employer&amp;role=staff"/);
  const failed=renderAssignedCompanies({status:503,body:{error:"unavailable"}},login,active);
  assert.match(failed,/couldn’t be loaded/);assert.match(failed,/Try again/);
  let headers:Record<string,string>={};const response={writeHead(_status:number,value:Record<string,string>){headers=value},end(){}} as unknown as ServerResponse;
  writeHtml(response,200,body,{},true);assert.equal(headers["cache-control"],"no-store");assert.match(headers["content-security-policy"]!,/default-src 'none'/);
  const navigation=(role:"staff"|"candidate",selected=true)=>renderWorkspace({status:200,body:{contexts:[],active:selected?{orgId:"employer",organizationName:"Employer",role}:null}} as Parameters<typeof renderWorkspace>[0],login);
  assert.match(navigation("staff"),/>My companies<\/a>/);
  assert.doesNotMatch(navigation("candidate"),/>My companies<\/a>/);
  assert.doesNotMatch(navigation("staff",false),/>My companies<\/a>/);
});

test("SHU354_SHOWN shows each assigned name as a company link without principal ids", () => {
  const login={organizationAccountManager:{} as OrganizationAccountManager} as BrowserLoginApplication;
  const companies=organizationAssignedCompaniesView([{org_id:"company-two",name:"Beta"},{org_id:"company-one",name:"Alpha & One"}]);
  const body=renderAssignedCompanies({status:200,body:{companies}},login,{orgId:"employer",organizationName:"Employer",role:"admin"});
  assert.ok(body.indexOf("Alpha &amp; One")<body.indexOf("Beta"));assert.match(body,/href="\/workspace\?org_id=company-one&amp;role=admin"/);assert.doesNotMatch(body,/principal|person-1|workspace\/companies/);
});

test("SHU357_MY_COMPANIES_SIGN_IN distinguishes an expired session from an unavailable read",()=>{const login={organizationAccountManager:{} as OrganizationAccountManager,web:{origin:"https://studenthub.example.invalid",returnTo:"https://studenthub.example.invalid/workspace/my-companies"}} as BrowserLoginApplication,active={orgId:"employer",organizationName:"Employer",role:"staff" as const};const expired=renderAssignedCompanies({status:401,body:{error:"unauthorized"}},login,active);assert.match(expired,/Sign in/);assert.match(expired,/href="\/login\/universe\?return_to=https%3A%2F%2Fstudenthub\.example\.invalid%2Fworkspace%2Fmy-companies"/);assert.doesNotMatch(expired,/Try again/);const unavailable=renderAssignedCompanies({status:503,body:{error:"unavailable"}},login,active);assert.match(unavailable,/Try again/);assert.doesNotMatch(unavailable,/>Sign in</)});


test("U2B_NOTICE_SEAM: verified notices are escaped, cleared and linked field edits replace only browser forms", async (t) => {
  const f = await fixture(t, { nationalityId: "22222222-2222-4222-8222-222222222222" });
  let noticeReads = 0;
  Object.assign(f.login, { browserEdit: {
    async edit() { return { status: 200, title: "Edit", html: "<main>Edit seam</main>" }; },
    async submit() { throw new Error("unexpected write"); },
    async notice(session: string | undefined, cookieHeader: string | undefined) {
      assert.equal(session, SESSION);
      assert.ok(cookieHeader?.includes("studenthub_profile_notice=verified"));
      noticeReads++;
      return { notice: { title: "Saved <title>", message: 'Name <script>unsafe</script>' },
        clearCookie: "studenthub_profile_notice=; Max-Age=0; Path=/profile; HttpOnly; SameSite=Strict" };
    },
  } });
  const response = await fetch(`${f.url}/profile`, { headers: { ...BROWSER, cookie: `${BROWSER.cookie}; studenthub_profile_notice=verified` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  const html = await response.text();
  assert.equal(noticeReads, 1);
  assert.match(html, /id="profile-notice"/);
  assert.match(html, /Saved &lt;title&gt;/);
  assert.match(html, /Name &lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe/);
  for (const field of PERSON_SELF_EDIT_FIELDS) {
    assert.ok(html.includes(`href="/profile/edit/${field}"`), `Edit link for ${field}`);
    assert.ok(html.includes(`id="field-${field}"`), `Anchor for ${field}`);
  }
  assert.match(html, /id="profile-summary"/);
  assert.match(html, /Choose Edit beside a field/);
  assert.doesNotMatch(html, /editing isn’t enabled yet/);
  assert.doesNotMatch(html, /action="\/profile\/edit\/preview"/);
  const edit = await fetch(`${f.url}/profile/edit/displayName`, { headers: BROWSER });
  assert.equal(edit.status, 200);
  assert.match(await edit.text(), /Edit seam/);
});

test("U2B_LIVENESS: browser runtime profile reads never run session housekeeping, legacy preview and logout retain their bindings", async (t) => {
  const queries: string[] = [];
  t.mock.method(pg.Pool.prototype, "query", async (sql: string) => {
    queries.push(sql);
    return { rows: [{ person_id: "authorized-person" }], rowCount: 1 };
  });
  t.mock.method(PostgresAuthzStore.prototype, "getPrincipal", async (id: string) => ({ id, pbuuids: [] }));
  const runtime = createRuntimeLoginFromEnv({
    DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic", OIDC_ISSUER: "https://identity.test.invalid/",
    OIDC_CLIENT_ID: "synthetic", OIDC_CLIENT_SECRET: "synthetic", OIDC_CALLBACK_URL: `${ORIGIN}/login/callback`,
    OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize", OIDC_TOKEN_URL: "https://identity.test.invalid/token",
    OIDC_JWKS_URL: "https://identity.test.invalid/jwks", LOGIN_ALLOWED_RETURN_URLS: `${ORIGIN}/profile`,
    SAFE_WRITE_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
  })!;
  t.after(() => runtime.close());
  assert.ok(runtime.application.browserEdit);
  const profile = await runtime.application.profile({ sessionId: SESSION });
  assert.equal(profile.status, 200);
  assert.equal(profile.body?.personId, "authorized-person");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /^SELECT person_id FROM login_sessions/);
  assert.match(queries[0]!, /expires_at > clock_timestamp\(\)/);
  assert.doesNotMatch(queries.join(" "), /DELETE|UPDATE|INSERT/, "U2B_LIVENESS no housekeeping on browser profile notice path");
  queries.length = 0;
  assert.equal((await runtime.application.profileEdit!.preview(SESSION, {})).status, 400);
  assert.match(queries[0]!, /WITH expired AS/ , "legacy preview retains its session store");
  queries.length = 0;
  await runtime.application.logout(SESSION);
  assert.match(queries[0]!, /^DELETE FROM login_sessions/, "logout still deletes the session");
});


test("U2B_MOTHER_LINK: only a known non-Kuwaiti nationality exposes the mother edit", async (t) => {
  for (const [nationalityId, eligible] of [["11111111-1111-4111-8111-111111111111", false], [null, false], ["22222222-2222-4222-8222-222222222222", true]] as const) {
    const f = await fixture(t, { nationalityId });
    Object.assign(f.login, { browserEdit: { async notice() { return {}; } } });
    const response = await fetch(`${f.url}/profile`, { headers: BROWSER });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html.includes('href="/profile/edit/kuwaitiMother"'), eligible, "U2B_MOTHER_LINK eligibility");
    assert.ok(html.includes('href="/profile/edit/nationality"'));
  }
});

test("U2B_MOTHER_LINK: unconditional edit-link mutant dies at named assertion", async (t) => {
  const f = await fixture(t, { nationalityId: null });
  Object.assign(f.login, { browserEdit: { async notice() { return {}; } } });
  const projection = await f.profiles.readOwn({ requesterPrincipalId: "person-1", targetPersonId: "person-1" });
  assert.equal(projection.kind, "found");
  if (projection.kind !== "found") throw new Error("fixture unavailable");
  const probe = async (render: typeof profileDocument) => {
    const page = await render({ status: 200, body: projection.profile }, f.login);
    assert.equal(page.html.includes('href="/profile/edit/kuwaitiMother"'), false, "U2B_MOTHER_LINK mutant");
  };
  await probe(profileDocument);
  const sourceUrl = new URL("../src/web-ui.js", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const from = 'originChoices.countries.some(item => item.id === nationalityId && item.code !== "KW")';
  assert.equal(source.split(from).length, 2, "one mother-link mutation point");
  const mutantUrl = new URL(`./web-ui-mother-mutant-${randomUUID()}.mjs`, sourceUrl);
  try {
    writeFileSync(mutantUrl, source.replace(from, 'true'));
    const mutant = await import(mutantUrl.href) as { profileDocument: typeof profileDocument };
    await assert.rejects(probe(mutant.profileDocument), { name: "AssertionError", message: /U2B_MOTHER_LINK mutant/ });
  } finally { unlinkSync(mutantUrl); }
});


test("UPL_NAV_COPY SHU366_PAGE_NAV: profile and workspace document links require configured service", async (t) => {
  // Only configuration presence is under test here; the real document lifecycle
  // and its one-list page rendering are covered by documents-page.test.ts.
  const configured = await fixture(t, { documents: {} as CandidateDocuments });
  for (const language of ["en", "ar"] as const) {
    configured.rows.set("candidate-1", { ...SYNTHETIC_PROFILE_FIXTURES.populated, candidate_language_pref: language });
    const response = await fetch(`${configured.url}/profile`, { headers: BROWSER });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`href="/profile/documents">${language === "ar" ? "مستنداتي" : "My documents"}</a>`));
    assert.match(html, new RegExp(`lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}"`));
  }
  const unconfigured = await fixture(t);
  const response = await fetch(`${unconfigured.url}/profile`, { headers: BROWSER });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /href="\/profile\/documents"/);
  const navigation = { status: 200, body: { contexts: [], active: null } } as Parameters<typeof renderWorkspace>[0];
  assert.match(renderWorkspace(navigation, configured.login, true), /href="\/profile\/documents">My documents<\/a>/);
  assert.doesNotMatch(renderWorkspace(navigation, configured.login, false), /href="\/profile\/documents"/);
  assert.doesNotMatch(renderWorkspace(navigation, configured.login), /href="\/profile\/documents"/);
});
