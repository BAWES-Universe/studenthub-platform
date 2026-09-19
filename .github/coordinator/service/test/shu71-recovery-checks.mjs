import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
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
    // A completed teardown leaves no expiry mechanism behind, from every
    // realistic interrupted journal state this matrix can reach.
    for (const unit of expiryUnits(h)) assert.equal(h.exists(unit), false, `B4_PHASE_${phase}_EXPIRY_UNITS_REMOVED`);
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
// The window measured the kill refusal only for a unit this episode never
// started. Under the stricter reading - any unit that currently holds no
// processes, as after a reboot or a teardown that already stopped it - the
// same teardown must still complete rather than wedge.
export async function strictKillModelCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_STRICT_KILL_SETUP');
  h.systemd.killRequiresProcesses = true;
  h.active.set('shu-supervisor.service', 'inactive');
  const result = await create().execute('revoke');
  assert.equal(result.state, 'REVOKED', `B4_STRICT_KILL_NO_WEDGE: ${JSON.stringify(result)}`);
  assert.ok(h.events.some(e => e.includes(':kill --kill-whom=all')), 'B4_STRICT_KILL_ISSUED');
  assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), 'B4_STRICT_KILL_RECEIPT');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_STRICT_KILL_CREDENTIAL_REVOKED');
  const settled = treeSnapshot(h);
  assert.equal((await create().execute('revoke')).ok, true, 'B4_STRICT_KILL_IDEMPOTENT');
  assert.deepEqual(treeSnapshot(h), settled, 'B4_STRICT_KILL_IDEMPOTENT_INERT');
}

