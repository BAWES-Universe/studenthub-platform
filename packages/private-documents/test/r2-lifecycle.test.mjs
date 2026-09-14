import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {S3Client} from '@aws-sdk/client-s3';
import {R2Objects,R2DocumentStore,emptyPackedSnapshot} from '../../../dist/packages/private-documents/src/r2-storage.js';
import {createCandidateDocuments,createRuntimeCandidateDocumentsFromEnv} from '../../../dist/apps/gateway/src/candidate-documents-runtime.js';
import {createGatewayServer} from '../../../dist/apps/gateway/src/index.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {createIdempotencyKey} from '../../../dist/packages/idempotency-contract/src/index.js';
import {png,pdf} from './candidate-fixtures.mjs';
const origin='https://documents.example.test',accountId='0'.repeat(32),bucket='synthetic-private-documents';
const accessKeyId='synthetic-access-id',secretAccessKey='synthetic-only-secret-not-a-live-credential';
const hash=b=>createHash('sha256').update(b).digest('hex');
const md5=b=>createHash('md5').update(b).digest('base64');
const hmac=(key,s)=>createHmac('sha256',key).update(s).digest();
const encode=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
/** Independent SigV4 verifier for the synthetic PUT endpoint. The application
 * uses the SDK signer; this verifier recomputes canonical request and key scope. */
