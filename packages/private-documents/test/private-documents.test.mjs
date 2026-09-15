import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const { PrivateDocuments, FileDocumentStore } = await import(process.env.SHU101_TEST_MODULE ?? '../../../dist/packages/private-documents/src/index.js');
import { InMemoryAuthzStore } from '../../../dist/packages/contracts/src/index.js';
const person = { orgId: 'org-a', personId: 'alice' };
const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC ONLY\n%%EOF');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const video = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
const input = (extra={}) => ({ scope: person, type: 'resume', mime: 'application/pdf', bytes: pdf, ...extra });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shu101-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'private');
  const store = await FileDocumentStore.create(root);
  const authz = new InMemoryAuthzStore({organizations: [{id:'org-a',name:'A'}, {id:'org-b',name:'B'}], principals: ['alice','bob','owner','recruiter'].map(id=>({id,pbuuids:[]}))});
  for (const id of ['alice','bob']) await authz.grantMany(id,[{orgId:'org-a',role:'candidate',scope:'self'}]);
  await authz.grantMany('owner',[{orgId:'org-a',role:'org-owner',scope:'self'}]);
  await authz.grantMany('recruiter',[{orgId:'org-a',role:'recruiter',scope:'self'}]);
  let now = 1_800_000_000_000;
  const events = [];
  const options = {store, authz, authenticate: async credential => ['alice','bob','owner','recruiter'].includes(credential) ? {kind:'principal',principalId:credential} : null, signingKey: randomBytes(32), origin:'https://documents.example.test', now:()=>now, audit:event=>events.push(event)};
  const service = new PrivateDocuments(options);
  return {service,store,root,options,authz,events,advance:ms=>{now+=ms;}};
}
const rejects = (promise, code='denied') => assert.rejects(promise, e => e.message === code && e.code === code && e.cause === undefined);

test('AC01 all required document types upload private, scoped metadata and authenticated signed delivery', async t=>{
 const f=await fixture(t);
 for(const type of ['resume','personal-photo','civil-id-front','civil-id-back','video','video-thumbnail','company-logo','commercial-licence']) {
  const org=type.startsWith('company')||type==='commercial-licence';
  const mime=type==='video'?'video/mp4':type==='resume'||type==='commercial-licence'?'application/pdf':'image/png';
  const bytes=mime==='video/mp4'?video:mime==='image/png'?png:pdf;
  const actor=org?'owner':'alice'; const scope=org?{orgId:'org-a'}:person;
  const d=await f.service.upload(actor,input({type,mime,bytes,scope}));
  assert.deepEqual(Object.keys(d).sort(),['id','mime','size','type','version']);
  assert.equal(d.size,bytes.length);
  assert.deepEqual(await f.service.metadata(actor,d.id),d);
  const link=await f.service.issueDelivery(actor,d.id,60);
  assert.equal(link.expiresAt,1_800_000_060_000);
  const response=await f.service.deliver(actor,link.url);
  assert.deepEqual(response.bytes,bytes);
  assert.equal(response.headers['Cache-Control'],'private, no-store');
  assert.equal(response.headers['Content-Disposition'],'attachment');
  assert.equal(response.headers['X-Content-Type-Options'],'nosniff');
 }
});

test('NC-AUTH unauthorized, cross-person, cross-org and forged identity denied on every operation',async t=>{
 const {service:s}=await fixture(t); const d=await s.upload('alice',input()); const link=await s.issueDelivery('alice',d.id);
 for(const actor of ['', 'unknown', 'bob','owner','recruiter', {principalId:'alice'}]) {
  await rejects(s.metadata(actor,d.id)); await rejects(s.issueDelivery(actor,d.id));
  await rejects(s.deliver(actor,link.url)); await rejects(s.replace(actor,d.id,input()));
  await rejects(s.remove(actor,d.id)); await rejects(s.copy(actor,d.id,person));
 }
 await rejects(s.upload('alice',input({scope:{orgId:'org-b',personId:'alice'}})));
 await rejects(s.upload('alice',input({scope:{orgId:'org-a',personId:'bob'}})));
 await rejects(s.copy('alice',d.id,{orgId:'org-b',personId:'alice'}));
 await rejects(s.copy('alice',d.id,{orgId:'org-a',personId:'bob'}));
 assert.deepEqual((await s.deliver('alice',link.url)).bytes,pdf);
});

