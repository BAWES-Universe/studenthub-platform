import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PAY_HISTORY_CALCULATION_VERSION, PostgresTransferInvoiceEffects } from "@studenthub/db/billing";
import { PostgresCandidateStatisticsStore } from "@studenthub/db/reports";
import { CANDIDATE_STATISTICS_CALCULATION_VERSION, CandidateStatisticsService } from "../../reports/src/candidate-statistics.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// Synthetic companies, stores, people and amounts only. Transfers move through the pay lane's own lifecycle.
const url = process.env.DATABASE_URL;
let admin: pg.Pool, pool: pg.Pool, schema: string, shop: string;
const actor = { principalId: "pay-actor", actingAs: false };
const NOW = new Date("2026-11-27T10:00:00Z");
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const move = async (id: string, ...actions: TransferAction[]) => {
  const lifecycle = new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z"));
  for (const action of actions) assert.equal((await lifecycle.transition(actor, id, action)).kind, "changed", action);
};
/** The pay lane's generated calculation; `result` is the stored candidate total unless given. */
const F2 = (hours: string, minutes: number, seconds: number, bonus: string, commission: string, result: string) => ({ version: CANDIDATE_STATISTICS_CALCULATION_VERSION, candidateKey: "k", orgId: "A", contractId: "c",
  input: { rate: { payModel: "hourly", source: "contract", candidateHourlyRate: "2.000", companyHourlyRate: "9.999" }, hours, minutes, seconds, bonus, bonusCommissionPercent: "10.000", transferCost: "7.777", payouts: 1 },
  result: { kind: "calculated", candidateTotal: result, companyTotal: "99.000", bonusCommission: commission } });

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `candidate_stats_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('A','A legal','root')");
  for (const id of [actor.principalId, "me", "other"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  shop = randomUUID();
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,'A','A mall shop',$2,$2)", [shop, "a".repeat(64)]);
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

/** A transfer for month `month` of 2026 with the given lines (paid as asked, before the transfer moves); returns its id. */
async function transfer(month: number, lines: readonly { person?: string; total: string; calculation?: unknown; paid?: boolean }[], currency = "KWD", ...actions: TransferAction[]): Promise<string> {
  const id = randomUUID(), start = `2026-${String(month).padStart(2, "0")}-01`;
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,'A',$2,($2::date + interval '1 month' - interval '1 day')::date,$3)", [id, start, currency]);
  for (const line of lines) {
    const lineId = `line-${randomUUID()}`;
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation)
      VALUES($1,$2,$3,$4,$5,$6,'99.000','synthetic',$7)`, [lineId, id, line.person ?? "me", shop, currency, line.total, JSON.stringify(line.calculation ?? {})]);
    if (line.paid) await pool.query("UPDATE pay_transfer_lines SET paid = true WHERE id = $1", [lineId]);
  }
  await move(id, ...actions);
  return id;
}

