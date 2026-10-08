import { canonicalDecimal, compareDecimal, isPositiveDecimal } from "./decimal.js";
import type { IsoDate, PayContract, PayModel } from "./types.js";

export const RATE_RESOLUTION_VERSION = "studenthub.pay-rate-resolution.v1" as const;

/** Every rule the resolver can apply; the record lists the ones it did, in order. */
export type ResolutionStep =
  | "contracts_matched_by_period"
  | "contracts_matched_active_today"
  | "explicit_contract_filter"
  | "pay_model_filter"
  | "single_contract_selected"
  | "no_matching_contract"
  | "candidate_rate_from_input"
  | "candidate_rate_from_candidate"
  | "company_rate_from_input"
  | "company_rate_from_company"
  | "company_rate_from_parent";

export interface RateResolutionInput {
  readonly candidateId: string;
  readonly storeId: string;
  /** Every contract the candidate holds; the resolver filters to the store itself. */
  readonly contracts: readonly PayContract[];
  /** The transfer's period. Without one, legacy falls back to "not ended before today". */
  readonly period?: { readonly start: IsoDate; readonly end: IsoDate };
  readonly today: IsoDate;
  readonly contractId?: string;
  readonly payModel?: PayModel;
  /** Rates typed on the transfer line; used only when no contract matches. */
  readonly entered?: { readonly candidateHourlyRate?: string; readonly companyHourlyRate?: string };
  /** Server-side defaults for the contract-less path. */
  readonly defaults?: {
    readonly candidateHourlyRate?: string;
    readonly companyHourlyRate?: string;
    readonly parentCompanyHourlyRate?: string;
  };
}

interface ResolutionBase {
  readonly version: typeof RATE_RESOLUTION_VERSION;
  readonly steps: readonly ResolutionStep[];
  readonly matchedContractIds: readonly string[];
}

export type RateResolution =
  | (ResolutionBase & {
      readonly source: "contract";
      readonly contractId: string;
      readonly payModel: "hourly";
      readonly candidateHourlyRate: string;
      readonly companyHourlyRate: string;
    })
  | (ResolutionBase & {
      readonly source: "contract";
      readonly contractId: string;
      readonly payModel: "fixed_price" | "monthly_salary";
      readonly candidateTotal: string;
      readonly companyTotal: string;
      readonly transferCost: string;
    })
  | (ResolutionBase & {
      readonly source: "manual";
      readonly contractId: null;
      readonly payModel: "hourly";
      readonly candidateHourlyRate: string;
      readonly companyHourlyRate: string;
    });

export class RateResolutionError extends Error {
  constructor(
    readonly code: "ambiguous_contract" | "contract_not_applicable" | "candidate_rate_unavailable" | "company_rate_unavailable" | "company_rate_below_candidate" | "invalid_period",
    readonly status: 400 | 409,
    readonly matchedContractIds: readonly string[] = [],
  ) {
    super(code);
  }
}

/** A real `YYYY-MM-DD` calendar date: `2026-13-01` or `2026-02-30` would compare lexically and skew selection. */
export function isCalendarDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && !value.startsWith("0000");
}

/**
 * Legacy contract selection (`TransferCandidate.php:1006-1059`), made explicit:
 * non-deleted contracts for the candidate and store that overlap the period
 * (`start <= period.end AND (end IS NULL OR end >= period.start)`), or, with no
 * period, that have not ended before today. Status is not consulted, as in
 * legacy. More than one match is refused rather than guessed. An explicit
 * contract id or pay model that leaves nothing is refused too, so a filter can
 * never step around a contract in force into manual pay.
 */
