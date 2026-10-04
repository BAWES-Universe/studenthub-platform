// Repository-only admission and refusal proof. No lifecycle or host probes run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { bindSuite, suiteBoundary, INVENTORY_PATH } from '../suite-runner-spec.mjs';
import { deriveRequirements, suiteNames, evaluateSuite } from '../host-suite-contract.mjs';
const checkout = fs.realpathSync(process.cwd());
const git = (cwd, ...args) => {
  const r = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `A12_PROOF_GIT: ${r.stderr}`); return r.stdout.trimEnd();
};
const specFor = checkout => ({ service_uid: process.getuid(), service_gid: process.getgid(), service_groups: process.getgroups(),
  checkout, temp_dir: os.tmpdir(), revision: git(checkout, 'rev-parse', 'HEAD'), tree: git(checkout, 'rev-parse', 'HEAD^{tree}') });
const spec = specFor(checkout);
const contract = bindSuite(spec);
const inventory = JSON.parse(git(checkout, 'show', `${spec.revision}:${INVENTORY_PATH}`));
assert.equal(contract.expected_tests, inventory.names.length, 'A12_COMMITTED_INVENTORY_ADMITTED');
assert.deepEqual(contract.names, inventory.names, 'A12_COMMITTED_INVENTORY_ADMITTED');
console.log(`A12_COMMITTED_INVENTORY_ADMITTED: ${spec.revision}; ${contract.files.length} files; ${contract.expected_tests} outcomes`);
const refusal = (label, code, fn) => { assert.throws(fn, { code }, label); console.log(`${label}: ${code}`); };
const changedInventory = value => ({ ...suiteBoundary, run(file, args, options) {
  if (args.includes('show') && args.at(-1) === `${spec.revision}:${INVENTORY_PATH}`)
    return value === null ? { status: 128, stdout: '' } : { status: 0, stdout: JSON.stringify(value) };
  return suiteBoundary.run(file, args, options);
} });
for (const [label, value] of [
  ['missing inventory', null], ['missing files', { ...inventory, files: [] }],
  ['partial files', { ...inventory, files: inventory.files.slice(1) }],
  ['extra files', { ...inventory, files: [...inventory.files, '.github/coordinator/test/extra.test.mjs'] }],
  ['version mismatch', { ...inventory, version: 'invalid' }],
]) refusal(label, 'SHU251_SUITE_INVENTORY', () => bindSuite(spec, changedInventory(value)));
refusal('missing name requirement', 'SHU251_PREFLIGHT_REQUIREMENTS', () => bindSuite(spec,
  changedInventory({ ...inventory, requirements: inventory.requirements.slice(1) })));
const unknown = structuredClone(inventory); unknown.requirements[0].capabilities.push({ name: 'undeclared' });
refusal('capability outside vocabulary', 'SHU251_PREFLIGHT_REQUIREMENTS', () => bindSuite(spec, changedInventory(unknown)));
const drift = inventory.names.map(name => ({ name })); drift[0].name += ' drift';
refusal('name drift', 'SHU251_SUITE_NAMES', () => suiteNames(drift, contract.names));
const badReason = structuredClone(inventory.requirements); badReason[0].capabilities = [{ name: 'git', reason: 'unauthorized' }];
refusal('unpermitted reason', 'SHU251_PREFLIGHT_SKIP_BINDING', () => deriveRequirements(inventory.names, badReason));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-byte-proof-'));
try {
  git(root, 'clone', '--quiet', '--shared', '--no-hardlinks', checkout, 'checkout');
  const copy = path.join(root, 'checkout'), copySpec = specFor(copy);
  bindSuite(copySpec);
  const target = inventory.files[0];
  git(copy, 'update-index', '--assume-unchanged', target);
  fs.appendFileSync(path.join(copy, target), '\n// deliberate proof-only byte tampering\n');
  assert.equal(git(copy, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'A12_TAMPER_HIDDEN_FROM_STATUS');
  refusal('real hidden byte tampering', 'SHU251_SUITE_FILE_DIGEST', () => bindSuite(copySpec));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
if (process.argv[2]) {
  const events = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
  const outcomes = events.filter(e => e.type === 'outcome');
  assert.equal(events.filter(e => e.type === 'complete').length, 1, 'A12_AUTHORITATIVE_COMPLETE');
  assert.equal(events.at(-1).type, 'complete', 'A12_AUTHORITATIVE_COMPLETE');
  const result = evaluateSuite({ outcomes, complete: true, exit_code: 0 }, contract.expected_tests);
  assert.doesNotThrow(() => suiteNames(outcomes, contract.names), 'A12_AUTHORITATIVE_SUITE_NAMES');
  console.log(`A12_AUTHORITATIVE_SUITE_NAMES: ${JSON.stringify(result.counts)}`);
}
