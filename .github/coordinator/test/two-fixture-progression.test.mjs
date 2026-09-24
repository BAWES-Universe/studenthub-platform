import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, sign } from 'node:crypto';
import { ephemeralPublicSource } from './fixture/ephemeral-public-source.mjs';
import { twoFixtureConfig } from './fixture/two-fixture-config.mjs';
import { reviewedActivationBytes } from '../two-fixture-activation.mjs';
import { singleRunActivationStatus } from '../single-run-activation.mjs';
import { createReceipt, receiptCommentBody, parseReceiptsFromComments, validateReceipt } from '../reconcile.mjs';
import { pushExactSha } from '../push-broker.mjs';
import { readProgressionPush } from '../two-fixture-progression.mjs';
const { privateKey, publicKey } = ephemeralPublicSource();

function harness() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'b3-progression-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
  const wt = path.join(root, 'worker'), home = path.join(root, 'codex'), state = path.join(home, 'coordinator-runs');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  git(root, 'init', wt); git(wt, 'config', 'user.name', 'Isolated B3'); git(wt, 'config', 'user.email', 'b3@example.invalid');
  fs.writeFileSync(path.join(wt, 'content'), 'seed'); git(wt, 'add', '.'); git(wt, 'commit', '-m', 'seed');
  const seed = git(wt, 'rev-parse', 'HEAD');
  const remote = path.join(root, 'BAWES-Universe', 'studenthub-platform.git');
  fs.mkdirSync(path.dirname(remote)); git(root, 'init', '--bare', remote);
  // Two-fixture world stated explicitly: the committed config is now the
  // one-fixture demonstration scope and no longer describes this harness.
  const config = twoFixtureConfig();
  config.two_fixture_activation_public_key = publicKey.export({ type: 'spki', format: 'pem' });
  const record = { kind: 'two-fixture-v1', activation_id: 'b3-progression-test', coordinator_revision: 'a'.repeat(40),
    slots: 2, expires_at: '2026-09-14T12:00:00.000Z', stop_before_merge: true,
    fixtures: [config.fixture_lane, ...config.fixture_lanes].map(lane => ({ issue_id: lane.id, branch: `coordinator/${lane.id}`, seed_head: seed, lane })),
    gates: { reviewed: true, runtime: true }, signature: '' };
  record.signature = sign(null, reviewedActivationBytes(record), privateKey).toString('base64');
  for (const f of record.fixtures) git(wt, 'push', remote, `${seed}:refs/heads/${f.branch}`);
  const env = { ENABLE_DISPATCH: 'true', CODEX_HOME: home };
  const comments = [];
  let serial = 0;
  const persist = (receipt, actor = config.linear_receipt_actor_ids[0]) => {
    assert.equal(validateReceipt(receipt).valid, true, JSON.stringify(validateReceipt(receipt)));
    comments.push({ user: { id: actor }, createdAt: `2026-09-14T11:00:${String(serial++).padStart(2, '0')}.000Z`, body: receiptCommentBody(receipt) });
  };
  const status = (overrides = {}) => singleRunActivationStatus({ filePath: '/isolated/activation', config, env,
    issues: record.fixtures.map(f => ({ id: f.issue_id, linearId: `uuid-${f.issue_id}` })),
    receipts: parseReceiptsFromComments(comments), now: new Date('2026-09-14T11:30:00Z'), gitHead: record.coordinator_revision,
    io: { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }), readFile: () => JSON.stringify(record),
      mainRevision: record.coordinator_revision,
      fixtureHeadResolver: branch => git(remote, 'rev-parse', `refs/heads/${branch}`),
      fixtureAncestryResolver: (base, head) => spawnSync('git', ['-C', remote, 'merge-base', '--is-ancestor', base, head]).status === 0,
      ...overrides } });
  const armed = status(); assert.equal(armed.state, 'armed', 'B3_INITIAL_BINDING');
  const reserve = (lane = 0, target = seed, role = 'build') => {
    const f = record.fixtures[lane];
    const made = createReceipt({ issue_id: f.issue_id, authorization_ref: f.lane.authorization_ref,
      requested_worker: role === 'review' ? 'claude-verifier' : 'codex-builder', receipt_version: '1.1.0', role,
      runtime: role === 'review' ? 'claude-code' : 'codex-cli', repo: config.pilot_repo, branch: f.branch,
      target_sha: target, episode_id: record.activation_id, activation_digest: armed.activation_digest,
      attempt_id: randomUUID(), reserved_at: '2026-09-14T11:00:00.000Z' });
    assert.equal(made.ok, true, JSON.stringify(made.errors));
    const r = { ...made.receipt, stage: 'RUNNING', worker_identity: role === 'review' ? 'claude:independent' : 'codex:writer',
      external_run_id: `codexrun_${made.receipt.attempt_id}`, adapter_status: 'in_progress' };
    persist(r); return r;
  };
  const push = async r => {
    git(wt, 'reset', '--hard', r.target_sha);
    fs.writeFileSync(path.join(wt, 'content'), r.attempt_id);
    const result = await pushExactSha({ stateDir: state, attempt_id: r.attempt_id, target_sha: r.target_sha,
      result_sha: null, workspaceReady: true, branch: r.branch, repo: r.repo, worktree: wt, allowedRoot: root,
      remoteUrl: `file://${remote}`, allowedHost: 'file', gitImpl: (exe, args, options, callback) => {
        if (args.includes('push')) assert.ok(!args.some(arg => arg.startsWith('--force') || arg.startsWith('+')), 'B3_BROKER_NO_FORCE');
        return execFile(exe, args, options, callback);
      }, env: process.env });
    assert.equal(result.ok, true, JSON.stringify(result));
    // Copy the broker-created commit back only to prepare the next isolated worker.
    git(wt, 'fetch', remote, `refs/heads/${r.branch}`);
    return result.remote_head;
  };
  const finish = (r, verdict, head) => {
    const next = { ...r, stage: verdict === 'BLOCKED' ? 'HOLD' : 'COMPLETED', verdict_stage: verdict, result_sha: head,
      adapter_status: 'completed', timestamps: { ...r.timestamps, terminal: '2026-09-14T11:10:00.000Z' },
      last_activity: `2026-09-14T11:10:${String(serial).padStart(2, '0')}.000Z`, evidence_links: ['isolated:test'] };
    persist(next); return next;
  };
  return { root, wt, remote, state, config, record, env, comments, git, seed, status, reserve, push, persist, finish,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('B3_SEQUENCE: armed seed, broker descendant, BLOCK, revision, re-review', async () => {
  const h = harness(); try {
    const signedSeed = JSON.stringify(h.record);
    const build = h.reserve(); h.reserve(1);
    const head = await h.push(build);
    assert.equal(h.status().state, 'armed', 'B3_PUSH_BEFORE_TERMINAL: broker push remains armed before receipt fold');
    h.finish(build, 'BUILD_READY', head);
    assert.equal(h.status().successor?.role, 'review', 'B3_BUILD_REVIEW');
    const review = h.reserve(0, head, 'review'); h.finish(review, 'BLOCKED', head);
    assert.equal(h.status().successor?.role, 'revise', 'B3_BLOCK_REVISION');
    const revise = h.reserve(0, head, 'revise'); const revised = await h.push(revise);
    h.finish(revise, 'REVISION_READY', revised);
    assert.equal(h.status().successor?.role, 'review', 'B3_REVISION_REREVIEW');
    assert.equal(h.status().successor?.target_sha, revised, 'B3_REREVIEW_EXACT_HEAD');
    assert.equal(JSON.stringify(h.record), signedSeed, 'B3_IMMUTABLE_SIGNED_SEED');
    assert.equal(h.git(h.remote, 'rev-parse', 'refs/heads/coordinator/SHU-254'), h.seed, 'B3_ONE_LANE_ADVANCEMENT');
  } finally { h.cleanup(); }
});

const attacks = {
  MISSING_ANCESTRY: h => ({ fixtureAncestryResolver: () => false }),
  FORGED_RECEIPT: h => { const r = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(h.comments[0].body)[1]); r.activation_digest = 'f'.repeat(64); h.comments.length = 0; h.persist(r); return {}; },
  WRONG_ACTOR: h => { h.comments[0].user.id = 'untrusted'; return {}; },
  WRONG_LANE: h => { const file = fs.readdirSync(h.state).find(f => f.startsWith('push-')); const p = path.join(h.state, file); const r = JSON.parse(fs.readFileSync(p)); r.branch = 'coordinator/SHU-254'; fs.writeFileSync(p, JSON.stringify(r)); return {}; },
  FORCE_UPDATE: h => { const file = fs.readdirSync(h.state).find(f => f.startsWith('push-')); const p = path.join(h.state, file); const r = JSON.parse(fs.readFileSync(p)); r.update_mode = 'force'; fs.writeFileSync(p, JSON.stringify(r)); return {}; },
  STALE_EPISODE: h => { const r = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(h.comments[0].body)[1]); r.episode_id = 'old-episode'; h.comments.length = 0; h.persist(r); return {}; },
  REWIND: h => { h.git(h.remote, 'update-ref', 'refs/heads/coordinator/SHU-140', h.seed); return {}; },
  NO_RECEIPT: h => { h.comments.length = 0; return {}; },
  NO_BROKER: h => ({ readProgressionPush: () => null }),
};
for (const [name, attack] of Object.entries(attacks)) test(`B3_${name}: refuses unauthorized progression`, async () => {
  const h = harness(); try {
    const r = h.reserve(); await h.push(r);
    assert.equal(h.status().state, 'armed', `B3_${name}_POSITIVE`);
    assert.equal(h.status(attack(h)).code, 'ACT_STALE_SEED_HEAD', `B3_${name}_REFUSED`);
  } finally { h.cleanup(); }
});

