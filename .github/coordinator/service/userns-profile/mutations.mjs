import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controls } from './controls.mjs';
const file = fileURLToPath(new URL('../test/userns-profile.test.mjs', import.meta.url));
for (const [name, assertion] of controls) {
  const run = mutation => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.SHU251_USERNS_MUTATION;
    if (mutation) env.SHU251_USERNS_MUTATION = mutation;
    return spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^A12 control ${name}$`, file],
      { env, encoding: 'utf8', timeout: 10000 });
  };
  const positive = run();
  assert.ifError(positive.error);
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  assert.match(positive.stdout, /# pass 1\n/);
  assert.match(positive.stdout, /# skipped 0\n/);
  const mutant = run(name);
  assert.ifError(mutant.error);
  assert.equal(mutant.signal, null);
  assert.equal(mutant.status, 1, mutant.stdout + mutant.stderr);
  assert.match(mutant.stdout, new RegExp(assertion));
  assert.match(mutant.stdout, /code: 'ERR_ASSERTION'/);
  assert.match(mutant.stdout, /# fail 1\n/);
  assert.match(mutant.stdout, /# skipped 0\n/);
  assert.doesNotMatch(mutant.stdout + mutant.stderr, /SyntaxError/);
  console.log(`${name}: positive PASS; syntax-clean mutant KILLED by ${assertion}`);
}
