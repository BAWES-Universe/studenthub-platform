// SHU-280. A COMPLETION ROW MAY NOT SKIP THE FINAL MEASUREMENT.
//
// SHU-279 moved the restoration of the published fixture refs into the
// reviewed teardown as `restore-branch`, and proved it. But `restore-branch`
// is a JOURNALLED effect, so a durable `DONE` row makes every later invocation
// skip it - and the same row skipped its MEASUREMENT with it. Measured by the
// independent verifier and ruled blocking by the owner: `restore-branch`
// SUCCEEDS, a LATER teardown effect fails, a third party then advances the
// lane branch, and the SECOND invocation ends `TEARDOWN_COMPLETE,
// failures: []` while the ref is advanced - a clean receipt sitting on top of
// externally changed state.
//
//   "A completion row may avoid repeating an effect, but it may not avoid
//    final measurement of externally mutable state. If a branch changes after
//    an earlier restore and before a later teardown invocation, the result
//    must HALT by name and leave the third-party value untouched. It must not
//    emit a clean teardown receipt."
//
// The controls, the mutations and the mutant loader live here so that the SAME
// check functions drive the .test.mjs file test-by-test, the round's mutant x
// control matrix, and the RED measurement against the pre-fix revision - one
// definition, three readers, no re-implementation that could drift.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';

export const keys = ephemeralPublicSource();
export const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
export const source = fs.readFileSync(moduleUrl, 'utf8');
export const fixture = t => productionFixture(t, keys);
const FOREIGN = 'f'.repeat(40);

const parent = h => h.spec.pkg.reseed.expected_parent;
const published = h => h.spec.pkg.reseed.expected_seed_head;
const lineage = h => ({ remote: h.refs.remote, local: h.refs.local, tracking: h.refs.tracking });
const retained = h => ({ remote: parent(h), local: parent(h), tracking: parent(h) });
// The restoration's own measurement, and the FINAL one. They are separate rows
// on purpose: the first says what the effect saw when it was allowed to run,
// the second says what the host held when the receipt was written.
const restoreRows = h => h.journal().filter(e => e.event === 'BRANCH_RESTORE_MEASURED');
const finalRows = h => h.journal().filter(e => e.event === 'BRANCH_FINAL_MEASURED');
const found = row => ({ remote: row.remote, local: row.local, tracking: row.tracking });
const pushes = h => h.events.filter(e => e.startsWith('command:') && e.includes(' push '));
const updates = h => h.events.filter(e => e.startsWith('command:') && e.includes(' update-ref '));
const mutations = h => [...pushes(h), ...updates(h)].length;

// THE OWNER'S SETUP, and the only one that reproduces the ruled defect: the
// window arms and publishes, `restore-branch` SUCCEEDS and reaches its durable
// DONE row, and a LATER teardown effect fails so the invocation ends
// TEARDOWN_INCOMPLETE and the episode stays open.
//
// The later failure is `evidence-broker`: the broker really does stop and the
// command then reports failure, exactly as a connection or a spawn that dies
// after its work landed. Modelling it that way is deliberate - the physical
// post-conditions the final observation checks still hold, so what the second
// invocation refuses is the BRANCH and nothing else.
export async function armedThenBrokenTeardown(create, h) {
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'B8_SETUP_ARMED');
  assert.equal(h.refs.remote, published(h), 'B8_SETUP_PUBLISHED');
  const inner = h.boundary.run;
  h.boundary.run = (exe, argv, options) => {
    const answer = inner(exe, argv, options);
    return exe === '/usr/bin/systemctl' && argv[0] === 'stop' && argv[1] === 'shu71-evidence.service'
      ? { status: 1, stdout: '' } : answer;
  };
  const first = await create(h.id, h.boundary).execute('revoke');
  h.boundary.run = inner;
  assert.equal(first.ok, false, `B8_SETUP_FIRST_INVOCATION_INCOMPLETE: ${JSON.stringify(first)}`);
  assert.ok(first.failures.includes('ACT_TEARDOWN_EVIDENCE_BROKER'), 'B8_SETUP_LATER_EFFECT_FAILED');
  // The restore SUCCEEDED and carries the durable completion row that makes
  // every later invocation skip the step.
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:restore-branch'), 'B8_SETUP_RESTORE_HAS_DONE_ROW');
  assert.deepEqual(lineage(h), retained(h), 'B8_SETUP_RESTORED_BEFORE_THIRD_PARTY');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', 'B8_SETUP_FIRST_INVOCATION_INCOMPLETE');
  return first;
}

