import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";
import { principalAuditRef } from "../authorization-audit.js";
import { organizationLive } from "../organization-liveness.js";

// Recruit R1: requests for people. A status change and its activity row commit
// in one transaction; the request row is locked first so two changes of one
// request cannot both win. Refusals, unknown ids and other companies' rows all
// answer not_found so existence is never revealed.

type Grant = { org_id: string; role: string; scope: string };
type Decision = (rows: readonly Grant[], orgId: string, ancestors: readonly string[]) => boolean;
type Client = pg.Pool | pg.PoolClient;
type Status = "draft" | "open" | "filling" | "filled" | "closed";
type CloseReason = "fulfilled" | "cancelled";

export interface RecruitRequestInput {
  readonly storeId: string;
  readonly positionTitle: string;
  readonly description: string;
  readonly compensationText: string;
  readonly positionType: "full_time" | "part_time";
  readonly headcount: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly payModel: "hourly" | "fixed_price" | "monthly_salary" | null;
  readonly gender: "any" | "male" | "female" | "other";
  readonly location: string | null;
  readonly priority: number;
  readonly draft: boolean;
}
export interface RecruitRequestRecord {
  id: string; org_id: string; org_name: string; store_id: string; store_name: string;
  position_title: string; description: string; compensation_text: string; position_type: "full_time" | "part_time";
  headcount: number; period_start: string | null; period_end: string | null; pay_model: "hourly" | "fixed_price" | "monthly_salary" | null;
  gender: "any" | "male" | "female" | "other"; location: string | null; priority: number;
  status: Status; close_reason: CloseReason | null; assigned: boolean; created_at: string; updated_at: string; cursor_at: string;
}
export interface RecruitRequestEventRecord { from_status: Status | null; to_status: Status; close_reason: CloseReason | null; actor_name: string | null; at: string }
export interface RecruitRequestPageQuery { readonly status?: Status; readonly cursor?: { readonly createdAt: string; readonly id: string }; readonly limit: number }
export interface RecruitStoreOption { readonly store_id: string; readonly name: string }

export type RecruitRequestCreateResult = { kind: "created"; requestId: string } | { kind: "not_found" };
export type RecruitRequestTransitionResult = { kind: "transitioned"; status: Status } | { kind: "not_found" } | { kind: "refused"; status: Status };
export type RecruitRequestDetail = { readonly request: RecruitRequestRecord; readonly events: readonly RecruitRequestEventRecord[]; readonly canTransition: boolean; readonly people: readonly RecruitRequestPersonRecord[] };
/** People suggested to or working through the request, as the company sees them (R4); withdrawn cards are left out. */
export type RecruitRequestPersonLink = { readonly stage: string | null; readonly invitation_status: string | null };
export type RecruitRequestPersonProfile = {
  readonly principal_id: string; readonly name: string | null; readonly arabic_name: string | null; readonly objective: string | null; readonly introduction: string | null;
  readonly preferred_time: string | null; readonly gender: string | null; readonly birth_date: string | null; readonly driving_licence: boolean | null;
  readonly nationality_name: string | null; readonly area_name: string | null; readonly job_search_status: string | null;
};
export type RecruitRequestPersonRecordRow = { readonly kind: "education" | "experience" | "skill"; readonly fields: Record<string, unknown>; readonly university: string | null; readonly degree: string | null; readonly major: string | null };
export type RecruitRequestPersonDetail = { readonly person: RecruitRequestPersonProfile; readonly records: readonly RecruitRequestPersonRecordRow[]; readonly link: RecruitRequestPersonLink; readonly staff: boolean };
export type RecruitRequestPersonRecord = { readonly person_principal_id: string; readonly person_name: string | null; readonly stage: string };

export interface RecruitRequestsStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly createDecision: Decision;
  readonly readDecision: Decision;
  readonly transitionDecision: Decision;
  readonly staffDecision: (rows: readonly Grant[]) => boolean;
  /** Stores the principal manages (access lane A4); empty when not a store manager. Defaults to none. */
  readonly managedStores?: (principalId: string) => Promise<readonly { readonly orgId: string; readonly storeId: string }[]>;
  readonly transitionAllowed: (from: Status, to: Status) => boolean;
}

