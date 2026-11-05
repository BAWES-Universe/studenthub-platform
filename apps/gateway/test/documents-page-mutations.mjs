import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = new URL('../../../dist/apps/gateway/src/documents-page.js', import.meta.url);
const suite = fileURLToPath(new URL('../../../dist/apps/gateway/test/documents-page.test.js', import.meta.url));
const original = await readFile(source, 'utf8');
const anchor = 'documents.find(row => row.type === type); // SHU366_PAGE slot presence';
assert.equal(original.split(anchor).length - 1, 1, 'SHU366_PAGE anchor binds once');
const target = new URL(`../../../dist/apps/gateway/src/documents-page-mutant-${process.pid}.js`, import.meta.url);
function run(module) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^SHU366_PAGE finalized file', suite], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SHU366_PAGE_MODULE: module } });
  assert.equal(result.error, undefined, 'SHU366_PAGE runner must execute');
  return { ...result, output: result.stdout + result.stderr };
}
try {
  const control = run(source.href);
  assert.equal(control.status, 0, `SHU366_PAGE passing control\n${control.output}`);
  assert.match(control.output, /ok \d+ - SHU366_PAGE finalized file/);
  await writeFile(target, original.replace(anchor, 'undefined; // SHU366_PAGE slot presence'));
  const mutant = run(target.href);
  assert.notEqual(mutant.status, 0, `SHU366_PAGE mutant survived\n${mutant.output}`);
  assert.match(mutant.output, /not ok \d+ - SHU366_PAGE finalized file/);
  assert.match(mutant.output, /AssertionError/);
  assert.match(mutant.output, /SHU366_PAGE finalized slot must be On file/);
  assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
  console.log('KILLED SHU366_PAGE empty slots -> SHU366_PAGE finalized slot must be On file');
} finally {
  await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.equal(await readFile(source, 'utf8'), original, 'SHU366_PAGE original remains restored');
}