// ---------------------------------------------------------------- controls

// (b) THE DEFECT ITSELF. A third party advances the lane branch between the
// two invocations. The step is NOT re-run - its DONE row still stands - and
// the refs are measured anyway; the third value HALTS by name, is recorded,
// and is left exactly where the third party left it.
export async function thirdPartyMovementCheck(create, h, which = 'remote') {
  const label = `B8_THIRD_PARTY_${which.toUpperCase()}`;
  await armedThenBrokenTeardown(create, h);
  const measured = finalRows(h).length, restored = restoreRows(h).length, moved = mutations(h);
  h.refs[which] = FOREIGN;
  const before = { ...lineage(h) };
  const second = await create(h.id, h.boundary).execute('resume');
  // The EFFECT is not repeated - that is what the DONE row is for - and the
  // MEASUREMENT happens anyway. Both halves of the ruling, in one place.
  assert.equal(restoreRows(h).length, restored, 'B8_EFFECT_NOT_REPEATED');
  // `>` rather than `=== measured + 1`: teardownActivation re-attempts every
  // failed non-retirement step once, so a refusing observation measures twice.
  assert.ok(finalRows(h).length > measured, 'B8_FINAL_MEASURED_AGAIN');
  assert.deepEqual(found(finalRows(h).at(-1)), { ...retained(h), [which]: FOREIGN }, 'B8_FINAL_MEASUREMENT_RECORDS_WHAT_IT_FOUND');
  // Never overwritten, never adopted: the observation issues no command at all.
  assert.equal(h.refs[which], FOREIGN, `B8_THIRD_VALUE_UNTOUCHED: ${label}`);
  assert.deepEqual(lineage(h), before, `B8_THIRD_VALUE_UNTOUCHED: ${label}`);
  assert.equal(mutations(h), moved, 'B8_THIRD_VALUE_NO_MUTATION_ISSUED');
  // `ok: true` here IS the clean receipt the ruling forbids, so it is asserted
  // under that name rather than under a generic scenario label.
  assert.equal(second.ok, false, `B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT: ${label} ${JSON.stringify(second)}`);
  assert.equal(second.code, 'ACT_CLEANUP_FAILED', 'B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', 'B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT');
  assert.ok(second.failures.includes('ACT_TEARDOWN_OBSERVATION'), 'B8_THIRD_VALUE_HALTS_BY_NAME');
  assert.ok(second.failures.includes('ACT_TEARDOWN_BRANCH_MOVED'), 'B8_THIRD_VALUE_HALTS_BY_NAME');
  assert.deepEqual(h.journal().at(-1).failures, second.failures, 'B8_THIRD_VALUE_FAILURES_DURABLE');
  return second;
}

// (a) THE CONTROL THAT PINS THE OTHER DIRECTION. The same second invocation,
// with the ref STILL at the retained parent, is a clean receipt - the
// measurement is a cost, not a new refusal, and a re-invocation over unchanged
// state still completes.
export async function unchangedSecondInvocationCheck(create, h) {
  const label = 'B8_UNCHANGED_CLEAN_RECEIPT';
  await armedThenBrokenTeardown(create, h);
  const measured = finalRows(h).length, restored = restoreRows(h).length, moved = mutations(h);
  const second = await create(h.id, h.boundary).execute('resume');
  assert.equal(second.state, 'REVOKED', `${label}: ${JSON.stringify(second)}`);
  assert.deepEqual(second.failures, [], label);
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', label);
  assert.deepEqual(lineage(h), retained(h), 'B8_UNCHANGED_MOVES_NOTHING');
  assert.equal(mutations(h), moved, 'B8_UNCHANGED_NO_MUTATION_ISSUED');
  assert.equal(restoreRows(h).length, restored, 'B8_EFFECT_NOT_REPEATED');
  // Measured again regardless - the receipt rests on a fresh reading, not on
  // the DONE row of a step that ran in an earlier process. TWO readings, not
  // one: SHU-280's twelfth round gave the `expiry-timer` re-observation the
  // same measurement, so a completing invocation reads the refs once in the
  // `observation` step and once more in the retirement step that follows it.
  // The property this control pins is unchanged - the count is.
  assert.equal(finalRows(h).length, measured + 2, 'B8_FINAL_MEASURED_AGAIN');
  assert.deepEqual(found(finalRows(h).at(-1)), retained(h), 'B8_FINAL_MEASUREMENT_RECORDS_WHAT_IT_FOUND');
  return second;
}

