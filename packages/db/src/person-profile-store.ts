import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef, SAFE_WRITE_OPERATION, safeWritePrincipalRef } from "./safe-write-store.js";

export const PERSON_PROFILE_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "drivingLicence", "jobSearchStatus", "phone", "handle", "nationality", "university", "kuwaitiMother"] as const;
export type PersonProfileField = (typeof PERSON_PROFILE_FIELDS)[number];
const COLUMNS: Record<PersonProfileField, string> = {
  displayName: "display_name", arabicName: "arabic_name", objective: "objective", intro: "introduction", preferredTime: "preferred_time",
  gender: "gender", birthDate: "birth_date", drivingLicence: "driving_licence", jobSearchStatus: "job_search_status",
  phone: "phone", handle: "profile_handle",
  nationality: "nationality_id", university: "university_id", kuwaitiMother: "kuwaiti_mother",
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

  async contactValueAvailable(principalId: string, field: "phone" | "handle", value: string): Promise<boolean> {
    const column = COLUMNS[field];
    const { rows } = await this.#pool.query(`SELECT NOT EXISTS (SELECT 1 FROM person_profiles WHERE ${column}=$1 AND principal_id<>$2) AS available`, [value, principalId]);
    return rows[0]?.available === true;
  }

  async originValueAvailable(principalId: string, field: "nationality" | "university" | "kuwaitiMother", value: string): Promise<boolean> {
    if (field === "university" && value === "") return true;
    if (field === "kuwaitiMother") {
      if (value !== "" && value !== "true" && value !== "false") return false;
      const { rows } = await this.#pool.query(`SELECT NOT EXISTS (SELECT 1 FROM person_profiles pp JOIN catalogue_items c ON c.id=pp.nationality_id WHERE pp.principal_id=$1 AND c.catalogue_type='country' AND c.code='KW') AS available`, [principalId]);
      return rows[0]?.available === true;
    }
    const type = field === "nationality" ? "country" : "university";
    const { rows } = await this.#pool.query(`SELECT EXISTS (SELECT 1 FROM catalogue_items WHERE id=$1 AND catalogue_type=$2 AND status='active') AS available`, [value, type]);
    return rows[0]?.available === true;
  }

  async readOriginChoices() {
    const { rows } = await this.#pool.query(`SELECT id::text,name,code,catalogue_type FROM catalogue_items WHERE status='active' AND catalogue_type IN ('country','university') ORDER BY catalogue_type,normalized_name COLLATE "C",id`);
    return Object.freeze({
      countries: Object.freeze(rows.filter(row => row.catalogue_type === "country").map(row => Object.freeze({ id: row.id as string, name: row.name as string, code: row.code as string | null }))),
      universities: Object.freeze(rows.filter(row => row.catalogue_type === "university").map(row => Object.freeze({ id: row.id as string, name: row.name as string }))),
    });
  }

  forPrincipal(principalId: string): SafeWriteStore {
    if (!principalId) throw new TypeError("principal id required");
    const principalRef = safeWritePrincipalRef(principalId), personRef = personRecordRef(principalId);
    return {
      contactValueAvailable: (field: "phone" | "handle", value: string) => this.contactValueAvailable(principalId, field, value),
      originValueAvailable: (field: "nationality" | "university" | "kuwaitiMother", value: string) => this.originValueAvailable(principalId, field, value),
      ownedRecord: async ref => ref === principalRef && await this.#exists(this.#pool, principalId) ? personRef : null,
      readField: async (record, field) => record === personRef && PERSON_PROFILE_FIELDS.includes(field as PersonProfileField)
        ? this.#readField(principalId, field as PersonProfileField) : null,
      commit: async input => input.principalRef === principalRef && input.personRef === personRef
        ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    } as SafeWriteStore;
  }

  async readOwnPreferences(principalId: string) {
    if (!principalId) throw new TypeError("principal id required");
    const { rows } = await this.#pool.query(
      `SELECT pp.display_name, pp.display_name_written_at, pp.arabic_name, pp.arabic_name_written_at,
              pp.objective, pp.objective_written_at, pp.introduction, pp.introduction_written_at,
              pp.preferred_time, pp.preferred_time_written_at,
              pp.gender::text, pp.gender_written_at, pp.birth_date::text, pp.birth_date_written_at,
              pp.driving_licence::text, pp.driving_licence_written_at,
              pp.job_search_status::text, pp.job_search_status_written_at,
              pp.phone::text, pp.phone_written_at, pp.profile_handle::text, pp.profile_handle_written_at
              ,pp.nationality_id::text, pp.nationality_id_written_at, nationality.name AS nationality_name
              ,pp.university_id::text, pp.university_id_written_at, university.name AS university_name
              ,pp.kuwaiti_mother::text, pp.kuwaiti_mother_written_at
         FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id=p.id
         LEFT JOIN catalogue_items nationality ON nationality.id=pp.nationality_id AND nationality.catalogue_type='country'
         LEFT JOIN catalogue_items university ON university.id=pp.university_id AND university.catalogue_type='university'
         WHERE p.id=$1`, [principalId]);
    const row = rows[0];
    if (!row) return null;
    const result: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(COLUMNS)) {
      const at = row[`${column}_written_at`];
      if (at instanceof Date) result[field] = Object.freeze({ value: field === "nationality" ? row.nationality_name : field === "university" ? row.university_name : row[column], updatedAt: at.toISOString(), ...((field === "nationality" || field === "university") && row[column] !== null ? { editValue: row[column] } : {}) });
    }
    return Object.freeze(result);
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
        if (field === "university" && input.value === "") { /* None is stored as NULL without a UUID lookup. */ }
        else {
          const type = field === "nationality" ? "country" : "university";
          const selected = (await client.query(`SELECT code FROM catalogue_items WHERE id=$1 AND catalogue_type=$2 AND status='active'`, [input.value, type])).rows[0];
          if (!selected) throw new Refusal("invalid_value");
          if (field === "nationality" && selected.code === "KW") await client.query(`UPDATE person_profiles SET kuwaiti_mother=NULL, kuwaiti_mother_written_at=NULL WHERE principal_id=$1`, [id]);
        }
      }
      if (field === "kuwaitiMother") {
        const kuwaiti = (await client.query(`SELECT 1 FROM person_profiles pp JOIN catalogue_items c ON c.id=pp.nationality_id WHERE pp.principal_id=$1 AND c.catalogue_type='country' AND c.code='KW'`, [id])).rows.length > 0;
        if (kuwaiti) throw new Refusal("invalid_value");
      }
      await client.query(`INSERT INTO person_profiles (principal_id, ${column}, ${column}_written_at) VALUES ($1,$2,clock_timestamp())
        ON CONFLICT (principal_id) DO UPDATE SET ${column}=EXCLUDED.${column}, ${column}_written_at=EXCLUDED.${column}_written_at`, [id, input.value === "" ? null : input.value]);
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
      if (databaseError.code === "23505" && ["person_profiles_phone_uq", "person_profiles_profile_handle_uq"].includes(String(databaseError.constraint))) return { ok: false, reason: "invalid_value" };
      if (databaseError.code === "23514") return { ok: false, reason: "invalid_value" };
      throw error;
    }
    finally { client.release(); }
  }
}
