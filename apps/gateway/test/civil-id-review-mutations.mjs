import assert from "node:assert/strict";
import{spawnSync}from"node:child_process";import{readFile,writeFile,unlink}from"node:fs/promises";import{fileURLToPath}from"node:url";
const source=new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-review-http.test.js",import.meta.url)),original=await readFile(source,"utf8");
const cases=[
 ["list a released or decided row","REV_QUEUE","const rows = await s.store.listPending({ page, excludePrincipalId: a.id });","const rows = [];"],
 ["show the full number in the list","REV_QUEUE","number: maskCivilId(x.country, s.vault.open(x.principalId, x.country, x.numberCiphertext))","number: s.vault.open(x.principalId, x.country, x.numberCiphertext)"],
 ["drop the own-row refusal","REV_STAFF","if (subject === a.id) {","if (false && subject === a.id) {"],
 ["accept a reject without a reason","REV_DECIDE","reason.length < 1 || reason.length > 300","reason.length > 300"],
 ["skip the revision check","REV_DECIDE","revision !== row.revision || (decision !==","false || (decision !=="],
 ["clear needs_review without a decision","REV_DECIDE","const result = await s.store.decide({","const result = \"decided\"; void ({ "],
 ["skip the confirmation expiry","REV_DECIDE","c.exp <= (s.now?.() ?? Date.now())","false"],
 ["drop the Origin check","REV_ORIGIN","r.headers.origin !== s.origin || r.headers[\"sec-fetch-site\"] === \"cross-site\"","false || r.headers[\"sec-fetch-site\"] === \"cross-site\""],
 ["read the state twice","REV_QUEUE","const rows = await s.store.listPending({ page, excludePrincipalId: a.id });","await s.store.listPending({ page, excludePrincipalId: a.id }); const rows = await s.store.listPending({ page, excludePrincipalId: a.id });"],
];
function run(module,token){return spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000,env:{...process.env,SHU600_REVIEW_MODULE:module}})}
for(const [name,token,needle,replacement]of cases){assert.equal(original.split(needle).length-1,1,`${name} compiled needle binds once`);const target=new URL(`../../../dist/apps/gateway/src/civil-id-review-mutant-${process.pid}.js?case=${encodeURIComponent(name)}`,import.meta.url),file=new URL(target.href.split("?")[0]);try{const control=run(source.href,token);assert.equal(control.status,0,`${name} control passes\n${control.stdout}${control.stderr}`);await writeFile(file,original.replace(needle,replacement));const mutant=run(target.href,token),output=mutant.stdout+mutant.stderr;assert.notEqual(mutant.status,0,`${name} mutant survived\n${output}`);assert.match(output,/not ok/);assert.match(output,/AssertionError|ERR_ASSERTION/);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${name}`)}finally{await unlink(file).catch(e=>{if(e.code!=="ENOENT")throw e});assert.equal(await readFile(source,"utf8"),original)}}
