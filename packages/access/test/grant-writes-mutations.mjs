import assert from"node:assert/strict";import{spawnSync}from"node:child_process";import{readFile,writeFile,unlink}from"node:fs/promises";import{fileURLToPath}from"node:url";
const catalogue=new URL("../../../dist/packages/access/src/grant-catalogue.js",import.meta.url),writes=new URL("../../../dist/packages/access/src/grant-writes.js",import.meta.url),suiteC=fileURLToPath(new URL("../../../dist/packages/access/test/grant-catalogue.test.js",import.meta.url)),suiteW=fileURLToPath(new URL("../../../dist/packages/access/test/grant-writes.test.js",import.meta.url));
const run=(suite,pattern,env={})=>spawnSync(process.execPath,["--test",`--test-name-pattern=^${pattern} `,suite],{encoding:"utf8",env:{...process.env,...env}});
assert.equal(run(suiteC,"SHU453_CATALOGUE").status,0);assert.equal(run(suiteW,"SHU453_PREVIEW_CONFIRM").status,0);
const mutations=[
 [catalogue,suiteC,"SHU453_CATALOGUE","SHU453_CATALOGUE_MODULE",'if (!isAdmin && !isStaff)','if (!isAdmin && !isStaff && !callerGrants.some(g => g.role === "recruiter"))'],
 [writes,suiteW,"SHU453_PREVIEW_CONFIRM","SHU453_WRITES_MODULE",'if (token.change !== canonical(change))','if (false && token.change !== canonical(change))'],
 [writes,suiteW,"SHU453_GUARDS","SHU453_WRITES_MODULE",'const refusal = await input.store.preview(caller, change);','const refusal = null;'],
 [writes,suiteW,"SHU453_ATOMIC","SHU453_WRITES_MODULE",'const refusal = await input.store.commit(caller, change, token.tokenId);','await input.store.commit(caller, change, token.tokenId); const refusal = await input.store.commit(caller, change, token.tokenId);']
];
for(const[src,suite,pattern,key,from,to]of mutations){const original=await readFile(src,"utf8");assert.equal(original.split(from).length-1,1,`${pattern} binds once`);const target=new URL(`../../../dist/packages/access/src/shu453-mutation-${process.pid}.js`,import.meta.url);try{await writeFile(target,original.replace(from,to));const r=run(suite,pattern,{[key]:target.href});assert.notEqual(r.status,0,`${pattern} survived\n${r.stdout}${r.stderr}`)}finally{await unlink(target).catch(()=>{})}}
process.stdout.write("4/4 SHU453 mutations killed\n");
