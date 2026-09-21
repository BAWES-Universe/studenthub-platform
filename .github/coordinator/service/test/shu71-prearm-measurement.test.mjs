// SHU-280 round fourteen: a teardown may not answer clean over a ref it never
// read, including the embedded teardown a pre-arm halt returns. The controls,
// the mutations and the mutant loader live in
// shu71-prearm-measurement-checks.mjs so that the SAME check functions drive
// this file test-by-test, the round's mutant x control matrix and the RED
// measurement against the pre-fix revision - one definition, three readers, no
// re-implementation that could drift from what is committed.
import { test } from 'node:test';
import { createShu71Production } from '../shu71-production.mjs';
import { controls, mutations2, movedRefs, fixture, preArmForeignRefCheck,
  loadMutant, killedBy } from './shu71-prearm-measurement-checks.mjs';

for (const [name, check] of controls)
  test(`B10 pre-arm teardown measurement: ${name}`, async t => { await check(createShu71Production, fixture(t)); });

for (const which of movedRefs)
  test(`B10 pre-arm teardown measurement: a third party holding the ${which} ref is refused and never overwritten`, async t => {
    await preArmForeignRefCheck(createShu71Production, fixture(t), which);
  });

for (const [name, edits, check] of mutations2)
  test(`B10 pre-arm teardown measurement mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, edits);
    await killedBy(t, () => check(mutant.createShu71Production, fixture(t)));
  });
