import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as coordinator from '../reconcile.mjs';
import { consumeMergeReadiness, mergeAttemptCommentBody, parseMergeAttemptsFromComments } from '../merge-readiness.mjs';

const HEAD = 'a'.repeat(40);
const STALE = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const WRONG_TREE = 'e'.repeat(40);
const MERGE = 'f'.repeat(40);
const ACTOR = 'trusted-linear-actor';
const messages = {
  stale: 'STALE_HEAD_MUTATION: a changed PR head must HOLD before merge',
  family: 'INDEPENDENT_VERDICT_MUTATION: a self/same-family PASS must HOLD before merge',
  check: 'RED_CHECK_MUTATION: a missing, pending or red required check must HOLD before merge',
  thread: 'BLOCKING_THREAD_MUTATION: an unresolved review thread must HOLD before merge',
  explicit: 'EXPLICIT_HOLD_MUTATION: protected work and explicit holds must never merge',
  duplicate: 'DUPLICATE_MERGE_MUTATION: duplicate ticks and restart must produce no second action',
  lost: 'LOST_RESPONSE_MUTATION: a lost merge response must recover from GitHub without a second merge',
  tree: 'TREE_MISMATCH_MUTATION: completion requires the landed squash tree to equal the approved head tree',
};

function terminalReceipt({ sameFamily = false } = {}) {
  const writerMade = coordinator.createReceipt({ issue_id: 'SHU-900', authorization_ref: 'SHU-900',
    requested_worker: 'codex-builder', repo: 'example/repo', branch: 'feat/routine', target_sha: BASE,
    attempt_id: '00000000-0000-4000-8000-000000000001' });
  assert.ok(writerMade.ok);
  const writer = { ...writerMade.receipt, stage: 'COMPLETED', verdict_stage: 'BUILD_READY', result_sha: HEAD,
    external_run_id: 'codexrun_writer', worker_identity: 'codex-author', adapter_status: 'completed',
    evidence_links: ['https://example.test/build'], last_activity: '2026-09-14T00:01:00.000Z',
    timestamps: { ...writerMade.receipt.timestamps, launch: '2026-09-14T00:00:10.000Z', terminal: '2026-09-14T00:01:00.000Z' } };
  const requested_worker = sameFamily ? 'codex-verifier' : 'claude-verifier';
  const reviewMade = coordinator.createReceipt({ issue_id: 'SHU-900', authorization_ref: 'SHU-900',
    requested_worker, repo: 'example/repo', branch: 'feat/routine', target_sha: HEAD,
    receipt_version: sameFamily ? '1.1.0' : '1.0.0', role: 'review', runtime: sameFamily ? 'codex-cli' : 'claude-code',
    attempt_id: '00000000-0000-4000-8000-000000000002' });
  assert.ok(reviewMade.ok);
  const review = { ...reviewMade.receipt, stage: 'COMPLETED', verdict_stage: 'PASS', result_sha: null,
    external_run_id: sameFamily ? 'codexrun_review' : 'clauderun_review', worker_identity: sameFamily ? 'codex-reviewer' : 'claude-reviewer',
    adapter_status: 'completed', evidence_links: ['https://example.test/verdict'], last_activity: '2026-09-14T00:02:00.000Z',
    timestamps: { ...reviewMade.receipt.timestamps, launch: '2026-09-14T00:01:10.000Z', terminal: '2026-09-14T00:02:00.000Z' },
    handoff: { source_attempt_id: reviewMade.receipt.attempt_id, target_sha: HEAD, verdict_stage: 'PASS',
      action: 'merge-readiness', hold_code: 'MISSING_AUTHORITY' } };
  assert.equal(coordinator.validateReceipt(review).valid, true);
  return { writer, review };
}

