import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const civil=new URL("../../../dist/packages/profile/src/civil-id.js",import.meta.url),profile=new URL("../../../dist/packages/profile/src/profile.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/civil-id-http.js",import.meta.url);
const profileSuite=fileURLToPath(new URL("../../../dist/packages/profile/test/civil-id.test.js",import.meta.url)),gatewaySuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/civil-id-http.test.js",import.meta.url));
const mutants=[
 [civil,"Q14_3_FORMAT","input.country === \"KW\" ? 12 : 9","input.country === \"KW\" ? 11 : 9",profileSuite],
 [civil,"Q14_3_FORMAT","/[\\u0660-\\u0669\\u06f0-\\u06f9]/g","/[\\u06f0-\\u06f9]/g",profileSuite],
 [civil,"Q14_3_UNIQUE","if (sealed && country && !await options.store.numberAvailable","if (false && sealed && country && !await options.store.numberAvailable",profileSuite],
 [civil,"Q14_3_EXPIRY","value < today","value <= today",profileSuite],
 [civil,"Q14_3_EXPIRY","kuwaitDate(now())","kuwaitDate(new Date())",profileSuite],
 [civil,"Q14_3_REVIEW_FLAG","w.changed.includes(\"number\") || w.changed.includes(\"expiry\")","false",profileSuite],
 [civil,"Q14_3_SECRECY","return country === \"KW\" ? `•••• •••• ${last}` : `••••• ${last}`;","return number;",profileSuite],
 [civil,"Q14_3_SECRECY","\n        cipher.setAAD(Buffer.from(`${principalId}\\0${country}`));","\n        cipher.setAAD(Buffer.alloc(0));",profileSuite],
 [gateway,"Q14_3_PAGE","if (!requestOrigin || !origin || requestOrigin !== origin || request.headers[\"sec-fetch-site\"] === \"cross-site\")","if (false)",gatewaySuite],
 [gateway,"Q14_3_PAGE","const revision = Number(params.get(\"revision\"));","const revision = current?.revision ?? Number(params.get(\"revision\"));",gatewaySuite],
 [gateway,"Q14_3_SHOWN","return `<div id=\"field-civilId\"","return `<div data-dropped=\"field-civilId\"",gatewaySuite],
 [profile,"Q14_3_EXPIRY","civil.expiry < profile.asOfDate","false",profileSuite],
];
let killed=0;
for(const [file,token,from,to,suite] of mutants){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token} binding`);try{await writeFile(file,original.replace(from,to));const r=spawnSync(process.execPath,["--test",`--test-name-pattern=^${token} `,suite],{encoding:"utf8"});assert.notEqual(r.status,0,`${token} mutant survived: ${from}`);killed++;}finally{await writeFile(file,original);}}
console.log(`Killed ${killed} civil ID mutants; Postgres transaction, uniqueness and CHECK mutants are CI-reviewed.`);
