import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = new URL('../../../dist/apps/gateway/src/organization-documents-http.js', import.meta.url);
const original = await readFile(source, 'utf8');
const suite = fileURLToPath(new URL('../../../dist/apps/gateway/test/organization-documents-http.test.js', import.meta.url));
const mutations = [
  ['serve without delivery capability', 'SHU-301 private-delivery negative-control', 'runtime.service.deliver(session, runtime.origin + raw)', "runtime.service.deliver(session, (await runtime.service.issueDelivery(session, new URL(runtime.origin + raw).searchParams.get('documentId'))).url)"],
  ['leak storage URL', 'SHU-301 response-whitelist', 'return { id: value.id, type: value.type, mime: value.mime, size: value.size, version: value.version };', "return { id: value.id, type: value.type, mime: value.mime, size: value.size, version: value.version, storageKey: 'private/key', url: 'https://public.invalid/object' };"],
  ['drop Origin check', 'SHU-301 cross-site-upload', "request.headers.origin !== runtime.origin || request.headers['sec-fetch-site'] === 'cross-site'", "request.headers['sec-fetch-site'] === 'cross-site'"],
  ['expose ownership refusal', 'SHU-301 non-owner', "code === 'denied' ? 404 : code === 'invalid' ? 400 : 503", "code === 'denied' ? 403 : code === 'invalid' ? 400 : 503"],
];
function run(pattern, module) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern} `, suite], { encoding: 'utf8', env: { ...process.env, SHU301_TEST_MODULE: module }, timeout: 30000 });
  return { ...result, output: result.stdout + result.stderr };
}
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/apps/gateway/src/organization-documents-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const result = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.equal(result.error, undefined, `${name}: runner error`); assert.notEqual(result.status, 0, `${name} survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${pattern} `)); assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally { await unlink(target).catch(() => undefined); }
}
process.stdout.write('4/4 SHU-301 mutations killed\n');
