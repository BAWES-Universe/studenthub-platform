import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {InMemoryAuthzStore} from "../../../dist/packages/contracts/src/index.js";
import {StaffDocuments} from "../../../dist/packages/private-documents/src/staff-delivery.js";

test("REV_IMAGES staff links bind viewer, subject, slot and version and audit before bytes",async()=>{
 const authz=new InMemoryAuthzStore({organizations:[{id:"root",name:"Operator"}],principals:["staff","other","person"].map(id=>({id,pbuuids:[]}))});
 await authz.grantMany("staff",[{orgId:"root",role:"staff",scope:"subtree"}]);await authz.grantMany("other",[{orgId:"root",role:"staff",scope:"subtree"}]);
 const tokens=new Map([["s","staff"],["o","other"]]),front=randomUUID(),back=randomUUID(),events=[];
 const state={format:1,retired:[],documents:[
  {id:randomUUID(),version:front,type:"civil-id-front",mime:"image/png",size:3,scope:{orgId:"docs",personId:"person"},acl:"private",data:Buffer.from("one").toString("base64")},
  {id:randomUUID(),version:back,type:"civil-id-back",mime:"image/png",size:3,scope:{orgId:"docs",personId:"person"},acl:"private",data:Buffer.from("two").toString("base64")}]};
 const service=new StaffDocuments({orgId:"docs",origin:"https://example.test",signingKey:randomBytes(32),store:{transaction:async fn=>fn(state)},authz,
  authenticate:async token=>tokens.has(token)?{kind:"principal",principalId:tokens.get(token)}:null,staffOrgIds:["root"],audit:{recordView:async x=>events.push(x)},now:()=>1000});
 const link=await service.issue("s","person","civil-id-front","civil_id_review");assert.equal(events[0].kind,"civil_id_image_issue");
 assert.deepEqual((await service.deliver("s",link.url)).bytes,Buffer.from("one"));assert.equal(events[1].kind,"civil_id_image_deliver");
 await assert.rejects(service.deliver("o",link.url),/denied/);
 state.documents[0].version=back;await assert.rejects(service.deliver("s",link.url),/denied/);
});

test("REV_STAFF staff delivery refuses missing grant and own civil review",async()=>{
 const authz=new InMemoryAuthzStore({organizations:[{id:"root",name:"Operator"}],principals:[{id:"person",pbuuids:[]}]});
 const service=new StaffDocuments({orgId:"docs",origin:"https://example.test",signingKey:randomBytes(32),store:{transaction:async fn=>fn({format:1,documents:[],retired:[]})},authz,authenticate:async()=>({kind:"principal",principalId:"person"}),staffOrgIds:["root"],audit:{recordView:async()=>{}}});
 await assert.rejects(service.documents("x","person"),/denied/);
});
