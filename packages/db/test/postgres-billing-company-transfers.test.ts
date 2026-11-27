import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PAY_HISTORY_CALCULATION_VERSION, PostgresTransferInvoiceEffects, PostgresTransferInvoiceReads } from "@studenthub/db/billing";
import { transferInvoiceReadDecision } from "../../billing/src/transfer-invoice-access.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// O-13 company transfers. Synthetic companies, stores, people and amounts only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let reads: PostgresTransferInvoiceReads;
let schema: string;
const store: Record<string, string> = {};
const actor = { principalId: "staff", actingAs: false };
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const move = async (id: string, ...actions: TransferAction[]) => {
  const lifecycle = new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z"));
  for (const action of actions) assert.equal((await lifecycle.transition(actor, id, action)).kind, "changed", action);
};
const grant = (principal: string, org: string, role: string, scope: "self" | "subtree" = "self") =>
  pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES($1,$2,$3,$4)", [principal, org, role, scope]);
const hourly = (hours: string, minutes: number) => JSON.stringify({ version: PAY_HISTORY_CALCULATION_VERSION,
  input: { hours, minutes, rate: { payModel: "hourly", candidateHourlyRate: "1.250", companyHourlyRate: "2.000" } }, result: { candidateTotal: "9.999" } });

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `company_transfers_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  // The operator org "root" sits above every company: P with sub-company C1, and X.
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P legal','root'),('C1','C1','P'),('X','X','root')");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('P','Parent Trading Co')");
  for (const id of ["fin-p", "self-p", "fin-c1", "staff", "recruiter", "op-fin", "w1", "w2"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query("UPDATE principals SET display_name = 'Account Name' WHERE id = 'w1'");
  await pool.query("INSERT INTO person_profiles(principal_id,display_name,display_name_written_at) VALUES ('w1','Amal Synthetic',now())");
  for (const org of ["P", "C1", "X"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$4)", [store[org], org, `Shop ${org}`, "a".repeat(64)]);
  }
  reads = new PostgresTransferInvoiceReads({ pool, decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, ["root"]) });
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

async function transfer(company: string, period: [string, string], lines: readonly { person: string; org: string; candidate: string; company: string; calculation?: string; paid?: boolean }[],
  ...actions: TransferAction[]): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3,$4,'KWD')", [id, company, ...period]);
  for (const line of lines) {
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation,paid)
      VALUES($1,$2,$3,$4,'KWD',$5,$6,'synthetic',$7,$8)`, [randomUUID(), id, line.person, store[line.org], line.candidate, line.company, line.calculation ?? "{}", line.paid ?? false]);
  }
  await move(id, ...actions);
  return id;
}

test("COMPANY_TRANSFERS_LIST a company reader sees its transfers newest period first, with what it owes; never another company's or a deleted one", async () => {
  const october = await transfer("P", ["2026-10-01", "2026-10-31"], [{ person: "w1", org: "P", candidate: "8.000", company: "10.500" }, { person: "w2", org: "C1", candidate: "1.000", company: "2.250" }],
    "lock", "payment_received");
  const november = await transfer("P", ["2026-11-01", "2026-11-30"], []);
  const gone = await transfer("P", ["2026-09-01", "2026-09-30"], [{ person: "w1", org: "P", candidate: "1.000", company: "1.000" }], "lock", "delete");
  await transfer("X", ["2026-10-01", "2026-10-31"], [{ person: "w1", org: "X", candidate: "1.000", company: "3.000" }], "lock");
  await grant("fin-p", "P", "finance", "subtree");
  const page = await reads.companyTransfers("fin-p", "P");
  assert.ok(page);
  assert.equal(page.name, "Parent Trading Co");
  assert.deepEqual(page.transfers.map(t => [t.transferId, t.orgId, t.companyName, t.periodStart, t.periodEnd, t.currencyCode, t.status, t.lineCount, t.personCount, t.companyTotal, t.paymentReceivedOn]), [
    [november, "P", "Parent Trading Co", "2026-11-01", "2026-11-30", "KWD", "draft", 0, 0, "0.000", null],
    [october, "P", "Parent Trading Co", "2026-10-01", "2026-10-31", "KWD", "distributing", 2, 2, "12.750", "2026-11-22"],
  ], "the deleted transfer and company X's are not listed");
  assert.equal(await reads.companyTransfers("fin-p", "X"), null);
  assert.equal(await reads.companyTransfer("fin-p", "P", gone), null, "a deleted transfer is not found");
});