const mutations = [
  ['RECOVERY_ANCESTRY', 'push-broker.mjs', 'if (a.error) {', 'if (a.error && !recovering) {', 'B3_RECOVERY_ANCESTRY', 'B3_RECOVERY_REAL_ANCESTRY_REFUSED'],
  ['ANCESTRY_REVERSED', 'two-fixture-progression.mjs', 'isAncestor(receipt.target_sha, push.result_sha)', 'isAncestor(push.result_sha, receipt.target_sha)', 'B3_SEQUENCE', 'B3_PUSH_BEFORE_TERMINAL'],
  ['JOURNAL_PERMS', 'two-fixture-progression.mjs', 's.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)', 'false', 'B3_PUSH_CUSTODY', 'B3_PUBLIC_JOURNAL_REFUSED'],
  ['DIGEST_IMMUTABILITY', 'reconcile.mjs', '"receipt_version", "role", "runtime", "activation_digest",', '"receipt_version", "role", "runtime",', 'B3_RECEIPT_PROVENANCE', 'B3_DIGEST_IMMUTABLE'],
  ['RECOVERY_ACTIVATION', 'two-fixture-recovery.mjs', "return status.valid === true && status.state === 'armed';", 'return true;', 'B3_RECOVERY_ACTIVATION', 'B3_RECOVERY_ACTIVATION_REFUSED'],
  ["RECOVERY_INTERRUPTED", "push-broker.mjs", "[RECOVERY]: true", "[RECOVERY]: false", "B3_RECOVERY_INTERRUPTED", "B3_RECOVERY_INTERRUPTED_RESUMED"],
  ["RECOVERY_AMBIGUOUS", "push-broker.mjs", "if (remote.ok === true && remote.head === result_sha) {\n      try {", "if (false) {\n      try {", "B3_RECOVERY_AMBIGUOUS", "B3_RECOVERY_AMBIGUOUS_RESUMED"],
  ["RECOVERY_REWRITE", "push-broker.mjs", "existingRecord.stage !== \"PENDING\" || remote.ok !== true || remote.head !== target_sha", "false", "B3_RECOVERY_REWRITE", "B3_RECOVERY_REWRITE_REFUSED"],
  ["RECOVERY_IDEMPOTENT", "push-broker.mjs", "existingRecord.pushed_at ?? new Date().toISOString()", "new Date().toISOString()", "B3_RECOVERY_IDEMPOTENT", "B3_RECOVERY_STABLE_JOURNAL"],
  ["RECOVERY_DEATH", "push-broker.mjs", "const pre = recovering ?", "const pre = false ?", "B3_RECOVERY_DEATH_BEFORE", "B3_RECOVERY_PROCESS_DEATH_RESUMED"],
  ["RECOVERY_BINDING", "push-broker.mjs", "existingRecord.attempt_id !== attempt_id", "false", "B3_RECOVERY_BINDINGS", "B3_RECOVERY_BINDING_REFUSED"],
  ["RECOVERY_CUSTODY", "push-broker.mjs", "st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)", "false", "B3_RECOVERY_BINDINGS", "B3_RECOVERY_CUSTODY_REFUSED"],
  ["RECOVERY_AUTH", "push-broker.mjs", "typeof options.beforePublish !== \"function\"", "false", "B3_RECOVERY_BINDINGS", "B3_RECOVERY_AUTH_REQUIRED"],
  ["RECOVERY_DURABILITY", "push-broker.mjs", "if (recovering) durableRecoveryMark(stateDir, attempt_id, mark);", "if (recovering) { /* lost durable mark */ }", "B3_RECOVERY_INTERRUPTED", "B3_RECOVERY_DURABLE"],
  ["RECOVERY_MARK_FAILURE", "push-broker.mjs", "if (recovering) return { ...held(\"could not durably confirm recovery\"), reason_code: \"B3_RECOVERY_DURABILITY\" };", "if (false) return { ...held(\"could not durably confirm recovery\"), reason_code: \"B3_RECOVERY_DURABILITY\" };", "B3_RECOVERY_DURABILITY", "B3_RECOVERY_MARK_FAILURE_HELD"],
  ["DANGLING_IGNORED", "two-fixture-progression.mjs", "if (next.length !== 1 || next[0].to === head) return null;", "if (next.length !== 1 || next[0].to === head) break;", "B3_DANGLING", "B3_DANGLING_REFUSED"],
  ["ATTEMPT_UNBOUND", "two-fixture-progression.mjs", "push.attempt_id !== receipt.attempt_id", "false", "B3_FORK", "B3_ATTEMPT_REFUSED"],
  ['BROKER_FORCE', 'push-broker.mjs', '    "push",\n    remoteUrl,', '    "push", "--force",\n    remoteUrl,', 'B3_SEQUENCE', 'B3_BROKER_NO_FORCE'],
  ['DISPATCH_STAMP', 'reconcile.mjs', 'activation_digest: singleRunActivation.activation_digest ?? null,', 'activation_digest: null,', 'B3_DISPATCH_STAMP', 'B3_DISPATCH_DIGEST'],
  ['TRANSPORT_ACTOR', 'reconcile.mjs', 'if (actor) Object.defineProperty(next, RECEIPT_COMMENT_ACTOR, { value: actor });', 'if (false) Object.defineProperty(next, RECEIPT_COMMENT_ACTOR, { value: actor });', 'B3_RECEIPT_PROVENANCE', 'B3_TRANSITION_ACTOR'],
  ['EQUALITY_ONLY', 'two-fixture-activation.mjs', "if (progressed[fixture.branch] !== heads[fixture.branch])", 'if (true)', 'B3_SEQUENCE', 'B3_PUSH_BEFORE_TERMINAL'],
  ['MISSING_ANCESTRY', 'two-fixture-progression.mjs', 'if (isAncestor(receipt.target_sha, push.result_sha) !== true)', 'if (false)', 'B3_MISSING_ANCESTRY', 'B3_MISSING_ANCESTRY_REFUSED'],
  ['FORGED_RECEIPT', 'two-fixture-progression.mjs', 'receipt.activation_digest !== digest', 'false', 'B3_FORGED_RECEIPT', 'B3_FORGED_RECEIPT_REFUSED'],
  ['WRONG_ACTOR', 'two-fixture-progression.mjs', 'if (!config.linear_receipt_actor_ids?.includes(receiptCommentActorId(receipt)))', 'if (false)', 'B3_WRONG_ACTOR', 'B3_WRONG_ACTOR_REFUSED'],
  ['WRONG_LANE', 'two-fixture-progression.mjs', 'push.branch !== fixture.branch', 'false', 'B3_WRONG_LANE', 'B3_WRONG_LANE_REFUSED'],
  ['FORCE_UPDATE', 'two-fixture-progression.mjs', "push.update_mode !== 'fast-forward'", 'false', 'B3_FORCE_UPDATE', 'B3_FORCE_UPDATE_REFUSED'],
  ['STALE_EPISODE', 'two-fixture-progression.mjs', 'if (receipt.episode_id !== record.activation_id)', 'if (false)', 'B3_STALE_EPISODE', 'B3_STALE_EPISODE_REFUSED'],
  ['ONE_LANE', 'two-fixture-progression.mjs', '  return heads;', "  if (Object.values(heads).some((head, i) => head === record.fixtures[i].seed_head) && Object.values(heads).some((head, i) => head !== record.fixtures[i].seed_head)) return null;\n  return heads;", 'B3_SEQUENCE', 'B3_PUSH_BEFORE_TERMINAL'],
  ['REWIND', 'two-fixture-activation.mjs', 'if (heads[fixture.branch] === fixture.seed_head && progressed[fixture.branch] !== fixture.seed_head)', 'if (false)', 'B3_REWIND', 'B3_REWIND_REFUSED'],
];
for (const [name, file, from, to, pattern, assertion] of mutations) test(`B3_MUTATION_${name}: dies by named assertion`, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'b3-mutant-'));
  try {
    fs.cpSync(new URL('../', import.meta.url), dir, { recursive: true });
    const target = path.join(dir, file), source = fs.readFileSync(target, 'utf8');
    assert.equal(source.split(from).length, 2, `B3_MUTATION_${name}_APPLIED_ONCE`);
    fs.writeFileSync(target, source.replace(from, to));
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}:`, path.join(dir, 'test/two-fixture-progression.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, output);
    assert.match(output, /name: 'AssertionError'/, output);
    assert.ok(output.includes(assertion), output);
    assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import { createEpisodeHarness } from './fixture/episode-harness.mjs';
import { activationDigest } from '../two-fixture-progression.mjs';
import { readFixtureAncestry } from '../two-fixture-evidence.mjs';

test('B3_DISPATCH_STAMP: main persists immutable signed provenance before launch', async () => {
  const f = harness();
  const h = createEpisodeHarness({ revision: f.record.coordinator_revision, activationId: f.record.activation_id,
    now: new Date('2026-09-14T11:30:00Z'), configOverrides: f.config,
    extraNodes: [{ id: 'uuid-SHU-254', identifier: 'SHU-254', title: 'second fixture', state: { name: 'Todo' },
      priorityLabel: 'Low', labels: { nodes: [{ name: 'repo:platform' }] }, assignee: null, delegate: null, parent: null, relations: { nodes: [] } }] });
  try {
    fs.writeFileSync(h.activationPath, JSON.stringify(f.record));
    const t = await h.runTick({ env: { DISPATCH_TARGET_SHA: f.seed, CODEX_HOME: path.join(f.root, 'codex') }, io: {
      mainRevision: f.record.coordinator_revision, fixtureHeadResolver: () => f.seed,
      deriveScopedBaseSha: async () => 'd'.repeat(40), prepareWorkspace: async () => ({ cwd: f.wt }),
    } });
    assert.equal(t.code, 0, t.text);
    assert.equal(h.launched.length, 1, 'B3_REAL_DISPATCH');
    const r = h.receipts().find(r => r.issue_id === 'SHU-140');
    assert.equal(r?.activation_digest, activationDigest(reviewedActivationBytes(f.record)), 'B3_DISPATCH_DIGEST');
    assert.equal(r?.target_sha, f.seed, 'B3_DISPATCH_SEED');
    assert.equal(r?.episode_id, f.record.activation_id, 'B3_DISPATCH_EPISODE');
  } finally { h.cleanup(); f.cleanup(); }
});

test('B3_ANCESTRY_API: real read helper requires ahead and exact merge base', () => {
  const config = { pilot_repo: 'BAWES-Universe/studenthub-platform' }, env = { GITHUB_TOKEN: 'synthetic' };
  for (const [status, base, expected] of [['ahead', 'a'.repeat(40), true], ['diverged', 'a'.repeat(40), false], ['ahead', 'c'.repeat(40), false], ['identical', 'a'.repeat(40), false]]) {
    const actual = readFixtureAncestry(config, env, 'a'.repeat(40), 'b'.repeat(40), (exe, args, opts) => {
      assert.ok(!args.join(' ').includes('synthetic'), 'B3_TOKEN_STDIN_ONLY');
      const prelude = `globalThis.fetch = async () => ({ ok: true, json: async () => (${JSON.stringify({ status, merge_base_commit: { sha: base } })}) });`;
      return execFileSync(exe, [args[0], args[1], prelude + args[2]], opts);
    });
    assert.equal(actual, expected, 'B3_EXACT_API_ANCESTRY');
  }
  assert.equal(readFixtureAncestry(config, {}, 'a'.repeat(40), 'b'.repeat(40)), false, 'B3_ANCESTRY_MISSING_TOKEN');
});

test('B3_PUSH_CUSTODY: unsafe journal permissions and symlinks cannot authorize', async () => {
  const h = harness(); try {
    const r = h.reserve(); await h.push(r);
    const file = path.join(h.state, `push-${r.attempt_id}.json`);
    assert.ok(readProgressionPush(r, h.env), 'B3_PRIVATE_JOURNAL');
    fs.chmodSync(file, 0o644);
    assert.equal(readProgressionPush(r, h.env), null, 'B3_PUBLIC_JOURNAL_REFUSED');
    fs.chmodSync(file, 0o600); fs.renameSync(file, `${file}.original`); fs.symlinkSync(`${file}.original`, file);
    assert.equal(readProgressionPush(r, h.env), null, 'B3_SYMLINK_JOURNAL_REFUSED');
  } finally { h.cleanup(); }
});

import { nextReceiptState, receiptCommentActorId, RECEIPT_IMMUTABLE_FIELDS } from '../reconcile.mjs';
test('B3_RECEIPT_PROVENANCE: transitions retain transport actor and digest is immutable', () => {
  const h = harness(); try {
    h.reserve(); const parsed = parseReceiptsFromComments(h.comments)[0];
    const next = nextReceiptState(parsed, { type: 'hold', reason: 'test' }).receipt;
    assert.equal(receiptCommentActorId(next), h.config.linear_receipt_actor_ids[0], 'B3_TRANSITION_ACTOR');
    assert.ok(RECEIPT_IMMUTABLE_FIELDS.includes('activation_digest'), 'B3_DIGEST_IMMUTABLE');
    assert.ok(!JSON.stringify(next).includes(h.config.linear_receipt_actor_ids[0]), 'B3_ACTOR_NOT_SERIALIZED');
  } finally { h.cleanup(); }
});

test('B3_BOTH_LANES: independently bound descendants can both progress', async () => {
  const h = harness(); try {
    const first = h.reserve(), second = h.reserve(1);
    await h.push(first); await h.push(second);
    assert.equal(h.status().state, 'armed', 'B3_BOTH_DESCENDANTS_ACCEPTED');
  } finally { h.cleanup(); }
});

test('B3_MAIN_SEQUENCE: coordinator ticks dispatch build, BLOCK revision and re-review', async () => {
  const f = harness();
  const actor = f.config.linear_receipt_actor_ids[0];
  const h = createEpisodeHarness({ revision: f.record.coordinator_revision, activationId: f.record.activation_id,
    callbackActor: actor, githubToken: 'synthetic', initialBranchHead: f.seed,
    now: new Date('2026-09-14T11:30:00Z'), configOverrides: f.config,
    extraNodes: [{ id: 'uuid-SHU-254', identifier: 'SHU-254', title: 'second fixture', state: { name: 'Todo' },
      priorityLabel: 'Low', labels: { nodes: [{ name: 'repo:platform' }] }, assignee: null, delegate: null, parent: null, relations: { nodes: [] } }] });
  try {
    fs.writeFileSync(h.activationPath, JSON.stringify(f.record));
    f.reserve(1); h.comments.push(...f.comments);
    const tick = async () => {
      const result = await h.runTick({ env: { DISPATCH_TARGET_SHA: f.seed, CODEX_HOME: path.join(f.root, 'codex') }, io: {
        mainRevision: f.record.coordinator_revision,
        fixtureHeadResolver: branch => f.git(f.remote, 'rev-parse', `refs/heads/${branch}`),
        fixtureAncestryResolver: (base, head) => spawnSync('git', ['-C', f.remote, 'merge-base', '--is-ancestor', base, head]).status === 0,
        deriveScopedBaseSha: async () => 'd'.repeat(40), prepareWorkspace: async () => ({ cwd: f.wt }),
        fetchImpl: async (...args) => {
          const response = await h.fetchImpl(...args);
          // The API transport authenticates coordinator-created receipt comments.
          for (const c of h.comments) if (c.body.startsWith('<!-- coordinator-receipt') && !c.user) c.user = { id: actor };
          const request = JSON.parse(args[1]?.body ?? "{}");
          if (request.query?.includes('CoordinatorIssueComments')) {
            const payload = await response.json();
            const issue = h.nodes.find(n => n.id === request.variables.issueId || n.identifier === request.variables.issueId)?.identifier;
            payload.data.issue.comments.nodes = payload.data.issue.comments.nodes.filter(c => {
              const body = /```json\n([\s\S]*?)\n```/.exec(c.body);
              const value = body ? JSON.parse(body[1]) : null;
              return value?.issue_id ? value.issue_id === issue : issue === 'SHU-140';
            });
            return { ...response, json: async () => payload };
          }
          return response;
        },
      } });
      assert.equal(result.code, 0, result.text); return result;
    };
    const latest = worker => h.receipts().filter(r => r.issue_id === 'SHU-140' && r.requested_worker === worker).at(-1);
    const complete = async (r, stage, head) => {
      h.postCallback({ attemptId: r.attempt_id, stage, targetSha: r.target_sha, resultSha: head });
      h.branchHead.value = head; h.completeRun(r.external_run_id); await tick();
    };
    await tick(); const firstTick = await tick(); const build = latest('codex-builder');
    assert.ok(build, `B3_MAIN_BUILD: ${firstTick.text}`);
    const built = await f.push(build); await complete(build, 'BUILD_READY', built); const reviewTick = await tick();
    const review = latest('claude-verifier'); assert.ok(review, `B3_MAIN_REVIEW: ${reviewTick.text}`);
    assert.equal(review.target_sha, built, 'B3_MAIN_REVIEW_HEAD');
    await complete(review, 'BLOCKED', built); await tick();
    const revise = latest('codex-builder'); assert.equal(revise.role, 'revise', 'B3_MAIN_REVISION');
    const revised = await f.push(revise); await complete(revise, 'REVISION_READY', revised); await tick();
    const rereview = latest('claude-verifier');
    assert.notEqual(rereview.attempt_id, review.attempt_id, 'B3_MAIN_REREVIEW');
    assert.equal(rereview.target_sha, revised, 'B3_MAIN_REREVIEW_HEAD');
    assert.equal(h.triggers['claude-code'], 2, 'B3_MAIN_TWO_REVIEWS');
    assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/coordinator/SHU-254'), f.seed, 'B3_MAIN_OTHER_LANE_UNCHANGED');
  } finally { h.cleanup(); f.cleanup(); }
});

test('B3_REMOTE_REWRITES: real unrelated and unauthorized descendant heads refuse', async () => {
  const h = harness(); try {
    const r = h.reserve(); const built = await h.push(r);
    const tree = h.git(h.remote, 'rev-parse', `${built}^{tree}`);
    const commit = (...parents) => h.git(h.remote, '-c', 'user.name=B3', '-c', 'user.email=b3@example.invalid', 'commit-tree', tree, ...parents, '-m', 'unauthorized');
    const unrelated = commit(), unauthorized = commit('-p', built);
    for (const head of [unrelated, unauthorized]) {
      h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, head);
      assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_UNAUTHORIZED_HEAD_REFUSED');
    }
    const journal = path.join(h.state, `push-${r.attempt_id}.json`);
    const forged = JSON.parse(fs.readFileSync(journal)); forged.result_sha = unrelated;
    fs.writeFileSync(journal, JSON.stringify(forged));
    h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, unrelated);
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_REAL_NON_ANCESTOR_REFUSED');
  } finally { h.cleanup(); }
});

import { recoverTwoFixturePush } from '../two-fixture-recovery.mjs';
import { recoverExactSha, persistPrePush, readPrePushRecord } from '../push-broker.mjs';

function recoveryOptions(h, r) {
  h.git(h.wt, 'reset', '--hard', r.target_sha);
  fs.writeFileSync(path.join(h.wt, 'content'), r.attempt_id);
  return { stateDir: h.state, attempt_id: r.attempt_id, target_sha: r.target_sha,
    result_sha: null, workspaceReady: true, branch: r.branch, repo: r.repo,
    worktree: h.wt, allowedRoot: h.root, remoteUrl: `file://${h.remote}`, allowedHost: 'file',
    env: process.env, beforePublish: () => true };
}
function recoveryEvidence(h) {
  return { record: h.record, config: h.config, revision: h.record.coordinator_revision,
    mainRevision: h.record.coordinator_revision, env: h.env, now: new Date('2026-09-14T11:30:00Z'),
    heads: Object.fromEntries(h.record.fixtures.map(f => [f.branch, h.git(h.remote, 'rev-parse', `refs/heads/${f.branch}`)])),
    issues: h.record.fixtures.map(f => ({ id: f.issue_id, linearId: `uuid-${f.issue_id}` })),
    receipts: parseReceiptsFromComments(h.comments), readPush: r => readProgressionPush(r, h.env),
    isAncestor: (base, head) => spawnSync('git', ['-C', h.remote, 'merge-base', '--is-ancestor', base, head]).status === 0 };
}
const lostPush = landed => (exe, args, opts, cb) => {
  if (!args.includes('push')) return execFile(exe, args, opts, cb);
  assert.ok(!args.some(a => a.startsWith('--force') || a.startsWith('+')), 'B3_RECOVERY_NO_FORCE');
  if (!landed) return cb(new Error('interrupted before send'), '', '');
  return execFile(exe, args, opts, () => cb(new Error('lost response'), '', ''));
};

