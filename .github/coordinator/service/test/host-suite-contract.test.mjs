import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
test('SHU251 contract publishes seven exact legacy skips', () => {
  assert.equal(Object.keys(PERMITTED_SKIPS).length, 7);
  const outcomes = Object.entries(PERMITTED_SKIPS).map(([name, reason]) => ({ name, reason, status: 'skip' }));
  assert.deepEqual(evaluateSuite(report(outcomes), 7).counts, { tests: 7, pass: 0, fail: 0, skipped: 7 });
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
