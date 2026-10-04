// SHU-71 post-push read-back robustness. The controls, the mutations and the
// mutant loader live in shu71-postpush-readback-checks.mjs so that the SAME
// check functions drive this file test-by-test, the round's mutant x control
// matrix, and the RED measurement against the pre-fix revision - one definition,
// three readers, no re-implementation that could drift from what is committed.
import { test } from 'node:test';
import { createShu71Production, apiFailureDetail, retryableApiFailure } from '../shu71-production.mjs';
import { controls, mutations, closureMutations, fixture, loadMutant, killedBy,
  detailClosureCheck, retryableClosureCheck } from './shu71-postpush-readback-checks.mjs';

for (const [name, check] of controls)
  test(`B5 post-push read-back: ${name}`, async t => { await check(createShu71Production, fixture(t)); });
test('B5 post-push read-back: the reported detail is closed to the reviewed fields',
  () => detailClosureCheck(apiFailureDetail));
test('B5 post-push read-back: only a measured transient outcome is retryable',
  () => retryableClosureCheck(retryableApiFailure));

for (const [name, before, after, check] of mutations)
  test(`B5 post-push read-back mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, () => check(mutant.createShu71Production, fixture(t)));
  });
for (const [name, check, reviewed, before, after] of closureMutations)
  test(`B5 post-push read-back mutation: ${name}`, async t => {
    check(reviewed);
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, async () => check(mutant[reviewed.name]));
  });
