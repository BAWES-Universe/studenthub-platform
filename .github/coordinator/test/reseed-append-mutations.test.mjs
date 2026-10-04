import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cases = [
  ['M1 changed blob', "b?.oid ?? ZERO", 'ZERO', 'RESEED blob OIDs are load bearing', 'RESEED blob OIDs retained'],
  ['M2 changed mode', "b?.mode ?? '000000'", "b ? '100644' : '000000'", 'RESEED modes are load bearing', 'RESEED modes retained'],
  ['M3 changed path', 'paths.sort(Buffer.compare);', 'paths.sort((a, b) => -Buffer.compare(a, b));', 'RESEED raw path byte ordering', 'RESEED raw byte order'],
  ['M4 parent', "if (parents.length !== 2 || parents[0] !== binding.expected_parent || parents[1] !== binding.approvedExecutionRevision) refuse('UNEXPECTED_PARENT');", '', 'RESEED unexpected parents refused', 'RESEED wrong parent refused'],
  ['M5 timestamp', 'Object.freeze(1735689600)', 'Object.freeze(1735689601)', 'RESEED fixed timestamp literal', 'RESEED historical timestamp is fixed'],
  ['M6 message', "Object.freeze('Append approved execution revision to sealed seed.\\n')", "Object.freeze('Different message.\\n')", 'RESEED fixed message literal', 'RESEED message is fixed'],
  ['M7 digest convention', "Buffer.from('\\0')", "Buffer.from('|')", 'RESEED independent manifest literal and complete transition', 'RESEED canonical digest convention'],
  ['M8 extra path', "if (manifest.toString('hex') !== binding.manifest_hex) refuse('UNEXPECTED_PATH');", '', 'RESEED extra path refused', 'RESEED extra path refused'],
];
for (const [name, from, to, pattern, assertion] of cases) test(`RESEED mutation ${name}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-mutant-'));
  try {
    fs.mkdirSync(path.join(root, 'test'));
    const target = path.join(root, 'reseed-append-contract.mjs');
    const source = fs.readFileSync(new URL('../reseed-append-contract.mjs', import.meta.url), 'utf8');
    fs.writeFileSync(target, source);
    fs.copyFileSync(new URL('./reseed-append-contract.test.mjs', import.meta.url), path.join(root, 'test/reseed-append-contract.test.mjs'));
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern}$`, path.join(root, 'test/reseed-append-contract.test.mjs')],
      { env, encoding: 'utf8', timeout: 60_000 });
    const control = run();
    assert.equal(control.status, 0, `${name}: matched control passes\n${control.stdout}${control.stderr}`);
    assert.match(control.stdout, /^# pass 1$/m, `${name}: exact control pass count`);
    assert.match(control.stdout, /^# fail 0$/m);
    assert.equal(source.split(from).length, 2, `${name}: unique replacement`);
    fs.writeFileSync(target, source.replace(from, to));
    const syntax = spawnSync(process.execPath, ['--check', target], { env, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: syntax clean`);
    const mutant = run(), output = mutant.stdout + mutant.stderr;
    assert.equal(mutant.status, 1, `${name}: mutant must exit 1\n${output}`);
    assert.match(output, /^# fail 1$/m, `${name}: exactly one selected assertion fails`);
    assert.match(output, /code: 'ERR_ASSERTION'/, `${name}: assertion failure`);
    assert.match(output, /failureType: 'testCodeFailure'/, `${name}: test code failure`);
    assert.match(output, /AssertionError/);
    assert.ok(output.includes(assertion), `${name}: exact named assertion ${assertion}`);
    assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, `${name}: crash is not a kill`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
