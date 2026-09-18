import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sign, createHash } from 'node:crypto';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { createEpisodeHarness } from '../../test/fixture/episode-harness.mjs';
import { canonicalBytes } from '../../shu71-activation-package.mjs';

import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const credential = '/srv/shu/state/shu71-activation.json';
const lease = '/srv/shu/state/shu71-evidence/active.json';
const gates = ['coordinator', 'supervisor'].map(n => `/etc/systemd/system/shu-${n}.service.d/90-shu71.conf`);
const effects = (p, start) => p.events.slice(start).filter(e => /^(write:|rename:|unlink:|remove:|command:|api:)/.test(e)).length;
const shared = p => [...gates, credential, lease].map(f => p.exists(f) ? p.read(f) : null);

async function composition(t) {
  const p = productionFixture(t, keys), pkg = p.spec.pkg;
  const config = JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url)));
  const lanes = [config.fixture_lane, ...config.fixture_lanes];
  for (const f of [...pkg.fixtures, ...pkg.activation.fixtures]) f.lane = structuredClone(lanes.find(l => l.id === f.issue_id));
  p.write(`/etc/shu/approvals/${p.id}.shu71.json`, JSON.stringify({ payload: p.spec,
    signature: sign(null, canonicalBytes(p.spec, false), keys.privateKey).toString('base64') }));
  const execute = action => createShu71Production(p.id, p.boundary).execute(action);
  const armStart = p.events.length;
  assert.equal((await execute('run')).state, 'ARMED', 'B1_PRODUCTION_ARM');
  // Preserve the original 116 operations, five identity reads, and exactly
  // four new journal writes (RUN_ATTEMPT_STARTED, INTENT, CHECK_STARTED, DONE), plus seven ruled runtime operations (three probes and four receipt writes/renames).
  assert.equal(effects(p, armStart), 116 + 5 + 7 + 4, 'B1_ARM_EFFECT_COUNT');
  assert.deepEqual(p.events.slice(armStart).filter(e => e.startsWith('command:')).slice(0, 5), [
    'command:/usr/bin/systemctl:show --property=User --value shu-supervisor.service',
    'command:/usr/bin/systemctl:show --property=Group --value shu-supervisor.service',
    'command:/usr/bin/id:-u shu-coordinator',
    'command:/usr/bin/id:-g shu-coordinator',
    'command:/usr/bin/id:-gn shu-coordinator',
  ], 'CLOSURE_ARM_IDENTITY_READ_ARGV');
  const signed = p.read(credential);
  config.two_fixture_activation_public_key = keys.publicKey.export({ type: 'spki', format: 'pem' });
  config.fixture_lane = pkg.fixtures[0].lane;
  config.fixture_lanes = [pkg.fixtures[1].lane];
  const actor = config.linear_receipt_actor_ids[0];
  const h = createEpisodeHarness({ revision: pkg.coordinator_revision, activationId: p.id,
    nodeId: pkg.fixtures[0].linear_id, callbackActor: actor, githubToken: 'synthetic',
    initialBranchHead: pkg.fixtures[0].seed_head, now: p.context.now, configOverrides: config,
    extraNodes: [{ id: pkg.fixtures[1].linear_id, identifier: 'SHU-254', title: 'second fixture',
      state: { name: 'Todo' }, priorityLabel: 'Low', labels: { nodes: [{ name: 'repo:platform' }] },
      assignee: null, delegate: null, parent: null, relations: { nodes: [] } }] });
  t.after(h.cleanup);
  // Copy only transport bytes, not a independently constructed activation.
  fs.writeFileSync(h.activationPath, signed);
  const heads = new Map(pkg.fixtures.map(f => [f.branch, f.seed_head]));
  const pushes = new Map(), edges = [], trace = [];
  const latest = id => h.receipts().filter(r => r.issue_id === id).at(-1);
  const snapshot = () => ({ gates: gates.map(f => p.read(f)), credential: p.read(credential),
    lease: JSON.parse(p.read(lease)), complete: p.journal().some(e => e.event === 'TEARDOWN_COMPLETE') });
  const armed = { gates: gates.map(() => '[Service]\nEnvironment=ENABLE_DISPATCH=true\n'), credential: signed,
    lease: { activation_id: p.id }, complete: false };
  async function tick() {
    const start = p.events.length;
    assert.equal((await execute('expire')).state, 'NOT_EXPIRED', 'B1_LIVE_WAKE');
    const result = await h.runTick({ io: {
      mainRevision: pkg.coordinator_revision,
      fixtureHeadResolver: branch => heads.get(branch),
      fixtureAncestryResolver: (base, head) => edges.some(e => e[0] === base && e[1] === head),
      readProgressionPush: receipt => pushes.get(receipt.attempt_id) ?? null,
      deriveScopedBaseSha: async () => 'd'.repeat(40), prepareWorkspace: async () => ({ cwd: h.dir }),
      fetchImpl: async (url, opts) => {
        if (String(url).includes('/branches/')) {
          const branch = decodeURIComponent(String(url).split('/branches/')[1]);
          return { ok: true, status: 200, json: async () => ({ commit: { sha: heads.get(branch) } }) };
        }
        const response = await h.fetchImpl(url, opts);
        for (const c of h.comments) if (c.body.startsWith('<!-- coordinator-receipt') && !c.user) c.user = { id: actor };
        const request = JSON.parse(opts?.body ?? '{}');
        if (request.query?.includes('CoordinatorIssueComments')) {
          const payload = await response.json();
          const issue = h.nodes.find(n => n.id === request.variables.issueId)?.identifier;
          payload.data.issue.comments.nodes = payload.data.issue.comments.nodes.filter(c => {
            const value = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(c.body)?.[1] ?? '{}');
            return value.issue_id ? value.issue_id === issue : h.receipts().some(r => r.issue_id === issue && r.attempt_id === value.attempt_id);
          });
          return { ...response, json: async () => payload };
        }
        return response;
      },
    } });
    assert.equal(result.code, 0, `B1_COORDINATOR_TICK: ${result.text}`);
    assert.deepEqual(snapshot(), armed, 'B1_ARMED_STATE_TABLE');
    assert.equal(effects(p, start), 0, 'B1_LIVE_WAKE_ZERO_EFFECTS');
    return result;
  }
  async function expect(id, role, head) {
    await tick(); const observed = await tick();
    const r = latest(id);
    assert.ok(r, 'B1_RECEIPT_PRESENT');
    assert.equal(r?.role, role === 'build' ? undefined : role, `B1_SEQUENCE_${id}_${role}: ${observed.text}`);
    assert.equal(r.requested_worker, role === 'review' ? 'claude-verifier' : 'codex-builder', 'B1_WORKER_ROLE');
    assert.equal(r.stage, 'RUNNING', 'B1_RUNNING');
    assert.equal(r.target_sha, head, 'B1_EXACT_HEAD');
    assert.equal(r.activation_digest, createHash('sha256').update(canonicalBytes(JSON.parse(signed))).digest('hex'), 'B1_SIGNED_DIGEST');
    assert.equal(r.episode_id, p.id, 'B1_EXACT_EPISODE');
    assert.equal(r.branch, `coordinator/${id}`, 'B1_EXACT_BRANCH');
    assert.equal(h.launched.find(l => l.attempt_id === r.attempt_id)?.target_sha, head, 'B1_LAUNCH_EXACT_HEAD');
    trace.push(`${id}:${role}`);
    return r;
  }
  async function finish(r, verdict, head) {
    if (head !== r.target_sha) {
      // External broker boundary response, not a progression/reconcile helper.
      pushes.set(r.attempt_id, { stage: 'PUSHED', attempt_id: r.attempt_id, target_sha: r.target_sha,
        result_sha: head, branch: r.branch, repo: r.repo, update_mode: 'fast-forward' });
      edges.push([r.target_sha, head]);
      // The evidence API can establish transitive ancestry from the signed seed.
      for (const [base, to] of [...edges]) if (to === r.target_sha) edges.push([base, head]);
      heads.set(r.branch, head);
    }
    h.postCallback({ attemptId: r.attempt_id, stage: verdict, targetSha: r.target_sha, resultSha: head });
    h.completeRun(r.external_run_id);
    await tick();
    const folded = h.receiptFor(r.attempt_id);
    assert.equal(folded.verdict_stage, verdict, `B1_CALLBACK_FOLDED_${verdict}`);
    assert.equal(folded.stage, verdict === 'BLOCKED' ? 'HOLD' : 'COMPLETED', `B1_TERMINAL_STATE_${verdict}`);
    assert.equal(folded.result_sha, head, 'B1_RESULT_EXACT_HEAD');
  }
  async function lane(id, start) {
    const seed = heads.get(`coordinator/${id}`), built = (id === 'SHU-140' ? '1' : '3').repeat(40), revised = (id === 'SHU-140' ? '2' : '4').repeat(40);
    const build = start ?? await expect(id, 'build', seed);
    await finish(build, 'BUILD_READY', built);
    const review = await expect(id, 'review', built);
    await finish(review, 'BLOCKED', built);
    const revise = await expect(id, 'revise', built);
    await finish(revise, 'REVISION_READY', revised);
    const rereview = await expect(id, 'review', revised);
    assert.notEqual(rereview.attempt_id, review.attempt_id, 'B1_NEW_REVIEW_ATTEMPT');
    await finish(rereview, 'PASS', revised);
    return rereview;
  }
  return { p, h, execute, expect, finish, lane, trace, heads, pkg, signed };
}

