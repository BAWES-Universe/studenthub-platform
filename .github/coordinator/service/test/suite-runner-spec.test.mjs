import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as runner from '../suite-runner-spec.mjs';
import { runSuite } from '../host-suite-contract.mjs';
import { createDisposableSuite, removeDisposableSuite, verifyDisposableSuite, recordDisposableSuite } from '../disposable-suite.mjs';
const spec = { service_uid: 1234, service_gid: 1234, service_groups: [1234], checkout: '/disposable/checkout', temp_dir: '/disposable/tmp', revision: 'a'.repeat(40), tree: 'b'.repeat(40) };
const files = ['.github/coordinator/service/test/a.test.mjs', '.github/coordinator/test/a.test.mjs'];
function boundary(change = {}) {
  const calls = [];
  const io = { identity: () => ({ uid: 1234, gid: 1234, groups: [1234] }),
    run(file, args) {
      calls.push([file, args]);
      let stdout = '';
      if (file === '/usr/bin/systemctl') stdout = change.active ?? 'inactive';
      else if (args.includes('HEAD')) stdout = change.revision ?? spec.revision;
      else if (args.includes('HEAD^{tree}')) stdout = spec.tree;
      else if (args.includes('status')) stdout = change.dirty ?? '';
      else if (args.includes('ls-tree')) stdout = files.join('\n');
      else if (args.includes('show')) stdout = args.at(-1).endsWith(runner.INVENTORY_PATH)
        ? JSON.stringify(change.inventory ?? { version: 'shu251-suite-inventory-v1', files, names: ['one', 'two'], requirements: ['one', 'two'].map(name => ({ name, capabilities: [] })) }) : '1\n';
      return { status: 0, stdout };
    },
    fs: { lstatSync: () => ({ uid: 1234, gid: 1234, mode: 0o40755, isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false }),
      realpathSync: file => file, readFileSync: () => '1\n' },
  };
  return { io, calls };
}
export function controls(api = runner) {
  const { io } = boundary();
  const valid = api.bindSuite(spec, io);
  assert.equal(valid.expected_tests, 2);
  assert.deepEqual(valid.files, files.map(f => `${spec.checkout}/${f}`));
  assert.equal(valid.binding.checkout, spec.checkout);
  assert.equal(valid.binding.revision, spec.revision);
  assert.equal(valid.binding.expected_tests, 2);
  assert.equal(valid.binding.entries.length, 2);
  assert.match(valid.binding.inventory_sha256, /^[a-f0-9]{64}$/);
  for (const field of ['inventory', 'inventory_path', 'inventory_digest', 'names', 'requirements',
    'wrappers', 'wrapper', 'paths', 'command', 'commands', 'argv', 'executable', 'expected_count']) {
    assert.throws(() => api.bindSuite({ ...spec, [field]: [] }, io), { code: 'SHU251_SUITE_CALLER_SELECTION' }, 'SHU251_SUITE_CALLER_SELECTION');
  }
  assert.throws(() => api.bindSuite(spec, { ...io, fs: { ...io.fs, realpathSync: file => file === spec.checkout ? '/replacement' : file } }),
    { code: 'SHU251_SUITE_CHECKOUT_REALPATH' }, 'SHU251_SUITE_CHECKOUT_REALPATH');
  assert.throws(() => api.bindSuite(spec, { ...io, fs: { ...io.fs, readFileSync: () => 'changed despite clean git status\n' } }),
    { code: 'SHU251_SUITE_FILE_DIGEST' }, 'SHU251_SUITE_FILE_DIGEST');
  assert.throws(() => api.suiteIdentity(spec, { ...io, identity: () => ({ uid: 0, gid: 1234, groups: [1234] }) }), { code: 'SHU251_SUITE_IDENTITY' }, 'SHU251_SUITE_IDENTITY');
  assert.throws(() => api.bindSuite(spec, boundary({ revision: 'c'.repeat(40) }).io), { code: 'SHU251_SUITE_REVISION' }, 'SHU251_SUITE_REVISION');
  assert.throws(() => api.bindSuite({ ...spec, expected_tests: 1 }, io), { code: 'SHU251_SUITE_INVENTORY' }, 'SHU251_SUITE_INVENTORY');
  assert.deepEqual(Object.values(api.suiteQuiescence(io)), ['inactive', 'inactive', 'inactive']);
  assert.throws(() => api.suiteQuiescence(boundary({ active: 'active' }).io), { code: 'SHU251_SUITE_QUIESCENCE' }, 'SHU251_SUITE_QUIESCENCE');
  api.suiteNames([{ name: 'one' }, { name: 'two' }], ['two', 'one']);
  assert.throws(() => api.suiteNames([{ name: 'one' }, { name: 'one' }], ['one', 'two']), { code: 'SHU251_SUITE_NAMES' }, 'SHU251_SUITE_NAMES');
}
test('SHU251 suite pinned spec positive and refusal controls', () => controls());
test('SHU251 suite exact file and identity shapes', () => {
  for (const change of [{ service_uid: 999 }, { service_gid: 999 }, { service_groups: [] }])
    assert.throws(() => runner.bindSuite({ ...spec, ...change }, boundary().io), { code: 'SHU251_SUITE_IDENTITY' });
  for (const inventory of [{}, { version: 'shu251-suite-inventory-v1', files: files.slice(1), names: ['one'] },
    { version: 'shu251-suite-inventory-v1', files: [...files, '.github/coordinator/test/extra.test.mjs'], names: ['one'] }])
    assert.throws(() => runner.bindSuite(spec, boundary({ inventory }).io), { code: 'SHU251_SUITE_INVENTORY' });
  assert.throws(() => runner.bindSuite(spec, boundary({ dirty: '?? extra.test.mjs' }).io), { code: 'SHU251_SUITE_REVISION' });
  const { io } = boundary();
  assert.throws(() => runner.bindSuite(spec, { ...io, run(file, args, options) {
    if (args.includes('show') && args.at(-1).endsWith(runner.INVENTORY_PATH)) return { status: 128, stdout: '' };
    return io.run(file, args, options);
  } }), { code: 'SHU251_SUITE_INVENTORY' }, 'missing revision inventory still refuses production binding');
  for (const active of ['activating', 'deactivating', 'failed', 'active\ninactive', ''])
    assert.throws(() => runner.suiteQuiescence(boundary({ active }).io), { code: 'SHU251_SUITE_QUIESCENCE' });
});
test('SHU251 suite binds wrapper bytes and refuses hidden changes and unsupported entries', () => {
  const wrapper = '.github/coordinator/reviewer-sandbox.sh';
  const { io } = boundary();
  const withWrapper = { ...io, run(file, args, options) {
    const result = io.run(file, args, options);
    return args.includes('ls-tree') ? { ...result, stdout: [...files, wrapper].join('\n') } : result;
  } };
  const bound = runner.bindSuite(spec, withWrapper);
  assert.ok(bound.binding.entries.some(entry => entry.file === wrapper));
  for (const fault of ['changed', 'missing', 'symlink', 'directory', 'alias']) {
    const absolute = `${spec.checkout}/${wrapper}`;
    const fakeFs = { ...io.fs,
      readFileSync(file) {
        if (file !== absolute) return io.fs.readFileSync(file);
        if (fault === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return fault === 'changed' ? 'unreviewed wrapper' : '1\n';
      },
      lstatSync(file) {
        const stat = io.fs.lstatSync(file);
        return file === absolute ? { ...stat, isFile: () => fault !== 'directory', isSymbolicLink: () => fault === 'symlink' } : stat;
      },
      realpathSync: file => file === absolute && fault === 'alias' ? '/unreviewed-wrapper' : file,
    };
    assert.throws(() => runner.bindSuite(spec, { ...withWrapper, fs: fakeFs }), { code: 'SHU251_SUITE_FILE_DIGEST' });
  }
});
test('SHU251 suite measures metadata through controlled boundary without probing host policy', () => {
  const { io, calls } = boundary();
  const facts = runner.measureSuite(spec, io);
  assert.deepEqual(facts.identity, { uid: 1234, gid: 1234, groups: [1234] });
  assert.equal(facts.checkout[0].path, spec.checkout);
  assert.equal(facts.temporary[0].mode, 0o755);
  assert.equal(facts.namespace.result, 'NOT_PROBED');
  assert.equal(facts.sudo.result, 'NOT_PROBED');
  assert.equal(Object.keys(facts.kernel).length, 5);
  assert.deepEqual(calls, []);
});
const mutations = [
  ['root runner accepted', 'actual.uid === 0 || actual.uid !== spec.service_uid', 'false', 'SHU251_SUITE_IDENTITY'],
  ['revision ignored', "suiteGit(spec.checkout, ['rev-parse', 'HEAD'], io) !== spec.revision", 'false', 'SHU251_SUITE_REVISION'],
  ['caller count accepted', "Object.hasOwn(spec, 'expected_tests')", 'false', 'SHU251_SUITE_INVENTORY'],
  ['live timer accepted', "result.stdout.trim() !== 'inactive'", 'false', 'SHU251_SUITE_QUIESCENCE'],
  ['duplicate name accepted', "!Array.isArray(names) || sorted(outcomes.map(o => o.name)) !== sorted(names)", 'false', 'SHU251_SUITE_NAMES'],
  ['caller execution selectors accepted', 'Object.keys(spec).some(key => !fields.includes(key))', 'false', 'SHU251_SUITE_CALLER_SELECTION'],
  ['checkout realpath substituted', 'checkout !== spec.checkout', 'false', 'SHU251_SUITE_CHECKOUT_REALPATH'],
  ['checkout bytes substituted', 'digest(io.fs.readFileSync(absolute)) !== expected', 'false', 'SHU251_SUITE_FILE_DIGEST'],
];
for (const [name, from, to, code] of mutations) test(`SHU251 suite mutation ${name}`, async t => {
  controls();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mutant.mjs');
  const source = fs.readFileSync(new URL(code === 'SHU251_SUITE_NAMES' ? '../host-suite-contract.mjs' : '../suite-runner-spec.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(from).length, 2);
  fs.writeFileSync(file, source.replace(from, to).replace("'./host-suite-contract.mjs'", JSON.stringify(new URL('../host-suite-contract.mjs', import.meta.url).href)));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const mutant = await import(pathToFileURL(file));
  assert.throws(() => controls(code === 'SHU251_SUITE_NAMES' ? { ...runner, suiteNames: mutant.suiteNames } : mutant), error => error.code === 'ERR_ASSERTION' && error.message.includes(code));
});

function disposableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-clone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), parent = path.join(root, 'disposables');
  fs.mkdirSync(source); fs.mkdirSync(parent, { mode: 0o755 });
  const git = (...args) => {
    const out = spawnSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
  };
  git('init'); git('config', 'user.name', 'A12 fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), "import test from 'node:test'; test('fixture', () => {});\n");
  }
  fs.writeFileSync(path.join(source, runner.INVENTORY_PATH), JSON.stringify({ version: 'shu251-suite-inventory-v1', files, names: ['one', 'two'], requirements: ['one', 'two'].map(name => ({ name, capabilities: [] })) }));
  git('add', '.'); git('commit', '-m', 'isolated A12 fixture');
  const s = { ...spec, revision: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    disposable_parent: parent, source_checkout: source, activation_id: 'a12-fixture-001',
    checkout: `${parent}/a12-fixture-001/checkout`, temp_dir: `${parent}/a12-fixture-001/tmp` };
  const rootStat = fs.lstatSync(root);
  const io = { ...boundary().io, fs: { ...fs,
    lstatSync(file) {
      // Only fixture descendants use real metadata. Ancestor identities are synthetic.
      const actual = file.startsWith(root + '/') ? fs.lstatSync(file) : rootStat;
      const stat = Object.create(actual); stat.uid = 1234; stat.gid = 1234;
      stat.mode = actual.isDirectory() ? 0o40755 : actual.mode;
      return stat;
    },
  }, run(file, args, options) {
    assert.equal(file, '/usr/bin/git');
    assert.ok(args[1].startsWith(root + '/'), 'only disposable fixture Git commands');
    return spawnSync(file, args, { encoding: 'utf8', ...options });
  } };
  return { s, io, root, evidence: `${parent}/a12-fixture-001.a12.json` };
}
test('SHU251 disposable clone create verify remove preserves durable receipt', async t => {
  const { s, io, evidence } = disposableFixture(t);
  const ready = createDisposableSuite(s, io);
  assert.equal(verifyDisposableSuite(s, io).state, 'ready');
  recordDisposableSuite(s, { counts: { tests: 2, pass: 2 } }, io);
  assert.equal(ready.state, 'ready'); assert.equal(ready.revision, s.revision);
  assert.equal(ready.suite_binding.checkout, s.checkout);
  assert.equal(ready.suite_binding.revision, s.revision);
  assert.equal(fs.readFileSync(path.join(s.checkout, runner.INVENTORY_PATH), 'utf8'), fs.readFileSync(path.join(s.source_checkout, runner.INVENTORY_PATH), 'utf8'));
  assert.throws(() => createDisposableSuite(s, io), { code: 'SHU251_SUITE_DISPOSABLE' });
  const suite = await runSuite(s, {
    contract: async () => ({ ...runner.bindSuite(s, io), quiescence: runner.suiteQuiescence(boundary().io), record: result => recordDisposableSuite(s, result, io) }),
    probe: name => name === 'cvtsudoers' ? { available: true, identity: '/usr/bin/cvtsudoers.ws' } : true,
    run: () => ({ status: 0, stdout: '{"type":"outcome","name":"one","status":"pass"}\n{"type":"outcome","name":"two","status":"pass"}\n{"type":"complete"}' }),
  });
  assert.deepEqual(suite.counts, { tests: 2, pass: 2, fail: 0, skipped: 0 });
  assert.deepEqual(suite.binding, ready.suite_binding);
  const removed = removeDisposableSuite(s, io);
  assert.equal(removed.state, 'removed'); assert.equal(fs.existsSync(path.dirname(s.checkout)), false);
  assert.equal(JSON.parse(fs.readFileSync(evidence, 'utf8')).state, 'removed');
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')).suite, suite);
  assert.equal(removeDisposableSuite(s, io).state, 'removed');
});
test('SHU251 disposable refusal preserves foreign paths and drift', t => {
  const { s, io, evidence } = disposableFixture(t);
  assert.throws(() => createDisposableSuite({ ...s, checkout: s.source_checkout }, io), { code: 'SHU251_SUITE_DISPOSABLE' }, 'SHU251_SUITE_DISPOSABLE');
  createDisposableSuite(s, io);
  const record = JSON.parse(fs.readFileSync(evidence, 'utf8')); record.inode = 'foreign';
  fs.writeFileSync(evidence, JSON.stringify(record));
  assert.throws(() => removeDisposableSuite(s, io), { code: 'SHU251_SUITE_DISPOSABLE' });
  assert.equal(fs.existsSync(s.checkout), true);
});
test('SHU251 disposable clone failure remains removable by durable custody', t => {
  const { s, io, evidence } = disposableFixture(t);
  assert.throws(() => createDisposableSuite(s, { ...io, run: () => ({ status: 1, stdout: '' }) }), { code: 'SHU251_SUITE_REVISION' });
  assert.equal(JSON.parse(fs.readFileSync(evidence, 'utf8')).state, 'creating');
  assert.equal(removeDisposableSuite(s, io).state, 'removed');
});
test('SHU251 disposable mutation accepts foreign checkout', async t => {
  const { s, io, root } = disposableFixture(t);
  const from = 'spec.checkout !== `${spec.disposable_parent}/${spec.activation_id}/checkout`';
  const source = fs.readFileSync(new URL('../disposable-suite.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(from).length, 2);
  const file = path.join(root, 'mutant.mjs');
  fs.writeFileSync(file, source.replace(from, 'false')
    .replace("'./suite-runner-spec.mjs'", JSON.stringify(new URL('../suite-runner-spec.mjs', import.meta.url).href))
    .replace("'./host-suite-contract.mjs'", JSON.stringify(new URL('../host-suite-contract.mjs', import.meta.url).href)));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const mutant = await import(pathToFileURL(file));
  const bad = { ...s, checkout: `${path.dirname(s.checkout)}/foreign` };
  assert.throws(() => createDisposableSuite(bad, io), { code: 'SHU251_SUITE_DISPOSABLE' });
  assert.throws(() => assert.throws(() => mutant.createDisposableSuite(bad, io), { code: 'SHU251_SUITE_DISPOSABLE' }, 'SHU251_SUITE_DISPOSABLE'), error => error.code === 'ERR_ASSERTION' && error.message.includes('SHU251_SUITE_DISPOSABLE'));
});


test('L4_REPOSITORY_BOUNDARY mutation refuses host command before fake execution', () => {
  const source = fs.readFileSync(new URL('./fixture/a12-repository-boundary.mjs', import.meta.url), 'utf8');
  const from = "if (file !== process.execPath && base !== 'git')";
  assert.equal(source.split(from).length, 2);
  const attempt = code => {
    const api = () => new Proxy({}, { get: (target, key) => target[key] ?? (() => ({})) });
    const fakeFs = api(); fakeFs.promises = api();
    const context = { fs: fakeFs, child: api(), net: api(), path, URL,
      process: { execPath: '/fixture/node', env: { L4_REPOSITORY_ROOT: '/repository' } },
      fileURLToPath: () => '/tmp/preload.mjs', syncBuiltinESMExports: () => {} };
    // Parsing the complete transformed module also verifies mutant syntax.
    return runInNewContext(code.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', "'file:///tmp/preload.mjs'") +
      "\nchild.spawnSync('/usr/bin/systemctl', ['start', 'fixture']);", context);
  };
  assert.throws(() => attempt(source), { code: 'L4_REPOSITORY_BOUNDARY' }, 'L4_REPOSITORY_BOUNDARY');
  assert.throws(() => assert.throws(() => attempt(source.replace(from, 'if (false)')), { code: 'L4_REPOSITORY_BOUNDARY' }, 'L4_REPOSITORY_BOUNDARY'),
    error => error.code === 'ERR_ASSERTION' && error.message.includes('L4_REPOSITORY_BOUNDARY'));
});
