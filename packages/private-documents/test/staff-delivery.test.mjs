import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
import {R2DocumentStore} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {png,pdf} from './candidate-fixtures.mjs';
const moduleUrl=process.env.STAFFDOC_MODULE ?? new URL('../../../dist/packages/private-documents/src/staff-delivery.js',import.meta.url).href;
const {StaffDocuments,STAFF_DELIVERY_PATH}=await import(moduleUrl);
const sha=b=>createHash('sha256').update(b).digest('hex');

async function rig({audit,now=1800000000000}={}){
 let clock=now;
 const ids=['subject','staff','admin','other','candidate','owner','selfstaff','foreign'];
 const credentials=Object.fromEntries(ids.map(id=>[id,randomBytes(18).toString('base64url')]));
 const authz=new InMemoryAuthzStore({organizations:[{id:'candidate-org',name:'Candidates'},{id:'operator',name:'Operator'},{id:'foreign-org',name:'Foreign'}],principals:ids.map(id=>({id,pbuuids:[]}))});
 await authz.grantMany('staff',[{orgId:'operator',role:'staff',scope:'subtree'}]);
 await authz.grantMany('admin',[{orgId:'operator',role:'admin',scope:'subtree'}]);
 await authz.grantMany('candidate',[{orgId:'operator',role:'candidate',scope:'subtree'}]);
 await authz.grantMany('owner',[{orgId:'operator',role:'org-owner',scope:'subtree'}]);
 await authz.grantMany('selfstaff',[{orgId:'operator',role:'staff',scope:'self'}]);
 await authz.grantMany('foreign',[{orgId:'foreign-org',role:'staff',scope:'subtree'}]);
 const front=png(4),resume=pdf(),frontId=randomUUID(),frontVersion=randomUUID(),resumeId=randomUUID(),resumeVersion=randomUUID();
 const rows=[{id:frontId,version:frontVersion,type:'civil-id-front',mime:'image/png',bytes:front},{id:resumeId,version:resumeVersion,type:'resume',mime:'application/pdf',bytes:resume}];
 const blobs={},documents=[];
 for(const row of rows){const key=`immutable/${row.version}/${sha(row.bytes)}`;blobs[key]={key,digest:sha(row.bytes),size:row.bytes.length};documents.push({id:row.id,version:row.version,type:row.type,mime:row.mime,size:row.bytes.length,scope:{orgId:'candidate-org',personId:'subject'},acl:'private',data:`r2:${key}`});}
 let packed={state:{format:1,documents,retired:[]},blobs},objectReads=0,grantReads=0;
 const originalList=authz.listGrantsForPrincipal.bind(authz);authz.listGrantsForPrincipal=async id=>{grantReads++;return originalList(id);};
 const objects={read:async(key)=>{objectReads++;const row=rows.find(r=>key.includes(r.version));return Buffer.from(row.bytes);},writeImmutable:async()=>{}};
 const snapshots={transaction:async fn=>fn(structuredClone(packed)),reserve:async()=>{},read:async()=>structuredClone(packed),auditRead:async()=>{}};
 const store=new R2DocumentStore(snapshots,objects),key=randomBytes(32),events=[];
 const documentsService=new CandidateDocuments({store,authz,orgId:'candidate-org',origin:'https://documents.example.test',signingKey:key,now:()=>clock,authenticate:async c=>{const entry=Object.entries(credentials).find(([,v])=>v===c);return entry?{kind:'principal',principalId:entry[0]}:null;}});
 const auditPort={recordView:audit??(async e=>{events.push(e);})};
 const service=new StaffDocuments({documents:documentsService,staffOrgIds:['operator'],audit:auditPort,now:()=>clock});
 return {service,documentsService,authz,credentials,events,key,front,frontId,frontVersion,resumeId,resumeVersion,counts:()=>({objectReads,grantReads}),setNow:value=>{clock=value;},replaceFront(){const next=randomUUID();packed.state.documents.find(d=>d.id===frontId).version=next;return next;}};
}