test("CANDIDATE_STATISTICS_PG money is what was paid out, per currency, with the bonus after commission split out; hours come from live transfers past draft", async () => {
  assert.equal(CANDIDATE_STATISTICS_CALCULATION_VERSION, PAY_HISTORY_CALCULATION_VERSION, "the pay lane's generated calculation");
  // Paid out and complete: 2:30:15 worked, 12.500 of which 5.000 bonus less 0.500 commission.
  await transfer(1, [{ total: "12.500", calculation: F2("2", 30, 15, "5.000", "0.500", "12.500"), paid: true }, { person: "other", total: "80.000", calculation: F2("40", 0, 0, "0", "0.000", "80.000"), paid: true }],
    "KWD", "lock", "payment_received", "complete");
  // Paid out while distributing: a line added by hand (no calculation) and one edited after generation (its result no longer matches).
  await transfer(2, [{ total: "3.000", paid: true }, { total: "10.000", calculation: F2("9", 0, 0, "4.000", "0.400", "9.000"), paid: true }], "KWD", "lock", "payment_received");
  // Not paid out: hours count, money does not.
  await transfer(3, [{ total: "2.000", calculation: F2("1", 0, 0, "0", "0.000", "2.000"), paid: true }], "KWD", "lock"); // marked paid, but only locked
  await transfer(4, [{ total: "1.500", calculation: F2("0", 45, 50, "0", "0.000", "1.500") }], "KWD", "lock", "payment_received"); // distributing, line unpaid
  // Not counted at all.
  await transfer(5, [{ total: "200.000", calculation: F2("100", 0, 0, "0", "0.000", "200.000") }], "KWD"); // draft
  await transfer(6, [{ total: "100.000", calculation: F2("50", 0, 0, "0", "0.000", "100.000") }], "KWD", "cancel");
  await transfer(7, [{ total: "140.000", calculation: F2("70", 0, 0, "0", "0.000", "140.000") }], "KWD", "lock", "delete");
  // A salary line carrying a bonus input: the pay lane adds no bonus to its total, so all of it is paid.
  const salary = F2("0", 0, 0, "6.000", "0.000", "50.000") as { input: { rate: Record<string, unknown> } };
  salary.input.rate = { payModel: "monthly_salary", source: "contract", candidateTotal: "50.000", companyTotal: "99.000" };
  await transfer(9, [{ total: "50.000", calculation: salary, paid: true }], "KWD", "lock", "payment_received");
  // Another currency stays apart.
  await transfer(8, [{ total: "7.000", paid: true }], "USD", "lock", "payment_received");
  const store = new PostgresCandidateStatisticsStore({ pool });
  const raw = await store.read("me", NOW);
  assert.equal(JSON.stringify(raw).includes("99.000"), false, "the company total is never read");
  assert.equal(JSON.stringify(raw).includes("9.999"), false, "the company rate is never read");
  const stats = await new CandidateStatisticsService(store, () => NOW).own("me");
  assert.deepEqual(stats.worked, { hours: "4", minutes: 16, seconds: 5 });
  assert.deepEqual(stats.money, [
    { currency: "KWD", paid: "71.000", bonus: "4.500", earnings: "75.500" },
    { currency: "USD", paid: "7.000", bonus: "0.000", earnings: "7.000" },
  ]);
  const other = await new CandidateStatisticsService(store, () => NOW).own("other");
  assert.deepEqual([other.worked.hours, other.money], ["40", [{ currency: "KWD", paid: "80.000", bonus: "0.000", earnings: "80.000" }]], "only the person's own lines");
});

test("CANDIDATE_STATISTICS_PG upcoming interviews are the person's scheduled ones after now, for a request not filled or closed", async () => {
  const request = async (status: string) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO recruit_requests(id,org_id,store_id,created_by_principal_id,position_title,description,compensation_text,position_type,headcount,status)
      VALUES($1,'A',$2,$3,'Cashier','Front till','3 KWD an hour','part_time',1,$4)`, [id, shop, actor.principalId, status]);
    return id;
  };
  const interview = async (requestId: string, person: string, at: string, status = "scheduled") => {
    const card = randomUUID();
    await pool.query("INSERT INTO recruit_pipeline_cards(id,request_id,person_principal_id,stage) VALUES($1,$2,$3,'interviewing')", [card, requestId, person]);
    await pool.query("INSERT INTO recruit_interviews(id,card_id,scheduled_at,duration_minutes,mode,status,closed_at) VALUES($1,$2,$3,30,'phone',$4,$5)",
      [randomUUID(), card, at, status, status === "scheduled" ? null : at]);
  };
  const open = await request("open"), filling = await request("filling"), filled = await request("filling");
  await interview(open, "me", "2026-11-28T09:00:00Z"); // counted
  await interview(filling, "me", "2026-11-27T10:00:01Z"); // counted: a second after now
  await interview(filled, "me", "2026-11-29T09:00:00Z"); // the request is filled below
  await pool.query("UPDATE recruit_requests SET status = 'filled' WHERE id = $1", [filled]);
  const other = await request("open");
  await interview(other, "me", "2026-11-27T10:00:00Z"); // exactly now: not upcoming
  await interview(other, "other", "2026-11-28T09:00:00Z"); // someone else's
  const store = new PostgresCandidateStatisticsStore({ pool });
  const cancelled = await request("open");
  await interview(cancelled, "me", "2026-11-30T09:00:00Z", "cancelled");
  assert.equal((await store.read("me", NOW)).upcomingInterviews, 2);
  assert.equal((await store.read("other", NOW)).upcomingInterviews, 1);
});
