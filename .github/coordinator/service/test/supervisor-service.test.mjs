import { fixtureEnvironmentFiles } from '../verify.mjs';
import { test as nodeTest } from 'node:test';
// Bound every service test, including regressions that leave asynchronous work pending.
const test = (name, options, fn) => typeof options === 'function'
  ? nodeTest(name, { timeout: 10000 }, options)
  : nodeTest(name, { timeout: 10000, ...options }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
    assert.equal(response.ok, true, 'SHU251_READINESS: authenticated status must succeed before notification');
    assert.equal(typeof response.version, 'string', 'SHU251_READINESS: authenticated status must include a server version before notification');
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
test('SHU251 mutation: notification before listen', async t => {
  const params = fixture(t), file = join(params.stateDir, '..', 'notify-mutant.mjs');
  const source = fs.readFileSync(new URL('../supervisor-service.mjs', import.meta.url), 'utf8');
  const listen = '  const server = await listenSupervisor({ supervisor, socketPath });';
  const notify = '  try { await ready(); } catch (error) { await stop(); throw error; }';
  assert.ok(source.includes(listen) && source.includes(notify));
  fs.writeFileSync(file, source.replace(notify, '').replace(listen, `  await ready();\n${listen}`)
    .replace("'../supervisor.mjs'", JSON.stringify(new URL('../../supervisor.mjs', import.meta.url).href))
    .replace("'../supervisor-worker.mjs'", JSON.stringify(new URL('../../supervisor-worker.mjs', import.meta.url).href)));
  const mutant = await import(pathToFileURL(file));
  await assert.rejects(() => recovered(t, mutant.startSupervisor), error => error.name === 'AssertionError'
    && error.message.includes('SHU251_READINESS: authenticated status must succeed before notification'));
});
test('SHU251 routine shutdown preserves workers and refuses further admission', async t => {
  const params = fixture(t), worker = child();
  const service = await startSupervisor({ ...params, spawnWorker: () => worker, ready: () => {} });
  t.after(() => service.stop());
  const request = signedSupervisorRequest(order, secret);
  assert.equal((await submitToSupervisor({ socketPath: params.socketPath, request })).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  await service.stop();
  assert.equal(worker.killed, undefined, 'SHU251_CHILDREN: routine shutdown must preserve workers');
  assert.equal((await service.supervisor.submit(request)).ok, false, 'SHU251_SHUTDOWN: stopped service must refuse admission');
  const restarted = await startSupervisor({ ...params, spawnWorker: () => { throw new Error('duplicate'); }, ready: () => {} });
  t.after(() => restarted.stop());
  assert.equal(restarted.supervisor.store.readRun(order.attempt_id).status, 'hold');
  await restarted.stop();
});
test('SHU251 terminating shutdown records HOLD and terminates owned child', async t => {
  const params = fixture(t), worker = child();
  const service = await startSupervisor({ ...params, spawnWorker: () => worker, ready: () => {} });
  t.after(() => service.stop());
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
  t.after(() => service.stop());
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
test('SHU251 concrete merged service argv renders valid units', { skip: process.env.SHU251_NO_SYSTEMD === '1' ? 'SHU251_NO_SYSTEMD: systemd interaction prohibited in this window' : false }, t => {
  const params = fixture(t), workdir = process.cwd();
  const options = serviceParameters({ ...fixtureEnvironmentFiles(join(params.stateDir, '..')), workdir, supervisorStateDir: params.stateDir, supervisorSocket: params.socketPath });
  const units = render(options);
  assertPolicy(units, options);
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
  t.after(() => service.stop());
  await service.supervisor.submit(signedSupervisorRequest(order, secret));
  await service.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0, 'SHU251_SHUTDOWN: queued launch must not spawn after shutdown');
  assert.equal(service.supervisor.store.readRun(order.attempt_id).status, 'accepted');
});
test('SHU251 occupied socket refuses startup before recovery', async t => {
  const params = fixture(t);
  const service = await startSupervisor({ ...params, ready: () => {} });
  t.after(() => service.stop());
  try {
    await assert.rejects(() => startSupervisor({ ...params, ready: () => {} }), {
      name: 'AssertionError', message: 'SHU251_SUPERVISOR_SOCKET: occupied or stale socket requires operator inspection',
    });
  } finally { await service.stop(); }
});

test('SHU251 mutation: missing or short secret refuses startup before state and readiness', async t => {
  for (const invalid of [undefined, '', 'short', Buffer.alloc(31)]) {
    const params = fixture(t);
    let ready = false, spawned = false;
    await assert.rejects(() => startSupervisor({ ...params, secret: invalid,
      ready: () => { ready = true; }, spawnWorker: () => { spawned = true; return child(); } }), {
      name: 'AssertionError', message: 'SHU251_SUPERVISOR_SECRET: SHU_SUPERVISOR_SECRET must contain at least 32 bytes',
    });
    assert.equal(ready, false);
    assert.equal(spawned, false);
    assert.equal(fs.existsSync(params.stateDir), false);
    assert.equal(fs.existsSync(params.socketPath), false);
  }
});
test('SHU251 service entry point fails closed when secret environment is missing', t => {
  const params = fixture(t);
  const result = spawnSync(process.execPath, [new URL('../supervisor-service.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, SHU_SUPERVISOR_STATE_DIR: params.stateDir, SHU_SUPERVISOR_SOCKET: params.socketPath },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError \[ERR_ASSERTION\]: SHU251_SUPERVISOR_SECRET: SHU_SUPERVISOR_SECRET must contain at least 32 bytes/);
  assert.equal(fs.existsSync(params.stateDir), false);
  assert.equal(fs.existsSync(params.socketPath), false);
});

// The tick's failure path must name its cause: a bare token leaves a stalled run
// unexplainable from its own journal (v1 demonstration, attempt 1).
test('SHU251 tick failure names its cause on stderr', () => {
  // The activation path is pinned to ACTIVATION_FILE, so any other value throws
  // inside the tick's own try block.
  const tick = fileURLToPath(new URL('../coordinator-tick.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [tick, '--activation', '/dev/null/not-the-activation.json'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  const at = run.stderr.indexOf('ACT_COORDINATOR_TICK_FAILED');
  assert.notEqual(at, -1, 'the token must still be printed');
  assert.match(run.stderr.slice(at), /ACT_ACTIVATION_PATH/, 'the cause must follow the token');
});
