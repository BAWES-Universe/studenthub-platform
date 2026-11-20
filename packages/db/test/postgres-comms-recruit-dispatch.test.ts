import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresRecruitDispatchStore } from "@studenthub/db/comms";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { EmailOutboxService, FakeEmailPort } from "../../notifications/src/index.js";
import { NotificationsService } from "../../notifications/src/notifications.js";
import { dispatchRecruitThenDeliver } from "../../comms/src/recruit-dispatch.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS = `rd-ops-${randomUUID()}`;
let pool: pg.Pool, authz: PostgresAuthzStore, dispatcher: PostgresRecruitDispatchStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS, name: "Operator" }));
  dispatcher = new PostgresRecruitDispatchStore({ pool });
});
after(async () => pool.end());

async function principal(prefix: string) {
  const id = `rd-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
async function request(company: string, title: string) {
  const orgId = `rd-co-${randomUUID()}`, storeId = randomUUID(), id = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: orgId, name: company, parentOrgId: OPS }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Mall',$3,$3)", [storeId, orgId, "a".repeat(64)]);
  await pool.query(`INSERT INTO recruit_requests(id,org_id,store_id,position_title,description,compensation_text,position_type,headcount,status)
    VALUES($1,$2,$3,$4,'d','3 KWD an hour','part_time',1,'open')`, [id, orgId, storeId, title]);
  return { id, orgId };
}
async function invitation(requestId: string, person: string, status: "sent" | "accepted" | "withdrawn") {
  const id = randomUUID();
  await pool.query(`INSERT INTO recruit_invitations(id,request_id,person_principal_id,status,answered_at) VALUES($1,$2,$3,$4,$5)`,
    [id, requestId, person, status, status === "sent" ? null : new Date()]);
  return id;
}
const outbox = async (kind: string, recipient: string, requestId: string, subject: string) =>
  (await pool.query<{ id: string }>("INSERT INTO recruit_outbox(kind,recipient_principal_id,request_id,subject_id,dedupe_key) VALUES($1,$2,$3,$4,$5) RETURNING id::text", [kind, recipient, requestId, subject, `${kind}:${subject}`])).rows[0]!.id;
async function drain() { let total = 0; for (let n; (n = await dispatcher.dispatch(1000, new Date())) > 0;) total += n; return total; }

test("COMMS_RECRUIT_DISPATCH_PG each recruit event reaches its recipient once: a feed item, and a sent invitation still open is emailed", async () => {
  await drain();
  const person = await principal("person"), recruiter = await principal("recruiter");
  const req = await request("Sultan Co", "Cashier");
  const open = await invitation(req.id, person, "sent"), taken = await invitation(req.id, await principal("other"), "accepted");
  const pulled = await invitation((await request("Other Co", "Barista")).id, person, "withdrawn");
  const ids = [await outbox("invitation.sent", person, req.id, open), await outbox("invitation.accepted", recruiter, req.id, taken)];
  const pulledReq = (await pool.query<{ request_id: string }>("SELECT request_id::text FROM recruit_invitations WHERE id=$1", [pulled])).rows[0]!.request_id;
  ids.push(await outbox("invitation.sent", person, pulledReq, pulled), await outbox("invitation.withdrawn", person, pulledReq, pulled));
  assert.ok(await drain() >= 4);
  assert.equal(await dispatcher.dispatch(1000, new Date()), 0, "nothing left");
  const dispatched = (await pool.query("SELECT count(*)::int n FROM recruit_outbox WHERE id = ANY($1::bigint[]) AND dispatched_at IS NOT NULL", [ids])).rows[0].n;
  assert.equal(dispatched, 4);
  const feed = (await pool.query("SELECT recipient_principal_id, kind, subject_reference FROM notifications WHERE subject_reference = ANY($1::text[]) ORDER BY subject_reference", [ids.map(i => `recruit_outbox:${i}`)])).rows;
  assert.deepEqual(feed.map(r => [r.recipient_principal_id, r.kind]).sort(), [[person, "recruit.invitation.sent"], [person, "recruit.invitation.sent"], [person, "recruit.invitation.withdrawn"], [recruiter, "recruit.invitation.accepted"]].sort());
  const mail = (await pool.query("SELECT recipient_principal_id, template_parameters, idempotency_key FROM email_outbox WHERE class = 'recruit.invitation' AND recipient_principal_id = $1", [person])).rows;
  assert.deepEqual(mail, [{ recipient_principal_id: person, template_parameters: { position: "Cashier", company: "Sultan Co" }, idempotency_key: `recruit.invitation:${open}` }], "the withdrawn invitation is not emailed");

  // The feed renders each item from the request as it is now, and the bell counts the same items.
  const store = PostgresNotificationsStore.connect({ pool }), feedService = new NotificationsService(store, store, authz);
  await pool.query("UPDATE organizations SET name = 'Sultan Group' WHERE id = $1", [req.orgId]);
  const page = await feedService.list(person, 1, ["recruit.invitation.sent", "recruit.invitation.withdrawn"]);
  assert.deepEqual(page.items.map(i => [i.text, i.href]).sort(), [
    ["You're invited to apply for Barista at Other Co.", "/recruit/invitations"],
    ["You're invited to apply for Cashier at Sultan Group.", "/recruit/invitations"],
    ["Your invitation to Barista at Other Co was withdrawn.", "/recruit/invitations"]]);
  assert.equal(await feedService.count(person), 3);
  const theirs = await feedService.list(recruiter);
  assert.deepEqual(theirs.items.map(i => i.text), ["An invitation to Cashier at Sultan Group was accepted."]);
  assert.equal(await feedService.count(recruiter), 1);
  // Someone else's event is never shown, even under a forged row in their own feed.
  await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'recruit.invitation.sent',$2,'{}','forged')", [recruiter, `recruit_outbox:${ids[0]}`]);
  assert.deepEqual((await feedService.list(recruiter)).items.length, 1);
  assert.equal(await feedService.count(recruiter), 1);
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'recruit.invitation.sent','recruit_outbox:x','{}','bad')", [person]), /notifications_kind_payload_check/);
  await assert.rejects(pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'recruit.invitation.sent','recruit_outbox:1','{\"text\":\"x\"}','bad')", [person]), /notifications_kind_payload_check/);
});

test("COMMS_RECRUIT_DISPATCH_PG the email delivery job dispatches first, so the invitation email goes out in the same run", async () => {
  await drain();
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const person = await principal("invitee"), req = await request("Run Co", "Runner");
  const inv = await invitation(req.id, person, "sent");
  await outbox("invitation.sent", person, req.id, inv);
  const port = new FakeEmailPort();
  const service = new EmailOutboxService(new PostgresEmailOutboxStore({ pool }), port, true, true);
  await dispatchRecruitThenDeliver(dispatcher, () => service.processDue(100, new Date()));
  const sent = port.sent.filter(m => m.to === `${person}@example.invalid`);
  assert.deepEqual(sent.map(m => m.subject), ["You’re invited to apply for a job opening"]);
  assert.match(sent[0]!.body, /apply for Runner at Run Co\./);
  // A person who switched the email off still gets the feed item, and no email.
  const quiet = await principal("quiet"), inv2 = await invitation(req.id, quiet, "sent");
  await pool.query("INSERT INTO email_preferences(principal_id,class,enabled) VALUES($1,'recruit.invitation',false)", [quiet]);
  await outbox("invitation.sent", quiet, req.id, inv2);
  await dispatchRecruitThenDeliver(dispatcher, () => service.processDue(100, new Date()));
  assert.equal(port.sent.filter(m => m.to === `${quiet}@example.invalid`).length, 0);
  assert.equal((await pool.query("SELECT state FROM email_outbox WHERE idempotency_key=$1", [`recruit.invitation:${inv2}`])).rows[0].state, "suppressed");
  assert.equal((await pool.query("SELECT count(*)::int n FROM notifications WHERE recipient_principal_id=$1 AND kind='recruit.invitation.sent'", [quiet])).rows[0].n, 1);
});