function accepts(url,headers,bytes,now){
 try {
  const u=new URL(url),q=u.searchParams,signed=q.get('X-Amz-SignedHeaders').split(';');
  const date=q.get('X-Amz-Date'),issued=Date.UTC(+date.slice(0,4),+date.slice(4,6)-1,+date.slice(6,8),+date.slice(9,11),+date.slice(11,13),+date.slice(13,15));
  if(now<issued||now>=issued+Number(q.get('X-Amz-Expires'))*1000)return false;
  const values={...headers,host:u.host};
  const query=[...q].filter(([k])=>k!=='X-Amz-Signature').map(([k,v])=>[encode(k),encode(v)]).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([k,v])=>`${k}=${v}`).join('&');
  const canonical=['PUT',u.pathname,query,signed.map(k=>`${k}:${values[k].trim()}\n`).join(''),signed.join(';'),'UNSIGNED-PAYLOAD'].join('\n');
  const scope=q.get('X-Amz-Credential').split('/').slice(1).join('/');
  const [day,region,service]=scope.split('/');
  const key=hmac(hmac(hmac(hmac('AWS4'+secretAccessKey,day),region),service),'aws4_request');
  return hmac(key,['AWS4-HMAC-SHA256',date,scope,hash(canonical)].join('\n')).toString('hex')===q.get('X-Amz-Signature')
    && +headers['content-length']===bytes.length&&headers['content-md5']===md5(bytes)&&headers['if-none-match']==='*';
 }catch{return false;}
}
async function fixture(t){
 let packed=emptyPackedSnapshot(),tail=Promise.resolve(),fail=false,uncertain=false,now=1800000000000;
 const reserved=new Set(),objects=new Map(),requests=[];
 const snapshots={reserve:async key=>{reserved.add(key);},transaction:fn=>{
  const next=tail.then(async()=>{const draft=structuredClone(packed),before=packed.state.documents.map(d=>d.version).join();const result=await fn(draft);
   if(fail&&draft.state.documents.map(d=>d.version).join()!==before){fail=false;throw new Error('synthetic commit failure');}
   packed=draft;if(uncertain){uncertain=false;throw new Error('synthetic uncertain commit');}return result;
  });tail=next.then(()=>undefined,()=>undefined);return next;
 }};
 const client=new S3Client({region:'auto',endpoint:`https://${accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,
  credentials:{accessKeyId,secretAccessKey},maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
  requestHandler:{handle:async request=>{
   requests.push(request);const key=decodeURIComponent(request.path).slice(bucket.length+2);
   assert.equal(request.headers['x-amz-acl'],undefined,'R2 must never receive an ACL');
   if(request.method==='PUT'){
    assert.ok(reserved.has(key),'durable quarantine reservation must precede the object PUT');
    assert.equal(request.headers['if-none-match'],'*');
    if(objects.has(key))return {response:{statusCode:412,headers:{'content-type':'application/xml'},body:Readable.from(['<Error><Code>PreconditionFailed</Code></Error>'])}};
    objects.set(key,Buffer.from(request.body));return {response:{statusCode:200,headers:{etag:'"synthetic"'},body:Readable.from([])}};
   }
   assert.equal(request.method,'GET','no delete/list/provider mutation allowed');
   const bytes=objects.get(key);return {response:{statusCode:bytes?200:404,headers:{'content-length':String(bytes?.length??0)},body:Readable.from(bytes?[bytes]:[])}};
  }}});
 const r2=new R2Objects({accountId,bucket,accessKeyId,secretAccessKey,client});t.after(()=>r2.close());
 const store=new R2DocumentStore(snapshots,r2),authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic'}],principals:['alice','bob'].map(id=>({id,pbuuids:[]}))});
 for(const p of ['alice','bob'])await authz.grantMany(p,[{orgId:'org-a',role:'candidate',scope:'self'}]);
 const sessions={alice:randomBytes(32).toString('base64url'),bob:randomBytes(32).toString('base64url')};
 const ports={store,authz,sessions:{get:async id=>{const personId=Object.keys(sessions).find(p=>sessions[p]===id);return personId?{id,personId}:undefined;},put:async()=>{},delete:async()=>{}},origin,orgId:'org-a',signingKey:randomBytes(32),now:()=>now,
  directUploads:{authorize:async ticket=>{await snapshots.reserve(ticket.objectKey);return r2.authorize(ticket);},read:ticket=>r2.read(ticket)}};
 const service=createCandidateDocuments(ports),server=createGatewayServer(undefined,undefined,undefined,undefined,null,undefined,service);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const key=()=>createIdempotencyKey(new Date(now));
 async function req(path,body,{actor='alice',idempotency=key(),method='POST'}={}){const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{authorization:'Bearer '+sessions[actor],origin,'content-type':'application/json','idempotency-key':idempotency},body:method==='GET'?undefined:JSON.stringify(body)});const bytes=Buffer.from(await r.arrayBuffer());let json;try{json=JSON.parse(bytes);}catch{}return {status:r.status,body:json,bytes};}
 const authorize=(type,bytes,expectedVersion=null)=>req('/candidate-documents/uploads',{type,mime:type==='resume'?'application/pdf':'image/png',size:bytes.length,expectedVersion,sha256:hash(bytes),contentMd5:md5(bytes)});
 function upload(ticket,bytes,url=ticket.directUpload.url,headers=ticket.directUpload.headers){
  if(!accepts(url,headers,bytes,now))return 403;
  const key=decodeURIComponent(new URL(url).pathname).slice(bucket.length+2);
  if(objects.has(key))return 412;objects.set(key,Buffer.from(bytes));return 200;
 }
 return {req,authorize,upload,key,service,store,r2,objects,requests,reserved,sessions,ports,snapshot:()=>structuredClone(packed),fail:()=>fail=true,uncertain:()=>uncertain=true,advance:ms=>now+=ms};
}

test('SHU-145/R2-01 direct signatures bind one key, exact headers, one write and expiry',async t=>{
 const f=await fixture(t),bytes=png(),ticket=(await f.authorize('personal-photo',bytes)).body;
 assert.ok(ticket.directUpload,'configured R2 must return a direct PUT capability');
 const url=new URL(ticket.directUpload.url),signed=url.searchParams.get('X-Amz-SignedHeaders').split(';');
 for(const h of ['host','content-type','content-length','content-md5','if-none-match'])assert.ok(signed.includes(h),`signed ${h}`);
 assert.equal(url.searchParams.get('X-Amz-Expires'),'60');
 assert.equal(f.upload(ticket,bytes,ticket.directUpload.url.replace(ticket.uploadId,'1'.repeat(36))),403,'sibling key rejected by independent signature verifier');
 assert.equal(f.upload(ticket,bytes,undefined,{...ticket.directUpload.headers,'content-type':'text/html'}),403);
 assert.equal(f.upload(ticket,Buffer.concat([bytes,Buffer.from('x')])),403);
 assert.equal(f.upload(ticket,bytes),200);assert.equal(f.upload(ticket,bytes),412);
 f.advance(60000);assert.equal(f.upload(ticket,bytes),403);
 assert.equal((await f.req('/candidate-documents/finalize',{uploadId:ticket.uploadId})).status,403);
});

test('SHU-145/R2-02 all four slots finalize through real gateway, primitive and R2 transport',async t=>{
 const f=await fixture(t);
 for(const type of ['personal-photo','resume','civil-id-front','civil-id-back']){
  const bytes=type==='resume'?pdf():png(),a=await f.authorize(type,bytes);assert.equal(a.status,201);assert.equal(f.upload(a.body,bytes),200);
  assert.equal((await f.req('/candidate-documents/finalize',{uploadId:a.body.uploadId},{actor:'bob'})).status,403);
  const d=await f.req('/candidate-documents/finalize',{uploadId:a.body.uploadId});assert.equal(d.status,200,JSON.stringify(d.body));
  const link=(await f.req('/candidate-documents/delivery',{documentId:d.body.metadata.id})).body;
  const response=await f.req(link.url.slice(origin.length),undefined,{method:'GET'});assert.equal(response.status,200);assert.deepEqual(response.bytes,bytes);
 }
 const snapshot=f.snapshot();assert.equal(snapshot.state.documents.length,4);
 for(const row of snapshot.state.documents)assert.ok(row.data.startsWith('r2:'),'SQL must retain references, not bytes');
 for(const ticket of snapshot.state.lifecycle.uploads)assert.equal(ticket.data,undefined,'NC-DUPLICATE: R2 finalization must release the staged journal copy');
 assert.ok(!JSON.stringify(snapshot).includes(pdf().toString('base64')));
 assert.ok(f.requests.every(r=>['PUT','GET'].includes(r.method)));
});

test('SHU-145/R2-03 failed commit retains old bytes; new cloud objects stay quarantined on retry',async t=>{
 const f=await fixture(t),a=(await f.authorize('personal-photo',png())).body;f.upload(a,png());
 const old=(await f.req('/candidate-documents/finalize',{uploadId:a.uploadId})).body.metadata;
 const b=(await f.authorize('personal-photo',png(15),old.version)).body;f.upload(b,png(15));const before=f.snapshot(),count=f.objects.size,key=f.key();
 f.fail();assert.equal((await f.req('/candidate-documents/finalize',{uploadId:b.uploadId},{idempotency:key})).status,503);
 assert.deepEqual(f.snapshot(),before);assert.ok(f.objects.size>count,'new immutable bytes can exist after SQL rollback');
 assert.ok([...f.objects.keys()].every(k=>f.reserved.has(k)),'even rollback orphans have durable reservations');
 const link=(await f.req('/candidate-documents/delivery',{documentId:old.id})).body;assert.deepEqual((await f.req(link.url.slice(origin.length),undefined,{method:'GET'})).bytes,png());
 assert.equal((await f.req('/candidate-documents/finalize',{uploadId:b.uploadId},{idempotency:key})).status,200);
 assert.equal(f.snapshot().state.lifecycle.cleanup.length,1);assert.deepEqual(await f.service.cleanup(),{held:1,deleted:0});
});

test('SHU-145/R2-04 provider admission never substitutes for final content and digest validation',async t=>{
 const f=await fixture(t),bad=Buffer.from('89504e470d0a1a0a','hex');
 const a=(await f.authorize('personal-photo',bad)).body;assert.equal(f.upload(a,bad),200);
 assert.equal((await f.req('/candidate-documents/finalize',{uploadId:a.uploadId})).status,400);
 const b=(await f.authorize('personal-photo',png())).body;f.objects.set(b.objectKey,png(9));
 assert.equal((await f.req('/candidate-documents/finalize',{uploadId:b.uploadId})).status,400);
 assert.equal(f.snapshot().state.documents.length,0);
});

test('SHU-145/R2-05 uncertain metadata commit replays receipt without another cloud mutation',async t=>{
 const f=await fixture(t),a=(await f.authorize('personal-photo',png())).body;f.upload(a,png());const key=f.key();f.uncertain();
 assert.equal((await f.req('/candidate-documents/finalize',{uploadId:a.uploadId},{idempotency:key})).status,503);
 const count=f.objects.size;assert.equal((await f.req('/candidate-documents/finalize',{uploadId:a.uploadId},{idempotency:key})).status,200);
 assert.equal(f.objects.size,count);assert.equal(f.snapshot().state.lifecycle.audit.length,1);
});

test('SHU-145/R2-06 immutable collision and corrupted readback fail closed',async t=>{
 const f=await fixture(t),a=(await f.authorize('personal-photo',png())).body;f.upload(a,png());
 assert.equal((await f.req('/candidate-documents/finalize',{uploadId:a.uploadId})).status,200);
 const snapshot=f.snapshot(),ref=Object.values(snapshot.blobs)[0],bytes=f.objects.get(ref.key);
 await f.r2.writeImmutable(ref.key,bytes,'image/png');
 await assert.rejects(f.r2.writeImmutable(ref.key,png(4),'image/png'),{message:'unavailable'});
 f.objects.set(ref.key,png(4));assert.equal((await f.req('/candidate-documents',undefined,{method:'GET'})).status,503);
});

test('SHU-145/R2-07 complete R2 configuration constructs ports without contacting provider',async()=>{
 const env={DOCUMENT_STORAGE:'r2',DOCUMENT_ORG_ID:'org-a',DOCUMENT_ORIGIN:origin,DOCUMENT_SIGNING_KEY:randomBytes(32).toString('base64'),
  DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',OIDC_CALLBACK_URL:origin+'/login/callback',DOCUMENT_R2_ACCOUNT_ID:accountId,DOCUMENT_R2_BUCKET:bucket,
  DOCUMENT_R2_ACCESS_KEY_ID:accessKeyId,DOCUMENT_R2_SECRET_ACCESS_KEY:secretAccessKey};
 const runtime=await createRuntimeCandidateDocumentsFromEnv(env);assert.ok(runtime.service.options.directUploads);assert.ok(runtime.service.options.store instanceof R2DocumentStore);await runtime.close();
 await assert.rejects(createRuntimeCandidateDocumentsFromEnv({...env,DOCUMENT_ROOT:'/no-fallback'}),{message:'invalid candidate-document configuration'});
});
