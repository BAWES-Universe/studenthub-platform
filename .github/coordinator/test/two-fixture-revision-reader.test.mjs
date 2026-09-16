import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { singleRunActivationStatus } from '../single-run-activation.mjs';
import { BROKER_GIT_CONFIG_ARGS, brokerGitEnv } from '../push-broker.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const realExec = cp.execFileSync;
const sha = 'a'.repeat(40);
function status(dir, revision = sha) {
  // Stop immediately AFTER execution binding: no signature, keys or enabled gates.
  const record = { kind: 'two-fixture-v1', activation_id: 'reader-test', coordinator_revision: revision,
    slots: 2, expires_at: '2026-09-14T12:00:00.000Z', stop_before_merge: true,
    fixtures: [config.fixture_lane, ...config.fixture_lanes].map(lane => ({ issue_id: lane.id,
      branch: `coordinator/${lane.id}`, seed_head: sha, lane })),
    gates: { reviewed: false, runtime: false }, signature: '' };
  return singleRunActivationStatus({ dir, config, filePath: 'in-memory-only', now: new Date('2026-09-14T11:00:00Z'),
    io: { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }),
      readFile: () => JSON.stringify(record), fixtureHeadResolver: () => sha } });
}
function sandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-reader-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function intercept(fn, body) {
  cp.execFileSync = fn; syncBuiltinESMExports();
  try { return body(); } finally { cp.execFileSync = realExec; syncBuiltinESMExports(); }
}
function repo(root, name = 'repo') {
  const dir = path.join(root, name); fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const nested = path.join(dir, 'coordinator', 'nested'); fs.mkdirSync(nested, { recursive: true });
  return { dir, nested };
}
const passedBinding = result => assert.equal(result.code, 'ACT_PARTIAL_ARMING', 'READER_BINDING: matching reads pass execution binding');

