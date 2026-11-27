import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import pg from 'pg';
import { LifecycleError } from './candidate-lifecycle.js';
import { DocumentError, documentReadHydrator, ownerOfScope, sameOwner, validateReferencedState, validateState, type CurrentDocument, type DocumentOwner, type DocumentState, type DocumentStore } from './index.js';
import type { UploadTicket } from './lifecycle-state.js';

const digest = (bytes:Buffer):string => createHash('sha256').update(bytes).digest('hex');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const validKey = new RegExp(`^(uploads/${uuid}|immutable/${uuid}/[0-9a-f]{64})$`);
function checkKey(key:string):void { if (!validKey.test(key)) throw new Error('unavailable'); }
export interface PrivateObjectPort {
  read(key:string,maximum:number):Promise<Buffer>;
  writeImmutable(key:string,bytes:Buffer,mime:string):Promise<void>;
}
export interface DirectUploadPort {
  authorize(ticket:UploadTicket):Promise<{url:string;headers:Record<string,string>}>;
  read(ticket:UploadTicket):Promise<Buffer>;
}
/** R2 S3 transport: no ACL, public URL or delete API. All server requests are
 * bounded; only single-object PUT capabilities leave the server. */
export class R2Objects implements PrivateObjectPort, DirectUploadPort {
  readonly client:S3Client;
  constructor(private readonly config:{accountId:string;bucket:string;accessKeyId:string;secretAccessKey:string;client?:S3Client}) {
    if (!/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
      || !config.accessKeyId || !config.secretAccessKey) throw new Error('invalid candidate-document configuration');
    this.client=config.client ?? new S3Client({region:'auto',endpoint:`https://${config.accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,
      credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},maxAttempts:2,
      requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  }
  async authorize(t:UploadTicket):Promise<{url:string;headers:Record<string,string>}> {
    checkKey(t.objectKey);
    if (!t.expectedDigest || !t.contentMd5 || t.expiresAt-t.issuedAt !== 60000) throw new Error('invalid');
    const headers={'content-type':t.mime,'content-length':String(t.size),'content-md5':t.contentMd5,'if-none-match':'*'};
    const url=await getSignedUrl(this.client,new PutObjectCommand({Bucket:this.config.bucket,Key:t.objectKey,ContentType:t.mime,
      ContentLength:t.size,ContentMD5:t.contentMd5,IfNoneMatch:'*'}),{expiresIn:60,signingDate:new Date(t.issuedAt),
      signableHeaders:new Set(Object.keys(headers))});
    return {url,headers};
  }
  async read(input:string|UploadTicket,maximum=10*1024*1024):Promise<Buffer> {
    const key=typeof input==='string'?input:input.objectKey;
    const limit=typeof input==='string'?maximum:input.size;
    checkKey(key);
    try {
      const result=await this.client.send(new GetObjectCommand({Bucket:this.config.bucket,Key:key}),{abortSignal:AbortSignal.timeout(10000)});
      if (!result.Body || !Number.isSafeInteger(result.ContentLength) || result.ContentLength! > limit) {
        (result.Body as {destroy?:()=>void})?.destroy?.(); throw new Error();
      }
      const chunks:Buffer[]=[];let size=0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        const b=Buffer.from(chunk);size+=b.length;
        if(size>limit) {(result.Body as {destroy?:()=>void}).destroy?.();throw new Error();}chunks.push(b);
      }
      if(size!==result.ContentLength)throw new Error();
      return Buffer.concat(chunks);
    } catch {throw new Error('unavailable');}
  }
  async writeImmutable(key:string,bytes:Buffer,mime:string):Promise<void> {
    checkKey(key);
    try {
      await this.client.send(new PutObjectCommand({Bucket:this.config.bucket,Key:key,Body:bytes,ContentLength:bytes.length,
        ContentType:mime,ContentMD5:createHash('md5').update(bytes).digest('base64'),CacheControl:'private, no-store',IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(10000)});
    } catch (e) {
      // A retried immutable PUT may already exist. Never overwrite it, and do
      // not interpret an arbitrary provider error as success.
      if ((e as {$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode===412
        && digest(await this.read(key,bytes.length))===digest(bytes)) return;
      throw new Error('unavailable');
    }
  }
  close():void {this.client.destroy();}
}
export interface PackedSnapshot {state:DocumentState;blobs:Record<string,{key:string;digest:string;size:number}>}
export const emptyPackedSnapshot=():PackedSnapshot=>({state:{format:1,documents:[],retired:[]},blobs:{}});
export interface SnapshotPort {
  transaction<T>(fn:(snapshot:PackedSnapshot)=>Promise<T>):Promise<T>;
  /** Independent durable quarantine reservation BEFORE any immutable object PUT.
   * It survives metadata rollback. No implementation may delete these objects. */
  reserve(key:string):Promise<void>;
  read?():Promise<PackedSnapshot>;
  auditRead?(entry:{operation:'list'|'issueDelivery'|'deliver';principalRef:string;at:number}):Promise<void>;
}
const ownerId=/^[A-Za-z0-9_-]{1,128}$/;
function checkOwner(owner:DocumentOwner):void{if((owner.kind!=='person'&&owner.kind!=='org')||!ownerId.test(owner.id))throw new Error('unavailable');}
const sha=(value:string):string=>createHash('sha256').update(value).digest('hex');
/** Every row of a per-owner state must belong to that owner: its documents and retired
 * versions by scope, its uploads, receipts and audit by principal, its cleanup by document. */
function ownedBy(owner:DocumentOwner,state:DocumentState):void{
  const rows=[...state.documents,...state.retired],ids=new Set(rows.map(d=>d.id));
  if(rows.some(d=>!sameOwner(ownerOfScope(d.scope),owner)))throw new Error('unavailable');
  const l=state.lifecycle;if(!l)return;
  const ref=owner.kind==='person'?sha(owner.id):null;
  if(l.uploads.some(t=>owner.kind!=='person'||t.principalId!==owner.id)||l.receipts.some(r=>r.principalRef!==ref)
    ||l.audit.some(a=>a.principalRef!==ref)||l.cleanup.some(c=>!ids.has(c.documentId)))throw new Error('unavailable');
}
/** Production metadata port: one row per owner (migration 0661), so a write locks and reads only
 * that owner's documents. The owner row is created empty on first use and is the lock every
 * upload, replace, remove and promotion of that owner's slots shares. The same transaction keeps
 * the document-id index and the durable slot history. A separate small pool commits object
 * reservations (they survive a metadata rollback); another serves unlocked reads and read audit. */
export class PostgresDocumentPartitions {
  private readonly pool:pg.Pool;
  private readonly journal:pg.Pool;
  private readonly reader:pg.Pool;
  constructor(connectionString:string){this.pool=new pg.Pool({connectionString,max:2});this.journal=new pg.Pool({connectionString,max:1});this.reader=new pg.Pool({connectionString,max:2});}
  /** The snapshot port of one owner. */
  port(owner:DocumentOwner):SnapshotPort{
    checkOwner(owner);
    return {transaction:fn=>this.transaction(owner,fn),reserve:key=>this.reserve(key),read:()=>this.read(owner),auditRead:entry=>this.auditRead(entry)};
  }
  async read(owner:DocumentOwner):Promise<PackedSnapshot>{
    checkOwner(owner);
    try {const rows=await this.reader.query('SELECT snapshot FROM candidate_document_partitions WHERE owner_kind = $1 AND owner_id = $2',[owner.kind,owner.id]);
      if(rows.rowCount===0)return emptyPackedSnapshot();if(rows.rowCount!==1)throw new Error();return rows.rows[0].snapshot as PackedSnapshot;}catch{throw new Error('unavailable');}
  }
  /** Current documents of `types` in `orgId` across people, for listings such as the civil ID
   * review queue. Only people whose slot history says such a slot is active are read, and only
   * each document's metadata leaves the database: no retired version, journal or body. */
  async listCurrent(orgId:string,types:readonly string[]):Promise<CurrentDocument[]>{
    if(!ownerId.test(orgId)||!types.length||types.some(t=>typeof t!=='string'))throw new Error('unavailable');
    let rows;
    try {rows=(await this.reader.query(`SELECT jsonb_build_object('id', d.doc->'id', 'version', d.doc->'version', 'type', d.doc->'type', 'mime', d.doc->'mime', 'size', d.doc->'size', 'scope', d.doc->'scope') AS doc
      FROM candidate_document_partitions p CROSS JOIN LATERAL jsonb_array_elements(p.snapshot->'state'->'documents') WITH ORDINALITY AS d(doc, ord)
      WHERE p.owner_kind = 'person' AND p.owner_id IN (SELECT person_id FROM candidate_document_slots WHERE org_id = $1 AND type = ANY($2::text[]) AND state = 'active')
        AND d.doc->'scope'->>'orgId' = $1 AND d.doc->>'type' = ANY($2::text[])
      ORDER BY p.owner_id COLLATE "C", d.ord`,[orgId,[...types]])).rows;}catch{throw new Error('unavailable');}
    return rows.map(({doc})=>{
      if(!/^[0-9a-f-]{36}$/.test(doc.id)||!/^[0-9a-f-]{36}$/.test(doc.version)||!types.includes(doc.type)||typeof doc.mime!=='string'||!Number.isSafeInteger(doc.size)
        ||doc.scope?.orgId!==orgId||typeof doc.scope?.personId!=='string')throw new Error('unavailable');
      return doc as CurrentDocument;
    });
  }
  /** The held cleanup count across owners (retired versions held plus staged upload bodies); one number leaves the database. */
  async heldCount():Promise<number>{
    try {
      const rows=await this.reader.query(`SELECT COALESCE(sum(
        (SELECT count(*) FROM jsonb_array_elements(COALESCE(p.snapshot->'state'->'lifecycle'->'cleanup', '[]'::jsonb)) c WHERE c->>'status' = 'held')
        + (SELECT count(*) FROM jsonb_array_elements(COALESCE(p.snapshot->'state'->'lifecycle'->'uploads', '[]'::jsonb)) u WHERE u ? 'data')), 0)::int AS held
        FROM candidate_document_partitions p`);
      return rows.rows[0].held as number;
    } catch {throw new Error('unavailable');}
  }
  /** The owner of a document id, or null. */
  async locate(documentId:string):Promise<DocumentOwner|null>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(documentId))return null;
    let rows;
    try {rows=await this.reader.query('SELECT owner_kind, owner_id FROM candidate_document_ids WHERE document_id = $1',[documentId]);}catch{throw new Error('unavailable');}
    if(rows.rowCount===0)return null;
    const owner={kind:rows.rows[0].owner_kind,id:rows.rows[0].owner_id} as DocumentOwner;checkOwner(owner);return owner;
  }
  async auditRead(entry:{operation:'list'|'issueDelivery'|'deliver';principalRef:string;at:number}):Promise<void>{
    try {await this.reader.query('INSERT INTO candidate_document_read_audit (id, operation, principal_ref, occurred_at) VALUES (gen_random_uuid(), $1, $2, to_timestamp($3 / 1000.0))',[entry.operation,entry.principalRef,entry.at]);}catch{throw new Error('unavailable');}
  }
  async reserve(key:string):Promise<void>{
    checkKey(key);
    await this.journal.query('INSERT INTO candidate_document_object_reservations (object_key) VALUES ($1) ON CONFLICT DO NOTHING',[key]);
  }
  async transaction<T>(owner:DocumentOwner,fn:(snapshot:PackedSnapshot)=>Promise<T>):Promise<T>{
    checkOwner(owner);
    const c=await this.pool.connect();let destroy=false;
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '5s'");
      // Every writer holds the authority row, so the rollback script (FOR UPDATE) never races a
      // write. Until the first owner write it is held exclusively; that write records itself.
      const seen=await c.query('SELECT first_write_at FROM candidate_document_store_authority WHERE singleton = true');
      if(seen.rowCount!==1)throw new Error();
      const authority=await c.query(`SELECT store, first_write_at FROM candidate_document_store_authority WHERE singleton = true ${seen.rows[0].first_write_at===null?'FOR UPDATE':'FOR SHARE'}`);
      if(authority.rowCount!==1||authority.rows[0].store!=='partitioned')throw new Error();
      await c.query('INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING',[owner.kind,owner.id,JSON.stringify(emptyPackedSnapshot())]);
      const rows=await c.query('SELECT snapshot FROM candidate_document_partitions WHERE owner_kind = $1 AND owner_id = $2 FOR UPDATE',[owner.kind,owner.id]);
      if(rows.rowCount!==1)throw new Error();
      const value=rows.rows[0].snapshot as PackedSnapshot;
      const before=JSON.stringify(value),result=await fn(value),after=JSON.stringify(value);
      if(Buffer.byteLength(after)>16*1024*1024)throw new Error();
      if(before!==after){
        ownedBy(owner,value.state);
        await c.query('UPDATE candidate_document_partitions SET snapshot = $3::jsonb WHERE owner_kind = $1 AND owner_id = $2',[owner.kind,owner.id,after]);
        await this.index(c,owner,value.state);
        if(authority.rows[0].first_write_at===null)await c.query('UPDATE candidate_document_store_authority SET first_write_at = now() WHERE singleton = true AND first_write_at IS NULL');
      }
      await c.query('COMMIT');return result;
    } catch (error) {
      try {await c.query('ROLLBACK');}catch{destroy=true;}
      if (error instanceof LifecycleError || error instanceof DocumentError) throw error;
      throw new Error('unavailable');
    } finally {c.release(destroy);}
  }
  /** Document ids stay with their owner forever; slot history records every slot that ever held a document. */
  private async index(c:pg.PoolClient,owner:DocumentOwner,state:DocumentState):Promise<void>{
    const rows=[...state.documents,...state.retired],ids=[...new Set(rows.map(d=>d.id))];
    await c.query('INSERT INTO candidate_document_ids (document_id, owner_kind, owner_id) SELECT unnest($3::uuid[]), $1, $2 ON CONFLICT (document_id) DO NOTHING',[owner.kind,owner.id,ids]);
    const foreign=await c.query('SELECT count(*)::int AS n FROM candidate_document_ids WHERE document_id = ANY($3::uuid[]) AND (owner_kind <> $1 OR owner_id <> $2)',[owner.kind,owner.id,ids]);
    if(foreign.rows[0].n!==0)throw new Error();
    if(owner.kind!=='person')return;
    const slots=new Map<string,{org:string;type:string;state:'active'|'cleared'}>();
    for(const d of state.retired)slots.set(JSON.stringify([d.scope.orgId,d.type]),{org:d.scope.orgId,type:d.type,state:'cleared'});
    for(const d of state.documents)slots.set(JSON.stringify([d.scope.orgId,d.type]),{org:d.scope.orgId,type:d.type,state:'active'});
    const list=[...slots.values()];
    await c.query(`INSERT INTO candidate_document_slots (person_id, org_id, type, state) SELECT $1, o, t, s FROM unnest($2::text[], $3::text[], $4::text[]) AS x(o, t, s)
      ON CONFLICT (person_id, org_id, type) DO UPDATE SET state = EXCLUDED.state, updated_at = now() WHERE candidate_document_slots.state <> EXCLUDED.state`,
      [owner.id,list.map(x=>x.org),list.map(x=>x.type),list.map(x=>x.state)]);
  }
  async close():Promise<void>{await Promise.all([this.pool.end(),this.journal.end(),this.reader.end()]);}
}
/** The production document store: one R2DocumentStore per owner over PostgresDocumentPartitions.
 * Reads and writes go through partition(owner); a whole-store read or transaction is refused.
 * Cross-owner needs have their own bounded queries (listCurrent, heldCount). */
export class PartitionedR2DocumentStore implements DocumentStore {
  constructor(readonly partitions:PostgresDocumentPartitions,readonly objects:PrivateObjectPort){}
  partition(owner:DocumentOwner):DocumentStore{return new R2DocumentStore(this.partitions.port(owner),this.objects);}
  locate(documentId:string):Promise<DocumentOwner|null>{return this.partitions.locate(documentId);}
  listCurrent(orgId:string,types:readonly string[]):Promise<CurrentDocument[]>{return this.partitions.listCurrent(orgId,types);}
  heldCount():Promise<number>{return this.partitions.heldCount();}
  async transaction<T>():Promise<T>{throw new Error('unavailable');}
}
/** Hydrate only inside the private transaction, reuse all primitive validators,
 * then store bytes exclusively in immutable R2 objects. SQL holds references,
 * metadata, receipts and audit, never document bodies. */
export class R2DocumentStore implements DocumentStore {
  readonly readPath?:DocumentStore['readPath'];
  constructor(readonly snapshots:SnapshotPort,readonly objects:PrivateObjectPort){
    if(snapshots.read&&snapshots.auditRead)this.readPath={
      read:async fn=>{
        const packed=await snapshots.read!();
        if(!packed||typeof packed!=='object'||!packed.state||!packed.blobs||typeof packed.blobs!=='object'||!Array.isArray(packed.state.documents)||!Array.isArray(packed.state.retired))throw new Error('unavailable');
        const s=structuredClone(packed.state),rows=[...s.documents,...s.retired,...(s.lifecycle?.uploads??[]).filter(t=>t.data!==undefined)];
        const refs=new Map<string,{row:(typeof rows)[number];key:string;digest:string;size:number}>();let total=0;
        for(const row of rows){
          if(typeof row.data!=='string'||!row.data.startsWith('r2:'))throw new Error('unavailable');
          const key=row.data.slice(3);checkKey(key);const ref=packed.blobs[key];
          if(!ref||ref.key!==key||!Number.isSafeInteger(ref.size)||ref.size<1||ref.size>100*1024*1024||ref.size!==row.size||!/^[0-9a-f]{64}$/.test(ref.digest))throw new Error('unavailable');
          total+=ref.size;if(total>192*1024*1024)throw new Error('unavailable');
          if('version'in row&&s.documents.includes(row))refs.set(row.id,{row,key,digest:ref.digest,size:ref.size});
        }
        validateReferencedState(s);
        Object.defineProperty(s,documentReadHydrator,{value:async(id:string)=>{const item=refs.get(id);if(!item)return;const bytes=await this.objects.read(item.key,item.size);if(bytes.length!==item.size||digest(bytes)!==item.digest)throw new Error('unavailable');item.row.data=bytes.toString('base64');}});
        return fn(s);
      },
      audit:entry=>snapshots.auditRead!(entry)
    };
  }
  async transaction<T>(fn:(state:DocumentState)=>Promise<T>):Promise<T>{
    return this.snapshots.transaction(async packed=>{
      if (!packed || typeof packed!=='object' || !packed.state || !packed.blobs || typeof packed.blobs!=='object'
        || !Array.isArray(packed.state.documents) || !Array.isArray(packed.state.retired)) throw new Error('unavailable');
      const s=structuredClone(packed.state);
      const items=()=>[...s.documents,...s.retired,...(s.lifecycle?.uploads??[]).filter(t=>t.data!==undefined)];
      let total=0;
      for(const row of items()){
        if(typeof row.data!=='string'||!row.data.startsWith('r2:'))throw new Error('unavailable');
        const key=row.data.slice(3);checkKey(key);const ref=packed.blobs[key];
        if(!ref||ref.key!==key||!Number.isSafeInteger(ref.size)||ref.size<1||ref.size>100*1024*1024||!/^[0-9a-f]{64}$/.test(ref.digest))throw new Error('unavailable');
        total+=ref.size;if(total>192*1024*1024)throw new Error('unavailable');
        const bytes=await this.objects.read(key,ref.size);
        if(bytes.length!==ref.size||digest(bytes)!==ref.digest)throw new Error('unavailable');
        row.data=bytes.toString('base64');
      }
      validateState(s);
      const result=await fn(s);validateState(s);
      if(Buffer.byteLength(JSON.stringify(s))>256*1024*1024)throw new Error('unavailable');
      const next:PackedSnapshot={state:s,blobs:{}};
      for(const row of items()){
        const bytes=Buffer.from(row.data!,'base64'),sha=digest(bytes);
        // IDs and digests are validated server data, never a caller-selected prefix.
        const key=`immutable/${'version' in row?row.version:row.id}/${sha}`;checkKey(key);
        const previous=packed.blobs[key];
        if(previous && (previous.digest!==sha||previous.size!==bytes.length))throw new Error('unavailable');
        if(!previous){await this.snapshots.reserve(key);await this.objects.writeImmutable(key,bytes,row.mime);}
        next.blobs[key]={key,digest:sha,size:bytes.length};row.data=`r2:${key}`;
      }
      packed.state=next.state;packed.blobs=next.blobs;
      return result;
    });
  }
}
