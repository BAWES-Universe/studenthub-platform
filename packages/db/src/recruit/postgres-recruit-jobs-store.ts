import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";

// Recruit R7: job board (legacy Job, JobSkills, JobInterest). Operator staff
// publish and edit jobs and decide applications; anyone signed in browses active
// jobs and applies once while the job is active (checked under the job's row
// lock, so a close and an application never cross). Decisions write the outbox.

type Grant = { org_id: string; role: string; scope: string };
type JobStatus = "draft" | "active" | "closed";
type ApplicationStatus = "interested" | "shortlisted" | "rejected";

export interface RecruitJobsStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly staffDecision: (rows: readonly Grant[]) => boolean;
  /** Who may browse the board and apply: the candidate surface (`candidate:self`). */
  readonly candidateDecision: (rows: readonly Grant[]) => boolean;
  readonly acceptsApplications: (status: JobStatus) => boolean;
  readonly transitionAllowed: (from: ApplicationStatus, to: ApplicationStatus) => boolean;
  readonly outbox: (to: ApplicationStatus, applicationId: string, personId: string) => { readonly kind: string; readonly recipient: string; readonly dedupeKey: string } | null;
  readonly pageSize: number;
}

export interface RecruitJobInput {
  readonly requestId: string; readonly areaId: string | null; readonly position: string; readonly positionAr: string | null; readonly description: string | null; readonly descriptionAr: string | null;
  readonly hoursPerDay: number | null; readonly daysPerWeek: number | null; readonly compensationType: string | null; readonly compensationAmount: string | null;
  readonly compensationDescription: string | null; readonly compensationDescriptionAr: string | null; readonly minAge: number | null; readonly maxAge: number | null;
  readonly gender: "any" | "male" | "female" | "other"; readonly availableFrom: string | null; readonly availableTo: string | null; readonly status: JobStatus; readonly skills: readonly string[];
}
export interface RecruitJobRecord {
  readonly id: string; readonly request_id: string; readonly org_name: string; readonly store_name: string; readonly area_id: string | null; readonly area_name: string | null; readonly position: string; readonly position_ar: string | null;
  readonly description: string | null; readonly description_ar: string | null; readonly hours_per_day: number | null; readonly days_per_week: number | null; readonly compensation_type: string | null;
  readonly compensation_amount: string | null; readonly compensation_description: string | null; readonly compensation_description_ar: string | null; readonly min_age: number | null; readonly max_age: number | null;
  readonly gender: "any" | "male" | "female" | "other"; readonly available_from: string | null; readonly available_to: string | null; readonly status: JobStatus; readonly skills: string[]; readonly created_at: string;
  readonly application_status: ApplicationStatus | null; readonly applications: number;
}
export interface RecruitJobApplicationRecord { readonly id: string; readonly person_principal_id: string; readonly person_name: string | null; readonly status: ApplicationStatus; readonly note: string | null; readonly created_at: string; readonly decided_at: string | null }

export type RecruitJobWriteResult = { kind: "saved"; jobId: string } | { kind: "not_found" } | { kind: "area_invalid" } | { kind: "request_locked" };
export type RecruitApplyResult = { kind: "applied"; applicationId: string } | { kind: "not_found" } | { kind: "job_closed" } | { kind: "duplicate"; applicationId: string };
export type RecruitDecideResult = { kind: "decided"; status: ApplicationStatus } | { kind: "not_found" } | { kind: "refused"; status: ApplicationStatus };

const JOB_COLUMNS = `j.id, j.request_id, o.name AS org_name, s.name AS store_name, j.area_id, ai.name::text AS area_name, j.position, j.position_ar, j.description, j.description_ar,
 j.hours_per_day, j.days_per_week, j.compensation_type, j.compensation_amount, j.compensation_description, j.compensation_description_ar, j.min_age, j.max_age, j.gender,
 to_char(j.available_from,'YYYY-MM-DD') AS available_from, to_char(j.available_to,'YYYY-MM-DD') AS available_to, j.status, j.skills, j.created_at`;
