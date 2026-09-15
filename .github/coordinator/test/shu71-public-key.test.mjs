import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadShu71PublicKey, SHU71_PUBLIC_KEY_PATH } from '../shu71-public-key.mjs';
import { publicKeyFingerprint, validateAnchor as validateBoundAnchor, validateShu71Package } from '../shu71-activation-package.mjs';
import { validateTwoFixtureActivation } from '../two-fixture-activation.mjs';

const revision = 'a'.repeat(40);
const manifest = JSON.parse(fs.readFileSync(new URL('../shu71-trust-anchor.json', import.meta.url), 'utf8'));
const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const anchor = { ...manifest };
// Direct anchor checks require the same separate execution binding as the package.
function validateAnchor(value, key, checkout) {
  return validateBoundAnchor(value, key, checkout, undefined, { record: context().record, mainRevision: revision });
}
const pem = loadShu71PublicKey();
const fingerprint = '0cc5f24f46554bd25b713d78fca2f2bd48ab9b270d217a9dce613956d5786d5a';
// A public-only foreign Ed25519 SPKI, not a signing fixture.
const foreign = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + Buffer.alloc(32, 1).toString('base64') + '\n-----END PUBLIC KEY-----\n';

function context() {
  const fixtures = [config.fixture_lane, ...config.fixture_lanes].map((lane, i) => ({
    issue_id: lane.id, linear_id: `00000000-0000-4000-8000-00000000000${i}`,
    branch: `coordinator/${lane.id}`, seed_head: i ? '6c9c14907189fe3af733969c3d8f3a2c4e21f9b0' : 'b'.repeat(40), lane,
  }));
  const activation = { kind: 'two-fixture-v1', activation_id: 'public-source-proof', coordinator_revision: revision,
    slots: 2, expires_at: '2026-09-15T20:00:00.000Z', stop_before_merge: true,
    fixtures: fixtures.map(({ linear_id, ...entry }) => entry), gates: { reviewed: true, runtime: true }, signature: 'A'.repeat(86) + '==' };
  const before = { state_id: '00000000-0000-4000-8000-000000000003', assignee_id: null };
  const pkg = { kind: 'shu71-activation-package-v1', activation_id: activation.activation_id, coordinator_revision: revision,
    created_at: '2026-09-15T09:00:00.000Z', expires_at: activation.expires_at, slots: 2, stop_before_merge: true,
    merge_authority: 'none', fixtures, reseed: { issue_id: 'SHU-140', branch: 'coordinator/SHU-140',
      expected_parent: 'c'.repeat(40), expected_seed_head: fixtures[0].seed_head, patch_sha256: 'd'.repeat(64), append_only: true, force: false },
    issue_transitions: fixtures.map(({ issue_id, linear_id }) => ({ issue_id, linear_id, before, ready: before, restore: before })),
    cleanup: { worktree_root: '/srv/shu/worktrees', evidence_dir: '/srv/shu/state/shu71-evidence', coordinator_uid: 999,
      worker_uid: 995, reviewer_uid: 994, identity_bound: true, retain_evidence: true },
    evidence: { journal_path: `/srv/shu/state/shu71-evidence/${activation.activation_id}/journal.jsonl`,
      archive_path: `/srv/shu/state/shu71-evidence/${activation.activation_id}/activation.json`, append_only: true, retain_on_failure: true },
    activation, signature: activation.signature };
  return { pkg, anchor, revision, mainRevision: revision, now: new Date('2026-09-15T10:00:00Z'),
    config, record: activation, env: { ENABLE_DISPATCH: 'true' },
    heads: Object.fromEntries(fixtures.map(f => [f.branch, f.seed_head])),
    issues: fixtures.map(f => ({ ...f, id: f.issue_id, linearId: f.linear_id })) };
}

test('ACT_COMMITTED_ANCHOR_POSITIVE: real PEM validates and package reaches signature verification', () => {
  assert.equal(publicKeyFingerprint(pem), fingerprint, 'ACT_COMMITTED_FINGERPRINT');
  assert.deepEqual(validateAnchor(anchor, pem, revision), { ok: true }, 'ACT_COMMITTED_ANCHOR_POSITIVE');
  assert.equal(validateShu71Package(context()).code, 'ACT_FORGED_ENVELOPE', 'ACT_PACKAGE_PROCEEDS: unsigned control reaches signature verification');
  assert.equal(validateTwoFixtureActivation(context()).code, 'ACT_MANUAL_GATE_BYPASS', 'ACT_RUNTIME_PROCEEDS: unsigned control reaches signature verification');
  // A valid reviewed manifest cannot supply a missing execution authorization.
  assert.equal(validateBoundAnchor(manifest, pem, revision).code, 'ACT_TRUST_ANCHOR_INVALID', 'ACT_REVISION_UNBOUND: valid provenance cannot authorize execution');
  assert.equal(validateAnchor(anchor, pem, 'b'.repeat(40)).code, 'ACT_TRUST_ANCHOR_INVALID', 'ACT_REVISION_DRIFT');
});

test('ACT_FINGERPRINT_MUTATION: changed manifest digest refuses', () => {
  const changed = { ...anchor, spki_sha256: 'f'.repeat(64) };
  assert.equal(validateAnchor(changed, pem, revision).code, 'ACT_TRUST_ANCHOR_MISMATCH', 'ACT_FINGERPRINT_MUTATION');
  assert.equal(validateShu71Package({ ...context(), anchor: changed }).code, 'ACT_TRUST_ANCHOR_MISMATCH', 'ACT_FINGERPRINT_PACKAGE_MUTATION');
});

