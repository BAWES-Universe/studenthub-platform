import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const profile=new URL("../../../dist/packages/profile/src/self-edit.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/profile-edit-http.js",import.meta.url);
const profileSuite=fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js",import.meta.url)),gatewaySuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-edit-http.test.js",import.meta.url));
const mutations=[[profile,"SHU372_WRITE","if (input.length === 0)","if (false)"],[profile,"SHU372_RULES","objective: 100","objective: 101"],[gateway,"SHU372_PAGE","a.length > 80 ? a.slice(0, 77).join(\"\") + \"…\" : x","x"],[gateway,"SHU372_OWNER","const principal = async (s) => s ? (await ports.sessions.get(s))?.personId : undefined;","const principal = async (_s) => 'person-a';"]];
for(const[file,token,from,to]of mutations){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token} mutant binds once`);try{await writeFile(file,original.replace(from,to));const result=spawnSync(process.execPath,["--test-name-pattern",`^${token} `,file===profile?profileSuite:gatewaySuite],{encoding:"utf8"});assert.notEqual(result.status,0,`${token} assertion test did not kill its mutant\n${result.stdout}${result.stderr}`);}finally{await writeFile(file,original);}}
process.stdout.write("4/4 SHU372 mutations killed\n");
