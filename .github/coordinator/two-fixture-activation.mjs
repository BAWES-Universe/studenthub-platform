// Read-only authorization verifier. No record writer, gate setter or launcher.
import { verify, createPublicKey } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveFixtureLane, validateFixtureScopePolicy } from './workspace-scope.mjs';

const SHA = /^[0-9a-f]{40}$/;
const IDS = ['SHU-140', 'SHU-254'];
const keys = ['kind', 'activation_id', 'coordinator_revision', 'slots', 'expires_at', 'stop_before_merge', 'fixtures', 'gates', 'signature'];
const fixtureKeys = ['issue_id', 'branch', 'seed_head', 'lane'];
const exact = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
export function reviewedActivationBytes(record) {
  // Canonical recursive key order; signature covers every field except itself.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  const { signature, ...payload } = record;
  return Buffer.from(JSON.stringify(canonical(payload)));
}
const refusal = (code, detail) => ({ requested: true, state: 'refused', valid: false, code, reason: `${code}: ${detail}`, kind: 'two-fixture-v1' });

export function validateTwoFixtureActivation({ record, config, revision, mainRevision, heads = {}, issues = [], env = {}, now = new Date() }) {
  const at = new Date(now).getTime();
  const expiry = Date.parse(record?.expires_at);
  if (!exact(record, keys) || record.kind !== 'two-fixture-v1' || typeof record.activation_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(record.activation_id ?? '') ||
      !SHA.test(record.coordinator_revision ?? '') || !Number.isInteger(record.slots) || record.stop_before_merge !== true ||
      typeof record.expires_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(record.expires_at) ||
      !Number.isFinite(at) || !Number.isFinite(expiry) || expiry <= at || expiry - at > 86400000 ||
      !Array.isArray(record.fixtures) || !exact(record.gates, ['reviewed', 'runtime']) ||
      typeof record.gates.reviewed !== 'boolean' || typeof record.gates.runtime !== 'boolean' || typeof record.signature !== 'string' ||
      record.fixtures.some(f => !exact(f, fixtureKeys) || typeof f.issue_id !== 'string' || typeof f.branch !== 'string' || !SHA.test(f.seed_head ?? '') || !f.lane)) return refusal('ACT_MALFORMED', 'invalid or missing bound field');
  if (record.fixtures.length < 2) return refusal('ACT_MISSING_FIXTURE', 'exactly two fixtures required');
  if (record.fixtures.length > 2) return refusal('ACT_EXTRA_FIXTURE', 'only two fixtures allowed');
  const configured = [config.fixture_lane, ...(Array.isArray(config.fixture_lanes) ? config.fixture_lanes : [])].filter(Boolean);
  if (new Set(record.fixtures.map(f => f.issue_id)).size !== record.fixtures.length || new Set(record.fixtures.map(f => f.lane.id)).size !== record.fixtures.length || new Set(configured.map(f => f.id)).size !== configured.length) return refusal('ACT_DUPLICATE_LANE', 'duplicate card or lane');
  if (record.slots !== 2 || config.max_dispatch !== record.slots) return refusal('ACT_CAPACITY_DRIFT', 'record and committed capacity must both equal two');
  if (!isDeepStrictEqual([...record.fixtures.map(f => f.issue_id)].sort(), IDS) || !isDeepStrictEqual((Array.isArray(config.dispatch_scope?.issue_ids) ? [...config.dispatch_scope.issue_ids].sort() : []), IDS)) return refusal('ACT_LANE_CROSS', 'only the reviewed pair is allowed');
  if (record.coordinator_revision !== revision || record.coordinator_revision !== mainRevision) return refusal('ACT_MALFORMED', 'running coordinator and main must equal the bound revision');
  if (record.gates.reviewed !== record.gates.runtime || record.fixtures.some(f => !issues.some(i => i.id === f.issue_id && i.linearId)) || configured.length !== 2) return refusal('ACT_PARTIAL_ARMING', 'both gates and both resolvable fixtures required');
  for (const fixture of record.fixtures) {
    let lane;
    try { lane = resolveFixtureLane(config, fixture.issue_id); } catch { return refusal('ACT_PARTIAL_ARMING', 'fixtures cannot be resolved'); }
    if (!lane) return refusal('ACT_PARTIAL_ARMING', 'fixtures cannot be resolved');
    if (fixture.branch !== `coordinator/${fixture.issue_id}` || fixture.lane.id !== fixture.issue_id || !isDeepStrictEqual(fixture.lane, lane) || !validateFixtureScopePolicy(lane).ok) return refusal('ACT_LANE_CROSS', 'issue must retain its exact reviewed lane definition and branch');
    if (heads[fixture.branch] !== fixture.seed_head) return refusal('ACT_STALE_SEED_HEAD', 'branch head differs from bound seed');
  }
  let authenticated = false;
  try {
    const key = createPublicKey(config.two_fixture_activation_public_key);
    authenticated = key.asymmetricKeyType === 'ed25519' && /^[A-Za-z0-9+/]{86}==$/.test(record.signature) && verify(null, reviewedActivationBytes(record), key, Buffer.from(record.signature, 'base64'));
  } catch { /* absent or invalid trust anchor refuses */ }
  if (!authenticated || config.enable_dispatch !== false || (env.ENABLE_DISPATCH === 'true') !== record.gates.runtime) return refusal('ACT_MANUAL_GATE_BYPASS', 'signed reviewed gates diverge from runtime or committed configuration');
  return { requested: true, valid: true, state: record.gates.reviewed ? 'armed' : 'disabled', kind: record.kind,
    ...record, target_issue_ids: record.fixtures.map(f => f.issue_id), reason: null };
}