for (const [name, landed] of [['INTERRUPTED', false], ['AMBIGUOUS', true]]) {
  test(`B3_RECOVERY_${name}: exact attempt reconciles and full sequence resumes`, async () => {
    const h = harness(); try {
      const build = h.reserve(); const built = await h.push(build); h.finish(build, 'BUILD_READY', built);
      const review = h.reserve(0, built, 'review'); h.finish(review, 'BLOCKED', built);
      const r = h.reserve(0, built, 'revise'), opts = recoveryOptions(h, r);
      const before = JSON.stringify(h.record);
      assert.equal((await pushExactSha({ ...opts, gitImpl: lostPush(landed) })).stage, 'HOLD');
      assert.equal(readPrePushRecord(h.state, r.attempt_id).stage, 'PENDING');
      if (!landed) assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_PENDING_STILL_REFUSES');
      const recovered = await recoverTwoFixturePush({ ...opts, readAuthorization: () => recoveryEvidence(h) });
      assert.equal(recovered.ok, true, `B3_RECOVERY_${name}_RESUMED: ${JSON.stringify(recovered)}`);
      assert.equal(readPrePushRecord(h.state, r.attempt_id).stage, 'PUSHED', 'B3_RECOVERY_DURABLE');
      assert.equal(h.status().state, 'armed', `B3_RECOVERY_${name}_ARMED`);
      h.finish(r, 'REVISION_READY', recovered.remote_head);
      assert.equal(h.status().successor?.role, 'review', 'B3_RECOVERY_REREVIEW');
      assert.equal(h.status().successor?.target_sha, recovered.remote_head, 'B3_RECOVERY_EXACT_REREVIEW');
      h.git(h.wt, 'fetch', h.remote, `refs/heads/${r.branch}`);
      const sibling = h.reserve(1); await h.push(sibling);
      assert.equal(h.status().state, 'armed', 'B3_RECOVERY_BOTH_LANES_RESUME');
      assert.equal(JSON.stringify(h.record), before, 'B3_RECOVERY_SIGNED_SEED_UNCHANGED');
    } finally { h.cleanup(); }
  });
}

