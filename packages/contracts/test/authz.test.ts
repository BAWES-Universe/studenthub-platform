import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHZ_CONTRACT_VERSION,
  CONTRACT_VERSIONS,
  PLATFORM_CONTRACT_VERSION,
  ROLE,
  ROLES,
  InMemoryAuthzStore,
  InMemoryIssuerKeyRegistry,
  ISSUER_KEY_ALGORITHMS,
  ancestorOrgIdsIncludingSelf,
  claimsActToContextSelection,
  claimsToRequestIdentity,
  contractVersion,
  createOrganization,
  createPrincipal,
  descendantOrgIdsIncludingSelf,
  isRole,
  isSameOrDescendantOf,
  listEffectiveContexts,
  normalizeGrantEntry,
  resolveActiveContext,
  type AuthzStore,
  type ContextSelection,
  type DenialReason,
  type GrantScope,
  type Role,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACME = "acme";
const ACME_INDIA = "acme-india";
const ACME_INDIA_BLR = "acme-india-blr";
const LONE_WOLF = "lonewolf";

const ORGS = [
  createOrganization({ id: ACME, name: "Acme Inc" }),
  createOrganization({ id: ACME_INDIA, name: "Acme India Pvt", parentOrgId: ACME }),
  createOrganization({
    id: ACME_INDIA_BLR,
    name: "Acme India Bangalore",
    parentOrgId: ACME_INDIA,
  }),
  createOrganization({ id: LONE_WOLF, name: "Lone Wolf Ltd" }),
];

const ALICE = createPrincipal({ id: "alice", pbuuids: ["pbuuid-alice-1", "pbuuid-alice-2"] });
const BOB = createPrincipal({ id: "bob", pbuuids: ["pbuuid-bob-1"] });
const MALLORY = createPrincipal({ id: "mallory" });

function makeStore(): AuthzStore {
  return new InMemoryAuthzStore({ organizations: ORGS, principals: [ALICE, BOB, MALLORY] });
}

async function grant(
  store: AuthzStore,
  principalId: string,
  orgId: string,
  role: Role,
  scope: GrantScope = "self",
): Promise<void> {
  await store.grantMany(principalId, [{ orgId, role, scope }]);
}

async function expectDenied(
  store: AuthzStore,
  identity: { kind: "principal"; principalId: string } | { kind: "pbuuid"; pbuuid: string },
  selection: ContextSelection | undefined,
  reason: DenialReason,
): Promise<void> {
  const resolution = await resolveActiveContext(identity, selection, store);
  assert.equal(resolution.kind, "denied", `expected denial ${reason}`);
  if (resolution.kind === "denied") assert.equal(resolution.reason, reason);
}


// ---------------------------------------------------------------------------
// Roles: the closed, versioned role set
// ---------------------------------------------------------------------------

test("authz: the role set is the documented closed union", () => {
  assert.deepEqual([...ROLES], [
    "candidate",
    "staff",
    "admin",
    "org-owner",
    "recruiter",
    "finance",
  ]);
  assert.equal(ROLE.ORG_OWNER, "org-owner");
  assert.equal(ROLE.RECRUITER, "recruiter");
  assert.equal(ROLE.CANDIDATE, "candidate");
});

test("authz: isRole guards values without scattering string literals", () => {
  assert.equal(isRole("candidate"), true);
  assert.equal(isRole("superuser"), false);
  assert.equal(isRole(42), false);
  assert.equal(isRole(undefined), false);
});

// ---------------------------------------------------------------------------
// Organization hierarchy helpers
// ---------------------------------------------------------------------------

test("authz: ancestor chains walk up, nearest first, cycle-safe", () => {
  const chain = ancestorOrgIdsIncludingSelf(ORGS, ACME_INDIA_BLR);
  assert.deepEqual([...chain], [ACME_INDIA_BLR, ACME_INDIA, ACME]);
});

