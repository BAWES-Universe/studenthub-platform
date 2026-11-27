import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '@studenthub/db';
import {PostgresDocumentPartitions,PartitionedR2DocumentStore,R2DocumentStore,emptyPackedSnapshot} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
import {listCivilIdPhotos} from '../../../dist/packages/private-documents/src/civil-id-reads.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {createIdempotencyKey} from '../../../dist/packages/idempotency-contract/src/index.js';
import {png} from './candidate-fixtures.mjs';
const url=process.env.DATABASE_URL;
const unavailable={skip:!url?'requires configured scratch PostgreSQL':false};
let pool,snapshots;
before(async()=>{if(url){pool=new pg.Pool({connectionString:url});await runMigrations(pool);snapshots=new PostgresDocumentPartitions(url);}});
after(async()=>{await snapshots?.close();await pool?.end();});
const digest=value=>createHash('sha256').update(value).digest('hex');
// Owner rows, ids and slot history are never deleted, so every test uses its own people.
const person=()=>`p-${randomUUID()}`;
const row=async(kind,id)=>(await pool.query('SELECT xmin::text, snapshot FROM candidate_document_partitions WHERE owner_kind=$1 AND owner_id=$2',[kind,id])).rows[0];
async function readRig(){
 const now=Date.now()+Math.floor(Math.random()*1000000),alice=person();
 const bytes=png(),id=randomUUID(),version=randomUUID(),key=`immutable/${version}/${digest(bytes)}`;
 const packed={state:{format:1,documents:[{id,version,type:'personal-photo',mime:'image/png',size:bytes.length,scope:{orgId:'org-a',personId:alice},acl:'private',data:`r2:${key}`}],retired:[],lifecycle:{format:1,uploads:[],receipts:[],cleanup:[],audit:[]}},blobs:{[key]:{key,digest:digest(bytes),size:bytes.length}}};
 await pool.query("INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ('person',$1,$2::jsonb)",[alice,JSON.stringify(packed)]);
 const credential=randomBytes(24).toString('base64url'),authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'A'}],principals:[{id:alice,pbuuids:[]}]});
 const store=new PartitionedR2DocumentStore(snapshots,{read:async(k,n)=>{assert.equal(k,key);assert.equal(n,bytes.length);return bytes;},writeImmutable:async()=>{}});
 const service=new CandidateDocuments({store,authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),now:()=>now,authenticate:async c=>c===credential?{kind:'principal',principalId:alice}:null});
 return {service,credential,id,packed,now,alice};
}
async function within(promise,message){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new assert.AssertionError({message})),3000);})]);}finally{clearTimeout(timer);}
}
async function writerPoolExhausted(){
 await within(new Promise(resolve=>{const poll=()=>snapshots.pool?.totalCount===2&&snapshots.pool?.idleCount===0?resolve():setTimeout(poll,10);poll();}),'writer pool was not exhausted');
}
async function runReads(f){
 const listed=await f.service.list(f.credential);assert.equal(listed.length,1);
 const issued=await f.service.issueDelivery(f.credential,f.id);assert.equal(typeof issued.url,'string');
 const delivered=await f.service.deliver(f.credential,issued.url);assert.deepEqual(delivered.bytes,png());
}
/** A candidate service over the real per-owner store and in-memory objects. */
function candidates(people,objects=new Map()){
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic'}],principals:people.map(id=>({id,pbuuids:[]}))});
 const store=new PartitionedR2DocumentStore(snapshots,{read:async k=>Buffer.from(objects.get(k)),writeImmutable:async(k,b)=>{objects.set(k,Buffer.from(b));}});
 const credentials=Object.fromEntries(people.map(p=>[p,randomBytes(32).toString('base64url')]));
 const service=new CandidateDocuments({store,authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),
  authenticate:async c=>{const p=people.find(x=>credentials[x]===c);return p?{kind:'principal',principalId:p}:null;}});
 return {service,store,credentials,objects};
}
async function upload(f,who,bytes=png()){
 const a=(await f.service.authorizeUpload(f.credentials[who],createIdempotencyKey(),{type:'personal-photo',mime:'image/png',size:bytes.length,expectedVersion:null})).body;
 await f.service.put(f.credentials[who],createIdempotencyKey(),a.uploadId,a.objectKey,a.credential,bytes);
 return a;
}

