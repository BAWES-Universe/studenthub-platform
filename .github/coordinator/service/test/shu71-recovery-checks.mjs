import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { digest } from '../shu71-journal.mjs';
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
    // Install symlinks are compared as links, never followed: a leftover
    // <target>.wants/<unit> whose unit file is gone is a dangling link, and
    // reading through it would turn real modelled state into an ENOENT.
    result[p] = st.isSymbolicLink() ? `link:${fs.readlinkSync(h.root + p)}`
      : st.isDirectory() ? 'dir' : fs.readFileSync(h.root + p).toString('base64');
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
  const timer = `shu71-expiry-${h.id}.timer`, service = `shu71-expiry-${h.id}.service`;
  let restore = () => {};
  if (drift === 'supervisor') h.active.set('shu-supervisor.service', 'active');
  else if (drift === 'timer-file') h.write(`/etc/systemd/system/${timer}`, '[Timer]\n', 0o644);
  else if (drift === 'timer-active') h.active.set(timer, 'active');
  // The drift only the never-created branch refuses: BOTH durable unit files
  // present and in perfect root custody for a mechanism the journal proves was
  // never created. Every other clause of the retirement is satisfied by it, so
  // without that branch the pair is disabled, unlinked and reported retired.
  else if (drift === 'both-files') for (const [unit, body] of [[timer, '[Timer]\n'], [`shu71-expiry-${h.id}.service`, '[Service]\n']])
    h.write(`/etc/systemd/system/${unit}`, body, 0o644);
  // The companion half of expiryRetired()'s absence conjunct. Only the .service
  // unit file is there, so every OTHER term of expiryRetired() is satisfied -
  // the timer unit is idle and systemd reports no unit file state for it - and
  // only `EXPIRY_UNITS.every(unitFileAbsent)` can refuse the leftover half of a
  // mechanism the journal proves was never created.
  else if (drift === 'service-file') h.write(`/etc/systemd/system/shu71-expiry-${h.id}.service`, '[Service]\n', 0o644);
  // P154D-02. The companion service is MEASURABLY RUNNING and nothing else is:
  // no unit file anywhere, the timer idle and unknown to systemd. Every other
  // term of expiryRetired() is satisfied, so only the companion's own liveness
  // conjunct can refuse - and without it the teardown issues no stop, leaves
  // the service running and reports a clean retirement, which is the exact
  // state the verifier measured.
  else if (drift === 'service-active') h.active.set(service, 'active');
  // P154D-04. Enablement survives the unit file: `enable` writes an install
  // symlink under <target>.wants/, and removing the unit file does not remove
  // it. Both durable files are absent here and the leftover link is the whole
  // drift, so only the companion's enablement conjunct can refuse. The
  // `disabled` half is the same leftover link with the unit not enabled: a
  // residue of the mechanism either way, and neither answer is `not-found`.
  else if (drift === 'service-enabled-link') h.wants.add(service), h.enabled.add(service);
  else if (drift === 'service-disabled-link') h.wants.add(service);
  else if (drift === 'timer-enabled-link') h.wants.add(timer), h.enabled.add(timer);
  // The companion's durable FILE, measured where systemd's loaded view cannot
  // stand in for it: the file is planted after systemd's last reload, so it is
  // on disk and absent from the loaded view. Liveness and enablement both
  // answer the retired answer, and only EXPIRY_UNITS.every(unitFileAbsent) can
  // refuse the leftover half of the mechanism.
  else if (drift === 'service-file-stale-view') {
    h.systemd.unitFileViewCached = true;
    const run = h.boundary.run;
    restore = () => { h.boundary.run = run; h.systemd.unitFileViewCached = false; };
    h.boundary.run = (exe, argv, options) => {
      const result = run(exe, argv, options);
      if (exe === '/usr/bin/systemctl' && argv[0] === 'daemon-reload') h.write(`/etc/systemd/system/${service}`, '[Service]\n', 0o644);
      return result;
    };
  }
  else h.enabled.add(timer), h.write(`/etc/systemd/system/${timer}`, '[Timer]\n', 0o644);
  const result = await preArmEnvHalt(createProduction, h);
  restore();
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
  // SHU-280's fourteenth round. The destroyed log is also what stops the
  // RESTORATION from claiming the branch - an empty journal carries no
  // `local-reseed` INTENT row - so this episode's PUBLISHED head is still
  // standing on the lane when the receipt is written, and the final
  // measurement, which is no longer gated on that same row, refuses to close
  // over it. Fail-closed is what this control exists to pin and it is
  // unchanged: the kill is still issued and the credential is still revoked.
  // What changed is that the receipt now NAMES what it left behind instead of
  // reporting `REVOKED` over a branch the next mint will refuse.
  assert.equal(result.ok, false, `B4_DESTROYED_JOURNAL_NOT_PROOF: ${JSON.stringify(result)}`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_BRANCH_UNRESTORED'),
    `B4_DESTROYED_JOURNAL_NOT_PROOF: ${JSON.stringify(result)}`);
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
  'restore-shu-140', 'restore-shu-254', 'restore-branch', 'fixtures', 'evidence-broker', 'archive', 'manifest', 'expiry-timer']);
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
//
// A-11/B-11 round: a throw is now its OWN named refusal rather than the state
// the caller named. The requirement the assertion below pins is unchanged - a
// predicate that threw may never be a measured true, and may never reach the
// caller as a bare error - and it is now stated as the name it refuses under.
export function predicateRefusalCheck(api) {
  const boom = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  let measured;
  try { measured = api.measuredPredicate(boom); } catch (error) { measured = error; }
  assert.equal(measured?.code, 'ACT_TEARDOWN_MEASUREMENT', 'B4_EXPIRY_PREDICATE_THROW_REFUSES');
  assert.notEqual(measured, true, 'B4_EXPIRY_PREDICATE_THROW_REFUSES');
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
  const name = `B4_EXPIRY_POSTCONDITION_${variant.toUpperCase().replaceAll('-', '_')}`;
  const companion = `shu71-expiry-${h.id}.service`;
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  const run = h.boundary.run;
  h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable' && argv.at(-1) === expiryTimer(h)) {
      if (variant === 'active') h.active.set(expiryTimer(h), 'active');
      // P154D-02. The COMPANION halves of the same post-condition: a disable
      // that leaves the service it triggers running, or enabled, is drift the
      // exit status cannot report, and the timer's own end state is spotless in
      // both - so only the companion conjunct being measured can refuse.
      else if (variant === 'service-active') h.active.set(companion, 'active');
      else if (variant === 'service-enabled') h.enabled.add(companion);
      else h.enabled.add(expiryTimer(h));
    }
    return result;
  };
  const result = await create().execute('revoke');
  // Exactly one conjunct is false at the point of measurement.
  assert.equal(h.active.get(expiryTimer(h)) ?? 'inactive', variant === 'active' ? 'active' : 'inactive', `${name}_ACTIVE_STATE`);
  assert.equal(h.enabled.has(expiryTimer(h)), variant === 'enabled', `${name}_ENABLED_STATE`);
  assert.equal(h.active.get(companion) ?? 'inactive', variant === 'service-active' ? 'active' : 'inactive', `${name}_COMPANION_ACTIVE_STATE`);
  assert.equal(h.enabled.has(companion), variant === 'service-enabled', `${name}_COMPANION_ENABLED_STATE`);
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_UNITS_RETAINED`);
  unfinished(h, name);
  h.boundary.run = run;
  // Nothing in the teardown stops or disables the companion, so the drift this
  // control planted on it is cleared here before the recovery retry: the rule
  // refuses the drift, and the same teardown completes once it is gone.
  h.active.set(companion, 'inactive'); h.enabled.delete(companion);
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RETIRED_AFTER_RECOVERY`);
}
export const expiryActivePostConditionCheck = (createProduction, h) => expiryPostConditionConjunct(createProduction, h, 'active');
export const expiryEnabledPostConditionCheck = (createProduction, h) => expiryPostConditionConjunct(createProduction, h, 'enabled');
export const expiryCompanionActivePostConditionCheck = (createProduction, h) => expiryPostConditionConjunct(createProduction, h, 'service-active');
export const expiryCompanionEnabledPostConditionCheck = (createProduction, h) => expiryPostConditionConjunct(createProduction, h, 'service-enabled');
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
  // Not enabled means the install symlink is gone too: enablement is a durable
  // link under <target>.wants/ that outlives the unit file, so a mechanism that
  // is claimed to be entirely absent must have no link left behind either.
  h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h)); h.wants.delete(expiryTimer(h));
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

