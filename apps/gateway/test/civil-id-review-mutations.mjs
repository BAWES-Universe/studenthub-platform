import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-review-http.test.js",import.meta.url)),original=await readFile(source,"utf8");
const mutants=[
 ["list a released or decided row","const list = await rt.store.listPending({ page, excludePrincipalId: viewer });","const list = await rt.store.listPending({ page, excludePrincipalId: viewer }); list.rows.push({principalId:'released-mutant',name:'released'});"],
 ["show the full number in the list","maskCivilId(r.country, rt.vault.open(r.principalId, r.country, r.sealedNumber))","rt.vault.open(r.principalId, r.country, r.sealedNumber)"],
 ["drop the own-row refusal","if (subject === viewer)","if (false)"],
 ["accept a reject without a reason","(!reason || reason.length > 300","(reason?.length > 300"],
 ["skip the revision check","p.revision !== row.revision","false"],
 ["clear needs_review without a decision","const result = await rt.store.decide(","const result = await rt.store.clearWithoutDecision("],
 ["skip the confirmation expiry","if ((rt.now ?? Date.now)() >= p.expires)","if (false)"],
 ["drop the Origin check","req.headers.origin !== rt.origin","false"],
 ["read the state twice","const list = await rt.store.listPending({ page, excludePrincipalId: viewer });","await rt.store.listPending({ page, excludePrincipalId: viewer }); const list = await rt.store.listPending({ page, excludePrincipalId: viewer });"],
];
const run=()=>spawnSync(process.execPath,[suite],{encoding:"utf8",timeout:30000});
try{const control=run();assert.equal(control.status,0,`civil review passing control\n${control.stdout}${control.stderr}`);for(const [name,needle,replacement] of mutants){assert.equal(original.split(needle).length-1,1,`${name} binds once`);await writeFile(source,original.replace(needle,replacement));const killed=run(),output=killed.stdout+killed.stderr;assert.notEqual(killed.status,0,`${name} mutant survived\n${output}`);if(output){assert.match(output,/not ok/);assert.match(output,/AssertionError|testCodeFailure/);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/)}console.log(`KILLED ${name}`);await writeFile(source,original)}}finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"original remains restored")}
