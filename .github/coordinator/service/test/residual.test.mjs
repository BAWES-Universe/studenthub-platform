import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyGatePositiveControl, assertStatusShape, POSITIVE, SHAPE, RECEIPT } from '../residual-validation.mjs';
import { DurableSupervisor, SupervisorStore, signedSupervisorRequest, submitToSupervisor } from '../../supervisor.mjs';
import { hasLaunchReceipt } from '../../intended-work.mjs';
import { checkStatus } from '../check-status.mjs';
import { probeProcess } from '../supervisor-service.mjs';
import { createEpisodeHarness } from '../../test/fixture/episode-harness.mjs';
const secret = 'local-residual-secret-at-least-32-bytes';
const order = { version: '1.0.0', role: 'build', runtime: 'hermes-pool', issue_id: 'SHU-140',
  authorization_ref: 'FIXTURE-OPUS-CONTRACT-20260905', attempt_id: '11111111-2222-4333-8444-555555555555',
  target_sha: 'a'.repeat(40), repo: 'example/fixture', branch: 'feat/fixture', task_context: 'sandbox' };
const named = (message) => error => error.name === 'AssertionError' && error.message.includes(message);
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu251-residual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateDir: join(root, 'state'), socketPath: join(root, 'service.sock'), secret,
    release: join(root, 'release'), journal: join(root, 'worker.log') };
}
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(20); }
  assert.fail(message);
}

test('SHU251_GATE_OFF_POSITIVE_CONTROL same pending tick differs only by gate', { timeout: 10000 }, async t => {
  const evidence = await verifyGatePositiveControl();
  assert.equal(evidence.configGate, false);
  t.diagnostic(JSON.stringify(evidence));
});
test('SHU251 mutation: suppress positive-control launch', { timeout: 10000 }, async () => {
  await assert.rejects(() => verifyGatePositiveControl({ suppressLaunch: true }), named(POSITIVE));
});

