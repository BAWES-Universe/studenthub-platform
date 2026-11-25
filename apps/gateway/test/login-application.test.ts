import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticLoginRig, FakeUpstreamSessions, runLoginConformance, runUpstreamSessionConformance, UPSTREAM_SESSION_SCENARIOS } from "@studenthub/login-contract";
import type { AuthorizationStore, UpstreamSessionEvent } from "@studenthub/login-contract";

import { createLoginApplication, upstreamCheckSeconds } from "../src/login-application.js";
import { checkedLiveSessionPerson } from "../src/wiring/profile.js";
import {
  createRuntimeLoginFromEnv,
  DiscoveryUpstreamSessions,
  HttpOidcTransport,
  RefreshingJwksResolver,
  upstreamSessionsFromEnv,
} from "../src/login-runtime.js";

test("the real gateway login implementation satisfies the executable OIDC contract", async () => {
  const report = await runLoginConformance(createLoginApplication);
  assert.equal(
    report.ok,
    true,
    report.results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`).join("\n"),
  );
  assert.equal(report.results.length, 7);
});

test("runtime login stays disabled when unconfigured and rejects partial configuration", () => {
  assert.equal(createRuntimeLoginFromEnv({}), undefined);
  assert.throws(
    () => createRuntimeLoginFromEnv({ OIDC_ISSUER: "https://identity.test.invalid/" }),
    /incomplete login configuration/,
  );
});

test("the real profile path reports persistent dependency failure as unavailable", async () => {
  const sessionFailure = createSyntheticLoginRig(createLoginApplication);
  sessionFailure.sessions.get = async () => { throw new Error("synthetic session-store failure"); };
  assert.deepEqual(await sessionFailure.app.profile({ sessionId: "synthetic-session" }), {
    status: 503,
    body: { error: "login_unavailable" },
  });

  const authorizationFailure = createSyntheticLoginRig(createLoginApplication);
  await authorizationFailure.sessions.put({ id: "synthetic-session", personId: "person-1" });
  authorizationFailure.authorization.roleFor = async () => {
    throw new Error("synthetic authorization-store failure");
  };
  assert.deepEqual(await authorizationFailure.app.profile({ sessionId: "synthetic-session" }), {
    status: 503,
    body: { error: "login_unavailable" },
  });
});

test("Q14_4_EMAIL profile carries a non-empty principal email without a second authorization read", async () => {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: "synthetic-session", personId: "person-1" });
  let reads = 0;
  const authorization = rig.authorization as AuthorizationStore;
  authorization.principalFor = async () => { reads++; return { role: "self", email: "person@universe.invalid" }; };
  assert.deepEqual(await rig.app.profile({ sessionId: "synthetic-session" }), { status: 200, body: { personId:"person-1", role:"self", email:"person@universe.invalid" } });
  assert.equal(reads, 1);
  authorization.principalFor = async () => ({ role:"self", email:"   " });
  assert.deepEqual(await rig.app.profile({ sessionId:"synthetic-session" }), { status:200, body:{personId:"person-1",role:"self"} });
  delete authorization.principalFor;
  assert.deepEqual(await rig.app.profile({ sessionId:"synthetic-session" }), { status:200, body:{personId:"person-1",role:"candidate"} });
});

test("runtime configuration rejects non-HTTPS identity endpoints before opening PostgreSQL", () => {
  assert.throws(
    () => createRuntimeLoginFromEnv({
      DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
      OIDC_ISSUER: "http://identity.test.invalid/",
      OIDC_CLIENT_ID: "synthetic-client",
      OIDC_CLIENT_SECRET: "synthetic-secret",
      OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
      OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize",
      OIDC_TOKEN_URL: "https://identity.test.invalid/token",
      OIDC_JWKS_URL: "https://identity.test.invalid/jwks",
      LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.test.invalid/home",
    }),
    /OIDC_ISSUER must use https/,
  );
});

test("runtime configuration rejects an empty return URL allowlist descriptively", () => {
  assert.throws(
    () => createRuntimeLoginFromEnv({
      DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
      OIDC_ISSUER: "https://identity.test.invalid/",
      OIDC_CLIENT_ID: "synthetic-client",
      OIDC_CLIENT_SECRET: "synthetic-secret",
      OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
      OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize",
      OIDC_TOKEN_URL: "https://identity.test.invalid/token",
      OIDC_JWKS_URL: "https://identity.test.invalid/jwks",
      LOGIN_ALLOWED_RETURN_URLS: "   ",
    }),
    /LOGIN_ALLOWED_RETURN_URLS must not be empty/,
  );
});

test("OIDC token and JWKS requests carry bounded abort signals", async () => {
  let calls = 0;
  const successfulFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.ok(init?.signal);
    assert.equal(init.signal.aborted, false);
    if (calls === 1) {
      return new Response(JSON.stringify({ access_token: "access", id_token: "header.claims.signature" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ keys: [{ kid: "synthetic-key", kty: "OKP" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new HttpOidcTransport(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/authorize",
    "https://identity.test.invalid/token",
    1_000,
    successfulFetch,
  );
  assert.deepEqual(await transport.exchange({
    code: "synthetic-code",
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    redirectUri: "https://studenthub.test.invalid/login/callback",
    codeVerifier: "synthetic-verifier",
  }), { accessToken: "access", idToken: "header.claims.signature" });

  const resolver = new RefreshingJwksResolver(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/jwks",
    300,
    1_000,
    successfulFetch,
  );
  assert.deepEqual(await resolver.resolve("https://identity.test.invalid/", "synthetic-key"), {
    kid: "synthetic-key",
    kty: "OKP",
  });
});

test("stalled OIDC token and JWKS requests terminate at the configured bound", async () => {
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal);
      const failureTimer = setTimeout(() => reject(new Error("OIDC request did not abort")), 1_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(failureTimer);
        reject(init.signal?.reason);
      }, { once: true });
    })) as typeof fetch;

  const transport = new HttpOidcTransport(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/authorize",
    "https://identity.test.invalid/token",
    10,
    stalledFetch,
  );
  await assert.rejects(
    transport.exchange({
      code: "synthetic-code",
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      redirectUri: "https://studenthub.test.invalid/login/callback",
      codeVerifier: "synthetic-verifier",
    }),
    { name: "TimeoutError" },
  );

  const resolver = new RefreshingJwksResolver(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/jwks",
    300,
    10,
    stalledFetch,
  );
  await assert.rejects(
    resolver.resolve("https://identity.test.invalid/", "synthetic-key"),
    { name: "TimeoutError" },
  );
});

// SHU-457: signing out ends the session everywhere.

test("SHU457_PORT the gateway login passes the upstream session scenarios, and without the port behaves as before", async () => {
  const report = await runUpstreamSessionConformance(createLoginApplication);
  assert.equal(report.ok, true, report.results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`).join("\n"));
  assert.equal(report.results.length, UPSTREAM_SESSION_SCENARIOS.length);
  // Without the port: no reference is recorded even when the token has a sid, and no upstream is asked.
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
  const authorization = rig.provider.authorizationRequests.at(-1)!;
  const callback = await rig.app.callback({ browserSessionId: "browser-a", state: authorization.state, code: rig.provider.authorize({ sid: "sid-1" } as never) });
  assert.equal(callback.status, 302);
  assert.deepEqual([...rig.sessions.records.values()].map((record) => Object.keys(record).sort()), [["id", "personId"]]);
});

