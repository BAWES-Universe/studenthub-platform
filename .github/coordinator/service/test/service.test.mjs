import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { render, assertPolicy, verifySyntax, names } from '../units.mjs';
import { install, rollback, snapshot } from '../install.mjs';
import { verify, fixtureParameters, assertQuiet } from '../verify.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu251-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function named(fn, message) {
  assert.throws(fn, error => error.name === 'AssertionError' && error.message.includes(message));
}

test('SHU251 local kill-switch, syntax and rollback harness', async () => {
  assert.equal((await verify()).writes, 0);
});
test('SHU251 parameterised argv and unit syntax', t => {
  const root = fixture(t), params = fixtureParameters(root);
  params.supervisor.push('literal $TOKEN %i "quote" \\ slash');
  const units = render(params);
  assert.match(units[names[0]], /\$\$TOKEN %%i/);
  for (const name of names) fs.writeFileSync(join(root, name), units[name]);
  assertPolicy(units);
  verifySyntax(root);
  named(() => render({ ...params, supervisor: ['relative'] }), 'SHU251_COMMAND');
  named(() => render({ ...params, coordinator: ['relative'] }), 'SHU251_COMMAND');
  named(() => render({ ...params, supervisor: ['/usr/bin/true', 'bad\nRestart=no'] }), 'SHU251_PARAMETER');
});
test('SHU251 staging is idempotent and preserves original backup', t => {
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
test('SHU251 drift requires rollback and symlinks are refused', t => {
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
test('SHU251 invalid executable fails syntax before staging changes', t => {
  const root = fixture(t), params = fixtureParameters(root), before = snapshot(root);
  params.supervisor = [join(root, 'missing-executable')];
  named(() => install(root, params), 'SHU251_SYNTAX');
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('SHU251 common flock excludes overlapping writers and releases after exit', { timeout: 5000 }, async t => {
  const root = fixture(t), lock = join(root, 'host-tick.lock');
  const holder = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '2', lock, process.execPath,
    '-e', "process.stdout.write('ready'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => holder.stdin.end());
  await once(holder.stdout, 'data');
  const rejected = spawnSync('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '2', lock, '/usr/bin/touch', join(root, 'second-writer')]);
  assert.equal(rejected.status, 2, 'SHU251_LOCK: concurrent writer must be refused');
  assert.equal(fs.existsSync(join(root, 'second-writer')), false, 'SHU251_LOCK: concurrent writer must be refused');
  const exited = once(holder, 'exit');
  holder.stdin.end();
  await exited;
  assert.equal(spawnSync('/usr/bin/flock', ['--nonblock', lock, '/usr/bin/true']).status, 0, 'SHU251_LOCK_RELEASE: writer exit must release the lock');
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
  const units = render(fixtureParameters(fixture(t)));
  assert.ok(units[name].includes(before));
  units[name] = units[name].replace(before, after);
  named(() => assertPolicy(units), message);
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


test('SHU251 partial staging failure restores prior state', t => {
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
  assert.deepEqual(fs.readdirSync(root), [names[0]]);
});
