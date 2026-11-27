// Checks GPT asked for before migration 0661 or any promotion runs (#393, 7226316933):
// a production-size bounded civil ID consumer with a throughput figure, and a quiesced handover.
// Synthetic people and documents only. The database tests skip without DATABASE_URL.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '@studenthub/db';
import {PostgresCivilIdOcrStore} from '../../../dist/packages/db/src/postgres-civil-id-ocr-store.js';
import {precheck,postcheck,parsePrecheck,target,HandoverError} from '../../../dist/packages/private-documents/src/store-handover.js';
import {handoverMain} from '../../../dist/packages/private-documents/src/store-handover-cli.js';
import {runCivilIdOcr,InMemoryCivilIdOcrStore,FakeCivilIdOcrReader,CivilIdVault} from '../../../dist/packages/profile/src/index.js';
import {emptyPackedSnapshot} from '../../../dist/packages/private-documents/src/r2-storage.js';
const url=process.env.DATABASE_URL;
const unavailable={skip:!url?'requires configured scratch PostgreSQL':false};
const migration=name=>readFileSync(new URL(`../../db/migrations/${name}`,import.meta.url),'utf8');
// Production size: every legacy candidate with both civil ID photos. SWEEP_PEOPLE raises it for a manual run.
const PEOPLE=Number(process.env.SWEEP_PEOPLE??50000);
let pool;
before(async()=>{if(url){pool=new pg.Pool({connectionString:url});await runMigrations(pool);}});
after(async()=>{await pool?.end();});

/** A pool whose clients count every row the database sends back to this process. */
function countingPool(inner){
 const seen={rows:0,queries:0};
 return {seen,pool:{connect:async()=>{const c=await inner.connect();return new Proxy(c,{get(t,k){if(k==='query')return async(...a)=>{const r=await t.query(...a);seen.queries++;seen.rows+=r.rows?.length??0;return r;};const v=t[k];return typeof v==='function'?v.bind(t):v;}});},
  query:async(...a)=>{const r=await inner.query(...a);seen.queries++;seen.rows+=r.rows?.length??0;return r;},end:async()=>{}}};
}

