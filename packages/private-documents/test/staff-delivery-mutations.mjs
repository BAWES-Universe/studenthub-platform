import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url);
const suite=fileURLToPath(new URL("./staff-delivery.test.mjs",import.meta.url));
const original=await readFile(source,"utf8");
const mutants=[
 ["REV_STAFF","drop the staff gate",'if (!grants.some(g => (g.role === "staff" || g.role === "admin") && g.scope === "subtree" && operators.includes(g.orgId)))','if (false)'],
 ["REV_IMAGES","accept an owner link",'.update("staff-delivery-v1\\0")','.update("")'],
 ["REV_IMAGES","skip the issue audit",'await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject, kind: purpose === "civil_id_review" ? "civil_id_image_issue" : "person_document_issue", documentType: type, documentVersion: d.version });','void 0;'],
 ["REV_IMAGES","drop the viewer binding","data.viewer !== viewer","false"],
 ["REV_IMAGES","serve on audit failure","return unavailable();\n    } return { bytes:","void 0;\n    } return { bytes:"],
];
function run(token){const r=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suite],{encoding:"utf8",timeout:30000});assert.equal(r.error,undefined,`${token} runner executes`);return{...r,output:r.stdout+r.stderr};}
try{for(const[token,name,needle,replacement]of mutants){assert.equal(original.split(needle).length-1,1,`${name} mutation binding`);await writeFile(source,original.replace(needle,replacement));const mutant=run(token);assert.notEqual(mutant.status,0,`${name} mutant survived\n${mutant.output}`);assert.match(mutant.output,/not ok/);assert.match(mutant.output,/AssertionError/);assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/);await writeFile(source,original);const control=run(token);assert.equal(control.status,0,`${token} control passes\n${control.output}`);console.log(`KILLED ${token} ${name}`);}}finally{await writeFile(source,original);assert.equal(await readFile(source,"utf8"),original,"staff delivery original restored");}
