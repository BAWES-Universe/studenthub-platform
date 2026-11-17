// W-5: everyone sees the hours they may see.
//
// Legacy candidate, company, manager and staff CandidateWorkingHourController
// list/detail/stats actions, with these fixes:
// - the person could read every decision field through `expand` (note,
//   rating, reason, is_public): the person sees the outcome and reason, and
//   the note only when the employer marked it public; never the rating;
// - the date range went raw into SQL (injection): dates are parsed and bound;
// - the company list took its store from the request or the person's current
//   store: scope comes from the signed-in actor only;
// - "hours" mixed approved, pending and rejected time: totals are split;
// - stats returned the last session's status as the day status: counts per
//   status instead.
// Paging is stable: ordered by work date, then session id, with a cursor.

import { isIsoDate, isUuid, type IsoDate } from "./common.js";
import type { DecisionOutcome, WorkDecision, WorkScope } from "./decisions.js";
import type { SessionStatus, WorkSession } from "./sessions.js";

export const MAX_RANGE_DAYS = 366;
export const PAGE_SIZE = 100;

export interface HoursRange { readonly from: IsoDate; readonly to: IsoDate }
export interface HoursCursor { readonly workDate: IsoDate; readonly id: string }

export interface SessionFilter {
  readonly personId?: string;
  /** Organizations whose stores are included; their sub-companies only with `includeSubtree`. */
  readonly orgIds?: readonly string[];
  readonly includeSubtree?: boolean;
  readonly storeIds?: readonly string[];
  readonly status?: SessionStatus;
  readonly range: HoursRange;
  readonly after?: HoursCursor;
  readonly limit: number;
}

export interface HoursViewStore {
  /** Sessions in force (not deleted, not replaced), ordered by work date then id. */
  listSessions(filter: SessionFilter): Promise<readonly WorkSession[]>;
  decisions(ids: readonly string[]): Promise<readonly WorkDecision[]>;
  /** Totals over the whole filter (every page), split by status. */
  totals(filter: Omit<SessionFilter, "after" | "limit">): Promise<HoursTotals>;
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined>;
}

/** What the person sees about a decision on their own hours. */
export interface PersonDecisionView {
  readonly outcome: DecisionOutcome;
  readonly reason: string | null;
  readonly note: string | null;
  readonly decidedAt: string;
}

/** What an employer or staff sees. Staff and the deciding company see everything about their own decisions. */
export interface EmployerDecisionView extends PersonDecisionView {
  readonly rating: number | null;
  readonly notePublic: boolean;
  readonly decidedBy: string | null;
}

export interface HoursTotals { readonly approvedSeconds: number; readonly pendingSeconds: number; readonly rejectedSeconds: number; readonly open: number }
export interface HoursRow<D> { readonly session: WorkSession; readonly decision: D | null }
export interface HoursPage<D> {
  readonly rows: readonly HoursRow<D>[];
  readonly totals: HoursTotals;
  readonly next: HoursCursor | null;
}

export type ViewRefusal = "invalid_input" | "forbidden";

export function parseRange(from: unknown, to: unknown): HoursRange | undefined {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return undefined;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return days < MAX_RANGE_DAYS ? { from, to } : undefined;
}

/** Cursor text is `YYYY-MM-DD~uuid`, opaque to callers. */
export function parseCursor(value: unknown): HoursCursor | undefined | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const [workDate, id, extra] = value.split("~");
  return extra === undefined && isIsoDate(workDate) && isUuid(id) ? { workDate, id: id.toLowerCase() } : undefined;
}
export function formatCursor(cursor: HoursCursor): string {
  return `${cursor.workDate}~${cursor.id}`;
}

export function personDecisionView(d: WorkDecision): PersonDecisionView {
  return Object.freeze({ outcome: d.outcome, reason: d.reason, note: d.notePublic ? d.note : null, decidedAt: d.decidedAt });
}
export function employerDecisionView(d: WorkDecision): EmployerDecisionView {
  return Object.freeze({ outcome: d.outcome, reason: d.reason, note: d.note, decidedAt: d.decidedAt, rating: d.rating, notePublic: d.notePublic, decidedBy: d.decidedBy });
}

export class HoursViews {
  readonly #store: HoursViewStore;
  readonly #scope: WorkScope;
  readonly #managed: (actorId: string) => Promise<readonly { readonly orgId: string; readonly storeId: string }[]>;

