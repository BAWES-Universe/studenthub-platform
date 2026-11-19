import assert from "node:assert/strict";
import test from "node:test";
import { planGeneration, payableFingerprint, weeklyPeriod, type MonthlyContract } from "../src/generation.js";
import type { PayableInput, PayableWorkSource, PayableLineage } from "../../work/src/payable.js";
const period={start:"2026-11-01",end:"2026-11-30"};
const input=(id="a"):PayableInput=>({version:"studenthub.work.payable-input.v1",assignmentId:id,personId:"p",orgId:"co",storeId:"s",payContractId:"c",period,approvedSeconds:3600,pendingSeconds:50,rejectedSeconds:20,openSessions:1,sessions:[{sessionId:id,workDate:"2026-11-10",durationSeconds:3600,source:"timer",correctsSessionId:null,lineageRootId:id,decisionId:"d",changedAt:"2026-11-10T10:00:00Z"}]});
const source=(rows:readonly PayableInput[]=[],lineages:readonly PayableLineage[]=[]):PayableWorkSource=>({async payableInputs(){return rows;},async lineage(){return lineages;}});
const confirmation={async confirm(i:PayableInput){return {state:"confirmed" as const,inputFingerprint:payableFingerprint(i),reference:"confirm:"+i.assignmentId};}};
const base={period,claims:[],finalizedRoots:[]};
test("F2 absent or stale confirmation never creates hourly candidate",async()=>{
 assert.equal((await planGeneration({...base,work:source([input()])})).blocked[0]?.reason,"month_confirmation_port_required");
 const p=await planGeneration({...base,work:source([input()]),confirmations:{async confirm(){return {state:"confirmed",inputFingerprint:"old",reference:"r"};}}});assert.equal(p.candidates.length,0);assert.equal(p.blocked[0]?.reason,"month_unconfirmed_or_changed");
});
test("F2 groups assignments under person contract period without inventing amounts",async()=>{
 const rows=[input("b"),input("a")];const before=JSON.stringify(rows);
 const p=await planGeneration({...base,work:source(rows),confirmations:confirmation});assert.equal(p.candidates.length,1);const c=p.candidates[0]!;assert.equal(c.kind,"hourly");if(c.kind!=="hourly")throw Error();assert.equal(c.inputs.reduce((n,i)=>n+i.approvedSeconds,0),7200);assert.equal("candidateTotal" in c,false);assert.equal(JSON.stringify(rows),before);
 const repeat=await planGeneration({...base,work:source(rows),confirmations:confirmation});assert.deepEqual(p,repeat);
 const reordered=await planGeneration({...base,work:source([...rows].reverse()),confirmations:confirmation});assert.deepEqual(p,reordered);
});
test("F2 existing manual or generated claim prevents duplicate",async()=>{
 const p=await planGeneration({...base,work:source([input()]),confirmations:confirmation,claims:[{personId:"p",contractId:"c",period}]});assert.equal(p.candidates.length,0);assert.equal(p.blocked[0]?.reason,"existing_line_including_manual");
});
test("F2 corrupt sums and duplicate lineages fail closed",async()=>{
 await assert.rejects(planGeneration({...base,work:source([{...input(),approvedSeconds:3601}])}),/sum mismatch/);
 await assert.rejects(planGeneration({...base,work:source([input(),{...input(),assignmentId:"b"}])}),/duplicate payable lineage/);
});
test("F2 finalized chained corrections are review deltas, not ordinary payment",async()=>{
 const paid={rootId:"a",personId:"p",recognizedRevision:"original-plus-finalized-adjustment-2"};
 const now:PayableLineage={rootId:"a",sessionIds:["a","b","c"],inForce:{sessionId:"c",assignmentId:"a",orgId:"co",workDate:"2026-12-01",durationSeconds:7200,status:"approved",decisionId:"dc",changedAt:"2026-12-02T00:00:00Z"}};
 const p=await planGeneration({...base,work:source([input()], [now]),confirmations:confirmation,finalizedRoots:[paid]});assert.equal(p.candidates.length,0);assert.deepEqual(p.adjustmentReviews,[{finalized:paid,current:now}]);assert.equal(p.blocked[0]?.reason,"finalized_lineage_requires_adjustment");
 assert.equal(p.adjustmentReviews[0]?.finalized.recognizedRevision,paid.recognizedRevision);
});
test("F2 missing finalized root is unknown, discarded root remains reviewable",async()=>{
 const finalizedRoots=[{rootId:"a",personId:"p",recognizedRevision:"v2"}];
 const missing=await planGeneration({...base,work:source(),finalizedRoots});assert.equal(missing.blocked[0]?.reason,"finalized_lineage_unresolved");
 const gone=await planGeneration({...base,work:source([],[{rootId:"a",sessionIds:["a"],inForce:null}]),finalizedRoots});assert.equal(gone.adjustmentReviews.length,1);assert.equal(gone.candidates.length,0);
});
const monthly=(id:string,orgId:string):MonthlyContract=>({id,orgId,parentOrgId:null,personId:id,currency:"KWD",active:true,personActive:true,autoGenerate:true,startDate:null,endDate:null,rateRevision:"rate-v1"});
test("F2 weekly visits every company, parent grouping, rolling7 and divisor4",async()=>{
 const period=weeklyPeriod("2026-11-21");assert.deepEqual(period,{start:"2026-11-15",end:"2026-11-21"});
 const p=await planGeneration({...base,period,work:source(),weeklyBusinessDate:period.end,monthlyContracts:[monthly("a","co1"),{...monthly("b","child"),parentOrgId:"parent"}]});assert.equal(p.candidates.length,2);assert.deepEqual(p.candidates.map(c=>c.orgId),["co1","parent"]);assert.ok(p.candidates.every(c=>c.kind==="monthly-weekly"&&c.payoutDivisor===4));
});
test("F2 monthly eligibility and conflicting currency do not silently pay",async()=>{
 const period=weeklyPeriod("2026-11-21");const contracts=[{...monthly("a","co"),autoGenerate:false},{...monthly("b","co"),personActive:false},{...monthly("c","co"),startDate:"2026-11-22"},{...monthly("d","co"),endDate:"2026-11-20"},{...monthly("e","co"),currency:"USD"}];
 const p=await planGeneration({...base,period,work:source(),weeklyBusinessDate:period.end,monthlyContracts:contracts});assert.equal(p.candidates.length,0);assert.equal(p.blocked[0]?.reason,"non_kwd_requires_legacy_valuation");
});
test("F2 monthly retry sees manual claim and excludes it",async()=>{
 const period=weeklyPeriod("2026-11-21");const p=await planGeneration({...base,period,work:source(),claims:[{personId:"a",contractId:"a",period}],weeklyBusinessDate:period.end,monthlyContracts:[monthly("a","co")]});assert.equal(p.candidates.length,0);
});
test("F2 invalid dates and non-weekly generation reject",async()=>{
 assert.throws(()=>weeklyPeriod("2026-02-30"));
 await assert.rejects(planGeneration({...base,work:source(),monthlyContracts:[monthly("a","co")],weeklyBusinessDate:"2026-11-21"}),/rolling seven/);
});
