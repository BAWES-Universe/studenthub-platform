import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";

import { runMigrations } from "../src/migrate.js";
import { PostgresLoginStore } from "../src/postgres-login-store.js";

const connectionString = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
let stores: PostgresLoginStore[] = [];

before(async () => {
  if (!connectionString) throw new Error("DATABASE_URL is required for Postgres stable-id tests");
  pool = new pg.Pool({ connectionString });
  await runMigrations(pool);
});

beforeEach(async () => {
  for (const store of stores) await store.close();
  stores = [];
  await pool.query("TRUNCATE login_sessions, external_identities, principals CASCADE");
});

after(async () => {
  for (const store of stores) await store.close();
  await pool.end();
});

function store(): PostgresLoginStore {
  const result = new PostgresLoginStore({ connectionString });
  stores.push(result);
  return result;
}

async function identity(login: PostgresLoginStore, subject = "student@example.invalid") {
  return login.identities.createForSubject(
    "https://universe.test.invalid", subject, { email: subject },
  );
}

test("Q14L_BIND Postgres binds once and matching stable ids continue", async () => {
  const login = store();
  await identity(login);
  assert.equal(
    await login.identities.bindStableId?.(
      "https://universe.test.invalid", "student@example.invalid", "stable_id_123",
    ),
    "bound",
  );
  assert.equal(
    await login.identities.bindStableId?.(
      "https://universe.test.invalid", "student@example.invalid", "stable_id_123",
    ),
    "matched",
  );
});

test("Q14L_REASSIGN Postgres mismatch revokes sessions and leaves a persistent lock", async () => {
  const login = store();
  const created = await identity(login);
  await login.identities.bindStableId?.(
    created.issuer, created.subject, "original_id_123",
  );
  await login.sessions.put({ id: "existing-session", personId: created.personId });
  assert.equal(
    await login.identities.bindStableId?.(
      created.issuer, created.subject, "different_id_456",
    ),
    "mismatch",
  );
  assert.equal(await login.sessions.get("existing-session"), undefined);
  assert.equal(
    await login.identities.bindStableId?.(
      created.issuer, created.subject, "original_id_123",
    ),
    "locked",
  );
  const row = await pool.query(
    "SELECT stable_user_id, locked_reason FROM external_identities WHERE person_id = $1::text",
    [created.personId],
  );
  assert.deepEqual(row.rows[0], {
    stable_user_id: "original_id_123", locked_reason: "stable_id_mismatch",
  });
});

test("Q14L_LOCK concurrent binding locks the loser; reports conceal ids and unlock is complete", async () => {
  const first = store();
  const second = store();
  const created = await identity(first, "concurrent@example.invalid");
  const outcomes = await Promise.all([
    first.identities.bindStableId?.(created.issuer, created.subject, "first_stable_123"),
    second.identities.bindStableId?.(created.issuer, created.subject, "second_stable_456"),
  ]);
  assert.ok(outcomes.includes("bound"));
  assert.ok(outcomes.includes("mismatch"));

  const locked = await first.listLockedIdentities();
  assert.equal(locked.length, 1);
  assert.equal(locked[0]?.personId, created.personId);
  assert.match(locked[0]?.subjectHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal("stableUserId" in (locked[0] ?? {}), false);
  assert.equal(await first.unlockIdentity({ issuer: created.issuer, subject: created.subject }), true);
  const lockColumns = await pool.query(
    "SELECT locked_at, locked_reason FROM external_identities WHERE person_id = $1::text",
    [created.personId],
  );
  assert.deepEqual(lockColumns.rows[0], { locked_at: null, locked_reason: null });
});

test("Q14L_LOCK migration is discoverable at its assigned lane number", async () => {
  const files = await readdir(new URL("../../../../packages/db/migrations/", import.meta.url));
  assert.ok(files.includes("0226_external_identity_stable_id.sql"));
});
