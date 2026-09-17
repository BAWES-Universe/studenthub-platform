// Standalone rechecks of the verifier's independent mutation sites. Every
// mutant runs genuine trust assertions, never a mutation harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {cwd: repo, encoding: 'utf8'}).trim();
const cases = [
 ['MX-P1','production','        observeTeardown();\n        command','        command',true],
 ['MX1','production','attempts >= 32','attempts >= 1000000000',true],
 ['MX2','production','else atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: attempts + 1 }));','else {}',true],
 ['MX5','production',"expired ? 'expiry' : 'revoke', action === 'expire'","expired ? 'expiry' : 'revoke', false",true],
 ['MX6','production',"'recovery', action === 'expire'","'recovery', false",true],
 ['MX7','production',' && attempts <= 32','',true],
 ['MX10','journal','effect, repeat);',"effect, repeat && step !== 'activation');",true],
 ['MX11','journal'," || step.startsWith('stop-')"," || step.startsWith('restore-') || step.startsWith('stop-')",true],
 ['MX12','journal'," || step.startsWith('stop-')"," || step === 'archive' || step.startsWith('stop-')",true],
 ['MX3','production','let exhausted = false;','if (!automatic) remove(`${dir}/automatic-teardown.json`);\n    let exhausted = false;',true],
 ['MX13','journal',"'activation', 'workers', 'reload'","'activation', 'reload'",false],
 ['MX14','journal',"'workers', 'reload', 'evidence-broker'","'workers', 'evidence-broker'",false],
];
for (const [id, target, before, after, kill] of cases) {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'shu71-r4-mx-'));
 try {
  fs.cpSync(path.join(repo,'.github/coordinator'),path.join(tmp,'.github/coordinator'),{recursive:true});
  const file=path.join(tmp,`.github/coordinator/service/shu71-${target}.mjs`);
  const source=fs.readFileSync(file,'utf8');
  if(source.split(before).length!==2) throw new Error(`${id}: non-unique mutation`);
  fs.writeFileSync(file,source.replace(before,after));
  const result=spawnSync(process.execPath,['--test','.github/coordinator/service/test/shu71-trust.test.mjs'],{cwd:tmp,env:{...process.env,GIT_DIR:gitDir,SHU251_NO_SYSTEMD:'1'},encoding:'utf8'});
  const assertions=[...new Set(result.stdout.match(/B4_[A-Z0-9_]+/g)??[])];
  const counts=Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
  console.log(JSON.stringify({id,status:result.status,assertions,...counts,expected:kill?'killed':'survived'}));
  if(kill ? result.status===0 || !assertions.length : result.status!==0) process.exitCode=1;
 } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
