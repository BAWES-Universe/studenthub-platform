import { test as nodeTest } from 'node:test';
// Bound every service test, including regressions that leave asynchronous work pending.
const noSystemd = { skip: process.env.SHU251_NO_SYSTEMD === '1' ? 'SHU251_NO_SYSTEMD: systemd interaction prohibited in this window' : false };
const test = (name, options, fn) => typeof options === 'function'
  ? nodeTest(name, { timeout: 10000 }, options)
  : nodeTest(name, { timeout: 10000, ...options }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { render, assertPolicy, verifySyntax, names, WORKSPACE_STATE_DIR, serviceParameters } from '../units.mjs';
import { install, rollback, snapshot } from '../install.mjs';
import { verify, fixtureParameters, assertQuiet } from '../verify.mjs';
import { assertFixtureEnvironmentUnchanged } from '../verify.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu251-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function named(fn, message) {
  assert.throws(fn, error => error.name === 'AssertionError' && error.message.includes(message));
}

test('SHU251 local kill-switch, syntax and rollback harness', noSystemd, async () => {
  assert.equal((await verify()).writes, 0);
});
test('SHU251 parameterised argv and unit syntax', noSystemd, t => {
  const root = fixture(t), params = fixtureParameters(root);
  params.supervisor.push('literal $TOKEN %i "quote" \\ slash');
  const units = render(params);
  assert.match(units[names[0]], /\$\$TOKEN %%i/);
  for (const name of names) fs.writeFileSync(join(root, name), units[name]);
  assertPolicy(units, params);
  verifySyntax(root);
  named(() => render({ ...params, supervisor: ['relative'] }), 'SHU251_COMMAND');
  named(() => render({ ...params, coordinator: ['relative'] }), 'SHU251_COMMAND');
  named(() => render({ ...params, supervisor: ['/usr/bin/true', 'bad\nRestart=no'] }), 'SHU251_PARAMETER');
});
test('SHU251 staging is idempotent and preserves original backup', noSystemd, t => {
  const root = fixture(t), params = fixtureParameters(root);
  fs.writeFileSync(join(root, names[0]), 'old\n', { mode: 0o640 });
  const before = snapshot(root);
  assert.equal(install(root, params).changed, true);
  const backup = fs.readFileSync(join(root, '.shu251-backup.json'));
  const times = names.map(n => fs.statSync(join(root, n)).mtimeMs);
  assert.equal(install(root, params).changed, false);
  assert.deepEqual(names.map(n => fs.statSync(join(root, n)).mtimeMs), times);
  assert.deepEqual(fs.readFileSync(join(root, '.shu251-backup.json')), backup);
  rollback(root);
  assert.deepEqual(snapshot(root), before, 'SHU251_ROLLBACK: prior bytes, modes and absence must be restored');
  assert.equal(rollback(root).changed, false);
});
test('SHU251 drift requires rollback and symlinks are refused', noSystemd, t => {
  const root = fixture(t), params = fixtureParameters(root);
  install(root, params);
  fs.writeFileSync(join(root, names[1]), 'drift');
  named(() => install(root, params), 'SHU251_DRIFT');
  rollback(root);
  fs.symlinkSync(join(root, 'missing'), join(root, names[0]));
  named(() => install(root, params), 'SHU251_FILE');
});
test('SHU251 refuses unsafe destination and concurrent transaction', t => {
  const root = fixture(t), params = fixtureParameters(root);
  named(() => install('/etc', params), 'SHU251_DESTINATION');
  fs.chmodSync(root, 0o770);
  named(() => install(root, params), 'SHU251_PRIVATE');
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(join(root, '.shu251-operation'));
  assert.throws(() => install(root, params), { code: 'EEXIST' });
  assert.equal(fs.existsSync(join(root, '.shu251-backup.json')), false);
});
test('SHU251 invalid executable fails syntax before staging changes', noSystemd, t => {
  const root = fixture(t), params = fixtureParameters(root), before = snapshot(root);
  params.supervisor = [join(root, 'missing-executable')];
  named(() => install(root, params), 'SHU251_SYNTAX');
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(fs.readdirSync(root), ['.environment']);
  assertFixtureEnvironmentUnchanged(root);
});
test('SHU251 common flock excludes overlapping writers and releases after exit', { timeout: 5000 }, async t => {
  const root = fixture(t), lock = join(root, 'host-tick.lock');
  const holder = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '2', lock, process.execPath,
    '-e', "process.stdout.write('ready'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => holder.stdin.end());
  await once(holder.stdout, 'data');
  const rejected = spawnSync('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '2', lock, process.execPath, '-e', "require('node:fs').appendFileSync(process.argv[1], '');", join(root, 'second-writer')]);
  assert.equal(rejected.status, 2, 'SHU251_LOCK: concurrent writer must be refused');
  assert.equal(fs.existsSync(join(root, 'second-writer')), false, 'SHU251_LOCK: concurrent writer must be refused');
  const exited = once(holder, 'exit');
  holder.stdin.end();
  await exited;
  assert.equal(spawnSync('/usr/bin/flock', ['--nonblock', lock, process.execPath, '-e', '']).status, 0, 'SHU251_LOCK_RELEASE: writer exit must release the lock');
});

const policyMutations = [
  ['supervisor restart removed', names[0], 'Restart=on-failure', 'Restart=no', 'SHU251_RESTART: supervisor must restart on failure'],
  ['writer restart removed', names[1], 'Restart=on-failure', 'Restart=no', 'SHU251_RESTART: writer must restart on failure'],
  ['worker preservation removed', names[0], 'KillMode=process', 'KillMode=control-group', 'SHU251_CHILDREN: routine restart must preserve workers'],
  ['writer lock bypassed', names[1], '"/usr/bin/flock"', '"/usr/bin/true"', 'SHU251_WRITER: tick must hold the common flock'],
  ['timer misdirected', names[2], 'Unit=shu-coordinator.service', 'Unit=other.service', 'SHU251_WAKE: timer must target the single writer'],
  ['dispatch gate enabled', names[1], 'ENABLE_DISPATCH=false', 'ENABLE_DISPATCH=true', 'SHU251_GATE: staged dispatch must be off'],
];
for (const [label, name, before, after, message] of policyMutations) test(`SHU251 mutation: ${label}`, t => {
  const params = fixtureParameters(fixture(t)), units = render(params);
  assert.ok(units[name].includes(before));
  units[name] = units[name].replace(before, after);
  named(() => assertPolicy(units, params), message);
});
for (const [label, after, launches, writes, message] of [
  ['unexpected adapter call', {}, 1, 0, 'SHU251_ZERO_LAUNCH: disabled tick must make zero adapter calls'],
  ['remote mutation', {}, 0, 1, 'SHU251_ZERO_WRITE: disabled tick must make zero remote mutations'],
  ['durable state changed', { receipt: 'changed' }, 0, 0, 'SHU251_STATE_DIFF: disabled tick must preserve all fixture state'],
]) test(`SHU251 mutation: ${label}`, () => named(() => assertQuiet({}, after, launches, writes), message));

test('SHU251 mutation: rollback restore omitted', async t => {
  const root = fixture(t), moduleRoot = fixture(t);
  const source = fs.readFileSync(new URL('../install.mjs', import.meta.url), 'utf8');
  const target = 'else atomic(join(root, name), Buffer.from(item.data, \'base64\'), item.mode);';
  assert.ok(source.includes(target));
  const mutant = source.replace(target, 'else { /* mutation: omit restoration */ }')
    .replace("'./units.mjs'", JSON.stringify(new URL('../units.mjs', import.meta.url).href));
  const file = join(moduleRoot, 'mutant.mjs');
  fs.writeFileSync(file, mutant);
  const mutated = await import(pathToFileURL(file));
  fs.writeFileSync(join(root, names[0]), 'old', { mode: 0o600 });
  mutated.install(root, fixtureParameters(root));
  named(() => mutated.rollback(root), 'SHU251_ROLLBACK: prior bytes, modes and absence must be restored');
});


test('SHU251 partial staging failure restores prior state', noSystemd, t => {
  const root = fixture(t), params = fixtureParameters(root);
  fs.writeFileSync(join(root, names[0]), 'old supervisor', { mode: 0o600 });
  const prior = snapshot(root), rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && to === join(root, names[1])) {
      injected = true;
      throw new Error('injected staging write failure');
    }
    return rename(from, to);
  };
  try { assert.throws(() => install(root, params), /injected staging write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.deepEqual(snapshot(root), prior, 'SHU251_ROLLBACK: prior bytes, modes and absence must be restored');
  assert.deepEqual(fs.readdirSync(root), ['.environment', names[0]]);
  assertFixtureEnvironmentUnchanged(root);
});

test('SHU251 canonical writer lock accepted and foreign parameter refused', t => {
  const params = fixtureParameters(fixture(t));
  assertPolicy(render(params), params);
  named(() => render({ ...params, writerLock: '/tmp/foreign.lock' }), 'SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock');
});
test('SHU251 mutation: rendered foreign writer lock', t => {
  const params = fixtureParameters(fixture(t)), units = render(params);
  units[names[1]] = units[names[1]].replace(params.writerLock, '/tmp/foreign.lock');
  named(() => assertPolicy(units, params), 'SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock');
});
test('SHU251 nonexistent destination has named refusal', t => {
  const root = fixture(t);
  named(() => install(join(root, 'missing'), fixtureParameters(root)), 'SHU251_DESTINATION: existing real temporary staging directory required');
});
test('SHU251 mutation: unresolved timer placeholder', t => {
  const params = fixtureParameters(fixture(t)), units = render(params);
  units[names[2]] += '\n@UNRESOLVED@\n';
  named(() => assertPolicy(units, params), 'SHU251_PARAMETER: unresolved template');
});
test('SHU251 mutation: enabled tick trips real kill-switch harness', async () => {
  const { verifyKillSwitch } = await import('../verify.mjs');
  await assert.rejects(() => verifyKillSwitch({ enabled: true }), error => error.name === 'AssertionError'
    && error.message.includes('SHU251_ZERO_LAUNCH: disabled tick must make zero adapter calls'));
});
for (const [label, from, to, unit, message] of [
  ['supervisor dependency removed', 'Requires=shu-supervisor.service', '', names[1], 'SHU251_DEPENDENCY: coordinator must require supervisor'],
  ['supervisor readiness bypassed', 'Type=notify', 'Type=simple', names[0], 'SHU251_READINESS: supervisor must notify after recovery and listen'],
]) test(`SHU251 mutation: ${label}`, t => {
  const params = fixtureParameters(fixture(t)), units = render(params);
  units[unit] = units[unit].replace(from, to);
  named(() => assertPolicy(units, params), message);
});
test('SHU251 required CI runs both globs with service prerequisites', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url)));
  assert.equal(pkg.scripts['test:coordinator'], 'node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs', 'SHU251_CI: standard coordinator command must include both globs');
  const ci = fs.readFileSync(new URL('../../../workflows/ci.yml', import.meta.url), 'utf8').split('  fast-checks:')[1];
  assert.ok(ci.includes('run: npm run test:coordinator') && ci.includes('systemd-analyze --version && test -x /usr/bin/flock') && !ci.includes('continue-on-error:'), 'SHU251_CI: required fast-checks must enforce service tests and prerequisites');
});