// (c.i) THIS RUN'S OWN PUBLISHED HEAD, STANDING AT THE END. `restore-branch`
// already holds a DONE row, so the effect is not re-run - and the final
// measurement still refuses to close a clean receipt over the value this
// episode published. It names itself separately from a foreign write, because
// it means something different: the restoration did not hold.
export async function republishedAfterRestoreCheck(create, h) {
  const label = 'B8_UNRESTORED_HALTS';
  await armedThenBrokenTeardown(create, h);
  const moved = mutations(h);
  h.refs.remote = published(h);
  const second = await create(h.id, h.boundary).execute('resume');
  assert.equal(second.ok, false, `${label}: ${JSON.stringify(second)}`);
  assert.ok(second.failures.includes('ACT_TEARDOWN_OBSERVATION'), 'B8_UNRESTORED_HALTS_BY_NAME');
  assert.ok(second.failures.includes('ACT_TEARDOWN_BRANCH_UNRESTORED'), 'B8_UNRESTORED_HALTS_BY_NAME');
  assert.equal(finalRows(h).at(-1).remote, published(h), 'B8_FINAL_MEASUREMENT_RECORDS_WHAT_IT_FOUND');
  assert.equal(h.refs.remote, published(h), 'B8_UNRESTORED_NOT_OVERWRITTEN');
  assert.equal(mutations(h), moved, 'B8_UNRESTORED_NO_MUTATION_ISSUED');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B8_UNRESTORED_NOT_A_CLEAN_RECEIPT');
  return second;
}

