import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACTIONS, UNIT_NAMES, drive, hash, receipt, validateReceipt, assertRollbackSafe } from '../phase-a-driver.mjs';

const SHA = 'a'.repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const window = { approved_sha: SHA, repo_dir: root, remote_ref: 'refs/heads/main', workspace_state_dir: path.join(root, 'state'), supervisor_state_dir: path.join(root, 'supervisor'), unit_directory: path.join(root, 'units'), prior_state_file: path.join(root, 'prior.json'), fixture: { issue_id: 'SHU-251', attempt_id: '12345678-1234-1234-1234-123456789012', target_sha: SHA, pid: 1234, start_token: '456', release_file: path.join(root, 'release'), journal_file: path.join(root, 'journal') } };
  fs.mkdirSync(window.unit_directory);
  const units = Object.fromEntries(UNIT_NAMES.map(n => [n, n.endsWith('.timer') ? '[Timer]\nOnUnitInactiveSec=60s\n' : '[Service]\nEnvironment=ENABLE_DISPATCH=false\n']));
  for (const [name, data] of Object.entries(units)) fs.writeFileSync(path.join(window.unit_directory, name), data);
  const spec = { window, window_spec_path: path.join(root, 'window.json'), render: { workdir: root } };
  fs.writeFileSync(spec.window_spec_path, JSON.stringify(window));
  const prior = { version: 'shu251-prior-state-v1', approved_sha: SHA, active: {}, enabled: {}, units: {} };
  for (const n of UNIT_NAMES) { prior.active[n] = 'inactive'; prior.enabled[n] = 'disabled'; prior.units[n] = { data: Buffer.from(units[n]).toString('base64'), mode: 0o644 }; }
  fs.writeFileSync(window.prior_state_file, JSON.stringify(prior));
  const calls = []; let time = 0;
  const evidence = action => {
    const base = { binding: ACTIONS[action], ok: true };
    if (action === 'inventory') return { ...base, approved_sha: SHA, remote_ref: window.remote_ref, fixture_branch_head: SHA, comment_count: 0, comments_digest: hash('[]') };
    if (action === 'quiescence') return { ...base, states: Object.fromEntries(UNIT_NAMES.map(n => [n, 'inactive'])), writer_lock: 'free' };
    if (action === 'worker') return { ...base, pid: 1234, start_token: '456' };
    if (action === 'launch') return { ...base, pid: 1234, start_token: '456', issue_id: window.fixture.issue_id, attempt_id: window.fixture.attempt_id, target_sha: SHA };
    if (action === 'transport') return { ...base, stage: 'RUNNING', attempt_id: window.fixture.attempt_id, credential: { binding: 'status_credential_delivery', ok: true } };
    if (action === 'rollback') return { ...base, restored_revision: SHA };
    if (action === 'capture-prior') return { ...base, prior_state_file: window.prior_state_file };
    if (action === 'replay-release') return { ...base, replay: 'accepted', released: true, attempt_id: window.fixture.attempt_id };
    if (action === 'cleanup') return { ...base, signaled_pid: 1234, removed: [window.fixture.release_file, window.fixture.journal_file] };
  };
  const io = { read: f => fs.readFileSync(f), render: async () => units, pin() {}, lockExisting() {}, run: async (action, file) => { assert.equal(file, spec.window_spec_path); calls.push(action); return JSON.stringify({ ok: true, evidence: evidence(action) }); }, snapshot: () => ({ file: { sha256: hash('state') } }), watch: () => ({ count: () => 0, close() {} }), now: () => time, wait: async ms => { time += ms; }, invocation: () => 'b'.repeat(32) };
  return { root, spec, io, calls, prior, units, evidence };
}
const approved = { execute: true, env: { SHU251_HOST_MUTATION_APPROVED: 'true' }, approvedHostMutation: SHA };
const named = code => e => e.code === code;

