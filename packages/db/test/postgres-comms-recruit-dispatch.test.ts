import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresRecruitDispatchStore } from "@studenthub/db/comms";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { EmailOutboxService, FakeEmailPort, type EmailClass } from "../../notifications/src/index.js";
import type { StoredEmailClass } from "../src/postgres-email-outbox-store.js";
import { NotificationsService } from "../../notifications/src/notifications.js";
import { dispatchRecruitThenDeliver } from "../../comms/src/recruit-dispatch.js";
import { emailDeliveryWork } from "../../../apps/worker/src/email-delivery.js";
import { PostgresFiringSpikeStore, PostgresMorningSummaryStore } from "@studenthub/db/reports";

// The outbox store's own class list must be exactly the canonical one (this file stops compiling otherwise).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const OUTBOX_CLASSES_MATCH: Same<StoredEmailClass, EmailClass> = true;

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

// The worker's own email_delivery work (default batch size), with a sender that delivers.
function workerRun(port: FakeEmailPort) {
  const emailStore = new PostgresEmailOutboxStore({ pool });
  return emailDeliveryWork({ recruitDispatch: dispatcher, service: new EmailOutboxService(emailStore, port, true, true),
    summaryStore: new PostgresMorningSummaryStore({ pool }), spikeStore: new PostgresFiringSpikeStore({ pool }), volumeStore: emailStore, alert: () => undefined });
}

test("COMMS_RECRUIT_DISPATCH_PG the worker's email delivery job dispatches first, so with no backlog the invitation email goes out in the same run", async () => {
  await drain();
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const person = await principal("invitee"), req = await request("Run Co", "Runner");
  const inv = await invitation(req.id, person, "sent");
  await outbox("invitation.sent", person, req.id, inv);
  const port = new FakeEmailPort(), run = workerRun(port);
  await run();
  const sent = port.sent.filter(m => m.to === `${person}@example.invalid`);
  assert.deepEqual(sent.map(m => m.subject), ["You’re invited to apply for a job opening"]);
  assert.match(sent[0]!.body, /apply for Runner at Run Co\./);
  // A person who switched the email off still gets the feed item, and no email.
  const quiet = await principal("quiet"), inv2 = await invitation(req.id, quiet, "sent");
  await pool.query("INSERT INTO email_preferences(principal_id,class,enabled) VALUES($1,'recruit.invitation',false)", [quiet]);
  await outbox("invitation.sent", quiet, req.id, inv2);
  await run();
  assert.equal(port.sent.filter(m => m.to === `${quiet}@example.invalid`).length, 0);
  assert.equal((await pool.query("SELECT state FROM email_outbox WHERE idempotency_key=$1", [`recruit.invitation:${inv2}`])).rows[0].state, "suppressed");
  assert.equal((await pool.query("SELECT count(*)::int n FROM notifications WHERE recipient_principal_id=$1 AND kind='recruit.invitation.sent'", [quiet])).rows[0].n, 1);
});