test('SWEEP-01 production size: the OCR sweep reads every current civil ID photo in the database, in one snapshot, and no photo row reaches the process',unavailable,async()=>{
 const run=randomBytes(4).toString('hex'),org=`org-sweep-${run}`,prefix=`sw${run}-`;
 // Seed PEOPLE people, each with a front and back photo, an active slot for each, in one statement per table.
 const t0=Date.now();
 await pool.query(`INSERT INTO principals (id) SELECT $1||i FROM generate_series(1,$2::int) i`,[prefix,PEOPLE]);
 await pool.query(`INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot)
  SELECT 'person', $1||i, jsonb_build_object('state', jsonb_build_object('format',1,'retired','[]'::jsonb,'documents', jsonb_build_array(
    jsonb_build_object('id',gen_random_uuid(),'version',gen_random_uuid(),'type','civil-id-front','mime','image/png','size',100,'scope',jsonb_build_object('orgId',$3::text,'personId',$1||i),'acl','private','data','r2:x'),
    jsonb_build_object('id',gen_random_uuid(),'version',gen_random_uuid(),'type','civil-id-back','mime','image/png','size',100,'scope',jsonb_build_object('orgId',$3::text,'personId',$1||i),'acl','private','data','r2:x'))),'blobs','{}'::jsonb)
  FROM generate_series(1,$2::int) i`,[prefix,PEOPLE,org]);
 await pool.query(`INSERT INTO candidate_document_slots (person_id, org_id, type, state) SELECT $1||i, $3, t, 'active' FROM generate_series(1,$2::int) i, unnest(ARRAY['civil-id-front','civil-id-back']) t`,[prefix,PEOPLE,org]);
 const seeded=Date.now()-t0;
 const counted=countingPool(pool),store=new PostgresCivilIdOcrStore({pool:counted.pool,orgId:org});
 const at=new Date('2026-12-01T00:00:00Z');
 let t=Date.now();const baseline=await store.beginStoreSweep(at.toISOString());const baselineMs=Date.now()-t;
 assert.deepEqual(baseline,{baseline:true,queued:0});
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM civil_id_ocr_jobs WHERE org_id=$1 AND status='noted'",[org])).rows[0].n,2*PEOPLE,'every photo is noted exactly once');
 // Change some people while nothing is sweeping: 10 replace their front photo, 5 remove their back photo.
 await pool.query(`UPDATE candidate_document_partitions SET snapshot = jsonb_set(snapshot,'{state,documents,0,version}',to_jsonb(gen_random_uuid()::text)) WHERE owner_kind='person' AND owner_id = ANY($1)`,[Array.from({length:10},(_,i)=>`${prefix}${i+1}`)]);
 const removed=Array.from({length:5},(_,i)=>`${prefix}${i+101}`);
 await pool.query(`UPDATE candidate_document_partitions SET snapshot = jsonb_set(snapshot,'{state,documents}',(snapshot->'state'->'documents') - 1) WHERE owner_kind='person' AND owner_id = ANY($1)`,[removed]);
 await pool.query(`UPDATE candidate_document_slots SET state='cleared' WHERE person_id = ANY($1) AND type='civil-id-back'`,[removed]);
 t=Date.now();const sweep=await store.beginStoreSweep(new Date(at.getTime()+300_000).toISOString());const sweepMs=Date.now()-t;
 assert.deepEqual(sweep,{baseline:false,queued:10},'only the replaced photos are queued');
 const superseded=(await pool.query('SELECT count(*)::int AS n FROM civil_id_ocr_jobs WHERE org_id=$1 AND superseded_at IS NOT NULL',[org])).rows[0].n;
 assert.equal(superseded,15,'the 10 replaced and the 5 removed photos are superseded');
 // Bounded consumer: the rows this process received are a handful, whatever PEOPLE is.
 assert.ok(counted.seen.rows<=10,`rows sent to the process: ${counted.seen.rows}`);
 const rate=Math.round(2*PEOPLE/(sweepMs/1000));
 console.log(`SWEEP-01 people=${PEOPLE} photos=${2*PEOPLE} seedMs=${seeded} baselineMs=${baselineMs} sweepMs=${sweepMs} photosPerSecond=${rate} rowsToProcess=${counted.seen.rows} queries=${counted.seen.queries}`);
 // Throughput floor: a full sweep at production size well inside the five-minute sweep interval.
 assert.ok(sweepMs<120_000&&baselineMs<120_000,`sweep took ${sweepMs} ms, baseline ${baselineMs} ms`);
});

test('SWEEP-02 the sweep sees one snapshot: a photo replaced while it runs is either wholly in this sweep or the next, never half',unavailable,async()=>{
 const run=randomBytes(4).toString('hex'),org=`org-snap-${run}`,person=`sn${run}`;
 await pool.query('INSERT INTO principals (id) VALUES ($1)',[person]);
 const doc=v=>({id:randomUUID(),version:v,type:'civil-id-front',mime:'image/png',size:100,scope:{orgId:org,personId:person},acl:'private',data:'r2:x'});
 const first=doc(randomUUID());
 await pool.query("INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ('person',$1,$2::jsonb)",[person,JSON.stringify({state:{format:1,documents:[first],retired:[]},blobs:{}})]);
 await pool.query("INSERT INTO candidate_document_slots (person_id, org_id, type, state) VALUES ($1,$2,'civil-id-front','active')",[person,org]);
 const store=new PostgresCivilIdOcrStore({pool,orgId:org});
 await store.beginStoreSweep('2026-12-01T00:00:00Z');
 // A writer holds the person's row with a replacement while the sweep runs: the sweep reads the committed state only.
 const writer=await pool.connect();
 try{
  await writer.query('BEGIN');
  const second={...first,version:randomUUID()};
  await writer.query("UPDATE candidate_document_partitions SET snapshot=$2::jsonb WHERE owner_kind='person' AND owner_id=$1",[person,JSON.stringify({state:{format:1,documents:[second],retired:[first]},blobs:{}})]);
  const during=await store.beginStoreSweep('2026-12-01T00:05:00Z');
  assert.deepEqual(during,{baseline:false,queued:0},'the uncommitted replacement is not seen, and the current photo is not superseded');
  await writer.query('COMMIT');
  const next=await store.beginStoreSweep('2026-12-01T00:10:00Z');
  assert.deepEqual(next,{baseline:false,queued:1},'the next sweep takes the replacement');
  const jobs=(await pool.query('SELECT document_version::text AS v, superseded_at IS NOT NULL AS gone FROM civil_id_ocr_jobs WHERE org_id=$1 ORDER BY created_at',[org])).rows;
  assert.deepEqual(jobs,[{v:first.version,gone:true},{v:second.version,gone:false}]);
 }finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();}
});

