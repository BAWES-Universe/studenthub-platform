import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
const http="dist/apps/gateway/src/civil-id-suggestion-http.js",web="dist/apps/gateway/src/web-ui.js",testFile="dist/apps/gateway/test/civil-id-suggestion-http.test.js";
const probes=[
 {item:"item 1 full number",file:http,name:"OCRP_LINE",from:"number ending ${s.last4}, expiring ${s.expiry}",to:"number ending 290010101234, expiring ${s.expiry}"},
 {item:"item 1 expired accept",file:http,name:"OCRP_LINE",from:"if (suggestion.expired)",to:"if (false && suggestion.expired)"},
 {item:"item 2 bypass CIV",file:http,name:"OCRP_ACCEPT",from:"const result = await service.civilId.save(",to:"const result = { ok: true }; void ("},
 {item:"item 3 current check",file:http,name:"OCRP_STALE",from:"if (!current || current.id !== id)",to:"if (!current)"},
 {item:"item 3 random submission",file:http,name:"OCRP_STALE",from:"submissionId: submissionId(id)",to:"submissionId: globalThis.crypto.randomUUID()"},
 {item:"item 4 dismiss writes CIV",file:http,name:"OCRP_DISMISS",from:'if (path.endsWith("/dismiss")) {',to:'if (path.endsWith("/dismiss")) { await service.civilId.save({ principalId: principal, submissionId: submissionId(id), revision: 0, country: "KW", number: "290010101234", expiry: "2027-03-01" });'},
 {item:"item 5 origin",file:http,name:"OCRP_ORIGIN",from:"request.headers.origin !== origin",to:"false"},
 {item:"item 6 hidden number",file:http,name:"OCRP_SECRECY",from:'name="suggestionId" value="${esc(id)}"',to:'name="suggestionId" value="290010101234"'},
 {item:"item 7 read suggestion twice",file:web,name:"OCRP_SHOWN",from:"profile.civilIdSuggestion ?? null",to:"(profile.civilIdSuggestion, profile.civilIdSuggestion) ?? null"},
];
for(const probe of probes){const original=readFileSync(probe.file,"utf8");assert.equal(original.split(probe.from).length-1,1,`${probe.item} binds exactly once`);const baseline=spawnSync(process.execPath,["--test","--test-name-pattern",probe.name,testFile],{encoding:"utf8"});assert.equal(baseline.status,0,baseline.stderr);try{writeFileSync(probe.file,original.replace(probe.from,probe.to));const mutated=spawnSync(process.execPath,["--test","--test-name-pattern",probe.name,testFile],{encoding:"utf8"});assert.equal(mutated.status,1,`${probe.item} survived\n${mutated.stdout}\n${mutated.stderr}`);}finally{writeFileSync(probe.file,original);}process.stdout.write(`KILLED ${probe.item} by ${probe.name}\n`);}
process.stdout.write("9/9 SHU-575 mutants killed\n");
