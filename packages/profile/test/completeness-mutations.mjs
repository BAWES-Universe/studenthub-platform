import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source=new URL("../../../dist/packages/profile/src/completeness.js",import.meta.url);
const suite=fileURLToPath(new URL("../../../dist/packages/profile/test/completeness.test.js",import.meta.url));
const mutants=[
  ["Q14_4_RULES","present(f.drivingLicence)","f.drivingLicence?.value === true"],
  ["Q14_4_RULES",'evidence.nationalityCode !== "KW"','evidence.nationalityCode === "KW"'],
  ["Q14_4_RULES",'d.type === "personal-photo"','importedPending(profile)?.has("personal_photo") === false'],
  ["Q14_4_DERIVED","!evidence.sourcesAvailable","false"],
  ["Q14_4_RULES","COMPLETENESS_ORDER.filter(name => missing.has(name))",'["identity_reference", ...COMPLETENESS_ORDER.filter(name => missing.has(name))]'],
];
let killed=0;
for(const [token,from,to] of mutants){const original=await readFile(source,"utf8");assert.equal(original.split(from).length-1,1,`${token} binding ${from}`);try{await writeFile(source,original.replace(from,to));const run=spawnSync(process.execPath,["--test",`--test-name-pattern=^${token} `,suite],{encoding:"utf8"});assert.notEqual(run.status,0,`${token} mutant survived: ${from}`);killed++;}finally{await writeFile(source,original);}}
const gateway=await readFile(new URL("../../../dist/apps/gateway/src/profile-completeness.js",import.meta.url),"utf8");
assert.equal((gateway.match(/\.documents\.list\(|documents\.list\(/g)??[]).length,1,"Q14_4_SHOWN one documents list call site");
assert.doesNotMatch(gateway,/INSERT|UPDATE|\.save\(|\.write\(/i,"Q14_4_DERIVED never stores result");
const webFile=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),webSuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js",import.meta.url));
const web=await readFile(webFile,"utf8"),link='? "/profile/documents" : ["education", "skill"]',bad='? "/profile/background" : ["education", "skill"]';
assert.equal(web.split(link).length-1,1,"Q14_4_CHECKLIST link mutant binding");
try{await writeFile(webFile,web.replace(link,bad));const run=spawnSync(process.execPath,["--test",'--test-name-pattern=^Q14_4_CHECKLIST ',webSuite],{encoding:"utf8"});assert.notEqual(run.status,0,"Q14_4_CHECKLIST link mutant survived");killed++;}finally{await writeFile(webFile,web);}
console.log(`Killed ${killed} completeness mutants; gateway read/store guards passed.`);
