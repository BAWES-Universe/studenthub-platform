import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresPayHistoryReads, PostgresTransferInvoiceEffects, candidateWorked } from "@studenthub/db/billing";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// Synthetic companies, stores, people and amounts only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let reads: PostgresPayHistoryReads;
let schema: string;
const actor = { principalId: "pay-actor", actingAs: false };
const store: Record<string, string> = {};
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z"));
const move = async (id: string, ...actions: TransferAction[]) => {
  for (const action of actions) assert.equal((await lifecycle().transition(actor, id, action)).kind, "changed", action);
};
const HOURLY = (hours: string, minutes: number, rate: string) => ({ version: "studenthub.payroll.f2-preview.v1", candidateKey: "k", orgId: "A", contractId: "c",
  input: { rate: { payModel: "hourly", source: "contract", candidateHourlyRate: rate, companyHourlyRate: "9.999" }, hours, minutes, seconds: 0, bonus: "0", transferCost: "7.777", payouts: 1 },
  result: { kind: "calculated", candidateTotal: "1.000", companyTotal: "8.888" } });

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `pay_history_reads_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('A','A legal','root'),('B','B legal','root')");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('A','Alpha Trading'),('B','  ')");
  for (const id of [actor.principalId, "me", "other"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  for (const org of ["A", "B"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$4)", [store[org], org, `${org} mall shop`, "a".repeat(64)]);
  }
  reads = new PostgresPayHistoryReads({ pool });
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

/** A transfer for `company` in month `month` of 2026 with the given lines; returns the transfer id and its line ids in order. */
async function transfer(company: string, month: number, lines: readonly { person: string; total: string; calculation?: unknown }[]): Promise<{ id: string; lines: string[] }> {
  const id = randomUUID(), start = `2026-${String(month).padStart(2, "0")}-01`;
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3,($3::date + interval '1 month' - interval '1 day')::date,'KWD')", [id, company, start]);
  const ids: string[] = [];
  for (const line of lines) {
    const lineId = `line-${randomUUID()}`; ids.push(lineId);
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation)
      VALUES($1,$2,$3,$4,'KWD',$5,'99.000','synthetic',$6)`, [lineId, id, line.person, store[company], line.total, JSON.stringify(line.calculation ?? {})]);
  }
  return { id, lines: ids };
}
const pay = (...lineIds: string[]) => pool.query("UPDATE pay_transfer_lines SET paid = true WHERE id = ANY($1::text[])", [lineIds]);

test("PAY_HISTORY_READS_OWN a person sees only their own paid lines, newest first, with the candidate total", async () => {
  const oct = await transfer("A", 10, [{ person: "me", total: "120.500" }, { person: "other", total: "80.000" }]);
  const nov = await transfer("B", 11, [{ person: "me", total: "60.250" }]);
  await pay(...oct.lines, ...nov.lines);
  await move(oct.id, "lock", "payment_received", "complete"); await move(nov.id, "lock", "payment_received");
  const page = await reads.list("me", 1);
  assert.deepEqual(page.entries.map(e => [e.lineId, e.companyName, e.storeName, e.periodStart, e.periodEnd, e.currencyCode, e.total, e.status]), [
    [nov.lines[0], "B legal", "B mall shop", "2026-11-01", "2026-11-30", "KWD", "60.250", "paid"],
    [oct.lines[0], "Alpha Trading", "A mall shop", "2026-10-01", "2026-10-31", "KWD", "120.500", "paid"],
  ], "the profile name, or the legal name when it is blank");
  assert.equal(JSON.stringify(page).includes("99.000"), false, "the company total never leaves the store");
  assert.deepEqual([page.page, page.pageCount, page.total], [1, 1, 2]);
  assert.equal(await reads.detail("other", oct.lines[0]!), null, "another person's line is not found");
  assert.deepEqual((await reads.list("other", 1)).entries.map(e => e.total), ["80.000"]);
});

