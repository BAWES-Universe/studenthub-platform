import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { documentsPage } from '../src/documents-page.js';
const { handleDocumentsUpload } = await import(process.env.SHU548_UPLOAD_MODULE ?? '../src/documents-upload-http.js');

const session = 's'.repeat(43), origin = 'https://documents.test.invalid';
function body(extra = ''): { boundary: string; bytes: Buffer } {
  const boundary = 'shu548boundary';
  const submission = `${Date.now()}.${randomUUID()}`;
  const text = `--${boundary}\r\nContent-Disposition: form-data; name="submission"\r\n\r\n${submission}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.png"\r\nContent-Type: image/png\r\n\r\nPNG${extra}\r\n--${boundary}--\r\n`;
  return { boundary, bytes: Buffer.from(text) };
}
async function invoke(options: { origin?: string; cookie?: boolean; raw?: Buffer; contentType?: string; currentVersion?: string } = {}) {
  const form = body(), calls: string[] = [], keys: unknown[] = []; let expectedVersion: unknown;
  const request = Readable.from(options.raw ? [options.raw] : [form.bytes]) as Readable & Record<string, unknown>;
  request.method = 'POST'; request.url = '/profile/documents/personal-photo/upload';
  request.headers = { cookie: options.cookie === false ? undefined : `__Host-studenthub_session=${session}`, origin: options.origin ?? origin,
    'content-type': options.contentType ?? `multipart/form-data; boundary=${form.boundary}`, 'content-length': String((options.raw ?? form.bytes).length) };
  let status = 0, headers: Record<string,string> = {}, responseBody = '';
  const response = { setHeader() {}, writeHead(code: number, value: Record<string,string>) { status = code; headers = value; }, end(value?: string) { responseBody = value ?? ''; } };
  const service = { options: { origin }, list: async () => { calls.push('list'); return options.currentVersion ? [{ type: 'personal-photo', version: options.currentVersion }] : []; },
    authorizeUpload: async (_session: unknown, key: unknown, input: { expectedVersion: unknown }) => { calls.push('authorize'); keys.push(key); expectedVersion = input.expectedVersion; return { status: 201, body: { uploadId: 'u', objectKey: 'k', credential: 'c' } }; },
    put: async (_session: unknown, key: unknown) => { calls.push('bytes'); keys.push(key); return { status: 204 }; }, finalize: async (_session: unknown, key: unknown) => { calls.push('finalize'); keys.push(key); return { status: 200 }; } };
  const login = { profile: async () => ({ status: 200, body: { personId: 'person-1' } }) };
  await handleDocumentsUpload(request as never, response as never, service as never, login as never);
  return { status, headers, responseBody, calls, keys, expectedVersion };
}

test('Q14_1_UPLOAD forms and server-side upload redirect', async () => {
  const html = documentsPage([], 'en');
  assert.equal((html.match(/enctype="multipart\/form-data"/g) ?? []).length, 4);
  for (const slot of ['personal-photo','resume','civil-id-front','civil-id-back']) assert.match(html, new RegExp(`/profile/documents/${slot}/upload`));
  const result = await invoke(); assert.equal(result.status, 303); assert.equal(result.headers.location, '/profile/documents');
});
test('Q14_1_LIMIT rejects an over-bound body', async () => { const result = await invoke({ raw: Buffer.alloc(10 * 1024 * 1024 + 64 * 1024 + 1) }); assert.equal(result.status, 413); assert.equal(result.calls.includes('authorize'), false); });
test('Q14_1_REFUSALS malformed multipart stores nothing', async () => { const result = await invoke({ raw: Buffer.from('bad') }); assert.equal(result.status, 400); assert.equal(result.calls.includes('authorize'), false); });
test('Q14_1_REPLACE keeps finalize as the committing step', async () => { const result = await invoke({ currentVersion: 'old-version' }); assert.deepEqual(result.calls.slice(-3), ['authorize','bytes','finalize']); assert.equal(result.expectedVersion, 'old-version'); });
test('Q14_1_ONE_PATH uses one authorize, bytes and finalize call', async () => { const result = await invoke(); for (const step of ['authorize','bytes','finalize']) assert.equal(result.calls.filter(x => x === step).length, 1); assert.equal(new Set(result.keys).size, 3); });
test('Q14_1_OWNER cookie and exact origin precede body mutation', async () => { assert.equal((await invoke({ cookie: false })).status, 401); const wrong = await invoke({ origin: 'https://evil.invalid' }); assert.equal(wrong.status, 403); assert.equal(wrong.calls.includes('list'), false); });
test('Q14_1_SHOWN rendering remains a fixed four-slot projection', () => { assert.equal((documentsPage([], 'en').match(/id="document-/g) ?? []).length, 4); });
