import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { CAPABILITIES, PERMITTED_SKIPS, preflight, evaluateSuite, runSuite, hostProbe, resolveCvtsudoers, CVTSUDOERS_CANDIDATES } from '../host-suite-contract.mjs';
const spec = { service_uid: 1234, service_gid: 1234, checkout: '/temporary-checkout', temp_dir: '/temporary-area' };
const available = name => name === 'cvtsudoers' ? { available: true, identity: '/usr/bin/cvtsudoers' } : true;
const named = code => e => e.code === code;
const report = outcomes => ({ complete: true, exit_code: 0, outcomes });

test('SHU251 contract missing capabilities never become skips', async () => {
  for (const capability of CAPABILITIES)
    await assert.rejects(() => preflight(spec, async name => name !== capability.name && available(name)), named(capability.code), `CAPABILITY_REQUIRED: missing ${capability.name} must refuse`);
});
test('SHU251 contract probe errors are named preflight refusals', async () => {
  await assert.rejects(() => preflight(spec, async () => { throw Error('missing executable'); }), named('SHU251_PREFLIGHT_PRIVILEGE'));
  await assert.rejects(() => preflight({ ...spec, service_uid: 0 }, async name => available(name)), named('SHU251_PREFLIGHT_SPEC'));
  const result = await preflight(spec, async name => available(name));
  assert.equal(Object.keys(result.capabilities).length, CAPABILITIES.length);
});
test('SHU251 contract publishes eight exact sanctioned skips', () => {
  assert.equal(Object.keys(PERMITTED_SKIPS).length, 8);
  const outcomes = Object.entries(PERMITTED_SKIPS).map(([name, reason]) => ({ name, reason, status: 'skip' }));
  assert.deepEqual(evaluateSuite(report(outcomes), 8).counts, { tests: 8, pass: 0, fail: 0, skipped: 8 });
});
test('SHU251 contract refuses outcomes outside the exact permitted set', () => {
  assert.throws(() => evaluateSuite(report([{ name: 'undocumented', status: 'skip', reason: 'missing binary' }]), 1), named('SHU251_SUITE_UNPERMITTED_SKIP'), 'SKIP_SET_REQUIRED: undocumented skip must refuse');
  const name = Object.keys(PERMITTED_SKIPS)[0];
  assert.throws(() => evaluateSuite(report([{ name, status: 'skip', reason: 'different capability' }]), 1), named('SHU251_SUITE_UNPERMITTED_SKIP'));
  assert.throws(() => evaluateSuite(report([{ name, status: 'fail' }]), 1), named('SHU251_SUITE_FAILURE'));
  assert.throws(() => evaluateSuite(report([{ name, status: 'todo' }]), 1), named('SHU251_SUITE_OUTCOME'));
});
test('SHU251 contract rejects incomplete suite and nonzero exit', () => {
  assert.throws(() => evaluateSuite(report([]), 1), named('SHU251_SUITE_INCOMPLETE'));
  assert.throws(() => evaluateSuite({ ...report([{ name: 'a', status: 'pass' }]), complete: false }, 1), named('SHU251_SUITE_INCOMPLETE'));
  assert.throws(() => evaluateSuite({ ...report([{ name: 'a', status: 'pass' }]), exit_code: 1 }, 1), named('SHU251_SUITE_EXIT'));
});
test('SHU251 contract preflight failure prevents suite execution', async () => {
  let ran = false;
  await assert.rejects(() => runSuite(spec, { probe: async () => false, run() { ran = true; } }), named('SHU251_PREFLIGHT_PRIVILEGE'));
  assert.equal(ran, false);
});
test('SHU251 contract structured reporter runs only temp fixture tests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-suite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.test.mjs');
  fs.writeFileSync(file, "import test from 'node:test'; test('fixture one',()=>{}); test('fixture two',()=>{});\n");
  const result = await runSuite({ ...spec, checkout: root, temp_dir: root, files: [file], expected_tests: 2 }, { probe: async name => available(name) });
  assert.deepEqual(result.counts, { tests: 2, pass: 2, fail: 0, skipped: 0 });
});
test('SHU251 contract detects capabilities through injectable command boundaries', async () => {
  const calls = [];
  const probe = hostProbe(spec, { uid: () => 0, fs: { lstatSync: () => ({ uid: 1234 }) }, run(file, args) { calls.push([file, args]); return { status: 0, stdout: args.includes('--reuid=65534') ? '65534\n' : JSON.stringify(available('cvtsudoers')) }; } });
  for (const { name } of CAPABILITIES) assert.deepEqual(await probe(name), available(name), name);
  assert.ok(calls.some(([, args]) => args.includes('/usr/bin/unshare') && args.includes('--map-root-user')));
  assert.ok(calls.some(([, args]) => args.some(a => a.includes('cvtsudoers'))));
  assert.ok(calls.every(([file]) => ['/usr/bin/setpriv'].includes(file)));
});

