import assert from "node:assert/strict";
import{spawnSync}from"node:child_process";
import{readFile,writeFile}from"node:fs/promises";
import{fileURLToPath}from"node:url";
const http=new URL("../../../dist/apps/gateway/src/civil-id-suggestion-http.js",import.meta.url),web=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),index=new URL("../../../dist/apps/gateway/src/index.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-suggestion-http.test.js",import.meta.url));
const originals=new Map([[http,await readFile(http,"utf8")],[web,await readFile(web,"utf8")],[index,await readFile(index,"utf8")]]);
const mutants=[
 ["OCRP_LINE",http,'`a number ending ${esc(suggestion.last4)}`','`a number ending 290010101234`',"OCRP_LINE full number absent","render full number"],
 ["OCRP_LINE",http,'if (suggestion.expired)','if (false)',"OCRP_LINE expired has no accept","accept expired date"],
 ["OCRP_ACCEPT",http,'const saved = await service.civilId.save(', 'const saved = await (async () => ({ok:true}))(',"OCRP_ACCEPT saved masked value","bypass CIV"],
 ["OCRP_STALE",http,'if (!current || current.id !== id) {','if (false) {',"OCRP_STALE current suggestion required","skip current check"],
 ["OCRP_STALE",http,'submissionId: submissionId(id),','submissionId: "33333333-3333-4333-8333-"+Math.random().toString().slice(2,14),',"OCRP_STALE one CIV write","random submission id"],
 ["OCRP_DISMISS",http,'await service.resolve(id, principal, "dismissed");','await service.civilId.save({principalId:principal,submissionId:submissionId(id),revision:0,country:current.country,expiry:current.expiry??undefined}); await service.resolve(id, principal, "dismissed");',"OCRP_DISMISS no CIV write","dismiss writes civil ID"],
 ["OCRP_ORIGIN",http,'request.headers["sec-fetch-site"] === "cross-site"','false',"OCRP_ORIGIN statuses","skip Origin gate"],
 ["OCRP_SECRECY",http,'const hidden = `<input type="hidden" name="suggestionId" value="${esc(suggestion.id)}">`;','const hidden = `<input type="hidden" name="number" value="290010101234"><input type="hidden" name="suggestionId" value="${esc(suggestion.id)}">`;',"OCRP_SECRECY plain number absent","number hidden field"],
 ["OCRP_SHOWN",index,'civilIdSuggestion = await login.civilIdSuggestion?.current(requesterPrincipalId);','civilIdSuggestion = await login.civilIdSuggestion?.current(requesterPrincipalId); await login.civilIdSuggestion?.current(requesterPrincipalId);',"OCRP_SHOWN one read","read suggestion twice"],
];
function run(token){return spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000});}
try{for(const[token,file,needle,replacement,message,label]of mutants){const original=originals.get(file);assert.equal(original.split(needle).length-1,1,`${label} needle binds once`);const control=run(token),controlOut=control.stdout+control.stderr;assert.equal(control.status,0,`${token} control passes\n${controlOut}`);await writeFile(file,original.replace(needle,replacement));const result=run(token),output=result.stdout+result.stderr;assert.notEqual(result.status,0,`${label} mutant survived\n${output}`);assert.match(output,/not ok/);assert.match(output,/AssertionError/);assert.match(output,new RegExp(message));assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${token} ${label}`);await writeFile(file,original);}}
finally{for(const[file,original]of originals){await writeFile(file,original);assert.equal(await readFile(file,"utf8"),original,"compiled original restored");}}
