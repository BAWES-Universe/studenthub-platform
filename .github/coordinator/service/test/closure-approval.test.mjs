import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sign, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as api from '../compose-shu71-approval.mjs';
import { harness } from '../../test/fixture/shu71-package.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
function fixture() {
  const { context } = harness(keys), { pkg, anchor, publicKeyPem, revision } = context;
  return { pkg, anchor, publicKeyPem, revision, activationId: pkg.activation_id, checkout: '/srv/shu/repo', tree: 'd'.repeat(40),
    binding: { branch: pkg.reseed.branch, expected_parent: pkg.reseed.expected_parent,
      expected_seed_head: pkg.reseed.expected_seed_head, patch_sha256: pkg.reseed.patch_sha256,
      approvedExecutionRevision: revision, tree: 'e'.repeat(40), manifest_hex: '' } };
}
function controls(module = api) {
  const input = fixture(), expected = module.composeApproval(input);
  const doc = { payload: expected.payload, signature: sign(null, expected.bytes, keys.privateKey).toString('base64') };
  const owner = keys.publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(module.validateApproval(doc, expected, owner, expected.sha256).ok, true, 'CLOSURE_APPROVAL_VALID');
  assert.equal(module.composeApproval(input).sha256, expected.sha256, 'CLOSURE_APPROVAL_DETERMINISTIC');
  const unsigned = structuredClone(input); unsigned.pkg.signature = ''; unsigned.pkg.activation.signature = '';
  assert.equal(module.composeApproval(unsigned).sha256, expected.sha256, 'CLOSURE_NO_EXTRA_SIGNING_PREREQUISITE');
  assert.throws(() => module.validateApproval(doc, expected, owner, '0'.repeat(64)), { code: 'CLOSURE_APPROVAL_DIGEST' }, 'CLOSURE_WRONG_DIGEST');
  const foreign = generateKeyPairSync('ed25519');
  const forged = { ...doc, signature: sign(null, expected.bytes, foreign.privateKey).toString('base64') };
  assert.throws(() => module.validateApproval(forged, expected, owner, expected.sha256), { code: 'CLOSURE_APPROVAL_FOREIGN_KEY' }, 'CLOSURE_FOREIGN_KEY');
  assert.throws(() => module.composeApproval({ ...input, revision: 'f'.repeat(40) }), { code: 'CLOSURE_APPROVAL_STALE_REVISION' }, 'CLOSURE_STALE_REVISION');
  const missing = structuredClone(input); missing.pkg.fixtures.pop();
  assert.throws(() => module.composeApproval(missing), { code: 'CLOSURE_APPROVAL_MISSING_FIXTURE' }, 'CLOSURE_MISSING_FIXTURE');
  return expected;
}
test('CLOSURE_APPROVAL deterministic canonical artifact and named refusals', t => {
  const expected = controls();
  t.diagnostic(`SYNTHETIC_CANONICAL_SHA256=${expected.sha256}`);
  const evidence = new URL('../execution-closure-evidence/synthetic-approval.canonical.json', import.meta.url);
  assert.equal(fs.readFileSync(evidence, 'utf8'), expected.bytes.toString(), 'CLOSURE_COMMITTED_CANONICAL_BYTES');
});
const mutations = [
  ['wrong digest accepted', "export function validateApproval(doc, expected, ownerKey, expectedDigest) {", "export function validateApproval(doc, expected, ownerKey, expectedDigest) { expectedDigest = expected.sha256;", 'CLOSURE_WRONG_DIGEST'],
  ['foreign key accepted', "need(authentic, 'CLOSURE_APPROVAL_FOREIGN_KEY');", '', 'CLOSURE_FOREIGN_KEY'],
  ['stale revision accepted', "pkg?.coordinator_revision === revision && pkg?.activation?.coordinator_revision === revision\n    && binding?.approvedExecutionRevision === revision", 'true', 'CLOSURE_STALE_REVISION'],
  ['missing fixture accepted', "Array.isArray(pkg.fixtures) && pkg.fixtures.length === 2\n    && same(pkg.fixtures.map(f => f.issue_id).sort(), ['SHU-140', 'SHU-254'])", 'true', 'CLOSURE_MISSING_FIXTURE'],
];
for (const [label, from, to, assertion] of mutations) test(`CLOSURE_APPROVAL mutation ${label}`, async t => {
  controls();
  const sourceURL = new URL('../compose-shu71-approval.mjs', import.meta.url);
  const source = fs.readFileSync(sourceURL, 'utf8').replace(/from '([^']+)'/g, (all, name) => name.startsWith('.') ? `from '${new URL(name, sourceURL).href}'` : all);
  assert.equal(source.split(from).length, 2, 'CLOSURE_UNIQUE_MUTATION');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs'); fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'CLOSURE_MUTANT_SYNTAX');
  const mutant = await import(pathToFileURL(file));
  assert.throws(() => controls(mutant), e => e.code === 'ERR_ASSERTION' && e.message.includes(assertion), assertion);
});

