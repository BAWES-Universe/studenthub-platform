/**
 * SHU-55 acceptance tests: PostgresAuthzStore against the REAL lab Postgres
 * (127.0.0.1:55432/studenthub_authz, DATABASE_URL overridable).
 *
 * Every run starts from a clean schema: the `before` hook applies all
 * migrations, and `beforeEach` truncates the authz tables so no test ever
 * depends on leftover state. The store under test is a brand-new
 * PostgresAuthzStore per test — same interface shape the in-memory tests
 * exercise, so the parity suite below is the focused proof that the Postgres
 * implementation is behaviorally interchangeable.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";

import {
  createOrganization,
  createPrincipal,
  resolveActiveContext,
  type RoleGrant,
} from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";

const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:shu55labpw@127.0.0.1:55432/studenthub_authz";

const ACME = "acme";
const ACME_INDIA = "acme-india";

// --- Suite plumbing --------------------------------------------------------------

let adminPool: pg.Pool;
let activeStores: PostgresAuthzStore[] = [];

/** A fresh store over the shared test database; closed by afterEach. */
function makeStore(): PostgresAuthzStore {
  const store = new PostgresAuthzStore({ connectionString: DB_URL });
  activeStores.push(store);
  return store;
}

before(async () => {
  adminPool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(adminPool);
});

beforeEach(async () => {
  activeStores = [];
  await adminPool.query(
    "TRUNCATE organizations, principals, principal_pbuuids, grants RESTART IDENTITY CASCADE",
  );
});

afterEach(async () => {
  // close() is idempotent-safe here: a test may already have closed a store
  // (the restart test closes its first store on purpose), and pool.end() on
  // an ended pool must not fail the suite.
  for (const store of activeStores) await store.close().catch(() => undefined);
});

after(async () => {
  await adminPool.end();
});

// ---------------------------------------------------------------------------
// Parity: organization store
// ---------------------------------------------------------------------------

test("parity: organizations upsert, update in place, fetch and list", async () => {
  const store = makeStore();

  await store.upsertOrganization(createOrganization({ id: ACME, name: "Acme Inc" }));
  // Parent must exist before its child (schema FK; see store header).
  await store.upsertOrganization(
    createOrganization({ id: ACME_INDIA, name: "Acme India Pvt", parentOrgId: ACME }),
  );

  const org = await store.getOrganization(ACME_INDIA);
  assert.deepEqual(org, { id: ACME_INDIA, name: "Acme India Pvt", parentOrgId: ACME });

  // Upsert of an existing id updates in place instead of duplicating.
  await store.upsertOrganization(createOrganization({ id: ACME, name: "Acme Inc (renamed)" }));
  const renamed = await store.getOrganization(ACME);
  assert.equal(renamed?.name, "Acme Inc (renamed)");

  const all = await store.listOrganizations();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((o) => o.id).sort(),
    [ACME, ACME_INDIA],
  );
  assert.equal(await store.getOrganization("ghost"), undefined);
});

// ---------------------------------------------------------------------------
// Parity: principal store
// ---------------------------------------------------------------------------

test("parity: principals register, list, and resolve by pbuuid", async () => {
  const store = makeStore();

  await store.registerPrincipal(
    createPrincipal({
      id: "alice",
      pbuuids: ["alice-1@bawes.net", "alice-2@bawes.net"],
      displayName: "Alice",
      email: "alice-1@bawes.net",
    }),
  );

  const byPbuuid = await store.findPrincipalByPbuuid("alice-1@bawes.net");
  assert.equal(byPbuuid?.id, "alice");
  assert.equal(byPbuuid?.displayName, "Alice");
  assert.deepEqual([...(byPbuuid?.pbuuids ?? [])].sort(), ["alice-1@bawes.net", "alice-2@bawes.net"]);

  const direct = await store.getPrincipal("alice");
  assert.equal(direct?.id, "alice");
  assert.equal(direct?.email, "alice-1@bawes.net");

  assert.equal((await store.findPrincipalByPbuuid("alice-2@bawes.net"))?.id, "alice");
  assert.equal(await store.findPrincipalByPbuuid("ghost@bawes.net"), undefined);
  assert.equal(await store.getPrincipal("ghost"), undefined);

  const listed = await store.listPrincipals();
  assert.deepEqual(listed.map((p) => p.id), ["alice"]);

  // Optional fields omitted on the input stay undefined on the output.
  await store.registerPrincipal(createPrincipal({ id: "minimal", pbuuids: ["m@bawes.net"] }));
  const minimal = await store.getPrincipal("minimal");
  assert.equal(minimal?.displayName, undefined);
  assert.equal(minimal?.email, undefined);
});

// ---------------------------------------------------------------------------
// Parity: grant store semantics (many-at-once, idempotent, widest scope wins)
// ---------------------------------------------------------------------------

async function seedOrgAndPrincipal(store: PostgresAuthzStore): Promise<void> {
  await store.upsertOrganization(createOrganization({ id: ACME, name: "Acme Inc" }));
  await store.registerPrincipal(createPrincipal({ id: "alice", pbuuids: ["alice@bawes.net"] }));
}

