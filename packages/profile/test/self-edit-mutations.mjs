import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const profile=new URL("../../../dist/packages/profile/src/self-edit.js",import.meta.url);
const page=new URL("../../../dist/apps/gateway/src/profile-edit-http.js",import.meta.url);
const profileSuite=fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js",import.meta.url));
const pageSuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-edit-http.test.js",import.meta.url));
const mutations=[
 [profile,"SHU372_RULES",profileSuite,"[...value].length > PERSON_PROFILE_MAX[field]","false"],
 [profile,"SHU372_OWNER",profileSuite,"return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined","return \"owner\""],
 [profile,"SHU372_WRITE",profileSuite,"return result.ok ? { status: 200, body: { receipt: result.receipt } }","return result.ok ? { status: 409, body: { error: \"mutant\" } }"],
 [page,"SHU372_PAGE",pageSuite,"Confirm change</button>","Continue</button>"],
];
for(const[file,token,suite,from,to]of mutations){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`mutation binds: ${token}`);try{await writeFile(file,original.replace(from,to));const result=spawnSync(process.execPath,[suite],{encoding:"utf8"});const output=(result.stdout??"")+(result.stderr??"");assert.notEqual(result.status,0,`${token} mutant survived\n${output}`);}finally{await writeFile(file,original);}}
process.stdout.write("4/4 SHU372 mutations killed\n");
