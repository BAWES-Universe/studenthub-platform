import assert from"node:assert/strict";import{spawnSync}from"node:child_process";import{readFile,writeFile}from"node:fs/promises";import{fileURLToPath}from"node:url";
const source=new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-review-http.test.js",import.meta.url)),original=await readFile(source,"utf8");
const mutants=[
 ["REV_QUEUE","maskedNumber: masked","maskedNumber: r.vault.open(row.principal_id, row.country, row.number_ciphertext)","secret-free"],
 ["REV_STAFF","if (subject === who)","if (false && subject === who)","own rows forbidden"],
 ["REV_DECIDE","!reason || reason.length > 300","false || reason.length > 300","preview submits"],
 ["REV_DECIDE","revision !== row.revision","false && revision !== row.revision","preview submits"],
 ["REV_DECIDE","(r.now ?? Date.now)() >= c.expiresAt","false && (r.now ?? Date.now)() >= c.expiresAt","preview submits"],
 ["REV_ORIGIN",'req.headers.origin !== r.origin','false && req.headers.origin !== r.origin',"store nothing"],
 ["REV_ORIGIN",'req.headers["sec-fetch-site"] === "cross-site"','false && req.headers["sec-fetch-site"] === "cross-site"',"store nothing"],
];
function run(token){return spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000});}
try{for(const[token,needle,replacement,message]of mutants){const control=run(token);assert.equal(control.error,undefined,`${token} control executes`);assert.equal(control.status,0,`${token} passing control\n${control.stdout}${control.stderr}`);assert.equal(original.split(needle).length-1,1,`${token} binding occurs once`);await writeFile(source,original.replace(needle,replacement));const mutant=run(token),output=mutant.stdout+mutant.stderr;assert.equal(mutant.error,undefined,`${token} runner executes`);assert.notEqual(mutant.status,0,`${token} mutant survived\n${output}`);assert.match(output,/not ok/);assert.match(output,/AssertionError/);assert.match(output,new RegExp(message));assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${token} ${needle}`);await writeFile(source,original);}}
finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"civil review original remains restored");}
