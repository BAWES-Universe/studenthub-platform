import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const profileSuite="dist/packages/profile/test/area.test.js";
const gatewaySuite="dist/apps/gateway/test/area-http.test.js";
const postgresSuite="dist/packages/db/test/postgres-person-location.test.js";
const mutations=[
  ["Q14_5_CATALOGUE","packages/reference-catalogue/dist/types.js",'"degree-group", "area"','"degree-group"',gatewaySuite],
  ["Q14_5_AREA","packages/profile/dist/profile.js",'language === "ar" && location.areaNameAr','false && location.areaNameAr',gatewaySuite],
  ["Q14_5_COORDINATES","dist/apps/gateway/src/area-http.js","script-src 'nonce-${nonce}'","script-src 'nonce-wrong'",gatewaySuite],
  ["Q14_5_COORDINATES","dist/apps/gateway/src/area-http.js","service.area.confirmation(person, body.latitude, body.longitude, \"en\")","service.area.save({ principalId: person })",gatewaySuite],
  ["Q14_5_COORDINATES","dist/packages/profile/src/area.js","bestDistance <= 50","bestDistance <= 5000",profileSuite],
  ["Q14_5_PRIVATE","dist/apps/gateway/src/area-http.js",'location: "/profile#field-area"','location: `/profile?latitude=${body.latitude}&longitude=${body.longitude}#field-area`',gatewaySuite],
  ["Q14_5_PAGE","dist/apps/gateway/src/area-http.js","request.headers.origin !== service.origin","false",gatewaySuite],
  ["Q14_5_SHOWN","dist/apps/gateway/src/web-ui.js",'"area", "drivingLicence"','"drivingLicence"',gatewaySuite],
];

let killed=0;
async function kill([token,file,from,to,suite]){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token} mutation binding: ${from}`);try{await writeFile(file,original.replace(from,to));const result=spawnSync(process.execPath,[suite],{encoding:"utf8",env:process.env});const output=result.stdout+result.stderr;assert.notEqual(result.status,0,`${token} mutant survived: ${from}`);assert.match(output,new RegExp(`not ok \\d+ - ${token} `));assert.match(output,/ERR_ASSERTION/);killed++;console.log(`Killed ${token} mutant`);}finally{await writeFile(file,original);}}
for(const mutation of mutations)await kill(mutation);

if(process.env.DATABASE_URL){
  await kill(["Q14_5_AREA","packages/db/dist/postgres-person-location-store.js","AND catalogue_type='area' AND status='active'","AND catalogue_type='area'",postgresSuite]);
  await kill(["Q14_5_AREA","packages/db/dist/postgres-person-location-store.js","(current?.revision ?? 0) !== input.expectedRevision","false",postgresSuite]);
  console.log("PostgreSQL active-area and stale-revision transaction mutants killed; migration CHECK and trigger mutants are pinned by Q14_5_CATALOGUE and checked in CI.");
}else console.log("PostgreSQL transaction mutants not run (DATABASE_URL unset); migration CHECK and trigger mutants are pinned for CI.");
console.log(`Killed ${killed} Q14_5 mutants.`);
