import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresTransferInvoiceEffects, PostgresTransferInvoiceReads, listTransferInvoices } from "@studenthub/db/billing";
import { transferInvoiceReadDecision } from "../../billing/src/transfer-invoice-access.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// Synthetic companies, stores, people and amounts only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let reads: PostgresTransferInvoiceReads;
let schema: string;
const actor = { principalId: "inv-actor", actingAs: false };
const store: Record<string, string> = {};
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z"));
const move = async (id: string, action: TransferAction) => assert.equal((await lifecycle().transition(actor, id, action)).kind, "changed", action);
const grant = (principal: string, org: string, role: string, scope: "self" | "subtree" = "self") =>
  pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES($1,$2,$3,$4)", [principal, org, role, scope]);

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `transfer_invoice_reads_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  // The operator org "root" sits above every company: P with sub-companies C1 and C2, and X.
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P legal',  'root'),('C1','C1','P'),('C2','C2','P'),('X','X','root')");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('P','Parent Trading Co'),('C1','  ')");
  for (const id of [actor.principalId, "worker", "fin-p", "owner-p", "fin-c1", "self-p", "staff", "recruiter", "candidate", "fin-x", "op-fin", "op-admin"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  for (const org of ["P", "C1", "C2", "X"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)", [store[org], org, "a".repeat(64)]);
  }
  reads = new PostgresTransferInvoiceReads({ pool, decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, ["root"]) });
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

async function transfer(lines: readonly [org: string, total: string][], company: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-10-01','2026-10-31','KWD')", [id, company]);
  for (const [org, total] of lines) {
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation)
      VALUES($1,$2,'worker',$3,'KWD','1.000',$4,'synthetic','{}')`, [randomUUID(), id, store[org], total]);
  }
  return id;
}
const numberOf = async (id: string, org: string) => (await listTransferInvoices(pool, id)).find(i => i.orgId === org && !i.deleted)!.invoiceNumber;

test("TRANSFER_INVOICE_READS_TREE a company reader sees its own and its sub-companies' live invoices, never another company's", async () => {
  const group = await transfer([["P", "4.000"], ["C1", "2.500"], ["C2", "1.000"]], "P");
  const other = await transfer([["X", "9.000"]], "X");
  await move(group, "lock"); await move(other, "lock");
  await grant("fin-p", "P", "finance", "subtree");
  const page = await reads.listForOrganization("fin-p", "P");
  assert.ok(page);
  assert.equal(page.name, "Parent Trading Co", "the profile's English name");
  assert.deepEqual(page.invoices.map(i => [i.orgId, i.companyName, i.total, i.lineCount, i.status, i.paidOn]).sort(),
    [["C1", "C1", "2.500", 1, "unpaid", null], ["C2", "C2", "1.000", 1, "unpaid", null], ["P", "Parent Trading Co", "4.000", 1, "unpaid", null]],
    "a blank profile name falls back to the organization name");
  assert.ok(page.invoices.every(i => i.transferId === group && i.currencyCode === "KWD"));
  assert.equal(await reads.document("fin-p", "P", await numberOf(other, "X")), null, "another company's invoice is not found through P");
  assert.equal(await reads.listForOrganization("fin-p", "X"), null);
});

test("TRANSFER_INVOICE_READS_SCOPE a self grant covers only its organization; a subtree grant or a grant on the sub-company covers the companies below", async () => {
  const group = await transfer([["P", "4.000"], ["C1", "2.500"]], "P");
  await move(group, "lock");
  await grant("fin-c1", "C1", "finance"); await grant("self-p", "P", "org-owner"); await grant("owner-p", "P", "org-owner", "subtree");
  assert.deepEqual((await reads.listForOrganization("fin-c1", "C1"))?.invoices.map(i => i.orgId), ["C1"], "a sub-company sees only its own invoice");
  assert.equal(await reads.listForOrganization("fin-c1", "P"), null, "a sub-company cannot read its parent");
  assert.equal(await reads.listForOrganization("self-p", "C1"), null, "a self grant on the parent does not reach the child page");
  assert.deepEqual((await reads.listForOrganization("self-p", "P"))?.invoices.map(i => i.orgId), ["P"], "a self grant on the parent shows only the parent's own invoice");
  assert.equal(await reads.document("self-p", "P", await numberOf(group, "C1")), null, "nor the sub-company's PDF through the parent");
  assert.deepEqual((await reads.listForOrganization("owner-p", "P"))?.invoices.map(i => i.orgId).sort(), ["C1", "P"], "a subtree grant on the parent shows its sub-companies");
  assert.equal((await reads.document("owner-p", "P", await numberOf(group, "C1")))?.orgId, "C1");
  assert.deepEqual((await reads.listForOrganization("owner-p", "C1"))?.invoices.map(i => i.orgId), ["C1"]);
  await grant("self-p", "C1", "finance");
  assert.deepEqual((await reads.listForOrganization("self-p", "P"))?.invoices.map(i => i.orgId).sort(), ["C1", "P"], "a grant on the sub-company itself adds it to the parent's page");
  await grant("staff", "root", "staff", "subtree");
  assert.equal((await reads.listForOrganization("staff", "P"))?.invoices.length, 2, "StudentHub staff reach every company through root");
});

