import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile,writeFile,unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const httpSource=new URL("../../../dist/apps/gateway/src/civil-id-suggestion-http.js",import.meta.url),gatewaySource=new URL("../../../dist/apps/gateway/src/index.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-suggestion-http.test.js",import.meta.url));
const originals=new Map([[httpSource.href,await readFile(httpSource,"utf8")],[gatewaySource.href,await readFile(gatewaySource,"utf8")]]);
const mutations=[
 ["OCRP_LINE",httpSource,"const details = [",'const details = ["290010101234",'],
 ["OCRP_LINE",httpSource,"if (suggestion.expired && suggestion.expiry)","if (false && suggestion.expired && suggestion.expiry)"],
 ["OCRP_ACCEPT",httpSource,"await civilId.save(","await ({save:async()=>({ok:true})}).save("],
 ["OCRP_STALE",httpSource,"current.id !== id","current.id === id"],
 ["OCRP_STALE",httpSource,"submissionId, revision:",'submissionId:"random", revision:'],
 ["OCRP_DISMISS",httpSource,'suggestion.resolve(id, principalId, "dismissed")','civilId.save({principalId,submissionId,revision:0,country:"KW",number:"290010101234"})'],
 ["OCRP_ORIGIN",httpSource,"request.headers.origin !== origin","false"],
 ["OCRP_SECRECY",httpSource,'name="suggestionId" value="${escapeHtml(suggestion.id)}"','name="suggestionId" value="${escapeHtml(suggestion.id)}290010101234"'],
 ["OCRP_SEAM",gatewaySource,"civilIdSuggestion.current(authorizedProfilePersonId)","civilIdSuggestion.current(authorizedProfilePersonId).then(async value => { await login.civilIdSuggestion.current(authorizedProfilePersonId); return value; })"],
];
function run(token,module,kind="http"){const key=kind==="gateway"?"OCRP_GATEWAY_MODULE":"OCRP_MODULE";return spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000,env:{...process.env,[key]:module}});}
for(let i=0;i<mutations.length;i++){const [token,source,needle,replacement]=mutations[i],original=originals.get(source.href),target=new URL(`../../../dist/apps/gateway/src/civil-id-suggestion-mutant-${process.pid}-${i}.js`,import.meta.url),kind=source.href===gatewaySource.href?"gateway":"http";assert.equal(original.split(needle).length-1,1,`${token} binding exactly once`);try{const control=run(token,source.href,kind),controlOutput=control.stdout+control.stderr;assert.equal(control.status,0,`${token} control passes\n${controlOutput}`);await writeFile(target,original.replace(needle,replacement));const mutant=run(token,target.href,kind),output=mutant.stdout+mutant.stderr;assert.notEqual(mutant.status,0,`${token} mutant survived\n${output}`);assert.match(output,new RegExp(`not ok \\d+ - ${token}`),`${token} status=${mutant.status} signal=${mutant.signal} error=${mutant.error}\n${output}`);assert.match(output,/AssertionError/);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${token} ${i+1}`);}finally{await unlink(target).catch(error=>{if(error.code!=="ENOENT")throw error;});assert.equal(await readFile(source,"utf8"),original,"original remains unchanged");}}
