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
const principal=subject.payContractPrincipalRef(ACTOR),record=subject.payContractCompanyRecordRef(COMPANY);
function request(v:string=value()){return{principalRef:principal,change:{personRef:record,field:"pay_contract",value:v}} as const;}
function acceptingStore(commit:SafeWriteStore["commit"]=()=>({ok:true})):SafeWriteStore{return{ownedRecord:()=>record,readField:()=>null,commit};}
async function previewWith(c:normal.PayContractCreateCheck,v:string=value(),store:SafeWriteStore=acceptingStore()){return subject.buildPayContractCreateWrite({store,secret:TEST_SECRET,companyId:COMPANY,check:c}).preview(request(v));}
async function refusedAtPreviewAndConfirm(c:normal.PayContractCreateCheck,v:string){const store=acceptingStore(),invalid={ok:false,reason:"invalid_value"};const tokenPreview=await subject.buildPayContractCreateWrite({store,secret:TEST_SECRET,companyId:COMPANY,check:subject.acceptAnyPayContractCreateValue}).preview(request());assert.ok(tokenPreview.ok);if(!tokenPreview.ok)return;const writer=subject.buildPayContractCreateWrite({store,secret:TEST_SECRET,companyId:COMPANY,check:c});assert.deepEqual(await writer.preview(request(v)),invalid);assert.deepEqual(await writer.confirm({...request(v),token:tokenPreview.token}),invalid);}

test("SHU-317/AC-01 conformance canonical and reference validation ",async()=>{
  assert.equal((await runSafeWriteConformance(i=>subject.buildPayContractCreateWrite({...i,companyId:COMPANY,check:subject.acceptAnyPayContractCreateValue}))).ok,true);
  await refusedAtPreviewAndConfirm(check(),JSON.stringify(input()));
  await refusedAtPreviewAndConfirm(check(),value().replace('"transferCost":"1.000"','"transferCost":"1.5"'));
  const retired=references();retired.set("currency",CURRENCY,"deleted");await refusedAtPreviewAndConfirm(subject.payContractCreateCheck({references:retired,contracts:new subject.InMemoryPayContractStore(),candidates:{isCandidate:async()=>true}}),value());
  await refusedAtPreviewAndConfirm(check(new subject.InMemoryPayContractStore(),false),value());
});

test("SHU-317/AC-02 employer-write-refused roles and scope ",async()=>{
  async function drive(rows:normal.PayContractGrantRow[],company=COMPANY,ancestors:string[]=[],operators:string[]=[]){const companyRecord=subject.payContractCompanyRecordRef(company),allowed=()=>subject.payContractWriteDecision(rows,company,ancestors,operators);const store:SafeWriteStore={ownedRecord:()=>allowed()?companyRecord:null,readField:()=>null,commit:()=>allowed()?{ok:true}:{ok:false,reason:"not_own_record"}};const writer=subject.buildPayContractCreateWrite({store,secret:TEST_SECRET,companyId:company,check:async()=>true}),r={principalRef:principal,change:{personRef:companyRecord,field:"pay_contract" as const,value:value()}};const p=await writer.preview(r);if(p.ok)assert.ok((await writer.confirm({...r,token:p.token})).ok);return p;}
  for(const role of ["org-owner","recruiter","finance"])assert.deepEqual(await drive([{org_id:COMPANY,role,scope:"self"}]),{ok:false,reason:"not_own_record"});
  assert.deepEqual(await drive([{org_id:"parent",role:"staff",scope:"self"}],COMPANY,["parent"]),{ok:false,reason:"not_own_record"});
  assert.equal((await drive([{org_id:"parent",role:"admin",scope:"subtree"}],COMPANY,["parent"])).ok,true);
  assert.deepEqual(await drive([{org_id:COMPANY,role:"staff",scope:"self"}],COMPANY,[],[COMPANY]),{ok:false,reason:"not_own_record"});
});

test("SHU-317/AC-03 company-bound check ",async()=>{assert.deepEqual(await previewWith(check(),value({companyId:"company-b"})),{ok:false,reason:"invalid_value"});});

test("SHU-317/AC-04 overlap-refused-at-preview periods and stores ",async()=>{
  const store=new subject.InMemoryPayContractStore(),refs=references();await new subject.PayContracts(store,refs).create(ACTOR,input());
  assert.deepEqual(await previewWith(check(store),value({startDate:"2026-06-01"})),{ok:false,reason:"invalid_value"});
  assert.equal((await previewWith(check(store),value({storeId:"store-b"}))).ok,true);
  const deleted=new subject.InMemoryPayContractStore();const made=await new subject.PayContracts(deleted,refs).create(ACTOR,input());await new subject.PayContracts(deleted,refs).remove(ACTOR,made.id);assert.equal((await previewWith(check(deleted))).ok,true);
});

test("SHU-317/AC-05 racing-overlap-state-changed creator ",async()=>{
  const contracts=new subject.InMemoryPayContractStore(),refs=references(),creator=subject.payContractCreator(refs);
  const safe=acceptingStore(async(commit:CommitInput)=>creator(contracts,ACTOR,COMPANY,commit.value));
  let domainCheck=check(contracts);const writer=subject.buildPayContractCreateWrite({store:safe,secret:TEST_SECRET,companyId:COMPANY,check:(company,v)=>domainCheck(company,v)}),r=request(),p=await writer.preview(r);assert.ok(p.ok);if(!p.ok)return;
  await new subject.PayContracts(contracts,refs).create(ACTOR,input());
  domainCheck=async()=>true; // the clash lands after confirm's check but before the transactional creator
  assert.deepEqual(await writer.confirm({...r,token:p.token}),{ok:false,reason:"state_changed"});assert.equal((await contracts.listForCandidate(CANDIDATE)).length,1);
});