test("COMMS_RECRUIT_DISPATCH_PG every delivery attempt rechecks the invitation: withdrawn before the claim, or answered before a retry, sends nothing", async () => {
  await drain();
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const req = await request("Stale Co", "Clerk");
  const outboxStore = new PostgresEmailOutboxStore({ pool }), port = new FakeEmailPort();
  const service = new EmailOutboxService(outboxStore, port, true, true);
  const state = async (inv: string) => (await pool.query("SELECT state FROM email_outbox WHERE idempotency_key=$1", [`recruit.invitation:${inv}`])).rows[0]?.state;
  // Queued, then withdrawn before any worker claims it.
  const pulled = await principal("pulled"), inv1 = await invitation(req.id, pulled, "sent");
  await outbox("invitation.sent", pulled, req.id, inv1);
  await dispatcher.dispatch(1000, new Date());
  assert.equal(await state(inv1), "pending");
  await pool.query("UPDATE recruit_invitations SET status='withdrawn', answered_at=now() WHERE id=$1", [inv1]);
  await service.processDue(100, new Date());
  assert.equal(await state(inv1), "suppressed");
  // Queued, the first attempt fails and is retried, and the person accepts in between.
  const answered = await principal("answered"), inv2 = await invitation(req.id, answered, "sent");
  await outbox("invitation.sent", answered, req.id, inv2);
  await dispatcher.dispatch(1000, new Date());
  port.result = { ok: false, code: "provider_timeout", safeToRetry: true };
  await service.processDue(100, new Date()).catch(() => undefined);
  assert.equal(await state(inv2), "pending", "waiting for a retry");
  await pool.query("UPDATE recruit_invitations SET status='accepted', answered_at=now() WHERE id=$1", [inv2]);
  port.result = { ok: true };
  const tried = port.sent.length;
  await service.processDue(100, new Date(Date.now() + 3_600_000));
  assert.equal(await state(inv2), "suppressed");
  assert.equal(port.sent.filter(m => m.to === `${pulled}@example.invalid`).length, 0, "the withdrawn invitation was never sent");
  assert.equal(port.sent.slice(tried).filter(m => m.to === `${answered}@example.invalid`).length, 0, "the answered invitation is not retried");
  // Still open at the claim: it is sent.
  const open = await principal("open"), inv3 = await invitation(req.id, open, "sent");
  await outbox("invitation.sent", open, req.id, inv3);
  await dispatcher.dispatch(1000, new Date());
  await pool.query("UPDATE recruit_invitations SET status='seen' WHERE id=$1", [inv3]);
  await service.processDue(100, new Date(Date.now() + 3_600_000));
  assert.equal(await state(inv3), "sent");
});

test("COMMS_RECRUIT_DISPATCH_PG an invitation whose request closed is not emailed: closed before dispatch, or after queueing but before the claim; the feed item stays", async () => {
  await drain();
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const outboxStore = new PostgresEmailOutboxStore({ pool }), port = new FakeEmailPort();
  const service = new EmailOutboxService(outboxStore, port, true, true);
  const state = async (inv: string) => (await pool.query("SELECT state FROM email_outbox WHERE idempotency_key=$1", [`recruit.invitation:${inv}`])).rows[0]?.state;
  const feed = async (who: string) => Number((await pool.query("SELECT count(*) n FROM notifications WHERE recipient_principal_id=$1 AND kind='recruit.invitation.sent'", [who])).rows[0].n);
  // Closed before dispatch: the feed item is written, no email is queued.
  const early = await request("Early Co", "Clerk"), a = await principal("early"), invA = await invitation(early.id, a, "sent");
  await outbox("invitation.sent", a, early.id, invA);
  await pool.query("UPDATE recruit_requests SET status='closed', close_reason='cancelled' WHERE id=$1", [early.id]);
  await dispatcher.dispatch(1000, new Date());
  assert.equal(await feed(a), 1);
  assert.equal(await state(invA), undefined, "no email queued for a closed request");
  // Queued while open, then filled before any worker claims it.
  const late = await request("Late Co", "Clerk"), b = await principal("late"), invB = await invitation(late.id, b, "sent");
  await outbox("invitation.sent", b, late.id, invB);
  await dispatcher.dispatch(1000, new Date());
  assert.equal(await state(invB), "pending");
  await pool.query("UPDATE recruit_requests SET status='filling' WHERE id=$1", [late.id]);
  await pool.query("UPDATE recruit_requests SET status='filled' WHERE id=$1", [late.id]);
  // Control: a still-open (filling) request is sent in the same run.
  const live = await request("Live Co", "Clerk"), c = await principal("live"), invC = await invitation(live.id, c, "sent");
  await outbox("invitation.sent", c, live.id, invC);
  await dispatcher.dispatch(1000, new Date());
  await pool.query("UPDATE recruit_requests SET status='filling' WHERE id=$1", [live.id]);
  await service.processDue(100, new Date());
  assert.equal(await state(invB), "suppressed");
  assert.equal(await feed(b), 1, "the feed item stays");
  assert.equal(await state(invC), "sent");
  assert.deepEqual(port.sent.map(m => m.to), [`${c}@example.invalid`], "only the open request's invitation reached the sender");
});