// This is a conservative source guard, not a JavaScript parser. Support the
// current single-line literal / condition && literal / condition ? literal :
// false forms. Any other property expression requires review, never omission.
function sourceSkipReasons(source, file) {
  return [...source.matchAll(/(?:\bskip|['"]skip['"])\s*:/g)].map(property => {
    const tail = source.slice(property.index + property[0].length);
    const match = /^\s*(?:([^;\n{}]*?)\s*(&&|\?)\s*)?('(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*")\s*(:\s*false\s*)?(?=[,}])/.exec(tail);
    assert.ok(match && (match[2] === '?' ? !!match[4] : !match[4]), `${file}: unsupported skip expression; extend source guard explicitly`);
    if (match[1]) assert.match(match[1].replaceAll("'1'", '1').replaceAll('?.', '.'), /^[A-Za-z0-9_.$!&|=><() \t]+$/, `${file}: unsupported skip expression condition`);
    // Only the lexically bounded string literal is evaluated, never its condition.
    return { reason: runInNewContext(match[3]), condition: match[1]?.trim() };
  });
}
test('SHU251 contract source skip reasons remain covered or explicitly prohibited', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const permitted = new Set(Object.values(PERMITTED_SKIPS));
  const prohibited = 'SHU251_NO_SYSTEMD: systemd interaction prohibited in this window';
  const observed = new Set();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.test.mjs')) {
        for (const { reason, condition } of sourceSkipReasons(fs.readFileSync(file, 'utf8'), file)) {
          if (reason === prohibited) {
            assert.equal(condition, "process.env.SHU251_NO_SYSTEMD === '1'", file);
            assert.equal(permitted.has(reason), false, 'systemd prohibition must not become an A12 waiver');
            assert.throws(() => evaluateSuite(report([{ name: 'systemd prohibited', status: 'skip', reason }]), 1), named('SHU251_SUITE_UNPERMITTED_SKIP'));
          } else {
            assert.ok(permitted.has(reason), `${file}: undocumented skip reason: ${reason}`);
            observed.add(reason);
          }
        }
      }
    }
  }
  visit(root);
  assert.ok(observed.size > 0, 'source scan must discover sanctioned skip reasons');
});
test('SHU251 contract source skip guard fails closed on unsupported expressions', () => {
  const property = 'skip' + ': ';
  for (const expression of ["'literal'", "!canSwitch && 'literal'", "nonRoot ? 'literal' : false"])
    assert.equal(sourceSkipReasons(`{ ${property}${expression} }`, 'sample')[0].reason, 'literal');
  for (const expression of ['reasonVariable', 'true', "condition ? 'literal' : otherReason", "condition &&\ncomputedReason", "condition ? 'first' : other && 'second'", "condition && 'first' && 'second'"])
    assert.throws(() => sourceSkipReasons(`{ ${property}${expression} }`, 'sample'), /unsupported skip expression/);
  assert.equal(sourceSkipReasons(`{ ${property}'changed reason' }`, 'sample')[0].reason, 'changed reason');
});

