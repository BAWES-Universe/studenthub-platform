import assert from "node:assert/strict";
import test from "node:test";

import type { LoginApplication } from "@studenthub/login-contract";

import { createGatewayServer } from "../src/index.js";

const SESSION = "s".repeat(43);

test("gateway routes bind the browser cookie and expose no callback secrets", async (context) => {
  let browserSessionId = "";
  let startCalls = 0;
  const login: LoginApplication = {
    async start(request) {
      startCalls += 1;
      browserSessionId = request.browserSessionId;
      assert.equal(request.returnTo, "https://studenthub.test.invalid/home");
      return { status: 302, headers: { location: "https://identity.test.invalid/authorize" } };
    },
    async callback(request) {
      assert.deepEqual(request, { browserSessionId, state: "state", code: "code" });
      return {
        status: 302,
        headers: {
          location: "https://studenthub.test.invalid/home",
          "set-cookie": `__Host-studenthub_session=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      };
    },
    async profile(request) {
      assert.equal(request.sessionId, SESSION);
      return { status: 200, body: { personId: "person-synthetic", role: "self" } };
    },
    async logout(sessionId) {
      assert.equal(sessionId, SESSION);
      return { status: 204, headers: { "set-cookie": "__Host-studenthub_session=; Max-Age=0" } };
    },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const missingReturnTo = await fetch(`${origin}/login/universe`, { redirect: "manual" });
  assert.equal(missingReturnTo.status, 400);
  assert.deepEqual(await missingReturnTo.json(), { error: "login_rejected" });
  assert.equal(startCalls, 0);

  const start = await fetch(
    `${origin}/login/universe?return_to=${encodeURIComponent("https://studenthub.test.invalid/home")}`,
    { redirect: "manual" },
  );
  assert.equal(start.status, 302);
  assert.equal(startCalls, 1);
  assert.equal(start.headers.get("location"), "https://identity.test.invalid/authorize");
  const browserCookie = start.headers.get("set-cookie") ?? "";
  assert.match(browserCookie, /^__Host-studenthub_browser=[A-Za-z0-9_-]{43};/);
  assert.match(browserCookie, /HttpOnly/);
  assert.match(browserCookie, /Secure/);
  assert.match(browserCookie, /SameSite=Lax/);
  const cookieHeader = browserCookie.split(";", 1)[0]!;

  const callback = await fetch(`${origin}/login/callback?state=state&code=code`, {
    headers: { cookie: cookieHeader },
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(await callback.text(), "");
  assert.doesNotMatch(JSON.stringify([...callback.headers]), /state|code|token|secret/i);

  const profile = await fetch(`${origin}/profile`, {
    headers: { cookie: `__Host-studenthub_session=${SESSION}` },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.headers.get("cache-control"), "no-store");
  assert.deepEqual(await profile.json(), { personId: "person-synthetic", role: "self" });

  const falsePrefix = await fetch(`${origin}/profile-foreign`, {
    headers: { cookie: `__Host-studenthub_session=${SESSION}` },
  });
  assert.equal(falsePrefix.status, 404);

  const logout = await fetch(`${origin}/logout?source=profile`, {
    method: "POST",
    headers: { cookie: `__Host-studenthub_session=${SESSION}` },
  });
  assert.equal(logout.status, 204);
});

test("gateway contains rejecting login dependencies and remains available", async (context) => {
  const unavailable = async () => { throw new Error("synthetic dependency failure"); };
  const login: LoginApplication = {
    start: unavailable,
    callback: unavailable,
    profile: unavailable,
    logout: unavailable,
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const cases = [
    fetch(`${origin}/login/universe?return_to=${encodeURIComponent("https://studenthub.test.invalid/home")}`),
    fetch(`${origin}/login/callback?state=state&code=code`, {
      headers: { cookie: `__Host-studenthub_browser=${"b".repeat(43)}` },
    }),
    fetch(`${origin}/profile`, {
      headers: { cookie: `__Host-studenthub_session=${SESSION}` },
    }),
    fetch(`${origin}/logout`, {
      method: "POST",
      headers: { cookie: `__Host-studenthub_session=${SESSION}` },
    }),
  ];
  for (const response of await Promise.all(cases)) {
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "login_unavailable" });
  }
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});
