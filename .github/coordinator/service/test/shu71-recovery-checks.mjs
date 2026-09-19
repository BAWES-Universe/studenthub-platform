import assert from 'node:assert/strict';
import fs from 'node:fs';
export async function gateRecoveryCheck(createProduction, h, retry = 'resume') {
  const create = () => createProduction(h.id, h.boundary);
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
    assert.equal(h.events.some(e => e.includes('disable --now shu71-expiry-')), false, 'B4_RETRY_TIMER_RETAINED');
  }
  h.boundary.fs.renameSync = rename;
  const result = await create().execute(retry);
  assert.equal(result.state, 'REVOKED', 'B4_DRIFT_RECOVERED');
  for (const service of ['shu-coordinator', 'shu-supervisor']) assert.equal(h.read(`/etc/systemd/system/${service}.service.d/90-shu71.conf`), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'B4_GATE_REPAIRED');
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), false, 'B4_LEASE_RELEASED');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_ACTIVATION_REMOVED');
  assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), 'B4_RECOVERY_COMPLETION');
  assert.ok(h.events.some(e => e.includes('disable --now shu71-expiry-')), 'B4_TIMER_RETIRED_AFTER_RECOVERY');
}
export async function serviceRecoveryCheck(createProduction, h, service = 'shu71-evidence.service') {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run');
  const run = h.boundary.run, rename = h.boundary.fs.renameSync;
  h.boundary.run = (exe, argv, opts) => {
    const result = run(exe, argv, opts);
    if (service === 'shu71-evidence.service' && argv[0] === 'stop' && argv[1] === service) h.active.set(service, 'active');
    return result;
  };
  h.boundary.fs.renameSync = (from, to) => {
    rename(from, to);
    if (service !== 'shu71-evidence.service' && to.endsWith('/activation.json')) h.active.set(service, 'active');
  };
  assert.equal((await create().execute('revoke')).code, 'ACT_CLEANUP_FAILED', 'B4_SERVICE_DRIFT_REFUSED');
  assert.equal(h.events.some(e => e.includes('disable --now shu71-expiry-')), false, 'B4_RETRY_TIMER_RETAINED');
  h.boundary.run = run; h.boundary.fs.renameSync = rename;
  const start = h.events.length;
  assert.equal((await create().execute('expire')).state, 'REVOKED', 'B4_SERVICE_DRIFT_RECOVERED');
  assert.ok(h.events.slice(start).some(e => e.endsWith(`:stop ${service}`)), 'B4_SERVICE_STOP_REPEATED');
  assert.equal(h.active.get(service), 'inactive', 'B4_SERVICE_STOP_OBSERVED');
}

