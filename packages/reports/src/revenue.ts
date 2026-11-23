import { kuwaitDay } from "./id-cards.js";
import { invitationMonths } from "./statistics.js";

/**
 * Revenue (contract P-4, screen A-31 `/reports/revenue`): what companies paid and what belonged
 * to candidates, read live from the pay lane's transfer lines, per currency. Legacy evidence
 * (`BAWES-Universe/studenthub` @ 55119d3): `status/modules/v1/controllers/StatisticController.php`
 * (`actionList`, `actionTransfer`, `actionGraph`) and `Transfer::getTotalsByMonths`.
 *
 * Changes from legacy, by the rule that legacy prod is the benchmark and best practice wins:
 * - Legacy served these figures from the "status" app with no sign-in. Here only operator admins
 *   see them (the same check as staff time and standup); everyone else gets not found.
 * - Legacy added amounts across currencies. Every figure here is per currency, never summed across.
 * - Legacy's graph grouped transfers by the month they were created and counted drafts. Here a month
 *   is the transfer's pay period (the month `period_end` falls in, which is when the work was done),
 *   and drafts and cancelled transfers are left out. A deleted transfer is never counted.
 * - Legacy's "revenue" columns (`company_stats`, `candidate_stats`) were incremented by a job and
 *   drifted (RP-F2, the `update-company-stats` double count). Nothing is stored here: each figure is
 *   one live query over the lines, and the reconciliation shows the same lines by transfer status.
 * - Staff salaries and expenses have no source on the platform yet, so they and net profit show as
 *   not available, never 0.
 */
export const REVENUE_RECEIVED = ["payment_sent", "distributing", "complete"] as const;
/** Every transfer status, in lifecycle order, for the reconciliation. */
export const REVENUE_STATUSES = ["draft", "locked", "payment_sent", "distributing", "complete", "cancelled"] as const;
export type RevenueStatus = typeof REVENUE_STATUSES[number];

/** Amounts are numeric strings with three decimals (fils), as stored; never floats. */
export interface RevenueAmounts { readonly companyTotal: string; readonly candidateTotal: string; readonly grossProfit: string }
export interface RevenueStatusRow extends RevenueAmounts { readonly currency: string; readonly status: RevenueStatus; readonly transfers: number; readonly lines: number }
export interface RevenueMonthRow extends RevenueAmounts { readonly currency: string; readonly month: string; readonly transfers: number; readonly received: string }

export interface RevenueStore {
  /** All-time totals per currency and status, deleted transfers left out. */
  byStatus(): Promise<readonly RevenueStatusRow[]>;
  /** Per currency and pay-period month in [first, last] (`YYYY-MM`), drafts, cancelled and deleted transfers left out. */
  byMonth(first: string, last: string): Promise<readonly RevenueMonthRow[]>;
}

export interface RevenueCurrency extends RevenueAmounts { readonly currency: string; readonly transfers: number; readonly lines: number }
export interface RevenuePage {
  readonly day: string; readonly months: readonly string[];
  /** Payment received (payment sent, distributing or complete), per currency: legacy's totals. */
  readonly received: readonly RevenueCurrency[];
  /** One row per currency and month of `months`, oldest first; a month with no transfers is zeros. */
  readonly monthly: readonly RevenueMonthRow[];
  readonly reconciliation: readonly RevenueStatusRow[];
  readonly missing: readonly { readonly label: string; readonly waitsOn: string }[];
}
export const REVENUE_MISSING = [
  { label: "Staff salaries", waitsOn: "staff salary records, which no lane holds yet" },
  { label: "Expenses", waitsOn: "expense records, which no lane holds yet" },
  { label: "Net profit", waitsOn: "staff salaries and expenses" },
] as const;

const MONEY = /^-?\d+\.\d{3}$/;
const FILS = (v: string) => { if (!MONEY.test(v)) throw new RangeError("invalid amount"); return BigInt(v.replace(".", "")); };
const fmt = (fils: bigint) => { const neg = fils < 0n, a = neg ? -fils : fils, s = a.toString().padStart(4, "0"); return `${neg ? "-" : ""}${s.slice(0, -3)}.${s.slice(-3)}`; };
const ZERO = "0.000";

/** The received totals per currency, summed exactly in fils from the reconciliation rows. */
export function receivedTotals(rows: readonly RevenueStatusRow[]): RevenueCurrency[] {
  const by = new Map<string, { company: bigint; candidate: bigint; transfers: number; lines: number }>();
  for (const r of rows) {
    if (!(REVENUE_RECEIVED as readonly string[]).includes(r.status)) continue;
    const t = by.get(r.currency) ?? { company: 0n, candidate: 0n, transfers: 0, lines: 0 };
    t.company += FILS(r.companyTotal); t.candidate += FILS(r.candidateTotal); t.transfers += r.transfers; t.lines += r.lines;
    by.set(r.currency, t);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => ({ currency, transfers: t.transfers, lines: t.lines,
    companyTotal: fmt(t.company), candidateTotal: fmt(t.candidate), grossProfit: fmt(t.company - t.candidate) }));
}

/** Every currency seen anywhere gets a row for every month, oldest first; a month outside `months` is an error. */
export function monthlyRows(months: readonly string[], currencies: readonly string[], rows: readonly RevenueMonthRow[]): RevenueMonthRow[] {
  const key = (c: string, m: string) => `${c} ${m}`, by = new Map<string, RevenueMonthRow>();
  for (const r of rows) { if (!months.includes(r.month)) throw new RangeError("month outside the range"); by.set(key(r.currency, r.month), r); }
  return [...currencies].sort().flatMap(currency => months.map(month => by.get(key(currency, month))
    ?? { currency, month, transfers: 0, companyTotal: ZERO, candidateTotal: ZERO, grossProfit: ZERO, received: ZERO }));
}

export class RevenueService {
  readonly #store: RevenueStore; readonly #authority: { isOperatorAdmin(principalId: string): Promise<boolean> }; readonly #now: () => Date;
  constructor(store: RevenueStore, authority: { isOperatorAdmin(principalId: string): Promise<boolean> }, now: () => Date = () => new Date()) {
    this.#store = store; this.#authority = authority; this.#now = now;
  }
  /** The page for an operator admin; undefined for anyone else, before anything is read. */
  async page(viewer: string): Promise<RevenuePage | undefined> {
    if (!(await this.#authority.isOperatorAdmin(viewer))) return undefined;
    const day = kuwaitDay(this.#now()), months = invitationMonths(day);
    const [reconciliation, raw] = await Promise.all([this.#store.byStatus(), this.#store.byMonth(months[0]!, months[months.length - 1]!)]);
    const currencies = [...new Set([...reconciliation.map(r => r.currency), ...raw.map(r => r.currency)])];
    return { day, months, received: receivedTotals(reconciliation), monthly: monthlyRows(months, currencies, raw), reconciliation, missing: REVENUE_MISSING };
  }
}
