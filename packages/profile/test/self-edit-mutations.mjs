import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const moduleFile=new URL("../../../dist/packages/profile/src/self-edit.js",import.meta.url);
const suite=fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js",import.meta.url));
const mutations=[
  ["drop maximum length","value.length > limit","false"],
  ["allow one-word names","value.split(/\\s+/u).length < 2","false"],
  ["allow forbidden controls","FORBIDDEN.test(value)","false"],
  ["drop Arabic-script requirement","!/[\\u0620-\\u064A\\u066E-\\u06D3\\u06FA-\\u06FC\\u0750-\\u077F\\u08A0-\\u08C9\\uFB50-\\uFBC2\\uFBD3-\\uFD8F\\uFD92-\\uFDC7\\uFDF0-\\uFDFB\\uFE70-\\uFEFC]/u.test(value)","false"],
];
const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,["--test","--test-reporter=tap","--test-name-pattern=^SHU372_RULES ",suite],{stdio:["ignore","pipe","pipe"]});let output="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);child.on("error",reject);child.on("close",status=>resolve({status,output}))});
assert.equal((await run()).status,0,"baseline must pass");
for(const[name,from,to]of mutations){const original=await readFile(moduleFile,"utf8");assert.equal(original.split(from).length-1,1,`${name} must bind once`);try{await writeFile(moduleFile,original.replace(from,to));const result=await run();assert.notEqual(result.status,0,`${name} survived\n${result.output}`);assert.match(result.output,/not ok \d+ - SHU372_RULES /);assert.match(result.output,/ERR_ASSERTION/);process.stdout.write(`KILLED ${name}\n`)}finally{await writeFile(moduleFile,original)}}
assert.equal((await run()).status,0,"restored suite must pass");
process.stdout.write(`${mutations.length}/${mutations.length} SHU-372 mutations killed\n`);
