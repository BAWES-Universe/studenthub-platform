import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import { FileDocumentStore } from '../../../packages/private-documents/src/index.js';
import { CandidateDocuments, LifecycleError } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { createIdempotencyKey } from '../../../packages/idempotency-contract/src/index.js';
import { documentsPage } from '../src/documents-page.js';
const { handleDocumentsUpload } = await import(process.env.SHU539_UPLOAD_MODULE ?? '../src/documents-upload-http.js');

const SESSION='s'.repeat(43), OTHER='o'.repeat(43), ORIGIN='https://documents.test.invalid', NOW=1_800_000_000_000;
function png(colour=0): Buffer {
  const crc=(bytes:Buffer)=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;};
  const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,colour,0,0]))),chunk('IEND',Buffer.alloc(0))]);
}
type Part={name:string;value:Buffer|string;filename?:string;mime?:string};
function body(parts: readonly Part[], boundary='shu539'): Buffer {
  const values:Buffer[]=[];
  for(const part of parts){values.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename!==undefined?`; filename="${part.filename}"`:''}\r\n${part.mime?`Content-Type: ${part.mime}\r\n`:''}\r\n`),Buffer.isBuffer(part.value)?part.value:Buffer.from(part.value),Buffer.from('\r\n'));}
  values.push(Buffer.from(`--${boundary}--\r\n`)); return Buffer.concat(values);
}
async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'shu539-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const disk=await FileDocumentStore.create(join(root,'private'));
  const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'Synthetic'}],principals:['person-1','person-2'].map(id=>({id,pbuuids:[]}))});
  const service=new CandidateDocuments({store:disk,authz,origin:ORIGIN,orgId:'org-a',signingKey:randomBytes(32),now:()=>NOW,authenticate:async value=>value===SESSION?{kind:'principal',principalId:'person-1'}:value===OTHER?{kind:'principal',principalId:'person-2'}:null});
  const calls={list:0,authorize:0,put:0,finalize:0};
  const list=service.list.bind(service),authorize=service.authorizeUpload.bind(service),put=service.put.bind(service),finalize=service.finalize.bind(service);
  service.list=async value=>{calls.list++;return list(value);};
  service.authorizeUpload=async(...args)=>{calls.authorize++;return authorize(...args);};
  service.put=async(...args)=>{calls.put++;return put(...args);};
  service.finalize=async(...args)=>{calls.finalize++;return finalize(...args);};
  const server=createServer(async(req,res)=>{if(await handleDocumentsUpload(req,res,service))return;res.writeHead(404);res.end();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  const submission=createIdempotencyKey(new Date(NOW));
  const post=(slot:string,bytes=png(),mime='image/png',extra:Part[]=[],submitted=submission)=>{const payload=body([{name:'submission',value:submitted},{name:'file',value:bytes,filename:'never-shown.png',mime},...extra]);return fetch(`${url}/profile/documents/${slot}/upload`,{method:'POST',redirect:'manual',headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN,'content-type':'multipart/form-data; boundary=shu539','content-length':String(payload.length)},body:new Uint8Array(payload)});};
  return {service,disk,calls,post,submission,url};
}

test('Q14_1_UPLOAD forms and valid upload show format and size without filename',async t=>{const f=await fixture(t),bytes=png();const page=documentsPage([],'en');assert.equal((page.match(/enctype="multipart\/form-data"/g)??[]).length,4);for(const slot of ['personal-photo','resume','civil-id-front','civil-id-back'])assert.match(page,new RegExp(`action="/profile/documents/${slot}/upload"`));assert.doesNotMatch(page,/<script/i);const response=await f.post('personal-photo',bytes);assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/profile/documents');const shown=documentsPage(await f.service.list(SESSION),'en');assert.match(shown,new RegExp(`PNG · ${bytes.length} bytes`));assert.doesNotMatch(shown,/never-shown/);});
test('Q14_1_LIMIT multipart bodies stop at the fixed bound and store nothing',async t=>{const f=await fixture(t),bytes=Buffer.alloc(10*1024*1024+64*1024);const response=await f.post('personal-photo',bytes);assert.equal(response.status,413);assert.match(await response.text(),/10 MiB/);assert.equal((await f.disk.transaction(async state=>state.documents.length)),0);});
test('Q14_1_REFUSALS existing admission rejects wrong, forged, empty and extra parts',async t=>{const f=await fixture(t);for(const [bytes,mime] of [[Buffer.from('GIF89a'),'image/gif'],[png(),'application/pdf'],[Buffer.from('bad'),'image/png'],[Buffer.alloc(0),'image/png']] as const){const response=await f.post('personal-photo',bytes,mime);assert.equal(response.status,400);assert.match(await response.text(),/valid file|Choose a file/);}const extra=await f.post('personal-photo',png(),'image/png',[{name:'other',value:'bad'}]);assert.equal(extra.status,400);assert.equal((await f.service.list(SESSION)).length,0);});
test('Q14_1_REFUSALS refused finalize never returns success',async t=>{const f=await fixture(t);f.service.finalize=async()=>{throw new LifecycleError(400,'invalid');};const response=await f.post('personal-photo');assert.equal(response.status,400);assert.equal((await f.disk.transaction(async state=>state.documents.length)),0);});
test('Q14_1_ONE_PATH ignores client keys, calls each step once, and sequential retry conflicts',async t=>{const f=await fixture(t);const first=await f.post('personal-photo');assert.equal(first.status,303);assert.deepEqual(f.calls,{list:1,authorize:1,put:1,finalize:1});const second=await f.post('personal-photo');assert.equal(second.status,409);assert.equal((await f.service.list(SESSION)).length,1);});
test('Q14_1_REPLACE replacement commits before retiring exactly one old version',async t=>{const f=await fixture(t),first=png(),second=png(9);assert.equal((await f.post('personal-photo',first)).status,303);assert.equal((await f.post('personal-photo',second,'image/png',[],createIdempotencyKey(new Date(NOW),randomUUID()))).status,303);const state=await f.disk.transaction(async value=>structuredClone(value));assert.equal(state.documents.length,1);assert.equal(state.documents[0]!.size,second.length);assert.equal(state.lifecycle!.cleanup.length,1);assert.equal(state.lifecycle!.cleanup[0]!.status,'held');});
test('Q14_1_OWNER cookie and origin checks precede body; unknown slots are 404',async t=>{const f=await fixture(t),payload=body([{name:'submission',value:f.submission},{name:'file',value:png(),filename:'x',mime:'image/png'}]);for(const headers of [{origin:ORIGIN},{authorization:'Bearer '+SESSION,origin:ORIGIN},{cookie:`__Host-studenthub_session=${SESSION}`,origin:'https://evil.invalid'},{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN,'sec-fetch-site':'cross-site'}] as Record<string,string>[]){const r=await fetch(`${f.url}/profile/documents/personal-photo/upload`,{method:'POST',headers:{...headers,'content-type':'multipart/form-data; boundary=shu539'},body:new Uint8Array(payload)});assert.equal(r.status,headers.cookie?403:401);}assert.equal((await fetch(`${f.url}/profile/documents/other/upload`,{method:'POST'})).status,404);assert.deepEqual(f.calls,{list:0,authorize:0,put:0,finalize:0});});
test('Q14_1_SHOWN one list plus fixed three mutation calls regardless of other slots',async t=>{const f=await fixture(t);assert.equal((await f.post('civil-id-front')).status,303);assert.deepEqual(f.calls,{list:1,authorize:1,put:1,finalize:1});assert.match(documentsPage(await f.service.list(SESSION),'en'),/id="document-civil-id-front"[^]*On file/);});
