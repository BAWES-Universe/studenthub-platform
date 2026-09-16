import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RESEED_IDENTITY = Object.freeze({ name: 'shu-coordinator', email: 'shu-coordinator@bawes.local' });
export const RESEED_TIMESTAMP = Object.freeze(1735689600);
export const RESEED_TIMEZONE = Object.freeze('+0000');
export const RESEED_MESSAGE = Object.freeze('Append approved execution revision to sealed seed.\n');
export const SEALED_SEED_BLOBS = Object.freeze({
  'tools/fixture-conformance/scan-vacuous.expectations.mjs': '4d19f13e35b592971dc453321a79d1dd6dde4d2d',
  'tools/fixture/scan-vacuous.mjs': '6b18133a75c24c573892f9e229eb49420cd51466',
  'tools/fixture/test/scan-vacuous.test.mjs': 'e3abeb362a4d84195f8a3afac82a983930cf50ef',
  'tools/fixture-conformance/README.md': 'f614ea04e10a455a5ada3a077ff1e604aa8a19bd',
});
const OID = /^[0-9a-f]{40}$/;
const MODES = new Set(['100644', '100755', '120000']);
const ZERO = '0'.repeat(40);
function refuse(name) {
  const code = `SHU71_RESEED_${name}`;
  throw Object.assign(new Error(code), { code });
}
function requireOid(value) { if (!OID.test(value ?? '')) refuse('RESULT_SHA_MISMATCH'); }

// The runner is injected at the IO boundary. No shell, hooks, user configuration,
// replace refs, ambient object-store overrides, or optional index writes.
export function createGitAdapter(repo) {
  const cwd = fs.realpathSync(repo);
  return (args, { input, objectDirectory, code = 'UNEXPECTED_TREE' } = {}) => {
    const env = { PATH: process.env.PATH, LC_ALL: 'C', HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
    if (objectDirectory) {
      env.GIT_OBJECT_DIRECTORY = objectDirectory.directory;
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objectDirectory.alternates;
    }
    const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, input, maxBuffer: 128 * 1024 * 1024 });
    if (run.status !== 0) refuse(code); // Never propagate stderr or file contents.
    return run.stdout;
  };
}
const string = (git, args, options) => git(args, options).toString('utf8').trim();
function format(git) {
  if (string(git, ['rev-parse', '--show-object-format']) !== 'sha1') refuse('HASH_ALGORITHM');
}
function refFor(git, branch) {
  if (typeof branch !== 'string' || branch.startsWith('refs/')) refuse('NOT_APPEND_ONLY');
  const ref = `refs/heads/${branch}`;
  git(['check-ref-format', ref], { code: 'NOT_APPEND_ONLY' });
  return ref;
}

// -r -t includes traversal nodes so empty trees cannot disappear silently.
// Directories with leaves are structural; empty trees and gitlinks are refused.
// -z preserves every path byte, including tabs and newlines.
export function readTreeState(git, tree, options) {
  requireOid(tree);
  const bytes = git(['ls-tree', '-r', '-t', '-z', '--full-tree', tree], options);
  const entries = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    const tab = bytes.indexOf(9, start);
    if (end < 0 || tab < start || tab > end) refuse('UNEXPECTED_TREE');
    const [mode, type, oid] = bytes.subarray(start, tab).toString('ascii').split(' ');
    if (mode !== '040000' && !MODES.has(mode)) refuse('UNSUPPORTED_MODE');
    if ((mode === '040000' ? type !== 'tree' : type !== 'blob') || !OID.test(oid)) refuse('UNEXPECTED_TREE');
    entries.push({ path: Buffer.from(bytes.subarray(tab + 1, end)), mode, oid });
    start = end + 1;
  }
  for (const entry of entries.filter(e => e.mode === '040000')) {
    const prefix = Buffer.concat([entry.path, Buffer.from('/')]);
    if (!entries.some(e => e.mode !== '040000' && e.path.subarray(0, prefix.length).equals(prefix))) refuse('UNSUPPORTED_MODE');
  }
  return entries.filter(e => e.mode !== '040000');
}

