import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

if(!process.env.DATABASE_URL)throw Error("DATABASE_URL is required for the SHU-327 organization deletion guard mutations");
const suite=fileURLToPath(new URL("../../../dist/packages/db/test/postgres-organization-deletion-guards.test.js",import.meta.url));
const files={status:new URL("../dist/postgres-organization-status-store.js",import.meta.url),terms:new URL("../dist/postgres-organization-commercial-terms-store.js",import.meta.url),approved:new URL("../dist/postgres-organization-approved-to-hire-store.js",import.meta.url),notes:new URL("../dist/postgres-organization-notes-store.js",import.meta.url),brands:new URL("../dist/postgres-organization-brands-store.js",import.meta.url),pay:new URL("../dist/postgres-pay-contract-safe-write-store.js",import.meta.url),profile:new URL("../dist/postgres-organization-profile-store.js",import.meta.url),live:new URL("../dist/organization-liveness.js",import.meta.url)};
const mutations=[
 ["status","STATUS_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["status","STATUS_RACE","if (!await organizationLive(client, org, true))","if (false)"],
 ["terms","TERMS_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["terms","TERMS_RACE","if (!await organizationLive(client, org, true))","if (false)"],
 ["approved","APPROVED_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["approved","APPROVED_RACE","if (!await organizationLive(client, org, true))","if (false)"],
 ["notes","NOTES_PREVIEW","if (!await organizationLive(c, org))","if (false)"],["notes","NOTES_RACE","if (!await organizationLive(c, org, true))","if (false)"],
 ["profile","PROFILE_PREVIEW","if (!await organizationLive(client, orgId))","if (false)"],["profile","PROFILE_RACE","if (!await organizationLive(client, orgId, true))","if (false)"],
 ["pay","PAYCONTRACT_PREVIEW","await organizationLive(this.#pool, company) &&","true &&"],["pay","PAYCONTRACT_RACE","if (!await organizationLive(client, company, true))","if (false)"],
 ["brands","BRANDS_PREVIEW","if (!await organizationLive(c, org, lock))","if (false)"],["brands","BRANDS_RACE","organizationLive(c, org, lock)","organizationLive(c, org, false)"],
 ["live","STATUS_RACE",' ? " FOR SHARE" : ""',' ? "" : ""'],
];
const originals=new Map();for(const [key,url]of Object.entries(files))originals.set(key,await readFile(url,"utf8"));
const run=pattern=>spawnSync(process.execPath,["--test-reporter=tap","--test-concurrency=1",...(pattern?[`--test-name-pattern=^SHU327_PG_${pattern} `]:[]),suite],{encoding:"utf8",timeout:120000});
try{assert.equal(run().status,0,"unmutated SHU-327 suite passes");for(const[key,pattern,from,to]of mutations){const original=originals.get(key);assert.equal(original.split(from).length-1,1,`mutation binds exactly once: ${key} ${pattern}`);await writeFile(files[key],original.replace(from,to));const result=run(pattern),output=result.stdout+result.stderr;assert.notEqual(result.status,0,`${key} ${pattern}: mutation survived\n${output}`);assert.match(output,new RegExp(`not ok \\d+ - SHU327_PG_${pattern} `));assert.match(output,/AssertionError|ERR_ASSERTION/);await writeFile(files[key],original)}}finally{for(const[key,url]of Object.entries(files))await writeFile(url,originals.get(key))}
assert.equal(run().status,0,"restored SHU-327 suite passes");
