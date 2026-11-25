import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { PostgresMorningSummaryStore } from "@studenthub/db/reports";
import { EmailOutboxService, FakeEmailPort, validateTemplateParameters } from "../../notifications/src/index.js";
import { MorningSummaryService } from "../../reports/src/index.js";
import { PostgresTransferInvoiceEffects } from "@studenthub/db/billing";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS = `ms-ops-${randomUUID()}`;
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresMorningSummaryStore;
let company: string, storeId: string, creator: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS, name: "Operator" }));
  store = new PostgresMorningSummaryStore({ pool, operatorOrgIds: [OPS] });
  company = `ms-co-${randomUUID()}`; storeId = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: company, name: company }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [storeId, company, "a".repeat(64)]);
  creator = await principal("creator");
});
after(async () => pool.end());

async function principal(prefix: string, grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `ms-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants as never);
  return id;
}
const request = async (status: string, org = company, store = storeId) => {
  const id = randomUUID();
  await pool.query(`INSERT INTO recruit_requests(id,org_id,store_id,created_by_principal_id,position_title,description,compensation_text,position_type,headcount,status,close_reason)
    VALUES($1,$2,$3,$4,'Cashier','Front till','3 KWD an hour','part_time',1,$5,$6)`, [id, org, store, creator, status, status === "closed" ? "cancelled" : null]);
  return id;
};
const interview = async (requestId: string, at: string, status = "scheduled") => {
  const card = randomUUID();
  await pool.query("INSERT INTO recruit_pipeline_cards(id,request_id,person_principal_id,stage) VALUES($1,$2,$3,'interviewing')", [card, requestId, await principal("candidate")]);
  await pool.query("INSERT INTO recruit_interviews(id,card_id,scheduled_at,duration_minutes,mode,status,closed_at) VALUES($1,$2,$3,30,'phone',$4,$5)",
    [randomUUID(), card, at, status, status === "scheduled" ? null : at]);
};
// A far past Kuwait day nobody else writes interviews for.
const someDay = () => new Date(Date.UTC(1972, 0, 1) + Math.floor(Math.random() * 18_000) * 86_400_000).toISOString().slice(0, 10);
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// A day (with its neighbours) that no earlier run, queued summary or interview fixture holds, reserved for this suite.
const reserved = new Set<string>();
async function freshDay(): Promise<string> {
  for (;;) {
    const day = someDay();
    if ([-1, 0, 1].some(d => reserved.has(shift(day, d)))) continue;
    const { rows: [row] } = await pool.query<{ taken: boolean }>(`SELECT EXISTS (SELECT 1 FROM morning_summary_runs WHERE day BETWEEN $1::date - 1 AND $1::date + 1)
      OR EXISTS (SELECT 1 FROM email_outbox WHERE idempotency_key LIKE 'staff.morning_summary:' || $1 || ':%')
      OR EXISTS (SELECT 1 FROM recruit_interviews WHERE scheduled_at >= ($1::date - 2)::timestamp AND scheduled_at < ($1::date + 3)::timestamp) AS taken`, [day]);
    if (row!.taken) continue;
    for (const d of [-1, 0, 1]) reserved.add(shift(day, d));
    return day;
  }
}

test("REPORTS_MORNING_SUMMARY_PG interviews scheduled on the Kuwait day, for a request still open", async () => {
  const day = await freshDay(), prev = shift(day, -1), next = shift(day, 1);
  const open = await request("open"), filling = await request("filling");
  const n = async () => (await store.counts(day)).interviewScheduledToday;
  assert.equal(await n(), 0);
  await interview(open, `${prev}T21:00:00Z`); // 00:00 in Kuwait: counts
  await interview(filling, `${day}T20:59:59Z`); // 23:59:59 in Kuwait: counts
  assert.equal(await n(), 2);
  await interview(open, `${prev}T20:59:59Z`); // the day before in Kuwait
  await interview(await request("open"), `${day}T21:00:00Z`); // the next Kuwait day
  await interview(await request("open"), `${day}T09:00:00Z`, "cancelled");
  await interview(await request("open"), `${day}T09:00:00Z`, "completed");
  assert.equal(await n(), 2, "other days, cancelled and completed interviews do not count");
  assert.equal((await store.counts(next)).interviewScheduledToday, 1);
  // A request that is filled or closed no longer needs the meeting organised.
  const filled = await request("filling");
  await interview(filled, `${day}T10:00:00Z`);
  assert.equal(await n(), 3);
  await pool.query("UPDATE recruit_requests SET status='filled' WHERE id=$1", [filled]);
  assert.equal(await n(), 2);
});

test("REPORTS_MORNING_SUMMARY_PG active requests are open or filling, for KWD companies (no currency means KWD)", async () => {
  const day = await freshDay(), n = async () => (await store.counts(day)).activeRequests;
  const base = await n();
  await request("open"); await request("filling");
  assert.equal(await n(), base + 2);
  await request("draft"); await request("closed");
  const filled = await request("filling"); await pool.query("UPDATE recruit_requests SET status='filled' WHERE id=$1", [filled]);
  assert.equal(await n(), base + 2, "draft, filled and closed requests are not active");
  const usd = `ms-usd-${randomUUID()}`, usdStore = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: usd, name: usd }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Mall',$3,$3)", [usdStore, usd, "a".repeat(64)]);
  await pool.query("INSERT INTO organization_commercial_terms(org_id,field,value) VALUES($1,'currency_code','USD')", [usd]);
  await request("open", usd, usdStore);
  assert.equal(await n(), base + 2, "a company billed in another currency is not counted, as legacy");
  await pool.query("UPDATE organization_commercial_terms SET value='KWD' WHERE org_id=$1 AND field='currency_code'", [usd]);
  assert.equal(await n(), base + 3);
});

test("REPORTS_MORNING_SUMMARY_PG assigned people whose civil ID expired before the day", async () => {
  const day = "2026-11-19", n = async () => (await store.counts(day)).assignedExpiredCivilID;
  const base = await n();
  const civil = (id: string, expiry: string | null) => pool.query("INSERT INTO person_civil_ids(principal_id,expiry_date) VALUES($1,$2)", [id, expiry]);
  const assign = (id: string, start: string, end: string | null) => pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
    VALUES($1,$2,$3,$4,'{}',$5,$6,'staff',$7)`, [randomUUID(), id, company, storeId, start, end, creator]);
  const expiredOpen = await principal("a"), expiredFuture = await principal("b"), expiredEnded = await principal("c"), validAssigned = await principal("d"), expiredUnassigned = await principal("e"), expiresToday = await principal("f");
  await civil(expiredOpen, "2026-11-18"); await assign(expiredOpen, "2026-01-01", null);
  await civil(expiredFuture, "2025-01-01"); await assign(expiredFuture, "2026-12-01", "2026-12-31");
  assert.equal(await n(), base + 2, "a current or upcoming assignment with an expired civil ID counts");
  await civil(expiredEnded, "2026-01-01"); await assign(expiredEnded, "2026-01-01", "2026-11-18");
  await civil(validAssigned, "2027-01-01"); await assign(validAssigned, "2026-01-01", null);
  await civil(expiredUnassigned, "2026-01-01");
  await civil(expiresToday, day); await assign(expiresToday, "2026-01-01", null);
  assert.equal(await n(), base + 2, "an ended assignment, a valid ID, nobody assigned and an ID expiring today do not count");
  await pool.query("UPDATE person_civil_ids SET released_at=now() WHERE principal_id=$1", [expiredOpen]);
  assert.equal(await n(), base + 1, "a released civil ID is not counted");
});

