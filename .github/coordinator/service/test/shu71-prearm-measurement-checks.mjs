// SHU-280, round fourteen. A TEARDOWN MAY NOT ANSWER CLEAN OVER A REF IT NEVER
// READ - INCLUDING THE TEARDOWN A PRE-ARM HALT RETURNS.
//
// Rounds twelve and thirteen gave the teardown's final observation, the
// `expiry-timer` re-observation and the post-completion path an unconditional
// reading of the three refs the next mint reads. All three kept the
// RESTORATION's gate: `if (!(journal.recovered || journalHas(journal, 'INTENT',
// 'local-reseed'))) return;`. That gate asks a question about THIS EPISODE'S
// HISTORY - did this run publish? - and the receipt makes a claim about the
// HOST. The independent verifier recorded the consequence as a documented
// boundary; the owner had already ruled the class blocking, twice:
//
//   "A completion row may avoid repeating an effect, but it may not avoid
//    final measurement of externally mutable state... the result must HALT by
//    name and leave the third-party value untouched. It must not emit a clean
//    teardown receipt."
//
// Measured on the modelled host at `0027b23e`: a window that halts BEFORE
// `local-reseed` - a `binding` read-back that never answers - returns
// `{"ok":false,"state":"HALT","code":"ACT_API_FAILED",...,"teardown":
// {"ok":true,"state":"REVOKED","code":null,"failures":[]}}` while
// `refs/heads/coordinator/SHU-140` stands at `ffffffff…`. Nothing on that path
// asked.
//
// The gate is therefore removed from `observePublishedRefs` and kept, byte for
// byte, on `restorePublishedRefs`. The EFFECT still never runs on a pre-arm
// path - no push, no `update-ref`, no repeated effect of any kind - and the
// MEASUREMENT always does. What the gate also bought, one spared `ls-remote`
// and one spared credential read, is given up deliberately: a read the receipt
// depends on is not an optional read.
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
import { coordinatorText } from './shu71-supervisor-environment-fixture.mjs';
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
const restoreRows = h => h.journal().filter(e => e.event === 'BRANCH_RESTORE_MEASURED');
const finalRows = h => h.journal().filter(e => e.event === 'BRANCH_FINAL_MEASURED');
const found = row => ({ remote: row.remote, local: row.local, tracking: row.tracking });
const pushes = h => h.events.filter(e => e.startsWith('command:') && e.includes(' push '));
const updates = h => h.events.filter(e => e.startsWith('command:') && e.includes(' update-ref '));
const mutations = h => [...pushes(h), ...updates(h)].length;

// THE PRE-ARM HALT, of exactly the shape the boundary produces: the GitHub
// read-back of the lane's ref never answers, so `binding` - the FIRST reviewed
// step, before `sign`, before `expiry-watch`, before `local-reseed` - refuses,
// and the covering handler returns a HALT carrying an EMBEDDED teardown. The
// fault is installed on the forward path only; the teardown's own reads answer
// normally, so what each control measures is the teardown.
function haltBeforeReseed(h) {
  const inner = h.boundary.fetch;
  h.boundary.fetch = async (url, options) =>
    url.includes('/git/ref/heads/coordinator%2FSHU-140') ? { ok: false, status: 500, text: async () => '{}' } : inner(url, options);
  return h;
}
// Every control asserts this first: the episode really did stop before the step
// that creates the published commit, so there is no INTENT row for
// `local-reseed`, and the teardown it returns is the embedded one.
function assertPreArm(h, result, label) {
  assert.equal(result.state, 'HALT', `B10_PREARM_SETUP: ${label} ${JSON.stringify(result)}`);
  assert.equal(h.journal().some(e => e.event === 'INTENT' && e.step === 'local-reseed'), false,
    `B10_PREARM_SETUP_NEVER_RESEEDED: ${label}`);
  assert.equal(typeof result.teardown, 'object', `B10_PREARM_SETUP_EMBEDDED_TEARDOWN: ${label}`);
  assert.notEqual(result.teardown, null, `B10_PREARM_SETUP_EMBEDDED_TEARDOWN: ${label}`);
}

// ---------------------------------------------------------------- controls