test('SHU251 driver dry run invokes no binding', async t => {
  const { spec, io, calls } = fixture(t);
  assert.equal((await drive('identity', spec, {}, io)).dry_run, true);
  assert.deepEqual(calls, []);
});
test('SHU251 driver approval is explicit for every mutation', async t => {
  const { spec, io, calls } = fixture(t);
  for (const step of ['rollback', 'capture-prior', 'cleanup', 'replay-release']) {
    for (const options of [{ execute: true }, { ...approved, env: {} }, { ...approved, approvedHostMutation: 'b'.repeat(40) }])
      await assert.rejects(() => drive(step, spec, options, io), named('SHU251_HOST_MUTATION_APPROVAL'), 'APPROVAL_REQUIRED: mutation must require both exact approvals');
  }
  assert.deepEqual(calls, []);
});
test('SHU251 driver installed identity is byte exact', async t => {
  const { spec, io } = fixture(t);
  const good = await drive('identity', spec, { execute: true }, io);
  assert.deepEqual(good.evidence.rendered_sha256, good.evidence.installed_sha256);
  fs.appendFileSync(path.join(spec.window.unit_directory, UNIT_NAMES[0]), '\n');
  await assert.rejects(() => drive('identity', spec, { execute: true }, io), named('SHU251_UNIT_IDENTITY'), 'UNIT_BYTES_REQUIRED: trailing newline mismatch must refuse');
});
test('SHU251 driver receipt binds the evidence digest', t => {
  const { spec } = fixture(t);
  const value = receipt('identity', spec, { rendered_sha256: { unit: hash('original') }, installed_sha256: { unit: hash('original') } });
  validateReceipt(value, 'identity', spec);
  value.evidence.installed_sha256.unit = hash('changed');
  assert.throws(() => validateReceipt(value, 'identity', spec), named('SHU251_EVIDENCE_DIGEST'), 'EVIDENCE_BOUND: changed evidence must refuse');
});
test('SHU251 driver receipt rejects wrong revision spec step and keys', t => {
  const { spec } = fixture(t);
  for (const patch of [{ approved_sha: 'b'.repeat(40) }, { spec_sha256: hash('other') }, { step: 'worker' }, { extra: true }, { evidence: [] }])
    assert.throws(() => validateReceipt({ ...receipt('identity', spec, { rendered_sha256: {}, installed_sha256: {} }), ...patch }, 'identity', spec), named('SHU251_RECEIPT_INVALID'));
});
test('SHU251 driver gate off observes two complete wake intervals', async t => {
  const { spec, io, calls } = fixture(t);
  const result = await drive('gate-off', spec, { execute: true }, io);
  assert.equal(result.evidence.elapsed_ms, 122000);
  assert.equal(result.evidence.samples.length, 3);
  assert.equal(result.evidence.writes, 0); assert.equal(result.evidence.launches, 0);
  assert.equal(calls.filter(a => a === 'inventory').length, 4);
  assert.equal(calls.filter(a => a === 'quiescence').length, 4);
});
test('SHU251 driver refuses inventory differences writes and short waits', async t => {
  for (const fault of ['inventory', 'writes', 'time']) {
    const { spec, io } = fixture(t); let n = 0, closed = false;
    if (fault === 'inventory') io.snapshot = () => ({ n: n++ });
    io.watch = () => ({ count: () => fault === 'writes' ? 1 : 0, close: () => { closed = true; } });
    if (fault === 'time') io.wait = async () => {};
    await assert.rejects(() => drive('gate-off', spec, { execute: true }, io), named(fault === 'inventory' ? 'SHU251_GATE_OFF_DIFF' : fault === 'writes' ? 'SHU251_GATE_OFF_WRITES' : 'SHU251_WAKE_INTERVAL'));
    assert.equal(closed, true);
  }
});
test('SHU251 driver refuses malformed and unbound binding receipts', async t => {
  const { spec, io } = fixture(t);
  for (const raw of ['not json', '{}', JSON.stringify({ ok: true, evidence: { ok: true, binding: 'worker_observation', pid: 999, start_token: '456' } })]) {
    io.run = async () => raw;
    await assert.rejects(() => drive('worker', spec, { execute: true }, io), named('SHU251_BINDING_RECEIPT'));
  }
});
test('SHU251 driver restart accepts new supervisor and same live worker', async t => {
  const { spec, io, calls } = fixture(t);
  const before = await drive('restart-before', spec, { execute: true }, io);
  await assert.rejects(() => drive('restart-after', spec, { execute: true, before }, io), named('SHU251_RESTART_ACCEPTANCE'));
  io.invocation = () => 'c'.repeat(32);
  const after = await drive('restart-after', spec, { execute: true, before }, io);
  assert.equal(after.evidence.worker.pid, before.evidence.worker.pid);
  assert.ok(calls.includes('transport'));
  assert.match(after.evidence.before_receipt_sha256, /^[a-f0-9]{64}$/);
});
test('SHU251 driver rollback cannot restore active or enabled dispatch', async t => {
  const { spec, io, prior, calls } = fixture(t);
  for (const field of ['active', 'enabled']) {
    const altered = structuredClone(prior); altered[field][UNIT_NAMES[0]] = field;
    fs.writeFileSync(spec.window.prior_state_file, JSON.stringify(altered));
    await assert.rejects(() => drive('rollback', spec, approved, io), named('SHU251_ROLLBACK_REENABLE'), 'ROLLBACK_STAYS_OFF: active or enabled prior state must refuse');
  }
  assert.ok(!calls.includes('rollback'));
});
test('SHU251 driver rollback uses reviewed path and verifies quiescence', async t => {
  const { spec, io, calls, prior } = fixture(t);
  const result = await drive('rollback', spec, approved, io);
  assert.deepEqual(calls, ['inventory', 'rollback', 'quiescence']);
  assert.equal(result.evidence.dispatch_reenabled, false);
  prior.units[UNIT_NAMES[0]].data = Buffer.from('Environment=ENABLE_DISPATCH=true\n').toString('base64');
  assert.throws(() => assertRollbackSafe(prior, SHA), named('SHU251_ROLLBACK_REENABLE'));
});
test('SHU251 driver routes all nine reviewed actions', async t => {
  const { spec, io, calls } = fixture(t);
  for (const step of Object.keys(ACTIONS)) await drive(step, spec, approved, io);
  for (const action of Object.keys(ACTIONS)) assert.ok(calls.includes(action));
});
test('SHU251 driver refuses changed window spec before execution', async t => {
  const { spec, io, calls } = fixture(t);
  fs.writeFileSync(spec.window_spec_path, '{}');
  await assert.rejects(() => drive('inventory', spec, { execute: true }, io), named('SHU251_SPEC_CHANGED'));
  assert.deepEqual(calls, []);
});

