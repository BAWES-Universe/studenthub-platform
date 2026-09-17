import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../units.mjs', import.meta.url), 'utf8');
const cases = fs.readFileSync(new URL('./environment-content.test.mjs', import.meta.url), 'utf8');
const mutations = [
  ['STRIP_QUOTES_REMOVED', "const body = delimiter ? raw.slice(1, -1) : raw;", 'const body = raw;',
    '^ENV_CONTENT_ACCEPT_(COMMAND|SSH_COMMAND|DOUBLE_JSON|SINGLE_JSON)$',
    ['COMMAND', 'SSH_COMMAND', 'DOUBLE_JSON', 'SINGLE_JSON'].map(label => `ENV_CONTENT_ACCEPT_${label}`)],
  ['CONTENT_REFUSAL_REMOVED',
    "assert.ok(value !== undefined && value.trim().length > 0, 'SHU251_ENV_CONTENT: well-formed nonempty unambiguous effective values required');",
    '/* mutant: omit content refusal */', '^ENV_CONTENT_REFUSE_',
    ['EMPTY', 'WHITESPACE', 'QUOTED_EMPTY', 'QUOTED_WHITESPACE', 'UNTERMINATED_DOUBLE', 'MISMATCHED', 'TRAILING',
      'INNER_DOUBLE', 'INNER_SINGLE', 'DOLLAR', 'BRACED_DOLLAR', 'CONTINUATION', 'DOUBLE_CONTINUATION',
      'UNQUOTED_QUOTE', 'ESCAPED_CLOSING'].map(label => `ENV_CONTENT_REFUSE_${label}`)],
];
for (const [name, before, after, pattern, assertions] of mutations) test(`ENV_CONTENT_MUTATION_${name}`, t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu-env-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'test'));
  fs.copyFileSync(new URL('../credential-delivery.mjs', import.meta.url), join(root, 'credential-delivery.mjs'));
  fs.writeFileSync(join(root, 'test/environment-content.test.mjs'), cases);
  for (const unit of ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer']) {
    fs.copyFileSync(new URL(`../${unit}.in`, import.meta.url), join(root, `${unit}.in`));
  }
  const env = { ...process.env, TMPDIR: '/tmp' };
  delete env.NODE_TEST_CONTEXT;
  const run = args => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env });
  fs.writeFileSync(join(root, 'units.mjs'), source);
  const control = run(['--test', 'test/environment-content.test.mjs']);
  assert.ok(control.status === 0 && /# pass 26\b/.test(control.stdout), 'ENV_CONTENT_MUTATION_CONTROL: all acceptance bars pass in throwaway copy');
  assert.ok(source.split(before).length === 2, 'ENV_CONTENT_MUTATION_TARGET: exactly one replacement');
  fs.writeFileSync(join(root, 'units.mjs'), source.replace(before, after));
  assert.ok(run(['--check', 'units.mjs']).status === 0, 'ENV_CONTENT_MUTATION_SYNTAX: node --check must pass');
  const killed = run(['--test', `--test-name-pattern=${pattern}`, 'test/environment-content.test.mjs']);
  assert.ok(killed.status === 1, 'ENV_CONTENT_MUTATION_KILL: test runner must refuse');
  assert.ok(!/SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/.test(killed.stdout + killed.stderr), 'ENV_CONTENT_MUTATION_KIND: no syntax, type or module-load kills');
  const failures = killed.stdout.split(/(?=^not ok )/m).slice(1);
  assert.ok(failures.length === assertions.length, 'ENV_CONTENT_MUTATION_COUNT: every selected case must die');
  for (const code of assertions) {
    assert.ok(failures.some(block => block.includes(`- ${code}\n`) && block.includes(`${code}:`)
      && block.includes("code: 'ERR_ASSERTION'") && block.includes("failureType: 'testCodeFailure'")),
    `${code}: mutant must die by named assertion and testCodeFailure/ERR_ASSERTION`);
  }
});
