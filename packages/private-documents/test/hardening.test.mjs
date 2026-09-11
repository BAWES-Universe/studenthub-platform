import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closeSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAuthzStore } from '../../../dist/packages/contracts/src/index.js';

const moduleUnderTest = process.env.SHU236_TEST_MODULE
  ?? '../../../dist/packages/private-documents/src/index.js';
const { FileDocumentStore, PrivateDocuments } = await import(moduleUnderTest);

const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC SHU-236\n%%EOF');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const person = Object.freeze({ orgId: 'org-a', personId: 'alice' });
const input = (extra = {}) => ({
  scope: person,
  type: 'resume',
  mime: 'application/pdf',
  bytes: pdf,
  ...extra,
});

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shu236-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'private');
  const store = await FileDocumentStore.create(root);
  const authz = new InMemoryAuthzStore({
    organizations: [
      { id: 'org-a', name: 'A' },
      { id: 'org-b', name: 'B' },
    ],
    principals: ['alice', 'bob', 'owner'].map(id => ({ id, pbuuids: [] })),
  });
  await authz.grantMany('alice', [
    { orgId: 'org-a', role: 'candidate', scope: 'self' },
    { orgId: 'org-b', role: 'candidate', scope: 'self' },
  ]);
  await authz.grantMany('bob', [
    { orgId: 'org-a', role: 'candidate', scope: 'self' },
  ]);
  await authz.grantMany('owner', [
    { orgId: 'org-a', role: 'org-owner', scope: 'self' },
  ]);
  let now = 1_800_000_000_000;
  const options = {
    store,
    authz,
    authenticate: async credential => ['alice', 'bob', 'owner'].includes(credential)
      ? { kind: 'principal', principalId: credential }
      : null,
    signingKey: randomBytes(32),
    origin: 'https://documents.example.test',
    now: () => now,
    ...overrides,
  };
  return {
    root,
    store,
    authz,
    options,
    service: new PrivateDocuments(options),
    setNow(value) { now = value; },
    now: () => now,
  };
}

const denied = promise => assert.rejects(
  promise,
  error => error?.message === 'denied' && error?.code === 'denied',
);
const invalid = promise => assert.rejects(
  promise,
  error => error?.message === 'invalid' && error?.code === 'invalid',
);
const unavailable = promise => assert.rejects(
  promise,
  error => error?.message === 'unavailable' && error?.code === 'unavailable',
);
const snapshot = root => readFile(join(root, 'state.json'), 'utf8');

test('NC-LOCK-RELEASE close rejection cannot skip lock unlink or wedge the committed store', async t => {
  const f = await fixture(t);
  const document = await f.service.upload('alice', input());
  const replacement = Buffer.concat([pdf, Buffer.from('committed')]);
  await f.store.transaction(async state => {
    const descriptors = await readdir('/proc/self/fd');
    const lockDescriptor = await descriptors.reduce(async (foundPromise, descriptor) => {
      const found = await foundPromise;
      if (found !== undefined) return found;
      const target = await readlink(`/proc/self/fd/${descriptor}`).catch(() => '');
      return target === join(f.root, '.lock') ? Number(descriptor) : undefined;
    }, Promise.resolve(undefined));
    assert.ok(Number.isInteger(lockDescriptor), 'the transaction lock descriptor is observable');
    closeSync(lockDescriptor);
    state.documents[0].data = replacement.toString('base64');
    state.documents[0].size = replacement.length;
  });
  await assert.rejects(lstat(join(f.root, '.lock')), { code: 'ENOENT' });
  const committed = await f.store.transaction(async state => state.documents[0]);
  assert.equal(committed.id, document.id);
  assert.equal(committed.data, replacement.toString('base64'));
  assert.equal(committed.size, replacement.length);
});

test('AC-REPLACE-IMMUTABLE replacement cannot change owner, organization, type, or person scope', async t => {
  const f = await fixture(t);
  const document = await f.service.upload('alice', input());
  const before = await snapshot(f.root);
  const attempts = [
    input({ scope: { orgId: 'org-a', personId: 'bob' } }),
    input({ scope: { orgId: 'org-b', personId: 'alice' } }),
    input({ type: 'personal-photo', mime: 'image/png', bytes: png }),
    input({ scope: { orgId: 'org-a' }, type: 'commercial-licence' }),
  ];
  for (const replacement of attempts) {
    await invalid(f.service.replace('alice', document.id, replacement));
    assert.equal(await snapshot(f.root), before);
    await denied(f.service.metadata('bob', document.id));
  }
  assert.deepEqual(await f.service.metadata('alice', document.id), document);
});