test('B1_SINGLE_LANE: production credential drives coordinator build BLOCK revision re-review', async t => {
  const c = await composition(t);
  // Only SHU-140 is eligible; the signed production package still binds both fixtures.
  c.h.nodes[1].state.name = 'Backlog';
  await c.lane('SHU-140');
  assert.deepEqual(c.trace, ['SHU-140:build', 'SHU-140:review', 'SHU-140:revise', 'SHU-140:review'], 'B1_SINGLE_ORDER');
  assert.equal(c.h.launched.length, 4, 'B1_SINGLE_FOUR_LAUNCHES');
  assert.equal(c.heads.get('coordinator/SHU-254'), c.pkg.fixtures[1].seed_head, 'B1_SINGLE_OTHER_HEAD_UNTOUCHED');
  const cleanupStart = c.p.events.length;
  assert.equal((await c.execute('resume')).state, 'REVOKED', 'B1_RESUME_REVOKES_ARMED');
  assert.equal(effects(c.p, cleanupStart), 68, 'B1_RESUME_EFFECT_COUNT');
  assert.deepEqual(shared(c.p), [gates.map(() => '[Service]\nEnvironment=ENABLE_DISPATCH=false\n'), null, null].flat(), 'B1_RETIRED_STATE_TABLE');
  assert.equal(c.p.journal().filter(e => e.event === 'TEARDOWN_COMPLETE').length, 1, 'B1_ONE_COMPLETION_RECORD');
  const repeatStart = c.p.events.length;
  assert.equal((await c.execute('revoke')).state, 'REVOKED', 'B1_REVOKE_IDEMPOTENT');
  assert.equal(effects(c.p, repeatStart), 4, 'B1_REVOKE_OBSERVATION_ONLY');
});

