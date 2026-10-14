import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import type { PayContractSafeWriteStore, PayContractStore } from "@studenthub/pay-contracts";
import { databaseUrl } from "./connection.js";
import { organizationAuditRef } from "./authorization-audit.js";
import { transactionFor } from "./postgres-pay-contract-store.js";

export const PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION = "pay_contract.create.safe_write";
type Grant = { readonly org_id: string; readonly role: string; readonly scope: string };
type Decision = (rows: readonly Grant[], companyId: string, ancestors: readonly string[]) => boolean;
type Creator = (store: PayContractStore, actorId: string, companyId: string, value: string) => Promise<{ok:true}|{ok:false;reason:"state_changed"}>;
const reference = /^[0-9a-f]{64}$/;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:safe-write-token:v1\0").update(id).digest("hex");
class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome,{ok:true}>["reason"]) { super(reason); } }
export interface PostgresPayContractSafeWriteStoreOptions { readonly connectionString?: string; readonly pool?: pg.Pool; readonly decision: Decision; readonly creator: Creator; readonly recordRef:(id:string)=>string; readonly principalRef:(id:string)=>string }

export class PostgresPayContractSafeWriteStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #o: PostgresPayContractSafeWriteStoreOptions;
  constructor(o: PostgresPayContractSafeWriteStoreOptions) { this.#o=o;this.#owns=!o.pool;this.#pool=o.pool??new pg.Pool({connectionString:o.connectionString??databaseUrl()}); }
  async close(){if(this.#owns)await this.#pool.end();}
  forCompany(id:string,company:string):PayContractSafeWriteStore { const principal=this.#o.principalRef(id),record=this.#o.recordRef(company);return {
    ownedRecord:async p=>p===principal&&await this.#allowed(this.#pool,id,company)?record:null,
    readField:async(p,f)=>p===record&&f==="pay_contract"?null:null,
    commit:async input=>input.principalRef===principal&&input.personRef===record?this.#commit(id,company,input):{ok:false,reason:"not_own_record"},
    tokenUsed:async tokenId=>(await this.#pool.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2",[PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION,tokenRef(tokenId)])).rows.length>0,
  };}
  async readReceipt(id:string,company:string,receiptRef:string):Promise<Receipt|null>{if(!reference.test(receiptRef))return null;const{rows}=await this.#pool.query<{actor_principal_ref:string;after_summary:Record<string,unknown>}>("SELECT actor_principal_ref,after_summary FROM authorization_mutation_audit WHERE operation=$1 AND request_ref=$2 AND actor_principal_ref=$3 AND target_org_refs=$4::text[]",[PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION,receiptRef,this.#o.principalRef(id),[organizationAuditRef(company)]]);const a=rows[0]?.after_summary;if(!a)return null;const receipt={contractVersion:a.contractVersion,receiptRef,personRef:a.personRef,principalRef:rows[0]!.actor_principal_ref,changeSetDigest:a.changeSetDigest,fields:a.fields,committedAt:a.committedAt}as Receipt;if(receipt.personRef!==this.#o.recordRef(company)||!Array.isArray(receipt.fields)||receipt.fields.length!==1||receipt.fields[0]!=="pay_contract")throw new Error("malformed pay contract receipt");return receipt;}
  async isCandidate(id:string):Promise<boolean>{const{rows}=await this.#pool.query<{role:string}>("SELECT role FROM grants WHERE principal_id=$1",[id]);return rows.some(row=>row.role==="candidate");}
  async #grants(c:pg.Pool|pg.PoolClient,id:string,lock=false){return(await c.query<Grant>(`SELECT org_id,role,scope FROM grants WHERE principal_id=$1${lock?" FOR SHARE":""}`,[id])).rows;}
  async #ancestors(c:pg.Pool|pg.PoolClient,company:string){return(await c.query<{id:string}>("WITH RECURSIVE chain AS (SELECT id,parent_org_id FROM organizations WHERE id=$1 UNION ALL SELECT o.id,o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id=o.id) SELECT id FROM chain WHERE id<>$1",[company])).rows.map(x=>x.id);}
  async #allowed(c:pg.Pool|pg.PoolClient,id:string,company:string){const[g,a]=await Promise.all([this.#grants(c,id),this.#ancestors(c,company)]);return this.#o.decision(g,company,a);}
  async #commit(id:string,company:string,input:CommitInput):Promise<CommitOutcome>{if(input.field!=="pay_contract"||input.receipt.fields.length!==1||input.receipt.fields[0]!==input.field)throw new TypeError("inconsistent pay contract commit");const client=await this.#pool.connect();let destroy=false;try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,317))",[company]);const grants=await this.#grants(client,id,true),ancestors=await this.#ancestors(client,company);if(!this.#o.decision(grants,company,ancestors))throw new Refusal("not_own_record");const used=await client.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2",[PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION,tokenRef(input.tokenId)]);if(used.rows.length)throw new Refusal("token_already_used");if(input.expectedBefore!==null)throw new Refusal("state_changed");const bound:PayContractStore={get:async()=>undefined,listForCandidate:async()=>[],transaction:async work=>work(transactionFor(client))};const made=await this.#o.creator(bound,id,company,input.value);if(!made.ok)throw new Refusal(made.reason);await client.query("INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,$4::text[],$5::jsonb,$6::jsonb)",[input.receipt.receiptRef,input.principalRef,PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION,[organizationAuditRef(company)],JSON.stringify({valuePresent:false}),JSON.stringify({contractVersion:input.receipt.contractVersion,personRef:input.receipt.personRef,changeSetDigest:input.changeSetDigest,fields:["pay_contract"],committedAt:input.receipt.committedAt,tokenRef:tokenRef(input.tokenId)})]);await client.query("COMMIT");return{ok:true};}catch(error){try{await client.query("ROLLBACK");}catch{destroy=true;}if(error instanceof Refusal)return{ok:false,reason:error.reason};if((error as{code?:string}).code==="23505")return{ok:false,reason:"token_already_used"};throw error;}finally{client.release(destroy);}}
}