test('NC-ORG org-owner access remains scoped; recruiter and candidate cannot access org documents',async t=>{
 const {service:s}=await fixture(t); const d=await s.upload('owner',input({scope:{orgId:'org-a'},type:'commercial-licence'}));
 for(const actor of ['recruiter','alice','bob']) {await rejects(s.metadata(actor,d.id));await rejects(s.upload(actor,input({scope:{orgId:'org-a'},type:'commercial-licence'})));}
 await rejects(s.upload('owner',input({scope:{orgId:'org-b'},type:'commercial-licence'})));
});

test('NC-PUBLIC public ACL on upload/copy is rejected, private is the only accepted ACL',async t=>{
 const {service:s,root}=await fixture(t); const d=await s.upload('alice',input());
 for(const acl of ['public-read','public-read-write','authenticated-read',null]) {
  await rejects(s.upload('alice',input({acl})),'invalid');
  await rejects(s.copy('alice',d.id,person,{acl}),'invalid');
 }
 const copy=await s.copy('alice',d.id,person,{acl:'private'});
 assert.notEqual(copy.id,d.id);
 assert.deepEqual((await s.deliver('alice',(await s.issueDelivery('alice',copy.id)).url)).bytes,pdf);
 const state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
 assert.ok(state.documents.every(d=>d.acl==='private'));
});

test('NC-UNSIGNED unsigned, tampered, wrong origin, extra parameter and guessed-key delivery denied',async t=>{
 const {service:s}=await fixture(t); const d=await s.upload('alice',input());const {url}=await s.issueDelivery('alice',d.id);
 for(const bad of ['https://documents.example.test/'+d.id, url.split('?')[0],url+'&extra=1',url.replace('documents.example.test','evil.example.test'),url.slice(0,-1)+'!',url.replace('/private-documents/','/objects/')]) await rejects(s.deliver('alice',bad));
 for(const id of ['../../etc/passwd','candidate-resume/guess.pdf','00000000-0000-4000-8000-000000000000']) {await rejects(s.metadata('alice',id));await rejects(s.issueDelivery('alice',id));}
});

test('NC-EXPIRY exact TTL boundary, excessive/nonfinite TTL and stale grants deny',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());
 for(const ttl of [0,-1,301,Infinity,NaN,1.5,'60']) await rejects(f.service.issueDelivery('alice',d.id,ttl),'invalid');
 const link=await f.service.issueDelivery('alice',d.id,1); f.advance(1000);await rejects(f.service.deliver('alice',link.url));
 const fresh=await f.service.issueDelivery('alice',d.id);await f.authz.clearGrantsForPrincipal('alice');
 await rejects(f.service.deliver('alice',fresh.url));await rejects(f.service.metadata('alice',d.id));
});

test('AC-REPLACE old links revoked atomically; rejected replacement preserves original; delete revokes metadata/copy/delivery',async t=>{
 const {service:s}=await fixture(t);const d=await s.upload('alice',input());const old=await s.issueDelivery('alice',d.id);
 await rejects(s.replace('alice',d.id,input({bytes:Buffer.from('bad')})),'invalid');
 assert.deepEqual((await s.deliver('alice',old.url)).bytes,pdf);
 const replacement=await s.replace('alice',d.id,input({bytes:Buffer.concat([pdf,Buffer.from('NEW')])}));assert.notEqual(replacement.version,d.version);
 await rejects(s.deliver('alice',old.url));const fresh=await s.issueDelivery('alice',d.id);
 await s.remove('alice',d.id);await rejects(s.deliver('alice',fresh.url));await rejects(s.metadata('alice',d.id));await rejects(s.copy('alice',d.id,person));
});