test('READER inline trust is exact and walks real nested checkout root', () => sandbox(root => {
  const r = repo(root); const link = path.join(root, 'alias'); fs.symlinkSync(r.nested, link);
  const calls = [];
  intercept((exe, args, options) => { calls.push({ exe, args, options }); return sha + '\n'; }, () => passedBinding(status(link)));
  const call = calls.find(c => c.args.includes('--verify'));
  assert.deepEqual(call.args, [...BROKER_GIT_CONFIG_ARGS, '-c', `safe.directory=${r.dir}`, '-C', link, 'rev-parse', '--verify', 'refs/heads/main'],
    'READER_EXACT_TRUST: inline exception must name only the real walked checkout root');
  assert.equal(call.exe, 'git');
  assert.deepEqual(call.options, { env: brokerGitEnv(process.env), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
}));

test('READER missing root fails closed without invoking git', () => sandbox(root => {
  let calls = 0;
  intercept(() => { calls++; return sha; }, () => {
    for (const dir of [root, path.join(root, 'missing')]) {
      const result = status(dir);
      assert.equal(result.reason, 'ACT_MALFORMED: ACT_EXECUTION_REVISION_WRONG', 'READER_NO_ROOT: unresolved root must refuse');
      assert.equal(result.state, 'refused');
    }
  });
  assert.equal(calls, 0, 'READER_NO_GIT: unresolved root must never invoke a permissive read');
}));

test('READER git failure returns null and refuses', () => sandbox(root => {
  const r = repo(root);
  intercept(() => { throw new Error('git failed'); }, () => {
    assert.equal(status(r.dir).reason, 'ACT_MALFORMED: ACT_EXECUTION_REVISION_WRONG');
  });
}));

function git(dir, ...args) {
  return realExec('git', [...BROKER_GIT_CONFIG_ARGS, '-C', dir, ...args], { env: brokerGitEnv(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function realRepo(root, name) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, '-c', 'user.name=Reader Test', '-c', 'user.email=reader@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', name);
  return { dir, revision: git(dir, 'rev-parse', 'HEAD') };
}

test('READER ownership rejection hook requires inline trust', () => sandbox(root => {
  const r = realRepo(root, 'owned'); const nested = path.join(r.dir, 'nested'); fs.mkdirSync(nested);
  const before = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  try {
    assert.throws(() => git(nested, 'rev-parse', '--verify', 'refs/heads/main'), /dubious ownership/, 'READER_OWNERSHIP_CONTROL: untrusted Git must fail');
    const result = status(nested, r.revision);
    assert.equal(result.code, 'ACT_PARTIAL_ARMING', 'READER_OWNERSHIP: inline trust must resolve main under ownership rejection');
  } finally {
    if (before === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = before;
  }
}));

test('READER operator-owned checkout read by non-root account', { skip: process.getuid?.() !== 0 ? 'Not exercisable: non-root account, no passwordless elevation to create root-owned checkout' : false }, () => sandbox(root => {
  const r = realRepo(root, 'root-owned'); fs.chmodSync(root, 0o755);
  const args = [...BROKER_GIT_CONFIG_ARGS, '-C', r.dir, 'rev-parse', '--verify', 'refs/heads/main'];
  const options = { uid: 65534, gid: 65534, env: brokerGitEnv(process.env), encoding: 'utf8' };
  assert.notEqual(cp.spawnSync('git', args, options).status, 0, 'READER_REAL_OWNER_CONTROL');
  const out = cp.spawnSync('git', ['-c', `safe.directory=${r.dir}`, ...args], options);
  assert.equal(out.status, 0, 'READER_REAL_OWNER: scoped trust permits non-root reader');
  assert.equal(out.stdout.trim(), r.revision);
}));

test('READER wrong checkout and directory substitution retain binding', () => sandbox(root => {
  const a = realRepo(root, 'bound'); const b = realRepo(root, 'other');
  passedBinding(status(a.dir, a.revision));
  const result = status(b.dir, a.revision);
  assert.equal(result.state, 'refused');
  assert.equal(result.reason, 'ACT_MALFORMED: ACT_EXECUTION_REVISION_WRONG');
  const nested = path.join(a.dir, 'substitute'); fs.mkdirSync(nested);
  passedBinding(status(nested, a.revision));
}));

test('READER stale main ref refuses execution revision', () => sandbox(root => {
  const r = realRepo(root, 'stale'); passedBinding(status(r.dir, r.revision));
  git(r.dir, 'checkout', '--detach');
  git(r.dir, '-c', 'user.name=Reader Test', '-c', 'user.email=reader@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'advance');
  const head = git(r.dir, 'rev-parse', 'HEAD');
  assert.equal(status(r.dir, head).reason, 'ACT_MALFORMED: ACT_EXECUTION_REVISION_WRONG');
}));

test('READER checkout drift refuses observed revision', () => sandbox(root => {
  const r = realRepo(root, 'drift'); passedBinding(status(r.dir, r.revision));
  git(r.dir, 'checkout', '--detach');
  git(r.dir, '-c', 'user.name=Reader Test', '-c', 'user.email=reader@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'drift');
  assert.equal(status(r.dir, r.revision).reason, 'ACT_MALFORMED: ACT_CHECKOUT_DRIFT');
}));

const inline = '"-c", `safe.directory=${checkoutRoot}`, "-C", dir';
const walk = 'while (!fs.existsSync(path.join(checkoutRoot, ".git"))) {\n          const parent = path.dirname(checkoutRoot);\n          if (parent === checkoutRoot) return null;\n          checkoutRoot = parent;\n        }';
const mutations = [
  ['drop inline exception', inline, '"-C", dir', 'READER ownership rejection hook', 'READER_OWNERSHIP: inline trust must resolve main under ownership rejection'],
  ['wildcard trust', inline, '"-c", "safe.directory=*", "-C", dir', 'READER inline trust', 'READER_EXACT_TRUST: inline exception must name only the real walked checkout root'],
  ['permissive unresolved-root fallback', '          if (parent === checkoutRoot) return null;', '          if (parent === checkoutRoot) break;', 'READER missing root', 'READER_NO_ROOT: unresolved root must refuse'],
  ['skip root walk-up', walk, '', 'READER inline trust', 'READER_EXACT_TRUST: inline exception must name only the real walked checkout root'],
];
for (const [name, from, to, pattern, message] of mutations) test(`READER mutation: ${name}`, () => sandbox(root => {
  fs.cpSync(new URL('../', import.meta.url), root, { recursive: true });
  const target = path.join(root, 'single-run-activation.mjs'); const original = fs.readFileSync(target, 'utf8');
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = () => cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern}`, path.join(root, 'test/two-fixture-revision-reader.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  const control = run(); const controlText = control.stdout + control.stderr;
  assert.equal(control.status, 0, controlText);
  assert.match(controlText, /# pass 1\n/); assert.match(controlText, /# fail 0\n/);
  assert.equal(original.split(from).length, 2, `${name}: exactly one unique textual replacement`);
  fs.writeFileSync(target, original.replace(from, to));
  const syntax = cp.spawnSync(process.execPath, ['--check', target], { env, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const mutant = run(); const output = mutant.stdout + mutant.stderr;
  assert.equal(mutant.status, 1, output);
  assert.match(output, /# fail 1\n/);
  assert.ok(output.includes(message), output);
  assert.match(output, /code: 'ERR_ASSERTION'/);
  assert.match(output, /failureType: 'testCodeFailure'/);
  assert.match(output, /name: 'AssertionError'/);
  assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/);
}));
