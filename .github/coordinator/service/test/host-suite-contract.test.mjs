import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { CAPABILITIES, PERMITTED_SKIPS, preflight, evaluateSuite, runSuite, hostProbe } from '../host-suite-contract.mjs';
const spec = { service_uid: 1234, service_gid: 1234, checkout: '/temporary-checkout', temp_dir: '/temporary-area' };
const named = code => e => e.code === code;
const report = outcomes => ({ complete: true, exit_code: 0, outcomes });

test('SHU251 contract missing capabilities never become skips', async () => {
  for (const capability of CAPABILITIES)
    await assert.rejects(() => preflight(spec, async name => name !== capability.name), named(capability.code), `CAPABILITY_REQUIRED: missing ${capability.name} must refuse`);
});
test('SHU251 contract probe errors are named preflight refusals', async () => {
  await assert.rejects(() => preflight(spec, async () => { throw Error('missing executable'); }), named('SHU251_PREFLIGHT_PRIVILEGE'));
  await assert.rejects(() => preflight({ ...spec, service_uid: 0 }, async () => true), named('SHU251_PREFLIGHT_SPEC'));
  const result = await preflight(spec, async () => true);
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
  const result = await runSuite({ ...spec, checkout: root, temp_dir: root, files: [file], expected_tests: 2 }, { probe: async () => true });
  assert.deepEqual(result.counts, { tests: 2, pass: 2, fail: 0, skipped: 0 });
});
test('SHU251 contract detects capabilities through injectable command boundaries', async () => {
  const calls = [];
  const probe = hostProbe(spec, { uid: () => 0, fs: { lstatSync: () => ({ uid: 1234 }) }, run(file, args) { calls.push([file, args]); return { status: 0, stdout: args.includes('--reuid=65534') ? '65534\n' : '' }; } });
  for (const { name } of CAPABILITIES) assert.equal(await probe(name), true, name);
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
