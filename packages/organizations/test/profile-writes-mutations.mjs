import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source=new URL("../dist/profile-writes.js",import.meta.url);
const original=await readFile(source,"utf8");
const suite=fileURLToPath(new URL("../../../dist/packages/organizations/test/profile-writes.test.js",import.meta.url));
const mutations=[
  ["let website bypass preview","SHU-300/AC-01 CONFORMANCE","preview: (request) => implementation.preview(request)","preview: (request) => request.change.field === \"website\" ? Promise.resolve({ ok: true, changes: [], token: {} }) : implementation.preview(request)"],
  ["accept recruiter on write","SHU-300/AC-02 recruiter-write-refused","return role === \"org-owner\" && grantedOrgId === requestedOrgId;","return (role === \"org-owner\" || role === \"recruiter\") && grantedOrgId === requestedOrgId;"],
  ["edit another organization","SHU-300/AC-03 cross-org","return role === \"org-owner\" && grantedOrgId === requestedOrgId;","return role === \"org-owner\";"],
  ["replace compare with unconditional write","SHU-300/AC-04 stale-confirm","return current === expectedBefore;","return true;"],
];
function run(pattern,module){const result=spawnSync(process.execPath,["--test","--test-reporter=tap",...(pattern?[`--test-name-pattern=^${pattern} `]:[]),suite],{encoding:"utf8",env:{...process.env,...(module?{SHU300_TEST_MODULE:module}:{})},timeout:60000});return{...result,output:(result.stdout??"")+(result.stderr??"")};}
const baseline=run();assert.equal(baseline.status,0,`baseline must pass\n${baseline.output}`);
for(const[name,pattern,from,to]of mutations){assert.equal(original.split(from).length-1,1,`mutation must bind exactly once: ${name}`);const target=new URL(`../dist/mutation-${process.pid}.js`,import.meta.url);try{await writeFile(target,original.replace(from,to));const result=run(pattern,`${target.href}?mutation=${encodeURIComponent(name)}`);assert.equal(result.error,undefined,`${name}: runner error ${String(result.error)}\n${result.output}`);assert.notEqual(result.status,0,`${name}: survived\n${result.output}`);assert.match(result.output,new RegExp(`not ok \\d+ - ${pattern} `),`${name}: named test did not fail\n${result.output}`);assert.match(result.output,/code: 'ERR_ASSERTION'/);process.stdout.write(`KILLED ${name} -> ${pattern}\n`);}finally{await unlink(target).catch(()=>undefined);}}
assert.equal(run().status,0,"restored suite must pass");