/** Resolves once a backend running a statement that mentions `needle` is waiting on a lock. */
async function waitsOnLock(needle){
 for(let i=0;i<200;i++){const {rowCount}=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",[`%${needle}%`]);if(rowCount)return;await new Promise(r=>setTimeout(r,25));}
 throw new Error(`no backend waited on ${needle}`);
}

test('SWEEP-04 an overlapping sweep or a worker writing a job makes the sweep wait, never fail it with a serialization error',unavailable,async()=>{
 const run=randomBytes(4).toString('hex'),org=`org-race-${run}`,person=`rc${run}`;
 await pool.query('INSERT INTO principals (id) VALUES ($1)',[person]);
 const first={id:randomUUID(),version:randomUUID(),type:'civil-id-front',mime:'image/png',size:100,scope:{orgId:org,personId:person},acl:'private',data:'r2:x'};
 await pool.query("INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ('person',$1,$2::jsonb)",[person,JSON.stringify({state:{format:1,documents:[first],retired:[]},blobs:{}})]);
 await pool.query("INSERT INTO candidate_document_slots (person_id, org_id, type, state) VALUES ($1,$2,'civil-id-front','active')",[person,org]);
 const store=new PostgresCivilIdOcrStore({pool,orgId:org});
 await store.beginStoreSweep('2026-12-01T00:00:00Z');
 const other=await pool.connect();
 try{
  // 1. Another sweep holds the throttle row and commits while this one waits: this one skips, as the throttle intends.
  await other.query('BEGIN');
  await other.query("UPDATE civil_id_ocr_baseline SET last_sweep_at='2026-12-01T00:05:00Z' WHERE org_id=$1",[org]);
  const skipped=store.beginStoreSweep('2026-12-01T00:05:00Z');
  await waitsOnLock('civil_id_ocr_baseline');
  await other.query('COMMIT');
  assert.deepEqual(await skipped,{baseline:false,queued:0},'the overlapping sweep is skipped, not failed');
  // 2. The person replaces the photo, and a worker holds the old photo's job while the sweep supersedes it.
  const second={...first,version:randomUUID()};
  await pool.query("UPDATE candidate_document_partitions SET snapshot=$2::jsonb WHERE owner_kind='person' AND owner_id=$1",[person,JSON.stringify({state:{format:1,documents:[second],retired:[first]},blobs:{}})]);
  await other.query('BEGIN');
  await other.query("UPDATE civil_id_ocr_jobs SET updated_at=updated_at WHERE org_id=$1 AND document_version=$2::uuid",[org,first.version]);
  const swept=store.beginStoreSweep('2026-12-01T00:10:00Z');
  await waitsOnLock('UPDATE civil_id_ocr_jobs j SET superseded_at');
  await other.query('COMMIT');
  assert.deepEqual(await swept,{baseline:false,queued:1},'the sweep waits for the worker, then queues the new photo');
  const jobs=(await pool.query('SELECT document_version::text AS v, superseded_at IS NOT NULL AS gone FROM civil_id_ocr_jobs WHERE org_id=$1 ORDER BY created_at',[org])).rows;
  assert.deepEqual(jobs,[{v:first.version,gone:true},{v:second.version,gone:false}]);
 }finally{await other.query('ROLLBACK').catch(()=>{});other.release();}
});

test('SWEEP-03 the OCR run uses the in-store sweep and a per-person back lookup, never the whole list',async()=>{
 const store=new InMemoryCivilIdOcrStore();let sweeps=0,backs=0;
 store.beginStoreSweep=async at=>{sweeps++;return store.beginSweep([front,back],at);};
 const front={principalId:'person',side:'front',documentId:randomUUID(),version:randomUUID(),size:3},back={principalId:'person',side:'back',documentId:randomUUID(),version:randomUUID(),size:3};
 await store.beginSweep([],'2026-01-01T00:00:00Z');
 let reads=0;
 const source={inStore:true,list:async()=>{throw new Error('the whole list is never read');},back:async p=>{backs++;return p==='person'?back:null;},
  read:async()=>{reads++;return {bytes:Buffer.from('img'),mime:'image/jpeg'};}};
 const reader={read:async()=>reads===1?['290010100000']:['02/03/2029']};
 await runCivilIdOcr({store,photos:source,reader,vault:new CivilIdVault(Buffer.alloc(32,4)),clock:{now:()=>new Date('2026-01-01T00:05:00Z')},workerId:randomUUID(),leaseMs:1000,batchSize:1});
 assert.deepEqual([sweeps,backs],[1,1]);
 assert.equal(store.jobs.find(j=>j.side==='front')?.expiry,'2029-03-02','the expiry fallback read the back photo found per person');
});

/** The pre-0661 tables in a scratch schema, with one old row holding every kind of element. */
async function oldStore(schema){
 const scoped=`${url}${url.includes('?')?'&':'?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
 const session=async()=>{const x=new pg.Client({connectionString:scoped});await x.connect();return x;};
 const c=await session();
 await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path = ${schema}`);
 await c.query(migration('0145_candidate_private_documents.sql'));await c.query(migration('0220_candidate_document_read_audit.sql'));
 await c.query('CREATE TABLE principals (id text PRIMARY KEY, display_name text, email text)');
 await c.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
 const packed=emptyPackedSnapshot(),sha=v=>createHash('sha256').update(v).digest('hex');
 const doc=(person,type='personal-photo')=>({id:randomUUID(),version:randomUUID(),type,mime:'image/png',size:10,scope:{orgId:'org-a',personId:person},acl:'private',data:`r2:immutable/${randomUUID()}/${'a'.repeat(64)}`});
 const active=doc('alice'),retired=doc('alice');
 packed.state.documents.push(active);packed.state.retired.push(retired);
 packed.state.lifecycle={format:1,uploads:[],receipts:[],audit:[{id:randomUUID(),operation:'list',principalRef:sha('alice'),at:1}],cleanup:[{id:`${retired.id}:${retired.version}`,documentId:retired.id,version:retired.version,retiredAt:1,status:'held'}]};
 for(const d of [active,retired]){const key=d.data.slice(3);packed.blobs[key]={key,digest:'a'.repeat(64),size:10};}
 await c.query('UPDATE candidate_document_snapshot SET snapshot = $1::jsonb',[JSON.stringify(packed)]);
 return {c,session};
}

