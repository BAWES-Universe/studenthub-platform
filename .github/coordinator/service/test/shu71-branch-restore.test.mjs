// SHU-279: the teardown restores the refs the run published. The controls, the
// mutations and the mutant loader live in shu71-branch-restore-checks.mjs so
// that the SAME check functions drive this file test-by-test, the round's
// mutant x control matrix and the RED measurement against the pre-fix revision
// - one definition, three readers, no re-implementation that could drift from
// what is committed.
import { test } from 'node:test';
import { createShu71Production } from '../shu71-production.mjs';
import { controls, mutations, foreignRefs, fixture, foreignMovementCheck,
  loadMutant, killedBy } from './shu71-branch-restore-checks.mjs';

for (const [name, check] of controls)
  test(`B7 published-branch restore: ${name}`, async t => { await check(createShu71Production, fixture(t)); });

for (const which of foreignRefs)
  test(`B7 published-branch restore: a foreign ${which} head is refused by name and never overwritten`, async t => {
    await foreignMovementCheck(createShu71Production, fixture(t), which);
  });

for (const [name, edits, check] of mutations)
  test(`B7 published-branch restore mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, edits);
    await killedBy(t, () => check(mutant.createShu71Production, fixture(t)));
  });