test("TRANSFER_INVOICE_READS_REFUSED recruiters, candidates, operator-level finance, operator orgs, missing and deleted companies all answer null", async () => {
  const group = await transfer([["P", "4.000"]], "P");
  await move(group, "lock");
  const number = await numberOf(group, "P");
  await grant("recruiter", "P", "recruiter", "subtree"); await grant("candidate", "P", "candidate");
  await grant("staff", "root", "staff", "subtree"); await grant("fin-x", "X", "finance");
  await grant("op-fin", "root", "finance", "subtree"); await grant("op-admin", "root", "admin", "subtree");
  for (const who of ["recruiter", "candidate", "fin-x", "op-fin", "nobody"]) {
    assert.equal(await reads.listForOrganization(who, "P"), null, who);
    assert.equal(await reads.document(who, "P", number), null, who);
  }
  assert.equal((await reads.listForOrganization("op-admin", "P"))?.invoices.length, 1, "StudentHub admins read through root");
  assert.equal((await reads.document("op-admin", "P", number))?.invoiceNumber, number);
  assert.equal(await reads.listForOrganization("staff", "root"), null, "an operator organization is never billed");
  assert.equal(await reads.listForOrganization("staff", "missing"), null);
  await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES('P',$1)", ["b".repeat(64)]);
  assert.equal(await reads.listForOrganization("staff", "P"), null, "a deleted company answers as a missing one");
  assert.equal(await reads.document("staff", "P", number), null);
});

test("TRANSFER_INVOICE_READS_DOCUMENT one live invoice with its period; voided ones are gone; a paid one carries its payment day", async () => {
  const group = await transfer([["P", "4.000"], ["C1", "2.500"]], "P");
  await move(group, "lock");
  await grant("fin-p", "P", "finance", "subtree");
  const c1 = await numberOf(group, "C1");
  assert.deepEqual(await reads.document("fin-p", "P", c1), {
    invoiceNumber: c1, transferId: group, orgId: "C1", companyName: "C1", currencyCode: "KWD",
    invoiceDate: (await listTransferInvoices(pool, group)).find(i => i.invoiceNumber === c1)!.invoiceDate,
    total: "2.500", lineCount: 1, status: "unpaid", paidOn: null, creditNumber: null, creditedOn: null, periodStart: "2026-10-01", periodEnd: "2026-10-31",
  });
  assert.equal(await reads.document("fin-p", "P", "SH-2026-11-999999"), null);
  // Unlock, change C1's line and lock again: the old C1 invoice is voided and a new one issued.
  await move(group, "admin_unlock");
  await pool.query("UPDATE pay_transfer_lines SET company_total='3.000' WHERE transfer_id=$1 AND store_id=$2", [group, store.C1]);
  await move(group, "lock");
  assert.equal(await reads.document("fin-p", "P", c1), null, "a voided invoice is not served");
  const reissued = await numberOf(group, "C1");
  assert.notEqual(reissued, c1);
  assert.deepEqual((await reads.listForOrganization("fin-p", "P"))?.invoices.map(i => i.invoiceNumber).sort(), [reissued, await numberOf(group, "P")].sort());
  await move(group, "payment_received");
  const paid = await reads.document("fin-p", "P", reissued);
  const today = (await pool.query("SELECT (now() AT TIME ZONE 'Asia/Kuwait')::date::text AS d")).rows[0].d as string;
  assert.equal(paid?.status, "paid"); assert.equal(paid?.paidOn, today);
});