test('NC-FS-NLINK a multiply-linked state file fails closed', async t => {
  const f = await fixture(t);
  const document = await f.service.upload('alice', input());
  await link(join(f.root, 'state.json'), join(f.root, 'state-hardlink.json'));
  assert.equal((await stat(join(f.root, 'state.json'))).nlink, 2);
  await unavailable(f.service.metadata('alice', document.id));
});

test('NC-FS-ROOT root directory type, mode, and owner are enforced and mode restoration recovers', async t => {
  const f = await fixture(t);
  const document = await f.service.upload('alice', input());
  await chmod(f.root, 0o755);
  await unavailable(f.service.metadata('alice', document.id));
  await chmod(f.root, 0o700);
  assert.deepEqual(await f.service.metadata('alice', document.id), document);

  const originalGetuid = process.getuid;
  const actualUid = (await stat(f.root)).uid;
  process.getuid = () => actualUid + 1;
  try {
    await unavailable(f.service.metadata('alice', document.id));
  } finally {
    process.getuid = originalGetuid;
  }
  assert.deepEqual(await f.service.metadata('alice', document.id), document);
});

test('NC-CONFIG short signing keys and noncanonical or non-HTTPS origins are rejected', async t => {
  const f = await fixture(t);
  for (const length of [0, 1, 16, 31]) {
    assert.throws(
      () => new PrivateDocuments({ ...f.options, signingKey: Buffer.alloc(length) }),
      /invalid private-document configuration/,
    );
  }
  for (const origin of [
    'http://documents.example.test',
    'https://documents.example.test/path',
    'https://documents.example.test:8443',
    'not a URL',
  ]) {
    assert.throws(
      () => new PrivateDocuments({ ...f.options, origin }),
      /invalid private-document configuration|Invalid URL/,
    );
  }
});

test('NC-STORE-RECORD stored MIME, type, and scope are revalidated before metadata or delivery', async t => {
  const mutations = [
    state => { state.documents[0].mime = 'text/html'; },
    state => { state.documents[0].mime = 'application/pdf\r\nX-Evil: yes'; },
    state => { state.documents[0].type = 'unknown'; },
    state => {
      state.documents[0].type = 'commercial-licence';
      state.documents[0].scope = { orgId: 'org-a', personId: 'alice' };
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    const document = await f.service.upload('alice', input());
    const state = JSON.parse(await snapshot(f.root));
    mutate(state);
    await writeFile(join(f.root, 'state.json'), JSON.stringify(state));
    await unavailable(f.service.metadata('alice', document.id));
  }
});

test('NC-STORE-SIZE stored size must equal decoded byte length', async t => {
  const f = await fixture(t);
  const document = await f.service.upload('alice', input());
  const state = JSON.parse(await snapshot(f.root));
  state.documents[0].size += 1;
  await writeFile(join(f.root, 'state.json'), JSON.stringify(state));
  await unavailable(f.service.metadata('alice', document.id));
});

test('NC-CRED-TYPE the service rejects non-string, empty, and oversized credentials before authentication', async t => {
  let authenticateCalls = 0;
  const f = await fixture(t, {
    authenticate: async () => {
      authenticateCalls += 1;
      return { kind: 'principal', principalId: 'alice' };
    },
  });
  const document = await f.service.upload('synthetic-session', input());
  const before = authenticateCalls;
  for (const credential of [null, undefined, 7, {}, [], Buffer.from('alice'), '', 'x'.repeat(8193)]) {
    await denied(f.service.metadata(credential, document.id));
  }
  assert.equal(authenticateCalls, before, 'invalid credential shapes never reach authenticate');
});

test('NC-CLOCK-REWIND delivery claims issued in the future are denied', async t => {
  const f = await fixture(t);
  const document = await f.service.upload('alice', input());
  const link = await f.service.issueDelivery('alice', document.id, 60);
  f.setNow(f.now() - 1);
  await denied(f.service.deliver('alice', link.url));
});

test('NC-RETIRED-UNREACHABLE retired records cannot be reached through any public operation', async t => {
  const f = await fixture(t);
  const original = await f.service.upload('alice', input());
  const oldLink = await f.service.issueDelivery('alice', original.id);
  await f.service.replace('alice', original.id, input({ bytes: Buffer.concat([pdf, Buffer.from('new')]) }));
  await f.service.remove('alice', original.id);

  await denied(f.service.metadata('alice', original.id));
  await denied(f.service.issueDelivery('alice', original.id));
  await denied(f.service.copy('alice', original.id, person));
  await denied(f.service.replace('alice', original.id, input()));
  await denied(f.service.remove('alice', original.id));
  await denied(f.service.deliver('alice', oldLink.url));
});
