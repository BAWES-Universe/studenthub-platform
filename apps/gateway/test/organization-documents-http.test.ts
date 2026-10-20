import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import type { LoginSession, SessionStore } from '@studenthub/login-contract';
import { FileDocumentStore, PrivateDocuments } from '../../../packages/private-documents/src/index.js';
import { createOrganizationDocuments } from '../src/organization-documents-runtime.js';

const { handleOrganizationDocuments } = await import(process.env.SHU301_TEST_MODULE ?? '../src/organization-documents-http.js');
const OWNER = 'o'.repeat(43), OTHER = 'x'.repeat(43), CANDIDATE = 'c'.repeat(43), ANON = 'a'.repeat(43);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
class Sessions implements SessionStore {
  rows = new Map<string, LoginSession>([[OWNER, { id: OWNER, personId: 'owner' }], [OTHER, { id: OTHER, personId: 'other-owner' }], [CANDIDATE, { id: CANDIDATE, personId: 'candidate' }]]);
  async put(row: LoginSession) { this.rows.set(row.id, row); }
  async get(id: string) { return this.rows.get(id); }
  async delete(id: string) { this.rows.delete(id); }
}
async function rig(context: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'shu301-')); context.after(() => rm(dir, { recursive: true, force: true }));
  const store = await FileDocumentStore.create(join(dir, 'documents'));
  const authz = new InMemoryAuthzStore({ organizations: [{ id: 'org-a', name: 'A' }, { id: 'org-b', name: 'B' }], principals: ['owner', 'other-owner', 'candidate'].map(id => ({ id, pbuuids: [] })) });
  await authz.grantMany('owner', [{ orgId: 'org-a', role: 'org-owner', scope: 'self' }]);
  await authz.grantMany('other-owner', [{ orgId: 'org-b', role: 'org-owner', scope: 'self' }]);
  await authz.grantMany('candidate', [{ orgId: 'org-a', role: 'candidate', scope: 'self' }]);
  let now = 1_800_000_000_000;
  const configuredOrigin = 'https://documents.example.test';
  const sessions = new Sessions(); const signingKey = randomBytes(32);
  const runtime = createOrganizationDocuments({ store, authz, sessions, origin: configuredOrigin, signingKey, now: () => now });
  const candidate = new PrivateDocuments({ store, authz, signingKey, origin: configuredOrigin, now: () => now, authenticate: async credential => {
    const session = await sessions.get(credential); return session ? { kind: 'principal', principalId: session.personId } : null;
  } });
  const server = createServer((request, response) => void handleOrganizationDocuments(request, response, runtime));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, origin: configuredOrigin, runtime, candidate, advance: (ms: number) => { now += ms; } };
}
const headers = (origin: string, session = OWNER) => ({ cookie: `__Host-studenthub_session=${session}`, origin, 'content-type': 'application/json' });
const body = (type: 'company-logo' | 'commercial-licence' = 'company-logo', bytes = png) => ({ orgId: 'org-a', type, mime: type === 'company-logo' ? 'image/png' : 'application/pdf', data: bytes.toString('base64') });
async function upload(endpoint: string, origin: string) {
  const response = await fetch(`${endpoint}/organization-documents/upload`, { method: 'POST', headers: headers(origin), body: JSON.stringify(body()) });
  assert.equal(response.status, 201); return response.json() as Promise<{ id: string; version: string }>;
}

test('SHU-301 private-delivery negative-control ', async context => {
  const { endpoint, origin, advance } = await rig(context); const document = await upload(endpoint, origin);
  let response = await fetch(`${endpoint}/organization-documents/delivery?documentId=${document.id}`, { headers: { cookie: `__Host-studenthub_session=${OWNER}` } });
  assert.equal(response.status, 404);
  response = await fetch(`${endpoint}/organization-documents/delivery`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ documentId: document.id }) });
  assert.equal(response.status, 200); const delivery = await response.json() as { url: string; expiresAt: number };
  assert.deepEqual(Object.keys(delivery).sort(), ['expiresAt', 'url']); assert.match(delivery.url, /^https:\/\/documents\.example\.test\/organization-documents\/delivery\?t=/);
  const deliveryPath = new URL(delivery.url).pathname + new URL(delivery.url).search;
  response = await fetch(endpoint + deliveryPath, { headers: { cookie: `__Host-studenthub_session=${OWNER}` } }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  advance(60_000); response = await fetch(endpoint + deliveryPath, { headers: { cookie: `__Host-studenthub_session=${OWNER}` } }); assert.equal(response.status, 404);
});

test('SHU-301 response-whitelist ', async context => {
  const { endpoint, origin } = await rig(context); const created = await upload(endpoint, origin);
  let response = await fetch(`${endpoint}/organization-documents/replace`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ documentId: created.id, ...body() }) });
  assert.equal(response.status, 200); const replaced = await response.json() as Record<string, unknown>;
  for (const value of [created, replaced]) assert.deepEqual(Object.keys(value).sort(), ['id', 'mime', 'size', 'type', 'version']);
  response = await fetch(`${endpoint}/organization-documents/remove`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ documentId: created.id }) });
  assert.equal(response.status, 200); assert.deepEqual(Object.keys(await response.json()).sort(), ['id', 'mime', 'size', 'type', 'version']);
});