async function liveRestart(t, { duplicate = false, loseReceipt = false } = {}) {
  const params = fixture(t), daemons = [], h = createEpisodeHarness();
  let run;
  t.after(async () => {
    for (const daemon of daemons) if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    if (run && probeProcess(run)) { try { process.kill(run.pid, 'SIGKILL'); } catch {} }
    await Promise.all(daemons.map(d => d.exitCode !== null || d.signalCode !== null ? null : once(d, 'exit')));
    h.cleanup();
  });
  const start = async () => {
    const daemon = fork(new URL('./fixture/residual-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} });
    daemons.push(daemon);
    const ready = once(daemon, 'message');
    daemon.send({ kind: 'daemon', ...params });
    assert.equal((await ready)[0].ready, true, 'SHU251_RESTART_SOCKET: restarted service must return authenticated status');
    return daemon;
  };
  const stop = async daemon => {
    const exited = once(daemon, 'exit'); daemon.send({ kind: 'stop' });
    assert.deepEqual(await exited, [0, null], 'SHU251_RESTART_SOCKET: supervisor must stop cleanly');
  };
  let bound;
  h.adapters['codex-cli'].launchBuilder = async o => {
    bound = { ...order, attempt_id: o.attempt_id, target_sha: o.target_sha };
    const response = await submitToSupervisor({ socketPath: params.socketPath, request: signedSupervisorRequest(bound, secret) });
    assert.equal(response.ok, true);
    await until(async () => {
      const status = await checkStatus({ ...params, order: bound });
      return status.stage === 'RUNNING' && hasLaunchReceipt(status.launch_receipt, bound);
    }, RECEIPT);
    return { stage: 'RUNNING', external_run_id: `sandbox_${o.attempt_id}`, worker_identity: 'sandbox:worker' };
  };
  const first = await start();
  assert.equal((await h.runTick()).code, 0);
  const store = new SupervisorStore(params.stateDir);
  await until(() => fs.existsSync(params.journal), 'SHU251_RESTART_LIVE: worker must be live before restart');
  run = store.readRun(bound.attempt_id);
  assert.equal(probeProcess(run), true, 'SHU251_RESTART_LIVE: worker must be live before restart');
  // A release-controlled child remains running for a measured interval, not
  // merely a quick process whose exit races restart.
  await delay(1000);
  assert.equal(probeProcess(run), true, 'SHU251_RESTART_LIVE: worker must be live before restart');
  const receipt = fs.readFileSync(store.paths(bound.attempt_id).launch);
  await stop(first); // Actual daemon PID exits; detached worker remains alive.
  assert.equal(probeProcess(run), true, 'SHU251_RESTART_LIVE: worker must survive supervisor exit');
  const second = await start();
  assert.notEqual(second.pid, first.pid);
  const status = () => submitToSupervisor({ socketPath: params.socketPath, request: signedSupervisorRequest(bound, secret, 'status') });
  const adopted = await status();
  assertStatusShape(adopted, { store, attemptId: bound.attempt_id });
  assert.deepEqual(await checkStatus({ ...params, order: bound }), adopted);
  assert.equal(adopted.stage, 'RUNNING', 'SHU251_RESTART_SOCKET: restarted service must return authenticated status');
  assert.equal(store.readRun(bound.attempt_id).pid, run.pid, 'SHU251_RESTART_ADOPTED: recovered attempt must retain the same live process identity');
  // Replay admission while the original child is live.
  await submitToSupervisor({ socketPath: params.socketPath, request: signedSupervisorRequest(bound, secret) });
  if (duplicate) fs.appendFileSync(params.journal, 'started duplicate\n');
  assert.equal(fs.readFileSync(params.journal, 'utf8').split('\n').filter(x => x.startsWith('started ')).length, 1,
    'SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker');
  fs.writeFileSync(params.release, 'finish');
  await until(() => fs.readFileSync(params.journal, 'utf8').includes('completed'), 'SHU251_RESTART_TERMINAL: adopted worker must complete exactly once');
  await until(() => !probeProcess(run), 'SHU251_RESTART_NO_ORPHAN: worker must exit after durable completion');
  if (loseReceipt) fs.unlinkSync(store.paths(bound.attempt_id).completion);
  assert.ok(store.hasCompletion(bound.attempt_id), 'SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt');
  assert.equal(store.validatedCompletion(bound.attempt_id).ok, true, 'SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt');
  assert.equal((await status()).stage, 'COMPLETED');
  await stop(second);
  const third = await start(); // Fold terminal receipt into run on recovery.
  assert.equal(store.readRun(bound.attempt_id).status, 'completed', 'SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt');
  assert.equal(fs.readFileSync(params.journal, 'utf8'), `started ${run.pid}\ncompleted ${run.pid}\n`, 'SHU251_RESTART_TERMINAL: adopted worker must complete exactly once');
  assert.deepEqual(fs.readFileSync(store.paths(bound.attempt_id).launch), receipt, 'SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker');
  assertStatusShape(await status(), { store, attemptId: bound.attempt_id });
  await stop(third);
  t.diagnostic(JSON.stringify({ supervisorPids: [first.pid, second.pid, third.pid], workerPid: run.pid,
    spawnCount: 1, completionCount: 1, orphan: false,
    states: ['RUNNING', 'RUNNING', 'COMPLETED'], terminalReceiptValidated: true, launchReceiptUnchanged: true }));
}
test('SHU251 live worker restart adopts once and recovers durable completion', { timeout: 20000 }, t => liveRestart(t));
test('SHU251 mutation: duplicate spawn evidence after restart', { timeout: 20000 }, t => assert.rejects(() => liveRestart(t, { duplicate: true }), named('SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker')));
test('SHU251 mutation: terminal receipt lost after restart', { timeout: 20000 }, t => assert.rejects(() => liveRestart(t, { loseReceipt: true }), named('SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt')));

test('SHU251_STATUS_SHAPE pins all states and launch receipt binding', t => {
  const params = fixture(t), supervisor = new DurableSupervisor({ ...params, spawnWorker: () => {}, schedule: () => {} });
  const store = supervisor.store;
  store.accept(order, new Date().toISOString());
  const request = signedSupervisorRequest(order, secret, 'status');
  for (const state of ['accepted', 'hold', 'running', 'completed', 'failed']) {
    store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: state });
    if (['running', 'completed', 'failed'].includes(state)) store.markLaunch(order.attempt_id, { issue_id: order.issue_id, attempt_id: order.attempt_id, target_sha: order.target_sha,
      pid: 7001, phase: 'launched', completion_token_hash: 'a'.repeat(64) });
    const status = supervisor.status(request);
    assert.equal(status.stage, state.toUpperCase());
    assertStatusShape(status, { store, attemptId: order.attempt_id });
  }
  fs.unlinkSync(store.paths(order.attempt_id).launch);
  for (const state of ['running', 'completed', 'failed']) {
    store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: state });
    const refused = supervisor.status(request);
    assertStatusShape(refused);
    assert.equal(refused.ok, false, RECEIPT);
    assert.equal(refused.reason, 'launch receipt missing or invalid', RECEIPT);
  }
});
test('SHU251 mutation: required status field removed or renamed', t => {
  const params = fixture(t), supervisor = new DurableSupervisor({ ...params, spawnWorker: () => {}, schedule: () => {} });
  supervisor.store.accept(order, new Date().toISOString());
  const status = supervisor.status(signedSupervisorRequest(order, secret, 'status'));
  for (const [key, value] of Object.entries({ version: 2, ok: 'true', durable: 1, attempt_id: 7, target_sha: null, stage: 'LAUNCHED', result: [], heartbeat: 'invalid' })) {
    assert.throws(() => assertStatusShape({ ...status, [key]: value }), named(SHAPE));
  }
  for (const key of Object.keys(status)) {
    const removed = { ...status }; delete removed[key];
    assert.throws(() => assertStatusShape(removed), named(SHAPE));
    assert.throws(() => assertStatusShape({ ...removed, [`renamed_${key}`]: status[key] }), named(SHAPE));
  }
});
test('SHU251 mutation: status claims launch without receipt', t => {
  const params = fixture(t), supervisor = new DurableSupervisor({ ...params, spawnWorker: () => {}, schedule: () => {} });
  supervisor.store.accept(order, new Date().toISOString());
  const status = supervisor.status(signedSupervisorRequest(order, secret, 'status'));
  assert.throws(() => assertStatusShape({ ...status, stage: 'RUNNING' }, { store: supervisor.store, attemptId: order.attempt_id }), named(RECEIPT));
});

