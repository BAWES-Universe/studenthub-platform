// Internal staff time: StudentHub's own staff clock in and out (legacy
// `staff_work_session`, the staff app's daily stand-up start and end session,
// and the admin app's list, inactive list and download). Hours are hours, so
// this lives in the work lane beside the hours candidates work at companies.
//
// Who: any operator staff member (staff or admin on the operator organization)
// times their own day; operator admins see everyone's (legacy admin app).

import { isIsoDate, isPrincipalId, kuwaitDate, OPERATOR_ORG_IDS, sqlState, isOperatorStaff, type IsoDate, type WorkGrant } from "./common.js";
import { parseRange, type HoursRange } from "./views.js";
import type { GrantsPort } from "./placement.js";

export interface StaffSession {
  readonly id: string;
  readonly staffId: string;
  readonly workDate: IsoDate;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Whole minutes, server-computed; null while open. */
  readonly minutes: number | null;
  readonly source: "timer" | "import";
}

/** One staff member's day: closed minutes added up; `open` while a session of that day has no end. */
export interface StaffDay {
  readonly staffId: string;
  readonly workDate: IsoDate;
  readonly minutes: number;
  readonly sessions: number;
  readonly open: boolean;
  readonly firstStart: string;
  readonly lastEnd: string | null;
}
export interface StaffDayCursor { readonly workDate: IsoDate; readonly staffId: string }

export interface StaffTimeStore {
  /** The staff member's open session of `workDate`, if any. */
  openSession(staffId: string, workDate: IsoDate): Promise<StaffSession | undefined>;
  /** "exists" when an open session of that day is already there (two parallel starts). */
  insertOpen(session: { readonly id: string; readonly staffId: string; readonly workDate: IsoDate; readonly startedAt: Date }): Promise<"inserted" | "exists">;
  /** Ends an open session; undefined when it was already ended. */
  end(id: string, endedAt: Date): Promise<StaffSession | undefined>;
  sessionsOn(staffId: string, workDate: IsoDate): Promise<readonly StaffSession[]>;
  /** Days in the range, newest first then staff id, after the cursor. */
  days(filter: { readonly range: HoursRange; readonly staffId?: string; readonly after?: StaffDayCursor; readonly limit: number }): Promise<readonly StaffDay[]>;
  /** Everyone who holds a staff or admin grant on an operator organization. */
  operatorStaff(): Promise<readonly string[]>;
  /** Who has any session on the date. */
  staffWithSessionOn(workDate: IsoDate): Promise<ReadonlySet<string>>;
}

export const STAFF_DAY_PAGE_SIZE = 100;
export type StaffTimeRefusal = "forbidden" | "invalid_input" | "not_working";
type Refused = { readonly kind: "refused"; readonly code: StaffTimeRefusal };
const refused = (code: StaffTimeRefusal): Refused => ({ kind: "refused", code });

/** Admin of the operator organization: sees every staff member's time. */
export function isOperatorAdmin(grants: readonly WorkGrant[]): boolean {
  return grants.some((g) => g.role === "admin" && OPERATOR_ORG_IDS.includes(g.orgId) && g.scope === "subtree");
}

export interface StaffTimeServiceOptions {
  readonly store: StaffTimeStore;
  readonly grants: GrantsPort;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export class StaffTimeService {
  readonly #store: StaffTimeStore;
  readonly #grants: GrantsPort;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: StaffTimeServiceOptions) {
    this.#store = options.store;
    this.#grants = options.grants;
    this.#newId = options.newId;
    this.#now = options.now ?? (() => new Date());
  }

  async #staff(actorId: string): Promise<boolean> { return isOperatorStaff(await this.#grants.listGrantsForPrincipal(actorId)); }
  async #admin(actorId: string): Promise<boolean> { return isOperatorAdmin(await this.#grants.listGrantsForPrincipal(actorId)); }