test('SHU-145/PG-01 metadata callback rollback preserves state and durable quarantine reservations',unavailable,async()=>{
 const key=`uploads/${randomUUID()}`,owner={kind:'person',id:person()};
 await assert.rejects(snapshots.transaction(owner,async s=>{await snapshots.reserve(key);s.state.lifecycle={format:1,uploads:[],receipts:[],cleanup:[],audit:[]};throw new Error('synthetic failure');}),{message:'unavailable'});
 assert.equal(await row('person',owner.id),undefined,'the owner row created for the lock rolls back too');
 assert.equal((await pool.query('SELECT retention_status FROM candidate_document_object_reservations WHERE object_key=$1',[key])).rows[0].retention_status,'held');
});

test('SHU-145/PG-02 concurrent adapter instances serialize updates of one owner',unavailable,async()=>{
 const second=new PostgresDocumentPartitions(url),owner={kind:'person',id:person()};
 try {
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?snapshots:second).transaction(owner,async s=>{
   s.state.lifecycle??={format:1,uploads:[],receipts:[],cleanup:[],audit:[]};
   await new Promise(r=>setImmediate(r));
   s.state.lifecycle.audit.push({id:randomUUID(),operation:'finalize',principalRef:digest(owner.id),at:Date.now()});
  })));
  assert.equal((await row('person',owner.id)).snapshot.state.lifecycle.audit.length,12);
 }finally{await second.close();}
});

test('SHU-145/PG-03 real SQL and synthetic private objects recover an uncertain metadata commit',unavailable,async()=>{
 const bytes=new Map(),alice=person();let uncertain=false;
 const port=snapshots.port({kind:'person',id:alice});
 const backing={reserve:k=>port.reserve(k),transaction:async fn=>{const r=await port.transaction(fn);if(uncertain){uncertain=false;throw new Error('synthetic uncertain commit');}return r;}};
 const store=new R2DocumentStore(backing,{read:async k=>Buffer.from(bytes.get(k)),writeImmutable:async(k,b)=>{
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM candidate_document_object_reservations WHERE object_key=$1',[k])).rows[0].n,1);
  bytes.set(k,Buffer.from(b));
 }});
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic'}],principals:[{id:alice,pbuuids:[]}]});
 await authz.grantMany(alice,[{orgId:'org-a',role:'candidate',scope:'self'}]);
 const credential=randomBytes(32).toString('base64url'),service=new CandidateDocuments({store,authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),authenticate:async c=>c===credential?{kind:'principal',principalId:alice}:null});
 const a=(await service.authorizeUpload(credential,createIdempotencyKey(),{type:'personal-photo',mime:'image/png',size:png().length,expectedVersion:null})).body;
 await service.put(credential,createIdempotencyKey(),a.uploadId,a.objectKey,a.credential,png());
 const key=createIdempotencyKey();uncertain=true;
 await assert.rejects(service.finalize(credential,key,{uploadId:a.uploadId}),e=>e.code==='unavailable');
 const result=await service.finalize(credential,key,{uploadId:a.uploadId});assert.equal(result.status,200);
 const packed=(await row('person',alice)).snapshot;
 assert.equal(packed.state.lifecycle.audit.length,1);assert.equal(packed.state.documents.length,1);
 assert.ok(packed.state.documents[0].data.startsWith('r2:'));
 assert.deepEqual((await service.deliver(credential,(await service.issueDelivery(credential,result.body.metadata.id)).url)).bytes,png());
});

test('RA_NO_LOCK reader and audit pool bypass a locked or exhausted writer pool',unavailable,async()=>{
 const f=await readRig();
 const locker=await pool.connect();
 try{
  await locker.query('BEGIN');await locker.query("SELECT snapshot FROM candidate_document_partitions WHERE owner_kind='person' AND owner_id=$1 FOR UPDATE",[f.alice]);
  await assert.doesNotReject(()=>within(runReads(f),'service reads queued behind row lock'));
 }finally{await locker.query('ROLLBACK');locker.release();}
 let release;const parked=new Promise(r=>release=r);
 let firstEntered;const entered=new Promise(r=>firstEntered=r);
 const parkedOwner={kind:'person',id:person()};
 const first=snapshots.transaction(parkedOwner,async()=>{firstEntered();return parked;});
 await entered;
 const second=snapshots.transaction(parkedOwner,async()=>{});
 await writerPoolExhausted();
 try{
  await assert.doesNotReject(()=>within(runReads(f),'service reads or audits used writer pool'));
 }finally{release();await Promise.all([first,second]);}
});

