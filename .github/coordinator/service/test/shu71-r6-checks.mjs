import assert from 'node:assert/strict';
import { openActivationJournal } from '../shu71-journal.mjs';
import { gates } from './shu71-r5-checks.mjs';

export const reservationHistories = [
  ...Array.from({ length: 31 }, (_, i) => [`PARTIAL_${i + 1}`, i + 1]),
  ['DESCENDING', 32], ['DUPLICATE', 32], ['REORDERED', 32], ['GAP', 32], ['EXTRA', 32], ['ORDERED', 32],
];

export async function reservationHistoryCheck(createProduction, h, kind = 'PARTIAL_1', count = 1) {
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED');
  const credential = h.read('/srv/shu/state/shu71-activation.json');
  h.expire();
  // Actual automatic cleanup produces each reservation. A remote restore fault
  // keeps the episode unfinished so later wakes do not become retired receipts.
  h.faults.before = e => e === 'card:SHU-140';
  for (let i = 0; i < count; i++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
  h.faults.before = undefined;
  const dir = `/srv/shu/state/shu71-evidence/${h.id}`;
  const rows = h.journal();
  const reservations = rows.filter(e => e.event === 'AUTOMATIC_TEARDOWN_RESERVED');
  assert.deepEqual(reservations.map(e => e.attempts), Array.from({ length: count }, (_, i) => i + 1), 'B4_R6_REAL_RESERVATIONS');
  if (kind === 'DESCENDING') reservations.forEach((e, i) => { e.attempts = 32 - i; });
  if (kind === 'DUPLICATE') reservations[16].attempts = 16;
  if (kind === 'REORDERED') [reservations[15].attempts, reservations[16].attempts] = [17, 16];
  if (kind === 'GAP') reservations[31].attempts = 33;
  if (kind === 'EXTRA') rows.push({ event: 'AUTOMATIC_TEARDOWN_RESERVED', attempts: 33 });
  // Model local tampering, not a broken hash: rebuild through the real journal
  // writer, then let a fresh production process validate and consume the chain.
  h.write(`${dir}/journal.jsonl`, '');
  const journal = openActivationJournal(dir, h.boundary.fs, 'journal.jsonl', h.identity);
  for (const { seq, previous, sha256, ...event } of rows) journal.append(event);
  journal.close();
  h.write(`${dir}/automatic-teardown.json`, '{"attempts":32}');
  for (const gate of gates) h.write(gate, '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0o644);
  h.write('/srv/shu/state/shu71-activation.json', credential);
  const start = h.events.length;
  const result = await create().execute('expire');
  const effects = h.events.slice(start).filter(e => /^(write:|rename:|unlink:|remove:|command:|api:)/.test(e));
  if (kind === 'ORDERED') {
    // Deliberately pins the R5-B root-adversary residual, not an authentication claim.
    assert.equal(result.code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_R6_ORDERED_LOCAL_CHAIN_ACCEPTED');
    assert.deepEqual(effects, [], 'B4_R6_ORDERED_ZERO_EFFECTS_RESIDUAL');
    for (const gate of gates) assert.match(h.read(gate), /ENABLE_DISPATCH=true/);
    assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), true);
  } else {
    assert.equal(result.code, 'ACT_RETRY_BUDGET_UNAVAILABLE', `B4_R6_${kind}_EVIDENCE_REFUSED`);
    assert.equal(result.budget_error, 'ACT_RETRY_BUDGET_INVALID', `B4_R6_${kind}_EVIDENCE_INVALID`);
    for (const gate of gates) assert.match(h.read(gate), /ENABLE_DISPATCH=false/, `B4_R6_${kind}_BOTH_GATES_DISARMED`);
    assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, `B4_R6_${kind}_CREDENTIAL_REVOKED`);
    if (kind === 'DESCENDING') {
      for (const gate of gates) assert.equal(h.read(gate), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'B4_R7_DESCENDING_GATE_CONTENTS');
      assert.equal(effects.length, 7, 'B4_R7_DESCENDING_SAFETY_EFFECTS');
    }
    assert.ok(effects.length > 0, `B4_R6_${kind}_SAFETY_EFFECTS`);
  }
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), true, 'B4_R6_OWNERSHIP_RETAINED');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B4_R6_NO_FALSE_COMPLETION');
}