  constructor(store: HoursViewStore, scope: WorkScope, managedStores: (actorId: string) => Promise<readonly { readonly orgId: string; readonly storeId: string }[]>) {
    this.#store = store;
    this.#scope = scope;
    this.#managed = managedStores;
  }

  /** "My hours": the person's own sessions only. */
  async mine(personId: string, range: HoursRange, after: HoursCursor | null): Promise<HoursPage<PersonDecisionView>> {
    return this.#page({ personId, range, ...(after ? { after } : {}), limit: PAGE_SIZE }, personDecisionView);
  }

  /**
   * A company's hours: staff and the company see every store of the company
   * (sub-companies included); a store manager sees only the stores they manage
   * in it. `storeId` narrows to one store the actor covers.
   */
  async company(actorId: string, orgId: string, range: HoursRange, options: { readonly storeId?: string; readonly status?: SessionStatus; readonly after?: HoursCursor | null } = {}):
    Promise<HoursPage<EmployerDecisionView> | { readonly kind: "refused"; readonly code: ViewRefusal }> {
    const base = { range, ...(options.status ? { status: options.status } : {}), ...(options.after ? { after: options.after } : {}), limit: PAGE_SIZE };
    const ancestors = await this.#store.organizationAncestors(orgId);
    if (ancestors === undefined) return { kind: "refused", code: "forbidden" };
    // A self-scoped grant reaches this company only; a subtree grant (or staff above) reaches its sub-companies too.
    const reach = await this.#scope.companyReach(actorId, orgId);
    if (options.storeId !== undefined) {
      if (!isUuid(options.storeId)) return { kind: "refused", code: "invalid_input" };
      const storeId = options.storeId.toLowerCase();
      if (!(await this.#scope.covers(actorId, orgId, storeId))) return { kind: "refused", code: "forbidden" };
      // A manager's store must belong to this company; the org filter keeps a mismatched pair empty.
      return this.#page({ ...base, orgIds: [orgId], includeSubtree: reach === "subtree", storeIds: [storeId] }, employerDecisionView);
    }
    // Company-wide: staff or the company itself; a manager falls back to their own stores in it.
    if (reach !== "none") return this.#page({ ...base, orgIds: [orgId], includeSubtree: reach === "subtree" }, employerDecisionView);
    const managed = (await this.#managed(actorId)).filter((m) => m.orgId === orgId).map((m) => m.storeId);
    if (managed.length === 0) return { kind: "refused", code: "forbidden" };
    return this.#page({ ...base, orgIds: [orgId], includeSubtree: false, storeIds: managed }, employerDecisionView);
  }

  /** Staff across every company (legacy staff list-date). */
  async all(actorId: string, range: HoursRange, options: { readonly personId?: string; readonly status?: SessionStatus; readonly after?: HoursCursor | null } = {}):
    Promise<HoursPage<EmployerDecisionView> | { readonly kind: "refused"; readonly code: ViewRefusal }> {
    if (!(await this.#scope.isOperatorStaff(actorId))) return { kind: "refused", code: "forbidden" };
    return this.#page({ range, ...(options.personId ? { personId: options.personId } : {}), ...(options.status ? { status: options.status } : {}),
      ...(options.after ? { after: options.after } : {}), limit: PAGE_SIZE }, employerDecisionView);
  }

  async #page<D>(filter: SessionFilter, view: (d: WorkDecision) => D): Promise<HoursPage<D>> {
    const sessions = await this.#store.listSessions({ ...filter, limit: filter.limit + 1 });
    const pageRows = sessions.slice(0, filter.limit);
    const decisionIds = [...new Set(pageRows.map((s) => s.decisionId).filter((id): id is string => id !== null))];
    const decisions = new Map((decisionIds.length ? await this.#store.decisions(decisionIds) : []).map((d) => [d.id, d]));
    const { after: _after, limit: _limit, ...whole } = filter;
    const totals = await this.#store.totals(whole);
    const last = pageRows[pageRows.length - 1];
    return Object.freeze({
      rows: Object.freeze(pageRows.map((session) => {
        const d = session.decisionId ? decisions.get(session.decisionId) : undefined;
        return Object.freeze({ session, decision: d ? view(d) : null });
      })),
      totals,
      next: sessions.length > filter.limit && last ? { workDate: last.workDate, id: last.id } : null,
    });
  }
}
