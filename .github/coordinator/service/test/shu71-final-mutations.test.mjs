import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalMutants } from './shu71-final-mutants.mjs';
import { loadMutant } from './shu71-r8-mutants.mjs';
import { exhaustedVariants, exhaustedInvariant, invariantName } from './shu71-exhausted-invariants.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
for (const mutant of finalMutants) test(`FINAL ${mutant.id} dies by invariant name`, async t => {
  const create = await loadMutant(t, mutant), variant = exhaustedVariants[mutant.variant];
  await assert.rejects(exhaustedInvariant(create, () => productionFixture(t, keys), variant,
    snapshots => t.diagnostic(JSON.stringify({ id: mutant.id, ...snapshots }))),
  error => error.code === 'ERR_ASSERTION' && error.message.includes(invariantName(variant)),
  `${mutant.id}_MUST_DIE_BY_NAME`);
});
