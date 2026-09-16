import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShu71Production } from '../shu71-production.mjs';
import { openActivationJournal } from '../shu71-journal.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { trustChecks, journalCheck } from './shu71-trust-checks.mjs';
const keys = ephemeralPublicSource();
for (const [name, check] of Object.entries(trustChecks)) test(`trust guard: ${name}`, t => check(createShu71Production, productionFixture(t, keys)));
for (const kind of ['hash', 'link', 'sequence', 'torn', 'custody']) test(`journal guard: ${kind}`, t => journalCheck(openActivationJournal, productionFixture(t, keys), kind));
for (const drift of ['activation', 'supervisor-gate', 'service']) test(`receipt independently observes ${drift}`, async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); await create().execute('revoke');
  if (drift === 'activation') h.write('/srv/shu/state/shu71-activation.json', 'rearmed');
  if (drift === 'supervisor-gate') h.write('/etc/systemd/system/shu-supervisor.service.d/90-shu71.conf', '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0o644);
  if (drift === 'service') h.active.set('shu-supervisor.service', 'active');
  assert.equal((await create().execute('expire')).code, 'ACT_TEARDOWN_DRIFT', 'B4_EACH_PHYSICAL_FACT');
});
test('forged completion diverts to recovery and preserves original evidence', async t => {
  const h = productionFixture(t, keys), file = `/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`;
  await createShu71Production(h.id, h.boundary).execute('run');
  const rows = h.journal(); rows.at(-1).event = 'TEARDOWN_COMPLETE';
  const forged = rows.map(JSON.stringify).join('\n') + '\n'; h.write(file, forged);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('resume')).state, 'REVOKED', 'B4_FORGED_RECOVERY');
  assert.equal(h.read(file), forged, 'B4_FORGED_BYTES_RETAINED');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_FORGED_ACTIVATION_REMOVED');
  assert.match(h.read(file.replace('journal.jsonl', 'recovery.jsonl')), /TEARDOWN_COMPLETE/, 'B4_RECOVERY_EVIDENCE');
});

test('process identity refuses before all production effects', t => {
  const h = productionFixture(t, keys); h.boundary.uid = () => 999;
  assert.throws(() => createShu71Production(h.id, h.boundary), e => e.code === 'ACT_PROCESS_IDENTITY', 'B1_PROCESS_IDENTITY');
  assert.deepEqual(h.events, [], 'B1_IDENTITY_BEFORE_EFFECTS');
});
test('approval file custody refuses before authority or signing', async t => {
  const h = productionFixture(t, keys), file = `/etc/shu/approvals/${h.id}.shu71.json`;
  h.write(file, h.read(file), 0o600, 999);
  await assert.rejects(createShu71Production(h.id, h.boundary).execute('run'), e => e.code === 'ACT_FILE_CUSTODY', 'B1_APPROVAL_CUSTODY');
  assert.equal(h.signatures(), 0);
});
test('fixture ref readback refuses before signing', async t => {
  const h = productionFixture(t, keys), fetch = h.boundary.fetch;
  h.boundary.fetch = (url, opts) => url.endsWith('SHU-140') ? Promise.resolve({ ok: true, text: async () => JSON.stringify({ object: { sha: 'f'.repeat(40) } }) }) : fetch(url, opts);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).code, 'ACT_REF_BINDING', 'B1_REF_BINDING');
  assert.equal(h.signatures(), 0);
});
test('remote ancestry refuses diverged comparison after push', async t => {
  const h = productionFixture(t, keys), fetch = h.boundary.fetch;
  h.boundary.fetch = (url, opts) => url.includes('/compare/') ? Promise.resolve({ ok: true, text: async () => JSON.stringify({ status: 'diverged' }) }) : fetch(url, opts);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).code, 'ACT_REMOTE_ANCESTRY', 'B1_REMOTE_ANCESTRY');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false);
});
test('completed teardown observation fails closed on unreadable gate', async t => {
  const h = productionFixture(t, keys);
  await createShu71Production(h.id, h.boundary).execute('run'); await createShu71Production(h.id, h.boundary).execute('revoke');
  const open = h.boundary.fs.openSync;
  h.boundary.fs.openSync = (file, ...args) => {
    if (file.endsWith('90-shu71.conf')) throw Object.assign(new Error('SECRET_POISON'), { code: 'EACCES' });
    return open(file, ...args);
  };
  const result = await createShu71Production(h.id, h.boundary).execute('revoke');
  assert.equal(result.code, 'ACT_TEARDOWN_DRIFT', 'B4_UNOBSERVABLE_REFUSED');
  assert.doesNotMatch(JSON.stringify(result), /POISON/);
});
test('successor receipt is explicitly historical and does not observe or mutate shared services', async t => {
  const h = productionFixture(t, keys);
  await createShu71Production(h.id, h.boundary).execute('run'); await createShu71Production(h.id, h.boundary).execute('revoke');
  h.write('/srv/shu/state/shu71-evidence/active.json', JSON.stringify({ activation_id: 'successor' }));
  h.write('/srv/shu/state/shu71-activation.json', 'successor');
  const start = h.events.length, result = await createShu71Production(h.id, h.boundary).execute('expire');
  assert.equal(result.receipt_scope, 'retired_episode', 'B4_HISTORICAL_RECEIPT');
  assert.equal(result.physical_teardown_observed, false, 'B4_NO_SUCCESSOR_PHYSICAL_CLAIM');
  assert.equal(h.read('/srv/shu/state/shu71-activation.json'), 'successor');
  assert.equal(h.events.slice(start).some(e => e.startsWith('command:')), false);
});
test('first completion and retry cannot trust successful writes without gate readback', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run');
  const rename = h.boundary.fs.renameSync;
  h.boundary.fs.renameSync = (from, to) => {
    rename(from, to);
    if (to.endsWith('90-shu71.conf')) h.write(to, '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0o644);
  };
  for (const action of ['revoke', 'resume']) {
    const result = await create().execute(action);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_COMPLETION_READBACK');
    assert.ok(result.failures.includes('ACT_TEARDOWN_OBSERVATION'), 'B4_OBSERVATION_FAILURE_RETAINED');
    assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B4_NO_FALSE_COMPLETION_ROW');
  }
});
