import { kuwaitDay } from "./id-cards.js";

/**
 * Staff statistics (contract P-3), slice 3: the firing hit map. Legacy (`common/models/FiringHitmap.php`,
 * staff `FiringHitmapController::actionList`, staff app `firing-hitmap.page.html`): for every top-level
 * company, how many placements ended in each of the last 12 months, newest first. A month is marked
 * "danger" when its count is more than twice the company's 12-month average and "warning" when it is
 * more than the average; the average is the 12-month total divided by 12.
 *
 * Changes from legacy, by the rule that legacy prod is the benchmark and best practice wins:
 * - Legacy stored the counts in `firing_hitmap` from a daily cron and showed the stored rows. Here
 *   they are counted from the placements when the page is asked for, so they always reconcile.
 * - Legacy's columns came from the first company's stored rows, so a company with other months
 *   showed under the wrong heading. Here every company has the same 12 months.
 * - Legacy marked a cell "warning" too when it was "danger" (both classes applied); here a cell
 *   has one level.
 * - Legacy counted every placement whose end date fell in the month, including end dates later
 *   in the current month. Here a placement counts once its end date has come (up to today in Kuwait).
 * - The spike email (`FiringHitmap::firingSpike`) is not in this slice.
 */
export interface FiringCompany { readonly orgId: string; readonly name: string }
/** Placements of one company (sub-companies rolled up) that ended in one month, `YYYY-MM`. */
export interface FiringCount { readonly orgId: string; readonly month: string; readonly total: number }
export interface FiringHitMapStore {
  /** Top-level companies that are not deleted, and the placements ended in `months` (`YYYY-MM`) up to `day`, by company. */
  firings(day: string, months: readonly string[]): Promise<{ readonly companies: readonly FiringCompany[]; readonly counts: readonly FiringCount[] }>;
}
export type FiringLevel = "danger" | "warning" | null;
export interface FiringHitMapRow {
  readonly orgId: string; readonly name: string;
  /** One cell per month of `FiringHitMap.months`, newest first. */
  readonly cells: readonly { readonly month: string; readonly total: number; readonly level: FiringLevel }[];
  readonly total: number;
  /** The 12-month total divided by 12, to two decimal places. */
  readonly average: number;
}
export interface FiringHitMap { readonly day: string; readonly months: readonly string[]; readonly companies: readonly FiringHitMapRow[] }

/** The 12 months up to and including the month of `day` (`YYYY-MM-DD`), newest first. */
export function lastTwelveMonths(day: string): string[] {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const n = y * 12 + (m - 1) - i;
    return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, "0")}`;
  });
}

/** A month's level against the 12-month total, compared in whole numbers (total > 2 × sum / 12). */
export function firingLevel(total: number, sum: number): FiringLevel {
  if (total * 12 > 2 * sum) return "danger";
  return total * 12 > sum ? "warning" : null;
}

export function buildFiringHitMap(day: string, companies: readonly FiringCompany[], counts: readonly FiringCount[]): FiringHitMap {
  const months = lastTwelveMonths(day);
  const by = new Map<string, number>();
  for (const c of counts) {
    if (!Number.isSafeInteger(c.total) || c.total < 0) throw new TypeError("firing count has no value");
    by.set(`${c.orgId}\u0000${c.month}`, (by.get(`${c.orgId}\u0000${c.month}`) ?? 0) + c.total);
  }
  const rows = companies.map(co => {
    const totals = months.map(month => by.get(`${co.orgId}\u0000${month}`) ?? 0);
    const sum = totals.reduce((a, b) => a + b, 0);
    return { orgId: co.orgId, name: co.name, total: sum, average: Math.round(sum * 100 / 12) / 100,
      cells: months.map((month, i) => ({ month, total: totals[i]!, level: firingLevel(totals[i]!, sum) })) };
  });
  // Most placements ended first, then by name, so the companies to look at are on top.
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.orgId.localeCompare(b.orgId));
  return { day, months, companies: rows };
}

export class FiringHitMapService {
  readonly #store: FiringHitMapStore; readonly #authority: { isStaff(principalId: string): Promise<boolean> }; readonly #now: () => Date;
  constructor(store: FiringHitMapStore, authority: { isStaff(principalId: string): Promise<boolean> }, now: () => Date = () => new Date()) {
    this.#store = store; this.#authority = authority; this.#now = now;
  }
  /** The hit map as of today in Kuwait; undefined for anyone who is not StudentHub staff. */
  async page(viewer: string): Promise<FiringHitMap | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const day = kuwaitDay(this.#now());
    const { companies, counts } = await this.#store.firings(day, lastTwelveMonths(day));
    return buildFiringHitMap(day, companies, counts);
  }
}
