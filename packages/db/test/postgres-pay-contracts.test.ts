import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import {
  PostgresFinanceReferenceResolver, PostgresPayContractStore, organizationAuditRef, principalAuditRef, runMigrations,
} from "@studenthub/db";
import { PayContractError, PayContracts, resolveEffectiveRate, validateBankDetails, type PayContract } from "@studenthub/pay-contracts";

// Synthetic fixtures only: candidate C at store S of company O.
const DB_URL = process.env.DATABASE_URL ?? "";
const STAFF = "principal-pay-staff";
const C = "principal-pay-candidate-c";
const O = "org-pay-company-o";
const S = "store-pay-s";
const FIXED = new Date("2026-10-07T12:00:00.000Z");
let pool: pg.Pool;
let kwd: string;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL pay-contract tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
});
beforeEach(async () => {
  // Owner administration for isolation; app paths cannot truncate the audit ledger.
  await pool.query("ALTER TABLE authorization_mutation_audit DISABLE TRIGGER authorization_mutation_audit_no_truncate");
  try {
    await pool.query("TRUNCATE authorization_mutation_audit, pay_contracts, catalogue_submissions, catalogue_items RESTART IDENTITY CASCADE");
  } finally {
    await pool.query("ALTER TABLE authorization_mutation_audit ENABLE TRIGGER authorization_mutation_audit_no_truncate");
  }
  await pool.query("DELETE FROM principals WHERE id = ANY($1)", [[STAFF, C]]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [O]);
  await pool.query("INSERT INTO principals (id) VALUES ($1), ($2)", [STAFF, C]);
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Synthetic Company O')", [O]);
  kwd = await catalogueItem("currency", "active");
});
after(async () => { await pool.end(); });

function service() {
  return new PayContracts(new PostgresPayContractStore(pool), new PostgresFinanceReferenceResolver(pool), () => FIXED);
}

async function catalogueItem(type: string, status: "active" | "deleted"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5, $6, $6, $7)`,
    [id, type, `Synthetic ${type} ${id.slice(0, 8)}`, status, "a".repeat(64), FIXED, status === "deleted" ? FIXED : null],
  );
  return id;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: C, companyId: O, storeId: S, startDate: "2026-01-01", endDate: "2026-06-30", currencyId: kwd,
    terms: { payModel: "hourly", candidateHourlyRate: "1.5", companyHourlyRate: "2.25" }, ...overrides,
  };
}

test("SHU182/PG-01 each pay model round-trips with exact decimals and calendar dates", async () => {
  const hourly = await service().create(STAFF, input());
  const fixed = await service().create(STAFF, input({
    startDate: "2026-07-01", endDate: "2026-07-31", transferCost: "0.125",
    terms: { payModel: "fixed_price", candidateTotal: "100", companyTotal: "120.5", completionPercentage: 40 },
  }));
  const monthly = await service().create(STAFF, input({
    startDate: "2026-08-01", endDate: undefined, autoGenerate: true,
    terms: { payModel: "monthly_salary", candidateTotal: "300", companyTotal: "360.005", salaryDay: 25 },
  }));
  const fresh = new PayContracts(new PostgresPayContractStore(pool), new PostgresFinanceReferenceResolver(pool), () => FIXED);
  for (const created of [hourly, fixed, monthly]) assert.deepEqual(await fresh.get(created.id), created);
  assert.equal(monthly.endDate, undefined);
  assert.deepEqual((await fresh.listForCandidate(C)).map((c) => c.id), [monthly.id, fixed.id, hourly.id]);
});

test("SHU182/PG-02 the table refuses rows the domain would refuse", async () => {
  const valid = await service().create(STAFF, input());
  const { rows } = await pool.query("SELECT * FROM pay_contracts WHERE id = $1", [valid.id]);
  const row = rows[0] as Record<string, unknown>;
  const attempts: Record<string, Record<string, unknown>> = {
    "company rate below candidate": { company_hourly_rate: "1.000" },
    "zero candidate rate": { candidate_hourly_rate: "0", company_hourly_rate: "1" },
    "hourly row carrying a total": { candidate_total: "5", company_total: "6" },
    "fixed price without totals": { pay_model: "fixed_price" },
    "auto-generate on hourly": { auto_generate: true },
    "end before start": { end_date: "2025-12-31" },
    "deleted without deleted_at": { status: "deleted" },
    "negative transfer cost": { transfer_cost: "-0.001" },
    "unknown pay model": { pay_model: "commission" },
    "malformed store id": { store_id: "store with spaces" },
    // A NULL term makes the per-model comparison unknown; the CHECK must still refuse it.
    "hourly without rates": { candidate_hourly_rate: null, company_hourly_rate: null },
    "hourly without a company rate": { company_hourly_rate: null },
    "fixed price without a candidate total": { pay_model: "fixed_price", candidate_hourly_rate: null, company_hourly_rate: null, company_total: "10", completion_percentage: 10 },
    "monthly without a company total": { pay_model: "monthly_salary", candidate_hourly_rate: null, company_hourly_rate: null, candidate_total: "5", salary_day: 3 },
  };
  for (const [label, change] of Object.entries(attempts)) {
    const next = { ...row, ...change, id: randomUUID() };
    const columns = Object.keys(next);
    await assert.rejects(
      pool.query(`INSERT INTO pay_contracts (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(next)),
      (error: unknown) => (error as { code?: string }).code === "23514",
      `expected a CHECK violation for ${label}`,
    );
  }
});

