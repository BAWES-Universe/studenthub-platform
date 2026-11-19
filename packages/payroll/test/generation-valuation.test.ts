import assert from "node:assert/strict";
import test from "node:test";
import { planGeneration,payableFingerprint,weeklyPeriod,type GenerationPlan } from "../src/generation.js";
import { valueGenerationPlan,type GenerationValuationPort } from "../src/generation-valuation.js";
import type { PayableInput } from "../../work/src/payable.js";
const period=weeklyPeriod("2026-11-21");
const work:PayableInput={version:"studenthub.work.payable-input.v1",assignmentId:"assignment",personId:"hourly-person",orgId:"co",storeId:"store",payContractId:"hourly-contract",period,approvedSeconds:9000,pendingSeconds:0,rejectedSeconds:0,openSessions:0,sessions:[{sessionId:"session",lineageRootId:"root",workDate:"2026-11-18",durationSeconds:9000,source:"timer",correctsSessionId:null,decisionId:"decision",changedAt:"2026-11-19T10:00:00Z"}]};
const confirm={async confirm(i:PayableInput){return {state:"confirmed" as const,inputFingerprint:payableFingerprint(i),reference:"synthetic-confirmation"};}};
const options={period,claims:[],finalizedRoots:[],work:{async payableInputs(){return [work];},async lineage(){return []; }},confirmations:confirm,weeklyBusinessDate:period.end,monthlyContracts:[{id:"salary-contract",personId:"salary-person",orgId:"co",parentOrgId:null,currency:"KWD",active:true,personActive:true,autoGenerate:true,startDate:null,endDate:null,rateRevision:"salary-v1"}]};
const port:GenerationValuationPort={async resolve(c){return {personId:c.personId,contractId:c.contractId!,orgId:c.orgId,storeId:"store",currencyCode:"KWD",revision:c.kind==="hourly"?"hourly-v1":c.rateRevision,
 bonus:"0.000",bonusCommissionPercent:"0.000",transferCost:"0.000",rate:c.kind==="hourly"?{version:"studenthub.pay-rate-resolution.v1",source:"contract",contractId:c.contractId!,payModel:"hourly",candidateHourlyRate:"2.000",companyHourlyRate:"3.000",steps:[],matchedContractIds:[c.contractId!]}:{version:"studenthub.pay-rate-resolution.v1",source:"contract",contractId:c.contractId!,payModel:"monthly_salary",candidateTotal:"400.000",companyTotal:"600.000",transferCost:"0.000",steps:[],matchedContractIds:[c.contractId!]}};}};
test("F2_F1 actual calculator gives exact hourly plus salary/4 drafts and totals",async()=>{
 const plan=await planGeneration(options),batch=await valueGenerationPlan(plan,port);
 assert.equal(batch.kind,"preview-only");assert.equal(batch.lines.length,2);assert.equal(batch.blocked.length,0);
 const hourly=batch.lines.find(l=>l.personId==="hourly-person")!,salary=batch.lines.find(l=>l.personId==="salary-person")!;
 assert.equal(hourly.candidateTotal,"5.000");assert.equal(hourly.companyTotal,"7.500");assert.equal(salary.candidateTotal,"100.000");assert.equal(salary.companyTotal,"150.000");
 assert.deepEqual(batch.totals,{KWD:{candidateTotal:"105.000",companyTotal:"157.500"}});
 const retry=await valueGenerationPlan({...plan,candidates:[...plan.candidates].reverse()},port);assert.deepEqual(retry,batch);
});
test("F2_F1 revision changes with valuation while stable line identity prevents fresh retry identity",async()=>{
 const plan=await planGeneration(options),first=await valueGenerationPlan(plan,port);
 const changed=await valueGenerationPlan(plan,{async resolve(c){const s=await port.resolve(c);return c.kind==="hourly"?{...s,revision:"hourly-v2",rate:{...s.rate,payModel:"hourly",candidateHourlyRate:"4.000",companyHourlyRate:"6.000"} as typeof s.rate}:s;}});
 assert.equal(first.key,changed.key);assert.deepEqual(first.lines.map(l=>l.id),changed.lines.map(l=>l.id));assert.notEqual(first.revision,changed.revision);
});
test("F2_F1 absence of confirmation leaves hourly blocked, no implied employer approval",async()=>{
 const batch=await valueGenerationPlan(await planGeneration({...options,confirmations:undefined,monthlyContracts:[]}),port);assert.equal(batch.lines.length,0);assert.equal(batch.blocked[0]?.reason,"month_confirmation_port_required");
});
test("F2_F1 finalized correction goes to review and never normal re-payment",async()=>{
 const finalizedRoots=[{rootId:"root",personId:work.personId,recognizedRevision:"paid-plus-adjustment-v2"}];
 const plan=await planGeneration({...options,monthlyContracts:[],finalizedRoots,work:{async payableInputs(){return [work];},async lineage(){return [{rootId:"root",sessionIds:["session","correction"],inForce:{sessionId:"correction",assignmentId:"assignment",orgId:"co",workDate:"2026-12-01",durationSeconds:10800,status:"approved" as const,decisionId:"corrected",changedAt:"2026-12-02T00:00:00Z"}}];}}});
 const batch=await valueGenerationPlan(plan,{async resolve(){throw Error("must not value ordinary replacement");}});assert.equal(batch.lines.length,0);assert.equal(batch.adjustmentReviews.length,1);assert.equal(batch.adjustmentReviews[0]?.finalized.recognizedRevision,"paid-plus-adjustment-v2");
});
test("F2_F1 mismatched rate snapshot fails whole preview, does not emit a batch",async()=>{
 await assert.rejects(valueGenerationPlan(await planGeneration(options),{async resolve(c){return {...await port.resolve(c),contractId:"different"};}}),/scope mismatch/);
});
test("F2_F1 duplicate input candidate cannot create duplicate drafts",async()=>{
 const plan=await planGeneration(options);const bad:GenerationPlan={...plan,candidates:[plan.candidates[0]!,plan.candidates[0]!]};await assert.rejects(valueGenerationPlan(bad,port),/duplicate candidate/);
});
