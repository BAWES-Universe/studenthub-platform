import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresTransferInvoiceEffects, listTransferInvoices, transferInvoiceForLine } from "@studenthub/db/billing";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// Synthetic companies, stores and amounts only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let schema: string;
const actor = { principalId: "inv-staff", actingAs: false };
const person = "inv-person";
const store: Record<string, string> = {};
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const effects = new PostgresTransferInvoiceEffects();
const clock = () => new Date("2026-11-22T10:00:00Z");
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, effects), clock);
const move = async (id: string, action: TransferAction) => {
  const result = await lifecycle().transition(actor, id, action);
  assert.equal(result.kind, "changed", `${action}: ${JSON.stringify(result)}`);
};

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `transfer_invoice_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  // parent P with sub-companies C1 and C2; X is an unrelated company.
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('P','P',NULL),('C1','C1','P'),('C2','C2','P'),('X','X',NULL)");
  for (const id of [actor.principalId, person]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  for (const org of ["P", "C1", "C2", "X"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)", [store[org], org, "a".repeat(64)]);
  }
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

async function transfer(lines: readonly [org: string, companyTotal: string][], company = "P"): Promise<{ id: string; lineIds: string[] }> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-11-01','2026-11-30','KWD')", [id, company]);
  const lineIds: string[] = [];
  for (const [org, total] of lines) {
    const lineId = randomUUID();
    lineIds.push(lineId);
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation)
      VALUES($1,$2,$3,$4,'KWD','1.000',$5,'synthetic','{}')`, [lineId, id, person, store[org], total]);
  }
  return { id, lineIds };
}
const live = async (id: string) => (await listTransferInvoices(pool, id)).filter(invoice => !invoice.deleted);
const kuwaitToday = async () => (await pool.query("SELECT (now() AT TIME ZONE 'Asia/Kuwait')::date::text AS d")).rows[0].d as string;
const sequence = async () => (await pool.query("SELECT last_sequence::int AS n FROM billing_sequence WHERE account_id='studenthub-transfers'")).rows[0]?.n as number | undefined;

test("TRANSFER_INVOICE_LOCK_SINGLE a company without sub-company lines gets exactly one unpaid invoice at lock", async () => {
  const { id, lineIds } = await transfer([["P", "10.100"], ["P", "0.200"]]);
  assert.deepEqual(await listTransferInvoices(pool, id), [], "no invoice while draft");
  await move(id, "lock");
  const today = await kuwaitToday();
  const invoices = await listTransferInvoices(pool, id);
  assert.deepEqual(invoices, [{
    invoiceNumber: `SH-${today.slice(0, 7)}-000001`, transferId: id, orgId: "P", currencyCode: "KWD", invoiceDate: today,
    total: "10.300", lineCount: 2, status: "unpaid", deleted: false, voidReason: null,
  }]);
  assert.equal((await transferInvoiceForLine(pool, lineIds[1]!))?.invoiceNumber, invoices[0]!.invoiceNumber);
  assert.equal((await lifecycle().transition(actor, id, "lock")).kind, "refused", "a repeat lock is refused");
  assert.equal((await listTransferInvoices(pool, id)).length, 1);
});

test("TRANSFER_INVOICE_LOCK_CHILDREN one invoice per billed company, parent-owned lines kept on the parent", async () => {
  const { id, lineIds } = await transfer([["C1", "5.000"], ["P", "1.250"], ["C2", "2.500"], ["C1", "0.005"]]);
  await move(id, "lock");
  const byOrg = Object.fromEntries((await live(id)).map(invoice => [invoice.orgId, [invoice.total, invoice.lineCount]]));
  assert.deepEqual(byOrg, { C1: ["5.005", 2], C2: ["2.500", 1], P: ["1.250", 1] });
  assert.equal(new Set((await live(id)).map(invoice => invoice.invoiceNumber)).size, 3);
  for (const [index, org] of ["C1", "P", "C2", "C1"].entries()) {
    assert.equal((await transferInvoiceForLine(pool, lineIds[index]!))?.orgId, org, "each line maps to its own company's invoice");
  }
});

test("TRANSFER_INVOICE_EMPTY a transfer without lines still gets its invoice, as legacy", async () => {
  const { id } = await transfer([]);
  await move(id, "lock");
  assert.deepEqual((await live(id)).map(invoice => [invoice.orgId, invoice.total, invoice.lineCount]), [["P", "0.000", 0]]);
});

