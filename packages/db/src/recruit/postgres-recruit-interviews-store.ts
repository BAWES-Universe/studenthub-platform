import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";
import { organizationLive } from "../organization-liveness.js";

// Recruit R6: interviews and versioned evaluations. The request's company
// (its readers) and the pipeline's authority (assigned recruiter or lead)
// schedule, cancel and evaluate; operator staff read every request. Each write
// locks the request, then the card, then the interview (the pipeline's order).
// The internal note is read and written only by internal (operator) callers.

type Grant = { org_id: string; role: string; scope: string };
type Decision = (rows: readonly Grant[], orgId: string, ancestors: readonly string[]) => boolean;
type Client = pg.Pool | pg.PoolClient;
type Status = "scheduled" | "completed" | "cancelled";
type Mode = "in_person" | "phone" | "video";
type Outcome = "passed" | "not_passed" | "no_show";
type OutboxKind = "interview.scheduled" | "interview.cancelled";

export interface RecruitInterviewsStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  /** The company side: readers of the request through the company's own grants. */
  readonly companyDecision: Decision;
  /** Operator staff, who read every request's interviews. */
  readonly staffDecision: (rows: readonly Grant[]) => boolean;
  readonly leadDecision: (rows: readonly Grant[]) => boolean;
  /** Recruiter or staff on an operator organization: an assigned recruiter keeps authority only while this holds. */
  readonly recruiterEligible: (rows: readonly Grant[]) => boolean;
  readonly authority: (principalId: string, assignedRecruiterId: string | null, isLead: boolean, isRecruiter: boolean) => boolean;
  /** Who reads and writes internal notes. */
  readonly internalDecision: (rows: readonly Grant[]) => boolean;
  readonly stageAllowed: (stage: string) => boolean;
  readonly transitionAllowed: (from: Status, to: Status) => boolean;
  readonly evaluationAllowed: (status: Status) => boolean;
  readonly outbox: (kind: OutboxKind, interviewId: string, personId: string) => { readonly kind: string; readonly recipient: string; readonly dedupeKey: string };
}

export interface RecruitInterviewInput { readonly cardId: string; readonly scheduledAt: string; readonly durationMinutes: number; readonly mode: Mode; readonly location: string | null }
export interface RecruitEvaluationInput { readonly outcome: Outcome; readonly rating: number | null; readonly sharedNote: string | null; readonly internalNote: string | null; readonly expectedVersion?: number }
export interface RecruitInterviewRecord {
  readonly id: string; readonly card_id: string; readonly person_name: string | null; readonly scheduled_at: string; readonly duration_minutes: number; readonly mode: Mode;
  readonly location: string | null; readonly status: Status; readonly outcome: Outcome | null; readonly rating: number | null;
  readonly shared_note: string | null; readonly internal_note: string | null; readonly scheduled_by_name: string | null; readonly evaluation_version: number | null;
}
export interface RecruitInterviewCardOption { readonly id: string; readonly person_name: string | null; readonly stage: string }
export interface RecruitRequestInterviews {
  readonly request: { readonly id: string; readonly position_title: string; readonly store_name: string; readonly org_name: string };
  readonly interviews: readonly RecruitInterviewRecord[];
  readonly cards: readonly RecruitInterviewCardOption[];
  readonly canWrite: boolean;
  readonly seesInternal: boolean;
}
export interface RecruitPersonInterviewRecord { readonly id: string; readonly org_name: string; readonly store_name: string; readonly position_title: string; readonly scheduled_at: string; readonly duration_minutes: number; readonly mode: Mode; readonly location: string | null; readonly status: Status; readonly outcome: Outcome | null }

export type RecruitScheduleResult = { kind: "scheduled"; interviewId: string } | { kind: "not_found" } | { kind: "stage_refused"; stage: string };
export type RecruitInterviewCloseResult = { kind: "cancelled" } | { kind: "not_found" } | { kind: "refused"; status: Status };
export type RecruitEvaluateResult = { kind: "evaluated"; version: number } | { kind: "not_found" } | { kind: "refused"; status: Status } | { kind: "internal_note_refused" } | { kind: "stale"; version: number };

