import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const http=new URL("../../../dist/apps/gateway/src/civil-id-suggestion-http.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/index.js",import.meta.url),webUi=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-suggestion-http.test.js",import.meta.url));
const originals=new Map([[http,await readFile(http,"utf8")],[gateway,await readFile(gateway,"utf8")],[webUi,await readFile(webUi,"utf8")]]);
const cases=[
 ["OCRP_LINE","OCRP_LINE full civil ID must never render",http,'`a number ending ${esc(suggestion.last4)}`','`a number ending 123456781234`'],
 ["OCRP_LINE","OCRP_LINE expired suggestion must have no accept form",http,"if (suggestion.expired && suggestion.expiry)","if (false && suggestion.expiry)"],
 ["OCRP_ACCEPT","OCRP_ACCEPT one CIV save",http,"await service.civilId.save(","await (async()=>({ok:true}))("],
 ["OCRP_STALE","OCRP_STALE retry redirects",http,"if (!current || current.id !== id)","if (!current || current.id === id)"],
 ["OCRP_STALE","OCRP_STALE submission id is derived",http,"`civil-id-suggestion:${id}`","`random-submission:${id}`"],
 ["OCRP_DISMISS","OCRP_DISMISS no civil write",http,'if(how==="dismissed"){await service.store.resolve(id,principal,"dismissed",service.now().toISOString());','if(how==="dismissed"){const own=await service.civilId.readOwn(principal);await service.civilId.save({principalId:principal,submissionId:submitted,revision:own?.revision??0,expiry:current.expiry??undefined});await service.store.resolve(id,principal,"dismissed",service.now().toISOString());'],
 ["OCRP_ORIGIN","OCRP_ORIGIN wrong origin rejected",http,'if (!request.headers.origin || !origin || request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site")',"if (false)"],
 ["OCRP_LINE","OCRP_LINE suggestion id only",http,'name="suggestionId"','name="number"'],
 ["OCRP_SHOWN","OCRP_SHOWN exactly one suggestion read",gateway,"civilIdSuggestion = await login.civilIdSuggestion.current(requesterPrincipalId) ?? undefined;","civilIdSuggestion = (await login.civilIdSuggestion.current(requesterPrincipalId), await login.civilIdSuggestion.current(requesterPrincipalId)) ?? undefined;"],
 ["OCRP_PLACE","OCRP_PLACE one suggestion row",webUi,"renderCivilIdSuggestion(language, civilIdSuggestion)","renderCivilIdSuggestion(language, civilIdSuggestion) + renderCivilIdSuggestion(language, civilIdSuggestion)"],
];
function run(token,env={}){const r=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000,env:{...process.env,...env}});assert.equal(r.error,undefined,`${token} runner must execute`);return{...r,output:r.stdout+r.stderr};}
for(const[token,message,source,from,to]of cases){const original=originals.get(source);assert.equal(original.split(from).length-1,1,`${token} mutation anchor binds once: ${from}`);try{const control=run(token);assert.equal(control.status,0,`${token} passing control\n${control.output}`);await writeFile(source,original.replace(from,to));const mutant=run(token);assert.notEqual(mutant.status,0,`${token} mutant survived\n${mutant.output}`);assert.match(mutant.output,/not ok/);assert.match(mutant.output,/AssertionError/);assert.match(mutant.output,new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${token} ${message}`);}finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,`${token} original remains unchanged`);}}
