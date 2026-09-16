import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as contract from '../reseed-append-contract.mjs';

const { createGitAdapter, precomputeReseedBinding, createReseedAppendIo, canonicalManifest,
  manifestDigest, serializeReseedCommit, verifyReseedCommit, readTreeState, SEALED_SEED_BLOBS } = contract;
const txt = b => b.toString().trim();
const oid = n => n.repeat(40);
const entry = (name, mode, hash) => ({ path: Buffer.isBuffer(name) ? name : Buffer.from(name), mode, oid: hash });
const old = [entry('gone', '100644', oid('1')), entry('z', '100644', oid('2'))];
const next = [entry('z', '100755', oid('3')), entry('a\t\n', '120000', oid('4'))];

// Independent implementation of the specification: no calls into the contract.
// Walk the union in byte order and feed all six fields individually to SHA256.
function independentDigest(before, after) {
  const names = [...before, ...after].map(e => e.path);
  const unique = names.filter((p, i) => names.findIndex(q => q.equals(p)) === i).sort((a, b) => Buffer.compare(a, b));
  const hash = createHash('sha256');
  for (const p of unique) {
    const a = before.find(e => e.path.equals(p)), b = after.find(e => e.path.equals(p));
    if (a && b && a.mode === b.mode && a.oid === b.oid) continue;
    for (const value of [!a ? 'A' : !b ? 'D' : 'M', p, a ? a.mode : '000000', a ? a.oid : '0'.repeat(40), b ? b.mode : '000000', b ? b.oid : '0'.repeat(40)]) {
      hash.update(value); hash.update(new Uint8Array([0]));
    }
  }
  return hash.digest('hex');
}

function run(repo, args, input) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, input, env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid',
    GIT_AUTHOR_DATE: '1735689600 +0000', GIT_COMMITTER_DATE: '1735689600 +0000' } });
  assert.equal(r.status, 0, `fixture git ${args[0]} succeeded`);
  return r.stdout;
}
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-contract-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  run(repo, ['init', '--object-format=sha1', '-b', 'base']);
  for (const [name, hash] of Object.entries(SEALED_SEED_BLOBS)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), run(process.cwd(), ['cat-file', 'blob', hash]));
  }
  fs.writeFileSync(path.join(repo, 'common'), 'base\n');
  run(repo, ['add', '.']); run(repo, ['commit', '-m', 'base']);
  const base = txt(run(repo, ['rev-parse', 'HEAD']));
  fs.writeFileSync(path.join(repo, 'left'), 'left\n');
  run(repo, ['add', '.']); run(repo, ['commit', '-m', 'left']);
  const parent = txt(run(repo, ['rev-parse', 'HEAD']));
  run(repo, ['branch', 'coordinator/SHU-140']);
  run(repo, ['checkout', '-b', 'approved', base]);
  fs.writeFileSync(path.join(repo, 'right'), 'right\n');
  run(repo, ['add', '.']); run(repo, ['commit', '-m', 'right']);
  const revision = txt(run(repo, ['rev-parse', 'HEAD']));
  const git = createGitAdapter(repo);
  const input = { git, branch: 'coordinator/SHU-140', expected_parent: parent, approvedExecutionRevision: revision };
  const binding = precomputeReseedBinding(input);
  const plan = { issue_id: 'SHU-140', branch: binding.branch, expected_parent: parent,
    expected_seed_head: binding.expected_seed_head, patch_sha256: binding.patch_sha256, append_only: true, force: false };
  return { repo, git, input, binding, plan, base, parent, revision };
}
function rejects(code, fn, message = code) {
  assert.throws(fn, error => error.code === `SHU71_RESEED_${code}` && error.message === error.code, message);
}
function snapshot(f) {
  return { refs: txt(f.git(['show-ref'])), objects: txt(f.git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])),
    counts: txt(f.git(['count-objects', '-v'])), status: txt(f.git(['status', '--porcelain'])) };
}
function install(f) { return createReseedAppendIo(f).appendReseed(f.plan); }
function inspect(f, binding = f.binding, id = binding.expected_seed_head) {
  return verifyReseedCommit({ git: f.git, binding, oid: id });
}

