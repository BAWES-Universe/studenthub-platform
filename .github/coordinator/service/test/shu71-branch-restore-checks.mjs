// SHU-279. TEARDOWN = RESTORE, INCLUDING THE ONE THING THE RUN CHANGES OUTSIDE
// ITSELF. An approved window armed on the target host through `sign`,
// `expiry-watch`, `local-reseed` and `remote-push`; the push LANDED
// (`refs/heads/coordinator/SHU-140` carried the reseed commit whose parent is
// the retained parent) and the run then halted on a later read. Its teardown
// completed with `ok:true`, `TEARDOWN_COMPLETE`, `failures:[]`: it restored the
// fixture cards, stopped the units and retained the evidence, and it did NOT
// restore the branch it had published. The next mint refused `MINT_LINEAGE` -
// correctly - and the owner declined the approval block, because a hand repair
// is not reviewed code.
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
const ARCHIVE = h => `/srv/shu/state/shu71-evidence/${h.id}/activation.json`;
const MANIFEST = h => `/srv/shu/state/shu71-evidence/${h.id}/manifest.json`;

// THE EXACT THREE TERMS THE NEXT MINT READS. mint-shu71-package.mjs
// `repositoryFacts` requires, for the SHU-140 lane, that the remote ref, the
// checkout's branch and the checkout's remote-tracking ref all equal the
// RETAINED PARENT, and refuses MINT_LINEAGE otherwise. The controls below
// assert that observable end state on the modelled host rather than asserting
// that some internal call was made - which is the difference between proving
// the promise and proving the implementation.
const lineage = h => ({ remote: h.refs.remote, local: h.refs.local, tracking: h.refs.tracking });
const retained = h => { const at = h.spec.pkg.reseed.expected_parent; return { remote: at, local: at, tracking: at }; };
const published = h => h.spec.pkg.reseed.expected_seed_head;
const measurements = h => h.journal().filter(e => e.event === 'BRANCH_RESTORE_MEASURED');
const pushes = h => h.events.filter(e => e.startsWith('command:') && e.includes(' push '));
const laneReads = h => h.events.filter(e => e.startsWith('command:') && e.includes(' ls-remote ') && e.includes('SHU-140'));

// Counts every command the boundary runs and lets a control act at one of them.
function watchCommands(h, at = () => {}) {
  const inner = h.boundary.run;
  h.boundary.run = (exe, argv, options) => { at(exe, argv); return inner(exe, argv, options); };
  return h;
}
// A halt AFTER the push, of exactly the shape the target host produced: the
// reseed is published, the step reaches its durable DONE row, and the next
// READ the window makes never answers. Only the forward path's reads are
// failed - the teardown's own fixture reads answer normally - so what the
// control measures is the teardown, not the injected failure.
function haltAfterPush(h) {
  const inner = h.boundary.fetch;
  let failing = 0;
  h.boundary.fetch = async (url, options) => {
    if (url === 'https://api.linear.app/graphql' && h.refs.remote === published(h) && failing < 5) {
      failing++;
      return { ok: false, status: 503, text: async () => '{}' };
    }
    return inner(url, options);
  };
  return h;
}

// ---------------------------------------------------------------- controls

// THE DEFECT ITSELF. The window publishes the reseed and halts after it; the
// teardown must put the remote and the local branch back at the retained
// parent, and the successor's lineage gate must be satisfiable afterwards.
export async function haltAfterPushCheck(create, h) {
  const label = 'B7_HALT_AFTER_PUSH_RESTORES';
  haltAfterPush(h);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', label);
  assert.equal(result.code, 'ACT_API_FAILED', label);
  // The push really did land before the halt: the journal carries the step's
  // durable DONE row, and the measurement the teardown took names the
  // published head on the remote and in the checkout.
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'remote-push'), 'B7_PUSH_LANDED_BEFORE_HALT');
  // The end state FIRST: this is the promise, and it is measured on the host
  // rather than inferred from any call the teardown did or did not make.
  assert.equal(h.refs.remote, h.spec.pkg.reseed.expected_parent, 'B7_REMOTE_RESTORED_TO_PARENT');
  assert.equal(h.refs.local, h.spec.pkg.reseed.expected_parent, 'B7_LOCAL_RESTORED_TO_PARENT');
  assert.deepEqual(lineage(h), retained(h), 'B7_MINT_LINEAGE_SATISFIED');
  assert.equal(result.teardown.ok, true, `${label}: ${JSON.stringify(result.teardown)}`);
  assert.deepEqual(result.teardown.failures, [], label);
  // What it found is durable, and the first thing it did was measure.
  assert.deepEqual(measurements(h).map(e => ({ remote: e.remote, local: e.local }))[0],
    { remote: published(h), local: published(h) }, 'B7_RESTORE_MEASURED_WHAT_IT_FOUND');
  // The restoration is a reviewed teardown step, with its own INTENT and its
  // own DONE row, not an operator action and not a silent side effect.
  for (const event of ['INTENT', 'DONE'])
    assert.ok(h.journal().some(e => e.event === event && e.step === 'teardown:restore-branch'), `B7_RESTORE_IS_A_TEARDOWN_STEP_${event}`);
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', label);
  return result;
}

