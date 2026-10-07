import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BankDetailError, InMemoryFinanceReferenceResolver, InMemoryPayContractStore, PayContractError, PayContracts,
  RATE_RESOLUTION_VERSION, RateResolutionError, normalizeIban, resolveEffectiveRate, validateBankDetails,
  type PayContract,
} from "../src/index.js";

// Synthetic fixtures only: candidate C at store S of company O; catalogue ids are made up.
const STAFF = "principal-staff-1";
const C = "principal-candidate-c";
const D = "principal-candidate-d";
const O = "org-company-o";
const S = "store-s";
const S2 = "store-s2";
const KWD = "11111111-1111-4111-8111-111111111111";
const OLD_CURRENCY = "22222222-2222-4222-8222-222222222222";
const BANK = "33333333-3333-4333-8333-333333333333";
const CLOSED_BANK = "44444444-4444-4444-8444-444444444444";
const FIXED = new Date("2026-10-07T12:00:00.000Z");
const TODAY = "2026-10-07";

function rig() {
  const store = new InMemoryPayContractStore();
  const references = new InMemoryFinanceReferenceResolver();
  references.set("currency", KWD);
  references.set("currency", OLD_CURRENCY, "deleted");
  references.set("bank", BANK);
  references.set("bank", CLOSED_BANK, "deleted");
  return { store, references, contracts: new PayContracts(store, references, () => FIXED) };
}

const hourly = { payModel: "hourly", candidateHourlyRate: "1.500", companyHourlyRate: "2.250" } as const;
const monthly = { payModel: "monthly_salary", candidateTotal: "300", companyTotal: "360.5", salaryDay: 25 } as const;
const fixedPrice = { payModel: "fixed_price", candidateTotal: "100", companyTotal: "120", completionPercentage: 40 } as const;

function input(overrides: Record<string, unknown> = {}) {
  return { candidateId: C, companyId: O, storeId: S, startDate: "2026-01-01", endDate: "2026-06-30", currencyId: KWD, terms: hourly, ...overrides };
}

async function rejects(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PayContractError || error instanceof BankDetailError, `unexpected ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

function throwsResolution(run: () => unknown, code: string): RateResolutionError {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof RateResolutionError, `expected RateResolutionError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

/** Imported legacy data can hold overlaps the new write path refuses; tests reach it through the store. */
function legacyRow(id: string, overrides: Partial<PayContract>): PayContract {
  return Object.freeze({
    id, candidateId: C, companyId: O, storeId: S, startDate: "2026-01-01", currencyId: KWD, transferCost: "0.000",
    autoGenerate: false, status: "active", terms: { payModel: "hourly", candidateHourlyRate: "1.000", companyHourlyRate: "2.000" },
    createdAt: FIXED.toISOString(), updatedAt: FIXED.toISOString(), ...overrides,
  } as PayContract);
}

test("SHU182_OVERLAP_REFUSED overlapping contracts for one candidate and store are refused, whatever the pay model", async () => {
  const { contracts } = rig();
  const first = await contracts.create(STAFF, input());
  await rejects(contracts.create(STAFF, input({ startDate: "2026-05-01", endDate: "2026-12-31", terms: monthly })), "overlapping_contract", 409);
  await rejects(contracts.create(STAFF, input({ startDate: "2025-12-01", endDate: undefined, terms: fixedPrice })), "overlapping_contract", 409);
  await rejects(contracts.create(STAFF, input({ startDate: "2026-06-30", endDate: "2026-07-31" })), "overlapping_contract", 409);
  // The day after the end does not overlap; another store or another candidate never does.
  const next = await contracts.create(STAFF, input({ startDate: "2026-07-01", endDate: undefined, terms: monthly }));
  await contracts.create(STAFF, input({ storeId: S2 }));
  await contracts.create(STAFF, input({ candidateId: D }));
  // Moving an existing contract into another one is refused too.
  await rejects(contracts.update(STAFF, first.id, { startDate: "2026-01-01", endDate: "2026-07-15", currencyId: KWD, terms: hourly }), "overlapping_contract", 409);
  // A removed contract no longer blocks its period.
  await contracts.remove(STAFF, next.id);
  await contracts.create(STAFF, input({ startDate: "2026-08-01", endDate: "2026-08-31" }));
});

test("SHU182_CONCURRENT_CREATE two simultaneous overlapping creates leave exactly one contract", async () => {
  const { contracts, store } = rig();
  const results = await Promise.allSettled([
    contracts.create(STAFF, input()),
    contracts.create(STAFF, input({ terms: monthly })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.listForCandidate(C)).length, 1);
});

test("SHU182_TERMS_VALIDATION closed fields, exact decimals, and the company side covers the candidate side", async () => {
  const { contracts } = rig();
  await rejects(contracts.create(STAFF, { ...input(), extra: 1 }), "invalid_contract", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...hourly, note: "x" } })), "invalid_contract", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...hourly, candidateHourlyRate: "1.2345" } })), "invalid_candidate_rate", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...hourly, candidateHourlyRate: "0" } })), "invalid_candidate_rate", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...hourly, companyHourlyRate: "-2" } })), "invalid_company_rate", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...hourly, companyHourlyRate: "1.499" } })), "company_amount_below_candidate", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...monthly, salaryDay: 32 } })), "invalid_salary_day", 400);
  await rejects(contracts.create(STAFF, input({ terms: { ...fixedPrice, completionPercentage: 101 } })), "invalid_completion_percentage", 400);
  await rejects(contracts.create(STAFF, input({ terms: { payModel: "weekly" } })), "invalid_pay_model", 400);
  await rejects(contracts.create(STAFF, input({ startDate: "2026-02-30" })), "invalid_start_date", 400);
  await rejects(contracts.create(STAFF, input({ endDate: "2025-12-31" })), "invalid_end_date", 400);
  await rejects(contracts.create(STAFF, input({ autoGenerate: true })), "invalid_auto_generate", 400);
  await rejects(contracts.create(STAFF, input({ transferCost: "1e3" })), "invalid_transfer_cost", 400);
  await rejects(contracts.create("", input()), "unauthorized", 401);
  const created = await contracts.create(STAFF, input({ terms: monthly, autoGenerate: true, transferCost: 2.5 }));
  assert.deepEqual(created.terms, { payModel: "monthly_salary", candidateTotal: "300.000", companyTotal: "360.500", salaryDay: 25 });
  assert.equal(created.transferCost, "2.500");
  assert.equal(created.autoGenerate, true);
  assert.equal(created.status, "active");
});

