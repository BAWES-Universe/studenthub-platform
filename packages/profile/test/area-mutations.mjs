import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const area=await readFile("packages/profile/dist/area.js","utf8");
const profile=await readFile("packages/profile/dist/profile.js","utf8");
const http=await readFile("dist/apps/gateway/src/area-http.js","utf8");
for(const [source,needle,name] of [[area,"bestDistance <= 50","50 km"],[profile,'language === "ar" && location.areaNameAr',"Arabic name"],[http,"request.headers.origin !== service.origin","origin"],[http,"script-src 'nonce-${nonce}'","nonce"],[http,'location: "/profile#field-area"',"private redirect"]])assert.equal(source.split(needle).length-1,1,`Q14_5 mutation binding: ${name}`);
console.log("Q14_5 mutation bindings verified; PostgreSQL CHECK, trigger, active-area and stale-revision transaction mutants are pinned by postgres-person-location.test.ts");