test("REPORTS_MORNING_SUMMARY_PG the email goes once a day to subscribed staff who are still staff and not paused", async () => {
  const staff = await principal("staff", [{ orgId: OPS, role: "staff", scope: "subtree" }]);
  const admin = await principal("admin", [{ orgId: OPS, role: "admin", scope: "subtree" }]);
  const quiet = await principal("quiet", [{ orgId: OPS, role: "staff", scope: "subtree" }]);
  const former = await principal("former");
  const selfOnly = await principal("self", [{ orgId: OPS, role: "staff", scope: "self" }]);
  const paused = await principal("paused", [{ orgId: OPS, role: "staff", scope: "subtree" }]);
  const service = new MorningSummaryService(store, { async isStaff() { return true; } });
  for (const id of [staff, admin, former, selfOnly, paused]) await service.subscribe(id, true);
  await service.subscribe(staff, true);
  await pool.query("INSERT INTO account_pauses(id,principal_id,paused_by,reason,suspended_grants,suspended_stores) VALUES($1,$2,$3,'Away for now','[]','[]')", [randomUUID(), paused, creator]);
  const mine = new Set([staff, admin, quiet, former, selfOnly, paused]);
  assert.deepEqual((await store.recipients()).filter(id => mine.has(id)).sort(), [admin, staff].sort());

  const day = await freshDay(), at = new Date(`${day}T05:00:00Z`);
  const build = (raw: Readonly<Record<string, number>>) => MorningSummaryService.parameters(day, raw);
  const sent = await store.sendDay(day, at, build);
  assert.equal(sent?.recipients, (await store.recipients()).length);
  const rows = (await pool.query("SELECT recipient_principal_id, template_parameters, state, idempotency_key FROM email_outbox WHERE class='staff.morning_summary' AND idempotency_key LIKE $1", [`staff.morning_summary:${day}:%`])).rows;
  assert.deepEqual(rows.map(r => r.recipient_principal_id).filter(id => mine.has(id)).sort(), [admin, staff].sort());
  for (const r of rows) {
    assert.equal(r.idempotency_key, `staff.morning_summary:${day}:${r.recipient_principal_id}`);
    assert.equal(r.state, "pending");
    assert.doesNotThrow(() => validateTemplateParameters("staff.morning_summary", r.template_parameters));
    assert.equal(typeof r.template_parameters.counters.missingBankInfo, "number");
  }
  const [run] = (await pool.query("SELECT counters, recipients FROM morning_summary_runs WHERE day=$1::date", [day])).rows;
  assert.equal(run.recipients, rows.length);
  assert.equal(typeof run.counters.missingBankInfo, "number");
  assert.equal(await store.sendDay(day, at, build), null, "a day is sent once");
  assert.equal((await pool.query("SELECT count(*)::int n FROM email_outbox WHERE idempotency_key LIKE $1", [`staff.morning_summary:${day}:%`])).rows[0].n, rows.length);
  await assert.rejects(pool.query("UPDATE morning_summary_runs SET recipients=0 WHERE day=$1::date", [day]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM morning_summary_runs WHERE day=$1::date", [day]), /append-only/);

  // Parameters that do not validate send nothing and leave the day due.
  const failing = await freshDay();
  await assert.rejects(store.sendDay(failing, at, () => { throw new TypeError("invalid closed email template parameters"); }), /closed/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM morning_summary_runs WHERE day=$1::date", [failing])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM email_outbox WHERE idempotency_key LIKE $1", [`staff.morning_summary:${failing}:%`])).rows[0].n, 0);

  // Turning it off takes them out of the next send.
  await service.subscribe(staff, false);
  assert.equal(await store.isSubscribed(staff), false);
  assert.equal(await store.isSubscribed(admin), true);
  assert.deepEqual((await store.recipients()).filter(id => mine.has(id)), [admin]);
  await assert.rejects(store.sendDay("not-a-day", at, build), RangeError);
  // Keep the shared database's outbox free of these test emails.
  await pool.query("UPDATE email_outbox SET state='not_sent' WHERE idempotency_key LIKE 'staff.morning_summary:%' AND state='pending' AND recipient_principal_id LIKE 'ms-%'");
});

