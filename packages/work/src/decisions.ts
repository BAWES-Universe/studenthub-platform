// W-4: the employer approves or rejects hours.
//
// Legacy company CandidateWorkLogFeedbackController (save, bulk-save, undo) and
// CandidateWorkLogFeedback::afterSave, with these fixes:
// - every decision is scoped to the decider: staff/admin above the company,
//   the company's owners and recruiters (sub-companies through a subtree
//   grant), or a store manager for their own store only (access lane A4);
// - a day decision changes pending closed sessions only; it no longer rewrites
//   earlier decisions. Changing a decided session is a session decision;
// - only closed sessions in force are decided;
// - bulk is all-or-nothing: one unknown or out-of-scope item refuses the batch;
// - undo records its own decision and returns the session to pending. Legacy
//   has no undo window, and D-WK2 keeps legacy, so there is none here;
// - rating is 1 to 5 (legacy had no rule).

import { COMPANY_ROLES, STAFF_ROLES, cleanText, isCompanyFor, isOperatorStaff, isStaffFor, isIsoDate, isPrincipalId, isUuid, orgReach, type IsoDate, type WorkGrant } from "./common.js";
import type { GrantsPort, WorkEvent } from "./placement.js";
import type { SessionStatus, WorkSession } from "./sessions.js";

export type DecisionOutcome = "approved" | "rejected" | "undone";

export interface WorkDecision {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly personId: string;
  readonly workDate: IsoDate;
  readonly scope: "session" | "day";
  readonly outcome: DecisionOutcome;
  readonly sessionIds: readonly string[];
  readonly reason: string | null;
  readonly note: string | null;
  readonly rating: number | null;
  readonly notePublic: boolean;
  readonly batchId: string | null;
  /** Null only for an imported legacy decision whose contact has no principal. */
  readonly decidedBy: string | null;
  readonly decidedAt: string;
}

export interface DecisionInput {
  readonly decision: "approve" | "reject";
  readonly reason?: unknown;
  readonly note?: unknown;
  readonly rating?: unknown;
  readonly notePublic?: unknown;
}

export interface DayKey {
  readonly personId: string;
  readonly storeId: string;
  readonly workDate: IsoDate;
}

/** Store-manager scope from the access lane (A4): the stores a principal manages. */
export interface ManagedStoresPort {
  managedStores(principalId: string): Promise<readonly { readonly orgId: string; readonly storeId: string }[]>;
}
export const NO_MANAGED_STORES: ManagedStoresPort = Object.freeze({ managedStores: async () => [] });

export interface DecisionTransaction {
  /** Locks and returns the sessions, in the order given; missing ids are absent. */
  lockSessions(ids: readonly string[]): Promise<readonly WorkSession[]>;
  /** Locks and returns the closed sessions in force of a day at a store. */
  lockDay(day: DayKey): Promise<readonly WorkSession[]>;
  /** Whether a live correction replaces the session (a replaced session is not decided). */
  isReplaced(sessionId: string): Promise<boolean>;
  insertDecision(decision: WorkDecision): Promise<void>;
  setStatus(sessionIds: readonly string[], status: SessionStatus, decisionId: string): Promise<void>;
  event(event: WorkEvent): Promise<void>;
  /** Tells the person (comms lane) inside the same transaction; a failure rolls the decision back. */
  notify(notice: DecisionNotice): Promise<void>;
}

/** One per changed session. `undone` names the decision being withdrawn. */
export type DecisionNotice =
  | { readonly kind: "decided"; readonly personId: string; readonly sessionId: string; readonly decisionId: string; readonly outcome: "approved" | "rejected"; readonly workDate: IsoDate }
  | { readonly kind: "undone"; readonly personId: string; readonly sessionId: string; readonly withdrawnDecisionId: string };

export interface DecisionStore {
  /** Organization ancestors, nearest first; undefined when unknown. */
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined>;
  transaction<T>(work: (tx: DecisionTransaction) => Promise<T>): Promise<T>;
}

export type DecisionRefusal = "invalid_input" | "forbidden" | "session_not_found" | "session_open" | "session_replaced" | "day_not_found" | "not_decided" | "too_many";
export type DecideHoursOutcome =
  | { readonly kind: "decided"; readonly decisions: readonly WorkDecision[]; readonly changed: number }
  | { readonly kind: "refused"; readonly code: DecisionRefusal; readonly index?: number };