const validConversion = JSON.stringify({ User_Specs: [{ Users: [{ username: 'root' }], Cmnd_Specs: [{ Commands: [{ command: 'ALL' }] }] }] });
// Virtual filesystem and process boundary: no real system paths are read/written.
function parserIO(entries = {}, options = {}) {
  const calls = [], looked = [], closed = [], removed = [];
  let executed = false;
  const stat = entry => ({ dev: 1n, ino: BigInt(entry.ino ?? 2), mode: BigInt(entry.mode ?? 0o100755), size: 42n,
    mtimeNs: executed && options.changed ? 2n : 1n, ctimeNs: 1n, isFile: () => !entry.nonregular });
  const io = {
    fs: {
      constants: fs.constants,
      lstatSync(file) { looked.push(file); if (!entries[file]) throw Object.assign(Error('absent'), { code: 'ENOENT' }); return stat(entries[file]); },
      realpathSync: file => entries[file].target ?? file,
      accessSync(file) { if (entries[file].denied) throw Error('denied'); },
      openSync(file, flags) { assert.ok(flags & fs.constants.O_NOFOLLOW); io.opened = file; return 17; },
      fstatSync: () => stat(options.openChanged ? { ino: 3 } : entries[io.opened]),
      mkdtempSync: () => '/virtual/fixture',
      writeFileSync(file, data) { assert.equal(data, 'root ALL=(ALL) ALL\n'); },
      closeSync: fd => closed.push(fd), rmSync: dir => removed.push(dir),
    },
    run(file, args, opts) {
      calls.push([file, args, opts]); executed = true;
      if (options.drift) entries[sudoRs] = {};
      assert.equal(file, '/proc/self/fd/3', 'PINNED_EXECUTION: execute only the inherited descriptor');
      assert.equal(JSON.stringify(opts.stdio), JSON.stringify(['ignore', 'pipe', 'pipe', 17]));
      return options.result ?? { status: 0, stdout: validConversion };
    },
  };
  return { io, calls, looked, closed, removed };
}
const conventional = '/usr/bin/cvtsudoers', sudoRs = '/usr/bin/cvtsudoers.ws';
for (const [label, candidate] of [['conventional', conventional], ['sudo-rs', sudoRs]]) {
  test(`SHU251 parser ${label} identity`, async () => {
    const { io, calls, closed, removed } = parserIO({ [candidate]: {} });
    let result;
    assert.doesNotThrow(() => { result = resolveCvtsudoers('/virtual', io); }, `${label.toUpperCase()}_ACCEPTED`);
    assert.deepEqual(result, { available: true, identity: candidate }, `${label.toUpperCase()}_IDENTITY`);
    const receipt = await preflight(spec, async name => name === 'cvtsudoers' ? result : true);
    assert.deepEqual(receipt.capabilities.cvtsudoers, result, 'RECEIPT_IDENTITY');
    const suite = await runSuite({ ...spec, files: [spec.checkout + '/example.test.mjs'], expected_tests: 1 }, {
      probe: async name => name === 'cvtsudoers' ? result : true,
      run: () => ({ status: 0, stdout: '{"type":"outcome","name":"example","status":"pass"}\n{"type":"complete"}' }),
    });
    assert.deepEqual(suite.preflight.capabilities.cvtsudoers, result, 'SUITE_RECEIPT_IDENTITY');
    assert.equal(calls.length, 1); assert.deepEqual(closed, [17]); assert.deepEqual(removed, ['/virtual/fixture']);
  });
}
const refusalCases = [
  ['absent', {}, {}, '', 'ABSENT_REFUSED'],
  ['nonzero', { [conventional]: {} }, { result: { status: 1, stdout: validConversion } }, '', 'NONZERO_REFUSED'],
  ['invalid JSON', { [conventional]: {} }, { result: { status: 0, stdout: 'invalid' } }, '_OUTPUT', 'JSON_REFUSED'],
  ['empty output', { [conventional]: {} }, { result: { status: 0, stdout: '' } }, '_OUTPUT', 'EMPTY_REFUSED'],
  ['missing shape', { [conventional]: {} }, { result: { status: 0, stdout: '{}' } }, '_OUTPUT', 'SHAPE_REFUSED'],
  ['PATH substitution', { cvtsudoers: {}, '/hostile/cvtsudoers': {} }, {}, '', 'PATH_REFUSED'],
  ['unapproved path', { '/unapproved/parser': {} }, {}, '', 'UNAPPROVED_REFUSED'],
  ['ambiguous providers', { [conventional]: {}, [sudoRs]: {} }, {}, '_AMBIGUOUS', 'AMBIGUITY_REFUSED'],
  ['provider appears during execution', { [conventional]: {} }, { drift: true }, '_AMBIGUOUS', 'PROVIDER_DRIFT_REFUSED'],
  ['symlink', { [conventional]: { target: '/unapproved/parser' } }, {}, '_SUBSTITUTION', 'SYMLINK_REFUSED'],
  ['nonregular', { [conventional]: { nonregular: true } }, {}, '_SUBSTITUTION', 'REGULAR_REQUIRED'],
  ['nonexecutable', { [conventional]: { mode: 0o100644 } }, {}, '_SUBSTITUTION', 'EXECUTABLE_REQUIRED'],
  ['access denied', { [conventional]: { denied: true } }, {}, '_SUBSTITUTION', 'ACCESS_REQUIRED'],
  ['changed on open', { [conventional]: {} }, { openChanged: true }, '_SUBSTITUTION', 'OPEN_IDENTITY_REQUIRED'],
  ['changed during execution', { [conventional]: {} }, { changed: true }, '_SUBSTITUTION', 'STABLE_IDENTITY_REQUIRED'],
];
for (const [label, entries, options, suffix, message] of refusalCases) test(`SHU251 parser ${label}`, async () => {
  const { io, calls, looked } = parserIO(structuredClone(entries), options);
  const oldPath = process.env.PATH;
  process.env.PATH = '/hostile';
  try {
    assert.throws(() => resolveCvtsudoers('/virtual', io), named(`SHU251_PREFLIGHT_CVTSUDOERS${suffix}`), message);
    await assert.rejects(() => preflight(spec, async name => name === 'cvtsudoers' ? resolveCvtsudoers('/virtual', parserIO(structuredClone(entries), options).io) : true), named(`SHU251_PREFLIGHT_CVTSUDOERS${suffix}`), message);
    assert.ok(looked.every(file => CVTSUDOERS_CANDIDATES.includes(file)), 'ONLY_APPROVED_PATHS');
    if (['PATH substitution', 'unapproved path', 'ambiguous providers', 'absent'].includes(label)) assert.equal(calls.length, 0);
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});
test('SHU251 parser service child carries only resolved identity', async () => {
  const { io } = parserIO({ [sudoRs]: {} });
  const probe = hostProbe(spec, { uid: () => spec.service_uid, run(file, args) {
    assert.equal(file, process.execPath);
    const source = args.at(-1).replace("import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';", '');
    let stdout;
    runInNewContext(source, { fs: io.fs, path, spawnSync: io.run, process: {}, console: { log: s => { stdout = s; } } });
    return { status: 0, stdout };
  } });
  assert.deepEqual(await probe('cvtsudoers'), { available: true, identity: sudoRs });
});

const parserMutations = [
  ['conventional identity lost', 'conventional identity', 'identity: candidate', "identity: '/usr/bin/cvtsudoers.ws'", 'CONVENTIONAL_IDENTITY'],
  ['sudo-rs identity lost', 'sudo-rs identity', 'identity: candidate', "identity: '/usr/bin/cvtsudoers'", 'SUDO-RS_IDENTITY'],
  ['absence accepted', 'absent', "if (present.length === 0) fail('');", "if (present.length === 0) return {available:true,identity:'/usr/bin/cvtsudoers'};", 'ABSENT_REFUSED'],
  ['nonzero accepted', 'nonzero', "if (!successful(result)) fail('');", 'if (false) fail(\'\');', 'NONZERO_REFUSED'],
  ['invalid JSON accepted', 'invalid JSON', "catch { fail('_OUTPUT'); }", "catch { return {available:true,identity:candidate}; }", 'JSON_REFUSED'],
  ['PATH search enabled', 'PATH substitution', 'for (const candidate of CVTSUDOERS_CANDIDATES)', "for (const candidate of [...CVTSUDOERS_CANDIDATES, ...process.env.PATH.split(':').map(dir => path.join(dir, 'cvtsudoers'))])", 'PATH_REFUSED'],
  ['unapproved path admitted', 'unapproved path', 'for (const candidate of CVTSUDOERS_CANDIDATES)', "for (const candidate of [...CVTSUDOERS_CANDIDATES, '/unapproved/parser'])", 'UNAPPROVED_REFUSED'],
  ['dual provider selection', 'ambiguous providers', "if (present.length > 1) fail('_AMBIGUOUS');", "if (present.length > 1) return {available:true,identity:present[0].candidate};", 'AMBIGUITY_REFUSED'],
  ['provider drift unchecked', 'provider appears during execution', 'CVTSUDOERS_CANDIDATES.filter(p => p !== candidate)', '[]', 'PROVIDER_DRIFT_REFUSED'],
  ['pinned execution removed', 'conventional identity', "io.run('/proc/self/fd/3',", 'io.run(candidate,', 'CONVENTIONAL_ACCEPTED'],
  ['old hardcoded path restored', 'sudo-rs identity', 'for (const candidate of CVTSUDOERS_CANDIDATES)', "for (const candidate of ['/usr/bin/cvtsudoers'])", 'SUDO-RS_ACCEPTED'],
  ['shape validation removed', 'missing shape', 'if (!validShape)', 'if (false)', 'SHAPE_REFUSED'],
  ['symlink accepted', 'symlink', 'io.fs.realpathSync(candidate) !== candidate', 'false', 'SYMLINK_REFUSED'],
  ['nonregular accepted', 'nonregular', '!stat.isFile()', 'false', 'REGULAR_REQUIRED'],
  ['nonexecutable accepted', 'nonexecutable', '!(Number(stat.mode) & 0o111)', 'false', 'EXECUTABLE_REQUIRED'],
  ['access check removed', 'access denied', 'io.fs.accessSync(candidate, io.fs.constants.X_OK);', '', 'ACCESS_REQUIRED'],
  ['opened inode unchecked', 'changed on open', "if (identity(io.fs.fstatSync(fd, { bigint: true })) !== identity(stat)) fail('_SUBSTITUTION');\n    dir", "if (false) fail('_SUBSTITUTION');\n    dir", 'OPEN_IDENTITY_REQUIRED'],
  ['post execution identity unchecked', 'changed during execution', "    verify(); // Recheck the approved pathname and inode metadata after execution.", '', 'STABLE_IDENTITY_REQUIRED'],
  ['receipt identity dropped', 'sudo-rs identity', "capability.name === 'cvtsudoers' ? resolved : 'available'", "'available'", 'RECEIPT_IDENTITY'],
];
for (const [name, controlName, from, to, message] of parserMutations) test(`SHU251 parser mutation: ${name}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  const target = path.join(root, 'host-suite-contract.mjs');
  fs.copyFileSync(new URL('../host-suite-contract.mjs', import.meta.url), target);
  fs.copyFileSync(new URL('./host-suite-contract.test.mjs', import.meta.url), path.join(root, 'test/host-suite-contract.test.mjs'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^SHU251 parser ${controlName}$`, path.join(root, 'test/host-suite-contract.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  const control = run();
  assert.equal(control.status, 0, control.stdout + control.stderr);
  assert.match(control.stdout, /^# pass 1$/m); assert.match(control.stdout, /^# fail 0$/m);
  const source = fs.readFileSync(target, 'utf8');
  assert.equal(source.split(from).length, 2, 'exactly one unique textual replacement');
  fs.writeFileSync(target, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', target]).status, 0, 'syntax clean mutant');
  const mutant = run(), output = mutant.stdout + mutant.stderr;
  assert.equal(mutant.status, 1, output);
  assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/);
  assert.match(output, /name: 'AssertionError'/); assert.match(output, /code: 'ERR_ASSERTION'/);
  assert.match(output, /failureType: 'testCodeFailure'/); assert.match(output, /^# fail 1$/m);
  assert.ok(output.includes(message), output);
  const error = output.match(/^  error: ([\s\S]*?)\n  code: 'ERR_ASSERTION'/m)?.[1].trim();
  t.diagnostic(`${name}: AssertionError: ${error}`);
});
