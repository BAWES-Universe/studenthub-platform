// SHU-71 arming: a live fixture card is MEASURED off Linear as
// { state_id, assignee_id }, while the owner-approved artifact is sealed with
// canonicalBytes - every key SORTED - so the identical card deserializes as
// { assignee_id, state_id }. The comparison must be over the FIELDS. These
// controls drive the real target-host shape (productionFixture's default
// 'canonical' approval bytes, exactly what compose-shu71-approval.mjs `seal`
// writes), the mirror shape, the restore path, and genuine drift - so the fix
// cannot degenerate into accepting a card that is really in the wrong state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShu71Production, sameFixtureCard } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
const source = fs.readFileSync(moduleUrl, 'utf8');
const ACTIVATION = '/srv/shu/state/shu71-activation.json';
// Values that belong to no reviewed transition of either fixture.
const FOREIGN_STATE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ASSIGNEE = '22222222-2222-4222-8222-222222222222';
const canonical = (t, options = {}) => productionFixture(t, keys, '/etc/shu/keys/shu71-activation-ed25519.pem', null, options);
const construction = t => canonical(t, { approvalBytes: 'construction' });
const sealedCard = (h, index = 0) =>
  JSON.parse(h.read(`/etc/shu/approvals/${h.id}.shu71.json`)).payload.pkg.issue_transitions[index].before;
const cardWrites = h => h.events.filter(e => e.startsWith('card:'));

// The artifact is in the MINT's key order and the window still arms. This is
// the exact refusal the target host reported for shu71-mint-00000019.
async function canonicalArmsCheck(create, h) {
  assert.deepEqual(Object.keys(sealedCard(h)), ['assignee_id', 'state_id'], 'B1_ARTIFACT_IS_MINT_KEY_ORDER');
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code ?? null, null, 'B1_BINDING_PRIOR_STATE_FIELD_EQUAL');
  assert.equal(result.state, 'ARMED', 'B1_BINDING_PRIOR_STATE_FIELD_EQUAL');
}

// Mirror direction: an artifact recorded in the construction order must not
// regress. Same assertion surface, opposite serialization.
async function constructionArmsCheck(create, h) {
  assert.deepEqual(Object.keys(sealedCard(h)), ['state_id', 'assignee_id'], 'B1_ARTIFACT_IS_CONSTRUCTION_KEY_ORDER');
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B1_CONSTRUCTION_ORDER_ARMED');
}

// The pre-transition check inside transition(): both cards actually reach their
// reviewed ready state rather than refusing ACT_PRIOR_STATE_DRIFT on key order.
async function readyPairCheck(create, h) {
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B1_READY_PRIOR_STATE_FIELD_EQUAL');
  for (const t of h.spec.pkg.issue_transitions)
    assert.deepEqual(h.states.get(t.issue_id), t.ready, 'B1_READY_PRIOR_STATE_FIELD_EQUAL');
}

// The POST-UPDATE read-back against `target`: a field-equal card read back in
// the construction order is not ACT_PARTIAL_ARMING.
async function readyReadbackCheck(create, h) {
  const result = await create(h.id, h.boundary).execute('run');
  assert.notEqual(result.code, 'ACT_PARTIAL_ARMING', 'B1_READY_READBACK_FIELD_EQUAL');
  assert.equal(result.state, 'ARMED', 'B1_READY_READBACK_FIELD_EQUAL');
  assert.ok(h.exists(ACTIVATION), 'B1_READY_READBACK_FIELD_EQUAL');
}

// The restore path: transition(t, t.restore, true). Its post-update read-back
// compares a constructed card against the canonicalized artifact too, so a
// teardown must not fail ACT_TEARDOWN_RESTORE_* on key order.
async function restoreReadbackCheck(create, h) {
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'B4_RESTORE_READBACK_FIELD_EQUAL');
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.deepEqual(result.failures, [], 'B4_RESTORE_READBACK_FIELD_EQUAL');
  assert.equal(result.state, 'REVOKED', 'B4_RESTORE_READBACK_FIELD_EQUAL');
  for (const t of h.spec.pkg.issue_transitions)
    assert.deepEqual(h.states.get(t.issue_id), t.restore, 'B4_RESTORE_READBACK_FIELD_EQUAL');
}

