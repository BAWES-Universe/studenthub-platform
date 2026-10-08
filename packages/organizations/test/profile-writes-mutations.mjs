import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,unlink,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const source=new URL("../dist/profile-writes.js",import.meta.url),original=await readFile(source,"utf8");
const suite=fileURLToPath(new URL("../../../dist/packages/organizations/test/profile-writes.test.js",import.meta.url));
const mutations=[
 ["let website bypass preview","SHU-300/AC-01 CONFORMANCE","return { preview: implementation.preview, confirm: implementation.confirm };","return { preview: async (request) => { const result = await implementation.preview(request); return result.ok ? { ...result, changes: [] } : result; }, confirm: implementation.confirm };"],
 ["accept recruiter","SHU-300/AC-02 recruiter-write-refused",'row.role === "org-owner"','true'],
 ["accept cross organization","SHU-300/AC-03 cross-org",'row.org_id === orgId && row.role === "org-owner"','row.role === "org-owner"'],
 ["ignore stale state","SHU-300/AC-04 stale-confirm","return current === expectedBefore;","return true;"],
];
function run(pattern,module){const r=spawnSync(process.execPath,["--test","--test-reporter=tap",...(pattern?[`--test-name-pattern=^${pattern} `]:[]),suite],{encoding:"utf8",env:{...process.env,...(module?{SHU300_TEST_MODULE:module}:{})},timeout:30000});return {...r,output:r.stdout+r.stderr};}
assert.equal(run().status,0);
for(const [name,pattern,from,to] of mutations){assert.equal(original.split(from).length-1,1,`${name} binds once`);const target=new URL(`../dist/profile-mutation-${process.pid}.js`,import.meta.url);try{await writeFile(target,original.replace(from,to));const r=run(pattern,`${target.href}?mutation=${encodeURIComponent(name)}`);assert.equal(r.error,undefined,`${name}: runner error ${r.error}`);assert.notEqual(r.status,0,`${name} survived\n${r.output}`);assert.match(r.output,new RegExp(`not ok \\d+ - ${pattern} `));assert.match(r.output,/code: 'ERR_ASSERTION'/);process.stdout.write(`KILLED ${name} -> ${pattern}\n`);}finally{await unlink(target).catch(()=>{})}}
assert.equal(run().status,0);process.stdout.write("4/4 SHU-300 mutations killed\n");