test('RA_NO_WRITE plain reads do not rewrite the owner row',unavailable,async()=>{
 const f=await readRig();
 const before=await row('person',f.alice);
 for(let i=0;i<20;i++)await assert.doesNotReject(async()=>{const listed=await f.service.list(f.credential);const issued=await f.service.issueDelivery(f.credential,f.id);await f.service.deliver(f.credential,issued.url);assert.equal(listed.length,1);});
 const afterRead=await row('person',f.alice);
 assert.deepEqual(afterRead,before,'read path must not update the owner row');
 assert.equal(afterRead.snapshot.state.lifecycle.audit.length,0,'read audits must not grow lifecycle state');
});

test('RA_AUDIT_ROW audit rows are minimal, constrained and append-only',unavailable,async()=>{
 const f=await readRig(),ref=digest(f.alice),at=f.now;
 await assert.doesNotReject(()=>f.service.issueDelivery(f.credential,f.id));
 const rows=(await pool.query('SELECT * FROM candidate_document_read_audit WHERE principal_ref=$1 AND occurred_at=to_timestamp($2 / 1000.0)',[ref,at])).rows;
 assert.equal(rows.length,1,'one service read must append one audit row');
 const row=rows[0];
 assert.deepEqual(Object.keys(row).sort(),['id','occurred_at','operation','principal_ref']);assert.equal(row.operation,'issueDelivery');assert.equal(row.principal_ref,ref);assert.ok(Math.abs(row.occurred_at.getTime()-at)<2);
 await assert.rejects(pool.query('UPDATE candidate_document_read_audit SET operation=$1 WHERE id=$2',['list',row.id]));
 await assert.rejects(pool.query('DELETE FROM candidate_document_read_audit WHERE id=$1',[row.id]));
 await assert.rejects(pool.query('TRUNCATE candidate_document_read_audit'));
 await assert.rejects(pool.query('INSERT INTO candidate_document_read_audit(id,operation,principal_ref,occurred_at) VALUES($1,$2,$3,now())',[randomUUID(),'bad',ref]));
});

test('PART-01 a write locks and reads only its owner: a locked person never blocks another, and unrelated bodies are never read',unavailable,async()=>{
 const [alice,bob]=[person(),person()],f=candidates([alice,bob]);
 const reads=[];const objects=f.objects;
 const watched=new PartitionedR2DocumentStore(snapshots,{read:async k=>{reads.push(k);return Buffer.from(objects.get(k));},writeImmutable:async(k,bytes)=>{objects.set(k,Buffer.from(bytes));}});
 const g={...f,service:new CandidateDocuments({...f.service.options,store:watched})};
 const bobUpload=await upload(g,bob);await g.service.finalize(f.credentials[bob],createIdempotencyKey(),{uploadId:bobUpload.uploadId});
 reads.length=0;
 const locker=await pool.connect();
 try{
  await locker.query('BEGIN');await locker.query("SELECT 1 FROM candidate_document_partitions WHERE owner_kind='person' AND owner_id=$1 FOR UPDATE",[bob]);
  const a=await within(upload(g,alice),'a write for alice waited on bob');
  await within(g.service.finalize(f.credentials[alice],createIdempotencyKey(),{uploadId:a.uploadId}),'alice finalize waited on bob');
 }finally{await locker.query('ROLLBACK');locker.release();}
 const bobKeys=Object.keys((await row('person',bob)).snapshot.blobs);
 assert.ok(bobKeys.length>0);
 assert.ok(!reads.some(k=>bobKeys.includes(k)),'no body of another owner is read');
});

test('PART-02 same-slot race: two uploads into an empty slot commit exactly one document',unavailable,async()=>{
 const alice=person(),f=candidates([alice]);
 const [a,b]=await Promise.all([upload(f,alice,png(1)),upload(f,alice,png(2))]);
 const results=await Promise.allSettled([a,b].map(t=>f.service.finalize(f.credentials[alice],createIdempotencyKey(),{uploadId:t.uploadId})));
 assert.deepEqual(results.map(r=>r.status).sort(),['fulfilled','rejected']);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'conflict');
 const state=(await row('person',alice)).snapshot.state;
 assert.equal(state.documents.length,1);assert.equal(state.retired.length,0);
 assert.deepEqual((await pool.query('SELECT type, state FROM candidate_document_slots WHERE person_id=$1',[alice])).rows,[{type:'personal-photo',state:'active'}]);
});

