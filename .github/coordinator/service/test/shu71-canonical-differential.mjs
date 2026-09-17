// Repository-only reproductions: source and guard mutations stay in disposable copies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deltaMutants, deltaKiller } from './shu71-delta-mutants.mjs';
import { evidencePredicate } from './shu71-r8-mutants.mjs';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), SHU251_NO_SYSTEMD: '1' };
const witnesses = deltaMutants.filter(m => m.id.startsWith('X'));
const results = [];
for (const mutant of [{ id: 'CONTROL', bypass: 'false' }, ...witnesses, { id: 'GUARD_DELETED' }, { id: 'GUARD_WEAKENED' }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-canonical-'));
  try {
    const coordinator = path.join(root, '.github/coordinator');
    fs.cpSync(sourceRoot, coordinator, { recursive: true });
    const service = path.join(coordinator, 'service');
    const run = file => {
      const result = spawnSync(process.execPath, ['--test', file], { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
      return { result, counts };
    };
    if (mutant.bypass !== undefined) {
      const file = path.join(service, 'shu71-production.mjs');
      const source = fs.readFileSync(file, 'utf8');
      assert.equal(source.split(evidencePredicate).length, 2, 'CANONICAL_UNIQUE_MUTATION_SITE');
      fs.writeFileSync(file, source.replace(evidencePredicate, `(${mutant.bypass}) || (${evidencePredicate})`));
      // Drive each plant against the actual transplanted module, including CONTROL.
      fs.writeFileSync(path.join(service, 'test/canonical-probe.mjs'), `
import { test } from 'node:test';
import fs from 'node:fs';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { stateTransition } from './shu71-r8-state-model.mjs';
import { deltaMutants } from './shu71-delta-mutants.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource(), snapshots = [];
for (const m of deltaMutants.filter(m => ${JSON.stringify(mutant.id)} === 'CONTROL' ? m.id.startsWith('X') : m.id === ${JSON.stringify(mutant.id)})) test(m.id, async t => {
 const state = await stateTransition(createShu71Production, productionFixture(t, keys), { physical: 'armed', counter: 'exhausted', journal: 'intact', allowance: 'unconsumed' }, m.plant.transform);
 snapshots.push({ id: m.id, ...state });
 fs.writeFileSync('snapshots.json', JSON.stringify(snapshots));
});
`);
      const probe = run('.github/coordinator/service/test/canonical-probe.mjs');
      assert.equal(probe.result.status, 0, probe.result.stdout);
      const snapshots = JSON.parse(fs.readFileSync(path.join(root, 'snapshots.json'), 'utf8'));
      assert.equal(snapshots.length, mutant.id === 'CONTROL' ? 5 : 1);
      for (const snapshot of snapshots) assert.deepEqual(snapshot.after, {
        gates: Array(2).fill(`[Service]\nEnvironment=ENABLE_DISPATCH=${mutant.id === 'CONTROL' ? 'false' : 'true'}\n`),
        credential: mutant.id !== 'CONTROL', lease: true, effects: mutant.id === 'CONTROL' ? 7 : 0,
        code: mutant.id === 'CONTROL' ? 'ACT_RETRY_BUDGET_UNAVAILABLE' : 'ACT_RETRY_BUDGET_EXHAUSTED', complete: false,
      }, `${mutant.id}_${snapshot.id}_SNAPSHOT`);
      const { result, counts } = run('.github/coordinator/service/test/shu71-trust.test.mjs');
      const killer = mutant.id === 'CONTROL' ? null : deltaKiller(mutant);
      assert.equal(result.status, killer ? 1 : 0, result.stdout + result.stderr);
      assert.equal(counts.fail, killer ? 1 : 0);
      if (killer) assert.ok(result.stdout.includes(killer), 'CANONICAL_NAMED_KILL');
      results.push({ id: mutant.id, counts, killer, snapshots });
    } else {
      const file = path.join(service, 'test/shu71-delta-properties.mjs');
      const source = fs.readFileSync(file, 'utf8');
      const start = source.indexOf("  const name = 'SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_CANONICAL_READ_ATTEMPTS_ONLY';");
      const end = source.indexOf('\n}', start);
      assert.ok(start >= 0 && end > start);
      const oldGuard = "  const reads = [...prefix.matchAll(/JSON\\.parse\\(privateRead\\(`\\$\\{dir\\}\\/automatic-teardown\\.json`\\)\\)([^;\\n]*)/g)];\n  assert.deepEqual(reads.map(m => m[1].trim()), ['.attempts'], 'SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_CANONICAL_READ_ATTEMPTS_ONLY');";
      fs.writeFileSync(file, source.slice(0, start) + (mutant.id === 'GUARD_WEAKENED' ? oldGuard : '') + source.slice(end));
      const { result, counts } = run('.github/coordinator/service/test/shu71-delta-mutations.test.mjs');
      assert.equal(result.status, 1);
      for (const m of witnesses) assert.ok(result.stdout.includes(`${m.id}_MUST_DIE_BY_NAME`), `${mutant.id}_${m.id}_NON_VACUOUS`);
      results.push({ id: mutant.id, counts, killers: witnesses.map(m => `${m.id}_MUST_DIE_BY_NAME`) });
    }
    console.log(JSON.stringify(results.at(-1)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