export function matchContracts(input: RateResolutionInput): { readonly contracts: readonly PayContract[]; readonly steps: readonly ResolutionStep[] } {
  const steps: ResolutionStep[] = [];
  const { period } = input;
  if (!isCalendarDate(input.today) || (period !== undefined && (!isCalendarDate(period.start) || !isCalendarDate(period.end) || period.end < period.start))) {
    throw new RateResolutionError("invalid_period", 400);
  }
  let matches = input.contracts.filter((c) => c.candidateId === input.candidateId && c.storeId === input.storeId && c.status !== "deleted");
  if (period !== undefined) {
    matches = matches.filter((c) => c.startDate <= period.end && (c.endDate == null || c.endDate >= period.start));
    steps.push("contracts_matched_by_period");
  } else {
    // Legacy's fallback checks only the end date, so a contract that starts later still matches.
    matches = matches.filter((c) => c.endDate == null || c.endDate >= input.today);
    steps.push("contracts_matched_active_today");
  }
  const applicableIds = matches.map((c) => c.id);
  if (input.contractId !== undefined) {
    matches = matches.filter((c) => c.id === input.contractId);
    steps.push("explicit_contract_filter");
  }
  if (input.payModel !== undefined) {
    matches = matches.filter((c) => c.terms.payModel === input.payModel);
    steps.push("pay_model_filter");
  }
  // Manual pay is hourly and only for a period no contract covers.
  if (matches.length === 0 && (input.contractId !== undefined || applicableIds.length > 0 || (input.payModel ?? "hourly") !== "hourly")) {
    throw new RateResolutionError("contract_not_applicable", 409, Object.freeze(applicableIds.sort()));
  }
  // Newest start first, as legacy orders before taking one.
  matches.sort((a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id));
  return { contracts: matches, steps };
}

/**
 * F1 effective-rate resolution. Pure: the result and the reasoning behind it
 * are returned together so W1 and F2 can record exactly why a rate applied.
 * It produces rates and contract totals, never a payable amount (SHU-208).
 */
export function resolveEffectiveRate(input: RateResolutionInput): RateResolution {
  const { contracts: matches, steps: matchSteps } = matchContracts(input);
  const steps = [...matchSteps];
  const matchedContractIds = Object.freeze(matches.map((c) => c.id));
  if (matches.length > 1) throw new RateResolutionError("ambiguous_contract", 409, matchedContractIds);

  const contract = matches[0];
  if (contract !== undefined) {
    steps.push("single_contract_selected");
    const base = { version: RATE_RESOLUTION_VERSION, steps: Object.freeze(steps), matchedContractIds, source: "contract" as const, contractId: contract.id };
    const terms = contract.terms;
    if (terms.payModel === "hourly") {
      return Object.freeze({ ...base, payModel: "hourly", candidateHourlyRate: terms.candidateHourlyRate, companyHourlyRate: terms.companyHourlyRate });
    }
    return Object.freeze({
      ...base, payModel: terms.payModel, candidateTotal: terms.candidateTotal, companyTotal: terms.companyTotal, transferCost: contract.transferCost,
    });
  }

  // Manual pay with no contract (`TransferCandidate.php:1062-1208`): still payable, with guarded fallbacks.
  steps.push("no_matching_contract");
  let candidateRate: string | undefined;
  if (present(input.entered?.candidateHourlyRate)) {
    candidateRate = canonicalDecimal(input.entered?.candidateHourlyRate);
    steps.push("candidate_rate_from_input");
  } else if (positive(input.defaults?.candidateHourlyRate)) {
    candidateRate = canonicalDecimal(input.defaults?.candidateHourlyRate);
    steps.push("candidate_rate_from_candidate");
  }
  let companyRate: string | undefined;
  if (present(input.entered?.companyHourlyRate)) {
    companyRate = canonicalDecimal(input.entered?.companyHourlyRate);
    steps.push("company_rate_from_input");
  } else if (positive(input.defaults?.companyHourlyRate)) {
    companyRate = canonicalDecimal(input.defaults?.companyHourlyRate);
    steps.push("company_rate_from_company");
  } else if (positive(input.defaults?.parentCompanyHourlyRate)) {
    companyRate = canonicalDecimal(input.defaults?.parentCompanyHourlyRate);
    steps.push("company_rate_from_parent");
  }
  if (candidateRate === undefined || !isPositiveDecimal(candidateRate)) throw new RateResolutionError("candidate_rate_unavailable", 400);
  if (companyRate === undefined || !isPositiveDecimal(companyRate)) throw new RateResolutionError("company_rate_unavailable", 400);
  if (compareDecimal(companyRate, candidateRate) < 0) throw new RateResolutionError("company_rate_below_candidate", 400);
  return Object.freeze({
    version: RATE_RESOLUTION_VERSION, steps: Object.freeze(steps), matchedContractIds,
    source: "manual", contractId: null, payModel: "hourly", candidateHourlyRate: candidateRate, companyHourlyRate: companyRate,
  });
}

function present(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function positive(value: string | undefined): boolean {
  const canonical = canonicalDecimal(value);
  return canonical !== undefined && isPositiveDecimal(canonical);
}
