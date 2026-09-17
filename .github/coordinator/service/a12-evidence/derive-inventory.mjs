// Derivation only: this script does not execute the suite or infer success.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { SUITE_ROOTS, INVENTORY_PATH } from '../suite-runner-spec.mjs';
import { PERMITTED_SKIPS, deriveRequirements, suiteNames, evaluateSuite } from '../host-suite-contract.mjs';
const root = path.dirname(new URL(import.meta.url).pathname);
const capture = process.argv[2] ? path.resolve(process.argv[2]) : root;
const read = name => JSON.parse(fs.readFileSync(path.join(name === 'file-requirements.json' ? root : capture, name), 'utf8'));
const lines = name => fs.readFileSync(path.join(capture, name), 'utf8').trim().split('\n').map(JSON.parse);
const summary = read('successful-run-summary.json');
const revision = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(summary.revision, revision, 'A12_CAPTURE_REVISION');
const events = lines('successful-run.jsonl');
const outcomes = events.filter(e => e.type === 'outcome');
assert.equal(summary.exit_code, 0, 'A12_CAPTURE_EXIT');
assert.equal(events.filter(e => e.type === 'complete').length, 1, 'A12_CAPTURE_COMPLETE');
assert.equal(events.at(-1).type, 'complete', 'A12_CAPTURE_TERMINAL');
evaluateSuite({ outcomes, complete: true, exit_code: summary.exit_code }, outcomes.length);
const provenance = lines('outcome-files.jsonl').map(o => ({ ...o, file: path.isAbsolute(o.file) ? path.relative(process.cwd(), o.file) : o.file }));
assert.deepEqual(provenance.map(o => o.name), outcomes.map(o => o.name), 'A12_FILE_PROVENANCE_ORDER');
const tracked = execFileSync('/usr/bin/git', ['ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).trimEnd().split('\n');
const sorted = values => [...values].sort();
// Literal derivation from suite-runner-spec.mjs, using its exported roots.
const files = sorted(tracked.filter(f => SUITE_ROOTS.some(root => f.startsWith(root) && !f.slice(root.length).includes('/') && f.endsWith('.test.mjs'))));
const rows = read('file-requirements.json');
assert.deepEqual(rows.map(r => r.file), files, 'A12_AUDIT_EXACT_FILES');
assert.deepEqual([...new Set(provenance.map(o => o.file))].sort(), files, 'A12_PROVENANCE_EXACT_FILES');
const mapping = new Map(rows.map(r => [r.file, r.capabilities]));
// These executable fixtures and mutation children are retained, not rewritten.
for (const file of ['push-broker-gitconfig', 'workspace-result', 'codex-contract',
  'workspace-result-mutations', 'episode-successor-dispatch']) {
  assert.ok(mapping.get(`.github/coordinator/test/${file}.test.mjs`)?.includes('shell_toolchain'),
    `A12_RESTORED_SHELL_REQUIREMENT: ${file}`);
}

const names = outcomes.map(o => o.name);
const requirements = names.map((name, i) => {
  let capabilities = mapping.get(provenance[i].file).map(name => ({ name }));
  // Preserve the reviewed Option A per-proof mapping in capability-requirements.
  if (name === 'SHU261_NO_SETENV_POLICY') capabilities = [{ name: 'cvtsudoers' }];
  if (name === 'SHU261 wrapper contract isolates both reviewer phases and every protected class') capabilities = [];
  if (name === 'SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing') capabilities = [{ name: 'bash' }];
  // Only the exact seven distinct-identity proofs may bind an absence reason.
  if (Object.hasOwn(PERMITTED_SKIPS, name) && name !== 'SHU-71 restricted capability refusal')
    capabilities.push(...['privilege', 'worker_uid'].map(capability => ({ name: capability, reason: PERMITTED_SKIPS[name] })));
  return { name, capabilities };
});
const derived = deriveRequirements(names, requirements);
suiteNames(outcomes, names);
const inventory = { version: 'shu251-suite-inventory-v1', files, names, requirements };
fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'required-files.json'), JSON.stringify(files, null, 2) + '\n');
console.log(JSON.stringify({ assertion: 'A12_INVENTORY_DERIVED', revision, files: files.length, names: names.length, requirements: requirements.length,
  distinct_names: new Set(names).size, expected_tests: names.length,
  capability_name_counts: Object.fromEntries(Object.entries(derived).map(([name, values]) => [name, values.length])),
  empty_requirements: requirements.filter(r => !r.capabilities.length).length }, null, 2));
