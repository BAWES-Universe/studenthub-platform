// W-6: a person appeals hours; staff answer and correct them (D-WK3).
//
// Legacy candidate CandidateWorkingHourController appeal/appeal-detail/
// mark-read-appeal-update and staff appeal-list/appeal-detail/appeal-update/
// appeal-update-status/add-hour, with these fixes:
// - a person could appeal any session id: only their own session;
// - mark-read had no owner check: only the appellant marks their updates read;
// - status took any integer: four named states;
// - add-hour wrote an extra approved row beside the original, so both counted:
//   `correct` replaces a session (the original is kept, out of every total) and
//   `addMissing` adds time the person never logged; both are staff-only, need a
//   reason, and are recorded as an approval decision by that staff member
//   (D-WK3: no re-approval by the employer);
// - the staff list put dates raw into SQL: dates are parsed and bound.
// Corrections may come from an appeal or directly (staff correcting approved
// hours). A correction of a correction replaces the live one.

import { cleanText, isUuid, kuwaitDate } from "./common.js";
import type { WorkDecision, WorkScope } from "./decisions.js";
import type { Assignment, WorkEvent } from "./placement.js";
import { parseInstant, sessionConflict, sessionEvent, type NewSession, type WorkSession } from "./sessions.js";
import { parseRange, type HoursRange } from "./views.js";

