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
  destroyedJournalCheck, strictKillModelCheck, phaseInterruptionCheck, lifecyclePhases } from './shu71-recovery-checks.mjs';
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

// P154D-02/P154D-04 extend this list with the COMPANION's own three terms and
// with the two states the previous fixture could not represent at all: a unit
// whose durable file is gone while a leftover <target>.wants/ install symlink
// still answers for its enablement, and a unit file that is on disk but absent
// from systemd's loaded view.
for (const drift of ['supervisor', 'timer-file', 'timer-active', 'timer-enabled', 'both-files', 'service-file',
  'service-active', 'service-enabled-link', 'service-disabled-link', 'timer-enabled-link', 'service-file-stale-view']) {
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

test('B4 a unit that holds no processes still completes its teardown', async t => {
  await strictKillModelCheck(createShu71Production, productionFixture(t, keys));
});

// SHU-71 expiry retirement drift (blocking correction lane). The merged
// revision checked nothing at all when `disable --now` succeeded for a
// journal-proven installed timer, and never removed either durable unit file.
import * as production from '../shu71-production.mjs';
import { expiryFileDriftCheck, expiryRetirementCheck, expiryDisableFailureCheck, expiryCachedViewCheck,
  expiryPostConditionCheck, recoveredNonCreationCheck, teardownOrderCheck, fixturesRequireWorkersCheck,
  predicateRefusalCheck, expiryCustodyDriftCheck, expiryPostReloadDriftCheck, expiryInterruptedRemovalCheck,
  expiryInterruptedCustodyDriftCheck, expiryDisableExitFailureCheck, expiryActivePostConditionCheck,
  expiryEnabledPostConditionCheck, expiryUninstalledDisableCheck, expiryInstalledBeforeArmedCheck,
  expiryJournalBlindCustodyCheck, expiryAbsenceAccountedCheck, expiryVanishedMechanismCheck,
  expiryUnlinkCustodyCheck, expiryLiveCompanionCheck, expiryArmedWithoutDoneRowCheck,
  fixtureHostStateCheck, expiryCompanionActivePostConditionCheck,
  expiryCompanionEnabledPostConditionCheck, expirySelfRunCompletesCheck,
  expirySelfRunHidesNothingCheck, expirySelfRunPostConditionParityCheck } from './shu71-recovery-checks.mjs';

for (const unit of ['timer', 'service']) {
  test(`B4 a journal-proven installed expiry ${unit} file that vanished halts before disabling`, async t => {
    await expiryFileDriftCheck(createShu71Production, productionFixture(t, keys), unit);
  });
}

test('B4 a completed expiry retirement removes both durable unit files and repeats inertly', async t => {
  await expiryRetirementCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a disable that throws is a refusal by name, never a silent retirement', async t => {
  await expiryDisableFailureCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a cached systemd unit view is refreshed and re-measured before retirement completes', async t => {
  await expiryCachedViewCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a recovered log is never proof that the expiry mechanism was not created', async t => {
  await recoveredNonCreationCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 the reviewed teardown effect order is durable in the journal', async t => {
  await teardownOrderCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 fixture cleanup refuses until the worker kill reaches its durable DONE row', async t => {
  await fixturesRequireWorkersCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a disable that reports success while the unit stays live is drift', async t => {
  await expiryPostConditionCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a refusal predicate that throws is still the named refusal', () => {
  predicateRefusalCheck(production);
});

// Correction round: the custody half of the same pre-condition, one control per
// term, and the refusal that measures the end state after the daemon-reload.
for (const variant of ['non-root-owner', 'non-root-group', 'group-writable', 'world-writable', 'non-regular-file']) {
  test(`B4 an installed expiry unit file replaced by a ${variant} one halts before disabling`, async t => {
    await expiryCustodyDriftCheck(createShu71Production, productionFixture(t, keys), variant);
  });
}

// The remaining custody term, on each durable unit file in turn: another name
// in the filesystem still refers to the inode systemd loaded, so unlinking the
// unit path would leave that name - and whoever holds it - with the file.
for (const unit of ['timer', 'service']) {
  test(`B4 an installed expiry ${unit} unit file with a second hard link halts before disabling`, async t => {
    await expiryCustodyDriftCheck(createShu71Production, productionFixture(t, keys), `hardlinked-${unit}`);
  });
}

test('B4 an expiry mechanism still present after the reload is refused, never reported retired', async t => {
  await expiryPostReloadDriftCheck(createShu71Production, productionFixture(t, keys));
});

// Second correction round: the retry path. The durable removal receipt proves
// this teardown began unlinking - so an absent unit file is our own work - and
// nothing more. A unit file still present on the retry is measured for custody
// exactly as on the first pass, and the receipt's position before the loop is
// what makes the retry distinguishable from foreign drift at all.
test('B4 a teardown interrupted inside the removal loop retries on its durable receipt', async t => {
  await expiryInterruptedRemovalCheck(createShu71Production, productionFixture(t, keys));
});

for (const unit of ['timer', 'service']) {
  test(`B4 the removal receipt never waives custody of a present expiry ${unit} unit file`, async t => {
    await expiryInterruptedCustodyDriftCheck(createShu71Production, productionFixture(t, keys), unit);
  });
}

test('B4 a disable that exits non-zero for an installed timer is a refusal, not a retirement', async t => {
  await expiryDisableExitFailureCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a disable that leaves the expiry unit active but not enabled is drift', async t => {
  await expiryActivePostConditionCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a disable that leaves the expiry unit enabled but not active is drift', async t => {
  await expiryEnabledPostConditionCheck(createShu71Production, productionFixture(t, keys));
});

for (const variant of ['retired', 'present']) {
  test(`B4 a disable refused where the journal cannot vouch for the installation, mechanism ${variant}`, async t => {
    await expiryUninstalledDisableCheck(createShu71Production, productionFixture(t, keys), variant);
  });
}

test('B4 an expiry mechanism installed but not yet ARMED is still journal-proven installed', async t => {
  await expiryInstalledBeforeArmedCheck(createShu71Production, productionFixture(t, keys));
});

// Third correction round, P154C-01. The custody measurement is a property of
// the REMOVAL and is conditioned on nothing; the journal may only account for
// ABSENCE. These controls reach a present, drifted durable unit file in each
// journal state that used to skip the pre-condition entirely, and the absence
// rule in the same states.
for (const variant of ['non-root-owner', 'non-root-group', 'group-writable', 'world-writable', 'non-regular-file', 'hardlinked-timer', 'hardlinked-service']) {
  test(`B4 an install interrupted before its durable row still holds a present expiry unit file in custody, ${variant}`, async t => {
    await expiryJournalBlindCustodyCheck(createShu71Production, productionFixture(t, keys), 'interrupted-install', variant);
  });
}

for (const variant of ['hardlinked-timer', 'hardlinked-service']) {
  test(`B4 a recovered log never waives custody of a present expiry unit file, ${variant}`, async t => {
    await expiryJournalBlindCustodyCheck(createShu71Production, productionFixture(t, keys), 'recovered', variant);
  });
}

for (const [state, shape] of [['interrupted-install', 'retired'], ['interrupted-install', 'half'], ['recovered', 'half']]) {
  test(`B4 a journal that accounts for nothing excuses expiry absence only when measurably retired, ${state} ${shape}`, async t => {
    await expiryAbsenceAccountedCheck(createShu71Production, productionFixture(t, keys), state, shape);
  });
}

for (const proof of ['armed', 'done-row']) {
  test(`B4 a journal-proven installed expiry mechanism that vanished entirely is drift, ${proof}`, async t => {
    await expiryVanishedMechanismCheck(createShu71Production, productionFixture(t, keys), proof);
  });
}

test('B4 expiry custody is measured again immediately before the unlink', async t => {
  await expiryUnlinkCustodyCheck(createShu71Production, productionFixture(t, keys));
});

// Fourth correction round, P154D-02. The mechanism is TWO units: the timer only
// exists to start the companion service, and `disable --now <timer>` does not
// touch that service. These reach a measurably RUNNING companion through each
// door it is reachable by - the journal-proven installed state, the verifier's
// own journal-blind state, and the retired episode's receipt path - and require
// a refusal that carries the companion's own name instead of `ok:true`.
for (const state of ['installed', 'journal-blind', 'retired-episode', 'foreign-invocation']) {
  test(`B4 a measurably running expiry companion service is never a clean retirement, ${state}`, async t => {
    await expiryLiveCompanionCheck(createShu71Production, productionFixture(t, keys), state);
  });
}

test('B4 a disable that leaves the expiry companion service active is drift', async t => {
  await expiryCompanionActivePostConditionCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a disable that leaves the expiry companion service enabled is drift', async t => {
  await expiryCompanionEnabledPostConditionCheck(createShu71Production, productionFixture(t, keys));
});

// P154D-01. The ARMED disjunct of `installed`, pinned rather than declared
// equivalent: the reader accepts a chain-valid recovered log holding ARMED
// without the creating step's durable DONE row, which no writer here produces.
test('B4 a chain-valid recovered log holding ARMED proves the expiry mechanism was installed', async t => {
  await expiryArmedWithoutDoneRowCheck(createShu71Production, productionFixture(t, keys));
});

// P154D-04. The fixture's own fidelity is falsifiable: every host state these
// controls claim to model is driven against the modelled host and fails by its
// own name if the model cannot represent it.
test('B4 the modelled host represents every expiry unit state these controls claim', t => {
  fixtureHostStateCheck(productionFixture(t, keys));
});

// P154D-06. The mechanism this teardown must prove gone is the expiry mechanism
// MINUS the invocation performing the removal. The timer's `Unit=` names
// `shu71-expiry-<id>.service`, whose `ExecStart` is this module's `expire <id>`,
// so on the only unattended path the mechanism exists for the companion service
// IS the process performing the teardown and reports `activating`. These pin
// both directions of the bound: the self-run completes, the same episode still
// measures fully retired from a vantage that excludes nothing, and the parity of
// the exclusion at the post-condition after `disable --now` is isolated from the
// refusal before it.
test('B4 a timer-triggered expiry teardown running inside its own companion service completes', async t => {
  await expirySelfRunCompletesCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a completed self-run still measures fully retired from a non-companion vantage', async t => {
  await expirySelfRunHidesNothingCheck(createShu71Production, productionFixture(t, keys));
});

test('B4 a disable that leaves this invocation\'s own companion activating is not drift', async t => {
  await expirySelfRunPostConditionParityCheck(createShu71Production, productionFixture(t, keys));
});
