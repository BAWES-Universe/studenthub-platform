import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleDocumentsUpload } from '../src/documents-upload-http.js';
import { documentsPage } from '../src/documents-page.js';
import { LifecycleError } from '../../../packages/private-documents/src/candidate-lifecycle.js';

const SESSION = 's'.repeat(43), ORIGIN = 'https://documents.test.invalid';
function multipart(file: Buffer, mime = 'image/png', filename = 'never-echo-this.png', extra = '') {
  const boundary = 'SHU521-boundary';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n${file.toString('latin1')}\r\n--${boundary}\r\nContent-Disposition: form-data; name="submission"\r\n\r\nv1.1800000000000.12345678-1234-4234-8234-123456789abc\r\n${extra}--${boundary}--`, 'latin1');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
function response() {
  const value = new EventEmitter() as EventEmitter & { statusCode: number; headers: Map<string,string>; body: string; setHeader(n:string,v:unknown):void; getHeader(n:string):string|undefined; writeHead(s:number,h?:Record<string,unknown>):void; end(v?:unknown):void };
  value.statusCode = 200; value.headers = new Map(); value.body = '';
  value.setHeader = (n,v) => value.headers.set(n.toLowerCase(), String(v)); value.getHeader = n => value.headers.get(n.toLowerCase());
  value.writeHead = (s,h) => { value.statusCode=s; for (const [n,v] of Object.entries(h ?? {})) value.setHeader(n,v); };
  value.end = v => { if (v !== undefined) value.body += String(v); value.emit('finish'); };
  return value;
}
function request(body: Buffer, contentType: string, headers: Record<string,string> = {}) {
  const value = Readable.from([body]) as Readable & { method?:string; url?:string; headers:Record<string,string> };
  value.method='POST'; value.url='/profile/documents/personal-photo/upload'; value.headers={cookie:`__Host-studenthub_session=${SESSION}`,origin:ORIGIN,'sec-fetch-site':'same-origin','content-type':contentType,'content-length':String(body.length),...headers}; return value;
}
function service() {
  const calls:string[]=[];
  const value = { options:{origin:ORIGIN}, principal:async()=>{calls.push('principal');return 'person-1';}, list:async()=>{calls.push('list');return [];},
    authorizeUpload:async(_c:unknown,key:unknown,input:unknown)=>{calls.push('authorize');assert.match(String(key),/^v1\.1800000000000\./);assert.equal((input as {expectedVersion:unknown}).expectedVersion,null);return {status:201,body:{uploadId:'id',objectKey:'key',credential:'credential'}};},
    put:async()=>{calls.push('put');return {status:204};}, finalize:async()=>{calls.push('finalize');return {status:200,body:{metadata:{}}};} };
  return { value, calls };
}

test('Q14_1_UPLOAD Q14_1_ONE_PATH Q14_1_SHOWN plain forms and one server-side upload path', async () => {
  const html=documentsPage([], 'en');
  for(const slot of ['personal-photo','resume','civil-id-front','civil-id-back']) assert.match(html,new RegExp(`action="/profile/documents/${slot}/upload"`));
  assert.equal((html.match(/method="post" enctype="multipart\/form-data"/g)??[]).length,4);assert.doesNotMatch(html,/<script/);
  const form=multipart(Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex')), f=service(), res=response();
  assert.equal(await handleDocumentsUpload(request(form.body,form.contentType) as never,res as never,f.value as never),true);
  assert.equal(res.statusCode,303);assert.equal(res.headers.get('location'),'/profile/documents');assert.deepEqual(f.calls,['principal','list','authorize','put','finalize']);
  assert.doesNotMatch(res.body+JSON.stringify([...res.headers]),/never-echo-this|credential|objectKey/);
});

test('Q14_1_OWNER Q14_1_LIMIT Q14_1_REFUSALS closed refusals precede mutations', async () => {
  const form=multipart(Buffer.from('bad')), f=service();
  for(const [headers,status] of [[{origin:'https://evil.invalid'},403],[{'sec-fetch-site':'cross-site'},403],[{'content-length':String(11*1024*1024)},413]] as const){const res=response();await handleDocumentsUpload(request(form.body,form.contentType,headers) as never,res as never,f.value as never);assert.equal(res.statusCode,status);assert.match(res.body,/Personal photo/);}
  assert.deepEqual(f.calls,['principal','principal','principal']);
  const bad=response();await handleDocumentsUpload(request(form.body,'text/plain') as never,bad as never,f.value as never);assert.equal(bad.statusCode,400);assert.doesNotMatch(bad.body,/bad|never-echo-this/);
});

test('Q14_1_REPLACE sequential retry conflict is rendered and never reported successful', async () => {
  const form=multipart(Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex')), f=service();
  f.value.finalize=async()=>{f.calls.push('finalize');throw new LifecycleError(409,'conflict');};
  const res=response();await handleDocumentsUpload(request(form.body,form.contentType) as never,res as never,f.value as never);assert.equal(res.statusCode,409);assert.match(res.body,/documents changed/i);
});