export const APPEAL_STATUSES = ["submitted", "awaiting_review", "in_progress", "resolved"] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export interface WorkAppeal {
  readonly id: string;
  readonly sessionId: string;
  readonly personId: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly reason: string;
  readonly status: AppealStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppealUpdate {
  readonly id: string;
  readonly appealId: string;
  readonly title: string | null;
  readonly detail: string;
  readonly authorId: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface AppealDetail {
  readonly appeal: WorkAppeal;
  readonly session: WorkSession;
  /** Newest first, like legacy. */
  readonly updates: readonly AppealUpdate[];
  /** Staff entries made for this appeal (corrections and added time). */
  readonly entries: readonly WorkSession[];
}

export interface AppealCursor { readonly createdAt: string; readonly id: string }

export interface AppealTransaction {
  lockSession(id: string): Promise<WorkSession | undefined>;
  /** Whether a live correction replaces the session. */
  isReplaced(sessionId: string): Promise<boolean>;
  /** Organization ancestors read on this transaction's client, nearest first; undefined when unknown. */
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined>;
  /** Whether the session has an appeal that is not resolved yet, other than `exceptAppealId`. */
  hasOpenAppeal(sessionId: string, exceptAppealId?: string): Promise<boolean>;
  assignment(id: string): Promise<Assignment | undefined>;
  /** Raises a SessionConflict("overlap") when the entry overlaps a session in force. */
  insertSession(session: NewSession): Promise<WorkSession>;
  insertDecision(decision: WorkDecision): Promise<void>;
  setStatus(sessionIds: readonly string[], status: "approved", decisionId: string): Promise<void>;
  /** Takes a session out of force, keeping the row with who and why. */
  softDeleteSession(id: string, actorId: string, reason: string): Promise<void>;
  /** Puts a removed session back; raises SessionConflict("overlap") when it would overlap one in force. */
  restoreSession(id: string): Promise<void>;
  insertAppeal(appeal: Omit<WorkAppeal, "createdAt" | "updatedAt">): Promise<WorkAppeal>;
  lockAppeal(id: string): Promise<WorkAppeal | undefined>;
  setAppealStatus(id: string, status: AppealStatus): Promise<WorkAppeal>;
  insertUpdate(update: Omit<AppealUpdate, "createdAt" | "readAt">): Promise<AppealUpdate>;
  /** Marks an update read when it belongs to an appeal of `personId`; false when it doesn't. */
  markRead(updateId: string, personId: string): Promise<boolean>;
  event(event: WorkEvent): Promise<void>;
}

export interface AppealStore {
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined>;
  transaction<T>(work: (tx: AppealTransaction) => Promise<T>): Promise<T>;
  appeal(id: string): Promise<AppealDetail | undefined>;
  /** Newest first. `orgIds` include sub-companies only with `includeSubtree`. */
  listAppeals(filter: { readonly personId?: string; readonly orgIds?: readonly string[]; readonly includeSubtree?: boolean; readonly status?: AppealStatus; readonly range?: HoursRange;
    readonly after?: AppealCursor; readonly limit: number }): Promise<readonly WorkAppeal[]>;
}

export type AppealRefusal = "invalid_input" | "forbidden" | "session_not_found" | "appeal_not_found" | "update_not_found" | "session_open"
  | "session_replaced" | "session_not_rejected" | "appeal_open" | "end_before_start" | "in_future" | "outside_assignment" | "overlaps_session"
  | "already_deleted" | "not_deleted";
export type Refused = { readonly kind: "refused"; readonly code: AppealRefusal };

export interface AppealServiceOptions {
  readonly store: AppealStore;
  readonly scope: WorkScope;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export const APPEAL_PAGE_SIZE = 50;

const text = (value: unknown, max: number): string | null | undefined => value === undefined || value === null || value === "" ? null : cleanText(value, max);

export class AppealService {
  readonly #store: AppealStore;
  readonly #scope: WorkScope;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: AppealServiceOptions) {
    this.#store = options.store;
    this.#scope = options.scope;
    this.#newId = options.newId;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * The person appeals one of their own rejected sessions (legacy shows "Appeal
   * these hours" on rejected sessions only). The session must be ended, in
   * force (not deleted, not replaced by a correction) and rejected, and have no
   * appeal still open; the session row is locked, so two raises cannot race.
   */
  async raise(personId: string, sessionId: unknown, reason: unknown): Promise<{ readonly kind: "raised"; readonly appeal: WorkAppeal } | Refused> {
    const why = text(reason, 2000);
    if (!isUuid(sessionId) || !why) return { kind: "refused", code: "invalid_input" };
    return this.#store.transaction(async (tx) => {
      const s = await tx.lockSession(sessionId.toLowerCase());
      if (!s || s.personId !== personId || s.deletedAt !== null) return { kind: "refused", code: "session_not_found" };
      if (s.endedAt === null) return { kind: "refused", code: "session_open" };
      if (await tx.isReplaced(s.id)) return { kind: "refused", code: "session_replaced" };
      if (s.status !== "rejected") return { kind: "refused", code: "session_not_rejected" };
      if (await tx.hasOpenAppeal(s.id)) return { kind: "refused", code: "appeal_open" };
      const appeal = await tx.insertAppeal({ id: this.#newId(), sessionId: s.id, personId, orgId: s.orgId, storeId: s.storeId, reason: why, status: "submitted" });
      await tx.event(appealEvent("appeal.raised", appeal, personId, { sessionId: s.id }));
      return { kind: "raised", appeal };
    });
  }

  /** The appellant's own appeal; staff see any appeal of a company they cover. */
  async detail(actorId: string, appealId: unknown): Promise<AppealDetail | Refused> {
    if (!isUuid(appealId)) return { kind: "refused", code: "invalid_input" };
    const found = await this.#store.appeal(appealId.toLowerCase());
    if (!found || (found.appeal.personId !== actorId && !(await this.#scope.isStaff(actorId, found.appeal.orgId)))) return { kind: "refused", code: "appeal_not_found" };
    return found;
  }

  async mine(personId: string, after: AppealCursor | null = null): Promise<readonly WorkAppeal[]> {
    return this.#store.listAppeals({ personId, ...(after ? { after } : {}), limit: APPEAL_PAGE_SIZE });
  }

  /** Staff list (legacy appeal-list): every company for operator staff. Dates filter on when the appeal was raised. */
  async list(actorId: string, options: { readonly status?: unknown; readonly from?: unknown; readonly to?: unknown; readonly orgId?: string; readonly after?: AppealCursor | null } = {}):
    Promise<readonly WorkAppeal[] | Refused> {
    const status = options.status === undefined || options.status === "" ? undefined : options.status;
    if (status !== undefined && !APPEAL_STATUSES.includes(status as AppealStatus)) return { kind: "refused", code: "invalid_input" };
    let range: HoursRange | undefined;
    if (options.from !== undefined || options.to !== undefined) {
      range = parseRange(options.from, options.to);
      if (!range) return { kind: "refused", code: "invalid_input" };
    }
    const reach = options.orgId !== undefined ? await this.#scope.staffReach(actorId, options.orgId) : (await this.#scope.isOperatorStaff(actorId)) ? "subtree" : "none";
    if (reach === "none") return { kind: "refused", code: "forbidden" };
    return this.#store.listAppeals({
      ...(options.orgId !== undefined ? { orgIds: [options.orgId], includeSubtree: reach === "subtree" } : {}), ...(status ? { status: status as AppealStatus } : {}),
      ...(range ? { range } : {}), ...(options.after ? { after: options.after } : {}), limit: APPEAL_PAGE_SIZE,
    });
  }

  /** Staff post an update to the appellant (legacy appeal-update). */
  async postUpdate(actorId: string, appealId: unknown, input: { readonly title?: unknown; readonly detail: unknown }): Promise<{ readonly kind: "posted"; readonly update: AppealUpdate } | Refused> {
    const title = text(input.title, 255), detail = text(input.detail, 5000);
    if (!isUuid(appealId) || title === undefined || !detail) return { kind: "refused", code: "invalid_input" };
    return this.#withAppeal(actorId, appealId, async (tx, appeal) => {
      const update = await tx.insertUpdate({ id: this.#newId(), appealId: appeal.id, title, detail, authorId: actorId });
      await tx.event(appealEvent("appeal.updated", appeal, actorId, { updateId: update.id }));
      return { kind: "posted", update };
    });
  }

  async setStatus(actorId: string, appealId: unknown, status: unknown): Promise<{ readonly kind: "updated"; readonly appeal: WorkAppeal } | Refused> {
    if (!isUuid(appealId) || !APPEAL_STATUSES.includes(status as AppealStatus)) return { kind: "refused", code: "invalid_input" };
    return this.#withAppeal(actorId, appealId, async (tx, appeal) => {
      // Reopening a resolved appeal must not leave two open appeals on the same hours.
      if (appeal.status === "resolved" && status !== "resolved") {
        await tx.lockSession(appeal.sessionId);
        if (await tx.hasOpenAppeal(appeal.sessionId, appeal.id)) return { kind: "refused", code: "appeal_open" };
      }
      const updated = await tx.setAppealStatus(appeal.id, status as AppealStatus);
      await tx.event(appealEvent("appeal.status_changed", updated, actorId, { from: appeal.status, to: updated.status }));
      return { kind: "updated", appeal: updated };
    });
  }

  /** The appellant marks a staff update read. */
  async markRead(personId: string, updateId: unknown): Promise<{ readonly kind: "read" } | Refused> {
    if (!isUuid(updateId)) return { kind: "refused", code: "invalid_input" };
    return this.#store.transaction(async (tx) => (await tx.markRead(updateId.toLowerCase(), personId)) ? { kind: "read" } : { kind: "refused", code: "update_not_found" });
  }

  /**
   * Staff replace a closed session with corrected times (D-WK3). The correction
   * is approved by the staff member's own decision; the original stays on
   * record and leaves every total. Correcting a replaced session is refused:
   * correct the live correction instead.
   */
  async correct(actorId: string, sessionId: unknown, input: CorrectionInput): Promise<CorrectionOutcome> {
    const parsed = this.#parseEntry(input);
    if (!isUuid(sessionId) || "code" in parsed) return { kind: "refused", code: "code" in parsed ? parsed.code : "invalid_input" };
    const appealId = input.appealId === undefined || input.appealId === null ? null : isUuid(input.appealId) ? input.appealId.toLowerCase() : undefined;
    if (appealId === undefined) return { kind: "refused", code: "invalid_input" };
    return this.#staffTransaction(actorId, async (tx, scope): Promise<CorrectionOutcome> => {
      // Appeal before session, the same order as addMissing, so the two can't deadlock.
      const appeal = appealId !== null ? await tx.lockAppeal(appealId) : undefined;
      const original = await tx.lockSession(sessionId.toLowerCase());
      if (!original || original.deletedAt !== null || !(await scope.isStaff(actorId, original.orgId))) return { kind: "refused", code: "session_not_found" };
      if (original.endedAt === null) return { kind: "refused", code: "session_open" };
      if (await tx.isReplaced(original.id)) return { kind: "refused", code: "session_replaced" };
      // The appeal must be about this person at this company, or one company could attach its correction to another's appeal.
      if (appealId !== null && (!appeal || appeal.personId !== original.personId || appeal.orgId !== original.orgId)) return { kind: "refused", code: "appeal_not_found" };
      return this.#enter(tx, actorId, original, parsed, original.id, appealId);
    });
  }

  /** Staff add time the person never logged, answering their appeal (legacy add-hour). */
  async addMissing(actorId: string, appealId: unknown, input: Omit<CorrectionInput, "appealId">): Promise<CorrectionOutcome> {
    const parsed = this.#parseEntry(input);
    if (!isUuid(appealId) || "code" in parsed) return { kind: "refused", code: "code" in parsed ? parsed.code : "invalid_input" };
    return this.#withAppeal(actorId, appealId, async (tx, appeal) => {
      const appealed = await tx.lockSession(appeal.sessionId);
      if (!appealed) return { kind: "refused", code: "session_not_found" };
      return this.#enter(tx, actorId, appealed, parsed, null, appeal.id);
    });
  }

  /**
   * Staff take a closed session out of every total (legacy staff delete-session
   * and delete-day, which hard-deleted the rows). The row stays with who removed
   * it and why, and can be restored. A session replaced by a correction is
   * refused (remove the correction, and the original counts again); so is one
   * still in progress (the person discards that themselves).
   */
  async remove(actorId: string, sessionId: unknown, reason: unknown): Promise<RemovalOutcome> {
    const why = text(reason, 255);
    if (!isUuid(sessionId) || !why) return { kind: "refused", code: "invalid_input" };
    return this.#staffTransaction(actorId, async (tx, scope): Promise<RemovalOutcome> => {
      const session = await tx.lockSession(sessionId.toLowerCase());
      if (!session || !(await scope.isStaff(actorId, session.orgId))) return { kind: "refused", code: "session_not_found" };
      if (session.deletedAt !== null) return { kind: "refused", code: "already_deleted" };
      if (session.endedAt === null) return { kind: "refused", code: "session_open" };
      if (await tx.isReplaced(session.id)) return { kind: "refused", code: "session_replaced" };
      await tx.softDeleteSession(session.id, actorId, why);
      await tx.event(sessionEvent("session.deleted", session, actorId, { reason: why }));
      return { kind: "removed", sessionId: session.id };
    });
  }

  /**
   * Staff put a removed session back in force. A session the person discarded
   * while it was in progress can't come back (it never ended), nor a correction
   * whose original has been corrected again since, nor one that would overlap
   * hours now in force.
   */
  async restore(actorId: string, sessionId: unknown): Promise<RemovalOutcome> {
    if (!isUuid(sessionId)) return { kind: "refused", code: "invalid_input" };
    return this.#staffTransaction(actorId, async (tx, scope): Promise<RemovalOutcome> => {
      const session = await tx.lockSession(sessionId.toLowerCase());
      if (!session || !(await scope.isStaff(actorId, session.orgId))) return { kind: "refused", code: "session_not_found" };
      if (session.deletedAt === null) return { kind: "refused", code: "not_deleted" };
      if (session.endedAt === null) return { kind: "refused", code: "session_open" };
      if (session.correctsSessionId !== null && (await tx.isReplaced(session.correctsSessionId))) return { kind: "refused", code: "session_replaced" };
      try {
        await tx.restoreSession(session.id);
      } catch (error) {
        if (sessionConflict(error) === "overlap") return { kind: "refused", code: "overlaps_session" };
        throw error;
      }
      await tx.event(sessionEvent("session.restored", session, actorId));
      return { kind: "restored", sessionId: session.id };
    });
  }

  #parseEntry(input: Omit<CorrectionInput, "appealId">): ParsedEntry | { readonly code: AppealRefusal } {
    const startedAt = parseInstant(input.startedAt), endedAt = parseInstant(input.endedAt);
    const reason = text(input.reason, 255), note = text(input.note, 1000);
    if (!startedAt || !endedAt || !reason || note === undefined) return { code: "invalid_input" };
    if (endedAt.getTime() <= startedAt.getTime()) return { code: "end_before_start" };
    if (endedAt.getTime() > this.#now().getTime()) return { code: "in_future" };
    return { startedAt, endedAt, reason, note };
  }

  async #enter(tx: AppealTransaction, actorId: string, base: WorkSession, entry: ParsedEntry, correctsSessionId: string | null, appealId: string | null): Promise<CorrectionOutcome> {
    const workDate = kuwaitDate(entry.startedAt);
    const assignment = await tx.assignment(base.assignmentId);
    if (!assignment || workDate < assignment.startDate || (assignment.endDate !== null && workDate > assignment.endDate)) return { kind: "refused", code: "outside_assignment" };
    let session: WorkSession;
    try {
      session = await tx.insertSession({
        id: this.#newId(), assignmentId: assignment.id, personId: base.personId, orgId: base.orgId, storeId: base.storeId, workDate,
        startedAt: entry.startedAt, endedAt: entry.endedAt, startLocation: null, endLocation: null,
        source: correctsSessionId ? "correction" : "manual", status: "pending", flags: [], note: entry.note,
        correctsSessionId, createdBy: actorId, appealId,
      });
    } catch (error) {
      const conflict = sessionConflict(error);
      if (conflict === "overlap") return { kind: "refused", code: "overlaps_session" };
      if (conflict === "outside_assignment") return { kind: "refused", code: "outside_assignment" };
      throw error;
    }
    const decision: WorkDecision = Object.freeze({
      id: this.#newId(), orgId: session.orgId, storeId: session.storeId, personId: session.personId, workDate, scope: "session", outcome: "approved",
      sessionIds: Object.freeze([session.id]), reason: entry.reason, note: null, rating: null, notePublic: false, batchId: null,
      decidedBy: actorId, decidedAt: this.#now().toISOString(),
    });
    await tx.insertDecision(decision);
    await tx.setStatus([session.id], "approved", decision.id);
    const approved: WorkSession = Object.freeze({ ...session, status: "approved", decisionId: decision.id });
    await tx.event(sessionEvent(correctsSessionId ? "session.corrected" : "session.added", approved, actorId,
      { decisionId: decision.id, correctsSessionId, appealId, reason: entry.reason }));
    // D-WK3: a staff correction or added entry sends the person no notification; the appeal thread is where they hear back.
    return { kind: "entered", session: approved, decision };
  }

  async #withAppeal<T>(actorId: string, appealId: string, work: (tx: AppealTransaction, appeal: WorkAppeal) => Promise<T | Refused>): Promise<T | Refused> {
    return this.#staffTransaction(actorId, async (tx, scope) => {
      const appeal = await tx.lockAppeal(appealId.toLowerCase());
      if (!appeal || !(await scope.isStaff(actorId, appeal.orgId))) return { kind: "refused", code: "appeal_not_found" } as const;
      return work(tx, appeal);
    });
  }

  /** Staff grants are read before the transaction; ancestry is read on its client, so it never needs a second pool client. */
  async #staffTransaction<T>(actorId: string, work: (tx: AppealTransaction, scope: WorkScope) => Promise<T>): Promise<T> {
    const scopeFor = await this.#scope.forActor(actorId);
    return this.#store.transaction((tx) => work(tx, scopeFor((orgId) => tx.organizationAncestors(orgId))));
  }
}