// SHU-71 expiry retirement drift (blocking correction lane). The merged
// revision issued `systemctl disable --now` for a journal-proven installed
// timer and checked nothing at all when it succeeded: the two durable unit
// files could be missing, replaced or left behind and the retirement still
// reported success. These checks pin the pre-condition, the post-condition,
// the actual removal and the honest refusal.
const expiryTimer = h => `shu71-expiry-${h.id}.timer`;
// Like incomplete(), minus the retirement-command clause: these checks measure
// the retirement command themselves, in their own bounded event slice.
function unfinished(h, name) {
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, `${name}_NO_COMPLETION`);
  assert.equal(h.exists(lease), true, `${name}_OWNERSHIP_RETAINED`);
}
// The journal proves the mechanism was installed and the durable unit file is
// gone, yet systemd still holds the unit loaded, so `disable --now` succeeds.
// Only a measurement of the durable files can refuse this.
export async function expiryFileDriftCheck(createProduction, h, unit = 'timer') {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', `B4_EXPIRY_FILE_DRIFT_SETUP_${unit}`);
  assert.ok(h.journal().some(e => e.event === 'ARMED'), `B4_EXPIRY_FILE_DRIFT_JOURNAL_PROVES_INSTALLED_${unit}`);
  h.systemd.unitFileViewCached = true;
  const file = `/etc/systemd/system/shu71-expiry-${h.id}.${unit}`;
  fs.rmSync(h.root + file);
  assert.equal(h.exists(file), false, `B4_EXPIRY_FILE_DRIFT_REAL_${unit}`);
  // The modelled host answers yes: systemd still holds the unit loaded, so
  // `disable --now` exits 0 even with the durable file gone. The refusal below
  // is the pre-condition's, not a lucky command failure. The probe's own effect
  // on the model is undone, so the measured teardown starts from the armed state.
  const probe = h.boundary.run('/usr/bin/systemctl', ['disable', '--now', expiryTimer(h)], {});
  assert.equal(probe.status, 0, `B4_EXPIRY_FILE_DRIFT_DISABLE_WOULD_SUCCEED_${unit}`);
  assert.equal(h.enabled.has(expiryTimer(h)), false, `B4_EXPIRY_FILE_DRIFT_PROBE_DISABLED_${unit}`);
  h.enabled.add(expiryTimer(h)); h.active.set(expiryTimer(h), 'active');
  const start = h.events.length;
  const result = await create().execute('revoke');
  assert.equal(result.ok, false, `B4_EXPIRY_FILE_DRIFT_REFUSED_${unit}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `B4_EXPIRY_FILE_DRIFT_NAMED_${unit}`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `B4_EXPIRY_FILE_DRIFT_STEP_NAMED_${unit}`);
  assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `B4_EXPIRY_FILE_DRIFT_BEFORE_DISABLE_${unit}`);
  unfinished(h, `B4_EXPIRY_FILE_DRIFT_${unit}`);
  const repeat = h.events.length;
  assert.equal((await create().execute('resume')).code, 'ACT_CLEANUP_FAILED', `B4_EXPIRY_FILE_DRIFT_PERSISTS_${unit}`);
  assert.equal(h.events.slice(repeat).some(e => e.includes('disable --now shu71-expiry-')), false, `B4_EXPIRY_FILE_DRIFT_REPEAT_BEFORE_DISABLE_${unit}`);
  unfinished(h, `B4_EXPIRY_FILE_DRIFT_REPEAT_${unit}`);
  // Restoring the durable pair lets the same teardown complete and remove both.
  h.write(file, unit === 'timer' ? '[Timer]\n' : '[Service]\n', 0o644);
  h.systemd.unitFileViewCached = false;
  assert.equal((await create().execute('resume')).state, 'REVOKED', `B4_EXPIRY_FILE_DRIFT_RECOVERED_${unit}`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `B4_EXPIRY_FILE_DRIFT_RECOVERED_UNITS_REMOVED_${unit}`);
}
// A journal-proven installed timer, both files present, disable succeeding:
// the retirement completes, leaves no expiry mechanism behind, and a repeat
// teardown is an inert no-op success. A mechanism re-created afterwards is
// drift by name on the retired episode's own receipt path.
export async function expiryRetirementCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_EXPIRY_RETIREMENT_SETUP');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_RETIREMENT_INSTALLED');
  assert.equal(h.enabled.has(expiryTimer(h)), true, 'B4_EXPIRY_RETIREMENT_ENABLED');
  const result = await create().execute('revoke');
  assert.equal(result.state, 'REVOKED', `B4_EXPIRY_RETIREMENT_COMPLETES: ${JSON.stringify(result)}`);
  assert.ok(h.events.some(e => e.includes('disable --now shu71-expiry-')), 'B4_EXPIRY_RETIREMENT_DISABLED');
  assert.ok(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), 'B4_EXPIRY_RETIREMENT_RECEIPT');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_UNITS_REMOVED');
  assert.equal(h.enabled.has(expiryTimer(h)), false, 'B4_EXPIRY_UNIT_NOT_ENABLED');
  assert.equal(h.active.get(expiryTimer(h)) ?? 'inactive', 'inactive', 'B4_EXPIRY_UNIT_IDLE');
  const settled = treeSnapshot(h), start = h.events.length;
  const again = await create().execute('revoke');
  assert.equal(again.ok, true, `B4_EXPIRY_REPEAT_TEARDOWN_OK: ${JSON.stringify(again)}`);
  assert.equal(again.state, 'REVOKED', 'B4_EXPIRY_REPEAT_TEARDOWN_REVOKED');
  assert.deepEqual(treeSnapshot(h), settled, 'B4_EXPIRY_REPEAT_TEARDOWN_INERT');
  assert.equal(h.events.slice(start).some(e => /^(write:|rename:|unlink:|remove:)/.test(e)), false, 'B4_EXPIRY_REPEAT_TEARDOWN_NO_WRITES');
  h.write(`/etc/systemd/system/${expiryTimer(h)}`, '[Timer]\n', 0o644);
  const drifted = await create().execute('revoke');
  assert.equal(drifted.ok, false, `B4_RETIRED_EPISODE_EXPIRY_DRIFT: ${JSON.stringify(drifted)}`);
  assert.equal(drifted.code, 'ACT_TEARDOWN_DRIFT', 'B4_RETIRED_EPISODE_EXPIRY_DRIFT_NAMED');
}
// A disable that throws is never a silent success, even where the unit is
// already measurably idle and not enabled and the removal would otherwise
// leave a clean end state. The refusal is reported by name, never as the
// bare thrown error.
export async function expiryDisableFailureCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_EXPIRY_DISABLE_FAILURE_SETUP');
  h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h));
  h.faults.before = name => name === `command:/usr/bin/systemctl:disable --now ${expiryTimer(h)}`;
  const result = await create().execute('revoke');
  assert.equal(result.ok, false, `B4_EXPIRY_DISABLE_FAILURE_NOT_SILENT: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_EXPIRY_DISABLE_FAILURE_NAMED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), 'B4_EXPIRY_DISABLE_FAILURE_STEP_NAMED');
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(h.journal()), /SECRET_POISON/, 'B4_EXPIRY_DISABLE_FAILURE_NO_RAW_ERROR');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_DISABLE_FAILURE_UNITS_RETAINED');
  unfinished(h, 'B4_EXPIRY_DISABLE_FAILURE');
  h.faults.before = null;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_EXPIRY_DISABLE_FAILURE_RECOVERED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_DISABLE_FAILURE_RETIRED_AFTER_RECOVERY');
}
// A recovered log proves nothing about non-creation, including when it is an
// authentic retained prefix of this episode's own journal that records the
// forward attempt and no creating intent. The timer really is installed.
export async function recoveredNonCreationCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_RECOVERED_NON_CREATION_SETUP');
  const rows = h.journal(), stop = rows.findIndex(e => e.event === 'RUN_ATTEMPT_STARTED');
  assert.ok(stop > 0, 'B4_RECOVERED_PREFIX_AUTHENTIC');
  assert.equal(rows.slice(0, stop + 1).some(e => e.event === 'ARMED' || e.step === 'expiry-watch'), false, 'B4_RECOVERED_PREFIX_CLAIMS_NON_CREATION');
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/recovery.jsonl`, rows.slice(0, stop + 1).map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_RECOVERED_TIMER_REALLY_INSTALLED');
  const result = await create().execute('resume');
  assert.equal(result.state, 'REVOKED', `B4_RECOVERED_NOT_PROOF_OF_NON_CREATION: ${JSON.stringify(result)}`);
  assert.ok(h.events.some(e => e.includes('disable --now shu71-expiry-')), 'B4_RECOVERED_FAIL_CLOSED_RETIREMENT');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_RECOVERED_UNITS_REMOVED');
}
// The reviewed teardown effect order, as durable journal rows. Disarm precedes
// credential removal, the worker kill precedes the fixture cleanup that
// requires it, and the retry mechanism is retired last of all.
export const teardownEffectOrder = Object.freeze(['gate', 'activation', 'workers',
  'stop-shu-coordinator-timer', 'stop-shu-coordinator-service', 'stop-shu-supervisor-service', 'reload',
  'restore-shu-140', 'restore-shu-254', 'fixtures', 'evidence-broker', 'archive', 'manifest', 'expiry-timer']);
export async function teardownOrderCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_TEARDOWN_ORDER_SETUP');
  assert.equal((await create().execute('revoke')).state, 'REVOKED', 'B4_TEARDOWN_ORDER_REVOKED');
  const steps = event => h.journal().filter(e => e.event === event && typeof e.step === 'string' && e.step.startsWith('teardown:'))
    .map(e => e.step.slice('teardown:'.length));
  assert.deepEqual(steps('INTENT'), [...teardownEffectOrder], 'B4_TEARDOWN_EFFECT_ORDER');
  assert.deepEqual(steps('DONE'), [...teardownEffectOrder], 'B4_TEARDOWN_EFFECT_ORDER_COMPLETED');
}
// The fixture cleanup's durability precondition: it refuses until the worker
// kill has reached its own durable DONE row, and removes nothing before then.
export async function fixturesRequireWorkersCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_FIXTURES_DEPENDENCY_SETUP');
  const attempt = '33333333-3333-4333-8333-333333333333';
  h.write(`/srv/shu/state/workspaces/${attempt}.workspace.json`, JSON.stringify({ episode_id: h.id, attempt_id: attempt,
    issue_id: 'SHU-254', repo: 'BAWES-Universe/studenthub-platform', branch: 'coordinator/SHU-254' }), 0o600, 999);
  h.write(`/srv/shu/worktrees/${attempt}/result.txt`, 'fixture-only', 0o600, 995);
  const lstat = h.boundary.fs.lstatSync;
  h.boundary.fs.lstatSync = p => {
    const st = lstat(p);
    return p === `/srv/shu/worktrees/${attempt}` ? new Proxy(st, { get: (target, key) => key === 'uid' ? 995 : Reflect.get(target, key) }) : st;
  };
  h.faults.before = name => name.includes(':kill --kill-whom=all');
  const result = await create().execute('revoke');
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_FIXTURES_WORKERS_FAILED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_WORKERS'), 'B4_FIXTURES_WORKERS_NAMED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_FIXTURES'), 'B4_FIXTURES_REQUIRE_WORKERS_DONE');
  assert.equal(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:fixtures'), false, 'B4_FIXTURES_NO_DONE_WITHOUT_WORKERS');
  assert.equal(h.journal().some(e => e.event === 'FIXTURE_REMOVE_INTENT'), false, 'B4_FIXTURES_NO_RECEIPT_WITHOUT_WORKERS');
  assert.equal(h.exists(`/srv/shu/worktrees/${attempt}`), true, 'B4_FIXTURES_DURABILITY_PRECONDITION');
  h.faults.before = null;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_FIXTURES_DEPENDENCY_RECOVERED');
  assert.equal(h.exists(`/srv/shu/worktrees/${attempt}`), false, 'B4_FIXTURES_REMOVED_AFTER_WORKERS');
  assert.equal(h.exists(`/srv/shu/state/workspaces/${attempt}.workspace.json`), true, 'B4_FIXTURES_AUTHORITY_RETAINED_AFTER_WORKERS');
}
// systemd's loaded view is a cache. Where the removal is not yet reflected in
// it, the retirement refreshes the view with a daemon-reload and measures the
// end state again rather than reporting an unverified success.
export async function expiryCachedViewCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_EXPIRY_CACHED_VIEW_SETUP');
  h.systemd.unitFileViewCached = true;
  const start = h.events.length;
  const result = await create().execute('revoke');
  assert.equal(result.state, 'REVOKED', `B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW: ${JSON.stringify(result)}`);
  const slice = h.events.slice(start);
  const unlink = slice.findIndex(e => e === `unlink:/etc/systemd/system/${expiryTimer(h)}`);
  assert.ok(unlink >= 0, 'B4_EXPIRY_CACHED_VIEW_REMOVED');
  assert.ok(slice.slice(unlink).some(e => e === 'command:/usr/bin/systemctl:daemon-reload'), 'B4_EXPIRY_CACHED_VIEW_RELOADED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_CACHED_VIEW_UNITS_REMOVED');
  assert.equal(h.loaded.has(expiryTimer(h)), false, 'B4_EXPIRY_CACHED_VIEW_UNLOADED');
}
// The exit status of `disable --now` is not the end state. A disable that
// reports success while the unit stays active and enabled is drift, and the
// durable unit files of a live unit are never destroyed on that report.
export async function expiryPostConditionCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_EXPIRY_POSTCONDITION_SETUP');
  const run = h.boundary.run;
  h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable') { h.active.set(expiryTimer(h), 'active'); h.enabled.add(expiryTimer(h)); }
    return result;
  };
  const result = await create().execute('revoke');
  assert.equal(result.ok, false, `B4_EXPIRY_POSTCONDITION_REFUSED: ${JSON.stringify(result)}`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), 'B4_EXPIRY_POSTCONDITION_NAMED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_POSTCONDITION_UNITS_RETAINED');
  unfinished(h, 'B4_EXPIRY_POSTCONDITION');
  h.boundary.run = run;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_EXPIRY_POSTCONDITION_RECOVERED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_POSTCONDITION_RETIRED_AFTER_RECOVERY');
}
// The Sentry-shaped defect: a predicate evaluated as an argument of need()
// skips its own refusal when it throws. Measured into a value first, a throw
// is the named refusal and never a bare error in its place.
export function predicateRefusalCheck(api) {
  const boom = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  let measured;
  try { measured = api.measuredPredicate(boom); } catch (error) { measured = error; }
  assert.equal(measured, false, 'B4_EXPIRY_PREDICATE_THROW_REFUSES');
  assert.equal(api.measuredPredicate(() => false), false, 'B4_EXPIRY_PREDICATE_FALSE_REFUSES');
  assert.equal(api.measuredPredicate(() => 'yes'), false, 'B4_EXPIRY_PREDICATE_REQUIRES_MEASURED_TRUE');
  assert.equal(api.measuredPredicate(() => true), true, 'B4_EXPIRY_PREDICATE_MEASURED_TRUE_PASSES');
}

// SHU-71 expiry-retirement drift, correction round. The pre-condition's
// EXISTENCE half is pinned above (expiryFileDriftCheck); its CUSTODY half was
// enforced by the shipped code but pinned by no shipped control, so an
// installed unit file REPLACED by a non-root-owned, group/world-writable or
// non-regular file was still disabled, removed and reported as retired. Each
// control below plants exactly one broken custody term on a JOURNAL-PROVEN
// INSTALLED unit file, with both files present and `disable --now` ready to
// succeed, so nothing but the named clause can produce the refusal.
// ACT_TEARDOWN_DRIFT is raised by need() inside the `expiry-timer` teardown
// effect, and teardownActivation() reports every effect refusal under that
// step's own name: ACT_CLEANUP_FAILED with ACT_TEARDOWN_EXPIRY_TIMER in
// failures is the observable form of that refusal at the module boundary. The
// literal code is observable on the retired-episode receipt path, which
// expiryRetirementCheck pins.
const CUSTODY_VARIANTS = Object.freeze({
  'non-root-owner': 'owner', 'non-root-group': 'group', 'group-writable': 'group_mode',
  'world-writable': 'world_mode', 'non-regular-file': 'shape',
  'hardlinked-timer': 'links', 'hardlinked-service': 'links',
});
// Which durable unit file each variant damages. The predicate is applied to
// both by `EXPIRY_UNITS.every(...)`, so the link term is planted on each in
// turn; every earlier variant damages the timer, as it always did.
const CUSTODY_UNITS = Object.freeze({ 'hardlinked-service': 'service' });
// A genuine non-regular file with the unit file's own custody: root:root, one
// link, 0644, and not a symlink, so every other custody term still holds and
// only the shape term can refuse. Node unlinks the socket path on close, so the
// server is closed before the file is restored and always before returning.
async function plantNonRegularFile(path) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  fs.chmodSync(path, 0o644);
  let closed = false;
  return () => closed ? Promise.resolve() : new Promise(resolve => { closed = true; server.close(() => resolve()); });
}
// A second name for the unit file's own inode, outside the unit directory: the
// drift shape a durable root-owned unit file must not have, because whoever
// holds the other name keeps the inode - and the ability to rewrite what
// systemd loaded - after the retirement unlinks the unit path. Nothing else
// about the file changes: same mode, same owner, same regular-file shape, so
// only `s.nlink === 1` can refuse it. Removing the second name restores it.
function plantHardlink(h, file, unit) {
  const other = `/var/tmp/shu71-expiry-retained-${h.id}.${unit}`;
  fs.mkdirSync(h.root + '/var/tmp', { recursive: true, mode: 0o1777 });
  fs.linkSync(h.root + file, h.root + other);
  return async () => fs.rmSync(h.root + other, { force: true });
}
export async function expiryCustodyDriftCheck(createProduction, h, variant) {
  const create = () => createProduction(h.id, h.boundary);
  const unit = CUSTODY_UNITS[variant] ?? 'timer';
  const file = `/etc/systemd/system/shu71-expiry-${h.id}.${unit}`;
  assert.equal((await create().execute('run')).state, 'ARMED', `B4_EXPIRY_CUSTODY_SETUP_${variant}`);
  assert.ok(h.journal().some(e => e.event === 'ARMED'), `B4_EXPIRY_CUSTODY_JOURNAL_PROVES_INSTALLED_${variant}`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `B4_EXPIRY_CUSTODY_BOTH_UNITS_PRESENT_${variant}`);
  let close = null;
  if (variant === 'non-root-owner') h.owners.set(file, [999, 0]);
  else if (variant === 'non-root-group') h.owners.set(file, [0, 982]);
  else if (variant === 'group-writable') fs.chmodSync(h.root + file, 0o664);
  else if (variant === 'world-writable') fs.chmodSync(h.root + file, 0o646);
  else if (CUSTODY_VARIANTS[variant] === 'links') close = plantHardlink(h, file, unit);
  else { fs.rmSync(h.root + file); close = await plantNonRegularFile(h.root + file); }
  const terms = target => {
    const s = h.boundary.fs.lstatSync(target);
    return { shape: s.isFile() && !s.isSymbolicLink(), links: s.nlink === 1, owner: s.uid === 0,
      group: s.gid === 0, group_mode: !(s.mode & 0o020), world_mode: !(s.mode & 0o002) };
  };
  try {
    // Exactly one custody term is broken. Anything else would let a control
    // survive on the mutant that removes the term it claims to pin.
    const broken = Object.entries(terms(file)).filter(([, ok]) => !ok).map(([term]) => term);
    assert.deepEqual(broken, [CUSTODY_VARIANTS[variant]], `B4_EXPIRY_CUSTODY_EXACTLY_ONE_TERM_${variant}`);
    // ...and it is broken on exactly one of the two durable unit files, so the
    // refusal names the damaged file and not incidental damage to its companion.
    for (const other of expiryUnits(h).filter(p => p !== file))
      assert.deepEqual(Object.entries(terms(other)).filter(([, ok]) => !ok).map(([term]) => term), [],
        `B4_EXPIRY_CUSTODY_OTHER_UNIT_INTACT_${variant}`);
    // The modelled host would disable it: the unit file is still there, so the
    // refusal below is the pre-condition's, never a lucky command failure.
    assert.equal(h.exists(`/etc/systemd/system/shu71-expiry-${h.id}.service`), true, `B4_EXPIRY_CUSTODY_COMPANION_PRESENT_${variant}`);
    const start = h.events.length;
    const result = await create().execute('revoke');
    assert.equal(result.ok, false, `B4_EXPIRY_CUSTODY_REFUSED_${variant}: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', `B4_EXPIRY_CUSTODY_NAMED_${variant}`);
    assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `B4_EXPIRY_CUSTODY_STEP_NAMED_${variant}`);
    assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `B4_EXPIRY_CUSTODY_BEFORE_DISABLE_${variant}`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `B4_EXPIRY_CUSTODY_UNITS_RETAINED_${variant}`);
    assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `B4_EXPIRY_CUSTODY_NO_RECEIPT_${variant}`);
    unfinished(h, `B4_EXPIRY_CUSTODY_${variant}`);
    const repeat = h.events.length;
    assert.equal((await create().execute('resume')).code, 'ACT_CLEANUP_FAILED', `B4_EXPIRY_CUSTODY_PERSISTS_${variant}`);
    assert.equal(h.events.slice(repeat).some(e => e.includes('disable --now shu71-expiry-')), false, `B4_EXPIRY_CUSTODY_REPEAT_BEFORE_DISABLE_${variant}`);
    unfinished(h, `B4_EXPIRY_CUSTODY_REPEAT_${variant}`);
  } finally { if (close) await close(); }
  // Root custody restored, the same teardown completes and removes both files.
  if (variant === 'non-regular-file') h.write(file, '[Timer]\n', 0o644);
  h.owners.set(file, [0, 0]);
  fs.chmodSync(h.root + file, 0o644);
  assert.equal((await create().execute('resume')).state, 'REVOKED', `B4_EXPIRY_CUSTODY_RECOVERED_${variant}`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `B4_EXPIRY_CUSTODY_RECOVERED_UNITS_REMOVED_${variant}`);
}
// The refusal AFTER the daemon-reload. Both unit files are removed, systemd's
// stale loaded view is refreshed, and the end state is still not retired
// because the mechanism came back on disk before systemd re-read the unit
// directory. Nothing later in this teardown measures that state, so deleting
// this one statement reports a live expiry mechanism as a successful
// retirement; only the post-reload refusal can construct the difference.
export async function expiryPostReloadDriftCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const file = `/etc/systemd/system/${expiryTimer(h)}`;
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_EXPIRY_POST_RELOAD_SETUP');
  // The loaded view lags the removal, so the retirement must reload and
  // measure again rather than accept the cached answer.
  h.systemd.unitFileViewCached = true;
  const run = h.boundary.run;
  let recreated = 0;
  h.boundary.run = (exe, argv, options) => {
    if (exe === '/usr/bin/systemctl' && argv[0] === 'daemon-reload' && !h.exists(file)
      && h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED')) { recreated++; h.write(file, '[Timer]\n', 0o644); }
    return run(exe, argv, options);
  };
  const start = h.events.length;
  const result = await create().execute('revoke');
  const slice = h.events.slice(start);
  assert.equal(recreated, 1, 'B4_EXPIRY_POST_RELOAD_STATE_CONSTRUCTED');
  const unlink = slice.findIndex(e => e === `unlink:${file}`);
  assert.ok(unlink >= 0, 'B4_EXPIRY_POST_RELOAD_REMOVAL_ISSUED');
  assert.ok(slice.slice(unlink).some(e => e === 'command:/usr/bin/systemctl:daemon-reload'), 'B4_EXPIRY_POST_RELOAD_RELOADED');
  assert.equal(h.exists(file), true, 'B4_EXPIRY_POST_RELOAD_NOT_RETIRED');
  assert.equal(result.ok, false, `B4_EXPIRY_POST_RELOAD_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_EXPIRY_POST_RELOAD_NAMED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), 'B4_EXPIRY_POST_RELOAD_STEP_NAMED');
  unfinished(h, 'B4_EXPIRY_POST_RELOAD');
  // Once the mechanism stays removed, the same teardown completes.
  h.boundary.run = run;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_EXPIRY_POST_RELOAD_RECOVERED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_POST_RELOAD_RETIRED_AFTER_RECOVERY');
}

// SHU-71 expiry-retirement drift, second correction round. The controls below
// close the gaps an independent verifier demonstrated at
// `eb23e258247a03ea678676a73ba3e2d0a13da175`: the durable removal receipt was
// allowed to SKIP the custody pre-condition on the retry path, the receipt's
// position relative to the removal loop was pinned by nothing, the
// `ACT_COMMAND_FAILED` door of the disable catch was pinned by nothing, and the
// two post-condition conjuncts could not be told apart.
//
// Interrupt a teardown inside the removal loop: the durable receipt is written,
// `unlink` of `file` throws, and the process dies with the pair still in the
// state this returns. Both unit files are still present when the fault is
// planted on the FIRST unit of EXPIRY_UNITS (the timer); the timer is already
// gone when it is planted on the second (the service).
async function interruptExpiryRemoval(create, h, file, name) {
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_INSTALLED`);
  h.faults.before = event => event === `unlink:${file}`;
  const result = await create().execute('revoke');
  h.faults.before = null;
  assert.equal(result.ok, false, `${name}_INTERRUPTED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_INTERRUPTED_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_INTERRUPTED_STEP_NAMED`);
  // The load-bearing ordering, observed where its inversion is observable: the
  // receipt is durable BEFORE the unlink that was interrupted. Appended after
  // the loop instead, this interrupted state carries no receipt at all and the
  // retry below is indistinguishable from foreign drift - a permanent wedge.
  assert.ok(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), `${name}_RECEIPT_BEFORE_REMOVAL`);
  unfinished(h, name);
  return result;
}
// F-02. A teardown interrupted part-way through the removal loop: the receipt
// is durable before the unlinks, one durable unit file is already gone, and the
// retry finishes the removal rather than refusing its own half-done work. Only
// the correct order can satisfy this; the inversion leaves no receipt here.
export async function expiryInterruptedRemovalCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const [timer, service] = [`/etc/systemd/system/${expiryTimer(h)}`, `/etc/systemd/system/shu71-expiry-${h.id}.service`];
  await interruptExpiryRemoval(create, h, service, 'B4_EXPIRY_INTERRUPTED_REMOVAL');
  // Exactly the half-removed pair: our own work, proven by the receipt.
  assert.equal(h.exists(timer), false, 'B4_EXPIRY_INTERRUPTED_REMOVAL_FIRST_UNIT_GONE');
  assert.equal(h.exists(service), true, 'B4_EXPIRY_INTERRUPTED_REMOVAL_SECOND_UNIT_PRESENT');
  const start = h.events.length;
  const result = await create().execute('resume');
  assert.equal(result.state, 'REVOKED', `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, 'B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_OK');
  assert.ok(h.events.slice(start).some(e => e === `unlink:${service}`), 'B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_FINISHES_UNLINK');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_INTERRUPTED_REMOVAL_RETIRED');
}
// F-01. The receipt is not a custody waiver. On the retry path a unit file that
// is still PRESENT but has drifted out of root custody - here a second name for
// the inode systemd loaded - must halt, exactly as it does on the first pass.
// Accepting it disables and unlinks the unit path while the other name keeps
// the inode, and reports that as a clean retirement.
export async function expiryInterruptedCustodyDriftCheck(createProduction, h, unit = 'timer') {
  const create = () => createProduction(h.id, h.boundary);
  const timer = `/etc/systemd/system/${expiryTimer(h)}`, file = `/etc/systemd/system/shu71-expiry-${h.id}.${unit}`;
  const name = `B4_EXPIRY_INTERRUPTED_CUSTODY_${unit}`;
  // Interrupted at the FIRST unlink, so the receipt exists and both durable
  // unit files are still on disk - the verifier's demonstrated retry state.
  await interruptExpiryRemoval(create, h, timer, name);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_BOTH_UNITS_STILL_PRESENT`);
  const close = plantHardlink(h, file, unit);
  try {
    const s = h.boundary.fs.lstatSync(file);
    assert.equal(s.nlink, 2, `${name}_SECOND_NAME_PLANTED`);
    assert.equal(s.isFile() && !s.isSymbolicLink() && s.uid === 0 && s.gid === 0 && !(s.mode & 0o022), true, `${name}_ONLY_LINK_TERM_BROKEN`);
    const start = h.events.length;
    const result = await create().execute('resume');
    assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
    assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
    assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_BEFORE_DISABLE`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_UNITS_NOT_UNLINKED`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_UNITS_RETAINED`);
    unfinished(h, `${name}_RETRY`);
  } finally { await close(); }
  // The second name removed, the same retry finishes the interrupted removal.
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}
// F-03, the `ACT_COMMAND_FAILED` door of the disable catch. `systemctl disable`
// exits NON-ZERO for a journal-proven installed timer whose end state is
// otherwise spotless: idle, not enabled, both files in root custody. Nothing
// but the refusal conjuncts can produce a refusal here, so a catch that accepts
// any typed command failure reports this as a successful retirement.
export async function expiryDisableExitFailureCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_EXPIRY_DISABLE_EXIT_SETUP');
  assert.ok(h.journal().some(e => e.event === 'ARMED'), 'B4_EXPIRY_DISABLE_EXIT_JOURNAL_PROVES_INSTALLED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_DISABLE_EXIT_UNITS_PRESENT');
  h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h));
  const run = h.boundary.run;
  let exits = 0;
  h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable' && argv.at(-1) === expiryTimer(h)) { exits++; return { status: 1, stdout: '' }; }
    return result;
  };
  const start = h.events.length;
  const result = await create().execute('revoke');
  assert.equal(exits, 1, 'B4_EXPIRY_DISABLE_EXIT_NONZERO_ISSUED');
  assert.ok(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), 'B4_EXPIRY_DISABLE_EXIT_COMMAND_ISSUED');
  assert.equal(result.ok, false, `B4_EXPIRY_DISABLE_EXIT_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_EXPIRY_DISABLE_EXIT_NAMED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), 'B4_EXPIRY_DISABLE_EXIT_STEP_NAMED');
  assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, 'B4_EXPIRY_DISABLE_EXIT_UNITS_NOT_UNLINKED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_DISABLE_EXIT_UNITS_RETAINED');
  assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, 'B4_EXPIRY_DISABLE_EXIT_NO_RECEIPT');
  unfinished(h, 'B4_EXPIRY_DISABLE_EXIT');
  h.boundary.run = run;
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_EXPIRY_DISABLE_EXIT_RECOVERED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_DISABLE_EXIT_RETIRED_AFTER_RECOVERY');
}
// F-04. `expiryPostConditionCheck` ends the unit BOTH active and enabled, so
// either conjunct alone still refuses and neither can be attributed. These two
// make each conjunct independently reachable: the unit ends active but not
// enabled, and not active but enabled. In both, the OTHER conjunct is
// measurably satisfied, so only the named one can produce the refusal - and an
// inert conjunct destroys the durable unit files of a unit that is still live
// or still enabled, which is what each control observes.
async function expiryPostConditionConjunct(createProduction, h, variant) {
  const create = () => createProduction(h.id, h.boundary);
  const name = `B4_EXPIRY_POSTCONDITION_${variant.toUpperCase()}`;
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  const run = h.boundary.run;
  h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable' && argv.at(-1) === expiryTimer(h)) {
      if (variant === 'active') h.active.set(expiryTimer(h), 'active');
      else h.enabled.add(expiryTimer(h));
    }
    return result;
  };
  const result = await create().execute('revoke');
  // Exactly one conjunct is false at the point of measurement.
  assert.equal(h.active.get(expiryTimer(h)) ?? 'inactive', variant === 'active' ? 'active' : 'inactive', `${name}_ACTIVE_STATE`);
  assert.equal(h.enabled.has(expiryTimer(h)), variant === 'enabled', `${name}_ENABLED_STATE`);
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_UNITS_RETAINED`);
  unfinished(h, name);
  h.boundary.run = run;
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RETIRED_AFTER_RECOVERY`);
}
export const expiryActivePostConditionCheck = (createProduction, h) => expiryPostConditionConjunct(createProduction, h, 'active');
export const expiryEnabledPostConditionCheck = (createProduction, h) => expiryPostConditionConjunct(createProduction, h, 'enabled');
// The other door of the same catch: a disable that exits non-zero where the
// journal CANNOT vouch for the installation. `retired`: the mechanism really is
// absent, `disable` exits 1 because the unit file was never created, and the
// teardown must complete rather than wedge. `present`: the mechanism is right
// there, so the same non-zero exit is drift and must halt. Together they pin
// both halves of `!installed && expiryRetired()`.
export async function expiryUninstalledDisableCheck(createProduction, h, variant = 'retired') {
  const create = () => createProduction(h.id, h.boundary);
  const name = `B4_EXPIRY_UNINSTALLED_${variant.toUpperCase()}`;
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  // An authentic retained prefix of this episode's own journal that records the
  // forward attempt and neither ARMED nor any DONE for the creating step: the
  // phase stays inconclusive and `installed` is false.
  const rows = h.journal(), stop = rows.findIndex(e => e.event === 'RUN_ATTEMPT_STARTED');
  assert.ok(stop > 0, `${name}_PREFIX_AUTHENTIC`);
  assert.equal(rows.slice(0, stop + 1).some(e => e.event === 'ARMED' || e.step === 'expiry-watch'), false, `${name}_PREFIX_NOT_INSTALLED`);
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/recovery.jsonl`, rows.slice(0, stop + 1).map(e => JSON.stringify(e)).join('\n') + '\n');
  h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h));
  const run = h.boundary.run;
  let exits = 0;
  if (variant === 'retired') for (const path of expiryUnits(h)) fs.rmSync(h.root + path);
  else h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable' && argv.at(-1) === expiryTimer(h)) { exits++; return { status: 1, stdout: '' }; }
    return result;
  };
  const start = h.events.length;
  const result = await create().execute('resume');
  assert.ok(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), `${name}_COMMAND_ISSUED`);
  if (variant === 'retired') {
    // The command's own refusal, from the modelled host: no unit file, exit 1.
    assert.equal(result.state, 'REVOKED', `${name}_COMPLETES: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true, `${name}_NO_WEDGE`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_NOTHING_TO_REMOVE`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_STAYS_RETIRED`);
    return;
  }
  assert.equal(exits, 1, `${name}_NONZERO_ISSUED`);
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_UNITS_NOT_UNLINKED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_UNITS_RETAINED`);
  h.boundary.run = run;
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RETIRED_AFTER_RECOVERY`);
}
// The second disjunct of the `installed` derivation. Interrupted after the
// expiry-watch step reached its durable DONE row but before ARMED, the mechanism
// is installed and the journal proves it by that row alone. Custody drift on it
// must halt: reading installation from ARMED only would disable and destroy a
// drifted unit file in exactly this window.
export async function expiryInstalledBeforeArmedCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const file = `/etc/systemd/system/${expiryTimer(h)}`;
  let dead = false;
  h.faults.before = event => dead || (dead = event === 'command:/usr/bin/systemctl:restart shu-supervisor.service');
  await create().execute('run').catch(() => {});
  h.faults.before = null;
  assert.equal(dead, true, 'B4_EXPIRY_BEFORE_ARMED_INTERRUPTED');
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'expiry-watch'), 'B4_EXPIRY_BEFORE_ARMED_INSTALL_DONE');
  assert.equal(h.journal().some(e => e.event === 'ARMED'), false, 'B4_EXPIRY_BEFORE_ARMED_NOT_ARMED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_BEFORE_ARMED_UNITS_INSTALLED');
  const close = plantHardlink(h, file, 'timer');
  try {
    assert.equal(h.boundary.fs.lstatSync(file).nlink, 2, 'B4_EXPIRY_BEFORE_ARMED_SECOND_NAME_PLANTED');
    const start = h.events.length;
    const result = await create().execute('revoke');
    assert.equal(result.ok, false, `B4_EXPIRY_BEFORE_ARMED_REFUSED: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B4_EXPIRY_BEFORE_ARMED_NAMED');
    assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), 'B4_EXPIRY_BEFORE_ARMED_STEP_NAMED');
    assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, 'B4_EXPIRY_BEFORE_ARMED_BEFORE_DISABLE');
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, 'B4_EXPIRY_BEFORE_ARMED_UNITS_RETAINED');
    unfinished(h, 'B4_EXPIRY_BEFORE_ARMED');
  } finally { await close(); }
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_EXPIRY_BEFORE_ARMED_RECOVERED');
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, 'B4_EXPIRY_BEFORE_ARMED_UNITS_REMOVED');
}