test('PART-03 injected failures roll back metadata, id index and slot history together',unavailable,async()=>{
 const alice=person(),f=candidates([alice]),t=await upload(f,alice);
 const before=await row('person',alice);
 // An id already held by another owner fails the index step after the owner row was updated.
 const port=snapshots.port({kind:'person',id:alice}),stolen=randomUUID(),other=person();
 await pool.query("INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ('person',$1,$2::jsonb) ON CONFLICT DO NOTHING",[other,JSON.stringify(emptyPackedSnapshot())]);
 await pool.query("INSERT INTO candidate_document_ids (document_id, owner_kind, owner_id) VALUES ($1,'person',$2)",[stolen,other]);
 await assert.rejects(port.transaction(async s=>{s.state.documents.push({id:stolen,version:randomUUID(),type:'resume',mime:'application/pdf',size:1,scope:{orgId:'org-a',personId:alice},acl:'private',data:'r2:x'});}),{message:'unavailable'});
 // A document scoped to someone else is refused before anything is written.
 await assert.rejects(port.transaction(async s=>{s.state.documents.push({id:randomUUID(),version:randomUUID(),type:'resume',mime:'application/pdf',size:1,scope:{orgId:'org-a',personId:other},acl:'private',data:'r2:x'});}),{message:'unavailable'});
 assert.deepEqual(await row('person',alice),before,'the owner row is unchanged');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM candidate_document_slots WHERE person_id=$1',[alice])).rows[0].n,0);
 // The pending upload still finalizes afterwards.
 assert.equal((await f.service.finalize(f.credentials[alice],createIdempotencyKey(),{uploadId:t.uploadId})).status,200);
});

test('PART-04 slot history survives removal, and the store keeps one authoritative writer',unavailable,async()=>{
 const alice=person(),f=candidates([alice]),t=await upload(f,alice);
 const done=await f.service.finalize(f.credentials[alice],createIdempotencyKey(),{uploadId:t.uploadId});
 await f.service.remove(f.credentials[alice],createIdempotencyKey(),{type:'personal-photo',expectedVersion:done.body.metadata.version});
 assert.deepEqual((await pool.query('SELECT org_id, type, state FROM candidate_document_slots WHERE person_id=$1',[alice])).rows,[{org_id:'org-a',type:'personal-photo',state:'cleared'}]);
 await assert.rejects(pool.query('DELETE FROM candidate_document_slots WHERE person_id=$1',[alice]));
 await assert.rejects(pool.query('DELETE FROM candidate_document_ids WHERE owner_id=$1',[alice]));
 assert.deepEqual((await pool.query("SELECT owner_kind, owner_id FROM candidate_document_ids WHERE document_id=$1",[done.body.metadata.id])).rows,[{owner_kind:'person',owner_id:alice}]);
 // The old table is fenced from older builds (gone under its name) and its frozen copy refuses writes.
 await assert.rejects(pool.query('SELECT snapshot FROM candidate_document_snapshot WHERE singleton = true'),/does not exist/);
 await assert.rejects(pool.query('UPDATE candidate_document_snapshot_0661_rollback SET snapshot = snapshot'),/frozen/);
 await assert.rejects(pool.query('DELETE FROM candidate_document_snapshot_0661_rollback'),/frozen/);
 // A write has been accepted, so rollback to the old table is no longer allowed.
 assert.equal((await pool.query('SELECT candidate_document_store_rollback_allowed() AS ok')).rows[0].ok,false);
 // A whole-store write is refused; only a person's or organization's own store writes.
 await assert.rejects(f.store.transaction(async()=>{}),{message:'unavailable'});
 assert.deepEqual(await f.store.locate(done.body.metadata.id),{kind:'person',id:alice});
 assert.equal(await f.store.locate(randomUUID()),null);
});

