import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef } from "./safe-write-store.js";

const REF = /^[0-9a-f]{64}$/;
const PROFILE_EDIT_FIELDS = ["display_name", "arabic_name", "objective", "introduction", "preferred_time"] as const;
type ProfileEditField = typeof PROFILE_EDIT_FIELDS[number];
const column = (field: ProfileEditField):string => field;
const updated = (field: ProfileEditField) => `${column(field)}_updated_at`;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(id).digest("hex");
class Refusal extends Error { constructor(readonly reason: "token_already_used"|"not_own_record"|"state_changed") { super(reason); } }

export class PostgresPersonProfileStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) { this.#owns=!options.pool; this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()}); }
  async close(){ if(this.#owns) await this.#pool.end(); }
  forPrincipal(id:string): SafeWriteStore {
    const principalRef=principalAuditRef(id), personRef=personRecordRef(id);
    return {
      ownedRecord: async ref => ref===principalRef && (await this.#pool.query("SELECT 1 FROM principals WHERE id=$1",[id])).rowCount===1 ? personRef:null,
      readField: async (record,field) => record===personRef && (PROFILE_EDIT_FIELDS as readonly string[]).includes(field) ? this.#read(id,field as ProfileEditField):null,
      commit: async input => input.principalRef===principalRef&&input.personRef===personRef ? this.#commit(id,input):{ok:false,reason:"not_own_record"},
    };
  }
  async #read(id:string,field:ProfileEditField):Promise<string|null>{const c=column(field);const r=await this.#pool.query(`SELECT ${c} FROM person_profiles WHERE principal_id=$1`,[id]);return r.rows[0]?.[c]??null;}
  async readOwnPreferences(id:string):Promise<(Record<string,unknown>&{language:unknown;updatedAt:string})|null>{
    const r=await this.#pool.query(`SELECT p.language,p.updated_at AS language_updated_at,q.* FROM principals own LEFT JOIN person_preferences p ON p.principal_id=own.id LEFT JOIN person_profiles q ON q.principal_id=own.id WHERE own.id=$1`,[id]);
    const x=r.rows[0]; if(!x||(!x.language_updated_at&&!x.display_name_updated_at&&!x.arabic_name_updated_at&&!x.objective_updated_at&&!x.introduction_updated_at&&!x.preferred_time_updated_at))return null; return Object.freeze({ language:x.language, updatedAt:x.language_updated_at?.toISOString()??"", displayName:x.display_name,displayNameWritten:x.display_name_updated_at!==null,displayNameUpdatedAt:x.display_name_updated_at?.toISOString(),arabicName:x.arabic_name,arabicNameWritten:x.arabic_name_updated_at!==null,arabicNameUpdatedAt:x.arabic_name_updated_at?.toISOString(),objective:x.objective,objectiveWritten:x.objective_updated_at!==null,objectiveUpdatedAt:x.objective_updated_at?.toISOString(),intro:x.introduction,introWritten:x.introduction_updated_at!==null,introUpdatedAt:x.introduction_updated_at?.toISOString(),preferredTime:x.preferred_time,preferredTimeWritten:x.preferred_time_updated_at!==null,preferredTimeUpdatedAt:x.preferred_time_updated_at?.toISOString() });
  }
  async readReceipt(id:string,ref:string):Promise<Receipt|null>{if(!REF.test(ref))return null;const r=await this.#pool.query(`SELECT request_ref,actor_principal_ref,after_summary FROM authorization_mutation_audit WHERE operation='profile.safe_write' AND request_ref=$1 AND target_principal_ref=$2`,[ref,principalAuditRef(id)]);const x=r.rows[0];if(!x||!Array.isArray(x.after_summary?.fields)||x.after_summary.fields.length!==1||!(PROFILE_EDIT_FIELDS as readonly string[]).includes(x.after_summary.fields[0]))return null;return Object.freeze({contractVersion:x.after_summary.contractVersion,receiptRef:x.request_ref,personRef:x.after_summary.personRef,principalRef:x.actor_principal_ref,changeSetDigest:x.after_summary.changeSetDigest,fields:Object.freeze(x.after_summary.fields),committedAt:x.after_summary.committedAt});}
  async #commit(id:string,input:CommitInput):Promise<CommitOutcome>{
    if(!(PROFILE_EDIT_FIELDS as readonly string[]).includes(input.field)||input.receipt.fields[0]!==input.field)throw new TypeError("inconsistent safe-write commit");
    const field=input.field as ProfileEditField,c=column(field),u=updated(field),client=await this.#pool.connect();try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5959))",[id]);if((await client.query(`SELECT 1 FROM authorization_mutation_audit WHERE operation='profile.safe_write' AND after_summary->>'tokenRef'=$1`,[tokenRef(input.tokenId)])).rowCount)throw new Refusal("token_already_used");if(!(await client.query("SELECT 1 FROM principals WHERE id=$1",[id])).rowCount)throw new Refusal("not_own_record");const v=input.value===""?null:input.value;const w=await client.query(`INSERT INTO person_profiles(principal_id,${c},${u}) VALUES($1,$2,clock_timestamp()) ON CONFLICT(principal_id) DO UPDATE SET ${c}=EXCLUDED.${c},${u}=clock_timestamp() WHERE person_profiles.${c} IS NOT DISTINCT FROM $3 RETURNING 1`,[id,v,input.expectedBefore]);if(!w.rowCount)throw new Refusal("state_changed");await client.query(`INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,'profile.safe_write',$2,'{}',$3::jsonb,$4::jsonb)`,[input.receipt.receiptRef,input.receipt.principalRef,JSON.stringify({valuePresent:input.expectedBefore!==null}),JSON.stringify({contractVersion:input.receipt.contractVersion,personRef:input.receipt.personRef,changeSetDigest:input.changeSetDigest,fields:[field],committedAt:input.receipt.committedAt,tokenRef:tokenRef(input.tokenId)})]);await client.query("COMMIT");return{ok:true};}catch(e){await client.query("ROLLBACK").catch(()=>{});if(e instanceof Refusal)return{ok:false,reason:e.reason};if((e as {code?:string}).code==="23514")return{ok:false,reason:"state_changed"};throw e;}finally{client.release();}}
}
