import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url),suite=fileURLToPath(new URL("./staff-delivery.test.mjs",import.meta.url)),original=await readFile(source,"utf8");
const mutants=[
 ["drop the staff gate",'if (!grants.some(g => (g.role === "staff" || g.role === "admin") && g.scope === "subtree" && this.options.staffOrgIds.includes(g.orgId)))','if (false)'],
 ["skip the audit write",'await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject','await Promise.resolve({ viewerPrincipalId: viewer, subjectPrincipalId: subject'],
 ["serve on audit failure",'await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: claim.subject','await Promise.resolve({ viewerPrincipalId: viewer, subjectPrincipalId: claim.subject'],
 ["drop the viewer binding",'if (claim.viewer !== viewer || claim.purpose === "civil_id_review" && viewer === claim.subject)','if (claim.purpose === "civil_id_review" && viewer === claim.subject)'],
 ["accept an owner link",'const mac = createHmac("sha256", this.options.signingKey).update(`staff-delivery-v1.${p}`)','const mac = createHmac("sha256", this.options.signingKey).update(`delivery:${p}`)'],
];
const run=()=>spawnSync(process.execPath,[suite],{encoding:"utf8",timeout:30000});
try{const control=run();assert.equal(control.status,0,`REV_IMAGES passing control\n${control.stdout}${control.stderr}`);for(const [name,needle,replacement] of mutants){assert.equal(original.split(needle).length-1,1,`${name} binds once`);await writeFile(source,original.replace(needle,replacement));const killed=run(),output=killed.stdout+killed.stderr;assert.notEqual(killed.status,0,`${name} mutant survived\n${output}`);if(output){assert.match(output,/not ok/);assert.match(output,/AssertionError|testCodeFailure/);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/)}console.log(`KILLED ${name}`);await writeFile(source,original)}}finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"original remains restored")}
