import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { historicalSource } from './shu71-history.mjs';

test('historical custody validates all six recorded sources', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./fixtures/shu71-history/sha256.json', import.meta.url)));
  let count = 0;
  for (const [revision, files] of Object.entries(manifest)) for (const name of Object.keys(files)) {
    assert.ok(historicalSource(revision, name).length > 0); count++;
  }
  assert.equal(count, 6);
});

test('historical custody refuses an unrecorded revision with an actionable error', () => {
  assert.throws(() => historicalSource('0'.repeat(40), 'shu71-production.mjs'),
    { code: 'SHU71_HISTORY_UNRESOLVED' });
});

test('historical custody mechanism detects drift against a synthetic Git repository', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-custody-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.github/coordinator/service/test');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(new URL('./shu71-history.mjs', import.meta.url), path.join(dir, 'shu71-history.mjs'));
  const git = args => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  const original = fs.readFileSync(new URL(`./fixtures/shu71-history/${controlRevisions[0]}/shu71-production.mjs`, import.meta.url), 'utf8');
  fs.writeFileSync(path.join(dir, '../shu71-production.mjs'), original);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'historical fixture']);
  const revision = git(['rev-parse', 'HEAD']).toString().trim();
  // Explicitly register this synthetic revision in the disposable helper only.
  const helper = path.join(dir, 'shu71-history.mjs');
  fs.writeFileSync(helper, fs.readFileSync(helper, 'utf8').replace(controlRevisions[0], revision));
  const fixtures = path.join(dir, 'fixtures/shu71-history');
  fs.mkdirSync(path.join(fixtures, revision), { recursive: true });
  const file = path.join(fixtures, revision, 'shu71-production.mjs');
  const record = bytes => fs.writeFileSync(path.join(fixtures, 'sha256.json'), JSON.stringify({ [revision]: {
    'shu71-production.mjs': createHash('sha256').update(bytes).digest('hex')
  } }));
  fs.writeFileSync(file, original); record(original);
  const { historicalSource: read } = await import(pathToFileURL(path.join(dir, 'shu71-history.mjs')));
  assert.equal(read(revision, 'shu71-production.mjs'), original);
  fs.writeFileSync(file, 'drift');
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_DIGEST_MISMATCH' });
  const drift = original + '\n// synthetic custody drift\n';
  fs.writeFileSync(file, drift); record(drift);
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_GIT_MISMATCH' });
  fs.rmSync(file);
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_FIXTURE_MISSING' });
});