test('B3_RECOVERY_IDEMPOTENT: repeated recovery never pushes twice', async () => {
  const h = harness(); try {
    const r = h.reserve(), opts = recoveryOptions(h, r);
    await pushExactSha({ ...opts, gitImpl: lostPush(false) });
    let pushes = 0;
    opts.gitImpl = (exe, args, options, cb) => {
      if (args.includes('push')) { pushes++; assert.ok(!args.some(a => a.startsWith('--force') || a.startsWith('+')), 'B3_RECOVERY_NO_FORCE'); }
      return execFile(exe, args, options, cb);
    };
    const first = await recoverExactSha(opts), journal = fs.readFileSync(path.join(h.state, `push-${r.attempt_id}.json`), 'utf8');
    const second = await recoverExactSha(opts);
    assert.equal(first.ok, true, 'B3_RECOVERY_FIRST');
    assert.equal(second.stage, 'ALREADY_PUSHED', 'B3_RECOVERY_IDEMPOTENT_STAGE');
    assert.equal(second.remote_head, first.remote_head, 'B3_RECOVERY_IDEMPOTENT_HEAD');
    assert.equal(pushes, 1, 'B3_RECOVERY_SINGLE_PUSH');
    assert.equal(fs.readFileSync(path.join(h.state, `push-${r.attempt_id}.json`), 'utf8'), journal, 'B3_RECOVERY_STABLE_JOURNAL');
  } finally { h.cleanup(); }
});

