import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresTransferInvoiceEffects, PostgresTransferInvoiceReads, PostgresTransferInvoiceVoids, creditReason, listTransferInvoices } from "@studenthub/db/billing";
import { transferInvoiceReadDecision, transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// Synthetic companies, stores, people and amounts only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let voids: PostgresTransferInvoiceVoids;
let reads: PostgresTransferInvoiceReads;
let schema: string;
const actor = { principalId: "void-actor", actingAs: false };
const store: Record<string, string> = {};
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z"));
const move = async (id: string, ...actions: TransferAction[]) => {
  for (const action of actions) assert.equal((await lifecycle().transition(actor, id, action)).kind, "changed", action);
};
const SERIES = /^SH-\d{4}-\d{2}-\d{6}$/;

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `transfer_invoice_voids_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P','root'),('C1','C1','P')");
  for (const id of [actor.principalId, "worker", "op-admin"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES('op-admin','root','admin','subtree')");
  for (const org of ["P", "C1"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)", [store[org], org, "a".repeat(64)]);
  }
  voids = new PostgresTransferInvoiceVoids({ pool });
  reads = new PostgresTransferInvoiceReads({ pool, decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, ["root"]) });
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

async function transfer(lines: readonly [org: string, total: string][]): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,'P','2026-10-01','2026-10-31','KWD')", [id]);
  for (const [org, total] of lines) {
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation)
      VALUES($1,$2,'worker',$3,'KWD','1.000',$4,'synthetic','{}')`, [randomUUID(), id, store[org], total]);
  }
  return id;
}
const live = async (id: string, org: string) => (await listTransferInvoices(pool, id)).find(i => i.orgId === org && !i.deleted);
const credits = async () => (await pool.query<{ credit_number: string; invoice_number: string; total: string }>(
  "SELECT credit_number, invoice_number, total::text AS total FROM transfer_invoice_credit ORDER BY credit_number")).rows;