// (c.ii) THE SAME VALUE, WITH NO COMPLETION ROW IN FRONT OF IT. The first
// invocation's restoring push fails, so `restore-branch` has no DONE row and
// the published head is still on the remote: the final measurement names it
// rather than passing, and the NEXT invocation - where the step is re-run,
// exactly as the existing semantics require - restores it and closes clean.
export async function unrestoredThenRepairedCheck(create, h) {
  const label = 'B8_REPAIR';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', `${label}_SETUP`);
  const inner = h.boundary.run;
  h.boundary.run = (exe, argv, options) =>
    argv.includes('push') && h.refs.remote === published(h) ? { status: 1, stdout: '' } : inner(exe, argv, options);
  const first = await create(h.id, h.boundary).execute('revoke');
  h.boundary.run = inner;
  assert.equal(first.ok, false, `${label}_FIRST: ${JSON.stringify(first)}`);
  assert.equal(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:restore-branch'), false, 'B8_REPAIR_NO_DONE_ROW');
  assert.equal(h.refs.remote, published(h), 'B8_REPAIR_NOTHING_CLOBBERED');
  // The final measurement saw the published head and said so, under its own
  // name, in the same invocation that failed to restore it.
  assert.ok(finalRows(h).length > 0, 'B8_REPAIR_MEASURED_PUBLISHED');
  assert.equal(finalRows(h).at(-1).remote, published(h), 'B8_REPAIR_MEASURED_PUBLISHED');
  assert.ok(first.failures.includes('ACT_TEARDOWN_BRANCH_UNRESTORED'), 'B8_REPAIR_NAMES_UNRESTORED');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B8_REPAIR_NOT_A_CLEAN_RECEIPT');
  const second = await create(h.id, h.boundary).execute('resume');
  assert.equal(second.state, 'REVOKED', `${label}_SECOND: ${JSON.stringify(second)}`);
  assert.deepEqual(second.failures, [], `${label}_SECOND`);
  assert.deepEqual(lineage(h), retained(h), 'B8_REPAIR_MINT_LINEAGE_SATISFIED');
  assert.deepEqual(found(finalRows(h).at(-1)), retained(h), 'B8_REPAIR_FINAL_MEASUREMENT_CLEAN');
  return second;
}

// (d) THE MEASUREMENT ITSELF FAILING. On the second invocation the restore is
// skipped, so the final observation is the ONLY reader of that ref - and a
// read that never answers is a named teardown failure carrying its cause,
// never a silent pass.
export async function measurementFailureCheck(create, h) {
  const label = 'B8_MEASUREMENT_FAILURE';
  await armedThenBrokenTeardown(create, h);
  const before = { ...lineage(h) }, moved = mutations(h);
  const inner = h.boundary.run;
  let reads = 0;
  h.boundary.run = (exe, argv, options) => {
    if (argv.includes('for-each-ref') && argv.includes(`refs/heads/${h.spec.pkg.reseed.branch}`)) { reads++; return { status: 1, stdout: '' }; }
    return inner(exe, argv, options);
  };
  const second = await create(h.id, h.boundary).execute('resume');
  h.boundary.run = inner;
  assert.ok(reads > 0, 'B8_MEASUREMENT_READ_ATTEMPTED');
  assert.equal(second.ok, false, `${label}: ${JSON.stringify(second)}`);
  assert.ok(second.failures.includes('ACT_TEARDOWN_OBSERVATION'), 'B8_MEASUREMENT_FAILURE_NAMES_THE_STEP');
  assert.ok(second.failures.includes('ACT_COMMAND_FAILED'), 'B8_MEASUREMENT_FAILURE_CARRIES_ITS_CAUSE');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', 'B8_MEASUREMENT_FAILURE_NOT_A_CLEAN_RECEIPT');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B8_MEASUREMENT_FAILURE_NOT_A_CLEAN_RECEIPT');
  assert.deepEqual(lineage(h), before, 'B8_MEASUREMENT_FAILURE_MOVES_NOTHING');
  assert.equal(mutations(h), moved, 'B8_MEASUREMENT_FAILURE_NO_MUTATION_ISSUED');
  return second;
}

// THE GATE IS UNCHANGED AND STILL LOAD-BEARING. A window that refused before
// `local-reseed` published nothing, so the final measurement contacts no
// remote, reads no credential and claims nothing - and still completes.
export async function neverPublishedStillCleanCheck(create, h) {
  const label = 'B8_NEVER_PUBLISHED';
  const inner = h.boundary.fetch;
  h.boundary.fetch = async (url, options) =>
    url.includes('/git/ref/heads/coordinator%2FSHU-140') ? { ok: false, status: 500, text: async () => '{}' } : inner(url, options);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', label);
  assert.equal(h.journal().some(e => e.event === 'INTENT' && e.step === 'local-reseed'), false, label);
  assert.equal(result.teardown.ok, true, `${label}: ${JSON.stringify(result.teardown)}`);
  assert.deepEqual(result.teardown.failures, [], label);
  assert.deepEqual(finalRows(h), [], 'B8_NEVER_PUBLISHED_NO_FINAL_MEASUREMENT');
  assert.deepEqual(lineage(h), retained(h), 'B8_NEVER_PUBLISHED_MOVES_NOTHING');
  assert.equal(mutations(h), 0, 'B8_NEVER_PUBLISHED_NO_MUTATION_ISSUED');
  return result;
}

export const controls = [
  ['a third-party advance after a completed restore halts by name and is left untouched', thirdPartyMovementCheck],
  ['an unchanged ref on a second invocation is measured again and completes', unchangedSecondInvocationCheck],
  ['this run\'s published head standing at the end is never closed over', republishedAfterRestoreCheck],
  ['an unrestored ref is named, then restored by the invocation that may re-run the step', unrestoredThenRepairedCheck],
  ['a final measurement that cannot be taken is a named failure with its cause', measurementFailureCheck],
  ['a window that never published measures nothing and still completes', neverPublishedStillCleanCheck],
];
export const movedRefs = ['remote', 'local', 'tracking'];

// ---------------------------------------------------------------- mutations

