import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, sign } from 'node:crypto';
import { ephemeralPublicSource } from './fixture/ephemeral-public-source.mjs';
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
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
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
