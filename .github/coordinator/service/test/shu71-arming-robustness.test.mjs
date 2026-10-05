// SHU-71 arming and lifecycle robustness. The controls, the mutations and the
// mutant loader live in shu71-arming-robustness-checks.mjs so that the SAME
// check functions drive this file test-by-test, the round's mutant x control
// matrix, and the RED measurement against the pre-fix revision - one
// definition, three readers, no re-implementation that could drift from what is
// committed.
import { test } from 'node:test';
import { createShu71Production, commandFailureDetail, haltCode, readOnlyCommand } from '../shu71-production.mjs';
import { controls, variantControls, mutations, siblingMutations, fixture, loadMutant, killedBy,
  commandDetailClosureCheck, haltCodeClosureCheck, readOnlyCommandClosureCheck, cliNamesTheCodeCheck,
  linearMutationStillUnretriedCheck, PATTERN_MUTATION } from './shu71-arming-robustness-checks.mjs';

for (const [name, check] of controls)
  test(`B6 arming robustness: ${name}`, async t => { await check(createShu71Production, fixture(t)); });
for (const [name, check, variants] of variantControls) for (const variant of variants)
  test(`B6 arming robustness: ${name} (${variant})`, async t => { await check(createShu71Production, fixture(t), variant); });
test('B6 arming robustness: the Linear issueUpdate mutation is still final on its first error',
  async t => { await linearMutationStillUnretriedCheck(createShu71Production, fixture(t)); });
test('B6 arming robustness: the CLI names the refusal it caught', () => cliNamesTheCodeCheck());
test('B6 arming robustness: the reported command detail is closed to the reviewed fields',
  () => commandDetailClosureCheck(commandFailureDetail));
test('B6 arming robustness: only a reviewed refusal name reaches a halt record',
  () => haltCodeClosureCheck(haltCode));
test('B6 arming robustness: only an enumerated host read may be repeated',
  () => readOnlyCommandClosureCheck(readOnlyCommand));

for (const [name, before, after, check] of mutations)
  test(`B6 arming robustness mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, () => check(mutant.module.createShu71Production, fixture(t)));
  });
for (const [name, target, before, after, check] of siblingMutations)
  test(`B6 arming robustness mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, before, after, target);
    await killedBy(t, () => check(mutant.module.createShu71Production, fixture(t)));
  });
test(`B6 arming robustness mutation: ${PATTERN_MUTATION[0]}`, async t => {
  haltCodeClosureCheck(haltCode);
  const [, target, before, after] = PATTERN_MUTATION;
  const mutant = await loadMutant(t, before, after, target);
  await killedBy(t, async () => haltCodeClosureCheck(mutant.module.haltCode));
});