test('SHU251 documentation scopes gates, timeout, verifier side effect and non-root baseline', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of ['not an independent kill switch', 'hung tick never times out', '/run/systemd/systemd-units-load', 'does not establish positive discrimination', 'Requires=shu-supervisor.service']) {
    assert.ok(readme.includes(text), `SHU251_DOCUMENTATION: required operational qualification missing: ${text}`);
  }
  const baseline = fs.readFileSync(new URL('../../SHU-250-VALIDATION.md', import.meta.url), 'utf8');
  assert.ok(baseline.includes('**non-root**') && baseline.includes('758 pass / 0 skipped'), 'SHU251_BASELINE: document non-root and root suite counts');
});

test('SHU251 runtime override trips harness even with committed config gate false', async () => {
  const { verifyKillSwitch } = await import('../verify.mjs');
  await assert.rejects(() => verifyKillSwitch({ enabled: true, configEnabled: false }), error => error.name === 'AssertionError'
    && error.message.includes('SHU251_ZERO_LAUNCH: disabled tick must make zero adapter calls'));
});


test('SHU251 deployed workspace state directory accepted by installer', noSystemd, t => {
  const root = fixture(t), params = fixtureParameters(root);
  assert.equal(serviceParameters({ workdir: root }).workspaceStateDir, WORKSPACE_STATE_DIR);
  assert.equal(params.workspaceStateDir, WORKSPACE_STATE_DIR);
  assert.equal(install(root, params).changed, true);
  const writer = fs.readFileSync(join(root, names[1]), 'utf8');
  assert.ok(writer.includes(`Environment=SHU_WORKSPACE_STATE_DIR=${WORKSPACE_STATE_DIR}\n`));
  assert.ok(writer.includes(`ExecStart="/usr/bin/flock" "--nonblock" "--conflict-exit-code" "2" "${WORKSPACE_STATE_DIR}/host-tick.lock" `));
});
test('SHU251 foreign workspace state directory refused before staging', t => {
  const root = fixture(t), params = { ...fixtureParameters(root), workspaceStateDir: root, writerLock: join(root, 'host-tick.lock') };
  for (const allowWorkspaceStateDirOverride of [undefined, false, 'true']) {
    named(() => install(root, { ...params, allowWorkspaceStateDirOverride }), 'SHU251_WRITER_LOCK: foreign workspace state directory requires allowWorkspaceStateDirOverride=true');
    assert.deepEqual(fs.readdirSync(root), ['.environment']);
    assertFixtureEnvironmentUnchanged(root);
  }
});
test('SHU251 explicit workspace override stages a visible two-writer hazard', noSystemd, t => {
  const root = fixture(t), params = { ...fixtureParameters(root), workspaceStateDir: root, writerLock: join(root, 'host-tick.lock'), allowWorkspaceStateDirOverride: true };
  assert.equal(install(root, params).changed, true);
  const units = Object.fromEntries(names.map(name => [name, fs.readFileSync(join(root, name), 'utf8')]));
  assert.ok(units[names[1]].includes(`Environment=SHU_WORKSPACE_STATE_DIR=${root}\n`));
  assert.ok(units[names[1]].includes(`"${root}/host-tick.lock"`));
  assert.ok(units[names[1]].includes('two-writer hazard'));
  assertPolicy(units, params);
  named(() => assertPolicy(units, { ...params, workspaceStateDir: WORKSPACE_STATE_DIR, allowWorkspaceStateDirOverride: false }), 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
});
test('SHU251 mutation: matching foreign environment and writer lock', t => {
  const params = fixtureParameters(fixture(t)), units = render(params);
  units[names[1]] = units[names[1]].replaceAll(WORKSPACE_STATE_DIR, '/tmp/foreign-state');
  named(() => assertPolicy(units, params), 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
});
test('SHU251 mutation: explicit override warning removed', t => {
  const root = fixture(t), params = { ...fixtureParameters(root), workspaceStateDir: root, writerLock: join(root, 'host-tick.lock'), allowWorkspaceStateDirOverride: true };
  const units = render(params);
  units[names[1]] = units[names[1]].split('\n').slice(1).join('\n');
  named(() => assertPolicy(units, params), 'SHU251_WRITER_LOCK: explicit override must carry the two-writer hazard warning');
});

function assertDeployedWorkspaceState(value) {
  assert.equal(value, '/srv/shu/state/workspaces', 'SHU251_WRITER_LOCK: WORKSPACE_STATE_DIR must equal literal deployed /srv/shu/state/workspaces');
  const contract = fs.readFileSync(new URL('../../../../docs/SHU-63-activation-contract.md', import.meta.url), 'utf8');
  const declarations = [...contract.matchAll(/^export SHU_WORKSPACE_STATE_DIR=([^\s#]+).*$/gm)];
  assert.equal(declarations.length, 1, 'SHU251_WRITER_LOCK: activation contract must declare one workspace state directory');
  assert.equal(value, declarations[0][1], 'SHU251_WRITER_LOCK: WORKSPACE_STATE_DIR must agree with activation contract');
}
test('SHU251 canonical workspace constant matches literal deployment and activation contract', () => {
  assertDeployedWorkspaceState(WORKSPACE_STATE_DIR);
});
test('SHU251 mutation: canonical workspace constant repointed', async t => {
  const root = fixture(t), file = join(root, 'units-mutant.mjs');
  const source = fs.readFileSync(new URL('../units.mjs', import.meta.url), 'utf8');
  const declaration = "export const WORKSPACE_STATE_DIR = '/srv/shu/state/workspaces';";
  assert.ok(source.includes(declaration));
  fs.copyFileSync(new URL('../credential-delivery.mjs', import.meta.url), join(root, 'credential-delivery.mjs'));
  fs.writeFileSync(file, source.replace(declaration, "export const WORKSPACE_STATE_DIR = '/tmp/elsewhere';"));
  const mutant = await import(pathToFileURL(file));
  named(() => assertDeployedWorkspaceState(mutant.WORKSPACE_STATE_DIR), 'SHU251_WRITER_LOCK: WORKSPACE_STATE_DIR must equal literal deployed /srv/shu/state/workspaces');
});
test('SHU251 non-string workspace state directory has named fail-closed refusal', t => {
  const root = fixture(t), params = fixtureParameters(root);
  let coerced = false;
  for (const workspaceStateDir of [null, 42, { toString() { coerced = true; return WORKSPACE_STATE_DIR; } }]) {
    const invalid = { ...params, workspaceStateDir, allowWorkspaceStateDirOverride: true };
    for (const operation of [serviceParameters, render, p => install(root, p)]) {
      named(() => operation(invalid), 'SHU251_WRITER_LOCK: canonical workspace state directory required');
      assert.deepEqual(fs.readdirSync(root), ['.environment']);
      assertFixtureEnvironmentUnchanged(root);
    }
  }
  assert.equal(coerced, false, 'SHU251_WRITER_LOCK: non-string workspace state directory must not be coerced');
});

test('SHU251 configured identity and external secret file survive staging', noSystemd, t => {
  const root = fixture(t);
  const params = serviceParameters({ workdir: root, serviceUser: 'fixture-coordinator', serviceGroup: 'fixture-state', ...fixtureParameters(root) });
  // Syntax-only commands and temporary environment files require no host account.
  Object.assign(params, { supervisor: ['/usr/bin/true'], coordinator: ['/usr/bin/true'] });
  install(root, params);
  const units = Object.fromEntries(names.map(name => [name, fs.readFileSync(join(root, name), 'utf8')]));
  assertPolicy(units, params);
  for (const name of names.filter(name => name.endsWith('.service'))) {
    assert.match(units[name], /^User=fixture-coordinator$/m);
    assert.match(units[name], /^Group=fixture-state$/m);
    assert.deepEqual(units[name].split('\n').filter(line => line.startsWith('EnvironmentFile=')), [`EnvironmentFile=${params[name === names[0] ? 'supervisorEnvironmentFile' : 'coordinatorEnvironmentFile']}`], 'SHU251_SECRET_FILE: exact per-unit environment binding required');
  }
  for (const name of names) assert.doesNotMatch(units[name], /SHU_SUPERVISOR_SECRET\s*=/);
  rollback(root);
});
for (const name of names.filter(name => name.endsWith('.service'))) {
  for (const directive of ['User', 'Group']) {
    test(`SHU251 mutation: ${name} ${directive} removed`, t => {
      const params = fixtureParameters(fixture(t)), units = render(params);
      units[name] = units[name].replace(`${directive}=shu-coordinator\n`, '');
      named(() => assertPolicy(units, params), `SHU251_IDENTITY: ${name} must run with configured ${directive}`);
    });
  }
  test(`SHU251 mutation: ${name} secret file removed or optional`, t => {
    for (const replacement of ['', 'EnvironmentFile=-/etc/shu/supervisor.env']) {
      const params = fixtureParameters(fixture(t)), units = render(params);
      units[name] = units[name].replace(`EnvironmentFile=${params[name === names[0] ? 'supervisorEnvironmentFile' : 'coordinatorEnvironmentFile']}`, replacement);
      named(() => assertPolicy(units, params), 'SHU251_SECRET_FILE: each service must require its own environment file');
    }
  });
}
test('SHU251 mutation: embedded secret in any unit refused', t => {
  for (const name of names) {
    const params = fixtureParameters(fixture(t)), units = render(params);
    units[name] += '\nEnvironment="SHU_SUPERVISOR_SECRET=fixture-only-mutation-secret-value"\n';
    named(() => assertPolicy(units, params), 'SHU251_SECRET_LITERAL: units must not embed supervisor secrets');
  }
});
test('SHU251 unsafe identity and secret file parameters fail before staging', t => {
  const root = fixture(t), params = fixtureParameters(root);
  for (const change of [{ serviceUser: 'root' }, { serviceGroup: 'root' }, { serviceUser: 'bad\nUser=root' }, { serviceUser: 0 }]) {
    named(() => install(root, { ...params, ...change }), 'SHU251_IDENTITY: non-root service user and group names required');
  }
  for (const parameter of ['supervisorEnvironmentFile', 'coordinatorEnvironmentFile']) for (const environmentFile of ['relative', '-/etc/shu/secret', '/etc/../secret', '/etc/secret\nEnvironment=bad', null]) {
    named(() => install(root, { ...params, [parameter]: environmentFile }), 'SHU251_SECRET_FILE: plain absolute environment file path required');
  }
  assert.deepEqual(fs.readdirSync(root), ['.environment']);
  assertFixtureEnvironmentUnchanged(root);
});