test("parity: grantMany is many-at-once; re-granting upgrades self -> subtree in place", async () => {
  const store = makeStore();
  await seedOrgAndPrincipal(store);

  await store.grantMany("alice", [
    { orgId: ACME, role: "candidate", scope: "self" },
    { orgId: ACME, role: "recruiter" }, // scope defaults to self
  ]);

  let grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 2);
  const candidateRow = grants.find((g) => g.role === "candidate");
  assert.ok(candidateRow);
  assert.equal(candidateRow.scope, "self");
  assert.equal(Object.isFrozen(candidateRow), true);
  assert.equal(Object.isFrozen(grants), true);
  assert.equal(typeof candidateRow.id, "string", "grant ids are strings like the in-memory store");

  // Idempotent re-grant of the same (org, role) widens self -> subtree.
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate", scope: "subtree" }]);
  grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 2, "merge must not add a duplicate row");
  const upgraded = grants.find((g) => g.role === "candidate");
  assert.equal(upgraded?.scope, "subtree");
  assert.equal(upgraded?.id, candidateRow.id, "row replaced in place, not duplicated");

  // Widest scope wins is a one-way ratchet: a later 'self' grant must NOT
  // narrow an existing 'subtree' grant.
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate", scope: "self" }]);
  grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 2);
  assert.equal(grants.find((g) => g.role === "candidate")?.scope, "subtree");
});

test("parity: grantMany rejects an invalid entry without touching existing grants", async () => {
  const store = makeStore();
  await seedOrgAndPrincipal(store);
  await store.grantMany("alice", [{ orgId: ACME, role: "candidate" }]);

  await assert.rejects(
    () => store.grantMany("alice", [{ orgId: ACME, role: "superuser" }]),
    TypeError,
  );
  const grants = await store.listGrantsForPrincipal("alice");
  assert.equal(grants.length, 1, "a rejected grantMany must not partially apply");
});

test("parity: revokeMany removes exactly the targeted (org, role) rows; unknown ignored", async () => {
  const store = makeStore();
  await seedOrgAndPrincipal(store);
  await store.grantMany("alice", [
    { orgId: ACME, role: "candidate" },
    { orgId: ACME, role: "finance" },
    { orgId: ACME, role: "recruiter", scope: "subtree" },
  ]);

  // Scope is irrelevant to a revocation; unknown targets delete nothing.
  await store.revokeMany("alice", [
    { orgId: ACME, role: "candidate" },
    { orgId: ACME, role: "superuser" },
  ]);
  const grants = await store.listGrantsForPrincipal("alice");
  assert.deepEqual(
    grants.map((g: RoleGrant) => g.role).sort(),
    ["finance", "recruiter"],
  );
});

test("parity: clearGrantsForPrincipal empties the grant set but keeps the principal", async () => {
  const store = makeStore();
  await seedOrgAndPrincipal(store);
  await store.grantMany("alice", [{ orgId: ACME, role: "finance", scope: "subtree" }]);

  await store.clearGrantsForPrincipal("alice");
  assert.deepEqual(await store.listGrantsForPrincipal("alice"), []);

  await store.clearGrantsForPrincipal("never-granted"); // no-op on unknowns
  assert.equal((await store.getPrincipal("alice"))?.id, "alice");
});

// ---------------------------------------------------------------------------
// Integrity: pbuuid ownership (stale mapping removal + cross-principal theft)
// ---------------------------------------------------------------------------

test("integrity: re-registering a principal detaches its removed pbuuids", async () => {
  const store = makeStore();
  await store.registerPrincipal(
    createPrincipal({ id: "p1", pbuuids: ["a@bawes.net", "b@bawes.net"] }),
  );
  assert.equal((await store.findPrincipalByPbuuid("a@bawes.net"))?.id, "p1");

  // Detach a@bawes.net by re-registering without it.
  await store.registerPrincipal(createPrincipal({ id: "p1", pbuuids: ["b@bawes.net"] }));

  assert.equal(
    await store.findPrincipalByPbuuid("a@bawes.net"),
    undefined,
    "a detached identity must stop resolving — otherwise it still reaches p1's grants",
  );
  assert.equal((await store.findPrincipalByPbuuid("b@bawes.net"))?.id, "p1");

  // Detaching the LAST pbuuid leaves a principal with no identities at all.
  await store.registerPrincipal(createPrincipal({ id: "p1", pbuuids: [] }));
  assert.equal(await store.findPrincipalByPbuuid("b@bawes.net"), undefined);
  assert.equal((await store.getPrincipal("p1"))?.id, "p1");
});

test("integrity: a pbuuid owned by another principal cannot be claimed", async () => {
  const store = makeStore();
  await store.registerPrincipal(
    createPrincipal({ id: "victim", pbuuids: ["khalid@bawes.net"] }),
  );

  await assert.rejects(
    () =>
      store.registerPrincipal(
        createPrincipal({ id: "attacker", pbuuids: ["khalid@bawes.net"] }),
      ),
    (error: unknown) =>
      error instanceof TypeError &&
      /already owned by principal 'victim'/.test(error.message),
  );

  assert.equal((await store.findPrincipalByPbuuid("khalid@bawes.net"))?.id, "victim");
  assert.equal(
    await store.getPrincipal("attacker"),
    undefined,
    "rejected registration must not partially apply",
  );
});

