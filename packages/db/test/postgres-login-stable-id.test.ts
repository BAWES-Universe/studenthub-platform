import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";

import { runMigrations } from "../src/migrate.js";
import { PostgresLoginStore } from "../src/postgres-login-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
let stores: PostgresLoginStore[] = [];

before(async () => {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the Postgres stable-id tests");
  pool = new pg.Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
});

beforeEach(async () => {
  for (const store of stores) await store.close().catch(() => undefined);
  stores = [];
  await pool.query("TRUNCATE login_sessions, external_identities, principals CASCADE");
});

after(async () => {
  for (const store of stores) await store.close().catch(() => undefined);
  await pool.end();
});

function makeStore(): PostgresLoginStore {
  const store = new PostgresLoginStore({ connectionString: databaseUrl });
  stores.push(store);
  return store;
}

test("Q14L_BIND Postgres binds a stable id and matches it on later sign-in", async () => {
  const store = makeStore();
  const identity = await store.identities.createForSubject("issuer", "person@example.invalid", {});
  assert.equal(await store.identities.bindStableId?.("issuer", "person@example.invalid", "stable_id_123"), "bound");
  assert.equal(await store.identities.bindStableId?.("issuer", "person@example.invalid", "stable_id_123"), "matched");
  const { rows } = await pool.query<{ stable_user_id: string }>(
    "SELECT stable_user_id FROM external_identities WHERE person_id = $1::text", [identity.personId],
  );
  assert.equal(rows[0]?.stable_user_id, "stable_id_123");
});

test("Q14L_REASSIGN Postgres locks mismatch, revokes sessions, and keeps original data", async () => {
  const store = makeStore();
  const identity = await store.identities.createForSubject("issuer", "person@example.invalid", {});
  await store.identities.bindStableId?.("issuer", "person@example.invalid", "original_123");
  await store.sessions.put({ id: "session-one", personId: identity.personId });
  assert.equal(await store.identities.bindStableId?.("issuer", "person@example.invalid", "different_456"), "mismatch");
  assert.equal(await store.sessions.get("session-one"), undefined);
  assert.equal(await store.identities.bindStableId?.("issuer", "person@example.invalid", "original_123"), "locked");
  assert.deepEqual(await store.identities.findBySubject("issuer", "person@example.invalid"), identity);
});

test("Q14L_LOCK concurrent first binds serialize; reports redact stable ids; unlock clears lock", async () => {
  const first = makeStore();
  const second = makeStore();
  await first.identities.createForSubject("issuer", "person@example.invalid", {});
  const outcomes = await Promise.all([
    first.identities.bindStableId?.("issuer", "person@example.invalid", "concurrent_123"),
    second.identities.bindStableId?.("issuer", "person@example.invalid", "concurrent_456"),
  ]);
  assert.deepEqual(new Set(outcomes), new Set(["bound", "mismatch"]));
  const locked = await first.listLockedIdentities();
  assert.equal(locked.length, 1);
  assert.equal(locked[0]?.issuer, "issuer");
  assert.equal(locked[0]?.subjectHash.length, 64);
  assert.equal("stableUserId" in (locked[0] ?? {}), false);
  assert.equal(await first.unlockIdentity({ issuer: "issuer", subject: "person@example.invalid" }), true);
  assert.deepEqual(await first.listLockedIdentities(), []);
  const { rows } = await pool.query<{ locked_at: Date | null; locked_reason: string | null }>(
    "SELECT locked_at, locked_reason FROM external_identities WHERE issuer = $1::text AND subject = $2::text",
    ["issuer", "person@example.invalid"],
  );
  assert.deepEqual(rows[0], { locked_at: null, locked_reason: null });
});

test("Q14L_LOCK migration checks reject malformed ids and half-locked rows", async () => {
  const store = makeStore();
  await store.identities.createForSubject("issuer", "person@example.invalid", {});
  await assert.rejects(pool.query(
    "UPDATE external_identities SET stable_user_id = $1::text WHERE issuer = $2::text",
    ["bad.value", "issuer"],
  ));
  await assert.rejects(pool.query(
    "UPDATE external_identities SET locked_at = $1::timestamptz WHERE issuer = $2::text",
    [new Date(), "issuer"],
  ));
});
