import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { InMemoryAuthzStore } from '@studenthub/contracts';
import type { LoginSession, SessionStore } from '@studenthub/login-contract';
import { FileDocumentStore } from '../../../packages/private-documents/src/index.js';
import { createOrganizationDocuments } from '../src/organization-documents-runtime.js';

const { handleOrganizationDocuments } = await import(process.env.SHU301_TEST_MODULE ?? '../src/organization-documents-http.js');
const OWNER = 'o'.repeat(43), OTHER = 'x'.repeat(43), ANON = 'a'.repeat(43);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
class Sessions implements SessionStore {
  rows = new Map<string, LoginSession>([[OWNER, { id: OWNER, personId: 'owner' }], [OTHER, { id: OTHER, personId: 'other-owner' }]]);
  async put(row: LoginSession) { this.rows.set(row.id, row); }
  async get(id: string) { return this.rows.get(id); }
  async delete(id: string) { this.rows.delete(id); }
}
async function rig(context: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'shu301-')); context.after(() => rm(dir, { recursive: true, force: true }));
  const store = await FileDocumentStore.create(join(dir, 'documents'));
  const authz = new InMemoryAuthzStore({ organizations: [{ id: 'org-a', name: 'A' }, { id: 'org-b', name: 'B' }], principals: ['owner', 'other-owner'].map(id => ({ id, pbuuids: [] })) });
  await authz.grantMany('owner', [{ orgId: 'org-a', role: 'org-owner', scope: 'self' }]);
  await authz.grantMany('other-owner', [{ orgId: 'org-b', role: 'org-owner', scope: 'self' }]);
  let now = 1_800_000_000_000;
  const configuredOrigin = 'https://documents.example.test';
  const runtime = createOrganizationDocuments({ store, authz, sessions: new Sessions(), origin: configuredOrigin, signingKey: randomBytes(32), now: () => now });
  const server = createServer((request, response) => void handleOrganizationDocuments(request, response, runtime));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, origin: configuredOrigin, runtime, advance: (ms: number) => { now += ms; } };
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
