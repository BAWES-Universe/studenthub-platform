import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import { createSyntheticLoginRig } from '@studenthub/login-contract';
import { OwnProfileRepository, UnconfiguredApprovedProfileAdapter } from '@studenthub/profile';
import { FileDocumentStore } from '../../../packages/private-documents/src/index.js';
import { CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { createLoginApplication } from '../src/login-application.js';
import { handleDocumentsPage } from '../src/documents-page.js';
import type { BrowserLoginApplication } from '../src/web-ui.js';
const { handleDocumentsUpload } = await import(process.env.SHU531_UPLOAD_MODULE ?? '../src/documents-upload-http.js');

test('Q14_1_LIMIT declared oversize is refused before body consumption and names 10 MiB',async()=>{
  let reads=0,status=0,text='';
  const request=Readable.from((async function*(){reads++;yield Buffer.from('must not read');})()) as Readable & {url:string;method:string;headers:Record<string,string>};
  request.url='/profile/documents/personal-photo/upload';request.method='POST';request.headers={cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN,'content-type':'multipart/form-data; boundary=x','content-length':String(11*1024*1024)};
  const headers=new Map<string,string>();const response={setHeader:(k:string,v:string)=>headers.set(k,v),writeHead:(s:number)=>{status=s;},end:(v?:string)=>{text+=v??'';}} as never;
  const service={options:{origin:ORIGIN},list:async()=>{throw new Error('store touched');}} as never;
  const login={profile:async()=>({status:200,body:{personId:'person-1'}})} as never;
  assert.equal(await handleDocumentsUpload(request as never,response,service,login),true);assert.equal(status,413);assert.equal(reads,0);assert.match(text,/Personal photo/);assert.match(text,/10 MiB/);
});

const SESSION = 's'.repeat(43), OTHER = 'o'.repeat(43), ORIGIN = 'https://documents.test.invalid';
function crc32(bytes: Buffer): number { let c=0xffffffff; for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0; }
function chunk(type:string,data:Buffer):Buffer {const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;}
function png(color=0):Buffer {const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,color,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
function largerPng(color=0):Buffer {const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('gAMA',Buffer.from([0,0,177,143])),chunk('IDAT',deflateSync(Buffer.from([0,color,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
function pdf():Buffer {let s='%PDF-1.4\n';const offsets=[0];for(const [i,obj] of ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'].entries()){offsets.push(s.length);s+=`${i+1} 0 obj\n${obj}\nendobj\n`;}const x=s.length;s+=`xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(s);}
async function fixture(t: TestContext) {
  const root=await mkdtemp(join(tmpdir(),'shu531-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const disk=await FileDocumentStore.create(join(root,'documents'));
  const authz=new InMemoryAuthzStore({organizations:[{id:'org-a',name:'A'}],principals:['person-1','person-2'].map(id=>({id,pbuuids:[]}))});
  const loginRig=createSyntheticLoginRig(createLoginApplication); await loginRig.sessions.put({id:SESSION,personId:'person-1'}); await loginRig.sessions.put({id:OTHER,personId:'person-2'});
  const service=new CandidateDocuments({store:disk,authz,origin:ORIGIN,orgId:'org-a',signingKey:randomBytes(32),now:()=>1_800_000_000_000,
    authenticate:async value=>{const session=await loginRig.sessions.get(value);return session?{kind:'principal' as const,principalId:session.personId}:null;}});
  const repository=new OwnProfileRepository({principals:authz,source:new UnconfiguredApprovedProfileAdapter(),preferences:{async readOwnPreferences(){return{language:'en',updatedAt:'2026-11-05T00:00:00Z'};}}});
  const login:BrowserLoginApplication={...loginRig.app,web:{origin:ORIGIN,returnTo:`${ORIGIN}/profile`,profiles:repository}};
  const server=createServer(async(request,response)=>{if(await handleDocumentsPage(request,response,service,login))return;if(await handleDocumentsUpload(request,response,service,login))return;response.writeHead(404);response.end();}); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();}); const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const page=(session=SESSION)=>fetch(base+'/profile/documents',{headers:{accept:'text/html',cookie:`__Host-studenthub_session=${session}`}});
  const submission=async(type='personal-photo',session=SESSION)=>{const source=await(await page(session)).text();return new RegExp(`action="/profile/documents/${type}/upload"[^]*?name="submission" value="([^"]+)"`).exec(source)![1]!;};
  const post=async(type:string,bytes:Buffer,mime:string,options:{session?:string;origin?:string;site?:string;submission?:string;filename?:string;clientKey?:string}={})=>{
    const form=new FormData(); form.append('file',new Blob([new Uint8Array(bytes)],{type:mime}),options.filename??'never-shown.bin');form.append('submission',options.submission??await submission(type,options.session));
    return fetch(`${base}/profile/documents/${type}/upload`,{method:'POST',redirect:'manual',headers:{cookie:`__Host-studenthub_session=${options.session??SESSION}`,origin:options.origin??ORIGIN,...(options.site?{'sec-fetch-site':options.site}:{}),...(options.clientKey?{'idempotency-key':options.clientKey}:{})},body:form});
  };
  return {disk,service,page,submission,post,base};
}

test('Q14_1_UPLOAD four forms and a valid upload are shown without the file name',async t=>{
  const f=await fixture(t),html=await(await f.page()).text();
  for(const type of ['personal-photo','resume','civil-id-front','civil-id-back']) assert.match(html,new RegExp(`method="post" enctype="multipart/form-data" action="/profile/documents/${type}/upload"`));
  assert.equal((html.match(/name="file"/g)??[]).length,4);assert.equal((html.match(/name="submission"/g)??[]).length,4);assert.doesNotMatch(html,/<script/);
  assert.equal((html.match(/accept="image\/png,image\/jpeg"/g)??[]).length,3);assert.equal((html.match(/accept="application\/pdf"/g)??[]).length,1);
  const response=await f.post('personal-photo',png(),'image/png');assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/profile/documents');
  const shown=await(await f.page()).text();assert.match(shown,new RegExp(`document-personal-photo[^]*On file[^]*PNG · ${png().length} bytes`));assert.doesNotMatch(shown,/never-shown/);
});

test('Q14_1_LIMIT chunked oversize stops after the bound plus one chunk and stores nothing',async()=>{
  const size=1024*1024, chunks=12;let reads=0,status=0,text='',destroyed=false;
  const request={url:'/profile/documents/personal-photo/upload',method:'POST',headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN,'content-type':'multipart/form-data; boundary=x'},iterator(){return(async function*(){for(let i=0;i<chunks&&!destroyed;i++){reads++;yield Buffer.alloc(size);}})();},destroy(){destroyed=true;},resume(){throw new Error('streaming overflow must close, not drain into memory');}};
  const response={setHeader:()=>{},writeHead:(s:number)=>{status=s;},end:(v?:string)=>{text+=v??'';}} as never;
  const service={options:{origin:ORIGIN},list:async()=>{throw new Error('store touched');}} as never;
  const login={profile:async()=>({status:200,body:{personId:'person-1'}})} as never;
  await handleDocumentsUpload(request as never,response,service,login);assert.equal(status,413);assert.ok(reads*size<=10*1024*1024+64*1024+size);assert.ok(reads<chunks);assert.match(text,/10 MiB/);
});

test('Q14_1_REFUSALS every admission and multipart refusal stores nothing',async t=>{
  const f=await fixture(t);
  const cases:[string,Buffer,string][]=[['personal-photo',Buffer.from('GIF89a'),'image/gif'],['personal-photo',pdf(),'application/pdf'],['resume',png(),'image/png'],['personal-photo',Buffer.from('ffd8ffd9','hex'),'image/png'],['resume',Buffer.from('not pdf'),'application/pdf'],['personal-photo',png().subarray(0,20),'image/png'],['personal-photo',Buffer.from('ffd8ffe000104a4649460001010000010001','hex'),'image/jpeg'],['resume',pdf().subarray(0,-5),'application/pdf'],['personal-photo',Buffer.alloc(0),'image/png']];
  for(const [slot,bytes,mime] of cases){const before=await f.service.list(SESSION);const r=await f.post(slot,bytes,mime);assert.equal(r.status,400,`${slot}/${mime}`);assert.match(await r.text(),/valid file/);assert.deepEqual(await f.service.list(SESSION),before);}
  const token=await f.submission();const form=new FormData();form.append('file',new Blob([new Uint8Array(png())],{type:'image/png'}),'one.png');form.append('file',new Blob([new Uint8Array(png())],{type:'image/png'}),'two.png');form.append('submission',token);
  const duplicate=await fetch(`${f.base}/profile/documents/personal-photo/upload`,{method:'POST',headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN},body:form});assert.equal(duplicate.status,400);
  const unknown=new FormData();unknown.append('file',new Blob([new Uint8Array(png())],{type:'image/png'}),'one.png');unknown.append('submission',token);unknown.append('surprise','no');assert.equal((await fetch(`${f.base}/profile/documents/personal-photo/upload`,{method:'POST',headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN},body:unknown})).status,400);
  const boundary='empty-file';const empty=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}\r\nContent-Disposition: form-data; name="submission"\r\n\r\n${token}\r\n--${boundary}--`);const noFile=await fetch(`${f.base}/profile/documents/personal-photo/upload`,{method:'POST',headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN,'content-type':`multipart/form-data; boundary=${boundary}`},body:empty});assert.equal(noFile.status,400);assert.match(await noFile.text(),/Choose a file first/);
  assert.equal((await f.service.list(SESSION)).length,0);
  const refused=await fixture(t);refused.service.finalize=async()=>({status:409,body:{}});const denied=await refused.post('personal-photo',png(),'image/png');assert.equal(denied.status,503);
});

test('Q14_1_ONE_PATH server keys ignore client key and sequential replay conflicts',async t=>{
  const f=await fixture(t),token=await f.submission(),keys:string[]=[];for(const name of ['authorizeUpload','put','finalize'] as const){const original=f.service[name].bind(f.service) as (...args:never[])=>Promise<unknown>;(f.service[name] as unknown as (...args:never[])=>Promise<unknown>)=async(...args)=>{keys.push(String(args[1]));return original(...args);};}
  const first=await f.post('personal-photo',png(),'image/png',{submission:token,clientKey:'client-controlled'});assert.equal(first.status,303);assert.equal(keys.length,3);assert.equal(new Set(keys).size,3);assert.ok(keys.every(key=>key!=='client-controlled'));
  const second=await f.post('personal-photo',png(),'image/png',{submission:token});assert.equal(second.status,409);assert.equal((await f.service.list(SESSION)).length,1);
});

test('Q14_1_REPLACE replacement keeps one current document and shows its new size',async t=>{
  const f=await fixture(t),old=png(),next=largerPng(9);assert.equal((await f.post('personal-photo',old,'image/png')).status,303);
  const original=f.service.options.store.transaction.bind(f.service.options.store);let fail=true;f.service.options.store.transaction=async fn=>original(async state=>{const before=state.documents.map(row=>row.version).join();const result=await fn(state);if(fail&&state.documents.map(row=>row.version).join()!==before){fail=false;throw new Error('injected commit failure');}return result;});
  assert.equal((await f.post('personal-photo',next,'image/png')).status,503);const unchanged=await(await f.page()).text();assert.match(unchanged,new RegExp(`document-personal-photo[^]*On file[^]*${old.length} bytes`));assert.equal((await f.service.list(SESSION))[0]!.size,old.length);
  assert.equal((await f.post('personal-photo',next,'image/png')).status,303);
  const documents=await f.service.list(SESSION);assert.equal(documents.length,1);assert.equal(documents[0]!.size,next.length);
  const state=await f.disk.transaction(async value=>structuredClone(value));assert.equal(state.lifecycle?.cleanup.length,1);assert.equal(state.lifecycle?.cleanup[0]?.status,'held');
});

test('Q14_1_OWNER cookie and exact origin gate the body and isolate people',async t=>{
  const f=await fixture(t),token=await f.submission();
  let storeCalls=0,reads=0,status=0,text='';
  const request={url:'/profile/documents/personal-photo/upload',method:'POST',headers:{origin:ORIGIN,'content-type':'multipart/form-data; boundary=x'},resume(){},iterator(){reads++;throw new Error('body read');}};
  const response={setHeader:()=>{},writeHead:(value:number)=>{status=value;},end:(value?:string)=>{text+=value??'';}} as never;
  const untouched={options:{origin:ORIGIN},list:async()=>{storeCalls++;return[];}} as never;
  assert.equal(await handleDocumentsUpload(request as never,response,untouched,{} as never),true);assert.equal(status,401);assert.match(text,/Sign in/);assert.equal(storeCalls,0);assert.equal(reads,0);
  let wrongReads=0;const wrongRequest={...request,headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:'https://evil.invalid','content-type':'multipart/form-data; boundary=x'},iterator(){wrongReads++;throw new Error('body read');}};status=0;
  assert.equal(await handleDocumentsUpload(wrongRequest as never,response,untouched,{profile:async()=>({status:200,body:{personId:'person-1'}})} as never),true);assert.equal(status,403);assert.equal(wrongReads,0);assert.equal(storeCalls,0);
  const wrong=await f.post('personal-photo',png(),'image/png',{submission:token,origin:'https://evil.invalid'});assert.equal(wrong.status,403);
  const cross=await f.post('personal-photo',png(),'image/png',{submission:token,site:'cross-site'});assert.equal(cross.status,403);
  const bearer=await fetch(`${f.base}/profile/documents/personal-photo/upload`,{method:'POST',headers:{authorization:'Bearer '+SESSION,origin:ORIGIN},body:new FormData()});assert.equal(bearer.status,401);
  assert.equal((await fetch(`${f.base}/profile/documents/not-a-slot/upload`,{method:'POST'})).status,404);
  assert.equal((await f.post('personal-photo',png(),'image/png',{session:OTHER})).status,303);assert.equal((await f.service.list(SESSION)).length,0);assert.equal((await f.service.list(OTHER)).length,1);
});

test('Q14_1_SHOWN one list plus authorize, bytes and finalize has fixed cardinality',async t=>{
  const measure=async(prefill:boolean)=>{const f=await fixture(t);if(prefill){assert.equal((await f.post('personal-photo',png(),'image/png')).status,303);assert.equal((await f.post('resume',pdf(),'application/pdf')).status,303);assert.equal((await f.post('civil-id-back',png(2),'image/png')).status,303);}const token=await f.submission('civil-id-front'),calls:string[]=[];
    for(const name of ['list','authorizeUpload','put','finalize'] as const){const original=f.service[name].bind(f.service) as (...args:never[])=>Promise<unknown>;(f.service[name] as unknown as (...args:never[])=>Promise<unknown>)=async(...args)=>{calls.push(name);return original(...args);};}
    assert.equal((await f.post('civil-id-front',png(1),'image/png',{submission:token})).status,303);return calls;};
  assert.deepEqual(await measure(false),['list','authorizeUpload','put','finalize']);assert.deepEqual(await measure(true),['list','authorizeUpload','put','finalize']);
});
