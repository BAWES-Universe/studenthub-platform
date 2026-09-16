import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as contract from '../host-suite-contract.mjs';

const sourceURL = new URL('../host-suite-contract.mjs', import.meta.url);
const spec = { service_uid: 999, service_gid: 982, checkout: '/fixture', temp_dir: '/fixture/tmp' };
const [name, reason] = Object.entries(contract.PERMITTED_SKIPS)[0];
async function reporterControl(api, reporterFile, root) {
  const file = path.join(root, 'fixture.mjs');
  const entries = Object.entries(contract.PERMITTED_SKIPS).slice(0, 3);
  fs.writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict';
const entries = ${JSON.stringify(entries)};
test(entries[0][0], t => { t.skip(entries[0][1]); assert.fail('genuine failure after skip'); });
test(entries[1][0], async t => { t.skip(entries[1][1]); throw Error('async failure after skip'); });
test(entries[2][0], { ['skip']: entries[2][1] }, () => { assert.fail('option skip body must not run'); });
`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporterFile}`, file], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); // Node exit status cannot catch this defect.
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const outcomes = events.filter(e => e.type === 'outcome');
  assert.deepEqual(outcomes.map(o => o.status), ['fail', 'fail', 'skip'], 'REPORTER_FAILURE_PRECEDENCE');
  assert.deepEqual(outcomes.map(o => [o.name, o.reason]), entries);
  assert.equal(events.at(-1).type, 'complete');
  for (const outcome of outcomes.slice(0, 2))
    assert.throws(() => api.evaluateSuite({ outcomes: [outcome], complete: true, exit_code: result.status }, 1), { code: 'SHU251_SUITE_FAILURE' }, 'REPORTER_FAILURE_PRECEDENCE');
  assert.equal(api.evaluateSuite({ outcomes: outcomes.slice(2), complete: true, exit_code: 0 }, 1).counts.skipped, 1);
  assert.throws(() => api.evaluateSuite({ outcomes: [{ ...outcomes[2], reason: outcomes[2].reason + ' ' }], complete: true, exit_code: 0 }, 1), { code: 'SHU251_SUITE_UNPERMITTED_SKIP' });
}
async function failureShapeControl(api, reporterFile, root, shape) {
  const file = path.join(root, 'shape.mjs');
  const body = shape === 'after hook'
    ? "t.after(() => assert.fail('after hook failure'));"
    : "await new Promise(resolve => setTimeout(resolve, 400));";
  fs.writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict';
    test(${JSON.stringify(name)}, { timeout: 50 }, async t => {
      t.skip(${JSON.stringify(reason)}); ${body}
    });`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporterFile}`, file], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const outcomes = events.filter(e => e.type === 'outcome');
  assert.equal(events.at(-1).type, 'complete');
  assert.deepEqual(outcomes.map(o => [o.name, o.reason, o.status]), [[name, reason, 'fail']], 'REPORTER_FAILURE_SHAPE');
  assert.throws(() => api.evaluateSuite({ outcomes, complete: true, exit_code: result.status }, 1), { code: 'SHU251_SUITE_FAILURE' }, 'REPORTER_FAILURE_SHAPE');
}
async function nullControl(api) {
  let probes = 0;
  await assert.rejects(() => api.preflight(spec, () => { probes++; return true; }, null), { code: 'SHU251_PREFLIGHT_REQUIREMENTS' }, 'NULL_REQUIREMENTS_TYPED');
  assert.equal(probes, 0, 'NULL_REQUIREMENTS_TYPED');
}
async function reasonControl(api) {
  let reads = 0;
  const need = { name: 'privilege', get reason() { return ++reads === 1 ? reason : 'forged receipt reason'; } };
  const result = await api.preflight(spec, key => key === 'privilege' ? false : key === 'cvtsudoers' ? { available: true, identity: '/usr/bin/cvtsudoers.ws' } : true,
    { names: [name], requirements: [{ name, capabilities: [need] }] });
  assert.deepEqual(result.capabilities.privilege.authorized_skips, [{ name, reason }], 'VALIDATED_RECEIPT_REASON');
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-amendment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('SHU251 contract reporter failure beats skip end to end', t => reporterControl(contract, fileURLToPath(sourceURL), temporary(t)));
test('SHU251 contract null requirements refuse before probes', () => nullControl(contract));
test('SHU251 contract receipt uses validated skip reason', () => reasonControl(contract));
const mutations = [
  ['reporter failure precedence', "status: event.type === 'test:fail' ? 'fail' : d.skip ? 'skip'" + " : d.todo ? 'todo' : 'pass'", "status: d.skip ? 'skip'" + " : d.todo ? 'todo' : event.type === 'test:pass' ? 'pass' : 'fail'", reporterControl, 'REPORTER_FAILURE_PRECEDENCE'],
  ['null requirements typed guard', "if (requiredSet === null) halt('SHU251_PREFLIGHT_REQUIREMENTS', 'exact required test set');", '', nullControl, 'NULL_REQUIREMENTS_TYPED'],
  ['validated receipt reason', 'reason: PERMITTED_SKIPS[need.test]', 'reason: need.reason', reasonControl, 'VALIDATED_RECEIPT_REASON'],
];
for (const [label, from, to, control, assertion] of mutations) test(`SHU251 contract amendment mutation ${label}`, async t => {
  const root = temporary(t);
  await control(contract, fileURLToPath(sourceURL), root);
  const source = fs.readFileSync(sourceURL, 'utf8');
  assert.equal(source.split(from).length, 2, 'unique mutation');
  const file = path.join(root, 'mutant.mjs');
  fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'syntax clean');
  const mutant = await import(pathToFileURL(file));
  await assert.rejects(() => control(mutant, file, root), error => error.code === 'ERR_ASSERTION' && error.message.includes(assertion), assertion);
});

for (const shape of ['after hook', 'timeout']) {
  test(`SHU251 contract reporter skip plus ${shape} refuses`, t => failureShapeControl(contract, fileURLToPath(sourceURL), temporary(t), shape));
  test(`SHU251 contract amendment mutation skip plus ${shape}`, async t => {
    const root = temporary(t);
    await failureShapeControl(contract, fileURLToPath(sourceURL), root, shape);
    const [label, from, to] = mutations[0];
    const source = fs.readFileSync(sourceURL, 'utf8');
    assert.equal(source.split(from).length, 2, label);
    const file = path.join(root, 'mutant.mjs');
    fs.writeFileSync(file, source.replace(from, to));
    assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
    const mutant = await import(pathToFileURL(file));
    await assert.rejects(() => failureShapeControl(mutant, file, root, shape), error => error.code === 'ERR_ASSERTION' && error.message.includes('REPORTER_FAILURE_SHAPE'));
  });
}
