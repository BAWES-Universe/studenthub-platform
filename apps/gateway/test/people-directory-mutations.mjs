// Mutants are sibling modules; dist files are never overwritten.
import assert from"node:assert/strict";import{spawnSync}from"node:child_process";import{readFile,unlink,writeFile}from"node:fs/promises";import{fileURLToPath}from"node:url";
const dist=new URL("../../../dist/apps/gateway/",import.meta.url),people=new URL("src/people-directory.js",dist),web=new URL("src/web-ui.js",dist),suite=fileURLToPath(new URL("test/people-directory.test.js",dist)),hook=new URL("./helpers/swap-module.mjs",import.meta.url).href;
const cases=[
 ["drop staff check","DIR_ACCESS","if (!await isPeopleStaff(options.authz, session.personId))","if (false)"],
 ["accept self scope","DIR_ACCESS",'g.scope === "subtree"','(g.scope === "subtree" || g.scope === "self")'],
 ["accept repeated key","DIR_QUERY","params.getAll(key).length !== 1","false"],
];
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
for(const[name,prefix,from,to]of cases){const original=await readFile(people,"utf8");assert.equal(original.split(from).length-1,1,`${name}: needle binds exactly once`);const target=new URL(people.href.replace(/\.js$/,`-mutant-${process.pid}.js`));try{await writeFile(target,original.replace(from,to));const swaps={[people.href]:target.href},register=`import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`,r=spawnSync(process.execPath,["--import",`data:text/javascript,${encodeURIComponent(register)}`,"--test",`--test-name-pattern=^${esc(prefix)}`,suite],{encoding:"utf8",timeout:60000});assert.notEqual(r.status,0,`${name} survived`);assert.match(r.stdout+r.stderr,/AssertionError|test failed/);console.log(`KILLED ${name}`)}finally{await unlink(target).catch(()=>{});assert.equal(await readFile(people,"utf8"),original)}}
// Renderer needles are pinned too; gateway listener tests kill these in CI.
const rendered=await readFile(web,"utf8");for(const needle of['maskPhone(r.phoneLast4)','peopleLink(active, login)'])assert.equal(rendered.split(needle).length-1,1,`${needle}: needle binds exactly once`);