function harness(options = {}) {
  const pair = terminalReceipt(options);
  const comments = [pair.writer, pair.review].map((receipt, index) => ({ body: coordinator.receiptCommentBody(receipt),
    createdAt: `2026-09-14T00:0${index + 1}:00.000Z`, user: { id: ACTOR, displayName: 'Coordinator' } }));
  let merged = Boolean(options.alreadyMerged);
  let mergeCalls = 0;
  let githubReads = 0;
  let linearWrites = 0;
  let loseMergeResponse = Boolean(options.loseMergeResponse);
  const issueLabels = options.issueLabels ?? [];
  const fetchImpl = async (url, request = {}) => {
    if (url === 'https://api.linear.app/graphql') {
      const { query, variables } = JSON.parse(request.body);
      let data;
      if (query.includes('CoordinatorIssues')) data = { issues: { nodes: [{ id: 'linear-900', identifier: 'SHU-900', title: 'Routine change',
        state: { name: 'In Progress' }, priorityLabel: 'No priority', labels: { nodes: [{ name: 'repo:example/repo' }] }, assignee: null, delegate: null,
        parent: null, relations: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } };
      else if (query.includes('CoordinatorIssueComments')) data = { issue: { comments: { nodes: structuredClone(comments) } } };
      else if (query.includes('CoordinatorMergeIssue')) data = { issue: { id: 'linear-900', identifier: 'SHU-900', title: 'Routine change',
        state: { name: 'In Progress', type: 'started' }, labels: { nodes: issueLabels.map(name => ({ name })) },
        relations: { nodes: options.blocked ? [{ type: 'blockedBy', relatedIssue: { identifier: 'SHU-1', state: { name: 'In Progress', type: 'started' } } }] : [] },
        comments: { nodes: structuredClone(comments) } } };
      else if (query.includes('commentCreate')) {
        linearWrites++;
        comments.push({ body: variables.body, createdAt: `2026-09-14T00:10:${String(linearWrites).padStart(2, '0')}.000Z`, user: { id: ACTOR, displayName: 'Coordinator' } });
        data = { commentCreate: { success: true, comment: { id: `comment-${linearWrites}` } } };
      } else throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if (url === 'https://api.github.com/graphql') {
      githubReads++;
      return { ok: true, status: 200, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: options.unresolvedThread ? [{ isResolved: false, comments: { nodes: [{ isMinimized: false }] } }] : [],
        pageInfo: { hasNextPage: false, endCursor: null } } } } } }) };
    }
    if (!String(url).startsWith('https://api.github.com/repos/example/repo/')) throw new Error(`unexpected URL ${url}`);
    const pathname = String(url).slice('https://api.github.com/repos/example/repo'.length);
    if (request.method === 'PUT' && pathname === '/pulls/7/merge') {
      mergeCalls++;
      merged = true;
      if (loseMergeResponse) { loseMergeResponse = false; throw new Error('synthetic lost merge response'); }
      return { ok: true, status: 200, json: async () => ({ merged: true, sha: MERGE }) };
    }
    githubReads++;
    let body;
    if (pathname === '/pulls?state=open&per_page=100') body = merged ? [] : [{ number: 7, state: 'open', title: 'SHU-900 routine', body: '', head: { ref: 'feat/routine', sha: HEAD } }];
    else if (pathname.startsWith('/pulls?')) body = [{ number: 7, state: merged ? 'closed' : 'open', merged_at: merged ? '2026-09-14T00:20:00Z' : null,
      head: { sha: options.staleHead ? STALE : HEAD } }];
    else if (pathname === '/pulls/7') body = { number: 7, state: merged ? 'closed' : 'open', merged, merged_at: merged ? '2026-09-14T00:20:00Z' : null,
      merge_commit_sha: merged ? MERGE : null, draft: false, mergeable: true, mergeable_state: 'clean',
      head: { ref: 'feat/routine', sha: options.staleHead ? STALE : HEAD, repo: { full_name: 'example/repo' } },
      base: { ref: 'main', sha: BASE }, labels: (options.prLabels ?? []).map(name => ({ name })) };
    else if (pathname === `/commits/${HEAD}`) body = { commit: { tree: { sha: TREE } } };
    else if (pathname === `/commits/${MERGE}`) body = { commit: { tree: { sha: options.treeMismatch ? WRONG_TREE : TREE } } };
    else if (pathname === '/branches/main') body = { protected: options.unprotected !== true, commit: { sha: options.advancedBase ? STALE : BASE } };
    else if (pathname === '/branches/main/protection') body = { required_status_checks: { strict: true, contexts: [], checks: [{ context: 'CI', app_id: 1 }] } };
    else if (pathname.startsWith('/compare/')) body = { status: options.advancedBase ? 'diverged' : 'ahead', base_commit: { sha: options.advancedBase ? STALE : BASE } };
    else if (pathname === `/commits/${HEAD}/status?per_page=100`) body = { statuses: [] };
    else if (pathname === `/commits/${HEAD}/check-runs?filter=latest&per_page=100`) body = { total_count: 1,
      check_runs: [{ name: 'CI', status: 'completed', conclusion: options.redCheck ? 'failure' : 'success', app: { id: 1 } }] };
    else throw new Error(`unexpected GitHub path ${pathname}`);
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  const config = { routine_merge_authority: { enabled: true, authority_ref: 'SHU-259', repo: 'example/repo', merge_method: 'squash', max_per_tick: 1 },
    linear_receipt_actor_ids: [ACTOR] };
  const args = { receipts: [pair.writer, pair.review], issues: [{ id: 'SHU-900', linearId: 'linear-900' }],
    linearToken: 'linear', githubToken: 'github', config, env: { ENABLE_ROUTINE_MERGE: 'true' }, fetchImpl,
    now: () => new Date('2026-09-14T00:30:00.000Z'), stdout() {} };
  return { args, comments, consume: () => consumeMergeReadiness(args), mergeCalls: () => mergeCalls,
    githubReads: () => githubReads, linearWrites: () => linearWrites,
    attempts: () => parseMergeAttemptsFromComments(comments, [ACTOR]).records };
}

