import assert from"node:assert/strict";import{spawnSync}from"node:child_process";import{readFile,writeFile}from"node:fs/promises";import{fileURLToPath}from"node:url";
const area=new URL("../dist/area.js",import.meta.url),profile=new URL("../dist/profile.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/area-http.js",import.meta.url),web=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),types=new URL("../../reference-catalogue/dist/types.js",import.meta.url);const areaSuite=fileURLToPath(new URL("../../../dist/packages/profile/test/area.test.js",import.meta.url)),gatewaySuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/area-http.test.js",import.meta.url));
const mutations=[
["Q14_5_CATALOGUE",types,'"area",','',gatewaySuite],
["Q14_5_SHOWN",profile,'language === "ar" && area.nameAr ? area.nameAr :','false ? area.nameAr :',areaSuite],
["Q14_5_AREA",area,'if (input.areaId !== null && !this.#areas.some(a => a.id === input.areaId))','if (false)',areaSuite],
["Q14_5_COORDINATES",gateway,"script-src 'nonce-${nonce}'","script-src 'nonce-wrong'",gatewaySuite],
["Q14_5_COORDINATES",gateway,'if (path.endsWith("/location")) {','if (path.endsWith("/location")) { await service.save({principalId:id,areaId:null,latitude:null,longitude:null,expectedRevision:0,submissionId:randomUUID()});',gatewaySuite],
["Q14_5_COORDINATES",area,'bestDistance <= 50','bestDistance <= 500',areaSuite],
["Q14_5_PRIVATE",gateway,'location: "/profile#field-area"','location: `/profile?latitude=${values.latitude}#field-area`',gatewaySuite],
["Q14_5_PAGE",gateway,'request.headers.origin !== origin','false',gatewaySuite],
["Q14_5_AREA",area,'(current?.revision ?? 0) !== input.expectedRevision','false',areaSuite],
["Q14_5_SHOWN",web,'"area", "drivingLicence"','"drivingLicence"',gatewaySuite],
];let killed=0;for(const[token,file,from,to,suite]of mutations){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token}: ${from}`);try{await writeFile(file,original.replace(from,to));const result=spawnSync(process.execPath,["--test",`--test-name-pattern=^${token} `,suite],{encoding:"utf8"});assert.notEqual(result.status,0,`${token} mutant survived: ${from}`);const output=result.stdout+result.stderr;assert.match(output,new RegExp(`not ok \\d+ - ${token} `),output);killed++;console.log(`Killed ${token} mutant`)}finally{await writeFile(file,original)}}console.log(`Killed ${killed} area mutants. PostgreSQL CHECK, kind-trigger, active-area transaction and revision-lock boundaries are exercised by Q14_5_CATALOGUE, Q14_5_AREA and Q14_5_PRIVATE in postgres-person-location.test.ts${process.env.DATABASE_URL?" (CI database available)":" (DATABASE_URL unset locally)"}.`);
