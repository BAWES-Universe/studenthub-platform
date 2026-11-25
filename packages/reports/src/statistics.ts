import { EMAIL_VOLUME_THRESHOLD } from "../../notifications/src/email-volume.js";
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
 * - "Unpaid transfers with no profit" (slice 8) counts KWD transfers with an unpaid line whose
 *   company total equals the candidate total, from the pay lane's lines. Legacy also counted
 *   cancelled and deleted transfers, whose lines are never paid; here they are left out.
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
  { key: "assignedIdleCandidates", label: "Assigned candidates not paid for any pay period that ended in the past two months", source: available },
  { key: "companyMoreThen40DaysWithoutPayment", label: "Companies with assigned staff that have not made a payment in 40 days", source: available },
  { key: "last40daysNoRequest", label: "Active clients who have not made a request in over 40 days", source: missing("company start dates and active flags from the importer") },
  { key: "companyUnderReview", label: "Company registrations waiting for review", source: available },
  { key: "transfersWithNoProfitInProgress", label: "Unpaid transfers with no profit", source: available },
  { key: "transfersWithSameRateInProgress", label: "Unpaid transfers where the company and candidate rates are the same", source: missing("hourly rates on transfer lines, which the pay lane keeps only inside each line's calculation") },
  { key: "totalStoreAssignmentRequests", label: "Store assignment requests waiting for an answer", source: available },
  { key: "totalInterviewRequests", label: "Interviews to schedule", source: available },
  { key: "totalInterviewScheduled", label: "Upcoming scheduled interviews", source: available },
] as const satisfies readonly StatisticCounter[];

export type StaffStatisticKey = typeof STAFF_STATISTICS_COUNTERS[number]["key"];

/**
 * The overview figures (slice 2, legacy admin `StatisticController::actionList`), in legacy's
 * order. Each one names where it comes from: the statistics store (`store`), the company
 * directory as the viewer sees it (`companies`), or the work lane's staff time (`staffTime`).
 *
 * Changes from legacy:
 * - Companies come from the organizations directory, so "active" uses its one status
 *   derivation (finding OR-F2) and deleted companies are left out; legacy's KWD-only filter is
 *   not applied, because a company with no currency on file would silently drop out.
 * - "Candidates" are people with a profile; "assigned" are people with a store assignment
 *   running on the Kuwait day (legacy counted anyone who had ever been assigned).
 * - "Suggested" counts every recruit pipeline card: a card is where a suggestion starts.
 * - Requests leave out drafts, which no company has sent yet; delivered requests are the filled
 *   ones and the ones closed as fulfilled. Both keep legacy's KWD filter, like active requests.
 * - Invitations are shown once, with the hiring figures.
 * - "Universities to fix" (an English name missing or equal to the Arabic one) has no
 *   equivalent: the catalogue keeps one name per entry, so there is nothing to fix.
 * - Transfers (slice 8) are read live from the pay lane's `pay_transfers` and `pay_transfer_lines`,
 *   KWD like legacy, deleted transfers left out. "Candidates with a payment due" counts the unpaid
 *   lines of transfers whose salaries are being distributed (legacy `getTotalPayableCandidate`);
 *   "Transfers locked" and "Transfers with the payment sent" count transfers in that status now.
 *   Legacy also showed the amount still to pay; it is on the revenue page's reconciliation.
 */
export type OverviewSource = "store" | "companies" | "staffTime";
export interface OverviewFigure { readonly key: string; readonly label: string; readonly source: OverviewSource | { readonly kind: "missing"; readonly waitsOn: string } }
const NO_LEAVE = "staff leave, which no lane holds yet";
export const STATISTICS_OVERVIEW = [
  { key: "candidates", label: "Candidates (people with a profile)", source: "store" },
  { key: "assigned", label: "Candidates assigned to a store today", source: "store" },
  { key: "unapproved", label: "Candidates not yet approved", source: { kind: "missing", waitsOn: "profile approval, which no lane holds yet" } },
  { key: "suggested", label: "Candidates suggested to requests", source: "store" },
  { key: "activeClients", label: "Active companies", source: "companies" },
  { key: "companies", label: "All companies", source: "companies" },
  { key: "requests", label: "Requests", source: "store" },
  { key: "requestsDelivered", label: "Requests delivered", source: "store" },
  { key: "payableCandidates", label: "Candidates with a payment due", source: "store" },
  { key: "transfersLocked", label: "Transfers locked", source: "store" },
  { key: "transfersPaymentSent", label: "Transfers with the payment sent", source: "store" },
  { key: "staffSalaryPaid", label: "Staff salary paid", source: { kind: "missing", waitsOn: "staff salaries, which no lane holds yet" } },
  { key: "staff", label: "StudentHub staff", source: "staffTime" },
  { key: "staffAttended", label: "Staff who started a work session today", source: "staffTime" },
  { key: "staffAbsent", label: "Staff on leave today", source: { kind: "missing", waitsOn: NO_LEAVE } },
  { key: "staffNotAttended", label: "Staff who did not attend today", source: { kind: "missing", waitsOn: NO_LEAVE } },
] as const satisfies readonly OverviewFigure[];