test('NC-UPLOAD invalid MIME/signature/type/size and unsafe override fields rejected with no persistence',async t=>{
 const {service:s,root}=await fixture(t);
 for(const extra of [{bytes:Buffer.alloc(0)},{bytes:Buffer.alloc(10*1024*1024+1)},{mime:'text/html'},{bytes:Buffer.from('<script>bad</script>')},{type:'unknown'},{key:'chosen'},{url:'https://evil.test'},{filename:'../../secret'},{scope:{...person,role:'admin'}},{type:'company-logo',mime:'image/png',bytes:png}]) await rejects(s.upload('alice',input(extra)),'invalid');
 assert.equal(JSON.parse(await readFile(join(root,'state.json'),'utf8')).documents.length,0);
});

test('NC-FAILURE storage/auth failures and audit exceptions expose only stable codes, no raw secrets',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());
 const secret='OBJECT-KEY SECRET-CONTENTS https://bucket.test/key?X-Amz-Signature=SECRET';
 const s=new PrivateDocuments({...f.options,store:{transaction:async()=>{throw Error(secret);}}});
 await rejects(s.metadata('alice',d.id),'unavailable');await rejects(s.upload('alice',input()),'unavailable');
 const auth=new PrivateDocuments({...f.options,authenticate:async()=>{throw Error(secret);}});await rejects(auth.metadata('alice',d.id),'unavailable');
 const logging=new PrivateDocuments({...f.options,audit:()=>{throw Error(secret);}});await logging.metadata('alice',d.id);
 for(const event of f.events) assert.deepEqual(Object.keys(event).sort(),['code','operation']);
 assert.ok(!JSON.stringify(f.events).includes(secret));
});

test('AC-DURABLE restart preserves bytes; concurrent instances cannot overwrite and filesystem is private',async t=>{
 const f=await fixture(t); const d=await f.service.upload('alice',input());
 const other=new PrivateDocuments({...f.options,store:await FileDocumentStore.open(f.root)});
 assert.deepEqual(await other.metadata('alice',d.id),d);
 const {stat}=await import('node:fs/promises');assert.equal((await stat(f.root)).mode&0o777,0o700);assert.equal((await stat(join(f.root,'state.json'))).mode&0o777,0o600);
 let release; const gate=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);
 const held=f.store.transaction(async()=>{entered();await gate;});await ready;
 await rejects(other.upload('alice',input()),'unavailable');release();await held;
 assert.deepEqual(await other.metadata('alice',d.id),d);
});

test('NC-COMMIT failed metadata commit preserves old reference and old delivery; cleanup is retained separately',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());const link=await f.service.issueDelivery('alice',d.id);
 const s=new PrivateDocuments({...f.options,store:{transaction:fn=>f.store.transaction(async state=>{await fn(state);throw Error('commit unavailable');})}});
 await rejects(s.replace('alice',d.id,input()),'unavailable');await rejects(s.remove('alice',d.id),'unavailable');
 assert.deepEqual((await f.service.deliver('alice',link.url)).bytes,pdf);
 await f.service.replace('alice',d.id,input());await f.service.remove('alice',d.id);
 const state=JSON.parse(await readFile(join(f.root,'state.json'),'utf8'));assert.equal(state.retired.length,2);assert.equal(state.documents.length,0);
});

test('NC-FS permissive state, missing state and symlink state fail closed',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());
 await chmod(join(f.root,'state.json'),0o644);await rejects(f.service.metadata('alice',d.id),'unavailable');
 await chmod(join(f.root,'state.json'),0o600);await rm(join(f.root,'state.json'));
 await rejects(f.service.metadata('alice',d.id),'unavailable');assert.ok(!(await readdir(f.root)).includes('.lock'));
 const {symlink}=await import('node:fs/promises');await symlink('/etc/passwd',join(f.root,'state.json'));await rejects(f.service.metadata('alice',d.id),'unavailable');
});

test('NC-SIGNATURE forged signature on a valid payload is denied',async t=>{
 const {service:s}=await fixture(t);const d=await s.upload('alice',input());const {url}=await s.issueDelivery('alice',d.id);
 const forged=url.slice(0,url.lastIndexOf('.')+1)+'A'.repeat(43);await rejects(s.deliver('alice',forged));
});

