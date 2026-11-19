import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { EMAIL_CLASSES, EMAIL_TEMPLATES, validateTemplateParameters } from "../../notifications/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const person = `email2-${randomUUID()}`, staff = `email2-${randomUUID()}`;
let pool: pg.Pool, store: PostgresEmailOutboxStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  const authz = new PostgresAuthzStore(pool);
  for (const id of [person, staff]) await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  store = new PostgresEmailOutboxStore({ pool });
});
after(async () => pool.end());

const decide = (client: pg.Pool | pg.PoolClient, decision: "confirmed" | "rejected", reason: string | null = null) => {
  const id = randomUUID();
  return client.query(`INSERT INTO civil_id_review_decisions(id,subject_principal_id,reviewer_principal_id,decision,reason,civil_revision,confirm_ref) VALUES($1,$2,$3,$4,$5,1,$6)`,
    [id, person, staff, decision, reason, createHash("sha256").update(id).digest("hex")]).then(() => id);
};
const outbox = (id: string) => pool.query("SELECT class,recipient_principal_id,template_parameters,state FROM email_outbox WHERE idempotency_key=$1", [`civil_id.result:${id}`]).then(r => r.rows);

test("COMMS_EMAIL_CLASSES_PG the database class table matches the templates, and a transactional class cannot be switched off", async () => {
  const rows = (await pool.query("SELECT class,transactional FROM email_classes ORDER BY class")).rows;
  assert.deepEqual(rows, EMAIL_CLASSES.map(c => ({ class: c, transactional: EMAIL_TEMPLATES[c].required })).sort((a, b) => a.class.localeCompare(b.class)));
  await assert.rejects(pool.query("INSERT INTO email_preferences(principal_id,class,enabled) VALUES($1,'civil_id.result',false)", [person]), /cannot be switched off/);
  await pool.query("INSERT INTO email_preferences(principal_id,class,enabled) VALUES($1,'account.notice',false) ON CONFLICT DO NOTHING", [person]);
  await assert.rejects(pool.query("UPDATE email_preferences SET class='civil_id.result' WHERE principal_id=$1", [person]), /cannot be switched off/);
  await assert.rejects(pool.query("INSERT INTO email_preferences(principal_id,class,enabled) VALUES($1,'no.such',true)", [person]), /foreign key/);
  await assert.rejects(pool.query("INSERT INTO email_outbox(class,recipient_principal_id,template_parameters,idempotency_key) VALUES('no.such',$1,'{}',$2)", [person, randomUUID()]), /foreign key/);
});

test("COMMS_EMAIL_CIVIL_ID_RESULT_PG a staff decision queues its result email in the same transaction, once", async () => {
  const confirmed = await decide(pool, "confirmed");
  assert.deepEqual(await outbox(confirmed), [{ class: "civil_id.result", recipient_principal_id: person, template_parameters: { decision: "confirmed" }, state: "pending" }]);
  const rejected = await decide(pool, "rejected", "The back photo is missing");
  const [row] = await outbox(rejected);
  assert.deepEqual(row?.template_parameters, { decision: "rejected", reason: "The back photo is missing" });
  // What the database writes is what the template accepts.
  assert.doesNotThrow(() => validateTemplateParameters("civil_id.result", row?.template_parameters));
  const c = await pool.connect();
  let rolledBack: string;
  try { await c.query("BEGIN"); rolledBack = await decide(c, "confirmed"); await c.query("ROLLBACK"); } finally { c.release(); }
  assert.deepEqual(await outbox(rolledBack), []);
});