test('ACT_FOREIGN_KEY_MUTATION: self-appointed key and matching self-appointed manifest refuse', () => {
  assert.throws(() => loadShu71PublicKey(SHU71_PUBLIC_KEY_PATH, foreign), /ACT_TRUST_ANCHOR_MISMATCH:/, 'ACT_FOREIGN_KEY_MUTATION');
  assert.equal(validateAnchor({ ...anchor, spki_sha256: publicKeyFingerprint(foreign) }, foreign, revision).code,
    'ACT_TRUST_ANCHOR_MISMATCH', 'ACT_FOREIGN_KEY_MUTATION');
});

test('ACT_SOURCE_DIVERGENCE: either verifier supplied a foreign key refuses', () => {
  assert.equal(validateShu71Package({ ...context(), publicKeyPem: foreign }).code, 'ACT_TRUST_ANCHOR_MISMATCH', 'ACT_PACKAGE_SOURCE_DIVERGENCE');
  assert.equal(validateTwoFixtureActivation({ ...context(), config: { ...config, two_fixture_activation_public_key: foreign } }).code,
    'ACT_TRUST_ANCHOR_MISMATCH', 'ACT_RUNTIME_SOURCE_DIVERGENCE');
});

test('ACT_PUBLIC_KEY_PATH_MUTATION: unnamed, changed and dot-segment paths refuse', () => {
  assert.equal(SHU71_PUBLIC_KEY_PATH, fileURLToPath(new URL('../shu71-activation-public-key.pem', import.meta.url)), 'ACT_PUBLIC_KEY_PATH_PIN');
  for (const publicKeyPath of [null, '', '/tmp/foreign.pem', `${path.dirname(SHU71_PUBLIC_KEY_PATH)}/./shu71-activation-public-key.pem`, `${path.dirname(SHU71_PUBLIC_KEY_PATH)}/../shu71-activation-public-key.pem`]) {
    assert.throws(() => loadShu71PublicKey(publicKeyPath), /ACT_PUBLIC_KEY_PATH:/, 'ACT_PUBLIC_KEY_PATH_MUTATION');
    assert.equal(validateShu71Package({ ...context(), publicKeyPath }).code, 'ACT_PUBLIC_KEY_PATH', 'ACT_PACKAGE_PATH_PIN');
    assert.equal(validateTwoFixtureActivation({ ...context(), publicKeyPath }).code, 'ACT_PUBLIC_KEY_PATH', 'ACT_RUNTIME_PATH_PIN');
  }
});

test('ACT_PUBLIC_KEY_MISSING_MUTATION: absent committed file refuses by named assertion', () => {
  const root = fs.mkdtempSync('/tmp/shu71-missing-public-');
  try {
    fs.copyFileSync(new URL('../shu71-public-key.mjs', import.meta.url), path.join(root, 'shu71-public-key.mjs'));
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import assert from 'node:assert/strict'; import {loadShu71PublicKey} from './shu71-public-key.mjs'; assert.throws(() => loadShu71PublicKey(), /ACT_PUBLIC_KEY_PATH:/, 'ACT_PUBLIC_KEY_MISSING_MUTATION');"],
    { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `ACT_PUBLIC_KEY_MISSING_MUTATION: ${run.stderr}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [name, file, from, to, pattern] of [
  ['fingerprint comparison', 'shu71-activation-package.mjs', 'if (publicKeyFingerprint(publicKeyPem) !== anchor.spki_sha256)', 'if (false)', 'ACT_FINGERPRINT_MUTATION'],
  ['foreign key binding', 'shu71-public-key.mjs', 'suppliedPem === undefined || suppliedPem === pem', 'true', 'ACT_FOREIGN_KEY_MUTATION'],
  ['two-path divergence', 'shu71-public-key.mjs', 'suppliedPem === undefined || suppliedPem === pem', 'true', 'ACT_SOURCE_DIVERGENCE'],
  ['path binding', 'shu71-public-key.mjs', "typeof publicKeyPath === 'string'", "true || typeof publicKeyPath === 'string'", 'ACT_PUBLIC_KEY_PATH_MUTATION'],
]) test(`ACT_GUARD_MUTATION ${name}: named assertion kills removed binding`, () => {
  const root = fs.mkdtempSync('/tmp/shu71-public-mutant-');
  try {
    fs.cpSync(new URL('../', import.meta.url), root, { recursive: true });
    const target = path.join(root, file);
    const source = fs.readFileSync(target, 'utf8');
    assert.equal(source.split(from).length, 2, `${name}: unique mutation anchor`);
    fs.writeFileSync(target, source.replace(from, to));
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}:`, path.join(root, 'test/shu71-public-key.test.mjs')],
      { env, cwd: root, encoding: 'utf8', timeout: 30000 });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, `${name}: mutant must die\n${output}`);
    assert.match(output, /AssertionError/, `${name}: assertion required\n${output}`);
    assert.match(output, new RegExp(pattern), `${name}: named assertion required`);
    assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, `${name}: crashes do not count`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [label, invalidRevision] of [
  ['NULL', null], ['UNDEFINED', undefined], ['EMPTY', ''], ['NON_HEX_40', 'g'.repeat(40)],
]) test(`ACT_REVISION_${label}: non-conforming caller revision refuses`, () => {
  // Match the manifest binding so only the revision-format clause can refuse.
  const unbound = { ...manifest, provenance_revision: invalidRevision };
  assert.equal(validateAnchor(unbound, pem, invalidRevision).code, 'ACT_TRUST_ANCHOR_INVALID',
    `ACT_REVISION_${label}: non-conforming caller revision must refuse`);
});