test('B3_RECOVERY_REWRITE: unauthorized rewrite, descendant, missing ref and cross-lane head refuse', async () => {
  const h = harness(); try {
    const sibling = h.reserve(1), siblingHead = await h.push(sibling);
    const r = h.reserve(), opts = recoveryOptions(h, r);
    await pushExactSha({ ...opts, gitImpl: lostPush(false) });
    const tree = h.git(h.remote, 'rev-parse', `${h.seed}^{tree}`);
    const commit = (...parents) => h.git(h.remote, '-c', 'user.name=B3', '-c', 'user.email=b3@example.invalid', 'commit-tree', tree, ...parents, '-m', 'foreign');
    const journal = fs.readFileSync(path.join(h.state, `push-${r.attempt_id}.json`), 'utf8');
    for (const head of [commit(), commit('-p', h.seed), siblingHead, null]) {
      if (head) h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, head);
      else h.git(h.remote, 'update-ref', '-d', `refs/heads/${r.branch}`);
      const result = await recoverExactSha(opts);
      assert.equal(result.reason_code, 'B3_RECOVERY_REMOTE', 'B3_RECOVERY_REWRITE_REFUSED');
      assert.equal(fs.readFileSync(path.join(h.state, `push-${r.attempt_id}.json`), 'utf8'), journal, 'B3_RECOVERY_REWRITE_JOURNAL_UNCHANGED');
    }
    // PUSHED is durable evidence: even a rewind to its parent must not retry.
    h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, h.seed);
    assert.equal((await recoverExactSha(opts)).ok, true);
    h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, h.seed);
    assert.equal((await recoverExactSha(opts)).reason_code, 'B3_RECOVERY_REMOTE', 'B3_RECOVERY_PUSHED_REWIND_REFUSED');
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD');
  } finally { h.cleanup(); }
});

