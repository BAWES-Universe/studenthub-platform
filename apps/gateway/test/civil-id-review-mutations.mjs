import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist=new URL("../../../dist/apps/gateway/",import.meta.url),http=new URL("src/civil-id-review-http.js",dist),wiring=new URL("src/wiring/profile.js",dist);
const suite=fileURLToPath(new URL("test/civil-id-review-http.test.js",dist)),hook=new URL("./helpers/swap-module.mjs",import.meta.url).href;
const cases=[
 ["show the full number in the queue","REV_QUEUE queue masks","REV_QUEUE queue omits full number",http,"number = maskCivilId(r.country, opened)","number = opened"],
 ["drop the own-row refusal","REV_STAFF own Civil ID","REV_STAFF own-row open is 403",http,"if (person === principal)","if (false)"],
 ["drop scope subtree from isStaff","REV_STAFF production gate","REV_STAFF isStaff requires subtree scope",wiring,'grant.scope === "subtree"','true'],
 ["accept a reject without a reason","REV_DECIDE reject requires","REV_DECIDE reject without reason is refused",http,'(!reason || [...reason].length > 300','(false || [...reason].length > 300'],
 ["skip the revision check","REV_DECIDE stale revision","REV_DECIDE stale revision is refused",http,"claim.revision !== row.revision","false"],
 ["skip the confirmation expiry","REV_DECIDE expired confirmation","REV_DECIDE expired confirmation is refused",http,"claim.expiresAt <= (service.now ?? (() => new Date()))().getTime()","false"],
 ["drop the Origin check","REV_ORIGIN both decision","REV_ORIGIN wrong Origin is 403",http,"req.headers.origin !== service.origin","false"],
];
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function run(prefix,swaps){const register=`import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;const result=spawnSync(process.execPath,["--import",`data:text/javascript,${encodeURIComponent(register)}`,"--test","--test-reporter=tap",`--test-name-pattern=^${escape(prefix)}`,suite],{encoding:"utf8",timeout:60000});assert.equal(result.error,undefined,`${prefix} runner must execute`);return {...result,output:result.stdout+result.stderr}}
for(const [item,prefix,message,source,from,to] of cases){const original=await readFile(source,"utf8");assert.equal(original.split(from).length-1,1,`${item}: needle binds exactly once`);const target=new URL(source.href.replace(/\.js$/,`-mutant-${process.pid}.js`));try{const control=run(prefix,{});assert.equal(control.status,0,`${item}: unmutated control passes\n${control.output}`);assert.match(control.output,new RegExp(`\\nok \\d+ - ${escape(prefix)}`),`${item}: control ran named test`);await writeFile(target,original.replace(from,to));const mutant=run(prefix,{[source.href]:target.href});assert.notEqual(mutant.status,0,`${item}: mutant survived\n${mutant.output}`);assert.match(mutant.output,new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`),`${item}: named test fails`);assert.match(mutant.output,/name: 'AssertionError'/,`${item}: dies by AssertionError`);assert.match(mutant.output,new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`),`${item}: dies on ${message}`);assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/,`${item}: mutant loads`);console.log(`KILLED ${item} -> ${message}`)}finally{await unlink(target).catch(e=>{if(e.code!=="ENOENT")throw e});assert.equal(await readFile(source,"utf8"),original,`${item}: compiled file unchanged`)}}
console.log(`${cases.length}/${cases.length} civil ID review mutants killed`);
