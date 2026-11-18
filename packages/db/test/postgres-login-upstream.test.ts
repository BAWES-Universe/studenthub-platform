import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { PostgresLoginStore, runMigrations } from "@studenthub/db";
import type { SessionStore } from "@studenthub/login-contract";
import { confirmingSessions } from "../../../apps/gateway/src/login-application.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
let store: PostgresLoginStore;

before(async () => {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the Postgres upstream-session tests");
  pool = new pg.Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  store = new PostgresLoginStore({ connectionString: databaseUrl });
});

after(async () => {
  await store.close();
  await pool.end();
});

const NOW = Math.floor(Date.now() / 1000);

async function person(): Promise<string> {
  const id = `a5-${randomUUID()}`;
  await pool.query("INSERT INTO principals (id) VALUES ($1)", [id]);
  return id;
}

test("SHU457_RECORD migration 0404 adds the reference and the three times to login_sessions and nothing else", async () => {
  const { rows } = await pool.query<{ column_name: string; is_nullable: string; data_type: string }>(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'login_sessions' ORDER BY ordinal_position`,
  );
  assert.deepEqual(rows.map((row) => [row.column_name, row.is_nullable, row.data_type]), [
    ["id", "NO", "text"], ["person_id", "NO", "text"], ["expires_at", "NO", "timestamp with time zone"],
    ["upstream_session_ref", "YES", "text"], ["last_confirmed_at", "YES", "timestamp with time zone"], ["last_checked_at", "YES", "timestamp with time zone"],
    ["last_settled_at", "YES", "timestamp with time zone"],
  ]);
});

test("SHU457_RECORD a session keeps the reference and its times, and one without stays as before", async () => {
  const personId = await person();
  const withRef = randomUUID(), plain = randomUUID();
  await store.sessions.put({ id: withRef, personId, upstreamReference: "sid-1", lastCheckedAt: NOW, lastConfirmedAt: NOW });
  await store.sessions.put({ id: plain, personId });
  assert.deepEqual(await store.sessions.get(withRef), { id: withRef, personId, upstreamReference: "sid-1", lastCheckedAt: NOW, lastConfirmedAt: NOW });
  assert.deepEqual(await store.sessions.get(plain), { id: plain, personId });
  const { rows } = await pool.query("SELECT upstream_session_ref, last_checked_at FROM login_sessions WHERE person_id = $1 AND upstream_session_ref IS NULL", [personId]);
  assert.deepEqual(rows, [{ upstream_session_ref: null, last_checked_at: null }]);
  // take deletes and returns the reference in one statement.
  assert.equal((await store.sessions.take!(withRef))?.upstreamReference, "sid-1");
  assert.equal(await store.sessions.get(withRef), undefined);
  assert.equal(await store.sessions.take!(withRef), undefined);
});

test("SHU457_BOUND the conditional claim lets exactly one of many concurrent requests check, and confirm only moves forward", async () => {
  const personId = await person();
  const id = randomUUID();
  await store.sessions.put({ id, personId, upstreamReference: "sid-2", lastCheckedAt: NOW - 900, lastConfirmedAt: NOW - 900 });
  const second = new PostgresLoginStore({ connectionString: databaseUrl });
  try {
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? second : store).sessions.claimUpstreamCheck!(id, NOW - 900, NOW)));
    assert.equal(claims.filter(Boolean).length, 1, "one request wins the right to check");
  } finally {
    await second.close();
  }
  assert.equal((await store.sessions.get(id))?.lastCheckedAt, NOW, "the claim sets last checked");
  assert.equal(await store.sessions.claimUpstreamCheck!(id, NOW - 900, NOW + 1), false, "not again within T");
  assert.equal((await store.sessions.get(id))?.lastConfirmedAt, NOW - 900, "the claim leaves last confirmed");
  await store.sessions.confirmUpstream!(id, NOW);
  await store.sessions.confirmUpstream!(id, NOW - 10);
  assert.equal((await store.sessions.get(id))?.lastConfirmedAt, NOW);
  const plain = randomUUID();
  await store.sessions.put({ id: plain, personId });
  assert.equal(await store.sessions.claimUpstreamCheck!(plain, NOW, NOW), false, "a session without a reference is never claimed");
});

test("SHU457_BOUND a check put on the store applies to every reader of its sessions", async () => {
  const checked = new PostgresLoginStore({ connectionString: databaseUrl });
  try {
    const personId = await person();
    const id = randomUUID();
    await checked.sessions.put({ id, personId, upstreamReference: "sid-3", lastCheckedAt: NOW, lastConfirmedAt: NOW });
    const seen: string[] = [];
    checked.checkSessionsWith((plain: SessionStore) => ({
      ...plain,
      async get(sessionId) { seen.push(sessionId); const session = await plain.get(sessionId); if (session) await plain.delete(sessionId); return undefined; },
    }));
    assert.equal(await checked.sessions.get(id), undefined, "the check decides");
    assert.deepEqual(seen, [id]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM login_sessions WHERE id IS NOT NULL AND person_id = $1", [personId])).rows[0].n, 0);
    assert.equal((checked.sessions as unknown as Record<symbol, unknown>)[Symbol.for("studenthub.login.upstream-confirming")], true);
  } finally {
    await checked.close();
  }
});

test("SHU457_BOUND a reader in another process waits for an in-flight check and never rides on the row", async () => {
  const second = new PostgresLoginStore({ connectionString: databaseUrl });
  const wrap = () => confirmingSessions(store.sessions, {
    upstream: { isActive: async () => "active", end: async () => "ended" } as never,
    clock: { nowEpochSeconds: () => NOW }, boundSeconds: 900, timeoutMs: 200, log: () => undefined,
  });
  const due = async (sid: string) => {
    const id = randomUUID();
    await store.sessions.put({ id, personId: await person(), upstreamReference: sid, lastCheckedAt: NOW - 900, lastConfirmedAt: NOW - 900 });
    assert.equal(await second.sessions.claimUpstreamCheck!(id, NOW - 900, NOW), true, "the other process claims the check");
    return id;
  };
  const later = (ms: number, step: () => Promise<void>) => new Promise<void>((resolve, reject) => setTimeout(() => step().then(resolve, reject), ms));
  try {
    const ended = await due("sid-race-ended");
    const [seen] = await Promise.all([wrap().get(ended), later(100, () => second.sessions.delete(ended))]);
    assert.equal(seen, undefined, "the other process's answer of ended wins");

    const active = await due("sid-race-active");
    const [kept] = await Promise.all([wrap().get(active), later(100, () => second.sessions.confirmUpstream!(active, NOW))]);
    assert.equal(kept?.id, active, "an answer of active lets the reader through");

    const unknown = await due("sid-race-unknown");
    const [after] = await Promise.all([wrap().get(unknown), later(100, () => second.sessions.settleUpstreamCheck!(unknown, NOW))]);
    assert.equal(after?.id, unknown, "a settled unknown answer keeps the session within 2T");

    const stuck = await due("sid-race-stuck");
    assert.equal(await wrap().get(stuck), undefined, "a check that never settles fails closed");
    assert.ok(await store.sessions.get(stuck), "failing closed for one request deletes nothing");
  } finally {
    await second.close();
  }
});

test("SHU457_BOUND a claim that never settled is not a recent answer: refused until T passes, then checked again", async () => {
  let calls = 0;
  const wrapped = confirmingSessions(store.sessions, {
    upstream: { isActive: async () => { calls += 1; return "active"; }, end: async () => "ended" } as never,
    clock: { nowEpochSeconds: () => NOW }, boundSeconds: 900, timeoutMs: 200, log: () => undefined,
  });
  // A process claimed the check a minute ago and died before it answered.
  const dead = randomUUID();
  await store.sessions.put({ id: dead, personId: await person(), upstreamReference: "sid-dead-claim", lastCheckedAt: NOW - 60, lastConfirmedAt: NOW - 120 });
  const started = Date.now();
  assert.equal(await wrapped.get(dead), undefined, "the unanswered claim does not let the request through");
  assert.ok(Date.now() - started < 1_000, "past the wait window it refuses at once");
  assert.ok(await store.sessions.get(dead), "refusing deletes nothing");
  assert.equal(calls, 0, "no second check inside T");

  // Once T has passed since that claim, a new check may be claimed and answers.
  const old = randomUUID();
  await store.sessions.put({ id: old, personId: await person(), upstreamReference: "sid-old-claim", lastCheckedAt: NOW - 901, lastConfirmedAt: NOW - 1000 });
  assert.equal((await wrapped.get(old))?.id, old);
  assert.equal(calls, 1);
});