/** Company totals as the viewer's directory shows them; undefined when the directory does not answer for this viewer. */
export interface StatisticsCompanies { counts(viewer: string): Promise<{ readonly activeClients: number; readonly companies: number } | undefined> }
/** The work lane's staff time: who is StudentHub staff, and who started a session on a Kuwait day. */
export interface StatisticsStaffTime { operatorStaff(): Promise<readonly string[]>; staffWithSessionOn(workDate: string): Promise<ReadonlySet<string>> }

/** The raw hiring numbers the store reads; the ratios are worked out here. */
export interface HiringCounts { readonly hired: number; readonly retained: number; readonly invitations: number }
export interface HiringFigures extends HiringCounts {
  /** Percent of assignments that lasted (or have lasted so far) more than 365 days; null with no assignments. */
  readonly retentionRatio: number | null;
  /** Assignments per 100 invitations sent; null with no invitations. */
  readonly recruitmentYield: number | null;
}

/**
 * Invitations by the month they were sent (slice 5, legacy admin `StatisticController::actionInvitationGraphData`,
 * `Invitation::getDataByMonths`): the 12 whole months before the current Kuwait month, oldest first, with how many were
 * sent and how each stands now.
 *
 * Changes from legacy:
 * - Legacy keyed months by name only ("November"), so the month a year back and the current month shared one key, and
 *   grouped by `MONTH()` across years. Here a month is `YYYY-MM`, counted in Kuwait time.
 * - Legacy had no withdrawn invitations; here they are their own column, and still count in the total.
 * - "No answer yet" is sent or seen, legacy's "Invited/ No Response".
 */
export interface InvitationMonthCounts { readonly month: string; readonly noAnswer: number; readonly accepted: number; readonly declined: number; readonly withdrawn: number }
export interface InvitationMonth extends InvitationMonthCounts {
  readonly total: number;
  /** Percent of the month's invitations accepted (or declined), to one decimal; null with none sent. */
  readonly acceptanceRate: number | null; readonly declineRate: number | null;
}

