// SHU-280, round twelve. AN `ok: true` MAY NOT SIT ON TOP OF A REF A THIRD
// PARTY HAS MOVED - INCLUDING AFTER THE RECEIPT IS ALREADY WRITTEN.
//
// The previous round gave the teardown's own final observation an
// unconditional re-measurement of the three refs the next mint reads, and
// proved it. Its disclosure named what that did NOT reach, and the owner had
// already ruled that class blocking:
//
//   "A completion row may avoid repeating an effect, but it may not avoid
//    final measurement of externally mutable state... the result must HALT by
//    name and leave the third-party value untouched. It must not emit a clean
//    teardown receipt."
//
// Two paths still answered without reading the refs.
//
//   (1) THE POST-COMPLETION PATH. Once an episode's journal carries
//       TEARDOWN_COMPLETE, a repeat `run`/`resume`/`revoke`/`expire` takes the
//       historical-receipt branch of `execute()`: it re-measures the units, the
//       credential and the gates, and asked nothing about the refs. Measured:
//       invocation two closes clean with the refs at the retained parent, a
//       third party advances the remote, and invocation three answered
//       `{ ok: true, state: "REVOKED", physical_teardown_observed: true }`
//       with no BRANCH_FINAL_MEASURED row.
//
//   (2) THE `expiry-timer` RE-OBSERVATION. The last step of a teardown re-runs
//       `observeTeardown()` as defence in depth against drift between the
//       observation and the retirement - and re-read everything EXCEPT the
//       refs, so a write landing in that interval was seen by nothing and the
//       invocation closed `TEARDOWN_COMPLETE, failures: []` over a moved ref.
//
// Both now measure. Neither writes a new receipt and neither issues a command
// beyond the two reads: a disagreement HALTS by a named code and the third
// party's value is left exactly where it was found.
//
// The controls, the mutations and the mutant loader live here so that the SAME
// check functions drive the .test.mjs file test-by-test, this round's mutant x
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
const finalRows = h => h.journal().filter(e => e.event === 'BRANCH_FINAL_MEASURED');
const found = row => ({ remote: row.remote, local: row.local, tracking: row.tracking });
const receipts = h => h.journal().filter(e => ['TEARDOWN_COMPLETE', 'TEARDOWN_INCOMPLETE'].includes(e.event));
const pushes = h => h.events.filter(e => e.startsWith('command:') && e.includes(' push '));
const updates = h => h.events.filter(e => e.startsWith('command:') && e.includes(' update-ref '));
const mutations = h => [...pushes(h), ...updates(h)].length;
const remoteReads = h => h.events.filter(e => e.startsWith('command:') && e.includes(' ls-remote ')).length;
const localReads = h => h.events.filter(e => e.startsWith('command:') && e.includes(' for-each-ref ')).length;
const writes = h => h.events.filter(e => /^(write:|rename:|unlink:|remove:)/.test(e)).length;

// THE SETUP THE RULING DESCRIBES, taken one step further than the previous
// round's: the window arms and publishes, and the teardown COMPLETES. There is
// no open episode left, no failed step to retry and no reason to run an effect
// again - the durable TEARDOWN_COMPLETE was honest when it was written, with
// every ref measured at the retained parent. Everything after this point is
// about what the NEXT invocation is entitled to say.
export async function armedThenCompletedTeardown(create, h) {
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'B9_SETUP_ARMED');
  assert.equal(h.refs.remote, published(h), 'B9_SETUP_PUBLISHED');
  const first = await create(h.id, h.boundary).execute('revoke');
  assert.equal(first.ok, true, `B9_SETUP_FIRST_INVOCATION_CLEAN: ${JSON.stringify(first)}`);
  assert.deepEqual(first.failures, [], 'B9_SETUP_FIRST_INVOCATION_CLEAN');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', 'B9_SETUP_COMPLETION_ROW');
  assert.deepEqual(lineage(h), retained(h), 'B9_SETUP_RESTORED_BEFORE_THIRD_PARTY');
  return first;
}

// ---------------------------------------------------------------- controls

