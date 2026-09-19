import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { preArmDriftCheck, workerKillFailureCheck, destroyedJournalCheck } from './shu71-recovery-checks.mjs';
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
  ['pre-arm expiry drift silently accepted', "if (lifecyclePhase(journal, 'expiry-watch') === 'never') { need(retired(), 'ACT_TEARDOWN_DRIFT'); return; }",
    "if (false) { need(retired(), 'ACT_TEARDOWN_DRIFT'); return; }", (create, h) => preArmDriftCheck(create, h, 'timer-file')],
  ['expiry retirement ignores unit liveness', "&& unitIdle(timer) && ['', 'not-found'].includes(unitProperty(timer, 'UnitFileState'));", ';',
    (create, h) => preArmDriftCheck(create, h, 'timer-active')],
  ['non-creation inferred from an empty journal', "return journalHas(journal, 'RUN_ATTEMPT_STARTED') && !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';",
    "return !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';", destroyedJournalCheck],
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
