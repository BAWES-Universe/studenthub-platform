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
  let transactions = 0, lists = 0, deliveries = 0, broken = false, profileBroken = false;
  const now = 1_800_000_000_000;
  const service = new CandidateDocuments({ store: { transaction: fn => { transactions++; if (broken) throw new Error('RAW_ERROR private/key https://delivery.invalid?token=secret'); return disk.transaction(fn); } }, authz, origin, orgId: 'org-a', signingKey: randomBytes(32), now: () => now, authenticate: async credential => {
    const session = await loginRig.sessions.get(credential); return session ? { kind: 'principal', principalId: session.personId } : null;
  } });
  const originalList = service.list.bind(service);
  service.list = async credential => { lists++; return originalList(credential); };
  service.issueDelivery = async () => { deliveries++; throw new Error('Unexpected delivery'); };
  const repository = new OwnProfileRepository({ principals: authz, source: new UnconfiguredApprovedProfileAdapter(), preferences: { async readOwnPreferences() { return { language: language === 'ar' ? 'ar' : 'en', updatedAt: '2026-11-05T00:00:00Z' }; } } });
  const profileReads: unknown[] = [], sessionReads: unknown[] = [];
  const login: BrowserLoginApplication = { ...loginRig.app, profile: async request => { sessionReads.push(request); return loginRig.app.profile(request); }, web: { origin, returnTo: `${origin}/profile`, profiles: { async readOwn(request) { profileReads.push(request); if (profileBroken) throw new Error('RAW_PROFILE_ERROR'); return repository.readOwn(request); } } } };
  let configured = true;
  const server = createServer(async (request, response) => {
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
  return { service, login, loginRig, disk, authz, url, get, profileReads, sessionReads, key: () => createIdempotencyKey(new Date(now)), counts: () => ({ transactions, lists, deliveries }), unconfigure: () => { configured = false; }, breakStore: () => { broken = true; }, breakProfile: () => { profileBroken = true; } };
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
  assert.equal((html.match(/type="file" name="file"/g) ?? []).length, 4);
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
  }
});
test('SHU366_PAGE session refusal precedes even unconfigured service access', async t => {
  for (const mode of ['missing', 'expired', 'revoked']) {
    const f = await rig(t); f.unconfigure();
    if (mode !== 'missing') await f.loginRig.sessions.delete(SESSION);
    const response = await f.get('/profile/documents?language=ar', mode === 'missing' ? '' : SESSION);
    assert.equal(response.status, 401, mode); const html = await response.text();
    assert.match(html, /Sign in to view your documents/); assert.match(html, /Continue with Universe/);
    assert.deepEqual(f.counts(), { lists: 0, transactions: 0, deliveries: 0 }); assert.deepEqual(f.profileReads, []);
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
test('SHU366_PAGE methods and Accept are opt-in without store access', async t => {
  const f = await rig(t);
  for (const accept of ['*/*', 'application/json', 'text/html;q=0', 'application/json,text/html']) assert.equal((await f.get('/profile/documents', SESSION, accept)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await fetch(f.url + '/profile/documents', { method, headers: { accept: 'text/html', cookie: `__Host-studenthub_session=${SESSION}` } })).status, 404);
  assert.deepEqual(f.counts(), { lists: 0, transactions: 0, deliveries: 0 });
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
  assert.deepEqual(f.counts(), { transactions: 0, lists: 0, deliveries: 0 });
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
