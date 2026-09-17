import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../../workflows/repository-policy.yml', import.meta.url), 'utf8');
const names = [
  'Measure acceptance reference policy and its mutations',
  'Reject acceptance references in PR metadata',
  'Verify repository ownership controls',
  'Reject tracked dependency trees and host-absolute symlinks',
];
function step(source, name) {
  const block = source.split(`      - name: ${name}\n`);
  assert.equal(block.length, 2, name);
  return block[1].split('\n      - ')[0];
}
function independent(source) {
  assert.match(source, /    name: repository-policy\n/);
  assert.doesNotMatch(source, /continue-on-error:/);
  for (const [i, name] of names.entries()) {
    const condition = step(source, name).match(/^        if: (.*)$/m)?.[1];
    assert.equal(condition, i === 1 ? "always() && github.event_name == 'pull_request'" : 'always()', name);
  }
}
function script(name) {
  const block = step(workflow, name);
  assert.ok(block.includes('        run: |\n'), name);
  return block.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
}
function run(cmd, args, cwd, env) {
  return spawnSync(cmd, args, { cwd, env: env || { PATH: process.env.PATH }, encoding: 'utf8' });
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-workflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run('git', ['init', '-q'], dir).status, 0);
  mkdirSync(join(dir, '.github'));
  writeFileSync(join(dir, '.github/pull_request_template.md'), 'Fixture template');
  return dir;
}

test('all policy checks explicitly run despite prior step failure; no error masking', () => independent(workflow));
for (const name of names) test(`mutation remove independent condition: ${name}`, () => {
  independent(workflow);
  const block = step(workflow, name);
  const mutant = workflow.replace(block, block.replace(/^        if: .*\n/m, ''));
  assert.throws(() => independent(mutant), { code: 'ERR_ASSERTION' });
  console.log(`mutation=independence:${name} control=PASS mutant=KILLED assertion=ERR_ASSERTION`);
});

// Execute the actual three workflow commands in disposable repositories for all
// eight failure combinations. The condition assertion above ties this local
// runner to GitHub's always() scheduling; this is not a hosted Actions run.
for (let failures = 0; failures < 8; failures++) test(`three checks report independently: failure bits ${failures}`, t => {
  independent(workflow);
  const dir = fixture(t);
  writeFileSync(join(dir, '.github/CODEOWNERS'), failures & 2 ? '* @wrong\n' : '* @BAWES\n/.github/ @BAWES\n');
  if (failures & 4) {
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/tracked'), 'unsafe fixture');
  }
  assert.equal(run('git', ['add', '.'], dir).status, 0);
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { title: failures & 1 ? 'Closes SHU-253' : 'Local correction (SHU-251)', body: '' } }));
  const results = [
    run(process.execPath, [fileURLToPath(new URL('../acceptance-metadata.mjs', import.meta.url))], dir, { GITHUB_EVENT_PATH: event }),
    ...names.slice(2).map(name => run('bash', ['-e', '-o', 'pipefail', '-c', script(name)], dir)),
  ];
  for (const [i, result] of results.entries()) {
    assert.equal(result.status, failures & (1 << i) ? 1 : 0, `${names[i + 1]}: ${result.stdout}${result.stderr}`);
  }
  console.log(JSON.stringify({ failure_bits: failures, checks_run: results.length, exits: results.map(r => r.status) }));
});
test('tracked-path check preserves absolute-symlink refusal and relative-symlink acceptance', t => {
  const dir = fixture(t);
  for (const [target, status] of [['ordinary.txt', 0], ['/nonexistent-policy-fixture/never-read', 1]]) {
    rmSync(join(dir, 'link'), { force: true });
    symlinkSync(target, join(dir, 'link'));
    assert.equal(run('git', ['add', '.'], dir).status, 0);
    const result = run('bash', ['-e', '-o', 'pipefail', '-c', script(names[3])], dir);
    assert.equal(result.status, status, result.stderr);
  }
});
test('both legacy check scripts pass on the current repository', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const name of names.slice(2)) {
    const result = run('bash', ['-e', '-o', 'pipefail', '-c', script(name)], root);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
});
