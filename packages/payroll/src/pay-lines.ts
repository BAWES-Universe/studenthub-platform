import { canonicalDecimal, thousandths } from "../../pay-contracts/src/decimal.js";
import type { RateResolution } from "../../pay-contracts/src/resolution.js";

export interface PayLineDraft {
  readonly id: string;
  readonly personId: string;
  readonly storeId: string;
  readonly currencyCode: string;
  readonly candidateTotal: string;
  readonly companyTotal: string;
  readonly note: string;
  readonly calculation: Readonly<Record<string, unknown>>;
}
export interface PayLineCalculationInput {
  readonly rate: RateResolution;
  /** Exact hours text; integer minutes and seconds remain separate to preserve the legacy hourly gate. */
  readonly hours: string;
  readonly minutes: number;
  readonly seconds: number;
  readonly bonus: string;
  readonly bonusCommissionPercent: string;
  readonly transferCost: string;
  readonly payouts: number;
  readonly companyOverride?: string;
}
export type PayLineCalculation = { readonly kind: "calculated"; readonly candidateTotal: string; readonly companyTotal: string; readonly bonusCommission: string }
  | { readonly kind: "empty"; readonly candidateTotal: "0.000"; readonly companyTotal: "0.000" };
const money = (x: string): bigint => {
  if (typeof x !== "string" || canonicalDecimal(x) === undefined) throw new RangeError("invalid_decimal");
  return thousandths(x);
};
/** Nonnegative rational rounding to fils. Replay, not these synthetic tests, establishes full legacy equivalence. */
function rounded(n: bigint, d = 1n): bigint { if (n < 0n || d <= 0n) throw new RangeError("invalid_amount"); return (2n * n + d) / (2n * d); }
function format(n: bigint): string { if (n > 999999999999n) throw new RangeError("amount_overflow"); return `${n / 1000n}.${String(n % 1000n).padStart(3, "0")}`; }
export function calculatePayLine(input: PayLineCalculationInput): PayLineCalculation {
  const h = money(input.hours), bonus = money(input.bonus), commission = money(input.bonusCommissionPercent), cost = money(input.transferCost);
  if (![input.minutes, input.seconds].every(x => Number.isSafeInteger(x) && x >= 0) || !Number.isSafeInteger(input.payouts) || input.payouts < 1 || commission > 100000n) throw new RangeError("invalid_quantity");
  const r = input.rate;
  // Pinned legacy c2ce255:1243-1252 ignores minute/second-only work for an hourly contract.
  if (r.payModel === "hourly" && ((r.source === "contract" && h === 0n && bonus === 0n) || (h === 0n && input.minutes === 0 && input.seconds === 0 && bonus === 0n))) return { kind: "empty", candidateTotal: "0.000", companyTotal: "0.000" };
  let candidate: bigint, company: bigint;
  const appliedCommission = r.source === "manual" ? 0n : commission;
  const appliedCost = r.source === "manual" ? 0n : cost;
  const bonusCommission = rounded(bonus * appliedCommission, 100000n);
  if (r.payModel === "hourly") {
    const secondsThousandths = h * 3600n + BigInt(input.minutes) * 60000n + BigInt(input.seconds) * 1000n;
    // Do not round commission or per-minute rates before the final total.
    candidate = rounded((bonus * 100000n - bonus * appliedCommission) * 3600000n + secondsThousandths * money(r.candidateHourlyRate) * 100000n, 3600000n * 100000n);
    company = rounded((bonus + appliedCost) * 3600000n + secondsThousandths * money(r.companyHourlyRate), 3600000n);
  } else if (r.payModel === "monthly_salary") {
    const override = input.companyOverride === undefined ? 0n : money(input.companyOverride);
    const c = money(r.candidateTotal), co = money(r.companyTotal);
    if (override > 0n) { if (co === 0n) throw new RangeError("zero_company_total"); candidate = rounded(c * override, co); company = override; }
    else { candidate = rounded(c, BigInt(input.payouts)); company = rounded(co, BigInt(input.payouts)); }
  } else { candidate = money(r.candidateTotal); company = money(r.companyTotal); }
  if (company === 0n) throw new RangeError("zero_company_total");
  return { kind: "calculated", candidateTotal: format(candidate), companyTotal: format(company), bonusCommission: format(r.payModel === "hourly" ? bonusCommission : 0n) };
}
export function validatePayLine(line: PayLineDraft): void {
  if (![line.id, line.personId, line.storeId].every(x => typeof x === "string" && x.length > 0 && x.length <= 200)
    || !/^[A-Z]{3}$/.test(line.currencyCode) || typeof line.note !== "string" || line.note.length > 2000
    || line.calculation === null || Array.isArray(line.calculation) || typeof line.calculation !== "object") throw new RangeError("invalid_line");
  money(line.candidateTotal); if (money(line.companyTotal) === 0n) throw new RangeError("zero_company_total");
}
export function payLineTotals(lines: readonly PayLineDraft[]): Readonly<Record<string, { candidateTotal: string; companyTotal: string }>> {
  const totals = new Map<string, { candidate: bigint; company: bigint }>();
  for (const line of lines) { validatePayLine(line); const t = totals.get(line.currencyCode) ?? { candidate: 0n, company: 0n }; t.candidate += money(line.candidateTotal); t.company += money(line.companyTotal); totals.set(line.currencyCode, t); }
  return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => [currency, { candidateTotal: format(t.candidate), companyTotal: format(t.company) }]));
}
