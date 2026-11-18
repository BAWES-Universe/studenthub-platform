import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresStaffMessagesStore, recordWorkSessionDecision, retractWorkSessionDecision } from "@studenthub/db/comms";

const URL = process.env.DATABASE_URL ?? "";
const person = `comms-${randomUUID()}`, other = `comms-${randomUUID()}`, staff = `comms-${randomUUID()}`, org = `comms-${randomUUID()}`;
let pool: pg.Pool, messages: PostgresStaffMessagesStore, feed: PostgresNotificationsStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  const authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: org, name: "Company" }));
  for (const id of [person, other, staff]) await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  messages = new PostgresStaffMessagesStore({ pool });
  feed = new PostgresNotificationsStore({ pool });
});
after(async () => pool.end());

const send = (over: Partial<Parameters<PostgresStaffMessagesStore["send"]>[0]> = {}) =>
  messages.send({ recipientPrincipalId: person, senderPrincipalId: staff, kind: "civil_id_request", body: null, sendKey: randomUUID(), ...over });

test("COMMS_STAFF_MSG_PG a send writes the message and one feed row in the same transaction", async () => {
  const sent = await send({ kind: "message", body: "Bring your contract" });
  assert.equal(sent.status, "sent");
  const id = (sent as { id: string }).id;
  const rows = await pool.query("SELECT kind,subject_reference,parameters,dedupe_key FROM notifications WHERE recipient_principal_id=$1 AND subject_reference=$2", [person, `staff_message:${id}`]);
  assert.deepEqual(rows.rows, [{ kind: "staff.message", subject_reference: `staff_message:${id}`, parameters: {}, dedupe_key: `staff_message:${id}` }]);
  const [item] = await feed.list(person, 25, 0);
  assert.equal(item?.kind, "staff.message");
  assert.deepEqual(await feed.readStaffMessages(person, [id]), [{ id, kind: "message", body: "Bring your contract" }]);
});

test("COMMS_STAFF_MSG_PG a repeat send key is already_sent with no second row; a reused key is refused", async () => {
  const sendKey = randomUUID();
  const first = await send({ sendKey });
  assert.equal(first.status, "sent");
  assert.deepEqual(await send({ sendKey }), { status: "already_sent", id: (first as { id: string }).id });
  const count = await pool.query("SELECT count(*)::int n FROM staff_messages WHERE send_key=$1", [sendKey]);
  assert.equal(count.rows[0].n, 1);
  assert.deepEqual(await send({ sendKey, kind: "message", body: "different" }), { status: "send_key_conflict" });
  assert.deepEqual(await send({ sendKey, recipientPrincipalId: other }), { status: "send_key_conflict" });
  assert.deepEqual(await send({ sendKey, kind: "profile_photo_request" }), { status: "send_key_conflict" });
  const feedRows = await pool.query("SELECT count(*)::int n FROM notifications WHERE subject_reference=$1", [`staff_message:${(first as { id: string }).id}`]);
  assert.equal(feedRows.rows[0].n, 1);
});

test("COMMS_STAFF_MSG_PG an unknown recipient writes nothing", async () => {
  const sendKey = randomUUID();
  assert.deepEqual(await send({ sendKey, recipientPrincipalId: `missing-${randomUUID()}` }), { status: "recipient_not_found" });
  const count = await pool.query("SELECT count(*)::int n FROM staff_messages WHERE send_key=$1", [sendKey]);
  assert.equal(count.rows[0].n, 0);
});

test("COMMS_FEED_STAFF_PG messages are read only by their recipient and counted as unread until read", async () => {
  const before = await feed.countVisibleUnread(person);
  const sent = await send({ kind: "profile_photo_request" });
  const id = (sent as { id: string }).id;
  assert.equal(await feed.countVisibleUnread(person), before + 1);
  assert.deepEqual(await feed.readStaffMessages(other, [id]), []);
  const rows = await feed.list(person, 100, 0);
  const row = rows.find(r => r.subjectReference === `staff_message:${id}`)!;
  assert.equal(await feed.markRead(other, row.id), false);
  assert.equal(await feed.markRead(person, row.id), true);
  assert.equal(await feed.countVisibleUnread(person), before);
});