const JOB_FROM = `recruit_jobs j JOIN recruit_requests r ON r.id = j.request_id JOIN organizations o ON o.id = r.org_id JOIN organization_stores s ON s.id = r.store_id
 LEFT JOIN catalogue_items ai ON ai.id = j.area_id`;

export class PostgresRecruitJobsStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitJobsStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #grants(c: pg.Pool | pg.PoolClient, principalId: string, lock = false): Promise<Grant[]> {
    return (await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text${lock ? " FOR SHARE" : ""}`, [principalId])).rows;
  }

  async #staff(c: pg.Pool | pg.PoolClient, principalId: string, lock = false): Promise<boolean> {
    return this.options.staffDecision(await this.#grants(c, principalId, lock));
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

  async #checkRefs(c: pg.PoolClient, input: RecruitJobInput): Promise<"not_found" | "area_invalid" | null> {
    if (!(await c.query("SELECT 1 FROM recruit_requests WHERE id = $1::uuid FOR SHARE", [input.requestId])).rowCount) return "not_found";
    if (input.areaId && !(await c.query("SELECT 1 FROM catalogue_items WHERE id = $1::uuid AND catalogue_type = 'area' FOR SHARE", [input.areaId])).rowCount) return "area_invalid";
    return null;
  }

  static #values(input: RecruitJobInput) {
    return [input.requestId, input.areaId, input.position, input.positionAr, input.description, input.descriptionAr, input.hoursPerDay, input.daysPerWeek, input.compensationType, input.compensationAmount,
      input.compensationDescription, input.compensationDescriptionAr, input.minAge, input.maxAge, input.gender, input.availableFrom, input.availableTo, input.status, [...input.skills]];
  }

  async create(principalId: string, input: RecruitJobInput): Promise<RecruitJobWriteResult> {
    return this.#transaction<RecruitJobWriteResult>(async (c) => {
      if (!await this.#staff(c, principalId, true)) return { rollback: { kind: "not_found" } };
      const refused = await this.#checkRefs(c, input);
      if (refused) return { rollback: { kind: refused } };
      const id = randomUUID();
      await c.query(`INSERT INTO recruit_jobs(id, request_id, area_id, position, position_ar, description, description_ar, hours_per_day, days_per_week, compensation_type, compensation_amount,
        compensation_description, compensation_description_ar, min_age, max_age, gender, available_from, available_to, status, skills, created_by_principal_id, updated_by_principal_id)
        VALUES($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18::date, $19, $20::text[], $21::text, $21::text)`,
        [id, ...PostgresRecruitJobsStore.#values(input), principalId]);
      return { kind: "saved", jobId: id };
    });
  }

  async update(principalId: string, jobId: string, input: RecruitJobInput): Promise<RecruitJobWriteResult> {
    return this.#transaction<RecruitJobWriteResult>(async (c) => {
      if (!await this.#staff(c, principalId, true)) return { rollback: { kind: "not_found" } };
      const job = (await c.query<{ request_id: string | null }>("SELECT request_id FROM recruit_jobs WHERE id = $1::uuid FOR UPDATE", [jobId])).rows[0];
      if (!job) return { rollback: { kind: "not_found" } };
      // Applications belong to the request the job had when people applied; apply holds the job FOR SHARE, so this count is current.
      if (input.requestId.toLowerCase() !== job.request_id && (await c.query("SELECT 1 FROM recruit_job_applications WHERE job_id = $1::uuid LIMIT 1", [jobId])).rowCount) {
        return { rollback: { kind: "request_locked" } };
      }
      const refused = await this.#checkRefs(c, input);
      if (refused) return { rollback: { kind: refused } };
      await c.query(`UPDATE recruit_jobs SET request_id = $2::uuid, area_id = $3::uuid, position = $4, position_ar = $5, description = $6, description_ar = $7, hours_per_day = $8, days_per_week = $9,
        compensation_type = $10, compensation_amount = $11, compensation_description = $12, compensation_description_ar = $13, min_age = $14, max_age = $15, gender = $16,
        available_from = $17::date, available_to = $18::date, status = $19, skills = $20::text[], updated_by_principal_id = $21::text, updated_at = clock_timestamp() WHERE id = $1::uuid`,
        [jobId, ...PostgresRecruitJobsStore.#values(input), principalId]);
      return { kind: "saved", jobId };
    });
  }

  /** The board: active jobs the candidate has not applied to, or (applied) every job they applied to, newest first; null for a non-candidate. */
  async board(personId: string, query: { q: string | null; applied: boolean; page: number }): Promise<{ jobs: RecruitJobRecord[]; total: number } | null> {
    if (!this.options.candidateDecision(await this.#grants(this.#pool, personId))) return null;
    const like = query.q ? `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const where = `WHERE ${query.applied ? "a.id IS NOT NULL" : "j.status = 'active' AND a.id IS NULL"}
      AND ($2::text IS NULL OR j.position ILIKE $2 OR j.position_ar ILIKE $2 OR j.description ILIKE $2 OR j.description_ar ILIKE $2)`;
    const from = `${JOB_FROM} LEFT JOIN recruit_job_applications a ON a.job_id = j.id AND a.person_principal_id = $1::text`;
    const [rows, total] = await Promise.all([
      this.#pool.query<RecruitJobRecord>(`SELECT ${JOB_COLUMNS}, a.status AS application_status, 0 AS applications FROM ${from} ${where} ORDER BY j.created_at DESC, j.id LIMIT $3 OFFSET $4`,
        [personId, like, this.options.pageSize, (query.page - 1) * this.options.pageSize]),
      this.#pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${from} ${where}`, [personId, like]),
    ]);
    return { jobs: rows.rows, total: Number(total.rows[0]!.n) };
  }

  /** One job: staff see any; candidates see an active job or one they applied to; anyone else nothing. */
  async get(principalId: string, jobId: string): Promise<{ job: RecruitJobRecord; staff: boolean } | null> {
    const [grants, row] = await Promise.all([
      this.#grants(this.#pool, principalId),
      this.#pool.query<RecruitJobRecord>(`SELECT ${JOB_COLUMNS}, a.status AS application_status, (SELECT count(*)::int FROM recruit_job_applications x WHERE x.job_id = j.id) AS applications
        FROM ${JOB_FROM} LEFT JOIN recruit_job_applications a ON a.job_id = j.id AND a.person_principal_id = $2::text WHERE j.id = $1::uuid`, [jobId, principalId]),
    ]);
    const job = row.rows[0], staff = this.options.staffDecision(grants);
    if (!job || !(staff || (this.options.candidateDecision(grants) && (job.status === "active" || job.application_status)))) return null;
    return { job: staff ? job : { ...job, applications: 0 }, staff };
  }

  async apply(personId: string, jobId: string, note: string | null): Promise<RecruitApplyResult> {
    return this.#transaction<RecruitApplyResult>(async (c) => {
      if (!this.options.candidateDecision(await this.#grants(c, personId, true))) return { rollback: { kind: "not_found" } };
      const job = (await c.query<{ status: JobStatus }>("SELECT status FROM recruit_jobs WHERE id = $1::uuid FOR SHARE", [jobId])).rows[0];
      const existing = (await c.query<{ id: string }>("SELECT id FROM recruit_job_applications WHERE job_id = $1::uuid AND person_principal_id = $2::text", [jobId, personId])).rows[0];
      if (!job || (job.status === "draft" && !existing)) return { rollback: { kind: "not_found" } };
      if (existing) return { rollback: { kind: "duplicate", applicationId: existing.id } };
      if (!this.options.acceptsApplications(job.status)) return { rollback: { kind: "job_closed" } };
      const id = randomUUID();
      const inserted = await c.query("INSERT INTO recruit_job_applications(id, job_id, person_principal_id, note) VALUES($1::uuid, $2::uuid, $3::text, $4) ON CONFLICT (job_id, person_principal_id) DO NOTHING", [id, jobId, personId, note]);
      if (inserted.rowCount !== 1) {
        const raced = (await c.query<{ id: string }>("SELECT id FROM recruit_job_applications WHERE job_id = $1::uuid AND person_principal_id = $2::text", [jobId, personId])).rows[0]!;
        return { rollback: { kind: "duplicate", applicationId: raced.id } };
      }
      return { kind: "applied", applicationId: id };
    });
  }

  /** Staff: every job, newest first, filtered by status or request, with its application count. */
  async staffList(principalId: string, filter: { status: JobStatus | null; requestId: string | null }): Promise<RecruitJobRecord[] | null> {
    if (!await this.#staff(this.#pool, principalId)) return null;
    return (await this.#pool.query<RecruitJobRecord>(`SELECT ${JOB_COLUMNS}, NULL AS application_status, (SELECT count(*)::int FROM recruit_job_applications x WHERE x.job_id = j.id) AS applications
      FROM ${JOB_FROM} WHERE ($1::text IS NULL OR j.status = $1) AND ($2::uuid IS NULL OR j.request_id = $2::uuid) ORDER BY j.created_at DESC, j.id LIMIT 500`, [filter.status, filter.requestId])).rows;
  }

  async applications(principalId: string, jobId: string): Promise<RecruitJobApplicationRecord[] | null> {
    if (!await this.#staff(this.#pool, principalId)) return null;
    if (!(await this.#pool.query("SELECT 1 FROM recruit_jobs WHERE id = $1::uuid", [jobId])).rowCount) return null;
    return (await this.#pool.query<RecruitJobApplicationRecord>(`SELECT a.id, a.person_principal_id, COALESCE(pp.display_name, p.display_name) AS person_name, a.status, a.note, a.created_at, a.decided_at
      FROM recruit_job_applications a JOIN principals p ON p.id = a.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = a.person_principal_id
      WHERE a.job_id = $1::uuid ORDER BY a.created_at, a.id`, [jobId])).rows;
  }

  async decide(principalId: string, applicationId: string, to: ApplicationStatus): Promise<RecruitDecideResult> {
    return this.#transaction<RecruitDecideResult>(async (c) => {
      if (!await this.#staff(c, principalId, true)) return { rollback: { kind: "not_found" } };
      const row = (await c.query<{ status: ApplicationStatus; person_principal_id: string; request_id: string }>(
        "SELECT a.status, a.person_principal_id, j.request_id FROM recruit_job_applications a JOIN recruit_jobs j ON j.id = a.job_id WHERE a.id = $1::uuid FOR UPDATE OF a", [applicationId])).rows[0];
      if (!row) return { rollback: { kind: "not_found" } };
      if (!this.options.transitionAllowed(row.status, to)) return { rollback: { kind: "refused", status: row.status } };
      await c.query("UPDATE recruit_job_applications SET status = $2::text, decided_at = clock_timestamp(), decided_by_principal_id = $3::text WHERE id = $1::uuid", [applicationId, to, principalId]);
      const event = this.options.outbox(to, applicationId, row.person_principal_id);
      if (event) await c.query("INSERT INTO recruit_outbox(kind, recipient_principal_id, request_id, subject_id, dedupe_key) VALUES($1::text, $2::text, $3::uuid, $4::uuid, $5::text) ON CONFLICT (dedupe_key) DO NOTHING",
        [event.kind, event.recipient, row.request_id, applicationId, event.dedupeKey]);
      return { kind: "decided", status: to };
    });
  }
}
