import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresReplayStore } from "@studenthub/db/assertions";
import { generateEd25519KeyPair, signAssertion, verifyAssertion, UNIVERSE_SUBJECT_POLICY, type ReplayStore } from "@bawes/actor-assertion";

let pool: pg.Pool;
let store: PostgresReplayStore;
const issuer = `replay-test-${randomUUID()}`;
const clock = async () => Number((await pool.query("SELECT extract(epoch FROM clock_timestamp()) AS now")).rows[0].now);
before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations(pool);
  store = new PostgresReplayStore({ pool });
  const compatible: ReplayStore = store;
  assert.equal(compatible, store);
});
after(async () => {
  if (pool) {
    await pool.query("DELETE FROM actor_assertion_replay WHERE issuer LIKE $1", [`${issuer}%`]);
    await pool.end();
  }
});

async function waitUntilBlocked(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName],
    );
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("contending consumption did not reach a database lock wait");
}

test("two independent connections produce exactly one consumed outcome", async () => {
  const secondPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const second = new PostgresReplayStore({ pool: secondPool });
    const now = await clock(), jti = randomUUID();
    const results = await Promise.all([
      store.consume(issuer, jti, now + 60, now, { issuedAt: now, maxIatSkewSeconds: 5 }),
      second.consume(issuer, jti, now + 60, now, { issuedAt: now, maxIatSkewSeconds: 5 }),
    ]);
    assert.deepEqual(results.sort(), ["consumed", "replayed"]);
    assert.equal(await new PostgresReplayStore({ pool }).consume(issuer, jti, now + 60, now), "replayed");
  } finally { await secondPool.end(); }
});

test("the same jti under different issuers is independent", async () => {
  const now = await clock(), jti = randomUUID();
  assert.equal(await store.consume(issuer, jti, now + 60, now), "consumed");
  assert.equal(await store.consume(`${issuer}-other`, jti, now + 60, now), "consumed");
});

test("authoritative DB expiry ignores ahead and behind application clocks", async () => {
  const now = await clock();
  for (const appNow of [now - 3600, now + 3600]) {
    assert.equal(await store.consume(issuer, randomUUID(), now - 1, appNow), "expired");
    assert.equal(await store.consume(issuer, randomUUID(), now + 60, appNow), "consumed");
  }
});

test("authoritative future iat uses DB time and configured skew", async () => {
  const now = await clock();
  for (const appNow of [now - 3600, now + 3600]) {
    assert.equal(await store.consume(issuer, randomUUID(), now + 60, appNow,
      { issuedAt: now + 30, maxIatSkewSeconds: 5 }), "future_iat");
    assert.equal(await store.consume(issuer, randomUUID(), now + 60, appNow,
      { issuedAt: now + 5, maxIatSkewSeconds: 5 }), "consumed");
  }
});

test("an old transaction cannot admit an assertion after expiry", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT clock_timestamp() + interval '100 milliseconds' AS expiry");
    await client.query("SELECT pg_sleep(0.15)");
    const result = await client.query("SELECT consume_actor_assertion($1,$2,$3,NULL,NULL) AS outcome",
      [issuer, randomUUID(), rows[0].expiry]);
    assert.equal(result.rows[0].outcome, "expired");
  } finally { await client.query("ROLLBACK"); client.release(); }
});

for (const release of ["ROLLBACK", "COMMIT"]) {
test(`insert lock wait crossing expiry denies after conflict ${release}`, async () => {
  const applicationName = `replay-lock-${randomUUID()}`;
  const contenderPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: applicationName });
  const holder = await pool.connect();
  let pending: Promise<string> | undefined;
  try {
    const now = await clock(), expiresAt = now + 3, jti = randomUUID();
    await holder.query("BEGIN");
    await holder.query("INSERT INTO actor_assertion_replay VALUES ($1,$2,to_timestamp($3))", [issuer, jti, expiresAt]);
    pending = new PostgresReplayStore({ pool: contenderPool }).consume(issuer, jti, expiresAt, now);
    await waitUntilBlocked(applicationName);
    await pool.query("SELECT pg_sleep(greatest(0, $1 - extract(epoch FROM clock_timestamp())) + 0.05)", [expiresAt]);
    await holder.query(release);
    assert.equal(await pending, "expired");
    // The refused authentic assertion may be consumed, but never becomes accepted.
    assert.equal(await store.consume(issuer, jti, expiresAt, now), "expired");
  } finally {
    await holder.query("ROLLBACK"); holder.release();
    if (pending) await pending.catch(() => undefined);
    await contenderPool.end();
  }
});

}

test("prune retains recent tombstones and cannot reopen an expired token in a race", async () => {
  const now = await clock(), old = randomUUID(), recent = randomUUID();
  await pool.query("INSERT INTO actor_assertion_replay VALUES ($1,$2,to_timestamp($4)),($1,$3,to_timestamp($5))",
    [issuer, old, recent, now - 601, now - 599]);
  const [, outcome] = await Promise.all([store.prune(), store.consume(issuer, old, now - 601, now - 3600)]);
  assert.equal(outcome, "expired");
  const rows = (await pool.query("SELECT jti FROM actor_assertion_replay WHERE issuer=$1 AND jti=ANY($2)",
    [issuer, [old, recent]])).rows;
  assert.deepEqual(rows.map(row => row.jti), [recent]);
  assert.equal(await new PostgresReplayStore({ pool }).consume(issuer, old, now - 601, now - 3600), "expired");
});