// (a) THE CONTROL THAT PINS THE OTHER DIRECTION, and it comes first because the
// cost of measuring must not be a new refusal. Every ref is at the retained
// parent the package requires: the teardown reads all three, records what it
// found, and completes exactly as it did before - no false halt.
export async function preArmRetainedParentCheck(create, h) {
  const label = 'B10_PREARM_CLEAN';
  haltBeforeReseed(h);
  const result = await create(h.id, h.boundary).execute('run');
  assertPreArm(h, result, label);
  // Measured, and the reading is durable BEFORE the receipt rests on it.
  assert.ok(finalRows(h).length > 0, 'B10_PREARM_MEASURED');
  assert.deepEqual(found(finalRows(h).at(-1)), retained(h), 'B10_PREARM_RECORDS_WHAT_IT_FOUND');
  // And it still completes: the measurement is a cost, not a refusal.
  assert.equal(result.teardown.ok, true, `B10_PREARM_NO_FALSE_HALT: ${JSON.stringify(result.teardown)}`);
  assert.equal(result.teardown.state, 'REVOKED', 'B10_PREARM_NO_FALSE_HALT');
  assert.deepEqual(result.teardown.failures, [], 'B10_PREARM_NO_FALSE_HALT');
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_COMPLETE', 'B10_PREARM_NO_FALSE_HALT');
  // WHAT THE GATE WAS PROTECTING, PRESERVED. The EFFECT keeps its own gate:
  // `restore-branch` measures nothing for restoration, restores nothing, and
  // this path issues no push and no `update-ref` at all.
  assert.deepEqual(restoreRows(h), [], 'B10_PREARM_RESTORES_NOTHING');
  assert.equal(mutations(h), 0, 'B10_PREARM_NO_MUTATION_ISSUED');
  assert.deepEqual(lineage(h), retained(h), 'B10_PREARM_MOVES_NOTHING');
  // The effect still ran-and-skipped as a reviewed step, exactly as before.
  assert.ok(h.journal().some(e => e.event === 'DONE' && e.step === 'teardown:restore-branch'), 'B10_PREARM_RESTORE_IS_STILL_A_STEP');
  return result;
}

// (b) THE DEFECT ITSELF, on each of the three refs in turn. A third party holds
// the lane ref at a value that is neither the retained parent nor anything this
// run published - and this run published NOTHING, which is precisely why the
// old gate skipped the reading. The teardown must HALT by name and leave the
// value exactly where it found it.
export async function preArmForeignRefCheck(create, h, which = 'remote') {
  const label = `B10_PREARM_FOREIGN_${which.toUpperCase()}`;
  haltBeforeReseed(h);
  h.refs[which] = FOREIGN;
  const before = { ...lineage(h) };
  const result = await create(h.id, h.boundary).execute('run');
  assertPreArm(h, result, label);
  // Measured FIRST: a refusal that cannot say which value stopped it is not
  // the closure the owner asked for.
  assert.ok(finalRows(h).length > 0, `B10_PREARM_FOREIGN_MEASURED: ${label}`);
  assert.deepEqual(found(finalRows(h).at(-1)), { ...retained(h), [which]: FOREIGN },
    `B10_PREARM_FOREIGN_RECORDS_WHAT_IT_FOUND: ${label}`);
  // `ok: true` here IS the clean teardown receipt the ruling forbids.
  assert.equal(result.teardown.ok, false, `B10_PREARM_FOREIGN_NOT_A_CLEAN_RECEIPT: ${label} ${JSON.stringify(result.teardown)}`);
  assert.equal(result.teardown.code, 'ACT_CLEANUP_FAILED', `B10_PREARM_FOREIGN_NOT_A_CLEAN_RECEIPT: ${label}`);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false,
    `B10_PREARM_FOREIGN_NOT_A_CLEAN_RECEIPT: ${label}`);
  assert.equal(h.journal().at(-1).event, 'TEARDOWN_INCOMPLETE', `B10_PREARM_FOREIGN_NOT_A_CLEAN_RECEIPT: ${label}`);
  // Named by the step that refused, and by the reason it refused.
  assert.ok(result.teardown.failures.includes('ACT_TEARDOWN_OBSERVATION'), `B10_PREARM_FOREIGN_NAMES_THE_STEP: ${label}`);
  assert.ok(result.teardown.failures.includes('ACT_TEARDOWN_BRANCH_MOVED'), `B10_PREARM_FOREIGN_HALTS_BY_NAME: ${label}`);
  assert.deepEqual(h.journal().at(-1).failures, result.teardown.failures, `B10_PREARM_FOREIGN_FAILURES_DURABLE: ${label}`);
  // Never overwritten, never adopted, never fast-forwarded.
  assert.equal(h.refs[which], FOREIGN, `B10_PREARM_FOREIGN_UNTOUCHED: ${label}`);
  assert.deepEqual(lineage(h), before, `B10_PREARM_FOREIGN_UNTOUCHED: ${label}`);
  assert.equal(mutations(h), 0, `B10_PREARM_FOREIGN_NO_MUTATION_ISSUED: ${label}`);
  assert.deepEqual(restoreRows(h), [], `B10_PREARM_FOREIGN_RESTORES_NOTHING: ${label}`);
  return result;
}

