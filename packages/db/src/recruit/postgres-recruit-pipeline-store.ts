import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";
import { principalAuditRef } from "../authorization-audit.js";

// Recruit R2: assignment, pipeline cards and placement hand-off. Every add or
// move locks the card and its request, writes its event in the same
// transaction, and derives the request status through the injected rule. The
// placement port (the work lane) is called inside the transaction before the
// move commits; it is idempotent on the card id, so a retry is safe.

type Grant = { org_id: string; role: string; scope: string };
type Stage = "suggested" | "contacted" | "interviewing" | "offered" | "placed" | "withdrawn";
type RequestStatus = "draft" | "open" | "filling" | "filled" | "closed";
type PipelineEvent = { kind: "card_added" } | { kind: "placed"; placedCount: number; headcount: number };

export const RECRUIT_SYSTEM_ACTOR_REF = "0".repeat(64);

export interface RecruitPlacementRequest {
  readonly recruitCardId: string;
  readonly requestId: string;
  readonly personId: string;
  readonly storeId: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
}
export type RecruitPlacementResult = { kind: "placed"; assignmentId: string; created: boolean } | { kind: "refused"; code: string };
export interface RecruitPlacementPort {
  placeFromRecruit(actorId: string, request: RecruitPlacementRequest): Promise<RecruitPlacementResult>;
  /** False while no work-lane placement is wired: "placed" is then not offered for person cards (full-timers need no port). */
  readonly available?: boolean;
}

export interface RecruitPipelineStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly assignDecision: (rows: readonly Grant[]) => boolean;
  readonly leadDecision: (rows: readonly Grant[]) => boolean;
  readonly recruiterEligible: (rows: readonly Grant[]) => boolean;
  /** Who can be suggested to a request: a principal holding a candidate grant (candidate:self). */
  readonly candidateDecision: (rows: readonly Grant[]) => boolean;
  readonly authority: (principalId: string, assignedRecruiterId: string | null, isLead: boolean, isRecruiter: boolean) => boolean;
  readonly transitionAllowed: (from: Stage, to: Stage) => boolean;
  readonly acceptsCards: (status: RequestStatus) => boolean;
  readonly requestStatusAfter: (status: RequestStatus, event: PipelineEvent) => RequestStatus | null;
  readonly placement: RecruitPlacementPort;
  /** Operator organizations, whose recruiter and staff grantees may be assigned (grants are read by the indexed org_id). */
  readonly operatorOrgIds: readonly string[];
}

export type RecruitAssignResult = { kind: "assigned" } | { kind: "not_found" } | { kind: "recruiter_ineligible" } | { kind: "request_closed" };
export type RecruitAddCardResult = { kind: "added"; cardId: string } | { kind: "not_found" } | { kind: "request_not_open" } | { kind: "duplicate"; cardId: string };
export type RecruitMoveResult = { kind: "moved"; stage: Stage } | { kind: "not_found" } | { kind: "refused"; stage: Stage } | { kind: "placement_refused"; code: string } | { kind: "subject_unavailable" };

export interface RecruitPipelineCardRecord { id: string; person_principal_id: string | null; fulltimer_id: string | null; person_name: string | null; stage: Stage; updated_at: string }
export interface RecruitPipelineEventRecord { card_id: string; from_stage: Stage | null; to_stage: Stage; actor_name: string | null; at: string }
export interface RecruitPipelineDetail {
  readonly request: { id: string; org_id: string; org_name: string; store_name: string; position_title: string; headcount: number; status: RequestStatus; assigned_recruiter_principal_id: string | null; recruiter_name: string | null; assigned_at: string | null };
  readonly cards: readonly RecruitPipelineCardRecord[];
  readonly events: readonly RecruitPipelineEventRecord[];
  readonly canAssign: boolean;
  readonly canMove: boolean;
  /** Whether a person card can be placed now: a work placement is wired. Full-timer cards need none. */
  readonly canPlacePeople: boolean;
  readonly recruiters: readonly { principal_id: string; name: string | null }[];
}

