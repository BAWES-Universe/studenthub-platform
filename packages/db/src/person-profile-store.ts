import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef, safeWritePrincipalRef, SAFE_WRITE_OPERATION } from "./safe-write-store.js";

export const PERSON_PROFILE_FIELDS = ["display_name", "arabic_name", "objective", "introduction", "preferred_time"] as const;
export type PersonProfileField = typeof PERSON_PROFILE_FIELDS[number];
const FIELD = new Set<string>(PERSON_PROFILE_FIELDS);
const REF = /^[0-9a-f]{64}$/;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(id).digest("hex");
class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); } }

export interface WrittenProfileValue { readonly value: unknown | null; readonly updatedAt: string; }
export type PersonProfilePreferences = Readonly<{ language?: unknown; languageUpdatedAt?: string; displayName?: WrittenProfileValue; arabicName?: WrittenProfileValue; objective?: WrittenProfileValue; intro?: WrittenProfileValue; preferredTime?: WrittenProfileValue }>;

export class PostgresPersonProfileStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) { this.#owns = !options.pool; this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() }); }
  async close() { if (this.#owns) await this.#pool.end(); }
  forPrincipal(principalId: string): SafeWriteStore {
    const principalRef = safeWritePrincipalRef(principalId), personRef = personRecordRef(principalId);
    return {
      ownedRecord: async ref => ref === principalRef && await this.#exists(this.#pool, principalId) ? personRef : null,
      readField: async (ref, field) => ref === personRef && FIELD.has(field) ? this.#readField(principalId, field as PersonProfileField) : null,
      commit: async input => input.principalRef === principalRef && input.personRef === personRef ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    };
  }
  async #exists(client: pg.Pool | pg.PoolClient, id: string) { return (await client.query("SELECT 1 FROM principals WHERE id=$1", [id])).rowCount === 1; }
  async #readField(id: string, field: PersonProfileField): Promise<string | null> {
    const date = `${field}_updated_at`;
    const { rows } = await this.#pool.query<Record<string, unknown>>(`SELECT ${field}, ${date} FROM person_profiles WHERE principal_id=$1`, [id]);
    return rows[0]?.[date] ? (rows[0]?.[field] as string | null) : null;
  }
  async readOwnPreferences(id: string): Promise<PersonProfilePreferences | null> {
    const { rows } = await this.#pool.query<Record<string, unknown>>(`SELECT p.id, l.language, l.updated_at AS language_updated_at, x.*
      FROM principals p LEFT JOIN person_preferences l ON l.principal_id=p.id LEFT JOIN person_profiles x ON x.principal_id=p.id WHERE p.id=$1`, [id]);
    const r = rows[0]; if (!r) return null;
    const out: Record<string, unknown> = {};
    if (r.language_updated_at instanceof Date) { out.language = r.language; out.languageUpdatedAt = r.language_updated_at.toISOString(); }
    for (const [field, key] of [["display_name","displayName"],["arabic_name","arabicName"],["objective","objective"],["introduction","intro"],["preferred_time","preferredTime"]] as const) {
      const at = r[`${field}_updated_at`]; if (at instanceof Date) out[key] = Object.freeze({ value: r[field] ?? null, updatedAt: at.toISOString() });
    }
    return Object.freeze(out) as PersonProfilePreferences;
  }
  async readReceipt(id: string, receiptRef: string): Promise<Receipt | null> {
    if (!REF.test(receiptRef)) return null;
    const { rows } = await this.#pool.query<{request_ref:string;actor_principal_ref:string;after_summary:Record<string,unknown>}>(`SELECT request_ref,actor_principal_ref,after_summary FROM authorization_mutation_audit WHERE operation=$1 AND request_ref=$2 AND target_principal_ref=$3`, [SAFE_WRITE_OPERATION, receiptRef, principalAuditRef(id)]);
    const r=rows[0], s=r?.after_summary, fields=s?.fields;
    if (!r || !Array.isArray(fields) || fields.length!==1 || !FIELD.has(fields[0] as string)) return null;
    const receipt={contractVersion:s.contractVersion,receiptRef:r.request_ref,personRef:s.personRef,principalRef:r.actor_principal_ref,changeSetDigest:s.changeSetDigest,fields,committedAt:s.committedAt};
    if (typeof receipt.contractVersion!=="string"||typeof receipt.personRef!=="string"||typeof receipt.changeSetDigest!=="string"||typeof receipt.committedAt!=="string") return null;
    return Object.freeze(receipt) as Receipt;
  }
  async #commit(id: string, input: CommitInput): Promise<CommitOutcome> {
    if (!FIELD.has(input.field) || input.receipt.fields.length!==1 || input.receipt.fields[0]!==input.field || input.receipt.personRef!==input.personRef || input.receipt.principalRef!==input.principalRef || input.receipt.changeSetDigest!==input.changeSetDigest) throw new TypeError("inconsistent safe-write commit");
    const field=input.field as PersonProfileField, updated=`${field}_updated_at`, spent=tokenRef(input.tokenId), client=await this.#pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5959))",[id]);
      if ((await client.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2",[SAFE_WRITE_OPERATION,spent])).rowCount) throw new Refusal("token_already_used");
      if (!await this.#exists(client,id)) throw new Refusal("not_own_record");
      const value=input.value===""?null:input.value;
      const written=input.expectedBefore===null
        ? await client.query(`INSERT INTO person_profiles(principal_id,${field},${updated}) VALUES($1,$2,clock_timestamp()) ON CONFLICT(principal_id) DO UPDATE SET ${field}=EXCLUDED.${field},${updated}=EXCLUDED.${updated} WHERE person_profiles.${field} IS NULL RETURNING 1`,[id,value])
        : await client.query(`UPDATE person_profiles SET ${field}=$2,${updated}=clock_timestamp() WHERE principal_id=$1 AND ${updated} IS NOT NULL AND ${field} IS NOT DISTINCT FROM $3 RETURNING 1`,[id,value,input.expectedBefore]);
      if (written.rowCount!==1) throw new Refusal("state_changed");
      await client.query(`INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,'{}'::text[], $4::jsonb,$5::jsonb)`,[input.receipt.receiptRef,input.receipt.principalRef,SAFE_WRITE_OPERATION,JSON.stringify({valuePresent:input.expectedBefore!==null}),JSON.stringify({contractVersion:input.receipt.contractVersion,personRef:input.receipt.personRef,changeSetDigest:input.receipt.changeSetDigest,fields:[field],committedAt:input.receipt.committedAt,tokenRef:spent})]);
      await client.query("COMMIT"); return {ok:true};
    } catch(error) { try{await client.query("ROLLBACK");}catch{} if(error instanceof Refusal)return {ok:false,reason:error.reason}; const e=error as {code?:string;constraint?:string}; if(e.code==="23505"&&e.constraint==="authorization_mutation_audit_safe_write_token")return {ok:false,reason:"token_already_used"}; if(e.code==="23514")return {ok:false,reason:"invalid_value"}; throw error; } finally { client.release(); }
  }
}
