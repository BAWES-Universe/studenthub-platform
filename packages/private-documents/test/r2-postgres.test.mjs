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
