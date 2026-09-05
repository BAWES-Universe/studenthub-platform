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
import { PostgresAuthzStore, runMigrations, bootstrapAdmin } from "@studenthub/db";

// DATABASE_URL is REQUIRED: the suite runs against a scratch Postgres that
// must never be a default in the repo. CI injects it (postgres service in
// .github/workflows/ci.yml); local runs export it (e.g. the SHU-55 lab
// database at 127.0.0.1:55432/studenthub_authz).
const DB_URL = process.env.DATABASE_URL ?? "";

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
  if (DB_URL.length === 0) {
    throw new Error(
      "DATABASE_URL is required to run the db suite: point it at a scratch " +
        "Postgres (CI injects it via the postgres service container).",
    );
  }
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
      pbuuids: ["alice-1@example.invalid", "alice-2@example.invalid"],
      displayName: "Alice",
      email: "alice-1@example.invalid",
    }),
  );

  const byPbuuid = await store.findPrincipalByPbuuid("alice-1@example.invalid");
  assert.equal(byPbuuid?.id, "alice");
  assert.equal(byPbuuid?.displayName, "Alice");
  assert.deepEqual([...(byPbuuid?.pbuuids ?? [])].sort(), ["alice-1@example.invalid", "alice-2@example.invalid"]);

  const direct = await store.getPrincipal("alice");
  assert.equal(direct?.id, "alice");
  assert.equal(direct?.email, "alice-1@example.invalid");

  assert.equal((await store.findPrincipalByPbuuid("alice-2@example.invalid"))?.id, "alice");
  assert.equal(await store.findPrincipalByPbuuid("ghost@example.invalid"), undefined);
  assert.equal(await store.getPrincipal("ghost"), undefined);

  const listed = await store.listPrincipals();
  assert.deepEqual(listed.map((p) => p.id), ["alice"]);

  // Optional fields omitted on the input stay undefined on the output.
  await store.registerPrincipal(createPrincipal({ id: "minimal", pbuuids: ["m@example.invalid"] }));
  const minimal = await store.getPrincipal("minimal");
  assert.equal(minimal?.displayName, undefined);
  assert.equal(minimal?.email, undefined);
});

// ---------------------------------------------------------------------------
// Parity: grant store semantics (many-at-once, idempotent, widest scope wins)
// ---------------------------------------------------------------------------

async function seedOrgAndPrincipal(store: PostgresAuthzStore): Promise<void> {
  await store.upsertOrganization(createOrganization({ id: ACME, name: "Acme Inc" }));
  await store.registerPrincipal(createPrincipal({ id: "alice", pbuuids: ["alice@example.invalid"] }));
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
    createPrincipal({ id: "p1", pbuuids: ["a@example.invalid", "b@example.invalid"] }),
  );
  assert.equal((await store.findPrincipalByPbuuid("a@example.invalid"))?.id, "p1");

  // Detach a@example.invalid by re-registering without it.
  await store.registerPrincipal(createPrincipal({ id: "p1", pbuuids: ["b@example.invalid"] }));

  assert.equal(
    await store.findPrincipalByPbuuid("a@example.invalid"),
    undefined,
    "a detached identity must stop resolving — otherwise it still reaches p1's grants",
  );
  assert.equal((await store.findPrincipalByPbuuid("b@example.invalid"))?.id, "p1");

  // Detaching the LAST pbuuid leaves a principal with no identities at all.
  await store.registerPrincipal(createPrincipal({ id: "p1", pbuuids: [] }));
  assert.equal(await store.findPrincipalByPbuuid("b@example.invalid"), undefined);
  assert.equal((await store.getPrincipal("p1"))?.id, "p1");
});

test("integrity: a pbuuid owned by another principal cannot be claimed", async () => {
  const store = makeStore();
  await store.registerPrincipal(
    createPrincipal({ id: "victim", pbuuids: ["victim@example.invalid"] }),
  );

  await assert.rejects(
    () =>
      store.registerPrincipal(
        createPrincipal({ id: "attacker", pbuuids: ["victim@example.invalid"] }),
      ),
    (error: unknown) =>
      error instanceof TypeError &&
      /already owned by principal 'victim'/.test(error.message),
  );

  assert.equal((await store.findPrincipalByPbuuid("victim@example.invalid"))?.id, "victim");
  assert.equal(
    await store.getPrincipal("attacker"),
    undefined,
    "rejected registration must not partially apply",
  );
});

