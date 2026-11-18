import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";
import { principalAuditRef } from "../authorization-audit.js";
import { RECRUIT_SYSTEM_ACTOR_REF } from "./postgres-recruit-pipeline-store.js";

// Recruit R4: invitations. Staff with authority over a request's pipeline invite a
// person; the person marks the invitation seen and accepts or declines; staff may
// withdraw it. Accepting puts the person on the request's pipeline at "contacted"
// in the same transaction. Every change writes its recruit outbox row there too.
// Lock order: request, then invitation, then card, as the pipeline store does.

type Grant = { org_id: string; role: string; scope: string };
type Status = "sent" | "seen" | "accepted" | "declined" | "withdrawn";
type Stage = "suggested" | "contacted" | "interviewing" | "offered" | "placed" | "withdrawn";
type RequestStatus = "draft" | "open" | "filling" | "filled" | "closed";
type OutboxKind = "invitation.sent" | "invitation.accepted" | "invitation.declined" | "invitation.withdrawn";

export interface RecruitInvitationsStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly leadDecision: (rows: readonly Grant[]) => boolean;
  /** Recruiter or staff on an operator organization: an assigned recruiter keeps authority only while this holds. */
  readonly recruiterEligible: (rows: readonly Grant[]) => boolean;
  readonly staffDecision: (rows: readonly Grant[]) => boolean;
  readonly authority: (principalId: string, assignedRecruiterId: string | null, isLead: boolean, isRecruiter: boolean) => boolean;
  readonly acceptsCards: (status: RequestStatus) => boolean;
  readonly transitionAllowed: (from: Status, to: Status, actor: "person" | "staff") => boolean;
  readonly acceptCardEffect: (stage: Stage | null) => "insert_contacted" | "move_contacted" | "keep" | "refuse";
  readonly requestStatusAfter: (status: RequestStatus, event: { kind: "card_added" }) => RequestStatus | null;
  /** Who can be invited: a principal holding a candidate grant (candidate:self). */
  readonly candidateDecision: (rows: readonly Grant[]) => boolean;
  readonly outbox: (to: Status, person: string, recruiter: string | null, inviter: string) => { kind: OutboxKind; recipient: string } | null;
}
export type RecruitInviteResult = { kind: "invited"; invitationId: string } | { kind: "not_found" } | { kind: "request_not_open" } | { kind: "duplicate"; invitationId: string };
export type RecruitInvitationAnswerResult = { kind: "done"; status: Status; cardId: string | null } | { kind: "not_found" } | { kind: "refused"; status: Status } | { kind: "request_not_open" } | { kind: "card_withdrawn" };
export interface RecruitInvitationRecord {
  id: string; request_id: string; status: Status; org_name: string; store_name: string; position_title: string; position_type: string;
  period_start: string | null; period_end: string | null; compensation_text: string; pay_model: string | null; location: string | null; created_at: string;
}
export interface RecruitRequestInvitationRecord { id: string; person_principal_id: string; person_name: string | null; status: Status; created_at: string; answered_at: string | null }

type Locked = { id: string; status: RequestStatus; assigned_recruiter_principal_id: string | null };
const LOCK_REQUEST = "SELECT id, status, assigned_recruiter_principal_id FROM recruit_requests WHERE id = $1::uuid FOR UPDATE";
type Invitation = { id: string; request_id: string; person_principal_id: string; invited_by_principal_id: string | null; status: Status };

export class PostgresRecruitInvitationsStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitInvitationsStoreOptions) {
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

