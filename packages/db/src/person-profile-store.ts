import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef } from "./safe-write-store.js";

export const PERSON_PROFILE_OPERATION = "profile.safe_write" as const;
export const PERSON_PROFILE_FIELDS = ["name","name_ar","objective","intro","preferred_time"] as const;
export type PersonProfileField = typeof PERSON_PROFILE_FIELDS[number];
const REF = /^[0-9a-f]{64}$/;
const column: Record<PersonProfileField, string> = { name:"name", name_ar:"name_ar", objective:"objective", intro:"intro", preferred_time:"preferred_time" };
const tokenRef=(id:string)=>createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(id).digest("hex");
class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome,{ok:true}>["reason"]){super(reason)} }

export interface PersonProfileRead { readonly [key:string]: unknown; readonly updatedAtByField: Readonly<Record<string,string>> }
export class PostgresPersonProfileStore {
  readonly #pool:pg.Pool; readonly #owns:boolean;
  constructor(options:{connectionString?:string;pool?:pg.Pool}={}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()})}
  async close(){if(this.#owns)await this.#pool.end()}
  forPrincipal(id:string):SafeWriteStore { const principalRef=principalAuditRef(id),personRef=personRecordRef(id); return {
    ownedRecord:async ref=>ref===principalRef&&(await this.#exists(this.#pool,id))?personRef:null,
    readField:async(ref,field)=>ref===personRef&&PERSON_PROFILE_FIELDS.includes(field as PersonProfileField)?this.#readField(this.#pool,id,field as PersonProfileField):null,
    commit:async input=>input.principalRef===principalRef&&input.personRef===personRef?this.#commit(id,input):{ok:false,reason:"not_own_record"},
  }}
  async #exists(c:pg.Pool|pg.PoolClient,id:string){return (await c.query("SELECT 1 FROM principals WHERE id=$1",[id])).rowCount===1}
  async #readField(c:pg.Pool|pg.PoolClient,id:string,field:PersonProfileField):Promise<string|null>{const q=await c.query(`SELECT ${column[field]} AS value, ${column[field]}_written AS written FROM person_profiles WHERE principal_id=$1`,[id]);return q.rows[0]?.written?(q.rows[0].value??""):null}
  async readOwnPreferences(id:string):Promise<any>{const q=await this.#pool.query("SELECT * FROM person_profiles WHERE principal_id=$1",[id]);const r=q.rows[0];if(!r)return null;const result:any={updatedAtByField:{}};for(const f of PERSON_PROFILE_FIELDS){if(r[`${f}_written`]){result[f]=r[f];result.updatedAtByField[f]=r[`${f}_updated_at`].toISOString()}}return Object.freeze(result)}
  async readReceipt(id:string,ref:string):Promise<Receipt|null>{if(!REF.test(ref))return null;const q=await this.#pool.query("SELECT request_ref,actor_principal_ref,after_summary FROM authorization_mutation_audit WHERE operation=$1 AND request_ref=$2 AND target_principal_ref=$3",[PERSON_PROFILE_OPERATION,ref,principalAuditRef(id)]);const r=q.rows[0];if(!r)return null;const a=r.after_summary;if(!a||a.personRef!==personRecordRef(id)||!Array.isArray(a.fields)||a.fields.length!==1||!PERSON_PROFILE_FIELDS.includes(a.fields[0]))throw new Error("malformed receipt");return Object.freeze({contractVersion:a.contractVersion,receiptRef:r.request_ref,personRef:a.personRef,principalRef:r.actor_principal_ref,changeSetDigest:a.changeSetDigest,fields:Object.freeze(a.fields),committedAt:a.committedAt}) as Receipt}
  async #commit(id:string,input:CommitInput):Promise<CommitOutcome>{const field=input.field as PersonProfileField;if(!PERSON_PROFILE_FIELDS.includes(field)||input.receipt.fields[0]!==field||input.receipt.changeSetDigest!==input.changeSetDigest)throw new TypeError("inconsistent commit");const c=await this.#pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5959))",[id]);if(!await this.#exists(c,id))throw new Refusal("not_own_record");if((await c.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2",[PERSON_PROFILE_OPERATION,tokenRef(input.tokenId)])).rowCount)throw new Refusal("token_already_used");const before=await this.#readField(c,id,field);if(before!==input.expectedBefore)throw new Refusal("state_changed");const value=input.value===""?null:input.value;await c.query(`INSERT INTO person_profiles(principal_id,${column[field]},${column[field]}_written,${column[field]}_updated_at) VALUES($1,$2,true,clock_timestamp()) ON CONFLICT(principal_id) DO UPDATE SET ${column[field]}=EXCLUDED.${column[field]},${column[field]}_written=true,${column[field]}_updated_at=clock_timestamp()`,[id,value]);await c.query("INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,'{}', $4::jsonb,$5::jsonb)",[input.receipt.receiptRef,input.receipt.principalRef,PERSON_PROFILE_OPERATION,JSON.stringify({valuePresent:input.expectedBefore!==null}),JSON.stringify({contractVersion:input.receipt.contractVersion,personRef:input.receipt.personRef,changeSetDigest:input.receipt.changeSetDigest,fields:[field],committedAt:input.receipt.committedAt,tokenRef:tokenRef(input.tokenId)})]);await c.query("COMMIT");return{ok:true}}catch(e){try{await c.query("ROLLBACK")}catch{}if(e instanceof Refusal)return{ok:false,reason:e.reason};if((e as any)?.code==="23505")return{ok:false,reason:"token_already_used"};throw e}finally{c.release()}}
}