test("SHU182/PG-03 a failed audit insert rolls back the contract in the same transaction", async () => {
  const store = new PostgresPayContractStore(pool);
  const contract: PayContract = {
    id: randomUUID(), candidateId: C, companyId: O, storeId: S, startDate: "2026-01-01", currencyId: kwd, transferCost: "0.000",
    autoGenerate: false, status: "active", terms: { payModel: "hourly", candidateHourlyRate: "1.000", companyHourlyRate: "2.000" },
    createdAt: FIXED.toISOString(), updatedAt: FIXED.toISOString(),
  };
  await assert.rejects(store.transaction(async (tx) => {
    await tx.insert(contract);
    // A negative count violates the closed audit shape, so the database refuses the audit row.
    await tx.audit({ operation: "pay_contract.create", actorId: STAFF, candidateId: C, companyId: O, payModel: "hourly", countBefore: 0, countAfter: -1 });
  }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pay_contracts")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM authorization_mutation_audit")).rows[0].n, 0);
});

test("SHU182/PG-04 concurrent overlapping creates leave exactly one contract", async () => {
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => service().create(STAFF, input())));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) {
    if (r.status === "rejected") assert.ok(r.reason instanceof PayContractError && r.reason.code === "overlapping_contract", String(r.reason));
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pay_contracts")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM authorization_mutation_audit")).rows[0].n, 1);
});

test("SHU182/PG-05 audit rows name actor, candidate and company by reference with a closed summary", async () => {
  const created = await service().create(STAFF, input());
  await service().update(STAFF, created.id, {
    startDate: "2026-01-01", endDate: "2026-03-31", currencyId: kwd,
    terms: { payModel: "fixed_price", candidateTotal: "100", companyTotal: "100", completionPercentage: 0 },
  });
  await service().remove(STAFF, created.id);
  const { rows } = await pool.query(
    "SELECT operation, actor_principal_ref, target_principal_ref, target_org_refs, before_summary, after_summary FROM authorization_mutation_audit ORDER BY occurred_at, id",
  );
  assert.deepEqual(rows.map((r) => [r.operation, r.before_summary, r.after_summary]), [
    ["pay_contract.create", { payModel: "hourly", contractCount: 0 }, { payModel: "hourly", contractCount: 1 }],
    ["pay_contract.update", { payModel: "fixed_price", contractCount: 1 }, { payModel: "fixed_price", contractCount: 1 }],
    ["pay_contract.remove", { payModel: "fixed_price", contractCount: 1 }, { payModel: "fixed_price", contractCount: 0 }],
  ]);
  for (const row of rows) {
    assert.equal(row.actor_principal_ref, principalAuditRef(STAFF));
    assert.equal(row.target_principal_ref, principalAuditRef(C));
    assert.deepEqual(row.target_org_refs, [organizationAuditRef(O)]);
    for (const summary of [row.before_summary, row.after_summary]) assert.deepEqual(Object.keys(summary).sort(), ["contractCount", "payModel"]);
  }
  // The ledger refuses an amount smuggled into the summary and a contract audit with no company.
  for (const [orgs, summary] of [
    [[organizationAuditRef(O)], { payModel: "hourly", contractCount: 1, candidateHourlyRate: "1.5" }],
    [[], { payModel: "hourly", contractCount: 1 }],
  ] as const) {
    await assert.rejects(pool.query(
      `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
       VALUES ($1, $2, 'pay_contract.create', $2, $3::text[], $4::jsonb, $4::jsonb)`,
      ["b".repeat(64), principalAuditRef(STAFF), orgs, JSON.stringify(summary)],
    ), (error: unknown) => (error as { code?: string }).code === "23514");
  }
  const row = (await pool.query("SELECT status, deleted_at FROM pay_contracts WHERE id = $1", [created.id])).rows[0];
  assert.equal(row.status, "deleted", "removal keeps the row");
  assert.ok(row.deleted_at instanceof Date);
});

test("SHU182/PG-06 stored contracts feed resolution, and catalogue banks gate bank details", async () => {
  const created = await service().create(STAFF, input());
  const resolution = resolveEffectiveRate({
    candidateId: C, storeId: S, contracts: await service().listForCandidate(C), period: { start: "2026-03-01", end: "2026-03-31" }, today: "2026-10-07",
  });
  assert.equal(resolution.source, "contract");
  assert.equal(resolution.contractId, created.id);
  const bank = await catalogueItem("bank", "active");
  const closed = await catalogueItem("bank", "deleted");
  const references = new PostgresFinanceReferenceResolver(pool);
  const details = await validateBankDetails({ bankId: bank, iban: "kw81 cbku 0000 0000 0000 1234 5601 01", beneficiaryName: "Synthetic Person" }, references);
  assert.equal(details.iban, "KW81CBKU0000000000001234560101");
  await assert.rejects(validateBankDetails({ bankId: closed, iban: details.iban, beneficiaryName: "Synthetic Person" }, references));
  // A currency id must name a currency, not some other catalogue row.
  await assert.rejects(service().create(STAFF, input({ startDate: "2027-01-01", endDate: undefined, currencyId: bank })),
    (error: unknown) => error instanceof PayContractError && error.code === "invalid_currency");
});