// The early return in transition(): a card already AT its target is left alone.
// A recovered episode restores unconditionally, and here both cards are still
// at `before`, which the schema holds identical to `restore` - so a correct
// comparison issues no Linear mutation at all.
async function idempotentRestoreCheck(create, h) {
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/recovery.jsonl`, '');
  const start = h.events.length;
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.state, 'REVOKED', 'B4_RESTORE_IDEMPOTENT_NO_WRITE');
  assert.deepEqual(h.events.slice(start).filter(e => e.startsWith('card:')), [], 'B4_RESTORE_IDEMPOTENT_NO_WRITE');
  for (const t of h.spec.pkg.issue_transitions)
    assert.deepEqual(h.states.get(t.issue_id), t.before, 'B4_RESTORE_IDEMPOTENT_NO_WRITE');
}

// Order-insensitivity is not tolerance. A card whose ASSIGNEE genuinely differs
// from the reviewed prior state still refuses at the arming binding step,
// before any fixture is written.
async function bindingDriftCheck(create, h) {
  const t = h.spec.pkg.issue_transitions.find(e => e.issue_id === 'SHU-254');
  h.states.set('SHU-254', { state_id: t.before.state_id, assignee_id: FOREIGN_ASSIGNEE });
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_PRIOR_STATE_DRIFT', 'B1_GENUINE_DRIFT_REFUSED');
  assert.equal(result.state, 'HALT', 'B1_GENUINE_DRIFT_REFUSED');
  assert.deepEqual(cardWrites(h), [], 'B1_GENUINE_DRIFT_REFUSED');
  assert.equal(h.exists(ACTIVATION), false, 'B1_GENUINE_DRIFT_REFUSED');
}

// The same refusal at the other site: the card passes the binding step and then
// drifts in STATE before its own ready transition, which is the only way to
// reach the pre-check inside transition() with a real mismatch.
async function readyDriftCheck(create, h) {
  const t = h.spec.pkg.issue_transitions.find(e => e.issue_id === 'SHU-254');
  const inner = h.boundary.fetch;
  let drifted = false;
  h.boundary.fetch = async (url, options) => {
    const reply = await inner(url, options);
    // Once SHU-140 has actually moved, the window is past the binding step.
    if (!drifted && url === 'https://api.linear.app/graphql' && h.states.get('SHU-140').state_id !== t.before.state_id) {
      drifted = true;
      h.states.set('SHU-254', { state_id: FOREIGN_STATE, assignee_id: t.before.assignee_id });
    }
    return reply;
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(drifted, true, 'B1_READY_GENUINE_DRIFT_REFUSED');
  assert.equal(result.code, 'ACT_PRIOR_STATE_DRIFT', 'B1_READY_GENUINE_DRIFT_REFUSED');
  assert.equal(result.state, 'HALT', 'B1_READY_GENUINE_DRIFT_REFUSED');
  assert.equal(h.exists(ACTIVATION), false, 'B1_READY_GENUINE_DRIFT_REFUSED');
  for (const e of h.spec.pkg.issue_transitions)
    assert.deepEqual(h.states.get(e.issue_id), e.restore, 'B1_READY_GENUINE_DRIFT_REFUSED');
}

// Order-insensitivity is not shapelessness. The two-key closure is not
// reachable through the entrypoint - issue() constructs exactly
// { state_id, assignee_id } and validateShu71Package's exactObject holds the
// artifact card to exactly those two keys - so it is proved directly on the
// exported comparison, which is the only place a differently-shaped object can
// be presented to it.
function shapeClosureCheck(sameCard) {
  assert.equal(sameCard({ state_id: 'S', assignee_id: 'A' }, { assignee_id: 'A', state_id: 'S' }), true, 'B1_SHAPE_BOTH_ORDERS_ACCEPTED');
  for (const [a, b] of [
    [{ state_id: 'S', assignee_id: 'A', extra: 1 }, { assignee_id: 'A', state_id: 'S' }],
    [{ assignee_id: 'A', state_id: 'S' }, { state_id: 'S', assignee_id: 'A', extra: 1 }],
  ]) assert.equal(sameCard(a, b), false, 'B1_SHAPE_EXTRA_KEY_REFUSED');
  for (const [a, b] of [
    [{ state_id: 'S', extra: 1 }, { state_id: 'S', extra: 1 }],
    [{ assignee_id: 'A', extra: 1 }, { extra: 1, assignee_id: 'A' }],
  ]) assert.equal(sameCard(a, b), false, 'B1_SHAPE_MISSING_FIELD_REFUSED');
  assert.equal(sameCard({ state_id: 'S', assignee_id: 'A' }, { assignee_id: 'Z', state_id: 'S' }), false, 'B1_SHAPE_GENUINE_DRIFT_REFUSED');
}

const controls = [
  ['canonical mint key order arms the window', canonical, canonicalArmsCheck],
  ['construction key order still arms the window', construction, constructionArmsCheck],
  ['both fixtures reach the reviewed ready state', canonical, readyPairCheck],
  ['post-update ready read-back accepts a field-equal card', canonical, readyReadbackCheck],
  ['restore read-back accepts a field-equal card', canonical, restoreReadbackCheck],
  ['a card already at its target is not rewritten', canonical, idempotentRestoreCheck],
  ['a genuinely drifted assignee still refuses before arming', canonical, bindingDriftCheck],
  ['a card that drifts in state before its transition still refuses', canonical, readyDriftCheck],
];
for (const [name, fixture, check] of controls)
  test(`B1/B4 arming order: ${name}`, async t => { await check(createShu71Production, fixture(t)); });
test('B1/B4 arming order: the field comparison stays closed to the two reviewed keys',
  () => shapeClosureCheck(sameFixtureCard));

const HELPER = "  && FIXTURE_CARD_FIELDS.every(field => a[field] === b[field]);";
const mutations = [
  // One per comparison site, each reverted to the serialization equality the
  // target host measured as unsatisfiable.
  ['arming binding prior-state comparison reverted to serialization equality',
    "for (const t of spec.pkg.issue_transitions) need(sameFixtureCard(await issue(t), t.before), 'ACT_PRIOR_STATE_DRIFT');",
    "for (const t of spec.pkg.issue_transitions) need(JSON.stringify(await issue(t)) === JSON.stringify(t.before), 'ACT_PRIOR_STATE_DRIFT');",
    canonical, canonicalArmsCheck],
  ['transition prior-state comparison reverted to serialization equality',
    "need(restoring || sameFixtureCard(current, t.before), 'ACT_PRIOR_STATE_DRIFT');",
    "need(restoring || JSON.stringify(current) === JSON.stringify(t.before), 'ACT_PRIOR_STATE_DRIFT');",
    canonical, readyPairCheck],
  // Anchor updated in place for the bounded re-read of the post-update
  // read-back; the mutation's name, its control and its assertion are
  // unchanged - the terminal comparison is the same comparison, made on the
  // value the bounded re-read settled on.
  ['post-update target comparison reverted to serialization equality',
    "    need(sameFixtureCard(observed, target), 'ACT_PARTIAL_ARMING');",
    "    need(JSON.stringify(observed) === JSON.stringify(target), 'ACT_PARTIAL_ARMING');",
    canonical, readyReadbackCheck],
  ['already-at-target early return reverted to serialization equality',
    'if (sameFixtureCard(current, target)) return;',
    'if (JSON.stringify(current) === JSON.stringify(target)) return;',
    canonical, idempotentRestoreCheck],
  // Order-insensitivity degenerating into tolerance, by each of its three doors.
  ['field comparison accepts any pair of cards', HELPER, '  && true;', canonical, bindingDriftCheck],
  ['field comparison stops reading assignee_id', HELPER,
    "  && ['state_id'].every(field => a[field] === b[field]);", canonical, bindingDriftCheck],
  ['field comparison stops reading state_id', HELPER,
    "  && ['assignee_id'].every(field => a[field] === b[field]);", canonical, readyDriftCheck],
];
// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
async function loadMutant(t, before, after) {
  assert.equal(source.split(before).length, 2, 'B1_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-order-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modified = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  return import(pathToFileURL(file));
}

// The killing assertion is reported, not merely counted.
async function killedBy(t, run) {
  let killed = null;
  await assert.rejects(run, error => {
    killed = error; return error.code === 'ERR_ASSERTION' && /B[14]_/.test(error.message);
  }, 'B1_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B[14]_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}

for (const [name, before, after, fixture, check] of mutations)
  test(`B1/B4 arming-order mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, () => check(mutant.createShu71Production, fixture(t)));
  });

// The two doors of the two-key closure. Neither is reachable through the
// entrypoint - the eight controls above all pass under both of these mutants -
// so each is killed by the direct control instead.
const shapeMutations = [
  ['field comparison accepts a differently-shaped card',
    'Object.keys(card).length === FIXTURE_CARD_FIELDS.length && ', ''],
  ['field comparison stops requiring both reviewed keys',
    ' && FIXTURE_CARD_FIELDS.every(field => Object.hasOwn(card, field)))', ')'],
];
for (const [name, before, after] of shapeMutations)
  test(`B1/B4 arming-order mutation: ${name}`, async t => {
    shapeClosureCheck(sameFixtureCard);
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, async () => shapeClosureCheck(mutant.sameFixtureCard));
  });