test("TRANSFER_INVOICE_RELOCK an unchanged relock reuses numbers; a changed company is voided and re-issued", async () => {
  const { id, lineIds } = await transfer([["P", "1.000"], ["C1", "2.000"], ["C2", "3.000"]]);
  await move(id, "lock");
  const first = new Map((await live(id)).map(invoice => [invoice.orgId, invoice.invoiceNumber]));
  await move(id, "admin_unlock");
  await move(id, "lock");
  assert.deepEqual(new Map((await live(id)).map(invoice => [invoice.orgId, invoice.invoiceNumber])), first);
  assert.equal(await sequence(), 3, "no number spent on an unchanged relock");

  await move(id, "admin_unlock");
  await pool.query("UPDATE pay_transfer_lines SET company_total='2.500' WHERE id=$1", [lineIds[1]]);
  await move(id, "lock");
  const after = new Map((await live(id)).map(invoice => [invoice.orgId, invoice]));
  assert.equal(after.get("P")?.invoiceNumber, first.get("P"));
  assert.equal(after.get("C2")?.invoiceNumber, first.get("C2"));
  assert.notEqual(after.get("C1")?.invoiceNumber, first.get("C1"));
  assert.equal(after.get("C1")?.total, "2.500");
  const voided = (await listTransferInvoices(pool, id)).filter(invoice => invoice.deleted);
  assert.deepEqual(voided.map(invoice => [invoice.invoiceNumber, invoice.voidReason, invoice.total]), [[first.get("C1"), "reissued", "2.000"]]);
});

test("TRANSFER_INVOICE_RELOCK_DROPPED a company whose lines all moved away loses its live invoice", async () => {
  const { id, lineIds } = await transfer([["P", "1.000"], ["C1", "2.000"]]);
  await move(id, "lock");
  await move(id, "admin_unlock");
  // Line identity is frozen by F-1, so move the line between companies under the test owner only.
  await pool.query("ALTER TABLE pay_transfer_lines DISABLE TRIGGER pay_line_draft_guard");
  await pool.query("UPDATE pay_transfer_lines SET store_id=$2 WHERE id=$1", [lineIds[1], store.P]);
  await pool.query("ALTER TABLE pay_transfer_lines ENABLE TRIGGER pay_line_draft_guard");
  await move(id, "lock");
  assert.deepEqual((await live(id)).map(invoice => [invoice.orgId, invoice.total]), [["P", "3.000"]]);
  assert.deepEqual((await listTransferInvoices(pool, id)).filter(i => i.deleted).map(i => [i.orgId, i.voidReason]).sort(),
    [["C1", "reissued"], ["P", "reissued"]]);
});

test("TRANSFER_INVOICE_PAID payment received marks every live invoice of the transfer paid, nothing else", async () => {
  const { id } = await transfer([["P", "1.000"], ["C1", "2.000"]]);
  const other = await transfer([["P", "4.000"]]);
  await move(id, "lock");
  await move(other.id, "lock");
  await move(id, "admin_unlock");
  await pool.query("UPDATE pay_transfer_lines SET company_total='9.000' WHERE transfer_id=$1", [id]);
  await move(id, "lock");
  await move(id, "payment_received");
  const all = await listTransferInvoices(pool, id);
  assert.deepEqual(all.filter(i => !i.deleted).map(i => i.status), ["paid", "paid"]);
  assert.deepEqual(all.filter(i => i.deleted).map(i => i.status), ["unpaid", "unpaid"], "voided invoices stay unpaid");
  assert.deepEqual((await listTransferInvoices(pool, other.id)).map(i => i.status), ["unpaid"]);
  const paidAt = (await pool.query("SELECT count(*)::int AS n FROM transfer_invoice WHERE transfer_id=$1 AND paid_at IS NOT NULL", [id])).rows[0].n;
  assert.equal(paidAt, 2);
});

test("TRANSFER_INVOICE_DELETE deleting a transfer voids its invoices, never removes them", async () => {
  const { id } = await transfer([["P", "1.000"], ["C2", "2.000"]]);
  await move(id, "lock");
  await move(id, "delete");
  const all = await listTransferInvoices(pool, id);
  assert.deepEqual(all.map(i => [i.orgId, i.deleted, i.voidReason]).sort(), [["C2", true, "transfer_deleted"], ["P", true, "transfer_deleted"]]);
});

test("TRANSFER_INVOICE_OUTSIDE a line billed to an unrelated company refuses the lock and leaves nothing behind", async () => {
  const { id } = await transfer([["P", "1.000"], ["X", "2.000"]]);
  await assert.rejects(lifecycle().transition(actor, id, "lock"), /transfer_invoice_line_outside_company/);
  assert.deepEqual(await listTransferInvoices(pool, id), []);
  assert.equal(await sequence(), undefined, "no number allocated");
  assert.equal((await pool.query("SELECT status FROM pay_transfers WHERE id=$1", [id])).rows[0].status, "draft");
});

