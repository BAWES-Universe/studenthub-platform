import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();

test('B1 production composition binds, signs, appends, leases, verifies, transitions, installs and revokes', async t => {
  const h = productionFixture(t, keys);
  const armed = await createShu71Production(h.id, h.boundary).execute('run');
  assert.equal(armed.state, 'ARMED', JSON.stringify({ armed, journal: h.journal() }));
  assert.equal(h.signatures(), 2, 'one logical signing operation signs both required payloads');
  assert.equal(h.journal().filter(e => e.event === 'SIGNING_STARTED').length, 1);
  assert.ok(h.events.some(e => e.includes('--force-with-lease=refs/heads/coordinator/SHU-140:')));
  assert.ok(h.events.some(e => e.includes('/compare/')));
  const resumed = await createShu71Production(h.id, h.boundary).execute('resume');
  assert.equal(resumed.state, 'REVOKED'); assert.equal(h.signatures(), 2);
  const revoked = await createShu71Production(h.id, h.boundary).execute('revoke');
  assert.equal(revoked.state, 'REVOKED', JSON.stringify(revoked));
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false);
  for (const t of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(t.issue_id), t.restore);
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE');
  assert.doesNotMatch(JSON.stringify(h.journal()), /POISON/);
});

test('B4 production expiry performs physical teardown after process replacement', async t => {
  const h = productionFixture(t, keys);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED');
  h.expire();
  const result = await createShu71Production(h.id, h.boundary).execute('expire');
  assert.equal(result.state, 'REVOKED');
  const rows = h.journal();
  assert.ok(rows.findIndex(e => e.event === 'AUTHORIZATION_EXPIRED') < rows.findIndex(e => e.event === 'TEARDOWN_COMPLETE'));
  assert.ok(h.events.some(e => e.includes('kill --kill-whom=all --signal=SIGKILL')));
});

test('B4 cleanup continues after gate failure and one fixture restore failure', async t => {
  const h = productionFixture(t, keys);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED');
  h.faults.before = name => name.includes('90-shu71.conf.pending') || name === 'card:SHU-140';
  const result = await createShu71Production(h.id, h.boundary).execute('revoke');
  assert.equal(result.code, 'ACT_CLEANUP_FAILED');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false);
  assert.deepEqual(h.states.get('SHU-254'), h.spec.pkg.issue_transitions[1].restore);
  assert.ok(h.journal().some(e => e.step === 'teardown:archive' && e.event === 'DONE'));
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(h.journal()), /SECRET_POISON/);
  h.faults.before = null;
  assert.equal((await createShu71Production(h.id, h.boundary).execute('resume')).state, 'REVOKED');
});

test('B4 corrupt journal and missing original approval/package still permit custody-bound recovery', async t => {
  const h = productionFixture(t, keys);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED');
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`, h.read(`/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`) + '{torn');
  h.write(`/etc/shu/approvals/${h.id}.shu71.json`, '{invalid');
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/signed-package.json`, '{invalid');
  const result = await createShu71Production(h.id, h.boundary).execute('resume');
  assert.equal(result.state, 'REVOKED', JSON.stringify(result));
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false);
  assert.ok(h.read(`/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`).endsWith('{torn'), 'torn evidence retained unchanged');
  assert.match(h.read(`/srv/shu/state/shu71-evidence/${h.id}/recovery.jsonl`), /TEARDOWN_COMPLETE/);
  for (const transition of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(transition.issue_id), transition.restore);
});

test('B4 retired expiry cannot revoke a successor activation', async t => {
  const h = productionFixture(t, keys);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED');
  assert.equal((await createShu71Production(h.id, h.boundary).execute('revoke')).state, 'REVOKED');
  h.write('/srv/shu/state/shu71-evidence/active.json', JSON.stringify({ activation_id: 'new-episode' }));
  h.write('/srv/shu/state/shu71-activation.json', 'successor');
  h.expire();
  const start = h.events.length;
  assert.equal((await createShu71Production(h.id, h.boundary).execute('expire')).state, 'REVOKED');
  assert.equal(h.read('/srv/shu/state/shu71-activation.json'), 'successor');
  assert.ok(!h.events.slice(start).some(e => e.startsWith('command:')));
});

test('B1/B4 process replacement before and after every forward mutation and durability boundary', async t => {
  const baseline = productionFixture(t, keys);
  assert.equal((await createShu71Production(baseline.id, baseline.boundary).execute('run')).state, 'ARMED');
  const boundaries = baseline.events.map((name, index) => ({ name, index: index + 1 })).filter(({ name }) =>
    /^(write:|fsync:|rename:|sign$|card:)/.test(name) || name.includes(' update-ref ') || name.includes(' push ') || name.startsWith('command:/usr/bin/systemctl:'));
  for (const phase of ['before', 'after']) for (const boundary of boundaries) {
    const h = productionFixture(t, keys);
    let dead = false;
    h.faults[phase] = () => dead || (dead = h.events.length >= boundary.index);
    // Once dead, *all* effects refuse, including exception-path cleanup. This
    // models process loss, not an exception that conveniently executes finally.
    if (phase === 'after') h.faults.before = () => dead;
    await createShu71Production(h.id, h.boundary).execute('run').catch(() => {});
    const signed = h.signatures();
    h.faults.before = null; h.faults.after = null;
    const result = await createShu71Production(h.id, h.boundary).execute('resume');
    const label = `${phase} ${boundary.index} ${boundary.name}`;
    if (result.state === 'HALT') {
      assert.equal(result.code, 'ACT_SIGNING_AMBIGUOUS', label + JSON.stringify(result));
      assert.equal(result.teardown.state, 'REVOKED', label);
      assert.equal(h.signatures(), signed, label + ': no second key consumption');
    } else assert.ok(['ARMED', 'REVOKED'].includes(result.state), label + JSON.stringify(result));
    if (result.state === 'ARMED') assert.equal((await createShu71Production(h.id, h.boundary).execute('revoke')).state, 'REVOKED', label);
    assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, label);
  }
  t.diagnostic(`${boundaries.length} forward boundaries x before/after = ${boundaries.length * 2} process-death injections`);
});

