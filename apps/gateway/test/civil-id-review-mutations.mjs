import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const reviewSource=new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url);
const indexSource=new URL("../../../dist/apps/gateway/src/index.js",import.meta.url);
const suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-review-http.test.js",import.meta.url));
const originals=new Map([[reviewSource,await readFile(reviewSource,"utf8")],[indexSource,await readFile(indexSource,"utf8")]]);
const mutants=[
 [reviewSource,"REV_QUEUE","list a released or decided row","const rows = await s.store.listPending({ page, excludePrincipalId: who.principalId });","const rows = [...await s.store.listPending({ page, excludePrincipalId: who.principalId }), ...await s.store.listPending({ page, excludePrincipalId: who.principalId })];"],
 [reviewSource,"REV_QUEUE","show the full number in the list","number: maskCivilId(r.country, s.vault.open(r.principalId, r.country, r.numberCiphertext))","number: s.vault.open(r.principalId, r.country, r.numberCiphertext)"],
 [reviewSource,"REV_STAFF","drop the own-row refusal","if (subject === who.principalId)","if (false && subject === who.principalId)"],
 [reviewSource,"REV_DECIDE","accept a reject without a reason","(!reason || reason.length > 300","(false || reason.length > 300"],
 [reviewSource,"REV_DECIDE","skip the revision check","revision !== current.revision","false"],
 [reviewSource,"REV_DECIDE","clear needs_review without a decision","const out = await s.store.decide({ subjectPrincipalId: subject, reviewerPrincipalId: who.principalId, decision: claim.decision, reason: claim.reason, revision: claim.revision, frontVersion: claim.front, backVersion: claim.back, confirmRef });","const out = { ok: true };"],
 [reviewSource,"REV_DECIDE","skip the confirmation expiry","(s.now?.() ?? new Date()).getTime() >= claim.expires","false"],
 [reviewSource,"REV_ORIGIN","drop the Origin check","req.headers.origin !== s.origin","false"],
 [indexSource,"REV_PERSON","read the state twice","civilReviewState = await login.civilIdReview?.store.stateFor(requesterPrincipalId);","civilReviewState = await login.civilIdReview?.store.stateFor(requesterPrincipalId); await login.civilIdReview?.store.stateFor(requesterPrincipalId);"],
];
function run(token){const r=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000});assert.equal(r.error,undefined,`${token} runner executes`);return{...r,output:r.stdout+r.stderr};}
try{
 for(const [source,token,name,needle,replacement] of mutants){const original=originals.get(source);
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
}finally{for(const[source,original]of originals){await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"civil ID review original restored");}}
