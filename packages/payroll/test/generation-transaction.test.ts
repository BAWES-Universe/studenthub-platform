import assert from "node:assert/strict";
import test from "node:test";
import {commitGeneration,type GenerationReceipt,type GenerationTransactionStore} from "../src/generation-transaction.js";
import type {ValuedGenerationBatch} from "../src/generation-valuation.js";
const command={actorId:"staff",transferId:"transfer",expectedVersion:0,batchKey:"batch",expectedRevision:"r1"};
const fresh=():ValuedGenerationBatch=>({kind:"preview-only",key:"batch",revision:"r1",blocked:[],adjustmentReviews:[],totals:{KWD:{candidateTotal:"1.000",companyTotal:"2.000"}},lines:[{id:"line",personId:"person",storeId:"store",currencyCode:"KWD",candidateTotal:"1.000",companyTotal:"2.000",note:"",calculation:{candidateKey:"candidate",contractId:"contract",period:{start:"2026-11-01",end:"2026-11-30"},provenance:{roots:["root"]}}}]});
/** Disposable test transaction double, NOT a production claim store. */
class Fixture implements GenerationTransactionStore {
 state={claims:[] as string[],lines:[] as string[],receipts:[] as GenerationReceipt[],version:0};batch=fresh();fail="";authorized=true;reads=0;builds=0;
 async transaction<T>(fn:Parameters<GenerationTransactionStore["transaction"]>[0]):Promise<T>{
  const draft=structuredClone(this.state);
  const value=await fn({
   authorizeAndLock:async()=>{if(!this.authorized)throw Error("forbidden");},
   receipt:async(t,k)=>{this.reads++;return draft.receipts.find(r=>r.transferId===t&&r.batchKey===k);},
   rebuild:async()=>{this.builds++;return this.batch;},
   reserve:async(_t,ids)=>{for(const id of ids){const k=JSON.stringify([id.personId,id.contractId,id.periodStart,id.periodEnd]);if(draft.claims.includes(k))return false;draft.claims.push(k);}return this.fail!=="reserve";},
   appendDraft:async(_a,_t,v,lines)=>{if(v!==draft.version)throw Error("version_conflict");for(const line of lines){draft.lines.push(line.id);if(this.fail==="line")throw Error("line_failed");}return ++draft.version;},
   saveReceipt:async r=>{draft.receipts.push(r);if(this.fail==="receipt")throw Error("receipt_failed");},
  });this.state=draft;return value as T;
 }
}
test("F2_TX one commit then replay produces no extra claims/lines/rebuild",async()=>{
 const f=new Fixture();assert.equal((await commitGeneration(f,command)).kind,"committed");const saved=structuredClone(f.state);
 assert.equal((await commitGeneration(f,command)).kind,"replayed");assert.deepEqual(f.state,saved);assert.equal(f.builds,1);
});
test("F2_TX changed snapshot or newly missing confirmation causes zero writes",async()=>{
 for(const variant of ["changed","blocked"]){const f=new Fixture();if(variant==="changed")f.batch={...f.batch,revision:"r2"};else f.batch={...f.batch,blocked:[{key:"candidate",reason:"month_confirmation_port_required"}]};await assert.rejects(commitGeneration(f,command),/snapshot_changed|not_ready/);assert.deepEqual(f.state,{claims:[],lines:[],receipts:[],version:0});}
});
test("F2_TX claims, partial line write and receipt failure all roll back",async()=>{
 for(const fail of ["reserve","line","receipt"]){const f=new Fixture();f.fail=fail;await assert.rejects(commitGeneration(f,command));assert.deepEqual(f.state,{claims:[],lines:[],receipts:[],version:0});f.fail="";assert.equal((await commitGeneration(f,command)).kind,"committed");assert.equal(f.state.lines.length,1);}
});
test("F2_TX manual existing person contract period claim blocks append",async()=>{
 const f=new Fixture();f.state.claims.push(JSON.stringify(["person","contract","2026-11-01","2026-11-30"]));const before=structuredClone(f.state);await assert.rejects(commitGeneration(f,command),/claim_conflict/);assert.deepEqual(f.state,before);
});
test("F2_TX current authorization is checked before receipt replay",async()=>{
 const f=new Fixture();await commitGeneration(f,command);f.authorized=false;const reads=f.reads;await assert.rejects(commitGeneration(f,command),/forbidden/);assert.equal(f.reads,reads);
});
test("F2_TX changed retry revision is not accepted as success",async()=>{
 const f=new Fixture();await commitGeneration(f,command);await assert.rejects(commitGeneration(f,{...command,expectedRevision:"r2"}),/retry_conflict/);assert.equal(f.state.lines.length,1);
});
test("F2_TX finalized adjustment review cannot be appended as ordinary pay",async()=>{
 const f=new Fixture();f.batch={...f.batch,adjustmentReviews:[{finalized:{rootId:"root",personId:"person",recognizedRevision:"final"},current:{rootId:"root",sessionIds:["root"],inForce:null}}]};await assert.rejects(commitGeneration(f,command),/not_ready/);assert.equal(f.state.lines.length,0);
});
test("F2_TX positive command custody retains the original batch and target until receipt",async()=>{
 let allow!:()=>void;
 const gate=new Promise<void>(resolve=>{allow=resolve;});
 const f=new Fixture(), entered=f.transaction.bind(f);
 f.transaction=async fn=>{await gate;return entered(fn);};
 const submitted={...command};
 const running=commitGeneration(f,submitted);
 submitted.batchKey="a later form edit";submitted.transferId="another transfer";
 allow();
 const result=await running;
 assert.equal(result.receipt.batchKey,command.batchKey);
 assert.equal(result.receipt.transferId,command.transferId);
 assert.ok(Object.isFrozen(result.receipt.lineIds));
});
