import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '@studenthub/db';
import {PostgresDocumentSnapshot,R2DocumentStore,emptyPackedSnapshot} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {createIdempotencyKey} from '../../../dist/packages/idempotency-contract/src/index.js';
import {png} from './candidate-fixtures.mjs';
const url=process.env.DATABASE_URL;
const unavailable={skip:!url?'requires configured scratch PostgreSQL':false};
let pool,snapshots;
before(async()=>{if(url){pool=new pg.Pool({connectionString:url});await runMigrations(pool);snapshots=new PostgresDocumentSnapshot(url);}});
beforeEach(async()=>{if(pool){await pool.query('UPDATE candidate_document_snapshot SET snapshot=$1::jsonb',[JSON.stringify(emptyPackedSnapshot())]);await pool.query('TRUNCATE candidate_document_object_reservations');}});
after(async()=>{await snapshots?.close();await pool?.end();});

test('SHU-145/PG-01 metadata callback rollback preserves state and durable quarantine reservations',unavailable,async()=>{
 const key=`uploads/${randomUUID()}`;
 await assert.rejects(snapshots.transaction(async s=>{await snapshots.reserve(key);s.state.lifecycle={format:1,uploads:[],receipts:[],cleanup:[],audit:[]};throw new Error('synthetic failure');}),{message:'unavailable'});
 assert.deepEqual((await pool.query('SELECT snapshot FROM candidate_document_snapshot')).rows[0].snapshot,emptyPackedSnapshot());
 assert.equal((await pool.query('SELECT retention_status FROM candidate_document_object_reservations')).rows[0].retention_status,'held');
});

test('SHU-145/PG-02 concurrent adapter instances serialize metadata updates',unavailable,async()=>{
 const second=new PostgresDocumentSnapshot(url);
 try {
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?snapshots:second).transaction(async s=>{
   s.state.lifecycle??={format:1,uploads:[],receipts:[],cleanup:[],audit:[]};
   await new Promise(r=>setImmediate(r));
   s.state.lifecycle.audit.push({id:randomUUID(),operation:'finalize',principalRef:'a'.repeat(64),at:Date.now()});
  })));
  assert.equal((await pool.query('SELECT snapshot FROM candidate_document_snapshot')).rows[0].snapshot.state.lifecycle.audit.length,12);
 }finally{await second.close();}
});

test('SHU-145/PG-03 real SQL and synthetic private objects recover an uncertain metadata commit',unavailable,async()=>{
 const bytes=new Map();let uncertain=false;
 const backing={reserve:k=>snapshots.reserve(k),transaction:async fn=>{const r=await snapshots.transaction(fn);if(uncertain){uncertain=false;throw new Error('synthetic uncertain commit');}return r;}};
 const store=new R2DocumentStore(backing,{read:async k=>Buffer.from(bytes.get(k)),writeImmutable:async(k,b)=>{
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM candidate_document_object_reservations WHERE object_key=$1',[k])).rows[0].n,1);
  bytes.set(k,Buffer.from(b));
 }});
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic'}],principals:[{id:'alice',pbuuids:[]}]});
 await authz.grantMany('alice',[{orgId:'org-a',role:'candidate',scope:'self'}]);
 const credential=randomBytes(32).toString('base64url'),service=new CandidateDocuments({store,authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),authenticate:async c=>c===credential?{kind:'principal',principalId:'alice'}:null});
 const a=(await service.authorizeUpload(credential,createIdempotencyKey(),{type:'personal-photo',mime:'image/png',size:png().length,expectedVersion:null})).body;
 await service.put(credential,createIdempotencyKey(),a.uploadId,a.objectKey,a.credential,png());
 const key=createIdempotencyKey();uncertain=true;
 await assert.rejects(service.finalize(credential,key,{uploadId:a.uploadId}),e=>e.code==='unavailable');
 const result=await service.finalize(credential,key,{uploadId:a.uploadId});assert.equal(result.status,200);
 const packed=(await pool.query('SELECT snapshot FROM candidate_document_snapshot')).rows[0].snapshot;
 assert.equal(packed.state.lifecycle.audit.length,1);assert.equal(packed.state.documents.length,1);
 assert.ok(packed.state.documents[0].data.startsWith('r2:'));
 assert.deepEqual((await service.deliver(credential,(await service.issueDelivery(credential,result.body.metadata.id)).url)).bytes,png());
});