test("authz: subtree closure flows down; a sub-company is not an ancestor of its parent", () => {
  const descendants = descendantOrgIdsIncludingSelf(ORGS, ACME);
  assert.deepEqual([...descendants].sort(), [ACME, ACME_INDIA, ACME_INDIA_BLR]);

  assert.equal(isSameOrDescendantOf(ORGS, ACME_INDIA_BLR, ACME), true);
  assert.equal(isSameOrDescendantOf(ORGS, ACME_INDIA, ACME), true);
  assert.equal(isSameOrDescendantOf(ORGS, ACME, ACME_INDIA), false);
  assert.equal(isSameOrDescendantOf(ORGS, LONE_WOLF, ACME), false);
});

// ---------------------------------------------------------------------------
// Grant store semantics (many-at-once, idempotent, widest scope wins)
// ---------------------------------------------------------------------------

test("authz: grantMany is many-at-once; re-granting upgrades self -> subtree in place", async () => {
  const store = makeStore();
  await store.grantMany("alice", [
    { orgId: ACME, role: "candidate", scope: "self" },
    { orgId: ACME, role: "recruiter" },
  ]);

  let grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 2);
  const candidateRow = grants.find((g) => g.role === "candidate");
  assert.ok(candidateRow);
  assert.equal(candidateRow.scope, "self");
  assert.equal(Object.isFrozen(candidateRow), true);

  // Idempotent re-grant of the same (org, role) widens self -> subtree.
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate", scope: "subtree" }]);
  grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 2, "merge must not add a duplicate row");
  const upgraded = grants.find((g) => g.role === "candidate");
  assert.equal(upgraded?.scope, "subtree");
  assert.equal(upgraded?.id, candidateRow?.id, "row replaced, not duplicated");
});

test("authz: normalizeGrantEntry rejects unknown roles, scopes and empty orgs", () => {
  assert.throws(() => normalizeGrantEntry({ orgId: ACME, role: "superuser" }), TypeError);
  assert.throws(
    () => normalizeGrantEntry({ orgId: ACME, role: "candidate", scope: "planet" }),
    TypeError,
  );
  assert.throws(() => normalizeGrantEntry({ orgId: "  ", role: "candidate" }), TypeError);
  assert.deepEqual(normalizeGrantEntry({ orgId: ` ${ACME} `, role: "candidate" }), {
    orgId: ACME,
    role: "candidate",
    scope: "self",
  });
});

test("authz: revokeMany removes exactly the targeted (org, role) rows", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");
  await grant(store, "alice", ACME, "finance");
  await store.revokeMany("alice", [{ orgId: ACME, role: "candidate" }]);
  const grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.role, "finance");
});

test("authz: organization cycles are rejected on construction and on upsert", async () => {
  const store = makeStore();
  assert.throws(
    () =>
      new InMemoryAuthzStore({
        organizations: [
          createOrganization({ id: "a", name: "A", parentOrgId: "b" }),
          createOrganization({ id: "b", name: "B", parentOrgId: "a" }),
        ],
        principals: [],
      }),
    TypeError,
  );
  await assert.rejects(
    store.upsertOrganization(
      // Making ACME_INDIA a child of its own descendant (ACME_INDIA_BLR)
      // closes a cycle the store must reject on upsert.
      createOrganization({ id: ACME_INDIA, name: "Acme India", parentOrgId: ACME_INDIA_BLR }),
    ),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Deny by default
// ---------------------------------------------------------------------------

test("authz: unknown principal is denied with or without an org target", async () => {
  const store = makeStore();
  await expectDenied(store, { kind: "principal", principalId: "ghost" }, undefined, "unknown_principal");
  await expectDenied(store, { kind: "principal", principalId: "ghost" }, { orgId: ACME }, "unknown_principal");
});

test("authz: known principal with no grants is denied at every org", async () => {
  const store = makeStore();
  await expectDenied(store, { kind: "principal", principalId: "mallory" }, undefined, "unknown_principal");
  await expectDenied(store, { kind: "principal", principalId: "mallory" }, { orgId: ACME, role: "admin" }, "no_context_at_org");
});

test("authz: grants elsewhere do not leak into an org without a grant", async () => {
  const store = makeStore();
  await grant(store, "alice", LONE_WOLF, "admin");
  await expectDenied(store, { kind: "principal", principalId: "alice" }, { orgId: ACME, role: "admin" }, "no_context_at_org");
});

test("authz: targeting an unknown org is denied", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");
  await expectDenied(store, { kind: "principal", principalId: "alice" }, { orgId: "does-not-exist" }, "no_context_at_org");
});

// ---------------------------------------------------------------------------
// Grant resolution + server-side context re-derivation
// ---------------------------------------------------------------------------

test("authz: single role at the target org resolves without a client claim", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");

  const resolution = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: ACME },
    store,
  );
  assert.equal(resolution.kind, "authorized");
  if (resolution.kind === "authorized") {
    assert.equal(resolution.context.role, "candidate");
    assert.equal(resolution.context.orgId, ACME);
    assert.equal(resolution.context.direct, true);
    assert.deepEqual([...resolution.effectiveRoles], ["candidate"]);
  }
});