const SID = "synthetic-upstream-session-1";
async function signedIn(rig: ReturnType<typeof createSyntheticLoginRig>, sid: string | null = SID) {
  await rig.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
  const authorization = rig.provider.authorizationRequests.at(-1)!;
  const response = await rig.app.callback({ browserSessionId: "browser-a", state: authorization.state, code: rig.provider.authorize(sid ? { sid } as never : {}) });
  assert.equal(response.status, 302);
  return /^__Host-studenthub_session=([^;]+)/.exec(response.headers!["set-cookie"]!)![1]!;
}

test("SHU457_RECORD only a plain bounded sid is recorded, and a token without one is checked by its own expiry", async () => {
  for (const [sid, expected] of [[SID, SID], ["has space", undefined], ["x".repeat(256), undefined], [null, undefined]] as const) {
    const upstream = new FakeUpstreamSessions();
    const rig = createSyntheticLoginRig(createLoginApplication, { upstream, upstreamCheckSeconds: 900 });
    const id = await signedIn(rig, sid);
    assert.equal(rig.sessions.records.get(id)?.upstreamReference, expected);
    rig.clock.epoch += 10_000;
    assert.equal((await rig.app.profile({ sessionId: id })).status, expected ? 401 : 200);
  }
});

test("SHU457_SIGN_OUT local sign-out is first and complete, and the upstream failure is logged as a count and a class", async () => {
  const upstream = new FakeUpstreamSessions();
  upstream.endAnswer = "hang";
  const events: UpstreamSessionEvent[] = [];
  const rig = createSyntheticLoginRig(createLoginApplication, { upstream, upstreamCheckSeconds: 900, upstreamTimeoutMs: 20 });
  const id = await signedIn(rig);
  const started = Date.now();
  const response = await rig.app.logout(id);
  assert.ok(Date.now() - started < 15, "the response does not wait for the upstream");
  assert.equal(response.status, 204);
  assert.match(response.headers!["set-cookie"]!, /^__Host-studenthub_session=; .*Max-Age=0$/);
  assert.equal(rig.sessions.records.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  events.push(...rig.upstreamEvents);
  assert.deepEqual(events, [{ event: "upstream_end_unreachable", reason: "timeout", count: 1 }]);
  // A second unknown session id signs out the same way and asks nothing upstream.
  assert.equal((await rig.app.logout("never-issued")).status, 204);
  assert.deepEqual(upstream.ended, [SID]);
});

test("SHU457_BOUND T is one setting from 60 to 3600 seconds, default 900, and the bound holds at its edges", async () => {
  assert.equal(upstreamCheckSeconds(undefined), 900);
  for (const ok of [60, 3600]) assert.equal(upstreamCheckSeconds(ok), ok);
  for (const bad of [59, 3601, 900.5, Number.NaN]) assert.throws(() => upstreamCheckSeconds(bad), RangeError);
  assert.throws(() => createSyntheticLoginRig(createLoginApplication, { upstream: new FakeUpstreamSessions(), upstreamCheckSeconds: 30 }), RangeError);
  const upstream = new FakeUpstreamSessions();
  const rig = createSyntheticLoginRig(createLoginApplication, { upstream, upstreamCheckSeconds: 60 });
  const id = await signedIn(rig);
  const start = rig.clock.epoch;
  rig.clock.epoch = start + 59;
  await rig.app.profile({ sessionId: id });
  assert.equal(upstream.checked.length, 0);
  upstream.activity = "ended";
  rig.clock.epoch = start + 60;
  assert.equal((await rig.app.profile({ sessionId: id })).status, 401, "ended elsewhere stops working within T");
  assert.deepEqual(upstream.checked, [SID]);
  assert.equal(rig.upstreamEvents.length, 0);
});

test("SHU457_BOUND runtime: the port is off unless turned on, and T is validated", () => {
  assert.equal(upstreamSessionsFromEnv({}, "https://identity.test.invalid/", "client"), undefined);
  assert.equal(upstreamSessionsFromEnv({ LOGIN_UPSTREAM_SESSIONS: "off" }, "https://identity.test.invalid/", "client"), undefined);
  assert.equal(upstreamSessionsFromEnv({ LOGIN_UPSTREAM_SESSIONS: "on" }, "https://identity.test.invalid/", "client")?.checkSeconds, 900);
  assert.equal(upstreamSessionsFromEnv({ LOGIN_UPSTREAM_SESSIONS: "on", LOGIN_UPSTREAM_CHECK_SECONDS: "60" }, "https://identity.test.invalid/", "client")?.checkSeconds, 60);
  for (const bad of ["59", "3601", "15m", "", " 900"]) {
    assert.throws(() => upstreamSessionsFromEnv({ LOGIN_UPSTREAM_SESSIONS: "on", LOGIN_UPSTREAM_CHECK_SECONDS: bad }, "https://identity.test.invalid/", "client"));
  }
  assert.throws(() => upstreamSessionsFromEnv({ LOGIN_UPSTREAM_SESSIONS: "yes" }, "https://identity.test.invalid/", "client"));
  assert.throws(() => upstreamSessionsFromEnv({ LOGIN_UPSTREAM_CHECK_SECONDS: "900" }, "https://identity.test.invalid/", "client"));
});

test("SHU457_ADAPTER the discovery adapter ends the session at the end-session endpoint with the client id and the reference, in a form body", async () => {
  const ISSUER = "https://identity.test.invalid/application/o/studenthub/";
  const calls: { url: string; method: string; body: string; redirect?: RequestRedirect }[] = [];
  let discovery: Record<string, unknown> = { issuer: ISSUER, end_session_endpoint: "https://identity.test.invalid/application/o/studenthub/end-session/" };
  let endStatus = 302;
  const fakeIssuer = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : "", ...(init?.redirect ? { redirect: init.redirect } : {}) });
    assert.ok(init?.signal, "every issuer call is bounded");
    if (url.endsWith("/.well-known/openid-configuration")) return new Response(JSON.stringify(discovery), { status: 200 });
    if (url === discovery.end_session_endpoint) return new Response(null, { status: endStatus });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const adapter = new DiscoveryUpstreamSessions(ISSUER, "studenthub-client", 3_000, fakeIssuer);
  assert.equal(await adapter.end(SID), "ended");
  assert.equal(calls[0]!.url, "https://identity.test.invalid/application/o/studenthub/.well-known/openid-configuration");
  const end = calls[1]!;
  assert.equal(end.method, "POST");
  assert.equal(end.url, discovery.end_session_endpoint, "nothing is added to the URL");
  assert.equal(end.body, new URLSearchParams({ client_id: "studenthub-client", sid: SID }).toString());
  assert.equal(end.redirect, "manual");
  assert.equal(await adapter.end(SID), "ended");
  assert.equal(calls.filter((call) => call.url.endsWith("openid-configuration")).length, 1, "discovery is read once");
  endStatus = 500;
  assert.equal(await adapter.end(SID), "unreachable");
  assert.equal(await adapter.isActive(SID), "unknown", "the issuer offers no tokenless liveness query, so the bound decides");

  for (const document of [{ issuer: ISSUER }, { issuer: ISSUER, end_session_endpoint: "http://identity.test.invalid/end" }, { issuer: "https://other.invalid/", end_session_endpoint: "https://identity.test.invalid/end" }]) {
    discovery = document;
    calls.length = 0;
    const other = new DiscoveryUpstreamSessions(ISSUER, "studenthub-client", 3_000, fakeIssuer);
    assert.equal(await other.end(SID), "unreachable");
    assert.equal(calls.filter((call) => call.method === "POST").length, 0, "no end call without a trusted https endpoint");
  }
  const down = new DiscoveryUpstreamSessions(ISSUER, "studenthub-client", 3_000, (async () => { throw new Error("offline"); }) as typeof fetch);
  assert.equal(await down.end(SID), "unreachable");
});