test("PAY_HISTORY_READS_PAID only lines marked paid on a distributing or complete transfer are pay received", async () => {
  const locked = await transfer("A", 7, [{ person: "me", total: "1.000" }]);
  const sent = await transfer("A", 8, [{ person: "me", total: "2.000" }]);
  const unpaid = await transfer("A", 9, [{ person: "me", total: "3.000" }]);
  const done = await transfer("A", 10, [{ person: "me", total: "4.000" }]);
  const deleted = await transfer("B", 6, [{ person: "me", total: "5.000" }]);
  await pay(...locked.lines, ...sent.lines, ...done.lines, ...deleted.lines);
  await move(locked.id, "lock"); await move(sent.id, "lock", "payment_sent");
  await move(unpaid.id, "lock", "payment_received"); await move(done.id, "lock", "payment_received", "complete");
  await move(deleted.id, "lock", "delete");
  assert.deepEqual((await reads.list("me", 1)).entries.map(e => e.total), ["4.000"], "an unpaid line, a transfer not yet received and a deleted transfer are left out");
  for (const line of [...locked.lines, ...sent.lines, ...unpaid.lines, ...deleted.lines]) assert.equal(await reads.detail("me", line), null);
  assert.ok(await reads.detail("me", done.lines[0]!));
});

test("PAY_HISTORY_READS_PAGES ten to a page; a page past the end is empty", async () => {
  const months: { id: string; lines: string[] }[] = [];
  for (let month = 1; month <= 12; month++) months.push(await transfer("A", month, [{ person: "me", total: `${month}.000` }]));
  await pay(...months.flatMap(m => m.lines));
  for (const m of months) await move(m.id, "lock", "payment_received", "complete");
  const first = await reads.list("me", 1), second = await reads.list("me", 2), third = await reads.list("me", 3);
  assert.deepEqual(first.entries.map(e => e.total), ["12.000", "11.000", "10.000", "9.000", "8.000", "7.000", "6.000", "5.000", "4.000", "3.000"]);
  assert.deepEqual(second.entries.map(e => e.total), ["2.000", "1.000"]);
  assert.deepEqual([first.pageCount, second.pageCount, third.entries.length, third.total], [2, 2, 0, 12]);
  await assert.rejects(reads.list("me", 0), /invalid_page/);
});

test("PAY_HISTORY_READS_DETAIL a line shows worked time and the candidate's own rate, never the company's side", async () => {
  const t = await transfer("A", 10, [{ person: "me", total: "36.500", calculation: HOURLY("73", 15, "0.500") }, { person: "me", total: "10.000", calculation: { note: "manual" } }]);
  await pay(...t.lines); await move(t.id, "lock", "payment_received");
  const hourly = await reads.detail("me", t.lines[0]!);
  assert.deepEqual(hourly?.worked, { hours: "73", minutes: 15, hourlyRate: "0.500" });
  assert.equal(hourly?.total, "36.500");
  for (const secret of ["9.999", "7.777", "8.888", "99.000", "companyHourlyRate", "calculation"]) assert.equal(JSON.stringify(hourly).includes(secret), false, secret);
  assert.equal((await reads.detail("me", t.lines[1]!))?.worked, null, "a manual line shows its total only");
});

test("PAY_HISTORY_READS_CALCULATION only a well-formed hourly F2 calculation yields worked time", () => {
  const good = HOURLY("8", 30, "1.250");
  assert.deepEqual(candidateWorked(good), { hours: "8", minutes: 30, hourlyRate: "1.250" });
  for (const bad of [null, "x", {}, { ...good, version: "other" }, { ...good, input: { ...good.input, rate: { ...good.input.rate, payModel: "monthly_salary" } } },
    { ...good, input: { ...good.input, hours: 8 } }, { ...good, input: { ...good.input, minutes: 60 } }, { ...good, input: { ...good.input, minutes: 1.5 } },
    { ...good, input: { ...good.input, rate: { ...good.input.rate, candidateHourlyRate: "<b>" } } }]) assert.equal(candidateWorked(bad), null, JSON.stringify(bad));
});
