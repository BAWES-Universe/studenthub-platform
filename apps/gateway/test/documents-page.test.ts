import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import { createSyntheticLoginRig } from '@studenthub/login-contract';
import { UnconfiguredApprovedProfileAdapter, OwnProfileRepository } from '@studenthub/profile';
import { FileDocumentStore } from '../../../packages/private-documents/src/index.js';
import { CandidateDocuments, CANDIDATE_DOCUMENT_ADMISSION } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { createIdempotencyKey } from '../../../packages/idempotency-contract/src/index.js';
import { createLoginApplication } from '../src/login-application.js';
import { createGatewayServer } from '../src/index.js';
import type { BrowserLoginApplication } from '../src/web-ui.js';
import { handleCandidateDocuments } from '../src/candidate-documents-http.js';
import { handleDocumentsUpload } from '../src/documents-upload-http.js';
const { handleDocumentsPage, documentsPage } = await import(process.env.SHU366_PAGE_MODULE ?? '../src/documents-page.js');
const SESSION = 's'.repeat(43), OTHER = 'o'.repeat(43), origin = 'https://documents.test.invalid';
async function rig(t: TestContext, language = 'en') {
  const root = await mkdtemp(join(tmpdir(), 'shu366-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = await FileDocumentStore.create(join(root, 'private'));
  const authz = new InMemoryAuthzStore({ organizations: [{ id: 'org-a', name: 'Synthetic' }], principals: ['person-1', 'person-2'].map(id => ({ id, pbuuids: [] })) });
  const loginRig = createSyntheticLoginRig(createLoginApplication);
  await loginRig.sessions.put({ id: SESSION, personId: 'person-1' });
  await loginRig.sessions.put({ id: OTHER, personId: 'person-2' });
  let transactions = 0, lists = 0, deliveries = 0, authorizes = 0, puts = 0, finalizes = 0, broken = false, profileBroken = false, failCommit = false;
  const now = 1_800_000_000_000;
  const service = new CandidateDocuments({ store: { transaction: fn => { transactions++; if (broken) throw new Error('RAW_ERROR private/key https://delivery.invalid?token=secret'); return disk.transaction(async state => { const versions = state.documents.map(row => row.version).join(','); const result = await fn(state); if (failCommit && state.documents.map(row => row.version).join(',') !== versions) { failCommit = false; throw new Error('injected commit failure'); } return result; }); } }, authz, origin, orgId: 'org-a', signingKey: randomBytes(32), now: () => now, authenticate: async credential => {
    const session = await loginRig.sessions.get(credential); return session ? { kind: 'principal', principalId: session.personId } : null;
  } });
  const originalList = service.list.bind(service);
  service.list = async (credential, includeFinalizedAt) => { lists++; return originalList(credential, includeFinalizedAt); };
  const originalAuthorize = service.authorizeUpload.bind(service), originalPut = service.put.bind(service), originalFinalize = service.finalize.bind(service);
  service.authorizeUpload = async (...args) => { authorizes++; return originalAuthorize(...args); };
  service.put = async (...args) => { puts++; return originalPut(...args); };
  service.finalize = async (...args) => { finalizes++; return originalFinalize(...args); };
  service.issueDelivery = async () => { deliveries++; throw new Error('Unexpected delivery'); };
  const repository = new OwnProfileRepository({ principals: authz, source: new UnconfiguredApprovedProfileAdapter(), preferences: { async readOwnPreferences() { return { language: language === 'ar' ? 'ar' : 'en', updatedAt: '2026-11-05T00:00:00Z' }; } } });
  const profileReads: unknown[] = [], sessionReads: unknown[] = [];
  const login: BrowserLoginApplication = { ...loginRig.app, profile: async request => { sessionReads.push(request); return loginRig.app.profile(request); }, web: { origin, returnTo: `${origin}/profile`, profiles: { async readOwn(request) { profileReads.push(request); if (profileBroken) throw new Error('RAW_PROFILE_ERROR'); return repository.readOwn(request); } } } };
  let configured = true;
  const server = createServer(async (request, response) => {
    if (await handleDocumentsUpload(request, response, configured ? service : undefined)) return;
    // Dynamic module seam exercises the genuine page mutant, not a duplicate renderer.
    if (await handleDocumentsPage(request, response, configured ? service : undefined, login)) return;
    if (await handleCandidateDocuments(request, response, configured ? service : undefined, login)) return;
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const get = (path = '/profile/documents', session: string | undefined = SESSION, accept = 'text/html') => fetch(url + path, { headers: { accept, ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}) } });
  return { service, login, loginRig, disk, authz, url, get, profileReads, sessionReads, key: () => createIdempotencyKey(new Date(now)), counts: () => ({ transactions, lists, deliveries, authorizes, puts, finalizes }), unconfigure: () => { configured = false; }, failCommit: () => { failCommit = true; }, breakStore: () => { broken = true; }, breakProfile: () => { profileBroken = true; } };
}
function pdf(): Buffer {
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [i, object] of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'].entries()) { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = text.length;
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
async function finalize(f: Awaited<ReturnType<typeof rig>>, session = SESSION) {
  const bytes = pdf();
  const authorized = await f.service.authorizeUpload(session, f.key(), { type: 'resume', mime: 'application/pdf', size: bytes.length, expectedVersion: null });
  const ticket = authorized.body as { uploadId: string; objectKey: string; credential: string };
  assert.equal(authorized.status, 201);
  assert.equal((await f.service.put(session, f.key(), ticket.uploadId, ticket.objectKey, ticket.credential, bytes)).status, 204);
  const result = await f.service.finalize(session, f.key(), { uploadId: ticket.uploadId });
  assert.equal(result.status, 200);
  return { bytes, result, ticket };
}
async function submissionFor(f: Awaited<ReturnType<typeof rig>>, type: string, session = SESSION): Promise<string> {
  const html = await (await f.get('/profile/documents', session)).text();
  const section = html.split(`id="document-${type}"`)[1]!.split('</form>')[0]!;
  return /name="submission" value="([^"]+)"/.exec(section)![1]!;
}
async function postFile(f: Awaited<ReturnType<typeof rig>>, type: string, bytes: Buffer, mime: string, options: { session?: string; submission?: string; filename?: string } = {}) {
  const session = options.session ?? SESSION;
  const form = new FormData();
  form.set('submission', options.submission ?? await submissionFor(f, type, session));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), options.filename ?? 'browser-name-must-not-escape.bin');
  return fetch(`${f.url}/profile/documents/${type}/upload`, { method:'POST', redirect:'manual', headers:{ cookie:`__Host-studenthub_session=${session}`, origin, 'sec-fetch-site':'same-origin' }, body:form });
}
test('SHU366_PAGE finalized file appears once with closed slots and one list', async t => {
  const f = await rig(t), finalized = await finalize(f);
  const before = f.counts();
  const response = await f.get(); const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="document-resume"[^]*?<strong>On file<\/strong>/, 'SHU366_PAGE finalized slot must be On file');
  assert.equal((html.match(/<strong>On file<\/strong>/g) ?? []).length, 1);
  assert.equal((html.match(/<strong>Not uploaded<\/strong>/g) ?? []).length, 3);
  for (const label of ['Personal photo', 'CV', 'Civil ID front', 'Civil ID back']) assert.ok(html.includes(label));
  assert.ok(html.includes(`PDF · ${finalized.bytes.length} bytes`));
  assert.equal(f.counts().lists - before.lists, 1); assert.equal(f.counts().deliveries, 0);
  for (const row of (await f.disk.transaction(async state => state.documents))) { assert.ok(!html.includes(row.id)); assert.ok(!html.includes(row.version)); }
  assert.doesNotMatch(html, /uploads\/|delivery|<script|Date unavailable|timestamp/);
  assert.equal((html.match(/<form method="post" enctype="multipart\/form-data"/g) ?? []).length, 4);
  assert.match(html, /lang="en" dir="ltr"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('vary'), 'Accept');
  assert.deepEqual(f.profileReads, [{ requesterPrincipalId: 'person-1', targetPersonId: 'person-1' }]);
});
test('SHU366_PAGE empty guidance derives from lifecycle admission', async t => {
  const f = await rig(t); const html = await (await f.get()).text();
  assert.equal((html.match(/<strong>Not uploaded<\/strong>/g) ?? []).length, 4);
  for (const [type, rule] of Object.entries(CANDIDATE_DOCUMENT_ADMISSION)) {
    const section = html.split(`id="document-${type}"`)[1]!.split('</dd>')[0]!;
    assert.ok(section.includes(`${rule.maxBytes / (1024 * 1024)} MiB`));
    for (const mime of rule.mimeTypes) assert.ok(section.includes(({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' } as Record<string, string>)[mime]!));
    assert.match(section, new RegExp(`<form method="post" enctype="multipart/form-data" action="/profile/documents/${type}/upload">`));
    assert.match(section, new RegExp(`<input type="file" name="file" accept="${rule.mimeTypes.join(',')}">`));
    assert.match(section, /<input type="hidden" name="submission" value="[^" ]+">/);
  }
  assert.equal((html.match(/name="file"/g) ?? []).length, 4);
  assert.equal((html.match(/name="submission"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /<script|drag|progress/i);
});
test('SHU366_PAGE session refusal precedes even unconfigured service access', async t => {
  for (const mode of ['missing', 'expired', 'revoked']) {
    const f = await rig(t); f.unconfigure();
    if (mode !== 'missing') await f.loginRig.sessions.delete(SESSION);
    const response = await f.get('/profile/documents?language=ar', mode === 'missing' ? '' : SESSION);
    assert.equal(response.status, 401, mode); const html = await response.text();
    assert.match(html, /Sign in to view your documents/); assert.match(html, /Continue with Universe/);
    assert.deepEqual(f.counts(), { lists: 0, transactions: 0, deliveries: 0, authorizes: 0, puts: 0, finalizes: 0 }); assert.deepEqual(f.profileReads, []);
  }
  const configured = await rig(t); await configured.loginRig.sessions.delete(SESSION);
  assert.equal((await configured.get()).status, 401); assert.equal(configured.counts().transactions, 0);
});
test('SHU366_PAGE trusted EN and AR errors are closed and no data is leaked', async t => {
  for (const language of ['en', 'ar']) {
    const f = await rig(t, language); f.breakStore();
    const response = await f.get(`/profile/documents?language=${language === 'ar' ? 'en' : 'ar'}`); const html = await response.text();
    assert.equal(response.status, 503);
    assert.ok(html.includes(language === 'ar' ? 'المستندات غير متاحة مؤقتًا' : 'Documents are temporarily unavailable'));
    assert.ok(html.includes(`lang="${language}" dir="${language === 'ar' ? 'rtl' : 'ltr'}"`));
    assert.doesNotMatch(html, /RAW_ERROR|private\/key|delivery.invalid|secret/);
    const unavailable = await rig(t, language); unavailable.unconfigure();
    const unconfigured = await unavailable.get(); assert.equal(unconfigured.status, 503); assert.equal(unavailable.counts().transactions, 0);
    assert.ok((await unconfigured.text()).includes(`lang="${language}"`));
  }
  const f = await rig(t); f.breakProfile(); const response = await f.get();
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /RAW_PROFILE_ERROR/); assert.equal(f.counts().transactions, 0);
});
test('SHU366_PAGE queries and request bodies never select identity or locale', async t => {
  const f = await rig(t, 'ar'); await finalize(f, OTHER);
  const path = '/profile/documents?person_id=person-2&principalId=person-2&language=en';
  const response = await f.get(path); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /lang="ar" dir="rtl"/);
  assert.equal((html.match(/<strong>لم يتم الرفع<\/strong>/g) ?? []).length, 4);
  assert.deepEqual(f.sessionReads, [{ sessionId: SESSION }]);
  assert.deepEqual(f.profileReads, [{ requesterPrincipalId: 'person-1', targetPersonId: 'person-1' }]);
  const bodyResponse = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const body = JSON.stringify({ personId: 'person-2', language: 'en' });
    const req = httpRequest(f.url + path, { method: 'GET', headers: { cookie: `__Host-studenthub_session=${SESSION}`, accept: 'text/html', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, text }));
    }); req.on('error', reject); req.end(body);
  });
  assert.equal(bodyResponse.status, 200); assert.match(bodyResponse.text, /lang="ar"/); assert.doesNotMatch(bodyResponse.text, /<strong>محفوظ<\/strong>/);
});
test('SHU366_PAGE escapes dependency values and never serializes metadata', () => {
  const html = documentsPage([{ id: 'FORBIDDEN_ID', version: 'FORBIDDEN_VERSION', type: 'resume', mime: '<img src=x onerror="bad">', size: '<script>bad</script>' as unknown as number }], 'en');
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/); assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|FORBIDDEN_ID|FORBIDDEN_VERSION/);
});