test('CLOSURE_APPROVAL real Git compose seal validate entrypoints', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-compose-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => {
    const r = spawnSync('/usr/bin/git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' } });
    assert.equal(r.status, 0, 'CLOSURE_LOCAL_GIT'); return r.stdout.trim();
  };
  git(['init', '-b', 'main']);
  const locations = ['tools/fixture-conformance/scan-vacuous.expectations.mjs', 'tools/fixture/scan-vacuous.mjs',
    'tools/fixture/test/scan-vacuous.test.mjs', 'tools/fixture-conformance/README.md'];
  for (const name of locations) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(new URL(`./fixtures/closure-seed/${path.basename(name)}`, import.meta.url), path.join(root, name));
  }
  git(['add', '.']); git(['commit', '-m', 'sealed test seed']);
  const parent = git(['rev-parse', 'HEAD']); git(['branch', 'coordinator/SHU-140']);
  const input = fixture(), folder = path.join(root, '.github/coordinator'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'shu71-activation-public-key.pem'), input.publicKeyPem);
  fs.writeFileSync(path.join(folder, 'shu71-trust-anchor.json'), JSON.stringify(input.anchor));
  fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ fixture_lane: input.pkg.fixtures[0].lane, fixture_lanes: [input.pkg.fixtures[1].lane] }));
  git(['add', '.']); git(['commit', '-m', 'settled synthetic revision']); const revision = git(['rev-parse', 'HEAD']);
  const binding = precomputeReseedBinding({ git: createGitAdapter(root), branch: 'coordinator/SHU-140', expected_parent: parent, approvedExecutionRevision: revision });
  const pkg = input.pkg; pkg.coordinator_revision = revision; pkg.activation.coordinator_revision = revision;
  Object.assign(pkg.reseed, { expected_parent: parent, expected_seed_head: binding.expected_seed_head, patch_sha256: binding.patch_sha256 });
  pkg.fixtures[0].seed_head = binding.expected_seed_head; pkg.activation.fixtures[0].seed_head = binding.expected_seed_head;
  pkg.signature = ''; pkg.activation.signature = '';
  const packageFile = path.join(root, 'settled.json'), prefix = path.join(root, 'approval'); fs.writeFileSync(packageFile, JSON.stringify(pkg));
  const args = [root, revision, pkg.activation_id, packageFile, '/srv/shu/repo', prefix];
  assert.equal(api.main(['compose', ...args]).signed, false, 'CLOSURE_CLI_COMPOSE');
  const bytes = fs.readFileSync(`${prefix}.canonical.json`), signature = path.join(root, 'owner.sig'), owner = path.join(root, 'owner.pub');
  fs.writeFileSync(signature, sign(null, bytes, keys.privateKey)); fs.writeFileSync(owner, input.publicKeyPem);
  assert.equal(api.main(['seal', ...args, signature, owner]).ok, true, 'CLOSURE_CLI_SEAL');
  assert.equal(api.main(['validate', ...args, `${prefix}.shu71.json`, owner]).ok, true, 'CLOSURE_CLI_VALIDATE');
  fs.writeFileSync(`${prefix}.sha256`, '0'.repeat(64));
  assert.throws(() => api.main(['validate', ...args, `${prefix}.shu71.json`, owner]), { code: 'CLOSURE_APPROVAL_DIGEST' }, 'CLOSURE_CLI_DIGEST');
});
import { createGitAdapter, precomputeReseedBinding } from '../../reseed-append-contract.mjs';
