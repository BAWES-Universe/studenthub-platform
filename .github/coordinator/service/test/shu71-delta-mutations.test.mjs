import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltaMutants, deltaKiller } from './shu71-delta-mutants.mjs';
import { loadMutant, evidencePredicate } from './shu71-r8-mutants.mjs';
import { productionSource, exhaustedControl, completionOrdering, inventoryGuard } from './shu71-delta-properties.mjs';
import { exhaustedInvariant, journalInventory } from './shu71-exhausted-invariants.mjs';
import { stateTransition } from './shu71-r8-state-model.mjs';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
for (const m of deltaMutants) test(`DELTA ${m.id} reproduced and dies by name`, async t => {
  const fixture = () => productionFixture(t, keys), create = await loadMutant(t, m);
  const fixed = await exhaustedInvariant(createShu71Production, fixture, m.plant);
  const state = { physical: 'armed', counter: 'exhausted', journal: m.plant.journal ?? 'intact', allowance: 'unconsumed' };
  const broken = await stateTransition(create, fixture(), state, m.plant.transform);
  assert.deepEqual(broken.after, { gates: Array(2).fill('[Service]\nEnvironment=ENABLE_DISPATCH=true\n'), credential: true, lease: true, effects: 0, code: 'ACT_RETRY_BUDGET_EXHAUSTED', complete: false }, `${m.id}_BYPASS_REPRODUCED`);
  const killer = deltaKiller(m);
  if (killer.startsWith('SHU71')) {
    const source = productionSource().replace(evidencePredicate, `(${m.bypass}) || (${evidencePredicate})`);
    assert.throws(() => exhaustedControl(source), e => e.code === 'ERR_ASSERTION' && e.message.includes(killer), `${m.id}_MUST_DIE_BY_NAME`);
  } else await assert.rejects(exhaustedInvariant(create, fixture, m.plant), e => e.code === 'ERR_ASSERTION' && e.message.includes(killer), `${m.id}_MUST_DIE_BY_NAME`);
  t.diagnostic(JSON.stringify({ id: m.id, fixed: fixed.changed, mutant: broken.after, killer }));
});
test('DELTA ordering mutation dies by name', () => {
  const original = productionSource();
  const start = original.indexOf("      if (journal.entries.some(e => e.event === 'TEARDOWN_COMPLETE')) {");
  const end = original.indexOf("      if (active && active.activation_id !== id) return { ok: false", start);
  const block = original.slice(start, end);
  const source = original.replace(block, '').replace("      need(b.now() >= Date.parse(spec.pkg.created_at)", block + "      need(b.now() >= Date.parse(spec.pkg.created_at)");
  assert.throws(() => completionOrdering(source), /SHU71_CONTROL_PROPERTY_COMPLETION_BEFORE_EXHAUSTED/);
});
test('DELTA inventory omission dies by name', () => {
  assert.throws(() => inventoryGuard(journalInventory.slice(1)), /SHU71_CONTROL_PROPERTY_JOURNAL_CLASS_COVERAGE/);
});
test('DELTA Object.keys counter backstop dies by name', async t => {
  const m = { bypass: 'Object.keys(JSON.parse(privateRead(`${dir}/automatic-teardown.json`))).length > 1' };
  const create = await loadMutant(t, m);
  const { exhaustedVariants } = await import('./shu71-exhausted-invariants.mjs');
  await assert.rejects(exhaustedInvariant(create, () => productionFixture(t, keys), exhaustedVariants[2]), /B4_EXHAUSTED_IRRELEVANT_EXTRA_COUNTER_FIELDS/);
});

test('DELTA future append class fails inventory guard', () => {
  const source = productionSource() + "\njournal.append({ event: 'FUTURE_CLASS' });\n";
  assert.throws(() => inventoryGuard(journalInventory, { 'shu71-production.mjs': source }), /SHU71_CONTROL_PROPERTY_JOURNAL_APPEND_INVENTORY/);
});
