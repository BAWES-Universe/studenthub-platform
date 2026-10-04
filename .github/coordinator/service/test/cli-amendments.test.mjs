import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const service = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(service, 'host-suite-contract.mjs');
const preload = fileURLToPath(new URL('./fixture/a12-repository-boundary.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = path.join(root, 'spec.json');
  // Impossible service UID reaches the real imported identity guard before any
  // host probe, metadata read, clone creation or removal can occur.
  fs.writeFileSync(spec, JSON.stringify({ service_uid: -1, service_gid: -1, service_groups: [] }));
  return { root, spec };
}
function invoke(file, action, spec) {
  const env = { ...process.env, L4_REPOSITORY_ROOT: path.resolve(service, '../../..') };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--import', preload, file, action, spec], { env, encoding: 'utf8', timeout: 10000 });
}
function control(result) {
  assert.equal(result.error, undefined, 'CLI_TYPED_REFUSAL: subprocess completed');
  assert.equal(result.signal, null, 'CLI_TYPED_REFUSAL: no signal');
  assert.equal(result.status, 2, `CLI_TYPED_REFUSAL: ${result.stderr}`);
  assert.equal(result.stdout, '', 'CLI_TYPED_REFUSAL: no success receipt');
  const lines = result.stderr.trim().split('\n');
  assert.equal(lines.length, 1, 'CLI_TYPED_REFUSAL: one structured envelope');
  const envelope = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(envelope).sort(), ['code', 'ok', 'reason']);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'SHU251_SUITE_IDENTITY');
  assert.match(envelope.reason, /^SHU251_SUITE_IDENTITY:/);
}
for (const action of ['preflight', 'run', 'measure', 'create', 'remove']) {
  test(`SHU251 contract CLI ${action} structured refusal`, t => {
    const { spec } = fixture(t);
    control(invoke(entry, action, spec));
  });
  test(`SHU251 contract CLI mutation ${action} cyclic top-level await`, t => {
    const { root, spec } = fixture(t);
    control(invoke(entry, action, spec));
    // Preserve both real back-imports: replacing them with library URLs would
    // accidentally break the very cycle this regression must detect.
    for (const name of ['host-suite-contract.mjs', 'suite-runner-spec.mjs', 'disposable-suite.mjs'])
      fs.copyFileSync(path.join(service, name), path.join(root, name));
    const mutant = path.join(root, 'host-suite-contract.mjs');
    const source = fs.readFileSync(mutant, 'utf8');
    assert.equal(source.split('void (async () => {').length, 2);
    fs.writeFileSync(mutant, source.replace('void (async () => {', 'await (async () => {'));
    assert.equal(spawnSync(process.execPath, ['--check', mutant]).status, 0, 'syntax clean');
    const result = invoke(mutant, action, spec);
    assert.throws(() => control(result), error => error.code === 'ERR_ASSERTION' && error.message.includes('CLI_TYPED_REFUSAL'));
    assert.equal(result.status, 13, 'restored ESM deadlock');
    assert.equal(result.stdout, '', 'deadlock emits no receipt');
    assert.match(result.stderr, /unsettled top-level await/i);
  });
}
