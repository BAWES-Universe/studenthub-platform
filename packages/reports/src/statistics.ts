import { kuwaitDay } from "./id-cards.js";

/**
 * Staff statistics (contract P-3), slice 1: what legacy's staff dashboard counts
 * (`staff StatisticController::actionList`) and the hiring figures from legacy admin's
 * (`admin StatisticController::actionList`: hired, retained after a year, retention ratio,
 * invitations, recruitment yield), from recruit and work data.
 *
 * Each counter says where its number comes from, like the morning summary's. A counter whose
 * source has not landed is `missing`: the page shows "not available" for it, never 0. Counters
 * the morning summary also has use the same query, so the two pages never disagree.
 *
 * Changes from legacy, by the rule that legacy prod is the benchmark and best practice wins:
 * - Legacy's `totalRequests` and `activeRequests` are the same query (`Request::activeRequest`);
 *   here they are one counter.
 * - Support tickets were dropped (contract C-5), so the two ticket counters are not here.
 * - Legacy counted an assignment as retained only once it had an end date more than 365 days
 *   after its start; an assignment still running after 365 days counts here too, so the
 *   people who stayed longest are not left out.
 * - Legacy's "interview requests" are interviews a company asked for that staff had not yet
 *   scheduled. Here that is a recruit card in the interviewing stage with no scheduled
 *   interview, on a request that is still open.
 * - Legacy's "invited" tile counted invitations from KWD companies only, while its recruitment
 *   yield divided by every invitation. Here both use every invitation, as hired and retained do.
 */
export type StatisticSource = { readonly kind: "available" } | { readonly kind: "missing"; readonly waitsOn: string };
export interface StatisticCounter { readonly key: string; readonly label: string; readonly source: StatisticSource }

const available: StatisticSource = { kind: "available" };
const missing = (waitsOn: string): StatisticSource => ({ kind: "missing", waitsOn });

/** The staff dashboard's counters, in legacy's order. */
export const STAFF_STATISTICS_COUNTERS = [
  { key: "workLogAppeals", label: "Work log appeals submitted and not yet picked up", source: available },
  { key: "totalUnverifiedEmails", label: "Company contacts with an unverified email", source: missing("company contact email verification, which no lane holds yet") },
  { key: "totalExpiredCards", label: "Candidates with expired ID cards", source: available },
  { key: "assignedExpiredCivilID", label: "Assigned candidates with an expired civil ID", source: available },
  { key: "id_need_generated", label: "Candidates assigned to work without ID cards", source: available },
  { key: "profileApprovalRequire", label: "Profiles to be reviewed and approved", source: missing("profile approval, which no lane holds yet") },
  { key: "incompleteAssignedToWork", label: "Assigned candidates with incomplete profiles", source: missing("profile completeness, which no lane holds yet") },
  { key: "missingBankInfo", label: "Candidates missing bank info", source: missing("unpaid transfers from the pay lane (a count without them would be too low)") },
  { key: "requireFollowup", label: "Clients requiring follow-up", source: missing("company follow-up dates, which no lane holds yet") },
  { key: "activeRequests", label: "Active requests", source: available },
  { key: "totalMinor", label: "Candidates under 16", source: available },
  { key: "assignedIdleCandidates", label: "Assigned candidates who have not received any payment in the past two months", source: missing("transfers from the pay lane") },
  { key: "companyMoreThen40DaysWithoutPayment", label: "Companies with assigned staff that have not made a payment in 40 days", source: missing("transfers from the pay lane") },
  { key: "last40daysNoRequest", label: "Active clients who have not made a request in over 40 days", source: missing("company start dates and active flags from the importer") },
  { key: "companyUnderReview", label: "Company registrations waiting for review", source: available },
  { key: "transfersWithNoProfitInProgress", label: "Unpaid transfers with no profit", source: missing("transfers from the pay lane") },
  { key: "transfersWithSameRateInProgress", label: "Unpaid transfers where the company and candidate rates are the same", source: missing("transfers from the pay lane") },
  { key: "totalStoreAssignmentRequests", label: "Store assignment requests waiting for an answer", source: available },
  { key: "totalInterviewRequests", label: "Interviews to schedule", source: available },
  { key: "totalInterviewScheduled", label: "Upcoming scheduled interviews", source: available },
] as const satisfies readonly StatisticCounter[];

export type StaffStatisticKey = typeof STAFF_STATISTICS_COUNTERS[number]["key"];

/** The raw hiring numbers the store reads; the ratios are worked out here. */
export interface HiringCounts { readonly hired: number; readonly retained: number; readonly invitations: number }
export interface HiringFigures extends HiringCounts {
  /** Percent of assignments that lasted (or have lasted so far) more than 365 days; null with no assignments. */
  readonly retentionRatio: number | null;
  /** Assignments per 100 invitations sent; null with no invitations. */
  readonly recruitmentYield: number | null;
}

export interface StatisticsStore {
  /** The available counters for one Asia/Kuwait day, by key. */
  staffCounts(day: string, now: Date): Promise<Readonly<Record<string, number>>>;
  hiring(day: string): Promise<HiringCounts>;
}
export interface StatisticRow { readonly key: string; readonly label: string; readonly value: number | null; readonly waitsOn: string | null }
export interface StatisticsPage { readonly day: string; readonly counters: readonly StatisticRow[]; readonly hiring: HiringFigures }

const count = (n: unknown, key: string): number => {
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new TypeError(`statistic ${key} has no value`);
  return n as number;
};
/** A percentage to one decimal place, or null when there is nothing to divide by. */
export const percent = (part: number, whole: number): number | null => whole > 0 ? Math.round(part * 1000 / whole) / 10 : null;

export class StatisticsService {
  readonly #store: StatisticsStore; readonly #authority: { isStaff(principalId: string): Promise<boolean> }; readonly #now: () => Date;
  constructor(store: StatisticsStore, authority: { isStaff(principalId: string): Promise<boolean> }, now: () => Date = () => new Date()) {
    this.#store = store; this.#authority = authority; this.#now = now;
  }

  /** Every counter in registry order, and the hiring figures; undefined for anyone who is not StudentHub staff. */
  async page(viewer: string): Promise<StatisticsPage | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const now = this.#now(), day = kuwaitDay(now);
    const [raw, hiring] = await Promise.all([this.#store.staffCounts(day, now), this.#store.hiring(day)]);
    const counters = STAFF_STATISTICS_COUNTERS.map(c => c.source.kind === "missing"
      ? { key: c.key, label: c.label, value: null, waitsOn: c.source.waitsOn }
      : { key: c.key, label: c.label, value: count(raw[c.key], c.key), waitsOn: null });
    const h = { hired: count(hiring.hired, "hired"), retained: count(hiring.retained, "retained"), invitations: count(hiring.invitations, "invitations") };
    return { day, counters, hiring: { ...h, retentionRatio: percent(h.retained, h.hired), recruitmentYield: percent(h.hired, h.invitations) } };
  }
}