test('B3_RECOVERY_BINDINGS: forged journal, unsafe custody and absent authorization refuse', async () => {
  const h = harness(); try {
    const r = h.reserve(), opts = recoveryOptions(h, r);
    await pushExactSha({ ...opts, gitImpl: lostPush(false) });
    const file = path.join(h.state, `push-${r.attempt_id}.json`), original = fs.readFileSync(file, 'utf8');
    for (const [field, value] of [['attempt_id', randomUUID()], ['target_sha', 'b'.repeat(40)], ['result_sha', 'c'.repeat(40)], ['branch', 'coordinator/SHU-254'], ['repo', 'foreign/repo'], ['worktree', h.root], ['update_mode', 'force'], ['stage', 'FAILED'], ['version', 2]]) {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), [field]: value }));
      assert.equal((await recoverExactSha(opts)).reason_code, 'B3_RECOVERY_BINDING', `B3_RECOVERY_BINDING_REFUSED: ${field}`);
    }
    fs.writeFileSync(file, original); fs.chmodSync(file, 0o644);
    assert.equal((await recoverExactSha(opts)).reason_code, 'B3_RECOVERY_JOURNAL', 'B3_RECOVERY_CUSTODY_REFUSED');
    fs.chmodSync(file, 0o600);
    assert.equal((await recoverExactSha({})).reason_code, 'B3_RECOVERY_AUTHORIZATION', 'B3_RECOVERY_AUTH_REQUIRED');
    // Use non-workspace entry to exercise recovery's own fresh authorization gate.
    const journal = JSON.parse(original);
    h.git(h.wt, 'add', '.'); h.git(h.wt, 'commit', '-m', 'local');
    const direct = { ...opts, workspaceReady: false, result_sha: journal.result_sha,
      readHeadImpl: () => journal.result_sha, isAncestorImpl: () => true, cleanTreeImpl: () => ({ ok: true }), beforePublish: () => false };
    assert.equal((await recoverExactSha(direct)).reason_code, 'B3_RECOVERY_AUTHORIZATION', 'B3_RECOVERY_AUTH_RECHECKED');
    assert.equal(h.git(h.remote, 'rev-parse', `refs/heads/${r.branch}`), h.seed);
  } finally { h.cleanup(); }
});

