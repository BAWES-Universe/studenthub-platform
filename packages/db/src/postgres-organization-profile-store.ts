import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { organizationAuditRef, principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";

export const ORGANIZATION_PROFILE_OPERATION = "organization.profile.safe_write" as const;
const REFERENCE = /^[0-9a-f]{64}$/;
type OrganizationProfileField = "commonNameEn" | "commonNameAr" | "descriptionEn" | "descriptionAr" | "website";
const FIELD_COLUMNS: Readonly<Record<OrganizationProfileField, string>> = Object.freeze({
  commonNameEn: "common_name_en", commonNameAr: "common_name_ar",
  descriptionEn: "description_en", descriptionAr: "description_ar", website: "website",
});
const domainRef = (domain: string, value: string) => createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex");
export const organizationProfileRecordRef = (orgId: string): string => domainRef("organization-profile-ref", orgId);
const tokenRef = (tokenId: string): string => domainRef("organization-profile-token-ref", tokenId);

class Refusal extends Error {
  constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); }
}

export class PostgresOrganizationProfileStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;
  constructor(options: { readonly connectionString?: string; readonly pool?: pg.Pool } = {}) {
    this.#ownsPool = options.pool === undefined;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  forPrincipal(principalId: string, orgId: string): SafeWriteStore {
    if (!principalId || !orgId) throw new TypeError("principal and organization ids required");
    const principalRef = principalAuditRef(principalId);
    const recordRef = organizationProfileRecordRef(orgId);
    return {
      ownedRecord: async (candidate) => candidate === principalRef && await this.#isOwner(this.#pool, principalId, orgId) ? recordRef : null,
      readField: async (candidate, field) => candidate === recordRef && this.#column(field) ? this.#read(this.#pool, orgId, field as OrganizationProfileField) : null,
      commit: async (input) => input.principalRef === principalRef && input.personRef === recordRef
        ? this.#commit(principalId, orgId, input) : { ok: false, reason: "not_own_record" },
    };
  }

  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const { rows } = await this.#pool.query<{ request_ref: string; actor_principal_ref: string; after_summary: Record<string, unknown> }>(
      `SELECT request_ref, actor_principal_ref, after_summary FROM authorization_mutation_audit
       WHERE operation = $1 AND request_ref = $2 AND actor_principal_ref = $3`,
      [ORGANIZATION_PROFILE_OPERATION, receiptRef, principalAuditRef(principalId)],
    );
    const row = rows[0]; if (!row) return null;
    const a = row.after_summary;
    if (a.receiptRef !== undefined || typeof a.contractVersion !== "string" || typeof a.personRef !== "string"
      || typeof a.changeSetDigest !== "string" || !Array.isArray(a.fields) || typeof a.committedAt !== "string") {
      throw new Error("malformed organization profile receipt");
    }
    return { contractVersion: a.contractVersion, receiptRef: row.request_ref, personRef: a.personRef,
      principalRef: row.actor_principal_ref, changeSetDigest: a.changeSetDigest,
      fields: a.fields as string[], committedAt: a.committedAt };
  }

  #column(field: string): string | undefined { return FIELD_COLUMNS[field as OrganizationProfileField]; }
  async #isOwner(client: pg.Pool | pg.PoolClient, principalId: string, orgId: string): Promise<boolean> {
    const { rows } = await client.query("SELECT 1 FROM grants WHERE principal_id=$1 AND org_id=$2 AND role='org-owner'", [principalId, orgId]);
    return rows.length === 1;
  }
  async #read(client: pg.Pool | pg.PoolClient, orgId: string, field: OrganizationProfileField): Promise<string | null> {
    const column = this.#column(field); if (!column) return null;
    const { rows } = await client.query<Record<string, string | null>>(`SELECT ${column} FROM organization_profiles WHERE org_id=$1`, [orgId]);
    return rows[0]?.[column] ?? null;
  }
  async #commit(principalId: string, orgId: string, input: CommitInput): Promise<CommitOutcome> {
    const field = input.field as OrganizationProfileField;
    const column = this.#column(field);
    if (!column || input.receipt.personRef !== input.personRef || input.receipt.principalRef !== input.principalRef
      || input.receipt.fields.length !== 1 || input.receipt.fields[0] !== field) throw new TypeError("inconsistent safe-write commit");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 300))", [orgId]);
      if (!await this.#isOwner(client, principalId, orgId)) throw new Refusal("not_own_record");
      const spent = tokenRef(input.tokenId);
      const used = await client.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2", [ORGANIZATION_PROFILE_OPERATION, spent]);
      if (used.rows.length) throw new Refusal("token_already_used");
      const current = await this.#read(client, orgId, field);
      if (current !== input.expectedBefore) throw new Refusal("state_changed");
      if (input.expectedBefore === null) {
        await client.query(`INSERT INTO organization_profiles (org_id, ${column}) VALUES ($1,$2)
          ON CONFLICT (org_id) DO UPDATE SET ${column}=EXCLUDED.${column}, updated_at=clock_timestamp()`, [orgId, input.value]);
      } else {
        const written = await client.query(`UPDATE organization_profiles SET ${column}=$2, updated_at=clock_timestamp()
          WHERE org_id=$1 AND ${column}=$3 RETURNING 1`, [orgId, input.value, input.expectedBefore]);
        if (written.rows.length !== 1) throw new Refusal("state_changed");
      }
      await client.query(`INSERT INTO authorization_mutation_audit
        (request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
        VALUES ($1,$2,$3,$2,$4::text[],$5::jsonb,$6::jsonb)`, [input.receipt.receiptRef, input.principalRef,
        ORGANIZATION_PROFILE_OPERATION, [organizationAuditRef(orgId)], JSON.stringify({ valuePresent: input.expectedBefore !== null }),
        JSON.stringify({ contractVersion: input.receipt.contractVersion, personRef: input.personRef,
          changeSetDigest: input.changeSetDigest, fields: [field], committedAt: input.receipt.committedAt, tokenRef: spent })]);
      await client.query("COMMIT"); return { ok: true };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      throw error;
    } finally { client.release(); }
  }
}
