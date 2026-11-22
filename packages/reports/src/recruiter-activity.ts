import { kuwaitDay } from "./id-cards.js";

/**
 * Staff statistics (contract P-3), slice 6: what each staff member did over a range of Kuwait days.
 * Legacy had this twice: the recruiter report cron (`console/controllers/ReportController::actionRecruiter`,
 * 17:00 UTC Sunday to Thursday, each recruiter's day to Slack and Segment) and admin's staff list with
 * the `totalAssigned`, `totalRequests`, `totalNotes`, `totalSuggestions` and invitation totals over a
 * start and end date (`admin/models/Staff.php` extra fields, `common/models/Staff.php`).
 *
 * Here it is one staff page, `/workspace/statistics/recruiters`, for any range up to a year, today by default.
 *
 * Changes from legacy, by the rule that legacy prod is the benchmark and best practice wins:
 * - Slack and Segment are not channels here; the page replaces the post.
 * - Legacy listed staff with the recruiter role only. Here every StudentHub staff member is listed,
 *   busiest first, because placements and invitations are made by all of them.
 * - Legacy counted a placement by its start date (`start_date >= today`, so future starts too) and its
 *   suggestions as notes of type "Suggested". Here a placement counts on the day it was recorded, and a
 *   suggestion is a person the staff member put on a request (a new recruit card).
 * - Legacy's stories (and their employees and time) have no equivalent: the recruit pipeline replaced them.
 * - Removed notes are not counted.
 */
export const RECRUITER_ACTIVITY_MAX_DAYS = 366;
export const RECRUITER_ACTIVITY_COLUMNS = [
  { key: "placements", label: "Placements recorded" },
  { key: "requests", label: "Requests created" },
  { key: "suggestions", label: "People suggested" },
  { key: "notes", label: "Notes" },
  { key: "invitations", label: "Invitations sent" },
  { key: "invitationsAccepted", label: "Of those, accepted" },
  { key: "invitationsDeclined", label: "Of those, declined" },
] as const;
export type RecruiterActivityKey = typeof RECRUITER_ACTIVITY_COLUMNS[number]["key"];
export type RecruiterActivityCounts = Readonly<Record<RecruiterActivityKey, number>>;

export interface RecruiterActivityStore {
  /** Counts for each of `staff` over the Kuwait days `from` to `to` (inclusive), and their names; someone with nothing may be left out of `counts`. */
  recruiterActivity(staff: readonly string[], from: string, to: string): Promise<{ readonly names: ReadonlyMap<string, string>; readonly counts: ReadonlyMap<string, RecruiterActivityCounts> }>;
}
export interface RecruiterActivityRow extends RecruiterActivityCounts { readonly principalId: string; readonly name: string }
export interface RecruiterActivityPage { readonly from: string; readonly to: string; readonly today: string; readonly staff: readonly RecruiterActivityRow[]; readonly totals: RecruiterActivityCounts }
export type RecruiterActivityRange = { readonly from?: string | null; readonly to?: string | null };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day as `YYYY-MM-DD`, or null. */
export function calendarDay(v: string | null | undefined): string | null {
  const m = v ? DAY.exec(v) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v ? v : null;
}
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** Why a range is refused, or null when it is fine. */
export function rangeProblem(from: string, to: string, today: string): "from" | "to" | "order" | "too_long" | null {
  if (!calendarDay(from)) return "from";
  if (!calendarDay(to) || to > today) return "to";
  if (from > to) return "order";
  return daysBetween(from, to) + 1 > RECRUITER_ACTIVITY_MAX_DAYS ? "too_long" : null;
}

const zero = (): Record<RecruiterActivityKey, number> => Object.fromEntries(RECRUITER_ACTIVITY_COLUMNS.map(c => [c.key, 0])) as Record<RecruiterActivityKey, number>;
const count = (n: unknown, key: string): number => {
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new TypeError(`recruiter activity ${key} has no value`);
  return n as number;
};

export class RecruiterActivityService {
  readonly #store: RecruiterActivityStore; readonly #authority: { isStaff(principalId: string): Promise<boolean> };
  readonly #staff: { operatorStaff(): Promise<readonly string[]> }; readonly #now: () => Date;
  constructor(store: RecruiterActivityStore, authority: { isStaff(principalId: string): Promise<boolean> }, staff: { operatorStaff(): Promise<readonly string[]> }, now: () => Date = () => new Date()) {
    this.#store = store; this.#authority = authority; this.#staff = staff; this.#now = now;
  }
  /**
   * Every StudentHub staff member's counts over the range (today in Kuwait when not given), busiest first; undefined for
   * anyone who is not staff. A range that is not real days, ends after today, is backwards or is longer than a year is refused.
   */
  async page(viewer: string, range: RecruiterActivityRange = {}): Promise<RecruiterActivityPage | { readonly refused: ReturnType<typeof rangeProblem> } | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const today = kuwaitDay(this.#now()), to = range.to ?? today, from = range.from ?? to;
    const problem = rangeProblem(from, to, today);
    if (problem) return { refused: problem };
    const staff = [...new Set(await this.#staff.operatorStaff())];
    const { names, counts } = staff.length ? await this.#store.recruiterActivity(staff, from, to) : { names: new Map<string, string>(), counts: new Map<string, RecruiterActivityCounts>() };
    const totals = zero();
    const rows = staff.map(id => {
      const c = counts.get(id), row = zero();
      for (const { key } of RECRUITER_ACTIVITY_COLUMNS) { row[key] = count(c?.[key] ?? 0, key); totals[key] += row[key]; }
      return { principalId: id, name: names.get(id) ?? id, ...row };
    });
    const busy = (r: RecruiterActivityCounts) => r.placements + r.requests + r.suggestions + r.notes + r.invitations;
    rows.sort((a, b) => busy(b) - busy(a) || a.name.localeCompare(b.name) || a.principalId.localeCompare(b.principalId));
    return { from, to, today, staff: rows, totals };
  }
}