test("SHU457_BOUND with the upstream check on, the browser-edit and legacy-link session read goes through the checked store first", async () => {
  const live = new Map([["live", "person-1"], ["ended", "person-1"], ["other", "person-2"]]);
  const reads: string[] = [];
  let current = "";
  // The pool is keyed by a hash of the token; the fake answers for the session just read.
  const pool = { query: async () => { reads.push("pool"); const person_id = live.get(current); return { rows: person_id ? [{ person_id }] : [] }; } };
  // The checked store refuses "ended" (an upstream answer), and maps "other" to a different person.
  const sessions = { [Symbol.for("studenthub.login.upstream-confirming")]: true, get: async (id: string) => { reads.push("checked"); current = id; return id === "ended" ? undefined : { id, personId: id === "other" ? "person-1" : live.get(id)! }; } };
  assert.equal(await checkedLiveSessionPerson(sessions, pool as never, "live"), "person-1");
  assert.deepEqual(reads, ["checked", "pool"], "the checked read comes first");
  reads.length = 0;
  assert.equal(await checkedLiveSessionPerson(sessions, pool as never, "ended"), undefined, "a session the check ended is refused");
  assert.deepEqual(reads, ["checked"], "and the browser pool is not asked");
  assert.equal(await checkedLiveSessionPerson(sessions, pool as never, "other"), undefined, "the two reads must agree on the person");
  // With the upstream check off, the browser pool is read alone, as before (no housekeeping).
  reads.length = 0;
  current = "live";
  const plain = { get: async () => { reads.push("checked"); return undefined; } };
  assert.equal(await checkedLiveSessionPerson(plain, pool as never, "live"), "person-1");
  assert.deepEqual(reads, ["pool"]);
});