// (c) THE PACKAGE'S OWN PUBLISHED HEAD, STANDING ON A LANE THIS RUN NEVER
// TOUCHED. It is not the retained parent the package requires, so the mint's
// `MINT_LINEAGE` will refuse the successor; this teardown names it separately
// from a foreign write because it means something different to an operator -
// the reseed commit is on the branch and nothing here put it back.
export async function preArmPublishedHeadCheck(create, h) {
  const label = 'B10_PREARM_UNRESTORED';
  haltBeforeReseed(h);
  h.refs.remote = published(h);
  const result = await create(h.id, h.boundary).execute('run');
  assertPreArm(h, result, label);
  assert.ok(finalRows(h).length > 0, 'B10_PREARM_UNRESTORED_MEASURED');
  assert.equal(finalRows(h).at(-1).remote, published(h), 'B10_PREARM_UNRESTORED_RECORDS_WHAT_IT_FOUND');
  assert.equal(result.teardown.ok, false, `B10_PREARM_UNRESTORED_NOT_A_CLEAN_RECEIPT: ${JSON.stringify(result.teardown)}`);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B10_PREARM_UNRESTORED_NOT_A_CLEAN_RECEIPT');
  assert.ok(result.teardown.failures.includes('ACT_TEARDOWN_BRANCH_UNRESTORED'), 'B10_PREARM_UNRESTORED_HALTS_BY_NAME');
  assert.equal(h.refs.remote, published(h), 'B10_PREARM_UNRESTORED_UNTOUCHED');
  assert.equal(mutations(h), 0, 'B10_PREARM_UNRESTORED_NO_MUTATION_ISSUED');
  return result;
}

// (d) THE MEASUREMENT THAT CANNOT BE TAKEN. The credential the remote read
// needs is not there: `/srv/shu/coordinator.env` no longer carries
// `GITHUB_TOKEN`. The window halts pre-arm on the launch-environment guard, and
// the teardown CANNOT read the remote ref - so it does not answer clean over
// it. It names the step, carries `ACT_CREDENTIAL_UNAVAILABLE` as the cause in
// the returned result, and touches nothing.
export async function preArmCredentialUnavailableCheck(create, h) {
  const label = 'B10_PREARM_UNMEASURABLE';
  // The same coordinator file the fixture writes, with the one key the remote
  // read needs removed. Every other launch-environment requirement still holds.
  h.write('/srv/shu/coordinator.env', coordinatorText().split('\n').filter(line => !line.startsWith('GITHUB_TOKEN=')).join('\n'), 0o600, 999);
  const before = { ...lineage(h) };
  const result = await create(h.id, h.boundary).execute('run');
  assertPreArm(h, result, label);
  assert.equal(result.teardown.ok, false, `B10_PREARM_UNMEASURABLE_NOT_A_CLEAN_SUCCESS: ${JSON.stringify(result.teardown)}`);
  assert.equal(result.teardown.state, 'HALT', 'B10_PREARM_UNMEASURABLE_NOT_A_CLEAN_SUCCESS');
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, 'B10_PREARM_UNMEASURABLE_NOT_A_CLEAN_SUCCESS');
  assert.ok(result.teardown.failures.includes('ACT_TEARDOWN_OBSERVATION'), 'B10_PREARM_UNMEASURABLE_NAMES_THE_STEP');
  // The returned result SAYS WHY it could not measure, by name.
  assert.ok(result.teardown.failures.includes('ACT_CREDENTIAL_UNAVAILABLE'), 'B10_PREARM_UNMEASURABLE_CARRIES_ITS_CAUSE');
  assert.deepEqual(lineage(h), before, 'B10_PREARM_UNMEASURABLE_MOVES_NOTHING');
  assert.equal(mutations(h), 0, 'B10_PREARM_UNMEASURABLE_NO_MUTATION_ISSUED');
  return result;
}

// (e) THE SAME PROPERTY ON THE OTHER PRE-ARM ENTRY POINT. A `revoke` of a
// window that never ran at all takes `cleanup()` directly rather than through
// the covering handler, and it emits a receipt of its own. It measures too.
export async function neverRanRevokeCheck(create, h) {
  const label = 'B10_PREARM_REVOKE';
  h.refs.local = FOREIGN;
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(h.journal().some(e => e.event === 'INTENT' && e.step === 'local-reseed'), false, `${label}_NEVER_RESEEDED`);
  assert.equal(result.ok, false, `${label}_NOT_A_CLEAN_RECEIPT: ${JSON.stringify(result)}`);
  assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), false, `${label}_NOT_A_CLEAN_RECEIPT`);
  assert.ok(result.failures.includes('ACT_TEARDOWN_BRANCH_MOVED'), `${label}_HALTS_BY_NAME`);
  assert.equal(finalRows(h).at(-1).local, FOREIGN, `${label}_RECORDS_WHAT_IT_FOUND`);
  assert.equal(h.refs.local, FOREIGN, `${label}_UNTOUCHED`);
  assert.equal(mutations(h), 0, `${label}_NO_MUTATION_ISSUED`);
  assert.deepEqual(restoreRows(h), [], `${label}_RESTORES_NOTHING`);
  return result;
}

