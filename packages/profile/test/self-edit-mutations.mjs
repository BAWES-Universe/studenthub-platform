import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile,writeFile } from "node:fs/promises";
const profile=new URL("../../../dist/packages/profile/src/self-edit.js",import.meta.url),page=new URL("../../../dist/apps/gateway/src/profile-edit-http.js",import.meta.url);
const mutations=[
 [profile,"SHU372_WRITE","dist/packages/profile/test/self-edit.test.js","allowClear: OPTIONAL.has(field)","allowClear: false"],
 [profile,"SHU372_RULES","dist/packages/profile/test/self-edit.test.js",".length < 2",".length < 1"],
 [page,"SHU372_PAGE","dist/apps/gateway/test/profile-edit-http.test.js","slice(0, n)","slice(0, n + 1)"],
 [profile,"SHU372_OWNER","dist/packages/profile/test/self-edit.test.js","store: input.store,","store: { ...input.store, ownedRecord: async () => null },"],
];
for(const [file,token,suite,from,to] of mutations){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token} mutant binds once`);try{await writeFile(file,original.replace(from,to));const run=spawnSync(process.execPath,[`--test-name-pattern=^${token} `,suite],{encoding:"utf8"});assert.equal(run.error,undefined,`${token} runner error`);assert.notEqual(run.status,0,`${token} mutant survived\n${run.stdout}${run.stderr}`)}finally{await writeFile(file,original)}}
process.stdout.write("4/4 SHU-390 mutations killed\n");
