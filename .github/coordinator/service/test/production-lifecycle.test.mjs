import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { productionFixture } from './production-fixture.mjs';
import { createProductionLifecycle } from '../production-lifecycle.mjs';
import { FILES } from '../host-lifecycle.mjs';
import { main, defaultIO } from '../phase-a-driver.mjs';
const named = code => e => e.code === code;
const absent = { kind: 'absent' };
const data = { kind: 'file', data: Buffer.from('bytes').toString('base64'), uid: 0, gid: 0, mode: 0o644 };

test('PROVIDER complete real provider recorded-boundary lifecycle', async t => {
  const f = productionFixture(t), prior = f.provider.snapshot();
  assert.equal((await f.run('preflight')).evidence.after.writer_lock, undefined);
  await f.run('pin'); await f.run('pin-retain'); await f.run('install'); await f.run('start'); await f.run('readiness'); await f.run('restart');
  await f.run('host-rollback'); await f.run('pin-restore');
  assert.deepEqual(f.provider.snapshot(), prior);
  assert.ok(f.events.some(e => e[0] === 'fsync' && e[2] === 'file'));
  assert.ok(f.events.some(e => e[0] === 'fsync' && e[2] === 'directory'));
  assert.ok(f.commands.some(c => c.file === '/usr/bin/git' && c.args.includes('update-ref')));
});

const cases = [
  ['SHU251_PREFLIGHT_PRIVILEGE', f => () => createProductionLifecycle(f.spec, { ...f.boundary, uid: () => 1001 })],
  ['SHU251_PROVIDER_SCOPE', f => { const s = structuredClone(f.spec); s.lifecycle.evidence_dir += '/elsewhere'; return () => createProductionLifecycle(s, f.boundary); }],
  ['SHU251_PROVIDER_PATH', f => { fs.chmodSync(f.resolve('/etc/systemd/system'), 0o777); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_SUBSTITUTION', f => { const original = f.boundary.fs.fstatSync; f.boundary.fs.fstatSync = fd => ({ ...original(fd), ino: -1 }); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_SYMLINK', f => { fs.symlinkSync('/unreviewed', f.resolve(`/etc/systemd/system/${FILES[0]}`)); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_FILE', f => { f.write(`/etc/systemd/system/${FILES[0]}`, 'bytes'); fs.linkSync(f.resolve(`/etc/systemd/system/${FILES[0]}`), f.resolve('/etc/systemd/system/alias')); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_STORAGE', f => () => f.provider.withLock(() => f.provider.save({ binding: { activation_id: 'other' } }))],
  ['SHU251_PROVIDER_CUSTODY', f => () => f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } })],
  ['SHU251_PROVIDER_ALLOWLIST', f => () => f.provider.withLock(() => f.provider.place('other.service', absent, data))],
  ['SHU251_PROVIDER_COMPARE', f => () => f.provider.withLock(() => f.provider.place(FILES[0], data, data))],
  ['SHU251_PROVIDER_ARGV', f => () => f.provider.withLock(() => f.provider.systemd('start', 'other.service'))],
  ['SHU251_PROVIDER_PIN', f => () => f.provider.withLock(() => f.provider.pin('refs/heads/main', 'b'.repeat(40), 'a'.repeat(40)))],
  ['SHU251_PROVIDER_COMMAND', f => { f.faults.command = (file,args) => file === '/usr/bin/systemctl' && args[0] === 'daemon-reload' ? { status: 1, stdout: '' } : null; return () => f.provider.withLock(() => f.provider.systemd('daemon-reload', null)); }],
  ['SHU251_PROVIDER_READINESS', f => { f.faults.command = file => file === '/usr/bin/ss' ? { status: 0, stdout: '' } : null; return () => f.provider.readiness(); }],
];
for (const [code, change] of cases) test(`PROVIDER guard ${code}`, async t => {
  const control = productionFixture(t);
  await control.run('install'); await control.run('start'); await control.run('pin'); await control.run('host-rollback'); await control.run('pin-restore');
  const f = productionFixture(t);
  if (code === 'SHU251_PROVIDER_READINESS') { await f.run('install'); await f.run('start'); }
  const action = change(f);
  await assert.rejects(async () => action(), named(code), `${code}_REQUIRED`);
});