test('HANDOVER-01 the 0661 switch is checked quiet before and unchanged after: a held lock or an open transaction refuses, a late write is caught',unavailable,async()=>{
 const schema=`h0661_${randomBytes(6).toString('hex')}`;
 const {c,session}=await oldStore(schema);
 const other=await session();
 try{
  const pre=await precheck(c);
  assert.deepEqual(pre.counts,{documents:1,retired:1,uploads:0,receipts:0,cleanup:1,audit:1});
  assert.match(pre.digest,/^[0-9a-f]{32}$/);
  assert.match(pre.target,/^[0-9a-f]{32}$/);
  assert.equal(await target(c),pre.target,'the approval fingerprint is the one the precheck carries');
  assert.deepEqual(Object.keys(pre).sort(),['counts','digest','target']);
  // A writer in flight on the old row, or any open transaction that touched the store's schema, refuses.
  await other.query('BEGIN');await other.query('SELECT 1 FROM candidate_document_snapshot WHERE singleton FOR UPDATE');
  await assert.rejects(precheck(c),e=>e instanceof HandoverError&&e.code==='locked');
  await other.query('ROLLBACK');
  await other.query('BEGIN');await other.query('SELECT count(*) FROM principals');
  await assert.rejects(precheck(c),e=>e instanceof HandoverError&&e.code==='locked');
  await other.query('ROLLBACK');
  assert.deepEqual(await precheck(c),pre,'quiet again: same digest and counts');
  await assert.rejects(postcheck(c,pre),e=>e.code==='notMigrated');
  // The migration, as the runner applies it.
  await c.query('BEGIN');await c.query(migration('0661_candidate_document_partitions.sql'));
  await c.query("INSERT INTO schema_migrations (version) VALUES ('0661_candidate_document_partitions')");await c.query('COMMIT');
  await assert.rejects(precheck(c),e=>e.code==='notBefore0661');
  const post=await postcheck(c,pre);
  assert.deepEqual(post,{target:pre.target,counts:pre.counts,owners:1,rollbackAllowed:true});
  assert.equal(await target(c),pre.target,'the rename keeps the table, so the fingerprint holds after 0661');
  // An identical store elsewhere (same row, same digest and counts) is not this one.
  const twin=`h0661_${randomBytes(6).toString('hex')}`,copy=await oldStore(twin);
  try{
   await copy.c.query('UPDATE candidate_document_snapshot SET snapshot = $1::jsonb',[(await c.query('SELECT snapshot::text AS s FROM candidate_document_snapshot_0661_rollback')).rows[0].s]);
   const elsewhere=await precheck(copy.c);
   assert.equal(elsewhere.digest,pre.digest);assert.deepEqual(elsewhere.counts,pre.counts);assert.notEqual(elsewhere.target,pre.target);
   await assert.rejects(postcheck(c,elsewhere),e=>e.code==='otherTarget');
  }finally{await copy.c.query(`DROP SCHEMA ${twin} CASCADE`).catch(()=>{});await copy.c.end();}
  // A precheck record that is not exactly what precheck prints never reaches a comparison.
  for(const bad of [undefined,{},{...pre,counts:{}},{target:pre.target,digest:pre.digest}])await assert.rejects(postcheck(c,bad),e=>e.code==='precheckInvalid');
  // A write that slipped in between the check and the migration shows as another digest.
  await assert.rejects(postcheck(c,{...pre,digest:'0'.repeat(32)}),e=>e.code==='changedSinceCheck');
  await assert.rejects(postcheck(c,{...pre,counts:{...pre.counts,audit:2}}),e=>e.code==='countMismatch');
  // Once the new store accepted a write, the old row is no longer the measure.
  await c.query('UPDATE candidate_document_store_authority SET first_write_at = now()');
  await assert.rejects(postcheck(c,pre),e=>e.code==='alreadyWritten');
 }finally{await other.end().catch(()=>{});await c.query(`DROP SCHEMA ${schema} CASCADE`).catch(()=>{});await c.end();}
});

