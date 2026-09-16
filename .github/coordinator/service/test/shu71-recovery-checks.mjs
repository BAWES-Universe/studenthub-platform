import assert from 'node:assert/strict';
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
