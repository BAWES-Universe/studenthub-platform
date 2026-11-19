import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileDocumentStore, documentReadHydrator } from '../../../dist/packages/private-documents/src/index.js';
const moduleUrl = process.env.PHOTO_MODULE ?? new URL('../../../dist/packages/private-documents/src/personal-photo-source.js', import.meta.url).href;
const { PERSONAL_PHOTO_MAX_BYTES, personalPhotoSource, readPersonalPhoto, openPersonalPhotoSourceFromEnv } = await import(moduleUrl);

const JPEG = Buffer.from([255, 216, 255, 224]);
const doc = (over = {}) => ({ id: randomUUID(), version: randomUUID(), type: 'personal-photo', mime: 'image/jpeg', size: JPEG.length, scope: { orgId: 'org', personId: 'person-1' }, acl: 'private', data: JPEG.toString('base64'), ...over });
const memory = docs => ({ transaction: async fn => fn({ format: 1, documents: structuredClone(docs), retired: [] }) });
const auditLog = (fail = false) => { const views = []; return { views, port: { async recordView(v) { if (fail) throw new Error('audit down'); views.push(v); } } }; };

test('PHOTO_READ the one current photo is returned to the printer, audited first as id_card_render', async () => {
  const d = doc(), audit = auditLog();
  const source = personalPhotoSource({ store: memory([d, doc({ type: 'resume', mime: 'application/pdf' })]), orgId: 'org', audit: audit.port });
  assert.deepEqual(await source.read('person-1', 'staff-9'), { bytes: JPEG, mime: 'image/jpeg', version: d.version });
  assert.deepEqual(audit.views, [{ viewerPrincipalId: 'staff-9', subjectPrincipalId: 'person-1', kind: 'id_card_render', documentType: 'personal-photo', documentVersion: d.version }]);
  const png = doc({ mime: 'image/png' });
  assert.equal((await personalPhotoSource({ store: memory([png]), orgId: 'org', audit: auditLog().port }).read('person-1', 'person-1'))?.mime, 'image/png');
});

test('PHOTO_NONE no photo, two photos, another person or org, a format the card cannot print, or too large reads as none and audits nothing', async () => {
  const cases = [
    ['no photo', []],
    ['two photos', [doc(), doc()]],
    ['another person', [doc({ scope: { orgId: 'org', personId: 'person-2' } })]],
    ['another org', [doc({ scope: { orgId: 'other', personId: 'person-1' } })]],
    ['gif', [doc({ mime: 'image/gif' })]],
    ['declared too large', [doc({ size: PERSONAL_PHOTO_MAX_BYTES + 1 })]],
    ['stored too large', [doc({ data: Buffer.alloc(PERSONAL_PHOTO_MAX_BYTES + 1).toString('base64') })]],
  ];
  for (const [label, docs] of cases) {
    const audit = auditLog();
    // Compared as a boolean: a failure must not print megabytes of photo bytes.
    const got = await personalPhotoSource({ store: memory(docs), orgId: 'org', audit: audit.port }).read('person-1', 'staff-9');
    assert.equal(got === null, true, label);
    assert.equal(audit.views.length, 0, label);
  }
  assert.equal(PERSONAL_PHOTO_MAX_BYTES, 2 * 1024 * 1024);
  const exact = doc({ size: PERSONAL_PHOTO_MAX_BYTES, data: Buffer.alloc(PERSONAL_PHOTO_MAX_BYTES).toString('base64') });
  assert.equal((await readPersonalPhoto(memory([exact]), 'org', 'person-1'))?.bytes.length, PERSONAL_PHOTO_MAX_BYTES, 'exactly the cap is allowed');
  for (const bad of ['', 'a@b', 'x'.repeat(129), '../person-1'])
    assert.equal(await readPersonalPhoto({ transaction: async () => assert.fail('no read for an id that cannot hold documents') }, 'org', bad), null, bad);
});

test('PHOTO_AUDIT when the audit cannot be written no bytes are returned', async () => {
  await assert.rejects(personalPhotoSource({ store: memory([doc()]), orgId: 'org', audit: auditLog(true).port }).read('person-1', 'staff-9'), /audit down/);
});

test('PHOTO_R2 R2-style stores use the read path and hydrate only the photo', async () => {
  const d = doc({ data: 'r2:reference' }); let hydrated = [];
  const store = { transaction: async () => assert.fail('must not lock the store'), readPath: { audit: async () => {}, read: async fn => {
    const copy = { format: 1, documents: [structuredClone(d)], retired: [] };
    Object.defineProperty(copy, documentReadHydrator, { value: async id => { hydrated.push(id); copy.documents[0].data = JPEG.toString('base64'); } });
    return fn(copy);
  } } };
  assert.deepEqual((await readPersonalPhoto(store, 'org', 'person-1'))?.bytes, JPEG);
  assert.deepEqual(hydrated, [d.id]);
});

test('PHOTO_ENV opens the configured document storage, none when unset, and refuses a partial setup', async () => {
  const audit = auditLog();
  assert.equal(await openPersonalPhotoSourceFromEnv(audit.port, { DATABASE_URL: 'postgres://x' }), undefined, 'the database alone is not document storage');
  await assert.rejects(openPersonalPhotoSourceFromEnv(audit.port, { DOCUMENT_STORAGE: 'r2', DOCUMENT_ORG_ID: 'org' }), /invalid document configuration/);
  await assert.rejects(openPersonalPhotoSourceFromEnv(audit.port, { DOCUMENT_STORAGE: 'other', DOCUMENT_ORG_ID: 'org', DOCUMENT_ROOT: '/tmp' }), /invalid document configuration/);
  const root = await mkdtemp(join(tmpdir(), 'shu-photo-'));
  try {
    const path = join(root, 'store'), store = await FileDocumentStore.create(path), d = doc();
    await store.transaction(async s => { s.documents.push(d); });
    const opened = await openPersonalPhotoSourceFromEnv(audit.port, { DOCUMENT_STORAGE: 'synthetic-file', DOCUMENT_ORG_ID: 'org', DOCUMENT_ROOT: path });
    try { assert.deepEqual((await opened.source.read('person-1', 'person-1'))?.bytes, JPEG); } finally { await opened.close(); }
    assert.equal(audit.views.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