const OBSERVATION = "    effects.push(['observation', () => { observeTeardown(); observePublishedRefs(spec, journal); }]);";
// Re-anchored by SHU-280's thirteenth round, which gave the same function a
// `settled` caller - the post-completion path, which writes no receipt and so
// records only a DISAGREEING reading. The gate itself is unchanged, and so are
// both mutations below: they put a completion row back in charge of the
// measurement, which is exactly what this round's own controls forbid too.
const GATE = `  function observePublishedRefs(spec, journal, settled = false) {
    if (!(journal.recovered || journalHas(journal, 'INTENT', 'local-reseed'))) return;`;
const JUDGE = "      need(false, value === published ? 'ACT_TEARDOWN_BRANCH_UNRESTORED' : 'ACT_TEARDOWN_BRANCH_MOVED');";
const remoteMoved = (create, h) => thirdPartyMovementCheck(create, h, 'remote');
const localMoved = (create, h) => thirdPartyMovementCheck(create, h, 'local');

export const mutations2 = [
  // The measurement removed outright - the merged pre-fix behaviour.
  ['the final measurement is removed entirely', [[OBSERVATION, "    effects.push(['observation', observeTeardown]);"]], remoteMoved],
  // The completion row put back in charge of the measurement, in the three
  // shapes the owner named.
  ['the final measurement runs only when the restore has no DONE row',
    [[GATE, `${GATE}\n    if (journalHas(journal, 'DONE', 'teardown:restore-branch')) return;`]], remoteMoved],
  ['the final measurement is a no-op once it has run in an earlier invocation',
    [[GATE, `${GATE}\n    if (journalHas(journal, 'BRANCH_FINAL_MEASURED')) return;`]], remoteMoved],
  // Measured, recorded, and nothing concluded from it.
  ['the measurement is recorded but never judged', [[JUDGE, '      void kind, value;']], remoteMoved],
  // A third value treated as this run's to put back - leased to whatever the
  // ref happens to hold, which is what "restore it anyway" is.
  ['a third value is treated as restorable',
    [[JUDGE, "      if (kind === 'remote') git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${value}`, REMOTE, `${parent}:${ref}`], { remote: true });\n"
      + "      else git(spec, ['update-ref', kind === 'local' ? ref : tracking, parent, value]);"]], remoteMoved],
  // The same door without even a lease: an unconditional clobber.
  ['the third value is overwritten by an unleased force',
    [[JUDGE, "      if (kind === 'remote') git(spec, ['push', '--porcelain', '--force', REMOTE, `${parent}:${ref}`], { remote: true });\n"
      + "      else git(spec, ['update-ref', kind === 'local' ? ref : tracking, parent]);"]], remoteMoved],
  ['a third local head is overwritten by an unconditional update-ref',
    [[JUDGE, "      if (kind === 'remote') git(spec, ['push', '--porcelain', '--force', REMOTE, `${parent}:${ref}`], { remote: true });\n"
      + "      else git(spec, ['update-ref', kind === 'local' ? ref : tracking, parent]);"]], localMoved],
  // This run's own published head accepted as an ending state.
  ['this run\'s published head is accepted at the end',
    [[JUDGE, "      need(value !== published, 'ACT_TEARDOWN_BRANCH_MOVED');"]], republishedAfterRestoreCheck],
  // A read that never answered turned into a pass.
  ['a measurement failure is swallowed',
    [[OBSERVATION, "    effects.push(['observation', () => { observeTeardown(); try { observePublishedRefs(spec, journal); } catch { /* mutant */ } }]);"]],
    measurementFailureCheck],
];

// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
export async function loadMutant(t, edits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-final-measurement-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let mutated = source;
  for (const [before, after] of edits) {
    assert.equal(mutated.split(before).length, 2, 'B8_MUTATION_ANCHOR_UNIQUE');
    mutated = mutated.replace(before, after);
  }
  const modified = mutated.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  return import(pathToFileURL(file));
}
// The killing assertion is reported, not merely counted.
export async function killedBy(t, run) {
  let killed = null;
  await assert.rejects(run, error => {
    killed = error; return error.code === 'ERR_ASSERTION' && /B8_/.test(error.message);
  }, 'B8_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B8_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}
