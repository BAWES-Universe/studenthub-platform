import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

if(!process.env.DATABASE_URL)throw Error("DATABASE_URL is required for the SHU-327 organization deletion guard mutations");
const suite=fileURLToPath(new URL("../../../dist/packages/db/test/postgres-organization-deletion-guards.test.js",import.meta.url));
const files={status:new URL("../dist/postgres-organization-status-store.js",import.meta.url),terms:new URL("../dist/postgres-organization-commercial-terms-store.js",import.meta.url),approved:new URL("../dist/postgres-organization-approved-to-hire-store.js",import.meta.url),notes:new URL("../dist/postgres-organization-notes-store.js",import.meta.url),brands:new URL("../dist/postgres-organization-brands-store.js",import.meta.url),stores:new URL("../dist/postgres-organization-stores-store.js",import.meta.url),pay:new URL("../dist/postgres-pay-contract-safe-write-store.js",import.meta.url),profile:new URL("../dist/postgres-organization-profile-store.js",import.meta.url),live:new URL("../dist/organization-liveness.js",import.meta.url)};
const mutations=[
 ["status","SHU327_PG_STATUS_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["status","SHU327_PG_STATUS_RACE","if (!await organizationLive(client, org, true))","if (false)"],
 ["terms","SHU327_PG_TERMS_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["terms","SHU327_PG_TERMS_RACE","if (!await organizationLive(client, org, true))","if (false)"],
 ["approved","SHU327_PG_APPROVED_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["approved","SHU327_PG_APPROVED_RACE","if (!await organizationLive(client, org, true))","if (false)"],
 ["notes","SHU327_PG_NOTES_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["notes","SHU327_PG_NOTES_RACE","if (!await organizationLive(c, org, true))","if (false)"],
 ["profile","SHU327_PG_PROFILE_PREVIEW","if (!await organizationLive(client, orgId))","if (false)"],["profile","SHU327_PG_PROFILE_RACE","if (!await organizationLive(client, orgId, true))","if (false)"],
 ["pay","SHU327_PG_PAYCONTRACT_PREVIEW","await organizationLive(this.#pool, company) &&","true &&"],["pay","SHU327_PG_PAYCONTRACT_RACE","if (!await organizationLive(client, company, true))","if (false)"],
 ["brands","SHU327_PG_BRANDS_PREVIEW","if (!await organizationLive(c, org, lock))","if (false)"],["brands","SHU327_PG_BRANDS_RACE","organizationLive(c, org, lock)","organizationLive(c, org, false)"],
 ["live","SHU327_PG_STATUS_RACE",' ? " FOR SHARE" : ""',' ? "" : ""'],
 ["stores","SHU164_PG_STORES_PREVIEW","if (!await organizationLive(c, orgId, lock))","if (false)"],["stores","SHU164_PG_STORES_RACE","organizationLive(c, orgId, lock)","organizationLive(c, orgId, false)"],
];
const originals=new Map();for(const [key,url]of Object.entries(files))originals.set(key,await readFile(url,"utf8"));
const run=token=>spawnSync(process.execPath,["--test-reporter=tap","--test-concurrency=1",...(token?[`--test-name-pattern=^${token} `]:[]),suite],{encoding:"utf8",timeout:120000});
try{assert.equal(run().status,0,"unmutated SHU-327 suite passes");for(const[key,token,from,to]of mutations){const original=originals.get(key);assert.equal(original.split(from).length-1,1,`mutation binds exactly once: ${key} ${token}`);await writeFile(files[key],original.replace(from,to));const result=run(token),output=result.stdout+result.stderr;assert.notEqual(result.status,0,`${key} ${token}: mutation survived\n${output}`);assert.match(output,new RegExp(`not ok \\d+ - ${token} `));assert.match(output,/AssertionError|ERR_ASSERTION/);await writeFile(files[key],original)}}finally{for(const[key,url]of Object.entries(files))await writeFile(url,originals.get(key))}
assert.equal(run().status,0,"restored SHU-327 suite passes");