test('RESEED independent manifest literal and complete transition', () => {
  const literal = '23fd85b37240a6b4840999ae0861ac7aad7b6e789bcbea4d8f958de59be9d750';
  assert.equal(independentDigest(old, next), literal, 'RESEED independent literal');
  assert.equal(manifestDigest(canonicalManifest(old, next)), literal, 'RESEED canonical digest convention');
  assert.equal(canonicalManifest(old, old).length, 0, 'RESEED unchanged paths omitted');
});
test('RESEED blob OIDs are load bearing', () => {
  assert.equal(manifestDigest(canonicalManifest(old, next)), independentDigest(old, next), 'RESEED blob OIDs retained');
});
test('RESEED modes are load bearing', () => {
  assert.equal(manifestDigest(canonicalManifest(old, next)), independentDigest(old, next), 'RESEED modes retained');
});
test('RESEED raw path byte ordering', () => {
  const state = ['z', 'A', 'a/x', 'a.c', 'a-', 'a\t', 'a\n', Buffer.from([255]), 'é'].map(p => entry(p, '100644', oid('1')));
  assert.equal(manifestDigest(canonicalManifest([], state)), independentDigest([], state), 'RESEED raw byte order');
});
test('RESEED fixed timestamp literal', () => {
  assert.equal(contract.RESEED_TIMESTAMP, 1735689600, 'RESEED historical timestamp is fixed');
});
test('RESEED fixed message literal', () => {
  assert.equal(contract.RESEED_MESSAGE, 'Append approved execution revision to sealed seed.\n', 'RESEED message is fixed');
});
test('RESEED zero footprint precompute and exact append round trip', t => {
  const f = fixture(t), before = snapshot(f);
  const historical = f.git(['cat-file', 'commit', f.parent]);
  const binding = precomputeReseedBinding(f.input);
  assert.deepEqual(binding, f.binding, 'RESEED repeat precompute deterministic');
  assert.deepEqual(snapshot(f), before, 'RESEED precompute refs objects counts and worktree unchanged');
  const calls = [];
  const git = (args, options) => { calls.push(args); return f.git(args, options); };
  const result = createReseedAppendIo({ git, binding }).appendReseed(f.plan);
  assert.deepEqual(result, { before: f.parent, after: binding.expected_seed_head, parent: f.parent, patch_sha256: binding.patch_sha256, forced: false });
  assert.equal(calls.filter(a => a[0] === 'update-ref').length, 1, 'RESEED exactly one CAS');
  assert.ok(calls.findIndex(a => a[0] === 'hash-object' && a.includes('-w')) < calls.findIndex(a => a[0] === 'update-ref'), 'RESEED install precedes CAS');
  assert.equal(txt(f.git(['rev-parse', 'refs/heads/coordinator/SHU-140'])), binding.expected_seed_head, 'RESEED exact resulting SHA');
  const raw = f.git(['cat-file', 'commit', binding.expected_seed_head]);
  assert.deepEqual(raw, serializeReseedCommit(binding.tree, f.parent, f.revision), 'RESEED git commit bytes round trip');
  for (const write of [[], ['-w']]) assert.equal(txt(f.git(['hash-object', '-t', 'commit', ...write, '--stdin'], { input: raw })), binding.expected_seed_head);
  assert.deepEqual(f.git(['cat-file', 'commit', f.parent]), historical, 'RESEED prior history verbatim');
  f.git(['merge-base', '--is-ancestor', f.parent, binding.expected_seed_head]);
  assert.notEqual(f.parent, binding.expected_seed_head, 'RESEED strict fast forward');
  const a = readTreeState(f.git, f.parent), b = readTreeState(f.git, binding.tree);
  assert.equal(independentDigest(a, b), binding.patch_sha256, 'RESEED independent resulting digest');
  for (const [name, hash] of Object.entries(SEALED_SEED_BLOBS)) {
    assert.equal(txt(f.git(['rev-parse', `${binding.expected_seed_head}:${name}`])), hash);
    assert.deepEqual(f.git(['show', `${f.parent}:${name}`]), f.git(['show', `${binding.expected_seed_head}:${name}`]), 'RESEED sealed bytes preserved');
  }
  const objects = snapshot(f).objects;
  f.git(['merge-tree', '--write-tree', f.parent, f.revision]);
  assert.equal(snapshot(f).objects, objects, 'RESEED merge installation idempotent');
  assert.deepEqual(createReseedAppendIo(f).observeReseed(f.plan), result);
});
test('RESEED temporary merge takes objects while real store stays unchanged', t => {
  const f = fixture(t), before = snapshot(f);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-proof-'));
  try {
    const options = { objectDirectory: { directory: temp, alternates: path.join(f.repo, '.git/objects') } };
    f.git(['merge-tree', '--write-tree', f.parent, f.revision], options);
    assert.ok(fs.readdirSync(temp).some(n => /^[0-9a-f]{2}$/.test(n)), 'RESEED merge wrote temporary objects');
    assert.deepEqual(snapshot(f), before, 'RESEED real store unchanged by temporary merge');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('RESEED unexpected parents refused', t => {
  const f = fixture(t); install(f);
  rejects('UNEXPECTED_PARENT', () => inspect(f, { ...f.binding, approvedExecutionRevision: f.base }), 'RESEED wrong parent refused');
});
test('RESEED extra path refused', t => {
  const f = fixture(t); install(f);
  rejects('UNEXPECTED_PATH', () => inspect(f, { ...f.binding, manifest_hex: '' }), 'RESEED extra path refused');
});
test('RESEED named refusal matrix', t => {
  const f = fixture(t); install(f);
  rejects('UNEXPECTED_TREE', () => inspect(f, { ...f.binding, tree: f.base }));
  rejects('DIGEST_MISMATCH', () => inspect(f, { ...f.binding, patch_sha256: '0'.repeat(64) }));
  rejects('RESULT_SHA_MISMATCH', () => inspect(f, { ...f.binding, expected_seed_head: f.base }, f.binding.expected_seed_head));
  rejects('PARENT_MISMATCH', () => createReseedAppendIo(f).appendReseed(f.plan));
  rejects('NOT_APPEND_ONLY', () => createReseedAppendIo(f).appendReseed({ ...f.plan, force: true }));
  rejects('SEED_BLOB_CHANGED', () => verifyReseedCommit({ ...f, oid: f.binding.expected_seed_head, sealed: { common: oid('0') } }));
  const raw = serializeReseedCommit(f.binding.tree, f.parent, f.revision);
  const drift = Buffer.concat([raw, Buffer.from('extra\n')]);
  const driftId = txt(f.git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: drift }));
  rejects('METADATA_DRIFT', () => inspect(f, f.binding, driftId));
  for (const mode of ['040000', '160000', '100600']) rejects('UNSUPPORTED_MODE', () => canonicalManifest([], [entry('bad', mode, oid('1'))]));
  const git = (args, options) => args[0] === 'rev-parse' && args[1] === '--show-object-format' ? Buffer.from('sha256\n') : f.git(args, options);
  rejects('HASH_ALGORITHM', () => precomputeReseedBinding({ ...f.input, git }));
});
test('RESEED bad CAS leaves branch unchanged and unreachable objects harmless', t => {
  const f = fixture(t), calls = [];
  const git = (args, options) => {
    calls.push(args);
    if (args[0] === 'update-ref') return f.git([...args.slice(0, 3), f.base], options);
    return f.git(args, options);
  };
  rejects('NOT_APPEND_ONLY', () => createReseedAppendIo({ ...f, git }).appendReseed(f.plan));
  assert.equal(txt(f.git(['rev-parse', 'refs/heads/coordinator/SHU-140'])), f.parent, 'RESEED bad CAS leaves branch unchanged');
  assert.equal(calls.filter(a => a[0] === 'update-ref').length, 1);
  assert.equal(txt(f.git(['cat-file', '-t', f.binding.expected_seed_head])), 'commit', 'RESEED pre-CAS crash leaves installed object only');
});
test('RESEED dirty binding refused before ref update', t => {
  const f = fixture(t);
  for (const [field, value, code] of [['tree', f.base, 'UNEXPECTED_TREE'], ['expected_seed_head', f.base, 'RESULT_SHA_MISMATCH'], ['manifest_hex', '', 'UNEXPECTED_PATH'], ['patch_sha256', '0'.repeat(64), 'DIGEST_MISMATCH']]) {
    const binding = { ...f.binding, [field]: value }, plan = { ...f.plan };
    if (field in plan) plan[field] = value;
    rejects(code, () => createReseedAppendIo({ ...f, binding }).appendReseed(plan));
    assert.equal(txt(f.git(['rev-parse', 'refs/heads/coordinator/SHU-140'])), f.parent, 'RESEED refusal precedes history update');
  }
});
test('RESEED merge conflict has zero footprint', t => {
  const f = fixture(t);
  run(f.repo, ['checkout', 'coordinator/SHU-140']);
  fs.writeFileSync(path.join(f.repo, 'common'), 'left conflict\n');
  run(f.repo, ['add', '.']); run(f.repo, ['commit', '-m', 'conflicting left']);
  const parent = txt(f.git(['rev-parse', 'HEAD']));
  run(f.repo, ['checkout', 'approved']);
  fs.writeFileSync(path.join(f.repo, 'common'), 'right conflict\n');
  run(f.repo, ['add', '.']); run(f.repo, ['commit', '-m', 'conflicting right']);
  const revision = txt(f.git(['rev-parse', 'HEAD'])), before = snapshot(f);
  rejects('CONFLICT', () => precomputeReseedBinding({ ...f.input, expected_parent: parent, approvedExecutionRevision: revision }));
  assert.deepEqual(snapshot(f), before, 'RESEED conflicting precompute leaves no footprint');
});

test('RESEED real trees retain binary paths modes symlinks additions and deletions', t => {
  const f = fixture(t);
  run(f.repo, ['checkout', 'approved']);
  fs.unlinkSync(path.join(f.repo, 'common'));
  fs.chmodSync(path.join(f.repo, 'right'), 0o755);
  fs.symlinkSync('right', path.join(f.repo, 'link'));
  fs.writeFileSync(Buffer.concat([Buffer.from(f.repo + '/'), Buffer.from([255, 9, 10])]), 'binary path');
  run(f.repo, ['add', '.']); run(f.repo, ['commit', '-m', 'all transition types']);
  const revision = txt(f.git(['rev-parse', 'HEAD']));
  const binding = precomputeReseedBinding({ ...f.input, approvedExecutionRevision: revision });
  const plan = { ...f.plan, expected_seed_head: binding.expected_seed_head, patch_sha256: binding.patch_sha256 };
  createReseedAppendIo({ ...f, binding }).appendReseed(plan);
  const before = readTreeState(f.git, f.parent), after = readTreeState(f.git, binding.tree);
  assert.equal(independentDigest(before, after), binding.patch_sha256, 'RESEED raw real-tree transition agrees with independent spec');
  assert.equal(after.find(e => e.path.equals(Buffer.from('right'))).mode, '100755');
  assert.equal(after.find(e => e.path.equals(Buffer.from('link'))).mode, '120000');
  assert.ok(after.some(e => e.path.equals(Buffer.from([255, 9, 10]))));
  assert.ok(!after.some(e => e.path.equals(Buffer.from('common'))));
});
test('RESEED real gitlink empty tree and SHA256 repositories refused', t => {
  const f = fixture(t);
  const gitlink = txt(f.git(['mktree'], { input: Buffer.from(`160000 commit ${f.parent}\tmodule\n`) }));
  rejects('UNSUPPORTED_MODE', () => readTreeState(f.git, gitlink));
  const empty = txt(f.git(['mktree'], { input: Buffer.alloc(0) }));
  const tree = txt(f.git(['mktree'], { input: Buffer.from(`040000 tree ${empty}\tempty\n`) }));
  rejects('UNSUPPORTED_MODE', () => readTreeState(f.git, tree));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-sha256-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  run(repo, ['init', '--object-format=sha256']);
  rejects('HASH_ALGORITHM', () => precomputeReseedBinding({ ...f.input, git: createGitAdapter(repo) }));
});
test('RESEED all metadata headers and sealed drift refused before CAS', t => {
  const f = fixture(t); install(f);
  const raw = serializeReseedCommit(f.binding.tree, f.parent, f.revision).toString();
  assert.deepEqual(contract.RESEED_IDENTITY, { name: 'shu-coordinator', email: 'shu-coordinator@bawes.local' });
  assert.equal(contract.RESEED_TIMEZONE, '+0000');
  assert.ok(Object.isFrozen(SEALED_SEED_BLOBS) && Object.isFrozen(contract.RESEED_IDENTITY));
  for (const bytes of [raw.replace('author shu-', 'author other-'), raw.replace('committer shu-', 'committer other-'),
    raw.replace('1735689600', '1735689601'), raw.replace('+0000', '+0100'), raw.replace('\n\n', '\nencoding UTF-8\n\n'), raw + '\n']) {
    const id = txt(f.git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: Buffer.from(bytes) }));
    rejects('METADATA_DRIFT', () => inspect(f, f.binding, id));
  }
  run(f.repo, ['checkout', 'approved']);
  fs.writeFileSync(path.join(f.repo, Object.keys(SEALED_SEED_BLOBS)[0]), 'changed sealed fixture');
  run(f.repo, ['add', '.']); run(f.repo, ['commit', '-m', 'sealed drift']);
  const revision = txt(f.git(['rev-parse', 'HEAD']));
  rejects('SEED_BLOB_CHANGED', () => precomputeReseedBinding({ ...f.input, expected_parent: f.binding.expected_seed_head, approvedExecutionRevision: revision }));
});
test('RESEED linked worktree resolves real object storage without writes', t => {
  const f = fixture(t);
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-worktree-'));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const worktree = path.join(container, 'é checkout');
  run(f.repo, ['worktree', 'add', '--detach', worktree, f.revision]);
  const git = createGitAdapter(worktree), before = snapshot(f);
  assert.deepEqual(precomputeReseedBinding({ ...f.input, git }), f.binding, 'RESEED linked worktree same binding');
  assert.deepEqual(snapshot(f), before, 'RESEED shared real object store unchanged');
});