const gate = '/etc/systemd/system/shu-coordinator.service.d/90-shu71.conf';
const activation = '/srv/shu/state/shu71-activation.json';
const lease = '/srv/shu/state/shu71-evidence/active.json';
const armed = '[Service]\nEnvironment=ENABLE_DISPATCH=true\n';
function incomplete(h, name) {
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, `${name}_NO_COMPLETION`);
  assert.equal(h.exists(lease), true, `${name}_OWNERSHIP_RETAINED`);
  assert.equal(h.events.some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_TIMER_RETAINED`);
}
export async function retirementWindowCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED');
  const write = h.boundary.fs.writeFileSync;
  let injected = false;
  h.boundary.fs.writeFileSync = (file, data) => {
    write(file, data);
    if (String(data).includes('"event":"INTENT","step":"teardown:expiry-timer"')) {
      injected = true;
      h.write(gate, armed, 0o644);
    }
  };
  const result = await create().execute('revoke');
  assert.equal(injected, true, 'B4_RETIREMENT_WINDOW_INJECTED');
  assert.equal(h.read(gate), armed, 'B4_RETIREMENT_WINDOW_REAL_DRIFT');
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_RETIREMENT_REOBSERVATION');
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), 'B4_RETIREMENT_FAILURE_RETAINED');
  incomplete(h, 'B4_RETIREMENT');
  h.boundary.fs.writeFileSync = write;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_RETIREMENT_RECOVERED');
  assert.equal(h.read(gate), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n');
  assert.equal(h.exists(lease), false);
}
export async function activationRecoveryCheck(createProduction, h, retry = 'resume') {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run');
  const unlink = h.boundary.fs.unlinkSync;
  h.boundary.fs.unlinkSync = file => {
    unlink(file);
    if (file === activation) h.write(activation, 'recreated activation', 0o640);
  };
  for (const action of ['revoke', 'expire']) {
    assert.equal((await create().execute(action)).code, 'ACT_CLEANUP_FAILED', 'B4_ACTIVATION_DRIFT_REFUSED');
    assert.equal(h.exists(activation), true);
    incomplete(h, 'B4_ACTIVATION');
  }
  h.boundary.fs.unlinkSync = unlink;
  assert.equal((await create().execute(retry)).state, 'REVOKED', 'B4_ACTIVATION_DRIFT_RECOVERED');
  assert.equal(h.exists(activation), false, 'B4_ACTIVATION_REPLAY_REMOVED');
  assert.equal(h.exists(lease), false, 'B4_ACTIVATION_REPLAY_RELEASED');
  assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'));
  assert.ok(h.events.some(e => e.includes('disable --now shu71-expiry-')));
}
function sustainGateDrift(h) {
  const rename = h.boundary.fs.renameSync;
  h.boundary.fs.renameSync = (from, to) => {
    rename(from, to);
    if (to === gate) h.write(gate, armed, 0o644);
  };
  return () => { h.boundary.fs.renameSync = rename; };
}
export async function onceOnlyRestoreCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run');
  const clear = sustainGateDrift(h);
  let start = h.events.length;
  assert.equal((await create().execute('revoke')).code, 'ACT_CLEANUP_FAILED');
  assert.ok(h.events.slice(start).filter(e => e === 'api:https://api.linear.app/graphql').length >= 2, 'B4_RESTORE_FIRST_ATTEMPT');
  const archive = `/srv/shu/state/shu71-evidence/${h.id}/activation.json`;
  assert.ok(h.events.slice(start).includes(`rename:${archive}`), 'B4_ARCHIVE_FIRST_ATTEMPT');
  for (const action of ['resume', 'expire', 'revoke']) {
    start = h.events.length;
    assert.equal((await create().execute(action)).code, 'ACT_CLEANUP_FAILED');
    assert.equal(h.events.slice(start).filter(e => e.startsWith('api:')).length, 0, 'B4_RESTORES_ONCE_ONLY');
    assert.equal(h.events.slice(start).filter(e => e === `rename:${archive}`).length, 0, 'B4_ARCHIVE_ONCE_ONLY');
    incomplete(h, 'B4_ONCE_ONLY');
  }
  clear();
  assert.equal((await create().execute('resume')).state, 'REVOKED');
}
export async function boundedReplayCheck(createProduction, h, retry = 'resume') {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run');
  const budget = `/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`;
  assert.equal((await create().execute('expire')).state, 'NOT_EXPIRED');
  assert.equal(h.exists(budget), false, 'B4_BUDGET_NOT_SPENT_BEFORE_EXPIRY');
  h.expire();
  const clear = sustainGateDrift(h);
  for (let n = 1; n <= 32; n++) {
    assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED', 'B4_BUDGET_ATTEMPT_AVAILABLE');
    assert.equal(JSON.parse(h.read(budget)).attempts, n, 'B4_BUDGET_DURABLE_COUNT');
    incomplete(h, 'B4_BUDGET');
  }
  const rows = h.journal().length;
  for (let n = 0; n < 40; n++) {
    const start = h.events.length;
    assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_AUTOMATIC_REPLAY_BOUNDED');
    assert.equal(h.journal().length, rows, 'B4_BOUNDED_JOURNAL_GROWTH');
    assert.equal(h.events.slice(start).filter(e => /^(command:|api:|write:|rename:|unlink:|remove:)/.test(e)).length, 0, 'B4_BOUNDED_EFFECTS');
    incomplete(h, 'B4_BUDGET_EXHAUSTED');
  }
  clear();
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_BUDGET_NO_IMPLICIT_RESET');
  assert.equal((await create().execute(retry)).state, 'REVOKED', 'B4_BUDGET_OPERATOR_RECOVERY');
  assert.equal(h.exists(activation), false);
  assert.equal(h.exists(lease), false);
  assert.equal(h.read(gate), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n');
  assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'));
  assert.ok(h.events.some(e => e.includes('disable --now shu71-expiry-')));
}

export async function counterFaultCheck(createProduction, h, fault = 'mode') {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED'); h.expire();
  const budget = `/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`;
  if (fault === 'mode') h.write(budget, '{"attempts":0}', 0o644);
  else if (fault === 'write') h.faults.before = e => e === `write:${budget}.pending`;
  else if (fault === 'fsync') h.faults.before = e => e === `fsync:${budget}.pending`;
  else if (fault === 'rename') h.faults.before = e => e === `rename:${budget}`;
  else if (fault === 'nlink') {
    h.write(budget, '{"attempts":0}');
    fs.linkSync(h.root + budget, h.root + budget + '.link');
    assert.equal(fs.statSync(h.root + budget).nlink, 2, 'B4_COUNTER_REAL_HARDLINK');
  } else h.write(budget, fault);
  for (let n = 0; n < 4; n++) {
    const result = await create().execute('expire');
    assert.equal(result.code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_COUNTER_REFUSAL');
    for (const service of ['shu-coordinator', 'shu-supervisor'])
      assert.equal(h.read(`/etc/systemd/system/${service}.service.d/90-shu71.conf`), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'B4_COUNTER_FAULT_DISARMS');
    assert.equal(h.exists(activation), false, 'B4_COUNTER_CREDENTIAL_REVOKED');
    incomplete(h, 'B4_COUNTER');
  }
}

export async function manualBudgetCheck(createProduction, h, action = 'revoke') {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run'); h.expire(); const clear = sustainGateDrift(h);
  const budget = `/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`;
  for (let n = 0; n < 10; n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
  for (let n = 0; n < 3; n++) {
    assert.equal((await create().execute(action)).code, 'ACT_CLEANUP_FAILED');
    assert.equal(h.exists(budget), true, 'B4_MANUAL_BUDGET_RETAINED');
    assert.equal(JSON.parse(h.read(budget)).attempts, 10, 'B4_MANUAL_BUDGET_UNCHANGED');
  }
  for (let n = 0; n < 22; n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
  clear(); assert.equal((await create().execute(action)).state, 'REVOKED');
  assert.equal(JSON.parse(h.read(budget)).attempts, 32, 'B4_MANUAL_BUDGET_UNCHANGED');
}

export async function exhaustedSettlementCheck(createProduction, h, interrupt = false) {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run'); h.expire(); const clear = sustainGateDrift(h);
  for (let n = 0; n < 32; n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
  clear();
  // Clearing the writer alone does not restore the file: this must still refuse.
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
  h.write(gate, '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 0o644);
  h.active.set('shu-supervisor.service', 'active');
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_SETTLEMENT_SERVICE_GUARD');
  assert.equal(h.exists(lease), true);
  h.active.set('shu-supervisor.service', 'inactive');
  h.write(activation, 'drift', 0o640);
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_SETTLEMENT_ACTIVATION_GUARD');
  assert.equal(h.exists(lease), true);
  h.boundary.fs.unlinkSync(activation);
  if (interrupt) {
    const run = h.boundary.run;
    // Fail before the modeled command executes, so timer retirement is observable.
    h.boundary.run = (exe, argv, opts) => {
      if (argv[0] === 'disable') throw new Error('interrupted retirement');
      return run(exe, argv, opts);
    };
    h.restoreSettlementRun = () => { h.boundary.run = run; };
  }
  const start = h.events.length, result = await create().execute('expire');
  if (interrupt) {
    assert.equal(result.code, 'ACT_CLEANUP_FAILED');
    incomplete(h, 'B4_SETTLEMENT_FAILED');
    const rows = h.journal().length;
    for (let n = 0; n < 40; n++) assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
    assert.equal(h.journal().length, rows, 'B4_SETTLEMENT_BOUNDED');
    incomplete(h, 'B4_SETTLEMENT_FAILED');
    h.restoreSettlementRun();
    h.faults.before = undefined;
    assert.equal((await create().execute('resume')).state, 'REVOKED');
  } else {
    assert.equal(result.state, 'REVOKED', 'B4_EXHAUSTED_SELF_HEAL');
    assert.equal(h.events.slice(start).some(e => /^api:|:stop |:kill |:daemon-reload/.test(e)), false, 'B4_SETTLEMENT_NO_REPAIR');
  }
  assert.equal(h.exists(lease), false, 'B4_EXHAUSTED_LEASE_RELEASED');
  assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'));
  h.write(lease, JSON.stringify({activation_id: 'successor'}));
  h.write(activation, 'successor');
  assert.equal((await create().execute('expire')).receipt_scope, 'retired_episode', 'B4_SETTLED_SUCCESSOR_PROTECTED');
  assert.equal(h.read(activation), 'successor');
}

// SHU-71 idempotent teardown. The approved window shu71-mint-00000017 halted
// by name before arming and could not complete its own teardown: the worker
// kill, the fixture cleanup that depends on it and the expiry-timer retirement
// all failed against resources that had never been created. These checks are
// shared by the behavioural controls and by the named killing mutants.
const ENV_KEY = 'SHU_REVIEW_MODEL_WRAPPER_JSON';
const expiryUnits = h => [`/etc/systemd/system/shu71-expiry-${h.id}.service`, `/etc/systemd/system/shu71-expiry-${h.id}.timer`];
export function treeSnapshot(h, root = '') {
  const result = {};
  const visit = p => {
    const st = fs.lstatSync(h.root + p);
    result[p] = st.isDirectory() ? 'dir' : fs.readFileSync(h.root + p).toString('base64');
    if (st.isDirectory()) for (const n of fs.readdirSync(h.root + p).sort()) visit(`${p}/${n}`);
  };
  visit(root); return result;
}
// Halt by name before arming, with the documented reviewer wrapper key absent
// from the coordinator source, exactly as the approved window did.
export async function preArmEnvHalt(createProduction, h, key = ENV_KEY) {
  const { supervisorEnvironment, coordinatorText } = await import('./shu71-supervisor-environment-fixture.mjs');
  const env = { ...supervisorEnvironment }; delete env[key];
  h.write('/srv/shu/coordinator.env', coordinatorText(env), 0o600, 999);
  return createProduction(h.id, h.boundary).execute('run');
}
export async function preArmTeardownCheck(createProduction, h, key = ENV_KEY) {
  const before = treeSnapshot(h);
  const result = await preArmEnvHalt(createProduction, h, key);
  assert.equal(result.code, 'SHU71_SUPERVISOR_ENV_REQUIRED', 'B4_PREARM_NAMED_REFUSAL');
  assert.equal(result.missing_key, key, 'B4_PREARM_REFUSAL_NAMES_KEY');
  assert.ok(h.journal().some(e => e.event === 'HALTED' && e.missing_key === key), 'B4_PREARM_REFUSAL_DURABLE_KEY');
  assert.equal(result.teardown.ok, true, `B4_PREARM_TEARDOWN_COMPLETE: ${JSON.stringify(result.teardown)}`);
  assert.deepEqual(result.teardown.failures, [], 'B4_PREARM_TEARDOWN_NO_FAILURES');
  assert.equal(result.teardown.state, 'REVOKED', 'B4_PREARM_TEARDOWN_REVOKED');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', 'B4_PREARM_TEARDOWN_RECEIPT_DURABLE');
  for (const step of ['workers', 'fixtures', 'expiry-timer'])
    assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === `teardown:${step}`), `B4_PREARM_TEARDOWN_STEP_${step.toUpperCase()}`);
  // No unit started, no expiry timer created, no activation credential.
  assert.deepEqual([...h.started], [], 'B4_PREARM_NO_UNIT_STARTED');
  assert.deepEqual([...h.enabled], [], 'B4_PREARM_NO_UNIT_ENABLED');
  assert.equal(h.events.some(e => /:(restart|kill|enable) /.test(e)), false, 'B4_PREARM_NO_START_OR_KILL_COMMAND');
  for (const unit of expiryUnits(h)) assert.equal(h.exists(unit), false, 'B4_PREARM_NO_EXPIRY_TIMER');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_PREARM_NO_ACTIVATION_FILE');
  // No worker, worktree or workspace record was created; fixtures are untouched.
  assert.deepEqual(fs.readdirSync(`${h.root}/srv/shu/worktrees`), [], 'B4_PREARM_NO_WORKTREE');
  assert.deepEqual(fs.readdirSync(`${h.root}/srv/shu/state/workspaces`), [], 'B4_PREARM_NO_WORKSPACE');
  assert.equal(h.events.some(e => e.startsWith('card:')), false, 'B4_PREARM_NO_FIXTURE_MUTATION');
  for (const t of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(t.issue_id), t.before, 'B4_PREARM_FIXTURES_PRIOR_STATE');
  // Dispatch is off at every layer and the activation id is released.
  for (const gate of ['shu-coordinator', 'shu-supervisor'])
    assert.equal(h.read(`/etc/systemd/system/${gate}.service.d/90-shu71.conf`), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'B4_PREARM_DISPATCH_OFF');
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), false, 'B4_PREARM_ACTIVATION_ID_RELEASED');
  assert.ok(Object.keys(before).length > 0, 'B4_PREARM_SNAPSHOT_TAKEN');
  // Re-running cleanup succeeds and creates or deletes nothing new.
  const settled = treeSnapshot(h), start = h.events.length;
  const second = await createProduction(h.id, h.boundary).execute('revoke');
  assert.equal(second.ok, true, `B4_PREARM_SECOND_CLEANUP_OK: ${JSON.stringify(second)}`);
  assert.equal(second.state, 'REVOKED', 'B4_PREARM_SECOND_CLEANUP_REVOKED');
  assert.deepEqual(treeSnapshot(h), settled, 'B4_PREARM_SECOND_CLEANUP_INERT');
  assert.equal(h.events.slice(start).some(e => /^(write:|rename:|unlink:|remove:)/.test(e)), false, 'B4_PREARM_SECOND_CLEANUP_NO_WRITES');
  for (const unit of expiryUnits(h)) assert.equal(h.exists(unit), false, 'B4_PREARM_SECOND_CLEANUP_NO_TIMER');
  assert.deepEqual([...h.started], [], 'B4_PREARM_SECOND_CLEANUP_NO_UNIT');
  return result;
}
// The fixtures step keeps every safety check it performs when the worker step
// legitimately no-ops: episode-bound attempt ids only, inode receipt, and
// authority sidecars and unrelated worktrees preserved.
export async function preArmFixtureCleanupCheck(createProduction, h) {
  const attempt = '22222222-2222-4222-8222-222222222222';
  const record = `/srv/shu/state/workspaces/${attempt}.workspace.json`;
  h.write(record, JSON.stringify({ episode_id: h.id, attempt_id: attempt, issue_id: 'SHU-254',
    repo: 'BAWES-Universe/studenthub-platform', branch: 'coordinator/SHU-254' }), 0o600, 999);
  h.write(`/srv/shu/worktrees/${attempt}/result.txt`, 'fixture-only', 0o600, 995);
  h.write('/srv/shu/worktrees/unrelated/keep', 'unrelated');
  const lstat = h.boundary.fs.lstatSync;
  h.boundary.fs.lstatSync = p => {
    const st = lstat(p);
    return p === `/srv/shu/worktrees/${attempt}` ? new Proxy(st, { get: (target, key) => key === 'uid' ? 995 : Reflect.get(target, key) }) : st;
  };
  const result = await preArmEnvHalt(createProduction, h);
  assert.equal(result.code, 'SHU71_SUPERVISOR_ENV_REQUIRED', 'B4_PREARM_FIXTURE_NAMED_REFUSAL');
  assert.equal(result.teardown.ok, true, `B4_PREARM_FIXTURE_TEARDOWN_COMPLETE: ${JSON.stringify(result.teardown)}`);
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:fixtures'), 'B4_PREARM_FIXTURE_STEP_NOT_BLOCKED');
  assert.ok(h.journal().some(e => e.event === 'FIXTURE_REMOVE_INTENT' && e.attempt_id === attempt), 'B4_PREARM_FIXTURE_INODE_RECEIPT');
  assert.equal(h.exists(`/srv/shu/worktrees/${attempt}`), false, 'B4_PREARM_FIXTURE_REMOVED');
  assert.equal(h.exists(record), true, 'B4_PREARM_FIXTURE_AUTHORITY_RETAINED');
  assert.equal(h.read('/srv/shu/worktrees/unrelated/keep'), 'unrelated', 'B4_PREARM_FIXTURE_UNRELATED_RETAINED');
}
// Drift: the journal proves the resource was never created, yet the host shows
// it present or running. Each case must refuse by name, never silently no-op.
export async function preArmDriftCheck(createProduction, h, drift = 'supervisor') {
  const timer = `shu71-expiry-${h.id}.timer`;
  if (drift === 'supervisor') h.active.set('shu-supervisor.service', 'active');
  else if (drift === 'timer-file') h.write(`/etc/systemd/system/${timer}`, '[Timer]\n', 0o644);
  else if (drift === 'timer-active') h.active.set(timer, 'active');
  else h.enabled.add(timer), h.write(`/etc/systemd/system/${timer}`, '[Timer]\n', 0o644);
  const result = await preArmEnvHalt(createProduction, h);
  assert.equal(result.code, 'SHU71_SUPERVISOR_ENV_REQUIRED', `B4_PREARM_DRIFT_NAMED_REFUSAL_${drift}`);
  assert.equal(result.teardown.ok, false, `B4_PREARM_DRIFT_REFUSED_${drift}: ${JSON.stringify(result.teardown)}`);
  assert.equal(result.teardown.code, 'ACT_CLEANUP_FAILED', `B4_PREARM_DRIFT_NAMED_CLEANUP_${drift}`);
  const expected = drift === 'supervisor' ? 'ACT_TEARDOWN_WORKERS' : 'ACT_TEARDOWN_EXPIRY_TIMER';
  assert.ok(result.teardown.failures.includes(expected), `B4_PREARM_DRIFT_FAILURE_${drift}`);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, `B4_PREARM_DRIFT_NO_COMPLETION_${drift}`);
  assert.equal(h.events.some(e => e.includes(':disable --now')), false, `B4_PREARM_DRIFT_NO_RETIREMENT_${drift}`);
  if (drift === 'supervisor') assert.equal(h.events.some(e => e.includes(':kill --kill-whom=all')), false, `B4_PREARM_DRIFT_NO_KILL_${drift}`);
  for (const gate of ['shu-coordinator', 'shu-supervisor'])
    assert.equal(h.read(`/etc/systemd/system/${gate}.service.d/90-shu71.conf`), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', `B4_PREARM_DRIFT_DISPATCH_OFF_${drift}`);
}
// A kill refused for any reason other than a unit measured idle stays a failure.
export async function workerKillFailureCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_KILL_FAILURE_SETUP');
  h.faults.before = name => name.includes(':kill --kill-whom=all');
  const result = await create().execute('revoke');
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_KILL_FAILURE_NOT_ACCEPTED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_WORKERS'), 'B4_KILL_FAILURE_NAMED');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B4_KILL_FAILURE_NO_COMPLETION');
  h.faults.before = null;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_KILL_FAILURE_RECOVERED');
}
// A destroyed journal proves nothing: it must take the fail-closed path rather
// than claim the supervisor was never started for this episode.
export async function destroyedJournalCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_DESTROYED_JOURNAL_SETUP');
  assert.equal(h.active.get('shu-supervisor.service'), 'active', 'B4_DESTROYED_JOURNAL_UNIT_RUNNING');
  h.boundary.fs.unlinkSync(`/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`);
  const result = await create().execute('revoke');
  assert.equal(result.state, 'REVOKED', `B4_DESTROYED_JOURNAL_NOT_PROOF: ${JSON.stringify(result)}`);
  assert.ok(h.events.some(e => e.includes(':kill --kill-whom=all')), 'B4_DESTROYED_JOURNAL_FAIL_CLOSED_KILL');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_DESTROYED_JOURNAL_CREDENTIAL_REVOKED');
}
// Interrupt the run at each lifecycle phase boundary and prove every recovery
// either completes cleanup or halts by a named code, with dispatch off.
const NAMED_CLEANUP_CODES = ['ACT_CLEANUP_FAILED', 'ACT_RETRY_BUDGET_EXHAUSTED', 'ACT_RETRY_BUDGET_UNAVAILABLE'];
export const lifecyclePhases = ['before-arming', 'after-arming', 'before-supervisor-start', 'after-supervisor-start',
  'before-expiry-installation', 'after-expiry-installation', 'mid-teardown'];
export async function phaseInterruptionCheck(createProduction, h, phase) {
  const create = () => createProduction(h.id, h.boundary);
  const timer = `command:/usr/bin/systemctl:enable --now shu71-expiry-${h.id}.timer`;
  const marks = {
    'before-arming': ['after', e => e === 'command:/usr/bin/systemctl:start shu-coordinator.timer'],
    'after-arming': [null, null],
    'before-supervisor-start': ['before', e => e === 'command:/usr/bin/systemctl:restart shu-supervisor.service'],
    'after-supervisor-start': ['after', e => e === 'command:/usr/bin/systemctl:restart shu-supervisor.service'],
    'before-expiry-installation': ['before', e => e === `write:/etc/systemd/system/shu71-expiry-${h.id}.service.pending`],
    'after-expiry-installation': ['after', e => e === timer],
    'mid-teardown': [null, null],
  };
  const [when, match] = marks[phase];
  let dead = false;
  if (when) {
    h.faults[when] = name => dead || (dead = match(name));
    if (when === 'after') h.faults.before = () => dead;
  }
  const armed = await create().execute('run').catch(() => ({ state: 'DEAD' }));
  h.faults.before = null; h.faults.after = null;
  if (when) assert.equal(dead, true, `B4_PHASE_${phase}_INTERRUPTED`);
  else assert.equal(armed.state, 'ARMED', `B4_PHASE_${phase}_ARMED`);
  if (phase === 'mid-teardown') {
    let killed = false;
    h.faults.after = name => killed || (killed = name === 'unlink:/srv/shu/state/shu71-activation.json');
    h.faults.before = () => killed;
    await create().execute('revoke').catch(() => {});
    h.faults.before = null; h.faults.after = null;
    assert.equal(killed, true, `B4_PHASE_${phase}_INTERRUPTED`);
  }
  const result = await create().execute('revoke');
  const named = result.ok === true || NAMED_CLEANUP_CODES.includes(result.code);
  assert.ok(named, `B4_PHASE_${phase}_NAMED_OUTCOME: ${JSON.stringify(result)}`);
  for (const gate of ['shu-coordinator', 'shu-supervisor']) {
    const file = `/etc/systemd/system/${gate}.service.d/90-shu71.conf`;
    assert.equal(h.exists(file) ? h.read(file) : '[Service]\nEnvironment=ENABLE_DISPATCH=false\n',
      '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', `B4_PHASE_${phase}_DISPATCH_OFF`);
  }
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, `B4_PHASE_${phase}_CREDENTIAL_REVOKED`);
  if (result.ok) {
    assert.equal(result.state, 'REVOKED', `B4_PHASE_${phase}_REVOKED`);
    assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), `B4_PHASE_${phase}_RECEIPT`);
    assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), false, `B4_PHASE_${phase}_RELEASED`);
    const settled = treeSnapshot(h);
    const again = await create().execute('revoke');
    assert.equal(again.ok, true, `B4_PHASE_${phase}_IDEMPOTENT: ${JSON.stringify(again)}`);
    assert.deepEqual(treeSnapshot(h), settled, `B4_PHASE_${phase}_IDEMPOTENT_INERT`);
  } else {
    // A named halt must not wedge: it stays named and never re-arms dispatch.
    const retry = await create().execute('resume');
    assert.ok(retry.ok === true || NAMED_CLEANUP_CODES.includes(retry.code), `B4_PHASE_${phase}_RETRY_NAMED: ${JSON.stringify(retry)}`);
  }
  return result;
}
