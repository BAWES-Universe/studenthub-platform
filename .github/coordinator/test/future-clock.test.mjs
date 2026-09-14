import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const preload = fileURLToPath(new URL('./fixture/shift-wall-clock.mjs', import.meta.url));
function shiftedEnv() {
  const env = { ...process.env, NODE_OPTIONS: `--import=${preload}`, SHU_TEST_CLOCK_OFFSET_MS: '31536000000' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('SHU-230: future clock ticks, preserves explicit dates and reaches subprocesses', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    const before = Date.now();
    assert.ok(before - performance.timeOrigin > 300 * 86400000, 'wall clock must actually move');
    assert.equal(new Date('2020-01-01T00:00:00Z').toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(Date.parse('2020-01-01T00:00:00Z'), 1577836800000);
    assert.equal(Date.UTC(2020, 0, 1), 1577836800000);
    assert.ok(new Date() instanceof Date);
    assert.ok(Math.abs(Date.parse(Date()) - Date.now()) < 1000);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(Date.now() > before, 'shift must not freeze time');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(Number(child.stdout) >= before && Number(child.stdout) <= Date.now(), 'child must inherit shifted clock');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: shiftedEnv(), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [name, file, before, after, pattern, assertion] of [
  ['literal fresh-claim date', 'hermes-adversarial.test.mjs', 'const freshClaimTime = new Date(Date.now());', "const freshClaimTime = new Date('2026-09-05T00:00:00.000Z');", 'invalid PID claim', 'fresh ambiguous claim must remain pending'],
  ['split process clocks', 'capacity-scheduler.test.mjs', 'now: () => Number(process.env.TEST_NOW)', 'now: () => Date.parse("2026-09-08T12:00:00Z")', 'four concurrent processes', 'shared clock must preserve both reservations'],
]) {
  test(`SHU-230 mutation: ${name} fails under future clock`, () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'shu230-mutation-'));
    try {
      fs.cpSync(new URL('../', import.meta.url), dir, { recursive: true });
      const path = join(dir, 'test', file), source = fs.readFileSync(path, 'utf8');
      assert.equal(source.split(before).length, 2);
      fs.writeFileSync(path, source.replace(before, after));
      const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, path], { env: shiftedEnv(), encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /AssertionError/);
      assert.ok((result.stdout + result.stderr).includes(assertion), result.stdout + result.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