test('stale-head', async () => {
  const h = harness({ staleHead: true });
  const result = await h.consume();
  assert.equal(result.merges, 0, messages.stale);
  assert.equal(h.mergeCalls(), 0, messages.stale);
  assert.deepEqual([h.attempts().at(-1)?.state, h.attempts().at(-1)?.hold_code], ['HOLD', 'STALE_HEAD'], messages.stale);
});

test('self-same-family-verdict', async () => {
  const h = harness({ sameFamily: true });
  const result = await h.consume();
  assert.equal(result.merges, 0, messages.family);
  assert.equal(h.mergeCalls(), 0, messages.family);
  assert.deepEqual([h.attempts().at(-1)?.state, h.attempts().at(-1)?.hold_code], ['HOLD', 'INELIGIBLE_VERDICT'], messages.family);
});

test('red-required-check', async () => {
  const h = harness({ redCheck: true });
  const result = await h.consume();
  assert.equal(result.merges, 0, messages.check);
  assert.equal(h.mergeCalls(), 0, messages.check);
  assert.equal(h.attempts().at(-1)?.hold_code, 'REQUIRED_CHECKS_NOT_GREEN', messages.check);
});

test('unresolved-blocking-thread', async () => {
  const h = harness({ unresolvedThread: true });
  const result = await h.consume();
  assert.equal(result.merges, 0, messages.thread);
  assert.equal(h.mergeCalls(), 0, messages.thread);
  assert.equal(h.attempts().at(-1)?.hold_code, 'BLOCKING_REVIEW_THREAD', messages.thread);
});

test('explicit-hold-and-forbidden-action', async () => {
  for (const label of ['production', 'deployment', 'activation', 'credential', 'spend', 'destructive-migration', 'product-decision', 'needs:decision']) {
    const h = harness({ issueLabels: [label] });
    const result = await h.consume();
    assert.equal(result.merges, 0, messages.explicit);
    assert.equal(h.mergeCalls(), 0, messages.explicit);
    assert.equal(h.attempts().at(-1)?.hold_code, 'FORBIDDEN_MERGE_ACTION', messages.explicit);
  }
  for (const options of [{ issueLabels: ['Blocked'] }, { blocked: true }, { prLabels: ['hold'] }]) {
    const h = harness(options);
    await h.consume();
    assert.equal(h.mergeCalls(), 0, messages.explicit);
    assert.equal(h.attempts().at(-1)?.hold_code, 'EXPLICIT_HOLD', messages.explicit);
  }
});

test('advanced-base-and-branch-protection-hold', async () => {
  const advanced = harness({ advancedBase: true });
  await advanced.consume();
  assert.deepEqual([advanced.mergeCalls(), advanced.attempts().at(-1)?.hold_code], [0, 'BASE_ADVANCED']);
  const unprotected = harness({ unprotected: true });
  await unprotected.consume();
  assert.deepEqual([unprotected.mergeCalls(), unprotected.attempts().at(-1)?.hold_code], [0, 'BRANCH_PROTECTION_UNSATISFIED']);
});

