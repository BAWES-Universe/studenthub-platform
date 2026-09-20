import assert from 'node:assert/strict';
import { openActivationJournal } from '../shu71-journal.mjs';
import { stateTransition, requiredTransition } from './shu71-r8-state-model.mjs';

export const row = { physical: 'armed', counter: 'exhausted', journal: 'intact', allowance: 'unconsumed' };
const journalVariant = event => ({
  axis: 'NON_RESERVATION_ROWS', label: event,
  transform(h, dir) {
    const journal = openActivationJournal(dir, h.boundary.fs, 'journal.jsonl', h.identity);
    try { journal.append({ event }); } finally { journal.close(); }
  },
});
// Representatives of three irrelevant-input axes, not mutant predicates.
export const exhaustedVariants = [
  journalVariant('HALTED'), journalVariant('FIXTURE_REMOVE_INTENT'),
  { axis: 'EXTRA_COUNTER_FIELDS', label: 'extra fields', transform(h, dir) {
    const file = `${dir}/automatic-teardown.json`;
    h.write(file, JSON.stringify({ ...JSON.parse(h.read(file)), settled: true, arbitrary_metadata: { value: 'ignored' } }));
  } },
  { axis: 'CLOCK_PAST_EXPIRY', label: '+365 days', transform(h) {
    const expiry = h.boundary.now();
    h.boundary.now = () => expiry + 365 * 86400000;
  } },
];
export const invariantName = variant => `B4_EXHAUSTED_IRRELEVANT_${variant.axis}`;
export async function exhaustedInvariant(createProduction, fixture, variant, diagnostic = () => {}) {
  const selected = { ...row, journal: variant.journal ?? 'intact' };
  const baseline = await stateTransition(createProduction, fixture(), selected);
  const changed = await stateTransition(createProduction, fixture(), selected, variant.transform);
  diagnostic({ variant: variant.label, baseline: baseline.after, changed: changed.after });
  assert.deepEqual(baseline.after, requiredTransition(selected), invariantName(variant));
  assert.deepEqual(changed.after, baseline.after, invariantName(variant));
  return { baseline: baseline.after, changed: changed.after };
}

// Payload values instantiate the exact shapes at the guarded production sites.
export const journalInventory = [
  { event: 'APPROVED', payload: h => ({ spec: h.spec }) },
  { event: 'SIGNING_STARTED' },
  { event: 'RUN_ATTEMPT_STARTED' }, { event: 'BROKER_RUNTIME_CHECK_STARTED' },
  { event: 'BROKER_RUNTIME_MEASURED', payload: h => JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/broker-runtime.json`)) },
  { event: 'ARMED', payload: h => ({ authorization_expires_at: h.spec.pkg.expires_at, teardown_complete: false }) },
  { event: 'HALTED', payload: () => ({ code: 'ACT_PRODUCTION_FAILED' }) },
  { event: 'EXPIRY_RETIREMENT_STARTED' },
  { event: 'FIXTURE_REMOVE_INTENT', payload: () => ({ attempt_id: '12345678-1234-1234-1234-123456789abc', dev: 1, ino: 2, uid: 999 }) },
  { event: 'BRANCH_RESTORE_MEASURED', payload: h => ({ branch: h.spec.pkg.reseed.branch,
    remote: h.spec.pkg.reseed.expected_parent, local: h.spec.pkg.reseed.expected_parent, tracking: h.spec.pkg.reseed.expected_parent }) },
  { event: 'AUTOMATIC_TEARDOWN_RESERVED', payload: () => ({ attempts: 2 }) },
  { event: 'SETTLEMENT_STARTED' }, { event: 'INTENT', payload: () => ({ step: 'teardown:gate' }) },
  { event: 'DONE', payload: () => ({ step: 'teardown:gate' }) },
  { event: 'AUTHORIZATION_EXPIRED' }, { event: 'REVOKE_REQUESTED' },
  { event: 'TEARDOWN_INCOMPLETE', payload: () => ({ failures: ['ACT_TEARDOWN_GATE'] }) },
  { event: 'TEARDOWN_COMPLETE', terminal: true, payload: () => ({ failures: [] }) },
];
export function appendReal(h, dir, entry, journal = 'intact') {
  const writer = openActivationJournal(dir, h.boundary.fs, journal === 'recovered' ? 'recovery.jsonl' : 'journal.jsonl', h.identity);
  try { writer.append({ event: entry.event, ...entry.payload?.(h) }); } finally { writer.close(); }
}
export const realJournalVariants = ['intact', 'recovered'].flatMap(journal => journalInventory.filter(e => !e.terminal).map(entry => ({
  axis: 'NON_RESERVATION_ROWS', label: `${entry.event} real payload ${journal}`, journal,
  transform: (h, dir) => appendReal(h, dir, entry, journal),
})));
export const clockSweep = [86400001, ...[2, 7, 29, 365, 400, 3650].map(d => d * 86400000)].map(delta => ({
  axis: 'CLOCK_PAST_EXPIRY', label: `delta ${delta} ms`, transform(h) { const expiry = h.boundary.now(); h.boundary.now = () => expiry + delta; },
}));
exhaustedVariants.push(...realJournalVariants, ...clockSweep);