test("SHU182_CURRENCY_ACTIVE a new or changed currency must be active; an unchanged historical one may stay", async () => {
  const { contracts, store, references } = rig();
  await rejects(contracts.create(STAFF, input({ currencyId: OLD_CURRENCY })), "invalid_currency", 400);
  await rejects(contracts.create(STAFF, input({ currencyId: "55555555-5555-4555-8555-555555555555" })), "invalid_currency", 400);
  const created = await contracts.create(STAFF, input());
  references.set("currency", KWD, "deleted");
  const updated = await contracts.update(STAFF, created.id, { startDate: "2026-01-01", endDate: "2026-03-31", currencyId: KWD, terms: hourly });
  assert.equal(updated.endDate, "2026-03-31");
  assert.equal((await store.get(created.id))?.currencyId, KWD);
  const failing = new PayContracts(store, { resolve: async () => { throw new Error("catalogue down"); } }, () => FIXED);
  await rejects(failing.create(STAFF, input({ storeId: S2 })), "reference_unavailable", 503);
});

test("SHU182_PARTIES_FIXED update cannot move a contract to another candidate, company or store; unknown ids are 404", async () => {
  const { contracts } = rig();
  const created = await contracts.create(STAFF, input());
  await rejects(contracts.update(STAFF, created.id, { ...input(), candidateId: D }), "invalid_contract", 400);
  await rejects(contracts.update(STAFF, "66666666-6666-4666-8666-666666666666", { startDate: "2026-01-01", currencyId: KWD, terms: hourly }), "not_found", 404);
  await rejects(contracts.get("not-a-uuid"), "not_found", 404);
  const removed = await contracts.remove(STAFF, created.id);
  assert.equal(removed.status, "deleted");
  await rejects(contracts.get(created.id), "not_found", 404);
  await rejects(contracts.remove(STAFF, created.id), "not_found", 404);
  assert.deepEqual(await contracts.listForCandidate(C), []);
});

test("SHU182_AUDIT_ATOMIC a contract and its audit row commit or fail together, and the audit carries no amounts", async () => {
  const { contracts, store } = rig();
  store.failNextAudit = true;
  await assert.rejects(contracts.create(STAFF, input()), /injected audit failure/);
  assert.equal((await store.listForCandidate(C)).length, 0);
  const created = await contracts.create(STAFF, input());
  await contracts.update(STAFF, created.id, { startDate: "2026-01-01", endDate: "2026-02-28", currencyId: KWD, terms: hourly });
  await contracts.remove(STAFF, created.id);
  assert.deepEqual(store.auditLog.map((a) => [a.operation, a.payModel, a.countBefore, a.countAfter]), [
    ["pay_contract.create", "hourly", 0, 1],
    ["pay_contract.update", "hourly", 1, 1],
    ["pay_contract.remove", "hourly", 1, 0],
  ]);
  for (const entry of store.auditLog) {
    assert.deepEqual(Object.keys(entry).sort(), ["actorId", "candidateId", "companyId", "countAfter", "countBefore", "operation", "payModel"]);
  }
});

