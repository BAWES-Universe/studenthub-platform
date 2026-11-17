// W-3: a person clocks in and out, and may log hours after the fact.
//
// Legacy candidate AccountController start/stop/discard and
// CandidateWorkingHourController add-hour, with the settled D-WK1 rule
// (decisions 2026-10-27): location is required on Start and Stop, both pairs
// are kept, there is no geofence, and a late manual entry is accepted and
// flagged to the approver. Server time is the only clock.

import { cleanText, constraintName, isUuid, sqlState, kuwaitDate, type IsoDate } from "./common.js";
import type { Assignment, WorkEvent } from "./placement.js";

export type SessionSource = "timer" | "manual" | "correction" | "import";
export type SessionStatus = "pending" | "approved" | "rejected";
export type SessionFlag = "late_entry" | "location_missing";

export interface Location {
  readonly latitude: number;
  readonly longitude: number;
}

export interface WorkSession {
  readonly id: string;
  readonly assignmentId: string;
  readonly personId: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly workDate: IsoDate;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Whole seconds, server-computed; null while open. */
  readonly durationSeconds: number | null;
  readonly startLocation: Location | null;
  readonly endLocation: Location | null;
  readonly source: SessionSource;
  readonly status: SessionStatus;
  readonly flags: readonly SessionFlag[];
  readonly note: string | null;
  readonly correctsSessionId: string | null;
  readonly deletedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewSession {
  readonly id: string;
  readonly assignmentId: string;
  readonly personId: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly workDate: IsoDate;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly startLocation: Location | null;
  readonly endLocation: Location | null;
  readonly source: Exclude<SessionSource, "import">;
  readonly status: SessionStatus;
  readonly flags: readonly SessionFlag[];
  readonly note: string | null;
  readonly correctsSessionId: string | null;
  readonly createdBy: string;
}

export class SessionConflict extends Error {
  constructor(readonly reason: "already_open" | "overlap") { super(`work session ${reason}`); }
}

/** Maps a store error to a session conflict: the in-memory class, or the Postgres unique index / 0501 overlap trigger. */
export function sessionConflict(error: unknown): "already_open" | "overlap" | undefined {
  if (error instanceof SessionConflict) return error.reason;
  if (sqlState(error) === "23505" && constraintName(error) === "work_sessions_one_open") return "already_open";
  if (sqlState(error) === "23P01") return "overlap";
  return undefined;
}

export interface SessionTransaction {
  /** Raises SessionConflict("already_open") or SessionConflict("overlap"). */
  insert(session: NewSession): Promise<WorkSession>;
  /** Locks and returns the person's open session, if any. */
  lockOpen(personId: string): Promise<WorkSession | undefined>;
  lock(id: string): Promise<WorkSession | undefined>;
  close(id: string, endedAt: Date, endLocation: Location): Promise<WorkSession>;
  softDelete(id: string, actorId: string, reason: string): Promise<void>;
  /** Raises SessionConflict("overlap") when the restored session would overlap one in force. */
  restore(id: string): Promise<void>;
  event(event: WorkEvent): Promise<void>;
}

export interface SessionStore {
  /** The person's assignment in force on `date` at an active store, if any. */
  assignmentOn(personId: string, date: IsoDate): Promise<Assignment | undefined>;
  assignment(id: string): Promise<Assignment | undefined>;
  open(personId: string): Promise<WorkSession | undefined>;
  transaction<T>(work: (tx: SessionTransaction) => Promise<T>): Promise<T>;
}

export type SessionRefusal =
  | "invalid_input" | "location_required" | "not_assigned" | "already_working" | "not_working"
  | "overlaps_session" | "end_before_start" | "in_future" | "outside_assignment" | "session_not_found" | "not_deleted" | "already_deleted";

export type SessionOutcome = { readonly kind: "started" | "stopped" | "added"; readonly session: WorkSession } | { readonly kind: "discarded" } | { readonly kind: "refused"; readonly code: SessionRefusal };

/** A coordinate pair from a form or JSON body; strings are accepted because forms send text. */
export function parseLocation(latitude: unknown, longitude: unknown): Location | undefined {
  const lat = typeof latitude === "string" && latitude.trim() !== "" ? Number(latitude) : latitude;
  const long = typeof longitude === "string" && longitude.trim() !== "" ? Number(longitude) : longitude;
  if (typeof lat !== "number" || typeof long !== "number" || !Number.isFinite(lat) || !Number.isFinite(long)) return undefined;
  if (lat < -90 || lat > 90 || long < -180 || long > 180) return undefined;
  // numeric(9,6) keeps six places; round here so what is returned equals what is stored.
  return { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(long * 1e6) / 1e6 };
}

/** Instants for manual entry: ISO 8601 with an explicit offset or Z, so the time zone is never guessed. */
export function parseInstant(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export interface SessionServiceOptions {
  readonly store: SessionStore;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export class SessionService {
  readonly #store: SessionStore;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: SessionServiceOptions) {
    this.#store = options.store;
    this.#newId = options.newId;
    this.#now = options.now ?? (() => new Date());
  }

  /** "Today": the open session, if any, and where the person works today. */
  async today(personId: string): Promise<{ readonly open: WorkSession | null; readonly assignment: Assignment | null }> {
    const [open, assignment] = await Promise.all([this.#store.open(personId), this.#store.assignmentOn(personId, kuwaitDate(this.#now()))]);
    return { open: open ?? null, assignment: assignment ?? null };
  }

  async start(personId: string, location: Location | undefined): Promise<SessionOutcome> {
    if (!location) return { kind: "refused", code: "location_required" };
    const now = this.#now();
    const workDate = kuwaitDate(now);
    const assignment = await this.#store.assignmentOn(personId, workDate);
    if (!assignment) return { kind: "refused", code: "not_assigned" };
    return this.#store.transaction(async (tx): Promise<SessionOutcome> => {
      if (await tx.lockOpen(personId)) return { kind: "refused", code: "already_working" };
      let session: WorkSession;
      try {
        session = await tx.insert({
          id: this.#newId(), assignmentId: assignment.id, personId, orgId: assignment.orgId, storeId: assignment.storeId, workDate,
          startedAt: now, endedAt: null, startLocation: location, endLocation: null, source: "timer", status: "pending", flags: [],
          note: null, correctsSessionId: null, createdBy: personId,
        });
      } catch (error) {
        const conflict = sessionConflict(error);
        if (conflict) return { kind: "refused", code: conflict === "already_open" ? "already_working" : "overlaps_session" };
        throw error;
      }
      await tx.event(sessionEvent("session.started", session, personId));
      return { kind: "started", session };
    });
  }

  /** Stop keeps the start location and records the stop location separately (fixes WK-F2). */
  async stop(personId: string, location: Location | undefined): Promise<SessionOutcome> {
    if (!location) return { kind: "refused", code: "location_required" };
    return this.#store.transaction(async (tx): Promise<SessionOutcome> => {
      const open = await tx.lockOpen(personId);
      if (!open) return { kind: "refused", code: "not_working" };
      const now = this.#now();
      const endedAt = now.getTime() < Date.parse(open.startedAt) ? new Date(open.startedAt) : now;
      const session = await tx.close(open.id, endedAt, location);
      await tx.event(sessionEvent("session.stopped", session, personId));
      return { kind: "stopped", session };
    });
  }