test('B1_TWO_LANES: B completes while A revision remains running, then A completes', async t => {
  const c = await composition(t);
  const a = await c.expect('SHU-140', 'build', c.pkg.fixtures[0].seed_head);
  await c.finish(a, 'BUILD_READY', '1'.repeat(40));
  const review = await c.expect('SHU-140', 'review', '1'.repeat(40));
  await c.finish(review, 'BLOCKED', '1'.repeat(40));
  const revision = await c.expect('SHU-140', 'revise', '1'.repeat(40));
  await c.lane('SHU-254');
  assert.equal(c.h.receiptFor(revision.attempt_id).stage, 'RUNNING', 'B1_REAL_OVERLAP_A_REVISION_RUNNING_AFTER_B_PASS');
  assert.equal(c.h.receipts().filter(r => r.issue_id === 'SHU-254').at(-1).verdict_stage, 'PASS', 'B1_REAL_OVERLAP_B_FINISHED');
  await c.finish(revision, 'REVISION_READY', '2'.repeat(40));
  const rereview = await c.expect('SHU-140', 'review', '2'.repeat(40));
  assert.notEqual(rereview.attempt_id, review.attempt_id, 'B1_INTERLEAVED_NEW_REVIEW');
  await c.finish(rereview, 'PASS', '2'.repeat(40));
  assert.deepEqual(c.trace, ['SHU-140:build', 'SHU-140:review', 'SHU-140:revise', 'SHU-254:build', 'SHU-254:review', 'SHU-254:revise', 'SHU-254:review', 'SHU-140:review'], 'B1_INTERLEAVED_ORDER');
  assert.equal(c.h.launched.length, 8, 'B1_TWO_EIGHT_LAUNCHES');
  assert.deepEqual(c.h.launched.map(l => { const r = c.h.receiptFor(l.attempt_id); return `${r.issue_id}:${r.role ?? 'build'}`; }), c.trace, 'B1_ACTUAL_LAUNCH_ORDER');

  c.p.expire();
  const cleanupStart = c.p.events.length;
  assert.equal((await c.execute('expire')).state, 'REVOKED', 'B1_EXPIRED_TEARDOWN');
  assert.equal(effects(c.p, cleanupStart), 72, 'B1_EXPIRY_EFFECT_COUNT');
  assert.deepEqual(gates.map(g => c.p.read(g)), gates.map(() => '[Service]\nEnvironment=ENABLE_DISPATCH=false\n'), 'B1_EXPIRED_GATES');
  assert.equal(c.p.journal().filter(e => e.event === 'TEARDOWN_COMPLETE').length, 1, 'B1_EXPIRED_ONE_COMPLETION');
  assert.equal(c.p.exists(credential), false, 'B1_EXPIRED_CREDENTIAL_REVOKED');
  assert.equal(c.p.exists(lease), false, 'B1_EXPIRED_LEASE_RELEASED');
});