export const MAX_BATCH = 200;

interface ParsedDecision {
  readonly status: "approved" | "rejected";
  readonly reason: string | null;
  readonly note: string | null;
  readonly rating: number | null;
  readonly notePublic: boolean;
}

export function parseDecision(input: DecisionInput): ParsedDecision | undefined {
  if (input.decision !== "approve" && input.decision !== "reject") return undefined;
  const reason = input.reason === undefined || input.reason === null || input.reason === "" ? null : cleanText(input.reason, 255);
  const note = input.note === undefined || input.note === null || input.note === "" ? null : cleanText(input.note, 2000);
  if (reason === undefined || note === undefined) return undefined;
  let rating: number | null = null;
  if (input.rating !== undefined && input.rating !== null && input.rating !== "") {
    const value = typeof input.rating === "string" ? Number(input.rating) : input.rating;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) return undefined;
    rating = value;
  }
  const notePublic = input.notePublic === true || input.notePublic === "true" || input.notePublic === "on";
  if (input.notePublic !== undefined && input.notePublic !== null && typeof input.notePublic !== "boolean" && !["true", "false", "on", ""].includes(String(input.notePublic))) return undefined;
  return { status: input.decision === "approve" ? "approved" : "rejected", reason, note, rating, notePublic };
}

export function parseDayKey(value: unknown): DayKey | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => !["personId", "storeId", "workDate"].includes(k))) return undefined;
  if (!isPrincipalId(r.personId) || !isUuid(r.storeId) || !isIsoDate(r.workDate)) return undefined;
  return { personId: r.personId, storeId: r.storeId.toLowerCase(), workDate: r.workDate };
}

/** Who may decide (and read) a store's hours. */
export class WorkScope {
  readonly #grants: GrantsPort;
  readonly #managed: ManagedStoresPort;
  readonly #ancestors: (orgId: string) => Promise<readonly string[] | undefined>;
  /** Present only for a scope made for one operation; a long-lived scope reads grants on every call so a revoked grant stops at once. */
  readonly #cache: Map<string, { grants: readonly WorkGrant[]; managed: ReadonlySet<string> }> | undefined;

  constructor(grants: GrantsPort, managed: ManagedStoresPort, ancestors: (orgId: string) => Promise<readonly string[] | undefined>, options: { readonly perOperation?: boolean } = {}) {
    this.#grants = grants;
    this.#managed = managed;
    this.#ancestors = ancestors;
    this.#cache = options.perOperation === true ? new Map() : undefined;
  }

