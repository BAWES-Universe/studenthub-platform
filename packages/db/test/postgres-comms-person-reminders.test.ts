import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresPersonRemindersStore, type PersonReminderKind as StoredKind } from "@studenthub/db/comms";
import { PostgresBankDetailsStore } from "@studenthub/db";
import { bankReminderEligible } from "../src/comms/postgres-person-reminders-store.js";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { EmailOutboxService, FakeEmailPort } from "../../notifications/src/index.js";
import { queuePersonRemindersThenDeliver, type PersonReminderKind } from "../../comms/src/person-reminders.js";
import { emailDeliveryWork } from "../../../apps/worker/src/email-delivery.js";
import { PostgresRecruitDispatchStore } from "@studenthub/db/comms";
import { PostgresFiringSpikeStore, PostgresMorningSummaryStore } from "@studenthub/db/reports";

// The schedule's kinds must be exactly the store's (this file stops compiling otherwise).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const REMINDER_KINDS_MATCH: Same<StoredKind, PersonReminderKind> = true;

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresPersonRemindersStore, company: string, storeId: string, creator: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresPersonRemindersStore({ pool });
  company = `pr-co-${randomUUID()}`; storeId = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: company, name: company }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [storeId, company, "a".repeat(64)]);
  creator = await principal("creator");
});
after(async () => pool.end());

async function principal(prefix: string, email = true) {
  const id = `pr-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], ...(email ? { email: `${id}@example.invalid` } : {}) }));
  return id;
}
const profile = (id: string, name: string | null, birth: string | null) => pool.query(`INSERT INTO person_profiles(principal_id,display_name,display_name_written_at,birth_date,birth_date_written_at)
  VALUES($1,$2,CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,$3::date,CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)`, [id, name, birth]);
const civil = (id: string, expiry: string) => pool.query("INSERT INTO person_civil_ids(principal_id,expiry_date) VALUES($1,$2)", [id, expiry]);
const assign = (id: string, start: string, end: string | null) => pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
  VALUES($1,$2,$3,$4,'{}',$5,$6,'staff',$7)`, [randomUUID(), id, company, storeId, start, end, creator]);
const pause = (id: string) => pool.query("INSERT INTO account_pauses(id,principal_id,paused_by,reason,suspended_grants,suspended_stores) VALUES($1,$2,$3,'Away for now','[]','[]')", [randomUUID(), id, creator]);
const queued = async (cls: string, day: string, ids: string[]) => (await pool.query<{ recipient_principal_id: string; template_parameters: unknown; state: string }>(
  "SELECT recipient_principal_id, template_parameters, state FROM email_outbox WHERE class=$1 AND idempotency_key LIKE $2 AND recipient_principal_id = ANY($3) ORDER BY recipient_principal_id",
  [cls, `${cls}:${day}:%`, ids])).rows;
const fresh = (kind: string, day: string) => pool.query("DELETE FROM person_reminder_runs WHERE kind=$1 AND day=$2", [kind, day]);

