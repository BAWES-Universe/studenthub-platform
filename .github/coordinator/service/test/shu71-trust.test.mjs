import { gateRecoveryCheck, serviceRecoveryCheck, retirementWindowCheck, activationRecoveryCheck, onceOnlyRestoreCheck, boundedReplayCheck, counterFaultCheck, manualBudgetCheck, exhaustedSettlementCheck } from './shu71-recovery-checks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShu71Production } from '../shu71-production.mjs';
import { openActivationJournal } from '../shu71-journal.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { trustChecks, journalCheck } from './shu71-trust-checks.mjs';
const keys = ephemeralPublicSource();
for (const [name, check] of Object.entries(trustChecks)) test(`trust guard: ${name}`, t => check(createShu71Production, productionFixture(t, keys)));
for (const kind of ['hash', 'link', 'sequence', 'torn', 'custody']) test(`journal guard: ${kind}`, t => journalCheck(openActivationJournal, productionFixture(t, keys), kind));
for (const drift of ['activation', 'supervisor-gate', 'service']) test(`receipt independently observes ${drift}`, async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); await create().execute('revoke');
  if (drift === 'activation') h.write('/srv/shu/state/shu71-activation.json', 'rearmed');
  if (drift === 'supervisor-gate') h.write('/etc/systemd/system/shu-supervisor.service.d/90-shu71.conf', '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0o644);
  if (drift === 'service') h.active.set('shu-supervisor.service', 'active');
  assert.equal((await create().execute('expire')).code, 'ACT_TEARDOWN_DRIFT', 'B4_EACH_PHYSICAL_FACT');
});
test('forged completion diverts to recovery and preserves original evidence', async t => {
  const h = productionFixture(t, keys), file = `/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`;
  await createShu71Production(h.id, h.boundary).execute('run');
  const rows = h.journal(); rows.at(-1).event = 'TEARDOWN_COMPLETE';
  const forged = rows.map(JSON.stringify).join('\n') + '\n'; h.write(file, forged);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('resume')).state, 'REVOKED', 'B4_FORGED_RECOVERY');
  assert.equal(h.read(file), forged, 'B4_FORGED_BYTES_RETAINED');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_FORGED_ACTIVATION_REMOVED');
  assert.match(h.read(file.replace('journal.jsonl', 'recovery.jsonl')), /TEARDOWN_COMPLETE/, 'B4_RECOVERY_EVIDENCE');
});

test('process identity refuses before all production effects', t => {
  const h = productionFixture(t, keys); h.boundary.uid = () => 999;
  assert.throws(() => createShu71Production(h.id, h.boundary), e => e.code === 'ACT_PROCESS_IDENTITY', 'B1_PROCESS_IDENTITY');
  assert.deepEqual(h.events, [], 'B1_IDENTITY_BEFORE_EFFECTS');
});
test('approval file custody refuses before authority or signing', async t => {
  const h = productionFixture(t, keys), file = `/etc/shu/approvals/${h.id}.shu71.json`;
  h.write(file, h.read(file), 0o600, 999);
  await assert.rejects(createShu71Production(h.id, h.boundary).execute('run'), e => e.code === 'ACT_FILE_CUSTODY', 'B1_APPROVAL_CUSTODY');
  assert.equal(h.signatures(), 0);
});
test('fixture ref readback refuses before signing', async t => {
  const h = productionFixture(t, keys), fetch = h.boundary.fetch;
  h.boundary.fetch = (url, opts) => url.endsWith('SHU-140') ? Promise.resolve({ ok: true, text: async () => JSON.stringify({ object: { sha: 'f'.repeat(40) } }) }) : fetch(url, opts);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).code, 'ACT_REF_BINDING', 'B1_REF_BINDING');
  assert.equal(h.signatures(), 0);
});
test('remote ancestry refuses diverged comparison after push', async t => {
  const h = productionFixture(t, keys), fetch = h.boundary.fetch;
  h.boundary.fetch = (url, opts) => url.includes('/compare/') ? Promise.resolve({ ok: true, text: async () => JSON.stringify({ status: 'diverged' }) }) : fetch(url, opts);
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).code, 'ACT_REMOTE_ANCESTRY', 'B1_REMOTE_ANCESTRY');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false);
});
test('completed teardown observation fails closed on unreadable gate', async t => {
  const h = productionFixture(t, keys);
  await createShu71Production(h.id, h.boundary).execute('run'); await createShu71Production(h.id, h.boundary).execute('revoke');
  const open = h.boundary.fs.openSync;
  h.boundary.fs.openSync = (file, ...args) => {
    if (file.endsWith('90-shu71.conf')) throw Object.assign(new Error('SECRET_POISON'), { code: 'EACCES' });
    return open(file, ...args);
  };
  const result = await createShu71Production(h.id, h.boundary).execute('revoke');
  assert.equal(result.code, 'ACT_TEARDOWN_DRIFT', 'B4_UNOBSERVABLE_REFUSED');
  assert.doesNotMatch(JSON.stringify(result), /POISON/);
});
test('successor receipt is explicitly historical and does not observe or mutate shared services', async t => {
  const h = productionFixture(t, keys);
  await createShu71Production(h.id, h.boundary).execute('run'); await createShu71Production(h.id, h.boundary).execute('revoke');
  h.write('/srv/shu/state/shu71-evidence/active.json', JSON.stringify({ activation_id: 'successor' }));
  h.write('/srv/shu/state/shu71-activation.json', 'successor');
  const start = h.events.length, result = await createShu71Production(h.id, h.boundary).execute('expire');
  assert.equal(result.receipt_scope, 'retired_episode', 'B4_HISTORICAL_RECEIPT');
  assert.equal(result.physical_teardown_observed, false, 'B4_NO_SUCCESSOR_PHYSICAL_CLAIM');
  assert.equal(h.read('/srv/shu/state/shu71-activation.json'), 'successor');
  assert.equal(h.events.slice(start).some(e => e.startsWith('command:')), false);
});
for (const retry of ['resume', 'revoke', 'expire']) test(`transient gate drift refuses false completion then recovers via ${retry}`, t =>
  gateRecoveryCheck(createShu71Production, productionFixture(t, keys), retry));
