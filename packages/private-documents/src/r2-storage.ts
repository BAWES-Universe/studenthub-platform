import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import pg from 'pg';
import { LifecycleError } from './candidate-lifecycle.js';
import { DocumentError, validateState, type DocumentState, type DocumentStore } from './index.js';
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
}
/** Production metadata port, isolated from profile tables. One locked metadata
 * row provides the same transaction semantics as the existing reference store.
 * A separate small pool prevents reservation deadlocks with snapshot readers. */
export class PostgresDocumentSnapshot implements SnapshotPort {
  private readonly pool:pg.Pool;
  private readonly journal:pg.Pool;
  constructor(connectionString:string){this.pool=new pg.Pool({connectionString,max:2});this.journal=new pg.Pool({connectionString,max:1});}
  async reserve(key:string):Promise<void>{
    checkKey(key);
    await this.journal.query('INSERT INTO candidate_document_object_reservations (object_key) VALUES ($1) ON CONFLICT DO NOTHING',[key]);
  }
  async transaction<T>(fn:(snapshot:PackedSnapshot)=>Promise<T>):Promise<T>{
    const c=await this.pool.connect();let destroy=false;
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '5s'");
      const rows=await c.query('SELECT snapshot FROM candidate_document_snapshot WHERE singleton = true FOR UPDATE');
      if(rows.rowCount!==1)throw new Error();
      const value=rows.rows[0].snapshot as PackedSnapshot;
      const before=JSON.stringify(value),result=await fn(value),after=JSON.stringify(value);
      if(Buffer.byteLength(after)>16*1024*1024)throw new Error();
      if(before!==after)await c.query('UPDATE candidate_document_snapshot SET snapshot = $1::jsonb WHERE singleton = true',[after]);
      await c.query('COMMIT');return result;
    } catch (error) {
      try {await c.query('ROLLBACK');}catch{destroy=true;}
      if (error instanceof LifecycleError || error instanceof DocumentError) throw error;
      throw new Error('unavailable');
    } finally {c.release(destroy);}
  }
  async close():Promise<void>{await Promise.all([this.pool.end(),this.journal.end()]);}
}
/** Hydrate only inside the private transaction, reuse all primitive validators,
 * then store bytes exclusively in immutable R2 objects. SQL holds references,
 * metadata, receipts and audit, never document bodies. */
export class R2DocumentStore implements DocumentStore {
  constructor(readonly snapshots:SnapshotPort,readonly objects:PrivateObjectPort){}
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