test("integrity: a rejected registration leaves NO trace of any of its pbuuids", async () => {
  const store = makeStore();
  await store.registerPrincipal(
    createPrincipal({ id: "victim", pbuuids: ["taken@example.invalid"] }),
  );
  // First pbuuid is free, second is taken: the whole transaction must roll
  // back, so even the free one is not indexed (matches the in-memory
  // validation-before-mutation behavior).
  await assert.rejects(() =>
    store.registerPrincipal(
      createPrincipal({ id: "attacker", pbuuids: ["free@example.invalid", "taken@example.invalid"] }),
    ),
    TypeError,
  );
  assert.equal(await store.findPrincipalByPbuuid("free@example.invalid"), undefined);
  assert.equal(
    (await store.findPrincipalByPbuuid("taken@example.invalid"))?.id,
    "victim",
    "the victim's mapping survives the failed claim",
  );
});

// ---------------------------------------------------------------------------
// Concurrency: the pbuuid primary key serializes competing claims (TOCTOU)
// ---------------------------------------------------------------------------

test("concurrency: parallel claims of one pbuuid — exactly one principal wins", async () => {
  const store = makeStore();
  const shared = "shared@example.invalid";
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
    createPrincipal({
      id: "root-admin",
      pbuuids: ["root-admin@example.invalid"],
      displayName: "Root Admin",
    }),
  );
  await storeA.grantMany("root-admin", [
    { orgId: ACME, role: "admin", scope: "subtree" },
  ]);
  await storeA.close();

  // A NEW store over the same database — nothing in memory, everything from
  // Postgres — must resolve the exact same active context the old store
  // would have: the subtree grant at acme reaches acme-india.
  const storeB = makeStore();
  const resolution = await resolveActiveContext(
    { kind: "pbuuid", pbuuid: "root-admin@example.invalid" },
    { orgId: ACME_INDIA, role: "admin" },
    storeB,
  );
  assert.equal(resolution.kind, "authorized");
  if (resolution.kind === "authorized") {
    assert.equal(resolution.context.principalId, "root-admin");
    assert.equal(resolution.context.orgId, ACME_INDIA);
    assert.equal(resolution.context.role, "admin");
    assert.equal(resolution.context.scope, "subtree");
    assert.equal(resolution.context.grantedByOrgId, ACME);
    assert.equal(resolution.context.direct, false);
  }

  const grants = await storeB.listGrantsForPrincipal("root-admin");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.orgId, ACME);
  assert.equal(grants[0]?.role, "admin");
  assert.equal(grants[0]?.scope, "subtree");

  const orgs = await storeB.listOrganizations();
  assert.equal(orgs.length, 2);
});

// ---------------------------------------------------------------------------
// Integrity: organization tree cycles (parity with InMemoryAuthzStore)
// ---------------------------------------------------------------------------

test("integrity: reparenting into a cycle (A->B->A) is rejected atomically", async () => {
  const store = makeStore();
  await store.upsertOrganization(createOrganization({ id: "a", name: "A" }));
  await store.upsertOrganization(
    createOrganization({ id: "b", name: "B", parentOrgId: "a" }),
  );

  // Reparent A under B would close the cycle A->B->A. The self-referencing
  // FK alone permits it (both rows exist); the store must reject it like
  // InMemoryAuthzStore does.
  await assert.rejects(
    () =>
      store.upsertOrganization(
        createOrganization({ id: "a", name: "A", parentOrgId: "b" }),
      ),
    (error: unknown) =>
      error instanceof TypeError && /cycle detected/.test(error.message),
  );

  // The rejected reparent must leave the tree exactly as it was.
  assert.equal((await store.getOrganization("a"))?.parentOrgId, undefined);
  assert.equal((await store.getOrganization("b"))?.parentOrgId, "a");
});