test("COMMS_FEED_STAFF_PG unread count adds organization and staff rows from one query", async () => {
  const authz = new PostgresAuthzStore(pool);
  await authz.grantMany(other, [{ orgId: org, role: "org-owner" }]);
  await feed.record({ recipientPrincipalId: other, kind: "organization.status_changed", subjectReference: `organization:${org}`, parameters: { status: "active" }, dedupeKey: `r-${randomUUID()}` });
  await send({ recipientPrincipalId: other });
  assert.equal(await feed.countVisibleUnread(other), 2);
  await feed.markAllRead(other);
  assert.equal(await feed.countVisibleUnread(other), 0);
});

test("COMMS_STAFF_MSG_SCHEMA payload rules are closed per kind", async () => {
  const sent = await send();
  const id = (sent as { id: string }).id;
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'staff.message',$2,'{\"text\":\"stored\"}'::jsonb,$3)", [person, `staff_message:${id}`, `x-${randomUUID()}`]));
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'staff.message',$2,'{}'::jsonb,$3)", [person, `organization:${org}`, `x-${randomUUID()}`]));
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'chat.message',$2,'{}'::jsonb,$3)", [person, `staff_message:${id}`, `x-${randomUUID()}`]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'civil_id_request','text',$3)", [person, staff, randomUUID()]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'message',NULL,$3)", [person, staff, randomUUID()]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'message',' padded ',$3)", [person, staff, randomUUID()]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'message',$3,$4)", [person, staff, "x".repeat(1001), randomUUID()]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'civil_id_request',NULL,'not-a-uuid')", [person, staff]));
});

test("COMMS_WORK_DECISION_PG a decision inside the caller's transaction is recorded once, rolled back with it, and retracted on undo", async () => {
  const workPerson = `comms-${randomUUID()}`;
  await new PostgresAuthzStore(pool).registerPrincipal(createPrincipal({ id: workPerson, pbuuids: [], email: `${workPerson}@example.invalid` }));
  const notice = { personPrincipalId: workPerson, sessionId: randomUUID(), decisionId: randomUUID(), decision: "approved" as const, workDate: "2026-11-10" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordWorkSessionDecision(client, { ...notice, decisionId: randomUUID() });
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await recordWorkSessionDecision(client, notice);
    await recordWorkSessionDecision(client, notice);
    await client.query("COMMIT");
  } finally { client.release(); }
  const rows = await feed.list(workPerson, 25, 0);
  assert.deepEqual(rows.map(r => [r.kind, r.subjectReference, r.parameters]), [["work.session_approved", `work_session:${notice.sessionId}`, { workDate: "2026-11-10" }]]);
  assert.equal(await feed.countVisibleUnread(workPerson), 1);
  await retractWorkSessionDecision(pool, { personPrincipalId: other, decisionId: notice.decisionId });
  assert.equal(await feed.countVisibleUnread(workPerson), 1);
  await retractWorkSessionDecision(pool, { personPrincipalId: workPerson, decisionId: notice.decisionId });
  assert.deepEqual(await feed.list(workPerson, 25, 0), []);
  await assert.rejects(recordWorkSessionDecision(pool, { ...notice, decisionId: randomUUID(), workDate: "10/11/2026" }));
  await assert.rejects(recordWorkSessionDecision(pool, { ...notice, decisionId: randomUUID(), workDate: "2026-02-29" }));
  await recordWorkSessionDecision(pool, { ...notice, decisionId: randomUUID(), workDate: "2028-02-29" });
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'work.session_approved',$2,'{\"workDate\":null}'::jsonb,$3)", [workPerson, `work_session:${notice.sessionId}`, `x-${randomUUID()}`]));
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'work.session_rejected',$2,$3::jsonb,$4)", [workPerson, `work_session:${notice.sessionId}`, JSON.stringify({ workDate: "2026-11-10", note: "stored" }), `x-${randomUUID()}`]));
});