type Located = { interview_id: string | null; card_id: string; request_id: string };
type Access = { read: boolean; write: boolean; internal: boolean };

const SELECT_INTERVIEWS = `SELECT i.id, i.card_id, COALESCE(pp.display_name, p.display_name, f.name) AS person_name, i.scheduled_at, i.duration_minutes, i.mode, i.location, i.status,
  e.outcome, e.rating, e.shared_note, e.internal_note, COALESCE(sp.display_name, s.display_name) AS scheduled_by_name, e.version AS evaluation_version
 FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id
 LEFT JOIN principals p ON p.id = c.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = c.person_principal_id LEFT JOIN recruit_fulltimers f ON f.id = c.fulltimer_id
 LEFT JOIN principals s ON s.id = i.scheduled_by_principal_id LEFT JOIN person_profiles sp ON sp.principal_id = i.scheduled_by_principal_id
 LEFT JOIN LATERAL (SELECT outcome, rating, shared_note, internal_note, version FROM recruit_interview_evaluations WHERE interview_id = i.id ORDER BY version DESC LIMIT 1) e ON true`;

export class PostgresRecruitInterviewsStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitInterviewsStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #access(c: Client, principalId: string, request: { org_id: string; assigned_recruiter_principal_id: string | null }, lock = false): Promise<Access> {
    const grants = (await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text${lock ? " FOR SHARE" : ""}`, [principalId])).rows;
    const staff = this.options.staffDecision(grants);
    let company = false;
    if (await organizationLive(c, request.org_id, lock)) {
      const ancestors = (await c.query<{ id: string }>(
        "WITH RECURSIVE chain AS (SELECT id, parent_org_id FROM organizations WHERE id = $1::text UNION ALL SELECT o.id, o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id = o.id) SELECT id FROM chain WHERE id <> $1::text",
        [request.org_id])).rows.map((r) => r.id);
      company = this.options.companyDecision(grants, request.org_id, ancestors);
    }
    const pipeline = this.options.authority(principalId, request.assigned_recruiter_principal_id, this.options.leadDecision(grants), this.options.recruiterEligible(grants));
    return { read: staff || company || pipeline, write: company || pipeline, internal: this.options.internalDecision(grants) };
  }

  async #transaction<T>(work: (c: pg.PoolClient) => Promise<T | { rollback: T }>): Promise<T> {
    const c = await this.#pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN");
      // Every write here takes the organization tree lock (shared) first, before any row lock: a reparent or an Access
      // grant change (which hold it exclusively, then lock rows) waits for the write, and the lock order is the same
      // everywhere, so a write that authorises through ancestry never waits on the tree while holding a request row.
      await c.query("SELECT pg_advisory_xact_lock_shared(hashtext('studenthub:organizations:tree'))");
      const result = await work(c);
      if (typeof result === "object" && result !== null && "rollback" in result) {
        await c.query("ROLLBACK");
        return (result as { rollback: T }).rollback;
      }
      await c.query("COMMIT");
      return result as T;
    } catch (error) {
      try { await c.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      c.release(broken);
    }
  }

  /** Locks request, card and (when given) interview in the pipeline's order and answers the caller's access. */
  async #lock(c: pg.PoolClient, principalId: string, located: Located) {
    const request = (await c.query<{ id: string; org_id: string; assigned_recruiter_principal_id: string | null }>(
      "SELECT id, org_id, assigned_recruiter_principal_id FROM recruit_requests WHERE id = $1::uuid FOR UPDATE", [located.request_id])).rows[0]!;
    const card = (await c.query<{ stage: string; person_principal_id: string | null; request_id: string }>(
      "SELECT stage, person_principal_id, request_id FROM recruit_pipeline_cards WHERE id = $1::uuid FOR UPDATE", [located.card_id])).rows[0]!;
    const interview = located.interview_id ? (await c.query<{ status: Status; card_id: string }>("SELECT status, card_id FROM recruit_interviews WHERE id = $1::uuid FOR UPDATE", [located.interview_id])).rows[0] : undefined;
    const access = await this.#access(c, principalId, request, true);
    return { request, card, interview, access };
  }

  async #outbox(c: pg.PoolClient, kind: OutboxKind, interviewId: string, personId: string | null, requestId: string) {
    if (personId === null) return; // a full-timer has no account; staff reach them by phone
    const row = this.options.outbox(kind, interviewId, personId);
    await c.query("INSERT INTO recruit_outbox(kind, recipient_principal_id, request_id, subject_id, dedupe_key) VALUES($1::text, $2::text, $3::uuid, $4::uuid, $5::text) ON CONFLICT (dedupe_key) DO NOTHING",
      [row.kind, row.recipient, requestId, interviewId, row.dedupeKey]);
  }

  async #locateInterview(c: Client, interviewId: string): Promise<Located | undefined> {
    return (await c.query<Located>("SELECT i.id AS interview_id, i.card_id, c.request_id FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id WHERE i.id = $1::uuid", [interviewId])).rows[0];
  }

  async schedule(principalId: string, requestId: string, input: RecruitInterviewInput): Promise<RecruitScheduleResult> {
    return this.#transaction<RecruitScheduleResult>(async (c) => {
      const located = (await c.query<{ request_id: string }>("SELECT request_id FROM recruit_pipeline_cards WHERE id = $1::uuid", [input.cardId])).rows[0];
      if (!located || located.request_id !== requestId) return { rollback: { kind: "not_found" } };
      const { card, access } = await this.#lock(c, principalId, { interview_id: null, card_id: input.cardId, request_id: requestId });
      if (!access.write) return { rollback: { kind: "not_found" } };
      if (!this.options.stageAllowed(card.stage)) return { rollback: { kind: "stage_refused", stage: card.stage } };
      const id = randomUUID();
      await c.query("INSERT INTO recruit_interviews(id, card_id, scheduled_at, duration_minutes, mode, location, scheduled_by_principal_id) VALUES($1::uuid, $2::uuid, $3::timestamptz, $4::integer, $5::text, $6::text, $7::text)",
        [id, input.cardId, input.scheduledAt, input.durationMinutes, input.mode, input.location, principalId]);
      await this.#outbox(c, "interview.scheduled", id, card.person_principal_id, requestId);
      return { kind: "scheduled", interviewId: id };
    });
  }

  async cancel(principalId: string, interviewId: string): Promise<RecruitInterviewCloseResult> {
    return this.#transaction<RecruitInterviewCloseResult>(async (c) => {
      const located = await this.#locateInterview(c, interviewId);
      if (!located) return { rollback: { kind: "not_found" } };
      const { card, interview, access } = await this.#lock(c, principalId, located);
      if (!access.write || !interview) return { rollback: { kind: "not_found" } };
      if (!this.options.transitionAllowed(interview.status, "cancelled")) return { rollback: { kind: "refused", status: interview.status } };
      await c.query("UPDATE recruit_interviews SET status = 'cancelled', closed_at = clock_timestamp(), closed_by_principal_id = $2::text WHERE id = $1::uuid", [interviewId, principalId]);
      await this.#outbox(c, "interview.cancelled", interviewId, card.person_principal_id, located.request_id);
      return { kind: "cancelled" };
    });
  }

  async evaluate(principalId: string, interviewId: string, input: RecruitEvaluationInput): Promise<RecruitEvaluateResult> {
    return this.#transaction<RecruitEvaluateResult>(async (c) => {
      const located = await this.#locateInterview(c, interviewId);
      if (!located) return { rollback: { kind: "not_found" } };
      const { interview, access } = await this.#lock(c, principalId, located);
      if (!access.write || !interview) return { rollback: { kind: "not_found" } };
      if (input.internalNote !== null && !access.internal) return { rollback: { kind: "internal_note_refused" } };
      if (!this.options.evaluationAllowed(interview.status)) return { rollback: { kind: "refused", status: interview.status } };
      const previous = (await c.query<{ version: number; internal_note: string | null }>(
        "SELECT version, internal_note FROM recruit_interview_evaluations WHERE interview_id = $1::uuid ORDER BY version DESC LIMIT 1", [interviewId])).rows[0];
      // The request row lock serializes evaluations, so the version read here is the one a correction replaces.
      if (input.expectedVersion !== undefined && input.expectedVersion !== (previous?.version ?? 0)) return { rollback: { kind: "stale", version: previous?.version ?? 0 } };
      const version = (previous?.version ?? 0) + 1;
      // A company correction keeps the staff internal note it cannot see.
      const internal = access.internal ? input.internalNote : previous?.internal_note ?? null;
      await c.query("INSERT INTO recruit_interview_evaluations(id, interview_id, version, outcome, rating, shared_note, internal_note, evaluated_by_principal_id) VALUES($1::uuid, $2::uuid, $3::integer, $4::text, $5::smallint, $6::text, $7::text, $8::text)",
        [randomUUID(), interviewId, version, input.outcome, input.rating, input.sharedNote, internal, principalId]);
      if (interview.status === "scheduled") {
        if (!this.options.transitionAllowed("scheduled", "completed")) return { rollback: { kind: "refused", status: interview.status } };
        await c.query("UPDATE recruit_interviews SET status = 'completed', closed_at = clock_timestamp(), closed_by_principal_id = $2::text WHERE id = $1::uuid", [interviewId, principalId]);
      }
      return { kind: "evaluated", version };
    });
  }

  /** A request's interviews for its company, its pipeline authority and operator staff; internal notes only for internal callers. */
  async forRequest(principalId: string, requestId: string): Promise<RecruitRequestInterviews | null> {
    // The assignment, the caller's grants and the interviews come from one snapshot, so access never mixes two moments.
    const c = await this.#pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.#forRequest(c, principalId, requestId);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      try { await c.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      c.release(broken);
    }
  }

  async #forRequest(c: pg.PoolClient, principalId: string, requestId: string): Promise<RecruitRequestInterviews | null> {
    const request = (await c.query<{ id: string; org_id: string; assigned_recruiter_principal_id: string | null; position_title: string; store_name: string; org_name: string }>(
      `SELECT r.id, r.org_id, r.assigned_recruiter_principal_id, r.position_title, s.name AS store_name, o.name AS org_name
       FROM recruit_requests r JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id WHERE r.id = $1::uuid`, [requestId])).rows[0];
    if (!request) return null;
    const access = await this.#access(c, principalId, request);
    if (!access.read) return null;
    // One client answers one query at a time: read in sequence inside the snapshot.
    const interviews = await c.query<RecruitInterviewRecord>(`${SELECT_INTERVIEWS} WHERE c.request_id = $1::uuid ORDER BY i.scheduled_at, i.id`, [requestId]);
    const cards = await c.query<RecruitInterviewCardOption>(
        `SELECT c.id, COALESCE(pp.display_name, p.display_name, f.name) AS person_name, c.stage FROM recruit_pipeline_cards c
         LEFT JOIN principals p ON p.id = c.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = c.person_principal_id LEFT JOIN recruit_fulltimers f ON f.id = c.fulltimer_id
         WHERE c.request_id = $1::uuid ORDER BY person_name NULLS LAST, c.id`, [requestId]);
    return {
      request: { id: request.id, position_title: request.position_title, store_name: request.store_name, org_name: request.org_name },
      interviews: interviews.rows.map((row) => (access.internal ? row : { ...row, internal_note: null })),
      cards: cards.rows.filter((card) => this.options.stageAllowed(card.stage)),
      canWrite: access.write, seesInternal: access.internal,
    };
  }

  /** The person's own interviews: when, where and the outcome; never a rating or a note. */
  async mine(personId: string): Promise<readonly RecruitPersonInterviewRecord[]> {
    return (await this.#pool.query<RecruitPersonInterviewRecord>(
      `SELECT i.id, o.name AS org_name, s.name AS store_name, r.position_title, i.scheduled_at, i.duration_minutes, i.mode, i.location, i.status,
        (SELECT outcome FROM recruit_interview_evaluations WHERE interview_id = i.id ORDER BY version DESC LIMIT 1) AS outcome
       FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id JOIN recruit_requests r ON r.id = c.request_id
       JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id
       WHERE c.person_principal_id = $1::text ORDER BY i.scheduled_at DESC, i.id LIMIT 200`, [personId])).rows;
  }
}
