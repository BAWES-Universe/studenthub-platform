import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DurableSupervisor, signedSupervisorRequest } from '../supervisor.mjs';
import { readableTaskStatus } from '../capacity-scheduler.mjs';
import { requireHoldCode } from '../intended-work.mjs';
import { carriedSupervisorOutcome, supervisorAdapter } from '../supervisor-dispatch.mjs';

const secret = 'shu86-test-secret-at-least-thirty-two-bytes';
const order = { version: '1.0.0', role: 'build', runtime: 'hermes-pool', issue_id: 'SHU-86',
  authorization_ref: 'SHU-86', attempt_id: '11111111-2222-4333-8444-555555555555',
  target_sha: 'a'.repeat(40), repo: 'example/repo', branch: 'fix/shu86', task_context: 'fix lane' };
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'shu86-'));
  const children = [];
  const make = (schedule) => new DurableSupervisor({ stateDir: dir, secret, ...(schedule ? { schedule } : {}),
    probeProcess: () => true, spawnWorker: () => {
      const child = new EventEmitter(); child.pid = 7000 + children.length; child.processStartToken = 'fixture-start';
      children.push(child); return child;
    } });
  t.after(() => { children.forEach(c => c.emit('exit', 1)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, make, children };
}
const idle = () => new Promise(resolve => setImmediate(resolve));

test('SHU-86: unpersisted next-action plan is UNLAUNCHED and autonomous idle recovery launches', async t => {
  const f = fixture(t), supervisor = f.make();
  // Reproduce the defect: the planner has only an in-memory promise of work.
  const plan = { ...order, description: 'next automatic action: launch fix lane' };
  const before = supervisor.store.reportIntent(plan);
  assert.equal(before.status, 'UNLAUNCHED', 'ANNOUNCE_WITHOUT_CLAIM: volatile plan cannot be reported as work');
  assert.equal(before.hold_code, 'MISSING_CLAIM');
  assert.equal(before.next_automatic_action, null);
  assert.throws(() => supervisor.store.announce(plan), { name: 'AssertionError',
    message: 'ANNOUNCE_WITHOUT_CLAIM: durable intent required before announcement' },
  'ANNOUNCE_WITHOUT_CLAIM: announcement must refuse a volatile plan');
  // Scheduler input is eligible work, not a human prompt. Persist, then let the
  // ordinary event loop recover the intention before any acceptance exists.
  supervisor.store.intend(order, new Date().toISOString(), 'AWAITING_LAUNCH');
  assert.equal(fs.existsSync(supervisor.store.paths(order.attempt_id).order), false);
  setImmediate(() => supervisor.recover());
  await idle(); await idle();
  assert.equal(f.children.length, 1, 'RECOVERY_NOT_EXACTLY_ONCE: autonomous idle must launch the pending fix once');
  assert.equal(supervisor.store.announce(order).status, 'RUNNING');
});

test('SHU-86: reporting requires an actual bound launch receipt', async t => {
  const f = fixture(t), supervisor = f.make(() => {});
  const response = await supervisor.submit(signedSupervisorRequest(order, secret));
  assert.equal(response.status, 'UNLAUNCHED', 'REPORT_WITHOUT_RECEIPT: durable intent alone cannot report running');
  assert.equal(response.hold_code, 'AWAITING_LAUNCH');
  const report = supervisor.store.announce(order);
  assert.equal(report.status, 'UNLAUNCHED', 'REPORT_WITHOUT_RECEIPT: durable intent alone cannot report running');
  const forged = { ...response, stage: 'RUNNING' };
  assert.equal(carriedSupervisorOutcome(forged, order).stage, 'LAUNCH_UNKNOWN',
    'REPORT_WITHOUT_RECEIPT: transport must refuse running without a launch receipt');
  let contacts = 0;
  const adapter = supervisorAdapter({ ...order, receipt_version: '1.1.0', requested_worker: 'hermes-box' },
    { SHU_SUPERVISOR_SECRET: secret }, { supervisorTransport: async () => { contacts++; return forged; } });
  assert.equal((await adapter.launchBuilder({})).stage, 'LAUNCH_UNKNOWN', 'REPORT_WITHOUT_RECEIPT: submission acknowledgement cannot report running');
  assert.equal(contacts, 1, 'REPORT_WITHOUT_RECEIPT: fixture must reach the transport');
  supervisor.store.writeRun(order.attempt_id, { ...supervisor.store.readRun(order.attempt_id), status: 'running' });
  assert.equal(supervisor.status(signedSupervisorRequest(order, secret, 'status')).stage, 'UNLAUNCHED');
  supervisor.store.claimLaunch(order.attempt_id, { attempt_id: order.attempt_id, phase: 'spawn_attempted' });
  assert.equal(supervisor.store.announce(order).status, 'UNLAUNCHED');
});

test('SHU-86: three restarts recover pending work exactly once', async t => {
  const f = fixture(t);
  f.make(() => {}).store.intend(order, new Date().toISOString(), 'AWAITING_LAUNCH');
  const counts = [];
  for (let restart = 1; restart <= 3; restart++) {
    const supervisor = f.make(); supervisor.recover();
    // Duplicate recovery in the same event-loop turn also exercises claim election.
    supervisor.recover(); await idle();
    counts.push(f.children.length);
    assert.equal(f.children.length, 1, 'RECOVERY_NOT_EXACTLY_ONCE: each restart must retain exactly one launch');
    assert.equal(supervisor.store.announce(order).status, 'RUNNING');
  }
  assert.deepEqual(counts, [1, 1, 1]);
  t.diagnostic('three restart cumulative launch counts: 1, 1, 1');
});

test('SHU-86: pending HOLD codes are mandatory and survive idle restart', async t => {
  const f = fixture(t), supervisor = f.make();
  for (const code of [undefined, null, '', 'some free text']) {
    assert.throws(() => supervisor.store.intend(order, new Date().toISOString(), code), /HOLD_CODE_REQUIRED/, 'HOLD_CODE_REQUIRED: absent or unknown HOLD codes must fail closed');
    assert.throws(() => requireHoldCode(code), { name: 'AssertionError',
      message: 'HOLD_CODE_REQUIRED: an enumerated HOLD code is required' },
    'HOLD_CODE_REQUIRED: absent or unknown HOLD codes must fail closed');
  }
  supervisor.store.intend(order, new Date().toISOString(), 'BLOCKED_BY_APPROVED_WINDOW');
  for (let i = 0; i < 3; i++) { f.make().recover(); await idle(); }
  assert.equal(f.children.length, 0);
  assert.equal(f.make().store.announce(order).hold_code, 'BLOCKED_BY_APPROVED_WINDOW');
  const path = supervisor.store.intentPath(order), bad = JSON.parse(fs.readFileSync(path));
  delete bad.hold_code; fs.writeFileSync(path, JSON.stringify(bad));
  assert.throws(() => f.make().recover(), /HOLD_CODE_REQUIRED/);
});

test('SHU-86: capacity occupancy never substitutes for a launch receipt', () => {
  for (const status of ['reserved', 'dispatching', 'running', 'queued', 'in-review']) {
    const report = readableTaskStatus({ task_id: 'fix-lane', runtime: 'codex-cli', role: 'build' },
      { status, next_automatic_action: 'launch_fix_lane' });
    assert.equal(report.status, 'UNLAUNCHED', 'REPORT_WITHOUT_RECEIPT: capacity occupancy is not execution evidence');
    assert.equal(report.hold_reason, 'MISSING_LAUNCH_RECEIPT');
    assert.equal(report.next_automatic_action, null);
  }
});

test('SHU-86: crash after spawn retains claim and stale wakeup cannot duplicate', async t => {
  const f = fixture(t), supervisor = f.make(() => {});
  await supervisor.submit(signedSupervisorRequest(order, secret));
  const writeRun = supervisor.store.writeRun.bind(supervisor.store);
  supervisor.store.writeRun = (id, run) => {
    if (run.status === 'running') throw new Error('simulated crash after spawn');
    return writeRun(id, run);
  };
  await assert.rejects(supervisor.launch(order.attempt_id), /simulated crash after spawn/);
  supervisor.store.writeRun = writeRun;
  await supervisor.launch(order.attempt_id); // stale scheduled wakeup
  for (let i = 0; i < 3; i++) { f.make().recover(); await idle(); }
  assert.equal(f.children.length, 1, 'RECOVERY_NOT_EXACTLY_ONCE: durable launch election must prevent duplicate spawn');
  assert.equal(supervisor.store.readRun(order.attempt_id).hold_code, 'AMBIGUOUS_LAUNCH');
  assert.equal(supervisor.store.announce(order).hold_code, 'AMBIGUOUS_LAUNCH');
});

const mutations = [
  ['remove persist-before-announce check', 'supervisor.mjs',
    "assert.ok(existsSync(this.intentPath(order)), 'ANNOUNCE_WITHOUT_CLAIM: durable intent required before announcement');", '',
    'unpersisted next-action', 'ANNOUNCE_WITHOUT_CLAIM: announcement must refuse a volatile plan'],
  ['remove receipt requirement', 'supervisor.mjs',
    "if (!hasLaunchReceipt(launch, order)) return { status: 'UNLAUNCHED', hold_code: launch ? requireHoldCode('AMBIGUOUS_LAUNCH') : intent.hold_code, next_automatic_action: null };",
    "if (false) return { status: 'UNLAUNCHED' };", 'reporting requires',
    'REPORT_WITHOUT_RECEIPT: durable intent alone cannot report running'],
  ['remove transport receipt requirement', 'supervisor-dispatch.mjs',
    "if (!hasLaunchReceipt(response.launch_receipt, receipt)) return {",
    "if (false) return {", 'reporting requires',
    'REPORT_WITHOUT_RECEIPT: submission acknowledgement cannot report running'],
  ['remove pending recovery', 'supervisor.mjs', 'this.store.accept(intent.order, this.now());', '',
    'three restarts', 'RECOVERY_NOT_EXACTLY_ONCE: each restart must retain exactly one launch'],
  ['remove launch claim election', 'supervisor.mjs', 'if (!claimed) return this.store.readRun(attemptId);', '',
    'crash after spawn retains', 'RECOVERY_NOT_EXACTLY_ONCE: durable launch election must prevent duplicate spawn'],
  ['make HOLD code optional', 'intended-work.mjs',
    "assert.ok(HOLD_CODES.includes(code), 'HOLD_CODE_REQUIRED: an enumerated HOLD code is required');", '',
    'pending HOLD codes', 'HOLD_CODE_REQUIRED: absent or unknown HOLD codes must fail closed'],
];
for (const [name, file, before, after, pattern, named] of mutations) {
  test(`SHU-86 mutation: ${name}`, () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'shu86-mutation-'));
    try {
      fs.cpSync(new URL('../', import.meta.url), dir, { recursive: true });
      const path = join(dir, file), source = fs.readFileSync(path, 'utf8');
      assert.equal(source.split(before).length, 2, `unique mutation anchor: ${name}`);
      fs.writeFileSync(path, source.replace(before, after));
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, join(dir, 'test/shu86-durable-intent.test.mjs')],
        { env, encoding: 'utf8', timeout: 15000 });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 1, output); assert.match(output, /AssertionError/); assert.ok(output.includes(named), output);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