// SHU-71 expiry-retirement drift, third correction round. An independent
// verifier reviewed `f6d6711056f0356a010f28aeae3c6c70c20018cd` and returned
// BLOCK on the same property for the third time, through a third door: the
// custody pre-condition was gated on `installed`, so it was SKIPPED ENTIRELY
// where the journal could not vouch for the installation - an install
// interrupted before its durable DONE row, or a recovered log - while the
// removal loop below still unlinked whatever was present. The controls here
// pin the RESTRUCTURED rule rather than that one door: custody is a property of
// the removal, measured on every PRESENT unit file whatever the journal says,
// and the journal may only ever account for ABSENCE.
//
// A run interrupted inside `installExpiry` leaves exactly the state the
// verifier described: both durable unit files written, the INTENT row for
// `expiry-watch` durable, and neither a DONE row nor ARMED nor a removal
// receipt, so `installed` and `removing` are both false and the phase is
// inconclusive. The teardown that the failed run triggers is interrupted too -
// its `disable --now` throws an untyped error, which is a refusal - so the pair
// survives for the measured retry below.
async function interruptExpiryInstall(create, h, name) {
  const timer = expiryTimer(h);
  h.faults.before = event => [`command:/usr/bin/systemctl:enable --now ${timer}`,
    `command:/usr/bin/systemctl:disable --now ${timer}`].includes(event);
  const halt = await create().execute('run');
  h.faults.before = null;
  assert.equal(halt.ok, false, `${name}_INSTALL_INTERRUPTED: ${JSON.stringify(halt)}`);
  const rows = h.journal();
  assert.ok(rows.some(e => e.event === 'INTENT' && e.step === 'expiry-watch'), `${name}_INSTALL_INTENT_DURABLE`);
  assert.equal(rows.some(e => e.event === 'DONE' && e.step === 'expiry-watch'), false, `${name}_NO_DURABLE_DONE_ROW`);
  assert.equal(rows.some(e => e.event === 'ARMED'), false, `${name}_NOT_ARMED`);
  assert.equal(rows.some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_NO_RECEIPT`);
  assert.equal(rows.some(e => e.event === 'TEARDOWN_COMPLETE'), false, `${name}_TEARDOWN_UNFINISHED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_BOTH_UNITS_PRESENT`);
  return halt;
}
// An authentic retained PREFIX of this episode's own journal, ending at the
// forward attempt: the log is `recovered`, holds neither ARMED nor any DONE row
// for the creating step, and the mechanism really is installed on disk.
function recoverLogWithoutInstallation(h, name) {
  const rows = h.journal(), stop = rows.findIndex(e => e.event === 'RUN_ATTEMPT_STARTED');
  assert.ok(stop > 0, `${name}_PREFIX_AUTHENTIC`);
  assert.equal(rows.slice(0, stop + 1).some(e => e.event === 'ARMED' || e.step === 'expiry-watch'), false, `${name}_PREFIX_NOT_INSTALLED`);
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/recovery.jsonl`, rows.slice(0, stop + 1).map(e => JSON.stringify(e)).join('\n') + '\n');
}
// Plant exactly one broken custody term on one of the two durable unit files,
// leaving every other term - and the companion file - intact. Returns the
// restore function; `variant` is one of CUSTODY_VARIANTS above.
async function plantCustodyDrift(h, variant) {
  const unit = CUSTODY_UNITS[variant] ?? 'timer';
  const file = `/etc/systemd/system/shu71-expiry-${h.id}.${unit}`;
  let close = null;
  if (variant === 'non-root-owner') h.owners.set(file, [999, 0]);
  else if (variant === 'non-root-group') h.owners.set(file, [0, 982]);
  else if (variant === 'group-writable') fs.chmodSync(h.root + file, 0o664);
  else if (variant === 'world-writable') fs.chmodSync(h.root + file, 0o646);
  else if (CUSTODY_VARIANTS[variant] === 'links') close = plantHardlink(h, file, unit);
  else { fs.rmSync(h.root + file); close = await plantNonRegularFile(h.root + file); }
  // `close` releases the planted resource and is always safe to run, including
  // where a mutant has already unlinked the file: it never masks the failing
  // assertion that killed the mutant. `restore` rebuilds root custody and runs
  // only on the passing path, after the measured refusal.
  return { file, unit,
    close: async () => { if (close) await close(); },
    restore: () => {
      if (variant === 'non-regular-file') h.write(file, unit === 'timer' ? '[Timer]\n' : '[Service]\n', 0o644);
      h.owners.set(file, [0, 0]);
      fs.chmodSync(h.root + file, 0o644);
    } };
}
const custodyTerms = (h, target) => {
  const s = h.boundary.fs.lstatSync(target);
  return { shape: s.isFile() && !s.isSymbolicLink(), links: s.nlink === 1, owner: s.uid === 0,
    group: s.gid === 0, group_mode: !(s.mode & 0o020), world_mode: !(s.mode & 0o002) };
};
// P154C-01. The journal vouches for NOTHING about the installation - `installed`
// is false either because the install was interrupted before its durable DONE
// row or because the log is a recovered prefix - and a durable expiry unit file
// is PRESENT and out of root custody. Gated on the journal, the pre-condition
// never runs here at all and the drifted file is disabled, unlinked and
// reported as a clean retirement. Custody being a property of the removal, it
// halts by name before the command, exactly as it does for a proven install.
export async function expiryJournalBlindCustodyCheck(createProduction, h, state, variant) {
  const create = () => createProduction(h.id, h.boundary);
  const name = `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_${state}_${variant}`;
  if (state === 'interrupted-install') await interruptExpiryInstall(create, h, name);
  else {
    assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
    recoverLogWithoutInstallation(h, name);
  }
  const { file, close, restore } = await plantCustodyDrift(h, variant);
  try {
    // Exactly one custody term is broken, on exactly one of the two files, so
    // a control cannot survive the mutant that removes the term it pins.
    assert.deepEqual(Object.entries(custodyTerms(h, file)).filter(([, ok]) => !ok).map(([term]) => term),
      [CUSTODY_VARIANTS[variant]], `${name}_EXACTLY_ONE_TERM`);
    for (const other of expiryUnits(h).filter(p => p !== file))
      assert.deepEqual(Object.entries(custodyTerms(h, other)).filter(([, ok]) => !ok).map(([term]) => term), [],
        `${name}_OTHER_UNIT_INTACT`);
    // Both durable unit files are still there, so `disable --now` would succeed
    // on the modelled host: the refusal below is the custody rule's own.
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_BOTH_UNITS_PRESENT`);
    const start = h.events.length;
    const result = await create().execute('resume');
    assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
    assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
    assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_BEFORE_DISABLE`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_UNITS_NOT_UNLINKED`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_UNITS_RETAINED`);
  } finally { await close(); }
  restore();
  // Root custody restored in the SAME journal state, the retirement completes
  // and removes both durable unit files: the rule refuses drift, not the state.
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}
// The other half of the same rule: what the journal may excuse is ABSENCE, and
// only where it accounts for it. `retired`: the journal vouches for nothing and
// the mechanism is measurably, entirely retired, so the teardown completes
// rather than wedging. `half`: one durable unit file is gone and the other is
// right there in perfect custody, with no receipt and no journal account of the
// gap - that is drift, and it halts before the command rather than quietly
// finishing someone else's removal.
export async function expiryAbsenceAccountedCheck(createProduction, h, state, shape) {
  const create = () => createProduction(h.id, h.boundary);
  const name = `B4_EXPIRY_ABSENCE_${state}_${shape}`;
  const [service, timer] = expiryUnits(h);
  if (state === 'interrupted-install') await interruptExpiryInstall(create, h, name);
  else {
    assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
    recoverLogWithoutInstallation(h, name);
  }
  h.active.set(timer.replace('/etc/systemd/system/', ''), 'inactive');
  h.enabled.delete(expiryTimer(h)); h.wants.delete(expiryTimer(h));
  for (const path of shape === 'retired' ? expiryUnits(h) : [service]) fs.rmSync(h.root + path);
  // Measured before the teardown: the file that is still there is in perfect
  // root custody, so only the unaccounted-for ABSENCE of its companion can
  // produce the refusal below.
  if (shape === 'half') assert.deepEqual(Object.entries(custodyTerms(h, timer)).filter(([, ok]) => !ok).map(([term]) => term), [], `${name}_PRESENT_UNIT_IN_CUSTODY`);
  const start = h.events.length;
  const result = await create().execute('resume');
  if (shape === 'retired') {
    assert.equal(result.state, 'REVOKED', `${name}_COMPLETES: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true, `${name}_NO_WEDGE`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_NOTHING_TO_REMOVE`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_STAYS_RETIRED`);
    return;
  }
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_BEFORE_DISABLE`);
  assert.equal(h.exists(timer), true, `${name}_PRESENT_UNIT_RETAINED`);
  assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_NO_RECEIPT`);
  // The companion restored, the gap is accounted for and the same teardown
  // completes and removes both.
  h.write(service, '[Service]\n', 0o644);
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}
// The `!installed` half of the absence rule. The journal PROVES this episode
// created the mechanism - by ARMED, or by the durable DONE row alone in the
// window before it - and the mechanism has vanished entirely, with no removal
// receipt to account for it. The end state is otherwise spotless: idle, not
// enabled, nothing left on disk. Only the absence clause can refuse it, and it
// must, before any command is issued: an installation that disappeared without
// this teardown removing it is drift, not a completed retirement.
export async function expiryVanishedMechanismCheck(createProduction, h, proof = 'armed') {
  const create = () => createProduction(h.id, h.boundary);
  const name = `B4_EXPIRY_VANISHED_${proof.toUpperCase().replaceAll('-', '_')}`;
  if (proof === 'armed') assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  else {
    let dead = false;
    h.faults.before = event => dead || (dead = event === 'command:/usr/bin/systemctl:restart shu-supervisor.service');
    await create().execute('run').catch(() => {});
    h.faults.before = null;
    assert.equal(dead, true, `${name}_INTERRUPTED`);
    assert.equal(h.journal().some(e => e.event === 'ARMED'), false, `${name}_NOT_ARMED`);
  }
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'expiry-watch'), `${name}_JOURNAL_PROVES_INSTALLED`);
  assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_NO_RECEIPT`);
  for (const path of expiryUnits(h)) { assert.equal(h.exists(path), true, `${name}_INSTALLED`); fs.rmSync(h.root + path); }
  h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h)); h.wants.delete(expiryTimer(h));
  const start = h.events.length;
  const result = await create().execute('revoke');
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_BEFORE_DISABLE`);
  assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_STILL_NO_RECEIPT`);
  unfinished(h, name);
  // The durable pair restored, the same teardown completes and removes both.
  for (const [path, body] of expiryUnits(h).map(p => [p, p.endsWith('.timer') ? '[Timer]\n' : '[Service]\n'])) h.write(path, body, 0o644);
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}
// The SECOND measurement. `disable --now` runs between the custody check at the
// top of the retirement and the unlink, and a unit file can drift in that
// window - here a second name is planted on the inode by the disable itself.
// The file about to be unlinked must be held in custody NOW, not as it was
// before the command; measured only once, the retirement destroys the unit path
// and leaves the inode, and its holder, behind.
export async function expiryUnlinkCustodyCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const name = 'B4_EXPIRY_UNLINK_CUSTODY';
  const file = `/etc/systemd/system/${expiryTimer(h)}`;
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  assert.deepEqual(Object.entries(custodyTerms(h, file)).filter(([, ok]) => !ok).map(([term]) => term), [], `${name}_CUSTODY_HELD_AT_ENTRY`);
  const run = h.boundary.run;
  let close = null;
  h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable' && argv.at(-1) === expiryTimer(h) && !close) close = plantHardlink(h, file, 'timer');
    return result;
  };
  try {
    const start = h.events.length;
    const result = await create().execute('revoke');
    assert.ok(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), `${name}_DISABLE_ISSUED`);
    assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
    assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_UNITS_NOT_UNLINKED`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_UNITS_RETAINED`);
    // Measured after the retention assertions, so an unlink the re-measure
    // should have prevented is reported by its own name rather than by an
    // ENOENT raised while probing the file it destroyed.
    let links = null;
    try { links = h.boundary.fs.lstatSync(file).nlink; } catch { /* reported as null */ }
    assert.equal(links, 2, `${name}_SECOND_NAME_PLANTED_BY_DISABLE`);
    assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_NO_RECEIPT`);
    unfinished(h, name);
  } finally { h.boundary.run = run; if (close) await close(); }
  // The second name gone, the same teardown completes and removes both.
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}

// SHU-71 expiry-retirement drift, fourth correction round. An independent
// verifier reviewed `56a1a33334e209ff4d90eb464342ddee22922f69`, could not break
// the custody restructure through any of five doors, and returned BLOCK on a
// different property: the end-state tolerance measured the TIMER only. The
// mechanism is two units - the timer exists to START the companion service, and
// `disable --now <timer>` does not touch that service - so a teardown could
// report `{"ok":true,"state":"REVOKED"}`, issue no stop, and leave
// `shu71-expiry-<id>.service` measurably ACTIVE. The controls below construct
// that state through each door it is reachable by.
const expiryCompanion = h => `shu71-expiry-${h.id}.service`;
// Ask the modelled host, exactly as the module does.
const unitShow = (h, unit, property) =>
  String(h.boundary.run('/usr/bin/systemctl', ['show', `--property=${property}`, '--value', unit], {}).stdout ?? '').trim();
// P154D-02. A measurably RUNNING companion service is a mechanism that is not
// retired, and it must never coexist with a reported clean retirement.
//
// `installed`: the journal proves this episode created the mechanism, both
// durable unit files are present and in perfect root custody, the timer is
// exactly where a legitimate teardown finds it - and the companion is live. The
// refusal carries its own name, `ACT_TEARDOWN_EXPIRY_SERVICE`, reported in
// `failures[]` alongside the reviewed effect step's own name, and it fires
// BEFORE `disable --now` so the timer is never disabled around a live service.
//
// `journal-blind`: the verifier's measured state, rebuilt term for term - a
// recovered log, BOTH durable unit files deleted, no removal receipt, the timer
// `ActiveState=inactive` with an empty `UnitFileState`, and the companion
// active. This is the state that returned `ok:true` with no stop command.
//
// `retired-episode`: the same drift on the retired episode's own receipt path,
// where the refusal code is observable literally at the module boundary.
export async function expiryLiveCompanionCheck(createProduction, h, state = 'installed') {
  const create = () => createProduction(h.id, h.boundary);
  const name = `B4_EXPIRY_LIVE_COMPANION_${state.toUpperCase().replaceAll('-', '_')}`;
  const companion = expiryCompanion(h);
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  if (state === 'retired-episode') {
    assert.equal((await create().execute('revoke')).state, 'REVOKED', `${name}_TEARDOWN_COMPLETED`);
    assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), `${name}_RECEIPT_DURABLE`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_MECHANISM_REMOVED`);
    h.active.set(companion, 'active');
    assert.equal(unitShow(h, companion, 'ActiveState'), 'active', `${name}_COMPANION_MEASURABLY_ACTIVE`);
    const drifted = await create().execute('revoke');
    assert.equal(drifted.ok, false, `${name}_REFUSED: ${JSON.stringify(drifted)}`);
    assert.equal(drifted.state, 'HALT', `${name}_HALTS`);
    assert.equal(drifted.code, 'ACT_TEARDOWN_EXPIRY_SERVICE', `${name}_NAMED`);
    h.active.set(companion, 'inactive');
    const settled = await create().execute('revoke');
    assert.equal(settled.state, 'REVOKED', `${name}_RECOVERED: ${JSON.stringify(settled)}`);
    return;
  }
  if (state === 'journal-blind') {
    recoverLogWithoutInstallation(h, name);
    for (const path of expiryUnits(h)) fs.rmSync(h.root + path);
    h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h)); h.wants.delete(expiryTimer(h));
  }
  // P154D-06, the FOREIGN half of the invocation exclusion. This process really
  // is running under systemd and really does have an INVOCATION_ID, and the live
  // companion belongs to a DIFFERENT start. The exclusion is bounded by exact
  // invocation identity, so presence of an id on either side excludes nothing
  // and the refusal is by its own name, exactly as for an operator CLI run.
  if (state === 'foreign-invocation') h.selfInvocation.id = 'f'.repeat(32);
  h.active.set(companion, 'active');
  if (state === 'foreign-invocation') {
    assert.match(unitShow(h, companion, 'InvocationID'), /^[0-9a-f]{32}$/, `${name}_COMPANION_HAS_ITS_OWN_INVOCATION`);
    assert.match(h.boundary.invocationId(), /^[0-9a-f]{32}$/, `${name}_PROCESS_HAS_AN_INVOCATION`);
    assert.notEqual(unitShow(h, companion, 'InvocationID'), h.boundary.invocationId(), `${name}_INVOCATIONS_DIFFER`);
  }
  // The state, measured through the same interface the module reads, before
  // the teardown runs: nothing here is assumed.
  assert.equal(unitShow(h, companion, 'ActiveState'), 'active', `${name}_COMPANION_MEASURABLY_ACTIVE`);
  if (state === 'journal-blind') {
    assert.equal(unitShow(h, expiryTimer(h), 'ActiveState'), 'inactive', `${name}_TIMER_IDLE`);
    assert.equal(unitShow(h, expiryTimer(h), 'UnitFileState'), '', `${name}_TIMER_UNKNOWN`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_BOTH_UNIT_FILES_DELETED`);
    assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_NO_RECEIPT`);
  } else {
    assert.ok(h.journal().some(e => e.event === 'ARMED'), `${name}_JOURNAL_PROVES_INSTALLED`);
    for (const path of expiryUnits(h)) {
      assert.equal(h.exists(path), true, `${name}_BOTH_UNIT_FILES_PRESENT`);
      assert.deepEqual(Object.entries(custodyTerms(h, path)).filter(([, ok]) => !ok).map(([term]) => term), [], `${name}_UNITS_IN_CUSTODY`);
    }
  }
  const start = h.events.length;
  const result = await create().execute(state === 'journal-blind' ? 'resume' : 'revoke');
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_SERVICE'), `${name}_COMPANION_REFUSAL_NAMED`);
  // No completion, no stop issued to the companion, no disable of the timer
  // around it, and nothing unlinked.
  assert.equal(h.events.slice(start).some(e => e.includes(`:stop ${companion}`)), false, `${name}_NO_STOP_ISSUED`);
  assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_BEFORE_DISABLE`);
  assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_UNITS_NOT_UNLINKED`);
  assert.equal(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_STILL_NO_RECEIPT`);
  assert.equal(unitShow(h, companion, 'ActiveState'), 'active', `${name}_COMPANION_STILL_RUNNING`);
  unfinished(h, name);
  // The companion measurably gone, the same teardown completes in the same
  // journal state: the rule refuses a live mechanism, not the state around it.
  h.active.set(companion, 'inactive');
  if (state === 'journal-blind') {
    for (const [path, body] of expiryUnits(h).map(p => [p, p.endsWith('.timer') ? '[Timer]\n' : '[Service]\n'])) h.write(path, body, 0o644);
  }
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}
// P154D-01. The `journalHas(journal, 'ARMED')` disjunct of `installed` was
// declared an equivalent mutant on a WRITER-side argument: every journal this
// module produces is prefix-closed, so ARMED implies the `expiry-watch` DONE
// row. The reader's input space is larger. `recovery.jsonl` is accepted on a
// keyless sha256 chain with no prefix check, so a chain-valid log holding ARMED
// with the DONE row removed and the chain recomputed is a log this module will
// read - and with it, `installed` is true only because of the ARMED disjunct.
// The state below is otherwise a spotless retirement, so dropping the disjunct
// makes it complete with `ok:true, state:REVOKED` and issue the disable.
const rechainJournal = rows => {
  let previous = '0'.repeat(64);
  return rows.map((row, seq) => {
    const { seq: _seq, previous: _previous, sha256: _sha256, ...event } = row;
    const payload = { seq, previous, ...event };
    const sha256 = digest(JSON.stringify(payload));
    previous = sha256;
    return { ...payload, sha256 };
  });
};
export async function expiryArmedWithoutDoneRowCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const name = 'B4_EXPIRY_ARMED_WITHOUT_DONE_ROW';
  const recovery = `/srv/shu/state/shu71-evidence/${h.id}/recovery.jsonl`;
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  const rows = rechainJournal(h.journal().filter(e => !(e.event === 'DONE' && e.step === 'expiry-watch')));
  // The log the READER accepts: chain-valid, holding ARMED, with the creating
  // step's durable DONE row removed. No writer of this module produces it; the
  // keyless chain reader takes it without a prefix check.
  assert.ok(rows.some(e => e.event === 'ARMED'), `${name}_HOLDS_ARMED`);
  assert.equal(rows.some(e => e.event === 'DONE' && e.step === 'expiry-watch'), false, `${name}_DONE_ROW_REMOVED`);
  assert.equal(rows.some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_NO_RECEIPT`);
  let previous = '0'.repeat(64);
  for (const [index, row] of rows.entries()) {
    const { sha256, ...payload } = row;
    assert.equal(payload.seq === index && payload.previous === previous && sha256 === digest(JSON.stringify(payload)), true, `${name}_CHAIN_VALID`);
    previous = sha256;
  }
  h.write(recovery, rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  // The rest of the verifier's state: the mechanism has vanished entirely and
  // nothing accounts for it - no receipt, and a journal that (without the ARMED
  // disjunct) would vouch for no installation at all.
  for (const path of expiryUnits(h)) fs.rmSync(h.root + path);
  h.active.set(expiryTimer(h), 'inactive'); h.enabled.delete(expiryTimer(h)); h.wants.delete(expiryTimer(h));
  assert.equal(unitShow(h, expiryTimer(h), 'UnitFileState'), '', `${name}_TIMER_UNKNOWN`);
  assert.equal(unitShow(h, expiryCompanion(h), 'UnitFileState'), '', `${name}_COMPANION_UNKNOWN`);
  const start = h.events.length;
  const result = await create().execute('resume');
  // Proof the reader really accepted this chain rather than falling into the
  // damaged-log path: this teardown appended its own rows to that same file.
  const written = fs.readFileSync(h.root + recovery, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(written.some(e => e.event === 'ARMED'), `${name}_READER_ACCEPTED_CHAIN`);
  assert.ok(written.some(e => ['REVOKE_REQUESTED', 'AUTHORIZATION_EXPIRED'].includes(e.event)), `${name}_READER_APPENDED_TO_CHAIN`);
  assert.equal(result.ok, false, `${name}_REFUSED: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${name}_STEP_NAMED`);
  assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_BEFORE_DISABLE`);
  assert.equal(written.some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), false, `${name}_STILL_NO_RECEIPT`);
  unfinished(h, name);
  // The durable pair restored, the same teardown completes and removes both.
  for (const [path, body] of expiryUnits(h).map(p => [p, p.endsWith('.timer') ? '[Timer]\n' : '[Service]\n'])) h.write(path, body, 0o644);
  assert.equal((await create().execute('resume')).state, 'REVOKED', `${name}_RECOVERED`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_RECOVERED_UNITS_REMOVED`);
}
// P154D-04. The fixture's own fidelity, falsifiable rather than asserted in
// prose. Every state the controls above claim to model is driven here against
// the SAME modelled host interface the module reads, and each assertion fails
// by its own name if the model cannot represent the state it claims to.
export function fixtureHostStateCheck(h) {
  const name = 'B4_FIXTURE_REPRESENTS';
  const timer = expiryTimer(h), companion = expiryCompanion(h);
  const file = unit => `/etc/systemd/system/${unit}`;
  const state = unit => unitShow(h, unit, 'UnitFileState');
  const liveness = unit => unitShow(h, unit, 'ActiveState');
  const place = (unit, present) => present
    ? h.write(file(unit), unit.endsWith('.timer') ? '[Timer]\n' : '[Service]\n', 0o644)
    : fs.rmSync(h.root + file(unit), { force: true });
  // (1) The two durable unit files, present and absent INDEPENDENTLY - all four
  // combinations, including the half-present case in either direction.
  for (const [t, s] of [[true, true], [true, false], [false, true], [false, false]]) {
    place(timer, t); place(companion, s);
    assert.equal(h.exists(file(timer)), t, `${name}_TIMER_FILE_${t}_${s}`);
    assert.equal(h.exists(file(companion)), s, `${name}_COMPANION_FILE_${t}_${s}`);
    assert.equal(state(timer), t ? 'disabled' : '', `${name}_TIMER_STATE_${t}_${s}`);
    assert.equal(state(companion), s ? 'disabled' : '', `${name}_COMPANION_STATE_${t}_${s}`);
  }
  // (2) A companion measurably ACTIVE while its own unit file is absent and the
  // timer is inactive and not found - the verifier's measured state.
  place(timer, false); place(companion, false);
  h.active.set(companion, 'active');
  assert.equal(liveness(companion), 'active', `${name}_COMPANION_ACTIVE_WITHOUT_FILE`);
  assert.equal(h.exists(file(companion)), false, `${name}_COMPANION_ACTIVE_FILE_ABSENT`);
  assert.equal(liveness(timer), 'inactive', `${name}_TIMER_INACTIVE_BESIDE_LIVE_COMPANION`);
  assert.equal(state(timer), '', `${name}_TIMER_NOT_FOUND_BESIDE_LIVE_COMPANION`);
  h.active.set(companion, 'inactive');
  // (3) Enablement that OUTLIVES the unit file: the install symlink under
  // <target>.wants/ is not removed with it, so the host still answers for a
  // unit whose file is gone - `enabled` and, for the same leftover link with
  // the unit not enabled, `disabled`. Neither is the empty answer.
  for (const unit of [timer, companion]) {
    h.wants.add(unit); h.enabled.add(unit);
    assert.equal(h.exists(file(unit)), false, `${name}_LEFTOVER_LINK_FILE_ABSENT_${unit.split('.').pop()}`);
    assert.equal(h.wants.has(unit), true, `${name}_LEFTOVER_LINK_PRESENT_${unit.split('.').pop()}`);
    assert.equal(state(unit), 'enabled', `${name}_ENABLED_WITHOUT_FILE_${unit.split('.').pop()}`);
    h.enabled.delete(unit);
    assert.equal(state(unit), 'disabled', `${name}_DISABLED_WITHOUT_FILE_${unit.split('.').pop()}`);
  }
  // (4) daemon-reload rebuilds the LOADED view and does not erase a still-present
  // install symlink. Both halves are measured: the link survives and still
  // answers, and the loaded view really was rebuilt from the unit directory.
  h.systemd.unitFileViewCached = true;
  place(timer, true);
  assert.equal(state(timer), 'disabled', `${name}_STALE_VIEW_ANSWERS_FROM_LINK`);
  h.wants.delete(timer);
  assert.equal(state(timer), '', `${name}_STALE_LOADED_VIEW_HIDES_PRESENT_FILE`);
  h.boundary.run('/usr/bin/systemctl', ['daemon-reload'], {});
  assert.equal(state(timer), 'disabled', `${name}_RELOAD_REBUILDS_LOADED_VIEW`);
  assert.equal(h.wants.has(companion), true, `${name}_RELOAD_KEEPS_WANTS_LINK`);
  assert.equal(state(companion), 'disabled', `${name}_RELOAD_KEEPS_ENABLEMENT_ANSWER`);
  h.systemd.unitFileViewCached = false;
  h.wants.delete(companion);
  place(timer, false);
  assert.equal(state(companion), '', `${name}_LINK_REMOVED_IS_NOT_FOUND`);
  // (5) P154D-06. Invocation identity, on BOTH sides, as first-class modelled
  // state rather than a per-argv reply: a unit that is measurably live answers
  // with an id of its own however it became live, a restart answers with a
  // DIFFERENT id, an exited start still answers with its own (stale, not
  // empty), a unit that never ran answers empty, and this process's own
  // INVOCATION_ID is representable both absent (an operator CLI run) and equal
  // to a named unit's current id (a unit's own ExecStart).
  const invocation = unit => unitShow(h, unit, 'InvocationID');
  assert.equal(invocation(companion), '', `${name}_NEVER_RAN_HAS_NO_INVOCATION`);
  h.active.set(companion, 'activating');
  const first = invocation(companion);
  assert.match(first, /^[0-9a-f]{32}$/, `${name}_LIVE_UNIT_HAS_AN_INVOCATION`);
  assert.equal(invocation(companion), first, `${name}_INVOCATION_IS_STABLE`);
  h.active.set(companion, 'inactive');
  assert.equal(invocation(companion), first, `${name}_EXITED_START_ANSWERS_STALE`);
  h.write(file(companion), '[Service]\n', 0o644);
  h.boundary.run('/usr/bin/systemctl', ['start', companion], {});
  const second = invocation(companion);
  assert.match(second, /^[0-9a-f]{32}$/, `${name}_RESTART_HAS_AN_INVOCATION`);
  assert.notEqual(second, first, `${name}_RESTART_MINTS_A_NEW_INVOCATION`);
  assert.equal(h.boundary.invocationId(), null, `${name}_PROCESS_OUTSIDE_SYSTEMD_HAS_NONE`);
  h.selfInvocation.id = second;
  assert.equal(h.boundary.invocationId(), second, `${name}_PROCESS_IS_A_NAMED_INVOCATION`);
  h.selfInvocation.id = null;
  h.active.set(companion, 'inactive');
  place(companion, false);
}

