/**
 * Operational reports (contract A-24, `/reports/operations`): the one entry for StudentHub staff to the day's
 * operations, replacing legacy's staff dashboard and report list (STAFF-B010, ADM-B074..080 assigned-candidate
 * views, STAFF-B043 productivity, ADM-B024..028 standup). It reads nothing of its own: today's morning summary
 * counters and the team's totals for today come from those services, and every other view is a link to the page
 * that already serves it. Access is the same staff check as the pages it links to; no new grant is created.
 */
import type { MorningSummaryRow } from "./morning-summary.js";
import type { RecruiterActivityCounts } from "./recruiter-activity.js";

export interface OperationsSources {
  /** Today's morning summary for a staff member; undefined for anyone else. */
  summary(viewer: string): Promise<{ readonly day: string; readonly rows: readonly MorningSummaryRow[] } | undefined>;
  /** What the team recorded on one Kuwait day; undefined for anyone else. */
  team(viewer: string, day: string): Promise<{ readonly totals: RecruiterActivityCounts; readonly staff: readonly unknown[] } | { readonly refused: unknown } | undefined>;
}
export interface OperationsPage {
  readonly day: string;
  /** The morning summary's counters, in its order; a counter whose source has not landed is null with what it waits on. */
  readonly attention: readonly MorningSummaryRow[];
  readonly team: { readonly staff: number; readonly totals: RecruiterActivityCounts };
}

export class OperationsService {
  readonly #sources: OperationsSources; readonly #authority: { isStaff(principalId: string): Promise<boolean> };
  constructor(sources: OperationsSources, authority: { isStaff(principalId: string): Promise<boolean> }) { this.#sources = sources; this.#authority = authority; }
  /** Today's operations for a staff member; undefined for anyone else, before anything is read. */
  async page(viewer: string): Promise<OperationsPage | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const summary = await this.#sources.summary(viewer);
    if (!summary) return undefined;
    // The team's day is the summary's, so both halves of the page are for the same Kuwait day.
    const team = await this.#sources.team(viewer, summary.day);
    if (!team) return undefined;
    if ("refused" in team) throw new Error(`team totals refused for ${summary.day}`);
    return { day: summary.day, attention: summary.rows, team: { staff: team.staff.length, totals: team.totals } };
  }
}