const today = async () => (await pool.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Asia/Kuwait')::date::text AS d")).rows[0]!.d;
const refused = (sql: string, params: unknown[] = []) =>
  assert.rejects(pool.query(sql, params), (error: { code?: string }) => error.code === "23514", sql);

test("TRANSFER_INVOICE_VOID_PRESERVES_HISTORY a void keeps the invoice, its number, total and status, and adds one credit note with a new number", async () => {
  const id = await transfer([["P", "4.000"], ["C1", "2.500"]]);
  await move(id, "lock");
  const original = (await live(id, "C1"))!;
  const result = await voids.credit({ actorId: "op-admin", invoiceNumber: original.invoiceNumber, reason: "  Billed the wrong store  " });
  assert.equal(result.kind, "credited");
  const credit = result.kind === "credited" ? result.credit : assert.fail();
  assert.match(credit.creditNumber, SERIES); assert.notEqual(credit.creditNumber, original.invoiceNumber);
  assert.deepEqual({ ...credit, creditNumber: "" }, { creditNumber: "", invoiceNumber: original.invoiceNumber, orgId: "C1", currencyCode: "KWD",
    creditDate: await today(), total: "2.500", reason: "Billed the wrong store", actorId: "op-admin" });
  const after = (await listTransferInvoices(pool, id)).find(i => i.invoiceNumber === original.invoiceNumber);
  assert.deepEqual(after, { ...original, deleted: true, voidReason: "credited" }, "only the void mark changes on the invoice");
  assert.equal((await live(id, "P"))?.deleted, false, "the other company's invoice is untouched");
  const again = await voids.credit({ actorId: "op-admin", invoiceNumber: original.invoiceNumber, reason: "twice" });
  assert.deepEqual(again, { kind: "already_credited", credit }, "a second void answers the first credit note");
  assert.equal((await credits()).length, 1);
  await refused("UPDATE transfer_invoice_credit SET total = 0");
  await refused("DELETE FROM transfer_invoice_credit");
  await refused("TRUNCATE transfer_invoice_credit");
  await refused("TRUNCATE transfer_invoice CASCADE");
  await refused("UPDATE transfer_invoice SET deleted = false, void_reason = NULL WHERE invoice_number = $1", [original.invoiceNumber]);
});

test("TRANSFER_INVOICE_VOID_REISSUE after a void an unlock and relock issues a new invoice with a new number; payment then needs it", async () => {
  const id = await transfer([["P", "4.000"], ["C1", "2.500"]]);
  await move(id, "lock");
  const p = (await live(id, "P"))!, c1 = (await live(id, "C1"))!;
  assert.equal((await voids.credit({ actorId: "op-admin", invoiceNumber: p.invoiceNumber, reason: "Wrong period" })).kind, "credited");
  assert.equal(await live(id, "P"), undefined, "a credited invoice no longer bills the company");
  await move(id, "admin_unlock", "lock");
  const reissued = (await live(id, "P"))!;
  assert.notEqual(reissued.invoiceNumber, p.invoiceNumber); assert.equal(reissued.total, "4.000");
  assert.equal((await live(id, "C1"))?.invoiceNumber, c1.invoiceNumber, "an invoice that was not voided is kept");
  await move(id, "payment_received");
  assert.deepEqual((await listTransferInvoices(pool, id)).map(i => [i.invoiceNumber, i.status, i.voidReason]).sort(),
    [[p.invoiceNumber, "unpaid", "credited"], [c1.invoiceNumber, "paid", null], [reissued.invoiceNumber, "paid", null]].sort());

  const only = await transfer([["P", "1.000"]]);
  await move(only, "lock");
  await voids.credit({ actorId: "op-admin", invoiceNumber: (await live(only, "P"))!.invoiceNumber, reason: "Wrong period" });
  await assert.rejects(lifecycle().transition(actor, only, "payment_received"), /transfer_invoice_missing/, "no payment is received against a transfer with nothing billed");
});

test("TRANSFER_INVOICE_VOID_PAID a paid invoice is credited, stays paid, and the statement owes the company the amount back", async () => {
  const id = await transfer([["P", "4.000"]]);
  await move(id, "lock", "payment_received");
  const paid = (await live(id, "P"))!;
  const result = await voids.credit({ actorId: "op-admin", invoiceNumber: paid.invoiceNumber, reason: "Refund agreed" });
  const credit = result.kind === "credited" ? result.credit : assert.fail(result.kind);
  const row = (await listTransferInvoices(pool, id))[0]!;
  assert.deepEqual([row.status, row.deleted, row.voidReason], ["paid", true, "credited"]);
  const day = await today();
  const page = await reads.listForOrganization("op-admin", "P");
  assert.deepEqual(page?.invoices.map(i => [i.invoiceNumber, i.status, i.creditNumber, i.creditedOn]), [[paid.invoiceNumber, "paid", credit.creditNumber, day]]);
  assert.equal((await reads.document("op-admin", "P", paid.invoiceNumber))?.creditNumber, credit.creditNumber);
  const statement = (await reads.statement("op-admin", "P", day, day))!;
  assert.deepEqual(statement.entries.map(e => [e.kind, e.invoiceNumber, e.creditNumber, e.amount]),
    [["invoice", paid.invoiceNumber, null, "4.000"], ["payment", paid.invoiceNumber, null, "4.000"], ["credit", paid.invoiceNumber, credit.creditNumber, "4.000"]]);
  const kwd = statement.currencies[0]!;
  assert.deepEqual([kwd.opening, kwd.invoiced, kwd.paid, kwd.credited, kwd.closing], ["0.000", "4.000", "4.000", "4.000", "-4.000"]);
  assert.deepEqual([kwd.members[0]!.credited, kwd.members[0]!.closing], ["4.000", "-4.000"]);
  const next = (await reads.statement("op-admin", "P", nextDay(day), nextDay(day)))!.currencies[0]!;
  assert.deepEqual([next.opening, next.credited, next.closing], ["-4.000", "0.000", "-4.000"], "a credit note counts in later opening balances");
});

test("TRANSFER_INVOICE_VOID_VISIBLE a credited invoice stays on the company's page and statement after its transfer is unlocked or deleted", async () => {
  const id = await transfer([["P", "4.000"], ["C1", "2.500"]]);
  await move(id, "lock");
  const p = (await live(id, "P"))!;
  await voids.credit({ actorId: "op-admin", invoiceNumber: p.invoiceNumber, reason: "Wrong period" });
  await move(id, "admin_unlock");
  const listed = async () => (await reads.listForOrganization("op-admin", "P"))!.invoices.map(i => i.invoiceNumber);
  assert.deepEqual(await listed(), [p.invoiceNumber], "the draft's unpaid C1 invoice is hidden; the credited one stays");
  await move(id, "delete");
  assert.deepEqual(await listed(), [p.invoiceNumber]);
  const day = await today();
  const kwd = (await reads.statement("op-admin", "P", day, day))!.currencies[0]!;
  assert.deepEqual([kwd.invoiced, kwd.credited, kwd.closing], ["4.000", "4.000", "0.000"]);
});

test("TRANSFER_INVOICE_VOID_REFUSED missing and otherwise voided invoices are not found; a draft's unpaid invoice is not creditable; reasons are checked", async () => {
  assert.deepEqual(await voids.credit({ actorId: "op-admin", invoiceNumber: "SH-2026-11-999999", reason: "x" }), { kind: "not_found" });
  const id = await transfer([["P", "4.000"]]);
  await move(id, "lock");
  const first = (await live(id, "P"))!;
  await move(id, "admin_unlock");
  await pool.query("UPDATE pay_transfer_lines SET company_total = '5.000' WHERE transfer_id = $1", [id]);
  assert.deepEqual(await voids.credit({ actorId: "op-admin", invoiceNumber: first.invoiceNumber, reason: "x" }), { kind: "not_creditable" }, "a draft is not payable");
  await move(id, "lock");
  assert.deepEqual(await voids.credit({ actorId: "op-admin", invoiceNumber: first.invoiceNumber, reason: "x" }), { kind: "not_found" }, "re-issued");
  const gone = await transfer([["P", "1.000"]]);
  await move(gone, "lock");
  const deleted = (await live(gone, "P"))!;
  await move(gone, "delete");
  assert.deepEqual(await voids.credit({ actorId: "op-admin", invoiceNumber: deleted.invoiceNumber, reason: "x" }), { kind: "not_found" }, "transfer deleted");
  for (const bad of ["", "   ", "a".repeat(501), "two\nlines", 7]) {
    await assert.rejects(voids.credit({ actorId: "op-admin", invoiceNumber: (await live(id, "P"))!.invoiceNumber, reason: bad as string }), /invalid_reason/, JSON.stringify(bad));
  }
  assert.equal(creditReason(` ${"é".repeat(500)} `), "é".repeat(500));
  assert.deepEqual(await credits(), []);
});

test("TRANSFER_INVOICE_VOID_GUARDED the table itself refuses a credit that does not copy a live invoice, and a void without its credit note", async () => {
  const id = await transfer([["P", "4.000"]]);
  await move(id, "lock");
  const number = (await live(id, "P"))!.invoiceNumber;
  // Each mismatch is tried as a complete, paired void, so only the copy check can refuse it.
  for (const [total, org] of [["3.999", "P"], ["4.000", "C1"]] as const) {
    await assert.rejects(inTransaction(async client => {
      await client.query(`INSERT INTO transfer_invoice_credit(credit_number,invoice_number,org_id,currency_code,credit_date,total,reason,actor_id)
        VALUES('SH-2026-11-900000',$1,$2,'KWD','2026-11-24',$3,'synthetic','op-admin')`, [number, org, total]);
      await client.query("UPDATE transfer_invoice SET deleted = true, void_reason = 'credited' WHERE invoice_number = $1", [number]);
    }), (e: { code?: string }) => e.code === "23514", `${total} ${org}`);
  }
  await refused("UPDATE transfer_invoice SET deleted = true, void_reason = 'credited' WHERE invoice_number = $1", [number]);
  await move(id, "payment_received");
  await refused("UPDATE transfer_invoice SET deleted = true, void_reason = 'reissued' WHERE invoice_number = $1", [number]);
  await inTransaction(async client => {
    await client.query(`INSERT INTO transfer_invoice_credit(credit_number,invoice_number,org_id,currency_code,credit_date,total,reason,actor_id)
      VALUES('SH-2026-11-900000',$1,'P','KWD','2026-11-24','4.000','synthetic','op-admin')`, [number]);
    await client.query("SAVEPOINT status");
    await assert.rejects(client.query("UPDATE transfer_invoice SET deleted = true, void_reason = 'credited', status = 'unpaid', paid_at = NULL WHERE invoice_number = $1", [number]),
      (e: { code?: string }) => e.code === "23514", "a credited void keeps the paid status");
    await client.query("ROLLBACK TO SAVEPOINT status");
    await client.query("UPDATE transfer_invoice SET deleted = true, void_reason = 'credited' WHERE invoice_number = $1", [number]);
  });
  await assert.rejects(pool.query(`INSERT INTO transfer_invoice_credit(credit_number,invoice_number,org_id,currency_code,credit_date,total,reason,actor_id)
     VALUES('SH-2026-11-900001',$1,'P','KWD','2026-11-24','4.000','synthetic','op-admin')`, [number]), (e: { code?: string }) => e.code === "23514" || e.code === "23505", "one credit note per invoice");
});

test("TRANSFER_INVOICE_VOID_PAIRED a credit note commits only together with its invoice's credited void", async () => {
  const id = await transfer([["P", "4.000"]]);
  await move(id, "lock");
  const number = (await live(id, "P"))!.invoiceNumber;
  const insert = (client: Pick<pg.PoolClient, "query">, credit: string) => client.query(
    `INSERT INTO transfer_invoice_credit(credit_number,invoice_number,org_id,currency_code,credit_date,total,reason,actor_id)
     VALUES($1,$2,'P','KWD','2026-11-24','4.000','synthetic','op-admin')`, [credit, number]);
  await refused(`INSERT INTO transfer_invoice_credit(credit_number,invoice_number,org_id,currency_code,credit_date,total,reason,actor_id)
     VALUES('SH-2026-11-900000',$1,'P','KWD','2026-11-24','4.000','synthetic','op-admin')`, [number]);
  await assert.rejects(inTransaction(client => insert(client, "SH-2026-11-900001").then(() => undefined)),
    (e: { code?: string }) => e.code === "23514", "an orphan credit note is refused at commit");
  assert.deepEqual(await credits(), []);
  assert.equal((await live(id, "P"))?.invoiceNumber, number, "the invoice stays live");
  await inTransaction(async client => {
    await insert(client, "SH-2026-11-900002");
    await client.query("UPDATE transfer_invoice SET deleted = true, void_reason = 'credited' WHERE invoice_number = $1", [number]);
  });
  assert.deepEqual((await credits()).map(c => c.credit_number), ["SH-2026-11-900002"]);
  assert.equal(await live(id, "P"), undefined);
  await refused("UPDATE transfer_invoice_credit SET reason = 'changed'");
  await refused("UPDATE transfer_invoice SET deleted = false, void_reason = NULL WHERE invoice_number = $1", [number]);
});

test("TRANSFER_INVOICE_VOID_WHO StudentHub's finance users and admins may void a company's invoices; company people, staff and self grants may not", async () => {
  const id = await transfer([["P", "4.000"], ["C1", "2.500"]]);
  await move(id, "lock");
  const c1 = (await live(id, "C1"))!;
  const people: [string, string, string, string][] = [["op-fin", "root", "finance", "subtree"], ["op-fin-self", "root", "finance", "self"], ["staff", "root", "staff", "subtree"],
    ["fin-p", "P", "finance", "subtree"], ["owner-p", "P", "org-owner", "subtree"], ["admin-p", "P", "admin", "subtree"]];
  for (const [who, org, role, scope] of people) {
    await pool.query("INSERT INTO principals(id) VALUES($1)", [who]);
    await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES($1,$2,$3,$4)", [who, org, role, scope]);
  }
  const voiders = new PostgresTransferInvoiceReads({ pool, decision: (rows, orgId, ancestors) => transferInvoiceVoidDecision(rows, orgId, ancestors, ["root"]) });
  const may = async (who: string) => (await voiders.document(who, "P", c1.invoiceNumber)) !== null;
  for (const who of ["op-fin", "op-admin"]) assert.ok(await may(who), who);
  for (const who of ["op-fin-self", "staff", "fin-p", "owner-p", "admin-p", "nobody"]) assert.equal(await may(who), false, who);
  assert.equal(await voiders.listForOrganization("op-fin", "root"), null, "an operator organization is never billed");
  assert.ok(await reads.document("op-fin", "P", c1.invoiceNumber), "StudentHub finance also reads what it voids");
});

async function inTransaction(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}