// Keep imports inside this control: isolated manifest mutation tests copy only
// this test file and the contract, and do not run the integration control.
test('RESEED command reaches RESEEDED with real append and refuses actual ref drift', async t => {
  const { sign } = await import('node:crypto');
  const { canonicalBytes, publicKeyFingerprint, runShu71Command } = await import('../shu71-activation-package.mjs');
  const { ephemeralPublicSource } = await import('./fixture/ephemeral-public-source.mjs');
  const testKeys = ephemeralPublicSource();
  const f = fixture(t); // Includes precomputeReseedBinding against the real temporary repo.
  const REVISION = f.revision, PARENT = f.parent;
  const SHU140_SEED = f.binding.expected_seed_head, PATCH = f.binding.patch_sha256;
  const SHU254_SEED = "6c9c14907189fe3af733969c3d8f3a2c4e21f9b0";
  const NOW = new Date("2026-09-15T10:00:00.000Z");
  const TODO = "68ef4514-566d-4ea8-8040-d933575b99d0";
  const BACKLOG = "d7847882-e3dc-42d3-8a81-4657d6161500";
  const KHALID = "48918d3d-f843-483f-bb23-2ba6c7ace499";
  const IDS = {
    "SHU-140": "3c2b8f0e-9608-477f-beb3-84d51b3dcb0f",
    "SHU-254": "8254e831-be6b-4d55-a99c-7f9437ac5981",
  };
  const { privateKey, publicKey } = testKeys;
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const lanes = {
    "SHU-140": { id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", note: "fixture",
      initial_build_paths: ["tools/fixture/scan-vacuous.mjs", "tools/fixture/test/scan-vacuous.test.mjs"],
      revision_paths: ["tools/fixture/scan-vacuous.mjs", "tools/fixture/test/scan-vacuous.test.mjs", "tools/fixture-conformance/scan-vacuous.expectations.mjs"],
      seeded_defect_path: "tools/fixture-conformance/scan-vacuous.expectations.mjs" },
    "SHU-254": { id: "SHU-254", authorization_ref: "SHU-254", note: "fixture",
      initial_build_paths: ["tools/fixture-2/scan-unawaited.mjs", "tools/fixture-2/test/scan-unawaited.test.mjs"],
      revision_paths: ["tools/fixture-2/scan-unawaited.mjs", "tools/fixture-2/test/scan-unawaited.test.mjs", "tools/fixture-2-conformance/scan-unawaited.expectations.mjs"],
      seeded_defect_path: "tools/fixture-2-conformance/scan-unawaited.expectations.mjs" },
  };
  const fixtures = [
    { issue_id: "SHU-140", linear_id: IDS["SHU-140"], branch: "coordinator/SHU-140", seed_head: SHU140_SEED, lane: lanes["SHU-140"] },
    { issue_id: "SHU-254", linear_id: IDS["SHU-254"], branch: "coordinator/SHU-254", seed_head: SHU254_SEED, lane: lanes["SHU-254"] },
  ];
  const activation = {
    kind: "two-fixture-v1", activation_id: "shu71-proof-20260915", coordinator_revision: REVISION,
    slots: 2, expires_at: "2026-09-15T20:00:00.000Z", stop_before_merge: true,
    fixtures: fixtures.map((entry) => ({ issue_id: entry.issue_id, branch: entry.branch, seed_head: entry.seed_head,
      lane: structuredClone(entry.lane) })), gates: { reviewed: true, runtime: true }, signature: "",
  };
  activation.signature = sign(null, canonicalBytes(activation), privateKey).toString("base64");
  const pkg = {
    kind: "shu71-activation-package-v1", activation_id: activation.activation_id, coordinator_revision: REVISION,
    created_at: "2026-09-15T09:00:00.000Z", expires_at: activation.expires_at, slots: 2,
    stop_before_merge: true, merge_authority: "none", fixtures,
    reseed: { issue_id: "SHU-140", branch: "coordinator/SHU-140", expected_parent: PARENT,
      expected_seed_head: SHU140_SEED, patch_sha256: PATCH, append_only: true, force: false },
    issue_transitions: [
      { issue_id: "SHU-140", linear_id: IDS["SHU-140"], before: { state_id: BACKLOG, assignee_id: KHALID },
        ready: { state_id: TODO, assignee_id: null }, restore: { state_id: BACKLOG, assignee_id: KHALID } },
      { issue_id: "SHU-254", linear_id: IDS["SHU-254"], before: { state_id: BACKLOG, assignee_id: null },
        ready: { state_id: TODO, assignee_id: null }, restore: { state_id: BACKLOG, assignee_id: null } },
    ],
    cleanup: { worktree_root: "/srv/shu/worktrees", evidence_dir: "/srv/shu/state/shu71-evidence",
      coordinator_uid: 999, worker_uid: 995, reviewer_uid: 994, identity_bound: true, retain_evidence: true },
    evidence: { journal_path: "/srv/shu/state/shu71-evidence/shu71-proof-20260915/journal.jsonl",
      archive_path: "/srv/shu/state/shu71-evidence/shu71-proof-20260915/activation.json", append_only: true, retain_on_failure: true },
    activation, signature: "",
  };
  pkg.signature = sign(null, canonicalBytes(pkg), privateKey).toString("base64");
  const anchor = { version: "1.0.0", algorithm: "Ed25519", provenance_revision: "e".repeat(40),
    spki_sha256: publicKeyFingerprint(publicKeyPem), state: "ready" };
  const issues = fixtures.map((entry) => ({ issue_id: entry.issue_id, linear_id: entry.linear_id }));
  const preparedHeads = { "coordinator/SHU-140": PARENT, "coordinator/SHU-254": SHU254_SEED };
  const context = { pkg, anchor, publicKeyPem, revision: REVISION, mainRevision: REVISION, heads: preparedHeads, issues, now: NOW };
  // Package shape follows shu71-activation-package.test.mjs. /srv paths are
  // validated strings only; all external effects below remain in memory.
  const events = [], unexpectedEffects = [];
  const unused = async () => { unexpectedEffects.push('unexpected non-reseed effect'); };
  const io = {
    ...createReseedAppendIo({ git: f.git, binding: f.binding }),
    appendEvidence: async event => { events.push(structuredClone(event)); },
    readIssue: unused, updateIssue: unused, installActivation: unused,
    setRuntimeGate: unused, archiveActivation: unused, cleanupFixtures: unused,
  };
  const ref = 'refs/heads/coordinator/SHU-140';
  assert.equal(context.heads['coordinator/SHU-140'], f.binding.expected_parent);
  assert.equal(txt(f.git(['rev-parse', ref])), f.binding.expected_parent);
  const result = await runShu71Command('reseed', { ...context, io });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'RESEEDED');
  assert.equal(txt(f.git(['rev-parse', ref])), f.binding.expected_seed_head);
  assert.deepEqual(events, [{
    version: '1.0.0', activation_id: pkg.activation_id, at: NOW.toISOString(),
    event: 'SHU140_RESEEDED', before: f.binding.expected_parent,
    after: f.binding.expected_seed_head, parent: f.binding.expected_parent,
    patch_sha256: f.binding.patch_sha256, forced: false,
  }]);

  // Drift to neither the approved parent nor the successful result. The same
  // signed context retains prepared heads, forcing the real adapter to refuse;
  // observeReseed must not recover this unrelated ref as a completed append.
  f.git(['update-ref', ref, f.base, f.binding.expected_seed_head]);
  assert.notEqual(f.base, f.binding.expected_parent);
  assert.notEqual(f.base, f.binding.expected_seed_head);
  const before = snapshot(f);
  const refused = await runShu71Command('reseed', { ...context, io });
  assert.equal(refused.ok, false);
  assert.notEqual(refused.state, 'RESEEDED');
  assert.equal(refused.state, 'HALT');
  assert.equal(refused.code, 'ACT_RESEED_FAILED');
  assert.equal(refused.detail, 'SHU71_RESEED_PARENT_MISMATCH');
  assert.equal(txt(f.git(['rev-parse', ref])), f.base);
  assert.deepEqual(snapshot(f), before, 'RESEED refused command leaves repository unchanged');
  assert.equal(events.length, 1, 'RESEED refusal appends no success evidence');
  assert.deepEqual(unexpectedEffects, [], 'RESEED performs no activation or issue effects');
});
