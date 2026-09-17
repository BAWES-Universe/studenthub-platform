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
  if (interrupt) h.faults.before = e => e.includes(':disable --now shu71-expiry-');
  const start = h.events.length, result = await create().execute('expire');
  if (interrupt) {
    assert.equal(result.code, 'ACT_CLEANUP_FAILED');
    const rows = h.journal().length;
    for (let n = 0; n < 40; n++) assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
    assert.equal(h.journal().length, rows, 'B4_SETTLEMENT_BOUNDED');
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