for (const service of ['shu71-evidence.service', 'shu-supervisor.service']) test(`transient ${service} restart is stopped again on recovery`, t =>
  serviceRecoveryCheck(createShu71Production, productionFixture(t, keys), service));

test('P1 drift after observation but before retirement refuses completion', t =>
  retirementWindowCheck(createShu71Production, productionFixture(t, keys)));
for (const retry of ['resume', 'revoke', 'expire']) test(`P4 activation file recreated after unlink recovers via ${retry}`, t =>
  activationRecoveryCheck(createShu71Production, productionFixture(t, keys), retry));
test('P5 remote restores and archive do not repeat on wedged wakes', t =>
  onceOnlyRestoreCheck(createShu71Production, productionFixture(t, keys)));
for (const retry of ['resume', 'revoke']) test(`P3 automatic replay budget persists across processes; operator ${retry} recovers`, t =>
  boundedReplayCheck(createShu71Production, productionFixture(t, keys), retry));

import { damagedJournalCheck } from './shu71-r7-checks.mjs';
test('P3 reservation survives interruption and damaged journal cannot reset the budget', t =>
  damagedJournalCheck(createShu71Production, productionFixture(t, keys)));
for (const value of ['not-json', '{"attempts":-1}', '{"attempts":1.5}', '{"attempts":33}']) test(`P3 invalid retry budget refuses automatic effects: ${value}`, async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, value);
  const start = h.events.length;
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_INVALID_BUDGET_REFUSED');
  assert.equal(h.events.slice(start).some(e => e.startsWith('command:') || e.startsWith('api:')), false);
  assert.equal((await create().execute('revoke')).state, 'REVOKED', 'B4_INVALID_BUDGET_MANUAL_RECOVERY');
});

for (const fault of ['mode', 'nlink', 'write', 'fsync', 'rename', '{}', 'not-json', '{"attempts":-1}', '{"attempts":33}', '{"attempts":1e999}'])
  test(`Q1 counter fault disarms both disk gates: ${fault}`, t => counterFaultCheck(createShu71Production, productionFixture(t, keys), fault));
for (const action of ['run', 'resume', 'revoke']) test(`Q5 explicit ${action} retains spent budget`, t => manualBudgetCheck(createShu71Production, productionFixture(t, keys), action));
for (const interrupt of [false, true]) test(`Q3 exhausted safe episode settles without repair; interruption=${interrupt}`, t => exhaustedSettlementCheck(createShu71Production, productionFixture(t, keys), interrupt));

import { counterDifferential } from './shu71-r4-differential.mjs';
test('Q1 identical counter fault at parent, blocked head and candidate', t => counterDifferential(t, keys, createShu71Production));