export const controls = [
  ['a pre-arm halt with the ref at the retained parent measures and still completes', preArmRetainedParentCheck],
  ['a pre-arm halt over a third-party value halts by name and leaves it untouched', preArmForeignRefCheck],
  ['a pre-arm halt over the package\'s published head is never closed over', preArmPublishedHeadCheck],
  ['a pre-arm teardown that cannot read the credential is not a clean success', preArmCredentialUnavailableCheck],
  ['a revoke of a window that never ran measures the refs too', neverRanRevokeCheck],
];
export const movedRefs = ['remote', 'local', 'tracking'];

// ---------------------------------------------------------------- mutations

const SIGNATURE = '  function observePublishedRefs(spec, journal, settled = false) {';
const GATE = "    if (!(journal.recovered || journalHas(journal, 'INTENT', 'local-reseed'))) return;";
const JUDGE = "      need(false, value === published ? 'ACT_TEARDOWN_BRANCH_UNRESTORED' : 'ACT_TEARDOWN_BRANCH_MOVED');";
const OBSERVATION = "    effects.push(['observation', () => { observeTeardown(); observePublishedRefs(spec, journal); }]);";
const TIMER = `        observeTeardown();
        observePublishedRefs(spec, journal);
        retireExpiryTimer(journal);`;
const localForeign = (create, h) => preArmForeignRefCheck(create, h, 'local');

export const mutations2 = [
  // The intent gate put back where it was - the pre-fix behaviour, exactly as
  // it was measured at `0027b23e`. Nothing reads, so nothing is recorded.
  ['the intent gate is reinstated over the measurement', [[SIGNATURE, `${SIGNATURE}\n${GATE}`]], preArmForeignRefCheck],
  // The same gate expressed on the pre-arm path only: the `observation` step
  // skips the reading and the retirement step is left to catch it. It does -
  // and the step that names the refusal is then the wrong one.
  ['the pre-reseed path skips the measurement in the observation step',
    [[OBSERVATION, "    effects.push(['observation', () => { observeTeardown(); "
      + "if (journal.recovered || journalHas(journal, 'INTENT', 'local-reseed')) observePublishedRefs(spec, journal); }]);"]],
    preArmForeignRefCheck],
  // Measured, recorded - and the judgement itself put back behind the episode's
  // own history, so a third value is answered `ok:true`.
  ['a third value is answered ok:true on a path that never published',
    [[JUDGE, "      if (journal.recovered || journalHas(journal, 'INTENT', 'local-reseed'))\n" + JUDGE]],
    preArmForeignRefCheck],
  // The same door, on the local ref.
  ['a third local head is answered ok:true on a path that never published',
    [[JUDGE, "      if (journal.recovered || journalHas(journal, 'INTENT', 'local-reseed'))\n" + JUDGE]],
    localForeign],
  // A read that never answered turned into a pass, on both readers.
  ['a measurement failure is swallowed on the pre-arm path',
    [[OBSERVATION, "    effects.push(['observation', () => { observeTeardown(); try { observePublishedRefs(spec, journal); } catch { /* mutant */ } }]);"],
      [TIMER, '        observeTeardown();\n        try { observePublishedRefs(spec, journal); } catch { /* mutant */ }\n        retireExpiryTimer(journal);']],
    preArmCredentialUnavailableCheck],
  // The pre-arm path given a MUTATION it may not have: the third value put back
  // by an unleased force before the named refusal. The refusal still happens;
  // the kill has to come from the REF.
  ['the pre-arm path puts a third value back before refusing',
    [[JUDGE, "      if (kind === 'remote') git(spec, ['push', '--porcelain', '--force', REMOTE, `${parent}:${ref}`], { remote: true });\n"
      + "      else git(spec, ['update-ref', kind === 'local' ? ref : tracking, parent]);\n" + JUDGE]],
    preArmForeignRefCheck],
  // The package's own published head accepted as an ending state on a path that
  // never published it.
  ['the published head is accepted on a path that never published it',
    [[JUDGE, "      need(value !== published, 'ACT_TEARDOWN_BRANCH_MOVED');"]], preArmPublishedHeadCheck],
];

// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
export async function loadMutant(t, edits, from = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-prearm-measurement-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let mutated = from;
  for (const [before, after] of edits) {
    assert.equal(mutated.split(before).length, 2, 'B10_MUTATION_ANCHOR_UNIQUE');
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
    killed = error; return error.code === 'ERR_ASSERTION' && /B10_/.test(error.message);
  }, 'B10_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B10_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}
