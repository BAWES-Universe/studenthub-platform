import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render, assertPolicy, serviceParameters, assertSupervisorLaunchEnvironment, supervisorAdapterKeys } from '../units.mjs';
import { fixtureParameters } from '../verify.mjs';
import { supervisorChildEnvironment } from '../credential-delivery.mjs';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { preflightActivation } from '../../activation.mjs';
import { reviewWrapper, reviewTestFiles, runReviewEvidence } from '../../review-execution.mjs';
import { supervisorEnvironment, environmentText, secretText, coordinatorText } from './shu71-supervisor-environment-fixture.mjs';
const keys = ephemeralPublicSource();
// Independent inventory of what the adapters read. Existing refusals keep their
// semantic responsibility; the new assertion binds presence to the actual file.
const contracts = {
  SHU_WORKER_UID: 'existing worker_identity_split; new file presence',
  SHU_WORKER_LAUNCH_WRAPPER: 'existing worker_identity_split; new file presence',
  SHU_WORKTREE_ROOT: 'existing host_push_broker; new file presence',
  SHU_PUSH_REMOTE_URL: 'existing host_push_broker; new file presence',
  SHU_REVIEW_EVIDENCE_DIR: 'existing REVIEW_EXECUTION_UNAVAILABLE/privateDirectory; new file presence',
  SHU_REVIEW_EXEC_UID: 'existing REVIEW_EXECUTION_UNAVAILABLE/distinct non-root uid; new file presence',
  SHU_REVIEW_EXEC_WRAPPER_JSON: 'existing REVIEW_EXECUTION_UNAVAILABLE/reviewWrapper; new file presence',
  SHU_REVIEW_MODEL_WRAPPER_JSON: 'existing REVIEW_EXECUTION_UNAVAILABLE/reviewWrapper; new file presence',
  SHU_REVIEW_TEST_FILES_JSON: 'existing REVIEW_EXECUTION_UNAVAILABLE/reviewTestFiles; new file presence',
};

test('B1_ENV_BINDING: exact per-unit file and nine effective adapter values', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const params = fixtureParameters(root);
  fs.writeFileSync(params.supervisorEnvironmentFile, secretText());
  fs.writeFileSync(params.coordinatorEnvironmentFile, coordinatorText());
  const units = render(params); assertPolicy(units, params);
  const defaults = serviceParameters({ workdir: root });
  assert.equal(defaults.supervisorEnvironmentFile, '/etc/shu/supervisor.env', 'B1_ENV_DEFAULT_SUPERVISOR');
  assert.equal(defaults.coordinatorEnvironmentFile, '/srv/shu/coordinator.env', 'B1_ENV_DEFAULT_COORDINATOR');
  for (const [unit, file] of [['shu-supervisor.service', params.supervisorEnvironmentFile], ['shu-coordinator.service', params.coordinatorEnvironmentFile]]) {
    assert.deepEqual(units[unit].split('\n').filter(l => l.startsWith('EnvironmentFile=')), [`EnvironmentFile=${file}`], 'SHU251_SECRET_FILE');
  }
  const env = assertSupervisorLaunchEnvironment(fs.readFileSync(params.supervisorEnvironmentFile, 'utf8'), fs.readFileSync(params.coordinatorEnvironmentFile, 'utf8'));
  assert.deepEqual(Object.keys(contracts), supervisorAdapterKeys, 'B1_ENV_NINE_KEYS');
  assert.deepEqual(env, supervisorEnvironment, 'B1_ENV_EFFECTIVE_VALUES');
  const child = supervisorChildEnvironment(env);
  for (const key of Object.keys(contracts)) assert.equal(child[key], env[key], `B1_ENV_CHILD_${key}`);
  assert.equal(child.SHU_SUPERVISOR_SECRET, undefined, 'B1_ENV_NO_TRANSPORT_SECRET_IN_CHILD');
  const p = productionFixture(t, keys), stat = p.boundary.fs.lstatSync('/etc/shu/supervisor.env');
  assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [0, 0, 0o600], 'B1_ENV_MODELED_CUSTODY');
});

for (const [key, responsibility] of Object.entries(contracts)) test(`B1_ENV_REQUIRED_${key}: ${responsibility}`, async t => {
  const env = { ...supervisorEnvironment }; delete env[key];
  const text = coordinatorText(env);
  assert.throws(() => assertSupervisorLaunchEnvironment(secretText(), text), e => e.code === 'SHU71_SUPERVISOR_ENV_REQUIRED' && e.key === key,
    `B1_ENV_NAMED_ABSENCE_${key}`);
  const p = productionFixture(t, keys); p.write('/srv/shu/coordinator.env', text, 0o600, 999);
  const result = await createShu71Production(p.id, p.boundary).execute('run');
  assert.equal(result.code, 'SHU71_SUPERVISOR_ENV_REQUIRED', `B1_ENV_PRODUCTION_REFUSAL_${key}`);
  assert.equal(p.signatures(), 0, `B1_ENV_BEFORE_SIGN_${key}`);
  assert.equal(p.exists('/srv/shu/state/shu71-activation.json'), false, `B1_ENV_NO_CREDENTIAL_${key}`);
  assert.ok(!p.events.some(e => e.startsWith('card:') || e.startsWith('command:') && /push --porcelain|update-ref/.test(e)), `B1_ENV_NO_FIXTURE_MUTATION_${key}`);
});

