import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile,unlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url),suite=fileURLToPath(new URL("./staff-delivery.test.mjs",import.meta.url)),original=await readFile(source,"utf8");
const cases=[
 ["drop the staff gate","REV_STAFF","if (!grants.some(","if (false && !grants.some("],
 ["accept an owner link","REV_IMAGES",'update("staff-delivery-v1\\0")','update("delivery:")'],
 ["skip the audit write","REV_IMAGES","await this.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject,","void ({ viewerPrincipalId: viewer, subjectPrincipalId: subject,"],
 ["serve on audit failure","REV_IMAGES","documentVersion: c.version }).catch(unavailable); const bytes","documentVersion: c.version }).catch(() => {}); const bytes"],
 ["drop the viewer binding","REV_IMAGES","if (c.viewer !== viewer || !slots.includes(c.type)","if (!slots.includes(c.type)"],
];
function run(module,token){return spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000,env:{...process.env,SHU600_STAFF_MODULE:module}})}
for(const [name,token,needle,replacement]of cases){assert.equal(original.split(needle).length-1,1,`${name} compiled needle binds once`);const target=new URL(`../../../dist/packages/private-documents/src/staff-delivery-mutant-${process.pid}.js?case=${encodeURIComponent(name)}`,import.meta.url),file=new URL(target.href.split("?")[0]);try{const control=run(source.href,token);assert.equal(control.status,0,`${name} control passes\n${control.stdout}${control.stderr}`);await writeFile(file,original.replace(needle,replacement));const mutant=run(target.href,token),output=mutant.stdout+mutant.stderr;assert.notEqual(mutant.status,0,`${name} mutant survived\n${output}`);assert.match(output,/not ok/);assert.match(output,/AssertionError|ERR_ASSERTION/);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${name}`)}finally{await unlink(file).catch(e=>{if(e.code!=="ENOENT")throw e});assert.equal(await readFile(source,"utf8"),original)}}
