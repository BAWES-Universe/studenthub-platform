// The focused mutation smoke check loads a sibling of the compiled module,
// using the same swap hook as the other civil-ID mutation suite. It never
// overwrites dist output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile,unlink,writeFile } from "node:fs/promises";
const source=new URL("../../../dist/apps/gateway/src/civil-id-http.js",import.meta.url);
const target=new URL(source.href.replace(/\.js$/,`-mutant-${process.pid}.js`));
const suite=new URL("../../../dist/apps/gateway/test/civil-id-review-http.test.js",import.meta.url);
const hook=new URL("./helpers/swap-module.mjs",import.meta.url).href;
const original=await readFile(source,"utf8"),needle='profileCopyText(language, "civilId.waiting")';
assert.equal(original.split(needle).length-1,1,"REV_SHOWN mutant needle binds exactly once");
const run=()=>spawnSync(process.execPath,["--import",`data:text/javascript,${encodeURIComponent(`import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify({[source.href]:target.href})}});`)}`,"--test",suite.pathname],{encoding:"utf8"});
try{await writeFile(target,original.replace(needle,'"Waiting mutant"'));const result=run();assert.notEqual(result.status,0,"REV_SHOWN waiting mutant is killed");assert.match(result.stdout+result.stderr,/AssertionError/,"REV_SHOWN mutant dies by assertion");}finally{await unlink(target).catch(()=>{});}
console.log("1/1 civil ID review mutation smoke mutants killed");
