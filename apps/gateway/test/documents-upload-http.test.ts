import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import { FileDocumentStore } from '../../../packages/private-documents/src/index.js';
import { LifecycleError } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { createCandidateDocuments } from '../src/candidate-documents-runtime.js';
import { createGatewayServer } from '../src/index.js';
import { documentsPage } from '../src/documents-page.js';
const { handleDocumentsUpload } = await import(process.env.SHU548_UPLOAD_MODULE ?? '../src/documents-upload-http.js');

const session = 's'.repeat(43), origin = 'https://documents.test.invalid';
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64');
const validJpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0001ffd9', 'hex');
function validPdf(): Buffer {
  let value = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'].entries()) {
    offsets.push(value.length); value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = value.length;
  value += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

async function realRig(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'shu548-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileDocumentStore.create(join(root, 'documents'));
  let failCommit = false;
  const lifecycleStore = { transaction: <T>(operation: Parameters<typeof store.transaction<T>>[0]) => store.transaction(async state => {
    const versions = state.documents.map(document => document.version).join(','); const result = await operation(state);
    if (failCommit && state.documents.map(document => document.version).join(',') !== versions) { failCommit = false; throw new Error('injected replacement commit failure'); }
    return result;
  }) };
  const authz = new InMemoryAuthzStore({
    organizations: [{ id: 'documents-org', name: 'Documents' }],
    principals: [{ id: 'person-1', pbuuids: [] }, { id: 'person-2', pbuuids: [] }],
  });
  for (const personId of ['person-1', 'person-2']) await authz.grantMany(personId, [{ orgId: 'documents-org', role: 'candidate', scope: 'self' }]);
  const tokens = { 'person-1': randomBytes(32).toString('base64url'), 'person-2': randomBytes(32).toString('base64url') };
  const rows = new Map(Object.entries(tokens).map(([personId, id]) => [id, { id, personId }]));
  const sessions = { get: async (id: string) => rows.get(id), put: async (row: { id: string; personId: string }) => { rows.set(row.id, row); }, delete: async (id: string) => { rows.delete(id); } };
  const service = createCandidateDocuments({ store: lifecycleStore, authz, sessions, origin, orgId: 'documents-org', signingKey: randomBytes(32) });
  const login = { profile: async ({ sessionId }: { sessionId: string }) => {
    const row = rows.get(sessionId); return row ? { status: 200, body: { personId: row.personId } } : { status: 401 };
  } };
  const server = createGatewayServer(undefined, undefined, undefined, login as never, null, undefined, service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  async function upload(personId: keyof typeof tokens, name = 'never-render-this.png') {
    const form = new FormData();
    form.set('submission', `${Date.now()}.${randomUUID()}`);
    form.set('file', new Blob([validPng], { type: 'image/png' }), name);
    return fetch(`${endpoint}/profile/documents/personal-photo/upload`, { method: 'POST', redirect: 'manual', headers: { cookie: `__Host-studenthub_session=${tokens[personId]}`, origin }, body: form });
  }
  async function post(personId: keyof typeof tokens, slot: string, bytes: Buffer, mime: string, filename = 'private-name') {
    const form = new FormData(); form.set('submission', `${Date.now()}.${randomUUID()}`); form.set('file', new Blob([Uint8Array.from(bytes)], { type: mime }), filename);
    return fetch(`${endpoint}/profile/documents/${slot}/upload`, { method: 'POST', redirect: 'manual', headers: { cookie: `__Host-studenthub_session=${tokens[personId]}`, origin }, body: form });
  }
  const state = () => store.transaction(async value => structuredClone(value));
  return { service, store, tokens, upload, post, state, endpoint, failNextCommit: () => { failCommit = true; } };
}
function body(extra = ''): { boundary: string; bytes: Buffer } {
  const boundary = 'shu548boundary';
  const submission = `${Date.now()}.${randomUUID()}`;
  const text = `--${boundary}\r\nContent-Disposition: form-data; name="submission"\r\n\r\n${submission}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.png"\r\nContent-Type: image/png\r\n\r\nPNG${extra}\r\n--${boundary}--\r\n`;
  return { boundary, bytes: Buffer.from(text) };
}
async function invoke(options: { origin?: string; cookie?: boolean; raw?: Buffer; chunks?: Iterable<Buffer>; omitLength?: boolean; contentType?: string; currentVersion?: string; finalizeError?: boolean } = {}) {
  const form = body(), calls: string[] = [], keys: unknown[] = []; let expectedVersion: unknown;
  const source = options.chunks ?? (options.raw ? [options.raw] : [form.bytes]);
  const request = Readable.from(source) as Readable & Record<string, unknown>;
  request.method = 'POST'; request.url = '/profile/documents/personal-photo/upload';
  request.headers = { cookie: options.cookie === false ? undefined : `__Host-studenthub_session=${session}`, origin: options.origin ?? origin,
    'content-type': options.contentType ?? `multipart/form-data; boundary=${form.boundary}`,
    ...(options.omitLength ? {} : { 'content-length': String((options.raw ?? form.bytes).length) }) };
  let status = 0, headers: Record<string,string> = {}, responseBody = '';
  const response = { setHeader() {}, writeHead(code: number, value: Record<string,string>) { status = code; headers = value; }, end(value?: string) { responseBody = value ?? ''; } };
  const service = { options: { origin }, list: async () => { calls.push('list'); return options.currentVersion ? [{ type: 'personal-photo', version: options.currentVersion }] : []; },
    authorizeUpload: async (_session: unknown, key: unknown, input: { expectedVersion: unknown }) => { calls.push('authorize'); keys.push(key); expectedVersion = input.expectedVersion; return { status: 201, body: { uploadId: 'u', objectKey: 'k', credential: 'c' } }; },
    put: async (_session: unknown, key: unknown) => { calls.push('bytes'); keys.push(key); return { status: 204 }; }, finalize: async (_session: unknown, key: unknown) => { calls.push('finalize'); keys.push(key); if (options.finalizeError) throw new LifecycleError(400, 'invalid'); return { status: 200 }; } };
  const login = { profile: async () => ({ status: 200, body: { personId: 'person-1' } }) };
  await handleDocumentsUpload(request as never, response as never, service as never, login as never);
  return { status, headers, responseBody, calls, keys, expectedVersion };
}

test('Q14_1_UPLOAD forms and server-side upload redirect', async () => {
  const html = documentsPage([], 'en');
  assert.equal((html.match(/enctype="multipart\/form-data"/g) ?? []).length, 4);
  const accepts = { 'personal-photo': 'image/png,image/jpeg', resume: 'application/pdf', 'civil-id-front': 'image/png,image/jpeg', 'civil-id-back': 'image/png,image/jpeg' };
  for (const [slot, accept] of Object.entries(accepts)) {
    assert.match(html, new RegExp(`/profile/documents/${slot}/upload`)); assert.match(html, new RegExp(`accept="${accept}"`));
  }
  assert.equal((html.match(/name="submission"/g) ?? []).length, 4); assert.doesNotMatch(html, /<script\b/);
  const result = await invoke(); assert.equal(result.status, 303); assert.equal(result.headers.location, '/profile/documents');
});
test('Q14_1_UPLOAD all admitted slot formats pass through the browser route', async context => {
  const rig = await realRig(context);
  for (const [slot, bytes, mime] of [['personal-photo', validJpeg, 'image/jpeg'], ['resume', validPdf(), 'application/pdf'], ['civil-id-front', validPng, 'image/png'], ['civil-id-back', validJpeg, 'image/jpeg']] as const)
    assert.equal((await rig.post('person-1', slot, bytes, mime)).status, 303);
  assert.equal((await rig.service.list(rig.tokens['person-1'])).length, 4);
});
test('Q14_1_UPLOAD route stores admitted bytes and renders only format and size', async context => {
  const rig = await realRig(context);
  const response = await rig.upload('person-1');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/profile/documents');
  const documents = await rig.service.list(rig.tokens['person-1']);
  assert.equal(documents.length, 1);
  const html = documentsPage(documents, 'en');
  assert.match(html, /On file/);
  assert.match(html, new RegExp(`PNG · ${validPng.length} bytes`));
  assert.doesNotMatch(html, /never-render-this/);
});
test('Q14_1_LIMIT rejects an over-bound body', async () => {
  const bound = 10 * 1024 * 1024 + 64 * 1024;
  const declared = await invoke({ raw: Buffer.alloc(bound + 1) });
  assert.equal(declared.status, 413);
  assert.match(declared.responseBody, /Personal photo/);
  assert.match(declared.responseBody, /10 MiB/);
  assert.equal(declared.calls.length, 0);

  const chunk = 16 * 1024;
  let yielded = 0;
  const chunks = (function* () {
    for (let index = 0; index < Math.ceil(bound / chunk) + 4; index += 1) {
      yielded += chunk;
      yield Buffer.alloc(chunk);
    }
  })();
  const streamed = await invoke({ chunks, omitLength: true });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.calls.length, 0);
  // The iterator may have supplied the one chunk that crossed the limit, but
  // the handler must not collect or inspect the remainder.
  assert.ok(yielded <= bound + chunk, `read ${yielded} bytes past a ${bound} byte bound`);
});
test('Q14_1_REFUSALS every type and content refusal leaves the real store unchanged', async context => {
  const rig = await realRig(context);
  const cases: [string, Buffer, string][] = [
    ['personal-photo', Buffer.from('GIF89a'), 'image/gif'], ['personal-photo', validPdf(), 'application/pdf'], ['resume', validPng, 'image/png'],
    ['personal-photo', validJpeg, 'image/png'], ['resume', Buffer.from('not a pdf'), 'application/pdf'],
    ['personal-photo', validPng.subarray(0, 20), 'image/png'], ['personal-photo', validJpeg.subarray(0, -2), 'image/jpeg'], ['resume', validPdf().subarray(0, -6), 'application/pdf'],
    ['personal-photo', Buffer.alloc(0), 'image/png'],
  ];
  for (const [slot, bytes, mime] of cases) {
    const before = await rig.state(); const response = await rig.post('person-1', slot, bytes, mime);
    assert.equal(response.status, 400, `${slot} ${mime} ${bytes.length}`); assert.match(await response.text(), /valid file|Choose a file/);
    const after = await rig.state(); assert.deepEqual(after.documents, before.documents); assert.equal(after.lifecycle?.cleanup.length ?? 0, before.lifecycle?.cleanup.length ?? 0);
    assert.equal(after.lifecycle?.uploads.some(ticket => ticket.committed) ?? false, false);
  }
});
test('Q14_1_REFUSALS empty filename, duplicate file, and unknown fields are rejected', async () => {
  const multipartCase = async (parts: string) => invoke({ raw: Buffer.from(`--x\r\n${parts}\r\n--x--\r\n`), contentType: 'multipart/form-data; boundary=x' });
  const submission = `Content-Disposition: form-data; name="submission"\r\n\r\n${Date.now()}.${randomUUID()}`;
  let result = await multipartCase(`${submission}\r\n--x\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: image/png\r\n\r\n`);
  assert.equal(result.status, 400); assert.match(result.responseBody, /Choose a file first/); assert.equal(result.calls.includes('authorize'), false);
  const file = `Content-Disposition: form-data; name="file"; filename="a"\r\nContent-Type: image/png\r\n\r\n${validPng.toString('latin1')}`;
  result = await multipartCase(`${submission}\r\n--x\r\n${file}\r\n--x\r\n${file}`); assert.equal(result.status, 400); assert.equal(result.calls.length, 0);
  result = await multipartCase(`${submission}\r\n--x\r\nContent-Disposition: form-data; name="personId"\r\n\r\nperson-2`); assert.equal(result.status, 400); assert.equal(result.calls.length, 0);
});
test('Q14_1_REFUSALS a finalize refusal is never converted into success', async () => { const result = await invoke({ finalizeError: true }); assert.equal(result.status, 400); assert.match(result.responseBody, /valid file/); });
test('Q14_1_REPLACE keeps finalize as the committing step', async () => { const result = await invoke({ currentVersion: 'old-version' }); assert.deepEqual(result.calls.slice(-3), ['authorize','bytes','finalize']); assert.equal(result.expectedVersion, 'old-version'); });
test('Q14_1_REPLACE failed commit preserves old display and success holds exactly one old version', async context => {
  const rig = await realRig(context); assert.equal((await rig.post('person-1', 'personal-photo', validPng, 'image/png')).status, 303);
  const old = (await rig.service.list(rig.tokens['person-1']))[0]!; rig.failNextCommit();
  const failed = await rig.post('person-1', 'personal-photo', validJpeg, 'image/jpeg'); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /injected|failure/);
  let listed = await rig.service.list(rig.tokens['person-1']); assert.equal(listed[0]?.version, old.version);
  let html = documentsPage(listed, 'en'); assert.match(html, new RegExp(`PNG · ${old.size} bytes`));
  assert.equal((await rig.state()).lifecycle?.cleanup.length ?? 0, 0);
  assert.equal((await rig.post('person-1', 'personal-photo', validJpeg, 'image/jpeg')).status, 303);
  listed = await rig.service.list(rig.tokens['person-1']); html = documentsPage(listed, 'en'); assert.match(html, new RegExp(`JPEG · ${validJpeg.length} bytes`));
  const state = await rig.state(); assert.equal(state.lifecycle?.cleanup.length, 1); assert.equal(state.lifecycle?.cleanup[0]?.status, 'held');
});
test('Q14_1_ONE_PATH uses one authorize, bytes and finalize call', async () => { const result = await invoke(); for (const step of ['authorize','bytes','finalize']) assert.equal(result.calls.filter(x => x === step).length, 1); assert.equal(new Set(result.keys).size, 3); });
test('Q14_1_ONE_PATH client idempotency is ignored and sequential replay conflicts once', async context => {
  const rig = await realRig(context); const form = new FormData(); const submission = `${Date.now()}.${randomUUID()}`;
  form.set('submission', submission); form.set('file', new Blob([validPng], { type: 'image/png' }), 'secret.png');
  const send = () => fetch(`${rig.endpoint}/profile/documents/personal-photo/upload`, { method: 'POST', redirect: 'manual', headers: { cookie: `__Host-studenthub_session=${rig.tokens['person-1']}`, origin, 'idempotency-key': 'client-controlled' }, body: form });
  assert.equal((await send()).status, 303); const second = await send(); assert.equal(second.status, 409); assert.match(await second.text(), /documents changed/i);
  assert.equal((await rig.service.list(rig.tokens['person-1'])).length, 1); assert.equal((await rig.state()).documents.length, 1);
});
test('Q14_1_ONE_PATH concurrent double-click replays one commit as two redirects', async context => {
  const rig = await realRig(context), submission = `${Date.now()}.${randomUUID()}`;
  const send = () => { const form = new FormData(); form.set('submission', submission); form.set('file', new Blob([validPng], { type: 'image/png' }), 'not-retained.png'); return fetch(`${rig.endpoint}/profile/documents/personal-photo/upload`, { method: 'POST', redirect: 'manual', headers: { cookie: `__Host-studenthub_session=${rig.tokens['person-1']}`, origin }, body: form }); };
  const responses = await Promise.all([send(), send()]); assert.deepEqual(responses.map(response => response.status), [303, 303]);
  const state = await rig.state(); assert.equal(state.documents.length, 1); assert.equal(state.lifecycle?.uploads.filter(ticket => ticket.committed).length, 1);
});
test('Q14_1_OWNER cookie and exact origin precede body mutation', async () => { assert.equal((await invoke({ cookie: false })).status, 401); const wrong = await invoke({ origin: 'https://evil.invalid' }); assert.equal(wrong.status, 403); assert.equal(wrong.calls.includes('list'), false); });
test('Q14_1_OWNER cross-site, bearer-only, and unknown slots fail closed', async context => {
  const rig = await realRig(context);
  let response = await fetch(`${rig.endpoint}/profile/documents/personal-photo/upload`, { method: 'POST', headers: { cookie: `__Host-studenthub_session=${rig.tokens['person-1']}`, origin, 'sec-fetch-site': 'cross-site' }, body: 'unread' }); assert.equal(response.status, 403);
  response = await fetch(`${rig.endpoint}/profile/documents/personal-photo/upload`, { method: 'POST', headers: { authorization: `Bearer ${rig.tokens['person-1']}`, origin }, body: 'unread' }); assert.equal(response.status, 401);
  response = await fetch(`${rig.endpoint}/profile/documents/not-a-slot/upload`, { method: 'POST', headers: { cookie: `__Host-studenthub_session=${rig.tokens['person-1']}`, origin }, body: 'unread' }); assert.equal(response.status, 404);
  assert.equal((await rig.state()).documents.length, 0);
});
test('Q14_1_OWNER every live session resolves its own namespace', async context => {
  const rig = await realRig(context);
  const response = await rig.upload('person-2');
  assert.equal(response.status, 303);
  assert.equal((await rig.service.list(rig.tokens['person-2'])).length, 1);
  assert.equal((await rig.service.list(rig.tokens['person-1'])).length, 0);
});
test('Q14_1_SHOWN upload uses one list, authorize, bytes and finalize independent of slot count', async () => { const result = await invoke({ currentVersion: 'old-version' }); assert.deepEqual(result.calls, ['list', 'authorize', 'bytes', 'finalize']); assert.match(documentsPage([{ id: 'i', version: 'v', type: 'personal-photo', mime: 'image/png', size: validPng.length }], 'en'), /On file/); });