const confirmedReceipt = () => ({ issue_id: order.issue_id, attempt_id: order.attempt_id,
  target_sha: order.target_sha, pid: 7001, phase: 'launched', completion_token_hash: 'a'.repeat(64) });

test('SHU251_STATUS_RECEIPT rejects marker-only and every invalid confirmed-spawn binding', t => {
  const supervisor = new DurableSupervisor({ ...fixture(t), spawnWorker: () => {}, schedule: () => {} });
  const store = supervisor.store, request = signedSupervisorRequest(order, secret, 'status');
  store.accept(order, new Date().toISOString());
  const invalid = [
    { attempt_id: order.attempt_id, phase: 'spawn_attempted', completion_token_hash: 'a'.repeat(64) },
    ...Object.keys(confirmedReceipt()).map(key => { const r = confirmedReceipt(); delete r[key]; return r; }),
    ...[{ issue_id: 'SHU-999' }, { attempt_id: '22222222-2222-4333-8444-555555555555' },
      { target_sha: 'b'.repeat(40) }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: '7001' },
      { phase: 'reserved' }, { phase: 'spawn_attempted' }, { completion_token_hash: 'a'.repeat(63) },
      { completion_token_hash: 'g'.repeat(64) }].map(change => ({ ...confirmedReceipt(), ...change })),
  ];
  for (const state of ['running', 'completed', 'failed']) {
    store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: state });
    for (const receipt of invalid) {
      store.markLaunch(order.attempt_id, receipt);
      const refused = supervisor.status(request);
      assert.deepEqual(refused, { ok: false, stage: 'UNLAUNCHED', reason: 'launch receipt missing or invalid' }, RECEIPT);
      assertStatusShape(refused);
      assert.equal(store.announce(order).status, 'UNLAUNCHED', RECEIPT);
      assert.throws(() => assertStatusShape({ version: '2.0.0', ok: true, durable: true,
        attempt_id: order.attempt_id, target_sha: order.target_sha, stage: state.toUpperCase(),
        result: null, heartbeat: null, launch_receipt: receipt }, { store, attemptId: order.attempt_id }), named(RECEIPT));
    }
  }
});

