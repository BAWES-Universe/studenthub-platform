// M-2 promotion step against real PostgreSQL (migrations 0661 and 0662) and in-memory objects.
// Synthetic people and documents only. Skips without DATABASE_URL.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '@studenthub/db';
import {PostgresDocumentPartitions,PartitionedR2DocumentStore} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
// PROMO_MODULE lets the mutation script run this suite against a mutant build.
const {LegacyDocumentPromotion,DocumentPromotionError,promotionIds}=await import(process.env.PROMO_MODULE??'../../../dist/packages/private-documents/src/legacy-promotion.js');
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {createIdempotencyKey} from '../../../dist/packages/idempotency-contract/src/index.js';
import {png} from './candidate-fixtures.mjs';
const url=process.env.DATABASE_URL;
const unavailable={skip:!url?'requires configured scratch PostgreSQL':false};
const ORG='org-a';
let pool,partitions;
before(async()=>{if(url){pool=new pg.Pool({connectionString:url});await runMigrations(pool);partitions=new PostgresDocumentPartitions(url);}});
after(async()=>{await partitions?.close();await pool?.end();});
const sha=b=>createHash('sha256').update(b).digest('hex');
let nextLegacy=BigInt(Date.now())*1000n;
const binding={acceptedCopy:randomUUID(),invocation:randomUUID()};

