import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";

// Recruit R9: full-timer records (legacy Fulltimer, FulltimerTags, FulltimerSkill,
// FulltimerExperience). Operator staff and recruiters only. A second live record
// with the same name or phone is refused and the existing one is named, as legacy
// did; the unique indexes settle a race. Records are archived, never deleted.

type Grant = { org_id: string; role: string; scope: string };

export interface RecruitFulltimersStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly staffDecision: (rows: readonly Grant[]) => boolean;
  readonly nameKey: (name: string) => string;
  readonly pageSize: number;
}

export interface RecruitFulltimerInput {
  readonly name: string; readonly phone: string | null; readonly email: string | null; readonly nationalityId: string | null; readonly countryId: string | null; readonly areaId: string | null; readonly universityId: string | null;
  readonly latitude: number | null; readonly longitude: number | null; readonly gender: "male" | "female" | "other" | null; readonly birthDate: string | null; readonly employed: boolean | null; readonly drivingLicence: boolean | null;
  readonly currentSalary: string | null; readonly expectedSalary: string | null; readonly currencyCode: string; readonly tags: readonly string[]; readonly skills: readonly string[]; readonly experience: readonly string[];
  readonly cvReference: string | null;
}
export interface RecruitFulltimerRecord {
  readonly id: string; readonly name: string; readonly phone: string | null; readonly email: string | null; readonly nationality_id: string | null; readonly nationality_name: string | null; readonly country_id: string | null; readonly country_name: string | null;
  readonly area_id: string | null; readonly area_name: string | null; readonly university_id: string | null; readonly university_name: string | null; readonly latitude: string | null; readonly longitude: string | null;
  readonly gender: "male" | "female" | "other" | null; readonly birth_date: string | null; readonly employed: boolean | null; readonly driving_licence: boolean | null; readonly current_salary: string | null; readonly expected_salary: string | null;
  readonly currency_code: string; readonly tags: string[]; readonly skills: string[]; readonly experience: string[]; readonly legacy_cv_reference: string | null; readonly archived_at: string | null; readonly created_at: string; readonly updated_at: string;
}
export interface RecruitFulltimerCardRecord { readonly card_id: string; readonly request_id: string; readonly position_title: string; readonly org_name: string; readonly stage: string }

export type RecruitFulltimerWriteResult = { kind: "saved"; fulltimerId: string } | { kind: "not_found" } | { kind: "duplicate"; field: "name" | "phone"; fulltimerId: string } | { kind: "reference_invalid"; field: string };

const COLUMNS = `f.id, f.name, f.phone, f.email, f.nationality_id, n.name::text AS nationality_name, f.country_id, c.name::text AS country_name, f.area_id, a.name::text AS area_name,
 f.university_id, u.name::text AS university_name, f.latitude::text, f.longitude::text, f.gender, to_char(f.birth_date,'YYYY-MM-DD') AS birth_date, f.employed, f.driving_licence,
 f.current_salary, f.expected_salary, f.currency_code, f.tags, f.skills, f.experience, f.legacy_cv_reference, f.archived_at, f.created_at, f.updated_at`;
const FROM = `recruit_fulltimers f LEFT JOIN catalogue_items n ON n.id = f.nationality_id LEFT JOIN catalogue_items c ON c.id = f.country_id
 LEFT JOIN catalogue_items a ON a.id = f.area_id LEFT JOIN catalogue_items u ON u.id = f.university_id`;
const REFS = [["nationalityId", "country"], ["countryId", "country"], ["areaId", "area"], ["universityId", "university"]] as const;

export class PostgresRecruitFulltimersStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitFulltimersStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #staff(c: pg.Pool | pg.PoolClient, principalId: string, lock = false): Promise<boolean> {
    return this.options.staffDecision((await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text${lock ? " FOR SHARE" : ""}`, [principalId])).rows);
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

  async #check(c: pg.PoolClient, input: RecruitFulltimerInput, self: string | null): Promise<RecruitFulltimerWriteResult | null> {
    for (const [field, type] of REFS) {
      const id = input[field];
      if (id && !(await c.query("SELECT 1 FROM catalogue_items WHERE id = $1::uuid AND catalogue_type = $2::text", [id, type])).rowCount) return { kind: "reference_invalid", field };
    }
    // Serialise duplicate checks on the name key so two creates cannot both pass.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('recruit_fulltimer:' || $1::text))", [this.options.nameKey(input.name)]);
    const byName = (await c.query<{ id: string }>("SELECT id FROM recruit_fulltimers WHERE name_key = $1::text AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)", [this.options.nameKey(input.name), self])).rows[0];
    if (byName) return { kind: "duplicate", field: "name", fulltimerId: byName.id };
    if (input.phone) {
      const byPhone = (await c.query<{ id: string }>("SELECT id FROM recruit_fulltimers WHERE phone = $1::text AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)", [input.phone, self])).rows[0];
      if (byPhone) return { kind: "duplicate", field: "phone", fulltimerId: byPhone.id };
    }
    return null;
  }

  #values(input: RecruitFulltimerInput) {
    return [input.name, this.options.nameKey(input.name), input.phone, input.email, input.nationalityId, input.countryId, input.areaId, input.universityId, input.latitude, input.longitude, input.gender, input.birthDate,
      input.employed, input.drivingLicence, input.currentSalary, input.expectedSalary, input.currencyCode, [...input.tags], [...input.skills], [...input.experience], input.cvReference];
  }

  async create(principalId: string, input: RecruitFulltimerInput): Promise<RecruitFulltimerWriteResult> {
    return this.#transaction<RecruitFulltimerWriteResult>(async (c) => {
      if (!await this.#staff(c, principalId, true)) return { rollback: { kind: "not_found" } };
      const refused = await this.#check(c, input, null);
      if (refused) return { rollback: refused };
      const id = randomUUID();
      await c.query(`INSERT INTO recruit_fulltimers(id, name, name_key, phone, email, nationality_id, country_id, area_id, university_id, latitude, longitude, gender, birth_date, employed, driving_licence,
        current_salary, expected_salary, currency_code, tags, skills, experience, legacy_cv_reference, created_by_principal_id, updated_by_principal_id)
        VALUES($1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::numeric, $11::numeric, $12, $13::date, $14, $15, $16, $17, $18, $19::text[], $20::text[], $21::text[], $22, $23::text, $23::text)`,
        [id, ...this.#values(input), principalId]);
      return { kind: "saved", fulltimerId: id };
    });
  }

  async update(principalId: string, fulltimerId: string, input: RecruitFulltimerInput): Promise<RecruitFulltimerWriteResult> {
    return this.#transaction<RecruitFulltimerWriteResult>(async (c) => {
      if (!await this.#staff(c, principalId, true)) return { rollback: { kind: "not_found" } };
      if (!(await c.query("SELECT 1 FROM recruit_fulltimers WHERE id = $1::uuid FOR UPDATE", [fulltimerId])).rowCount) return { rollback: { kind: "not_found" } };
      const refused = await this.#check(c, input, fulltimerId);
      if (refused) return { rollback: refused };
      await c.query(`UPDATE recruit_fulltimers SET name = $2, name_key = $3, phone = $4, email = $5, nationality_id = $6::uuid, country_id = $7::uuid, area_id = $8::uuid, university_id = $9::uuid,
        latitude = $10::numeric, longitude = $11::numeric, gender = $12, birth_date = $13::date, employed = $14, driving_licence = $15, current_salary = $16, expected_salary = $17, currency_code = $18,
        tags = $19::text[], skills = $20::text[], experience = $21::text[], legacy_cv_reference = $22, updated_by_principal_id = $23::text, updated_at = clock_timestamp() WHERE id = $1::uuid`,
        [fulltimerId, ...this.#values(input), principalId]);
      return { kind: "saved", fulltimerId };
    });
  }

  /** Archive (legacy delete) or restore. Restoring is refused while another live record holds the name or phone. */
  async archive(principalId: string, fulltimerId: string, archived: boolean): Promise<RecruitFulltimerWriteResult> {
    return this.#transaction<RecruitFulltimerWriteResult>(async (c) => {
      if (!await this.#staff(c, principalId, true)) return { rollback: { kind: "not_found" } };
      const row = (await c.query<{ name: string; phone: string | null }>("SELECT name, phone FROM recruit_fulltimers WHERE id = $1::uuid FOR UPDATE", [fulltimerId])).rows[0];
      if (!row) return { rollback: { kind: "not_found" } };
      if (!archived) {
        const refused = await this.#check(c, { name: row.name, phone: row.phone, nationalityId: null, countryId: null, areaId: null, universityId: null } as RecruitFulltimerInput, fulltimerId);
        if (refused) return { rollback: refused };
      }
      await c.query(`UPDATE recruit_fulltimers SET archived_at = ${archived ? "COALESCE(archived_at, clock_timestamp())" : "NULL"}, updated_by_principal_id = $2::text, updated_at = clock_timestamp() WHERE id = $1::uuid`, [fulltimerId, principalId]);
      return { kind: "saved", fulltimerId };
    });
  }

  async list(principalId: string, query: { q: string | null; currency: string; tag: string | null; archived: boolean; page: number }): Promise<{ rows: RecruitFulltimerRecord[]; total: number } | null> {
    if (!await this.#staff(this.#pool, principalId)) return null;
    const like = query.q ? `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const where = `WHERE f.currency_code = $1::text AND (f.archived_at IS NOT NULL) = $2::boolean AND ($3::text IS NULL OR f.name ILIKE $3 OR f.phone ILIKE $3 OR f.email ILIKE $3 OR EXISTS (SELECT 1 FROM unnest(f.skills) s WHERE s ILIKE $3))
      AND ($4::text IS NULL OR $4::text = ANY(f.tags))`;
    const params = [query.currency, query.archived, like, query.tag];
    const [rows, total] = await Promise.all([
      this.#pool.query<RecruitFulltimerRecord>(`SELECT ${COLUMNS} FROM ${FROM} ${where} ORDER BY f.created_at DESC, f.id LIMIT $5 OFFSET $6`, [...params, this.options.pageSize, (query.page - 1) * this.options.pageSize]),
      this.#pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM recruit_fulltimers f ${where}`, params),
    ]);
    return { rows: rows.rows, total: Number(total.rows[0]!.n) };
  }

  async get(principalId: string, fulltimerId: string): Promise<{ fulltimer: RecruitFulltimerRecord; cards: RecruitFulltimerCardRecord[] } | null> {
    if (!await this.#staff(this.#pool, principalId)) return null;
    const row = (await this.#pool.query<RecruitFulltimerRecord>(`SELECT ${COLUMNS} FROM ${FROM} WHERE f.id = $1::uuid`, [fulltimerId])).rows[0];
    if (!row) return null;
    const cards = (await this.#pool.query<RecruitFulltimerCardRecord>(
      `SELECT c.id AS card_id, r.id AS request_id, r.position_title, o.name AS org_name, c.stage FROM recruit_pipeline_cards c JOIN recruit_requests r ON r.id = c.request_id JOIN organizations o ON o.id = r.org_id
       WHERE c.fulltimer_id = $1::uuid ORDER BY c.created_at DESC, c.id`, [fulltimerId])).rows;
    return { fulltimer: row, cards };
  }
}
