import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile,unlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const http=new URL("../../../dist/apps/gateway/src/civil-id-suggestion-http.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/index.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-suggestion-http.test.js",import.meta.url));
const originals=new Map([[http,await readFile(http,"utf8")],[gateway,await readFile(gateway,"utf8")]]);
const cases=[
 ["OCRP_LINE","OCRP_LINE full civil ID must never render",http,'`a number ending ${esc(suggestion.last4)}`','`a number ending ${esc(suggestion.number)}`'],
 ["OCRP_LINE","OCRP_LINE expired suggestion must have no accept form",http,"if (suggestion.expired && suggestion.expiry)","if (false && suggestion.expiry)"],
 ["OCRP_ACCEPT","OCRP_ACCEPT one CIV save",http,"await service.civilId.save(","await (async()=>({ok:true}))("],
 ["OCRP_STALE","OCRP_STALE real CIV message",http,"if (!current || current.id !== id)","if (!current)"],
 ["OCRP_ACCEPT","OCRP_ACCEPT redirects",http,"`civil-id-suggestion:${id}`","`random-submission:${id}`"],
 ["OCRP_DISMISS","OCRP_DISMISS records dismissed",http,'service.store.resolve(id, principal, "dismissed"','service.store.resolve(id, principal, "accepted"'],
 ["OCRP_ORIGIN","OCRP_ORIGIN wrong origin rejected",http,'if (!request.headers.origin || !origin || request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site")',"if (false)"],
 ["OCRP_SECRECY","OCRP_SECRECY no number field",http,'name="suggestionId"','name="number"'],
 ["OCRP_SHOWN","OCRP_SHOWN exactly one suggestion read",gateway,"civilIdSuggestion = await login.civilIdSuggestion.current(requesterPrincipalId) ?? undefined;","civilIdSuggestion = (await login.civilIdSuggestion.current(requesterPrincipalId), await login.civilIdSuggestion.current(requesterPrincipalId)) ?? undefined;"],
];
function run(token,env={}){const r=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000,env:{...process.env,...env}});assert.equal(r.error,undefined,`${token} runner must execute`);return{...r,output:r.stdout+r.stderr};}
for(let i=0;i<cases.length;i++){const[token,message,source,from,to]=cases[i],original=originals.get(source);assert.equal(original.split(from).length-1,1,`${token} mutation anchor binds once: ${from}`);const target=new URL(`./${source===http?"civil-id-suggestion-http":"index"}-mutant-${process.pid}-${i}.js`,source),env={[source===http?"OCRP_HTTP_MODULE":"OCRP_GATEWAY_MODULE"]:target.href};try{const control=run(token);assert.equal(control.status,0,`${token} passing control\n${control.output}`);await writeFile(target,original.replace(from,to));const mutant=run(token,env);assert.notEqual(mutant.status,0,`${token} mutant survived\n${mutant.output}`);assert.match(mutant.output,/not ok/);assert.match(mutant.output,/AssertionError/);assert.match(mutant.output,new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${token} ${message}`);}finally{await unlink(target).catch(e=>{if(e.code!=="ENOENT")throw e});assert.equal(await readFile(source,"utf8"),original,`${token} original remains unchanged`);}}