for (const phase of ['before', 'after']) test(`B3_RECOVERY_DEATH_${phase.toUpperCase()}: new process recovers durable attempt after SIGKILL`, () => {
  const h = harness(); try {
    const r = h.reserve(), opts = recoveryOptions(h, r);
    const module = new URL('../push-broker.mjs', import.meta.url).href;
    const { beforePublish, ...serial } = opts;
    const script = `import { pushExactSha, persistPrePush, recoverExactSha } from ${JSON.stringify(module)};
      import { execFile } from 'node:child_process';
      const options = ${JSON.stringify(serial)};
      options.beforePublish = () => true;
      ${phase === 'before' ? `options.persistImpl = args => { persistPrePush(args); process.kill(process.pid, 'SIGKILL'); };` : `options.gitImpl = (exe,args,opts,cb) => execFile(exe,args,opts,(err,out,stderr) => { if(args.includes('push') && !err) process.kill(process.pid,'SIGKILL'); cb(err,out,stderr); });`}
      await pushExactSha(options);`;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(readPrePushRecord(h.state, r.attempt_id).stage, 'PENDING');
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `import { recoverExactSha } from ${JSON.stringify(module)};
      const result = await recoverExactSha({ ...${JSON.stringify(serial)}, beforePublish: () => true });
      console.log(JSON.stringify(result));`], { encoding: 'utf8', timeout: 30000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).ok, true, 'B3_RECOVERY_PROCESS_DEATH_RESUMED');
    assert.equal(readPrePushRecord(h.state, r.attempt_id).stage, 'PUSHED', 'B3_RECOVERY_PROCESS_DEATH_DURABLE');
    assert.equal(h.status().state, 'armed', 'B3_RECOVERY_PROCESS_DEATH_ARMED');
  } finally { h.cleanup(); }
});

test('B3_DANGLING: extra disconnected journal cannot be ignored during recovery', async () => {
  const h = harness(); try {
    const r = h.reserve(); const built = await h.push(r);
    const dangling = h.reserve(0, 'd'.repeat(40), 'revise');
    persistPrePush({ stateDir: h.state, attempt_id: dangling.attempt_id, target_sha: dangling.target_sha,
      result_sha: 'e'.repeat(40), branch: dangling.branch, repo: dangling.repo, worktree: h.wt });
    assert.equal(h.status({ fixtureAncestryResolver: () => true }).code, 'ACT_STALE_SEED_HEAD', 'B3_DANGLING_REFUSED');
    assert.equal(h.git(h.remote, 'rev-parse', `refs/heads/${r.branch}`), built);
  } finally { h.cleanup(); }
});