test("authz: client-supplied role that no grant backs is REJECTED (server re-derives)", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");

  // The claim says admin; the store says candidate. The store wins.
  await expectDenied(store, { kind: "principal", principalId: "alice" }, { orgId: ACME, role: "admin" }, "role_not_granted");

  // Re-issue the same request with a valid claim; the grant decides.
  const resolution = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: ACME, role: "candidate" },
    store,
  );
  assert.equal(resolution.kind, "authorized");
});

test("authz: context is re-derived from the store on EVERY request (no caching)", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "recruiter");

  const first = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: ACME, role: "recruiter" },
    store,
  );
  assert.equal(first.kind, "authorized");

  // Revocation must take effect on the very next resolution.
  await store.revokeMany("alice", [{ orgId: ACME, role: "recruiter" }]);
  const second = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: ACME, role: "recruiter" },
    store,
  );
  assert.equal(second.kind, "denied");
  if (second.kind === "denied") assert.equal(second.reason, "no_context_at_org");
});

test("authz: pbuuid identity resolves through the principal link (one human, many pbuuids)", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");

  for (const pbuuid of ["pbuuid-alice-1", "pbuuid-alice-2"]) {
    const resolution = await resolveActiveContext({ kind: "pbuuid", pbuuid }, { orgId: ACME }, store);
    assert.equal(resolution.kind, "authorized");
    if (resolution.kind === "authorized") {
      assert.equal(resolution.context.principalId, "alice");
    }
  }
});

// ---------------------------------------------------------------------------
// Role switching (fluid multi-role / multi-org)
// ---------------------------------------------------------------------------

test("authz: multi-role principal must select a role; switching is honored per request", async () => {
  const store = makeStore();
  await grant(store, "bob", ACME, "recruiter");
  await grant(store, "bob", ACME, "finance");

  // Two roles at the org, none claimed -> ambiguous, denied.
  await expectDenied(store, { kind: "principal", principalId: "bob" }, { orgId: ACME }, "role_required");

  const asRecruiter = await resolveActiveContext(
    { kind: "principal", principalId: "bob" },
    { orgId: ACME, role: "recruiter" },
    store,
  );
  assert.equal(asRecruiter.kind, "authorized");
  if (asRecruiter.kind === "authorized") {
    assert.equal(asRecruiter.context.role, "recruiter");
    assert.deepEqual([...asRecruiter.effectiveRoles].sort(), ["finance", "recruiter"]);
  }

  const asFinance = await resolveActiveContext(
    { kind: "principal", principalId: "bob" },
    { orgId: ACME, role: "finance" },
    store,
  );
  assert.equal(asFinance.kind, "authorized");
  if (asFinance.kind === "authorized") assert.equal(asFinance.context.role, "finance");
});

test("authz: multi-org principal without an org target is ambiguous and denied", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");
  await grant(store, "alice", LONE_WOLF, "admin");

  await expectDenied(store, { kind: "principal", principalId: "alice" }, undefined, "ambiguous_context");

  // Targeting one org resolves cleanly.
  const resolution = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: LONE_WOLF },
    store,
  );
  assert.equal(resolution.kind, "authorized");
  if (resolution.kind === "authorized") {
    assert.equal(resolution.context.role, "admin");
    assert.equal(resolution.context.orgId, LONE_WOLF);
  }
});

