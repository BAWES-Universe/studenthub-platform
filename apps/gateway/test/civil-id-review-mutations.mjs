import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url);
const suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-review-http.test.js",import.meta.url));
const original=await readFile(source,"utf8");
const mutants=[
 ["REV_QUEUE","show the full number in the list","number: maskCivilId(r.country, s.vault.open(r.principalId, r.country, r.numberCiphertext))","number: s.vault.open(r.principalId, r.country, r.numberCiphertext)"],
 ["REV_STAFF","drop the own-row refusal","if (subject === who.principalId)","if (false && subject === who.principalId)"],
 ["REV_DECIDE","accept a reject without a reason","(!reason || reason.length > 300","(false || reason.length > 300"],
 ["REV_DECIDE","skip the revision check","revision !== current.revision","false"],
 ["REV_DECIDE","skip the confirmation expiry","(s.now?.() ?? new Date()).getTime() >= claim.expires","false"],
 ["REV_ORIGIN","drop the Origin check","req.headers.origin !== s.origin","false"],
];
function run(token){const r=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000});assert.equal(r.error,undefined,`${token} runner executes`);return{...r,output:r.stdout+r.stderr};}
try{
 for(const [token,name,needle,replacement] of mutants){
  assert.equal(original.split(needle).length-1,1,`${name} mutation binding`);
  await writeFile(source,original.replace(needle,replacement));
  const mutant=run(token);
  assert.notEqual(mutant.status,0,`${name} mutant survived\n${mutant.output}`);
  assert.match(mutant.output,/not ok/);assert.match(mutant.output,/AssertionError/);
  assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/);
  await writeFile(source,original);
  const control=run(token);assert.equal(control.status,0,`${token} control passes\n${control.output}`);
  console.log(`KILLED ${token} ${name}`);
 }
}finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"civil ID review original restored");}