type Locked = { id: string; org_id: string; store_id: string; status: RequestStatus; headcount: number; assigned_recruiter_principal_id: string | null; period_start: string | null; period_end: string | null };
const LOCK_REQUEST = "SELECT id, org_id, store_id, status, headcount, assigned_recruiter_principal_id, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end FROM recruit_requests WHERE id = $1::uuid FOR UPDATE";

export class PostgresRecruitPipelineStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitPipelineStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #grants(c: pg.Pool | pg.PoolClient, principalId: string, lock = false): Promise<Grant[]> {
    return (await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text${lock ? " FOR SHARE" : ""}`, [principalId])).rows;
  }

  async #transaction<T>(work: (c: pg.PoolClient) => Promise<T | { rollback: T }>): Promise<T> {
    const c = await this.#pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN");
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

  async #requestStatus(c: pg.PoolClient, request: Locked, event: PipelineEvent) {
    const next = this.options.requestStatusAfter(request.status, event);
    if (next === null) return;
    await c.query("UPDATE recruit_requests SET status = $2::text, updated_at = clock_timestamp() WHERE id = $1::uuid", [request.id, next]);
    await c.query("INSERT INTO recruit_request_events(request_id, from_status, to_status, close_reason, actor_principal_id, actor_ref) VALUES($1::uuid, $2::text, $3::text, NULL, NULL, $4::text)",
      [request.id, request.status, next, RECRUIT_SYSTEM_ACTOR_REF]);
  }

  async #event(c: pg.PoolClient, cardId: string, from: Stage | null, to: Stage, principalId: string) {
    await c.query("INSERT INTO recruit_pipeline_events(card_id, from_stage, to_stage, actor_principal_id, actor_ref) VALUES($1::uuid, $2::text, $3::text, $4::text, $5::text)",
      [cardId, from, to, principalId, principalAuditRef(principalId)]);
  }

  async assign(principalId: string, requestId: string, recruiterId: string): Promise<RecruitAssignResult> {
    return this.#transaction<RecruitAssignResult>(async (c) => {
      if (!this.options.assignDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      const request = (await c.query<Locked>(LOCK_REQUEST, [requestId])).rows[0];
      if (!request) return { rollback: { kind: "not_found" } };
      if (request.status === "closed") return { rollback: { kind: "request_closed" } };
      if (!this.options.recruiterEligible(await this.#grants(c, recruiterId, true))) return { rollback: { kind: "recruiter_ineligible" } };
      await c.query("UPDATE recruit_requests SET assigned_recruiter_principal_id = $2::text, assigned_at = COALESCE(assigned_at, clock_timestamp()), updated_at = clock_timestamp() WHERE id = $1::uuid", [requestId, recruiterId]);
      return { kind: "assigned" };
    });
  }

  async addCard(principalId: string, requestId: string, personId: string): Promise<RecruitAddCardResult> {
    return this.#addCard(principalId, requestId, { column: "person_principal_id", id: personId });
  }

  /** Recruit R9: a full-timer (a staff-held record, no account) joins the same pipeline. */
  async addFulltimerCard(principalId: string, requestId: string, fulltimerId: string): Promise<RecruitAddCardResult> {
    return this.#addCard(principalId, requestId, { column: "fulltimer_id", id: fulltimerId });
  }

  async #addCard(principalId: string, requestId: string, subject: { column: "person_principal_id" | "fulltimer_id"; id: string }): Promise<RecruitAddCardResult> {
    return this.#transaction<RecruitAddCardResult>(async (c) => {
      const request = (await c.query<Locked>(LOCK_REQUEST, [requestId])).rows[0];
      if (!request) return { rollback: { kind: "not_found" } };
      const callerGrants = await this.#grants(c, principalId, true), isLead = this.options.leadDecision(callerGrants), isRecruiter = this.options.recruiterEligible(callerGrants);
      if (!this.options.authority(principalId, request.assigned_recruiter_principal_id, isLead, isRecruiter)) return { rollback: { kind: "not_found" } };
      if (!this.options.acceptsCards(request.status)) return { rollback: { kind: "request_not_open" } };
      const exists = subject.column === "person_principal_id"
        ? (await c.query("SELECT 1 FROM principals WHERE id = $1::text FOR SHARE", [subject.id])).rowCount === 1 && this.options.candidateDecision(await this.#grants(c, subject.id, true))
        : (await c.query("SELECT 1 FROM recruit_fulltimers WHERE id = $1::uuid AND archived_at IS NULL FOR SHARE", [subject.id])).rowCount === 1;
      if (!exists) return { rollback: { kind: "not_found" } };
      const cardId = randomUUID();
      const inserted = subject.column === "person_principal_id"
        ? await c.query("INSERT INTO recruit_pipeline_cards(id, request_id, person_principal_id, stage) VALUES($1::uuid, $2::uuid, $3::text, 'suggested') ON CONFLICT (request_id, person_principal_id) DO NOTHING", [cardId, requestId, subject.id])
        : await c.query("INSERT INTO recruit_pipeline_cards(id, request_id, fulltimer_id, stage) VALUES($1::uuid, $2::uuid, $3::uuid, 'suggested') ON CONFLICT (request_id, fulltimer_id) WHERE fulltimer_id IS NOT NULL DO NOTHING", [cardId, requestId, subject.id]);
      if (inserted.rowCount !== 1) {
        const existing = (await c.query<{ id: string }>(`SELECT id FROM recruit_pipeline_cards WHERE request_id = $1::uuid AND ${subject.column} = $2`, [requestId, subject.id])).rows[0]!;
        return { rollback: { kind: "duplicate", cardId: existing.id } };
      }
      await this.#event(c, cardId, null, "suggested", principalId);
      await this.#requestStatus(c, request, { kind: "card_added" });
      return { kind: "added", cardId };
    });
  }

  async move(principalId: string, cardId: string, to: Stage): Promise<RecruitMoveResult> {
    return this.#transaction<RecruitMoveResult>(async (c) => {
      const located = (await c.query<{ request_id: string }>("SELECT request_id FROM recruit_pipeline_cards WHERE id = $1::uuid", [cardId])).rows[0];
      if (!located) return { rollback: { kind: "not_found" } };
      // Request first, then card: the same lock order as addCard and the cancel cascade.
      const request = (await c.query<Locked>(LOCK_REQUEST, [located.request_id])).rows[0]!;
      const card = (await c.query<{ stage: Stage; person_principal_id: string | null }>("SELECT stage, person_principal_id FROM recruit_pipeline_cards WHERE id = $1::uuid FOR UPDATE", [cardId])).rows[0]!;
      const callerGrants = await this.#grants(c, principalId, true), isLead = this.options.leadDecision(callerGrants), isRecruiter = this.options.recruiterEligible(callerGrants);
      if (!this.options.authority(principalId, request.assigned_recruiter_principal_id, isLead, isRecruiter)) return { rollback: { kind: "not_found" } };
      if (!this.options.transitionAllowed(card.stage, to)) return { rollback: { kind: "refused", stage: card.stage } };
      // A closed request records no new hire, even from a card left at offered.
      if (to === "placed" && request.status === "closed") return { rollback: { kind: "refused", stage: card.stage } };
      // The subject must still be eligible for every move forward; withdrawing stays possible so staff can clear the card.
      if (to !== "withdrawn") {
        const eligible = card.person_principal_id !== null
          ? this.options.candidateDecision(await this.#grants(c, card.person_principal_id, true))
          : (await c.query("SELECT 1 FROM recruit_pipeline_cards c JOIN recruit_fulltimers f ON f.id = c.fulltimer_id WHERE c.id = $1::uuid AND f.archived_at IS NULL FOR SHARE OF f", [cardId])).rowCount === 1;
        if (!eligible) return { rollback: { kind: "subject_unavailable" } };
      }
      let assignmentId: string | null = null;
      // A full-timer has no account to pay: "placed" records the hire without a work assignment.
      if (to === "placed" && card.person_principal_id !== null) {
        const placed = await this.options.placement.placeFromRecruit(principalId, {
          recruitCardId: cardId, requestId: request.id, personId: card.person_principal_id, storeId: request.store_id, startDate: request.period_start, endDate: request.period_end,
        });
        if (placed.kind !== "placed") return { rollback: { kind: "placement_refused", code: placed.code } };
        assignmentId = placed.assignmentId;
      }
      await c.query("UPDATE recruit_pipeline_cards SET stage = $2::text, assignment_id = $3::uuid, updated_at = clock_timestamp() WHERE id = $1::uuid", [cardId, to, assignmentId]);
      await this.#event(c, cardId, card.stage, to, principalId);
      if (to === "placed") {
        const placedCount = Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM recruit_pipeline_cards WHERE request_id = $1::uuid AND stage = 'placed'", [request.id])).rows[0]!.n);
        await this.#requestStatus(c, request, { kind: "placed", placedCount, headcount: request.headcount });
      }
      return { kind: "moved", stage: to };
    });
  }

  /** The staff pipeline page in a fixed number of queries; null unless the caller is staff. */
  async view(principalId: string, requestId: string): Promise<RecruitPipelineDetail | null> {
    const grants = await this.#grants(this.#pool, principalId);
    const canAssign = this.options.assignDecision(grants), isLead = this.options.leadDecision(grants), isRecruiter = this.options.recruiterEligible(grants);
    // Staff who assign see every pipeline; a recruiter (with no staff grant) sees the one they are assigned to.
    if (!canAssign && !isRecruiter) return null;
    const request = (await this.#pool.query<RecruitPipelineDetail["request"]>(
      `SELECT r.id, r.org_id, o.name AS org_name, s.name AS store_name, r.position_title, r.headcount, r.status, r.assigned_recruiter_principal_id,
        COALESCE(pp.display_name, p.display_name) AS recruiter_name, r.assigned_at
       FROM recruit_requests r JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id
       LEFT JOIN principals p ON p.id = r.assigned_recruiter_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = r.assigned_recruiter_principal_id
       WHERE r.id = $1::uuid`, [requestId])).rows[0];
    if (!request) return null;
    const canMove = this.options.authority(principalId, request.assigned_recruiter_principal_id, isLead, isRecruiter);
    if (!canAssign && !canMove) return null;
    const [cards, events, recruiters] = await Promise.all([
      this.#pool.query<RecruitPipelineCardRecord>(
        `SELECT c.id, c.person_principal_id, c.fulltimer_id, COALESCE(pp.display_name, p.display_name, f.name) AS person_name, c.stage, c.updated_at
         FROM recruit_pipeline_cards c LEFT JOIN principals p ON p.id = c.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = c.person_principal_id
         LEFT JOIN recruit_fulltimers f ON f.id = c.fulltimer_id
         WHERE c.request_id = $1::uuid ORDER BY c.created_at, c.id`, [requestId]),
      this.#pool.query<RecruitPipelineEventRecord>(
        `SELECT e.card_id, e.from_stage, e.to_stage, COALESCE(pp.display_name, p.display_name) AS actor_name, e.at
         FROM recruit_pipeline_events e JOIN recruit_pipeline_cards c ON c.id = e.card_id
         LEFT JOIN principals p ON p.id = e.actor_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = e.actor_principal_id
         WHERE c.request_id = $1::uuid ORDER BY e.at, e.id`, [requestId]),
      this.#pool.query<{ principal_id: string; name: string | null; role: string; scope: string; org_id: string }>(
        `SELECT g.principal_id, COALESCE(pp.display_name, p.display_name) AS name, g.role, g.scope, g.org_id
         FROM grants g JOIN principals p ON p.id = g.principal_id LEFT JOIN person_profiles pp ON pp.principal_id = g.principal_id
         WHERE g.org_id = ANY($1::text[]) AND g.role IN ('recruiter','staff') ORDER BY name NULLS LAST, g.principal_id`, [this.options.operatorOrgIds]),
    ]);
    const eligible = new Map<string, string | null>();
    if (canAssign) for (const row of recruiters.rows) if (this.options.recruiterEligible([row])) eligible.set(row.principal_id, row.name);
    return {
      request, cards: cards.rows, events: events.rows, canAssign: canAssign && request.status !== "closed", canMove,
      canPlacePeople: this.options.placement.available !== false,
      recruiters: [...eligible].map(([principal_id, name]) => ({ principal_id, name })),
    };
  }
}