test("SHU182_RESOLUTION_RECORDED a contract rate comes back with its version, rule trail and matched contract", async () => {
  const { contracts, store } = rig();
  const created = await contracts.create(STAFF, input());
  const resolution = resolveEffectiveRate({
    candidateId: C, storeId: S, contracts: await store.listForCandidate(C),
    period: { start: "2026-03-01", end: "2026-03-31" }, today: TODAY,
  });
  assert.deepEqual(resolution, {
    version: RATE_RESOLUTION_VERSION,
    steps: ["contracts_matched_by_period", "single_contract_selected"],
    matchedContractIds: [created.id],
    source: "contract",
    contractId: created.id,
    payModel: "hourly",
    candidateHourlyRate: "1.500",
    companyHourlyRate: "2.250",
  });
  const monthlyContract = await contracts.create(STAFF, input({ startDate: "2026-07-01", endDate: undefined, terms: monthly, transferCost: "1" }));
  const monthlyResolution = resolveEffectiveRate({
    candidateId: C, storeId: S, contracts: await store.listForCandidate(C),
    period: { start: "2026-09-01", end: "2026-09-30" }, today: TODAY, payModel: "monthly_salary",
  });
  assert.deepEqual(monthlyResolution, {
    version: RATE_RESOLUTION_VERSION,
    steps: ["contracts_matched_by_period", "pay_model_filter", "single_contract_selected"],
    matchedContractIds: [monthlyContract.id],
    source: "contract",
    contractId: monthlyContract.id,
    payModel: "monthly_salary",
    candidateTotal: "300.000",
    companyTotal: "360.500",
    transferCost: "1.000",
  });
});

test("SHU182_PERIOD_SELECTION contracts are chosen by overlap with the period, or by not having ended before today", () => {
  const history = legacyRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { startDate: "2025-01-01", endDate: "2025-12-31" });
  const current = legacyRow("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { startDate: "2026-01-01" });
  const deleted = legacyRow("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { startDate: "2025-06-01", status: "deleted", deletedAt: FIXED.toISOString() });
  const all = [history, current, deleted];
  const pick = (period?: { start: string; end: string }, today = TODAY) => resolveEffectiveRate({ candidateId: C, storeId: S, contracts: all, period, today });
  assert.equal(pick({ start: "2025-03-01", end: "2025-03-31" }).contractId, history.id);
  assert.equal(pick({ start: "2026-03-01", end: "2026-03-31" }).contractId, current.id);
  // Without a period legacy keeps any contract not ended before today, even one that starts later.
  const future = legacyRow("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { storeId: S2, startDate: "2027-01-01" });
  assert.equal(resolveEffectiveRate({ candidateId: C, storeId: S2, contracts: [future], today: TODAY }).contractId, future.id);
  assert.equal(pick(undefined).contractId, current.id);
  // Inactive contracts still match, as in legacy; deleted ones never do.
  const inactive = legacyRow("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { storeId: S2, status: "inactive" });
  assert.equal(resolveEffectiveRate({ candidateId: C, storeId: S2, contracts: [inactive], today: TODAY }).contractId, inactive.id);
  throwsResolution(() => pick({ start: "2026-03-31", end: "2026-03-01" }), "invalid_period");
});

test("SHU182_AMBIGUOUS_REJECTED two matching contracts are refused, not resolved to the newest; an explicit id settles it", () => {
  const older = legacyRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { startDate: "2026-01-01" });
  const newer = legacyRow("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { startDate: "2026-02-01",
    terms: { payModel: "monthly_salary", candidateTotal: "300.000", companyTotal: "350.000", salaryDay: 1 } });
  const base = { candidateId: C, storeId: S, contracts: [older, newer], period: { start: "2026-03-01", end: "2026-03-31" }, today: TODAY };
  const error = throwsResolution(() => resolveEffectiveRate(base), "ambiguous_contract");
  assert.equal(error.status, 409);
  assert.deepEqual(error.matchedContractIds, [newer.id, older.id]);
  assert.equal(resolveEffectiveRate({ ...base, contractId: older.id }).contractId, older.id);
  assert.equal(resolveEffectiveRate({ ...base, payModel: "hourly" }).contractId, older.id);
});

test("SHU182_MANUAL_FALLBACK with no matching contract, entered rates win, then the candidate's, the company's and the parent's", () => {
  const removed = legacyRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { status: "deleted", deletedAt: FIXED.toISOString() });
  const base = { candidateId: C, storeId: S, contracts: [removed], today: TODAY };
  const entered = resolveEffectiveRate({ ...base, entered: { candidateHourlyRate: "1.25", companyHourlyRate: "2" },
    defaults: { candidateHourlyRate: "9", companyHourlyRate: "9" } });
  assert.deepEqual(entered, {
    version: RATE_RESOLUTION_VERSION,
    steps: ["contracts_matched_active_today", "no_matching_contract", "candidate_rate_from_input", "company_rate_from_input"],
    matchedContractIds: [], source: "manual", contractId: null, payModel: "hourly",
    candidateHourlyRate: "1.250", companyHourlyRate: "2.000",
  });
  const parent = resolveEffectiveRate({ ...base, defaults: { candidateHourlyRate: "1", companyHourlyRate: "0", parentCompanyHourlyRate: "1.5" } });
  assert.deepEqual(parent.steps.slice(2), ["candidate_rate_from_candidate", "company_rate_from_parent"]);
  assert.equal(parent.source === "manual" && parent.companyHourlyRate, "1.500");
  const company = resolveEffectiveRate({ ...base, defaults: { candidateHourlyRate: "1", companyHourlyRate: "1.2", parentCompanyHourlyRate: "5" } });
  assert.equal(company.source === "manual" && company.companyHourlyRate, "1.200");
  assert.equal(company.steps.at(-1), "company_rate_from_company");
  // An entered rate is used as entered: a zero or malformed one is refused, not replaced by a default.
  throwsResolution(() => resolveEffectiveRate({ ...base, entered: { candidateHourlyRate: "0" }, defaults: { candidateHourlyRate: "1", companyHourlyRate: "2" } }), "candidate_rate_unavailable");
  throwsResolution(() => resolveEffectiveRate({ ...base, entered: { candidateHourlyRate: "abc" }, defaults: { companyHourlyRate: "2" } }), "candidate_rate_unavailable");
  throwsResolution(() => resolveEffectiveRate({ ...base, defaults: { companyHourlyRate: "2" } }), "candidate_rate_unavailable");
  throwsResolution(() => resolveEffectiveRate({ ...base, defaults: { candidateHourlyRate: "1" } }), "company_rate_unavailable");
  throwsResolution(() => resolveEffectiveRate({ ...base, entered: { candidateHourlyRate: "2", companyHourlyRate: "1.999" } }), "company_rate_below_candidate");
});

