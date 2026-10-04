// Local-only reproduction: disposable coordinator copies and filesystem/API doubles.
// Optional argv[2] selects a historical trust test via local Git (e.g. 33f0436).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demonstratedMutants, evidencePredicate, loadMutant } from './shu71-r8-mutants.mjs';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { stateTransition, stateName } from './shu71-r8-state-model.mjs';
const keys = ephemeralPublicSource();
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
const trustPath = '.github/coordinator/service/test/shu71-trust.test.mjs';
const baseline = process.argv[2];
for (const m of demonstratedMutants) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-r8-differential-'));
  try {
    fs.cpSync(path.join(repo, '.github/coordinator'), path.join(tmp, '.github/coordinator'), { recursive: true });
    if (baseline) fs.writeFileSync(path.join(tmp, trustPath), execFileSync('git', ['show', `${baseline}:${trustPath}`], { cwd: repo }));
    const file = path.join(tmp, '.github/coordinator/service/shu71-production.mjs');
    const source = fs.readFileSync(file, 'utf8');
    if (source.split(evidencePredicate).length !== 2) throw Error('B4_R8_UNIQUE_MUTATION_SITE');
    fs.writeFileSync(file, source.replace(evidencePredicate, `(${m.bypass}) || (${evidencePredicate})`));
    const r = spawnSync(process.execPath, ['--test', trustPath], { cwd: tmp,
      env: { ...process.env, GIT_DIR: gitDir, SHU251_NO_SYSTEMD: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const counts = Object.fromEntries([...r.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
    const assertions = [...new Set(r.stdout.match(/B4_R8_STATE_[A-Z0-9_]+/g) ?? [])];
    const cleanups = [], t = { after: f => cleanups.push(f) };
    let snapshots;
    try {
      const mutant = await loadMutant(t, m);
      const candidate = await stateTransition(createShu71Production, productionFixture(t, keys), m.witness);
      const changed = await stateTransition(mutant, productionFixture(t, keys), m.witness);
      snapshots = { before: candidate.before, candidate: candidate.after, mutant: changed.after };
    } finally { cleanups.forEach(f => f()); }
    console.log(JSON.stringify({ id: m.id, baseline: baseline ?? 'current', status: r.status, ...counts, assertions,
      witness_assertion: `B4_R8_STATE_${stateName(m.witness)}`, snapshots }));
    if (baseline ? r.status !== 0 || counts.tests !== 105 : r.status !== 1 || !assertions.length) {
      process.stderr.write(r.stderr); process.exitCode = 1;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