// (b) THE DEFECT ITSELF, on each of the three refs in turn. A third party
// advances one of them AFTER the receipt is written. The next invocation does
// not repeat one effect and does not write one new durable receipt row - and it
// measures, refuses by name, and leaves the value alone.
export async function postCompletionMovementCheck(create, h, which = 'remote') {
  const label = `B9_POST_COMPLETION_${which.toUpperCase()}`;
  await armedThenCompletedTeardown(create, h);
  const measured = finalRows(h).length, moved = mutations(h), closed = receipts(h).length;
  const reads = remoteReads(h) + localReads(h);
  h.refs[which] = FOREIGN;
  const before = { ...lineage(h) };
  const third = await create(h.id, h.boundary).execute('resume');
  // `ok: true` here IS the clean answer over externally changed state that the
  // ruling forbids, so it is asserted under that name.
  assert.equal(third.ok, false, `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER: ${label} ${JSON.stringify(third)}`);
  assert.notEqual(third.state, 'REVOKED', `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER: ${label}`);
  assert.equal(third.physical_teardown_observed, undefined, `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER: ${label}`);
  // Named, not flattened into "drift": the operator has to know WHICH value.
  assert.equal(third.code, 'ACT_TEARDOWN_BRANCH_MOVED', `B9_POST_COMPLETION_HALTS_BY_NAME: ${label}`);
  // Measured: three reads were taken, and the reading the refusal rests on is
  // durable - it is the only thing that says WHICH value stopped the answer.
  assert.equal(remoteReads(h) + localReads(h), reads + 3, `B9_POST_COMPLETION_MEASURED: ${label}`);
  assert.equal(finalRows(h).length, measured + 1, `B9_POST_COMPLETION_REFUSAL_IS_DURABLE: ${label}`);
  assert.deepEqual(found(finalRows(h).at(-1)), { ...retained(h), [which]: FOREIGN },
    `B9_POST_COMPLETION_RECORDS_WHAT_IT_FOUND: ${label}`);
  // Never overwritten, never adopted, never fast-forwarded: this path issues
  // no command but the two reads.
  assert.equal(h.refs[which], FOREIGN, `B9_THIRD_VALUE_UNTOUCHED: ${label}`);
  assert.deepEqual(lineage(h), before, `B9_THIRD_VALUE_UNTOUCHED: ${label}`);
  assert.equal(mutations(h), moved, `B9_THIRD_VALUE_NO_MUTATION_ISSUED: ${label}`);
  // No second receipt: the durable TEARDOWN_COMPLETE stands untouched and
  // nothing new claims anything about this host.
  assert.equal(receipts(h).length, closed, `B9_POST_COMPLETION_NO_NEW_RECEIPT: ${label}`);
  assert.equal(h.journal().filter(e => e.event === 'TEARDOWN_COMPLETE').length, 1,
    `B9_POST_COMPLETION_NO_NEW_RECEIPT: ${label}`);
  return third;
}

// (a) THE CONTROL THAT PINS THE OTHER DIRECTION. The same invocation with every
// ref still at the retained parent stays a clean historical answer - the
// measurement is a cost, not a new refusal.
export async function postCompletionUnchangedCheck(create, h) {
  const label = 'B9_POST_COMPLETION_UNCHANGED';
  await armedThenCompletedTeardown(create, h);
  const measured = finalRows(h).length, moved = mutations(h), closed = receipts(h).length;
  const reads = remoteReads(h) + localReads(h), written = writes(h), rows = h.journal().length;
  const third = await create(h.id, h.boundary).execute('resume');
  assert.equal(third.ok, true, `${label}_NO_FALSE_HALT: ${JSON.stringify(third)}`);
  assert.equal(third.state, 'REVOKED', `${label}_NO_FALSE_HALT`);
  assert.equal(third.physical_teardown_observed, true, `${label}_NO_FALSE_HALT`);
  // The three reads WERE taken - that is the whole point - and because they
  // agreed, this repeat invocation of a settled episode stayed physically
  // inert: no journal row, no write of any kind. A measurement that recorded
  // unconditionally here would append another row on every later wake.
  assert.equal(remoteReads(h) + localReads(h), reads + 3, `${label}_MEASURED_ANYWAY`);
  assert.equal(finalRows(h).length, measured, `${label}_STAYS_INERT`);
  assert.equal(h.journal().length, rows, `${label}_STAYS_INERT`);
  assert.equal(writes(h), written, `${label}_STAYS_INERT`);
  assert.deepEqual(lineage(h), retained(h), `${label}_MOVES_NOTHING`);
  assert.equal(mutations(h), moved, `${label}_NO_MUTATION_ISSUED`);
  assert.equal(receipts(h).length, closed, 'B9_POST_COMPLETION_NO_NEW_RECEIPT');
  return third;
}

