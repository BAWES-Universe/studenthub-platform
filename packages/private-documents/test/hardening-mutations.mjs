import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../../../dist/packages/private-documents/src/index.js', import.meta.url);
const original = await readFile(source, 'utf8');
const testFile = fileURLToPath(new URL('./hardening.test.mjs', import.meta.url));
const mutations = [
  ['M1 lock close failure skips unlink', 'NC-LOCK-RELEASE', 'await lock.close().catch(() => undefined);', 'await lock.close();'],
  ['M2 replace scope and type check removed', 'AC-REPLACE-IMMUTABLE', "if (data.type !== previous.type || data.scope.orgId !== previous.scope.orgId || data.scope.personId !== previous.scope.personId)", 'if (false)'],
  ['M3 state hardlink check removed', 'NC-FS-NLINK', 'stat.nlink !== 1', 'false'],
  ['M4 root integrity check removed', 'NC-FS-ROOT', "if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())", 'if (false)'],
  ['M5 signing key minimum removed', 'NC-CONFIG', 'options.signingKey.byteLength < 32', 'false'],
  ['M6 stored record revalidation removed', 'NC-STORE-RECORD', "uploadOf({ scope: d.scope, type: d.type, mime: d.mime, bytes, acl: d.acl });", 'void d;'],
  ['M7 stored byte length check removed', 'NC-STORE-SIZE', "bytes.toString('base64') !== d.data || bytes.length !== d.size", "bytes.toString('base64') !== d.data"],
  ['M8 credential shape guard removed', 'NC-CRED-TYPE', "if (typeof credential !== 'string' || credential.length === 0 || credential.length > 8192)", 'if (false)'],
  ['M9 issue-time check removed', 'NC-CLOCK-REWIND', 'Number(claim.iat) > now', 'false'],
  ['M10 retired records included in lookup', 'NC-RETIRED-UNREACHABLE', 'const d = state.documents.find(d => d.id === id);', 'const d = [...state.documents, ...state.retired].find(d => d.id === id);'],
];

for (const [mutation, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${mutation}: source marker must bind exactly once`);
  const target = new URL(`./shu236-mutation-${process.pid}.js`, source);
  try {
    await writeFile(target, original.replace(from, to));
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern} `, testFile],
      {
        encoding: 'utf8',
        env: { ...process.env, SHU236_TEST_MODULE: target.href },
        timeout: 30_000,
      },
    );
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${mutation}: test process failed to run`);
    assert.notEqual(result.status, 0, `${mutation} survived`);
    assert.match(output, new RegExp(`not ok [0-9]+ - ${pattern} `), `${mutation}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation}: infrastructure failure is not a kill`);
    console.log(`KILLED ${mutation} -> ${pattern}`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}
console.log(`${mutations.length}/${mutations.length} SHU-236 mutations killed`);