const mutations = [
  { name: 'missing capability classified as skip', module: 'host-suite-contract', test: 'host-suite-contract', pattern: 'SHU251 contract missing capabilities never become skips', from: 'if (!available) halt(capability.code, capability.name);', to: "if (!available) { evidence[capability.name] = 'skip'; continue; }", assertion: 'CAPABILITY_REQUIRED: missing privilege must refuse' },
  { name: 'out of set skip accepted', module: 'host-suite-contract', test: 'host-suite-contract', pattern: 'SHU251 contract refuses outcomes outside the exact permitted set', from: "if (status === 'skip' && (!Object.hasOwn(PERMITTED_SKIPS, name) || reason !== PERMITTED_SKIPS[name]))", to: 'if (false)', assertion: 'SKIP_SET_REQUIRED: undocumented skip must refuse' },
  { name: 'mutation approval bypassed', module: 'phase-a-driver', test: 'phase-a-driver', pattern: 'SHU251 driver approval is explicit for every mutation', from: 'if (MUTATIONS.has(action) && !(options.env?.SHU251_HOST_MUTATION_APPROVED', to: 'if (false && MUTATIONS.has(action) && !(options.env?.SHU251_HOST_MUTATION_APPROVED', assertion: 'APPROVAL_REQUIRED: mutation must require both exact approvals' },
  { name: 'evidence digest unbound', module: 'phase-a-driver', test: 'phase-a-driver', pattern: 'SHU251 driver receipt binds the evidence digest', from: 'if (value.evidence_sha256 !== hash(canonical(value.evidence)))', to: 'if (false)', assertion: 'EVIDENCE_BOUND: changed evidence must refuse' },
  { name: 'rollback implicitly reenables dispatch', module: 'phase-a-driver', test: 'phase-a-driver', pattern: 'SHU251 driver rollback cannot restore active or enabled dispatch', from: "if (prior.active?.[unit] !== 'inactive' || !['disabled', 'masked', 'static', 'indirect', 'not-found'].includes(prior.enabled?.[unit]))", to: 'if (false)', assertion: 'ROLLBACK_STAYS_OFF: active or enabled prior state must refuse' },
  { name: 'installed identity compared leniently', module: 'phase-a-driver', test: 'phase-a-driver', pattern: 'SHU251 driver installed identity is byte exact', from: 'if (!expected.equals(actual))', to: "if (expected.toString().trim() !== actual.toString().trim())", assertion: 'UNIT_BYTES_REQUIRED: trailing newline mismatch must refuse' },
];
for (const mutation of mutations) test(`SHU251 phase A mutation: ${mutation.name}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  // Only the four new source/test modules are copied; no Git objects, host paths,
  // baseline branch, fixtures or runtime files from the real checkout are used.
  for (const name of ['phase-a-driver', 'host-suite-contract']) {
    fs.copyFileSync(new URL(`../${name}.mjs`, import.meta.url), path.join(root, `${name}.mjs`));
    fs.copyFileSync(new URL(`./${name}.test.mjs`, import.meta.url), path.join(root, 'test', `${name}.test.mjs`));
  }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const args = ['--test', `--test-name-pattern=^${mutation.pattern}$`, path.join(root, 'test', `${mutation.test}.test.mjs`)];
  const run = () => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const control = run();
  assert.equal(control.status, 0, control.stdout + control.stderr);
  assert.match(control.stdout, /^# pass 1$/m, 'matched control must pass exactly one test');
  assert.match(control.stdout, /^# fail 0$/m);
  const target = path.join(root, `${mutation.module}.mjs`), original = fs.readFileSync(target, 'utf8');
  assert.equal(original.split(mutation.from).length, 2, 'exactly one unique textual replacement');
  fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
  assert.equal(spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' }).status, 0, 'mutant must be syntax clean');
  const mutant = run(), output = mutant.stdout + mutant.stderr;
  assert.equal(mutant.status, 1, output);
  assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, 'crashes do not kill mutants');
  assert.match(output, /name: 'AssertionError'/);
  assert.match(output, /code: 'ERR_ASSERTION'/);
  assert.match(output, /failureType: 'testCodeFailure'/);
  assert.ok(output.includes(mutation.assertion), `must name assertion: ${mutation.assertion}\n${output}`);
  assert.match(output, /^# fail 1$/m);
  t.diagnostic(`${mutation.name}: ${output.match(/^  error: (.*)$/m)?.[1]}`);
});