test("COMPANY_TRANSFERS_DETAIL a line shows who, where, worked time and the company total; never the candidate's total, rates or calculation", async () => {
  const id = await transfer("P", ["2026-10-01", "2026-10-31"], [
    { person: "w1", org: "P", candidate: "8.000", company: "10.500", calculation: hourly("5", 15), paid: true },
    { person: "w2", org: "C1", candidate: "1.000", company: "2.250" },
  ], "lock");
  await grant("self-p", "P", "org-owner");
  const detail = await reads.companyTransfer("self-p", "P", id);
  assert.ok(detail);
  assert.equal(detail.companyTotal, "12.750");
  assert.deepEqual(detail.lines.map(({ lineId: _, ...line }) => line), [
    { personName: "Amal Synthetic", storeName: "Shop P", worked: { hours: "5", minutes: 15 }, companyTotal: "10.500", paid: true },
    { personName: "w2", storeName: "Shop C1", worked: null, companyTotal: "2.250", paid: false },
  ], "the profile name first, the id when there is no name; worked time only for an hourly line");
  const text = JSON.stringify(detail);
  for (const hidden of ["8.000", "1.000", "1.250", "2.000", "9.999", "candidate"]) assert.ok(!text.includes(hidden), `the company never sees ${hidden}`);
});

test("COMPANY_TRANSFERS_REFUSED recruiters, operator-level finance, other companies, the wrong company id and deleted companies all answer null", async () => {
  const id = await transfer("P", ["2026-10-01", "2026-10-31"], [{ person: "w1", org: "P", candidate: "1.000", company: "2.000" }], "lock");
  const child = await transfer("C1", ["2026-10-01", "2026-10-31"], [{ person: "w2", org: "C1", candidate: "1.000", company: "2.000" }], "lock");
  await grant("recruiter", "P", "recruiter", "subtree"); await grant("op-fin", "root", "finance", "subtree"); await grant("fin-c1", "C1", "finance");
  await grant("self-p", "P", "org-owner"); await grant("staff", "root", "staff", "subtree");
  assert.equal(await reads.companyTransfers("recruiter", "P"), null);
  assert.equal(await reads.companyTransfers("op-fin", "P"), null, "StudentHub finance reads no company's transfers through this page");
  assert.equal(await reads.companyTransfers("fin-c1", "P"), null, "a sub-company cannot read its parent");
  assert.deepEqual((await reads.companyTransfers("fin-c1", "C1"))?.transfers.map(t => t.transferId), [child]);
  assert.equal(await reads.companyTransfer("fin-c1", "C1", id), null, "nor its parent's transfer through its own page");
  assert.deepEqual((await reads.companyTransfers("self-p", "P"))?.transfers.map(t => t.transferId), [id], "a self grant does not reach the sub-company's transfers");
  assert.equal(await reads.companyTransfer("self-p", "P", child), null);
  assert.equal((await reads.companyTransfers("staff", "P"))?.transfers.length, 2, "StudentHub staff reach every company through root");
  assert.equal(await reads.companyTransfer("staff", "P", "missing"), null);
  await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES ('C1','synthetic-receipt')");
  assert.equal(await reads.companyTransfers("fin-c1", "C1"), null, "a deleted company answers null");
  assert.equal((await reads.companyTransfers("staff", "P"))?.transfers.length, 1, "and drops out of its parent's list");
});