test('SHU251_STATUS_SHAPE exact variants reject removed renamed and extra fields', t => {
  const supervisor = new DurableSupervisor({ ...fixture(t), spawnWorker: () => {}, schedule: () => {} });
  const store = supervisor.store, request = signedSupervisorRequest(order, secret, 'status');
  store.accept(order, new Date().toISOString());
  const variants = [];
  for (const state of ['accepted', 'hold', 'running', 'completed', 'failed']) {
    store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: state });
    if (['running', 'completed', 'failed'].includes(state)) store.markLaunch(order.attempt_id, confirmedReceipt());
    variants.push(supervisor.status(request));
  }
  store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: 'hold' });
  variants.push(supervisor.status(request)); // Confirmed spawn with operational HOLD retains its receipt.
  store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: 'failed' });
  fs.unlinkSync(store.paths(order.attempt_id).launch);
  variants.push(supervisor.status(request));
  store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: 'unknown' });
  variants.push(supervisor.status(request));
  fs.unlinkSync(store.paths(order.attempt_id).run);
  variants.push(supervisor.status(request));
  // Restore the receipt so execution schema mutations test shape independently.
  store.markLaunch(order.attempt_id, confirmedReceipt());
  const context = { store, attemptId: order.attempt_id };
  for (const status of variants) {
    assertStatusShape(status, context);
    assert.throws(() => assertStatusShape({ ...status, extra: true }, context), named(SHAPE));
    for (const key of Object.keys(status)) {
      const removed = { ...status }; delete removed[key];
      // Receipt identity remains a named RECEIPT failure, never a silent pass.
      const failure = status.ok && Object.hasOwn(status, 'launch_receipt')
        && ['attempt_id', 'target_sha', 'launch_receipt'].includes(key) && !(status.stage === 'HOLD' && key === 'launch_receipt') ? RECEIPT : SHAPE;
      assert.throws(() => assertStatusShape(removed, context), named(failure));
      assert.throws(() => assertStatusShape({ ...removed, [`renamed_${key}`]: status[key] }, context), named(failure));
    }
  }
});

test('SHU251 status precedence validates unknown states and completion before receipt or intent', t => {
  const supervisor = new DurableSupervisor({ ...fixture(t), spawnWorker: () => {}, schedule: () => {} });
  const store = supervisor.store, request = signedSupervisorRequest(order, secret, 'status');
  store.accept(order, new Date().toISOString());
  assert.equal(supervisor.status(request).stage, 'ACCEPTED');
  assert.equal(store.announce(order).status, 'UNLAUNCHED');
  fs.unlinkSync(store.intentPath(order));
  for (const receipt of [null, confirmedReceipt()]) {
    if (receipt) store.markLaunch(order.attempt_id, receipt);
    store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: 'unknown' });
    fs.writeFileSync(store.paths(order.attempt_id).completion, '{}');
    assert.deepEqual(supervisor.status(request), { ok: false, stage: 'HOLD', reason: 'unknown durable run state' });
    store.writeRun(order.attempt_id, { ...store.readRun(order.attempt_id), status: 'running' });
    const reason = store.validatedCompletion(order.attempt_id).reason;
    assert.deepEqual(supervisor.status(request), { ok: false, stage: 'HOLD', reason });
    fs.unlinkSync(store.paths(order.attempt_id).completion);
    assert.deepEqual(supervisor.status(request), { ok: false, stage: 'UNLAUNCHED', reason: 'launch receipt missing or invalid' });
    assert.equal(fs.existsSync(store.intentPath(order)), false, 'status must not repair intent');
  }
  const other = { ...order, target_sha: 'b'.repeat(40) };
  assert.equal(supervisor.status(signedSupervisorRequest(other, secret, 'status')).reason, 'status binding mismatch');
});
