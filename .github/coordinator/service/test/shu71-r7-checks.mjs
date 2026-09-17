import assert from 'node:assert/strict';
import { gates } from './shu71-r5-checks.mjs';

export async function damagedJournalCheck(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run'); h.expire();
  const credential = h.read('/srv/shu/state/shu71-activation.json');
  const dir = `/srv/shu/state/shu71-evidence/${h.id}`;
  const budget = `${dir}/automatic-teardown.json`;
  // Interrupt after the durable reservation, before any safety effect.
  let interrupted = false;
  h.faults.after = event => {
    if (!interrupted && event === `fsync:${dir}` && h.exists(budget)) { interrupted = true; return true; }
    return false;
  };
  const start = h.events.length;
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_BUDGET_RESERVATION_INTERRUPTED');
  assert.equal(JSON.parse(h.read(budget)).attempts, 1, 'B4_BUDGET_RESERVATION_SURVIVES');
  assert.equal(h.events.slice(start).some(e => e.startsWith('command:')), false, 'B4_NO_UNRESERVED_EFFECT');
  h.faults.after = undefined;
  h.write(budget, JSON.stringify({ attempts: 32 }));
  const original = h.read(`${dir}/journal.jsonl`);
  h.write(`${dir}/journal.jsonl`, original + 'torn');
  // Restore armed state so the earlier interrupted fallback cannot mask a bypass.
  for (const gate of gates) h.write(gate, '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0o644);
  h.write('/srv/shu/state/shu71-activation.json', credential);
  const recoveryStart = h.events.length;
  const result = await create().execute('expire');
  assert.equal(result.code, 'ACT_RETRY_BUDGET_EXHAUSTED', 'B4_RECOVERY_NO_BUDGET_RESET');
  for (const gate of gates) assert.equal(h.read(gate), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'B4_R7_RECOVERY_BOTH_GATES_DISARMED');
  assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, 'B4_R7_RECOVERY_CREDENTIAL_REVOKED');
  assert.equal(h.exists('/srv/shu/state/shu71-evidence/active.json'), true, 'B4_R7_RECOVERY_OWNERSHIP_RETAINED');
  const effects = h.events.slice(recoveryStart).filter(e => /^(write:|rename:|unlink:|remove:|command:|api:)/.test(e));
  assert.equal(effects.length, 8, 'B4_R7_RECOVERY_SAFETY_EFFECTS');
  assert.equal(result.budget_error, 'ACT_RETRY_BUDGET_INVALID', 'B4_R7_RECOVERY_BUDGET_ERROR');
  assert.doesNotMatch(h.read(`${dir}/journal.jsonl`) + h.read(`${dir}/recovery.jsonl`), /TEARDOWN_COMPLETE/, 'B4_R7_RECOVERY_NO_FALSE_COMPLETION');
  assert.equal(h.read(`${dir}/journal.jsonl`), original + 'torn');
  const recovery = h.read(`${dir}/recovery.jsonl`);
  assert.equal((await create().execute('expire')).code, 'ACT_RETRY_BUDGET_EXHAUSTED');
  assert.equal(h.read(`${dir}/recovery.jsonl`), recovery, 'B4_RECOVERY_BOUNDED_GROWTH');
  assert.equal((await create().execute('resume')).state, 'REVOKED', 'B4_BUDGET_DAMAGED_JOURNAL_MANUAL_RECOVERY');
}
