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
  const post=async(type:string,bytes:Buffer,mime:string,options:{session?:string;origin?:string;site?:string;submission?:string;filename?:string}={})=>{
    const form=new FormData(); form.append('file',new Blob([new Uint8Array(bytes)],{type:mime}),options.filename??'never-shown.bin');form.append('submission',options.submission??await submission(type,options.session));
    return fetch(`${base}/profile/documents/${type}/upload`,{method:'POST',redirect:'manual',headers:{cookie:`__Host-studenthub_session=${options.session??SESSION}`,origin:options.origin??ORIGIN,...(options.site?{'sec-fetch-site':options.site}:{})},body:form});
  };
  return {disk,service,page,submission,post,base};
}

test('Q14_1_UPLOAD four forms and a valid upload are shown without the file name',async t=>{
  const f=await fixture(t),html=await(await f.page()).text();
  for(const type of ['personal-photo','resume','civil-id-front','civil-id-back']) assert.match(html,new RegExp(`method="post" enctype="multipart/form-data" action="/profile/documents/${type}/upload"`));
  assert.equal((html.match(/name="file"/g)??[]).length,4);assert.equal((html.match(/name="submission"/g)??[]).length,4);assert.doesNotMatch(html,/<script/);
  const response=await f.post('personal-photo',png(),'image/png');assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/profile/documents');
  const shown=await(await f.page()).text();assert.match(shown,/document-personal-photo[^]*On file[^]*PNG/);assert.doesNotMatch(shown,/never-shown/);
});

test('Q14_1_REFUSALS forged, empty, unknown and duplicate parts store nothing',async t=>{
  const f=await fixture(t);
  for(const [bytes,mime] of [[Buffer.from('GIF89a'),'image/gif'],[png(),'application/pdf'],[Buffer.alloc(0),'image/png']] as const){const r=await f.post('personal-photo',bytes,mime);assert.equal(r.status,400);assert.match(await r.text(),/valid file/);}
  assert.equal((await f.service.list(SESSION)).length,0);
  const token=await f.submission();const form=new FormData();form.append('file',new Blob([new Uint8Array(png())],{type:'image/png'}),'one.png');form.append('file',new Blob([new Uint8Array(png())],{type:'image/png'}),'two.png');form.append('submission',token);
  const duplicate=await fetch(`${f.base}/profile/documents/personal-photo/upload`,{method:'POST',headers:{cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN},body:form});assert.equal(duplicate.status,400);
  const refused=await fixture(t);refused.service.finalize=async()=>({status:409,body:{}});const denied=await refused.post('personal-photo',png(),'image/png');assert.equal(denied.status,503);
});

test('Q14_1_ONE_PATH server keys ignore client key and sequential replay conflicts',async t=>{
  const f=await fixture(t),token=await f.submission(),first=await f.post('personal-photo',png(),'image/png',{submission:token});assert.equal(first.status,303);
  const second=await f.post('personal-photo',png(),'image/png',{submission:token});assert.equal(second.status,409);assert.equal((await f.service.list(SESSION)).length,1);
});

test('Q14_1_REPLACE replacement keeps one current document and shows its new size',async t=>{
  const f=await fixture(t),old=png(),next=png(9);assert.equal((await f.post('personal-photo',old,'image/png')).status,303);
  assert.equal((await f.post('personal-photo',next,'image/png')).status,303);
  const documents=await f.service.list(SESSION);assert.equal(documents.length,1);assert.equal(documents[0]!.size,next.length);
  const state=await f.disk.transaction(async value=>structuredClone(value));assert.equal(state.lifecycle?.cleanup.length,1);assert.equal(state.lifecycle?.cleanup[0]?.status,'held');
});

test('Q14_1_OWNER cookie and exact origin gate the body and isolate people',async t=>{
  const f=await fixture(t),token=await f.submission();
  const wrong=await f.post('personal-photo',png(),'image/png',{submission:token,origin:'https://evil.invalid'});assert.equal(wrong.status,403);
  const cross=await f.post('personal-photo',png(),'image/png',{submission:token,site:'cross-site'});assert.equal(cross.status,403);
  const bearer=await fetch(`${f.base}/profile/documents/personal-photo/upload`,{method:'POST',headers:{authorization:'Bearer '+SESSION,origin:ORIGIN},body:new FormData()});assert.equal(bearer.status,401);
  assert.equal((await fetch(`${f.base}/profile/documents/not-a-slot/upload`,{method:'POST'})).status,404);
  assert.equal((await f.post('personal-photo',png(),'image/png',{session:OTHER})).status,303);assert.equal((await f.service.list(SESSION)).length,0);assert.equal((await f.service.list(OTHER)).length,1);
});

test('Q14_1_SHOWN one list plus authorize, bytes and finalize has fixed cardinality',async t=>{
  const f=await fixture(t),calls:string[]=[];
  for(const name of ['list','authorizeUpload','put','finalize'] as const){const original=f.service[name].bind(f.service) as (...args:never[])=>Promise<unknown>;(f.service[name] as unknown as (...args:never[])=>Promise<unknown>)=async(...args)=>{calls.push(name);return original(...args);};}
  assert.equal((await f.post('civil-id-front',png(1),'image/png')).status,303);assert.deepEqual(calls,['list','authorizeUpload','put','finalize']);
});