// (c.i) THIS RUN'S OWN PUBLISHED HEAD, BACK ON THE REMOTE AFTER THE RECEIPT.
// It names itself separately from a foreign write because it means something
// different - the restoration this receipt claims is no longer true - and it is
// equally never repaired here: re-running a completed mutation is exactly the
// widening this round may not do.
export async function postCompletionUnrestoredCheck(create, h) {
  const label = 'B9_POST_COMPLETION_UNRESTORED';
  await armedThenCompletedTeardown(create, h);
  const moved = mutations(h);
  h.refs.remote = published(h);
  const third = await create(h.id, h.boundary).execute('resume');
  assert.equal(third.ok, false, `${label}: ${JSON.stringify(third)}`);
  assert.equal(third.code, 'ACT_TEARDOWN_BRANCH_UNRESTORED', `${label}_HALTS_BY_NAME`);
  assert.equal(finalRows(h).at(-1).remote, published(h), `${label}_RECORDS_WHAT_IT_FOUND`);
  assert.equal(h.refs.remote, published(h), `${label}_NOT_OVERWRITTEN`);
  assert.equal(mutations(h), moved, `${label}_NO_MUTATION_ISSUED`);
  assert.equal(h.journal().filter(e => e.event === 'TEARDOWN_COMPLETE').length, 1, 'B9_POST_COMPLETION_NO_NEW_RECEIPT');
  return third;
}

// (c) THE MEASUREMENT ITSELF FAILING. On this path the observation is the ONLY
// reader of those refs, so an unanswered read must never become a pass: it is a
// halt that carries its cause.
export async function postCompletionReadFailureCheck(create, h) {
  const label = 'B9_POST_COMPLETION_READ_FAILURE';
  await armedThenCompletedTeardown(create, h);
  const before = { ...lineage(h) }, moved = mutations(h);
  const inner = h.boundary.run;
  let reads = 0;
  h.boundary.run = (exe, argv, options) => {
    if (argv.includes('ls-remote') && argv.some(a => a === `refs/heads/${h.spec.pkg.reseed.branch}`)) { reads++; return { status: 1, stdout: '' }; }
    return inner(exe, argv, options);
  };
  const third = await create(h.id, h.boundary).execute('resume');
  h.boundary.run = inner;
  assert.ok(reads > 0, `${label}_READ_ATTEMPTED`);
  assert.equal(third.ok, false, `${label}_NEVER_A_SILENT_PASS: ${JSON.stringify(third)}`);
  assert.equal(third.physical_teardown_observed, undefined, `${label}_NEVER_A_SILENT_PASS`);
  assert.equal(third.code, 'ACT_TEARDOWN_DRIFT', `${label}_HALTS`);
  assert.equal(third.observation_error, 'ACT_COMMAND_FAILED', `${label}_CARRIES_ITS_CAUSE`);
  assert.equal(typeof third.command_failure, 'object', `${label}_CARRIES_ITS_CAUSE`);
  assert.notEqual(third.command_failure, null, `${label}_CARRIES_ITS_CAUSE`);
  assert.deepEqual(lineage(h), before, `${label}_MOVES_NOTHING`);
  assert.equal(mutations(h), moved, `${label}_NO_MUTATION_ISSUED`);
  return third;
}

// (d) THE `expiry-timer` WINDOW. The write lands AFTER the observation step has
// read the refs and BEFORE the receipt is written. The retirement step's
// re-observation is the last reading there is, and it catches it.
//
// The third party is modelled at the boundary: the first host command issued
// after the observation's own BRANCH_FINAL_MEASURED row is durable advances the
// remote. That is precisely the interval the retirement step covers.
export async function expiryTimerWindowCheck(create, h) {
  const label = 'B9_EXPIRY_TIMER_WINDOW';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', `${label}_SETUP`);
  const inner = h.boundary.run;
  let flipped = false;
  h.boundary.run = (exe, argv, options) => {
    if (!flipped && finalRows(h).length > 0) { flipped = true; h.refs.remote = FOREIGN; }
    return inner(exe, argv, options);
  };
  const result = await create(h.id, h.boundary).execute('revoke');
  h.boundary.run = inner;
  assert.equal(flipped, true, `${label}_THIRD_PARTY_LANDED_IN_THE_WINDOW`);
  // The observation step passed: it read the refs before the write landed, and
  // its row says so. That is what makes this the retirement step's job.
  assert.deepEqual(found(finalRows(h).at(0)), retained(h), `${label}_OBSERVATION_SAW_THE_OLD_VALUE`);
  assert.equal(result.ok, false, `${label}_NOT_A_CLEAN_RECEIPT: ${JSON.stringify(result)}`);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, `${label}_NOT_A_CLEAN_RECEIPT`);
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', `${label}_NOT_A_CLEAN_RECEIPT`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_TIMER'), `${label}_NAMES_THE_STEP`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_BRANCH_MOVED'), `${label}_HALTS_BY_NAME`);
  // Re-measured by the retirement step itself, not merely inherited.
  assert.ok(finalRows(h).length > 1, `${label}_RE_MEASURED`);
  assert.equal(finalRows(h).at(-1).remote, FOREIGN, `${label}_RECORDS_WHAT_IT_FOUND`);
  assert.equal(h.refs.remote, FOREIGN, `${label}_THIRD_VALUE_UNTOUCHED`);
  return result;
}

