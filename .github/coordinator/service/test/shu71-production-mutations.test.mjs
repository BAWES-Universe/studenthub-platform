import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { preArmDriftCheck, workerKillFailureCheck, destroyedJournalCheck, expiryFileDriftCheck, expiryRetirementCheck,
  expiryDisableFailureCheck, expiryCachedViewCheck, expiryPostConditionCheck, recoveredNonCreationCheck,
  teardownOrderCheck, fixturesRequireWorkersCheck, predicateRefusalCheck, expiryCustodyDriftCheck,
  expiryPostReloadDriftCheck, expiryInterruptedRemovalCheck, expiryInterruptedCustodyDriftCheck,
  expiryDisableExitFailureCheck, expiryActivePostConditionCheck, expiryEnabledPostConditionCheck,
  expiryUninstalledDisableCheck, expiryInstalledBeforeArmedCheck, expiryJournalBlindCustodyCheck,
  expiryAbsenceAccountedCheck, expiryVanishedMechanismCheck, expiryUnlinkCustodyCheck,
  expiryLiveCompanionCheck, expiryArmedWithoutDoneRowCheck,
  expiryCompanionActivePostConditionCheck, expiryCompanionEnabledPostConditionCheck,
  expirySelfRunCompletesCheck, expirySelfRunPostConditionParityCheck,
  reexecInvocationPresentCheck, reexecInvocationAbsentCheck, reexecInvocationEmptyCheck,
  reexecBoundaryCheck, reexecSingleElementCheck, expiryInvocationExactEqualityCheck } from './shu71-recovery-checks.mjs';
