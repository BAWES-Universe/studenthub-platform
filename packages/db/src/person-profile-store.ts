import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef, SAFE_WRITE_OPERATION, safeWritePrincipalRef } from "./safe-write-store.js";

export const PERSON_PROFILE_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "nationality", "university", "drivingLicence", "kuwaitiMother", "jobSearchStatus"] as const;
export type PersonProfileField = (typeof PERSON_PROFILE_FIELDS)[number];
const COLUMNS: Record<PersonProfileField, string> = {
  displayName: "display_name", arabicName: "arabic_name", objective: "objective", intro: "introduction", preferredTime: "preferred_time",
  gender: "gender", birthDate: "birth_date", nationality: "nationality_id", university: "university_id", drivingLicence: "driving_licence", kuwaitiMother: "kuwaiti_mother", jobSearchStatus: "job_search_status",
};
const REFERENCE = /^[0-9a-f]{64}$/;
const tokenRef = (value: string) => createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(value).digest("hex");

class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); } }

export class PostgresPersonProfileStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;
  constructor(options: { readonly connectionString?: string; readonly pool?: pg.Pool } = {}) {
    this.#ownsPool = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#ownsPool) await this.#pool.end(); }

  forPrincipal(principalId: string): SafeWriteStore {
    if (!principalId) throw new TypeError("principal id required");
    const principalRef = safeWritePrincipalRef(principalId), personRef = personRecordRef(principalId);
    return {
      ownedRecord: async ref => ref === principalRef && await this.#exists(this.#pool, principalId) ? personRef : null,
      readField: async (record, field) => record === personRef && PERSON_PROFILE_FIELDS.includes(field as PersonProfileField)
        ? this.#readField(principalId, field as PersonProfileField) : null,
      commit: async input => input.principalRef === principalRef && input.personRef === personRef
        ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    };
  }

  async readOwnPreferences(principalId: string) {
    if (!principalId) throw new TypeError("principal id required");
    const { rows } = await this.#pool.query(
      `SELECT pp.display_name, pp.display_name_written_at, pp.arabic_name, pp.arabic_name_written_at,
              pp.objective, pp.objective_written_at, pp.introduction, pp.introduction_written_at,
              pp.preferred_time, pp.preferred_time_written_at,
              pp.gender, pp.gender_written_at, pp.birth_date::text birth_date, pp.birth_date_written_at,
              pp.nationality_id, pp.nationality_written_at, c.name nationality_name, c.code nationality_code,
              pp.university_id, pp.university_written_at, u.name university_name,
              pp.driving_licence::text driving_licence, pp.driving_licence_written_at,
              pp.kuwaiti_mother::text kuwaiti_mother, pp.kuwaiti_mother_written_at,
              pp.job_search_status, pp.job_search_status_written_at
         FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id=p.id
         LEFT JOIN catalogue_items c ON c.id=pp.nationality_id
         LEFT JOIN catalogue_items u ON u.id=pp.university_id WHERE p.id=$1`, [principalId]);
    const row = rows[0];
    if (!row) return null;
    const result: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(COLUMNS)) {
      const at = row[`${column}_written_at`];
      if (at instanceof Date) result[field] = Object.freeze({ value: row[column], updatedAt: at.toISOString(),
        ...(field === "nationality" ? { id: row.nationality_id, name: row.nationality_name, code: row.nationality_code } : {}),
        ...(field === "university" ? { id: row.university_id, name: row.university_name } : {}) });
    }
    return Object.freeze(result);
  }

  async readProfileChoices() {
    const { rows } = await this.#pool.query(`SELECT id,catalogue_type AS type,name,code FROM catalogue_items
      WHERE status='active' AND catalogue_type IN ('country','university') ORDER BY catalogue_type,normalized_name COLLATE "C",id`);
    return Object.freeze({ countries: Object.freeze(rows.filter(r => r.type === "country")), universities: Object.freeze(rows.filter(r => r.type === "university")) });
  }

  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const { rows } = await this.#pool.query(`SELECT request_ref, actor_principal_ref, after_summary FROM authorization_mutation_audit
      WHERE operation=$1 AND request_ref=$2 AND target_principal_ref=$3`, [SAFE_WRITE_OPERATION, receiptRef, safeWritePrincipalRef(principalId)]);
    const row = rows[0], field = row?.after_summary?.fields?.[0];
    if (!row || !PERSON_PROFILE_FIELDS.includes(field)) return null;
    const receipt = { contractVersion: row.after_summary.contractVersion, receiptRef: row.request_ref,
      personRef: row.after_summary.personRef, principalRef: row.actor_principal_ref,
      changeSetDigest: row.after_summary.changeSetDigest, fields: [field], committedAt: row.after_summary.committedAt };
    if (receipt.personRef !== personRecordRef(principalId) || receipt.principalRef !== principalAuditRef(principalId)
      || !REFERENCE.test(receipt.changeSetDigest)) throw new Error("malformed safe-write receipt");
    return Object.freeze(receipt);
  }

  async #exists(client: pg.Pool | pg.PoolClient, id: string) { return (await client.query("SELECT 1 FROM principals WHERE id=$1", [id])).rows.length === 1; }
  async #readField(id: string, field: PersonProfileField) {
    const { rows } = await this.#pool.query(`SELECT ${COLUMNS[field]}::text AS value FROM person_profiles WHERE principal_id=$1`, [id]);
    return rows[0]?.value ?? null;
  }
  async #commit(id: string, input: CommitInput): Promise<CommitOutcome> {
    const field = input.field as PersonProfileField, column = COLUMNS[field];
    if (!column || input.receipt.personRef !== input.personRef || input.receipt.principalRef !== input.principalRef
      || input.receipt.changeSetDigest !== input.changeSetDigest || input.receipt.fields.length !== 1 || input.receipt.fields[0] !== field)
      throw new TypeError("inconsistent safe-write commit");
    const client = await this.#pool.connect(), spent = tokenRef(input.tokenId);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5959))", [id]);
      if ((await client.query(`SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2`, [SAFE_WRITE_OPERATION, spent])).rows.length) throw new Refusal("token_already_used");
      if (!await this.#exists(client, id)) throw new Refusal("not_own_record");
      const current = (await client.query(`SELECT ${column}::text AS value FROM person_profiles WHERE principal_id=$1 FOR UPDATE`, [id])).rows[0]?.value ?? null;
      if (current !== input.expectedBefore) throw new Refusal("state_changed");
      if (field === "nationality" || field === "university") {
        const type = field === "nationality" ? "country" : "university";
        if (input.value !== "" && !(await client.query("SELECT 1 FROM catalogue_items WHERE id=$1 AND catalogue_type=$2 AND status='active'", [input.value,type])).rowCount) throw new Refusal("invalid_value");
      }
      if (field === "nationality") {
        const kw = input.value !== "" && (await client.query("SELECT 1 FROM catalogue_items WHERE id=$1 AND catalogue_type='country' AND code='KW'",[input.value])).rowCount;
        if (kw) await client.query("UPDATE person_profiles SET kuwaiti_mother=NULL,kuwaiti_mother_written_at=clock_timestamp() WHERE principal_id=$1",[id]);
      }
      const stored = input.value === "" ? null : (field === "drivingLicence" || field === "kuwaitiMother" ? input.value === "true" : input.value);
      await client.query(`INSERT INTO person_profiles (principal_id, ${column}, ${column}_written_at) VALUES ($1,$2,clock_timestamp())
        ON CONFLICT (principal_id) DO UPDATE SET ${column}=EXCLUDED.${column}, ${column}_written_at=EXCLUDED.${column}_written_at`, [id, stored]);
      await client.query(`INSERT INTO authorization_mutation_audit (request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
        VALUES ($1,$2,$3,$2,'{}',$4::jsonb,$5::jsonb)`, [input.receipt.receiptRef, input.receipt.principalRef, SAFE_WRITE_OPERATION,
        JSON.stringify({ valuePresent: current !== null }), JSON.stringify({ contractVersion: input.receipt.contractVersion, personRef: input.receipt.personRef,
          changeSetDigest: input.receipt.changeSetDigest, fields: [field], committedAt: input.receipt.committedAt, tokenRef: spent })]);
      await client.query("COMMIT"); return { ok: true };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      const databaseError = error as { code?: unknown; constraint?: unknown };
      if (databaseError.code === "23505" && databaseError.constraint === "authorization_mutation_audit_safe_write_token") {
        return { ok: false, reason: "token_already_used" };
      }
      if (databaseError.code === "23514") return { ok: false, reason: "invalid_value" };
      throw error;
    }
    finally { client.release(); }
  }
}