// THE NORMAL PATH. A window that arms and is then revoked leaves exactly the
// same end state for the branch - the retained parent on the remote, in the
// checkout and in the remote-tracking ref - while everything the run
// legitimately produced is retained: the signed package, the journal, the
// archive, the manifest and the restored fixture cards.
export async function completedRunCheck(create, h) {
  const label = 'B7_COMPLETED_RUN_RESTORES';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  assert.equal(h.refs.remote, published(h), 'B7_COMPLETED_RUN_PUBLISHED');
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.state, 'REVOKED', `${label}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.failures, [], label);
  assert.deepEqual(lineage(h), retained(h), 'B7_MINT_LINEAGE_SATISFIED');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', label);
  // Nothing the run legitimately produced is corrupted or withdrawn.
  assert.equal(JSON.parse(h.read(ARCHIVE(h))).retained, true, 'B7_COMPLETED_RUN_EVIDENCE_RETAINED');
  assert.equal(JSON.parse(h.read(MANIFEST(h))).activation_id, h.id, 'B7_COMPLETED_RUN_EVIDENCE_RETAINED');
  assert.ok(h.exists(`/srv/shu/state/shu71-evidence/${h.id}/signed-package.json`), 'B7_COMPLETED_RUN_EVIDENCE_RETAINED');
  for (const t of h.spec.pkg.issue_transitions)
    assert.deepEqual(h.states.get(t.issue_id), t.restore, 'B7_COMPLETED_RUN_FIXTURES_RESTORED');
  assert.equal(pushes(h).length, 2, 'B7_COMPLETED_RUN_ONE_ARMING_ONE_RESTORING_PUSH');
  return result;
}

// A FETCHED REMOTE-TRACKING REF IS PART OF THE LINEAGE. `git push <url>` does
// not move `refs/remotes/origin/<branch>`, so this state is reached when
// anything on the box fetched between the push and the teardown - and the mint
// reads that ref as one of its three terms, so a box left with it at the
// published head is not restored.
export async function trackingRefreshedCheck(create, h) {
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'B7_TRACKING_SETUP');
  h.refs.tracking = published(h);
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(h.refs.tracking, h.spec.pkg.reseed.expected_parent, 'B7_TRACKING_RESTORED_TO_PARENT');
  assert.deepEqual(lineage(h), retained(h), 'B7_MINT_LINEAGE_SATISFIED');
  assert.equal(result.state, 'REVOKED', `B7_TRACKING_TEARDOWN: ${JSON.stringify(result)}`);
  assert.deepEqual(measurements(h).map(e => e.tracking), [published(h)], 'B7_TRACKING_MEASURED');
}

// IDEMPOTENCE. A teardown that runs twice is a clean no-op the second time: it
// does not fail, it moves nothing, it issues no second restoring push, and it
// does not claim a restore it did not make.
export async function teardownTwiceCheck(create, h) {
  await completedRunCheck(create, h);
  const before = { ...lineage(h) }, pushed = pushes(h).length;
  const again = await create(h.id, h.boundary).execute('revoke');
  assert.equal(again.state, 'REVOKED', `B7_SECOND_TEARDOWN_CLEAN: ${JSON.stringify(again)}`);
  assert.equal(again.ok, true, 'B7_SECOND_TEARDOWN_CLEAN');
  assert.deepEqual(lineage(h), before, 'B7_SECOND_TEARDOWN_MOVES_NOTHING');
  assert.equal(pushes(h).length, pushed, 'B7_SECOND_TEARDOWN_NO_SECOND_PUSH');
  assert.equal(measurements(h).length, 1, 'B7_SECOND_TEARDOWN_CLAIMS_NOTHING');
}

// NEVER PUBLISHED AT ALL. A window that refuses before `local-reseed` has
// changed nothing outside itself, so the teardown measures nothing, contacts
// no remote, reads no credential and claims no restore - and still completes.
export async function neverPushedCheck(create, h) {
  const label = 'B7_NEVER_PUSHED_CLEAN_NOOP';
  const inner = h.boundary.fetch;
  h.boundary.fetch = async (url, options) =>
    url.includes('/git/ref/heads/coordinator%2FSHU-140') ? { ok: false, status: 500, text: async () => '{}' } : inner(url, options);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', label);
  assert.equal(h.journal().some(e => e.event === 'INTENT' && e.step === 'local-reseed'), false, label);
  assert.equal(result.teardown.ok, true, `${label}: ${JSON.stringify(result.teardown)}`);
  assert.deepEqual(result.teardown.failures, [], label);
  assert.deepEqual(measurements(h), [], 'B7_NEVER_PUSHED_NO_MEASUREMENT');
  assert.deepEqual(lineage(h), retained(h), 'B7_NEVER_PUSHED_MOVES_NOTHING');
  assert.equal(pushes(h).length, 0, 'B7_NEVER_PUSHED_NO_PUSH');
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:restore-branch'), label);
}

// PUBLISHED LOCALLY BUT NEVER PUSHED. `local-reseed` created the commit and
// moved the checkout's branch; the push never happened. The local ref is
// restored, the remote is measured at the retained parent and is never
// written, and the evidence says exactly that.
export async function localOnlyCheck(create, h) {
  const label = 'B7_LOCAL_ONLY_RESTORED';
  watchCommands(h, (exe, argv) => { if (argv.includes('push')) throw new Error('PUSH_REFUSED_BY_CONTROL'); });
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', label);
  assert.equal(h.journal().some(e => e.event === 'INTENT' && e.step === 'local-reseed'), true, label);
  assert.deepEqual(measurements(h).map(e => ({ remote: e.remote, local: e.local })),
    [{ remote: h.spec.pkg.reseed.expected_parent, local: published(h) }], 'B7_LOCAL_ONLY_MEASURED');
  assert.equal(result.teardown.ok, true, `${label}: ${JSON.stringify(result.teardown)}`);
  assert.deepEqual(lineage(h), retained(h), 'B7_MINT_LINEAGE_SATISFIED');
}

// FOREIGN MOVEMENT. The ref holds a THIRD value - neither this run's published
// head nor the retained parent. The teardown refuses by name, carries the
// cause, never overwrites the value it found, and records what it found.
export async function foreignMovementCheck(create, h, which = 'remote') {
  const label = `B7_FOREIGN_${which.toUpperCase()}`;
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  const pushed = pushes(h).length;
  h.refs[which] = FOREIGN;
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(h.refs[which], FOREIGN, 'B7_FOREIGN_NOT_OVERWRITTEN');
  assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', label);
  assert.deepEqual(result.failures, ['ACT_TEARDOWN_RESTORE_BRANCH', 'ACT_TEARDOWN_BRANCH_FOREIGN',
    'ACT_TEARDOWN_EXPIRY_TIMER', 'ACT_CLEANUP_FAILED'], 'B7_FOREIGN_REFUSED_BY_NAME');
  assert.ok(measurements(h).every(e => e[which] === FOREIGN), 'B7_FOREIGN_VALUE_RECORDED');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', 'B7_FOREIGN_NOT_A_CLEAN_RECEIPT');
  assert.equal(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:restore-branch'), false, 'B7_FOREIGN_NO_DONE_ROW');
  if (which === 'remote') assert.equal(pushes(h).length, pushed, 'B7_FOREIGN_NO_PUSH_ISSUED');
}

// THE LEASE IS LOAD-BEARING, not decoration. The ref holds this run's
// published head when it is measured and is moved by someone else in the
// instant before the push. git's own compare-and-set refuses; the foreign
// value survives and the teardown fails by name rather than clobbering it.
export async function leaseRaceCheck(create, h) {
  const label = 'B7_LEASE_RACE';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  watchCommands(h, (exe, argv) => { if (argv.includes('push')) h.refs.remote = FOREIGN; });
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(h.refs.remote, FOREIGN, 'B7_FOREIGN_NOT_OVERWRITTEN');
  assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_RESTORE_BRANCH'), 'B7_LEASE_RACE_NAMED');
  assert.ok(result.failures.includes('ACT_COMMAND_FAILED'), 'B7_LEASE_RACE_CARRIES_CAUSE');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', 'B7_LEASE_RACE_NOT_A_CLEAN_RECEIPT');
}

// FAILURE VISIBILITY, and the once-only rule. A restoring push that cannot
// complete produces a TEARDOWN FAILURE carrying its own cause - never
// `TEARDOWN_COMPLETE, failures: []` - and the mutation is attempted exactly
// once in the invocation, including the independent safety re-attempt the
// teardown makes for every failed step.
export async function restoreFailureVisibleCheck(create, h) {
  const label = 'B7_RESTORE_FAILURE_VISIBLE';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  const inner = h.boundary.run;
  let attempts = 0;
  h.boundary.run = (exe, argv, options) => {
    if (!argv.includes('push') || h.refs.remote !== published(h)) return inner(exe, argv, options);
    attempts++; return { status: 1, stdout: '' };
  };
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.ok, false, `B7_FAILED_RESTORE_IS_NOT_A_COMPLETION: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_CLEANUP_FAILED', 'B7_FAILED_RESTORE_IS_NOT_A_COMPLETION');
  assert.ok(result.failures.includes('ACT_TEARDOWN_RESTORE_BRANCH'), 'B7_FAILURE_NAMES_THE_STEP');
  assert.ok(result.failures.includes('ACT_COMMAND_FAILED'), 'B7_FAILURE_CARRIES_ITS_CAUSE');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', 'B7_FAILURE_NOT_A_CLEAN_RECEIPT');
  assert.deepEqual(h.journal().at(-1).failures, result.failures, 'B7_FAILURE_DURABLE');
  assert.equal(attempts, 1, 'B7_PUSH_ATTEMPTED_ONCE');
  assert.equal(h.refs.remote, published(h), 'B7_FAILED_RESTORE_CHANGES_NOTHING');
  // A refused restore stays refused; it is never converted into a completion.
  assert.equal(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:restore-branch'), false, 'B7_FAILED_RESTORE_HAS_NO_DONE_ROW');
  // And the next invocation, with the fault removed, completes it.
  h.boundary.run = inner;
  const repaired = await create(h.id, h.boundary).execute('resume');
  assert.equal(repaired.state, 'REVOKED', `B7_RESTORE_RETRIED_NEXT_INVOCATION: ${JSON.stringify(repaired)}`);
  assert.deepEqual(lineage(h), retained(h), 'B7_MINT_LINEAGE_SATISFIED');
}

// A LANDED PUSH THAT REPORTED FAILURE is recovered by a RE-READ, never by
// pushing again: the connection drops after the pack is accepted, the remote
// is already at the retained parent, and the step completes on that measured
// value with exactly one push issued.
export async function landedButReportedFailureCheck(create, h) {
  const label = 'B7_LANDED_PUSH_REREAD';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  const inner = h.boundary.run;
  let attempts = 0;
  h.boundary.run = (exe, argv, options) => {
    if (!argv.includes('push')) return inner(exe, argv, options);
    // The pack is accepted - the ref really does move - and the command then
    // reports failure, exactly as a connection reset after the push lands.
    attempts++;
    const answer = inner(exe, argv, options);
    return attempts === 1 ? { status: 1, stdout: '' } : answer;
  };
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(attempts, 1, 'B7_PUSH_ATTEMPTED_ONCE');
  assert.equal(result.state, 'REVOKED', `${label}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.failures, [], label);
  assert.deepEqual(lineage(h), retained(h), 'B7_MINT_LINEAGE_SATISFIED');
}

// THE LOCAL COMPARE-AND-SET IS LOAD-BEARING TOO. The checkout's branch holds
// this run's published head when it is measured and is moved by someone else
// in the instant before the update; git's ref lock refuses, the foreign value
// survives and the teardown fails by name.
export async function localRaceCheck(create, h) {
  const label = 'B7_LOCAL_RACE';
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  watchCommands(h, (exe, argv) => { if (argv.includes('update-ref')) h.refs.local = FOREIGN; });
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(h.refs.local, FOREIGN, 'B7_FOREIGN_NOT_OVERWRITTEN');
  assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_RESTORE_BRANCH'), 'B7_LOCAL_RACE_NAMED');
  assert.ok(result.failures.includes('ACT_COMMAND_FAILED'), 'B7_LOCAL_RACE_CARRIES_CAUSE');
}

export const controls = [
  ['a halt after the remote push restores the branch it published', haltAfterPushCheck],
  ['a completed run restores the branch on the ordinary revoke path', completedRunCheck],
  ['a fetched remote-tracking ref is restored too', trackingRefreshedCheck],
  ['a teardown that runs twice is a clean no-op', teardownTwiceCheck],
  ['a window that never reached the reseed measures and claims nothing', neverPushedCheck],
  ['a local reseed that was never pushed restores the local ref only', localOnlyCheck],
  ['a landed push that reported failure is re-read, never pushed again', landedButReportedFailureCheck],
  ['a restoration that cannot complete is a named teardown failure', restoreFailureVisibleCheck],
  ['a remote moved between the measurement and the push is never clobbered', leaseRaceCheck],
  ['a local branch moved between the measurement and the update is never clobbered', localRaceCheck],
];
export const foreignRefs = ['remote', 'local', 'tracking'];

// ---------------------------------------------------------------- mutations

const GATE = "    if (!(journal.recovered || journalHas(journal, 'INTENT', 'local-reseed'))) return;";
const FOREIGN_GUARD = "      need(value === published, 'ACT_TEARDOWN_BRANCH_FOREIGN');";
const REATTEMPT_GUARD = "      need(!branchRestoresIssued.has(kind), 'ACT_TEARDOWN_BRANCH_REATTEMPT');";
const PUSH = "      try { git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${published}`, REMOTE, `${parent}:${ref}`], { remote: true }); }";
const LOCAL = "      git(spec, ['update-ref', ref, parent, published]);";
const TRACKING = "      git(spec, ['update-ref', tracking, parent, published]);";
const EFFECT = "      ['restore-branch', () => restorePublishedRefs(spec, journal)],";