test("COMMS_PERSON_REMINDERS_PG birthday: everyone whose birthday it is, once, by first name; 29 February is wished on the 28th in other years", async () => {
  const day = "2031-03-07"; await fresh("birthday", day);
  const sara = await principal("sara"), noName = await principal("noname"), other = await principal("other"), paused = await principal("paused"), noEmail = await principal("noemail", false), leap = await principal("leap");
  await profile(sara, "Sara Al-Ali", "2004-03-07"); await profile(noName, null, "1999-03-07"); await profile(other, "Omar Saleh", "2004-03-08");
  await profile(paused, "Paused Person", "2004-03-07"); await pause(paused); await profile(noEmail, "No Mail", "2004-03-07"); await profile(leap, "Leap Year", "2004-02-29");
  const ids = [sara, noName, other, paused, noEmail, leap];
  assert.ok((await store.sendDay("birthday", day, new Date())) as number >= 2);
  const rows = await queued("person.birthday", day, ids);
  assert.deepEqual(rows.map(r => [r.recipient_principal_id, r.template_parameters]), [[noName, { name: "" }], [sara, { name: "Sara" }]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  assert.equal(await store.sendDay("birthday", day, new Date()), null, "a day is queued once");
  const feb = "2031-02-28"; await fresh("birthday", feb);
  await store.sendDay("birthday", feb, new Date());
  assert.deepEqual((await queued("person.birthday", feb, ids)).map(r => r.recipient_principal_id), [leap], "not a leap year: 29 February on the 28th");
  const leapYear = "2032-02-28"; await fresh("birthday", leapYear);
  await store.sendDay("birthday", leapYear, new Date());
  assert.deepEqual(await queued("person.birthday", leapYear, ids), [], "in a leap year, on the 29th only");
});

test("COMMS_PERSON_REMINDERS_PG civil ID expired today and expiring within 25 days go to placed people only", async () => {
  const day = "2031-05-15"; await fresh("civil_id_expired", day); await fresh("civil_id_expiring", day);
  const today = await principal("today"), soon = await principal("soon"), past = await principal("past"), later = await principal("later"), unplaced = await principal("unplaced"), ended = await principal("ended"), released = await principal("released");
  await profile(today, "Today Person", null); await civil(today, day); await assign(today, "2031-01-01", null);
  await profile(soon, "Soon Person", null); await civil(soon, "2031-06-08"); await assign(soon, "2031-01-01", null);
  await civil(past, "2031-01-10"); await assign(past, "2031-01-01", "2031-12-31");
  await civil(later, "2031-06-09"); await assign(later, "2031-01-01", null);
  await civil(unplaced, day);
  await civil(ended, day); await assign(ended, "2031-01-01", "2031-05-14");
  await civil(released, day); await assign(released, "2031-01-01", null); await pool.query("UPDATE person_civil_ids SET released_at=now() WHERE principal_id=$1", [released]);
  const ids = [today, soon, past, later, unplaced, ended, released];
  await store.sendDay("civil_id_expired", day, new Date());
  assert.deepEqual((await queued("person.civil_id_expired", day, ids)).map(r => [r.recipient_principal_id, r.template_parameters]), [[today, { name: "Today" }]]);
  await store.sendDay("civil_id_expiring", day, new Date());
  const expiring = new Map((await queued("person.civil_id_expiring", day, ids)).map(r => [r.recipient_principal_id, r.template_parameters]));
  assert.deepEqual([...expiring.keys()].sort(), [past, soon, today].sort(), "within 25 days (8 June is the last), already expired included, placed only");
  assert.deepEqual(expiring.get(soon), { name: "Soon", expiry: "2031-06-08", status: "expiring" });
  assert.deepEqual(expiring.get(past), { name: "", expiry: "2031-01-10", status: "expired" });
  assert.deepEqual(expiring.get(today), { name: "Today", expiry: day, status: "expiring" });
});

test("COMMS_PERSON_REMINDERS_PG every delivery attempt rechecks: a renewed civil ID, an ended placement, a pause or an opt-out sends nothing", async () => {
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const day = "2031-07-28"; await fresh("civil_id_expiring", day); await fresh("birthday", day);
  const renewed = await principal("renewed"), leaves = await principal("leaves"), stays = await principal("stays"), optedOut = await principal("optout"), bday = await principal("bday");
  for (const id of [renewed, leaves, stays, optedOut]) { await civil(id, "2031-08-01"); await assign(id, "2031-01-01", null); }
  await profile(bday, "Bday Person", "2000-07-28");
  await pool.query("INSERT INTO email_preferences(principal_id,class,enabled) VALUES($1,'person.civil_id_expiring',false)", [optedOut]);
  await store.sendDay("civil_id_expiring", day, new Date()); await store.sendDay("birthday", day, new Date());
  await pool.query("UPDATE person_civil_ids SET expiry_date='2036-08-01' WHERE principal_id=$1", [renewed]);
  await pool.query("UPDATE work_assignments SET end_date='2031-07-20' WHERE person_principal_id=$1", [leaves]);
  await pause(bday);
  const port = new FakeEmailPort();
  await new EmailOutboxService(new PostgresEmailOutboxStore({ pool }), port, true, true).processDue(100, new Date());
  const states = Object.fromEntries((await queued("person.civil_id_expiring", day, [renewed, leaves, stays, optedOut])).map(r => [r.recipient_principal_id, r.state]));
  assert.deepEqual(states, { [renewed]: "suppressed", [leaves]: "suppressed", [stays]: "sent", [optedOut]: "suppressed" });
  assert.equal((await queued("person.birthday", day, [bday]))[0]!.state, "suppressed", "paused after queueing");
  const mail = port.sent.find(m => m.to === `${stays}@example.invalid`)!;
  assert.equal(mail.subject, "Civil ID is expiring");
  assert.match(mail.body, /expires on August 1, 2031\./);
  assert.equal(port.sent.filter(m => [renewed, leaves, optedOut, bday].some(id => m.to === `${id}@example.invalid`)).length, 0);
});

test("COMMS_PERSON_REMINDERS_PG the email delivery job queues what is due from 13:30 Kuwait time, once a day, then delivers", async () => {
  const day = "2031-09-15"; for (const k of ["birthday", "civil_id_expired", "civil_id_expiring", "bank_details_missing"]) await fresh(k, day);
  const person = await principal("job"); await profile(person, "Job Person", "2001-09-15");
  let delivered = 0; const deliver = async () => ++delivered;
  await queuePersonRemindersThenDeliver(store, deliver, () => new Date("2031-09-15T10:29:00Z"));
  assert.deepEqual(await queued("person.birthday", day, [person]), [], "13:29 in Kuwait: not yet");
  await queuePersonRemindersThenDeliver(store, deliver, () => new Date("2031-09-15T10:30:00Z"));
  assert.equal((await queued("person.birthday", day, [person])).length, 1);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM person_reminder_runs WHERE day=$1", [day])).rows[0].n), 4, "the 15th: all four kinds ran");
  await queuePersonRemindersThenDeliver(store, deliver, () => new Date("2031-09-15T18:00:00Z"));
  assert.equal((await queued("person.birthday", day, [person])).length, 1, "and only once");
  assert.equal(delivered, 3, "every run delivers");
});

test("COMMS_PERSON_REMINDERS_PG the worker queues reminders only when it can deliver, so a day is never spent on emails marked not sent", async () => {
  const day = "2031-10-01"; for (const k of ["birthday", "civil_id_expired", "civil_id_expiring", "bank_details_missing"]) await fresh(k, day);
  const person = await principal("worker"); await profile(person, "Worker Person", "1990-10-01");
  const run = (production: boolean, port: FakeEmailPort) => {
    const emailStore = new PostgresEmailOutboxStore({ pool });
    return emailDeliveryWork({ recruitDispatch: new PostgresRecruitDispatchStore({ pool }), placementFeed: { dispatch: async () => 0 }, service: new EmailOutboxService(emailStore, port, production, production),
      summaryStore: new PostgresMorningSummaryStore({ pool }), spikeStore: new PostgresFiringSpikeStore({ pool }), reminders: store, volumeStore: emailStore,
      alert: () => undefined, now: () => new Date("2031-10-01T11:00:00Z") })();
  };
  await run(false, new FakeEmailPort());
  assert.equal(Number((await pool.query("SELECT count(*) n FROM person_reminder_runs WHERE day=$1", [day])).rows[0].n), 0, "a worker that cannot deliver leaves the day due");
  assert.deepEqual(await queued("person.birthday", day, [person]), []);
  const port = new FakeEmailPort();
  for (let i = 0; i < 20 && !port.sent.some(m => m.to === `${person}@example.invalid`); i++) await run(true, port);
  assert.equal((await queued("person.birthday", day, [person]))[0]?.state, "sent");
  assert.equal(port.sent.filter(m => m.to === `${person}@example.invalid`).length, 1);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM person_reminder_runs WHERE day=$1", [day])).rows[0].n), 2, "birthday and expired today; not the 15th or 28th");
});


test("COMMS_PERSON_REMINDERS_PG missing bank details fails closed until a verified address exists: nothing is queued, and the day is still recorded once", async () => {
  const day = "2031-11-15"; await fresh("bank_details_missing", day);
  const missing = await principal("bank-missing"); await profile(missing, "Huda Al-Sabah", null); await assign(missing, "2031-10-01", null);
  assert.equal(await store.sendDay("bank_details_missing", day, new Date()), 0);
  assert.deepEqual(await queued("person.bank_details_missing", day, [missing]), [], "an address on the account is not a verified address");
  assert.equal(await store.sendDay("bank_details_missing", day, new Date()), null, "a day is queued once");
});

test("COMMS_PERSON_REMINDERS_PG a queued bank reminder is suppressed at the claim while no address is verified", async () => {
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const day = "2031-12-28", person = await principal("bank-queued"); await assign(person, "2031-01-01", null);
  await pool.query(`INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key) VALUES('person.bank_details_missing', $1, '{"name":""}', $2)`,
    [person, `person.bank_details_missing:${day}:${person}`]);
  const port = new FakeEmailPort();
  await new EmailOutboxService(new PostgresEmailOutboxStore({ pool }), port, true, true).processDue(100, new Date("2031-12-28T11:00:00Z"));
  assert.equal((await queued("person.bank_details_missing", day, [person]))[0]!.state, "suppressed");
  assert.equal(port.sent.filter(m => m.to === `${person}@example.invalid`).length, 0);
});

test("COMMS_PERSON_REMINDERS_PG with a verified address, the bank rule is placed on the attempt's day and not paused; details are asked of the bank store", async () => {
  const rule = bankReminderEligible(() => "true");
  const placed = await principal("rule-placed"), future = await principal("rule-future"), ended = await principal("rule-ended"), paused = await principal("rule-paused"), unplaced = await principal("rule-unplaced");
  await assign(placed, "2032-01-01", "2032-01-15"); await assign(future, "2032-01-16", null); await assign(ended, "2031-06-01", "2032-01-14"); await assign(paused, "2031-06-01", null); await pause(paused);
  const ids = [placed, future, ended, paused, unplaced];
  const on = async (day: string) => (await pool.query<{ id: string }>(`SELECT q.id FROM principals q WHERE q.id = ANY($1) AND ${rule("q.id", "$2::date")} ORDER BY q.id`, [ids, day])).rows.map(r => r.id);
  assert.deepEqual(await on("2032-01-15"), [placed], "the queue day");
  assert.deepEqual(await on("2032-01-16"), [future].sort(), "an attempt on the next day: the placement that ended on the 15th no longer counts");
  assert.equal(await new PostgresBankDetailsStore({ pool }).countWithoutDetails([placed]), 1);
});
