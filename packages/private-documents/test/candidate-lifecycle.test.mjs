import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createGatewayServer} from '../../../dist/apps/gateway/src/index.js';
import {createCandidateDocuments,createRuntimeCandidateDocumentsFromEnv} from '../../../dist/apps/gateway/src/candidate-documents-runtime.js';
import {FileDocumentStore} from '../../../dist/packages/private-documents/src/index.js';
import {InMemoryAuthzStore} from '../../../dist/packages/contracts/src/index.js';
import {createIdempotencyKey} from '../../../dist/packages/idempotency-contract/src/index.js';

const origin='https://documents.example.test';
import {png,pdf} from './candidate-fixtures.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'shu145-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const disk=await FileDocumentStore.create(join(root,'private'));
 let failure=false,removeFailure=false,uncertain=false,now=1800000000000;
 const store={transaction:fn=>disk.transaction(async s=>{const versions=s.documents.map(d=>d.version).join();const count=s.documents.length;const value=await fn(s);if(removeFailure&&s.documents.length<count){removeFailure=false;throw new Error('synthetic failed removal commit');}if(failure&&s.documents.some(d=>!versions.split(',').includes(d.version))){failure=false;throw new Error('object-key signed-url storage sentinel');}return value;}).then(r=>{if(uncertain){uncertain=false;throw new Error('commit outcome unknown');}return r;})};
 const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic A'},{id:'org-b',name:'Synthetic B'}],principals:['alice','bob','employer'].map(id=>({id,pbuuids:[]}))});
 for(const id of ['alice','bob'])await authz.grantMany(id,[{orgId:'org-a',role:'candidate',scope:'self'}]);
 await authz.grantMany('employer',[{orgId:'org-a',role:'org-owner',scope:'self'}]);
 const tokens={alice:randomBytes(32).toString('base64url'),bob:randomBytes(32).toString('base64url'),employer:randomBytes(32).toString('base64url')};
 const sessions=new Map(Object.entries(tokens).map(([personId,id])=>[id,{id,personId}]));
 const ports={store,authz,sessions:{get:async id=>sessions.get(id),put:async s=>sessions.set(s.id,s),delete:async id=>sessions.delete(id)},origin,orgId:'org-a',signingKey:randomBytes(32),now:()=>now};
 const service=createCandidateDocuments(ports);const events=[];service.options.audit=e=>events.push(e);
 const server=createGatewayServer(undefined,undefined,undefined,undefined,null,undefined,service);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const url=`http://127.0.0.1:${server.address().port}`;
 const key=()=>createIdempotencyKey(new Date(now));
 async function request(path,{actor='alice',method='POST',body,headers={},idempotency=key()}={}){
  const response=await fetch(url+path,{method,headers:{...(tokens[actor]?{cookie:`__Host-studenthub_session=${tokens[actor]}`}:{ }),origin,'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json','idempotency-key':idempotency,...headers},body:method==='GET'?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const bytes=Buffer.from(await response.arrayBuffer());let value;try{value=JSON.parse(bytes.toString());}catch{value=undefined;}return {status:response.status,body:value,bytes,headers:response.headers};
 }
 async function authorize(type='personal-photo',bytes=png(),expectedVersion=null,extra={}){return request('/candidate-documents/uploads',{body:{type,mime:type==='resume'?'application/pdf':'image/png',size:bytes.length,expectedVersion},...extra});}
 async function put(ticket,bytes=png(),extra={}){return request(`/candidate-documents/uploads/${ticket.uploadId}/bytes`,{method:'PUT',body:bytes,headers:{'x-object-key':ticket.objectKey,'x-upload-credential':ticket.credential,...extra.headers},...Object.fromEntries(Object.entries(extra).filter(([k])=>k!=='headers'))});}
 async function upload(type='personal-photo',bytes=png(),expectedVersion=null){const a=await authorize(type,bytes,expectedVersion);assert.equal(a.status,201,JSON.stringify(a.body));assert.equal((await put(a.body,bytes)).status,204);return a.body;}
 async function finalize(ticket,extra={}){return request('/candidate-documents/finalize',{body:{uploadId:ticket.uploadId},...extra});}
 const state=()=>disk.transaction(async s=>structuredClone(s));
 return {root:join(root,'private'),request,authorize,put,upload,finalize,state,disk,store,service,events,tokens,sessions,authz,ports,key,advance:ms=>now+=ms,fail:()=>failure=true,failRemove:()=>removeFailure=true,uncertain:()=>uncertain=true};
}

test('SHU-145/AC-01 mounted authenticated lifecycle covers all four document slots',async t=>{
 const f=await fixture(t);
 for(const type of ['personal-photo','resume','civil-id-front','civil-id-back']){
  const bytes=type==='resume'?pdf():png();const ticket=await f.upload(type,bytes);const result=await f.finalize(ticket);assert.equal(result.status,200,JSON.stringify(result.body));
  const metadata=result.body.metadata;assert.deepEqual(Object.keys(metadata).sort(),['id','mime','size','type','version']);
  const link=await f.request('/candidate-documents/delivery',{body:{documentId:metadata.id}});assert.equal(link.status,200);
  const download=await f.request(link.body.url.slice(origin.length),{method:'GET'});assert.equal(download.status,200);assert.deepEqual(download.bytes,bytes);assert.equal(download.headers.get('content-disposition'),'attachment');
 }
 assert.equal((await f.request('/candidate-documents',{method:'GET'})).body.documents.length,4);
 const s=await f.state();assert.ok(s.documents.every(d=>d.acl==='private'));assert.equal(s.lifecycle.audit.length,13);assert.equal(s.lifecycle.audit.filter(a=>a.operation==='finalize').length,4);
});

test('SHU-145/AC-02 sibling-key upload is refused by the real handler',async t=>{
 const f=await fixture(t),ticket=(await f.authorize()).body;
 const r=await f.put(ticket,png(),{headers:{'x-object-key':`uploads/${randomUUID()}`}});
 assert.equal(r.status,403,'single-object credential must not upload a sibling key');
 assert.equal((await f.state()).lifecycle.uploads[0].data,undefined);
 assert.equal((await f.put(ticket)).status,204);
});

test('SHU-145/AC-03 expiring retrieval and upload reject at the exact boundary',async t=>{
 const f=await fixture(t),ticket=await f.upload(),d=(await f.finalize(ticket)).body.metadata;
 const link=(await f.request('/candidate-documents/delivery',{body:{documentId:d.id}})).body;
 const second=(await f.authorize('resume',pdf())).body;
 f.advance(60000);
 assert.equal((await f.request(link.url.slice(origin.length),{method:'GET'})).status,403,'expired retrieval must be refused');
 assert.equal((await f.put(second,pdf())).status,403,'expired upload must be refused');
 assert.equal((await f.finalize(second)).status,403);
});

test('SHU-145/AC-04 failed replacement commit preserves old reference and bytes',async t=>{
 const f=await fixture(t),first=await f.upload(),old=(await f.finalize(first)).body.metadata;
 const link=(await f.request('/candidate-documents/delivery',{body:{documentId:old.id}})).body;
 const next=await f.upload('personal-photo',png(10),old.version);const key=f.key();f.fail();
 const failed=await f.finalize(next,{idempotency:key});
 const s=await f.state();assert.deepEqual(s.documents.map(d=>d.version),[old.version],'commit failure preserves the old reference');
 assert.equal(s.retired.length,0);assert.equal(s.lifecycle.cleanup.length,0);assert.equal(failed.status,503);
 assert.deepEqual((await f.request(link.url.slice(origin.length),{method:'GET'})).bytes,png(),'commit failure preserves the old bytes');
 assert.equal((await f.finalize(next,{idempotency:key})).status,200);
});

test('SHU-145/AC-05 replacement and removal queue idempotent held cleanup',async t=>{
 const f=await fixture(t),first=await f.upload(),old=(await f.finalize(first)).body.metadata;
 const link=(await f.request('/candidate-documents/delivery',{body:{documentId:old.id}})).body;
 const ticket=await f.upload('personal-photo',png(12),old.version),key=f.key();const r=await f.finalize(ticket,{idempotency:key});
 assert.equal(r.status,200);assert.deepEqual(await f.finalize(ticket,{idempotency:key}).then(r=>r.body),r.body);
 assert.equal((await f.request(link.url.slice(origin.length),{method:'GET'})).status,403);
 const removeKey=f.key(),body={type:'personal-photo',expectedVersion:r.body.metadata.version};
 assert.equal((await f.request('/candidate-documents/remove',{body,idempotency:removeKey})).status,200);
 assert.equal((await f.request('/candidate-documents/remove',{body,idempotency:removeKey})).status,200);
 for(let i=0;i<3;i++)assert.deepEqual(await f.service.cleanup(),{held:2,deleted:0});
 const s=await f.state();assert.equal(s.documents.length,0);assert.equal(s.retired.length,2);assert.equal(s.lifecycle.cleanup.length,2);assert.equal(s.lifecycle.audit.length,4);assert.equal(s.lifecycle.audit.filter(a=>['finalize','remove'].includes(a.operation)).length,3);
 assert.ok(s.lifecycle.cleanup.every(c=>c.status==='held')); // Includes unresolved policy and every possible legal hold: no purge authority.
});

test('SHU-145/NC-AUTH anonymous, forged principal, employer and cross-person are refused',async t=>{
 const f=await fixture(t),ticket=await f.upload();
 for(const actor of ['anonymous','employer']){
  assert.equal((await f.authorize('personal-photo',png(),null,{actor})).status,403);
  assert.equal((await f.put(ticket,png(),{actor})).status,403);
  assert.equal((await f.finalize(ticket,{actor})).status,403);
 }
 assert.equal((await f.put(ticket,png(),{actor:'bob'})).status,403);
 assert.equal((await f.finalize(ticket,{actor:'bob'})).status,403);
 const d=(await f.finalize(ticket)).body.metadata;
 assert.equal((await f.request('/candidate-documents/delivery',{actor:'bob',body:{documentId:d.id}})).status,403);
 for(const field of ['personId','orgId','objectKey','acl'])assert.equal((await f.request('/candidate-documents/uploads',{body:{type:'resume',mime:'application/pdf',size:pdf().length,expectedVersion:null,[field]:'alice'}})).status,400);
 assert.equal((await f.request('/candidate-documents/finalize',{body:{uploadId:ticket.uploadId,objectKey:ticket.objectKey}})).status,400);
 assert.equal((await f.request('/candidate-documents/remove',{actor:'bob',body:{type:'personal-photo',expectedVersion:d.version}})).status,409);
 const link=(await f.request('/candidate-documents/delivery',{body:{documentId:d.id}})).body;
 assert.equal((await f.request(link.url.slice(origin.length),{actor:'bob',method:'GET'})).status,403);
 f.sessions.delete(f.tokens.alice);
 assert.equal((await f.request(link.url.slice(origin.length),{method:'GET'})).status,403);
});

test('SHU-145/NC-CONTENT size, declared MIME, truncated and malformed bodies fail server validation',async t=>{
 const f=await fixture(t);
 for(const bytes of [Buffer.from('89504e470d0a1a0a','hex'),Buffer.concat([png(),Buffer.from('hidden')]),Buffer.from('<script>x</script>'),Buffer.alloc(0)]){
  const a=await f.authorize('personal-photo',bytes);
  if(!bytes.length){assert.equal(a.status,400);continue;}
  assert.equal((await f.put(a.body,bytes)).status,400);
 }
 const ticket=(await f.authorize()).body;
 assert.equal((await f.put(ticket,Buffer.concat([png(),Buffer.from('x')]))).status,400);
 const corrupt=png();corrupt[29]^=1;assert.equal((await f.put(ticket,corrupt)).status,400);
 const truncated=Buffer.from('%PDF-1.7\n%%EOF');const resume=(await f.authorize('resume',truncated)).body;assert.equal((await f.put(resume,truncated)).status,400);
 assert.equal((await f.request('/candidate-documents/uploads',{body:{type:'resume',mime:'text/html',size:100,expectedVersion:null}})).status,400);
 assert.equal((await f.request('/candidate-documents/uploads',{body:{type:'personal-photo',mime:'image/png',size:10*1024*1024+1,expectedVersion:null}})).status,400);
 assert.equal((await f.state()).documents.length,0);
});

test('SHU-145/NC-RETRY receipts bind payload, survive uncertain commit and restart',async t=>{
 const f=await fixture(t),key=f.key();const a=await f.authorize('personal-photo',png(),null,{idempotency:key});
 assert.deepEqual((await f.authorize('personal-photo',png(),null,{idempotency:key})).body,a.body);
 assert.equal((await f.authorize('resume',pdf(),null,{idempotency:key})).status,409);
 assert.equal((await f.put(a.body)).status,204);
 const finalKey=f.key();f.uncertain();assert.equal((await f.finalize(a.body,{idempotency:finalKey})).status,503);
 const retried=await f.finalize(a.body,{idempotency:finalKey});assert.equal(retried.status,200);
 const reopened=createCandidateDocuments({...f.ports,store:f.disk});f.advance(61000);
 assert.deepEqual(await reopened.finalize(f.tokens.alice,finalKey,{uploadId:a.body.uploadId}),{status:200,body:retried.body});
 assert.equal((await f.state()).documents.length,1);assert.equal((await f.state()).lifecycle.audit.length,1);
 assert.equal((await f.authorize('resume',pdf(),null,{idempotency:''})).status,400);
 f.advance(7*24*3600000);assert.equal((await f.finalize(a.body,{idempotency:finalKey})).status,409);
});

test('SHU-145/NC-CONCURRENT competing replacements cannot overwrite a newer version',async t=>{
 const f=await fixture(t),old=(await f.finalize(await f.upload())).body.metadata;
 const a=await f.upload('personal-photo',png(30),old.version),b=await f.upload('personal-photo',png(60),old.version);
 const results=await Promise.all([f.finalize(a),f.finalize(b)]);assert.equal(results.filter(r=>r.status===200).length,1);
 assert.ok(results.every(r=>[200,409,503].includes(r.status)));
 assert.equal((await f.finalize(results[0].status===200?b:a)).status,409);
 const s=await f.state();assert.equal(s.documents.length,1);assert.equal(s.retired.length,1);assert.equal(s.lifecycle.cleanup.length,1);
});

test('SHU-145/NC-FINALIZE staged mutation, arbitrary objects and second finalization are refused',async t=>{
 const f=await fixture(t),ticket=await f.upload();
 assert.equal((await f.finalize({uploadId:randomUUID()})).status,403);
 await f.disk.transaction(async s=>{s.lifecycle.uploads[0].data=png(8).toString('base64');});
 assert.equal((await f.finalize(ticket)).status,400);
 await f.disk.transaction(async s=>{s.lifecycle.uploads[0].data=png().toString('base64');});
 assert.equal((await f.finalize(ticket)).status,200);assert.equal((await f.finalize(ticket)).status,409);
});

test('SHU-145/NC-LOGS errors and audit stay whitelisted; sink failure cannot change commits',async t=>{
 const f=await fixture(t),ticket=await f.upload();
 const r=await f.put(ticket,png(),{headers:{'x-object-key':'uploads/secret-sentinel'}});assert.equal(r.status,403);
 assert.deepEqual(r.body,{error:'denied'});
 assert.ok(f.events.every(e=>Object.keys(e).sort().join()==='code,operation'));
 assert.ok(!JSON.stringify(f.events).includes(ticket.objectKey));assert.ok(!JSON.stringify(f.events).includes(ticket.credential));
 f.service.options.audit=async()=>{throw new Error(ticket.credential);};
 assert.equal((await f.finalize(ticket)).status,200);
 await new Promise(r=>setImmediate(r));
});

test('SHU-145/NC-HTTP rejects CSRF, unsigned delivery, arbitrary route and unconfigured storage',async t=>{
 const f=await fixture(t);
 assert.equal((await f.authorize('personal-photo',png(),null,{headers:{origin:'https://evil.example.test'}})).status,403);
 assert.equal((await f.request('/private-documents/delivery',{method:'GET'})).status,404);
 assert.equal((await f.request('/candidate-documents/objects/guess',{method:'GET'})).status,404);
 assert.equal((await f.request('/candidate-documents/uploads',{body:'not-json-object'})).status,400);
 assert.equal(await createRuntimeCandidateDocumentsFromEnv({}),undefined);
 for(const env of [{DOCUMENT_STORAGE:'r2'},{DOCUMENT_STORAGE:'synthetic-file',DOCUMENT_ROOT:'key-sentinel'}])await assert.rejects(createRuntimeCandidateDocumentsFromEnv(env),{message:'invalid candidate-document configuration'});
 const server=createGatewayServer(undefined,undefined,undefined,undefined,null);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/candidate-documents`)).status,503);
});


test('SHU-145/NC-REVOKED revoked grants deny receipt replay and delivery',async t=>{
 const f=await fixture(t),key=f.key(),ticket=await f.upload();
 const first=await f.finalize(ticket,{idempotency:key});assert.equal(first.status,200);
 const link=(await f.request('/candidate-documents/delivery',{body:{documentId:first.body.metadata.id}})).body;
 await f.authz.revokeMany('alice',[{orgId:'org-a',role:'candidate'}]);
 assert.equal((await f.finalize(ticket,{idempotency:key})).status,403);
 assert.equal((await f.request(link.url.slice(origin.length),{method:'GET'})).status,403);
 assert.equal((await f.request('/candidate-documents',{method:'GET'})).status,403);
});

test('SHU-145/NC-UPLOAD-REPLAY credential expiration also applies to transport retries',async t=>{
 const f=await fixture(t),ticket=(await f.authorize()).body,key=f.key();
 assert.equal((await f.put(ticket,png(),{idempotency:key})).status,204);
 assert.equal((await f.put(ticket,png(),{idempotency:key})).status,204);
 assert.equal((await f.put(ticket,png(),{headers:{'x-upload-credential':'forged'}})).status,403);
 f.advance(60000);
 assert.equal((await f.put(ticket,png(),{idempotency:key})).status,403);
});

test('SHU-145/NC-BODY oversized bytes are refused independently of authorized size',async t=>{
 const f=await fixture(t),ticket=(await f.authorize()).body;
 assert.equal((await f.put(ticket,Buffer.alloc(10*1024*1024+1))).status,413);
 assert.equal((await f.state()).lifecycle.uploads[0].data,undefined);
 assert.equal((await f.put(ticket)).status,204);
});


test('SHU-145/NC-REMOVE-COMMIT failed removal preserves active bytes and atomic audit',async t=>{
 const f=await fixture(t),d=(await f.finalize(await f.upload())).body.metadata;
 const before=await f.state(),key=f.key(),body={type:'personal-photo',expectedVersion:d.version};
 f.failRemove();assert.equal((await f.request('/candidate-documents/remove',{body,idempotency:key})).status,503);
 assert.deepEqual(await f.state(),before);
 assert.equal((await f.request('/candidate-documents/remove',{body,idempotency:key})).status,200);
 const after=await f.state();assert.equal(after.documents.length,0);assert.equal(after.lifecycle.cleanup.length,1);assert.equal(after.lifecycle.audit.length,2);
});


test('SHU-145/NC-ORG-RETRY same key cannot replay authorization from another organization',async t=>{
 const f=await fixture(t),key=f.key(),input={type:'personal-photo',mime:'image/png',size:png().length,expectedVersion:null};
 assert.equal((await f.request('/candidate-documents/uploads',{body:input,idempotency:key})).status,201);
 await f.authz.grantMany('alice',[{orgId:'org-b',role:'candidate',scope:'self'}]);
 const other=createCandidateDocuments({...f.ports,orgId:'org-b'});
 await assert.rejects(other.authorizeUpload(f.tokens.alice,key,input),e=>e.status===409);
 assert.equal((await f.state()).lifecycle.uploads.length,1);
});


test('SHU-145/AC-RUNTIME complete synthetic configuration constructs actual gateway storage dependencies',async t=>{
 const f=await fixture(t);
 const env={DOCUMENT_STORAGE:'synthetic-file',DOCUMENT_ROOT:f.root,DOCUMENT_ORG_ID:'org-a',DOCUMENT_ORIGIN:origin,
 DOCUMENT_SIGNING_KEY:randomBytes(32).toString('base64'),DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',OIDC_CALLBACK_URL:origin+'/login/callback'};
 const runtime=await createRuntimeCandidateDocumentsFromEnv(env);
 assert.ok(runtime?.service);assert.equal(runtime.service.options.orgId,'org-a');
 await runtime.close();
 await assert.rejects(createRuntimeCandidateDocumentsFromEnv({...env,DOCUMENT_ORIGIN:'https://wrong.example.test'}),{message:'invalid candidate-document configuration'});
 await assert.rejects(createRuntimeCandidateDocumentsFromEnv({...env,DOCUMENT_SIGNING_KEY:'secret-invalid'}),{message:'invalid candidate-document configuration'});
});

test('SHU-145/NC-DELIVERY-SCOPE configured route refuses other-org and non-S4 records',async t=>{
 const f=await fixture(t);
 await f.authz.grantMany('alice',[{orgId:'org-b',role:'candidate',scope:'self'},{orgId:'org-a',role:'org-owner',scope:'self'}]);
 for(const scopeType of [{scope:{orgId:'org-b',personId:'alice'},type:'personal-photo'},{scope:{orgId:'org-a'},type:'company-logo'}]){
  const d=await f.service.primitive.upload(f.tokens.alice,{...scopeType,mime:'image/png',bytes:png()});
  const link=await f.service.primitive.issueDelivery(f.tokens.alice,d.id);
  assert.equal((await f.request('/candidate-documents/delivery',{body:{documentId:d.id}})).status,403);
  assert.equal((await f.request(link.url.slice(origin.length),{method:'GET'})).status,403);
 }
});

test('SHU-145/NC-PRIMITIVE-AUDIT async audit rejection cannot break primitive delivery',async t=>{
 const f=await fixture(t),d=(await f.finalize(await f.upload())).body.metadata;
 f.service.options.audit=async()=>{throw new Error('upload-credential-sentinel');};
 const link=await f.service.primitive.issueDelivery(f.tokens.alice,d.id);
 assert.deepEqual((await f.service.primitive.deliver(f.tokens.alice,link.url)).bytes,png());
 await new Promise(r=>setImmediate(r));
});

test('SHU-145/NC-RETENTION staged bodies remain held across expiry and removal',async t=>{
 const f=await fixture(t),ticket=await f.upload('civil-id-front');
 await f.upload('resume',pdf());await f.upload('civil-id-back');await f.authorize();
 assert.deepEqual(await f.service.cleanup(),{held:3,deleted:0},'NC-RETENTION: cleanup must count every staged body plus retired copies');
 const finalized=await f.finalize(ticket);assert.equal(finalized.status,200);
 const d=finalized.body.metadata;
 assert.deepEqual(await f.service.cleanup(),{held:2,deleted:0},'NC-RETENTION: successful finalize must preserve sibling staged bodies');
 f.advance(60001);
 assert.equal((await f.request('/candidate-documents/remove',{body:{type:'civil-id-front',expectedVersion:d.version}})).status,200);
 const before=await f.state();
 for(let i=0;i<3;i++)assert.deepEqual(await f.service.cleanup(),{held:3,deleted:0},'NC-RETENTION: cleanup must count every staged body plus retired copies');
 assert.deepEqual(await f.state(),before,'NC-RETENTION: inspection must preserve all retained bytes');
 assert.deepEqual(before.lifecycle.uploads.filter(t=>t.data!==undefined).map(t=>Buffer.from(t.data,'base64')),[pdf(),png()]);
 // Existing journals may contain committed duplicates. Count them without purging.
 await f.disk.transaction(async s=>{const t=s.lifecycle.uploads[0];t.data=s.retired[0].data;t.digest=createHash('sha256').update(Buffer.from(t.data,'base64')).digest('hex');});
 assert.deepEqual(await f.service.cleanup(),{held:4,deleted:0},'NC-RETENTION: legacy committed staged copies must also count');
});

test('SHU-145/NC-DUPLICATE finalize releases only the superseded staged journal copy',async t=>{
 const f=await fixture(t),ticket=await f.upload(),key=f.key();f.fail();
 assert.equal((await f.finalize(ticket,{idempotency:key})).status,503);
 assert.equal((await f.state()).lifecycle.uploads[0].data,png().toString('base64'),'NC-DUPLICATE: failed finalization must retain staged bytes');
 assert.equal((await f.finalize(ticket,{idempotency:key})).status,200);
 const s=await f.state();
 assert.equal(s.lifecycle.uploads[0].data,undefined,'NC-DUPLICATE: successful finalize must release the superseded staged body');
 assert.equal(s.lifecycle.uploads[0].digest,undefined);
 assert.equal(s.lifecycle.uploads[0].committed,true);
 assert.equal(s.documents[0].data,png().toString('base64'));
 assert.equal((await f.finalize(ticket,{idempotency:key})).status,200);
 assert.deepEqual(await f.service.cleanup(),{held:0,deleted:0});
});

test('SHU-145/NC-READ-AUDIT civil ID issuance redemption and list commit durable audit',async t=>{
 const f=await fixture(t),d=(await f.finalize(await f.upload('civil-id-front'))).body.metadata;
 const before=(await f.state()).lifecycle.audit.length;
 const link=await f.request('/candidate-documents/delivery',{body:{documentId:d.id}});assert.equal(link.status,200);
 assert.equal((await f.request(link.body.url.slice(origin.length),{method:'GET'})).status,200);
 assert.equal((await f.request('/candidate-documents',{method:'GET'})).status,200);
 const rows=(await f.state()).lifecycle.audit.slice(before);
 assert.deepEqual(rows.map(r=>r.operation),['issueDelivery','deliver','list'],'NC-READ-AUDIT: successful private reads must commit durable audit rows');
 for(const row of rows){assert.deepEqual(Object.keys(row).sort(),['at','id','operation','principalRef']);assert.match(row.principalRef,/^[0-9a-f]{64}$/);}
 assert.equal(new Set(rows.map(r=>r.id)).size,3);
 assert.equal((await f.request(link.body.url.slice(origin.length),{actor:'bob',method:'GET'})).status,403);
 assert.equal((await f.state()).lifecycle.audit.length,before+3);
 // Reopen the file store: an in-memory callback alone is insufficient evidence.
 const reopened=await FileDocumentStore.open(f.root);
 assert.deepEqual(await reopened.transaction(async s=>s.lifecycle.audit.slice(before)),rows);
 const original=f.service.options.store;
 f.service.options.store={transaction:fn=>original.transaction(async s=>{await fn(s);throw new Error('audit commit failed');})};
 assert.equal((await f.request('/candidate-documents/delivery',{body:{documentId:d.id}})).status,503);
 assert.equal((await f.request(link.body.url.slice(origin.length),{method:'GET'})).status,503);
 assert.equal((await f.request('/candidate-documents',{method:'GET'})).status,503);
 f.service.options.store=original;
 assert.equal((await f.state()).lifecycle.audit.length,before+3);
});

test('SHU-145/NC-EMPTY-LIST-AUDIT empty list commits durable audit',async t=>{
 const f=await fixture(t);
 const result=await f.request('/candidate-documents',{method:'GET'});
 assert.equal(result.status,200);assert.deepEqual(result.body,{documents:[]});
 const reopened=await FileDocumentStore.open(f.root);
 const rows=await reopened.transaction(async s=>s.lifecycle?.audit ?? []);
 assert.deepEqual(rows.map(r=>r.operation),['list'],'NC-EMPTY-LIST-AUDIT: successful empty list must commit a durable audit row');
 assert.deepEqual(Object.keys(rows[0]).sort(),['at','id','operation','principalRef']);
 assert.equal(rows[0].principalRef,createHash('sha256').update('alice').digest('hex'));
});

test('SHU-145/NC-MULTIBYTE wrong upload credential is a denial',async t=>{
 const f=await fixture(t),ticket=(await f.authorize()).body;
 for(const credential of ['é'.repeat(ticket.credential.length),'x'.repeat(ticket.credential.length),'forged']){
  const r=await f.put(ticket,png(),{headers:{'x-upload-credential':credential}});
  assert.equal(r.status,403,'NC-MULTIBYTE: wrong upload credential must return 403, never 503');
  assert.equal((await f.state()).lifecycle.uploads[0].data,undefined);
 }
 assert.equal((await f.put(ticket)).status,204);
});
