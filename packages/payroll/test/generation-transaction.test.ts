import assert from "node:assert/strict";
import test from "node:test";
import {commitGeneration,type GenerationReceipt,type GenerationTransactionStore} from "../src/generation-transaction.js";
import {valueGenerationPlan,type ValuedGenerationBatch} from "../src/generation-valuation.js";
import {acknowledgedWorkBasis,payableFingerprint,planGeneration,type FinalizedRoot} from "../src/generation.js";
import type {PayableInput,PayableLineage} from "../../work/src/payable.js";
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

// Compare the real planner and valuation to the transaction protocol, never a hand-built
// successful batch. The fixture records only synthetic Work and Pay identities.
const recognized:PayableLineage={
 rootId:"prior",sessionIds:["prior"],
 inForce:{sessionId:"prior",assignmentId:"assignment",orgId:"co",workDate:"2026-11-19",
   durationSeconds:3600,status:"approved",decisionId:"first",changedAt:"2026-11-19T09:00:00Z"},
};
const corrected:PayableLineage={
 rootId:"prior",sessionIds:["prior","replacement"],
 inForce:{sessionId:"replacement",assignmentId:"assignment",orgId:"co",workDate:"2026-12-04",
   durationSeconds:7200,status:"approved",decisionId:"corrected",changedAt:"2026-12-04T09:00:00Z"},
};
const period={start:"2026-12-01",end:"2026-12-31"};
const newInput:PayableInput={
 version:"studenthub.work.payable-input.v1",assignmentId:"assignment",personId:"person",orgId:"co",
 storeId:"store",payContractId:"contract",period,approvedSeconds:3600,pendingSeconds:0,rejectedSeconds:0,openSessions:0,
 sessions:[{sessionId:"new",lineageRootId:"new",workDate:"2026-12-03",durationSeconds:3600,source:"timer",
   correctsSessionId:null,decisionId:"new-approved",changedAt:"2026-12-03T09:00:00Z"}],
};
const paidInitial:FinalizedRoot={rootId:"prior",personId:"person",recognizedRevision:"pay-original",
 acknowledgedWork:acknowledgedWorkBasis(recognized)};
async function rebuildWithHistory(paid:FinalizedRoot,current:PayableLineage|null,rows=[newInput],claimed=false){
 const plan=await planGeneration({period,claims:claimed?[{personId:"person",contractId:"contract",period}]:[],
   finalizedRoots:[paid],work:{async payableInputs(){return rows;},async lineage(roots){
     assert.deepEqual(roots,["prior"]);return current?[current]:[];
   }}, confirmations:{async confirm(input){return {state:"confirmed",inputFingerprint:payableFingerprint(input),reference:"fixture"};} }});
 return valueGenerationPlan(plan,{async resolve(c){
   return {personId:c.personId,contractId:"contract",orgId:c.orgId,storeId:"store",currencyCode:"KWD",revision:"rate-v1",
     bonus:"0.000",bonusCommissionPercent:"0.000",transferCost:"0.000",rate:{version:"studenthub.pay-rate-resolution.v1",
       source:"contract",contractId:"contract",payModel:"hourly",candidateHourlyRate:"2.000",
       companyHourlyRate:"3.000",steps:[],matchedContractIds:["contract"]}};
 }});
}
const runBatch=(f:Fixture)=>commitGeneration(f,{...command,batchKey:f.batch.key,expectedRevision:f.batch.revision});
test("acknowledged out-of-period Work permits new work and never republishes an old root",async()=>{
 const f=new Fixture();f.batch=await rebuildWithHistory(paidInitial,recognized);
 assert.deepEqual(f.batch.adjustmentReviews,[]);
 assert.deepEqual(f.batch.lines.map(l=>[l.candidateTotal,l.calculation.provenance]),[
   ["2.000",{inputFingerprints:[payableFingerprint(newInput)],confirmationReferences:["fixture"],roots:["new"]}]
 ]);
 assert.equal((await runBatch(f)).kind,"committed");
 assert.equal((await runBatch(f)).kind,"replayed");
 assert.equal(f.state.lines.length,1);assert.equal(f.state.receipts.length,1);
});
test("changed or discarded Work needs Finance review and cannot partially commit",async()=>{
 for(const next of [corrected,{...recognized,inForce:null}]){
   const f=new Fixture();f.batch=await rebuildWithHistory(paidInitial,next);
   assert.deepEqual(f.batch.adjustmentReviews,[{finalized:paidInitial,current:next}]);
   await assert.rejects(runBatch(f),/not_ready/);
   assert.deepEqual(f.state,{claims:[],lines:[],receipts:[],version:0});
 }
});
test("unchanged latest Work after a finalized cumulative adjustment stops recurring review",async()=>{
 const f=new Fixture();
 const paidLatest={...paidInitial,recognizedRevision:"pay-original-plus-finalized-adjustment",
   acknowledgedWork:acknowledgedWorkBasis(corrected)};
 f.batch=await rebuildWithHistory(paidLatest,corrected);
 assert.deepEqual(f.batch.adjustmentReviews,[]);
 assert.equal((await runBatch(f)).kind,"committed");
});
test("missing basis or missing Work resolution stays blocked; old root cannot bypass an existing claim",async()=>{
 const {acknowledgedWork:_,...noBasis}=paidInitial;
 const noEvidence=await rebuildWithHistory(noBasis,recognized);
 assert.equal(noEvidence.adjustmentReviews.length,1);
 assert.equal((await rebuildWithHistory(paidInitial,null)).blocked[0]?.reason,"finalized_lineage_unresolved");
 const mixed={...newInput,approvedSeconds:10800,sessions:[...newInput.sessions,{...newInput.sessions[0]!,
   sessionId:"replacement",lineageRootId:"prior",workDate:"2026-12-04",durationSeconds:7200}]};
 const paidLatest={...paidInitial,recognizedRevision:"final-adjustment",acknowledgedWork:acknowledgedWorkBasis(corrected)};
 for(const claimed of [true,false]){
   const batch=await rebuildWithHistory(paidLatest,corrected,[mixed],claimed);
   assert.equal(batch.lines.length,0);assert.equal(batch.adjustmentReviews.length,0);
   assert.equal(batch.blocked[0]?.reason,claimed?"existing_line_including_manual":"finalized_lineage_requires_adjustment");
 }
});
