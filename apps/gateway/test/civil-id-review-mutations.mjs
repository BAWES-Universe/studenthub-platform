import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const dist=new URL("../../../dist/apps/gateway/",import.meta.url),source=new URL("src/civil-id-review-http.js",dist),suite=fileURLToPath(new URL("test/civil-id-review-http.test.js",dist)),hook=new URL("./helpers/swap-module.mjs",import.meta.url).href;
const cases=[
 ["show full number in queue","REV_QUEUE","REV_QUEUE queue omits full number",'number = maskCivilId(r.country, s.vault.open(r.principalId, r.country, r.numberCiphertext));','number = s.vault.open(r.principalId, r.country, r.numberCiphertext);'],
 ["drop own-row refusal","REV_STAFF","REV_STAFF own row refused",'if (id === principal) {','if (false) {'],
 ["drop subtree scope","REV_STAFF","REV_STAFF self scope is not staff",'&& g.scope === "subtree"',''],
 ["accept reject without reason","REV_DECIDE","REV_DECIDE reject reason required",'[...reason].length < 1','[...reason].length < 0'],
 ["skip revision check","REV_DECIDE","REV_DECIDE stale revision refused",'claim.revision !== row.revision','(claim.revision = row.revision, false)'],
 ["skip confirmation expiry","REV_DECIDE","REV_DECIDE expired confirmation refused",'now >= claim.expires','false'],
 ["drop Origin check","REV_ORIGIN","REV_ORIGIN wrong origin denied",'req.headers.origin !== origin','false'],
];
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function run(prefix,swaps){const register=`import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;const r=spawnSync(process.execPath,["--import",`data:text/javascript,${encodeURIComponent(register)}`,"--test","--test-reporter=tap",`--test-name-pattern=^${escape(prefix)}`,suite],{encoding:"utf8",timeout:60000});assert.equal(r.error,undefined,`${prefix} runner must execute`);return {...r,output:r.stdout+r.stderr}}
for(const [name,prefix,message,from,to] of cases){const original=await readFile(source,"utf8");assert.equal(original.split(from).length-1,1,`${name}: needle binds exactly once`);const target=new URL(source.href.replace(/\.js$/,`-mutant-${process.pid}.js`));try{const control=run(prefix,{});assert.equal(control.status,0,`${name}: unmutated control passes\n${control.output}`);assert.match(control.output,new RegExp(`\\nok \\d+ - ${escape(prefix)}`),`${name}: control ran named test`);await writeFile(target,original.replace(from,to));const mutant=run(prefix,{[source.href]:target.href});assert.notEqual(mutant.status,0,`${name}: mutant survived\n${mutant.output}`);assert.match(mutant.output,new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`),`${name}: named test fails`);assert.match(mutant.output,/name: 'AssertionError'/,`${name}: AssertionError`);assert.match(mutant.output,new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`),`${name}: own assertion message`);assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/,`${name}: mutant loads`)}finally{await unlink(target).catch(e=>{if(e.code!=="ENOENT")throw e});assert.equal(await readFile(source,"utf8"),original,`${name}: dist unchanged`)}}
console.log(`${cases.length}/${cases.length} civil ID review mutants killed`);