  /** Throws away the open session (legacy hard-deleted it; here it is soft-deleted). */
  async discard(personId: string): Promise<SessionOutcome> {
    return this.#store.transaction(async (tx): Promise<SessionOutcome> => {
      const open = await tx.lockOpen(personId);
      if (!open) return { kind: "refused", code: "not_working" };
      await tx.softDelete(open.id, personId, "discarded by the person");
      await tx.event(sessionEvent("session.discarded", open, personId));
      return { kind: "discarded" };
    });
  }

  /**
   * Logs hours after the fact (legacy "Manual Log"). Both ends are required,
   * the end must be after the start and not in the future, the day must fall
   * in the person's placement, and the session must not overlap another one.
   * It is pending and flagged as a late entry for the approver (D-WK1).
   */
  async addManual(personId: string, input: { readonly startedAt: unknown; readonly endedAt: unknown; readonly note?: unknown }): Promise<SessionOutcome> {
    const startedAt = parseInstant(input.startedAt), endedAt = parseInstant(input.endedAt);
    const note = input.note === undefined || input.note === "" ? null : cleanText(input.note, 1000);
    if (!startedAt || !endedAt || note === undefined) return { kind: "refused", code: "invalid_input" };
    if (endedAt.getTime() <= startedAt.getTime()) return { kind: "refused", code: "end_before_start" };
    if (endedAt.getTime() > this.#now().getTime()) return { kind: "refused", code: "in_future" };
    const workDate = kuwaitDate(startedAt);
    const assignment = await this.#store.assignmentOn(personId, workDate);
    if (!assignment) return { kind: "refused", code: "outside_assignment" };
    return this.#store.transaction(async (tx): Promise<SessionOutcome> => {
      let session: WorkSession;
      try {
        session = await tx.insert({
          id: this.#newId(), assignmentId: assignment.id, personId, orgId: assignment.orgId, storeId: assignment.storeId, workDate,
          startedAt, endedAt, startLocation: null, endLocation: null, source: "manual", status: "pending", flags: ["late_entry"],
          note, correctsSessionId: null, createdBy: personId,
        });
      } catch (error) {
        if (sessionConflict(error)) return { kind: "refused", code: "overlaps_session" };
        throw error;
      }
      await tx.event(sessionEvent("session.added", session, personId));
      return { kind: "added", session };
    });
  }
}

export function sessionEvent(kind: WorkEvent["kind"], session: WorkSession, actorId: string | null, extra: WorkEvent["detail"] = {}): WorkEvent {
  return { kind, orgId: session.orgId, personId: session.personId, subjectId: session.id, actorId, detail: { assignmentId: session.assignmentId, workDate: session.workDate, ...extra } };
}

export function isSessionId(value: unknown): value is string {
  return isUuid(value);
}