test('Q1 independent gate failure is surfaced and second gate is still disarmed', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, '{}');
  h.faults.before = e => e === 'write:/etc/systemd/system/shu-coordinator.service.d/90-shu71.conf.pending';
  const result = await create().execute('expire');
  assert.equal(result.code, 'ACT_RETRY_BUDGET_UNAVAILABLE');
  assert.equal(result.budget_error, 'ACT_RETRY_BUDGET_INVALID', 'B4_COUNTER_INVALID_DIAGNOSTIC');
  assert.deepEqual(result.failures, ['ACT_TEARDOWN_GATE'], 'B4_COUNTER_GATE_FAILURE_SURFACED');
  assert.match(h.read('/etc/systemd/system/shu-supervisor.service.d/90-shu71.conf'), /ENABLE_DISPATCH=false/);
});
test('Q3 exhaustion cannot settle unfinished remote restoration', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  h.faults.before = e => e === 'card:SHU-140';
  for (let n=0;n<32;n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
  h.faults.before = undefined;
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_SETTLEMENT_UNFINISHED_REFUSED');
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), true);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false);
  assert.equal((await create().execute('resume')).state, 'REVOKED');
});

import { r5Differential, gates } from './shu71-r5-checks.mjs';
for (const scenario of ['counter-fault', 'counter-plant', 'settlement-plant', 'settlement-interrupt'])
  test(`R5 parent/blocked/candidate differential: ${scenario}`, t => r5Differential(t, keys, createShu71Production, scenario));
for (const value of ['{}', '{"attempts":32}', '{"attempts":32,"settlement_started":true}']) test(`R5 clean successor protected with counter ${value}`, async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, value);
  h.write('/srv/shu/state/shu71-evidence/active.json', '{"activation_id":"successor"}');
  const start = h.events.length;
  assert.equal((await create().execute('expire')).code, 'ACT_ACTIVATION_CONFLICT', 'B4_R5_SUCCESSOR_CONFLICT');
  assert.equal(h.events.slice(start).filter(e => /^(write:|rename:|unlink:|remove:|command:|api:)/.test(e)).length, 0, 'B4_R5_SUCCESSOR_ZERO_EFFECTS');
  for (const gate of gates) assert.match(h.read(gate), /ENABLE_DISPATCH=true/);
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), true);
});
test('R5 credential unlink failure is reported while both gates disarm', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, '{}');
  h.faults.before = e => e === 'unlink:/srv/shu/state/shu71-activation.json';
  const r = await create().execute('expire');
  assert.deepEqual(r.failures, ['ACT_TEARDOWN_ACTIVATION'], 'B4_COUNTER_CREDENTIAL_FAILURE_REPORTED');
  for (const gate of gates) assert.match(h.read(gate), /ENABLE_DISPATCH=false/);
  h.faults.before = undefined;
  await create().execute('expire');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_COUNTER_CREDENTIAL_RETRIED');
});

import { safeExhausted } from './shu71-r5-checks.mjs';
for (const timing of ['before', 'after']) test(`R5 settlement journal reservation interruption ${timing} write`, async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await safeExhausted(createShu71Production, h);
  const write = h.boundary.fs.writeFileSync;
  h.boundary.fs.writeFileSync = (file, data) => {
    const marker = String(data).includes('"event":"SETTLEMENT_STARTED"');
    if (marker && timing === 'before') throw new Error('reservation fault');
    write(file, data);
    if (marker && timing === 'after') throw new Error('reservation fault');
  };
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), true, 'B4_SETTLEMENT_RESERVATION_OWNERSHIP');
  assert.equal(h.events.some(e => e.includes('disable --now shu71-expiry-')), false, 'B4_SETTLEMENT_RESERVATION_TIMER');
  h.boundary.fs.writeFileSync = write;
  if (timing === 'before') assert.equal((await create().execute('expire')).state, 'REVOKED');
  else {
    // The counter boolean is still absent; the persisted journal marker alone
    // must prevent reuse after process death or a planted false boolean.
    const rows = h.journal().length;
    for (let n = 0; n < 5; n++) assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_SETTLEMENT_JOURNAL_ALLOWANCE');
    assert.equal(h.journal().length, rows, 'B4_SETTLEMENT_RESERVATION_BOUNDED');
    assert.equal((await create().execute('resume')).state, 'REVOKED');
  }
});

test('R5 supporting history cannot excuse an out-of-range counter', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await safeExhausted(createShu71Production, h);
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, '{"attempts":33}');
  const result = await create().execute('expire');
  assert.equal(result.code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_COUNTER_RANGE_WITH_EVIDENCE');
  assert.equal(result.budget_error, 'ACT_RETRY_BUDGET_INVALID');
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), true);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false);
});

import { reservationHistories, reservationHistoryCheck } from './shu71-r6-checks.mjs';
for (const [kind, count] of reservationHistories)
  test(`R6 reservation evidence: ${kind}`, t => reservationHistoryCheck(createShu71Production, productionFixture(t, keys), kind, count));