test("TRANSFER_INVOICE_READS_PAYABLE an unpaid invoice is listed and served only while its transfer is locked or payment sent; unlock and cancel hide it, relock re-issues or keeps it", async () => {
  await grant("fin-p", "P", "finance", "subtree");
  // An unrelated paid receipt, which every step below must keep.
  const settled = await transfer([["C2", "1.000"]], "P");
  await move(settled, "lock"); await move(settled, "payment_received");
  const receipt = await numberOf(settled, "C2");
  const group = await transfer([["P", "4.000"], ["C1", "2.500"]], "P");
  await move(group, "lock");
  const [c1, parent] = [await numberOf(group, "C1"), await numberOf(group, "P")];
  const listed = async () => Object.fromEntries((await reads.listForOrganization("fin-p", "P"))!.invoices.map(i => [i.invoiceNumber, [i.total, i.status]]));
  assert.deepEqual(await listed(), { [c1]: ["2.500", "unpaid"], [parent]: ["4.000", "unpaid"], [receipt]: ["1.000", "paid"] });
  assert.equal((await reads.document("fin-p", "P", c1))?.total, "2.500", "the original PDF while locked");

  // Admin unlock: the transfer is a draft again and C1 changes to 3.000. Before relock nothing of it is due.
  await move(group, "admin_unlock");
  await pool.query("UPDATE pay_transfer_lines SET company_total='3.000' WHERE transfer_id=$1 AND store_id=$2", [group, store.C1]);
  assert.deepEqual(await listed(), { [receipt]: ["1.000", "paid"] }, "the unlocked transfer's invoices leave the list; the receipt stays");
  assert.equal(await reads.document("fin-p", "P", c1), null, "the original direct PDF link is not found while unlocked");
  assert.equal(await reads.document("fin-p", "P", parent), null);
  assert.equal((await reads.document("fin-p", "P", receipt))?.status, "paid");

  // Relock: C1 changed, so it gets a new number and amount; P is unchanged and keeps its number.
  await move(group, "lock");
  const reissued = await numberOf(group, "C1");
  assert.notEqual(reissued, c1);
  assert.equal(await numberOf(group, "P"), parent);
  assert.deepEqual(await listed(), { [reissued]: ["3.000", "unpaid"], [parent]: ["4.000", "unpaid"], [receipt]: ["1.000", "paid"] });
  assert.equal(await reads.document("fin-p", "P", c1), null, "the old number stays voided");
  await move(group, "payment_sent");
  assert.equal((await reads.document("fin-p", "P", reissued))?.status, "unpaid", "still due once payment is sent");

  // Unlock then cancel: the cancelled transfer's invoice is never due again.
  const cancelled = await transfer([["P", "7.000"]], "P");
  await move(cancelled, "lock");
  const dropped = await numberOf(cancelled, "P");
  assert.ok((await listed())[dropped]);
  await move(cancelled, "admin_unlock"); await move(cancelled, "cancel");
  assert.equal((await listed())[dropped], undefined);
  assert.equal(await reads.document("fin-p", "P", dropped), null);
  assert.equal((await reads.document("fin-p", "P", receipt))?.status, "paid", "the unrelated receipt is preserved throughout");
});

/*
 * Invoices are dated and paid by the database clock, so history is built by locking (and paying)
 * now and then moving the dates back. Only this fixture lifts the forward-only guard, and only for
 * the dates; the reads under test never write.
 */
async function backdate(transferId: string, issued: string, paid?: string, total?: string): Promise<void> {
  await pool.query("ALTER TABLE transfer_invoice DISABLE TRIGGER transfer_invoice_forward_only");
  try {
    await pool.query("UPDATE transfer_invoice SET invoice_date = $2::date WHERE transfer_id = $1", [transferId, issued]);
    if (total) await pool.query("UPDATE transfer_invoice SET total = $2::numeric WHERE transfer_id = $1", [transferId, total]);
    if (paid) await pool.query("UPDATE transfer_invoice SET paid_at = ($2::date + time '12:00') AT TIME ZONE 'Asia/Kuwait' WHERE transfer_id = $1 AND status = 'paid'", [transferId, paid]);
  } finally { await pool.query("ALTER TABLE transfer_invoice ENABLE TRIGGER transfer_invoice_forward_only"); }
}
const lockOn = async (id: string, day: string) => { await move(id, "lock"); await backdate(id, day); };
const kuwaitToday = async () => (await pool.query("SELECT (now() AT TIME ZONE 'Asia/Kuwait')::date::text AS d")).rows[0].d as string;
const figures = (s: Awaited<ReturnType<PostgresTransferInvoiceReads["statement"]>>) => s?.currencies.map(c => [c.currencyCode, c.opening, c.invoiced, c.paid, c.closing,
  c.members.map(m => [m.orgId, m.opening, m.invoiced, m.paid, m.closing])]);

