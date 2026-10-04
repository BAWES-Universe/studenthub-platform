// Recheck the R5 verifier's MY1–MY7 sites against genuine trust assertions.
// MY5 follows the allowance guard to its new journal-backed location.
// MY3/MY7 are the verifier's redundant-observation survivors, not kill claims.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('../../../../', import.meta.url));
const gitDir=execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:repo,encoding:'utf8'}).trim();
const cases=[
 ['MY1 fallback disarms only the first gate','production','const failures = [];\n        for (const file of GATES) {','const failures = [];\n        for (const file of GATES.slice(0, 1)) {'],
 ['MY2 fallback writes the ARMED value','production',"catch { failures.push('ACT_TEARDOWN_GATE'); }","catch { failures.push('ACT_TEARDOWN_GATE'); }\n          try { atomic(file, '[Service]\\nEnvironment=ENABLE_DISPATCH=true\\n', 0, 0, 0o644); } catch {}"],
 ['MY3 settlement pre-check observeGateFiles deleted','production','        observeGateFiles();\n        need(effects.filter','        need(effects.filter'],
 ['MY4 settlement ignores an unfinished remote restore','production',"!['observation', 'expiry-timer'].includes(step))","!['observation', 'expiry-timer', 'restore-shu-140'].includes(step))"],
 ['MY5 settlement allowance never checked','production',"if (journal.entries.some(e => e.event === 'SETTLEMENT_STARTED')) return refusal;",'if (false) return refusal;'],
 ['MY6 settlement releases the lease unconditionally','production','if (result.ok) remove(`${ROOT}/active.json`);','remove(`${ROOT}/active.json`);'],
 ['MY7 exhausted settlement skips the final observation','production',"effects.filter(([step]) => ['observation', 'expiry-timer'].includes(step))","effects.filter(([step]) => ['expiry-timer'].includes(step))"],
];
for (const [id,target,before,after] of cases) {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'r5my-'));
 try {
  fs.cpSync(path.join(repo,'.github/coordinator'),path.join(tmp,'.github/coordinator'),{recursive:true});
  const file=path.join(tmp,`.github/coordinator/service/shu71-${target}.mjs`);
  const src=fs.readFileSync(file,'utf8');
  if(src.split(before).length!==2){console.log(JSON.stringify({id,error:'non-unique or absent mutation site',occurrences:src.split(before).length-1}));process.exitCode=1;continue;}
  fs.writeFileSync(file,src.replace(before,after));
  const r=spawnSync(process.execPath,['--test','.github/coordinator/service/test/shu71-trust.test.mjs'],{cwd:tmp,env:{...process.env,GIT_DIR:gitDir,SHU251_NO_SYSTEMD:'1'},encoding:'utf8'});
  const a=[...new Set(r.stdout.match(/B4_[A-Z0-9_]+/g)??[])];
  const c=Object.fromEntries([...r.stdout.matchAll(/^# (tests|pass|fail) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
  console.log(JSON.stringify({id,verdict:r.status!==0?'KILLED':'SURVIVED',assertions:a,...c}));
  const expectedSurvivor = /^MY[37] /.test(id);
  if (expectedSurvivor ? r.status !== 0 : r.status === 0 || !a.length) process.exitCode=1;
 } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