test('NC-SUBJECT even another authorized org owner must obtain their own delivery link',async t=>{
 const f=await fixture(t);await f.authz.grantMany('bob',[{orgId:'org-a',role:'org-owner',scope:'self'}]);
 const d=await f.service.upload('owner',input({scope:{orgId:'org-a'},type:'commercial-licence'}));
 assert.deepEqual(await f.service.metadata('bob',d.id),d);
 const link=await f.service.issueDelivery('owner',d.id);await rejects(f.service.deliver('bob',link.url));
 const own=await f.service.issueDelivery('bob',d.id);assert.deepEqual((await f.service.deliver('bob',own.url)).bytes,pdf);
});

test('NC-CROSSORG metadata and delivery reread the document organization grants',async t=>{
 const f=await fixture(t);await f.authz.grantMany('alice',[{orgId:'org-b',role:'candidate',scope:'self'}]);
 const d=await f.service.upload('alice',input({scope:{orgId:'org-b',personId:'alice'}}));const link=await f.service.issueDelivery('alice',d.id);
 await f.authz.revokeMany('alice',[{orgId:'org-b',role:'candidate'}]);
 await rejects(f.service.metadata('alice',d.id));await rejects(f.service.deliver('alice',link.url));
});

test('NC-REVOKE grants revoked after issuance deny authenticated delivery',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());const link=await f.service.issueDelivery('alice',d.id);
 await f.authz.clearGrantsForPrincipal('alice');await rejects(f.service.deliver('alice',link.url));
});

test('NC-STORE public object returned by a faulty storage adapter is never delivered or copied',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());const link=await f.service.issueDelivery('alice',d.id);
 const {writeFile}=await import('node:fs/promises');const path=join(f.root,'state.json');const state=JSON.parse(await readFile(path,'utf8'));state.documents[0].acl='public-read';await writeFile(path,JSON.stringify(state));
 await rejects(f.service.metadata('alice',d.id),'unavailable');await rejects(f.service.deliver('alice',link.url),'unavailable');await rejects(f.service.copy('alice',d.id,person),'unavailable');
});

test('NC-LOGS caller tokens, contents and URLs never enter success/failure audit or metadata',async t=>{
 const f=await fixture(t);const d=await f.service.upload('alice',input());const link=await f.service.issueDelivery('alice',d.id);await f.service.deliver('alice',link.url);await rejects(f.service.metadata('alice','SENSITIVE-KEY'));
 const forbidden=[pdf.toString(),pdf.toString('base64'),'SENSITIVE-KEY',link.url,d.id,'alice','org-a'];
 for(const secret of forbidden) assert.ok(!JSON.stringify(f.events).includes(secret));
 for(const e of f.events) {assert.deepEqual(Object.keys(e).sort(),['code','operation']);assert.ok(['ok','denied','invalid','unavailable'].includes(e.code));}
 assert.deepEqual(Object.keys(d).sort(),['id','mime','size','type','version']);
});

test('AC-HTTP real delivery handler enforces authenticated GET, expiry and safe response headers',async t=>{
 const f=await fixture(t);const {createServer}=await import('node:http');
 assert.equal(typeof f.service.handleDelivery,'function');
 const server=createServer((req,res)=>void f.service.handleDelivery(req,res));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const d=await f.service.upload('alice',input());const link=await f.service.issueDelivery('alice',d.id,1);const u=new URL(link.url);const endpoint=base+u.pathname+u.search;
 let r=await fetch(endpoint);assert.equal(r.status,403);assert.equal(r.headers.get('cache-control'),'private, no-store');
 r=await fetch(endpoint,{headers:{Authorization:'Bearer alice',Host:'attacker.example.test'}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),pdf);assert.equal(r.headers.get('content-disposition'),'attachment');
 r=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer alice'}});assert.equal(r.status,405);
 f.advance(1000);r=await fetch(endpoint,{headers:{Authorization:'Bearer alice'}});assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'denied'});
 r=await fetch(base+'/'+d.id,{headers:{Authorization:'Bearer alice'}});assert.equal(r.status,404);
});
