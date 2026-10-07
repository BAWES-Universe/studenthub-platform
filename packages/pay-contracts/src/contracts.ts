import { randomUUID } from "node:crypto";
import { canonicalDecimal, compareDecimal, isPositiveDecimal } from "./decimal.js";
import {
  PAY_MODELS,
  type ContractTerms, type FinanceReferenceResolver, type IsoDate, type PayContract, type PayContractStore, type PayModel,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const FIELDS = ["candidateId", "companyId", "storeId", "startDate", "endDate", "currencyId", "transferCost", "autoGenerate", "status", "terms"] as const;
const UPDATABLE = FIELDS.filter((f) => f !== "candidateId" && f !== "companyId" && f !== "storeId");

export class PayContractError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 409 | 503) {
    super(code);
  }
}

function invalid(code = "invalid_contract"): never {
  throw new PayContractError(code, 400);
}

function closedObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalid();
  return raw;
}

function partyId(value: unknown, code: string): string {
  if (typeof value !== "string" || !PARTY_ID.test(value)) invalid(code);
  return value;
}

function date(value: unknown, code: string): IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(code);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(code);
  return value;
}

function money(value: unknown, code: string, { positive }: { positive: boolean }): string {
  const canonical = canonicalDecimal(value);
  if (canonical === undefined || (positive && !isPositiveDecimal(canonical))) invalid(code);
  return canonical;
}

function wholeNumber(value: unknown, min: number, max: number, code: string): number {
  const parsed = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < min || parsed > max) invalid(code);
  return parsed;
}

/** The company side must cover the candidate side, as legacy's manual-pay guard requires (`:1166`). */
function companyCovers(company: string, candidate: string): void {
  if (compareDecimal(company, candidate) < 0) invalid("company_amount_below_candidate");
}

export function normalizeTerms(value: unknown): ContractTerms {
  const kind = (value as { payModel?: unknown } | null)?.payModel;
  if (typeof kind !== "string" || !(PAY_MODELS as readonly string[]).includes(kind)) invalid("invalid_pay_model");
  if (kind === "hourly") {
    const raw = closedObject(value, ["payModel", "candidateHourlyRate", "companyHourlyRate"]);
    const candidateHourlyRate = money(raw.candidateHourlyRate, "invalid_candidate_rate", { positive: true });
    const companyHourlyRate = money(raw.companyHourlyRate, "invalid_company_rate", { positive: true });
    companyCovers(companyHourlyRate, candidateHourlyRate);
    return Object.freeze({ payModel: "hourly", candidateHourlyRate, companyHourlyRate });
  }
  if (kind === "fixed_price") {
    const raw = closedObject(value, ["payModel", "candidateTotal", "companyTotal", "completionPercentage"]);
    const candidateTotal = money(raw.candidateTotal, "invalid_candidate_total", { positive: true });
    const companyTotal = money(raw.companyTotal, "invalid_company_total", { positive: true });
    companyCovers(companyTotal, candidateTotal);
    const completionPercentage = wholeNumber(raw.completionPercentage ?? 0, 0, 100, "invalid_completion_percentage");
    return Object.freeze({ payModel: "fixed_price", candidateTotal, companyTotal, completionPercentage });
  }
  const raw = closedObject(value, ["payModel", "candidateTotal", "companyTotal", "salaryDay"]);
  const candidateTotal = money(raw.candidateTotal, "invalid_candidate_total", { positive: true });
  const companyTotal = money(raw.companyTotal, "invalid_company_total", { positive: true });
  companyCovers(companyTotal, candidateTotal);
  const salaryDay = wholeNumber(raw.salaryDay, 1, 31, "invalid_salary_day");
  return Object.freeze({ payModel: "monthly_salary", candidateTotal, companyTotal, salaryDay });
}

interface EditableFields {
  readonly startDate: IsoDate;
  readonly endDate?: IsoDate;
  readonly currencyId: string;
  readonly transferCost: string;
  readonly autoGenerate: boolean;
  readonly status: "active" | "inactive";
  readonly terms: ContractTerms;
}

function normalizeEditable(raw: Record<string, unknown>): EditableFields {
  const startDate = date(raw.startDate, "invalid_start_date");
  const endDate = raw.endDate === undefined || raw.endDate === null || raw.endDate === "" ? undefined : date(raw.endDate, "invalid_end_date");
  if (endDate !== undefined && endDate < startDate) invalid("invalid_end_date");
  if (typeof raw.currencyId !== "string" || !UUID.test(raw.currencyId)) invalid("invalid_currency");
  const transferCost = money(raw.transferCost ?? "0", "invalid_transfer_cost", { positive: false });
  const terms = normalizeTerms(raw.terms);
  const autoGenerate = raw.autoGenerate === undefined ? false : raw.autoGenerate;
  if (typeof autoGenerate !== "boolean") invalid("invalid_auto_generate");
  // Only a monthly salary has a payout the weekly job can generate (FI-04).
  if (autoGenerate && terms.payModel !== "monthly_salary") invalid("invalid_auto_generate");
  const status = raw.status ?? "active";
  if (status !== "active" && status !== "inactive") invalid("invalid_status");
  return { startDate, endDate, currencyId: raw.currencyId.toLowerCase(), transferCost, autoGenerate, status, terms };
}

function overlaps(a: { startDate: IsoDate; endDate?: IsoDate }, b: { startDate: IsoDate; endDate?: IsoDate }): boolean {
  return (a.endDate === undefined || a.endDate >= b.startDate) && (b.endDate === undefined || b.endDate >= a.startDate);
}