test('duplicate-merge-and-already-merged-replay', async () => {
  const h = harness();
  const first = await h.consume();
  assert.equal(first.merges, 1, messages.duplicate);
  assert.equal(h.mergeCalls(), 1, messages.duplicate);
  const reads = h.githubReads(), writes = h.linearWrites();
  const second = await h.consume();
  assert.deepEqual(second, { writes: 0, merges: 0 }, messages.duplicate);
  assert.equal(h.mergeCalls(), 1, messages.duplicate);
  assert.equal(h.githubReads(), reads, messages.duplicate);
  assert.equal(h.linearWrites(), writes, messages.duplicate);
  const completed = h.attempts().find(record => record.state === 'COMPLETED');
  assert.deepEqual([completed.approved_head_sha, completed.merge_commit_sha, completed.landed_tree_sha], [HEAD, MERGE, TREE], messages.duplicate);
});

test('lost-merge-response', async () => {
  const h = harness({ loseMergeResponse: true });
  const result = await h.consume();
  assert.equal(result.merges, 1, messages.lost);
  assert.equal(h.mergeCalls(), 1, messages.lost);
  assert.equal(h.attempts().at(-1)?.state, 'COMPLETED', messages.lost);
  await h.consume();
  assert.equal(h.mergeCalls(), 1, messages.lost);
});

test('landed-tree-mismatch', async () => {
  const h = harness({ treeMismatch: true });
  let result;
  try { result = await h.consume(); } catch { assert.fail(messages.tree); }
  assert.equal(result.merges, 0, messages.tree);
  assert.equal(h.mergeCalls(), 1, messages.tree);
  assert.deepEqual([h.attempts().at(-1)?.state, h.attempts().at(-1)?.hold_code], ['HOLD', 'TREE_MISMATCH'], messages.tree);
});

test('routine-merge-gates-off', async () => {
  const h = harness();
  const result = await consumeMergeReadiness({ ...h.args, env: {} });
  assert.deepEqual(result, { writes: 0, merges: 0 });
  assert.deepEqual([h.mergeCalls(), h.linearWrites()], [0, 0]);
});

