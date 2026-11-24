import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresTransferInvoiceEffects } from "@studenthub/db/billing";
import { PostgresRevenueStore } from "@studenthub/db/reports";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// Synthetic companies, stores, people and amounts only. Transfers move through the pay lane's own lifecycle.
const url = process.env.DATABASE_URL;
let admin: pg.Pool, pool: pg.Pool, store: PostgresRevenueStore, schema: string, shop: string;
const actor = { principalId: "rev-actor", actingAs: false };
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const move = async (id: string, ...actions: TransferAction[]) => {
  const lifecycle = new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z"));
  for (const action of actions) assert.equal((await lifecycle.transition(actor, id, action)).kind, "changed", action);
};

before(async () => { assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database"); admin = new pg.Pool({ connectionString: url }); });
beforeEach(async () => {
  schema = `reports_revenue_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('A','A legal','root')");
  for (const id of [actor.principalId, "p1", "p2"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  shop = randomUUID();
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,'A','A shop',$2,$2)", [shop, "a".repeat(64)]);
  store = new PostgresRevenueStore({ pool });
});
afterEach(async () => { await pool?.end(); if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
after(async () => { await admin?.end(); });

/** A transfer whose pay period is `month` (YYYY-MM), with lines of [candidate, company] totals. */
async function transfer(month: string, lines: readonly [string, string][], currency = "KWD"): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,'A',$2::date,($2::date + interval '1 month' - interval '1 day')::date,$3)", [id, `${month}-01`, currency]);
  for (const [i, [candidate, company]] of lines.entries())
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic','{}')`,
      [`line-${randomUUID()}`, id, i % 2 ? "p2" : "p1", shop, currency, candidate, company]);
  return id;
}

test("REPORTS_REVENUE by status: every transfer once per currency and status, sums exact, deleted left out", async () => {
  const done = await transfer("2026-09", [["0.100", "0.300"], ["0.200", "0.400"]]);
  await move(done, "lock", "payment_received");
  await pool.query("UPDATE pay_transfer_lines SET paid = true WHERE transfer_id = $1", [done]); // every line paid before completing
  await move(done, "complete");
  const sent = await transfer("2026-10", [["10.000", "12.500"]]);
  await move(sent, "lock", "payment_sent");
  await transfer("2026-10", [["1.000", "2.000"]]); // a draft
  const gone = await transfer("2026-10", [["5.000", "6.000"]]);
  await move(gone, "delete");
  await transfer("2026-10", [["7.000", "8.000"]], "USD");
  const rows = (await store.read("2026-09", "2026-10")).byStatus;
  assert.deepEqual(rows.map(r => [r.currency, r.status, r.transfers, r.lines, r.companyTotal, r.candidateTotal, r.grossProfit]), [
    ["KWD", "draft", 1, 1, "2.000", "1.000", "1.000"],
    ["KWD", "payment_sent", 1, 1, "12.500", "10.000", "2.500"],
    ["KWD", "complete", 1, 2, "0.700", "0.300", "0.400"],
    ["USD", "draft", 1, 1, "8.000", "7.000", "1.000"],
  ], "lifecycle order within each currency; the deleted transfer is not counted");
});

test("REPORTS_REVENUE by month: by pay period, drafts and cancelled left out, received only once payment is sent", async () => {
  const sep = await transfer("2026-09", [["1.000", "3.000"]]);
  await move(sep, "lock");
  const oct = await transfer("2026-10", [["2.000", "5.000"], ["1.000", "1.500"]]);
  await move(oct, "lock", "payment_received");
  const cancelled = await transfer("2026-10", [["9.000", "9.500"]]);
  await move(cancelled, "cancel");
  await transfer("2026-10", [["4.000", "4.500"]]); // a draft
  const early = await transfer("2026-08", [["1.000", "1.000"]]);
  await move(early, "lock");
  const rows = (await store.read("2026-09", "2026-10")).byMonth;
  assert.deepEqual(rows.map(r => [r.currency, r.month, r.transfers, r.companyTotal, r.candidateTotal, r.grossProfit, r.received]), [
    ["KWD", "2026-09", 1, "3.000", "1.000", "2.000", "0.000"],
    ["KWD", "2026-10", 1, "6.500", "3.000", "3.500", "6.500"],
  ]);
  await assert.rejects(store.read("2026-10", "2026-09"), /invalid month range/);
  await assert.rejects(store.read("2026-13", "2026-12"), /invalid month range/);
});

test("REPORTS_REVENUE one snapshot: a payment recorded while the page is read shows in neither view or both", async () => {
  const oct = await transfer("2026-10", [["2.000", "5.000"]]);
  await move(oct, "lock");
  let statements = 0;
  // A pool whose client records the payment on another connection right after the reconciliation is read.
  const racing = { connect: async () => {
    const client = await pool.connect(), query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...a: unknown[]) => { const r = await query(...a); if (++statements === 2) await move(oct, "payment_received"); return r; };
    return client;
  } } as unknown as pg.Pool;
  const page = await new PostgresRevenueStore({ pool: racing }).read("2026-10", "2026-10");
  assert.ok(statements >= 3, "the payment committed between the two reads");
  assert.deepEqual(page.byStatus.map(r => r.status), ["locked"]);
  assert.deepEqual(page.byMonth.map(r => r.received), ["0.000"], "the months agree with the reconciliation, not with the later payment");
  const after = await store.read("2026-10", "2026-10");
  assert.deepEqual([after.byStatus.map(r => r.status), after.byMonth.map(r => r.received)], [["distributing"], ["5.000"]]);
});

test("REPORTS_REVENUE amounts: exact scale-3 text, zero as 0.000, no integer ceiling", async () => {
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,'A','2026-10-01','2026-10-31','KWD')", [randomUUID()]); // a draft with no lines
  await transfer("2026-10", [["999999999.999", "999999999.999"], ["999999999.999", "999999999.999"]], "USD");
  // Widen the scratch column so one sum passes the old 15-digit picture; the store must not care.
  await pool.query("ALTER TABLE pay_transfer_lines ALTER COLUMN company_total TYPE numeric, ALTER COLUMN candidate_total TYPE numeric");
  await transfer("2026-10", [["1.000", "123456789012345678.001"], ["0.500", "999999999999999999.999"]], "EUR");
  const rows = (await store.read("2026-10", "2026-10")).byStatus;
  assert.deepEqual(rows.map(r => [r.currency, r.lines, r.companyTotal, r.candidateTotal, r.grossProfit]), [
    ["EUR", 2, "1123456789012345678.000", "1.500", "1123456789012345676.500"],
    ["KWD", 0, "0.000", "0.000", "0.000"],
    ["USD", 2, "1999999999.998", "1999999999.998", "0.000"],
  ]);
});