test('PART-05 volume: a cross-person listing reads bounded metadata, never unrelated history, journals or bodies',unavailable,async()=>{
 const org=`org-vol-${randomBytes(4).toString('hex')}`,people=Array.from({length:120},()=>person()),civil=new Set(people.slice(0,3));
 const doc=(p,type)=>({id:randomUUID(),version:randomUUID(),type,mime:'image/png',size:1000,scope:{orgId:org,personId:p},acl:'private',data:`r2:immutable/${randomUUID()}/${'a'.repeat(64)}`});
 let stored=0;
 for(const p of people){
  const documents=[doc(p,'personal-photo'),...(civil.has(p)?[doc(p,'civil-id-front')]:[])];
  const retired=Array.from({length:30},()=>doc(p,'personal-photo'));
  const journal=Array.from({length:60},()=>({id:randomUUID(),operation:'finalize',principalRef:digest(p),at:1800000000000}));
  const packed={state:{format:1,documents,retired,lifecycle:{format:1,uploads:[],receipts:[],cleanup:retired.map(d=>({id:`${d.id}:${d.version}`,documentId:d.id,version:d.version,retiredAt:1,status:'held'})),audit:journal}},
   blobs:Object.fromEntries([...documents,...retired].map(d=>[d.data.slice(3),{key:d.data.slice(3),digest:'a'.repeat(64),size:1000}]))};
  const text=JSON.stringify(packed);stored+=text.length;
  await pool.query("INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ('person',$1,$2::jsonb)",[p,text]);
  await pool.query("INSERT INTO candidate_document_slots (person_id, org_id, type, state) SELECT $1, $2, t, 'active' FROM unnest($3::text[]) t",[p,org,documents.map(d=>d.type)]);
 }
 let returned=0,objectReads=0;
 const reader=snapshots.reader,query=reader.query.bind(reader);
 reader.query=async(...args)=>{const r=await query(...args);returned+=JSON.stringify(r.rows).length;for(const row of r.rows)assert.ok(!/retired|receipts|audit|cleanup|uploads|"data"|blobs/.test(JSON.stringify(row)),'no history, journal or body reference leaves the database');return r;};
 try{
  const store=new PartitionedR2DocumentStore(snapshots,{read:async()=>{objectReads++;throw new Error('no body is read');},writeImmutable:async()=>{throw new Error('no write');}});
  const listed=await listCivilIdPhotos(store,org);
  assert.deepEqual(listed.map(x=>x.principalId).sort(),[...civil].sort());
  assert.ok(listed.every(x=>x.side==='front'&&x.size===1000));
  assert.ok(stored>2_000_000,`fixture is large (${stored} bytes stored)`);
  assert.ok(returned<2_000,`listing returned ${returned} bytes for 3 documents`);
  returned=0;
  assert.ok(Number.isSafeInteger(await store.heldCount()));
  assert.ok(returned<200,'the held count returns one number');
  assert.equal(objectReads,0);
  await assert.rejects(store.transaction(async()=>{}),{message:'unavailable'});
  assert.equal(store.readPath,undefined,'no whole-store read exists');
 }finally{reader.query=query;}
});

test('PART-06 the civil ID listing walks bounded keyset pages: every match exactly once, none dropped at a page edge',unavailable,async()=>{
 const org=`org-page-${randomBytes(4).toString('hex')}`,expected=new Set();
 const people=Array.from({length:70},()=>person());
 for(const [i,p] of people.entries()){
  const types=i<60?['civil-id-front','civil-id-back']:['civil-id-front'];
  const documents=types.map(type=>({id:randomUUID(),version:randomUUID(),type,mime:'image/png',size:10,scope:{orgId:org,personId:p},acl:'private',data:`r2:immutable/${randomUUID()}/${'b'.repeat(64)}`}));
  for(const d of documents)expected.add(d.id);
  await pool.query("INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ('person',$1,$2::jsonb)",[p,JSON.stringify({state:{format:1,documents,retired:[]},blobs:Object.fromEntries(documents.map(d=>[d.data.slice(3),{key:d.data.slice(3),digest:'b'.repeat(64),size:10}]))})]);
  await pool.query("INSERT INTO candidate_document_slots (person_id, org_id, type, state) SELECT $1, $2, t, 'active' FROM unnest($3::text[]) t",[p,org,types]);
 }
 assert.equal(expected.size,130);
 const pages=[];const reader=snapshots.reader,query=reader.query.bind(reader);
 reader.query=async(...args)=>{const r=await query(...args);pages.push(r.rows.length);return r;};
 try{
  const store=new PartitionedR2DocumentStore(snapshots,{read:async()=>{throw new Error('no body is read');},writeImmutable:async()=>{throw new Error('no write');}});
  const listed=await listCivilIdPhotos(store,org,{pageSize:50});
  const ids=listed.map(x=>x.documentId);
  assert.equal(ids.length,130,'no match dropped');
  assert.equal(new Set(ids).size,130,'no match repeated');
  assert.deepEqual(new Set(ids),expected);
  assert.deepEqual(pages,[51,51,30],'three bounded queries of at most one page plus one look-ahead row');
  // A full last page ends cleanly with no empty extra page and nothing missing.
  pages.length=0;
  assert.equal((await listCivilIdPhotos(store,org,{pageSize:65})).length,130);
  assert.deepEqual(pages,[66,65]);
  await assert.rejects(store.listCurrent(org,['civil-id-front'],{limit:1001}),{message:'unavailable'});
 }finally{reader.query=query;}
});