test('B3_FORK: duplicate parent edges and journal attempt mismatch refuse', async () => {
  const h = harness(); try {
    const r = h.reserve(); await h.push(r);
    const fork = h.reserve(); const journal = readPrePushRecord(h.state, r.attempt_id);
    persistPrePush({ ...journal, stateDir: h.state, attempt_id: fork.attempt_id });
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_FORK_REFUSED');
    h.comments.pop();
    fs.writeFileSync(path.join(h.state, `push-${r.attempt_id}.json`), JSON.stringify({ ...journal, attempt_id: randomUUID() }));
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_ATTEMPT_REFUSED');
  } finally { h.cleanup(); }
});

test('B3_RECOVERY_DURABILITY: failed durable mark holds and next recovery reconciles', async () => {
  const h = harness(); try {
    const r = h.reserve(), opts = recoveryOptions(h, r);
    await pushExactSha({ ...opts, gitImpl: lostPush(false) });
    const temp = path.join(h.state, `push-${r.attempt_id}.json.recovery-${process.pid}`);
    fs.writeFileSync(temp, 'simulate interrupted mark', { mode: 0o600 });
    const result = await recoverExactSha(opts);
    assert.equal(result.reason_code, 'B3_RECOVERY_DURABILITY', 'B3_RECOVERY_MARK_FAILURE_HELD');
    assert.equal((await recoverExactSha(opts)).stage, 'ALREADY_PUSHED', 'B3_RECOVERY_MARK_FAILURE_RESUMED');
    assert.equal(h.status().state, 'armed');
  } finally { h.cleanup(); }
});

test('B3_RECOVERY_ACTIVATION: signed authorization and receipt attacks cannot recover', async () => {
  const h = harness(); try {
    const r = h.reserve(), opts = recoveryOptions(h, r);
    await pushExactSha({ ...opts, gitImpl: lostPush(false) });
    const original = structuredClone(h.comments), signed = JSON.stringify(h.record);
    const attacks = [
      () => { h.record.signature = 'x'.repeat(88); },
      () => { h.record.expires_at = '2020-01-01T00:00:00Z'; },
      () => { h.comments[0].user.id = 'forged'; },
      () => { const value = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(h.comments[0].body)[1]); value.activation_digest = 'f'.repeat(64); h.comments[0].body = receiptCommentBody(value); },
      () => { h.comments.length = 0; },
    ];
    for (const attack of attacks) {
      h.comments.splice(0, h.comments.length, ...structuredClone(original));
      Object.assign(h.record, JSON.parse(signed)); attack();
      assert.equal((await recoverTwoFixturePush({ ...opts, readAuthorization: () => recoveryEvidence(h) })).ok, false, 'B3_RECOVERY_ACTIVATION_REFUSED');
      assert.equal(h.git(h.remote, 'rev-parse', `refs/heads/${r.branch}`), h.seed);
    }
    h.comments.splice(0, h.comments.length, ...original); Object.assign(h.record, JSON.parse(signed));
    assert.equal((await recoverTwoFixturePush({ ...opts, readAuthorization: () => recoveryEvidence(h) })).ok, true, 'B3_RECOVERY_ACTIVATION_RESUMED');
  } finally { h.cleanup(); }
});

test('B3_RECOVERY_ANCESTRY: projected authorization cannot replace real broker ancestry', async () => {
  const h = harness(); try {
    const r = h.reserve(), opts = recoveryOptions(h, r);
    h.git(h.wt, 'reset', '--hard', h.seed);
    const tree = h.git(h.wt, 'rev-parse', 'HEAD^{tree}');
    const orphan = h.git(h.wt, 'commit-tree', tree, '-m', 'orphan');
    h.git(h.wt, 'reset', '--hard', orphan);
    h.git(h.wt, 'push', '--force', h.remote, `${orphan}:refs/heads/${r.branch}`);
    persistPrePush({ stateDir: h.state, attempt_id: r.attempt_id, target_sha: r.target_sha,
      result_sha: orphan, branch: r.branch, repo: r.repo, worktree: h.wt });
    const result = await recoverTwoFixturePush({ ...opts, workspaceReady: false, result_sha: orphan,
      readAuthorization: () => recoveryEvidence(h) });
    assert.equal(result.ok, false, 'B3_RECOVERY_REAL_ANCESTRY_REFUSED');
    assert.match(result.reason, /does not descend/, 'B3_RECOVERY_REAL_ANCESTRY_REASON');
  } finally { h.cleanup(); }
});

test('B3_VERIFIER_ATTACKS: role, missing first edge, sibling and JSON actor spoof remain refused', async () => {
  const h = harness(); try {
    const r = h.reserve(), built = await h.push(r), original = structuredClone(h.comments);
    const revise = h.reserve(0, built, 'revise'); await h.push(revise);
    h.comments.shift();
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_CHAIN_SKIP_REFUSED');
    h.comments.splice(0, h.comments.length, ...original);
    h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, built);
    const actorSpoof = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(h.comments[0].body)[1]);
    actorSpoof.actor_id = h.config.linear_receipt_actor_ids[0];
    h.comments[0].body = receiptCommentBody(actorSpoof); h.comments[0].user.id = 'untrusted';
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_JSON_ACTOR_REFUSED');
    h.comments.splice(0, h.comments.length, ...structuredClone(original));
    h.git(h.remote, 'update-ref', 'refs/heads/coordinator/SHU-254', built);
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_SIBLING_UNAUTHORIZED_REFUSED');
    h.git(h.remote, 'update-ref', 'refs/heads/coordinator/SHU-254', h.seed);
    const review = h.reserve(0, built, 'review'); await h.push(review);
    assert.equal(h.status().code, 'ACT_STALE_SEED_HEAD', 'B3_REVIEW_PUSH_REFUSED');
  } finally { h.cleanup(); }
});
