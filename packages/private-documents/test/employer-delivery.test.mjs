import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
import {R2DocumentStore} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {StaffDocuments} from '../../../dist/packages/private-documents/src/staff-delivery.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {png,pdf} from './candidate-fixtures.mjs';
const moduleUrl=process.env.EMPLOYERDOC_MODULE ?? new URL('../../../dist/packages/private-documents/src/employer-delivery.js',import.meta.url).href;
const {EmployerDocuments,EMPLOYER_DELIVERY_PATH,EMPLOYER_LINK_TTL_MS}=await import(moduleUrl);
const sha=b=>createHash('sha256').update(b).digest('hex');
const REQ='223e4567-e89b-42d3-a456-426614174000',OTHER_REQ='323e4567-e89b-42d3-a456-426614174000';

// Recruit R5: employer document links. Sight is a port (the recruit area answers it);
// here a set of "viewer|subject|request" triples stands in for it.
async function rig({audit,now=1800000000000}={}){
 let clock=now;
 const ids=['subject','owner','other','staff'];
 const credentials=Object.fromEntries(ids.map(id=>[id,randomBytes(18).toString('base64url')]));
 const authz=new InMemoryAuthzStore({organizations:[{id:'candidate-org',name:'Candidates'},{id:'operator',name:'Operator'}],principals:ids.map(id=>({id,pbuuids:[]}))});
 await authz.grantMany('staff',[{orgId:'operator',role:'staff',scope:'subtree'}]);
 const photo=png(3),resume=pdf(),photoVersion=randomUUID(),resumeVersion=randomUUID();
 const rows=[{id:randomUUID(),version:photoVersion,type:'personal-photo',mime:'image/png',bytes:photo},{id:randomUUID(),version:resumeVersion,type:'resume',mime:'application/pdf',bytes:resume}];
 const blobs={},documents=[];
 for(const row of rows){const key=`immutable/${row.version}/${sha(row.bytes)}`;blobs[key]={key,digest:sha(row.bytes),size:row.bytes.length};documents.push({id:row.id,version:row.version,type:row.type,mime:row.mime,size:row.bytes.length,scope:{orgId:'candidate-org',personId:'subject'},acl:'private',data:`r2:${key}`});}
 const packed={state:{format:1,documents,retired:[]},blobs};
 const objects={read:async(key)=>Buffer.from(rows.find(r=>key.includes(r.version)).bytes),writeImmutable:async()=>{}};
 const snapshots={transaction:async fn=>fn(structuredClone(packed)),reserve:async()=>{},read:async()=>structuredClone(packed),auditRead:async()=>{}};
 const signingKey=randomBytes(32);
 const documentsService=new CandidateDocuments({store:new R2DocumentStore(snapshots,objects),authz,orgId:'candidate-org',origin:'https://documents.example.test',signingKey,now:()=>clock,authenticate:async c=>{const entry=Object.entries(credentials).find(([,v])=>v===c);return entry?{kind:'principal',principalId:entry[0]}:null;}});
 const sight=new Set([`owner|subject|${REQ}`]),events=[];
 const service=new EmployerDocuments({documents:documentsService,sight:{maySee:async(v,s,r)=>sight.has(`${v}|${s}|${r}`)},audit:{recordView:audit??(async e=>{events.push(e);})},now:()=>clock});
 return {service,documentsService,signingKey,credentials,events,sight,photo,resume,photoVersion,resumeVersion,packed,setNow:v=>{clock=v;}};
}

test('EMPLOYERDOC_SIGHT links and delivery need sight through the request, checked again on delivery',async()=>{
 const f=await rig();
 const links=await f.service.links(f.credentials.owner,'subject',REQ);
 assert.deepEqual(links.map(l=>l.type),['personal-photo','resume']);
 assert.ok(links.every(l=>l.url.startsWith(`${EMPLOYER_DELIVERY_PATH}?t=`)&&l.expiresAt===1800000000000+EMPLOYER_LINK_TTL_MS));
 assert.deepEqual((await f.service.deliver(f.credentials.owner,links[1].url)).bytes,f.resume);
 for(const [who,req] of [['other',REQ],['owner',OTHER_REQ]])await assert.rejects(f.service.links(f.credentials[who],'subject',req),e=>e?.code==='denied',`${who} ${req}`);
 await assert.rejects(f.service.links('bad','subject',REQ),e=>e?.code==='denied');
 await assert.rejects(f.service.links(f.credentials.owner,'subject','not-a-uuid'),e=>e?.code==='denied');
 f.sight.delete(`owner|subject|${REQ}`);
 await assert.rejects(f.service.deliver(f.credentials.owner,links[0].url),e=>e?.code==='denied','sight withdrawn after issue');
});

