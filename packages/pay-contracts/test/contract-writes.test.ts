import assert from "node:assert/strict";
import { test } from "node:test";
import { runSafeWriteConformance, TEST_SECRET, type CommitInput, type SafeWriteStore } from "@studenthub/safe-write-contract";
import * as normal from "../src/index.js";
const subject=process.env.SHU317_TEST_MODULE?{...normal,...await import(process.env.SHU317_TEST_MODULE)} as typeof normal:normal;
const CURRENCY="11111111-1111-4111-8111-111111111111", CANDIDATE="candidate-a", COMPANY="company-a", STORE="store-a", ACTOR="staff-a";
const input=(extra:Record<string,unknown>={})=>({candidateId:CANDIDATE,companyId:COMPANY,storeId:STORE,startDate:"2026-01-01",currencyId:CURRENCY,transferCost:"1.000",autoGenerate:false,status:"active",terms:{payModel:"hourly",candidateHourlyRate:"10.000",companyHourlyRate:"12.000"},...extra});
const value=(extra:Record<string,unknown>={})=>subject.payContractCreateValue(subject.normalizePayContractCreate(input(extra)));
function references(){const r=new subject.InMemoryFinanceReferenceResolver();r.set("currency",CURRENCY);return r;}
function check(store=new subject.InMemoryPayContractStore(),candidate=true){return subject.payContractCreateCheck({references:references(),contracts:store,candidates:{isCandidate:async()=>candidate}});}

test("SHU-317/AC-01 conformance canonical and reference validation ",async()=>{
  assert.equal((await runSafeWriteConformance(i=>subject.buildPayContractCreateWrite({...i,companyId:COMPANY,check:subject.acceptAnyPayContractCreateValue}))).ok,true);
  const c=check();assert.equal(await c(COMPANY,value()),true);assert.equal(await c(COMPANY,JSON.stringify(input())),false);
  assert.equal(await c(COMPANY,value({transferCost:"1.5"})),true,"normalizer canonicalizes before encoding");
  const noncanonical=value().replace('"transferCost":"1.000"','"transferCost":"1.5"');assert.equal(await c(COMPANY,noncanonical),false);
  const retired=references();retired.set("currency",CURRENCY,"deleted");assert.equal(await subject.payContractCreateCheck({references:retired,contracts:new subject.InMemoryPayContractStore(),candidates:{isCandidate:async()=>true}})(COMPANY,value()),false);
  assert.equal(await check(new subject.InMemoryPayContractStore(),false)(COMPANY,value()),false);
});

test("SHU-317/AC-02 employer-write-refused roles and scope ",async()=>{
  for(const role of ["org-owner","recruiter","finance"])assert.equal(subject.payContractWriteDecision([{org_id:COMPANY,role,scope:"self"}],COMPANY,[],[]),false);
  assert.equal(subject.payContractWriteDecision([{org_id:"parent",role:"staff",scope:"self"}],COMPANY,["parent"],[]),false);
  assert.equal(subject.payContractWriteDecision([{org_id:"parent",role:"admin",scope:"subtree"}],COMPANY,["parent"],[]),true);
  assert.equal(subject.payContractWriteDecision([{org_id:COMPANY,role:"staff",scope:"self"}],COMPANY,[],[COMPANY]),false);
  const rows=[{org_id:COMPANY,role:"org-owner",scope:"self"}],principal=subject.payContractPrincipalRef(ACTOR),record=subject.payContractCompanyRecordRef(COMPANY);
  const store:SafeWriteStore={ownedRecord:()=>subject.payContractWriteDecision(rows,COMPANY,[],[])?record:null,readField:()=>null,commit:()=>({ok:false,reason:"not_own_record"})};
  assert.deepEqual(await subject.buildPayContractCreateWrite({store,secret:TEST_SECRET,companyId:COMPANY,check:async()=>true}).preview({principalRef:principal,change:{personRef:record,field:"pay_contract",value:value()}}),{ok:false,reason:"not_own_record"});
});

test("SHU-317/AC-03 company-bound check ",async()=>{assert.equal(await check()(COMPANY,value({companyId:"company-b"})),false);});

test("SHU-317/AC-04 overlap-refused-at-preview periods and stores ",async()=>{
  const store=new subject.InMemoryPayContractStore(),refs=references();await new subject.PayContracts(store,refs).create(ACTOR,input());
  assert.equal(await check(store)(COMPANY,value({startDate:"2026-06-01"})),false);
  assert.equal(await check(store)(COMPANY,value({storeId:"store-b"})),true);
  const deleted=new subject.InMemoryPayContractStore();const made=await new subject.PayContracts(deleted,refs).create(ACTOR,input());await new subject.PayContracts(deleted,refs).remove(ACTOR,made.id);assert.equal(await check(deleted)(COMPANY,value()),true);
});

test("SHU-317/AC-05 racing-overlap-state-changed creator ",async()=>{
  const store=new subject.InMemoryPayContractStore(),refs=references(),creator=subject.payContractCreator(refs);await new subject.PayContracts(store,refs).create(ACTOR,input());
  const outcome=await creator(store,ACTOR,COMPANY,value()).catch(()=>({ok:false as const,reason:"threw" as const}));
  assert.deepEqual(outcome,{ok:false,reason:"state_changed"});assert.equal((await store.listForCandidate(CANDIDATE)).length,1);
});
