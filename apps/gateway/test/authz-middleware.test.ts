import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_ASSERTION_FORMAT_VERSION,
  InMemoryAuthzStore,
  InMemoryIssuerKeyRegistry,
  encodeActorAssertion,
  type ActorAssertion,
  type ActorAssertionAct,
  type AssertionSubject,
  type AuthzStore,
  type IssuerKeyRegistry,
} from "@studenthub/contracts";

import {
  authorizeRequest,
  createAuthzMiddleware,
  createGatewayServer,
  type AuthzMiddleware,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACME = "acme";

function makeStore(): AuthzStore {
  const store = new InMemoryAuthzStore({
    organizations: [{ id: ACME, name: "Acme Inc" }],
    principals: [{ id: "alice", pbuuids: ["pbuuid-alice-1"] }],
  });
  return store;
}

async function makeRegistry(): Promise<IssuerKeyRegistry> {
  const registry = new InMemoryIssuerKeyRegistry();
  await registry.registerKey({ issuer: "authentik", keyId: "k1", algorithm: "EdDSA" });
  return registry;
}

function assertionFor(
  subject: AssertionSubject,
  act?: ActorAssertionAct,
): ActorAssertion {
  return {
    formatVersion: ACTOR_ASSERTION_FORMAT_VERSION,
    issuer: "authentik",
    keyId: "k1",
    subject,
    issuedAt: "2026-09-03T00:00:00.000Z",
    ...(act !== undefined ? { act } : {}),
  };
}

const asAlice = assertionFor({ kind: "principal", principalId: "alice" });
const aliceAtAcme = assertionFor({ kind: "principal", principalId: "alice" }, { orgId: ACME });
const aliceAsAdminAtAcme = assertionFor(
  { kind: "principal", principalId: "alice" },
  { orgId: ACME, role: "admin" },
);
const asGuest = assertionFor({ kind: "principal", principalId: "guest" });

async function buildMiddleware(
  overrides: { store?: AuthzStore; registry?: IssuerKeyRegistry; verify?: (a: ActorAssertion) => boolean } = {},
): Promise<{ middleware: AuthzMiddleware; store: AuthzStore; registry: IssuerKeyRegistry }> {
  const store = overrides.store ?? makeStore();
  const registry = overrides.registry ?? (await makeRegistry());
  const middleware = createAuthzMiddleware({
    store,
    registry,
    ...(overrides.verify !== undefined
      ? { verifyAssertionSignature: async (a: ActorAssertion) => overrides.verify?.(a) ?? false }
      : {}),
  });
  return { middleware, store, registry };
}

// ---------------------------------------------------------------------------
// authorizeRequest unit behaviour — deny by default
// ---------------------------------------------------------------------------

test("middleware: missing assertion header is a 401 deny (positive assertion required)", async () => {
  const { middleware } = await buildMiddleware();
  const decision = await authorizeRequest(undefined, middleware);
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.equal(decision.status, 401);
    assert.equal(decision.reason, "missing_assertion");
  }
});

test("middleware: malformed assertion wire value is a 401 deny", async () => {
  const { middleware } = await buildMiddleware();
  for (const garbage of ["not-base64", "@@@", "", "{}"]) {
    const decision = await authorizeRequest(garbage, middleware);
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") {
      assert.equal(decision.reason, "invalid_assertion", `for payload ${garbage}`);
    }
  }
});

test("middleware: assertion from an unknown issuer/key is a 401 deny", async () => {
  const { middleware } = await buildMiddleware();
  const foreign = assertionFor({ kind: "principal", principalId: "alice" }, undefined);
  const unknownKey = { ...foreign, issuer: "evil-issuer", keyId: "nope" };
  const decision = await authorizeRequest(encodeActorAssertion(unknownKey), middleware);
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.equal(decision.status, 401);
    assert.equal(decision.reason, "unknown_issuer_key");
  }
});

test("middleware: assertion signed with a RETIRED key is denied, not accepted", async () => {
  const registry = await makeRegistry();
  await registry.retireIssuerKey("authentik", "k1");
  const { middleware } = await buildMiddleware({ registry });

  const decision = await authorizeRequest(encodeActorAssertion(asAlice), middleware);
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.equal(decision.reason, "issuer_key_retired");
  }
});