test('EMPLOYERDOC_BIND links bind viewer, expiry, version and their own signing domain',async()=>{
 const f=await rig(),[photo]=await f.service.links(f.credentials.owner,'subject',REQ);
 f.sight.add(`other|subject|${REQ}`);
 await assert.rejects(f.service.deliver(f.credentials.other,photo.url),e=>e?.code==='denied','another viewer with sight');
 f.setNow(1800000000000+EMPLOYER_LINK_TTL_MS);
 await assert.rejects(f.service.deliver(f.credentials.owner,photo.url),e=>e?.code==='denied','expired');
 f.setNow(1800000000000+EMPLOYER_LINK_TTL_MS-1);
 assert.deepEqual((await f.service.deliver(f.credentials.owner,photo.url)).bytes,f.photo);
 const [payload,mac]=photo.url.split('?t=')[1].split('.');
 const claim=JSON.parse(Buffer.from(payload,'base64url').toString());
 const forged=Buffer.from(JSON.stringify({...claim,type:'resume'})).toString('base64url');
 await assert.rejects(f.service.deliver(f.credentials.owner,`${EMPLOYER_DELIVERY_PATH}?t=${forged}.${mac}`),e=>e?.code==='denied','tampered claim');
 await assert.rejects(f.service.deliver(f.credentials.owner,`/workspace/civil-ids/delivery?t=${payload}.${mac}`),e=>e?.code==='denied','other path');
 await assert.rejects(f.service.deliver(f.credentials.owner,`${photo.url}&x=1`),e=>e?.code==='denied','extra parameter');
 const staff=new StaffDocuments({documents:f.documentsService,staffOrgIds:['operator'],audit:{recordView:async()=>{}},now:()=>1800000000000});
 const staffLink=await staff.issue(f.credentials.staff,'subject','personal-photo','person_page');
 f.sight.add(`staff|subject|${REQ}`);
 await assert.rejects(f.service.deliver(f.credentials.staff,staffLink.url.replace('/workspace/civil-ids/delivery',EMPLOYER_DELIVERY_PATH)),e=>e?.code==='denied','a staff token never verifies here');
 const staffMac=createHmac('sha256',f.signingKey).update('staff-delivery-v1\u0000'+payload).digest('base64url');
 await assert.rejects(f.service.deliver(f.credentials.owner,`${EMPLOYER_DELIVERY_PATH}?t=${payload}.${staffMac}`),e=>e?.code==='denied','a staff-domain signature over an employer claim never verifies');
 f.packed.state.documents.find(d=>d.type==='personal-photo').version=randomUUID();
 await assert.rejects(f.service.deliver(f.credentials.owner,photo.url),e=>e?.code==='denied','replaced document');
});

test('EMPLOYERDOC_AUDIT every issue and delivery is recorded with the request; a failed audit exposes nothing',async()=>{
 const f=await rig(),links=await f.service.links(f.credentials.owner,'subject',REQ);
 await f.service.deliver(f.credentials.owner,links[0].url);
 assert.deepEqual(f.events.map(e=>[e.operation,e.documentType,e.requestId,e.viewerPrincipalId,e.subjectPrincipalId]),[['issue','personal-photo',REQ,'owner','subject'],['issue','resume',REQ,'owner','subject'],['deliver','personal-photo',REQ,'owner','subject']]);
 const broken=await rig({audit:async()=>{throw Error('down');}});
 await assert.rejects(broken.service.links(broken.credentials.owner,'subject',REQ),e=>e?.code==='unavailable');
});
