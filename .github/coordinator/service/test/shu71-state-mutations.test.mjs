import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { stateTransitionCheck, stateName } from './shu71-r8-state-model.mjs';
import { demonstratedMutants, loadMutant } from './shu71-r8-mutants.mjs';
const keys = ephemeralPublicSource();
for (const m of demonstratedMutants) test(`R8 demonstrated mutant ${m.id} dies on the state table`, async t => {
  await stateTransitionCheck(createShu71Production, productionFixture(t, keys), m.witness);
  const createMutant = await loadMutant(t, m);
  const name = `B4_R8_STATE_${stateName(m.witness)}`;
  await assert.rejects(() => stateTransitionCheck(createMutant, productionFixture(t, keys), m.witness),
    e => e.code === 'ERR_ASSERTION' && e.message.includes(name), `B4_R8_${m.id}_NAMED_KILL`);
  t.diagnostic(`${m.id}: ${name}`);
});