test('STAFFDOC_GATE exact staff gate and grant re-read',async()=>{
 const f=await rig(),staffLink=await f.service.issue(f.credentials.staff,'subject','civil-id-front','civil_id_review');
 for(const who of ['other','candidate','owner','selfstaff','foreign']){
  await assert.rejects(f.service.documents(f.credentials[who],'subject'),e=>e?.code==='denied',`${who} documents denied`);
  await assert.rejects(f.service.issue(f.credentials[who],'subject','civil-id-front','civil_id_review'),e=>e?.code==='denied',`${who} issue denied`);
  await assert.rejects(f.service.deliver(f.credentials[who],staffLink.url),e=>e?.code==='denied',`${who} deliver denied`);
 }
 await assert.rejects(f.service.documents('bad','subject'),e=>e?.code==='denied','no session denied');
 await assert.rejects(f.service.issue('bad','subject','civil-id-front','civil_id_review'),e=>e?.code==='denied','no session issue denied');
 await assert.rejects(f.service.deliver('bad',staffLink.url),e=>e?.code==='denied','no session deliver denied');
 await assert.equal((await f.service.documents(f.credentials.staff,'subject')).length,2,'staff subtree served');
 await assert.equal((await f.service.documents(f.credentials.admin,'subject')).length,2,'admin subtree served');
 await assert.deepEqual((await f.service.deliver(f.credentials.admin,(await f.service.issue(f.credentials.admin,'subject','civil-id-front','civil_id_review')).url)).bytes,f.front,'admin subtree delivers');
 const link=await f.service.issue(f.credentials.staff,'subject','civil-id-front','civil_id_review');
 await f.authz.clearGrantsForPrincipal('staff');
 await assert.rejects(f.service.deliver(f.credentials.staff,link.url),e=>e?.code==='denied','removed grant denies deliver');
 assert.ok(f.counts().grantReads>=14,'grant store is read on every call');
});

test('STAFFDOC_BIND viewer expiry slot version and signing domains',async()=>{
 const f=await rig(),link=await f.service.issue(f.credentials.staff,'subject','civil-id-front','civil_id_review');
 assert.deepEqual((await f.service.deliver(f.credentials.staff,link.url)).bytes,f.front,'bound viewer receives bytes');
 await assert.rejects(f.service.deliver(f.credentials.admin,link.url),e=>e?.code==='denied','viewer binding');
 const raw=new URL(link.url,'https://documents.example.test'),[payload]=raw.searchParams.get('t').split('.');
 const claim=JSON.parse(Buffer.from(payload,'base64url'));claim.type='resume';const changed=Buffer.from(JSON.stringify(claim)).toString('base64url');
 const sign=p=>createHmac('sha256',f.key).update('staff-delivery-v1\0'+p).digest('base64url');
 await assert.rejects(f.service.deliver(f.credentials.staff,`${STAFF_DELIVERY_PATH}?t=${changed}.${sign(changed)}`),e=>e?.code==='denied','slot binding');
 f.replaceFront();await assert.rejects(f.service.deliver(f.credentials.staff,link.url),e=>e?.code==='denied','version binding');
 const wrong=createHmac('sha256',f.key).update('owner-delivery-v1\0'+payload).digest('base64url');
 await assert.rejects(f.service.deliver(f.credentials.staff,`${STAFF_DELIVERY_PATH}?t=${payload}.${wrong}`),e=>e?.code==='denied','literal signing label');
 const g=await rig();const positive=await g.service.issue(g.credentials.staff,'subject','civil-id-front','civil_id_review'),u=new URL(positive.url,'https://documents.example.test'),p=u.searchParams.get('t').split('.')[0];u.searchParams.set('t',p+'.'+createHmac('sha256',g.key).update('staff-delivery-v1\0'+p).digest('base64url'));
 await assert.doesNotReject(()=>g.service.deliver(g.credentials.staff,u.pathname+u.search),'positive literal label pin');
 const owner=await g.documentsService.issueDelivery(g.credentials.subject,g.frontId);
 await assert.rejects(g.service.deliver(g.credentials.staff,owner.url),e=>e?.code==='denied','owner MAC refused');
 await assert.rejects(g.documentsService.deliver(g.credentials.staff,positive.url),e=>e?.code==='denied','staff MAC refused by owner');
 const expired=await rig(),expiring=await expired.service.issue(expired.credentials.staff,'subject','civil-id-front','civil_id_review');expired.setNow(1800000060000);await assert.rejects(expired.service.deliver(expired.credentials.staff,expiring.url),e=>e?.code==='denied','60 second expiry');
});

