import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const profile=new URL("../../../dist/packages/profile/src/self-edit.js",import.meta.url),gateway=new URL("../../../dist/apps/gateway/src/profile-edit-http.js",import.meta.url);
const gatewaySuite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-edit-http.test.js",import.meta.url));
const suites={SHU372_RULES:fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js",import.meta.url)),SHU372_WRITE:gatewaySuite,SHU372_PAGE:gatewaySuite,SHU372_OWNER:gatewaySuite};
const mutations=[
 ["SHU372_RULES","drop maximum length",profile,"Array.from(value).length > limit","false"],
 ["SHU372_RULES","allow one-word names",profile,"value.split(/\\s+/u).length < 2","false"],
 ["SHU372_RULES","allow forbidden controls",profile,"FORBIDDEN.test(value)","false"],
 ["SHU372_RULES","drop Arabic-script requirement",profile,"!/[\\u0620-\\u064A\\u066E-\\u06D3\\u06FA-\\u06FC\\u0750-\\u077F\\u08A0-\\u08C9\\uFB50-\\uFBC2\\uFBD3-\\uFD8F\\uFD92-\\uFDC7\\uFDF0-\\uFDFB\\uFE70-\\uFEFC]/u.test(value)","false"],
 ["SHU372_WRITE","wrong allowed field",gateway,"allowed: [field]","allowed: [\"objective\"]"],
 ["SHU372_PAGE","drop preview shortening",gateway,"points.length > 160","false"],
 ["SHU372_OWNER","wrong owner",gateway,"writer(id, body.field).preview","writer(\"other\", body.field).preview"],
];
const run=token=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${token} `,suites[token]],{stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);child.on("error",reject);child.on("close",status=>resolve({status,output}))});
for(const token of Object.keys(suites))assert.equal((await run(token)).status,0,`${token} baseline must pass`);
for(const[token,name,url,from,to]of mutations){const original=await readFile(url,"utf8");assert.equal(original.split(from).length-1,1,`${name} must bind once`);try{await writeFile(url,original.replace(from,to));const result=await run(token);assert.notEqual(result.status,0,`${name} survived\n${result.output}`);process.stdout.write(`KILLED ${token} ${name}\n`)}finally{await writeFile(url,original)}}
for(const token of Object.keys(suites))assert.equal((await run(token)).status,0,`${token} restored suite must pass`);
process.stdout.write(`${mutations.length}/${mutations.length} SHU-372 mutations killed\n`);
