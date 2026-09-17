// Suite guard: current revision inventory, live reporter attribution, audited
// file unions, and execution witnesses for the three independent verdict rows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUITE_ROOTS, INVENTORY_PATH } from '../suite-runner-spec.mjs';
import { PERMITTED_SKIPS, evaluateSuite } from '../host-suite-contract.mjs';
export const guardName = 'A12 committed inventory requirements match real outcomes';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const contractURL = new URL('../host-suite-contract.mjs', import.meta.url).href;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT'));
const git = args => {
  const r = spawnSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, 'A12_INVENTORY_GIT'); return r.stdout;
};
export function checkRequirements(inventory, outcomes, audit) {
  const expected = new Map(audit.map(r => [r.file, r.capabilities]));
  const rows = new Map();
  for (const row of inventory.requirements) {
    if (!rows.has(row.name)) rows.set(row.name, []);
    rows.get(row.name).push(row);
  }
  assert.deepEqual(inventory.requirements.map(r => r.name), inventory.names, 'A12_INVENTORY_REQUIREMENT_ORDER');
  for (const outcome of outcomes) {
    const row = rows.get(outcome.name)?.shift();
    assert.ok(row, `A12_INVENTORY_REQUIREMENTS: missing ${outcome.name}`);
    assert.ok(expected.has(outcome.file), `A12_INVENTORY_AUDIT: ${outcome.file}`);
    let capabilities = expected.get(outcome.file).map(name => ({ name }));
    if (outcome.name === 'SHU261_NO_SETENV_POLICY') capabilities = [{ name: 'cvtsudoers' }];
    if (outcome.name === 'SHU261 wrapper contract isolates both reviewer phases and every protected class') capabilities = [];
    if (outcome.name === 'SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing') capabilities = [{ name: 'bash' }];
    if (Object.hasOwn(PERMITTED_SKIPS, outcome.name) && outcome.name !== 'SHU-71 restricted capability refusal')
      capabilities.push(...['privilege', 'worker_uid'].map(name => ({ name, reason: PERMITTED_SKIPS[outcome.name] })));
    assert.deepEqual(row.capabilities, capabilities, `A12_INVENTORY_REQUIREMENTS: ${outcome.name}`);
  }
  assert.equal([...rows.values()].flat().length, 0, 'A12_INVENTORY_REQUIREMENTS: surplus rows');
}
export async function checkCommittedInventory(t) {
  const revision = git(['rev-parse', 'HEAD']).trim();
  const inventory = JSON.parse(git(['show', `${revision}:${INVENTORY_PATH}`]));
  const files = git(['ls-tree', '-r', '--name-only', revision]).trim().split('\n').filter(f =>
    SUITE_ROOTS.some(r => f.startsWith(r) && !f.slice(r.length).includes('/') && f.endsWith('.test.mjs'))).sort();
  assert.deepEqual(inventory.files, files, 'A12_INVENTORY_FILES');
  const audit = JSON.parse(fs.readFileSync(new URL('./file-requirements.json', import.meta.url)));
  assert.deepEqual(audit.map(r => r.file), files, 'A12_INVENTORY_AUDIT_FILES');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-inventory-run-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const reporter = path.join(tmp, 'reporter.mjs');
  fs.writeFileSync(reporter, `import reporter from ${JSON.stringify(contractURL)};
import path from 'node:path';
export default async function* (source) {
  const files=[];
  async function* observed(){for await(const e of source){
    if(['test:pass','test:fail'].includes(e.type)&&e.data.details?.type!=='suite')files.push(e.data.file);
    yield e;
  }}
  for await(const line of reporter(observed())){const e=JSON.parse(line);
    if(e.type==='outcome')e.file=path.relative(${JSON.stringify(root)},files.shift());
    yield JSON.stringify(e)+'\\n';
  }
}`);
  // Filtering just this guard prevents recursion. Node 22 emits no outcome or
  // skip for a filtered callback; every other existing proof runs unchanged.
  const result = spawnSync(process.execPath, ['--test', `--test-skip-pattern=^${guardName}$`, `--test-reporter=${reporter}`, ...files],
    { cwd: root, env, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `A12_INVENTORY_REAL_RUN: ${result.stderr}\n${result.stdout}`);
  const events = result.stdout.trim().split('\n').map(JSON.parse), outcomes = events.filter(e => e.type === 'outcome');
  assert.equal(events.filter(e => e.type === 'complete').length, 1, 'A12_INVENTORY_REAL_COMPLETE');
  assert.equal(events.at(-1).type, 'complete', 'A12_INVENTORY_REAL_TERMINAL');
  evaluateSuite({ outcomes, complete: true, exit_code: result.status }, inventory.names.length - 1);
  assert.deepEqual(outcomes.filter(o => o.status === 'skip').map(o => [o.name, o.reason]).sort(), Object.entries(PERMITTED_SKIPS).sort(), 'A12_INVENTORY_REAL_SKIPS');
  // This callback is the sole excluded recursive case, and is checked too.
  outcomes.push({ name: guardName, file: '.github/coordinator/service/test/suite-runner-spec.test.mjs' });
  assert.deepEqual(outcomes.map(o => o.name).sort(), [...inventory.names].sort(), 'A12_INVENTORY_REAL_NAMES');
  checkRequirements(inventory, outcomes, audit);
  for (const [label, name, mutate] of [
    ['drop F1 shell toolchain', 'SHU261 shipped profile branches pass exact network properties to systemd-run', r => { r.capabilities = r.capabilities.filter(c => c.name !== 'shell_toolchain'); }],
    ['drop F4 git', 'SHU-239 mutation M13 restore world-readable attempt directories', r => { r.capabilities = r.capabilities.filter(c => c.name !== 'git'); }],
    ['drop F6 shell toolchain', 'SHU-237 mutation M1 bypass canonicalization', r => { r.capabilities = r.capabilities.filter(c => c.name !== 'shell_toolchain'); }],
    ['drop required git', 'SHU-63 activation: the RUNNING revision is what bounds an activation, end to end', r => { r.capabilities = r.capabilities.filter(c => c.name !== 'git'); }],
    ['grant unused git', 'B2 credential: transport consumes only fixed systemd credential and never exports it', r => { r.capabilities.push({ name: 'git' }); }],
  ]) {
    const mutant = structuredClone(inventory), row = mutant.requirements.find(r => r.name === name);
    assert.ok(row, 'A12_INVENTORY_MUTATION_ROW'); mutate(row);
    assert.throws(() => checkRequirements(mutant, outcomes, audit),
      e => e.code === 'ERR_ASSERTION' && e.message.includes(`A12_INVENTORY_REQUIREMENTS: ${name}`), `A12_INVENTORY_MUTATION_KILL: ${label}`);
    t.diagnostic(`${label}: killed by A12_INVENTORY_REQUIREMENTS: ${name}`);
  }
  // A stored mapping alone cannot establish these dependencies. Reproduce the
  // verdict's execution witnesses, independently of the audit map.
  for (const [tool, file, name, capability] of [
    ['basename', 'shu261-cleanup-network', 'SHU261 shipped profile branches pass exact network properties to systemd-run', 'shell_toolchain'],
    ['git', 'single-run-activation', 'SHU-63 activation: the RUNNING revision is what bounds an activation, end to end', 'git'],
    ['git', 'shu239-mutations', 'SHU-239 mutation M13 restore world-readable attempt directories', 'git'],
  ]) {
    const bin = path.join(tmp, `${file}-path`); fs.mkdirSync(bin);
    for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) if (entry !== tool && !fs.existsSync(path.join(bin, entry))) {
        try { const source = path.join(dir, entry); if (fs.statSync(source).isFile()) fs.symlinkSync(source, path.join(bin, entry)); } catch {}
      }
    }
    const pattern = '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, `--test-reporter=${reporter}`, `.github/coordinator/test/${file}.test.mjs`],
      { cwd: root, env: { ...env, PATH: bin }, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 1, `A12_INVENTORY_WITNESS: ${tool}: ${r.stdout}${r.stderr}`);
    const failed = r.stdout.trim().split('\n').map(JSON.parse).filter(e => e.type === 'outcome' && e.status === 'fail');
    assert.ok(failed.some(e => e.name === name), `A12_INVENTORY_WITNESS_NAME: ${name}`);
    for (const outcome of outcomes.filter(o => o.file === `.github/coordinator/test/${file}.test.mjs`))
      assert.ok(inventory.requirements.find(r => r.name === outcome.name).capabilities.some(c => c.name === capability), `A12_INVENTORY_EXECUTED_CAPABILITY: ${outcome.name}: ${capability}`);
  }
  t.diagnostic(`A12_INVENTORY_REAL_RUN: ${revision}; ${files.length} files; ${outcomes.length - 1} child outcomes plus this guard`);
}
