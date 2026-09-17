// Repository-only reproduction; production mutations exist only in disposable copies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finalMutants } from './shu71-final-mutants.mjs';
import { evidencePredicate } from './shu71-r8-mutants.mjs';
import { exhaustedVariants, invariantName } from './shu71-exhausted-invariants.mjs';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
for (const mutant of [{ id: 'CONTROL', bypass: 'false' }, ...finalMutants]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-final-'));
  try {
    fs.cpSync(sourceRoot, path.join(root, '.github/coordinator'), { recursive: true });
    const file = path.join(root, '.github/coordinator/service/shu71-production.mjs');
    const source = fs.readFileSync(file, 'utf8');
    if (source.split(evidencePredicate).length !== 2) throw Error('FINAL_UNIQUE_MUTATION_SITE');
    fs.writeFileSync(file, source.replace(evidencePredicate, `(${mutant.bypass}) || (${evidencePredicate})`));
    const result = spawnSync(process.execPath, ['--test', '.github/coordinator/service/test/shu71-trust.test.mjs'],
      { cwd: root, env: { ...env, SHU251_NO_SYSTEMD: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
    const name = mutant.id === 'CONTROL' ? null : invariantName(exhaustedVariants[mutant.variant]);
    const snapshots = result.stdout.split('\n').filter(line => line.startsWith('# {"variant":'))
      .map(line => JSON.parse(line.slice(2).replaceAll('\\\\', '\\')));
    const killed = result.status === 1 && counts.fail === 1 && result.stdout.includes(name);
    console.log(JSON.stringify({ id: mutant.id, status: result.status, counts, assertion: name, killed, snapshots }));
    if (mutant.id === 'CONTROL' ? result.status !== 0 : !killed) {
      process.stderr.write(result.stdout + result.stderr);
      process.exitCode = 1;
      break; // A survivor is a model finding; do not add a shape-specific test.
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
