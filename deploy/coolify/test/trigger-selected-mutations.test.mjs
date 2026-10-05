import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const mutations = [
  ['precondition mislabeled', "outcome('PRECONDITION_NOT_MET', 'staging application", "outcome('DEPLOYMENT_FAILED', 'staging application", 'trigger precondition latest', 'TRIGGER_PRECONDITION_TYPED'],
  ['rejection mislabeled', "? 'TRIGGER_REJECTED' :", "? 'DEPLOYMENT_UNKNOWN' :", 'trigger explicit HTTP rejection', 'TRIGGER_REJECTION_TYPED'],
  ['empty receipt mislabeled', "outcome('DEPLOYMENT_UNKNOWN', 'Coolify returned no deployment", "outcome('DEPLOYMENT_FAILED', 'Coolify returned no deployment", 'trigger no deployment receipt', 'TRIGGER_NO_FALSE_FAILURE'],
  ['real failure hidden', "outcome('DEPLOYMENT_FAILED', 'recorded deployment", "outcome('DEPLOYMENT_UNKNOWN', 'recorded deployment", 'trigger real terminal failure', 'TRIGGER_REAL_FAILURE_DETECTED'],
  ['health verification bypassed', "if (application.status === 'running:healthy') {", "if (true) {", 'trigger timeout and unhealthy', 'TRIGGER_HEALTH_REQUIRED'],
];
for (const [name, before, after, pattern, named] of mutations) {
  test(`trigger mutation killed: ${name}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'trigger-mutation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'test'));
    const source = readFileSync(new URL('../trigger-selected.mjs', import.meta.url), 'utf8');
    assert.equal(source.split(before).length, 2, 'unique mutation anchor');
    writeFileSync(join(root, 'trigger-selected.mjs'), source.replace(before, after));
    for (const file of ['select-artifact.mjs', 'test/trigger-selected.test.mjs']) {
      writeFileSync(join(root, file), readFileSync(new URL(`../${file}`, import.meta.url)));
    }
    const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, join(root, 'test/trigger-selected.test.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000 });
    const output = child.stdout + child.stderr;
    assert.equal(child.status, 1, output);
    assert.match(output, /AssertionError/, output);
    assert.ok(output.includes(named), output);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, output);
    t.diagnostic(`AssertionError: ${named}`);
  });
}
