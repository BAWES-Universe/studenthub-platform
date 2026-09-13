import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { startSupervisor, supervisorState, probeProcess } from '../supervisor-service.mjs';
import { serviceParameters, render, assertPolicy, names, verifySyntax } from '../units.mjs';
import { SupervisorStore, signedSupervisorRequest, submitToSupervisor } from '../../supervisor.mjs';
const secret = 'local-test-secret-at-least-32-bytes-long';
const order = { version: '1.0.0', role: 'build', runtime: 'hermes-pool', issue_id: 'SHU-251',
  authorization_ref: 'SHU-251', attempt_id: '11111111-2222-4333-8444-555555555555', target_sha: 'a'.repeat(40),
  repo: 'example/fixture', branch: 'feat/fixture', task_context: 'local fixture' };
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu251-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { stateDir: join(root, 'state'), socketPath: join(root, 'daemon.sock'), secret, env: { ENABLE_DISPATCH: 'true' } };
}
function child() {
  return Object.assign(new EventEmitter(), { pid: process.pid, processStartToken: 'fixture', kill() { this.killed = true; } });
}
async function recovered(t, start = startSupervisor) {
  const params = fixture(t), store = new SupervisorStore(params.stateDir);
  store.accept(order, new Date().toISOString());
  store.claimLaunch(order.attempt_id, { phase: 'spawn_attempted' });
  const service = await start({ ...params, spawnWorker: () => { throw new Error('must not duplicate'); }, ready: async () => {
    assert.equal(store.readRun(order.attempt_id).status, 'hold', 'SHU251_RECOVERY: ambiguous launch must be held before readiness');
    const response = await submitToSupervisor({ socketPath: params.socketPath, request: signedSupervisorRequest(order, secret, 'status') });
    assert.equal(response.stage, 'HOLD', 'SHU251_READINESS: authenticated status must work before notification');
  } });
  await service.stop();
  assert.equal(fs.existsSync(params.socketPath), false, 'SHU251_SHUTDOWN: socket must close on stop');
}
test('SHU251 recovery precedes readiness and authenticated status is available', async t => recovered(t));
test('SHU251 mutation: recovery omitted before readiness', async t => {
  const params = fixture(t), file = join(params.stateDir, '..', 'mutant.mjs');
  const source = fs.readFileSync(new URL('../supervisor-service.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('  supervisor.recover();'));
  fs.writeFileSync(file, source.replace('  supervisor.recover();', '  /* omitted recovery */')
    .replace("'../supervisor.mjs'", JSON.stringify(new URL('../../supervisor.mjs', import.meta.url).href))
    .replace("'../supervisor-worker.mjs'", JSON.stringify(new URL('../../supervisor-worker.mjs', import.meta.url).href)));
  const mutant = await import(pathToFileURL(file));
  await assert.rejects(() => recovered(t, mutant.startSupervisor), error => error.name === 'AssertionError' && error.message.includes('SHU251_RECOVERY: ambiguous launch must be held before readiness'));
});
test('SHU251 routine shutdown preserves workers and refuses further admission', async t => {
  const params = fixture(t), worker = child();
  const service = await startSupervisor({ ...params, spawnWorker: () => worker, ready: () => {} });
  const request = signedSupervisorRequest(order, secret);
  assert.equal((await submitToSupervisor({ socketPath: params.socketPath, request })).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  await service.stop();
  assert.equal(worker.killed, undefined, 'SHU251_CHILDREN: routine shutdown must preserve workers');
  assert.equal((await service.supervisor.submit(request)).ok, false, 'SHU251_SHUTDOWN: stopped service must refuse admission');
  const restarted = await startSupervisor({ ...params, spawnWorker: () => { throw new Error('duplicate'); }, ready: () => {} });
  assert.equal(restarted.supervisor.store.readRun(order.attempt_id).status, 'hold');
  await restarted.stop();
});
test('SHU251 terminating shutdown records HOLD and terminates owned child', async t => {
  const params = fixture(t), worker = child();
  const service = await startSupervisor({ ...params, spawnWorker: () => worker, ready: () => {} });
  await service.supervisor.submit(signedSupervisorRequest(order, secret));
  await new Promise(resolve => setImmediate(resolve));
  await service.stop({ terminateChildren: true });
  assert.equal(worker.killed, true);
  assert.equal(service.supervisor.store.readRun(order.attempt_id).error_code, 'SUPERVISOR_SHUTDOWN');
});
test('SHU251 disabled startup neither resumes queued work nor admits submissions', async t => {
  const params = fixture(t), store = new SupervisorStore(params.stateDir);
  store.accept(order, new Date().toISOString());
  let launches = 0;
  const service = await startSupervisor({ ...params, env: { ENABLE_DISPATCH: 'false' }, spawnWorker: () => { launches++; return child(); }, ready: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0, 'SHU251_ZERO_LAUNCH: disabled service must not resume queued work');
  assert.equal((await service.supervisor.submit(signedSupervisorRequest(order, secret))).ok, false);
  await service.stop();
});
test('SHU251 readiness failure closes admission and socket', async t => {
  const params = fixture(t);
  await assert.rejects(() => startSupervisor({ ...params, ready: () => assert.fail('SHU251_READINESS: injected notifier failure') }), { name: 'AssertionError' });
  assert.equal(fs.existsSync(params.socketPath), false);
});
test('SHU251 authoritative inventory includes all durable trees and orphan files without writes', t => {
  const params = fixture(t);
  new SupervisorStore(params.stateDir);
  for (const dir of ['branches', 'orders', 'runs', 'launches', 'completions']) fs.writeFileSync(join(params.stateDir, dir, 'orphan.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(join(params.stateDir, 'unknown.tmp'), 'retained');
  const before = supervisorState(params.stateDir);
  assert.deepEqual(supervisorState(params.stateDir), before);
  assert.deepEqual(Object.keys(before.entries), ['branches', 'completions', 'launches', 'orders', 'runs', 'unknown.tmp']);
  fs.writeFileSync(join(params.stateDir, 'branches', 'orphan.json'), '{"changed":true}');
  assert.throws(() => assert.deepEqual(supervisorState(params.stateDir), before, 'SHU251_STATE_DIFF: supervisor durable state must be unchanged'), error => error.name === 'AssertionError' && error.message.includes('SHU251_STATE_DIFF: supervisor durable state must be unchanged'));
});
test('SHU251 mutation: durable inventory directory missing or symlinked', t => {
  const params = fixture(t);
  new SupervisorStore(params.stateDir);
  fs.rmdirSync(join(params.stateDir, 'launches'));
  assert.throws(() => supervisorState(params.stateDir), { name: 'AssertionError', message: 'SHU251_SUPERVISOR_STATE: missing durable launches directory' });
  fs.symlinkSync(join(params.stateDir, 'orders'), join(params.stateDir, 'launches'));
  assert.throws(() => supervisorState(params.stateDir), { name: 'AssertionError', message: 'SHU251_SUPERVISOR_STATE: only real directories and regular durable files allowed' });
});
test('SHU251 concrete merged service argv renders valid units', t => {
  const params = fixture(t), workdir = process.cwd();
  const units = render(serviceParameters({ workdir, workspaceStateDir: dirname(params.stateDir), supervisorStateDir: params.stateDir, supervisorSocket: params.socketPath }));
  assertPolicy(units);
  for (const name of names) fs.writeFileSync(join(params.stateDir, '..', name), units[name]);
  verifySyntax(join(params.stateDir, '..'));
});
test('SHU251 process identity probe distinguishes current and stale process tokens', () => {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const token = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  assert.equal(probeProcess({ pid: process.pid, process_token: token }), true);
  assert.equal(probeProcess({ pid: process.pid, process_token: 'stale' }), false);
});
test('SHU251 shutdown cancels queued launches before spawn', async t => {
  const params = fixture(t);
  let launches = 0;
  const service = await startSupervisor({ ...params, spawnWorker: () => { launches++; return child(); }, ready: () => {} });
  await service.supervisor.submit(signedSupervisorRequest(order, secret));
  await service.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0, 'SHU251_SHUTDOWN: queued launch must not spawn after shutdown');
  assert.equal(service.supervisor.store.readRun(order.attempt_id).status, 'accepted');
});
test('SHU251 occupied socket refuses startup before recovery', async t => {
  const params = fixture(t);
  const service = await startSupervisor({ ...params, ready: () => {} });
  try {
    await assert.rejects(() => startSupervisor({ ...params, ready: () => {} }), {
      name: 'AssertionError', message: 'SHU251_SUPERVISOR_SOCKET: occupied or stale socket requires operator inspection',
    });
  } finally { await service.stop(); }
});
