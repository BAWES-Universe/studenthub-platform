import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const moduleFile=new URL("../../../dist/packages/profile/src/civil-id.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/packages/profile/test/civil-id.test.js",import.meta.url));
const mutants=[
 ["Q14_3_FORMAT","input.country === \"KW\" ? 12 : 9","input.country === \"KW\" ? 11 : 9"],
 ["Q14_3_FORMAT","/[\\u0660-\\u0669\\u06f0-\\u06f9]/g","/[\\u06f0-\\u06f9]/g"],
 ["Q14_3_UNIQUE","if (sealed && country && !await options.store.numberAvailable","if (false && sealed && country && !await options.store.numberAvailable"],
 ["Q14_3_EXPIRY","value < today","value <= today"],
 ["Q14_3_EXPIRY","kuwaitDate(now())","kuwaitDate(new Date())"],
 ["Q14_3_REVIEW_FLAG","w.changed.includes(\"number\") || w.changed.includes(\"expiry\")","false"],
 ["Q14_3_SECRECY","        cipher.setAAD(Buffer.from(`${principalId}\\0${country}`))","        cipher.setAAD(Buffer.alloc(0))"],
];
let killed=0;
for(const [token,from,to] of mutants){const original=await readFile(moduleFile,"utf8");assert.equal(original.split(from).length-1,1);try{await writeFile(moduleFile,original.replace(from,to));const r=spawnSync(process.execPath,["--test",`--test-name-pattern=^${token} `,suite],{encoding:"utf8"});assert.notEqual(r.status,0,`${token} mutant survived`);killed++;}finally{await writeFile(moduleFile,original);}}
console.log(`Killed ${killed} civil ID mutants; Postgres transaction, uniqueness and CHECK mutants are CI-reviewed.`);