  /** Starts today's session; a second start returns the open one (legacy). */
  async start(actorId: string): Promise<{ readonly kind: "started"; readonly session: StaffSession; readonly already: boolean } | Refused> {
    if (!(await this.#staff(actorId))) return refused("forbidden");
    const now = this.#now(), today = kuwaitDate(now);
    const open = await this.#store.openSession(actorId, today);
    if (open) return { kind: "started", session: open, already: true };
    const id = this.#newId();
    if ((await this.#store.insertOpen({ id, staffId: actorId, workDate: today, startedAt: now })) === "exists") {
      const raced = await this.#store.openSession(actorId, today);
      if (raced) return { kind: "started", session: raced, already: true };
    }
    const session = await this.#store.openSession(actorId, today);
    return session ? { kind: "started", session, already: false } : refused("not_working");
  }

  /** Ends today's open session; the minutes come from the stored start and this end. */
  async end(actorId: string): Promise<{ readonly kind: "ended"; readonly session: StaffSession } | Refused> {
    if (!(await this.#staff(actorId))) return refused("forbidden");
    const now = this.#now();
    const open = await this.#store.openSession(actorId, kuwaitDate(now));
    if (!open) return refused("not_working");
    const session = await this.#store.end(open.id, now);
    return session ? { kind: "ended", session } : refused("not_working");
  }

  /** The actor's sessions today. */
  async today(actorId: string): Promise<{ readonly kind: "today"; readonly workDate: IsoDate; readonly sessions: readonly StaffSession[] } | Refused> {
    if (!(await this.#staff(actorId))) return refused("forbidden");
    const workDate = kuwaitDate(this.#now());
    return { kind: "today", workDate, sessions: await this.#store.sessionsOn(actorId, workDate) };
  }

  /** Days over a range: an admin sees everyone (or one `staffId`); a staff member sees only their own. */
  async days(actorId: string, from: unknown, to: unknown, options: { readonly staffId?: string; readonly after?: StaffDayCursor | null } = {}):
    Promise<{ readonly kind: "days"; readonly days: readonly StaffDay[]; readonly next: StaffDayCursor | null } | Refused> {
    const range = parseRange(from, to);
    if (!range) return refused("invalid_input");
    if (options.staffId !== undefined && !isPrincipalId(options.staffId)) return refused("invalid_input");
    if (options.after && (!isIsoDate(options.after.workDate) || !isPrincipalId(options.after.staffId))) return refused("invalid_input");
    const admin = await this.#admin(actorId);
    if (!admin && !(await this.#staff(actorId))) return refused("forbidden");
    // A staff member who is not an admin reads their own days only, whatever was asked.
    const staffId = admin ? options.staffId : actorId;
    if (!admin && options.staffId !== undefined && options.staffId !== actorId) return refused("forbidden");
    const rows = await this.#store.days({ range, ...(staffId ? { staffId } : {}), ...(options.after ? { after: options.after } : {}), limit: STAFF_DAY_PAGE_SIZE + 1 });
    const page = rows.slice(0, STAFF_DAY_PAGE_SIZE);
    const last = page[page.length - 1];
    return { kind: "days", days: page, next: rows.length > STAFF_DAY_PAGE_SIZE && last ? { workDate: last.workDate, staffId: last.staffId } : null };
  }

  /** Operator staff with no session on the date (legacy list-inactive); admins only. */
  async inactive(actorId: string, date: unknown): Promise<{ readonly kind: "inactive"; readonly workDate: IsoDate; readonly staffIds: readonly string[] } | Refused> {
    if (!isIsoDate(date)) return refused("invalid_input");
    if (!(await this.#admin(actorId))) return refused("forbidden");
    const [everyone, active] = await Promise.all([this.#store.operatorStaff(), this.#store.staffWithSessionOn(date)]);
    return { kind: "inactive", workDate: date, staffIds: [...new Set(everyone)].filter((id) => !active.has(id)).sort() };
  }
}

/** Unique violation on the one-open index: a parallel start won. */
export function isOpenStaffSessionConflict(error: unknown): boolean {
  return sqlState(error) === "23505";
}
