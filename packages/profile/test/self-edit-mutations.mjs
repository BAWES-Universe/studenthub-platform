import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile,writeFile } from "node:fs/promises";
const profile=new URL("../../../dist/packages/profile/src/self-edit.js",import.meta.url),page=new URL("../../../dist/apps/gateway/src/profile-edit-http.js",import.meta.url);
const mutations=[
 [profile,"SHU372_WRITE","dist/packages/profile/test/self-edit.test.js","allowClear: OPTIONAL.has(field)","allowClear: false"],
 [profile,"SHU372_RULES","dist/packages/profile/test/self-edit.test.js",".length < 2",".length < 1"],
 [page,"SHU372_PAGE","dist/apps/gateway/test/profile-edit-http.test.js","result.status === 400 && validField(values.field)","false"],
 [profile,"SHU372_OWNER","dist/packages/profile/test/self-edit.test.js","store: input.store,","store: { ...input.store, ownedRecord: async () => null },"],
];
const run=(token,suite)=>{const result=spawnSync(process.execPath,["--test","--test-reporter=tap",...(token?[`--test-name-pattern=^${token} `]:[]),suite],{encoding:"utf8",timeout:120000});return{...result,output:result.stdout+result.stderr}};
for(const suite of new Set(mutations.map(([, , target])=>target))){const baseline=run("",suite);assert.equal(baseline.status,0,`baseline must pass\n${baseline.output}`)}
for(const [file,token,suite,from,to] of mutations){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token} mutant binds once`);try{await writeFile(file,original.replace(from,to));const result=run(token,suite);assert.equal(result.error,undefined,`${token} runner error`);assert.notEqual(result.status,0,`${token} mutant survived\n${result.output}`);assert.match(result.output,new RegExp(`not ok \\d+ - ${token} `),`${token}: named test did not fail\n${result.output}`);assert.doesNotMatch(result.output,/SyntaxError|ERR_MODULE_NOT_FOUND/,`${token}: infrastructure failure\n${result.output}`);assert.match(result.output,/code: 'ERR_ASSERTION'/,`${token}: must die by AssertionError\n${result.output}`)}finally{await writeFile(file,original)}}
for(const suite of new Set(mutations.map(([, , target])=>target))){const restored=run("",suite);assert.equal(restored.status,0,`restored suite must pass\n${restored.output}`)}
process.stdout.write("4/4 SHU-390 mutations killed\n");