test('HANDOVER-03 a precheck record needs exactly its three fields and all six counts as nonnegative integers',()=>{
 const good={target:'a'.repeat(32),digest:'b'.repeat(32),counts:{documents:1,retired:0,uploads:0,receipts:0,cleanup:0,audit:2}};
 assert.deepEqual(parsePrecheck(JSON.parse(JSON.stringify(good))),good);
 const {audit,...partial}=good.counts;
 const bad={
  missing:undefined,notObject:'x',array:[],empty:{},noCounts:{target:good.target,digest:good.digest},noTarget:{digest:good.digest,counts:good.counts},
  extraField:{...good,note:'x'},emptyCounts:{...good,counts:{}},partialCounts:{...good,counts:partial},extraCount:{...good,counts:{...good.counts,other:0}},
  fractional:{...good,counts:{...good.counts,audit:1.5}},negative:{...good,counts:{...good.counts,audit:-1}},text:{...good,counts:{...good.counts,audit:'2'}},
  infinite:{...good,counts:{...good.counts,audit:Infinity}},nan:{...good,counts:{...good.counts,audit:NaN}},huge:{...good,counts:{...good.counts,audit:2**53}},
  nullCount:{...good,counts:{...good.counts,audit:null}},badDigest:{...good,digest:'B'.repeat(32)},badTarget:{...good,target:'short'},
 };
 for(const [name,v] of Object.entries(bad))assert.throws(()=>parsePrecheck(v),e=>e instanceof HandoverError&&e.code==='precheckInvalid',name);
});

