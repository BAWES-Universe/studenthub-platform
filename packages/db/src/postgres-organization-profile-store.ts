import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { databaseUrl } from "./connection.js";
import { organizationAuditRef } from "./authorization-audit.js";

export const ORGANIZATION_PROFILE_OPERATION = "organization.profile.safe_write";
const FIELDS = ["name_en", "name_ar", "description_en", "description_ar", "website"] as const;
type Field = (typeof FIELDS)[number];
type Grant = { readonly org_id: string; readonly role: string };
export type OrganizationOwnerDecision = (rows: readonly Grant[], orgId: string) => boolean;
export type OrganizationProfileStateDecision = (current: string | null, expected: string | null) => boolean;

const column: Record<Field, string> = {
  name_en: "name_en", name_ar: "name_ar", description_en: "description_en",
  description_ar: "description_ar", website: "website",
};
const reference = /^[0-9a-f]{64}$/;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:safe-write-token:v1\0").update(id).digest("hex");

export interface PostgresOrganizationProfileStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly ownerDecision: OrganizationOwnerDecision;
  readonly stateDecision: OrganizationProfileStateDecision;
  readonly recordRef: (orgId: string) => string;
  readonly principalRef: (principalId: string) => string;
}

class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); } }

export class PostgresOrganizationProfileStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #options: PostgresOrganizationProfileStoreOptions;
  constructor(options: PostgresOrganizationProfileStoreOptions) {
    this.#options = options; this.#owns = options.pool === undefined;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  forPrincipal(principalId: string, orgId: string): SafeWriteStore {
    const principalRef = this.#options.principalRef(principalId);
    const recordRef = this.#options.recordRef(orgId);
    return {
      ownedRecord: async (candidate) => candidate === principalRef && await this.#ownsOrganization(this.#pool, principalId, orgId) ? recordRef : null,
      readField: async (candidate, field) => candidate === recordRef && FIELDS.includes(field as Field)
        ? this.#read(this.#pool, orgId, field as Field) : null,
      commit: async (input) => input.principalRef === principalRef && input.personRef === recordRef
        ? this.#commit(principalId, orgId, input) : { ok: false, reason: "not_own_record" },
    };
  }

  async readReceipt(principalId: string, orgId: string, receiptRef: string): Promise<Receipt | null> {
    if (!reference.test(receiptRef)) return null;
    const { rows } = await this.#pool.query<{ actor_principal_ref: string; after_summary: Record<string, unknown> }>(
      `SELECT actor_principal_ref, after_summary FROM authorization_mutation_audit
       WHERE operation=$1 AND request_ref=$2 AND actor_principal_ref=$3 AND target_org_refs=$4::text[]`,
      [ORGANIZATION_PROFILE_OPERATION, receiptRef, this.#options.principalRef(principalId), [organizationAuditRef(orgId)]],
    );
    const a = rows[0]?.after_summary; if (!a) return null;
    const receipt = { contractVersion: a.contractVersion, receiptRef, personRef: a.personRef,
      principalRef: rows[0]!.actor_principal_ref, changeSetDigest: a.changeSetDigest,
      fields: a.fields, committedAt: a.committedAt } as Receipt;
    if (receipt.personRef !== this.#options.recordRef(orgId) || !Array.isArray(receipt.fields)
      || receipt.fields.length !== 1 || !FIELDS.includes(receipt.fields[0] as Field)) throw new Error("malformed organization profile receipt");
    return receipt;
  }

  async #grants(client: pg.Pool | pg.PoolClient, principalId: string, lock = false): Promise<Grant[]> {
    const { rows } = await client.query<Grant>(`SELECT org_id, role FROM grants WHERE principal_id=$1${lock ? " FOR SHARE" : ""}`, [principalId]);
    return rows;
  }
  async #ownsOrganization(client: pg.Pool | pg.PoolClient, principalId: string, orgId: string): Promise<boolean> {
    return this.#options.ownerDecision(await this.#grants(client, principalId), orgId);
  }
  async #read(client: pg.Pool | pg.PoolClient, orgId: string, field: Field): Promise<string | null> {
    const { rows } = await client.query<Record<string, string | null>>(`SELECT ${column[field]} FROM organization_profiles WHERE org_id=$1`, [orgId]);
    return rows[0]?.[field] ?? null;
  }
  async #commit(principalId: string, orgId: string, input: CommitInput): Promise<CommitOutcome> {
    if (!FIELDS.includes(input.field as Field) || input.receipt.fields.length !== 1 || input.receipt.fields[0] !== input.field) throw new TypeError("inconsistent organization profile commit");
    const field = input.field as Field; const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 300))", [orgId]);
      const grants = await this.#grants(client, principalId, true);
      if (!this.#options.ownerDecision(grants, orgId)) throw new Refusal("not_own_record");
      const used = await client.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2", [ORGANIZATION_PROFILE_OPERATION, tokenRef(input.tokenId)]);
      if (used.rows.length) throw new Refusal("token_already_used");
      const current = await this.#read(client, orgId, field);
      if (!this.#options.stateDecision(current, input.expectedBefore)) throw new Refusal("state_changed");
      await client.query(
        `INSERT INTO organization_profiles (org_id, ${column[field]}) VALUES ($1,$2)
         ON CONFLICT (org_id) DO UPDATE SET ${column[field]}=EXCLUDED.${column[field]}, updated_at=clock_timestamp()`, [orgId, input.value]);
      await client.query(`INSERT INTO authorization_mutation_audit
        (request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
        VALUES ($1,$2,$3,$2,$4::text[],$5::jsonb,$6::jsonb)`, [input.receipt.receiptRef, input.principalRef,
        ORGANIZATION_PROFILE_OPERATION, [organizationAuditRef(orgId)], JSON.stringify({ valuePresent: current !== null }), JSON.stringify({
          contractVersion: input.receipt.contractVersion, personRef: input.receipt.personRef,
          changeSetDigest: input.changeSetDigest, fields: [field], committedAt: input.receipt.committedAt,
          tokenRef: tokenRef(input.tokenId),
        })]);
      await client.query("COMMIT"); return { ok: true };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      if ((error as { code?: string; constraint?: string }).code === "23505"
        && (error as { constraint?: string }).constraint === "authorization_mutation_audit_organization_profile_token") return { ok: false, reason: "token_already_used" };
      throw error;
    } finally { client.release(); }
  }
}
