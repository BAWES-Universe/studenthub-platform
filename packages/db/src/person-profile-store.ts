import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef, SAFE_WRITE_OPERATION, safeWritePrincipalRef } from "./safe-write-store.js";

const SELF_EDIT_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime"] as const;
type SelfEditField = typeof SELF_EDIT_FIELDS[number];
const SELF_EDIT_CLEAR = "\0";

const COLUMNS: Readonly<Record<SelfEditField, string>> = Object.freeze({
  displayName: "display_name", arabicName: "arabic_name", objective: "objective",
  intro: "introduction", preferredTime: "preferred_time",
});
const REFERENCE = /^[0-9a-f]{64}$/;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(id).digest("hex");
class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome, {ok:true}>["reason"]) { super(reason); } }

export class PostgresPersonProfileStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { readonly connectionString?: string; readonly pool?: pg.Pool } = {}) {
    this.#owns = !options.pool; this.#pool = options.pool ?? new pg.Pool({connectionString: options.connectionString ?? databaseUrl()});
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }
  forPrincipal(principalId: string): SafeWriteStore {
    const principalRef = safeWritePrincipalRef(principalId), personRef = personRecordRef(principalId);
    return {
      ownedRecord: async ref => ref === principalRef && await this.#exists(this.#pool, principalId) ? personRef : null,
      readField: async (record, field) => record === personRef && SELF_EDIT_FIELDS.includes(field as SelfEditField)
        ? this.#read(this.#pool, principalId, field as SelfEditField) : null,
      commit: async input => input.principalRef === principalRef && input.personRef === personRef
        ? this.#commit(principalId, input) : {ok:false, reason:"not_own_record"},
    };
  }
  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const {rows} = await this.#pool.query(`SELECT request_ref,actor_principal_ref,after_summary FROM authorization_mutation_audit WHERE operation=$1 AND request_ref=$2 AND target_principal_ref=$3`, [SAFE_WRITE_OPERATION,receiptRef,safeWritePrincipalRef(principalId)]);
    const row=rows[0]; if(!row) return null; const s=row.after_summary;
    if(row.actor_principal_ref!==safeWritePrincipalRef(principalId)||s?.personRef!==personRecordRef(principalId)
      ||typeof s?.contractVersion!=="string"||!/^\d+\.\d+\.\d+$/.test(s.contractVersion)
      ||typeof s?.changeSetDigest!=="string"||!REFERENCE.test(s.changeSetDigest)
      ||typeof s?.committedAt!=="string"||!Number.isFinite(Date.parse(s.committedAt))
      ||!Array.isArray(s?.fields)||s.fields.length!==1||typeof s.fields[0]!=="string") throw new Error("malformed profile receipt");
    // profile.safe_write is shared with the language card. A valid receipt for
    // that route is deliberately indistinguishable from an unknown reference.
    if(s.fields[0]==="language") return null;
    if(!SELF_EDIT_FIELDS.includes(s.fields[0] as SelfEditField)) throw new Error("malformed profile receipt");
    return Object.freeze({contractVersion:s.contractVersion,receiptRef:row.request_ref,personRef:s.personRef,principalRef:row.actor_principal_ref,changeSetDigest:s.changeSetDigest,fields:Object.freeze(s.fields),committedAt:s.committedAt});
  }
  async readOwnPreferences(principalId:string): Promise<Readonly<{language:unknown;updatedAt:string}>|null> {
    const {rows}=await this.#pool.query(`SELECT pp.language,pp.updated_at AS language_updated_at,p.display_name,p.display_name_updated_at,p.arabic_name,p.arabic_name_updated_at,p.objective,p.objective_updated_at,p.introduction,p.introduction_updated_at,p.preferred_time,p.preferred_time_updated_at,p.written_fields FROM principals x LEFT JOIN person_preferences pp ON pp.principal_id=x.id LEFT JOIN person_profiles p ON p.principal_id=x.id WHERE x.id=$1`,[principalId]);
    const row=rows[0]; if(!row)return null;
    const normalized=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]));
    return Object.freeze({...normalized,updatedAt:String(normalized.language_updated_at??"")}) as Readonly<{language:unknown;updatedAt:string}>;
  }
  async #exists(c:pg.Pool|pg.PoolClient,id:string){return (await c.query("SELECT 1 FROM principals WHERE id=$1",[id])).rows.length===1;}
  async #read(c:pg.Pool|pg.PoolClient,id:string,field:SelfEditField):Promise<string|null>{const col=COLUMNS[field];const r=await c.query(`SELECT ${col} AS value FROM person_profiles WHERE principal_id=$1`,[id]);return r.rows[0]?.value??null;}
  async #commit(id:string,input:CommitInput):Promise<CommitOutcome>{
    const field=input.field as SelfEditField;if(!SELF_EDIT_FIELDS.includes(field)||input.receipt.fields.length!==1||input.receipt.fields[0]!==field||input.receipt.changeSetDigest!==input.changeSetDigest||input.receipt.personRef!==input.personRef||input.receipt.principalRef!==input.principalRef)throw new TypeError("inconsistent safe-write commit");
    const col=COLUMNS[field], date=`${col}_updated_at`, spent=tokenRef(input.tokenId), value=input.value===SELF_EDIT_CLEAR?null:input.value, client=await this.#pool.connect();
    try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5959))",[id]);if((await client.query(`SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2`,[SAFE_WRITE_OPERATION,spent])).rows.length)throw new Refusal("token_already_used");if(!await this.#exists(client,id))throw new Refusal("not_own_record");
      const current=await this.#read(client,id,field);if(current!==input.expectedBefore)throw new Refusal("state_changed");
      await client.query(`INSERT INTO person_profiles(principal_id,${col},${date},written_fields) VALUES($1,$2,clock_timestamp(),ARRAY[$3]) ON CONFLICT(principal_id) DO UPDATE SET ${col}=EXCLUDED.${col},${date}=EXCLUDED.${date},written_fields=array(SELECT DISTINCT unnest(person_profiles.written_fields||EXCLUDED.written_fields))`,[id,value,field]);
      await client.query(`INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,'{}', $4::jsonb,$5::jsonb)`,[input.receipt.receiptRef,principalAuditRef(id),SAFE_WRITE_OPERATION,JSON.stringify({valuePresent:input.expectedBefore!==null}),JSON.stringify({contractVersion:input.receipt.contractVersion,personRef:input.receipt.personRef,changeSetDigest:input.changeSetDigest,fields:[field],committedAt:input.receipt.committedAt,tokenRef:spent})]);await client.query("COMMIT");return {ok:true};
    }catch(e){try{await client.query("ROLLBACK");}catch{}if(e instanceof Refusal)return {ok:false,reason:e.reason};if((e as {code?:unknown;constraint?:unknown})?.code==="23505"&&(e as {constraint?:unknown}).constraint==="authorization_mutation_audit_safe_write_token")return {ok:false,reason:"token_already_used"};throw e;}finally{client.release();}
  }
}