test('UPL_DATE finalized time renders as a plain Asia/Kuwait date', () => {
  const html = documentsPage([{ id:'FORBIDDEN_ID',version:'FORBIDDEN_VERSION',type:'resume',mime:'application/pdf',size:42,finalizedAt:1_800_000_000_000 }], 'en');
  assert.match(html,/PDF · 42 bytes · 15 Jan 2027/);assert.doesNotMatch(html,/1800000000000|FORBIDDEN_ID|FORBIDDEN_VERSION/);
});

test('Q14_1_SHOWN one projected list renders an uploaded slot without per-row reads', () => {
  const html = documentsPage([{ id:'FORBIDDEN_ID',version:'FORBIDDEN_VERSION',type:'civil-id-front',mime:'image/jpeg',size:81,finalizedAt:1_800_000_000_000 }], 'en');
  assert.match(html,/id="document-civil-id-front"[^]*?<strong>On file<\/strong>[^]*?JPEG · 81 bytes/);
  assert.equal((html.match(/<strong>On file<\/strong>/g)??[]).length,1);assert.doesNotMatch(html,/FORBIDDEN_ID|FORBIDDEN_VERSION/);
});
test('SHU366_PAGE methods and Accept are opt-in without store access', async t => {
  const f = await rig(t);
  for (const accept of ['*/*', 'application/json', 'text/html;q=0', 'application/json,text/html']) assert.equal((await f.get('/profile/documents', SESSION, accept)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await fetch(f.url + '/profile/documents', { method, headers: { accept: 'text/html', cookie: `__Host-studenthub_session=${SESSION}` } })).status, 404);
  assert.deepEqual(f.counts(), { lists: 0, transactions: 0, deliveries: 0, authorizes: 0, puts: 0, finalizes: 0 });
  assert.equal((await f.get('/profile/documents-extra')).status, 404);
});

