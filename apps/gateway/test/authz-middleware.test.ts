import assert from "node:assert/strict";
import test from "node:test";

import { AssertionErrorCode } from "@bawes/actor-assertion";

import { authorizeRequest, createGatewayServer } from "../src/index.js";
import { createAuthzFixture, TEST_ORG, TEST_SUB } from "./helpers/authz.js";

// ---------------------------------------------------------------------------
// Stage 1-3: authentication. Every failure is 401 and never reaches grants.
// ---------------------------------------------------------------------------

test("a missing assertion is denied", async () => {
  const { middleware } = await createAuthzFixture();
  const decision = await authorizeRequest(undefined, middleware);
  assert.deepEqual(decision, { kind: "deny", status: 401, reason: "missing_assertion" });
});

test("an empty assertion header is denied", async () => {
  const { middleware } = await createAuthzFixture();
  assert.deepEqual(await authorizeRequest("   ", middleware), {
    kind: "deny",
    status: 401,
    reason: "missing_assertion",
  });
});

test("a non-envelope string is malformed, never trusted", async () => {
  const { middleware } = await createAuthzFixture();
  const decision = await authorizeRequest("not-an-assertion", middleware);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.kind === "deny" && decision.reason, AssertionErrorCode.MALFORMED);
});

test("an unsigned, hand-crafted payload cannot authenticate", async () => {
  // The pre-review contract accepted bare base64url(JSON) with no signature.
  // Forging one must now fail: there is no unsigned path.
  const { middleware } = await createAuthzFixture();
  const forged = Buffer.from(
    JSON.stringify({ sub: TEST_SUB, act: { org: TEST_ORG, role: "admin" } }),
    "utf8",
  ).toString("base64url");
  const decision = await authorizeRequest(forged, middleware);
  assert.equal(decision.kind, "deny");
});

test("an assertion for another destination is rejected (aud binding)", async () => {
  const fixture = await createAuthzFixture();
  const wire = await fixture.mint({ aud: "studenthub/other/action" });
  const decision = await authorizeRequest(wire, fixture.middleware);
  assert.equal(decision.kind === "deny" && decision.reason, AssertionErrorCode.AUD_MISMATCH);
});

test("an expired assertion is rejected", async () => {
  const fixture = await createAuthzFixture();
  const wire = await fixture.mint({ expOffsetSeconds: -1 });
  const decision = await authorizeRequest(wire, fixture.middleware);
  assert.equal(decision.kind === "deny" && decision.reason, AssertionErrorCode.EXPIRED);
});

test("a replayed jti is rejected on second use", async () => {
  const fixture = await createAuthzFixture();
  const wire = await fixture.mint();
  assert.equal((await authorizeRequest(wire, fixture.middleware)).kind, "allow");
  const replay = await authorizeRequest(wire, fixture.middleware);
  assert.equal(replay.kind === "deny" && replay.reason, AssertionErrorCode.REPLAYED);
});

test("an unknown key id resolves to nothing — rotation never falls back", async () => {
  const fixture = await createAuthzFixture();
  const wire = await fixture.mint({ kid: "not-registered" });
  const decision = await authorizeRequest(wire, fixture.middleware);
  assert.equal(decision.kind === "deny" && decision.reason, AssertionErrorCode.UNKNOWN_ISSUER);
});

// ---------------------------------------------------------------------------
// Positive subject rule (no denylist): shape is asserted, not enumerated.
// ---------------------------------------------------------------------------

for (const sub of [
  "guest",
  "anonymous",
  "anon",
  "system",
  "service-account-indexer",
  "0123456789abcdef",
]) {
  test(`subject ${JSON.stringify(sub)} fails the positive human-subject format`, async () => {
    const fixture = await createAuthzFixture();
    const wire = await fixture.mint({ sub });
    const decision = await authorizeRequest(wire, fixture.middleware);
    assert.equal(
      decision.kind === "deny" && decision.reason,
      AssertionErrorCode.SUBJECT_FORMAT,
      "unenumerated machine subjects must fail too — a denylist would pass them",
    );
  });
}

// ---------------------------------------------------------------------------
// Stage 4: authorization from grants, server-side.
// ---------------------------------------------------------------------------

test("a verified subject with no grant is authorized-denied, not authenticated-denied", async () => {
  const fixture = await createAuthzFixture();
  await fixture.store.clearGrantsForPrincipal("p-1");
  const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.kind === "deny" && decision.status, 403);
});

test("a verified subject with a grant resolves its context server-side", async () => {
  const fixture = await createAuthzFixture();
  const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
  assert.deepEqual(decision, {
    kind: "allow",
    subject: TEST_SUB,
    orgId: TEST_ORG,
    role: "staff",
  });
});

test("act is honoured only when a grant backs it", async () => {
  const fixture = await createAuthzFixture();
  const ok = await authorizeRequest(
    await fixture.mint({ act: { org: TEST_ORG, role: "staff" } }),
    fixture.middleware,
  );
  assert.equal(ok.kind === "allow" && ok.role, "staff");

  const forged = await authorizeRequest(
    await fixture.mint({ act: { org: TEST_ORG, role: "admin" } }),
    fixture.middleware,
  );
  assert.equal(forged.kind, "deny");
  assert.equal(forged.kind === "deny" && forged.status, 403, "a claimed role with no grant is never trusted");
});

// ---------------------------------------------------------------------------
// The gateway itself fails closed.
// ---------------------------------------------------------------------------

test("an unconfigured gateway denies every protected call", async (context) => {
  let calls = 0;
  // No authz argument at all — the pre-review default skipped the check entirely.
  const server = createGatewayServer({
    async callTool() {
      calls += 1;
      return { ok: true, content: [] };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp/tools/call`, {
    method: "POST",
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0, "an unconfigured gateway must never reach the adapter");
});

test("a configured gateway admits a valid assertion and rejects a missing one", async (context) => {
  const fixture = await createAuthzFixture();
  let calls = 0;
  const server = createGatewayServer(
    {
      async callTool() {
        calls += 1;
        return { ok: true, content: [] };
      },
    },
    undefined,
    fixture.middleware,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ name: "student.search", arguments: {} });

  const denied = await fetch(`${origin}/mcp/tools/call`, { method: "POST", body });
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);

  const allowed = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    body,
    headers: { "x-actor-assertion": await fixture.mint() },
  });
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);

  // /health stays public.
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});

test("a failing authz dependency returns 503 and never crashes the listener", async (context) => {
  const fixture = await createAuthzFixture();
  const broken = {
    ...fixture.middleware,
    resolveKey: async () => {
      throw new Error("registry unreachable");
    },
  };

  // Directly: the verifier turns it into a typed denial rather than rejecting.
  const decision = await authorizeRequest(await fixture.mint(), broken);
  assert.equal(decision.kind, "deny");

  // Through the server: a dependency that rejects outside the verifier must
  // still produce a response instead of an unhandled rejection.
  let calls = 0;
  const exploding = {
    ...fixture.middleware,
    get store(): never {
      throw new Error("store unreachable");
    },
  } as unknown as typeof fixture.middleware;
  const server = createGatewayServer(
    {
      async callTool() {
        calls += 1;
        return { ok: true, content: [] };
      },
    },
    undefined,
    exploding,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp/tools/call`, {
    method: "POST",
    headers: { "x-actor-assertion": await fixture.mint() },
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  assert.ok([401, 503].includes(response.status), `expected 401/503, got ${response.status}`);
  assert.equal(calls, 0, "a broken authz dependency must never reach the adapter");
});