test("TRANSFER_STATEMENT_FIGURES opening, invoiced, paid and closing per currency and company reconcile to the movements listed", async () => {
  await grant("fin-p", "P", "finance", "subtree");
  const september = await transfer([["P", "4.000"], ["C1", "2.500"]], "P");
  await lockOn(september, "2026-09-10"); await move(september, "payment_received"); await backdate(september, "2026-09-10", "2026-11-15");
  const october = await transfer([["P", "1.250"]], "P");
  await lockOn(october, "2026-10-10");
  const other = await transfer([["X", "9.000"]], "X");
  await lockOn(other, "2026-10-12");
  const oct = await reads.statement("fin-p", "P", "2026-10-01", "2026-10-31");
  assert.deepEqual(figures(oct), [["KWD", "6.500", "1.250", "0.000", "7.750", [["C1", "2.500", "0.000", "0.000", "2.500"], ["P", "4.000", "1.250", "0.000", "5.250"]]]],
    "September's invoices are owed until paid in November; another company's never appear");
  assert.deepEqual(oct?.entries.map(e => [e.date, e.kind, e.orgId, e.amount]), [["2026-10-10", "invoice", "P", "1.250"]]);
  assert.deepEqual([oct?.name, oct?.from, oct?.to], ["Parent Trading Co", "2026-10-01", "2026-10-31"]);
  const now = await reads.statement("fin-p", "P", "2026-11-01", "2026-11-30");
  assert.deepEqual(figures(now), [["KWD", "7.750", "0.000", "6.500", "1.250", [["C1", "2.500", "0.000", "2.500", "0.000"], ["P", "5.250", "0.000", "4.000", "1.250"]]]],
    "the payment day takes September's invoices off the balance");
  assert.deepEqual(now?.entries.map(e => [e.kind, e.orgId, e.amount]).sort(), [["payment", "C1", "2.500"], ["payment", "P", "4.000"]]);
  for (const s of [oct!, now!]) for (const c of s.currencies) {
    const sum = (kind: string) => s.entries.filter(e => e.kind === kind && e.currencyCode === c.currencyCode).reduce((n, e) => n + Math.round(Number(e.amount) * 1000), 0);
    assert.equal(sum("invoice"), Math.round(Number(c.invoiced) * 1000)); assert.equal(sum("payment"), Math.round(Number(c.paid) * 1000));
    assert.equal(Math.round(Number(c.opening) * 1000) + sum("invoice") - sum("payment"), Math.round(Number(c.closing) * 1000));
  }
  assert.deepEqual(await reads.statement("fin-p", "P", "2026-01-01", "2026-01-31"), { orgId: "P", name: "Parent Trading Co", from: "2026-01-01", to: "2026-01-31", currencies: [], entries: [] },
    "a period with nothing owed is an empty statement, not an error");
  await assert.rejects(reads.statement("fin-p", "P", "2026-10-31", "2026-10-01"), /invalid_window/);
});

test("TRANSFER_STATEMENT_STABLE a past period's statement is unchanged by later invoices and payments", async () => {
  await grant("fin-p", "P", "finance", "subtree");
  const october = await transfer([["P", "1.250"], ["C1", "3.000"]], "P");
  await lockOn(october, "2026-10-10");
  const before = await reads.statement("fin-p", "P", "2026-10-01", "2026-10-31");
  const november = await transfer([["C1", "8.000"]], "P");
  await lockOn(november, "2026-11-05");
  await move(october, "payment_received"); await move(november, "payment_received");
  await backdate(october, "2026-10-10", "2026-11-20"); await backdate(november, "2026-11-05", await kuwaitToday());
  assert.deepEqual(await reads.statement("fin-p", "P", "2026-10-01", "2026-10-31"), before);
  assert.equal(before?.currencies[0]?.closing, "4.250");
});

