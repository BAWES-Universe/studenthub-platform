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
  for (const id of [actor.principalId, "worker", "fin-p", "owner-p", "fin-c1", "self-p", "staff", "recruiter", "candidate", "fin-x"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
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

test("TRANSFER_INVOICE_READS_REFUSED recruiters, candidates, operator orgs, missing and deleted companies all answer null", async () => {
  const group = await transfer([["P", "4.000"]], "P");
  await move(group, "lock");
  const number = await numberOf(group, "P");
  await grant("recruiter", "P", "recruiter", "subtree"); await grant("candidate", "P", "candidate");
  await grant("staff", "root", "staff", "subtree"); await grant("fin-x", "X", "finance");
  for (const who of ["recruiter", "candidate", "fin-x", "nobody"]) {
    assert.equal(await reads.listForOrganization(who, "P"), null, who);
    assert.equal(await reads.document(who, "P", number), null, who);
  }
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
    total: "2.500", lineCount: 1, status: "unpaid", paidOn: null, periodStart: "2026-10-01", periodEnd: "2026-10-31",
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