import { controlContent, controlRevisions } from './shu71-history.mjs';
import { historicalProduction, gates } from './shu71-r5-checks.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
// These differentials execute HISTORICAL revisions, which compare the prior
// state by JSON.stringify and therefore cannot consume a canonically sealed
// approval at all. A differential must feed all three arms the same bytes, so
// the one serialization every arm can read is the construction order. The
// canonical target-host shape is driven against the candidate in
// shu71-arming-order.test.mjs and, by default, everywhere else.
for (const [index, revision] of controlRevisions.entries()) {
  test(`historical control semantics: ${revision} reservation and fault ordering`, async t => {
    // Load both real vendored modules. Execute the properties behind the source
    // guard so its assumptions are independently checked on disposable boundaries.
    const production = await historicalProduction(t, revision);
    const h = productionFixture(t, keys, production.signingPath, null, { approvalBytes: 'construction' }), create = () => production(h.id, h.boundary);
    h.owners.set('/srv/shu/state', [0, 0]); // Execute the immutable source under its historical custody.
    assert.equal((await create().execute('run')).state, 'ARMED'); h.expire();
    const budget = `/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`;
    const start = h.events.length;
    h.faults.before = e => e === 'card:SHU-140';
    assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
    h.faults.before = undefined;
    const events = h.events.slice(start);
    const reserve = events.findIndex(e => e === `write:${budget}.pending`);
    const disarm = events.findIndex(e => e === `write:${gates[0]}.pending`);
    assert.ok(disarm >= 0, 'SHU71_CONTROL_ORDINARY_DISARM');
    if (index === 0) assert.equal(reserve, -1, 'SHU71_CONTROL_PARENT_NO_RESERVATION');
    else assert.ok(reserve >= 0 && reserve < disarm, 'SHU71_CONTROL_RESERVATION_BEFORE_DISARM');
    // Fresh episode: neither previous disarm nor credential removal can mask
    // the historical fault-path difference.
    const fault = productionFixture(t, keys, production.signingPath, null, { approvalBytes: 'construction' });
    fault.owners.set('/srv/shu/state', [0, 0]);
    await production(fault.id, fault.boundary).execute('run'); fault.expire();
    fault.write(`/srv/shu/state/shu71-evidence/${fault.id}/automatic-teardown.json`, '{"attempts":0}', 0o644);
    const result = await production(fault.id, fault.boundary).execute('expire');
    assert.equal(result.state, index === 0 ? 'REVOKED' : 'HALT', 'SHU71_CONTROL_FAULT_OUTCOME');
    for (const gate of gates) assert.equal(fault.read(gate).includes('ENABLE_DISPATCH=true'), index === 1, 'SHU71_CONTROL_FAULT_GATE_ORDER');
    assert.equal(fault.exists('/srv/shu/state/shu71-activation.json'), index !== 0, 'SHU71_CONTROL_FAULT_CREDENTIAL_RETAINED');
  });
  test(`historical control rejects candidate substitution without Git: ${revision}`, () => {
    const candidate = fs.readFileSync(new URL('../shu71-production.mjs', import.meta.url), 'utf8');
    assert.throws(() => controlContent(revision, 'shu71-production.mjs', candidate),
      { code: 'SHU71_HISTORY_CONTROL_CONTENT' }, 'SHU71_CONTROL_CANDIDATE_SUBSTITUTION');
  });
}
test('historical journal controls require physical replay without Git', () => {
  for (const revision of controlRevisions) {
    const source = historicalSource(revision, 'shu71-journal.mjs');
    const mutant = source.replace('effect, repeat);', 'effect, false);');
    assert.notEqual(mutant, source);
    assert.throws(() => controlContent(revision, 'shu71-journal.mjs', mutant),
      /SHU71_HISTORY_CONTROL_CONTENT.*JOURNAL_APPLIES_REPEAT/, 'SHU71_CONTROL_JOURNAL_REPLAY_REQUIRED');
  }
});

