import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresLegacyInvoiceStore } from "@studenthub/db/billing";
import { mapLegacyInvoices, reconcileLegacyInvoices, LEGACY_TRANSFER_STATUS, type LegacyInvoiceSourceRow } from "@studenthub/billing";

// Synthetic legacy rows only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let schema: string;
const row = (over: Partial<LegacyInvoiceSourceRow> = {}): LegacyInvoiceSourceRow => ({
  invoiceId: "101", transferId: "501", parentTransferId: null, companyId: "7", invoiceDate: "2026-09-30",
  invoiceStatus: "unpaid", invoiceDeleted: false, transferStatus: LEGACY_TRANSFER_STATUS.lock,
  transferDeleted: false, companyTotal: "125.5", currencyCode: "KWD", ...over,
});

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `legacy_invoice_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

test("LEGACY_INVOICE_PG_ROUNDTRIP an import reads back identical and reconciles clean", async () => {
  const store = new PostgresLegacyInvoiceStore(pool);
  const source = [
    row({ invoiceId: "1", companyTotal: "0.1" }),
    row({ invoiceId: "2", companyTotal: "0.2", parentTransferId: "500" }),
    row({ invoiceId: "3", invoiceStatus: "paid", companyTotal: "9007199254740.993" }),
    row({ invoiceId: "4", invoiceDeleted: true }),
  ];
  const result = await store.importBatch(mapLegacyInvoices(source).records);
  assert.deepEqual(result, { inserted: 4, advanced: 0, unchanged: 0, conflicts: [] });
  const stored = await store.readAll();
  assert.deepEqual(stored, mapLegacyInvoices(source).records);
  const report = reconcileLegacyInvoices(source, stored);
  assert.equal(report.clean, true);
  assert.deepEqual(report.totals["7|KWD|unpaid"], { source: { count: 2, sum: "0.300" }, target: { count: 2, sum: "0.300" } });
  assert.deepEqual((await store.findByNumber("LEGACY-3"))?.total, "9007199254740.993");
});

test("LEGACY_INVOICE_PG_RERUN re-import is idempotent and only moves invoices forward", async () => {
  const store = new PostgresLegacyInvoiceStore(pool);
  const first = [row({ invoiceId: "1" }), row({ invoiceId: "2" }), row({ invoiceId: "3", invoiceStatus: "paid" })];
  await store.importBatch(mapLegacyInvoices(first).records);
  assert.deepEqual(await store.importBatch(mapLegacyInvoices(first).records), { inserted: 0, advanced: 0, unchanged: 3, conflicts: [] });

  const next = [
    row({ invoiceId: "1", invoiceStatus: "paid" }),            // paid since the last refresh
    row({ invoiceId: "2", invoiceDeleted: true }),             // soft-deleted since
    row({ invoiceId: "3", invoiceStatus: "unpaid" }),          // went backwards: refused
    row({ invoiceId: "5" }),                                   // new
  ];
  const result = await store.importBatch(mapLegacyInvoices(next).records);
  assert.deepEqual(result, { inserted: 1, advanced: 2, unchanged: 0, conflicts: ["LEGACY-3"] });
  const stored = new Map((await store.readAll()).map(r => [r.invoiceNumber, r]));
  assert.equal(stored.get("LEGACY-1")?.status, "paid");
  assert.equal(stored.get("LEGACY-2")?.deleted, true);
  assert.equal(stored.get("LEGACY-3")?.status, "paid", "a conflict writes nothing");

  const changedTotal = await store.importBatch(mapLegacyInvoices([row({ invoiceId: "5", companyTotal: "125.501" })]).records);
  assert.deepEqual(changedTotal.conflicts, ["LEGACY-5"]);
  assert.equal((await store.findByNumber("LEGACY-5"))?.total, "125.500");
});

test("LEGACY_INVOICE_PG_FROZEN the table refuses edits, removal and backwards moves even outside the store", async () => {
  const store = new PostgresLegacyInvoiceStore(pool);
  await store.importBatch(mapLegacyInvoices([row({ invoiceId: "1", invoiceStatus: "paid", invoiceDeleted: true })]).records);
  const refused = async (sql: string) => assert.rejects(pool.query(sql), (error: { code?: string }) => error.code === "23514", sql);
  await refused("UPDATE legacy_invoice SET total = total + 1");
  await refused("UPDATE legacy_invoice SET company_id = 8");
  await refused("UPDATE legacy_invoice SET invoice_date = invoice_date + 1");
  await refused("UPDATE legacy_invoice SET status = 'unpaid'");
  await refused("UPDATE legacy_invoice SET deleted = false");
  await refused("DELETE FROM legacy_invoice");
  await refused("TRUNCATE legacy_invoice");
  await assert.rejects(pool.query(`INSERT INTO legacy_invoice (invoice_number, legacy_invoice_id, transfer_id, company_id,
    invoice_date, status, total, currency_code, deleted) VALUES ('LEGACY-2', 3, 1, 1, '2026-01-01', 'paid', 1, 'KWD', false)`),
  (error: { code?: string }) => error.code === "23514", "the number is always LEGACY-<legacy id>");
  assert.equal((await store.readAll()).length, 1);
});

test("LEGACY_INVOICE_PG_ATOMIC a failing batch leaves nothing behind", async () => {
  const store = new PostgresLegacyInvoiceStore(pool);
  const records = mapLegacyInvoices([row({ invoiceId: "1" }), row({ invoiceId: "2" })]).records;
  const broken = [records[0]!, { ...records[1]!, currencyCode: "toolong" }];
  await assert.rejects(store.importBatch(broken));
  assert.deepEqual(await store.readAll(), []);
});
