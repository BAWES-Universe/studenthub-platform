import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = new URL('../../../dist/apps/gateway/src/documents-upload-http.js', import.meta.url);
const suite = fileURLToPath(new URL('../../../dist/apps/gateway/test/documents-upload-http.test.js', import.meta.url));
const original = await readFile(source, 'utf8');
const target = new URL(`../../../dist/apps/gateway/src/documents-upload-http-mutant-${process.pid}.js`, import.meta.url);
const mutations = [
  ['Q14_1_LIMIT drop body bound', 'if (Number.isFinite(length) && length > limit)', 'if (false)'],
  ['Q14_1_OWNER skip Origin check', "request.headers.origin !== service.options.origin", 'false'],
  ['Q14_1_ONE_PATH skip finalize', 'await service.finalize(session, keys[2], { uploadId: ticket.uploadId });', 'await Promise.resolve({ status: 200 });'],
  ['Q14_1_REFUSALS return success on refused finalize', 'catch (error) {', 'catch (error) { if (String(error).includes("conflict")) { response.writeHead(303, { location: "/profile/documents" }); response.end(); return true; }'],
  ['Q14_1_ONE_PATH use client idempotency key', 'const keys = serverKeys(service, type, parsed.submission);', "const keys = [String(request.headers['idempotency-key']), String(request.headers['idempotency-key']), String(request.headers['idempotency-key'])];"],
];
function run(module) { return spawnSync(process.execPath, ['--test', suite], { encoding:'utf8', timeout:30000, env:{...process.env,SHU503_UPLOAD_MODULE:module} }); }
try {
  assert.equal(run(source.href).status, 0, 'Q14_1 mutation control');
  for (const [name, needle, replacement] of mutations) {
    assert.equal(original.split(needle).length - 1, 1, `${name} binds once`); await writeFile(target, original.replace(needle, replacement));
    const result = run(target.href); assert.notEqual(result.status, 0, `${name} survived\n${result.stdout}${result.stderr}`); console.log(`KILLED ${name}`);
  }
} finally { await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
