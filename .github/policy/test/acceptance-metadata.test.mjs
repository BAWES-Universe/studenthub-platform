import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkMetadata } from '../acceptance-metadata.mjs';
import { probes } from '../probes.mjs';

for (const [name, title, body, allowed] of probes) test(`probe ${name}`, () => {
  const pr = { title: title || 'Local correction', body };
  if (allowed) assert.equal(checkMetadata(pr).code, 'BOARD_METADATA_ACCEPTED');
  else assert.throws(() => checkMetadata(pr), { code: 'BOARD_ACCEPTANCE_REFERENCE' });
});
test('BOARD_METADATA_SHAPE rejects missing or malformed metadata', () => {
  for (const pr of [null, {}, { title: '', body: '' }, { title: 'valid', body: null }, { title: 1, body: '' }]) {
    assert.throws(() => checkMetadata(pr), { code: 'BOARD_METADATA_SHAPE' });
  }
});
test('template is an accepted positive control', () => {
  assert.equal(checkMetadata({ title: 'Local correction', body: readFileSync(new URL('../../pull_request_template.md', import.meta.url), 'utf8') }).code, 'BOARD_METADATA_ACCEPTED');
});
test('event-file CLI measures every probe with exact exit and code', t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = join(dir, 'event.json');
  for (const [name, title, body, allowed] of probes) {
    writeFileSync(event, JSON.stringify({ pull_request: { title: title || 'Local correction', body } }));
    const result = spawnSync(process.execPath, [new URL('../acceptance-metadata.mjs', import.meta.url).pathname], { env: { GITHUB_EVENT_PATH: event }, encoding: 'utf8' });
    assert.equal(result.status, allowed ? 0 : 1, name);
    assert.equal(JSON.parse(allowed ? result.stdout : result.stderr).code, allowed ? 'BOARD_METADATA_ACCEPTED' : 'BOARD_ACCEPTANCE_REFERENCE');
    console.log(JSON.stringify({ name, title: title || 'Local correction', body, exit: result.status, output: JSON.parse(allowed ? result.stdout : result.stderr) }));
  }
  writeFileSync(event, '{');
  const result = spawnSync(process.execPath, [new URL('../acceptance-metadata.mjs', import.meta.url).pathname], { env: { GITHUB_EVENT_PATH: event }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { code: 'BOARD_METADATA_SHAPE' });
});
for (const code of ['BOARD_METADATA_SHAPE', 'BOARD_ACCEPTANCE_REFERENCE']) test(`mutation remove ${code}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mutation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../acceptance-metadata.mjs', import.meta.url), 'utf8');
  const guard = `throw Object.assign(new Error('${code}'), { code: '${code}' });`;
  assert.equal(source.split(guard).length, code === 'BOARD_METADATA_SHAPE' ? 3 : 2);
  const file = join(dir, 'acceptance-metadata.mjs');
  const pr = code === 'BOARD_METADATA_SHAPE' ? { title: '', body: '' } : { title: 'Completes only SHU-253', body: '' };
  writeFileSync(join(dir, 'control.mjs'), `import assert from 'node:assert/strict';\nimport {checkMetadata} from './acceptance-metadata.mjs';\nassert.throws(() => checkMetadata(${JSON.stringify(pr)}), {code: '${code}'}, '${code}');\n`);
  writeFileSync(file, source);
  assert.equal(spawnSync(process.execPath, [join(dir, 'control.mjs')]).status, 0);
  writeFileSync(file, source.replace(guard, '/* removed guard */'));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const result = spawnSync(process.execPath, [join(dir, 'control.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_ASSERTION/);
  assert.ok(result.stderr.includes(`Missing expected exception: ${code}`), result.stderr);
  console.log(`mutation=${code} control_exit=0 syntax_exit=0 mutant_exit=1 assertion=${code}`);
});

test('mutation restore blanket reference ban is killed by B19 positive control', t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mutation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../acceptance-metadata.mjs', import.meta.url), 'utf8');
  const pr = { title: probes.find(([name]) => name === 'B19 own PR title')[1], body: '' };
  const file = join(dir, 'acceptance-metadata.mjs');
  const control = join(dir, 'control.mjs');
  writeFileSync(control, `import assert from 'node:assert/strict';\nimport {checkMetadata} from './acceptance-metadata.mjs';\nassert.doesNotThrow(() => checkMetadata(${JSON.stringify(pr)}), 'B19 benign title must pass');\n`);
  writeFileSync(file, source);
  assert.equal(spawnSync(process.execPath, [control]).status, 0);
  assert.equal(source.split('if (closingReference.test(text)) {').length, 2);
  writeFileSync(file, source.replace('if (closingReference.test(text)) {', 'if (/[a-z]+-\\d+/iu.test(text)) {'));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const result = spawnSync(process.execPath, [control], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_ASSERTION/);
  assert.match(result.stderr, /B19 benign title must pass/);
  console.log('mutation=blanket-reference-ban control_exit=0 syntax_exit=0 mutant_exit=1 assertion=B19');
});
