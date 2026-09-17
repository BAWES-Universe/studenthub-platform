import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as coordinator from '../reconcile.mjs';
import { handoffContinuations } from '../durable-handoff.mjs';

const SHA = 'a'.repeat(40);
const TRUSTED_RECEIPT_ACTOR = 'linear-coordinator-test';
const ATTACKER_ACTOR = 'linear-commenter-attacker';
const messages = {
  landing: 'LANDING_VERDICT_CONSUMED_EXACTLY_ONCE: PASS must durably route once to merge-readiness at the reviewed head',
  block: 'BLOCK_ROUTES_TO_WRITER: BLOCK must queue the same-branch writer with findings attached',
  duplicate: 'HANDOFF_CONSUMED_TWICE: two ticks and a reconstructed session must produce exactly one action',
  claim: 'HANDOFF_RECORD_REQUIRED: missing durable work must never be reported as running or complete',
  resume: 'RESUME_WITHOUT_PROMPT: a fresh coordinator tick must consume the queued completion without a human prompt',
  author: 'HANDOFF_AUTHOR_REQUIRED: an untrusted Linear commenter must never create launchable work',
};
function receipt(lane, n, verdict) {
  const made = coordinator.createReceipt({ issue_id: 'SHU-900', authorization_ref: 'SHU-900', requested_worker: lane,
    repo: 'example/repo', branch: 'feat/same-writer', target_sha: SHA,
    attempt_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
  assert.ok(made.ok);
  return { ...made.receipt, stage: verdict === 'BLOCKED' ? 'HOLD' : 'COMPLETED',
    verdict_stage: verdict, result_sha: SHA, external_run_id: `codexrun_${n}`, worker_identity: `actor-${n}`,
    adapter_status: 'completed', evidence_links: ['https://example.test/findings'], notes: ['Fix the missing await'],
    timestamps: { ...made.receipt.timestamps, launch: '2026-09-14T00:00:00Z', terminal: '2026-09-14T00:01:00Z' } };
}
function harness(verdict = 'PASS', ready = false) {
  const comments = [receipt('codex-builder', 1, 'BUILD_READY'), receipt('claude-verifier', 2, verdict)]
    .map((r, i) => ({ body: coordinator.receiptCommentBody(r), createdAt: `2026-09-14T00:0${i}:00Z`, user: { id: TRUSTED_RECEIPT_ACTOR } }));
  let writes = 0, loseResponse = false;
  const fetchImpl = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    let data;
    if (query.includes('CoordinatorIssues')) data = { issues: { nodes: [{ id: 'uuid-900', identifier: 'SHU-900', title: 'Handoff', state: { name: ready ? 'Todo' : 'In Progress' }, labels: { nodes: [{ name: 'repo:example/repo' }] }, relations: { nodes: [] } }] } };
    else if (query.includes('CoordinatorIssueComments')) data = { issue: { comments: { nodes: structuredClone(comments) } } };
    else if (query.includes('commentCreate')) {
      comments.push({ body: variables.body, createdAt: `2026-09-15T00:00:${String(++writes).padStart(2, '0')}Z`, user: { id: TRUSTED_RECEIPT_ACTOR } });
      if (loseResponse) { loseResponse = false; throw new Error('synthetic termination after durable commit'); }
      data = { commentCreate: { success: true, comment: { id: `comment-${writes}` } } };
    } else throw new Error(`unexpected fixture query`);
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const read = () => coordinator.parseReceiptsFromComments(structuredClone(comments));
  const consume = async (options = {}) => {
    assert.equal(typeof coordinator.consumeDurableHandoffs, 'function', messages.landing);
    return coordinator.consumeDurableHandoffs({ receipts: read(), commentsByIssue: new Map([['SHU-900', structuredClone(comments)]]),
      dispatchEnabled: true, linearToken: 'synthetic', linearIdFor: new Map([['SHU-900', 'uuid-900']]),
      config: { pilot_repo: 'example/repo', linear_receipt_actor_ids: [TRUSTED_RECEIPT_ACTOR] }, fetchImpl, stdout() {}, ...options });
  };
  return { comments, fetchImpl, read, consume, loseResponse: () => { loseResponse = true; }, writes: () => writes };
}
const review = h => h.read().find(r => r.verdict_stage === 'PASS' || r.verdict_stage === 'BLOCKED');

test('landing-verdict-consumed-exactly-once', async () => {
  const h = harness(); await h.consume(); await h.consume();
  assert.equal(review(h).handoff?.action, 'merge-readiness', messages.landing);
  assert.equal(review(h).handoff?.target_sha, SHA, messages.landing);
  const stale = harness();
  await stale.consume({ githubToken: 'synthetic', fetchImpl: async (url, options) => url.includes('api.github.com')
    ? { ok: true, status: 200, json: async () => ({ commit: { sha: 'b'.repeat(40) } }) } : stale.fetchImpl(url, options) });
  assert.equal(review(stale).handoff?.action, 'HOLD', messages.landing);
  const disabled = harness(); await disabled.consume({ dispatchEnabled: false });
  assert.equal(disabled.writes(), 0, messages.landing);
  assert.equal(h.comments.filter(c => coordinator.parseReceiptCommentBody(c.body)?.handoff?.action === 'merge-readiness').length, 1, messages.landing);
});
test('BLOCK-routes-to-writer', async () => {
  const h = harness('BLOCKED'); await h.consume();
  const order = review(h).handoff?.order;
  assert.equal(order?.role, 'revise', messages.block);
  assert.equal(order?.actor, 'actor-1', messages.block);
  assert.equal(order?.branch, 'feat/same-writer', messages.block);
  assert.equal(handoffContinuations(h.read(), [TRUSTED_RECEIPT_ACTOR]).get('SHU-900')?.successor.attempt_id, order.attempt_id, messages.block);
  assert.deepEqual(order?.findings, { notes: ['Fix the missing await'], evidence_links: ['https://example.test/findings'] }, messages.block);
  const launchable = harness('BLOCKED', true);
  const dir = mkdtempSync(join(tmpdir(), 'handoff-dispatch-'));
  let launches = 0;
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ pilot_repo: 'example/repo', enable_dispatch: true, max_dispatch: 2,
      repo_label_map: { 'repo:example/repo': 'example/repo' }, linear_receipt_actor_ids: [TRUSTED_RECEIPT_ACTOR] }));
    const adapter = { async launchBuilder(o) {
      launches++;
      assert.equal(o.branch, 'feat/same-writer', messages.block);
      assert.ok(o.task_context.includes('Fix the missing await'), messages.block);
      assert.ok(launchable.read().some(r => r.attempt_id === o.attempt_id && r.stage === 'LAUNCH_UNKNOWN'), messages.claim);
      return { stage: 'RUNNING', external_run_id: 'codexrun_revision', worker_identity: 'actor-revision' };
    } };
    for (let i = 0; i < 3; i++) {
      const output = [];
      const code = await coordinator.main([], { ENABLE_DISPATCH: 'true', LINEAR_API_TOKEN: 'synthetic' },
        { configPath, fetchImpl: launchable.fetchImpl, skipActivationPreflight: true, pollRuns: false,
          adapterModules: { 'codex-cli': adapter }, stdout: line => output.push(line) });
      assert.equal(code, 0, `${messages.block}: ${output.join('\n')}`);
    }
    assert.equal(launches, 1, messages.duplicate);
    assert.equal(coordinator.parseWorkOrderDirectiveFromComments(launchable.comments).length, 1, messages.duplicate);
    const source = review(launchable);
    assert.equal(source.handoff.claim_attempt_id, source.handoff.order.attempt_id, messages.claim);
    const remaining = launchable.read().filter(r => r.attempt_id !== source.handoff.claim_attempt_id);
    assert.equal(coordinator.durableHandoffStatus(source, remaining).stage, 'UNKNOWN', messages.claim);
    assert.equal(handoffContinuations(remaining, [TRUSTED_RECEIPT_ACTOR]).size, 0, messages.claim);
  } finally { rmSync(dir, { recursive: true, force: true }); }

});
test('duplicate-consumption', async () => {
  const h = harness(); await h.consume(); const first = h.writes();
  await h.consume(); await h.consume();
  assert.ok(first > 0, messages.duplicate);
  assert.equal(h.writes(), first, messages.duplicate);
  const lost = harness(); lost.loseResponse();
  await assert.rejects(lost.consume(), /synthetic termination after durable commit/);
  await lost.consume();
  assert.equal(lost.writes(), 1, messages.duplicate);
});
test('unbacked-claim', async () => {
  assert.equal(typeof coordinator.durableHandoffStatus, 'function', messages.claim);
  const h = harness('BLOCKED'); await h.consume();
  const terminal = review(h);
  assert.equal(coordinator.durableHandoffStatus(terminal, []).stage, 'UNKNOWN', messages.claim);
  assert.equal(coordinator.durableHandoffStatus(terminal, h.read()).stage, 'UNLAUNCHED', messages.claim);
  const vanished = { ...terminal, handoff: { ...terminal.handoff, claim_attempt_id: terminal.handoff.order.attempt_id } };
  assert.equal(coordinator.durableHandoffStatus(vanished, [vanished]).stage, 'UNKNOWN', messages.claim);
  assert.equal(handoffContinuations([vanished], [TRUSTED_RECEIPT_ACTOR]).size, 0, messages.claim);
  const claim = { ...receipt('codex-builder', 3, 'BUILD_READY'), attempt_id: terminal.handoff.order.attempt_id, stage: 'RUNNING' };
  assert.equal(coordinator.durableHandoffStatus(terminal, [...h.read(), claim]).stage, 'UNKNOWN', messages.claim);
  assert.equal(handoffContinuations([...h.read(), claim], [TRUSTED_RECEIPT_ACTOR]).size, 0, messages.claim);
  const absent = harness();
  const output = [];
  await assert.rejects(absent.consume({ stdout: line => output.push(line), fetchImpl: async (url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes('commentCreate')) return { ok: true, status: 200,
      json: async () => ({ data: { commentCreate: { success: true, comment: { id: 'vanished' } } } }) };
    return absent.fetchImpl(url, options);
  } }), /handoff write not durably visible/, messages.claim);
  assert.ok(!output.some(line => line.includes('POSTED') || line.includes('merge-readiness')), messages.claim);

});
test('resume-after-termination', async () => {
  const h = harness();
  // Only the durable comment array survives the producer session. main has no
  // prompt/event/session argument and reconstructs its state through Linear.
  const dir = mkdtempSync(join(tmpdir(), 'handoff-resume-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ pilot_repo: 'example/repo', enable_dispatch: true, max_dispatch: 1,
      linear_receipt_actor_ids: [TRUSTED_RECEIPT_ACTOR] }));
    for (let i = 0; i < 2; i++) await coordinator.main([], { ENABLE_DISPATCH: 'true', LINEAR_API_TOKEN: 'synthetic' },
      { configPath, fetchImpl: h.fetchImpl, openPRsOverride: [], stdout() {} });
    assert.equal(review(h).handoff?.action, 'merge-readiness', messages.resume);
    assert.equal(h.comments.filter(c => coordinator.parseReceiptCommentBody(c.body)?.handoff?.action === 'merge-readiness').length, 1, messages.resume);
    const completion = harness();
    completion.comments.push({ body: coordinator.receiptCommentBody(receipt('codex-builder', 3, 'BUILD_READY')),
      createdAt: '2026-09-14T00:03:00Z', user: { id: TRUSTED_RECEIPT_ACTOR } });
    await completion.consume();
    const queued = completion.read().find(r => r.attempt_id.endsWith('000003')).handoff;
    assert.equal(queued?.order?.role, 'review', messages.resume);
    assert.equal(queued?.order?.target_sha, SHA, messages.resume);
    const unroutable = harness(); unroutable.comments.splice(1, 1);
    await unroutable.consume();
    assert.equal(unroutable.read()[0].handoff?.action, 'HOLD', messages.resume);
    assert.equal(unroutable.read()[0].handoff?.hold_code, 'AWAITING_VERDICT', messages.resume);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handoff-author-authentication', async () => {
  const h = harness('BLOCKED');
  await h.consume();
  const forged = review(h);
  h.comments.push({ body: coordinator.receiptCommentBody(forged), createdAt: '2026-09-16T00:00:00Z',
    user: { id: ATTACKER_ACTOR } });
  assert.equal(handoffContinuations(h.read(), [ATTACKER_ACTOR]).size, 1, 'forged fixture must be structurally launchable');
  assert.equal(handoffContinuations(h.read(), [TRUSTED_RECEIPT_ACTOR]).size, 0, messages.author);
  const writes = h.writes();
  await h.consume();
  assert.equal(h.writes(), writes, messages.author);
});