test('PROVIDER durability order and failures never acknowledge success', async t => {
  const f = productionFixture(t);
  await f.provider.withLock(() => {
    f.events.length = 0;
    f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } });
    const events = f.events.filter(e => ['write', 'fsync', 'rename'].includes(e[0]));
    assert.deepEqual(events.map(e => e[0]), ['write', 'fsync', 'rename', 'fsync'], 'PROVIDER_DURABILITY_REQUIRED');
    assert.equal(events[1][2], 'file'); assert.equal(events[3][2], 'directory');
    f.faults.fsync = true;
    assert.throws(() => f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } }));
  });
});
test('PROVIDER lock contention outside custody and release after exceptions', async t => {
  const f = productionFixture(t);
  f.faults.command = file => file === '/usr/bin/flock' ? { status: 1 } : null;
  await assert.rejects(() => f.provider.withLock(() => assert.fail('must not enter')), named('SHU251_WRITER_LOCK'), 'PROVIDER_LOCK_REQUIRED');
  f.faults.command = null;
  await assert.rejects(() => f.provider.withLock(async () => { await assert.rejects(() => f.provider.withLock(() => {}), named('SHU251_WRITER_LOCK')); throw Error('body'); }));
  await f.provider.withLock(() => f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } }));
});
test('PROVIDER default entrypoint wiring and no implementation option', async t => {
  const f = productionFixture(t), specFile = path.join(f.root, 'driver.json'); fs.writeFileSync(specFile, JSON.stringify(f.spec));
  const oldRead = defaultIO.read, oldFactory = defaultIO.lifecycleProvider;
  // Substitute only at the in-process default boundary; CLI has no IO argument.
  defaultIO.read = () => Buffer.from(JSON.stringify(f.spec.window));
  let called = 0; defaultIO.lifecycleProvider = async spec => { called++; assert.deepEqual(spec, f.spec); return f.provider; };
  try {
    const [outcome] = await Promise.allSettled([main(['preflight', specFile, '--execute'])]);
    assert.equal(outcome.status, 'fulfilled', 'PROVIDER_ENTRYPOINT_REQUIRED');
    const result = outcome.value;
    assert.equal(result.step, 'preflight'); assert.equal(called, 1, 'PROVIDER_ENTRYPOINT_REQUIRED');
    await assert.rejects(() => main(['preflight', specFile, '--provider', '/attacker.mjs']), named('SHU251_DRIVER_USAGE'), 'PROVIDER_NO_OVERRIDE_REQUIRED');
  } finally { defaultIO.read = oldRead; defaultIO.lifecycleProvider = oldFactory; }
  const oldPin = defaultIO.pin; let checked = 0;
  defaultIO.pin = async s => { assert.deepEqual(s, f.spec); checked++; };
  try {
    const provider = await oldFactory(f.spec, f.boundary);
    assert.equal(checked, 1, 'PROVIDER_CHECKOUT_REQUIRED');
    assert.equal(typeof provider?.probe, 'function', 'PROVIDER_FACTORY_REQUIRED');
    assert.equal((await provider.probe()).checkout.sha, f.spec.window.approved_sha, 'PROVIDER_FACTORY_REQUIRED');
  } finally { defaultIO.pin = oldPin; }
});