const COLUMNS = `r.id, r.org_id, o.name AS org_name, r.store_id, s.name AS store_name, r.position_title, r.description, r.compensation_text,
 r.position_type, r.headcount, to_char(r.period_start,'YYYY-MM-DD') AS period_start, to_char(r.period_end,'YYYY-MM-DD') AS period_end,
 r.pay_model, r.gender, r.location, r.priority, r.status, r.close_reason, (r.assigned_recruiter_principal_id IS NOT NULL) AS assigned,
 r.created_at, r.updated_at, to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
const FROM = "recruit_requests r JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id";

export class PostgresRecruitRequestsStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitRequestsStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #grants(c: Client, principalId: string, lock = false): Promise<Grant[]> {
    return (await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1${lock ? " FOR SHARE" : ""}`, [principalId])).rows;
  }

  async #ancestors(c: Client, orgId: string): Promise<string[]> {
    return (await c.query<{ id: string }>(
      "WITH RECURSIVE chain AS (SELECT id, parent_org_id FROM organizations WHERE id = $1::text UNION ALL SELECT o.id, o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id = o.id) SELECT id FROM chain WHERE id <> $1::text",
      [orgId],
    )).rows.map((row) => row.id);
  }

  async #allowed(c: Client, principalId: string, orgId: string, decisions: readonly Decision[], lock = false): Promise<boolean[]> {
    // A missing or deleted organization answers exactly as a refused one.
    if (!await organizationLive(c, orgId, lock)) return decisions.map(() => false);
    const [grants, ancestors] = await Promise.all([this.#grants(c, principalId, lock), this.#ancestors(c, orgId)]);
    return decisions.map((decision) => decision(grants, orgId, ancestors));
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

  async #event(c: pg.PoolClient, requestId: string, from: Status | null, to: Status, closeReason: CloseReason | null, principalId: string) {
    await c.query(
      "INSERT INTO recruit_request_events(request_id, from_status, to_status, close_reason, actor_principal_id, actor_ref) VALUES($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)",
      [requestId, from, to, closeReason, principalId, principalAuditRef(principalId)],
    );
  }

  /** Active stores of a company the caller may raise requests for; null when refused. */
  async stores(principalId: string, orgId: string): Promise<RecruitStoreOption[] | null> {
    const [allowed] = await this.#allowed(this.#pool, principalId, orgId, [this.options.createDecision]);
    if (!allowed) return null;
    return (await this.#pool.query<RecruitStoreOption>(
      "SELECT id AS store_id, name FROM organization_stores WHERE org_id = $1::text AND status = 'active' ORDER BY name, id", [orgId],
    )).rows;
  }

  async create(principalId: string, orgId: string, input: RecruitRequestInput): Promise<RecruitRequestCreateResult> {
    return this.#transaction<RecruitRequestCreateResult>(async (c) => {
      const [allowed] = await this.#allowed(c, principalId, orgId, [this.options.createDecision], true);
      if (!allowed) return { rollback: { kind: "not_found" } };
      const id = randomUUID(), status: Status = input.draft ? "draft" : "open";
      // The store check is part of the insert itself: no row unless the store is this company's and active.
      const inserted = await c.query(
        `INSERT INTO recruit_requests(id, org_id, store_id, created_by_principal_id, position_title, description, compensation_text, position_type,
           headcount, period_start, period_end, pay_model, gender, location, priority, status)
         SELECT $1::uuid, s.org_id, s.id, $3::text, $4::text, $5::text, $6::text, $7::text, $8::int, $9::date, $10::date, $11::text, $12::text, $13::text, $14::int, $15::text
         FROM organization_stores s WHERE s.id = $16::uuid AND s.org_id = $2::text AND s.status = 'active'
         FOR SHARE OF s`,
        [id, orgId, principalId, input.positionTitle, input.description, input.compensationText, input.positionType, input.headcount,
          input.periodStart, input.periodEnd, input.payModel, input.gender, input.location, input.priority, status, input.storeId],
      );
      if (inserted.rowCount !== 1) return { rollback: { kind: "not_found" } };
      await this.#event(c, id, null, status, null, principalId);
      return { kind: "created", requestId: id };
    });
  }

  async transition(principalId: string, requestId: string, to: Status, closeReason: CloseReason | null): Promise<RecruitRequestTransitionResult> {
    return this.#transaction<RecruitRequestTransitionResult>(async (c) => {
      const current = (await c.query<{ org_id: string; status: Status }>(
        "SELECT org_id, status FROM recruit_requests WHERE id = $1::uuid FOR UPDATE", [requestId],
      )).rows[0];
      if (!current) return { rollback: { kind: "not_found" } };
      const [allowed] = await this.#allowed(c, principalId, current.org_id, [this.options.transitionDecision], true);
      if (!allowed) return { rollback: { kind: "not_found" } };
      if (!this.options.transitionAllowed(current.status, to) || (to === "closed") !== (closeReason !== null)) {
        return { rollback: { kind: "refused", status: current.status } };
      }
      const updated = await c.query(
        `UPDATE recruit_requests SET status = $3::text, close_reason = $4::text, updated_at = clock_timestamp(),
           assigned_recruiter_principal_id = CASE WHEN $4::text = 'cancelled' THEN NULL ELSE assigned_recruiter_principal_id END
         WHERE id = $1::uuid AND status = $2::text`,
        [requestId, current.status, to, closeReason],
      );
      if (updated.rowCount !== 1) return { rollback: { kind: "refused", status: current.status } };
      await this.#event(c, requestId, current.status, to, closeReason, principalId);
      return { kind: "transitioned", status: to };
    });
  }

  /** One request with its activity (oldest first), or null when the caller may not read it. */
  async get(principalId: string, requestId: string): Promise<RecruitRequestDetail | null> {
    const row = (await this.#pool.query<RecruitRequestRecord>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.id = $1::uuid`, [requestId])).rows[0];
    if (!row) return null;
    const [read, transition] = await this.#allowed(this.#pool, principalId, row.org_id, [this.options.readDecision, this.options.transitionDecision]);
    if (!read) return null;
    const [events, people] = await Promise.all([
      this.#pool.query<RecruitRequestEventRecord>(
        "SELECT e.from_status, e.to_status, e.close_reason, p.display_name AS actor_name, e.at FROM recruit_request_events e LEFT JOIN principals p ON p.id = e.actor_principal_id WHERE e.request_id = $1::uuid ORDER BY e.at, e.id",
        [requestId]),
      this.#pool.query<RecruitRequestPersonRecord>(
        "SELECT c.person_principal_id, COALESCE(pp.display_name, p.display_name) AS person_name, c.stage FROM recruit_pipeline_cards c JOIN principals p ON p.id = c.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = c.person_principal_id WHERE c.request_id = $1::uuid AND c.stage <> 'withdrawn' ORDER BY c.created_at, c.id",
        [requestId]),
    ]);
    return { request: row, events: events.rows, canTransition: Boolean(transition), people: people.rows };
  }

  /**
   * A person as a request's company sees them (R5): profile fields, background records and how they are linked
   * to the request. Null unless the caller may read the request (or is operator staff) and the person has a card
   * or an invitation on it; the caller then decides with the injected rule whether the link still gives sight.
   */
  async person(principalId: string, requestId: string, personId: string): Promise<RecruitRequestPersonDetail | null> {
    const request = (await this.#pool.query<{ org_id: string; store_id: string }>("SELECT org_id, store_id FROM recruit_requests WHERE id = $1::uuid", [requestId])).rows[0];
    if (!request) return null;
    const [read, staff] = await this.#allowed(this.#pool, principalId, request.org_id, [this.options.readDecision, (rows) => this.options.staffDecision(rows)]);
    // A store manager sees the people of requests for the stores they manage, and no other.
    const manages = !read && !staff && (await this.options.managedStores?.(principalId) ?? []).some((s) => s.orgId === request.org_id && s.storeId === request.store_id);
    if (!read && !staff && !manages) return null;
    const link = (await this.#pool.query<RecruitRequestPersonLink>(
      `SELECT (SELECT stage FROM recruit_pipeline_cards WHERE request_id = $1::uuid AND person_principal_id = $2::text) AS stage,
        (SELECT status FROM recruit_invitations WHERE request_id = $1::uuid AND person_principal_id = $2::text) AS invitation_status`, [requestId, personId])).rows[0]!;
    if (link.stage === null && link.invitation_status === null) return null;
    const [person, records] = await Promise.all([
      this.#pool.query<RecruitRequestPersonProfile>(
        `SELECT p.id AS principal_id, COALESCE(pp.display_name, p.display_name) AS name, pp.arabic_name, pp.objective, pp.introduction, pp.preferred_time, pp.gender,
          to_char(pp.birth_date, 'YYYY-MM-DD') AS birth_date, pp.driving_licence, ci.name AS nationality_name, ai.name AS area_name, pp.job_search_status
         FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id = p.id
         LEFT JOIN catalogue_items ci ON ci.id = pp.nationality_id AND ci.catalogue_type = 'country'
         LEFT JOIN person_locations pl ON pl.principal_id = p.id LEFT JOIN catalogue_items ai ON ai.id = pl.area_id
         WHERE p.id = $1::text`, [personId]),
      this.#pool.query<RecruitRequestPersonRecordRow>(
        `SELECT r.kind, r.fields, u.name AS university, d.name AS degree, m.name AS major
         FROM candidate_profile_records r
         LEFT JOIN catalogue_items u ON r.fields->>'universityId' ~ '^[0-9a-f-]{36}$' AND u.id = (r.fields->>'universityId')::uuid AND u.catalogue_type = 'university'
         LEFT JOIN catalogue_items d ON r.fields->>'degreeId' ~ '^[0-9a-f-]{36}$' AND d.id = (r.fields->>'degreeId')::uuid AND d.catalogue_type = 'degree'
         LEFT JOIN catalogue_items m ON r.fields->>'majorId' ~ '^[0-9a-f-]{36}$' AND m.id = (r.fields->>'majorId')::uuid AND m.catalogue_type = 'major'
         WHERE r.owner_principal_id = $1::text AND r.status = 'active' AND r.kind IN ('education', 'experience', 'skill') ORDER BY r.created_at, r.id`, [personId]),
    ]);
    if (!person.rows[0]) return null;
    return { person: person.rows[0], records: records.rows, link, staff: Boolean(staff) };
  }

  /** Records one employer document link issued or opened (R5); append-only. */
  async recordEmployerDocumentView(view: { viewerPrincipalId: string; subjectPrincipalId: string; requestId: string; operation: "issue" | "deliver"; documentType: string; documentVersion: string }): Promise<void> {
    await this.#pool.query("INSERT INTO recruit_employer_document_views(viewer_principal_id, subject_principal_id, request_id, operation, document_type, document_version) VALUES($1::text, $2::text, $3::uuid, $4::text, $5::text, $6::text)",
      [view.viewerPrincipalId, view.subjectPrincipalId, view.requestId, view.operation, view.documentType, view.documentVersion]);
  }

  /** A company's requests, newest first, one page; null when the caller may not read the company. */
  async listCompany(principalId: string, orgId: string, query: RecruitRequestPageQuery): Promise<RecruitRequestRecord[] | null> {
    const [allowed] = await this.#allowed(this.#pool, principalId, orgId, [this.options.readDecision]);
    if (!allowed) return null;
    return (await this.#pool.query<RecruitRequestRecord>(
      `SELECT ${COLUMNS} FROM ${FROM}
       WHERE r.org_id = $1::text AND ($2::text IS NULL OR r.status = $2::text)
         AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $5::int`,
      [orgId, query.status ?? null, query.cursor?.createdAt ?? null, query.cursor?.id ?? null, query.limit],
    )).rows;
  }

  /** Every company's requests for staff, drafts excluded, newest first; null when the caller is not staff. */
  async listStaff(principalId: string, query: RecruitRequestPageQuery): Promise<RecruitRequestRecord[] | null> {
    if (!this.options.staffDecision(await this.#grants(this.#pool, principalId))) return null;
    if (query.status === "draft") return [];
    return (await this.#pool.query<RecruitRequestRecord>(
      `SELECT ${COLUMNS} FROM ${FROM}
       WHERE r.status <> 'draft' AND ($1::text IS NULL OR r.status = $1::text)
         AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $4::int`,
      [query.status ?? null, query.cursor?.createdAt ?? null, query.cursor?.id ?? null, query.limit],
    )).rows;
  }
}