export const mutations = [
  // The restoration removed outright - the merged pre-fix behaviour.
  ['the restoration is removed entirely', [[EFFECT, "      ['restore-branch', () => {}],"]], haltAfterPushCheck],
  ['the restoration returns before measuring anything', [[GATE, '    if (true) return;']], haltAfterPushCheck],
  // The restoration weakened: one ref at a time.
  ['the remote is never restored', [[PUSH, '      try { }']], haltAfterPushCheck],
  ['the local branch is never restored', [[LOCAL, '      void 0;']], haltAfterPushCheck],
  ['the remote-tracking ref is never restored', [[TRACKING, '      void 0;']], trackingRefreshedCheck],
  // The current-head check dropped, and the refusal turned into a restore.
  ['the current-head check is dropped', [[FOREIGN_GUARD, '      void published;']],
    (create, h) => foreignMovementCheck(create, h, 'remote')],
  ['a descendant is accepted as licence to restore',
    [[FOREIGN_GUARD, "      need(value !== parent, 'ACT_TEARDOWN_BRANCH_FOREIGN');"]],
    (create, h) => foreignMovementCheck(create, h, 'remote')],
  // Both doors at once: the head check dropped AND the lease taken from
  // whatever the ref happens to hold, which is what "restore it anyway" is.
  ['a foreign head is restored anyway, leased to whatever it holds',
    [[FOREIGN_GUARD, '      void published;'],
      [PUSH, "      try { git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${measured.remote}`, REMOTE, `${parent}:${ref}`], { remote: true }); }"]],
    (create, h) => foreignMovementCheck(create, h, 'remote')],
  ['a foreign local head is restored anyway',
    [[FOREIGN_GUARD, '      void published;'], [LOCAL, "      git(spec, ['update-ref', ref, parent, measured.local]);"]],
    (create, h) => foreignMovementCheck(create, h, 'local')],
  ['the local update drops its expected old value', [[LOCAL, "      git(spec, ['update-ref', ref, parent]);"]], localRaceCheck],
  // The lease removed: an unleased force clobbers whatever the ref holds.
  ['the remote update uses an unleased force',
    [[PUSH, "      try { git(spec, ['push', '--porcelain', '--force', REMOTE, `${parent}:${ref}`], { remote: true }); }"]], leaseRaceCheck],
  // The failure made invisible, and the mutation made repeatable.
  ['a failed restoration is swallowed',
    [[EFFECT, "      ['restore-branch', () => { try { restorePublishedRefs(spec, journal); } catch { /* mutant */ } }],"]],
    restoreFailureVisibleCheck],
  ['the once-only rule is dropped and the mutation is re-attempted', [[REATTEMPT_GUARD, '      void kind;']], restoreFailureVisibleCheck],
  // The re-read recovery widened into a second push.
  ['a push that reported failure is pushed again',
    [[PUSH + '\n      catch (error) {',
      PUSH + "\n      catch (error) { git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${published}`, REMOTE, `${parent}:${ref}`], { remote: true });"]],
    landedButReportedFailureCheck],
  // The gate widened: a window that never published still measures and claims.
  ['the intent gate is removed and a never-published window is measured', [[GATE, '    if (false) return;']], neverPushedCheck],
];

// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
export async function loadMutant(t, edits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-branch-restore-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let mutated = source;
  for (const [before, after] of edits) {
    assert.equal(mutated.split(before).length, 2, 'B7_MUTATION_ANCHOR_UNIQUE');
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
    killed = error; return error.code === 'ERR_ASSERTION' && /B7_/.test(error.message);
  }, 'B7_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B7_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}
