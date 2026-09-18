import assert from 'node:assert/strict';
import { openActivationJournal } from '../shu71-journal.mjs';
import { gates } from './shu71-r5-checks.mjs';

export const counterStates = ['absent', 'invalid', ...Array.from({ length: 32 }, (_, n) => `valid-${n}`), 'exhausted', 'settlement-started-set'];
export const journalStates = ['absent', 'intact', 'truncated', 'recovered', 'FORGED-ordered', 'FORGED-partial'];
export const stateSpace = ['armed', 'settlement-ready'].flatMap(physical => counterStates.flatMap(counter => journalStates.flatMap(journal => ['unconsumed', 'consumed'].map(allowance => ({ counter, journal, allowance, physical })))));
export const stateName = s => `${s.counter}_${s.journal}_${s.allowance}${s.physical === 'settlement-ready' ? '_READY' : ''}`.replaceAll('-', '_').toUpperCase();
export function unreachable(s) {
  return s.allowance === 'consumed' && ['absent', 'truncated'].includes(s.journal)
    ? 'Consumed means SETTLEMENT_STARTED in the selected valid journal; an absent journal or a newly recovered torn journal has no such row.' : null;
}
const activation = '/srv/shu/state/shu71-activation.json';
const lease = '/srv/shu/state/shu71-evidence/active.json';
export async function stateTransition(createProduction, h, s, transform = () => {}) {
  assert.equal(unreachable(s), null);
  const create = () => createProduction(h.id, h.boundary);
  assert.equal((await create().execute('run')).state, 'ARMED', 'B4_R8_SETUP_ARMED');
  h.expire();
  const dir = `/srv/shu/state/shu71-evidence/${h.id}`;
  if (s.physical === 'settlement-ready') {
    // Produce a genuine ordered exhaustion history through 32 production wakes.
    // Only timer retirement fails; all non-observational cleanup is DONE.
    h.faults.before = e => e === `command:/usr/bin/systemctl:disable --now shu71-expiry-${h.id}.timer`;
    for (let n = 0; n < 32; n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED', 'B4_R8_READY_REAL_RESERVATION');
    h.faults.before = undefined;
  }
  const original = h.read(`${dir}/journal.jsonl`);
  if (s.journal === 'absent') h.boundary.fs.unlinkSync(`${dir}/journal.jsonl`);
  else if (s.journal === 'truncated') h.write(`${dir}/journal.jsonl`, original + 'torn');
  else {
    const recovered = s.journal === 'recovered';
    if (recovered) h.write(`${dir}/journal.jsonl`, original + 'torn');
    const name = recovered ? 'recovery.jsonl' : 'journal.jsonl';
    if (recovered || s.journal.startsWith('FORGED')) {
      h.write(`${dir}/${name}`, '');
      const j = openActivationJournal(dir, h.boundary.fs, name, h.identity);
      // Local writer custody is deliberately granted, as in the retained R5-B residual.
      // Recovery includes both demonstrated durable-prefix facts: ARMED and one reservation.
      j.append({ event: 'APPROVED', spec: h.spec });
      j.append({ event: 'ARMED' });
      const count = s.journal === 'FORGED-ordered' ? 32 : 1;
      for (let attempts = 1; attempts <= count; attempts++) j.append({ event: 'AUTOMATIC_TEARDOWN_RESERVED', attempts });
      j.close();
    }
    if (s.allowance === 'consumed') {
      const j = openActivationJournal(dir, h.boundary.fs, name, h.identity); j.append({ event: 'SETTLEMENT_STARTED' }); j.close();
    }
  }
  const budget = `${dir}/automatic-teardown.json`;
  if (s.counter === 'absent' && h.exists(budget)) h.boundary.fs.unlinkSync(budget);
  if (s.counter !== 'absent') h.write(budget, s.counter === 'invalid' ? '{' : JSON.stringify({ attempts: s.counter.startsWith('valid-') ? Number(s.counter.slice(6)) : 32, ...(s.counter === 'settlement-started-set' ? { settlement_started: true } : {}) }));
  transform(h, dir);
  const snapshot = (result, start) => ({
    gates: gates.map(g => h.read(g)), credential: h.exists(activation), lease: h.exists(lease),
    effects: h.events.slice(start).filter(e => /^(write:|rename:|unlink:|remove:|command:|api:)/.test(e)).length,
    code: result.code ?? null, complete: ['journal.jsonl', 'recovery.jsonl'].some(n => h.exists(`${dir}/${n}`) && h.read(`${dir}/${n}`).includes('"event":"TEARDOWN_COMPLETE"')),
  });
  const start = h.events.length, before = snapshot({}, start);
  const ready = s.physical === 'settlement-ready';
  assert.deepEqual(before, {
    gates: Array(2).fill(`[Service]\nEnvironment=ENABLE_DISPATCH=${ready ? 'false' : 'true'}\n`),
    credential: !ready, lease: true, effects: 0, code: null, complete: false,
  }, `B4_R8_PRESTATE_${stateName(s)}`);
  const result = await create().execute('expire');
  return { before, after: snapshot(result, start), result, events: h.events.slice(start).filter(e => /^(write:|rename:|unlink:|remove:|command:|api:)/.test(e)) };
}

// This is the acceptance oracle, independent of production branches and mutant
// predicates. The bounded initial condition is an expired, unfinished episode,
// own lease held; either armed with a credential, or safe after 32 failed timer
// retirements. No fault remains active during the measured transition.
// Counts include journal writes and exclude reads, mkdir, chmod/chown and fsync.
const cleanupEffects = {
  armed: { absent: 67, intact: 72, truncated: 73, recovered: 72, 'FORGED-ordered': 66, 'FORGED-partial': 66 },
  'settlement-ready': { absent: 67, intact: 41, truncated: 69, recovered: 68, 'FORGED-ordered': 66, 'FORGED-partial': 66 },
};
export function requiredTransition(s) {
  const reason = unreachable(s);
  if (reason) return { unreachable: reason };
  const exhausted = ['exhausted', 'settlement-started-set'].includes(s.counter);
  const ready = s.physical === 'settlement-ready';
  const settlement = ready && exhausted && s.journal === 'intact';
  const settled = settlement && s.allowance === 'unconsumed';
  const orderedResidual = exhausted && s.journal === 'FORGED-ordered';
  const refused = !settled && (s.counter === 'invalid' || exhausted);
  const newlyOpened = ['absent', 'truncated'].includes(s.journal);
  const recovering = ['truncated', 'recovered'].includes(s.journal);
  return {
    gates: Array(2).fill(`[Service]\nEnvironment=ENABLE_DISPATCH=${orderedResidual && !ready ? 'true' : 'false'}\n`),
    credential: orderedResidual && !ready,
    lease: refused,
    effects: settled ? 21 : settlement || orderedResidual ? 0 : refused ? 7 + Number(newlyOpened) : cleanupEffects[s.physical ?? 'armed'][s.journal],
    code: settled ? null : settlement || orderedResidual || exhausted && recovering ? 'ACT_RETRY_BUDGET_EXHAUSTED' : refused ? 'ACT_RETRY_BUDGET_UNAVAILABLE' : null,
    complete: !refused,
  };
}
export async function stateTransitionCheck(createProduction, h, s) {
  const observed = await stateTransition(createProduction, h, s);
  assert.deepEqual(observed.after, requiredTransition(s), `B4_R8_STATE_${stateName(s)}`);
  return observed;
}