test('R6 reservation append interruption cannot precede durable counter consumption', async t => {
  const h = productionFixture(t, keys), create = () => createShu71Production(h.id, h.boundary);
  await create().execute('run'); h.expire();
  const dir = `/srv/shu/state/shu71-evidence/${h.id}`;
  const write = h.boundary.fs.writeFileSync;
  h.boundary.fs.writeFileSync = (file, data) => {
    write(file, data);
    if (String(data).includes('"event":"AUTOMATIC_TEARDOWN_RESERVED"')) throw new Error('reservation append interrupted');
  };
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_UNAVAILABLE');
  assert.equal(h.exists(`${dir}/automatic-teardown.json`), true, 'B4_R6_APPEND_INTERRUPTION_COUNTER_CONSUMED');
  assert.equal(JSON.parse(h.read(`${dir}/automatic-teardown.json`)).attempts, 1, 'B4_R6_APPEND_INTERRUPTION_ATTEMPT_CONSUMED');
  for (const gate of gates) assert.match(h.read(gate), /ENABLE_DISPATCH=false/);
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false);
  h.boundary.fs.writeFileSync = write;
});

// R8 finite acceptance table; fixed mutation witnesses live in the mutation suite.
import { stateSpace, stateName, unreachable, requiredTransition, stateTransitionCheck } from './shu71-r8-state-model.mjs';
test('R8 state domain is total and unreachable combinations are explicit', () => {
  assert.equal(stateSpace.length, 864, 'B4_R8_TOTAL_DOMAIN');
  assert.equal(new Set(stateSpace.map(stateName)).size, 864, 'B4_R8_UNIQUE_DOMAIN');
  assert.equal(stateSpace.filter(s => !unreachable(s)).length, 720, 'B4_R8_REACHABLE_DOMAIN');
  for (const s of stateSpace) assert.equal(Boolean(requiredTransition(s).unreachable), Boolean(unreachable(s)), 'B4_R8_TOTAL_CLASSIFICATION');
});
for (const s of stateSpace.filter(s => !unreachable(s))) test(`R8 state transition: ${stateName(s)}`, async t => {
  const observed = await stateTransitionCheck(createShu71Production, productionFixture(t, keys), s);
  t.diagnostic(JSON.stringify({ state: s, before: observed.before, after: observed.after }));
});

import { exhaustedVariants, exhaustedInvariant } from './shu71-exhausted-invariants.mjs';
for (const variant of exhaustedVariants) test(`exhausted invariant: ${variant.axis}: ${variant.label}`, t =>
  exhaustedInvariant(createShu71Production, () => productionFixture(t, keys), variant,
    snapshot => t.diagnostic(JSON.stringify(snapshot))));

import { exhaustedControl, completionOrdering, inventoryGuard } from './shu71-delta-properties.mjs';
import { journalInventory, appendReal } from './shu71-exhausted-invariants.mjs';
test('SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK and COUNTER_ATTEMPTS_ONLY', () => exhaustedControl());
test('SHU71_CONTROL_PROPERTY_COMPLETION_BEFORE_EXHAUSTED', () => completionOrdering());
test('SHU71_CONTROL_PROPERTY_JOURNAL_APPEND_INVENTORY', () => inventoryGuard(journalInventory));
for (const journal of ['intact', 'recovered']) test(`B4_TEARDOWN_COMPLETE_LEGITIMATE_TERMINAL_${journal}`, async t => {
  const h = productionFixture(t, keys);
  // The unchanged state driver verifies its unconsumed precondition before this
  // wrapper appends the terminal signal immediately before the measured wake.
  const create = (id, boundary) => {
    const production = createShu71Production(id, boundary);
    return { execute: async action => {
      if (action === 'expire') appendReal(h, `/srv/shu/state/shu71-evidence/${h.id}`, journalInventory.find(e => e.terminal), journal);
      return production.execute(action);
    } };
  };
  const { stateTransition } = await import('./shu71-r8-state-model.mjs');
  const measured = await stateTransition(create, h, { physical: 'armed', counter: 'exhausted', journal, allowance: 'unconsumed' });
  // Writer append is setup; exactly one write, checked rather than hidden.
  assert.equal(measured.events.filter(e => /journal.jsonl|recovery.jsonl/.test(e)).length, 1, 'B4_TERMINAL_REAL_WRITER');
  assert.deepEqual({ ...measured.after, effects: measured.after.effects - 1 }, {
    gates: Array(2).fill('[Service]\nEnvironment=ENABLE_DISPATCH=true\n'), credential: true, lease: true,
    effects: 0, code: 'ACT_TEARDOWN_DRIFT', complete: true,
  }, `B4_TEARDOWN_COMPLETE_LEGITIMATE_TERMINAL_${journal.toUpperCase()}`);
});