test("bounded cleanup respects its limit", async () => {
  const now = await clock();
  for (let i = 0; i < 3; i++) await pool.query("INSERT INTO actor_assertion_replay VALUES ($1,$2,to_timestamp($3))",
    [issuer, randomUUID(), now - 1000]);
  assert.equal(await store.prune(1), 1);
  await assert.rejects(store.prune(0), /invalid prune limit/);
});

test("invalid replay constraints fail closed before SQL", async () => {
  const now = await clock();
  for (const skew of [-1, 301, 0.5, NaN, Infinity]) {
    await assert.rejects(store.consume(issuer, randomUUID(), now + 60, now,
      { issuedAt: now, maxIatSkewSeconds: skew }), /invalid replay constraints/);
  }
  await assert.rejects(store.consume(issuer, randomUUID(), NaN, now), /invalid replay input/);
});

test("database failure throws and verifier returns UNAVAILABLE", async () => {
  const failedPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await failedPool.end();
  const failedStore = new PostgresReplayStore({ pool: failedPool });
  const now = Math.floor(await clock());
  await assert.rejects(failedStore.consume(issuer, randomUUID(), now + 60, now));
  const keys = await generateEd25519KeyPair();
  const token = await signAssertion({ v: 1, iss: issuer, aud: "test", sub: "test@example.com",
    iat: now, exp: now + 60, jti: randomUUID() }, keys.privateKeyPem);
  const result = await verifyAssertion(token, async () => keys.publicKeyPem, failedStore,
    { expectedAudience: "test", subjectPolicy: UNIVERSE_SUBJECT_POLICY, maxLifetimeSeconds: 60 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNAVAILABLE");
});


test("database function rejects null expiry and invalid strict constraints", async () => {
  for (const [expiry, issuedAt, skew] of [
    [null, null, null], ["infinity", null, null],
    ["2099-01-01", "2026-01-01", null], ["2099-01-01", null, 5],
    ["2099-01-01", "infinity", 5], ["2099-01-01", "2026-01-01", -1],
    ["2099-01-01", "2026-01-01", 301],
  ]) {
    await assert.rejects(pool.query("SELECT consume_actor_assertion($1,$2,$3,$4,$5)",
      [issuer, randomUUID(), expiry, issuedAt, skew]), /invalid actor assertion replay constraints/);
  }
});

test("unexpected database result cannot be interpreted as consumed", async () => {
  for (const rows of [[], [{ outcome: null }], [{ outcome: true }], [{ outcome: "unknown" }],
    [{ outcome: "consumed" }, { outcome: "consumed" }]]) {
    const fakePool = { query: async () => ({ rows }) } as unknown as pg.Pool;
    const invalidStore = new PostgresReplayStore({ pool: fakePool });
    await assert.rejects(invalidStore.consume(issuer, randomUUID(), 100, 0), /invalid replay database result/);
  }
});

test("owned pools handle idle errors without masking later query failures", async () => {
  // Capture the actual internally constructed pool without exposing it in the API.
  const OriginalPool = pg.Pool;
  const descriptor = Object.getOwnPropertyDescriptor(pg, "Pool")!;
  let owned!: pg.Pool;
  class ObservedPool extends OriginalPool {
    constructor(config?: pg.PoolConfig) {
      super(config);
      owned = this;
    }
  }
  let ownedStore!: PostgresReplayStore;
  try {
    Object.defineProperty(pg, "Pool", { configurable: true, writable: true, value: ObservedPool });
    ownedStore = new PostgresReplayStore({ connectionString: process.env.DATABASE_URL });
  } finally {
    Object.defineProperty(pg, "Pool", descriptor);
  }
  let closed = false;
  try {
    assert.equal(owned.listenerCount("error"), 1);
    assert.doesNotThrow(() => owned.emit("error", new Error("synthetic idle disconnect")));
    await ownedStore.close();
    closed = true;
    await assert.rejects(ownedStore.consume(issuer, randomUUID(), 100, 0));
  } finally {
    if (!closed) await ownedStore.close();
  }
});

test("injected pool error listeners and lifecycle remain the owner's responsibility", async () => {
  const injected = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let errors = 0;
  const onError = () => { errors++; };
  injected.on("error", onError);
  try {
    const listeners = injected.listeners("error");
    const injectedStore = new PostgresReplayStore({ pool: injected });
    assert.deepEqual(injected.listeners("error"), listeners);
    injected.emit("error", new Error("synthetic owner-handled disconnect"));
    assert.equal(errors, 1);
    await injectedStore.close();
    assert.equal((await injected.query("SELECT 1 AS ok")).rows[0].ok, 1);
    assert.deepEqual(injected.listeners("error"), listeners);
  } finally {
    await injected.end();
  }
});
