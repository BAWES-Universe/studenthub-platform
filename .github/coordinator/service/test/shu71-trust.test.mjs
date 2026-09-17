import { gateRecoveryCheck, serviceRecoveryCheck, retirementWindowCheck, activationRecoveryCheck, onceOnlyRestoreCheck, boundedReplayCheck } from './shu71-recovery-checks.mjs';
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
for (const retry of ['resume', 'revoke', 'expire']) test(`transient gate drift refuses false completion then recovers via ${retry}`, t =>
  gateRecoveryCheck(createShu71Production, productionFixture(t, keys), retry));
for (const service of ['shu71-evidence.service', 'shu-supervisor.service']) test(`transient ${service} restart is stopped again on recovery`, t =>
  serviceRecoveryCheck(createShu71Production, productionFixture(t, keys), service));

test('P1 drift after observation but before retirement refuses completion', t =>
  retirementWindowCheck(createShu71Production, productionFixture(t, keys)));
for (const retry of ['resume', 'revoke', 'expire']) test(`P4 activation file recreated after unlink recovers via ${retry}`, t =>
  activationRecoveryCheck(createShu71Production, productionFixture(t, keys), retry));
test('P5 remote restores and archive do not repeat on wedged wakes', t =>
  onceOnlyRestoreCheck(createShu71Production, productionFixture(t, keys)));
for (const retry of ['resume', 'revoke']) test(`P3 automatic replay budget persists across processes; operator ${retry} recovers`, t =>
  boundedReplayCheck(createShu71Production, productionFixture(t, keys), retry));

test('P3 reservation survives interruption and damaged journal cannot reset the budget', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  const dir = `/srv/shu/state/shu71-evidence/${h.id}`;
  const budget = `${dir}/automatic-teardown.json`;
  // Interrupt after the durable reservation, before any safety effect.
  let interrupted = false;
  h.faults.after = event => {
    if (!interrupted && event === `fsync:${dir}` && h.exists(budget)) { interrupted = true; return true; }
    return false;
  };
  const start = h.events.length;
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_BUDGET_RESERVATION_INTERRUPTED');
  assert.equal(JSON.parse(h.read(budget)).attempts, 1, 'B4_BUDGET_RESERVATION_SURVIVES');
  assert.equal(h.events.slice(start).some(e => e.startsWith('command:')), false, 'B4_NO_UNRESERVED_EFFECT');
  h.faults.after = undefined;
  h.write(budget, JSON.stringify({ attempts: 32 }));
  const original = h.read(`${dir}/journal.jsonl`);
  h.write(`${dir}/journal.jsonl`, original + 'torn');
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_RECOVERY_NO_BUDGET_RESET');
  assert.equal(h.read(`${dir}/journal.jsonl`), original + 'torn');
  const recovery = h.read(`${dir}/recovery.jsonl`);
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
  assert.equal(h.read(`${dir}/recovery.jsonl`), recovery, 'B4_RECOVERY_BOUNDED_GROWTH');
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_BUDGET_DAMAGED_JOURNAL_MANUAL_RECOVERY');
});
for (const value of ['not-json', '{"attempts":-1}', '{"attempts":1.5}', '{"attempts":33}']) test(`P3 invalid retry budget refuses automatic effects: ${value}`, async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, value);
  const start = h.events.length;
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_INVALID_BUDGET_REFUSED');
  assert.equal(h.events.slice(start).some(e => e.startsWith('command:') || e.startsWith('api:')), false);
  assert.equal((await create().execute('revoke')).state, 'REVOKED', 'B4_INVALID_BUDGET_MANUAL_RECOVERY');
});