// Diagnostic text counterexamples, not executable substitutes or provenance proofs.
// Each expects its own property code; another guard rejecting it is insufficient.
const textCases = [
  ['JOURNAL_VALIDATES_CHAIN', 0, 'journal', 'payload.seq===index', 'payload.seq>=index'],
  ['JOURNAL_REPEATS_PHYSICAL_EFFECTS', 0, 'journal', "'workers',", ''],
  ['JOURNAL_APPLIES_REPEAT', 0, 'journal', 'effect,repeat)', 'effect,false)'],
  ['JOURNAL_FAILURE_VETOES_RETIREMENT', 0, 'journal', "step==='expiry-timer'&&failures.length", 'false'],
  ['KNOWN_CONTROL_MODULE', 0, 'unknown', '', ''],
  ['CLEANUP_BODY_PRESENT', 0, 'production', 'async function cleanup(', 'async function other('],
  ['ORDERED_EFFECTS_PRESENT', 0, 'production', 'consteffects=[', 'constother=['],
  ['GATE_FIRST_ORDINARY_EFFECT', 0, 'production', "consteffects=[['gate'", "consteffects=[['other'"],
  ['DISARM_BEFORE_CREDENTIAL_REMOVAL', 0, 'production', "['activation',()=>remove(ACTIVATION_FILE)]", "['activation',()=>remove(OTHER_FILE)]"],
  ['NO_CREDENTIAL_REVOCATION_IN_FAULT_FALLBACK', 0, 'production', 'consteffects=[', 'remove(ACTIVATION_FILE);consteffects=['],
  ['NO_RESERVATION_EVIDENCE_BINDING', 0, 'production', 'consteffects=[', "log('AUTOMATIC_TEARDOWN_RESERVED');consteffects=["],
  ['PARENT_NO_RESERVATION_BEFORE_DISARM', 0, 'production', 'consteffects=[', "read('automatic-teardown.json');consteffects=["],
  ['PARENT_NO_COUNTER_FAULT_FALLBACK', 0, 'production', 'consteffects=[', "fail('ACT_RETRY_BUDGET_UNAVAILABLE');consteffects=["],
  ['BLOCKED_RESERVATION_BEFORE_DISARM', 1, 'production', 'attempts:attempts+1', 'attempts:attempts'],
  ['R4_FAULT_RETURNS_WITHOUT_DISARM', 1, 'production', "catch{return{ok:false,state:'HALT'", "catch{return{ok:false,state:'OTHER'"],
  ['R4_NO_FAULT_GATE_LOOP', 1, 'production', 'consteffects=[', 'for(constfileofGATES){}consteffects=['],
  ['R5_FAULT_DISARMS_GATES_ONLY', 2, 'production', 'for(constfileofGATES)', 'for(constfileof[])'],
  ['R5_COUNTER_BOOLEAN_SETTLEMENT_AUTHORITY', 2, 'production', '.settlement_started)returnrefusal;', '.other)returnrefusal;'],
];
for (const [property, index, module, before, after] of textCases) {
  test(`historical content diagnostic individually pins ${property}`, () => {
    const revision = controlRevisions[index];
    const name = `shu71-${module === 'unknown' ? 'production' : module}.mjs`;
    const source = fs.readFileSync(new URL(`./fixtures/shu71-history/${revision}/${name}`, import.meta.url), 'utf8');
    // Use the same whitespace domain as the diagnostic, preserving its body delimiter.
    const scoped = module === 'journal' ? source : source.match(/async function cleanup\([^]*?\n  return Object\.freeze/)[0];
    const text = scoped.replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, '')
      .replace('asyncfunctioncleanup(', 'async function cleanup(')
      .replace('returnObject.freeze', '\n  return Object.freeze');
    controlContent(revision, name, text);
    if (module !== 'unknown') assert.ok(text.includes(before), `SHU71_CONTROL_CASE_SITE_${property}`);
    assert.throws(() => controlContent(revision, module === 'unknown' ? 'unknown.mjs' : name,
      module === 'unknown' ? text : text.replace(before, after)),
    e => e.code === 'SHU71_HISTORY_CONTROL_CONTENT' && e.message.endsWith(`: ${property}`),
    `SHU71_CONTROL_PROPERTY_${property}`);
  });
}

test('historical custody refuses a vendored revision lacking a content specification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-unregistered-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const revision = '4'.repeat(40), name = 'shu71-production.mjs';
  const dir = path.join(root, 'fixtures/shu71-history');
  fs.mkdirSync(path.join(dir, revision), { recursive: true });
  const source = fs.readFileSync(new URL(`./fixtures/shu71-history/${controlRevisions[0]}/${name}`, import.meta.url));
  fs.writeFileSync(path.join(dir, revision, name), source);
  fs.writeFileSync(path.join(dir, 'sha256.json'), JSON.stringify({ [revision]: {
    [name]: createHash('sha256').update(source).digest('hex'),
  } }));
  fs.copyFileSync(new URL('./shu71-history.mjs', import.meta.url), path.join(root, 'history.mjs'));
  const { historicalSource: read } = await import(pathToFileURL(path.join(root, 'history.mjs')));
  assert.throws(() => read(revision, name), { code: 'SHU71_HISTORY_CONTROL_UNREGISTERED' },
    'SHU71_CONTROL_UNREGISTERED_VENDOR_REFUSED');
});
