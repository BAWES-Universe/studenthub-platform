/**
 * The morning summary's counters (contract P-2, legacy `CronController::actionSummary`), in the
 * order legacy's email lists them. Each counter says where its number comes from. A counter
 * whose source has not landed yet is `missing`: the digest and the staff page show "not
 * available" for it, never 0, and it switches on here, with its query in the store, when its
 * lane's data exists.
 *
 * Legacy lists "Candidates Assigned to work without ID cards" twice; here it is one counter.
 */
export type MorningSummarySource =
  | { readonly kind: "available" }
  | { readonly kind: "missing"; readonly waitsOn: string };
export interface MorningSummaryCounter { readonly key: string; readonly label: string; readonly source: MorningSummarySource }

const missing = (waitsOn: string): MorningSummarySource => ({ kind: "missing", waitsOn });
const available: MorningSummarySource = { kind: "available" };

export const MORNING_SUMMARY_COUNTERS = [
  { key: "interviewScheduledToday", label: "Interviews scheduled today: organise the meeting between the company and the candidates", source: available },
  { key: "companyMoreThen40DaysWithoutPayment", label: "Urgent: companies with assigned staff that have not made a payment in 40 days", source: missing("transfers from the pay lane") },
  { key: "totalExpiredCards", label: "Candidates with expired ID cards", source: missing("candidate ID cards, which no lane holds yet") },
  { key: "id_need_generated", label: "Candidates assigned to work without ID cards", source: missing("candidate ID cards, which no lane holds yet") },
  { key: "activeRequests", label: "Active requests that need an update", source: available },
  { key: "last40daysNoRequest", label: "Active clients who have not made a request in over 40 days", source: missing("company start dates and active flags from the importer") },
  { key: "requireFollowup", label: "Clients requiring follow-up", source: missing("company follow-up dates, which no lane holds yet") },
  { key: "missingBankInfo", label: "Candidates missing bank info", source: missing("unpaid transfers from the pay lane (a count without them would be too low)") },
  { key: "assignedExpiredCivilID", label: "Assigned candidates with an expired civil ID", source: available },
  { key: "assignedIdleCandidates", label: "Assigned candidates who have not received any payment in the past two months", source: missing("transfers from the pay lane") },
  { key: "incompleteAssignedToWork", label: "Assigned candidates with incomplete profiles", source: missing("profile completeness, which no lane holds yet") },
  { key: "profileApprovalRequire", label: "Profiles to be reviewed and approved", source: missing("profile approval, which no lane holds yet") },
] as const satisfies readonly MorningSummaryCounter[];

export type MorningSummaryCounterKey = typeof MORNING_SUMMARY_COUNTERS[number]["key"];
/** The counters' values: a number, or null for a counter whose source is missing. */
export type MorningSummaryCounts = { readonly [K in MorningSummaryCounterKey]: number | null };
export const MORNING_SUMMARY_KEYS: readonly MorningSummaryCounterKey[] = MORNING_SUMMARY_COUNTERS.map(c => c.key);
/** Legacy shows these two rows only when the number is above 0. */
export const MORNING_SUMMARY_HIDDEN_AT_ZERO: readonly MorningSummaryCounterKey[] = ["interviewScheduledToday", "companyMoreThen40DaysWithoutPayment"];