// THE EXCLUSION, PINNED. A LIVE SUCCESSOR owns the shared gates and owns this
// lane's refs; it may legitimately be holding its own published head on them.
// This answer declares `physical_teardown_observed: false` and makes no
// physical claim at all, so it takes no reading - measuring here would refuse a
// successor's ordinary arming. Asserted so that no later edit makes this path
// claim more without measuring more.
export async function successorScopeStillUnmeasuredCheck(create, h) {
  const label = 'B9_SUCCESSOR_SCOPE';
  await armedThenCompletedTeardown(create, h);
  const measured = finalRows(h).length, reads = remoteReads(h) + localReads(h);
  h.write('/srv/shu/state/shu71-evidence/active.json', JSON.stringify({ activation_id: 'shu71-successor-0001' }), 0o600);
  h.refs.remote = FOREIGN;
  const third = await create(h.id, h.boundary).execute('resume');
  assert.equal(third.ok, true, `${label}: ${JSON.stringify(third)}`);
  assert.equal(third.receipt_scope, 'retired_episode', `${label}_CLAIMS_NOTHING_PHYSICAL`);
  assert.equal(third.physical_teardown_observed, false, `${label}_CLAIMS_NOTHING_PHYSICAL`);
  assert.equal(finalRows(h).length, measured, `${label}_TAKES_NO_READING`);
  assert.equal(remoteReads(h) + localReads(h), reads, `${label}_TAKES_NO_READING`);
  assert.equal(h.refs.remote, FOREIGN, `${label}_TOUCHES_NOTHING`);
  return third;
}

// THE GATE IS UNCHANGED AND STILL LOAD-BEARING ON THIS PATH TOO. A window that
// refused before `local-reseed` published nothing, so every later wake of that
// retired episode contacts no remote and reads no credential - which is what
// keeps this measurement off the periodic wake of episodes that never armed.
export async function retiredNeverPublishedCheck(create, h) {
  const label = 'B9_NEVER_PUBLISHED';
  const inner = h.boundary.fetch;
  h.boundary.fetch = async (url, options) =>
    url.includes('/git/ref/heads/coordinator%2FSHU-140') ? { ok: false, status: 500, text: async () => '{}' } : inner(url, options);
  const first = await create(h.id, h.boundary).execute('run');
  h.boundary.fetch = inner;
  assert.equal(first.state, 'HALT', `${label}_SETUP`);
  assert.equal(first.teardown.ok, true, `${label}_SETUP: ${JSON.stringify(first.teardown)}`);
  assert.equal(h.journal().some(e => e.event === 'INTENT' && e.step === 'local-reseed'), false, `${label}_SETUP`);
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', `${label}_SETUP_COMPLETION_ROW`);
  const reads = remoteReads(h) + localReads(h);
  const second = await create(h.id, h.boundary).execute('resume');
  assert.equal(second.ok, true, `${label}_STILL_CLEAN: ${JSON.stringify(second)}`);
  assert.equal(second.physical_teardown_observed, true, `${label}_STILL_CLEAN`);
  assert.deepEqual(finalRows(h), [], `${label}_NO_FINAL_MEASUREMENT`);
  assert.equal(remoteReads(h) + localReads(h), reads, `${label}_CONTACTS_NO_REMOTE`);
  assert.deepEqual(lineage(h), retained(h), `${label}_MOVES_NOTHING`);
  return second;
}

export const controls = [
  ['a third-party advance after a COMPLETED teardown halts by name and is left untouched', postCompletionMovementCheck],
  ['an unchanged ref after a completed teardown is measured again and still answers clean', postCompletionUnchangedCheck],
  ['this run\'s published head back on the remote after the receipt is never answered over', postCompletionUnrestoredCheck],
  ['a post-completion measurement that cannot be taken halts carrying its cause', postCompletionReadFailureCheck],
  ['a write landing between the observation and the receipt is caught by the retirement step', expiryTimerWindowCheck],
  ['a live successor\'s scope claims nothing physical and therefore reads nothing', successorScopeStillUnmeasuredCheck],
  ['a retired episode that never published contacts no remote on any later wake', retiredNeverPublishedCheck],
];
export const movedRefs = ['remote', 'local', 'tracking'];

