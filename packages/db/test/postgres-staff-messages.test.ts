import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresStaffMessagesStore } from "@studenthub/db/comms";

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
  messages.send({ recipientPrincipalId: person, senderPrincipalId: staff, kind: "civil_id_request", body: null, sendKey: `k-${randomUUID()}`, ...over });

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
  const sendKey = `k-${randomUUID()}`;
  const first = await send({ sendKey });
  assert.equal(first.status, "sent");
  assert.deepEqual(await send({ sendKey }), { status: "already_sent", id: (first as { id: string }).id });
  const count = await pool.query("SELECT count(*)::int n FROM staff_messages WHERE send_key=$1", [sendKey]);
  assert.equal(count.rows[0].n, 1);
  assert.deepEqual(await send({ sendKey, recipientPrincipalId: other }), { status: "send_key_conflict" });
  assert.deepEqual(await send({ sendKey, kind: "profile_photo_request" }), { status: "send_key_conflict" });
  const feedRows = await pool.query("SELECT count(*)::int n FROM notifications WHERE subject_reference=$1", [`staff_message:${(first as { id: string }).id}`]);
  assert.equal(feedRows.rows[0].n, 1);
});

test("COMMS_STAFF_MSG_PG an unknown recipient writes nothing", async () => {
  const sendKey = `k-${randomUUID()}`;
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
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'civil_id_request','text',$3)", [person, staff, `k-${randomUUID()}`]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'message',NULL,$3)", [person, staff, `k-${randomUUID()}`]));
  await assert.rejects(pool.query("INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key) VALUES($1,$2,'message',' padded ',$3)", [person, staff, `k-${randomUUID()}`]));
});