test("TRANSFER_INVOICE_ATOMIC a late lifecycle failure rolls back the invoices and their numbers", async () => {
  const { id } = await transfer([["P", "1.000"], ["C1", "1.000"]]);
  await pool.query(`CREATE FUNCTION inv_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER inv_test_reject BEFORE INSERT ON pay_transfer_lifecycle_history FOR EACH ROW EXECUTE FUNCTION inv_test_reject()`);
  await assert.rejects(lifecycle().transition(actor, id, "lock"), /synthetic audit failure/);
  assert.deepEqual(await listTransferInvoices(pool, id), []);
  assert.equal(await sequence(), undefined);
  await pool.query("DROP TRIGGER inv_test_reject ON pay_transfer_lifecycle_history");
  await move(id, "lock");
  assert.equal((await live(id)).length, 2);
  assert.equal(await sequence(), 2);
});

test("TRANSFER_INVOICE_UNAVAILABLE payment received without issued invoices is refused, not silently paid", async () => {
  const { id } = await transfer([["P", "1.000"]]);
  const probe = { ...effects, ensureChildrenAndInvoices: async () => {}, markInvoicesPaid: effects.markInvoicesPaid.bind(effects), softDeleteGroup: effects.softDeleteGroup.bind(effects) };
  const service = new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, probe), clock);
  assert.equal((await service.transition(actor, id, "lock")).kind, "changed");
  await assert.rejects(service.transition(actor, id, "payment_received"), /transfer_invoice_missing/);
  assert.equal((await pool.query("SELECT status FROM pay_transfers WHERE id=$1", [id])).rows[0].status, "locked");
});

test("TRANSFER_INVOICE_FROZEN the table refuses edits, removal and backwards moves even outside the adapter", async () => {
  const { id } = await transfer([["P", "1.000"], ["C1", "2.000"]]);
  await move(id, "lock");
  await move(id, "payment_received");
  const voidable = await transfer([["P", "1.000"]]);
  await move(voidable.id, "lock");
  await move(voidable.id, "delete");
  const refused = async (sql: string, params: unknown[] = []) =>
    assert.rejects(pool.query(sql, params), (error: { code?: string }) => error.code === "23514", sql);
  await refused("UPDATE transfer_invoice SET total = total + 1 WHERE transfer_id=$1", [id]);
  await refused("UPDATE transfer_invoice SET org_id = 'X' WHERE transfer_id=$1", [id]);
  await refused("UPDATE transfer_invoice SET invoice_date = invoice_date + 1 WHERE transfer_id=$1", [id]);
  await refused("UPDATE transfer_invoice SET status = 'unpaid', paid_at = NULL WHERE transfer_id=$1", [id]);
  await refused("UPDATE transfer_invoice SET deleted = true, void_reason = 'reissued' WHERE transfer_id=$1", [id]);
  await refused("UPDATE transfer_invoice SET deleted = false, void_reason = NULL WHERE transfer_id=$1", [voidable.id]);
  await refused("UPDATE transfer_invoice SET status = 'paid', paid_at = now() WHERE transfer_id=$1", [voidable.id]);
  // The two allowed moves cannot carry an edit along with them.
  const open = await transfer([["P", "1.000"]]);
  await move(open.id, "lock");
  await refused("UPDATE transfer_invoice SET status = 'paid', paid_at = now(), total = 0 WHERE transfer_id=$1", [open.id]);
  await refused("UPDATE transfer_invoice SET deleted = true, void_reason = 'reissued', org_id = 'C1' WHERE transfer_id=$1", [open.id]);
  assert.deepEqual((await live(open.id)).map(i => [i.total, i.status, i.orgId]), [["1.000", "unpaid", "P"]]);
  await refused("DELETE FROM transfer_invoice");
  await refused("TRUNCATE transfer_invoice");
  await refused("INSERT INTO transfer_invoice(invoice_number,transfer_id,org_id,currency_code,invoice_date,total,line_count,lines_hash) VALUES ('LEGACY-1',$1,'P','KWD','2026-11-22',1,1,$2)", [id, "0".repeat(64)]);
  await assert.rejects(pool.query("INSERT INTO transfer_invoice(invoice_number,transfer_id,org_id,currency_code,invoice_date,total,line_count,lines_hash) VALUES ('SH-2026-11-999999',$1,'P','KWD','2026-11-22',1,1,$2)", [id, "0".repeat(64)]),
    (error: { code?: string }) => error.code === "23505", "one live invoice per transfer and company");
  assert.equal((await listTransferInvoices(pool, id)).length, 2);
});