test("EMAIL_VERIFIED_RECORD sign-in records the issuer's email_verified answer for the signed address; only a boolean true counts", async () => {
  const cases: [Record<string, unknown>, [string, boolean] | undefined][] = [
    [{ profile: { email: "Person@Universe.invalid" }, emailVerified: true }, ["Person@Universe.invalid", true]],
    [{ profile: { email: "person@universe.invalid" }, emailVerified: false }, ["person@universe.invalid", false]],
    [{ profile: { email: "person@universe.invalid" }, emailVerified: "true" }, ["person@universe.invalid", false]],
    [{ profile: { email: "person@universe.invalid" } }, ["person@universe.invalid", false]],
    [{ profile: { email: "   " }, emailVerified: true }, undefined],
    [{ profile: { email: "" }, emailVerified: true }, undefined],
  ];
  for (const [overrides, expected] of cases) {
    const rig = createSyntheticLoginRig(createLoginApplication);
    const recorded: [string, string, boolean][] = [];
    (rig.identities as unknown as { recordEmailVerification: unknown }).recordEmailVerification =
      async (personId: string, email: string, verified: boolean) => { recorded.push([personId, email, verified]); };
    await rig.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
    const authorization = rig.provider.authorizationRequests.at(-1)!;
    const response = await rig.app.callback({ browserSessionId: "browser-a", state: authorization.state, code: rig.provider.authorize(overrides as never) });
    assert.equal(response.status, 302, JSON.stringify(overrides));
    const personId = [...rig.sessions.records.values()][0]!.personId;
    assert.deepEqual(recorded, expected ? [[personId, ...expected]] : [], JSON.stringify(overrides));
  }
  // A store without the method records nothing and sign-in works as before.
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
  const authorization = rig.provider.authorizationRequests.at(-1)!;
  assert.equal((await rig.app.callback({ browserSessionId: "browser-a", state: authorization.state, code: rig.provider.authorize({ emailVerified: true } as never) })).status, 302);
});

