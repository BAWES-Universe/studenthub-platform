import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { databaseUrl } from "./connection.js";
import { personRecordRef, safeWritePrincipalRef, SAFE_WRITE_OPERATION } from "./safe-write-store.js";
const SELF_EDIT_CLEAR = "\u0000studenthub:clear-profile-field";

const SELF_EDIT_FIELDS = ["display_name", "arabic_name", "objective", "intro", "preferred_time"] as const;
type SelfEditField = typeof SELF_EDIT_FIELDS[number];
const COLUMNS: Readonly<Record<SelfEditField, string>> = Object.freeze({ display_name: "candidate_name", arabic_name: "candidate_name_ar", objective: "candidate_objective", intro: "candidate_intro", preferred_time: "candidate_preferred_time" });
const PROPERTIES: Readonly<Record<SelfEditField, string>> = Object.freeze({ display_name: "displayName", arabic_name: "arabicName", objective: "objective", intro: "intro", preferred_time: "preferredTime" });
const UPDATED: Readonly<Record<SelfEditField, string>> = Object.freeze({ display_name: "candidate_name_updated_at", arabic_name: "candidate_name_ar_updated_at", objective: "candidate_objective_updated_at", intro: "candidate_intro_updated_at", preferred_time: "candidate_preferred_time_updated_at" });
const REF = /^[0-9a-f]{64}$/;
const digest = (domain: string, value: string) => createHash("sha256").update(`studenthub:${domain}:v1\0${value}`).digest("hex");
class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); } }

export class PostgresPersonProfileStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) { this.#owns = !options.pool; this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() }); }
  async close() { if (this.#owns) await this.#pool.end(); }
  forPrincipal(principalId: string): SafeWriteStore {
    if (!principalId) throw new TypeError("principal id required");
    const principalRef = safeWritePrincipalRef(principalId), personRef = personRecordRef(principalId);
    return {
      ownedRecord: async ref => ref === principalRef && await this.#exists(this.#pool, principalId) ? personRef : null,
      readField: async (ref, field) => ref === personRef && this.#field(field) ? this.#read(this.#pool, principalId, field) : null,
      commit: async input => input.principalRef === principalRef && input.personRef === personRef ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    };
  }
  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REF.test(receiptRef)) return null;
    const { rows } = await this.#pool.query<{ request_ref:string; actor_principal_ref:string; after_summary:any }>("SELECT request_ref,actor_principal_ref,after_summary FROM authorization_mutation_audit WHERE operation=$1 AND request_ref=$2 AND target_principal_ref=$3", [SAFE_WRITE_OPERATION, receiptRef, safeWritePrincipalRef(principalId)]);
    const row=rows[0], s=row?.after_summary, field=s?.fields?.[0];
    if (!row || !this.#field(field) || s.fields.length !== 1 || row.actor_principal_ref !== safeWritePrincipalRef(principalId) || s.personRef !== personRecordRef(principalId)) return null;
    return Object.freeze({ contractVersion:s.contractVersion, receiptRef:row.request_ref, personRef:s.personRef, principalRef:row.actor_principal_ref, changeSetDigest:s.changeSetDigest, fields:Object.freeze([field]), committedAt:s.committedAt });
  }
  async readOwnPreferences(principalId: string) {
    const { rows } = await this.#pool.query<any>(`SELECT pp.language,pp.updated_at FROM person_preferences pp WHERE pp.principal_id=$1`, [principalId]);
    const profile = await this.#pool.query<any>(`SELECT candidate_name,candidate_name_updated_at,candidate_name_ar,candidate_name_ar_updated_at,candidate_objective,candidate_objective_updated_at,candidate_intro,candidate_intro_updated_at,candidate_preferred_time,candidate_preferred_time_updated_at FROM person_profiles WHERE principal_id=$1`, [principalId]);
    const r=rows[0], p=profile.rows[0]; if (!r && !p) return null;
    const out:any={}; if(r?.updated_at instanceof Date){out.updatedAt=r.updated_at.toISOString();out.language=r.language;}
    for (const f of SELF_EDIT_FIELDS) if (p?.[UPDATED[f]] instanceof Date) out[PROPERTIES[f]]={value:p[COLUMNS[f]],updatedAt:p[UPDATED[f]].toISOString()};
    return Object.freeze(out);
  }
  #field(value: unknown): value is SelfEditField { return typeof value === "string" && (SELF_EDIT_FIELDS as readonly string[]).includes(value); }
  async #exists(c: pg.Pool|pg.PoolClient,id:string){return (await c.query("SELECT 1 FROM principals WHERE id=$1",[id])).rows.length===1;}
  async #read(c:pg.Pool|pg.PoolClient,id:string,field:SelfEditField){const q=await c.query(`SELECT ${COLUMNS[field]} value FROM person_profiles WHERE principal_id=$1`,[id]);return q.rows[0]?.value??null;}
  async #commit(id:string,input:CommitInput):Promise<CommitOutcome>{
    if(!this.#field(input.field)||input.receipt.fields.length!==1||input.receipt.fields[0]!==input.field)throw new TypeError("inconsistent safe-write commit");
    const client=await this.#pool.connect(), field=input.field, column=COLUMNS[field], tokenRef=digest("safe-write-token-ref",input.tokenId);
    try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5959))",[id]);
      if((await client.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2",[SAFE_WRITE_OPERATION,tokenRef])).rows.length)throw new Refusal("token_already_used");
      if(!await this.#exists(client,id))throw new Refusal("not_own_record");
      const stored=input.value===SELF_EDIT_CLEAR?null:input.value;
      const written=input.expectedBefore===null
        ?await client.query(`INSERT INTO person_profiles(principal_id,${column},${UPDATED[field]}) VALUES($1,$2,clock_timestamp()) ON CONFLICT(principal_id) DO UPDATE SET ${column}=EXCLUDED.${column},${UPDATED[field]}=EXCLUDED.${UPDATED[field]},updated_at=clock_timestamp() WHERE person_profiles.${column} IS NULL RETURNING 1`,[id,stored])
        :await client.query(`UPDATE person_profiles SET ${column}=$2,${UPDATED[field]}=clock_timestamp(),updated_at=clock_timestamp() WHERE principal_id=$1 AND ${column}=$3 RETURNING 1`,[id,stored,input.expectedBefore]);
      if(written.rows.length!==1)throw new Refusal("state_changed");
      await client.query(`INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,'{}',$4::jsonb,$5::jsonb)`,[input.receipt.receiptRef,input.receipt.principalRef,SAFE_WRITE_OPERATION,JSON.stringify({valuePresent:input.expectedBefore!==null}),JSON.stringify({contractVersion:input.receipt.contractVersion,personRef:input.receipt.personRef,changeSetDigest:input.receipt.changeSetDigest,fields:[field],committedAt:input.receipt.committedAt,tokenRef})]);
      await client.query("COMMIT");return{ok:true};
    }catch(e){try{await client.query("ROLLBACK");}catch{}if(e instanceof Refusal)return{ok:false,reason:e.reason};if((e as any)?.code==="23505")return{ok:false,reason:"token_already_used"};throw e;}finally{client.release();}
  }
}