test("middleware: without an injected verifier every request fails closed (skeleton default)", async () => {
  const { middleware } = await buildMiddleware();
  const decision = await authorizeRequest(encodeActorAssertion(asAlice), middleware);
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") {
    assert.equal(decision.reason, "signature_not_verified");
  }
});

test("middleware: grantless or guest subjects resolve to a 403, never a bypass", async () => {
  const { middleware } = await buildMiddleware({ verify: () => true });
  const store = middleware.store;
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate" }]);

  // "guest" principal does not exist in the store -> authorization denial.
  const guestDecision = await authorizeRequest(encodeActorAssertion(asGuest), middleware);
  assert.equal(guestDecision.kind, "deny");
  if (guestDecision.kind === "deny") {
    assert.equal(guestDecision.status, 403);
    assert.equal(guestDecision.reason, "unknown_principal");
  }
});

test("middleware: valid assertion + grant allows; act role without a grant is a 403", async () => {
  const store = makeStore();
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate" }]);
  const { middleware } = await buildMiddleware({ store, verify: () => true });

  const allowed = await authorizeRequest(encodeActorAssertion(aliceAtAcme), middleware);
  assert.equal(allowed.kind, "allow", "candidate grant at acme must authorize");

  // Same subject, act claims admin which no grant backs -> denied server-side.
  const denied = await authorizeRequest(encodeActorAssertion(aliceAsAdminAtAcme), middleware);
  assert.equal(denied.kind, "deny");
  if (denied.kind === "deny") {
    assert.equal(denied.status, 403);
    assert.equal(denied.reason, "role_not_granted");
  }
});

// ---------------------------------------------------------------------------
// createGatewayServer integration — protected route, public health route
// ---------------------------------------------------------------------------

test("gateway: /mcp/tools/call is denied 401 before dispatch when authz is configured", async (context) => {
  const store = makeStore();
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate" }]);
  const { middleware } = await buildMiddleware({ store, verify: () => true });

  let calls = 0;
  const server = createGatewayServer(
    {
      async callTool() {
        calls += 1;
        return { ok: true, content: [] };
      },
    },
    undefined,
    middleware,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const noAssertion = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  assert.equal(noAssertion.status, 401);
  assert.equal(calls, 0, "unauthenticated call must never reach the adapter");
});

test("gateway: /mcp/tools/call allows an authorized assertion through to the adapter", async (context) => {
  const store = makeStore();
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate" }]);
  const { middleware } = await buildMiddleware({ store, verify: () => true });

  let calls = 0;
  const server = createGatewayServer(
    {
      async callTool() {
        calls += 1;
        return { ok: true, content: [{ type: "text", text: "hello" }] };
      },
    },
    undefined,
    middleware,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    headers: { "x-actor-assertion": encodeActorAssertion(aliceAtAcme) },
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; content: { type: string; text: string }[] };
  assert.equal(body.ok, true);
  assert.equal(body.content[0]?.text, "hello");
  assert.equal(calls, 1);
});

test("gateway: /mcp/tools/call denies 403 an authenticated but unauthorized claim", async (context) => {
  const store = makeStore();
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate" }]);
  const { middleware } = await buildMiddleware({ store, verify: () => true });

  let calls = 0;
  const server = createGatewayServer(
    {
      async callTool() {
        calls += 1;
        return { ok: true, content: [] };
      },
    },
    undefined,
    middleware,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    headers: { "x-actor-assertion": encodeActorAssertion(aliceAsAdminAtAcme) },
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: string; reason: string };
  assert.equal(body.error, "forbidden");
  assert.equal(body.reason, "role_not_granted");
  assert.equal(calls, 0);
});

test("gateway: /health stays public and unauthenticated even with authz configured", async (context) => {
  const { middleware } = await buildMiddleware();
  const server = createGatewayServer(undefined, undefined, middleware);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string };
  assert.equal(body.status, "ok");
});