/** A live bucket in memory, create-only like R2: an existing key is read back and compared, never replaced. */
function liveBucket(){
 const objects=new Map(),log={puts:[],reads:[]};
 return {objects,log,port:{
  read:async(k,n)=>{log.reads.push(k);const b=objects.get(k);if(!b||b.length>n)throw new Error('unavailable');return Buffer.from(b);},
  writeImmutable:async(k,b)=>{log.puts.push(k);const old=objects.get(k);if(old){if(!old.equals(b))throw new Error('unavailable');return;}objects.set(k,Buffer.from(b));},
 }};
}
/** A linked person with one staged document of `kind`. */
async function rig({kind='personal-photo',bytes=png(Math.floor(Math.random()*200)),link=true}={}){
 const principal=`p-${randomUUID()}`,legacyId=String(nextLegacy++),generation=randomUUID();
 await pool.query('INSERT INTO principals (id) VALUES ($1)',[principal]);
 if(link)await pool.query("INSERT INTO legacy_account_links (principal_id, legacy_candidate_id, linked_by_ref, method) VALUES ($1,$2,$3,'staff')",[principal,legacyId,'a'.repeat(64)]);
 const mime=kind==='resume'?'application/pdf':'image/png',digest=sha(bytes);
 const staged={legacyId,kind,generation,mime,size:bytes.length,sha256:digest,objectKey:`legacy-import/${generation}/${legacyId}/${kind}/${digest}`};
 await pool.query(`INSERT INTO legacy_candidate_documents (legacy_candidate_id, kind, generation, mime, size, sha256, object_key, doccheck_invocation, copy_invocation)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[legacyId,kind,generation,mime,bytes.length,digest,staged.objectKey,randomUUID(),binding.acceptedCopy]);
 return {principal,legacyId,staged,bytes};
}
const promotion=(bucket,now)=>new LegacyDocumentPromotion({partitions,objects:bucket.port,orgId:ORG,...(now?{now}:{})});
const ledger=async p=>(await pool.query('SELECT kind, outcome, document_id::text AS id, document_version::text AS version, legacy_candidate_id FROM legacy_document_promotions WHERE principal_id=$1',[p])).rows;
const stateOf=async p=>(await pool.query("SELECT snapshot FROM candidate_document_partitions WHERE owner_kind='person' AND owner_id=$1",[p])).rows[0]?.snapshot;
const slots=async p=>(await pool.query('SELECT type, state FROM candidate_document_slots WHERE person_id=$1',[p])).rows;
/** The person's own candidate document service over the same store and bucket. */
function personService(principal,bucket,now){
 const credential=randomBytes(24).toString('base64url');
 const authz=new InMemoryAuthzStore({organizations:[{id:ORG,name:'Synthetic'}],principals:[{id:principal,pbuuids:[]}]});
 const service=new CandidateDocuments({store:new PartitionedR2DocumentStore(partitions,bucket.port),authz,orgId:ORG,origin:'https://documents.example.test',
  signingKey:randomBytes(32),...(now?{now}:{}),authenticate:async c=>c===credential?{kind:'principal',principalId:principal}:null});
 return {service,credential};
}
async function ownUpload(f,bytes=png(250)){
 const a=(await f.service.authorizeUpload(f.credential,createIdempotencyKey(),{type:'personal-photo',mime:'image/png',size:bytes.length,expectedVersion:null})).body;
 await f.service.put(f.credential,createIdempotencyKey(),a.uploadId,a.objectKey,a.credential,bytes);
 return a;
}

test('PROMO-01 an empty slot is filled once: document, ledger, slot history and a read-back object commit together',unavailable,async()=>{
 const r=await rig(),bucket=liveBucket(),ids=promotionIds(r.principal,r.staged);
 assert.equal(await promotion(bucket).promote(r.principal,r.staged,r.bytes,binding),'promoted');
 const s=await stateOf(r.principal),key=`immutable/${ids.version}/${r.staged.sha256}`;
 assert.deepEqual(s.state.documents.map(d=>[d.id,d.version,d.type,d.mime,d.size,d.scope,d.data]),[[ids.id,ids.version,'personal-photo','image/png',r.bytes.length,{orgId:ORG,personId:r.principal},`r2:${key}`]]);
 assert.deepEqual(bucket.log.puts,[key]);
 assert.ok(bucket.log.reads.includes(key),'the written object is read back before commit');
 assert.ok(bucket.objects.get(key).equals(r.bytes));
 assert.deepEqual(await ledger(r.principal),[{kind:'personal-photo',outcome:'promoted',id:ids.id,version:ids.version,legacy_candidate_id:r.legacyId}]);
 assert.deepEqual(await slots(r.principal),[{type:'personal-photo',state:'active'}]);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM candidate_document_object_reservations WHERE object_key=$1',[key])).rows[0].n,1);
 // The person sees it as their own document.
 const f=personService(r.principal,bucket);
 assert.deepEqual((await f.service.list(f.credential)).map(m=>m.id),[ids.id]);
 // A replay changes nothing and writes nothing.
 const puts=bucket.log.puts.length;
 assert.equal(await promotion(bucket).promote(r.principal,r.staged,r.bytes,binding),'alreadyPromoted');
 assert.equal(bucket.log.puts.length,puts);
 assert.deepEqual((await stateOf(r.principal)).state.documents.length,1);
 // The rows are immutable.
 await assert.rejects(pool.query("UPDATE legacy_document_promotions SET outcome='personHeld' WHERE principal_id=$1",[r.principal]),/never updated/);
});

test('PROMO-02 a slot the person ever held is never refilled: active, cleared, or another version',unavailable,async()=>{
 // Active: the person uploaded first.
 const a=await rig(),bucket=liveBucket(),f=personService(a.principal,bucket);
 const t=await ownUpload(f);const mine=(await f.service.finalize(f.credential,createIdempotencyKey(),{uploadId:t.uploadId})).body.metadata;
 const before=JSON.stringify(await stateOf(a.principal));
 assert.equal(await promotion(bucket).promote(a.principal,a.staged,a.bytes,binding),'personHeld');
 assert.equal(JSON.stringify(await stateOf(a.principal)),before,'the person\'s document is untouched');
 assert.deepEqual((await ledger(a.principal)).map(x=>[x.outcome,x.id]),[['personHeld',null]]);
 // Cleared: the person removed theirs; the empty slot is still theirs.
 const c=await rig(),g=personService(c.principal,bucket);
 const u=await ownUpload(g);const done=(await g.service.finalize(g.credential,createIdempotencyKey(),{uploadId:u.uploadId})).body.metadata;
 await g.service.remove(g.credential,createIdempotencyKey(),{type:'personal-photo',expectedVersion:done.version});
 assert.deepEqual(await slots(c.principal),[{type:'personal-photo',state:'cleared'}]);
 assert.equal(await promotion(bucket).promote(c.principal,c.staged,c.bytes,binding),'personHeld');
 assert.deepEqual((await stateOf(c.principal)).state.documents,[]);
 // Slot history alone is enough: a slot recorded as held, with no version left in the state, stays the person's.
 const h=await rig();
 await pool.query("INSERT INTO candidate_document_slots (person_id, org_id, type, state) VALUES ($1,$2,'personal-photo','cleared')",[h.principal,ORG]);
 assert.equal(await promotion(bucket).promote(h.principal,h.staged,h.bytes,binding),'personHeld');
 // Recorded once: a later run does not reconsider it.
 assert.equal(await promotion(bucket).promote(c.principal,c.staged,c.bytes,binding),'alreadyPromoted');
 assert.ok(mine.id);
 // Another kind of the same person is still empty and is promoted.
 const resumeBytes=(await import('./candidate-fixtures.mjs')).pdf();
 const digest=sha(resumeBytes),gen=randomUUID();
 const resume={legacyId:c.legacyId,kind:'resume',generation:gen,mime:'application/pdf',size:resumeBytes.length,sha256:digest,objectKey:`legacy-import/${gen}/${c.legacyId}/resume/${digest}`};
 await pool.query(`INSERT INTO legacy_candidate_documents (legacy_candidate_id, kind, generation, mime, size, sha256, object_key, doccheck_invocation, copy_invocation)
  VALUES ($1,'resume',$2,'application/pdf',$3,$4,$5,$6,$7)`,[c.legacyId,gen,resumeBytes.length,digest,resume.objectKey,randomUUID(),binding.acceptedCopy]);
 assert.equal(await promotion(bucket).promote(c.principal,resume,resumeBytes,binding),'promoted');
});

test('PROMO-03 an upload in progress is waited for, and an expired one is not',unavailable,async()=>{
 const r=await rig(),bucket=liveBucket();let now=Date.now();
 const f=personService(r.principal,bucket,()=>now);
 await f.service.authorizeUpload(f.credential,createIdempotencyKey(),{type:'personal-photo',mime:'image/png',size:10,expectedVersion:null});
 assert.equal(await promotion(bucket,()=>now).promote(r.principal,r.staged,r.bytes,binding),'uploadInProgress');
 assert.deepEqual(await ledger(r.principal),[],'nothing recorded: a later run tries again');
 now+=60_001;
 assert.equal(await promotion(bucket,()=>now).promote(r.principal,r.staged,r.bytes,binding),'promoted');
});

test('PROMO-04 the link, the staged row and the bytes are rechecked; nothing is recorded on a mismatch',unavailable,async()=>{
 const bucket=liveBucket();
 const none=await rig({link:false});
 assert.equal(await promotion(bucket).promote(none.principal,none.staged,none.bytes,binding),'notLinked');
 const moved=await rig();
 await pool.query('UPDATE legacy_account_links SET legacy_candidate_id=$2 WHERE principal_id=$1',[moved.principal,String(nextLegacy++)]);
 assert.equal(await promotion(bucket).promote(moved.principal,moved.staged,moved.bytes,binding),'linkChanged');
 // A staged row other than the one handed over (same key fields, another digest) is refused.
 const r=await rig(),other=png(251),od=sha(other);
 const forged={...r.staged,size:other.length,sha256:od,objectKey:`legacy-import/${r.staged.generation}/${r.legacyId}/personal-photo/${od}`};
 assert.equal(await promotion(bucket).promote(r.principal,forged,other,binding),'stagedChanged');
 // Bytes that are not the staged row's never reach a transaction.
 await assert.rejects(promotion(bucket).promote(r.principal,r.staged,png(252),binding),DocumentPromotionError);
 await assert.rejects(promotion(bucket).promote(r.principal,{...r.staged,objectKey:'legacy-import/elsewhere'},r.bytes,binding),DocumentPromotionError);
 // A principal id the document store cannot own is reported, not a failure that stops the walk.
 assert.equal(await promotion(bucket).promote('admin@example.test',r.staged,r.bytes,binding),'ineligible');
 for(const p of [none.principal,moved.principal,r.principal,'admin@example.test'])assert.deepEqual(await ledger(p),[]);
 assert.deepEqual(bucket.log.puts,[]);
});

test('PROMO-05 an uncertain write rolls back, and the retry names the same object and commits once',unavailable,async()=>{
 const r=await rig(),bucket=liveBucket(),ids=promotionIds(r.principal,r.staged),key=`immutable/${ids.version}/${r.staged.sha256}`;
 // The write lands but its answer is lost.
 let lose=true;const flaky={read:bucket.port.read,writeImmutable:async(k,b,m)=>{await bucket.port.writeImmutable(k,b,m);if(lose){lose=false;throw new Error('timeout');}}};
 await assert.rejects(new LegacyDocumentPromotion({partitions,objects:flaky,orgId:ORG}).promote(r.principal,r.staged,r.bytes,binding),DocumentPromotionError);
 assert.deepEqual(await ledger(r.principal),[]);
 assert.deepEqual((await stateOf(r.principal))?.state.documents??[],[]);
 assert.ok(bucket.objects.has(key),'the object stays (reserved, never deleted)');
 assert.equal(await new LegacyDocumentPromotion({partitions,objects:flaky,orgId:ORG}).promote(r.principal,r.staged,r.bytes,binding),'promoted');
 assert.deepEqual(bucket.log.puts,[key,key],'the retry wrote to the same key');
 assert.deepEqual((await ledger(r.principal)).map(x=>x.version),[ids.version]);
 // An object that does not read back to the bytes fails closed.
 const s=await rig(),bad=liveBucket();
 const corrupt={read:async(k,n)=>{const b=await bad.port.read(k,n);b[b.length-1]^=1;return b;},writeImmutable:bad.port.writeImmutable};
 await assert.rejects(new LegacyDocumentPromotion({partitions,objects:corrupt,orgId:ORG}).promote(s.principal,s.staged,s.bytes,binding),DocumentPromotionError);
 assert.deepEqual(await ledger(s.principal),[]);
});

test('PROMO-06 a promotion and the person\'s own upload serialise on the person\'s lock: one current document, never both',unavailable,async()=>{
 for(let i=0;i<6;i++){
  const r=await rig(),bucket=liveBucket(),f=personService(r.principal,bucket);
  const bytes=png(240+i);
  const [promoted,own]=await Promise.allSettled([promotion(bucket).promote(r.principal,r.staged,r.bytes,binding),
   (async()=>{const t=await ownUpload(f,bytes);return f.service.finalize(f.credential,createIdempotencyKey(),{uploadId:t.uploadId});})()]);
  const docs=(await stateOf(r.principal)).state.documents;
  assert.equal(docs.length,1,'exactly one current photo');
  if(promoted.value==='promoted'){
   assert.equal(own.status,'rejected','the person\'s upload sees the promoted version and is refused');
   assert.equal(docs[0].id,promotionIds(r.principal,r.staged).id);
  }else{
   assert.ok(['uploadInProgress','personHeld'].includes(promoted.value),promoted.value);
   assert.equal(own.status,'fulfilled');
  }
 }
});
