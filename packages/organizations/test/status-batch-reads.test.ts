import assert from "node:assert/strict";
import test from "node:test";
import {InMemoryAuthzStore,createPrincipal} from "@studenthub/contracts";
import {InMemoryApprovedOrganizationAdapter} from "../src/adapter.js";
import type {OrganizationStatusRecord,OrganizationStatusRecords} from "../src/organizations.js";
import * as normalOrganizations from "../src/organizations.js";

const organizations=process.env.SHU308_ORG_MODULE
  ? await import(process.env.SHU308_ORG_MODULE) as typeof normalOrganizations
  : normalOrganizations;
const {OrganizationRepository}=organizations;
const importedAt="2025-01-01T00:00:00.000Z",revision="c2ce255695eabc7e3a0f23b162f5996274234c63";
const row=(orgId:string,parentOrgId:string|null,override:number=0)=>({org_id:orgId,parent_org_id:parentOrgId,source_revision:revision,imported_at:importedAt,company_name:`Company ${orgId}`,company_common_name_en:`Common ${orgId}`,company_common_name_ar:`Arabic ${orgId}`,company_description_en:"Description",company_description_ar:"Description",company_website:"https://example.invalid",currency_code:"KWD",company_approved_to_hire:1,company_status_override:override,company_hourly_rate:"10",company_email:`${orgId}@example.invalid`,company_bonus_commission:"1",total_candidate:0,is_request_updates_in_30_days:0,no_of_active_requests:0});

async function fixture(kind:"directory"|"children",statusRecords:OrganizationStatusRecords){
  const registry=kind==="directory"
    ? [{id:"root",name:"Root"},{id:"a",name:"A",parentOrgId:"root"},{id:"b",name:"B",parentOrgId:"root"},{id:"c",name:"C",parentOrgId:"root"}]
    : [{id:"root",name:"Root"},{id:"parent",name:"Parent",parentOrgId:"root"},{id:"child-a",name:"Child A",parentOrgId:"parent"},{id:"child-b",name:"Child B",parentOrgId:"parent"}];
  const store=new InMemoryAuthzStore({principals:[createPrincipal({id:"staff",pbuuids:["staff-pbuuid"]})],organizations:registry});
  await store.grantMany("staff",[{orgId:"root",role:"staff",scope:"subtree"}]);
  const snapshots=new Map<string,unknown>();
  for(const org of registry)if(org.id!=="root")snapshots.set(org.id,row(org.id,org.parentOrgId==="root"?null:org.parentOrgId??null,org.id==="c"?9:0));
  return new OrganizationRepository({store,source:new InMemoryApprovedOrganizationAdapter(snapshots),statusRecords});
}

function counting(records:ReadonlyMap<string,OrganizationStatusRecord>){
  let reads=0,batches=0,ids:readonly string[]=[];
  return {port:{read:async()=>{reads++;return {kind:"absent"} as const},readMany:async(orgIds:readonly string[])=>{batches++;ids=orgIds;return records}},counts:()=>({reads,batches,ids})};
}

test("SHU-308/AC-01 directory-reads-once",async()=>{
  const x=counting(new Map([["a",{kind:"status",status:"inactive"}],["b",{kind:"status",status:"active"}],["c",{kind:"cleared"}]] as const));
  const result=await(await fixture("directory",x.port)).listOrganizations({principalId:"staff",orgId:"root",role:"staff"});
  assert.equal(result.kind,"found");if(result.kind!=="found")return;
  assert.deepEqual(x.counts(),{reads:0,batches:1,ids:["a","b","c"]});
  assert.deepEqual(result.directory.entries.map(entry=>[entry.orgId,entry.status]),[["a",{state:"available",value:"inactive",sourceField:"company_status_override, total_candidate, is_request_updates_in_30_days, no_of_active_requests"}],["b",{state:"available",value:"active",sourceField:"company_status_override, total_candidate, is_request_updates_in_30_days, no_of_active_requests"}],["c",{state:"available",value:"inactive",sourceField:"company_status_override, total_candidate, is_request_updates_in_30_days, no_of_active_requests"}]]);
});

test("SHU-308/AC-02 sub-list-reads-once",async()=>{
  const x=counting(new Map([["child-a",{kind:"status",status:"under_review"}],["child-b",{kind:"status",status:"inactive"}]] as const));
  const result=await(await fixture("children",x.port)).listSubOrganizations({principalId:"staff",orgId:"parent",role:"staff"});
  assert.equal(result.kind,"found");if(result.kind!=="found")return;
  assert.deepEqual(x.counts(),{reads:0,batches:1,ids:["child-a","child-b"]});
  assert.deepEqual(result.subOrganizations.map(entry=>[entry.orgId,entry.status.state==="available"?entry.status.value:null]),[["child-a","under_review"],["child-b","inactive"]]);
});

test("SHU-308/AC-03 missing-means-absent",async()=>{
  const x=counting(new Map());const result=await(await fixture("directory",x.port)).listOrganizations({principalId:"staff",orgId:"root",role:"staff"});
  assert.equal(result.kind,"found");if(result.kind!=="found")return;
  const company=result.directory.entries.find(entry=>entry.orgId==="c");
  assert.deepEqual(company?.status,{state:"available",value:"under_review",sourceField:"company_status_override, total_candidate, is_request_updates_in_30_days, no_of_active_requests"});
});

test("SHU-308 fallback read-only port preserves results",async()=>{
  let reads=0;const records=new Map<string,OrganizationStatusRecord>([["a",{kind:"status",status:"inactive"}],["b",{kind:"status",status:"active"}]]);
  const repository=await fixture("directory",{read:async id=>{reads++;return records.get(id)??{kind:"absent"}}});
  const result=await repository.listOrganizations({principalId:"staff",orgId:"root",role:"staff"});
  assert.equal(result.kind,"found");if(result.kind!=="found")return;
  assert.equal(reads,3);assert.deepEqual(result.directory.entries.map(entry=>entry.status.state==="available"?entry.status.value:null),["inactive","active","under_review"]);
});