test("integrity: an organization cannot become its own parent at the store boundary", async () => {
  const store = makeStore();
  await store.upsertOrganization(createOrganization({ id: "a", name: "A" }));

  // Hand-built object bypassing createOrganization: the store itself must
  // reject self-parenting (a raw UPDATE would satisfy the FK).
  await assert.rejects(
    () => store.upsertOrganization({ id: "a", name: "A", parentOrgId: "a" }),
    (error: unknown) =>
      error instanceof TypeError && /own parent/.test(error.message),
  );

  assert.equal((await store.getOrganization("a"))?.parentOrgId, undefined);
});

test("integrity: a cycle spanning three organizations is rejected (A<-B->A closed via C)", async () => {
  const store = makeStore();
  await store.upsertOrganization(createOrganization({ id: "a", name: "A" }));
  await store.upsertOrganization(
    createOrganization({ id: "b", name: "B", parentOrgId: "a" }),
  );
  await store.upsertOrganization(
    createOrganization({ id: "c", name: "C", parentOrgId: "b" }),
  );

  // Reparent A under C: A -> C -> B -> A.
  await assert.rejects(
    () =>
      store.upsertOrganization(
        createOrganization({ id: "a", name: "A", parentOrgId: "c" }),
      ),
    TypeError,
  );
  assert.equal((await store.getOrganization("a"))?.parentOrgId, undefined);
});

// ---------------------------------------------------------------------------
// Bootstrap: the one-root-admin rule is a DATABASE property (SHU-55, GPT R3)
// ---------------------------------------------------------------------------

test("bootstrap concurrency: two simultaneous bootstraps cannot create two root admins", async () => {
  // Two independent processes (separate pools) race a fresh database. Both
  // can pass the pre-write SELECT guard; migration 0002's partial unique
  // index is what actually enforces one root admin — exactly one run must
  // succeed and exactly one admin grant row may exist afterwards.
  const poolA = new pg.Pool({ connectionString: DB_URL });
  const poolB = new pg.Pool({ connectionString: DB_URL });
  try {
    const [resultA, resultB] = await Promise.allSettled([
      bootstrapAdmin(poolA, { pbuuid: "admin-a@example.invalid" }),
      bootstrapAdmin(poolB, { pbuuid: "admin-b@example.invalid" }),
    ]);

    const settled = [resultA, resultB];
    const fulfilledCount = settled.filter((r) => r.status === "fulfilled").length;
    assert.equal(
      fulfilledCount,
      1,
      `exactly one bootstrap may create the root admin, got ${fulfilledCount} ` +
        `(both succeeding would be the TOCTOU two-root-admins bug)`,
    );
    const loser = settled.find((r) => r.status === "rejected");
    assert.ok(loser, "the losing bootstrap must be rejected");
    if (loser?.status === "rejected") {
      assert.match(
        String(loser.reason),
        /second platform admin/i,
        `loser must fail with the second-admin refusal, got: ${String(loser.reason)}`,
      );
    }

    const { rows } = await adminPool.query<{ principal_id: string }>(
      "SELECT principal_id FROM grants WHERE org_id = 'root' AND role = 'admin'",
    );
    assert.equal(rows.length, 1, "the database holds exactly one root admin grant");
  } finally {
    await poolA.end();
    await poolB.end();
  }
});

test("bootstrap: re-running with the exact same admin is a no-op; a different identity is refused", async () => {
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    const first = await bootstrapAdmin(pool, {
      pbuuid: "admin@example.invalid",
      displayName: "Admin",
    });
    assert.equal(first, "created");

    const second = await bootstrapAdmin(pool, {
      pbuuid: "admin@example.invalid",
      displayName: "Admin",
    });
    assert.equal(second, "noop", "identical principal + grant is idempotent");

    await assert.rejects(
      () => bootstrapAdmin(pool, { pbuuid: "intruder@example.invalid" }),
      (error: unknown) =>
        error instanceof Error && /second platform admin/i.test(error.message),
    );

    const { rows } = await adminPool.query<{ principal_id: string }>(
      "SELECT principal_id FROM grants WHERE org_id = 'root' AND role = 'admin'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.principal_id, "principal-admin@example.invalid");
  } finally {
    await pool.end();
  }
});
