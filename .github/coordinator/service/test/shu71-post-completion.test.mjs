// SHU-280 round twelve: an `ok: true` may not sit on top of a ref a third
// party has moved, including after the receipt is already written. The
// controls, the mutations and the mutant loader live in
// shu71-post-completion-checks.mjs so that the SAME check functions drive this
// file test-by-test, the round's mutant x control matrix and the RED
// measurement against the pre-fix revision - one definition, three readers, no
// re-implementation that could drift from what is committed.
import { test } from 'node:test';
import { createShu71Production } from '../shu71-production.mjs';
import { controls, mutations2, movedRefs, fixture, postCompletionMovementCheck,
  loadMutant, killedBy } from './shu71-post-completion-checks.mjs';

for (const [name, check] of controls)
  test(`B9 post-completion measurement: ${name}`, async t => { await check(createShu71Production, fixture(t)); });

for (const which of movedRefs)
  test(`B9 post-completion measurement: a third party that advances the ${which} ref after the receipt is refused and never overwritten`, async t => {
    await postCompletionMovementCheck(createShu71Production, fixture(t), which);
  });

for (const [name, edits, check] of mutations2)
  test(`B9 post-completion measurement mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, edits);
    await killedBy(t, () => check(mutant.createShu71Production, fixture(t)));
  });