export type RemovalOutcome = { readonly kind: "removed" | "restored"; readonly sessionId: string } | Refused;

export interface CorrectionInput {
  readonly startedAt: unknown;
  readonly endedAt: unknown;
  /** Why staff corrected the hours (D-WK3: required). */
  readonly reason: unknown;
  readonly note?: unknown;
  readonly appealId?: unknown;
}
interface ParsedEntry { readonly startedAt: Date; readonly endedAt: Date; readonly reason: string; readonly note: string | null }
export type CorrectionOutcome = { readonly kind: "entered"; readonly session: WorkSession; readonly decision: WorkDecision } | Refused;

export function appealEvent(kind: "appeal.raised" | "appeal.updated" | "appeal.status_changed", appeal: WorkAppeal, actorId: string, detail: WorkEvent["detail"]): WorkEvent {
  return { kind, orgId: appeal.orgId, personId: appeal.personId, subjectId: appeal.id, actorId, detail };
}

/** Cursor text is `<ISO time>~uuid`. */
export function parseAppealCursor(value: unknown): AppealCursor | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const [createdAt, id, extra] = value.split("~");
  return extra === undefined && createdAt !== undefined && !Number.isNaN(Date.parse(createdAt)) && /T/.test(createdAt) && isUuid(id)
    ? { createdAt: new Date(createdAt).toISOString(), id: id.toLowerCase() } : undefined;
}