// Gates/credential/lease belong to an activation containing BOTH fixtures, not
// to a lane. Exercise real successor arming on the SAME boundary and filesystem.
test('B1_CROSS_TEARDOWN: retired A wake protects B, retired B wake protects next A', async t => {
  const p = productionFixture(t, keys);
  const execute = (id, action) => createShu71Production(id, p.boundary).execute(action);
  assert.equal((await execute(p.id, 'run')).state, 'ARMED', 'B1_CROSS_INITIAL_ARM');
  let current = p.id;
  for (const [direction, next, seed] of [['A_TO_B', 'shu71-successor-B', '5'], ['B_TO_A', 'shu71-successor-A', '6']]) {
    const pkg = p.spec.pkg;
    pkg.reseed.expected_parent = pkg.reseed.expected_seed_head;
    pkg.reseed.expected_seed_head = seed.repeat(40);
    Object.assign(p.spec.binding, pkg.reseed);
    pkg.fixtures[0].seed_head = pkg.reseed.expected_seed_head;
    pkg.activation.fixtures[0].seed_head = pkg.reseed.expected_seed_head;
    pkg.activation_id = next; pkg.activation.activation_id = next;
    pkg.evidence.journal_path = `/srv/shu/state/shu71-evidence/${next}/journal.jsonl`;
    pkg.evidence.archive_path = `/srv/shu/state/shu71-evidence/${next}/activation.json`;
    p.write(`/etc/shu/approvals/${next}.shu71.json`, JSON.stringify({ payload: p.spec,
      signature: sign(null, canonicalBytes(p.spec, false), keys.privateKey).toString('base64') }));
    const beforeConflict = shared(p);
    assert.equal((await execute(next, 'run')).code, 'ACT_ACTIVATION_CONFLICT', `B1_SERIAL_EPISODES_${direction}`);
    assert.deepEqual(shared(p), beforeConflict, `B1_CONFLICT_UNTOUCHED_${direction}`);
    assert.equal((await execute(current, 'revoke')).state, 'REVOKED', `B1_RETIRE_${direction}`);
    assert.equal((await execute(next, 'run')).state, 'ARMED', `B1_SUCCESSOR_ARM_${direction}`);
    const beforeWake = shared(p), start = p.events.length;
    const wake = await execute(current, 'expire');
    assert.equal(wake.receipt_scope, 'retired_episode', `B1_RETIRED_WAKE_${direction}`);
    assert.equal(wake.physical_teardown_observed, false, `B1_NO_FALSE_OBSERVATION_${direction}`);
    assert.deepEqual(shared(p), beforeWake, `B1_SUCCESSOR_GATES_CREDENTIAL_LEASE_UNTOUCHED_${direction}`);
    assert.equal(effects(p, start), 0, `B1_RETIRED_ZERO_EFFECTS_${direction}`);
    current = next;
  }
  assert.equal((await execute(current, 'revoke')).state, 'REVOKED', 'B1_CROSS_FINAL_CLEANUP');
});