test('SHU366_PAGE real gateway mounts page without changing JSON list', async t => {
  const f = await rig(t); await finalize(f);
  const server = createGatewayServer(undefined, undefined, undefined, f.login, null, undefined, f.service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { cookie: `__Host-studenthub_session=${SESSION}` };
  const page = await fetch(url + '/profile/documents', { headers: { ...headers, accept: 'text/html' } });
  assert.equal(page.status, 200); assert.match(await page.text(), /<strong>On file<\/strong>/);
  const json = await fetch(url + '/candidate-documents', { headers });
  assert.equal(json.status, 200);
  const body = await json.json() as { documents: Record<string, unknown>[] };
  assert.equal(body.documents.length, 1);
  assert.deepEqual(Object.keys(body.documents[0]!).sort(), ['id', 'mime', 'size', 'type', 'version']);
});

test('SHU366_PAGE rejects ambiguous session cookies without store access', async t => {
  const f = await rig(t);
  for (const cookie of [`__Host-studenthub_session=${SESSION}; __Host-studenthub_session=${OTHER}`, `__Host-studenthub_session=${SESSION}; __Host-studenthub_session=${SESSION}`, `__Host-studenthub_session=${SESSION}=extra`]) {
    const response = await fetch(f.url + '/profile/documents', { headers: { accept: 'text/html', cookie } });
    assert.equal(response.status, 401);
  }
  assert.deepEqual(f.counts(), { transactions: 0, lists: 0, deliveries: 0, authorizes: 0, puts: 0, finalizes: 0 });
});

test('SHU366_PAGE concurrent revocation at primitive authentication is sign-in401', async t => {
  const f = await rig(t); await finalize(f);
  const authenticate = f.service.options.authenticate;
  let calls = 0;
  f.service.options.authenticate = async credential => {
    calls++;
    if (calls === 3) await f.loginRig.sessions.delete(SESSION);
    return authenticate(credential);
  };
  const response = await f.get();
  assert.equal(calls, 3, 'revocation reaches the non-empty-list primitive authentication');
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Sign in to view your documents/);
});

