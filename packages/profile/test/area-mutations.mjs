import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const area=await readFile(new URL("../../../dist/packages/profile/src/area.js",import.meta.url),"utf8");
const profile=await readFile(new URL("../../../dist/packages/profile/src/profile.js",import.meta.url),"utf8");
const gateway=await readFile(new URL("../../../dist/apps/gateway/src/area-http.js",import.meta.url),"utf8");
const store=await readFile(new URL("../../../dist/packages/db/src/postgres-person-location-store.js",import.meta.url),"utf8");
const web=await readFile(new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url),"utf8");
for(const needle of ["bestDistance <= 50","language === \"ar\"","status='active'","expectedRevision","script-src 'nonce-","/profile#field-area"]){assert.ok((area+profile+gateway+store+web).includes(needle),`Q14_5 mutation binding ${needle}`)}
