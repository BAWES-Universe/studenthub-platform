import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = new URL('../../../dist/apps/gateway/src/documents-upload-http.js', import.meta.url);
const suite = fileURLToPath(new URL('../../../dist/apps/gateway/test/documents-upload-http.test.js', import.meta.url));
const original = await readFile(source, 'utf8');
const cases = [
  ['Q14_1_LIMIT', 'size > LIMIT + OVERHEAD', 'false'],
  ['Q14_1_OWNER', 'request.headers.origin !== service.options.origin', 'false'],
  ['Q14_1_ONE_PATH', "submissionKey(form.submission, 'finalize')", "submissionKey(form.submission, 'bytes')"],
  ['Q14_1_ONE_PATH', "await service.finalize(session, submissionKey(form.submission, 'finalize'), { uploadId: ticket.uploadId });", ''],
  ['Q14_1_REFUSALS', "else if (lifecycle.status === 400)", 'else if (false)'],
  ['Q14_1_REPLACE', 'expectedVersion: current?.version ?? null', 'expectedVersion: null'],
];
function run(module, token) { return spawnSync(process.execPath, ['--test', `--test-name-pattern=^${token}`, suite], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SHU548_UPLOAD_MODULE: module } }); }
for (const [index, [token, needle, replacement]] of cases.entries()) {
  assert.equal(original.split(needle).length - 1, 1, `${token} needle binds once`);
  const target = new URL(`../../../dist/apps/gateway/src/documents-upload-mutant-${process.pid}-${index}.js`, import.meta.url);
  try {
    const control = run(source.href, token); assert.equal(control.error, undefined); assert.equal(control.status, 0, control.stdout + control.stderr);
    await writeFile(target, original.replace(needle, replacement));
    const mutant = run(target.href, token); assert.equal(mutant.error, undefined); assert.notEqual(mutant.status, 0, `${token} mutant survived`);
    assert.match(mutant.stdout + mutant.stderr, /AssertionError|ERR_ASSERTION/);
  } finally { await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
assert.equal(await readFile(source, 'utf8'), original);