/** The 12 whole months before the month of `day` (`YYYY-MM-DD`), oldest first. */
export function invitationMonths(day: string): string[] {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const n = y * 12 + (m - 1) - 12 + i;
    return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, "0")}`;
  });
}

/**
 * Emails sent per day (slice 7, legacy admin `MailLogController::actionStats`, `MailLog::getTotalByDays`): the last
 * 14 Kuwait days up to today, oldest first, with the emails sent and the delivery attempts that failed, and whether the
 * day passed the daily volume alert threshold (legacy `mailThreshold`, see the volume check in `packages/notifications`).
 *
 * Changes from legacy: legacy grouped by weekday name, so a 14-day view folded two weeks onto seven days, and it
 * counted every logged email; here a day is a Kuwait date, and only emails the provider accepted count as sent.
 */
export const EMAIL_DAYS = 14;
export interface EmailDayCounts { readonly day: string; readonly sent: number; readonly failed: number }
export interface EmailDay extends EmailDayCounts { readonly overThreshold: boolean }

/** The `EMAIL_DAYS` Kuwait days up to and including `day`, oldest first. */
export function emailDays(day: string): string[] {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Array.from({ length: EMAIL_DAYS }, (_, i) => new Date(at - (EMAIL_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** One row per day of `days`, in that order; a day the store left out is zeros. A day outside `days` is an error. */
export function emailsByDay(days: readonly string[], rows: readonly EmailDayCounts[]): EmailDay[] {
  const by = new Map<string, EmailDayCounts>();
  for (const r of rows) {
    if (!days.includes(r.day) || by.has(r.day)) throw new TypeError(`email day ${r.day} was not asked for`);
    by.set(r.day, r);
  }
  return days.map(day => {
    const sent = count(by.get(day)?.sent ?? 0, "sent"), failed = count(by.get(day)?.failed ?? 0, "failed");
    return { day, sent, failed, overThreshold: sent > EMAIL_VOLUME_THRESHOLD };
  });
}

export interface StatisticsStore {
  /** Emails sent, and delivery attempts that failed, on each of `days` (Kuwait dates). A day with none may be left out. */
  emailsByDay(days: readonly string[]): Promise<readonly EmailDayCounts[]>;
  /** Invitations sent in each of `months` (`YYYY-MM`, Kuwait time), by how they stand now. A month with none may be left out. */
  invitationsByMonth(months: readonly string[]): Promise<readonly InvitationMonthCounts[]>;
  /** The available counters for one Asia/Kuwait day, by key. */
  staffCounts(day: string, now: Date): Promise<Readonly<Record<string, number>>>;
  hiring(day: string): Promise<HiringCounts>;
  /** The overview figures this store reads (`source: "store"`), by key, for one Asia/Kuwait day. */
  overviewCounts(day: string): Promise<Readonly<Record<string, number>>>;
}
export interface StatisticRow { readonly key: string; readonly label: string; readonly value: number | null; readonly waitsOn: string | null }
export interface StatisticsPage {
  readonly day: string; readonly counters: readonly StatisticRow[]; readonly hiring: HiringFigures; readonly overview: readonly StatisticRow[];
  readonly invitationsByMonth: readonly InvitationMonth[];
  readonly emailsByDay: readonly EmailDay[]; readonly emailThreshold: number;
}

const count = (n: unknown, key: string): number => {
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new TypeError(`statistic ${key} has no value`);
  return n as number;
};
/** One row per month of `months`, in that order; a month the store left out is all zeros. A month outside `months` is an error. */
export function invitationsByMonth(months: readonly string[], rows: readonly InvitationMonthCounts[]): InvitationMonth[] {
  const by = new Map<string, InvitationMonthCounts>();
  for (const r of rows) {
    if (!months.includes(r.month) || by.has(r.month)) throw new TypeError(`invitation month ${r.month} was not asked for`);
    by.set(r.month, r);
  }
  return months.map(month => {
    const r = by.get(month);
    const c = { noAnswer: count(r?.noAnswer ?? 0, "noAnswer"), accepted: count(r?.accepted ?? 0, "accepted"), declined: count(r?.declined ?? 0, "declined"), withdrawn: count(r?.withdrawn ?? 0, "withdrawn") };
    const total = c.noAnswer + c.accepted + c.declined + c.withdrawn;
    return { month, ...c, total, acceptanceRate: percent(c.accepted, total), declineRate: percent(c.declined, total) };
  });
}

/** A percentage to one decimal place, or null when there is nothing to divide by. */
export const percent = (part: number, whole: number): number | null => whole > 0 ? Math.round(part * 1000 / whole) / 10 : null;

export class StatisticsService {
  readonly #store: StatisticsStore; readonly #authority: { isStaff(principalId: string): Promise<boolean> }; readonly #now: () => Date;
  readonly #companies: StatisticsCompanies | undefined; readonly #staffTime: StatisticsStaffTime | undefined;
  /** Without `companies` or `staffTime`, their figures show as not available. */
  constructor(store: StatisticsStore, authority: { isStaff(principalId: string): Promise<boolean> }, now: () => Date = () => new Date(),
    sources: { readonly companies?: StatisticsCompanies; readonly staffTime?: StatisticsStaffTime } = {}) {
    this.#store = store; this.#authority = authority; this.#now = now; this.#companies = sources.companies; this.#staffTime = sources.staffTime;
  }

  async #staffToday(day: string): Promise<Record<string, number> | undefined> {
    if (!this.#staffTime) return undefined;
    const [staff, attended] = await Promise.all([this.#staffTime.operatorStaff(), this.#staffTime.staffWithSessionOn(day)]);
    // Only people who are staff now count as attending, so attended never passes the staff total.
    return { staff: staff.length, staffAttended: staff.filter(id => attended.has(id)).length };
  }

  /** Every counter in registry order, the hiring figures and the overview; undefined for anyone who is not StudentHub staff. */
  async page(viewer: string): Promise<StatisticsPage | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const now = this.#now(), day = kuwaitDay(now);
    const months = invitationMonths(day), days = emailDays(day);
    const [raw, hiring, stored, companies, staffTime, invited, emails] = await Promise.all([this.#store.staffCounts(day, now), this.#store.hiring(day), this.#store.overviewCounts(day),
      this.#companies?.counts(viewer), this.#staffToday(day), this.#store.invitationsByMonth(months), this.#store.emailsByDay(days)]);
    const counters = STAFF_STATISTICS_COUNTERS.map(c => c.source.kind === "missing"
      ? { key: c.key, label: c.label, value: null, waitsOn: c.source.waitsOn }
      : { key: c.key, label: c.label, value: count(raw[c.key], c.key), waitsOn: null });
    const h = { hired: count(hiring.hired, "hired"), retained: count(hiring.retained, "retained"), invitations: count(hiring.invitations, "invitations") };
    const answered: Record<OverviewSource, Readonly<Record<string, number>> | undefined> = { store: stored, companies, staffTime };
    const unanswered: Record<OverviewSource, string> = { store: "", companies: "the company directory, which did not answer for you", staffTime: "staff time from the work lane, which is not connected here" };
    const overview = STATISTICS_OVERVIEW.map((f): StatisticRow => {
      if (typeof f.source !== "string") return { key: f.key, label: f.label, value: null, waitsOn: f.source.waitsOn };
      const from = answered[f.source];
      return from ? { key: f.key, label: f.label, value: count(from[f.key], f.key), waitsOn: null } : { key: f.key, label: f.label, value: null, waitsOn: unanswered[f.source] };
    });
    return { day, counters, hiring: { ...h, retentionRatio: percent(h.retained, h.hired), recruitmentYield: percent(h.hired, h.invitations) }, overview,
      invitationsByMonth: invitationsByMonth(months, invited), emailsByDay: emailsByDay(days, emails), emailThreshold: EMAIL_VOLUME_THRESHOLD };
  }
}