test('main-consumes-one-merge-readiness-with-dispatch-disabled', async () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), 'shu259-main-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ pilot_repo: 'example/repo', max_dispatch: 1, enable_dispatch: false,
      repo_label_map: { 'repo:example/repo': 'example/repo' }, linear_callback_actor_ids: [ACTOR],
      linear_receipt_actor_ids: [ACTOR],
      routine_merge_authority: h.args.config.routine_merge_authority }));
    const output = [];
    const code = await coordinator.main([], { LINEAR_API_TOKEN: 'linear', GITHUB_TOKEN: 'github', ENABLE_ROUTINE_MERGE: 'true' },
      { configPath, fetchImpl: h.args.fetchImpl, skipActivationPreflight: true, pollRuns: false, stdout: line => output.push(line), now: h.args.now });
    assert.equal(code, 0);
    assert.equal(h.mergeCalls(), 1);
    assert.ok(output.some(line => line.includes('merge-readiness: SHU-900 COMPLETED')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

if (!process.env.MERGE_MUTANT_CHILD) test('SHU-259 named mutation controls', (t) => {
  const sourcePath = new URL('../merge-readiness.mjs', import.meta.url);
  const original = readFileSync(sourcePath, 'utf8');
  const mutations = [
    ['stale', "if (pr.head.sha !== targetSha)", 'if (false)', 'stale-head'],
    ['family', 'if (!provenance.ok)', 'if (false)', 'self-same-family-verdict'],
    ['check', 'if (!snapshot.required_checks_green)', 'if (false)', 'red-required-check'],
    ['thread', 'if (snapshot.blocking_threads !== 0)', 'if (false)', 'unresolved-blocking-thread'],
    ['explicit', 'if (labels.some(label => FORBIDDEN_LABELS.has(label)))', 'if (false)', 'explicit-hold-and-forbidden-action'],
    ['duplicate', "if (existing?.state === 'COMPLETED' || existing?.state === 'HOLD') continue;", 'if (false) continue;', 'duplicate-merge-and-already-merged-replay'],
    ['lost', 'const recovered = await fetchGitHubMergeSnapshot({ repo: source.repo, branch: source.branch,', 'const recovered = { ok: false, merged: false }; void ({ repo: source.repo, branch: source.branch,', 'lost-merge-response'],
    ['tree', 'if (recovered.landed_tree_sha !== existing.approved_tree_sha)', 'if (false)', 'landed-tree-mismatch'],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'shu259-mutants-'));
  try {
    const copy = (() => {
      cpSync(new URL('..', import.meta.url).pathname, join(dir, 'coordinator'), { recursive: true, verbatimSymlinks: true });
      return { status: 0 }; // cpSync throws on failure; preserve the existing success assertion.
    })();
    assert.equal(copy.status, 0);
    for (const [name, from, to, pattern] of mutations) {
      assert.equal(original.split(from).length - 1, 1, `mutation anchor ${name}`);
      writeFileSync(join(dir, 'coordinator/merge-readiness.mjs'), original.replace(from, to));
      const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}$`, join(dir, 'coordinator/test/merge-readiness.test.mjs')],
        { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST'))), MERGE_MUTANT_CHILD: '1' } });
      assert.notEqual(child.status, 0, `${name} mutation survived`);
      assert.ok(child.stdout.includes(messages[name]) && child.stdout.includes('AssertionError'), `${name} must die by named AssertionError: ${child.stdout}${child.stderr}`);
      t.diagnostic(`${name}: killed by ${messages[name]}`);
      writeFileSync(join(dir, 'coordinator/merge-readiness.mjs'), original);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function strandPrepared(h) {
  const fetchImpl = h.args.fetchImpl;
  h.args.fetchImpl = async (url, request = {}) => {
    const response = await fetchImpl(url, request);
    if (url === 'https://api.linear.app/graphql') {
      const { query, variables } = JSON.parse(request.body);
      if (query.includes('commentCreate') && variables.body.includes('"state": "PREPARED"')) {
        throw new Error('fixture process stopped after durable PREPARED');
      }
    }
    return response;
  };
  await assert.rejects(h.consume(), /fixture process stopped after durable PREPARED/);
  h.args.fetchImpl = fetchImpl;
  const prepared = h.attempts().at(-1);
  assert.equal(prepared?.state, 'PREPARED');
  assert.equal(h.mergeCalls(), 0);
  return prepared;
}

for (const entry of ['consumeMergeReadiness', 'main']) test(`prepared-restart-red-check-${entry}`, async () => {
  const options = {};
  const h = harness(options);
  const prepared = await strandPrepared(h);
  // Keep the same durable comments and receipt lineage across the process boundary.
  options.redCheck = true;
  const dir = mkdtempSync(join(tmpdir(), 'shu259-restart-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ pilot_repo: 'example/repo', max_dispatch: 1, enable_dispatch: false,
      repo_label_map: { 'repo:example/repo': 'example/repo' }, linear_callback_actor_ids: [ACTOR],
      ...h.args.config }));
    await assert.doesNotReject(async () => {
      try {
        if (entry === 'main') {
          assert.equal(await coordinator.main([], { LINEAR_API_TOKEN: 'linear', GITHUB_TOKEN: 'github', ENABLE_ROUTINE_MERGE: 'true' },
            { configPath, fetchImpl: h.args.fetchImpl, skipActivationPreflight: true, pollRuns: false, stdout() {}, now: h.args.now }), 0);
        } else assert.deepEqual(await h.consume(), { writes: 1, merges: 0 });
      } catch (error) { console.log(error.stack); throw error; }
    }, 'SHU259_PREPARED_RESTART: a surviving intent must durably HOLD without an escaping exception');
    const parsed = parseMergeAttemptsFromComments(h.comments, [ACTOR]);
    assert.equal(parsed.conflicts.size, 0, 'SHU259_PREPARED_RESTART: immutable intent must not be poisoned');
    assert.deepEqual(parsed.records, [{ ...prepared, state: 'HOLD', hold_code: 'REQUIRED_CHECKS_NOT_GREEN',
      reason: 'one or more required checks are absent, pending or non-green' }], 'SHU259_PREPARED_RESTART: typed HOLD must retain every prepared binding');
    assert.equal(h.mergeCalls(), 0, 'SHU259_PREPARED_RESTART: no PUT on restart');
    assert.deepEqual(await h.consume(), { writes: 0, merges: 0 }, 'SHU259_PREPARED_RESTART: terminal HOLD must replay without action');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SHU259_SCHEMA_BINDING', () => {
  const schema = JSON.parse(readFileSync(new URL('../receipt-schema.json', import.meta.url), 'utf8'));
  const codes = schema.properties.handoff.properties.hold_code.enum;
  for (const code of ['STALE_HEAD', 'INELIGIBLE_VERDICT', 'REQUIRED_CHECKS_NOT_GREEN', 'BLOCKING_REVIEW_THREAD',
    'EXPLICIT_HOLD', 'BRANCH_PROTECTION_UNSATISFIED', 'FORBIDDEN_MERGE_ACTION', 'AMBIGUOUS_GITHUB_RESPONSE',
    'BASE_ADVANCED', 'TREE_MISMATCH', 'AMBIGUOUS_MERGE_RESPONSE']) {
    assert.ok(codes.includes(code), `SHU259_SCHEMA_BINDING: canonical receipt schema must retain ${code}`);
  }
});

for (const field of ['pr_number', 'base_ref']) test(`prepared-binding-${field}`, async () => {
  const h = harness();
  const prepared = await strandPrepared(h);
  const fetchImpl = h.args.fetchImpl;
  const puts = [];
  h.args.fetchImpl = async (url, request = {}) => {
    if (request.method === 'PUT') puts.push(url);
    const response = await fetchImpl(url.replace('/pulls/8', '/pulls/7').replace('/branches/release', '/branches/main'), request);
    const body = await response.json();
    if (url.startsWith('https://api.github.com/repos/example/repo/pulls')) {
      if (field === 'pr_number') {
        if (Array.isArray(body)) body.forEach(pr => { pr.number = 8; });
        else if (body.number) body.number = 8;
      } else if (body.base) body.base.ref = 'release';
    }
    return { ...response, json: async () => body };
  };
  await h.consume();
  console.log(`binding ${field}: PUTs=${JSON.stringify(puts)} durable=${JSON.stringify(h.attempts().at(-1))}`);
  assert.equal(puts.length, 0, `SHU259_OBJECT_BINDING: changed ${field} must HOLD before PUT`);
  assert.deepEqual([h.attempts().at(-1)?.pr_number, h.attempts().at(-1)?.base_ref], [prepared.pr_number, 'main'],
    'SHU259_OBJECT_BINDING: attested PR and base ref must preserve the durable intent');
  assert.equal(h.attempts().at(-1)?.hold_code, field === 'pr_number' ? 'AMBIGUOUS_GITHUB_RESPONSE' : 'BASE_ADVANCED');
});

for (const strict of [false, undefined]) test(`base-freshness-strict-${strict}`, async () => {
  const h = harness();
  const fetchImpl = h.args.fetchImpl;
  h.args.fetchImpl = async (url, request = {}) => {
    const response = await fetchImpl(url, request);
    const body = await response.json();
    if (url.endsWith('/protection')) body.required_status_checks.strict = strict;
    return { ...response, json: async () => body };
  };
  await h.consume();
  console.log(`strict=${strict}: PUTs=${h.mergeCalls()} state=${h.attempts().at(-1)?.state}`);
  assert.equal(h.mergeCalls(), 0, 'SHU259_BASE_FRESHNESS: absent server freshness enforcement must HOLD before PUT');
  assert.equal(h.attempts().at(-1)?.hold_code, 'BRANCH_PROTECTION_UNSATISFIED');
});

// Captured once using the blocked 79c82947 implementation and the original
// harness. Never regenerate this fixture with the implementation under test.
for (const redCheck of [true, false]) test(`blocked-head-prepared-upgrade-red-${redCheck}`, async () => {
  const h = harness({ redCheck });
  const prepared = JSON.parse(readFileSync(new URL('./fixture/shu259-blocked-prepared.json', import.meta.url), 'utf8'));
  h.comments.push({ body: mergeAttemptCommentBody(prepared), createdAt: '2026-09-14T00:10:00.000Z', user: { id: ACTOR } });
  assert.equal(h.attempts().at(-1)?.state, 'PREPARED', 'SHU259_LEGACY_INTENT: read the original durable intent');
  await assert.doesNotReject(h.consume(), 'SHU259_LEGACY_INTENT: upgrade must preserve a legacy intent as typed HOLD');
  const parsed = parseMergeAttemptsFromComments(h.comments, [ACTOR]);
  assert.equal(parsed.conflicts.size, 0, 'SHU259_LEGACY_INTENT: no immutable conflict on upgrade');
  assert.equal(parsed.records.at(-1)?.hold_code, redCheck ? 'REQUIRED_CHECKS_NOT_GREEN' : 'BASE_ADVANCED');
  assert.equal(parsed.records.at(-1)?.pr_number, prepared.pr_number);
  assert.equal(h.mergeCalls(), 0, 'SHU259_LEGACY_INTENT: missing base ref must never authorize a new PUT');
});

test('strict-server-rejects-base-race', async () => {
  const h = harness();
  const fetchImpl = h.args.fetchImpl;
  let puts = 0;
  h.args.fetchImpl = async (url, request = {}) => {
    // A base move after the final GET is rejected by strict protection at PUT.
    if (request.method === 'PUT') {
      puts++;
      assert.equal(url, 'https://api.github.com/repos/example/repo/pulls/7/merge');
      assert.deepEqual(JSON.parse(request.body), { sha: HEAD, merge_method: 'squash' });
      return { ok: false, status: 405, json: async () => ({ message: 'Base branch was modified. Review and try the merge again.' }) };
    }
    return fetchImpl(url, request);
  };
  await h.consume();
  assert.equal(puts, 1, 'SHU259_BASE_RACE: exercise the conditional request');
  assert.equal(h.mergeCalls(), 0, 'SHU259_BASE_RACE: server rejection must leave the base unmodified');
  assert.deepEqual([h.attempts().at(-1)?.state, h.attempts().at(-1)?.hold_code], ['HOLD', 'AMBIGUOUS_MERGE_RESPONSE']);
  assert.deepEqual(await h.consume(), { writes: 0, merges: 0 });
});

for (const phase of ['pre-merge', 'recovery', 'merged-restart']) {
  for (const field of ['pr_number', 'base_ref']) test(`binding-${phase}-${field}`, async () => {
    const h = harness();
    // Retain the original comments; GitHub reports a merge after the process stops.
    if (phase === 'merged-restart') await strandPrepared(h);
    const fetchImpl = h.args.fetchImpl;
    let lookups = 0, puts = 0;
    h.args.fetchImpl = async (url, request = {}) => {
      if (url.includes('/pulls?state=all')) lookups++;
      if (request.method === 'PUT') puts++;
      const response = await fetchImpl(url.replace('/pulls/8', '/pulls/7').replace('/branches/release', '/branches/main'), request);
      const body = await response.json();
      const changed = phase === 'merged-restart' || (phase === 'pre-merge' ? lookups >= 2 : puts > 0);
      if (changed && url.startsWith('https://api.github.com/repos/example/repo/pulls')) {
        if (phase === 'merged-restart') {
          for (const pr of Array.isArray(body) ? body : [body]) Object.assign(pr, { state: 'closed',
            merged: true, merged_at: '2026-09-14T00:20:00Z', merge_commit_sha: MERGE });
        }
        if (field === 'pr_number') {
          if (Array.isArray(body)) body.forEach(pr => { pr.number = 8; });
          else if (body.number) body.number = 8;
        } else if (body.base) body.base.ref = 'release';
      }
      return { ...response, json: async () => body };
    };
    await assert.doesNotReject(h.consume());
    assert.equal(puts, phase === 'recovery' ? 1 : 0, 'SHU259_RECOVERY_BINDING: no PUT using changed identity');
    assert.equal(h.attempts().at(-1)?.state, 'HOLD', 'SHU259_RECOVERY_BINDING: never attest a different PR or base');
    assert.equal(h.attempts().at(-1)?.hold_code, field === 'pr_number' ? 'AMBIGUOUS_GITHUB_RESPONSE' : 'BASE_ADVANCED');
    assert.deepEqual([h.attempts().at(-1)?.pr_number, h.attempts().at(-1)?.base_ref], [7, 'main']);
  });
}