test("integrity: a rejected registration leaves NO trace of any of its pbuuids", async () => {
  const store = makeStore();
  await store.registerPrincipal(
    createPrincipal({ id: "victim", pbuuids: ["taken@bawes.net"] }),
  );
  // First pbuuid is free, second is taken: the whole transaction must roll
  // back, so even the free one is not indexed (matches the in-memory
  // validation-before-mutation behavior).
  await assert.rejects(() =>
    store.registerPrincipal(
      createPrincipal({ id: "attacker", pbuuids: ["free@bawes.net", "taken@bawes.net"] }),
    ),
    TypeError,
  );
  assert.equal(await store.findPrincipalByPbuuid("free@bawes.net"), undefined);
  assert.equal(
    (await store.findPrincipalByPbuuid("taken@bawes.net"))?.id,
    "victim",
    "the victim's mapping survives the failed claim",
  );
});

// ---------------------------------------------------------------------------
// Concurrency: the pbuuid primary key serializes competing claims (TOCTOU)
// ---------------------------------------------------------------------------

test("concurrency: parallel claims of one pbuuid — exactly one principal wins", async () => {
  const store = makeStore();
  const shared = "shared@bawes.net";
  const principalA = createPrincipal({ id: "principal-a", pbuuids: [shared] });
  const principalB = createPrincipal({ id: "principal-b", pbuuids: [shared] });

  const [resultA, resultB] = await Promise.allSettled([
    store.registerPrincipal(principalA),
    store.registerPrincipal(principalB),
  ]);

  // The unique index serializes the writers: exactly one registration
  // commits, the other fails with the ownership TypeError. Both succeeding
  // would be the CWE-863 theft both stores must prevent; both failing would
  // mean the constraint rejected a legitimate first claim.
  const settled = [resultA, resultB];
  const winnerIndex = settled.findIndex((r) => r.status === "fulfilled");
  const loser = settled[1 - winnerIndex];
  assert.ok(winnerIndex !== -1, "exactly one registration must succeed");
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(loser.status, "rejected");
  if (loser.status === "rejected") {
    assert.ok(
      loser.reason instanceof TypeError && /already owned by principal/.test(loser.reason.message),
      `loser must fail with the ownership TypeError, got: ${String(loser.reason)}`,
    );
  }

  const winnerId = winnerIndex === 0 ? principalA.id : principalB.id;
  const loserId = winnerIndex === 0 ? principalB.id : principalA.id;

  // The pbuuid resolves to the winner — and only the winner exists.
  assert.equal((await store.findPrincipalByPbuuid(shared))?.id, winnerId);
  assert.equal(await store.getPrincipal(loserId), undefined);
  assert.equal((await store.getPrincipal(winnerId))?.id, winnerId);
});

// ---------------------------------------------------------------------------
// Restart persistence: data survives close(); a fresh store resolves it
// ---------------------------------------------------------------------------

test("persistence: contexts resolve identically after close + fresh store on the same database", async () => {
  const storeA = makeStore();
  await storeA.upsertOrganization(createOrganization({ id: ACME, name: "Acme Inc" }));
  await storeA.upsertOrganization(
    createOrganization({ id: ACME_INDIA, name: "Acme India Pvt", parentOrgId: ACME }),
  );
  await storeA.registerPrincipal(
    createPrincipal({ id: "khalid", pbuuids: ["khalid@bawes.net"], displayName: "Khalid" }),
  );
  await storeA.grantMany("khalid", [{ orgId: ACME, role: "admin", scope: "subtree" }]);
  await storeA.close();

  // A NEW store over the same database — nothing in memory, everything from
  // Postgres — must resolve the exact same active context the old store
  // would have: the subtree grant at acme reaches acme-india.
  const storeB = makeStore();
  const resolution = await resolveActiveContext(
    { kind: "pbuuid", pbuuid: "khalid@bawes.net" },
    { orgId: ACME_INDIA, role: "admin" },
    storeB,
  );
  assert.equal(resolution.kind, "authorized");
  if (resolution.kind === "authorized") {
    assert.equal(resolution.context.principalId, "khalid");
    assert.equal(resolution.context.orgId, ACME_INDIA);
    assert.equal(resolution.context.role, "admin");
    assert.equal(resolution.context.scope, "subtree");
    assert.equal(resolution.context.grantedByOrgId, ACME);
    assert.equal(resolution.context.direct, false);
  }

  const grants = await storeB.listGrantsForPrincipal("khalid");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.orgId, ACME);
  assert.equal(grants[0]?.role, "admin");
  assert.equal(grants[0]?.scope, "subtree");

  const orgs = await storeB.listOrganizations();
  assert.equal(orgs.length, 2);
});