test("COMMS_RECRUIT_DISPATCH_PG a failed dispatch writes nothing, delivery still runs, the error is reported, and the rows dispatch on a later run", async () => {
  await drain();
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const outboxStore = new PostgresEmailOutboxStore({ pool }), port = new FakeEmailPort();
  const service = new EmailOutboxService(outboxStore, port, true, true);
  // An email already queued by an earlier run, which this run must still deliver.
  const req = await request("Broken Co", "Clerk"), other = await principal("other"), otherInv = await invitation(req.id, other, "sent");
  await pool.query("INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key) VALUES('recruit.invitation', $1, $2::jsonb, $3)",
    [other, JSON.stringify({ position: "Clerk", company: "Broken Co" }), `recruit.invitation:${otherInv}`]);
  const person = await principal("broken"), inv = await invitation(req.id, person, "sent");
  const row = await outbox("invitation.sent", person, req.id, inv);
  // The feed insert for this person fails, so the whole dispatch transaction fails.
  const fn = `rd_fail_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.recipient_principal_id = '${person}' THEN RAISE EXCEPTION 'injected dispatch failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(dispatchRecruitThenDeliver(dispatcher, () => service.processDue(100, new Date())), /injected dispatch failure/);
  } finally {
    await pool.query(`DROP TRIGGER ${fn} ON notifications`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  }
  assert.deepEqual(port.sent.map(m => m.to), [`${other}@example.invalid`], "delivery ran despite the failed dispatch");
  assert.equal((await pool.query("SELECT dispatched_at FROM recruit_outbox WHERE id=$1::bigint", [row])).rows[0].dispatched_at, null, "the row still waits");
  assert.equal(Number((await pool.query("SELECT count(*) n FROM notifications WHERE recipient_principal_id=$1", [person])).rows[0].n), 0, "nothing was half-written");
  // The next run dispatches it and sends its email.
  await dispatchRecruitThenDeliver(dispatcher, () => service.processDue(100, new Date()));
  assert.notEqual((await pool.query("SELECT dispatched_at FROM recruit_outbox WHERE id=$1::bigint", [row])).rows[0].dispatched_at, null);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM notifications WHERE recipient_principal_id=$1 AND kind='recruit.invitation.sent'", [person])).rows[0].n), 1);
  assert.deepEqual(port.sent.map(m => m.to), [`${other}@example.invalid`, `${person}@example.invalid`]);
});

test("COMMS_RECRUIT_DISPATCH_PG behind a backlog of older mail larger than one delivery batch, the invitation email waits its turn and goes out on the next run, exactly once", async () => {
  await drain();
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  // 25 older due emails of another class share the queue: exactly one default batch.
  const backlog: string[] = [];
  for (let i = 0; i < 25; i++) {
    const who = await principal(`backlog${i}`);
    await pool.query(`INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key, next_attempt_at)
      VALUES('account.notice', $1, $2::jsonb, $3, now() - interval '1 hour' + make_interval(secs => $4::int))`,
      [who, JSON.stringify({ heading: "Notice", message: "Older mail." }), `rd-backlog:${who}`, i]);
    backlog.push(`${who}@example.invalid`);
  }
  const req = await request("Backlog Co", "Clerk"), person = await principal("behind"), inv = await invitation(req.id, person, "sent");
  await outbox("invitation.sent", person, req.id, inv);
  const port = new FakeEmailPort(), run = workerRun(port), mine = `${person}@example.invalid`;
  const state = async () => (await pool.query("SELECT state FROM email_outbox WHERE idempotency_key=$1", [`recruit.invitation:${inv}`])).rows[0]?.state;
  await run();
  assert.deepEqual(port.sent.filter(m => backlog.includes(m.to)).map(m => m.to).sort(), [...backlog].sort(), "run 1 delivers the older batch");
  assert.equal(await state(), "pending", "run 1 queued the invitation email behind it");
  assert.equal(port.sent.filter(m => m.to === mine).length, 0, "and did not send it ahead of older mail");
  await run();
  assert.equal(await state(), "sent");
  assert.equal(port.sent.filter(m => m.to === mine).length, 1, "run 2 sends it, once");
  await run();
  assert.equal(port.sent.filter(m => m.to === mine).length, 1, "and never again");
  assert.equal(port.sent.filter(m => backlog.includes(m.to)).length, 25, "the older mail went out once each");
});
