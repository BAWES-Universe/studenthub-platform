import assert from"node:assert/strict";import{spawnSync}from"node:child_process";import{readFile,writeFile}from"node:fs/promises";import{fileURLToPath}from"node:url";
const source=new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url),suite=fileURLToPath(new URL("./staff-delivery.test.mjs",import.meta.url)),original=await readFile(source,"utf8");
const mutants=[
 ["REV_STAFF",'if (!grants.some(g => (g.role === "staff" || g.role === "admin") && g.scope === "subtree" && this.options.staffOrgIds.includes(g.orgId)))','if (false)',"staff gate"],
 ["REV_IMAGES",'u.pathname !== "/workspace/civil-ids/delivery"','false',"owner link"],
 ["REV_IMAGES",'await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject','true || await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject',"audit"],
 ["REV_STAFF",'await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: claim.subject','true || await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: claim.subject',"audit failure"],
 ["REV_IMAGES",'claim.viewer !== viewer','false',"viewer"]
];
const run=token=>spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000});
try{for(const[token,needle,replacement,message]of mutants){assert.equal(original.split(needle).length-1,1,`${token} binding occurs once`);const control=run(token);assert.equal(control.status,0,`${token} passing control\n${control.stdout}${control.stderr}`);await writeFile(source,original.replace(needle,replacement));const mutant=run(token),output=mutant.stdout+mutant.stderr;assert.equal(mutant.error,undefined,`${token} runner executes`);assert.notEqual(mutant.status,0,`${token} mutant survived\n${output}`);assert.match(output,/not ok/);assert.match(output,/AssertionError/);assert.match(output,new RegExp(message));assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${token} ${message}`);await writeFile(source,original);}}
finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"staff delivery original remains restored");}