test("authz: single-context principal resolves without any selection at all", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "candidate");

  const resolution = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    undefined,
    store,
  );
  assert.equal(resolution.kind, "authorized");
  if (resolution.kind === "authorized") {
    assert.equal(resolution.context.orgId, ACME);
    assert.equal(resolution.context.role, "candidate");
  }
});

// ---------------------------------------------------------------------------
// Sub-company hierarchy rules (access is grant-based, never hardcoded)
// ---------------------------------------------------------------------------

test("authz: a subtree grant reaches every sub-company below its org", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "org-owner", "subtree");

  for (const orgId of [ACME, ACME_INDIA, ACME_INDIA_BLR]) {
    const resolution = await resolveActiveContext(
      { kind: "principal", principalId: "alice" },
      { orgId },
      store,
    );
    assert.equal(resolution.kind, "authorized", `expected ${orgId} to be covered`);
    if (resolution.kind === "authorized") {
      assert.equal(resolution.context.grantedByOrgId, ACME);
      assert.equal(resolution.context.direct, orgId === ACME);
    }
  }
});

test("authz: a self-scoped grant does NOT flow down to sub-companies", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "org-owner", "self");

  const atParent = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: ACME },
    store,
  );
  assert.equal(atParent.kind, "authorized");

  await expectDenied(store, { kind: "principal", principalId: "alice" }, { orgId: ACME_INDIA }, "no_context_at_org");
});

test("authz: a sub-company grant does NOT flow up to the parent (hierarchy is grant-based)", async () => {
  const store = makeStore();
  await grant(store, "bob", ACME_INDIA, "finance", "self");

  const atChild = await resolveActiveContext(
    { kind: "principal", principalId: "bob" },
    { orgId: ACME_INDIA },
    store,
  );
  assert.equal(atChild.kind, "authorized");

  await expectDenied(store, { kind: "principal", principalId: "bob" }, { orgId: ACME }, "no_context_at_org");
});

test("authz: direct grant beats inherited grant for the same (org, role) in listings", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "org-owner", "subtree");
  await grant(store, "alice", ACME_INDIA, "org-owner", "self");

  const contexts = await listEffectiveContexts({ kind: "principal", principalId: "alice" }, store);
  const atIndia = contexts.filter((c) => c.orgId === ACME_INDIA);
  assert.equal(atIndia.length, 1, "one effective context per (org, role)");
  assert.equal(atIndia[0]?.direct, true, "direct row must win over the inherited one");
  assert.equal(atIndia[0]?.grantedByOrgId, ACME_INDIA);
});

test("authz: nearest ancestor wins when several subtree grants cover the same org", async () => {
  const store = makeStore();
  await grant(store, "alice", ACME, "org-owner", "subtree");
  await grant(store, "alice", ACME_INDIA, "org-owner", "subtree");

  const resolution = await resolveActiveContext(
    { kind: "principal", principalId: "alice" },
    { orgId: ACME_INDIA_BLR },
    store,
  );
  assert.equal(resolution.kind, "authorized");
  if (resolution.kind === "authorized") {
    assert.equal(resolution.context.grantedByOrgId, ACME_INDIA, "nearest ancestor grant wins");
  }
});

// ---------------------------------------------------------------------------
// Actor assertions: positive subject (amendment b), optional act (a), wire v1
// ---------------------------------------------------------------------------

test("assertion adapter: a verified subject maps onto the resolver identity", () => {
  assert.deepEqual(claimsToRequestIdentity({ sub: "sub-123" }), {
    kind: "pbuuid",
    pbuuid: "sub-123",
  });
});

test("assertion adapter: act maps to a ContextSelection (a preference, never proof)", () => {
  assert.equal(claimsActToContextSelection({ sub: "s" }), undefined);
  assert.equal(claimsActToContextSelection({ sub: "s", act: {} }), undefined);
  assert.deepEqual(claimsActToContextSelection({ sub: "s", act: { org: "acme" } }), {
    orgId: "acme",
  });
  assert.deepEqual(
    claimsActToContextSelection({ sub: "s", act: { org: "acme", role: "staff" } }),
    { orgId: "acme", role: "staff" },
  );
});

