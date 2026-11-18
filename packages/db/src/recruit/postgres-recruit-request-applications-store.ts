import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";
import { principalAuditRef } from "../authorization-audit.js";
import { organizationLive } from "../organization-liveness.js";
import { RECRUIT_SYSTEM_ACTOR_REF } from "./postgres-recruit-pipeline-store.js";

// Recruit R7b: applications to open requests (legacy RequestApplication). Any
// candidate (a principal holding a candidate grant, as for the job board) browses
// the open requests of live companies and applies once while the request takes
// cards (checked under the request's row lock). Every write decides inside its
// transaction on grants read FOR SHARE, and holds the organization tree lock
// (shared) before reading ancestry. The
// company's request readers and the request's pipeline authority (assigned
// recruiter or lead) accept or reject; operator staff read. Accepting puts the
// person on the pipeline at "contacted" in the same transaction, as an accepted
// invitation does. Lock order: request, then application, then card.

type Grant = { org_id: string; role: string; scope: string };
type Decision = (rows: readonly Grant[], orgId: string, ancestors: readonly string[]) => boolean;
type Client = pg.Pool | pg.PoolClient;
type Status = "applied" | "accepted" | "rejected";
type Stage = "suggested" | "contacted" | "interviewing" | "offered" | "placed" | "withdrawn";
type RequestStatus = "draft" | "open" | "filling" | "filled" | "closed";

export interface RecruitRequestApplicationsStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly companyDecision: Decision;
  readonly staffDecision: (rows: readonly Grant[]) => boolean;
  readonly leadDecision: (rows: readonly Grant[]) => boolean;
  readonly recruiterEligible: (rows: readonly Grant[]) => boolean;
  /** Who may browse and apply, and who an acceptance may still put on the pipeline: a principal holding a candidate grant. */
  readonly candidateDecision: (rows: readonly Grant[]) => boolean;
  readonly authority: (principalId: string, assignedRecruiterId: string | null, isLead: boolean, isRecruiter: boolean) => boolean;
  readonly takesApplications: (status: RequestStatus) => boolean;
  readonly transitionAllowed: (from: Status, to: Status) => boolean;
  readonly acceptCardEffect: (stage: Stage | null) => "insert_contacted" | "move_contacted" | "keep" | "refuse";
  readonly requestStatusAfter: (status: RequestStatus, event: { kind: "card_added" }) => RequestStatus | null;
  readonly outbox: (to: Status, applicationId: string, personId: string, recruiterId: string | null) => { readonly kind: string; readonly recipient: string; readonly dedupeKey: string } | null;
  readonly pageSize: number;
}

export interface RecruitOpenRequestRecord {
  readonly id: string; readonly org_name: string; readonly store_name: string; readonly position_title: string; readonly description: string; readonly position_type: string;
  readonly compensation_text: string; readonly pay_model: string | null; readonly period_start: string | null; readonly period_end: string | null; readonly location: string | null;
  readonly status: RequestStatus; readonly created_at: string; readonly application_id: string | null; readonly application_status: Status | null;
}
export interface RecruitRequestApplicationRecord {
  readonly id: string; readonly person_principal_id: string; readonly person_name: string | null; readonly status: Status; readonly created_at: string; readonly decided_at: string | null; readonly card_id: string | null;
}
export interface RecruitOpenRequestQuery { readonly q: string | null; readonly positionType: "full_time" | "part_time" | null; readonly applied: boolean; readonly page: number }
export type RecruitRequestApplyResult = { kind: "applied"; applicationId: string } | { kind: "not_found" } | { kind: "request_not_open" } | { kind: "duplicate"; applicationId: string };
export type RecruitRequestApplicationDecideResult = { kind: "decided"; status: Status; cardId: string | null } | { kind: "not_found" } | { kind: "refused"; status: Status } | { kind: "request_not_open" } | { kind: "card_withdrawn" } | { kind: "person_unavailable" };

const OPEN_COLUMNS = `r.id, o.name AS org_name, s.name AS store_name, r.position_title, r.description, r.position_type, r.compensation_text, r.pay_model,
 to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end, r.location, r.status, r.created_at, a.id AS application_id, a.status AS application_status`;
const OPEN_FROM = `recruit_requests r JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id
 LEFT JOIN recruit_request_applications a ON a.request_id = r.id AND a.person_principal_id = $1::text`;
// A company being deleted or set inactive does not advertise.
const LIVE = `NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = r.org_id) AND NOT EXISTS (SELECT 1 FROM organization_status_overrides x WHERE x.org_id = r.org_id AND x.status = 'inactive')`;

export class PostgresRecruitRequestApplicationsStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitRequestApplicationsStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

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

  async #access(c: Client, principalId: string, request: { org_id: string; assigned_recruiter_principal_id: string | null }, lock = false): Promise<{ read: boolean; write: boolean }> {
    if (lock) await c.query("SELECT pg_advisory_xact_lock_shared(hashtext('studenthub:organizations:tree'))");
    const grants = await this.#grants(c, principalId, lock);
    let company = false;
    if (await organizationLive(c, request.org_id, lock)) {
      const ancestors = (await c.query<{ id: string }>(
        "WITH RECURSIVE chain AS (SELECT id, parent_org_id FROM organizations WHERE id = $1::text UNION ALL SELECT o.id, o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id = o.id) SELECT id FROM chain WHERE id <> $1::text",
        [request.org_id])).rows.map((r) => r.id);
      company = this.options.companyDecision(grants, request.org_id, ancestors);
    }
    const pipeline = this.options.authority(principalId, request.assigned_recruiter_principal_id, this.options.leadDecision(grants), this.options.recruiterEligible(grants));
    return { read: company || pipeline || this.options.staffDecision(grants), write: company || pipeline };
  }

  async #grants(c: Client, principalId: string, lock = false): Promise<Grant[]> {
    return (await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text${lock ? " FOR SHARE" : ""}`, [principalId])).rows;
  }

  /** Open requests of live companies the person has not applied to, or (applied) every request they applied to; newest first. Null for a non-candidate. */
  async board(personId: string, query: RecruitOpenRequestQuery): Promise<{ requests: RecruitOpenRequestRecord[]; total: number } | null> {
    if (!this.options.candidateDecision(await this.#grants(this.#pool, personId))) return null;
    const like = query.q ? `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const where = `WHERE ${query.applied ? "a.id IS NOT NULL" : `r.status IN ('open','filling') AND a.id IS NULL AND ${LIVE}`}
      AND ($2::text IS NULL OR r.position_title ILIKE $2 OR r.description ILIKE $2 OR o.name ILIKE $2) AND ($3::text IS NULL OR r.position_type = $3)`;
    const [rows, total] = await Promise.all([
      this.#pool.query<RecruitOpenRequestRecord>(`SELECT ${OPEN_COLUMNS} FROM ${OPEN_FROM} ${where} ORDER BY ${query.applied ? "a.created_at" : "r.created_at"} DESC, r.id LIMIT $4 OFFSET $5`,
        [personId, like, query.positionType, this.options.pageSize, (query.page - 1) * this.options.pageSize]),
      this.#pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${OPEN_FROM} ${where}`, [personId, like, query.positionType]),
    ]);
    return { requests: rows.rows, total: Number(total.rows[0]!.n) };
  }

  /** One request as a person sees it: open at a live company, or one they applied to. */
  async openRequest(personId: string, requestId: string): Promise<RecruitOpenRequestRecord | null> {
    if (!this.options.candidateDecision(await this.#grants(this.#pool, personId))) return null;
    const row = (await this.#pool.query<RecruitOpenRequestRecord & { live: boolean }>(`SELECT ${OPEN_COLUMNS}, ${LIVE} AS live FROM ${OPEN_FROM} WHERE r.id = $2::uuid`, [personId, requestId])).rows[0];
    if (!row || !(row.application_id || (row.live && this.options.takesApplications(row.status)))) return null;
    const { live: _live, ...rest } = row;
    return rest;
  }

  async apply(personId: string, requestId: string): Promise<RecruitRequestApplyResult> {
    return this.#transaction<RecruitRequestApplyResult>(async (c) => {
      // Decided on the person's own grants read FOR SHARE: a revoked candidate grant either commits first or waits.
      if (!this.options.candidateDecision(await this.#grants(c, personId, true))) return { rollback: { kind: "not_found" } };
      const request = (await c.query<{ org_id: string; status: RequestStatus; assigned_recruiter_principal_id: string | null }>(
        "SELECT org_id, status, assigned_recruiter_principal_id FROM recruit_requests WHERE id = $1::uuid FOR SHARE", [requestId])).rows[0];
      const existing = (await c.query<{ id: string }>("SELECT id FROM recruit_request_applications WHERE request_id = $1::uuid AND person_principal_id = $2::text", [requestId, personId])).rows[0];
      if (existing) return { rollback: { kind: "duplicate", applicationId: existing.id } };
      if (!request || request.status === "draft") return { rollback: { kind: "not_found" } };
      const inactive = (await c.query("SELECT 1 FROM organization_status_overrides WHERE org_id = $1::text AND status = 'inactive'", [request.org_id])).rowCount;
      if (!(await organizationLive(c, request.org_id, true)) || inactive) return { rollback: { kind: "not_found" } };
      if (!this.options.takesApplications(request.status)) return { rollback: { kind: "request_not_open" } };
      const id = randomUUID();
      const inserted = await c.query("INSERT INTO recruit_request_applications(id, request_id, person_principal_id) VALUES($1::uuid, $2::uuid, $3::text) ON CONFLICT (request_id, person_principal_id) DO NOTHING", [id, requestId, personId]);
      if (inserted.rowCount !== 1) {
        const raced = (await c.query<{ id: string }>("SELECT id FROM recruit_request_applications WHERE request_id = $1::uuid AND person_principal_id = $2::text", [requestId, personId])).rows[0]!;
        return { rollback: { kind: "duplicate", applicationId: raced.id } };
      }
      await this.#outbox(c, "applied", id, personId, requestId, request.assigned_recruiter_principal_id);
      return { kind: "applied", applicationId: id };
    });
  }

  async #outbox(c: pg.PoolClient, to: Status, applicationId: string, personId: string, requestId: string, recruiter: string | null) {
    const event = this.options.outbox(to, applicationId, personId, recruiter);
    if (!event) return;
    await c.query("INSERT INTO recruit_outbox(kind, recipient_principal_id, request_id, subject_id, dedupe_key) VALUES($1::text, $2::text, $3::uuid, $4::uuid, $5::text) ON CONFLICT (dedupe_key) DO NOTHING",
      [event.kind, event.recipient, requestId, applicationId, event.dedupeKey]);
  }

  /** A request's applications for its company, its pipeline authority and operator staff; null when refused. */
  async forRequest(principalId: string, requestId: string): Promise<{ applications: RecruitRequestApplicationRecord[]; canDecide: boolean } | null> {
    // The assignment, the caller's grants and the applications come from one snapshot.
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

  async #forRequest(c: pg.PoolClient, principalId: string, requestId: string): Promise<{ applications: RecruitRequestApplicationRecord[]; canDecide: boolean } | null> {
    const request = (await c.query<{ org_id: string; assigned_recruiter_principal_id: string | null }>("SELECT org_id, assigned_recruiter_principal_id FROM recruit_requests WHERE id = $1::uuid", [requestId])).rows[0];
    if (!request) return null;
    const access = await this.#access(c, principalId, request);
    if (!access.read) return null;
    const rows = (await c.query<RecruitRequestApplicationRecord>(
      `SELECT a.id, a.person_principal_id, COALESCE(pp.display_name, p.display_name) AS person_name, a.status, a.created_at, a.decided_at, c.id AS card_id
       FROM recruit_request_applications a JOIN principals p ON p.id = a.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = a.person_principal_id
       LEFT JOIN recruit_pipeline_cards c ON c.request_id = a.request_id AND c.person_principal_id = a.person_principal_id
       WHERE a.request_id = $1::uuid ORDER BY a.created_at DESC, a.id`, [requestId])).rows;
    return { applications: rows, canDecide: access.write };
  }

  async decide(principalId: string, applicationId: string, to: "accepted" | "rejected"): Promise<RecruitRequestApplicationDecideResult> {
    return this.#transaction<RecruitRequestApplicationDecideResult>(async (c) => {
      const located = (await c.query<{ request_id: string }>("SELECT request_id FROM recruit_request_applications WHERE id = $1::uuid", [applicationId])).rows[0];
      if (!located) return { rollback: { kind: "not_found" } };
      const request = (await c.query<{ id: string; org_id: string; status: RequestStatus; assigned_recruiter_principal_id: string | null }>(
        "SELECT id, org_id, status, assigned_recruiter_principal_id FROM recruit_requests WHERE id = $1::uuid FOR UPDATE", [located.request_id])).rows[0]!;
      const application = (await c.query<{ status: Status; person_principal_id: string }>("SELECT status, person_principal_id FROM recruit_request_applications WHERE id = $1::uuid FOR UPDATE", [applicationId])).rows[0]!;
      if (!(await this.#access(c, principalId, request, true)).write) return { rollback: { kind: "not_found" } };
      if (!this.options.transitionAllowed(application.status, to)) return { rollback: { kind: "refused", status: application.status } };
      let cardId: string | null = null;
      if (to === "accepted") {
        if (!this.options.takesApplications(request.status)) return { rollback: { kind: "request_not_open" } };
        const person = application.person_principal_id;
        // Only a person who is still a candidate joins the pipeline; rejecting stays possible.
        if (!this.options.candidateDecision(await this.#grants(c, person, true))) return { rollback: { kind: "person_unavailable" } };
        const card = (await c.query<{ id: string; stage: Stage }>("SELECT id, stage FROM recruit_pipeline_cards WHERE request_id = $1::uuid AND person_principal_id = $2::text FOR UPDATE", [request.id, person])).rows[0];
        const effect = this.options.acceptCardEffect(card?.stage ?? null);
        if (effect === "refuse") return { rollback: { kind: "card_withdrawn" } };
        const ref = principalAuditRef(principalId);
        if (effect === "insert_contacted") {
          cardId = randomUUID();
          await c.query("INSERT INTO recruit_pipeline_cards(id, request_id, person_principal_id, stage) VALUES($1::uuid, $2::uuid, $3::text, 'contacted')", [cardId, request.id, person]);
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
      await c.query("UPDATE recruit_request_applications SET status = $2::text, decided_at = clock_timestamp(), decided_by_principal_id = $3::text WHERE id = $1::uuid", [applicationId, to, principalId]);
      await this.#outbox(c, to, applicationId, application.person_principal_id, request.id, request.assigned_recruiter_principal_id);
      return { kind: "decided", status: to, cardId };
    });
  }
}
