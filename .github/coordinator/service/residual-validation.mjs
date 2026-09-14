// Local acceptance assertions; never installs services or contacts production.
import assert from 'node:assert/strict';
import { createEpisodeHarness } from '../test/fixture/episode-harness.mjs';
import { tree, assertQuiet } from './verify.mjs';

export const POSITIVE = 'SHU251_GATE_OFF_POSITIVE_CONTROL: the same eligible pending work with free capacity must launch exactly once when only the gate changes';
export async function verifyGatePositiveControl({ suppressLaunch = false } = {}) {
  const h = createEpisodeHarness();
  try {
    let writes = 0;
    const io = { fetchImpl: async (url, options) => {
      if (/\bmutation\b/.test(JSON.parse(options.body).query)) writes++;
      return h.fetchImpl(url, options);
    } };
    const capture = () => structuredClone({ files: tree(h.dir), comments: h.comments, pauses: h.pauses, triggers: h.triggers, launched: h.launched });
    const before = capture();
    const off = await h.runTick({ env: { ENABLE_DISPATCH: 'false' }, io });
    assert.equal(off.code, 0, POSITIVE);
    assert.match(off.text, /DRY-RUN \(dispatch disabled, no writes\)/, POSITIVE);
    assert.match(off.text, /eligible=1\s+excluded=0/, POSITIVE);
    assert.match(off.text, /next reservation \(if dispatch were on\): SHU-140 via codex-cli/, POSITIVE);
    assertQuiet(before, capture(), h.launched.length, writes);
    // Only the mutation changes the adapter; the ordinary paired ticks share
    // the exact same config, clock, pending issue, state, capacity and IO.
    if (suppressLaunch) h.adapters['codex-cli'].launchBuilder = async () => ({ stage: 'HOLD' });
    const on = await h.runTick({ env: { ENABLE_DISPATCH: 'true' }, io });
    assert.equal(on.code, 0, POSITIVE);
    assert.equal(h.launched.length, 1, POSITIVE);
    assert.ok(writes > 0, POSITIVE);
    return { off: { launches: 0, writes: 0, eligibleButRefused: true }, on: { launches: h.launched.length, writes }, configGate: h.config.enable_dispatch };
  } finally { h.cleanup(); }
}

export const SHAPE = 'SHU251_STATUS_SHAPE: status must match the documented v2 schema';
export const RECEIPT = 'SHU251_STATUS_RECEIPT: a launch claim requires a matching durable launch receipt';
export function assertStatusShape(status, { store, attemptId } = {}) {
  assert.ok(status && typeof status === 'object' && !Array.isArray(status), SHAPE);
  assert.equal(typeof status.ok, 'boolean', SHAPE);
  const keys = status.ok ? ['version', 'ok', 'durable', 'attempt_id', 'target_sha', 'stage', 'result', 'heartbeat'] : ['ok', 'stage', 'reason'];
  assert.deepEqual(Object.keys(status).sort(), keys.sort(), SHAPE);
  if (!status.ok) {
    assert.equal(status.stage, 'HOLD', SHAPE);
    assert.equal(typeof status.reason, 'string', SHAPE);
    return;
  }
  assert.equal(status.version, '2.0.0', SHAPE);
  assert.equal(status.durable, true, SHAPE);
  assert.equal(typeof status.attempt_id, 'string', SHAPE);
  assert.match(status.attempt_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, SHAPE);
  assert.equal(typeof status.target_sha, 'string', SHAPE);
  assert.match(status.target_sha, /^[0-9a-f]{40}$/, SHAPE);
  assert.ok(['ACCEPTED', 'RUNNING', 'HOLD', 'COMPLETED', 'FAILED'].includes(status.stage), SHAPE);
  assert.ok(status.result === null || (typeof status.result === 'object' && !Array.isArray(status.result)), SHAPE);
  assert.ok(status.heartbeat === null || (typeof status.heartbeat === 'string' && Number.isFinite(Date.parse(status.heartbeat))), SHAPE);
  if (['RUNNING', 'COMPLETED', 'FAILED'].includes(status.stage)) {
    assert.ok(store && attemptId === status.attempt_id && store.hasLaunch(attemptId), RECEIPT);
    const launch = store.readLaunch(attemptId);
    assert.ok(launch.attempt_id === attemptId && launch.phase === 'spawn_attempted' && /^[0-9a-f]{64}$/.test(launch.completion_token_hash), RECEIPT);
    assert.equal(store.readOrder(attemptId).target_sha, status.target_sha, RECEIPT);
  }
}