test("TRANSFER_STATEMENT_SCOPE a statement never widens access: a self grant shows only its company; others read nothing", async () => {
  const group = await transfer([["P", "4.000"], ["C1", "2.500"]], "P");
  await lockOn(group, "2026-10-10");
  await grant("self-p", "P", "org-owner"); await grant("fin-c1", "C1", "finance"); await grant("recruiter", "P", "recruiter", "subtree");
  await grant("op-fin", "root", "finance", "subtree");
  const own = await reads.statement("self-p", "P", "2026-10-01", "2026-10-31");
  assert.deepEqual(figures(own), [["KWD", "0.000", "4.000", "0.000", "4.000", [["P", "0.000", "4.000", "0.000", "4.000"]]]], "the sub-company's subtotal is not shown");
  assert.deepEqual(own?.entries.map(e => e.orgId), ["P"]);
  assert.deepEqual(figures(await reads.statement("fin-c1", "C1", "2026-10-01", "2026-10-31")), [["KWD", "0.000", "2.500", "0.000", "2.500", [["C1", "0.000", "2.500", "0.000", "2.500"]]]]);
  for (const who of ["fin-c1", "recruiter", "op-fin", "nobody"]) assert.equal(await reads.statement(who, "P", "2026-10-01", "2026-10-31"), null, who);
  assert.equal(await reads.statement("self-p", "root", "2026-10-01", "2026-10-31"), null, "an operator organization has no statement");
});

test("TRANSFER_STATEMENT_PRECISION invoices up to numeric(18,3), and sums beyond it, keep every fils", async () => {
  await grant("fin-p", "P", "finance", "subtree");
  const big = await transfer([["P", "1.000"]], "P"), bigger = await transfer([["C1", "1.000"]], "P");
  await lockOn(big, "2026-10-10"); await lockOn(bigger, "2026-10-11");
  await backdate(big, "2026-10-10", undefined, "999999999999999.999"); await backdate(bigger, "2026-10-11", undefined, "123456789012345.678");
  const s = await reads.statement("fin-p", "P", "2026-10-01", "2026-10-31");
  assert.deepEqual(figures(s), [["KWD", "0.000", "1123456789012345.677", "0.000", "1123456789012345.677",
    [["C1", "0.000", "123456789012345.678", "0.000", "123456789012345.678"], ["P", "0.000", "999999999999999.999", "0.000", "999999999999999.999"]]]]);
  assert.deepEqual(s?.entries.map(e => e.amount), ["999999999999999.999", "123456789012345.678"]);
  assert.deepEqual(figures(await reads.statement("fin-p", "P", "2026-11-01", "2026-11-30")), [["KWD", "1123456789012345.677", "0.000", "0.000", "1123456789012345.677",
    [["C1", "123456789012345.678", "0.000", "0.000", "123456789012345.678"], ["P", "999999999999999.999", "0.000", "0.000", "999999999999999.999"]]]], "a large opening balance too");
});

test("TRANSFER_STATEMENT_SNAPSHOT figures and movements come from one snapshot, even when a payment commits while the statement is read", async () => {
  await grant("fin-p", "P", "finance", "subtree");
  const october = await transfer([["P", "4.000"], ["C1", "2.500"]], "P");
  await lockOn(october, "2026-10-10");
  const today = await kuwaitToday();
  // A pool that lets a payment commit, on another connection, just before each statement query after the first.
  let reads_ = 0;
  const racing = new Proxy(pool, { get(target, key) {
    if (key !== "query") return Reflect.get(target, key);
    return async (text: string, values?: unknown[]) => {
      if (typeof text === "string" && text.includes("moves AS") && reads_++ === 0) await move(october, "payment_received");
      return target.query(text, values);
    };
  } });
  const raced = new PostgresTransferInvoiceReads({ pool: racing as pg.Pool, decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, ["root"]) });
  const s = (await raced.statement("fin-p", "P", "2026-10-01", today))!;
  for (const c of s.currencies) {
    const sum = (kind: string) => s.entries.filter(e => e.kind === kind && e.currencyCode === c.currencyCode).reduce((n, e) => n + Math.round(Number(e.amount) * 1000), 0);
    assert.equal(sum("invoice"), Math.round(Number(c.invoiced) * 1000)); assert.equal(sum("payment"), Math.round(Number(c.paid) * 1000));
    assert.equal(Math.round(Number(c.opening) * 1000) + sum("invoice") - sum("payment"), Math.round(Number(c.closing) * 1000));
  }
  assert.deepEqual(figures(s), [["KWD", "0.000", "6.500", "6.500", "0.000", [["C1", "0.000", "2.500", "2.500", "0.000"], ["P", "0.000", "4.000", "4.000", "0.000"]]]],
    "the payment that committed first is in both the figures and the movements");
});