// SHU-71 expiry-retirement drift, fifth correction round. P154D-06. The fourth
// round's HALT-by-name refusal was correct about the state the verifier
// measured and WRONG about one state it could not distinguish from it: the
// timer-triggered path itself. `installExpiry()` writes
// `ExecStart=/usr/bin/node <installedModule> expire <id>` into
// `shu71-expiry-<id>.service` and the timer's `Unit=` names that service, so on
// the only unattended path this mechanism exists for the companion service IS
// the process performing the teardown, and a running `Type=oneshot` unit reports
// `activating`. The shipped refusal therefore fired on the very invocation doing
// the removal: the window was left torn down but not retired, the process died
// non-zero and `Restart=on-failure` under `OnUnitActiveSec=1s` restarted it
// until the start limit tripped, requiring an operator `resume`/`revoke` with
// the expiry mechanism still installed.
//
// The rule is now: the teardown proves gone the expiry mechanism MINUS the
// invocation performing the removal, bounded by exact invocation identity and
// by nothing else. These controls drive both directions of that bound - the
// shape the fourth round recorded as an unmodelled gap, and the parity of the
// same exclusion at the post-condition after `disable --now`.
//
// The modelled companion start is real state, not a per-argv reply: the unit is
// placed in the fixture's `active` map as `activating`, the fixture answers
// `InvocationID` for it from its own first-class per-unit invocation state, and
// this process's `INVOCATION_ID` is set to exactly that value through
// `h.selfInvocation`, which is what `b.invocationId()` reads.
const selfRunCompanion = (h, name, state = 'activating') => {
  const companion = expiryCompanion(h);
  h.active.set(companion, state);
  const invocation = unitShow(h, companion, 'InvocationID');
  assert.match(invocation, /^[0-9a-f]{32}$/, `${name}_COMPANION_START_HAS_AN_INVOCATION`);
  h.selfInvocation.id = invocation;
  assert.equal(unitShow(h, companion, 'ActiveState'), state, `${name}_COMPANION_MEASURABLY_${state.toUpperCase()}`);
  assert.equal(h.boundary.invocationId(), invocation, `${name}_PROCESS_IS_THAT_INVOCATION`);
  return invocation;
};
// Control 1. The timer fires, systemd starts the companion, and the companion
// runs `expire <id>`. The teardown must COMPLETE: no ACT_TEARDOWN_EXPIRY_SERVICE
// on itself, no ACT_TEARDOWN_DRIFT from its own `activating` state, the timer
// stopped and not enabled with no leftover install symlink, and both durable
// unit files gone.
// The prefix is a parameter for the same reason the live-companion control's is:
// control 4 below drives this same self-run shape as its own SETUP and must
// report under its own name, so a mutant that leaves residue behind is
// attributed to the control that observed it rather than to this one.
export async function expirySelfRunCompletesCheck(createProduction, h, name = 'B4_EXPIRY_SELF_RUN_COMPLETES') {
  const create = () => createProduction(h.id, h.boundary);
  const companion = expiryCompanion(h);
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  assert.ok(h.journal().some(e => e.event === 'ARMED'), `${name}_JOURNAL_PROVES_INSTALLED`);
  for (const path of expiryUnits(h)) {
    assert.equal(h.exists(path), true, `${name}_MECHANISM_INSTALLED`);
    assert.deepEqual(Object.entries(custodyTerms(h, path)).filter(([, ok]) => !ok).map(([term]) => term), [], `${name}_UNITS_IN_CUSTODY`);
  }
  assert.equal(h.enabled.has(expiryTimer(h)), true, `${name}_TIMER_ENABLED`);
  assert.equal(h.wants.has(expiryTimer(h)), true, `${name}_TIMER_LINK_INSTALLED`);
  const invocation = selfRunCompanion(h, name);
  h.expire();
  const start = h.events.length;
  const result = await create().execute('expire');
  // Nothing was stopped or signalled to make this work: the exclusion is a
  // measurement, and the companion is still exactly as live as it was.
  assert.equal(h.events.slice(start).some(e => e.includes(`:stop ${companion}`)), false, `${name}_NO_STOP_ISSUED`);
  assert.equal(h.events.slice(start).some(e => e.includes(`:kill`) && e.includes(companion)), false, `${name}_NO_KILL_ISSUED`);
  assert.equal(unitShow(h, companion, 'ActiveState'), 'activating', `${name}_STILL_THIS_INVOCATION_LIVE`);
  assert.equal(unitShow(h, companion, 'InvocationID'), invocation, `${name}_STILL_THIS_INVOCATION_ID`);
  assert.equal(result.ok, true, `${name}_COMPLETED: ${JSON.stringify(result)}`);
  assert.equal(result.state, 'REVOKED', `${name}_RETIRED`);
  assert.equal(result.code, null, `${name}_NO_REFUSAL_CODE`);
  assert.deepEqual(result.failures, [], `${name}_NO_FAILURES`);
  assert.ok(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), `${name}_RECEIPT_DURABLE`);
  assert.ok(h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED'), `${name}_REMOVAL_RECEIPT`);
  // The mechanism really is retired, measured through the same interface the
  // module reads: the timer is stopped, not enabled, its install symlink is
  // gone, systemd knows nothing about it, and both unit files are unlinked.
  assert.ok(h.events.slice(start).some(e => e.includes(`disable --now ${expiryTimer(h)}`)), `${name}_DISABLE_ISSUED`);
  assert.equal(unitShow(h, expiryTimer(h), 'ActiveState'), 'inactive', `${name}_TIMER_STOPPED`);
  assert.equal(h.enabled.has(expiryTimer(h)), false, `${name}_TIMER_NOT_ENABLED`);
  assert.equal(h.wants.has(expiryTimer(h)), false, `${name}_TIMER_LINK_REMOVED`);
  assert.equal(unitShow(h, expiryTimer(h), 'UnitFileState'), '', `${name}_TIMER_UNKNOWN`);
  assert.equal(unitShow(h, companion, 'UnitFileState'), '', `${name}_COMPANION_UNKNOWN`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_UNITS_REMOVED`);
  return invocation;
}
// Control 4. The exclusion hides nothing. The same episode is measured AGAIN
// from a non-companion vantage - the invocation has ended and this process has
// no INVOCATION_ID at all, so no term is excluded from anything - and the
// retired episode's own receipt path must still observe a fully retired
// mechanism. This is what proves the exclusion does not paper over a surviving
// mechanism: leave the timer enabled or either unit file in place and
// `observeRetiredExpiry()` refuses here, where nothing is excluded.
export async function expirySelfRunHidesNothingCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const name = 'B4_EXPIRY_SELF_RUN_HIDES_NOTHING';
  const companion = expiryCompanion(h);
  await expirySelfRunCompletesCheck(createProduction, h, name);
  // The invocation is over: the oneshot exited and this vantage is an operator
  // run outside systemd entirely.
  h.active.set(companion, 'inactive');
  h.selfInvocation.id = null;
  assert.equal(h.boundary.invocationId(), null, `${name}_NO_INVOCATION_TO_EXCLUDE`);
  assert.equal(unitShow(h, companion, 'ActiveState'), 'inactive', `${name}_COMPANION_EXITED`);
  const observed = await create().execute('revoke');
  assert.equal(observed.ok, true, `${name}_OBSERVED: ${JSON.stringify(observed)}`);
  assert.equal(observed.state, 'REVOKED', `${name}_STILL_RETIRED`);
  assert.equal(observed.physical_teardown_observed, true, `${name}_END_STATE_MEASURED`);
  // Measured independently of the module's own answer, through the interface it
  // reads, so the assertion names say what was true rather than what was returned.
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_UNITS_STILL_ABSENT`);
  for (const unit of [expiryTimer(h), companion]) {
    assert.equal(unitShow(h, unit, 'ActiveState'), 'inactive', `${name}_IDLE_${unit.split('.').pop()}`);
    assert.equal(unitShow(h, unit, 'UnitFileState'), '', `${name}_NOT_ENABLED_${unit.split('.').pop()}`);
    assert.equal(h.wants.has(unit), false, `${name}_NO_LEFTOVER_LINK_${unit.split('.').pop()}`);
  }
}
// Control for the POST-CONDITION half of the same exclusion, isolated. The
// companion is idle at the refusal before `disable --now` - so that refusal
// cannot be what this control observes - and becomes THIS INVOCATION only
// afterwards, which is where a self-invocation's own `activating` state would
// otherwise trip ACT_TEARDOWN_DRIFT. The timer's own end state is spotless, so
// only the companion's post-condition term can produce a refusal here.
export async function expirySelfRunPostConditionParityCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const name = 'B4_EXPIRY_SELF_RUN_POST_CONDITION_PARITY';
  const companion = expiryCompanion(h);
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  const run = h.boundary.run;
  const raw = (unit, property) => String(run('/usr/bin/systemctl', ['show', `--property=${property}`, '--value', unit], {}).stdout ?? '').trim();
  let planted = null;
  h.boundary.run = (exe, argv, options) => {
    const result = run(exe, argv, options);
    if (exe === '/usr/bin/systemctl' && argv[0] === 'disable' && argv.at(-1) === expiryTimer(h) && planted === null) {
      h.active.set(companion, 'activating');
      planted = raw(companion, 'InvocationID');
      h.selfInvocation.id = planted;
    }
    return result;
  };
  try {
    assert.equal(unitShow(h, companion, 'ActiveState'), 'inactive', `${name}_COMPANION_IDLE_BEFORE_DISABLE`);
    assert.equal(h.boundary.invocationId(), null, `${name}_NO_INVOCATION_BEFORE_DISABLE`);
    const result = await create().execute('revoke');
    // The state at the point of measurement: the companion is live and IS this
    // invocation, and the timer's own two terms are spotless.
    assert.match(planted ?? '', /^[0-9a-f]{32}$/, `${name}_INVOCATION_PLANTED_BY_DISABLE`);
    assert.equal(h.active.get(companion), 'activating', `${name}_COMPANION_ACTIVATING_AFTER_DISABLE`);
    assert.equal(h.selfInvocation.id, planted, `${name}_COMPANION_IS_THIS_INVOCATION`);
    assert.equal(h.active.get(expiryTimer(h)) ?? 'inactive', 'inactive', `${name}_TIMER_IDLE`);
    assert.equal(h.enabled.has(expiryTimer(h)), false, `${name}_TIMER_NOT_ENABLED`);
    assert.equal(result.ok, true, `${name}_COMPLETED: ${JSON.stringify(result)}`);
    assert.equal(result.state, 'REVOKED', `${name}_RETIRED`);
    assert.deepEqual(result.failures, [], `${name}_NO_FAILURES`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_UNITS_REMOVED`);
  } finally { h.boundary.run = run; }
}

// SHU-71 expiry-retirement drift, sixth correction round. P154D-07. The fifth
// round's DISCLOSURE named its own last gap: the propagation of INVOCATION_ID
// across the CLI's `env -i` re-exec is what makes the exclusion work at all -
// without it the inner process cannot know that it IS the expiry companion -
// and NO control pinned the propagation itself. Delete the invocation element
// and every control the fifth round wrote still passes, while on the host the
// identity is wiped, the exclusion never applies and the timer-triggered
// teardown refuses itself. That is also the ONE place this correction widens
// what crosses a boundary deliberately built to carry no operator environment.
//
// The command construction is now `lockedReexecCommand(invocation, argv)`, a
// pure function of the parent's invocation value. These controls pin the
// CONSTRUCTED command, term by term, each with its own killing mutant; the
// runtime half - what really crosses `/usr/bin/env -i` into the process that
// measures it - is driven end to end in shu71-reexec-boundary.test.mjs.
//
// Written out rather than imported from the module under test, so that a
// mutant which moves them is a mutant these controls see.
const REEXEC_INSTALLED = '/usr/local/lib/shu71/coordinator/service/shu71-production.mjs';
const REEXEC_LOCK = ['/usr/bin/flock', '--nonblock', '/run/lock/shu71-production.lock'];
const REEXEC_WIPE = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1'];
const REEXEC_ARGV = ['expire', 'shu71reexec00002'];
const REEXEC_ID = 'deadbeefcafef00d0123456789abcdef';
// The constructed command for a given invocation element list, byte for byte.
const reexecExpected = carried => [...REEXEC_LOCK, ...REEXEC_WIPE, ...carried, '/usr/bin/node', REEXEC_INSTALLED, ...REEXEC_ARGV];
// Every control below builds the command with this process's own
// INVOCATION_ID REMOVED, so a mutant that reads the value from the environment
// instead of from its single argument cannot accidentally agree with it.
const withoutParentInvocation = build => {
  const had = Object.hasOwn(process.env, 'INVOCATION_ID'), previous = process.env.INVOCATION_ID;
  delete process.env.INVOCATION_ID;
  try { return build(); } finally { if (had) process.env.INVOCATION_ID = previous; }
};
// Control 1. PRESENT: exactly one INVOCATION_ID element, byte-exact, placed
// immediately after SHU71_LOCKED=1 and immediately before /usr/bin/node.
export function reexecInvocationPresentCheck(production) {
  const name = 'B4_REEXEC_PRESENT';
  const command = withoutParentInvocation(() => production.lockedReexecCommand(REEXEC_ID, REEXEC_ARGV));
  assert.deepEqual([...command], reexecExpected([`INVOCATION_ID=${REEXEC_ID}`]), `${name}_BYTE_EXACT`);
  const carried = command.filter(element => element.startsWith('INVOCATION_ID'));
  assert.deepEqual(carried, [`INVOCATION_ID=${REEXEC_ID}`], `${name}_EXACTLY_ONE_ELEMENT`);
  assert.equal(command.indexOf(carried[0]), command.indexOf('SHU71_LOCKED=1') + 1, `${name}_IMMEDIATELY_AFTER_THE_LOCK_FLAG`);
  assert.equal(command.indexOf(carried[0]) + 1, command.indexOf('/usr/bin/node'), `${name}_IMMEDIATELY_BEFORE_NODE`);
}
// Control 2. ABSENT: no INVOCATION_ID in the parent process at all, and NO
// element - never an invented `INVOCATION_ID=`. The value is read from the
// parent environment here, exactly as the CLI reads it.
export function reexecInvocationAbsentCheck(production) {
  const name = 'B4_REEXEC_ABSENT';
  const command = withoutParentInvocation(() => {
    assert.equal(Object.hasOwn(process.env, 'INVOCATION_ID'), false, `${name}_PARENT_HAS_NONE`);
    assert.equal(process.env.INVOCATION_ID, undefined, `${name}_PARENT_READS_UNDEFINED`);
    return production.lockedReexecCommand(process.env.INVOCATION_ID, REEXEC_ARGV);
  });
  assert.deepEqual([...command], reexecExpected([]), `${name}_BYTE_EXACT`);
  assert.deepEqual(command.filter(element => element.startsWith('INVOCATION_ID')), [], `${name}_NO_ELEMENT_AT_ALL`);
  assert.equal(command.includes('INVOCATION_ID='), false, `${name}_NO_INVENTED_EMPTY_ASSIGNMENT`);
  assert.equal(command.indexOf('SHU71_LOCKED=1') + 1, command.indexOf('/usr/bin/node'), `${name}_NOTHING_BETWEEN_THE_LOCK_FLAG_AND_NODE`);
}
// Control 3. EMPTY behaves exactly as absent. `INVOCATION_ID=''` is what a
// systemd-less start or a deliberately cleared variable produces, and an empty
// value is not an identity: it must never become `INVOCATION_ID=`, which the
// inner process would then read as an empty string rather than as absence.
export function reexecInvocationEmptyCheck(production) {
  const name = 'B4_REEXEC_EMPTY';
  const command = withoutParentInvocation(() => {
    process.env.INVOCATION_ID = '';
    assert.equal(process.env.INVOCATION_ID, '', `${name}_PARENT_IS_EMPTY`);
    return production.lockedReexecCommand(process.env.INVOCATION_ID, REEXEC_ARGV);
  });
  assert.deepEqual([...command], reexecExpected([]), `${name}_BYTE_EXACT_AS_ABSENT`);
  assert.deepEqual(command.filter(element => element.startsWith('INVOCATION_ID')), [], `${name}_NO_ELEMENT_AT_ALL`);
  assert.equal(command.includes('INVOCATION_ID='), false, `${name}_NO_INVENTED_EMPTY_ASSIGNMENT`);
}
// Control 4, constructed half. The boundary still takes NO operator
// environment: the wipe is there, and exactly three assignments cross it.
export function reexecBoundaryCheck(production) {
  const name = 'B4_REEXEC_BOUNDARY';
  const poison = 'B4_REEXEC_OPERATOR_POISON';
  const command = withoutParentInvocation(() => {
    process.env[poison] = 'operator-value-that-must-not-cross';
    try { return production.lockedReexecCommand(REEXEC_ID, REEXEC_ARGV); } finally { delete process.env[poison]; }
  });
  assert.equal(command.indexOf('-i'), command.indexOf('/usr/bin/env') + 1, `${name}_ENVIRONMENT_IS_WIPED`);
  assert.deepEqual(command.slice(command.indexOf('-i') + 1, command.indexOf('/usr/bin/node')),
    ['PATH=/usr/bin:/bin', 'SHU71_LOCKED=1', `INVOCATION_ID=${REEXEC_ID}`], `${name}_EXACTLY_THREE_ASSIGNMENTS`);
  assert.deepEqual([...command], reexecExpected([`INVOCATION_ID=${REEXEC_ID}`]), `${name}_BYTE_EXACT`);
  // Nothing of this process's environment appears anywhere in the command, by
  // name or by value, and the invocation element's value is the argument.
  assert.equal(command.some(element => element.includes(poison)), false, `${name}_NO_OPERATOR_NAME_CROSSES`);
  assert.equal(command.some(element => element.includes('operator-value-that-must-not-cross')), false, `${name}_NO_OPERATOR_VALUE_CROSSES`);
  assert.deepEqual(command.filter(element => element.startsWith('INVOCATION_ID')), [`INVOCATION_ID=${REEXEC_ID}`], `${name}_ELEMENT_IS_THE_ARGUMENT`);
}
// Control 5, constructed half. ONE argv element, so no value can inject a
// second assignment. A value carrying spaces and `=` stays whole.
export function reexecSingleElementCheck(production) {
  const name = 'B4_REEXEC_SINGLE_ELEMENT';
  const hostile = `${REEXEC_ID} PATH=/evil SHU71_LOCKED=0`;
  const command = withoutParentInvocation(() => production.lockedReexecCommand(hostile, REEXEC_ARGV));
  assert.deepEqual([...command], reexecExpected([`INVOCATION_ID=${hostile}`]), `${name}_BYTE_EXACT`);
  assert.deepEqual(command.slice(command.indexOf('-i') + 1, command.indexOf('/usr/bin/node')),
    ['PATH=/usr/bin:/bin', 'SHU71_LOCKED=1', `INVOCATION_ID=${hostile}`], `${name}_THREE_ASSIGNMENTS_NOT_FIVE`);
  assert.equal(command.filter(element => element.startsWith('PATH=')).length, 1, `${name}_ONE_PATH_ASSIGNMENT`);
  assert.equal(command.includes('PATH=/evil'), false, `${name}_NO_INJECTED_PATH`);
  assert.equal(command.includes('SHU71_LOCKED=0'), false, `${name}_NO_INJECTED_LOCK_FLAG`);
  assert.equal(command.filter(element => element.startsWith('SHU71_LOCKED=')).length, 1, `${name}_ONE_LOCK_FLAG`);
}
// Control 6. The alignment is EXACT STRING EQUALITY OF TWO NON-EMPTY VALUES and
// nothing looser. A near miss of the companion's own reported InvocationID -
// one leading or trailing space, a different case, a prefix, a suffix, or the
// empty string - is NOT this invocation, excludes nothing, and the live
// companion refuses by its own name. The same episode then completes on the
// exact value, so the refusals above were the identity term and not the state.
export async function expiryInvocationExactEqualityCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  const name = 'B4_EXPIRY_INVOCATION_EXACT_EQUALITY';
  const companion = expiryCompanion(h);
  assert.equal((await create().execute('run')).state, 'ARMED', `${name}_SETUP`);
  h.active.set(companion, 'activating');
  h.unitInvocations.set(companion, REEXEC_ID);
  assert.equal(unitShow(h, companion, 'InvocationID'), REEXEC_ID, `${name}_COMPANION_REPORTS_THE_REAL_ID`);
  assert.equal(unitShow(h, companion, 'ActiveState'), 'activating', `${name}_COMPANION_MEASURABLY_ACTIVATING`);
  const misses = [
    ['leading-space', ` ${REEXEC_ID}`], ['trailing-space', `${REEXEC_ID} `], ['upper-case', REEXEC_ID.toUpperCase()],
    ['prefix', REEXEC_ID.slice(0, -1)], ['suffix', REEXEC_ID.slice(1)], ['empty', ''],
  ];
  for (const [label, miss] of misses) {
    assert.notEqual(miss, REEXEC_ID, `${name}_${label}_REALLY_DIFFERS`);
    h.selfInvocation.id = miss;
    assert.equal(h.boundary.invocationId(), miss, `${name}_${label}_IS_THIS_PROCESS_CLAIM`);
    const start = h.events.length;
    const result = await create().execute('revoke');
    assert.equal(result.ok, false, `${name}_${label}_REFUSED: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ACT_CLEANUP_FAILED', `${name}_${label}_NAMED`);
    assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_SERVICE'), `${name}_${label}_COMPANION_REFUSAL_NAMED`);
    assert.equal(h.events.slice(start).some(e => e.includes('disable --now shu71-expiry-')), false, `${name}_${label}_BEFORE_DISABLE`);
    assert.equal(h.events.slice(start).some(e => e.startsWith('unlink:/etc/systemd/system/shu71-expiry-')), false, `${name}_${label}_UNITS_NOT_UNLINKED`);
    for (const path of expiryUnits(h)) assert.equal(h.exists(path), true, `${name}_${label}_MECHANISM_SURVIVES`);
    unfinished(h, name);
  }
  // The exact value, same live companion, same journal state: it completes.
  h.selfInvocation.id = REEXEC_ID;
  const settled = await create().execute('revoke');
  assert.equal(settled.ok, true, `${name}_EXACT_MATCH_COMPLETED: ${JSON.stringify(settled)}`);
  assert.equal(settled.state, 'REVOKED', `${name}_EXACT_MATCH_RETIRED`);
  assert.deepEqual(settled.failures, [], `${name}_EXACT_MATCH_NO_FAILURES`);
  for (const path of expiryUnits(h)) assert.equal(h.exists(path), false, `${name}_EXACT_MATCH_UNITS_REMOVED`);
  assert.equal(unitShow(h, companion, 'ActiveState'), 'activating', `${name}_COMPANION_NEVER_STOPPED`);
  assert.equal(unitShow(h, companion, 'InvocationID'), REEXEC_ID, `${name}_COMPANION_STILL_THIS_INVOCATION`);
}