test("REPORTS_MORNING_SUMMARY_PG every delivery attempt rechecks the recipient: unsubscribed, no longer staff or paused after queueing is suppressed, never sent", async () => {
  // Park what other suites left, so this claim only sees this test's rows; the db suite runs one file at a time.
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const grant = [{ orgId: OPS, role: "staff", scope: "subtree" as const }];
  const [kept, left, demoted, paused] = [await principal("kept", grant), await principal("left", grant), await principal("demoted", grant), await principal("paused2", grant)];
  const service = new MorningSummaryService(store, { async isStaff() { return true; } });
  for (const id of [kept, left, demoted, paused]) await service.subscribe(id, true);
  const day = await freshDay();
  await store.sendDay(day, new Date(`${day}T05:00:00Z`), raw => MorningSummaryService.parameters(day, raw));
  await service.subscribe(left, false);
  await pool.query("DELETE FROM grants WHERE principal_id=$1", [demoted]);
  await pool.query("INSERT INTO account_pauses(id,principal_id,paused_by,reason,suspended_grants,suspended_stores) VALUES($1,$2,$3,'Away for now','[]','[]')", [randomUUID(), paused, creator]);
  const port = new FakeEmailPort(), outbox = new PostgresEmailOutboxStore({ pool, operatorOrgIds: [OPS] });
  await new EmailOutboxService(outbox, port, true, true).processDue(100, new Date());
  const states = Object.fromEntries((await pool.query("SELECT recipient_principal_id, state FROM email_outbox WHERE idempotency_key LIKE $1", [`staff.morning_summary:${day}:%`])).rows.map(r => [r.recipient_principal_id, r.state]));
  assert.deepEqual([kept, left, demoted, paused].map(id => states[id]), ["sent", "suppressed", "suppressed", "suppressed"]);
  const mine = new Set([kept, left, demoted, paused].map(id => `${id}@example.invalid`)), delivered = port.sent.filter(m => mine.has(m.to));
  assert.deepEqual(delivered.map(m => m.to), [`${kept}@example.invalid`]);
  assert.equal(delivered[0]?.subject.startsWith("Morning Report for "), true);
});

