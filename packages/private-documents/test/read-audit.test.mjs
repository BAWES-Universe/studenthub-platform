import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
import {R2DocumentStore} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {png} from './candidate-fixtures.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
async function rig({audit=async()=>{}}={}){
 const alice=randomBytes(24).toString('base64url'),bob=randomBytes(24).toString('base64url'),bytes=png();
 const id=randomUUID(),version=randomUUID(),state={format:1,documents:[{id,version,type:'personal-photo',mime:'image/png',size:bytes.length,scope:{orgId:'org-a',personId:'alice'},acl:'private',data:bytes.toString('base64')}],retired:[]};
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'A'}],principals:['alice','bob'].map(id=>({id,pbuuids:[]}))});
 let transactions=0,reads=0,audits=0;
 const store={transaction:async fn=>{transactions++;return fn(structuredClone(state));},readPath:{read:async fn=>{reads++;return fn(structuredClone(state));},audit:async e=>{audits++;return audit(e);}}};
 const service=new CandidateDocuments({store,authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),now:()=>1800000000000,authenticate:async c=>c===alice?{kind:'principal',principalId:'alice'}:c===bob?{kind:'principal',principalId:'bob'}:null});
 return {service,alice,bob,id,counts:()=>({transactions,reads,audits})};
}

test('RA_AUDIT_ENTRY records the operation and hashed authenticated principal',async()=>{
 const entries=[],f=await rig({audit:async e=>entries.push(e)});
 await assert.doesNotReject(()=>f.service.list(f.alice));
 assert.equal(entries.length,1);assert.equal(entries[0].operation,'list');
 assert.equal(entries[0].principalRef,digest('alice'));assert.equal(entries[0].at,1800000000000);
});

test('RA_FAIL_CLOSED audit rejection returns no successful read',async()=>{
 const f=await rig({audit:async()=>{throw new Error('down');}});
 await assert.rejects(f.service.list(f.alice),e=>e?.status===503&&e?.code==='unavailable');
 assert.deepEqual(f.counts(),{transactions:0,reads:1,audits:1});
});

test('RA_DENIED refused reads append no audit',async()=>{
 const f=await rig();
 await assert.rejects(f.service.issueDelivery(f.bob,f.id),e=>e?.status===403&&e?.code==='denied');
 await assert.rejects(f.service.list('bad credential'),e=>e?.status===403&&e?.code==='denied');
 assert.deepEqual(f.counts(),{transactions:0,reads:1,audits:0},'ownership denial must precede audit');
});

test('RA_READ_PATH all reads make zero transaction calls',async()=>{
 const f=await rig();
 const listed=await f.service.list(f.alice);assert.equal(listed.length,1);
 const issued=await f.service.issueDelivery(f.alice,f.id);
 const delivered=await f.service.deliver(f.alice,issued.url);assert.ok(delivered.bytes.length>0);
 assert.deepEqual(f.counts(),{transactions:0,reads:3,audits:3});
});

test('RA_HYDRATE read path fetches only the object it serves',async()=>{
 const bytes=png(),id=randomUUID(),version=randomUUID(),key=`immutable/${version}/${digest(bytes)}`;
 const other=png(),otherId=randomUUID(),otherVersion=randomUUID(),otherKey=`immutable/${otherVersion}/${digest(other)}`;
 const packed={state:{format:1,documents:[{id,version,type:'personal-photo',mime:'image/png',size:bytes.length,scope:{orgId:'org-a',personId:'alice'},acl:'private',data:`r2:${key}`},{id:otherId,version:otherVersion,type:'personal-photo',mime:'image/png',size:other.length,scope:{orgId:'org-a',personId:'bob'},acl:'private',data:`r2:${otherKey}`}],retired:[]},blobs:{[key]:{key,digest:digest(bytes),size:bytes.length},[otherKey]:{key:otherKey,digest:digest(other),size:other.length}}};
 let objectReads=0,audits=0,transactions=0;
 const snapshots={transaction:async()=>{transactions++;throw new Error('unexpected');},reserve:async()=>{},read:async()=>structuredClone(packed),auditRead:async()=>{audits++;}};
 const store=new R2DocumentStore(snapshots,{read:async(k,n)=>{objectReads++;assert.equal(k,key,'must not fetch another principal document');assert.equal(n,bytes.length);return bytes;},writeImmutable:async()=>{}});
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'A'}],principals:[{id:'alice',pbuuids:[]}]});
 const token=randomBytes(24).toString('base64url'),service=new CandidateDocuments({store,authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),now:()=>1800000000000,authenticate:async c=>c===token?{kind:'principal',principalId:'alice'}:null});
 await assert.doesNotReject(()=>service.list(token));assert.equal(objectReads,0,'list must not hydrate objects');
 const link=await service.issueDelivery(token,id);assert.equal(objectReads,0,'link issue must not hydrate objects');
 const result=await service.deliver(token,link.url);assert.deepEqual(result.bytes,bytes);
 assert.equal(objectReads,1,'deliver hydrates exactly its one object');assert.equal(audits,3);assert.equal(transactions,0);
});