test('SHU-301 cross-site-upload ', async context => {
  const { endpoint, origin } = await rig(context);
  for (const originHeader of ['https://attacker.invalid', '']) {
    const response = await fetch(`${endpoint}/organization-documents/upload`, { method: 'POST', headers: { ...headers(origin), origin: originHeader }, body: JSON.stringify(body()) });
    assert.equal(response.status, 403);
  }
  const response = await fetch(`${endpoint}/organization-documents/upload`, { method: 'POST', headers: { ...headers(origin), 'sec-fetch-site': 'cross-site' }, body: JSON.stringify(body()) });
  assert.equal(response.status, 403);
});

test('SHU-301 non-owner ', async context => {
  const { endpoint, origin } = await rig(context); const document = await upload(endpoint, origin);
  for (const session of [OTHER, ANON]) {
    const response = await fetch(`${endpoint}/organization-documents/delivery`, { method: 'POST', headers: headers(origin, session), body: JSON.stringify({ documentId: document.id }) });
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
  }
  const crossOrg = await fetch(`${endpoint}/organization-documents/upload`, { method: 'POST', headers: headers(origin, OTHER), body: JSON.stringify(body()) });
  assert.equal(crossOrg.status, 404); assert.deepEqual(await crossOrg.json(), { error: 'not_found' });
});

test('SHU-301 organization route rejects candidate documents ', async context => {
  const { endpoint, origin, candidate } = await rig(context);
  const document = await candidate.upload(CANDIDATE, { scope: { orgId: 'org-a', personId: 'candidate' }, type: 'personal-photo', mime: 'image/png', bytes: png });
  const candidateDelivery = await candidate.issueDelivery(CANDIDATE, document.id);
  const replay = new URL(candidateDelivery.url); replay.pathname = '/organization-documents/delivery';
  let response = await fetch(endpoint + replay.pathname + replay.search, { headers: { cookie: `__Host-studenthub_session=${CANDIDATE}` } });
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
  for (const route of ['delivery', 'remove']) {
    response = await fetch(`${endpoint}/organization-documents/${route}`, { method: 'POST', headers: headers(origin, CANDIDATE), body: JSON.stringify({ documentId: document.id }) });
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
  }
  assert.deepEqual(await candidate.metadata(CANDIDATE, document.id), document);
});

test('SHU329_DOCS_DELETED deleted organization refuses every document operation ', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'shu329-')); context.after(() => rm(dir, { recursive: true, force: true }));
  const store = await FileDocumentStore.create(join(dir, 'documents'));
  const authz = new InMemoryAuthzStore({
    organizations: [{ id: 'parent', name: 'Parent' }, { id: 'child', name: 'Child', parentOrgId: 'parent' }],
    principals: [{ id: 'owner', pbuuids: [] }],
  });
  await authz.grantMany('owner', [{ orgId: 'parent', role: 'org-owner', scope: 'subtree' }]);
  const deleted = new Set<string>();
  const service = createOrganizationDocuments({
    store, authz, sessions: new Sessions(), origin: 'https://documents.example.test', signingKey: randomBytes(32),
    organizationDeleted: async orgId => deleted.has(orgId),
  }).service;
  const input = (orgId: string) => ({ scope: { orgId }, type: 'company-logo' as const, mime: 'image/png', bytes: png });
  const child = await service.upload(OWNER, input('child'));
  const parent = await service.upload(OWNER, input('parent'));
  const delivery = await service.issueDelivery(OWNER, child.id);
  deleted.add('child');
  const before = await store.transaction(async state => structuredClone(state));
  const denied = async (operation: Promise<unknown>) => assert.rejects(operation, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'denied');
  await denied(service.upload(OWNER, input('child')));
  await denied(service.metadata(OWNER, child.id));
  await denied(service.copy(OWNER, child.id, { orgId: 'parent' }));
  await denied(service.copy(OWNER, parent.id, { orgId: 'child' }));
  await denied(service.replace(OWNER, child.id, input('child')));
  await denied(service.remove(OWNER, child.id));
  await denied(service.issueDelivery(OWNER, child.id));
  await denied(service.deliver(OWNER, delivery.url));
  assert.deepEqual(await store.transaction(async state => structuredClone(state)), before);
  assert.deepEqual(await service.metadata(OWNER, parent.id), parent);
  assert.equal((await service.upload(OWNER, input('parent'))).type, 'company-logo');
});

test('SHU329_DOCS_PORT deletion port failure is unavailable and an omitted port preserves access ', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'shu329-port-')); context.after(() => rm(dir, { recursive: true, force: true }));
  const store = await FileDocumentStore.create(join(dir, 'documents'));
  const authz = new InMemoryAuthzStore({ organizations: [{ id: 'org-a', name: 'A' }], principals: [{ id: 'owner', pbuuids: [] }] });
  await authz.grantMany('owner', [{ orgId: 'org-a', role: 'org-owner', scope: 'self' }]);
  const common = { store, authz, sessions: new Sessions(), origin: 'https://documents.example.test', signingKey: randomBytes(32) };
  const legacy = createOrganizationDocuments(common).service;
  const input = { scope: { orgId: 'org-a' }, type: 'company-logo' as const, mime: 'image/png', bytes: png };
  const document = await legacy.upload(OWNER, input);
  assert.deepEqual(await legacy.metadata(OWNER, document.id), document);
  const unavailable = createOrganizationDocuments({ ...common, organizationDeleted: async () => { throw new Error('database offline'); } }).service;
  await assert.rejects(unavailable.metadata(OWNER, document.id), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unavailable');
});