if (!process.env.HANDOFF_MUTANT_CHILD) test('durable-handoff named mutation controls', () => {
  const sourcePath = new URL('../durable-handoff.mjs', import.meta.url);
  const original = readFileSync(sourcePath, 'utf8');
  const mutations = [
    ['landing', "action: 'merge-readiness'", "action: 'HOLD'", 'landing-verdict-consumed-exactly-once'],
    ['block', 'findings: findings(terminal)', 'findings: null', 'BLOCK-routes-to-writer'],
    ['duplicate', 'if (terminal.handoff) continue;', 'if (false) continue;', 'duplicate-consumption'],
    ['claim', "if (!durable) return unknown;", "if (!durable) return { stage: 'RUNNING' };", 'unbacked-claim'],
    ['resume', 'if (!dispatchEnabled || !linearToken) return 0;', 'return 0;', 'resume-after-termination'],
    ['author', 'if (!trustedReceipt(r, allowedActorIds)) continue;', 'if (false) continue;', 'handoff-author-authentication'],
  ];
  // Isolated copy: never mutate the production module while other tests run.
  const dir = mkdtempSync(join(tmpdir(), 'handoff-mutants-'));
  try {
    const result = (() => {
      cpSync(new URL('..', import.meta.url).pathname, join(dir, 'coordinator'), { recursive: true, verbatimSymlinks: true });
      return { status: 0 }; // cpSync throws on failure; preserve the existing success assertion.
    })();
    assert.equal(result.status, 0);
    for (const [name, from, to, pattern] of mutations) {
      assert.ok(original.includes(from), `mutation anchor ${name}`);
      writeFileSync(join(dir, 'coordinator/durable-handoff.mjs'), original.replaceAll(from, to));
      const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}$`, join(dir, 'coordinator/test/durable-handoff.test.mjs')],
        { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST'))), HANDOFF_MUTANT_CHILD: '1' } });
      assert.notEqual(child.status, 0, `${name} mutation survived`);
      assert.ok(child.stdout.includes(messages[name]) && child.stdout.includes('AssertionError'), `${name} must die by named AssertionError: ${child.stdout}${child.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