test('STAFFDOC_AUDIT writes first and fails closed',async()=>{
 const f=await rig(),link=await f.service.issue(f.credentials.staff,'subject','civil-id-front','civil_id_review');
 await f.service.deliver(f.credentials.staff,link.url);
 assert.deepEqual(f.events.map(e=>e.kind),['civil_id_image_issue','civil_id_image_deliver'],'civil audit kinds');
 assert.deepEqual(f.events[0],{viewerPrincipalId:'staff',subjectPrincipalId:'subject',kind:'civil_id_image_issue',documentType:'civil-id-front',documentVersion:f.frontVersion},'audit has complete bound values');
 const before=f.events.length;await f.service.documents(f.credentials.staff,'subject');assert.equal(f.events.length,before,'documents records nothing');
 await assert.rejects(f.service.issue(f.credentials.staff,'staff','civil-id-front','civil_id_review'),e=>e?.code==='denied','self review denied');
 await assert.rejects(f.service.issue(f.credentials.staff,'subject','resume','civil_id_review'),e=>e?.code==='denied','civil purpose slot denied');
 const person=await f.service.issue(f.credentials.staff,'subject','resume','person_page');await f.service.deliver(f.credentials.staff,person.url);assert.deepEqual(f.events.slice(-2).map(e=>e.kind),['person_document_issue','person_document_deliver'],'person audit kinds');
 let calls=0;const rejected=await rig({audit:async()=>{calls++;throw new Error('audit down');}});
 await assert.rejects(rejected.service.issue(rejected.credentials.staff,'subject','civil-id-front','civil_id_review'),e=>e?.code==='unavailable','failed issue audit returns no link');
 const good=await rig(),issued=await good.service.issue(good.credentials.staff,'subject','civil-id-front','civil_id_review');good.service.options.audit.recordView=async()=>{throw new Error('audit down');};
 await assert.rejects(good.service.deliver(good.credentials.staff,issued.url),e=>e?.code==='unavailable','failed delivery audit returns no bytes');assert.equal(good.counts().objectReads,0,'audit failure precedes hydration');assert.equal(calls,1);
});

test('STAFFDOC_BYTES hydrates exact R2 bytes and hardens response',async()=>{
 const f=await rig(),link=await f.service.issue(f.credentials.staff,'subject','civil-id-front','civil_id_review');
 assert.equal(f.counts().objectReads,0,'issue does not hydrate');
 const delivered=await f.service.deliver(f.credentials.staff,link.url).then(result=>result,e=>e?.code);
 assert.notEqual(typeof delivered,'string','stored R2 bytes served');
 const result=delivered;
 assert.deepEqual(result.bytes,f.front,'stored R2 bytes served');assert.equal(f.counts().objectReads,1,'read hydrator called exactly once');
 assert.deepEqual(result.headers,{'Content-Type':'image/png','Content-Length':String(f.front.length),'Content-Disposition':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox"},'hardened inline headers');
 const payload=new URL(link.url,'https://documents.example.test').searchParams.get('t').split('.')[0];
 const decoded=Buffer.from(payload,'base64url').toString('utf8');
 assert.equal(decoded.includes(f.frontId)||decoded.includes(`immutable/${f.frontVersion}`)||decoded.includes('r2:'),false,'link leaks no storage path or document id');
});
