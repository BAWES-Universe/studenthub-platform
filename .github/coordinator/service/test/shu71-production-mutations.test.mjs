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
  teardownOrderCheck, fixturesRequireWorkersCheck, predicateRefusalCheck } from './shu71-recovery-checks.mjs';
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
  ['remote ancestry guard bypassed', "need(comparison.status === 'ahead'", "need(true || comparison.status === 'ahead'", async (create, h) => {
    const fetch = h.boundary.fetch;
    h.boundary.fetch = async (url, opts) => url.includes('/compare/') ? { ok: true, text: async () => JSON.stringify({ status: 'diverged' }) } : fetch(url, opts);
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
  ['untyped exception text returned', "? error.code : 'ACT_PRODUCTION_FAILED';", '? error.code : error.message;', async (create, h) => {
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
  ['pre-arm expiry drift silently accepted', "if (lifecyclePhase(journal, 'expiry-watch') === 'never') { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); return; }",
    "if (false) { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); return; }", (create, h) => preArmDriftCheck(create, h, 'timer-file')],
  ['expiry retirement ignores unit liveness', "\n    && unitIdle(expiryTimerUnit) && ['', 'not-found'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'));", ';',
    (create, h) => preArmDriftCheck(create, h, 'timer-active')],
  ['non-creation inferred from an empty journal', "return journalHas(journal, 'RUN_ATTEMPT_STARTED') && !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';",
    "return !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';", destroyedJournalCheck],
  // SHU-71 expiry retirement drift: pre-condition, post-condition, the removal
  // itself, and the clauses in this area that no control pinned before.
  ['installed expiry pre-condition omitted', "if (installed && !removing) need(measuredPredicate(() => EXPIRY_UNITS.every(expiryUnitCustody)), 'ACT_TEARDOWN_DRIFT');",
    "if (false) need(measuredPredicate(() => EXPIRY_UNITS.every(expiryUnitCustody)), 'ACT_TEARDOWN_DRIFT');",
    (create, h) => expiryFileDriftCheck(create, h, 'timer')],
  ['expiry companion service file unchecked', 'EXPIRY_UNITS.every(expiryUnitCustody)', '[EXPIRY_UNITS[0]].every(expiryUnitCustody)',
    (create, h) => expiryFileDriftCheck(create, h, 'service')],
  ['retired expiry units left behind', 'for (const file of EXPIRY_UNITS) remove(file);', 'for (const file of []) remove(file);', expiryRetirementCheck],
  ['expiry retirement receipt omitted', "if (!removing) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });",
    "if (false) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });", expiryRetirementCheck],
  ['retired episode expiry drift unobserved', 'try { observeTeardown(); observeRetiredExpiry(); }', 'try { observeTeardown(); }', expiryRetirementCheck],
  ['expiry end state never measured', "    need(measuredPredicate(() => unitIdle(expiryTimerUnit)\n      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))), 'ACT_TEARDOWN_DRIFT');\n",
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
  const before = 'export const measuredPredicate = predicate => { try { return predicate() === true; } catch { return false; } };';
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
