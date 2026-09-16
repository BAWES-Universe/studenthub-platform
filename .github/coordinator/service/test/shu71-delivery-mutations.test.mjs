import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const cases = [
  ['child allowlist replaced by denylist', 'credential-delivery.mjs', 'allowed.has(key)', "!['SHU_SUPERVISOR_SECRET', 'GITHUB_TOKEN', 'GH_TOKEN', 'LINEAR_API_TOKEN', 'CREDENTIALS_DIRECTORY'].includes(key)", m => {
    assert.deepEqual(m.supervisorChildEnvironment({ github_token: 'poison', GITHUB_PAT: 'poison', UNKNOWN: 'poison' }), {}, 'B2_EXACT_ALLOWLIST');
  }],
  ['environment secret validation bypassed', 'credential-delivery.mjs', 'return checkedSecret(env.SHU_SUPERVISOR_SECRET)', 'return env.SHU_SUPERVISOR_SECRET', m => {
    assert.throws(() => m.supervisorTransportSecret({ SHU_SUPERVISOR_SECRET: 'short' }), /ACT_CREDENTIAL_UNAVAILABLE/, 'B2_ENV_SECRET_STRENGTH');
  }],
  ['child retains transport secret', 'credential-delivery.mjs', "'PATH', 'HOME'", "'SHU_SUPERVISOR_SECRET', 'PATH', 'HOME'", m => {
    assert.equal(m.supervisorChildEnvironment({ SHU_SUPERVISOR_SECRET: 'poison' }).SHU_SUPERVISOR_SECRET, undefined, 'B2_NO_CHILD_TRANSPORT_SECRET');
  }],
  ['child retains GitHub token', 'credential-delivery.mjs', "'PATH', 'HOME'", "'GITHUB_TOKEN', 'PATH', 'HOME'", m => {
    assert.equal(m.supervisorChildEnvironment({ GITHUB_TOKEN: 'poison' }).GITHUB_TOKEN, undefined, 'B2_NO_CHILD_GITHUB_TOKEN');
  }],
  ['child retains Linear token', 'credential-delivery.mjs', "'PATH', 'HOME'", "'LINEAR_API_TOKEN', 'PATH', 'HOME'", m => {
    assert.equal(m.supervisorChildEnvironment({ LINEAR_API_TOKEN: 'poison' }).LINEAR_API_TOKEN, undefined, 'B2_NO_CHILD_LINEAR_TOKEN');
  }],
  ['transport accepts foreign credential directory', 'credential-delivery.mjs', "if (env.CREDENTIALS_DIRECTORY !== '/run/credentials/shu-coordinator.service')", "if (false)", m => {
    assert.throws(() => m.supervisorTransportSecret({ CREDENTIALS_DIRECTORY: '/tmp/foreign' }, () => `SHU_SUPERVISOR_SECRET=${'x'.repeat(32)}`), /ACT_CREDENTIAL_UNAVAILABLE/, 'B2_FIXED_CREDENTIAL_DIRECTORY');
  }],
  ['transport allows short secret', 'credential-delivery.mjs', 'Buffer.byteLength(value) < 32', 'Buffer.byteLength(value) < 1', m => {
    assert.throws(() => m.supervisorTransportSecret({ CREDENTIALS_DIRECTORY: '/run/credentials/shu-coordinator.service' }, () => 'SHU_SUPERVISOR_SECRET=short'), /ACT_CREDENTIAL_UNAVAILABLE/, 'B2_SECRET_STRENGTH');
  }],
  ['tick omits activation argv', 'coordinator-tick.mjs', "return env.ENABLE_DISPATCH === 'true'", 'return false', m => {
    assert.deepEqual(m.coordinatorTickArgs(['--activation', '/srv/shu/state/shu71-activation.json'], { ENABLE_DISPATCH: 'true' }), ['--activation', '/srv/shu/state/shu71-activation.json'], 'B2_ACTIVATION_ARGV');
  }],
];
for (const [name, file, before, after, check] of cases) test(`B2 mutation: ${name}`, async t => {
  const url = new URL(`../${file}`, import.meta.url), source = fs.readFileSync(url, 'utf8');
  check(await import(url));
  assert.equal(source.split(before).length, 2, 'B2_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-delivery-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mutated = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, url).href}${quote}`);
  const target = path.join(root, file); fs.writeFileSync(target, mutated);
  const m = await import(pathToFileURL(target));
  assert.throws(() => check(m), error => error.code === 'ERR_ASSERTION' && /B2_/.test(error.message), 'B2_MUTATION_NAMED_ASSERTION');
});