  async #outbox(c: pg.PoolClient, to: Status, invitation: Invitation, recruiter: string | null) {
    const event = this.options.outbox(to, invitation.person_principal_id, recruiter, invitation.invited_by_principal_id ?? invitation.person_principal_id);
    if (!event) return;
    await c.query("INSERT INTO recruit_outbox(kind, recipient_principal_id, request_id, subject_id, dedupe_key) VALUES($1::text, $2::text, $3::uuid, $4::uuid, $5::text) ON CONFLICT (dedupe_key) DO NOTHING",
      [event.kind, event.recipient, invitation.request_id, invitation.id, `${event.kind}:${invitation.id}`]);
  }

  async invite(principalId: string, requestId: string, personId: string): Promise<RecruitInviteResult> {
    return this.#transaction<RecruitInviteResult>(async (c) => {
      const request = (await c.query<Locked>(LOCK_REQUEST, [requestId])).rows[0];
      if (!request) return { rollback: { kind: "not_found" } };
      const callerGrants = await this.#grants(c, principalId, true), isLead = this.options.leadDecision(callerGrants), isRecruiter = this.options.recruiterEligible(callerGrants);
      if (!this.options.authority(principalId, request.assigned_recruiter_principal_id, isLead, isRecruiter)) return { rollback: { kind: "not_found" } };
      if (!this.options.acceptsCards(request.status)) return { rollback: { kind: "request_not_open" } };
      if (!(await c.query("SELECT 1 FROM principals WHERE id = $1::text FOR SHARE", [personId])).rowCount) return { rollback: { kind: "not_found" } };
      if (!this.options.candidateDecision(await this.#grants(c, personId, true))) return { rollback: { kind: "not_found" } };
      const id = randomUUID();
      const inserted = await c.query("INSERT INTO recruit_invitations(id, request_id, person_principal_id, invited_by_principal_id) VALUES($1::uuid, $2::uuid, $3::text, $4::text) ON CONFLICT (request_id, person_principal_id) DO NOTHING", [id, requestId, personId, principalId]);
      if (inserted.rowCount !== 1) {
        const existing = (await c.query<{ id: string }>("SELECT id FROM recruit_invitations WHERE request_id = $1::uuid AND person_principal_id = $2::text", [requestId, personId])).rows[0]!;
        return { rollback: { kind: "duplicate", invitationId: existing.id } };
      }
      await this.#outbox(c, "sent", { id, request_id: requestId, person_principal_id: personId, invited_by_principal_id: principalId, status: "sent" }, request.assigned_recruiter_principal_id);
      return { kind: "invited", invitationId: id };
    });
  }

  /** The person's own answer: seen, accepted or declined. Another person's invitation is not found. */
  async answer(principalId: string, invitationId: string, to: "seen" | "accepted" | "declined"): Promise<RecruitInvitationAnswerResult> {
    return this.#change(principalId, invitationId, to, "person");
  }

  /** Staff with authority over the request withdraw an open invitation. */
  async withdraw(principalId: string, invitationId: string): Promise<RecruitInvitationAnswerResult> {
    return this.#change(principalId, invitationId, "withdrawn", "staff");
  }

  async #change(principalId: string, invitationId: string, to: Status, actor: "person" | "staff"): Promise<RecruitInvitationAnswerResult> {
    return this.#transaction<RecruitInvitationAnswerResult>(async (c) => {
      const located = (await c.query<{ request_id: string; person_principal_id: string }>("SELECT request_id, person_principal_id FROM recruit_invitations WHERE id = $1::uuid", [invitationId])).rows[0];
      if (!located) return { rollback: { kind: "not_found" } };
      const request = (await c.query<Locked>(LOCK_REQUEST, [located.request_id])).rows[0]!;
      const invitation = (await c.query<Invitation>("SELECT id, request_id, person_principal_id, invited_by_principal_id, status FROM recruit_invitations WHERE id = $1::uuid FOR UPDATE", [invitationId])).rows[0]!;
      if (actor === "person" && invitation.person_principal_id !== principalId) return { rollback: { kind: "not_found" } };
      // Accepting adds a pipeline card, so the person must still hold a candidate grant, read FOR SHARE like every other write's check.
      if (actor === "person" && to === "accepted" && !this.options.candidateDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      if (actor === "staff") {
        const callerGrants = await this.#grants(c, principalId, true), isLead = this.options.leadDecision(callerGrants), isRecruiter = this.options.recruiterEligible(callerGrants);
        if (!this.options.authority(principalId, request.assigned_recruiter_principal_id, isLead, isRecruiter)) return { rollback: { kind: "not_found" } };
      }
      if (invitation.status === to && to === "seen") return { rollback: { kind: "done", status: "seen", cardId: null } };
      if (!this.options.transitionAllowed(invitation.status, to, actor)) return { rollback: { kind: "refused", status: invitation.status } };
      let cardId: string | null = null;
      if (to === "accepted") {
        if (!this.options.acceptsCards(request.status)) return { rollback: { kind: "request_not_open" } };
        const card = (await c.query<{ id: string; stage: Stage }>("SELECT id, stage FROM recruit_pipeline_cards WHERE request_id = $1::uuid AND person_principal_id = $2::text FOR UPDATE", [request.id, principalId])).rows[0];
        const effect = this.options.acceptCardEffect(card?.stage ?? null);
        if (effect === "refuse") return { rollback: { kind: "card_withdrawn" } };
        const ref = principalAuditRef(principalId);
        if (effect === "insert_contacted") {
          cardId = randomUUID();
          await c.query("INSERT INTO recruit_pipeline_cards(id, request_id, person_principal_id, stage) VALUES($1::uuid, $2::uuid, $3::text, 'contacted')", [cardId, request.id, principalId]);
          await c.query("INSERT INTO recruit_pipeline_events(card_id, from_stage, to_stage, actor_principal_id, actor_ref) VALUES($1::uuid, NULL, 'contacted', $2::text, $3::text)", [cardId, principalId, ref]);
          const next = this.options.requestStatusAfter(request.status, { kind: "card_added" });
          if (next !== null) {
            await c.query("UPDATE recruit_requests SET status = $2::text, updated_at = clock_timestamp() WHERE id = $1::uuid", [request.id, next]);
            await c.query("INSERT INTO recruit_request_events(request_id, from_status, to_status, close_reason, actor_principal_id, actor_ref) VALUES($1::uuid, $2::text, $3::text, NULL, NULL, $4::text)", [request.id, request.status, next, RECRUIT_SYSTEM_ACTOR_REF]);
          }
        } else {
          cardId = card!.id;
          if (effect === "move_contacted") {
            await c.query("UPDATE recruit_pipeline_cards SET stage = 'contacted', updated_at = clock_timestamp() WHERE id = $1::uuid", [cardId]);
            await c.query("INSERT INTO recruit_pipeline_events(card_id, from_stage, to_stage, actor_principal_id, actor_ref) VALUES($1::uuid, 'suggested', 'contacted', $2::text, $3::text)", [cardId, principalId, ref]);
          }
        }
      }
      await c.query(`UPDATE recruit_invitations SET status = $2::text, updated_at = clock_timestamp(),
        seen_at = CASE WHEN $2::text = 'seen' THEN clock_timestamp() ELSE seen_at END,
        answered_at = CASE WHEN $2::text IN ('accepted','declined','withdrawn') THEN clock_timestamp() ELSE answered_at END WHERE id = $1::uuid`, [invitationId, to]);
      await this.#outbox(c, to, invitation, request.assigned_recruiter_principal_id);
      return { kind: "done", status: to, cardId };
    });
  }

  /** The person's own invitations, newest first, with what the request offers. */
  async mine(principalId: string): Promise<RecruitInvitationRecord[]> {
    return (await this.#pool.query<RecruitInvitationRecord>(
      `SELECT i.id, i.request_id, i.status, o.name AS org_name, s.name AS store_name, r.position_title, r.position_type,
        to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end, r.compensation_text, r.pay_model, r.location, i.created_at
       FROM recruit_invitations i JOIN recruit_requests r ON r.id = i.request_id JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id
       WHERE i.person_principal_id = $1::text ORDER BY i.created_at DESC, i.id LIMIT 200`, [principalId])).rows;
  }

  /** A request's invitations for staff who may read requests; null when refused. */
  async forRequest(principalId: string, requestId: string): Promise<RecruitRequestInvitationRecord[] | null> {
    if (!this.options.staffDecision(await this.#grants(this.#pool, principalId))) return null;
    return (await this.#pool.query<RecruitRequestInvitationRecord>(
      `SELECT i.id, i.person_principal_id, COALESCE(pp.display_name, p.display_name) AS person_name, i.status, i.created_at, i.answered_at
       FROM recruit_invitations i JOIN principals p ON p.id = i.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = i.person_principal_id
       WHERE i.request_id = $1::uuid ORDER BY i.created_at, i.id`, [requestId])).rows;
  }
}
