import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile,unlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../dist/completeness.js",import.meta.url),original=await readFile(source,"utf8");
const suite=fileURLToPath(new URL("../../../dist/packages/profile/test/completeness.test.js",import.meta.url));
const mutations=[
  ["treat No as missing","Q14_4_RULES false answers",'typeof field.value !== "string"','typeof field.value === "string"'],
  ["require mother for KW","Q14_4_RULES KW never",'nationalityCode !== "KW"','nationalityCode !== "ZZ"'],
  ["let import satisfy document","Q14_4_RULES documents never",'documents.has("personal-photo")','importedFallback("personal_photo", documents.has("personal-photo"))'],
  ["complete on failed source","Q14_4_DERIVED failures",'state: "unavailable"','state: "available", value: true'],
  ["keep identity reference","Q14_4_RULES requirements use",'const missing = [];','const missing = ["identity_reference"];'],
];
for(const [name,pattern,from,to] of mutations){assert.equal(original.split(from).length-1,1,`mutation must bind exactly once: ${name}`);const target=new URL(`../dist/completeness-mutant-${process.pid}.js`,import.meta.url);try{await writeFile(target,original.replace(from,to));const result=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${pattern} `,suite],{encoding:"utf8",env:{...process.env,SHU570_COMPLETENESS_MODULE:`${target.href}?mutation=${encodeURIComponent(name)}`},timeout:30000});const output=result.stdout+result.stderr;assert.equal(result.error,undefined);assert.notEqual(result.status,0,`${name}: survived`);assert.match(output,/code: 'ERR_ASSERTION'/,`${name}: must die by assertion\n${output}`);assert.match(output,/name: 'AssertionError'/,`${name}: must die by assertion\n${output}`);process.stdout.write(`KILLED ${name} -> ${pattern}\n`);}finally{await unlink(target).catch(()=>undefined);}}
process.stdout.write(`${mutations.length}/${mutations.length} SHU-570 profile mutations killed\n`);

const webSource=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),webOriginal=await readFile(webSource,"utf8");
const webSuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-journey.test.js",import.meta.url));
const webMutations=[["drop personal-photo link","const checklistTarget",'return "/profile/documents";','return undefined;'],["change civil target","const checklistTarget",'return "#field-civilId";','return "#field-area";']];
for(const [name,pattern,from,to] of webMutations){assert.equal(webOriginal.split(from).length-1,1,`mutation must bind exactly once: ${name}`);const target=new URL(`../../../dist/apps/gateway/src/web-ui-mutant-${process.pid}.js`,import.meta.url);try{await writeFile(target,webOriginal.replace(from,to));const result=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^Q14_4_CHECKLIST each translated `,webSuite],{encoding:"utf8",env:{...process.env,SHU570_WEB_UI_MODULE:`${target.href}?mutation=${encodeURIComponent(name)}`},timeout:30000});const output=result.stdout+result.stderr;assert.notEqual(result.status,0,`${name}: survived`);assert.match(output,/code: 'ERR_ASSERTION'/,`${name}: must die by assertion\n${output}`);process.stdout.write(`KILLED ${name} -> Q14_4_CHECKLIST\n`);}finally{await unlink(target).catch(()=>undefined);}}
process.stdout.write(`${webMutations.length}/${webMutations.length} SHU-570 link mutations killed\n`);
