import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const area=new URL("../../../dist/packages/profile/src/area.js",import.meta.url),profile=new URL("../dist/profile.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/area-http.js",import.meta.url),web=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),types=new URL("../../reference-catalogue/dist/types.js",import.meta.url);
const areaSuite=fileURLToPath(new URL("../../../dist/packages/profile/test/area.test.js",import.meta.url)),gatewaySuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/area-http.test.js",import.meta.url));
const mutations=[
  ["Q14_5_CATALOGUE",'"degree-group", "area"','"degree-group"',types,gatewaySuite],
  ["Q14_5_SHOWN",'language === "ar" && location.areaNameAr','false && location.areaNameAr',profile,gatewaySuite],
  ["Q14_5_AREA",'!this.#areas.some(a => a.id === input.areaId)','false',area,areaSuite],
  ["Q14_5_COORDINATES","script-src 'nonce-${nonce}'","script-src 'nonce-wrong-${nonce}'",web,gatewaySuite],
  ["Q14_5_COORDINATES",'const [suggested, current, areas] = await Promise.all','await runtime.service.save({principalId:actor.principalId,areaId:null,latitude:coordinates.latitude,longitude:coordinates.longitude,expectedRevision:0,submissionId:randomUUID()}); const [suggested, current, areas] = await Promise.all',gateway,gatewaySuite],
  ["Q14_5_COORDINATES",'bestDistance <= 50','bestDistance <= 10000',area,areaSuite],
  ["Q14_5_PRIVATE",'location: "/profile#field-area"','location: `/profile?latitude=${coordinates.latitude}#field-area`',gateway,gatewaySuite],
  ["Q14_5_PAGE",'request.headers.origin !== runtime.origin','false',gateway,gatewaySuite],
  ["Q14_5_AREA",'(current?.revision ?? 0) !== input.expectedRevision','false',area,areaSuite],
  ["Q14_5_SHOWN",'"area", "drivingLicence"','"drivingLicence"',web,gatewaySuite],
];
if(process.env.DATABASE_URL){const store=new URL("../../db/dist/postgres-person-location-store.js",import.meta.url),dbSuite=fileURLToPath(new URL("../../../dist/packages/db/test/postgres-person-location.test.js",import.meta.url));mutations.push(
  ["Q14_5_AREA","AND catalogue_type='area' AND status='active' FOR SHARE","AND catalogue_type='area' FOR SHARE",store,dbSuite],
  ["Q14_5_AREA",'(current?.revision ?? 0) !== input.expectedRevision','false',store,dbSuite],
);}
let killed=0;
for(const [token,from,to,moduleFile,suite] of mutations){const original=await readFile(moduleFile,"utf8");assert.equal(original.split(from).length-1,1,`${token} mutation binding ${from}`);try{await writeFile(moduleFile,original.replace(from,to));const result=spawnSync(process.execPath,[suite],{encoding:"utf8"});const output=(result.stdout??"")+(result.stderr??"")+String(result.error??"");assert.notEqual(result.status,0,`${token} mutant survived: ${from}`);assert.match(output,new RegExp(`not ok \\d+ - ${token} `));assert.match(output,/ERR_ASSERTION/);killed++;console.log(`Killed ${token} mutant`);}finally{await writeFile(moduleFile,original);}}
console.log(`Killed ${killed} area mutants${process.env.DATABASE_URL?", including PostgreSQL active-area and revision transaction mutants":"; PostgreSQL transaction mutants await DATABASE_URL"}. PostgreSQL CHECK-list and detail-trigger mutations are exercised by Q14_5_CATALOGUE in postgres-person-location.test.ts and were hand-checked because an applied migration cannot be replayed in the shared CI database.`);