// ---------------------------------------------------------------- mutations

const POST = '        try { observeTeardown(); observeRetiredExpiry(); observePublishedRefs(spec, journal, true); }';
const RECORD = "    if (!(settled && Object.entries(measured).every(agrees))) journal.append({ event: 'BRANCH_FINAL_MEASURED', branch, ...measured });";
const TIMER = `        observeTeardown();
        observePublishedRefs(spec, journal);
        retireExpiryTimer(journal);`;
const CATCH = "          const code = RETIRED_OBSERVATION_NAMES.includes(error?.code) ? error.code : 'ACT_TEARDOWN_DRIFT';";
const localMoved = (create, h) => postCompletionMovementCheck(create, h, 'local');

export const mutations2 = [
  // The measurement removed from the post-completion path - the pre-fix
  // behaviour, exactly as it was measured and disclosed.
  ['the post-completion measurement is removed entirely',
    [[POST, '        try { observeTeardown(); observeRetiredExpiry(); }']], postCompletionMovementCheck],
  // The same removal, seen from the control that pins the OTHER direction:
  // a clean re-invocation must still have taken the three reads.
  ['the post-completion measurement is removed and the clean answer stops reading',
    [[POST, '        try { observeTeardown(); observeRetiredExpiry(); }']], postCompletionUnchangedCheck],
  // The retirement step's re-observation back to units-only.
  ['the expiry-timer re-observation skips the refs',
    [[TIMER, '        observeTeardown();\n        retireExpiryTimer(journal);']], expiryTimerWindowCheck],
  // Measured, disagreed with, and answered clean anyway.
  ['a measured disagreement is answered ok:true',
    [[POST, '        try { observeTeardown(); observeRetiredExpiry(); try { observePublishedRefs(spec, journal, true); } catch (e) { if (!/BRANCH/.test(e?.code ?? \'\')) throw e; } }']],
    postCompletionMovementCheck],
  // The name flattened back into "drift": measured, refused, and the operator
  // never learns which value stopped it.
  ['the named branch refusal is flattened into drift',
    [[CATCH, "          const code = 'ACT_TEARDOWN_DRIFT';"]], postCompletionMovementCheck],
  // Refused, and the reading the refusal rests on never made durable.
  ['the refused reading is never recorded',
    [[RECORD, '    if (!settled) journal.append({ event: \'BRANCH_FINAL_MEASURED\', branch, ...measured });']],
    postCompletionMovementCheck],
  // The reading recorded on every wake, settled or not: a repeat invocation of
  // an episode that AGREES with its own receipt is no longer inert.
  ['the reading is recorded even when it agrees',
    [[RECORD, "    journal.append({ event: 'BRANCH_FINAL_MEASURED', branch, ...measured });"]],
    postCompletionUnchangedCheck],
  // The third party's value put back by this path - the widening the round
  // forbids, in its two shapes: a lease pinned to whatever the ref holds, and
  // an unconditional clobber of the local head. The refusal still happens and
  // is still named; the kill has to come from the REF, not from the answer.
  ['the third remote value is overwritten by a force push before the named refusal',
    [[POST, "        try { observeTeardown(); observeRetiredExpiry(); try { observePublishedRefs(spec, journal, true); }\n"
      + "          catch (e) { const r = spec.pkg.reseed;\n"
      + "            git(spec, ['push', '--porcelain', '--force', REMOTE, `${r.expected_parent}:refs/heads/${r.branch}`], { remote: true }); throw e; } }"]],
    postCompletionMovementCheck],
  ['a third local head is overwritten by an unconditional update-ref before the named refusal',
    [[POST, "        try { observeTeardown(); observeRetiredExpiry(); try { observePublishedRefs(spec, journal, true); }\n"
      + "          catch (e) { const r = spec.pkg.reseed; git(spec, ['update-ref', `refs/heads/${r.branch}`, r.expected_parent]); throw e; } }"]],
    localMoved],
  // A read that never answered turned into a pass.
  ['a post-completion read failure is swallowed',
    [[POST, '        try { observeTeardown(); observeRetiredExpiry(); try { observePublishedRefs(spec, journal, true); } catch { /* mutant */ } }']],
    postCompletionReadFailureCheck],
];

// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
export async function loadMutant(t, edits, from = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-post-completion-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let mutated = from;
  for (const [before, after] of edits) {
    assert.equal(mutated.split(before).length, 2, 'B9_MUTATION_ANCHOR_UNIQUE');
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
    killed = error; return error.code === 'ERR_ASSERTION' && /B9_/.test(error.message);
  }, 'B9_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B9_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}