test('B1_EXISTING_ACTIVATION_GUARDS: worker split and broker settings fail closed without duplicated validation', () => {
  const env = { ...supervisorEnvironment, CODEX_SANDBOX_NETWORK: 'disabled', GITHUB_TOKEN: 'synthetic',
    SHU_PUSH_BROKER_ENABLED: 'true', COORDINATOR_HOST: 'fixture' };
  const check = values => preflightActivation({ env: values, stateDir: '/srv/codex/state', cwd: '/repo',
    io: { getuid: () => 999, statImpl: () => ({ isDirectory: () => true, mode: 0o40700 }),
      accessImpl() {}, realpathImpl: p => p, hostname: () => 'fixture' } });
  assert.equal(check(env).ok, true, 'B1_EXISTING_GUARDS_POSITIVE');
  for (const uid of [undefined, '0', '999']) {
    assert.ok(check({ ...env, SHU_WORKER_UID: uid }).unmet.some(u => u.requirement === 'worker_identity_split'), `B1_EXISTING_UID_${uid ?? 'unset'}`);
  }
  for (const [key, requirement] of [['SHU_WORKER_LAUNCH_WRAPPER', 'worker_identity_split'], ['SHU_WORKTREE_ROOT', 'host_push_broker'], ['SHU_PUSH_REMOTE_URL', 'host_push_broker']]) {
    assert.ok(check({ ...env, [key]: undefined }).unmet.some(u => u.requirement === requirement), `B1_EXISTING_${key}`);
  }
});

test('B1_EXISTING_REVIEW_GUARDS: missing reviewer UID, wrappers and tests refuse', async () => {
  for (const key of ['SHU_REVIEW_EXEC_WRAPPER_JSON', 'SHU_REVIEW_MODEL_WRAPPER_JSON']) {
    assert.throws(() => reviewWrapper({}, key), new RegExp(key), `B1_EXISTING_${key}`);
  }
  assert.throws(() => reviewTestFiles({}), /SHU_REVIEW_TEST_FILES_JSON/, 'B1_EXISTING_REVIEW_TEST_FILES');
  const result = await runReviewEvidence({ attempt_id: '11111111-1111-4111-8111-111111111111',
    target_sha: 'a'.repeat(40), cwd: '/fixture', env: {}, ownUid: 999 });
  assert.equal(result.reason_code, 'REVIEW_EXECUTION_UNAVAILABLE', 'B1_EXISTING_REVIEW_UID_REFUSAL');
  assert.match(result.detail, /SHU_REVIEW_EXEC_UID/, 'B1_EXISTING_REVIEW_UID_DETAIL');
  const env = { ...supervisorEnvironment }; delete env.SHU_REVIEW_EVIDENCE_DIR;
  const missingDirectory = await runReviewEvidence({ attempt_id: '11111111-1111-4111-8111-111111111111',
    target_sha: 'a'.repeat(40), cwd: '/fixture', env, ownUid: 999,
    validateWrapperImpl: () => ['/synthetic/sandbox'],
    fsImpl: { lstatSync: () => ({ uid: 0, mode: 0o555, isFile: () => true, isSymbolicLink: () => false }) } });
  assert.equal(missingDirectory.reason_code, 'REVIEW_EXECUTION_UNAVAILABLE', 'B1_EXISTING_EVIDENCE_DIR_REFUSAL');
  assert.equal(missingDirectory.detail, 'review evidence directory must be absolute', 'B1_EXISTING_EVIDENCE_DIR_DETAIL');
});

test('B1_ENV_CUSTODY: production requires modeled root root 0600 on the opened file', async t => {
  for (const [label, uid, mode, gid] of [['OWNER', 999, 0o600, 0], ['GROUP', 0, 0o600, 999], ['PUBLIC', 0, 0o644, 0], ['MODE', 0, 0o400, 0]]) {
    const p = productionFixture(t, keys);
    p.write('/etc/shu/supervisor.env', secretText(), mode, uid);
    // writeFileSync preserves an existing file's mode, so set it in the disposable tree.
    fs.chmodSync(`${p.root}/etc/shu/supervisor.env`, mode);
    if (gid) {
      const stat = p.boundary.fs.fstatSync;
      p.boundary.fs.fstatSync = fd => new Proxy(stat(fd), { get: (s, key) => key === 'gid' ? gid : Reflect.get(s, key) });
    }
    const result = await createShu71Production(p.id, p.boundary).execute('run');
    assert.equal(result.code, 'ACT_FILE_CUSTODY', `B1_ENV_CUSTODY_${label}`);
    assert.equal(p.signatures(), 0, `B1_ENV_CUSTODY_BEFORE_SIGN_${label}`);
  }
});

test('CLOSURE_ENV production combined and crossed sources refuse before signing', async t => {
  for (const crossed of [false, true]) {
    const p = productionFixture(t, keys);
    if (crossed) p.write('/srv/shu/coordinator.env', coordinatorText() + secretText(), 0o600, 999);
    else p.write('/etc/shu/supervisor.env', environmentText());
    const result = await createShu71Production(p.id, p.boundary).execute('run');
    assert.equal(result.code, 'SHU251_ENV_CROSSED', 'CLOSURE_ENV_NAMED_PRODUCTION_REFUSAL');
    assert.equal(p.signatures(), 0, 'CLOSURE_ENV_BEFORE_SIGN');
  }
});
