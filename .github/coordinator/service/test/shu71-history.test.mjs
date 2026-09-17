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
  fs.writeFileSync(path.join(dir, '../shu71-production.mjs'), 'historical bytes');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'historical fixture']);
  const revision = git(['rev-parse', 'HEAD']).toString().trim();
  const fixtures = path.join(dir, 'fixtures/shu71-history');
  fs.mkdirSync(path.join(fixtures, revision), { recursive: true });
  const file = path.join(fixtures, revision, 'shu71-production.mjs');
  const record = bytes => fs.writeFileSync(path.join(fixtures, 'sha256.json'), JSON.stringify({ [revision]: {
    'shu71-production.mjs': createHash('sha256').update(bytes).digest('hex')
  } }));
  fs.writeFileSync(file, 'historical bytes'); record('historical bytes');
  const { historicalSource: read } = await import(pathToFileURL(path.join(dir, 'shu71-history.mjs')));
  assert.equal(read(revision, 'shu71-production.mjs'), 'historical bytes');
  fs.writeFileSync(file, 'drift');
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_DIGEST_MISMATCH' });
  record('drift');
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_GIT_MISMATCH' });
  fs.rmSync(file);
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_FIXTURE_MISSING' });
});

import { controlContent, controlRevisions } from './shu71-history.mjs';
import { historicalProduction, gates } from './shu71-r5-checks.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
for (const [index, revision] of controlRevisions.entries()) {
  test(`historical control semantics: ${revision} reservation and fault ordering`, async t => {
    // Load both real vendored modules. Execute the properties behind the source
    // guard so its assumptions are independently checked on disposable boundaries.
    const production = await historicalProduction(t, revision);
    const h = productionFixture(t, keys), create = () => production(h.id, h.boundary);
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
    const fault = productionFixture(t, keys);
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