/**
 * Two non-deleted contracts for one candidate at one store may not overlap,
 * whatever their pay models: legacy only discovered the clash when a transfer
 * was generated and then refused it (`:1037-1059`).
 */
function assertNoOverlap(existing: readonly PayContract[], candidate: { id: string; startDate: IsoDate; endDate?: IsoDate }): void {
  if (existing.some((c) => c.status !== "deleted" && c.id !== candidate.id && overlaps(c, candidate))) {
    throw new PayContractError("overlapping_contract", 409);
  }
}

function strip<T extends object>(value: T): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))) as T;
}

function requireActor(actorId: string): void {
  if (typeof actorId !== "string" || actorId.length === 0) throw new PayContractError("unauthorized", 401);
}

function requireId(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new PayContractError("not_found", 404);
  return id.toLowerCase();
}

function liveCount(contracts: readonly PayContract[]): number {
  return contracts.filter((c) => c.status !== "deleted").length;
}

/**
 * F1 (SHU-182): one contract aggregate with three pay models.
 * The actor is authorized by the caller (staff grant); this service owns the
 * contract rules, the overlap invariant and the audit row.
 */
export class PayContracts {
  constructor(
    private readonly store: PayContractStore,
    private readonly references: FinanceReferenceResolver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(idInput: unknown): Promise<PayContract> {
    const contract = await this.store.get(requireId(idInput));
    if (!contract || contract.status === "deleted") throw new PayContractError("not_found", 404);
    return contract;
  }

  async listForCandidate(candidateId: unknown): Promise<readonly PayContract[]> {
    const id = partyId(candidateId, "invalid_candidate");
    return (await this.store.listForCandidate(id))
      .filter((c) => c.candidateId === id && c.status !== "deleted")
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id));
  }

  async create(actorId: string, input: unknown): Promise<PayContract> {
    requireActor(actorId);
    const raw = closedObject(input, FIELDS);
    const candidateId = partyId(raw.candidateId, "invalid_candidate");
    const companyId = partyId(raw.companyId, "invalid_company");
    const storeId = partyId(raw.storeId, "invalid_store");
    const fields = normalizeEditable(raw);
    await this.assertCurrency(fields.currencyId, undefined);
    const now = this.now().toISOString();
    return this.store.transaction(async (tx) => {
      const existing = await tx.lockPair(candidateId, storeId);
      const id = randomUUID();
      assertNoOverlap(existing, { id, ...fields });
      const contract: PayContract = strip({ id, candidateId, companyId, storeId, ...fields, createdAt: now, updatedAt: now });
      await tx.insert(contract);
      const before = liveCount(existing);
      await tx.audit({ operation: "pay_contract.create", actorId, candidateId, companyId, payModel: fields.terms.payModel, countBefore: before, countAfter: before + 1 });
      return contract;
    });
  }

  /** Replaces the editable fields; candidate, company and store stay as created. */
  async update(actorId: string, idInput: unknown, input: unknown): Promise<PayContract> {
    requireActor(actorId);
    const id = requireId(idInput);
    const fields = normalizeEditable(closedObject(input, UPDATABLE));
    const previous = await this.store.get(id);
    await this.assertCurrency(fields.currencyId, previous?.currencyId);
    return this.store.transaction(async (tx) => {
      const current = await tx.find(id);
      if (!current || current.status === "deleted") throw new PayContractError("not_found", 404);
      if (current.currencyId !== previous?.currencyId && fields.currencyId !== current.currencyId) {
        // The row moved under us between the catalogue check and the lock; make the caller retry.
        throw new PayContractError("contract_changed", 409);
      }
      const existing = await tx.lockPair(current.candidateId, current.storeId);
      assertNoOverlap(existing, { id, ...fields });
      const { endDate: _end, ...kept } = current;
      const next: PayContract = strip({ ...kept, ...fields, updatedAt: this.now().toISOString() });
      await tx.replace(next);
      const count = liveCount(existing);
      await tx.audit({
        operation: "pay_contract.update", actorId, candidateId: current.candidateId, companyId: current.companyId,
        payModel: fields.terms.payModel, countBefore: count, countAfter: count,
      });
      return next;
    });
  }

  /** Soft delete, as legacy `deleted = 1`: the row stays for history and import reconciliation. */
  async remove(actorId: string, idInput: unknown): Promise<PayContract> {
    requireActor(actorId);
    const id = requireId(idInput);
    return this.store.transaction(async (tx) => {
      const current = await tx.find(id);
      if (!current || current.status === "deleted") throw new PayContractError("not_found", 404);
      const existing = await tx.lockPair(current.candidateId, current.storeId);
      const now = this.now().toISOString();
      const next: PayContract = Object.freeze({ ...current, status: "deleted", deletedAt: now, updatedAt: now });
      await tx.replace(next);
      const before = liveCount(existing);
      await tx.audit({
        operation: "pay_contract.remove", actorId, candidateId: current.candidateId, companyId: current.companyId,
        payModel: current.terms.payModel, countBefore: before, countAfter: before - 1,
      });
      return next;
    });
  }

  /** A new or changed currency must be an active catalogue currency; an unchanged historical one may stay. */
  private async assertCurrency(currencyId: string, previous: string | undefined): Promise<void> {
    if (currencyId === previous) return;
    let resolved: { readonly status: "active" | "deleted" } | undefined;
    try { resolved = await this.references.resolve("currency", currencyId); } catch { throw new PayContractError("reference_unavailable", 503); }
    if (resolved?.status !== "active") invalid("invalid_currency");
  }
}

export function isPayModel(value: unknown): value is PayModel {
  return typeof value === "string" && (PAY_MODELS as readonly string[]).includes(value);
}
