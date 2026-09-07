import assert from "node:assert/strict";
import test from "node:test";

import type { LoginApplication } from "@studenthub/login-contract";

import { createGatewayServer } from "../src/index.js";

const SESSION = "s".repeat(43);

test("gateway routes bind the browser cookie and expose no callback secrets", async (context) => {
  let browserSessionId = "";
  const login: LoginApplication = {
    async start(request) {
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
          "set-cookie": `studenthub_session=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      };
    },
    async profile(request) {
      assert.equal(request.sessionId, SESSION);
      return { status: 200, body: { personId: "person-synthetic", role: "self" } };
    },
    async logout(sessionId) {
      assert.equal(sessionId, SESSION);
      return { status: 204, headers: { "set-cookie": "studenthub_session=; Max-Age=0" } };
    },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const start = await fetch(
    `${origin}/login/universe?return_to=${encodeURIComponent("https://studenthub.test.invalid/home")}`,
    { redirect: "manual" },
  );
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("location"), "https://identity.test.invalid/authorize");
  const browserCookie = start.headers.get("set-cookie") ?? "";
  assert.match(browserCookie, /^studenthub_browser=[A-Za-z0-9_-]{43};/);
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
    headers: { cookie: `studenthub_session=${SESSION}` },
  });
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), { personId: "person-synthetic", role: "self" });

  const falsePrefix = await fetch(`${origin}/profile-foreign`, {
    headers: { cookie: `studenthub_session=${SESSION}` },
  });
  assert.equal(falsePrefix.status, 404);

  const logout = await fetch(`${origin}/logout`, {
    method: "POST",
    headers: { cookie: `studenthub_session=${SESSION}` },
  });
  assert.equal(logout.status, 204);
});