const mutations = cases.map(([code]) => ({ name: code, pattern: `PROVIDER guard ${code}`, from: 'if (!condition) refuse(code);', to: `if (!condition && code !== '${code}') refuse(code);`, assertion: `${code}_REQUIRED` }));
mutations.push(
  { name: 'default entrypoint', module: 'phase-a-driver', pattern: 'PROVIDER default entrypoint', from: 'const lifecycleIO = io === defaultIO ?', to: 'const lifecycleIO = false ?', assertion: 'PROVIDER_ENTRYPOINT_REQUIRED' },
  { name: 'production factory', module: 'phase-a-driver', pattern: 'PROVIDER default entrypoint', from: 'return createProductionLifecycle(spec, boundary);', to: 'return {};', assertion: 'PROVIDER_FACTORY_REQUIRED' },
  { name: 'reviewed checkout', module: 'phase-a-driver', pattern: 'PROVIDER default entrypoint', from: 'await defaultIO.pin(spec);', to: 'void spec;', assertion: 'PROVIDER_CHECKOUT_REQUIRED' },
  { name: 'file fsync', pattern: 'PROVIDER durability order', from: 'f.fsyncSync(handle);', to: 'void handle;', assertion: 'PROVIDER_DURABILITY_REQUIRED' },
  { name: 'directory fsync', pattern: 'PROVIDER durability order', from: 'f.renameSync(temp, `${root}/${name}`); f.fsyncSync(fd);', to: 'f.renameSync(temp, `${root}/${name}`);', assertion: 'PROVIDER_DURABILITY_REQUIRED' },
  { name: 'kernel lock', pattern: 'PROVIDER lock contention', from: "guard('SHU251_WRITER_LOCK', !r.error && r.status === 0);", to: 'void r;', assertion: 'PROVIDER_LOCK_REQUIRED' },
);
for (const mutation of mutations) test(`PROVIDER named mutation ${mutation.name}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mutation-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  for (const n of ['phase-a-driver', 'host-lifecycle', 'host-suite-contract', 'production-lifecycle']) fs.copyFileSync(new URL(`../${n}.mjs`, import.meta.url), path.join(root, `${n}.mjs`));
  for (const n of ['production-lifecycle.test', 'production-fixture', 'lifecycle-fixture']) fs.copyFileSync(new URL(`./${n}.mjs`, import.meta.url), path.join(root, `test/${n}.mjs`));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^${mutation.pattern}`, path.join(root, 'test/production-lifecycle.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  const control = run(); assert.equal(control.status, 0, control.stdout + control.stderr); assert.match(control.stdout, /^# pass 1$/m);
  const file = path.join(root, `${mutation.module ?? 'production-lifecycle'}.mjs`), source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(mutation.from).length, 2); fs.writeFileSync(file, source.replace(mutation.from, mutation.to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const result = run(), output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output); assert.match(output, /^# fail 1$/m);
  assert.match(output, /code: 'ERR_ASSERTION'/); assert.ok(output.includes(mutation.assertion), output);
  assert.doesNotMatch(output, /TypeError|SyntaxError|ERR_MODULE_NOT_FOUND/);
});


test('PROVIDER placements restore exact bytes mode absence and masking links', async t => {
  const f = productionFixture(t), name = FILES[0];
  const binary = { ...data, mode: 0o640, data: Buffer.from([0xff, 0xfe, 0, 1]).toString('base64') };
  const mask = { kind: 'symlink', target: '/dev/null', uid: 0, gid: 0 };
  await f.provider.withLock(() => {
    for (const [before, after] of [[absent, binary], [binary, data], [data, mask], [mask, data], [data, absent]]) {
      assert.equal(f.provider.place(name, before, after), true);
      assert.deepEqual(f.provider.snapshot().files[name], after);
    }
  });
});
test('PROVIDER substituted destination and symlink ancestor cannot redirect placement', async t => {
  for (const fault of ['ancestor', 'destination']) {
    const f = productionFixture(t), name = FILES[0];
    if (fault === 'ancestor') {
      fs.renameSync(f.resolve('/etc/systemd/system'), f.resolve('/etc/systemd/original'));
      fs.symlinkSync('original', f.resolve('/etc/systemd/system'));
      await assert.rejects(() => f.provider.withLock(() => f.provider.place(name, absent, data)), named('SHU251_PROVIDER_PATH'));
      assert.equal(fs.existsSync(f.resolve(`/etc/systemd/original/${name}`)), false);
    } else {
      const write = f.boundary.fs.writeFileSync;
      f.boundary.fs.writeFileSync = (...args) => { write(...args); f.write(`/etc/systemd/system/${name}`, 'substituted'); };
      await assert.rejects(() => f.provider.withLock(() => f.provider.place(name, absent, data)), named('SHU251_PROVIDER_SUBSTITUTION'));
      assert.equal(fs.readFileSync(f.resolve(`/etc/systemd/system/${name}`), 'utf8'), 'substituted');
    }
  }
});
test('PROVIDER observations reject listener identity runtime gate and oneshot drift', async t => {
  for (const fault of ['uid', 'gate', 'oneshot', 'invocation']) {
    const f = productionFixture(t); await f.run('install'); await f.run('start');
    if (fault === 'uid') f.write('/proc/123/status', 'Uid: 0 0 0 0\nGid: 1001 1001 1001 1001\nGroups: 1001 1002\n');
    if (fault === 'gate') f.write('/proc/123/environ', 'ENABLE_DISPATCH=true\0');
    if (fault === 'oneshot' || fault === 'invocation') f.faults.command = (file,args) => args.includes(fault === 'oneshot' ? '--property=ExecMainExitTimestampMonotonic' : '--property=InvocationID') ? { status: 0, stdout: '0' } : null;
    await assert.rejects(() => f.run('readiness'), named(fault === 'invocation' ? 'SHU251_LIFECYCLE_READINESS' : 'SHU251_PROVIDER_READINESS'));
  }
});