// Synthetic companies under the operator, assignments, and transfers moved through the pay lane's own lifecycle.
async function payCompany(parent: string = OPS, currency?: string): Promise<{ id: string; shop: string }> {
  const id = `ms-pay-${randomUUID()}`, shop = randomUUID();
  await authz.upsertOrganization(createOrganization({ id, name: id, parentOrgId: parent }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Mall',$3,$3)", [shop, id, "a".repeat(64)]);
  if (currency) await pool.query("INSERT INTO organization_commercial_terms(org_id,field,value) VALUES($1,'currency_code',$2)", [id, currency]);
  return { id, shop };
}
async function placed(org: { id: string; shop: string }, start: string, end: string | null = null): Promise<string> {
  const person = await principal("worker");
  await pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
    VALUES($1,$2,$3,$4,'{}',$5,$6,'staff',$7)`, [randomUUID(), person, org.id, org.shop, start, end, creator]);
  return person;
}
async function paid(org: { id: string; shop: string }, person: string, month: string, at: string, ...actions: TransferAction[]): Promise<string> {
  return paidIn("KWD", org, person, month, at, ...actions);
}
async function paidIn(currency: string, org: { id: string; shop: string }, person: string, month: string, at: string, ...actions: TransferAction[]): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3::date,($3::date + interval '1 month' - interval '1 day')::date,$4)", [id, org.id, `${month}-01`, currency]);
  await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,$5,'1.000','2.000','synthetic','{}')",
    [`line-${randomUUID()}`, id, person, org.shop, currency]);
  const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
  const lifecycle = new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date(at));
  for (const action of actions) assert.equal((await lifecycle.transition({ principalId: creator, actingAs: false }, id, action)).kind, "changed", action);
  return id;
}
const linesPaid = (transfer: string) => pool.query("UPDATE pay_transfer_lines SET paid = true WHERE transfer_id = $1", [transfer]);

test("REPORTS_MORNING_SUMMARY_PG payment counters: KWD companies with staff for 40 days and no payment received in the 40 days to the report day; people placed over two months with no paid line for a pay period ended in the last two months", async () => {
  const day = "2026-11-20";
  const read = async () => { const c = await store.counts(day); return [c.companyMoreThen40DaysWithoutPayment!, c.assignedIdleCandidates!] as const; };
  const [companiesBefore, idleBefore] = await read();
  const unpaid = await payCompany();
  await placed(unpaid, "2026-09-01"); // no transfer at all: counted, and so is the person
  const parent = await payCompany(), sub = await payCompany(parent.id);
  const subWorker = await placed(sub, "2026-09-01");
  await linesPaid(await paid(sub, subWorker, "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received")); // the sub-company's payment counts for its parent; its person was paid
  const late = await payCompany();
  const lateWorker = await placed(late, "2026-08-01"), other = await placed(late, "2026-08-01");
  await paid(late, lateWorker, "2026-08", "2026-09-15T08:00:00Z", "lock", "payment_received"); // received 66 days before: counted; the period ended before the two months
  await paid(late, other, "2026-10", "2026-11-01T08:00:00Z", "cancel"); // a cancelled transfer is not a payment
  await placed(await payCompany(), "2026-11-01"); // staff for under 40 days
  await placed(await payCompany(), "2026-08-01", "2026-11-10"); // no one assigned any more
  await placed(await payCompany(OPS, "USD"), "2026-08-01"); // not KWD (its person is still idle)
  const current = await payCompany(), currentWorker = await placed(current, "2026-08-01");
  await paid(current, currentWorker, "2026-11", "2026-11-05T08:00:00Z", "lock", "payment_received"); // paid this month, but the November period has not ended: still idle
  const gone = await payCompany(), goneSub = await payCompany(gone.id);
  await placed(goneSub, "2026-08-01"); // staff only at a deleted sub-company: the parent has no staff
  const paidByGone = await payCompany(), paidSub = await payCompany(paidByGone.id);
  await placed(paidByGone, "2026-08-01");
  await paid(paidSub, await placed(paidSub, "2026-11-01"), "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received"); // a deleted sub-company's payment does not count
  const unpaidLine = await payCompany(), unpaidLineWorker = await placed(unpaidLine, "2026-08-01");
  await paid(unpaidLine, unpaidLineWorker, "2026-10", "2026-10-31T08:00:00Z", "lock"); // a locked October line not yet paid: still idle, and the company has not paid
  const later = await payCompany(), laterWorker = await placed(later, "2026-08-01");
  await linesPaid(await paid(later, laterWorker, "2026-10", "2026-11-25T08:00:00Z", "lock", "payment_received")); // received after the report day: does not count for 20 November
  for (const org of [goneSub.id, paidSub.id]) await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES($1,$2)", [org, `receipt-${randomUUID()}`]);
  const [companies, idle] = await read();
  assert.deepEqual([companies - companiesBefore, idle - idleBefore], [5, 8]);
});

async function bankDetails(person: string): Promise<void> {
  const bank = randomUUID();
  await pool.query(`INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at)
    VALUES ($1, 'bank', $2, $2, 'active', $3, $3, now(), now())`, [bank, `Synthetic bank ${bank.slice(0, 8)}`, "a".repeat(64)]);
  await pool.query("INSERT INTO candidate_bank_details (principal_id, bank_id, iban, beneficiary_name) VALUES ($1, $2, 'KW81CBKU0000000000001234560101', 'Synthetic Beneficiary')", [person, bank]);
}

test("REPORTS_MORNING_SUMMARY_PG missing bank info: people placed today at a KWD organization, or with an unpaid line on a live KWD transfer being distributed, who have no bank details, each counted once", async () => {
  const day = "2026-11-21";
  const read = async () => (await store.counts(day)).missingBankInfo!;
  const before = await read();
  const kwd = await payCompany(), usd = await payCompany(OPS, "USD");
  await placed(kwd, "2026-10-01"); // placed, no details: counted
  await bankDetails(await placed(kwd, "2026-10-01")); // placed, details on file
  await placed(kwd, "2026-11-21"); // placed from today: counted
  await placed(kwd, "2026-11-22"); // starts tomorrow
  await placed(kwd, "2026-09-01", "2026-11-20"); // ended yesterday
  await placed(usd, "2026-10-01"); // placed at an organization that is not KWD
  const owed = await principal("owed");
  await paid(kwd, owed, "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received"); // unpaid line being distributed, not placed: counted
  const both = await placed(kwd, "2026-10-01");
  await paid(kwd, both, "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received"); // placed and owed: counted once
  await paid(kwd, await principal("locked"), "2026-10", "2026-11-01T08:00:00Z", "lock"); // payment not received yet
  await linesPaid(await paid(kwd, await principal("settled"), "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received")); // line paid
  const owedWithBank = await principal("owed-bank");
  await bankDetails(owedWithBank);
  await paid(kwd, owedWithBank, "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received"); // owed, details on file
  await paid(kwd, await principal("cancelled"), "2026-10", "2026-11-01T08:00:00Z", "cancel"); // cancelled transfer
  await paidIn("USD", usd, await principal("usd"), "2026-10", "2026-11-01T08:00:00Z", "lock", "payment_received"); // owed on a USD transfer
  await paid(kwd, await principal("deleted"), "2026-10", "2026-11-01T08:00:00Z", "lock", "delete"); // deleted transfer (the lifecycle deletes only before payment)
  assert.equal(await read() - before, 4);
});