  async #actor(actorId: string) {
    let entry = this.#cache?.get(actorId);
    if (!entry) {
      const [grants, managed] = await Promise.all([this.#grants.listGrantsForPrincipal(actorId), this.#managed.managedStores(actorId)]);
      entry = { grants, managed: new Set(managed.map((m) => m.storeId)) };
      this.#cache?.set(actorId, entry);
    }
    return entry;
  }

  /** Staff, the company (subtree aware), or the store's own manager. Never a sibling store. */
  async covers(actorId: string, orgId: string, storeId: string): Promise<boolean> {
    const actor = await this.#actor(actorId);
    if (actor.managed.has(storeId)) return true;
    const ancestors = await this.#ancestors(orgId);
    if (ancestors === undefined) return false;
    return isStaffFor(actor.grants, orgId, ancestors) || isCompanyFor(actor.grants, orgId, ancestors);
  }

  /** Staff or the company itself (owners, recruiters, subtree aware); store managers are not company-wide. */
  async coversCompany(actorId: string, orgId: string): Promise<boolean> {
    const ancestors = await this.#ancestors(orgId);
    if (ancestors === undefined) return false;
    const { grants } = await this.#actor(actorId);
    return isStaffFor(grants, orgId, ancestors) || isCompanyFor(grants, orgId, ancestors);
  }

  /** Staff or admin of the operator organization: every company's hours. */
  async isOperatorStaff(actorId: string): Promise<boolean> {
    return isOperatorStaff((await this.#actor(actorId)).grants);
  }

  /** How far staff or company grants reach from `orgId` (self-scoped grants never include sub-companies). */
  async companyReach(actorId: string, orgId: string): Promise<"none" | "self" | "subtree"> {
    const ancestors = await this.#ancestors(orgId);
    if (ancestors === undefined) return "none";
    return orgReach((await this.#actor(actorId)).grants, [...STAFF_ROLES, ...COMPANY_ROLES], orgId, ancestors);
  }
  async staffReach(actorId: string, orgId: string): Promise<"none" | "self" | "subtree"> {
    const ancestors = await this.#ancestors(orgId);
    if (ancestors === undefined) return "none";
    return orgReach((await this.#actor(actorId)).grants, STAFF_ROLES, orgId, ancestors);
  }

  async isStaff(actorId: string, orgId: string): Promise<boolean> {
    const ancestors = await this.#ancestors(orgId);
    return ancestors !== undefined && isStaffFor((await this.#actor(actorId)).grants, orgId, ancestors);
  }
}

export interface DecisionServiceOptions {
  readonly store: DecisionStore;
  readonly grants: GrantsPort;
  readonly managedStores?: ManagedStoresPort;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export class DecisionService {
  readonly #store: DecisionStore;
  readonly #grants: GrantsPort;
  readonly #managed: ManagedStoresPort;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: DecisionServiceOptions) {
    this.#store = options.store;
    this.#grants = options.grants;
    this.#managed = options.managedStores ?? NO_MANAGED_STORES;
    this.#newId = options.newId;
    this.#now = options.now ?? (() => new Date());
  }

  #scope(): WorkScope {
    return new WorkScope(this.#grants, this.#managed, (orgId) => this.#store.organizationAncestors(orgId), { perOperation: true });
  }

  /**
   * Decides individual sessions, singly or in bulk (all or nothing). Each
   * session gets its own decision row. A decided session may be decided again;
   * that is recorded like any other decision.
   */
  async decideSessions(actorId: string, sessionIds: readonly unknown[], input: DecisionInput): Promise<DecideHoursOutcome> {
    const parsed = parseDecision(input);
    if (!parsed || sessionIds.length === 0 || !sessionIds.every(isUuid)) return { kind: "refused", code: "invalid_input" };
    if (sessionIds.length > MAX_BATCH) return { kind: "refused", code: "too_many" };
    const ids = [...new Set((sessionIds as string[]).map((id) => id.toLowerCase()))];
    const scope = this.#scope();
    const batchId = ids.length > 1 ? this.#newId() : null;
    return this.#store.transaction(async (tx): Promise<DecideHoursOutcome> => {
      const sessions = await tx.lockSessions(ids);
      const decisions: WorkDecision[] = [];
      for (const [index, id] of ids.entries()) {
        const s = sessions.find((x) => x.id === id);
        if (!s || s.deletedAt !== null || !(await scope.covers(actorId, s.orgId, s.storeId))) return { kind: "refused", code: "session_not_found", index };
        if (s.endedAt === null) return { kind: "refused", code: "session_open", index };
        if (await tx.isReplaced(s.id)) return { kind: "refused", code: "session_replaced", index };
        decisions.push(this.#decision(actorId, s, "session", parsed.status, [s.id], parsed, batchId));
      }
      for (const [i, d] of decisions.entries()) {
        await tx.insertDecision(d);
        await tx.setStatus(d.sessionIds, parsed.status, d.id);
        const s = sessions.find((x) => x.id === ids[i])!;
        await tx.event(decisionEvent(d, s));
        if (s.status !== "pending" && s.decisionId !== null) await tx.notify(undoneNotice(s, s.decisionId));
        await tx.notify(decidedNotice(d, s, parsed.status));
      }
      return { kind: "decided", decisions, changed: decisions.length };
    });
  }

  /**
   * Decides whole days (legacy bulk-save by day): one decision row per day,
   * changing that day's pending closed sessions only. A day with no closed
   * session in force refuses the batch (legacy threw NotFound and rolled back).
   */
  async decideDays(actorId: string, days: readonly unknown[], input: DecisionInput): Promise<DecideHoursOutcome> {
    const parsed = parseDecision(input);
    const parsedKeys = days.map(parseDayKey);
    if (!parsed || parsedKeys.length === 0 || parsedKeys.some((k) => k === undefined)) return { kind: "refused", code: "invalid_input" };
    // The same day twice would read the same pending sessions twice and decide them twice.
    const keys = [...new Map((parsedKeys as DayKey[]).map((k) => [`${k.personId}|${k.storeId}|${k.workDate}`, k])).values()];
    if (keys.length > MAX_BATCH) return { kind: "refused", code: "too_many" };
    const scope = this.#scope();
    const batchId = keys.length > 1 ? this.#newId() : null;
    return this.#store.transaction(async (tx): Promise<DecideHoursOutcome> => {
      const planned: { decision: WorkDecision; sessions: readonly WorkSession[] }[] = [];
      for (const [index, key] of (keys as DayKey[]).entries()) {
        const sessions = await tx.lockDay(key);
        const first = sessions[0];
        if (!first || !(await scope.covers(actorId, first.orgId, first.storeId))) return { kind: "refused", code: "day_not_found", index };
        const pending = sessions.filter((s) => s.status === "pending");
        planned.push({ decision: this.#decision(actorId, first, "day", parsed.status, pending.map((s) => s.id), parsed, batchId), sessions: pending });
      }
      let changed = 0;
      for (const { decision, sessions } of planned) {
        await tx.insertDecision(decision);
        if (sessions.length) await tx.setStatus(decision.sessionIds, parsed.status, decision.id);
        for (const s of sessions) {
          await tx.event(decisionEvent(decision, s));
          await tx.notify(decidedNotice(decision, s, parsed.status));
        }
        changed += sessions.length;
      }
      return { kind: "decided", decisions: planned.map((p) => p.decision), changed };
    });
  }

  /** Returns a decided session to pending, with its own decision row (legacy undo, now recorded). */
  async undo(actorId: string, sessionId: unknown, reason?: unknown): Promise<DecideHoursOutcome> {
    const why = reason === undefined || reason === null || reason === "" ? null : cleanText(reason, 255);
    if (!isUuid(sessionId) || why === undefined) return { kind: "refused", code: "invalid_input" };
    const scope = this.#scope();
    return this.#store.transaction(async (tx): Promise<DecideHoursOutcome> => {
      const [s] = await tx.lockSessions([sessionId.toLowerCase()]);
      if (!s || s.deletedAt !== null || !(await scope.covers(actorId, s.orgId, s.storeId))) return { kind: "refused", code: "session_not_found" };
      if (s.status === "pending") return { kind: "refused", code: "not_decided" };
      if (await tx.isReplaced(s.id)) return { kind: "refused", code: "session_replaced" };
      const decision = this.#decision(actorId, s, "session", "undone", [s.id], { reason: why, note: null, rating: null, notePublic: false }, null);
      await tx.insertDecision(decision);
      await tx.setStatus([s.id], "pending", decision.id);
      await tx.event(decisionEvent(decision, s));
      if (s.decisionId !== null) await tx.notify(undoneNotice(s, s.decisionId));
      return { kind: "decided", decisions: [decision], changed: 1 };
    });
  }

  #decision(actorId: string, s: WorkSession, scope: "session" | "day", outcome: DecisionOutcome, sessionIds: readonly string[],
    p: Pick<ParsedDecision, "reason" | "note" | "rating" | "notePublic">, batchId: string | null): WorkDecision {
    return Object.freeze({
      id: this.#newId(), orgId: s.orgId, storeId: s.storeId, personId: s.personId, workDate: s.workDate, scope, outcome,
      sessionIds: Object.freeze([...sessionIds]), reason: p.reason, note: p.note, rating: p.rating, notePublic: p.notePublic,
      batchId, decidedBy: actorId, decidedAt: this.#now().toISOString(),
    });
  }
}

function decisionEvent(d: WorkDecision, s: WorkSession): WorkEvent {
  const kind = d.outcome === "approved" ? "session.approved" : d.outcome === "rejected" ? "session.rejected" : "session.undone";
  return { kind, orgId: s.orgId, personId: s.personId, subjectId: s.id, actorId: d.decidedBy, detail: { decisionId: d.id, workDate: s.workDate, scope: d.scope } };
}

function decidedNotice(d: WorkDecision, s: WorkSession, outcome: "approved" | "rejected"): DecisionNotice {
  return { kind: "decided", personId: s.personId, sessionId: s.id, decisionId: d.id, outcome, workDate: s.workDate };
}
function undoneNotice(s: WorkSession, withdrawnDecisionId: string): DecisionNotice {
  return { kind: "undone", personId: s.personId, sessionId: s.id, withdrawnDecisionId };
}
