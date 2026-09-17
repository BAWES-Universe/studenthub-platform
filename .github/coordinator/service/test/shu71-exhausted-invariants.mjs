import assert from 'node:assert/strict';
import { openActivationJournal } from '../shu71-journal.mjs';
import { stateTransition, requiredTransition } from './shu71-r8-state-model.mjs';

const row = { physical: 'armed', counter: 'exhausted', journal: 'intact', allowance: 'unconsumed' };
const journalVariant = event => ({
  axis: 'NON_RESERVATION_ROWS', label: event,
  transform(h, dir) {
    const journal = openActivationJournal(dir, h.boundary.fs);
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
  const baseline = await stateTransition(createProduction, fixture(), row);
  const changed = await stateTransition(createProduction, fixture(), row, variant.transform);
  diagnostic({ variant: variant.label, baseline: baseline.after, changed: changed.after });
  assert.deepEqual(baseline.after, requiredTransition(row), invariantName(variant));
  assert.deepEqual(changed.after, baseline.after, invariantName(variant));
  return { baseline: baseline.after, changed: changed.after };
}
