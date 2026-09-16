import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  BINDING_CODES, HostBindingHalt, capturePriorState, cleanupFixture, deliverStatusCredential,
  observeDriverQuiescence, observeFixtureLaunch, observeRemoteInventory, observeTransport,
  observeWorker, replayAndRelease, rollbackPriorState, validateWindowSpec,
} from '../host-window-bindings.mjs';

const SHA = 'a'.repeat(40), ATTEMPT = '11111111-2222-4333-8444-555555555555';
const named = binding => error => error instanceof HostBindingHalt && error.code === BINDING_CODES[binding]
  && error.message.startsWith(`${BINDING_CODES[binding]}:`);

const PROCESS_TOKEN = '123456';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'shu251-bindings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), workspace = path.join(root, 'workspace'), state = path.join(root, 'state');
  const evidence = path.join(root, 'evidence'), units = path.join(root, 'units'), staged = path.join(root, 'staged');
  for (const dir of [repo, workspace, state, evidence, units, staged, path.join(state, 'launches')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const order = { version: '1.0.0', issue_id: 'SHU-140', attempt_id: ATTEMPT, target_sha: SHA,
    role: 'build', runtime: 'codex-cli', repo: 'BAWES-Universe/studenthub-platform', branch: 'fixture', authorization_ref: 'fixture', task_context: 'fixture' };
  const orderFile = path.join(evidence, 'order.json'), envFile = path.join(evidence, 'status.env');
  fs.writeFileSync(orderFile, JSON.stringify(order), { mode: 0o600 });
  fs.writeFileSync(envFile, `SHU_SUPERVISOR_SECRET=${'s'.repeat(40)}\n`, { mode: 0o600 });
  const spec = { version: 'shu251-host-window-v2', approved_sha: SHA, repo_dir: repo,
    remote_url: 'https://github.com/BAWES-Universe/studenthub-platform.git', remote_ref: 'refs/heads/main',
    workspace_state_dir: workspace, supervisor_state_dir: state, supervisor_socket: path.join(root, 'supervisor.sock'),
    status_environment_file: envFile, service_uid: process.getuid() === 0 ? 999 : process.getuid(), unit_directory: units, staged_unit_directory: staged,
    prior_state_file: path.join(evidence, 'prior.json'), fixture: { issue_id: 'SHU-140', attempt_id: ATTEMPT,
      target_sha: SHA, order_json: orderFile, release_file: path.join(evidence, 'release'),
      journal_file: path.join(evidence, 'worker.log'), pid: 4242, start_token: PROCESS_TOKEN } };
  fs.writeFileSync(path.join(state, 'launches', `${ATTEMPT}.json`), JSON.stringify({ issue_id: 'SHU-140', attempt_id: ATTEMPT,
    target_sha: SHA, phase: 'launched', pid: 4242, completion_token_hash: 'b'.repeat(64) }), { mode: 0o600 });
  for (const name of ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer']) fs.writeFileSync(path.join(staged, name), `staged ${name}`, { mode: 0o644 });
  return { root, spec, order };
}

test('SHU251 operational bindings closed typed spec rejects free-form commands', t => {
  const { spec } = fixture(t);
  assert.equal(validateWindowSpec(spec), spec);
  assert.throws(() => validateWindowSpec({ ...spec, command: 'sh -c anything' }), named('remote_inventory'));
  const wrapper = path.resolve('.github/coordinator/service/shu251-operational-bindings.sh');
  const source = fs.readFileSync(wrapper, 'utf8');
  assert.doesNotMatch(source, /\beval\b|\bsh\s+-c\b|exec\s+"\$[A-Za-z_]/, 'SHU251_TYPED_ACTION: wrapper must not execute operator text');
  const rejected = spawnSync(wrapper, ['sh -c anything', '/tmp/spec.json'], { encoding: 'utf8' });
  assert.equal(rejected.status, 64, 'SHU251_TYPED_ACTION: unknown action must be rejected');
  assert.match(rejected.stderr, /SHU251_WINDOW_ACTION/, 'SHU251_TYPED_ACTION: unknown action must have typed output');
});

test('SHU251_REMOTE_INVENTORY positive control and mutation', async t => {
  const { spec } = fixture(t);
  const run = (_file, args) => args[0] === 'status' ? '' : args[0] === 'ls-remote' ? `${SHA}\trefs/heads/main` : SHA;
  const good = { run, readRemote: async () => ({ branch_head: SHA, comment_count: 3, comments_digest: 'd'.repeat(64) }) };
  assert.equal((await observeRemoteInventory(spec, good)).ok, true);
  const mutant = { run, readRemote: async () => ({ branch_head: 'c'.repeat(40), comment_count: 3, comments_digest: 'd'.repeat(64) }) };
  await assert.rejects(() => observeRemoteInventory(spec, mutant), named('remote_inventory'));
});

test('SHU251_STATUS_CREDENTIAL positive control and mutation', t => {
  const { spec } = fixture(t);
  const delivered = deliverStatusCredential(spec);
  assert.deepEqual(delivered.evidence.key_names, ['SHU_SUPERVISOR_SECRET']);
  assert.equal(Object.hasOwn(delivered.evidence, 'secret'), false);
  fs.chmodSync(spec.status_environment_file, 0o644);
  assert.throws(() => deliverStatusCredential(spec), named('status_credential_delivery'));
});

test('SHU251_DRIVER_QUIESCENCE positive control and mutation', t => {
  const { spec } = fixture(t);
  const good = { serviceState: () => 'inactive', run: () => '' };
  assert.equal(observeDriverQuiescence(spec, good).writer_lock, 'free');
  assert.throws(() => observeDriverQuiescence(spec, { ...good, serviceState: (_kind, unit) => unit.endsWith('.timer') ? 'active' : 'inactive' }), named('driver_quiescence'));
});

test('SHU251_FIXTURE_LAUNCH positive control and mutation', t => {
  const { spec } = fixture(t), file = path.join(spec.supervisor_state_dir, 'launches', `${ATTEMPT}.json`);
  assert.equal(observeFixtureLaunch(spec, { readStartToken: () => PROCESS_TOKEN }).pid, 4242);
  const receipt = JSON.parse(fs.readFileSync(file)); receipt.target_sha = 'c'.repeat(40); fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => observeFixtureLaunch(spec, { readStartToken: () => PROCESS_TOKEN }), named('fixture_launch_observation'));
});

test('SHU251_WORKER_OBSERVATION positive control and mutation', t => {
  const { spec } = fixture(t);
  assert.equal(observeWorker(spec, { readStartToken: () => PROCESS_TOKEN }).start_token, PROCESS_TOKEN);
  assert.throws(() => observeWorker(spec, { readStartToken: () => '654321' }), named('worker_observation'));
});

test('SHU251_TRANSPORT_OBSERVATION positive control and mutation', async t => {
  const { spec } = fixture(t);
  const credential = () => ({ secret: 's'.repeat(40), evidence: { key_names: ['SHU_SUPERVISOR_SECRET'] } });
  const status = async () => ({ ok: true, stage: 'RUNNING', attempt_id: ATTEMPT, target_sha: SHA });
  const socketStat = () => ({ isSocket: () => true, isSymbolicLink: () => false });
  assert.equal((await observeTransport(spec, { credential, status, socketStat })).stage, 'RUNNING');
  await assert.rejects(() => observeTransport(spec, { credential, socketStat, status: async () => { throw new Error('mutant transport'); } }), named('transport_observation'));
});

test('SHU251_REPLAY_RELEASE positive control and mutation', async t => {
  const { spec } = fixture(t);
  const credential = () => ({ secret: 's'.repeat(40), evidence: {} });
  const observeLaunch = () => ({ pid: 4242, start_token: PROCESS_TOKEN }), observeLiveWorker = () => ({ pid: 4242, start_token: PROCESS_TOKEN });
  assert.equal((await replayAndRelease(spec, { credential, submit: async () => ({ ok: true, duplicate: true, status: 'RUNNING' }), observeLaunch, observeLiveWorker })).released, true);
  fs.rmSync(spec.fixture.release_file);
  await assert.rejects(() => replayAndRelease(spec, { credential, submit: async () => ({ ok: false, stage: 'HOLD' }), observeLaunch, observeLiveWorker }), named('replay_release'));
});

test('SHU251_FIXTURE_CLEANUP positive control and mutation', t => {
  const { spec } = fixture(t), signals = [];
  fs.writeFileSync(spec.fixture.release_file, 'release'); fs.writeFileSync(spec.fixture.journal_file, 'journal');
  const observeLaunch = () => ({ pid: 4242, start_token: PROCESS_TOKEN });
  assert.equal(cleanupFixture(spec, { signal: (...args) => signals.push(args), observeLaunch, waitForExit: () => true }).signaled_pid, 4242);
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  const outside = path.join(spec.repo_dir, 'outside.log'); fs.writeFileSync(outside, 'x');
  const mutant = { ...spec, fixture: { ...spec.fixture, journal_file: outside } };
  fs.writeFileSync(spec.fixture.release_file, 'release');
  assert.throws(() => cleanupFixture(mutant, { signal: () => {}, observeLaunch, waitForExit: () => true }), named('fixture_cleanup'));
});

test('SHU251_PRIOR_STATE_ROLLBACK positive control and mutation', t => {
  const { spec } = fixture(t), unit = path.join(spec.unit_directory, 'shu-supervisor.service');
  fs.writeFileSync(unit, 'prior', { mode: 0o640 });
  const states = { serviceState: kind => kind === 'is-active' ? 'inactive' : 'disabled', run: () => '' };
  assert.equal(capturePriorState(spec, states).ok, true);
  fs.writeFileSync(unit, 'staged shu-supervisor.service');
  assert.equal(rollbackPriorState(spec, { run: () => '' }).ok, true);
  assert.equal(fs.readFileSync(unit, 'utf8'), 'prior');
  const prior = JSON.parse(fs.readFileSync(spec.prior_state_file)); prior.approved_sha = 'c'.repeat(40); fs.writeFileSync(spec.prior_state_file, JSON.stringify(prior));
  assert.throws(() => rollbackPriorState(spec, { run: () => '' }), named('prior_state_rollback'));
});

test('SHU251_UNEXPECTED: non-directory unit_directory reaches ENOTDIR', t => {
  const { root, spec } = fixture(t);
  fs.rmdirSync(spec.unit_directory);
  fs.writeFileSync(spec.unit_directory, 'fixture regular file');
  assert.throws(() => capturePriorState(spec, {
    serviceState: () => assert.fail('SHU251_UNEXPECTED: must fail before service access'),
  }), { code: 'ENOTDIR' }, 'SHU251_UNEXPECTED: non-directory example is reachable');
  const specFile = path.join(root, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const run = spawnSync(process.execPath, [new URL('../host-window-bindings.mjs', import.meta.url).pathname,
    'capture-prior', specFile], { encoding: 'utf8' });
  assert.equal(run.status, 2, 'SHU251_UNEXPECTED: CLI failure exit');
  const error = JSON.parse(run.stderr);
  assert.equal(error.ok, false, 'SHU251_UNEXPECTED: CLI failure contract');
  assert.equal(error.code, 'SHU251_UNEXPECTED', 'SHU251_UNEXPECTED: CLI classifies ENOTDIR');
  assert.match(error.reason, /ENOTDIR/, 'SHU251_UNEXPECTED: CLI preserves reason');
  assert.equal(Object.hasOwn(error, 'binding'), false, 'SHU251_UNEXPECTED: no binding name');
});

test('SHU251 operational wrapper routes every reviewed lifecycle action without host effects', t => {
  const { root } = fixture(t);
  const wrapper = path.resolve('.github/coordinator/service/shu251-operational-bindings.sh');
  const window = { approved_sha: SHA, repo_dir: root };
  const windowFile = path.join(root, 'window.json'), driverFile = path.join(root, 'driver.json');
  fs.writeFileSync(windowFile, JSON.stringify(window));
  fs.writeFileSync(driverFile, JSON.stringify({ window, window_spec_path: windowFile, render: { workdir: root } }));
  const actions = ['preflight', 'install', 'start', 'readiness', 'running-gate-off', 'restart', 'host-rollback', 'pin', 'pin-restore', 'pin-retain'];
  for (const action of actions) {
    const result = spawnSync(wrapper, [action, driverFile, '--approved-host-mutation', SHA], {
      encoding: 'utf8', env: { ...process.env, SHU251_HOST_MUTATION_APPROVED: 'true' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).step, action);
    assert.equal(JSON.parse(result.stdout).dry_run, true);
    if (action !== 'preflight') {
      const denied = spawnSync(wrapper, [action, driverFile, '--execute'], {
        encoding: 'utf8', env: { ...process.env, SHU251_HOST_MUTATION_APPROVED: '' },
      });
      assert.equal(denied.status, 2);
      assert.equal(JSON.parse(denied.stderr).code, 'SHU251_HOST_MUTATION_APPROVAL');
    }
  }
  const unknown = spawnSync(wrapper, ['untested-new-action', driverFile], { encoding: 'utf8' });
  assert.equal(unknown.status, 64);
  assert.equal(JSON.parse(unknown.stderr).code, 'SHU251_WINDOW_ACTION');
  const override = spawnSync(wrapper, ['install', driverFile, '--provider', '/attacker.mjs'], { encoding: 'utf8' });
  assert.equal(override.status, 2);
  assert.equal(JSON.parse(override.stderr).code, 'SHU251_DRIVER_USAGE');
});