export function canonicalManifest(before, after) {
  const index = (entries) => {
    const map = new Map();
    for (const entry of entries) {
      if (!MODES.has(entry.mode)) refuse('UNSUPPORTED_MODE');
      requireOid(entry.oid);
      const raw = Buffer.from(entry.path);
      if (!raw.length || raw.includes(0) || raw[0] === 47 || raw.toString().split('/').some(p => p === '.' || p === '..' || p === '')) refuse('UNEXPECTED_PATH');
      const key = raw.toString('hex');
      if (map.has(key)) refuse('UNEXPECTED_PATH');
      map.set(key, { ...entry, path: raw });
    }
    return map;
  };
  const old = index(before), next = index(after);
  const paths = [...new Set([...old.keys(), ...next.keys()])].map(key => Buffer.from(key, 'hex'));
  paths.sort(Buffer.compare);
  const parts = [];
  for (const raw of paths) {
    const key = raw.toString('hex'), a = old.get(key), b = next.get(key);
    if (a && b && a.mode === b.mode && a.oid === b.oid) continue;
    const status = !a ? 'A' : !b ? 'D' : 'M';
    // status NUL path NUL old_mode NUL old_oid NUL new_mode NUL new_oid NUL
    const fields = [status, raw, a?.mode ?? '000000', a?.oid ?? ZERO, b?.mode ?? '000000', b?.oid ?? ZERO];
    for (const field of fields) parts.push(Buffer.from(field), Buffer.from('\0'));
  }
  return Buffer.concat(parts);
}
export function manifestDigest(manifest) { return createHash('sha256').update(manifest).digest('hex'); }
export function serializeReseedCommit(tree, parent, revision) {
  [tree, parent, revision].forEach(requireOid);
  const identity = `${RESEED_IDENTITY.name} <${RESEED_IDENTITY.email}> ${RESEED_TIMESTAMP} ${RESEED_TIMEZONE}`;
  return Buffer.from(`tree ${tree}\nparent ${parent}\nparent ${revision}\nauthor ${identity}\ncommitter ${identity}\n\n${RESEED_MESSAGE}`);
}
function sealedCheck(state, sealed) {
  for (const [name, oid] of Object.entries(sealed)) {
    if (!state.some(entry => entry.path.equals(Buffer.from(name)) && entry.oid === oid)) refuse('SEED_BLOB_CHANGED');
  }
}
function merged(git, parent, revision, options = {}) {
  return string(git, ['merge-tree', '--write-tree', parent, revision], { ...options, code: 'CONFLICT' });
}
export function precomputeReseedBinding({ git, branch, expected_parent, approvedExecutionRevision, sealed = SEALED_SEED_BLOBS }) {
  format(git);
  [expected_parent, approvedExecutionRevision].forEach(requireOid);
  const ref = refFor(git, branch);
  if (string(git, ['rev-parse', '--verify', ref]) !== expected_parent) refuse('PARENT_MISMATCH');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-objects-'));
  try {
    // --git-path supports linked worktrees and bare repositories as well.
    const alternates = string(git, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
    const options = { objectDirectory: { directory, alternates: JSON.stringify(alternates) } };
    const tree = merged(git, expected_parent, approvedExecutionRevision, options);
    const before = readTreeState(git, expected_parent, options), after = readTreeState(git, tree, options);
    sealedCheck(before, sealed); sealedCheck(after, sealed);
    const manifest = canonicalManifest(before, after);
    const commit = serializeReseedCommit(tree, expected_parent, approvedExecutionRevision);
    const expected_seed_head = string(git, ['hash-object', '-t', 'commit', '--stdin'], { ...options, input: commit });
    return Object.freeze({ branch, expected_parent, approvedExecutionRevision, tree, expected_seed_head,
      patch_sha256: manifestDigest(manifest), manifest_hex: manifest.toString('hex') });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function verifyReseedCommit({ git, binding, oid, sealed = SEALED_SEED_BLOBS }) {
  const raw = git(['cat-file', 'commit', oid]);
  const header = raw.toString('utf8').split('\n\n')[0].split('\n');
  const parents = header.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.length !== 2 || parents[0] !== binding.expected_parent || parents[1] !== binding.approvedExecutionRevision) refuse('UNEXPECTED_PARENT');
  const tree = header[0]?.slice(5);
  if (header[0] !== `tree ${binding.tree}`) refuse('UNEXPECTED_TREE');
  if (!raw.equals(serializeReseedCommit(tree, parents[0], parents[1]))) refuse('METADATA_DRIFT');
  const before = readTreeState(git, binding.expected_parent), after = readTreeState(git, tree);
  sealedCheck(before, sealed); sealedCheck(after, sealed);
  const manifest = canonicalManifest(before, after);
  if (manifest.toString('hex') !== binding.manifest_hex) refuse('UNEXPECTED_PATH');
  if (manifestDigest(manifest) !== binding.patch_sha256) refuse('DIGEST_MISMATCH');
  if (oid !== binding.expected_seed_head || string(git, ['hash-object', '-t', 'commit', '--stdin'], { input: raw }) !== oid) refuse('RESULT_SHA_MISMATCH');
}

export function createReseedAppendIo({ git, binding, sealed = SEALED_SEED_BLOBS }) {
  binding = Object.freeze({ ...binding });
  sealed = Object.freeze({ ...sealed });
  const check = (plan) => {
    format(git);
    if (plan.append_only !== true || plan.force !== false || plan.branch !== binding.branch) refuse('NOT_APPEND_ONLY');
    if (plan.expected_parent !== binding.expected_parent) refuse('PARENT_MISMATCH');
    if (plan.expected_seed_head !== binding.expected_seed_head) refuse('RESULT_SHA_MISMATCH');
    if (plan.patch_sha256 !== binding.patch_sha256) refuse('DIGEST_MISMATCH');
    return refFor(git, plan.branch);
  };
  const result = () => ({ before: binding.expected_parent, after: binding.expected_seed_head,
    parent: binding.expected_parent, patch_sha256: binding.patch_sha256, forced: false });
  const verify = oid => verifyReseedCommit({ git, binding, oid, sealed });
  return Object.freeze({
    appendReseed(plan) {
      const ref = check(plan);
      if (string(git, ['rev-parse', '--verify', ref]) !== binding.expected_parent) refuse('PARENT_MISMATCH');
      const tree = merged(git, binding.expected_parent, binding.approvedExecutionRevision);
      if (tree !== binding.tree) refuse('UNEXPECTED_TREE');
      const commit = serializeReseedCommit(tree, binding.expected_parent, binding.approvedExecutionRevision);
      const oid = string(git, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: commit });
      if (oid !== binding.expected_seed_head) refuse('RESULT_SHA_MISMATCH');
      verify(oid);
      git(['merge-base', '--is-ancestor', binding.expected_parent, oid], { code: 'NOT_APPEND_ONLY' });
      // The only history mutation: install first, verify, then one compare-and-swap.
      git(['update-ref', ref, oid, binding.expected_parent], { code: 'NOT_APPEND_ONLY' });
      const observed = string(git, ['rev-parse', '--verify', ref]);
      verify(observed);
      return result();
    },
    observeReseed(plan) {
      const ref = check(plan);
      verify(string(git, ['rev-parse', '--verify', ref]));
      return result();
    },
  });
}
