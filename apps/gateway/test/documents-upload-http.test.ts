import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
const { handleDocumentsUpload } = await import(process.env.SHU503_UPLOAD_MODULE ?? '../src/documents-upload-http.js');

const SESSION = 's'.repeat(43), ORIGIN = 'https://documents.test.invalid', NOW = 1_800_000_000_000, SECRET = Buffer.alloc(32, 7);
function submission(type = 'personal-photo'): string { const raw = `${NOW}.00000000-0000-4000-8000-000000000001`; return `${raw}.${createHmac('sha256', SECRET).update(`documents-upload:${type}:${raw}`).digest('base64url')}`; }
function multipart(parts: readonly { name: string; value: Buffer | string; filename?: string; mime?: string }[], boundary = 'shu503-boundary'): Buffer {
  const rows: Buffer[] = [];
  for (const part of parts) rows.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.mime ? `Content-Type: ${part.mime}\r\n` : ''}\r\n`), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value), Buffer.from('\r\n'));
  rows.push(Buffer.from(`--${boundary}--`)); return Buffer.concat(rows);
}
function exchange(body: Buffer<ArrayBufferLike> = Buffer.alloc(0), headers: Record<string,string> = {}, path = '/profile/documents/personal-photo/upload') {
  const request = Readable.from(body.length ? [body] : []) as IncomingMessage;
  Object.assign(request, { method: 'POST', url: path, headers: { cookie: `__Host-studenthub_session=${SESSION}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'multipart/form-data; boundary=shu503-boundary', ...headers } });
  let status = 0, responseBody = '', responseHeaders: Record<string,string> = {};
  const response = { writeHead(code: number, values: Record<string,string>) { status = code; responseHeaders = values; return this; }, end(value?: string) { responseBody = value ?? ''; return this; } } as unknown as ServerResponse;
  return { request, response, result: () => ({ status, body: responseBody, headers: responseHeaders }) };
}
function fake() {
  const calls: { name: string; args: unknown[] }[] = [];
  const service = { options: { origin: ORIGIN, signingKey: SECRET, now: () => NOW },
    async principal(...args: unknown[]) { calls.push({ name: 'principal', args }); return 'person-1'; },
    async list(...args: unknown[]) { calls.push({ name: 'list', args }); return []; },
    async authorizeUpload(...args: unknown[]) { calls.push({ name: 'authorize', args }); return { status: 201, body: { uploadId: 'upload-secret', objectKey: 'object-secret', credential: 'credential-secret' } }; },
    async put(...args: unknown[]) { calls.push({ name: 'put', args }); return { status: 204 }; },
    async finalize(...args: unknown[]) { calls.push({ name: 'finalize', args }); return { status: 200 }; } };
  return { service: service as never, calls };
}
const valid = () => multipart([{ name: 'submission', value: submission() }, { name: 'file', filename: 'never-shown.png', mime: 'image/png', value: Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082','hex') }]);

test('Q14_1_ONE_PATH server runs one list, authorize, bytes and finalize with derived keys', async () => {
  const f = fake(), x = exchange(valid(), { 'idempotency-key': 'client-key-is-ignored' }); await handleDocumentsUpload(x.request, x.response, f.service);
  assert.equal(x.result().status, 303); assert.equal(x.result().headers.location, '/profile/documents');
  assert.deepEqual(f.calls.map(call => call.name), ['list','authorize','put','finalize']);
  assert.ok(f.calls.filter(call => ['authorize','put','finalize'].includes(call.name)).every(call => String(call.args[1]).startsWith('v1.')));
  assert.doesNotMatch(JSON.stringify(x.result()), /never-shown|upload-secret|object-secret|credential-secret|client-key-is-ignored/);
});

test('Q14_1_OWNER cookie and same-origin checks precede body and service access', async () => {
  for (const [headers, expected] of [[{ cookie: '' },401],[{ origin: 'https://evil.invalid' },403],[{ 'sec-fetch-site':'cross-site' },403]] as const) {
    const f = fake(), x = exchange(valid(), headers as Record<string,string>); await handleDocumentsUpload(x.request, x.response, f.service);
    assert.equal(x.result().status, expected); assert.equal(f.calls.length, 0); assert.match(x.result().body, expected === 401 ? /Continue with Universe/ : /refused/);
  }
  const f = fake(), unknown = exchange(valid(), {}, '/profile/documents/not-a-slot/upload'); await handleDocumentsUpload(unknown.request, unknown.response, f.service);
  assert.equal(unknown.result().status, 404); assert.equal(f.calls.length, 0);
});

test('Q14_1_LIMIT oversized declared bodies stop before multipart parsing and mutation', async () => {
  const f = fake(), x = exchange(Buffer.alloc(0), { 'content-length': String(10 * 1024 * 1024 + 64 * 1024 + 1) }); await handleDocumentsUpload(x.request, x.response, f.service);
  assert.equal(x.result().status, 413); assert.match(x.result().body, /Personal photo[^]*10 MiB/); assert.deepEqual(f.calls.map(call => call.name), ['list']);
});

test('Q14_1_REFUSALS missing, duplicate and unknown parts are closed HTML errors', async () => {
  const cases = [multipart([{ name:'submission',value:submission() }]), multipart([{ name:'submission',value:submission() },{ name:'file',filename:'',mime:'image/png',value:'' }]), multipart([{ name:'submission',value:submission() },{ name:'extra',value:'x' },{ name:'file',filename:'x.png',mime:'image/png',value:'x' }]), multipart([{ name:'submission',value:submission() },{ name:'file',filename:'a.png',mime:'image/png',value:'x' },{ name:'file',filename:'b.png',mime:'image/png',value:'x' }])];
  for (const body of cases) { const f=fake(),x=exchange(body); await handleDocumentsUpload(x.request,x.response,f.service); assert.equal(x.result().status,400); assert.match(x.result().body,/Personal photo[^]*Back to My documents/); assert.equal(f.calls.some(call=>call.name==='authorize'),false); }
});

test('Q14_1_REFUSALS a refused finalize never becomes a redirect', async () => {
  const f = fake(); (f.service as { finalize: () => Promise<never> }).finalize = async () => { throw Object.assign(new Error('conflict'), { status: 409, code: 'conflict' }); };
  const x = exchange(valid()); await handleDocumentsUpload(x.request, x.response, f.service);
  assert.notEqual(x.result().status, 303); assert.doesNotMatch(x.result().body, /conflict|upload-secret|object-secret/);
});