test('Q14_1_UPLOAD plain form uploads and renders the finalized file', async t => {
  const f = await rig(t);
  const page = await f.get(), markup = await page.text();
  const section = markup.split('id="document-personal-photo"')[1]!.split('</form>')[0]!;
  const submission = /name="submission" value="([^"]+)"/.exec(section)![1]!;
  const form = new FormData();
  form.set('submission', submission);
  form.set('file', new Blob([new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082','hex'))], { type: 'image/png' }), 'never-shown.png');
  const uploaded = await fetch(f.url + '/profile/documents/personal-photo/upload', { method: 'POST', redirect: 'manual', headers: {
    cookie: `__Host-studenthub_session=${SESSION}`, origin, 'sec-fetch-site': 'same-origin', 'idempotency-key': 'ignored-client-value',
  }, body: form });
  assert.equal(uploaded.status, 303); assert.equal(uploaded.headers.get('location'), '/profile/documents');
  const shown = await (await f.get()).text();
  assert.match(shown, /id="document-personal-photo"[^]*?<strong>On file<\/strong>/);
  assert.doesNotMatch(shown, /never-shown\.png/); assert.match(shown, /PNG/); assert.match(shown, /15 Jan 2027/);
});

test('Q14_1_REFUSALS route admission matrix leaves documents, tickets and cleanup unchanged', async t => {
  const f = await rig(t), goodPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082','hex');
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9','hex');
  const cases: [string, Buffer, string][] = [
    ['personal-photo', Buffer.from('GIF89a'), 'image/gif'], ['personal-photo', pdf(), 'application/pdf'], ['resume', goodPng, 'image/png'],
    ['personal-photo', jpeg, 'image/png'], ['resume', Buffer.from('%PDF-not-a-document'), 'application/pdf'],
    ['personal-photo', goodPng.subarray(0, 24), 'image/png'], ['civil-id-front', jpeg.subarray(0, -2), 'image/jpeg'],
    ['resume', pdf().subarray(0, -8), 'application/pdf'], ['civil-id-back', Buffer.alloc(0), 'image/png'],
  ];
  for (const [type, bytes, mime] of cases) {
    const before = await f.disk.transaction(async state => JSON.stringify({ documents:state.documents, uploads:state.lifecycle?.uploads ?? [], cleanup:state.lifecycle?.cleanup ?? [] }));
    const response = await postFile(f, type, bytes, mime);
    assert.equal(response.status, 400, `${type} ${mime} ${bytes.length}`); const html = await response.text();
    assert.match(html, /Choose a valid file/); assert.match(html, /Back to My documents/);
    const after = await f.disk.transaction(async state => JSON.stringify({ documents:state.documents, uploads:state.lifecycle?.uploads ?? [], cleanup:state.lifecycle?.cleanup ?? [] }));
    assert.equal(after, before, `${type} refusal changed durable state`);
  }
  const rawSubmission = await submissionFor(f, 'personal-photo'), boundary = 'shu503-stateful-refusal';
  const part = (name: string, value: Buffer | string, filename?: string) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n${filename === undefined ? '' : 'Content-Type: image/png\r\n'}\r\n`), Buffer.isBuffer(value) ? value : Buffer.from(value), Buffer.from('\r\n')]);
  const malformed = [
    [part('submission', rawSubmission), part('file', Buffer.alloc(0), '')],
    [part('submission', rawSubmission), part('unknown', 'x'), part('file', goodPng, 'x.png')],
    [part('submission', rawSubmission), part('file', goodPng, 'a.png'), part('file', goodPng, 'b.png')],
  ];
  for (const parts of malformed) {
    const before = await f.disk.transaction(async state => JSON.stringify({ documents:state.documents, uploads:state.lifecycle?.uploads ?? [], cleanup:state.lifecycle?.cleanup ?? [] }));
    const body = Buffer.concat([...parts, Buffer.from(`--${boundary}--`)]);
    const response = await fetch(`${f.url}/profile/documents/personal-photo/upload`, { method:'POST', redirect:'manual', headers:{ cookie:`__Host-studenthub_session=${SESSION}`, origin, 'sec-fetch-site':'same-origin', 'content-type':`multipart/form-data; boundary=${boundary}` }, body });
    assert.equal(response.status, 400); assert.match(await response.text(), /Back to My documents/);
    const after = await f.disk.transaction(async state => JSON.stringify({ documents:state.documents, uploads:state.lifecycle?.uploads ?? [], cleanup:state.lifecycle?.cleanup ?? [] }));
    assert.equal(after, before, 'malformed multipart changed durable state');
  }
});

test('Q14_1_REPLACE failed page commit keeps old size and successful retry holds exactly one old version', async t => {
  const f = await rig(t), old = pdf(), newer = Buffer.concat([pdf().subarray(0, -6), Buffer.from('%pad\n%%EOF\n')]);
  assert.equal((await postFile(f, 'resume', old, 'application/pdf')).status, 303);
  f.failCommit(); const failed = await postFile(f, 'resume', newer, 'application/pdf');
  assert.equal(failed.status, 503); let shown = await (await f.get()).text();
  assert.match(shown, new RegExp(`PDF · ${old.length} bytes`));
  let state = await f.disk.transaction(async value => value); assert.equal(state.documents[0]!.size, old.length); assert.equal(state.lifecycle!.cleanup.length, 0);
  assert.equal((await postFile(f, 'resume', newer, 'application/pdf')).status, 303);
  shown = await (await f.get()).text(); assert.match(shown, new RegExp(`PDF · ${newer.length} bytes`));
  state = await f.disk.transaction(async value => value); assert.equal(state.lifecycle!.cleanup.length, 1); assert.equal(state.lifecycle!.cleanup[0]!.status, 'held');
});

test('Q14_1_ONE_PATH retrying one signed form stores one version and client fields cannot select an owner', async t => {
  const f = await rig(t), bytes = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082','hex');
  const submission = await submissionFor(f, 'personal-photo');
  assert.equal((await postFile(f, 'personal-photo', bytes, 'image/png', { submission })).status, 303);
  assert.equal((await postFile(f, 'personal-photo', bytes, 'image/png', { submission })).status, 303);
  let state = await f.disk.transaction(async value => value); assert.equal(state.documents.length, 1); assert.equal(state.lifecycle!.cleanup.length, 0);
  const otherSubmission = await submissionFor(f, 'civil-id-front', OTHER);
  assert.equal((await postFile(f, 'civil-id-front', bytes, 'image/png', { session:OTHER, submission:otherSubmission })).status, 303);
  const first = await f.service.list(SESSION), second = await f.service.list(OTHER);
  assert.deepEqual(first.map(row => row.type), ['personal-photo']); assert.deepEqual(second.map(row => row.type), ['civil-id-front']);
  state = await f.disk.transaction(async value => value); assert.equal(state.documents.length, 2);
});

test('Q14_1_SHOWN genuine upload has one list authorize bytes finalize regardless of other slots', async t => {
  const f = await rig(t), bytes = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082','hex');
  await finalize(f); const submission = await submissionFor(f, 'civil-id-back'); const before = f.counts();
  assert.equal((await postFile(f, 'civil-id-back', bytes, 'image/png', { submission })).status, 303);
  const after = f.counts(); assert.deepEqual({ list:after.lists-before.lists, authorize:after.authorizes-before.authorizes, put:after.puts-before.puts, finalize:after.finalizes-before.finalizes }, { list:1, authorize:1, put:1, finalize:1 });
  const shown = await (await f.get()).text(); assert.match(shown, /id="document-civil-id-back"[^]*?<strong>On file<\/strong>/);
});