test("assertion adapter: contracts defines NO second assertion format", async () => {
  // SHU-49 originally shipped a parallel envelope here with no aud/exp/jti and
  // no signature. bawes-aa.v1 is the one format; this package must stay a
  // crypto-free adapter over verified claims.
  const contracts: Record<string, unknown> = await import("../src/index.js");
  for (const forked of [
    "parseActorAssertion",
    "encodeActorAssertion",
    "decodeActorAssertion",
    "isPositiveAssertionSubject",
    "ACTOR_ASSERTION_FORMAT_VERSION",
  ]) {
    assert.equal(contracts[forked], undefined, `${forked} must not be re-introduced`);
  }
});

test("assertion adapter: an act role that is not granted is rejected end-to-end", async () => {
  const store = new InMemoryAuthzStore({
    organizations: [createOrganization({ id: "acme", name: "Acme" })],
    principals: [createPrincipal({ id: "p1", pbuuids: ["sub-1"] })],
  });
  await store.grantMany("p1", [{ orgId: "acme", role: "candidate" }]);

  const claims = { sub: "sub-1", act: { org: "acme", role: "admin" } };
  const resolution = await resolveActiveContext(
    claimsToRequestIdentity(claims),
    claimsActToContextSelection(claims),
    store,
  );
  assert.equal(resolution.kind, "denied");
  assert.equal(resolution.kind === "denied" && resolution.reason, "role_not_granted");
});


test("registry: registration is active, idempotent, and algorithm-checked", async () => {
  const registry = new InMemoryIssuerKeyRegistry();
  const key = await registry.registerKey({ issuer: "authentik", keyId: "k1", algorithm: "EdDSA" });
  assert.equal(key.status, "active");
  assert.equal(key.issuer, "authentik");

  const again = await registry.registerKey({ issuer: "authentik", keyId: "k1", algorithm: "EdDSA" });
  assert.equal(again.keyId, key.keyId);
  assert.equal(again.registeredAt, key.registeredAt);

  await assert.rejects(
    registry.registerKey({ issuer: "authentik", keyId: "k2", algorithm: "ECIES" as never }),
    TypeError,
  );
});

test("registry: unknown issuer/key is a hard miss; retirement keeps rows for overlap", async () => {
  const registry = new InMemoryIssuerKeyRegistry();
  await registry.registerKey({ issuer: "authentik", keyId: "k1", algorithm: "EdDSA" });
  await registry.registerKey({ issuer: "authentik", keyId: "k2", algorithm: "ES256" });

  assert.equal(await registry.getIssuerKey("authentik", "missing"), undefined);
  assert.equal(await registry.getIssuerKey("unknown-issuer", "k1"), undefined);

  const retired = await registry.retireIssuerKey("authentik", "k1");
  assert.equal(retired.status, "retired");
  // Row is kept (audit/overlap verification), but no longer active.
  assert.equal((await registry.getIssuerKey("authentik", "k1"))?.status, "retired");
  assert.equal((await registry.getIssuerKey("authentik", "k2"))?.status, "active");

  const listed = await registry.listIssuerKeys("authentik");
  assert.deepEqual(listed.map((k) => k.keyId).sort(), ["k1", "k2"]);
  await assert.rejects(registry.retireIssuerKey("authentik", "missing"), RangeError);
});

test("registry: issuer keys are constrained to the supported algorithm set", () => {
  assert.deepEqual([...ISSUER_KEY_ALGORITHMS], ["EdDSA", "ES256", "RS256"]);
});

// ---------------------------------------------------------------------------
// Per-contract versioning (amendment d)
// ---------------------------------------------------------------------------

test("versions: every contract slot is versioned independently", () => {
  assert.deepEqual(CONTRACT_VERSIONS, {
    health: "1.0.0",
    authz: "1.0.0",
    identity: "1.0.0",
  });
  assert.equal(CONTRACT_VERSIONS.health, PLATFORM_CONTRACT_VERSION);
  assert.equal(CONTRACT_VERSIONS.authz, AUTHZ_CONTRACT_VERSION);
});

test("versions: the version helper returns the requested contract slot", () => {
  assert.equal(contractVersion("authz"), "1.0.0");
  assert.equal(contractVersion("health"), "1.0.0");
  assert.equal(contractVersion("identity"), "1.0.0");
});