test("SHU182_IBAN_MOD97 IBANs pass only with a valid checksum and length; the bank must be an active catalogue bank", async () => {
  const { references } = rig();
  assert.equal(normalizeIban("kw81 cbku 0000 0000 0000 1234 5601 01"), "KW81CBKU0000000000001234560101");
  assert.equal(normalizeIban("SA03 8000 0000 6080 1016 7519"), "SA0380000000608010167519");
  assert.equal(normalizeIban("GB82WEST12345698765432"), "GB82WEST12345698765432");
  assert.equal(normalizeIban("KW82CBKU0000000000001234560101"), undefined, "one check digit off");
  assert.equal(normalizeIban("KW81CBKU0000000000001234560110"), undefined, "two digits transposed");
  assert.equal(normalizeIban("KW81CBKU000000000000123456010"), undefined, "Kuwaiti IBANs are 30 characters");
  assert.equal(normalizeIban("not an iban"), undefined);
  const details = await validateBankDetails({ bankId: BANK.toUpperCase(), iban: "KW81CBKU0000000000001234560101", beneficiaryName: "  Synthetic   Person " }, references);
  assert.deepEqual(details, { bankId: BANK, iban: "KW81CBKU0000000000001234560101", beneficiaryName: "Synthetic Person" });
  await rejects(validateBankDetails({ bankId: BANK, iban: "KW82CBKU0000000000001234560101", beneficiaryName: "Synthetic Person" }, references), "invalid_iban", 400);
  await rejects(validateBankDetails({ bankId: CLOSED_BANK, iban: "KW81CBKU0000000000001234560101", beneficiaryName: "Synthetic Person" }, references), "invalid_bank", 400);
  await rejects(validateBankDetails({ bankId: BANK, iban: "KW81CBKU0000000000001234560101", beneficiaryName: "Synthetic Person", extra: true }, references), "invalid_bank_details", 400);
  await rejects(validateBankDetails({ bankId: BANK, iban: "KW81CBKU0000000000001234560101", beneficiaryName: "\u0000" }, references), "invalid_beneficiary_name", 400);
});