test('B4 process replacement before and after every teardown mutation and durability boundary', async t => {
  const baseline = productionFixture(t, keys);
  assert.equal((await createShu71Production(baseline.id, baseline.boundary).execute('run')).state, 'ARMED');
  const start = baseline.events.length;
  assert.equal((await createShu71Production(baseline.id, baseline.boundary).execute('revoke')).state, 'REVOKED');
  const boundaries = baseline.events.slice(start).map((name, index) => ({ name, index: index + 1 })).filter(({ name }) =>
    /^(write:|fsync:|rename:|unlink:|card:)/.test(name) || name.startsWith('command:/usr/bin/systemctl:'));
  for (const phase of ['before', 'after']) for (const boundary of boundaries) {
    const h = productionFixture(t, keys);
    assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED');
    const start = h.events.length;
    let dead = false;
    h.faults[phase] = () => dead || (dead = h.events.length >= start + boundary.index);
    if (phase === 'after') h.faults.before = () => dead;
    await createShu71Production(h.id, h.boundary).execute('revoke').catch(() => {});
    h.faults.before = null; h.faults.after = null;
    const result = await createShu71Production(h.id, h.boundary).execute('resume');
    const label = `${phase} ${boundary.index} ${boundary.name}`;
    assert.equal(result.state, 'REVOKED', label + JSON.stringify(result));
    assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, label);
    for (const transition of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(transition.issue_id), transition.restore, label);
  }
  t.diagnostic(`${boundaries.length} teardown boundaries x before/after = ${boundaries.length * 2} process-death injections`);
});

test('B4 fixture cleanup removes only the episode-bound owned attempt and preserves authority', async t => {
  const h = productionFixture(t, keys);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED');
  const attempt = '11111111-1111-4111-8111-111111111111';
  const recordPath = `/srv/shu/state/workspaces/${attempt}.workspace.json`;
  h.write(recordPath, JSON.stringify({ episode_id: h.id, attempt_id: attempt, issue_id: 'SHU-140',
    repo: 'BAWES-Universe/studenthub-platform', branch: 'coordinator/SHU-140' }), 0o600, 999);
  h.write(`/srv/shu/worktrees/${attempt}/result.txt`, 'fixture-only', 0o600, 995);
  // Test boundary models the ordinary workspace owner, never chowns the host.
  const lstat = h.boundary.fs.lstatSync;
  h.boundary.fs.lstatSync = p => {
    const st = lstat(p);
    return p === `/srv/shu/worktrees/${attempt}` ? new Proxy(st, { get(target, key) { return key === 'uid' ? 995 : Reflect.get(target, key); } }) : st;
  };
  h.write('/srv/shu/worktrees/unrelated/keep', 'unrelated');
  const result = await createShu71Production(h.id, h.boundary).execute('revoke');
  assert.equal(result.state, 'REVOKED', JSON.stringify(result));
  assert.equal(h.exists(`/srv/shu/worktrees/${attempt}`), false);
  assert.equal(h.exists(recordPath), true);
  assert.equal(h.read('/srv/shu/worktrees/unrelated/keep'), 'unrelated');
  assert.ok(h.journal().some(e => e.event === 'FIXTURE_REMOVE_INTENT' && e.attempt_id === attempt));
});

// SHU-71 idempotent, receipt-aware teardown (approved window shu71-mint-00000017).
import { preArmTeardownCheck, preArmFixtureCleanupCheck, preArmDriftCheck, workerKillFailureCheck,
  destroyedJournalCheck, phaseInterruptionCheck, lifecyclePhases } from './shu71-recovery-checks.mjs';
import { supervisorAdapterKeys } from '../units.mjs';

test('B4 pre-arm refusal by name completes its own teardown and is re-runnable', async t => {
  await preArmTeardownCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 every documented adapter key halts before arming with a complete teardown', async t => {
  for (const key of supervisorAdapterKeys) {
    const h = productionFixture(t, keys);
    const result = await preArmTeardownCheck(createShu71Production, h, key);
    assert.equal(result.missing_key, key, `B4_PREARM_EVERY_KEY_${key}`);
  }
});

test('B4 pre-arm fixture cleanup is not blocked by a legitimately skipped worker kill', async t => {
  await preArmFixtureCleanupCheck(createShu71Production, productionFixture(t, keys));
});

for (const drift of ['supervisor', 'timer-file', 'timer-active', 'timer-enabled']) {
  test(`B4 pre-arm teardown refuses ${drift} drift by name`, async t => {
    await preArmDriftCheck(createShu71Production, productionFixture(t, keys), drift);
  });
}

test('B4 a refused worker kill is accepted only for a unit measured idle', async t => {
  await workerKillFailureCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a destroyed journal is never proof that nothing was created', async t => {
  await destroyedJournalCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 interruption at every lifecycle phase boundary completes cleanup or halts by name', async t => {
  for (const phase of lifecyclePhases) {
    const result = await phaseInterruptionCheck(createShu71Production, productionFixture(t, keys), phase);
    t.diagnostic(`${phase}: ${JSON.stringify({ ok: result.ok, state: result.state, code: result.code ?? null })}`);
  }
});
