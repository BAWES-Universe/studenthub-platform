import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const targets={http:"dist/apps/gateway/src/legacy-link-http.js",login:"dist/apps/gateway/src/legacy-login.js",store:"dist/packages/db/src/postgres-legacy-link-store.js",web:"dist/apps/gateway/src/web-ui.js"};
const gatewayTest="dist/apps/gateway/test/legacy-link-http.test.js",loginTest="dist/apps/gateway/test/legacy-login.test.js";
const probes=[
  {item:"item 1",target:"store",name:"Q14_L_LINK",from:"legacy_account_link_events\n        (principal_id, legacy_candidate_id, kind, actor_ref, method)\n        VALUES ($1::text, $2::text, 'linked'",to:"legacy_account_link_events_mutant\n        (principal_id, legacy_candidate_id, kind, actor_ref, method)\n        VALUES ($1::text, $2::text, 'linked'"},
  {item:"item 2",target:"http",name:"Q14_L_RESET",from:"Reset it on StudentHub, then come back",to:"Reset your password"},
  {item:"item 3 refusal",target:"http",name:"Q14_L_REFUSALS",from:"That email and password don't match a StudentHub account",to:"Unknown legacy email"},
  {item:"item 3 wait",target:"http",name:"Q14_L_REFUSALS",from:"if (await input.store.checkWait(principalId))\n            return { kind: \"waiting\" }; return result(principalId, await input.legacy.login(credentials))",to:"if (false && await input.store.checkWait(principalId))\n            return { kind: \"waiting\" }; return result(principalId, await input.legacy.login(credentials))"},
  {item:"item 4",target:"http",name:"Q14_L_UNIQUE",from:"async login(principalId, credentials) { if ((await input.store.status(principalId)).linked)",to:"async login(principalId, credentials) { if (false && (await input.store.status(principalId)).linked)"},
  {item:"item 5",target:"store",name:"Q14_L_KEYS",from:"async resolveLink(principalId) {\n        const { rows } = await this.#pool.query(\"SELECT legacy_candidate_id::text FROM legacy_account_links WHERE principal_id = $1::text\"",to:"async resolveLink(principalId) {\n        const { rows } = await this.#pool.query(\"SELECT legacy_candidate_id::text FROM legacy_account_links WHERE legacy_candidate_id = $1::text\""},
  {item:"item 6",target:"login",name:"Q14_L_LEGACY_READONLY",file:loginTest,from:"endpoint(this.#base, \"v1/auth/login\"), { method: \"GET\", headers: { authorization, accept: \"application/json\" } }",to:"endpoint(this.#base, `v1/auth/login?password=${encodeURIComponent(input.password)}`), { method: \"GET\", headers: { accept: \"application/json\" } }"},
  {item:"item 7",target:"web",name:"Q14_L_SHOWN",from:"copy(\"profile.legacyPrompt\")",to:"copy(\"profile.legacyImported\")"},
];
for(const probe of probes){const path=targets[probe.target],file=probe.file??gatewayTest,original=readFileSync(path,"utf8");assert.equal(original.split(probe.from).length-1,1,`${probe.item} binds exactly once`);const baseline=spawnSync(process.execPath,["--test","--test-name-pattern",probe.name,file],{encoding:"utf8"});assert.equal(baseline.status,0,baseline.stderr);try{writeFileSync(path,original.replace(probe.from,probe.to));const mutated=spawnSync(process.execPath,["--test","--test-name-pattern",probe.name,file],{encoding:"utf8"});assert.equal(mutated.status,1,`${probe.item} survived\n${mutated.stdout}\n${mutated.stderr}`);}finally{writeFileSync(path,original);}process.stdout.write(`KILLED ${probe.item} by ${probe.name}\n`);}
process.stdout.write("8/8 SHU-514 mutants killed; PostgreSQL concurrency and uniqueness are additionally exercised by npm run test:db in CI\n");