const custody = variant => (create, h) => expiryCustodyDriftCheck(create, h, variant);
// The journal-independent custody requirement of the restructured
// retireExpiryTimer(): every durable expiry unit file that is PRESENT is held
// in root custody, measured before the disable and again before the unlink.
// Several mutants below reintroduce a journal condition in front of it - the
// three doors this defect has already been reopened through.
const CUSTODY_PREDICATE = 'const custodyOfPresentUnits = () => EXPIRY_UNITS.every(file => unitFileAbsent(file) || expiryUnitCustody(file));';
const keys = ephemeralPublicSource();
const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
const source = fs.readFileSync(moduleUrl, 'utf8');
const basic = async (create, h) => {
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B1_PRODUCTION_ARMED');
  assert.equal(h.signatures(), 2, 'B1_ONE_SIGNING_TRANSACTION');
  assert.ok(h.exists('/srv/shu/state/shu71-activation.json'), 'B1_ACTIVATION_INSTALLED');
  for (const transition of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(transition.issue_id), transition.ready, 'B1_EXACT_PAIR_READY');
  assert.match(h.read('/etc/systemd/system/shu-supervisor.service.d/90-shu71.conf'), /ENABLE_DISPATCH=true/, 'B1_PHYSICAL_GATE');
};
const mutations = [
  ['expected-old lease corrupted', '`--force-with-lease=${ref}:${old}`', '`--force-with-lease=${ref}:${next}`', basic],
  ['activation installation omitted', "await step('activation', () => atomic(", "await step('activation', () => void (", basic],
  ['only one fixture transitioned', 'for (const t of pkg.issue_transitions) await step', 'for (const t of pkg.issue_transitions.slice(0, 1)) await step', basic],
  ['gate enable omitted', "atomic(file, '[Service]\\nEnvironment=ENABLE_DISPATCH=true\\n'", "atomic(file, '[Service]\\nEnvironment=ENABLE_DISPATCH=false\\n'", basic],
  ['expiry authorization never triggers cleanup', 'const expired = b.now() >= Date.parse(spec.pkg.expires_at);', 'const expired = false;', async (create, h) => {
    await basic(create, h); h.expire();
    assert.equal((await create(h.id, h.boundary).execute('expire')).state, 'REVOKED', 'B4_PHYSICAL_EXPIRY');
  }],
  // The guard is now a conjunction over the commit object and the ref; the mutant
  // bypasses its FIRST term (the signed reseed sha) and the check below answers a
  // commit object that satisfies every OTHER term - the bound parents in order,
  // and the ref still carrying the reseed commit - so only the bypassed term can
  // make the difference between a HALT and an arming.
  ['remote ancestry guard bypassed', 'need(reseedCommit.sha === next', 'need(true || reseedCommit.sha === next', async (create, h) => {
    const fetch = h.boundary.fetch;
    h.boundary.fetch = async (url, opts) => url.includes('/git/commits/')
      ? { ok: true, text: async () => JSON.stringify({ sha: 'f'.repeat(40), parents: [{ sha: h.spec.pkg.reseed.expected_parent }, { sha: h.spec.pkg.coordinator_revision }] }) }
      : fetch(url, opts);
    assert.equal((await create(h.id, h.boundary).execute('run')).state, 'HALT', 'B1_REMOTE_ANCESTRY_REFUSED');
  }],
  ['post-push readback omitted', 'await heads(spec, true);', '/* mutation: omit post-push readback */', async (create, h) => {
    const fetch = h.boundary.fetch;
    h.boundary.fetch = async (url, opts) => url.endsWith('SHU-254') && h.events.some(e => e.includes(' push --porcelain'))
      ? { ok: true, text: async () => JSON.stringify({ object: { sha: 'f'.repeat(40) } }) } : fetch(url, opts);
    assert.equal((await create(h.id, h.boundary).execute('run')).state, 'HALT', 'B1_REMOTE_READBACK_REFUSED');
  }],
  ['signing intent erased', "journal.append({ event: 'SIGNING_STARTED' });", '/* mutation: omit signing intent */', async (create, h) => {
    let dead = false;
    h.faults.after = name => dead || (dead = name === 'sign'); h.faults.before = () => dead;
    await create(h.id, h.boundary).execute('run').catch(() => {});
    h.faults.before = null; h.faults.after = null;
    const result = await create(h.id, h.boundary).execute('resume');
    assert.equal(result.code, 'ACT_SIGNING_AMBIGUOUS', 'B1_AMBIGUOUS_SIGNING_NOT_REPEATED');
  }],
  // Anchor updated in place for the pattern-based halt code; the mutation's
  // name, its control and its assertion are unchanged. The hand-maintained
  // allow-list it used to anchor on is now haltCode(), which admits a reviewed
  // NAME and maps everything else to ACT_PRODUCTION_FAILED; the mutant is the
  // same defect expressed against it - report the exception's text in place of
  // the sanitized code whenever the code is not a reviewed name.
  ['untyped exception text returned', '      const code = haltCode(error?.code);',
    "      const code = reviewedCode(error?.code) ?? String(error?.message ?? 'ACT_PRODUCTION_FAILED');", async (create, h) => {
    h.faults.before = name => name === 'card:SHU-140';
    const result = await create(h.id, h.boundary).execute('run');
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(h.journal()), /SECRET_POISON/, 'B4_NO_EXCEPTION_TEXT');
  }],
  ['one fixture restoration omitted', "...IDS.map(id => [`restore-${id.toLowerCase()}`", "...IDS.slice(0, 1).map(id => [`restore-${id.toLowerCase()}`", async (create, h) => {
    await basic(create, h);
    assert.equal((await create(h.id, h.boundary).execute('revoke')).state, 'REVOKED', 'B4_REVOKED');
    for (const transition of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(transition.issue_id), transition.restore, 'B4_BOTH_FIXTURES_RESTORED');
  }],
  // Anchor updated in place for the receipt-aware kill; name and assertion unchanged.
  ['worker kill omitted', "['workers', () => killSupervisorWorkers(journal)]", "['workers', () => {}]", async (create, h) => {
    await basic(create, h); await create(h.id, h.boundary).execute('revoke');
    assert.ok(h.events.some(e => e.includes('kill --kill-whom=all --signal=SIGKILL')), 'B4_WORKERS_PHYSICALLY_KILLED');
  }],
  // SHU-71 idempotent, receipt-aware teardown.
  ['pre-arm worker drift silently accepted', "      if (phase === 'never') { need(idle, 'ACT_TEARDOWN_DRIFT'); return; }",
    "      if (phase === 'never') { return; }", (create, h) => preArmDriftCheck(create, h, 'supervisor')],
  ['refused worker kill blindly accepted', "catch (error) { need(error?.code === 'ACT_COMMAND_FAILED' && unitIdle(unit), 'ACT_TEARDOWN_DRIFT'); }",
    'catch { /* mutation: accept any kill refusal */ }', workerKillFailureCheck],
  // Anchors updated in place for the pre/post-condition retirement; names and assertions unchanged.
  // Third correction round: the never-created branch is no longer the only
  // clause that can refuse a half-present mechanism, so this mutant is killed
  // by the drift only IT refuses - both durable unit files present and in
  // perfect root custody for a mechanism the journal proves was never created.
  // Without the branch that state is disabled, unlinked and reported retired.
  ['pre-arm expiry drift silently accepted', "if (lifecyclePhase(journal, 'expiry-watch') === 'never') { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); return; }",
    "if (false) { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); return; }", (create, h) => preArmDriftCheck(create, h, 'both-files')],
  // Split so each half of expiryRetired()'s tail is killed by a control that
  // reaches THAT half: `timer-active` leaves the enablement half satisfied, and
  // the stale-loaded-view control leaves the liveness half satisfied. Anchors
  // updated in place for the two-unit end state; names and assertions unchanged.
  ['expiry retirement ignores unit liveness', "\n    && unitIdle(expiryTimerUnit) && ['', 'not-found'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))\n",
    "\n    && ['', 'not-found'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))\n",
    (create, h) => preArmDriftCheck(create, h, 'timer-active')],
  // Re-anchored control, same mutant name and assertions: with the COMPANION's
  // own enablement conjunct now measured, the stale-loaded-view state forces the
  // daemon-reload through the companion term too, so it no longer distinguishes
  // this mutant. The state that does is a TIMER whose durable file is gone while
  // its leftover <target>.wants/ install symlink still answers `enabled` - every
  // other term of the predicate is the retired answer there.
  ['expiry retirement ignores unit enablement', "\n    && unitIdle(expiryTimerUnit) && ['', 'not-found'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))\n",
    '\n    && unitIdle(expiryTimerUnit)\n', (create, h) => preArmDriftCheck(create, h, 'timer-enabled-link')],
  // P154D-02. The COMPANION's own liveness and enablement conjuncts. The timer
  // is idle and unknown in both states, and both durable files are absent, so
  // only the named conjunct can refuse; without it the mechanism is reported
  // retired while the companion runs, or while its install symlink survives.
  ['expiry retirement ignores companion liveness', "\n    && !expiryCompanionSurvivesRemoval() && ['', 'not-found'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'));",
    "\n    && ['', 'not-found'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'));",
    (create, h) => preArmDriftCheck(create, h, 'service-active')],
  ['expiry retirement ignores companion enablement', "\n    && !expiryCompanionSurvivesRemoval() && ['', 'not-found'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'));",
    '\n    && !expiryCompanionSurvivesRemoval();', (create, h) => preArmDriftCheck(create, h, 'service-enabled-link')],
  // ...and the absence conjunct itself. Measured, not assumed: each unit's own
  // UnitFileState answers for its own file wherever systemd's loaded view is
  // fresh, so the ONLY state that distinguishes this mutant is a durable unit
  // file that is on disk and absent from the loaded view - which is why the
  // control plants the companion file after systemd's last reload.
  ['expiry retirement ignores the companion unit file', "const expiryRetired = () => EXPIRY_UNITS.every(unitFileAbsent)\n    && unitIdle(expiryTimerUnit)",
    'const expiryRetired = () => unitIdle(expiryTimerUnit)', (create, h) => preArmDriftCheck(create, h, 'service-file-stale-view')],
  ['non-creation inferred from an empty journal', "return journalHas(journal, 'RUN_ATTEMPT_STARTED') && !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';",
    "return !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';", destroyedJournalCheck],
  // SHU-71 expiry retirement drift: pre-condition, post-condition, the removal
  // itself, and the clauses in this area that no control pinned before.
  // Anchors updated in place for the receipt-aware pre-condition; names and
  // assertions unchanged.
  // Anchors moved to the restructured clause; names and assertions unchanged.
  // The pre-condition is now two separate requirements - custody of every
  // PRESENT file, which nothing may condition, and an accounted-for ABSENCE,
  // which is what these two mutants address.
  ['installed expiry pre-condition omitted', "need(measuredPredicate(() => removing || EXPIRY_UNITS.every(file => !unitFileAbsent(file))\n      || !installed && expiryRetired()), 'ACT_TEARDOWN_DRIFT');",
    "need(true, 'ACT_TEARDOWN_DRIFT');",
    (create, h) => expiryFileDriftCheck(create, h, 'timer')],
  ['expiry companion service file unchecked', 'EXPIRY_UNITS.every(file => !unitFileAbsent(file))', '[EXPIRY_UNITS[0]].every(file => !unitFileAbsent(file))',
    (create, h) => expiryFileDriftCheck(create, h, 'service')],
  ['retired expiry units left behind', 'for (const file of EXPIRY_UNITS) remove(file);', 'for (const file of []) remove(file);', expiryRetirementCheck],
  ['expiry retirement receipt omitted', "if (!removing) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });",
    "if (false) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });", expiryRetirementCheck],
  // Re-anchored by SHU-280's thirteenth round, which gave this line the
  // published-ref measurement. The mutation is unchanged: drop the retired
  // expiry observation and nothing else.
  ['retired episode expiry drift unobserved', 'try { observeTeardown(); observeRetiredExpiry(); observePublishedRefs(spec, journal, true); }',
    'try { observeTeardown(); observePublishedRefs(spec, journal, true); }', expiryRetirementCheck],
  ['expiry end state never measured', "    need(measuredPredicate(() => unitIdle(expiryTimerUnit)\n      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))\n      && !expiryCompanionSurvivesRemoval()\n      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'))), 'ACT_TEARDOWN_DRIFT');\n",
    '', expiryPostConditionCheck],
  ['refused expiry disable blindly accepted', "catch (error) { need(measuredPredicate(() => error?.code === 'ACT_COMMAND_FAILED' && (removing || !installed && expiryRetired())), 'ACT_TEARDOWN_DRIFT'); }",
    'catch { /* mutation: accept any disable refusal */ }', expiryDisableFailureCheck],
  ['stale unit view never refreshed', "      command('/usr/bin/systemctl', ['daemon-reload']);\n      need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT');",
    "      need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT');", expiryCachedViewCheck],
  ['recovered log accepted as non-creation proof', 'if (journal.recovered || journalHas(journal, \'ARMED\')', "if (journalHas(journal, 'ARMED')", recoveredNonCreationCheck],
  ['teardown effect order permuted', "      ['activation', () => remove(ACTIVATION_FILE)],\n      ['workers', () => killSupervisorWorkers(journal)],",
    "      ['workers', () => killSupervisorWorkers(journal)],\n      ['activation', () => remove(ACTIVATION_FILE)],", teardownOrderCheck],
  ['fixtures durability precondition removed', "need(journal.entries.some(e => e.event === 'DONE' && e.step === 'teardown:workers'), 'ACT_FIXTURE_CLEANUP');",
    "need(true, 'ACT_FIXTURE_CLEANUP');", fixturesRequireWorkersCheck],
  // Correction round: one mutant per custody term of the pre-condition, plus
  // the vacuous predicate, and the refusal measured after the daemon-reload.
  // `!s.isSymbolicLink()` has no mutant: it is an equivalent mutant on an lstat
  // result, documented at the predicate rather than pinned by a faked control.
  ['expiry unit owner unchecked', 's.nlink === 1 && s.uid === 0 && s.gid === 0', 's.nlink === 1 && s.gid === 0', custody('non-root-owner')],
  ['expiry unit group unchecked', 's.nlink === 1 && s.uid === 0 && s.gid === 0', 's.nlink === 1 && s.uid === 0', custody('non-root-group')],
  ['expiry unit group-writable mode accepted', 's.gid === 0 && !(s.mode & 0o022)', 's.gid === 0 && !(s.mode & 0o002)', custody('group-writable')],
  ['expiry unit world-writable mode accepted', 's.gid === 0 && !(s.mode & 0o022)', 's.gid === 0 && !(s.mode & 0o020)', custody('world-writable')],
  ['expiry unit file shape unchecked', 's.isFile() && !s.isSymbolicLink() && ', '', custody('non-regular-file')],
  // The one remaining unpinned term. A hardlinked unit file is a real drift
  // shape: another name still refers to the inode systemd loaded, so unlinking
  // the unit path leaves the file, and its holder, behind. The control plants
  // the second name on the timer; the service-file control kills this mutant
  // too, and is the one that also observes the companion half of `every`.
  ['expiry unit hardlink unchecked', 's.nlink === 1 && s.uid === 0 && s.gid === 0', 's.uid === 0 && s.gid === 0', custody('hardlinked-timer')],
  ['expiry unit custody predicate vacuous', 'return s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === 0 && s.gid === 0 && !(s.mode & 0o022);',
    'return true;', custody('non-root-owner')],
  ['post-reload expiry end state never measured', "      command('/usr/bin/systemctl', ['daemon-reload']);\n      need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT');",
    "      command('/usr/bin/systemctl', ['daemon-reload']);", expiryPostReloadDriftCheck],
  // Second correction round. The verifier's own surviving mutants, plus one per
  // remaining load-bearing clause and ordering of the retirement, so the clause
  // table in SHU71-PREREQUISITES.md can be attacked instead of rediscovered.
  //
  // F-01: the shape the durable receipt had before this round. A retry finds a
  // journal-proven installed unit file that has drifted out of root custody and
  // disables, unlinks and reports it as a clean retirement, while a second name
  // for the same inode survives the removal.
  // Re-anchored on the restructured clause: the F-01 door is now reintroduced
  // by conditioning the custody PREDICATE itself on the durable receipt, which
  // waives it at both measurement points at once. Names and assertions unchanged.
  ['interrupted removal bypasses expiry custody', CUSTODY_PREDICATE,
    CUSTODY_PREDICATE.replace('=> EXPIRY_UNITS', '=> removing || EXPIRY_UNITS'),
    (create, h) => expiryInterruptedCustodyDriftCheck(create, h, 'timer')],
  ['interrupted removal bypasses companion custody', CUSTODY_PREDICATE,
    CUSTODY_PREDICATE.replace('=> EXPIRY_UNITS', '=> removing || EXPIRY_UNITS'),
    (create, h) => expiryInterruptedCustodyDriftCheck(create, h, 'service')],
  // F-02: the load-bearing ordering. Appended after the loop, a crash inside the
  // loop leaves no receipt and the retry is a permanent wedge.
  ['expiry removal receipt appended after the unlinks',
    "      if (!removing) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });\n      for (const file of EXPIRY_UNITS) remove(file);",
    "      for (const file of EXPIRY_UNITS) remove(file);\n      if (!removing) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });",
    expiryInterruptedRemovalCheck],
  ['expiry removal receipt never re-read', "const removing = journalHas(journal, 'EXPIRY_RETIREMENT_STARTED');",
    'const removing = false;', expiryInterruptedRemovalCheck],
  // F-03: both doors of the disable catch, and each conjunct behind the typed one.
  ['expiry disable exit-status refusal conjuncts dropped',
    "error?.code === 'ACT_COMMAND_FAILED' && (removing || !installed && expiryRetired())",
    "error?.code === 'ACT_COMMAND_FAILED'", expiryDisableExitFailureCheck],
  ['interrupted expiry disable refusal rejected', '(removing || !installed && expiryRetired())',
    '(!installed && expiryRetired())', expiryInterruptedRemovalCheck],
  ['uninstalled expiry disable refusal rejected', '(removing || !installed && expiryRetired())',
    '(removing)', (create, h) => expiryUninstalledDisableCheck(create, h, 'retired')],
  ['uninstalled expiry disable accepted with the mechanism present', '(removing || !installed && expiryRetired())',
    '(removing || !installed)', (create, h) => expiryUninstalledDisableCheck(create, h, 'present')],
  // F-04: one mutant per post-condition conjunct, each attributable now that the
  // two controls reach them independently.
  ['expiry post-condition unit liveness inert', 'measuredPredicate(() => unitIdle(expiryTimerUnit)\n',
    'measuredPredicate(() => true\n', expiryActivePostConditionCheck],
  ['expiry post-condition enablement unchecked',
    "\n      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))\n      && !expiryCompanionSurvivesRemoval()",
    '\n      && !expiryCompanionSurvivesRemoval()', expiryEnabledPostConditionCheck],
  // P154D-02. The companion halves of the same post-condition. `disable --now`
  // reports nothing about the service it triggers, so a disable that leaves it
  // running or enabled is drift the exit status cannot report - and an inert
  // conjunct destroys the durable unit files of a live or still-enabled unit.
  ['expiry post-condition companion liveness inert', '\n      && !expiryCompanionSurvivesRemoval()\n', '\n      && true\n',
    expiryCompanionActivePostConditionCheck],
  ['expiry post-condition companion enablement unchecked',
    "\n      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'))), 'ACT_TEARDOWN_DRIFT');",
    "), 'ACT_TEARDOWN_DRIFT');", expiryCompanionEnabledPostConditionCheck],
  // The remaining clauses of the sweep: the second disjunct of the `installed`
  // derivation, the disable command itself, and the removal loop's own guard.
  // `installed` no longer gates custody at all, so it is observable only where
  // a unit file is ABSENT: a mechanism the DONE row alone proves installed,
  // which has vanished entirely with no receipt, is drift. Read from ARMED only
  // that state is `!installed && expiryRetired()` and is reported retired.
  ['expiry installation proven only by ARMED', "journalHas(journal, 'ARMED') || journalHas(journal, 'DONE', 'expiry-watch');",
    "journalHas(journal, 'ARMED');", (create, h) => expiryVanishedMechanismCheck(create, h, 'done-row')],
  ['expiry disable command never issued', "try { command('/usr/bin/systemctl', ['disable', '--now', expiryTimerUnit]); }",
    'try { /* mutation: never issue the disable */ }', expiryRetirementCheck],
  // The removal loop's own guard. The teardown's `expiry-timer` step is not a
  // repeating effect, so a second teardown never re-enters the retirement: the
  // reachable state where the guard is false is a mechanism that is already
  // absent when the step first runs. Dropping it writes a removal receipt and
  // issues both unlinks for a pair there is nothing to remove.
  ['expiry removal issued with nothing to remove', 'if (measuredPredicate(() => !EXPIRY_UNITS.every(unitFileAbsent))) {',
    'if (true) {', (create, h) => expiryUninstalledDisableCheck(create, h, 'retired')],
  // Third correction round, P154C-01. The custody measurement is a property of
  // the removal; every mutant here puts a journal condition back in front of
  // it, or narrows what it measures, and each is killed by a control that
  // reaches a PRESENT, drifted unit file in the journal state it excuses.
  ['expiry custody conditioned on journal-proven installation', CUSTODY_PREDICATE,
    CUSTODY_PREDICATE.replace('=> EXPIRY_UNITS', '=> !installed || EXPIRY_UNITS'),
    (create, h) => expiryJournalBlindCustodyCheck(create, h, 'interrupted-install', 'hardlinked-timer')],
  ['expiry custody conditioned on a recovered log', CUSTODY_PREDICATE,
    CUSTODY_PREDICATE.replace('=> EXPIRY_UNITS', '=> journal.recovered || EXPIRY_UNITS'),
    (create, h) => expiryJournalBlindCustodyCheck(create, h, 'recovered', 'hardlinked-timer')],
  ['expiry custody predicate ignores the companion unit file', CUSTODY_PREDICATE,
    CUSTODY_PREDICATE.replace('EXPIRY_UNITS.every', '[EXPIRY_UNITS[0]].every'), custody('hardlinked-service')],
  ['expiry custody measured on absent unit files', CUSTODY_PREDICATE,
    CUSTODY_PREDICATE.replace('unitFileAbsent(file) || ', ''), expiryInterruptedRemovalCheck],
  // The two measurement points, each pinned on its own: before the command
  // that acts on the unit, and again immediately before the unlink.
  ['expiry custody measured only after the disable', '\n    requireCustodyOfPresentUnits();', '',
    custody('non-root-owner')],
  ['expiry custody never re-measured before the unlink', '\n      requireCustodyOfPresentUnits();', '',
    expiryUnlinkCustodyCheck],
  // The ABSENCE half of the same clause: what the journal may and may not
  // excuse. One mutant per disjunct, each with the state that distinguishes it.
  ['expiry presence pre-condition ignores the removal receipt', 'removing || EXPIRY_UNITS.every(file => !unitFileAbsent(file))',
    'EXPIRY_UNITS.every(file => !unitFileAbsent(file))', expiryInterruptedRemovalCheck],
  ['unaccounted expiry absence accepted', "\n      || !installed && expiryRetired()), 'ACT_TEARDOWN_DRIFT');", "), 'ACT_TEARDOWN_DRIFT');",
    (create, h) => expiryUninstalledDisableCheck(create, h, 'retired')],
  ['journal-proven installed expiry absence accepted', '\n      || !installed && expiryRetired())', '\n      || expiryRetired())',
    (create, h) => expiryVanishedMechanismCheck(create, h, 'armed')],
  ['unretired expiry absence accepted', "\n      || !installed && expiryRetired()), 'ACT_TEARDOWN_DRIFT');", "\n      || !installed), 'ACT_TEARDOWN_DRIFT');",
    (create, h) => expiryAbsenceAccountedCheck(create, h, 'interrupted-install', 'half')],
  // Fourth correction round, P154D-02. The mechanism is TWO units and a live
  // companion is its own refusal. Each mutant below removes one of the three
  // places that refusal is stated, and each is killed by the control that
  // reaches a measurably RUNNING companion through the matching door.
  ['expiry running companion accepted before the disable', '\n    requireIdleExpiryCompanion();\n    // Absence, accounted for.', '\n    // Absence, accounted for.',
    (create, h) => expiryLiveCompanionCheck(create, h, 'installed')],
  ['retired episode expiry companion liveness unobserved',
    "function observeRetiredExpiry() { requireIdleExpiryCompanion(); need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); }",
    "function observeRetiredExpiry() { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); }",
    (create, h) => expiryLiveCompanionCheck(create, h, 'retired-episode')],
  // Re-anchored by SHU-280's thirteenth round, which moved the same choice
  // into a named list so the two branch refusals survive to the caller too.
  // The mutation is unchanged: flatten every cause into generic drift.
  ['live expiry companion reported as generic drift',
    "const code = RETIRED_OBSERVATION_NAMES.includes(error?.code) ? error.code : 'ACT_TEARDOWN_DRIFT';",
    "const code = 'ACT_TEARDOWN_DRIFT';", (create, h) => expiryLiveCompanionCheck(create, h, 'retired-episode')],
  ['expiry companion refusal predicate vacuous',
    "const requireIdleExpiryCompanion = () => need(measuredPredicate(() => !expiryCompanionSurvivesRemoval()), 'ACT_TEARDOWN_EXPIRY_SERVICE');",
    'const requireIdleExpiryCompanion = () => {};', (create, h) => expiryLiveCompanionCheck(create, h, 'installed')],
  // P154D-01. The FIRST disjunct of the `installed` derivation, which the
  // previous round declared an equivalent mutant on a writer-side argument. The
  // reader's input space is larger than the writer's output: a chain-valid
  // recovered log holding ARMED without the creating step's durable DONE row is
  // accepted, and there ARMED is the only thing that proves the installation.
  ['expiry installation proven only by the DONE row', "journalHas(journal, 'ARMED') || journalHas(journal, 'DONE', 'expiry-watch');",
    "journalHas(journal, 'DONE', 'expiry-watch');", expiryArmedWithoutDoneRowCheck],
  // Fifth correction round, P154D-06. The exclusion must be EXACTLY as wide as
  // the invocation performing the removal and no wider, so it is attacked from
  // both sides and at both of its sites. Each mutant below is killed by a
  // different named control.
  //
  // A: drop the exclusion entirely and the mechanism refuses the invocation
  // that is removing it - the shipped regression, restored.
  ['expiry teardown refuses the invocation performing it',
    'const expiryCompanionSurvivesRemoval = () => !unitIdle(expiryServiceUnit) && !expiryCompanionIsThisInvocation();',
    'const expiryCompanionSurvivesRemoval = () => !unitIdle(expiryServiceUnit);', expirySelfRunCompletesCheck],
  // B: widen it so ANY companion with an invocation of its own is treated as
  // self. On a real host every live unit has one, so this is the loophole that
  // would tolerate a foreign live companion; the exact-equality-of-two-non-empty
  // -values term is what stops it.
  ['expiry invocation exclusion widened to any live companion',
    "    return typeof self === 'string' && self !== '' && unit !== '' && unit === self;",
    "    return unit !== '';", (create, h) => expiryLiveCompanionCheck(create, h, 'foreign-invocation')],
  // C: keep the exclusion at the refusal before the disable and drop its parity
  // at the post-condition, where a self-invocation is still `activating` by
  // construction and would trip ACT_TEARDOWN_DRIFT after its own removal.
  ['expiry post-condition refuses the invocation performing the removal',
    '\n      && !expiryCompanionSurvivesRemoval()\n', '\n      && unitIdle(expiryServiceUnit)\n',
    expirySelfRunPostConditionParityCheck],
  // Sixth correction round, P154D-07. The alignment is EXACT string equality of
  // two non-empty values. Loosen it - trim, lower-case, prefix-match - and a
  // near miss of the companion's own reported InvocationID starts excluding a
  // start that is not this one, which is the widening the fifth round's
  // foreign-invocation control cannot see because that control's two ids share
  // no prefix at all.
  ['expiry invocation comparison loosened below exact equality',
    "    return typeof self === 'string' && self !== '' && unit !== '' && unit === self;",
    "    return typeof self === 'string' && self.trim() !== '' && unit !== '' && unit.trim().toLowerCase().startsWith(self.trim().toLowerCase());",
    expiryInvocationExactEqualityCheck],
];
for (const [name, before, after, check] of mutations) test(`B1/B4 mutation: ${name}`, async t => {
  await check(createShu71Production, productionFixture(t, keys));
  assert.equal(source.split(before).length, 2, 'B1_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modified = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  const mutant = await import(pathToFileURL(file)); // module-load/syntax errors cannot count as kills
  await assert.rejects(check(mutant.createShu71Production, productionFixture(t, keys)),
    error => error.code === 'ERR_ASSERTION' && /B[14]_/.test(error.message), 'B1_MUTATION_NAMED_ASSERTION');
});

// The Sentry-shaped defect on the retirement line: a predicate evaluated as an
// argument of need() skips its own refusal when it throws. The mutant restores
// that shape and dies by the control's own named assertion.
test('B1/B4 mutation: refusal predicate evaluated inside need()', async t => {
  predicateRefusalCheck(await import('../shu71-production.mjs'));
  // Anchor updated in place: a throw is now the named MEASUREMENT refusal
  // rather than a mapped false. The mutant is the same defect - the predicate
  // evaluated bare, so its exception escapes in place of any named refusal -
  // and it dies by the same control's same assertion.
  const before = 'export const measuredPredicate = predicate => { try { return predicate() === true; } catch (error) { throw measurementFailure(error); } };';
  const after = 'export const measuredPredicate = predicate => predicate() === true;';
  assert.equal(source.split(before).length, 2, 'B1_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modified = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  const mutant = await import(pathToFileURL(file));
  assert.throws(() => predicateRefusalCheck(mutant),
    error => error.code === 'ERR_ASSERTION' && /B[14]_/.test(error.message), 'B1_MUTATION_NAMED_ASSERTION');
});

// Sixth correction round, P154D-07. The propagation itself, which the fifth
// round shipped load-bearing and unpinned. `lockedReexecCommand` is a pure
// function of the parent's invocation value, so its mutants are driven directly
// against the imported module rather than through a fixture, exactly as the
// measuredPredicate mutant below is. What really crosses `/usr/bin/env -i` into
// the process that measures it is attacked again, at runtime, in
// shu71-reexec-boundary.test.mjs.
const ELEMENT = '...(invocation ? [`INVOCATION_ID=${invocation}`] : []),';
const commandMutations = [
  // 1. PRESENT: the element deleted. Every control the fifth round wrote still
  // passes; the measurement it protects is correct and dead.
  ['expiry invocation never crosses the kernel lock', '\n    ' + ELEMENT, '', reexecInvocationPresentCheck],
  // 2. ABSENT: an element invented where the parent had none, so the inner
  // process reads `INVOCATION_ID` as an empty string rather than as absence.
  ['expiry invocation element invented when the parent has none', ELEMENT,
    '`INVOCATION_ID=${invocation ?? \'\'}`,', reexecInvocationAbsentCheck],
  // 3. EMPTY treated as a value, which is the same invented assignment reached
  // through the one state the truthiness test and a defined-ness test differ on.
  ['empty parent invocation treated as a value', ELEMENT,
    '...(invocation !== undefined ? [`INVOCATION_ID=${invocation}`] : []),', reexecInvocationEmptyCheck],
  // 4a. The boundary carries the operator's environment through the lock.
  ['parent environment carried through the kernel lock',
    "'/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',",
    "'/usr/bin/env', '-i', ...Object.entries(process.env).map(([key, value]) => `${key}=${value}`), 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',",
    reexecBoundaryCheck],
  // 4b. The wipe itself removed.
  ['kernel lock no longer wipes the environment', "'/usr/bin/env', '-i', 'PATH=/usr/bin:/bin'",
    "'/usr/bin/env', 'PATH=/usr/bin:/bin'", reexecBoundaryCheck],
  // 4c. The element is a NAME=VALUE pair read from somewhere other than the
  // single invocation value - here, straight back out of the environment the
  // function was extracted precisely so it would not read.
  ['expiry invocation element read from the environment, not the argument', ELEMENT,
    '...(invocation ? [`INVOCATION_ID=${process.env.INVOCATION_ID}`] : []),', reexecBoundaryCheck],
  // 5. The value split into several argv elements, so a value carrying spaces
  // and `=` injects a second variable into the inner process's environment.
  ['expiry invocation value split across argv elements', ELEMENT,
    "...(invocation ? `INVOCATION_ID=${invocation}`.split(' ') : []),", reexecSingleElementCheck],
];
for (const [name, before, after, check] of commandMutations) test(`B1/B4 mutation: ${name}`, async t => {
  check(await import('../shu71-production.mjs'));
  assert.equal(source.split(before).length, 2, 'B1_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modified = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  const mutant = await import(pathToFileURL(file)); // module-load/syntax errors cannot count as kills
  assert.throws(() => check(mutant),
    error => error.code === 'ERR_ASSERTION' && /B[14]_/.test(error.message), 'B1_MUTATION_NAMED_ASSERTION');
});
