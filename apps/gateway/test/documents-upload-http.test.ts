import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import { FileDocumentStore } from '../../../packages/private-documents/src/index.js';
import { createCandidateDocuments } from '../src/candidate-documents-runtime.js';
import { createGatewayServer } from '../src/index.js';
import { documentsPage } from '../src/documents-page.js';
const { handleDocumentsUpload } = await import(process.env.SHU548_UPLOAD_MODULE ?? '../src/documents-upload-http.js');

const session = 's'.repeat(43), origin = 'https://documents.test.invalid';
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64');

async function realRig(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'shu548-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileDocumentStore.create(join(root, 'documents'));
  const authz = new InMemoryAuthzStore({
    organizations: [{ id: 'documents-org', name: 'Documents' }],
    principals: [{ id: 'person-1', pbuuids: [] }, { id: 'person-2', pbuuids: [] }],
  });
  for (const personId of ['person-1', 'person-2']) await authz.grantMany(personId, [{ orgId: 'documents-org', role: 'candidate', scope: 'self' }]);
  const tokens = { 'person-1': randomBytes(32).toString('base64url'), 'person-2': randomBytes(32).toString('base64url') };
  const rows = new Map(Object.entries(tokens).map(([personId, id]) => [id, { id, personId }]));
  const sessions = { get: async (id: string) => rows.get(id), put: async (row: { id: string; personId: string }) => { rows.set(row.id, row); }, delete: async (id: string) => { rows.delete(id); } };
  const service = createCandidateDocuments({ store, authz, sessions, origin, orgId: 'documents-org', signingKey: randomBytes(32) });
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
  return { service, store, tokens, upload };
}
function body(extra = ''): { boundary: string; bytes: Buffer } {
  const boundary = 'shu548boundary';
  const submission = `${Date.now()}.${randomUUID()}`;
  const text = `--${boundary}\r\nContent-Disposition: form-data; name="submission"\r\n\r\n${submission}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.png"\r\nContent-Type: image/png\r\n\r\nPNG${extra}\r\n--${boundary}--\r\n`;
  return { boundary, bytes: Buffer.from(text) };
}
async function invoke(options: { origin?: string; cookie?: boolean; raw?: Buffer; chunks?: Iterable<Buffer>; omitLength?: boolean; contentType?: string; currentVersion?: string } = {}) {
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
test('Q14_1_REFUSALS malformed multipart stores nothing', async () => { const result = await invoke({ raw: Buffer.from('bad') }); assert.equal(result.status, 400); assert.equal(result.calls.includes('authorize'), false); });
test('Q14_1_REPLACE keeps finalize as the committing step', async () => { const result = await invoke({ currentVersion: 'old-version' }); assert.deepEqual(result.calls.slice(-3), ['authorize','bytes','finalize']); assert.equal(result.expectedVersion, 'old-version'); });
test('Q14_1_ONE_PATH uses one authorize, bytes and finalize call', async () => { const result = await invoke(); for (const step of ['authorize','bytes','finalize']) assert.equal(result.calls.filter(x => x === step).length, 1); assert.equal(new Set(result.keys).size, 3); });
test('Q14_1_OWNER cookie and exact origin precede body mutation', async () => { assert.equal((await invoke({ cookie: false })).status, 401); const wrong = await invoke({ origin: 'https://evil.invalid' }); assert.equal(wrong.status, 403); assert.equal(wrong.calls.includes('list'), false); });
test('Q14_1_OWNER every live session resolves its own namespace', async context => {
  const rig = await realRig(context);
  const response = await rig.upload('person-2');
  assert.equal(response.status, 303);
  assert.equal((await rig.service.list(rig.tokens['person-2'])).length, 1);
  assert.equal((await rig.service.list(rig.tokens['person-1'])).length, 0);
});
test('Q14_1_SHOWN rendering remains a fixed four-slot projection', () => { assert.equal((documentsPage([], 'en').match(/id="document-/g) ?? []).length, 4); });