test('RA_NO_LOCK reader and audit pool bypass a locked or exhausted writer pool',unavailable,async()=>{
 const locker=await pool.connect();
 try{
  await locker.query('BEGIN');await locker.query('SELECT snapshot FROM candidate_document_snapshot WHERE singleton=true FOR UPDATE');
  for(let i=0;i<3;i++)await assert.doesNotReject(Promise.race([snapshots.read(),new Promise((_,reject)=>setTimeout(()=>reject(new assert.AssertionError({message:'read queued behind row lock'})),500))]));
  await assert.doesNotReject(Promise.race([snapshots.auditRead({operation:'list',principalRef:'1'.repeat(64),at:Date.now()}),new Promise((_,reject)=>setTimeout(()=>reject(new assert.AssertionError({message:'audit queued behind row lock'})),500))]));
 }finally{await locker.query('ROLLBACK');locker.release();}
 let release;const parked=new Promise(r=>release=r);
 const first=snapshots.transaction(async()=>parked),second=snapshots.transaction(async()=>{});
 await new Promise(r=>setTimeout(r,100));
 try{
  for(let i=0;i<3;i++)await assert.doesNotReject(Promise.race([snapshots.read(),new Promise((_,reject)=>setTimeout(()=>reject(new assert.AssertionError({message:'read used writer pool'})),500))]));
  await assert.doesNotReject(Promise.race([snapshots.auditRead({operation:'deliver',principalRef:'2'.repeat(64),at:Date.now()}),new Promise((_,reject)=>setTimeout(()=>reject(new assert.AssertionError({message:'audit used writer pool'})),500))]));
 }finally{release();await Promise.all([first,second]);}
});

test('RA_NO_WRITE plain reads do not rewrite the shared snapshot',unavailable,async()=>{
 const before=await pool.query('SELECT xmin::text,snapshot FROM candidate_document_snapshot WHERE singleton=true');
 await assert.doesNotReject(()=>snapshots.read());await assert.doesNotReject(()=>snapshots.read());await assert.doesNotReject(()=>snapshots.read());
 const afterRead=await pool.query('SELECT xmin::text,snapshot FROM candidate_document_snapshot WHERE singleton=true');
 assert.deepEqual(afterRead.rows,before.rows,'read path must not update snapshot');
});

test('RA_AUDIT_ROW audit rows are minimal, constrained and append-only',unavailable,async()=>{
 const ref=randomBytes(32).toString('hex'),at=Date.now();
 await assert.doesNotReject(()=>snapshots.auditRead({operation:'issueDelivery',principalRef:ref,at}));
 const row=(await pool.query('SELECT * FROM candidate_document_read_audit WHERE principal_ref=$1',[ref])).rows[0];
 assert.deepEqual(Object.keys(row).sort(),['id','occurred_at','operation','principal_ref']);assert.equal(row.operation,'issueDelivery');assert.equal(row.principal_ref,ref);assert.ok(Math.abs(row.occurred_at.getTime()-at)<2);
 await assert.rejects(pool.query('UPDATE candidate_document_read_audit SET operation=$1 WHERE id=$2',['list',row.id]));
 await assert.rejects(pool.query('DELETE FROM candidate_document_read_audit WHERE id=$1',[row.id]));
 await assert.rejects(pool.query('TRUNCATE candidate_document_read_audit'));
 await assert.rejects(pool.query('INSERT INTO candidate_document_read_audit(id,operation,principal_ref,occurred_at) VALUES($1,$2,$3,now())',[randomUUID(),'bad',ref]));
});
