import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresDocumentPartitions,PartitionedR2DocumentStore,R2DocumentStore,emptyPackedSnapshot} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {CandidateDocuments} from '../../../dist/packages/private-documents/src/candidate-lifecycle.js';
import {PrivateDocuments} from '../../../dist/packages/private-documents/src/index.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {createIdempotencyKey} from '../../../dist/packages/idempotency-contract/src/index.js';
import {png} from './candidate-fixtures.mjs';
const url=process.env.DATABASE_URL;
const unavailable={skip:!url?'requires configured scratch PostgreSQL':false};
const migration=name=>readFileSync(new URL(`../../db/migrations/${name}`,import.meta.url),'utf8');
const sha=v=>createHash('sha256').update(v).digest('hex');
const schema=`m0661_${randomBytes(6).toString('hex')}`;
let admin;
before(async()=>{if(url)admin=new pg.Pool({connectionString:url,max:1});});
after(async()=>{if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});

/** The old single-row store, driven by the real services, with active, replaced, removed and pending documents. */
async function legacyRow(objects){
 let packed=emptyPackedSnapshot(),tail=Promise.resolve();
 const port={reserve:async()=>{},transaction:fn=>{const next=tail.then(async()=>{const draft=structuredClone(packed);const r=await fn(draft);packed=draft;return r;});tail=next.then(()=>undefined,()=>undefined);return next;}};
 const store=new R2DocumentStore(port,{read:async k=>Buffer.from(objects.get(k)),writeImmutable:async(k,b)=>{objects.set(k,Buffer.from(b));}});
 const people=['alice','bob','carol','dave'];
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic'}],principals:people.map(id=>({id,pbuuids:[]}))});
 await authz.grantMany('dave',[{orgId:'org-a',role:'org-owner',scope:'self'}]);
 const credentials=Object.fromEntries(people.map(p=>[p,randomBytes(32).toString('base64url')]));
 const options={authz,orgId:'org-a',origin:'https://documents.example.test',signingKey:randomBytes(32),now:()=>1800000000000,
  authenticate:async c=>{const p=people.find(x=>credentials[x]===c);return p?{kind:'principal',principalId:p}:null;}};
 const service=new CandidateDocuments({...options,store});
 const upload=async(who,bytes,expectedVersion=null)=>{
  const a=(await service.authorizeUpload(credentials[who],createIdempotencyKey(new Date(1800000000000)),{type:'personal-photo',mime:'image/png',size:bytes.length,expectedVersion})).body;
  await service.put(credentials[who],createIdempotencyKey(new Date(1800000000000)),a.uploadId,a.objectKey,a.credential,bytes);return a;};
 const fin=async(who,a,key=createIdempotencyKey(new Date(1800000000000)))=>({key,a,response:await service.finalize(credentials[who],key,{uploadId:a.uploadId})});
 const first=await fin('alice',await upload('alice',png(1)));
 const replaced=await fin('alice',await upload('alice',png(2),first.response.body.metadata.version));
 const bob=await fin('bob',await upload('bob',png(3)));
 await service.remove(credentials.bob,createIdempotencyKey(new Date(1800000000000)),{type:'personal-photo',expectedVersion:bob.response.body.metadata.version});
 const pending=await upload('carol',png(4));
 const org=await new PrivateDocuments({...options,store}).upload(credentials.dave,{scope:{orgId:'org-a'},type:'company-logo',mime:'image/png',bytes:png(5)});
 return {packed,credentials,options,replaced,pending,org,held:(await service.cleanup()).held};
}

