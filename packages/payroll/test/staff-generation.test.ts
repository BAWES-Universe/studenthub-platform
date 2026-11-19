import assert from "node:assert/strict";
import test from "node:test";
import type { PayableInput } from "../../work/src/payable.js";
import { buildScopedStaffGeneration, type StaffGenerationInputs } from "../src/staff-generation.js";
const period={start:"2026-11-01",end:"2026-11-30"};
const scope={actorId:"staff",transferId:"transfer",orgId:"org",period};
const work:PayableInput={version:"studenthub.work.payable-input.v1",assignmentId:"assignment",personId:"person",orgId:"org",storeId:"store",payContractId:"contract",period,approvedSeconds:7200,pendingSeconds:4500,rejectedSeconds:5400,openSessions:2,sessions:[{sessionId:"active",lineageRootId:"root",workDate:"2026-11-20",durationSeconds:7200,source:"correction",correctsSessionId:"root",decisionId:"d",changedAt:"2026-12-01T00:00:00Z"}]};
function ports():StaffGenerationInputs {
 return {authorize:async(s)=>{assert.deepEqual(s,scope);return true;},work:{payableInputs:async query=>{assert.deepEqual(query,{orgId:"org",period,includeSubtree:false});return [work];},lineage:async()=>[]},claims:[],finalizedRoots:[],
 rates:{resolve:async(c)=>({personId:c.personId,contractId:"contract",orgId:c.orgId,storeId:"store",currencyCode:"KWD",revision:"rate1",bonus:"0",bonusCommissionPercent:"0",transferCost:"0",rate:{version:"studenthub.pay-rate-resolution.v1",source:"contract",contractId:"contract",payModel:"hourly",candidateHourlyRate:"2.000",companyHourlyRate:"3.000",steps:[],matchedContractIds:["contract"]}})}};
}
test("exact staff range prices only the already approved sessions; no employer confirmation port",async()=>{
 const b=await buildScopedStaffGeneration(scope,ports());
 assert.deepEqual(b.totals.KWD,{candidateTotal:"4.000",companyTotal:"6.000"});
 assert.equal(b.lines.length,1);
});
test("a changed finalized lineage is sent to Finance review instead of ordinary pay",async()=>{
 const p=ports();
 const b=await buildScopedStaffGeneration(scope,{...p,finalizedRoots:[{rootId:"root",personId:"person",recognizedRevision:"recognized-v1"}],work:{...p.work,lineage:async roots=>{assert.deepEqual(roots,["root"]);return [{rootId:"root",sessionIds:["root","active"],inForce:{sessionId:"active",assignmentId:"assignment",orgId:"org",workDate:"2026-12-01",durationSeconds:7200,status:"approved",decisionId:"d",changedAt:"2026-12-01T00:00:00Z"}}];}}});
 assert.equal(b.lines.length,0);
 assert.equal(b.adjustmentReviews[0]?.current.inForce?.sessionId,"active");
});

import type pg from "pg";
import { PostgresPayLinesStore } from "../../db/src/payroll/postgres-pay-lines-store.js";
test("both F1 entry points keep the submitted amount and private calculation through the first await",async()=>{
 for(const externallyOwned of [false,true]){
  let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const rows:{text:string;params?:unknown[]}[]=[];
  const c={
   async query(text:string,params?:unknown[]){
    rows.push({text,params});
    if(text.includes("FOR UPDATE")){await barrier;return {rows:[{company_id:"org",status:"draft",version:0,currency_code:"KWD"}]};}
    return {rows:[],rowCount:1};
   },
   release(){},
  } as unknown as pg.PoolClient;
  const pool={connect:async()=>{await barrier;return c;}} as unknown as pg.Pool;
  const store=new PostgresPayLinesStore(pool,async()=>true,line=>assert.equal(line.candidateTotal,"4.000"));
  const input={id:"line",personId:"person",storeId:"store",currencyCode:"KWD",candidateTotal:"4.000",companyTotal:"6.000",note:"synthetic",calculation:{result:{source:"original"}}};
  const pending=externallyOwned?store.appendLinesInTransaction(c,"staff","transfer",0,[input]):store.appendLines("staff","transfer",0,[input]);
  input.candidateTotal="5.000";
  input.calculation.result.source="later form edit";
  release();
  assert.equal(await pending,1);
  const insert=rows.find(row=>row.text.startsWith("INSERT INTO pay_transfer_lines"));
  assert.equal(insert?.params?.[5],"4.000");
  assert.equal(insert?.params?.[8],'{"result":{"source":"original"}}');
  assert.equal(rows.some(row=>row.text==="BEGIN"),!externallyOwned);
  assert.equal(rows.some(row=>row.text==="COMMIT"),!externallyOwned);
 }
});
