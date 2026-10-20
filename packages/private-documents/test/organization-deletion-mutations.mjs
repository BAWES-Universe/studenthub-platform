import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../../../dist/packages/private-documents/src/index.js', import.meta.url);
const testFile = fileURLToPath(new URL('../../../dist/apps/gateway/test/organization-documents-http.test.js', import.meta.url));
const original = await readFile(source, 'utf8');
const anchor = "if (scope.personId === undefined && this.options.organizationDeleted && await this.options.organizationDeleted(scope.orgId))\n            fail('denied');";
assert.equal(original.split(anchor).length - 1, 1, 'organization deletion check must bind exactly once');

try {
  await writeFile(source, original.replace(anchor, 'void scope.orgId;'));
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-name-pattern=^SHU329_DOCS_DELETED ', testFile],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, 'mutation test process failed to run');
  assert.notEqual(result.status, 0, 'organization deletion check mutation survived');
  assert.match(output, /not ok [0-9]+ - SHU329_DOCS_DELETED /, `named test did not fail\n${output}`);
  assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, 'infrastructure failure is not a kill');
  console.log('KILLED organization deletion check removed -> SHU329_DOCS_DELETED');
} finally {
  await writeFile(source, original);
}