test('HANDOVER-02 the operator entry prints counts and a digest only, and refuses with a fixed code',async()=>{
 const out=[],err=[];
 const approved='c'.repeat(32),db='postgres://unused/x';
 assert.equal(await handoverMain(['precheck'],{},s=>out.push(s),s=>err.push(s)),2);
 assert.equal(await handoverMain(['postcheck'],{DATABASE_URL:db},s=>out.push(s),s=>err.push(s)),2);
 assert.equal(await handoverMain(['precheck','extra'],{DATABASE_URL:db},s=>out.push(s),s=>err.push(s)),2);
 assert.equal(await handoverMain(['precheck'],{DATABASE_URL:db},s=>out.push(s),s=>err.push(s)),2);
 assert.equal(await handoverMain(['precheck'],{DATABASE_URL:db,HANDOVER_APPROVED_TARGET:'nope'},s=>out.push(s),s=>err.push(s)),2);
 const dir=mkdtempSync(path.join(tmpdir(),'handover-'));
 try{
  const file=path.join(dir,'pre.json'),counts={documents:1,retired:1,uploads:0,receipts:0,cleanup:1,audit:1};
  writeFileSync(file,'not json');
  assert.equal(await handoverMain(['postcheck',file],{DATABASE_URL:db,HANDOVER_APPROVED_TARGET:approved},s=>out.push(s),s=>err.push(s)),2);
  writeFileSync(file,JSON.stringify({target:approved,digest:'d'.repeat(32),counts:{documents:1}}));
  assert.equal(await handoverMain(['postcheck',file],{DATABASE_URL:db,HANDOVER_APPROVED_TARGET:approved},s=>out.push(s),s=>err.push(s)),2);
  writeFileSync(file,JSON.stringify({target:'e'.repeat(32),digest:'d'.repeat(32),counts}));
  assert.equal(await handoverMain(['postcheck',file],{DATABASE_URL:db,HANDOVER_APPROVED_TARGET:approved},s=>out.push(s),s=>err.push(s)),2);
  assert.deepEqual(err,['handover: usage','handover: usage','handover: usage','handover: refused.approvedTarget','handover: refused.approvedTarget',
   'handover: refused.precheckFile','handover: refused.precheckFile','handover: refused.otherTarget']);
  assert.deepEqual(out,[],'a refusal prints nothing on standard output');
 }finally{rmSync(dir,{recursive:true,force:true});}
 if(!url)return;
 const schema=`h0661_${randomBytes(6).toString('hex')}`;
 const {c}=await oldStore(schema);
 try{
  const scoped=`${url}${url.includes('?')?'&':'?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const lines=[],errs=[];
  assert.equal(await handoverMain(['target'],{DATABASE_URL:scoped},s=>lines.push(s),()=>{}),0);
  const fingerprint=JSON.parse(lines[0]).target;
  assert.deepEqual(Object.keys(JSON.parse(lines[0])),['target']);
  // A precheck against a database other than the approved one refuses and prints nothing.
  assert.equal(await handoverMain(['precheck'],{DATABASE_URL:scoped,HANDOVER_APPROVED_TARGET:'f'.repeat(32)},s=>lines.push(s),s=>errs.push(s)),2);
  assert.deepEqual(errs,['handover: refused.otherTarget']);assert.equal(lines.length,1);
  assert.equal(await handoverMain(['precheck'],{DATABASE_URL:scoped,HANDOVER_APPROVED_TARGET:fingerprint},s=>lines.push(s),()=>{}),0);
  const printed=JSON.parse(lines[1]);
  assert.deepEqual(Object.keys(printed).sort(),['counts','digest','target']);
  assert.equal(printed.target,fingerprint);
  assert.ok(!lines.join('').includes('alice')&&!lines.join('').includes('org-a'),'no id leaves the check');
 }finally{await c.query(`DROP SCHEMA ${schema} CASCADE`).catch(()=>{});await c.end();}
});
