// Mutation check for the M-2 promotion step: each guard, removed from the built module, must fail
// its named PostgreSQL test. Needs DATABASE_URL (as the CI test job has); without it every mutant
// is reported SKIP, like the suite it drives.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = new URL('../../../dist/packages/private-documents/src/legacy-promotion.js', import.meta.url);
const suite = fileURLToPath(new URL('./legacy-promotion.test.mjs', import.meta.url));
const original = await readFile(source, 'utf8');
const mutations = [
  ['replay not checked against the record', 'PROMO-01', "if (await ledgered(sql, principalId, staged.kind))\n                    return 'alreadyPromoted';", ''],
  ['written object not read back', 'PROMO-01', 'readBackObjects(options.objects)', 'options.objects'],
  ['slot history ignored', 'PROMO-02', 'slot.rowCount !== 0 || ', ''],
  ['upload in progress ignored', 'PROMO-03', '&& t.expiresAt > now)', '&& false)'],
  ['link not rechecked', 'PROMO-04', "if (link.rows[0].legacy_candidate_id !== staged.legacyId)\n                    return 'linkChanged';", ''],
  ['staged row not rechecked', 'PROMO-04', "if (!await sameStaged(sql, staged))\n                    return 'stagedChanged';", ''],
  ['bytes not checked against the staged digest', 'PROMO-04', ' || sha(bytes) !== staged.sha256)', ')'],
  ['ids not derived (a retry names another object)', 'PROMO-05', "version: derivedUuid('legacy-document-version-v1', parts)", "version: derivedUuid('legacy-document-version-v1', [...parts, String(Math.random())])"],
];
if (!process.env.DATABASE_URL) {
  for (const [label, token] of mutations) console.log(`SKIP ${label}: DATABASE_URL not set (${token})`);
  process.exit(0);
}
const run = (moduleUrl, token) => {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^' + token + ' ', suite], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PROMO_MODULE: moduleUrl } });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); return { ...r, output: r.stdout + r.stderr };
};
let killed = 0;
for (const [label, token, needle, replacement] of mutations) {
  assert.equal(original.split(needle).length - 1, 1, label + ': needle binds exactly once');
  const target = new URL(`../../../dist/packages/private-documents/src/legacy-promotion-mutant-${process.pid}.js`, import.meta.url);
  try {
    const control = run(source.href, token); assert.equal(control.status, 0, `${label}: passing control\n${control.output}`);
    assert.match(control.output, /# pass [1-9]/, `${label}: the control ran the test`);
    await writeFile(target, original.replace(needle, replacement));
    const mutant = run(target.href, token); assert.notEqual(mutant.status, 0, `${label}: mutant must fail\n${mutant.output}`);
    console.log(`KILLED ${label} -> ${token}`);killed++;
  } finally { await unlink(target).catch(() => {}); }
}
console.log(`${killed}/${mutations.length} promotion mutations killed`);
