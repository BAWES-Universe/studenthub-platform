import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { PostgresEmailOutboxStore, runMigrations } from "@studenthub/db";
import { EMAIL_OVERDUE_MINUTES } from "../src/postgres-email-outbox-store.js";

// Synthetic principals and messages only, in a schema of its own.
const url = process.env.DATABASE_URL;
let admin: pg.Pool, pool: pg.Pool, schema: string;
const NOW = new Date("2026-11-27T09:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `email_summary_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  await pool.query("INSERT INTO principals(id,email) VALUES ('p1','synthetic@example.invalid')");
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

/** One message in `state`, queued `createdMinutesAgo` and due `dueMinutesAgo`, with attempts at the given minutes ago. */
async function message(state: string, createdMinutesAgo: number, dueMinutesAgo: number, attempts: readonly { outcome: string; minutesAgo: number }[] = []) {
  const id = randomUUID();
  await pool.query(`INSERT INTO email_outbox(id,class,recipient_principal_id,template_parameters,idempotency_key,state,attempts,next_attempt_at,created_at)
    VALUES($1,'account.notice','p1','{"heading":"Private heading","message":"Private text"}',$2,$3,$4,$5,$6)`,
    [id, `k-${id}`, state, attempts.length, ago(dueMinutesAgo), ago(createdMinutesAgo)]);
  for (const [i, a] of attempts.entries())
    await pool.query("INSERT INTO email_attempts(message_id,class,attempt_number,outcome,failure_code,at) VALUES($1,'account.notice',$2,$3,$4,$5)",
      [id, i + 1, a.outcome, a.outcome === "failed" ? "provider_timeout" : null, ago(a.minutesAgo)]);
}

test("OPS_EMAIL_PG waiting and overdue are pending or sending messages; attempts are the 24 hours up to now by outcome", async () => {
  const store = new PostgresEmailOutboxStore({ pool });
  assert.deepEqual(await store.deliverySummary(NOW), { waiting: 0, overdue: 0, oldestWaitingSince: null, last24Hours: { sent: 0, failed: 0, not_sent: 0, suppressed: 0 } }, "an empty outbox");
  assert.equal(EMAIL_OVERDUE_MINUTES, 15);
  await message("pending", 120, EMAIL_OVERDUE_MINUTES + 1, [{ outcome: "failed", minutesAgo: 30 }]); // waiting, overdue, the oldest; one failed attempt
  await message("sending", 20, EMAIL_OVERDUE_MINUTES); // waiting; due exactly 15 minutes ago is not overdue yet
  await message("pending", 5, -10); // waiting, due in the future
  await message("sent", 2000, 2000, [{ outcome: "failed", minutesAgo: 24 * 60 }, { outcome: "sent", minutesAgo: 24 * 60 - 1 }]); // exactly 24 hours ago is outside, a minute later is inside
  await message("failed", 60, 60, [{ outcome: "failed", minutesAgo: 50 }, { outcome: "failed", minutesAgo: 40 }]);
  await message("not_sent", 10, 10, [{ outcome: "not_sent", minutesAgo: 9 }]);
  await message("suppressed", 10, 10, [{ outcome: "suppressed", minutesAgo: -1 }]); // after now: not counted
  const summary = await store.deliverySummary(NOW);
  assert.deepEqual(summary, { waiting: 3, overdue: 1, oldestWaitingSince: ago(120), last24Hours: { sent: 1, failed: 3, not_sent: 1, suppressed: 0 } });
  assert.equal(JSON.stringify(summary).includes("Private"), false, "no message content is read");
  assert.equal(JSON.stringify(summary).includes("synthetic@"), false, "no address is read");
});
