import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = new URL('../../../dist/packages/private-documents/src/personal-photo-source.js', import.meta.url);
const suite = fileURLToPath(new URL('./personal-photo-source.test.mjs', import.meta.url));
const original = await readFile(source, 'utf8');
const mutations = [
  ['skip the audit', 'PHOTO_READ', "await options.audit.recordView(", "void (", 'audited first'],
  ['serve after a failed audit', 'PHOTO_AUDIT', "await options.audit.recordView(", "options.audit.recordView(", 'no bytes without audit'],
  ['pick the first of two photos', 'PHOTO_NONE', 'rows.length === 1 ? rows[0] : undefined', 'rows[0]', 'two photos'],
  ['drop the declared size cap', 'PHOTO_NONE', '|| d.size > PERSONAL_PHOTO_MAX_BYTES)', ')', 'declared too large'],
  ['drop the stored size cap', 'PHOTO_NONE', 'bytes.length > PERSONAL_PHOTO_MAX_BYTES ? null :', 'false ? null :', 'stored too large'],
  ['allow any image type', 'PHOTO_NONE', '!MIMES.has(d.mime) ||', '', 'gif'],
  ['ignore the org', 'PHOTO_NONE', "d.scope.orgId === orgId && ", '', 'another org'],
  ['skip the hydrator', 'PHOTO_R2', '[documentReadHydrator]?.(d.id)', '[Symbol()]?.(d.id)', 'stored R2 bytes'],
];
const run = (moduleUrl, token) => {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^' + token + ' ', suite], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PHOTO_MODULE: moduleUrl } });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); return { ...r, output: r.stdout + r.stderr };
};
for (const [label, token, needle, replacement, message] of mutations) {
  assert.equal(original.split(needle).length - 1, 1, label + ': needle binds exactly once');
  const target = new URL(`../../../dist/packages/private-documents/src/personal-photo-source-mutant-${process.pid}.js`, import.meta.url);
  try {
    const control = run(source.href, token); assert.equal(control.status, 0, `${label}: passing control\n${control.output}`);
    await writeFile(target, original.replace(needle, replacement));
    const mutant = run(target.href, token); assert.notEqual(mutant.status, 0, `${label}: mutant must fail (${message})\n${mutant.output}`);
    console.log(`KILLED ${label} -> ${token}`);
  } finally { await unlink(target).catch(() => {}); }
}
