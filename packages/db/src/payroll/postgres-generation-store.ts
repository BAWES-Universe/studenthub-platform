import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { PostgresPayLinesStore, snapshotPayLine, type PayLineDraft, type PayLineWritePolicy } from "./postgres-pay-lines-store.js";
// Structural DTOs: DB workspace does not depend on unbuilt payroll source.
interface Receipt {transferId:string;batchKey:string;revision:string;resultingVersion:number;lineIds:readonly string[]}
interface Identity {personId:string;contractId:string;periodStart:string;periodEnd:string;candidateKey:string;lineageRoots:readonly string[]}
export interface LockedGenerationBatch {
 readonly kind:"preview-only";readonly key:string;readonly revision:string;readonly lines:readonly PayLineDraft[];
 readonly totals:Readonly<Record<string,{candidateTotal:string;companyTotal:string}>>;
 readonly blocked:readonly {key:string;reason:string}[];readonly adjustmentReviews:readonly never[];
}
/** REQUIRED authoritative implementation; absent Work confirmation must fail closed.
 * Must use this client, lock coherent snapshots until commit, reject adjustment plans.
 */
export type LockedGenerationRebuild=(client:pg.PoolClient,transferId:string,batchKey:string)=>Promise<LockedGenerationBatch>;
interface Transaction {
 authorizeAndLock(actorId:string,transferId:string):Promise<void>;
 receipt(transferId:string,batchKey:string):Promise<Receipt|undefined>;
 rebuild(transferId:string,batchKey:string):Promise<LockedGenerationBatch>;
 reserve(transferId:string,ids:readonly Identity[]):Promise<boolean>;
 appendDraft(actorId:string,transferId:string,version:number,lines:readonly PayLineDraft[]):Promise<number>;
 saveReceipt(receipt:Receipt):Promise<void>;
}
export class PostgresGenerationStore {
 private readonly lines:PostgresPayLinesStore;
 constructor(private readonly pool:pg.Pool,private readonly authorize:PayLineWritePolicy,validate:(line:PayLineDraft)=>void,private readonly rebuildLocked:LockedGenerationRebuild){this.lines=new PostgresPayLinesStore(pool,authorize,validate);}
 async transaction<T>(work:(tx:Transaction)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();let broken=false;let target:string|undefined;let owner:string|undefined;let fresh:LockedGenerationBatch|undefined;let reserved=false;let resultingVersion:number|undefined;
  const locked=(id:string)=>{if(target!==id)throw Error("generation_target_not_locked");};
  try{
   await c.query("BEGIN");
   const result=await work({
    authorizeAndLock:async(actor,id)=>{if(target)throw Error("generation_target_already_locked");const row=(await c.query("SELECT company_id FROM pay_transfers WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!row||!await this.authorize(c,actor,row.company_id))throw Error("not_found");target=id;owner=actor;},
    receipt:async(id,key)=>{locked(id);const r=(await c.query("SELECT * FROM pay_generation_receipts WHERE transfer_id=$1 AND batch_key=$2",[id,key])).rows[0];return r?{transferId:id,batchKey:key,revision:r.revision,resultingVersion:r.resulting_version,lineIds:r.line_ids}:undefined;},
    rebuild:async(id,key)=>{locked(id);if(fresh)throw Error("generation_already_rebuilt");
     const rebuilt=await this.rebuildLocked(c,id,key);
     fresh={...structuredClone(rebuilt),lines:Object.freeze(rebuilt.lines.map(snapshotPayLine))};
     return structuredClone(fresh);},
    reserve:async(id,ids)=>{
     locked(id);if(!fresh||reserved)throw Error("generation_rebuild_required");
     if(fresh.kind!=="preview-only"||fresh.blocked.length||fresh.adjustmentReviews.length)throw Error("generation_not_ready");
     const snapshot=structuredClone(ids);
     const expected=fresh.lines.map(l=>{
      const {candidateKey,contractId,period,provenance}=l.calculation;
      const p=period as {start:string;end:string};
      return {personId:l.personId,contractId,periodStart:p?.start,periodEnd:p?.end,candidateKey,lineageRoots:(provenance as {roots?:unknown}|undefined)?.roots??[]};
     });
     if(!snapshot.length||!isDeepStrictEqual(snapshot,expected))throw Error("generation_reservation_mismatch");
     const rootReservations:{root:string;lineId:string}[]=[];
     for(const i of [...snapshot].sort((a,b)=>JSON.stringify([a.personId,a.periodStart,a.periodEnd,a.contractId]).localeCompare(JSON.stringify([b.personId,b.periodStart,b.periodEnd,b.contractId])))){
      const line=fresh.lines.find(l=>l.calculation.candidateKey===i.candidateKey);if(!line)throw Error("generation_line_missing");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text)::text,0))",[i.personId]);
      const existing=await c.query(`SELECT l.id FROM pay_transfer_lines l JOIN pay_transfers t ON t.id=l.transfer_id
       WHERE l.person_id=$1 AND ((t.period_start <= $3::date AND t.period_end >= $2::date
       AND (NULLIF(l.calculation->>'contractId','') IS NULL OR l.calculation->>'contractId'=$4))
       OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(l.calculation->'provenance'->'roots')='array' THEN l.calculation->'provenance'->'roots' ELSE '[]'::jsonb END) r WHERE r.value=ANY($5::text[]))) LIMIT 1`,[i.personId,i.periodStart,i.periodEnd,i.contractId,i.lineageRoots]);
      if(existing.rowCount)return false;
      const reserved=await c.query(`INSERT INTO pay_generation_claims(line_id,transfer_id,person_id,contract_id,period_start,period_end,candidate_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING line_id`,[line.id,id,i.personId,i.contractId,i.periodStart,i.periodEnd,i.candidateKey]);
      if(!reserved.rowCount)return false;
      for(const root of i.lineageRoots)rootReservations.push({root,lineId:line.id});
     }
     for(const {root,lineId} of rootReservations.sort((a,b)=>a.root.localeCompare(b.root))){const r=await c.query("INSERT INTO pay_generation_roots(root_id,line_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING root_id",[root,lineId]);if(!r.rowCount)return false;}
     reserved=true;return true;
    },
    appendDraft:async(actor,id,version,lines)=>{
     locked(id);if(owner!==actor||!fresh||!reserved||resultingVersion!==undefined||!isDeepStrictEqual(lines,fresh.lines))throw Error("generation_append_mismatch");
     resultingVersion=await this.lines.appendLinesInTransaction(c,actor,id,version,fresh.lines);
     return resultingVersion;
    },
    saveReceipt:async r=>{
     const receipt=structuredClone(r);
     locked(receipt.transferId);
     if(!fresh||resultingVersion===undefined||receipt.batchKey!==fresh.key||receipt.revision!==fresh.revision||receipt.resultingVersion!==resultingVersion||!isDeepStrictEqual(receipt.lineIds,fresh.lines.map(l=>l.id)))throw Error("generation_receipt_mismatch");
     await c.query("INSERT INTO pay_generation_receipts(transfer_id,batch_key,revision,resulting_version,line_ids) VALUES($1,$2,$3,$4,$5)",[receipt.transferId,receipt.batchKey,receipt.revision,receipt.resultingVersion,JSON.stringify(receipt.lineIds)]);},
   });
   await c.query("COMMIT");return result;
  }catch(e){try{await c.query("ROLLBACK");}catch{broken=true;}throw e;}finally{c.release(broken);}
 }
}