test("COMMS_EMAIL_DELIVERY_LOG_PG staff see each email's class, state and attempts, never the address or text", async () => {
  const decision = await decide(pool, "rejected", "Unreadable");
  const [{ id }] = (await pool.query("SELECT id FROM email_outbox WHERE idempotency_key=$1", [`civil_id.result:${decision}`])).rows;
  // Two tries, as the worker records them: a provider timeout, then a send.
  const at1 = new Date("2026-11-19T06:00:00Z"), at2 = new Date("2026-11-19T06:05:00Z");
  await pool.query("UPDATE email_outbox SET state='sending',attempts=1 WHERE id=$1", [id]);
  await store.complete(id, "civil_id.result", 1, "failed", "provider_timeout", new Date("2026-11-19T06:01:00Z"), at1);
  await pool.query("UPDATE email_outbox SET state='sending',attempts=2 WHERE id=$1", [id]);
  await store.complete(id, "civil_id.result", 2, "sent", null, null, at2);
  const log = await store.deliveryLog(person, 0, 50);
  assert.ok(log);
  assert.equal(log.total, (await pool.query("SELECT count(*)::int n FROM email_outbox WHERE recipient_principal_id=$1", [person])).rows[0].n);
  const entry = log.rows.find(r => r.id === id);
  assert.ok(entry);
  assert.deepEqual({ ...entry, createdAt: undefined }, { id, emailClass: "civil_id.result", state: "sent", createdAt: undefined, sentAt: at2,
    attempts: [{ attempt: 1, outcome: "failed", failureCode: "provider_timeout", at: at1 }, { attempt: 2, outcome: "sent", failureCode: null, at: at2 }] });
  const text = JSON.stringify(log);
  assert.equal(text.includes("@example.invalid"), false);
  assert.equal(text.includes("Unreadable"), false);
  assert.equal(await store.deliveryLog(`email2-missing-${randomUUID()}`, 0, 50), null);
  assert.deepEqual((await store.deliveryLog(person, 0, 1))?.rows.length, 1);
  assert.deepEqual((await store.deliveryLog(person, log.total, 50))?.rows, []);
});

test("COMMS_EMAIL_VOLUME_PG each level of the Kuwait day is recorded once and the next day starts again", async () => {
  // A past day nobody else writes to (after 1970, when Kuwait was already UTC+3 all year), so the shared database's other sends do not count.
  const day = new Date(Date.UTC(1971, 0, 2) + Math.floor(Math.random() * 18_000) * 86_400_000).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const [{ id }] = (await pool.query("INSERT INTO email_outbox(class,recipient_principal_id,template_parameters,idempotency_key,state) VALUES('account.notice',$1,'{\"heading\":\"H\",\"message\":\"M\"}',$2,'sent') RETURNING id", [person, randomUUID()])).rows;
  let n = 0;
  const sendAt = async (count: number, at: string) => { for (let i = 0; i < count; i++) await pool.query("INSERT INTO email_attempts(message_id,class,attempt_number,outcome,at) VALUES($1,'account.notice',$2,'sent',$3)", [id, ++n, at]); };
  // 21:00Z the day before is 00:00 in Kuwait, so it counts for `day`; 20:59Z does not.
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await sendAt(3, `${prev}T21:00:00Z`);
  await sendAt(5, `${prev}T20:59:59Z`);
  assert.equal(await store.recordVolumeCrossing(day, 3, new Date()), null, "3 sends do not pass a threshold of 3");
  await sendAt(1, `${day}T12:00:00Z`);
  assert.deepEqual(await store.recordVolumeCrossing(day, 3, new Date()), { day, level: 1, sentCount: 4, threshold: 3 });
  assert.equal(await store.recordVolumeCrossing(day, 3, new Date()), null, "level 1 alerts once");
  await sendAt(3, `${day}T20:59:59Z`);
  assert.deepEqual(await store.recordVolumeCrossing(day, 3, new Date()), { day, level: 2, sentCount: 7, threshold: 3 });
  await sendAt(4, `${day}T21:00:00Z`);
  assert.deepEqual(await store.recordVolumeCrossing(next, 3, new Date()), { day: next, level: 1, sentCount: 4, threshold: 3 });
  await pool.query("INSERT INTO email_attempts(message_id,class,attempt_number,outcome,failure_code,at) VALUES($1,'account.notice',$2,'failed','provider_timeout',$3)", [id, ++n, `${day}T12:00:00Z`]);
  assert.equal(await store.recordVolumeCrossing(day, 3, new Date()), null, "failed attempts are not sends");
  await assert.rejects(store.recordVolumeCrossing("not-a-day", 3, new Date()), RangeError);
  await assert.rejects(store.recordVolumeCrossing(day, 0, new Date()), RangeError);
});
