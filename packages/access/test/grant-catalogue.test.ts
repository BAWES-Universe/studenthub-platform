import assert from "node:assert/strict";
import test from "node:test";
import * as normal from "../src/grant-catalogue.js";
const subject=process.env.SHU453_CATALOGUE_MODULE?await import(process.env.SHU453_CATALOGUE_MODULE) as typeof normal:normal;
const grant=(role:string,orgId="root",scope="self")=>({id:"g",principalId:"p",orgId,role,scope}) as never;
const organizations=[{id:"root",name:"Operator"},{id:"company",name:"Company",parentOrgId:"root"}];
test("SHU453_CATALOGUE closed grant catalogue",()=>{
  assert.deepEqual(subject.grantCatalogue([grant("admin")],organizations[0]!,organizations).map(x=>x.role),["staff","admin","finance"]);
  assert.deepEqual(subject.grantCatalogue([grant("recruiter")],organizations[1]!,organizations),[]);
  assert.deepEqual(subject.grantCatalogue([grant("staff","company")],organizations[1]!,organizations).map(x=>[x.role,x.scopes]),[["org-owner",["self"]],["recruiter",["self"]],["finance",["self"]]]);
  assert.equal(subject.grantCatalogue([grant("admin","root","subtree")],organizations[1]!,organizations).every(x=>x.scopes.includes("subtree")),true);
  for(const role of["candidate","recruiter","finance","org-owner"])assert.deepEqual(subject.grantCatalogue([grant(role,"company")],organizations[1]!,organizations),[]);
});