test("EMAIL_VERIFIED_BEST_EFFORT a failed verification write vetoes the current address and the sign-in still succeeds; if the veto fails too, no session is created", async () => {
  const warn = console.warn;
  for (const vetoFails of [false, true]) {
    const rig = createSyntheticLoginRig(createLoginApplication);
    const vetoed: string[] = [];
    Object.assign(rig.identities as object, {
      recordEmailVerification: async () => { throw Object.assign(new Error("connection lost"), { code: "08006" }); },
      vetoEmailVerification: async (personId: string) => {
        if (vetoFails) throw new Error("still down");
        vetoed.push(personId);
      },
    });
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args.join(" ")); };
    try {
      await rig.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
      const authorization = rig.provider.authorizationRequests.at(-1)!;
      const response = await rig.app.callback({ browserSessionId: "browser-a", state: authorization.state, code: rig.provider.authorize({ profile: { email: "person@universe.invalid" }, emailVerified: false } as never) });
      assert.equal(response.status, vetoFails ? 400 : 302, `vetoFails=${vetoFails}`);
      assert.equal(rig.sessions.records.size, vetoFails ? 0 : 1, "a session exists only when no stale answer can remain");
    } finally {
      console.warn = warn;
    }
    if (!vetoFails) assert.deepEqual(vetoed, [[...rig.sessions.records.values()][0]!.personId], "a failed write vetoes the current address (fail closed)");
    else assert.deepEqual(vetoed, []);
    assert.deepEqual(warned, [JSON.stringify({ event: "email_verification_not_recorded" }),
      ...(vetoFails ? [JSON.stringify({ event: "email_verification_not_vetoed" })] : [])], "log lines carry no address or person");
  }
});