test('PART-MIG 0661 splits the single row into owners with parity, and every behaviour carries over',unavailable,async()=>{
 const objects=new Map(),old=await legacyRow(objects),keysBefore=[...objects.keys()].sort();
 // Build the pre-0661 tables in a scratch schema, load the old row, then run 0661 itself.
 const c=await admin.connect();
 try{
  await c.query(`CREATE SCHEMA ${schema}`);await c.query(`SET search_path = ${schema}`);
  await c.query(migration('0145_candidate_private_documents.sql'));await c.query(migration('0220_candidate_document_read_audit.sql'));
  await c.query('CREATE TABLE principals (id text PRIMARY KEY, display_name text, email text)');
  await c.query('UPDATE candidate_document_snapshot SET snapshot = $1::jsonb',[JSON.stringify(old.packed)]);
  await c.query(migration('0661_candidate_document_partitions.sql'));
  const rows=(await c.query('SELECT owner_kind, owner_id, snapshot FROM candidate_document_partitions ORDER BY owner_kind, owner_id')).rows;
  assert.deepEqual(rows.map(r=>[r.owner_kind,r.owner_id]),[['org','org-a'],['person','alice'],['person','bob'],['person','carol']]);
  // Each owner holds exactly its share of every array, in the old order, and the blob references its rows use.
  const st=old.packed.state,l=st.lifecycle,owner=r=>({kind:r.owner_kind,id:r.owner_id});
  const mine=(o,d)=>o.kind==='org'?d.scope.personId===undefined&&d.scope.orgId===o.id:d.scope.personId===o.id;
  for(const r of rows){
   const o=owner(r),s=r.snapshot.state,ids=new Set([...st.documents,...st.retired].filter(d=>mine(o,d)).map(d=>d.id));
   assert.deepEqual(s.documents,st.documents.filter(d=>mine(o,d)));
   assert.deepEqual(s.retired,st.retired.filter(d=>mine(o,d)));
   assert.deepEqual(s.lifecycle.uploads,l.uploads.filter(t=>o.kind==='person'&&t.principalId===o.id));
   assert.deepEqual(s.lifecycle.receipts,l.receipts.filter(x=>o.kind==='person'&&x.principalRef===sha(o.id)));
   assert.deepEqual(s.lifecycle.audit,l.audit.filter(x=>o.kind==='person'&&x.principalRef===sha(o.id)));
   assert.deepEqual(s.lifecycle.cleanup,l.cleanup.filter(x=>ids.has(x.documentId)));
  }
  assert.deepEqual(Object.assign({},...rows.map(r=>r.snapshot.blobs)),old.packed.blobs,'every blob reference kept, digests and sizes unchanged');
  assert.deepEqual((await c.query('SELECT type, person_id, state FROM candidate_document_slots ORDER BY person_id')).rows,
   [{type:'personal-photo',person_id:'alice',state:'active'},{type:'personal-photo',person_id:'bob',state:'cleared'}]);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM candidate_document_ids')).rows[0].n,new Set([...st.documents,...st.retired].map(d=>d.id)).size);
  assert.equal((await c.query('SELECT store FROM candidate_document_store_authority')).rows[0].store,'partitioned');
  await assert.rejects(c.query('UPDATE candidate_document_snapshot SET snapshot = snapshot'));
  assert.deepEqual((await c.query('SELECT snapshot FROM candidate_document_snapshot')).rows[0].snapshot,old.packed,'the old row is kept unchanged');
 }finally{await c.query('RESET search_path');c.release();}
 assert.deepEqual([...objects.keys()].sort(),keysBefore,'the migration copies and deletes no object');

 // The same people, through the new store.
 const scoped=`${url}${url.includes('?')?'&':'?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
 const partitions=new PostgresDocumentPartitions(scoped);
 try{
  const store=new PartitionedR2DocumentStore(partitions,{read:async k=>Buffer.from(objects.get(k)),writeImmutable:async(k,b)=>{objects.set(k,Buffer.from(b));}});
  const service=new CandidateDocuments({...old.options,store}),cred=old.credentials;
  // Receipt replay: the same key and request returns the stored response.
  assert.deepEqual(await service.finalize(cred.alice,old.replaced.key,{uploadId:old.replaced.a.uploadId}),old.replaced.response,'the stored response replays');
  assert.equal(await service.finalize(cred.alice,old.replaced.key,{uploadId:old.pending.uploadId}).catch(e=>e.code),'key_payload_mismatch','another request under a stored key is refused');
  const replayed=await service.list(cred.alice);
  assert.deepEqual(replayed.map(m=>m.version),[old.replaced.response.body.metadata.version]);
  const link=await service.issueDelivery(cred.alice,replayed[0].id);
  assert.deepEqual((await service.deliver(cred.alice,link.url)).bytes,png(2),'signed delivery reads the same object');
  assert.deepEqual(await service.list(cred.bob),[],'a removed document stays removed');
  // The pending upload finalizes.
  assert.equal((await service.finalize(cred.carol,createIdempotencyKey(new Date(1800000000000)),{uploadId:old.pending.uploadId})).status,200);
  // Held cleanup carries over (carol's finalize released only her own staged duplicate).
  assert.equal((await service.cleanup()).held,old.held-1);
  // An organization's own document is found by its id.
  assert.equal((await new PrivateDocuments({...old.options,store}).metadata(cred.dave,old.org.id)).version,old.org.version);
 }finally{await partitions.close();}
});
