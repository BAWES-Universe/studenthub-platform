import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist=new URL("../../../dist/apps/gateway/",import.meta.url),people=new URL("src/people-directory.js",dist),web=new URL("src/web-ui.js",dist),suite=fileURLToPath(new URL("test/people-directory.test.js",dist));
const hook=new URL("./helpers/swap-module.mjs",import.meta.url).href;
const cases=[
  ["drop the staff check","DIR_ACCESS","DIR_ACCESS ordinary person is hidden",people,"if (!await isPeopleStaff(options.authz, session.personId))","if (false)"],
  ["accept a self-scope grant","DIR_ACCESS","DIR_ACCESS self scope is hidden",people,'grant.scope === "subtree"','(grant.scope === "subtree" || grant.scope === "self")'],
  ["accept a repeated key","DIR_QUERY","DIR_QUERY repeated key rejected before store",people,"parameters.getAll(key).length !== 1","false"],
  ["render the full phone","DIR_ROWS","DIR_ROWS full phone is never rendered",people,"phone: row.phoneLast4 ? maskPhone(row.phoneLast4) : null","phone: row.phoneLast4"],
  ["read the store once per row","DIR_ONE_QUERY","DIR_ONE_QUERY HTML 1",people,"return { status: 200, body: { query, rows, total,","await Promise.all(rows.map(() => options.store.page(query, today))); return { status: 200, body: { query, rows, total,"],
  ["show sidebar for non-staff","DIR_ACCESS","DIR_ACCESS sidebar hidden without live staff grant",web,"if (!authorized || !active || !login.people","if (!active || !login.people"],
];
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function run(prefix,swaps){const register=`import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;return spawnSync(process.execPath,["--import",`data:text/javascript,${encodeURIComponent(register)}`,"--test","--test-reporter=tap",`--test-name-pattern=^${esc(prefix)}`,suite],{encoding:"utf8",timeout:60000});}
for(const [name,prefix,message,module,from,to] of cases){const original=await readFile(module,"utf8");assert.equal(original.split(from).length-1,1,`${name}: needle binds exactly once`);const target=new URL(module.href.replace(/\.js$/,`-mutant-${process.pid}.js`));try{const control=run(prefix,{}),controlOutput=control.stdout+control.stderr;assert.equal(control.error,undefined);assert.equal(control.status,0,`${name}: unmutated control passes\n${controlOutput}`);await writeFile(target,original.replace(from,to));const mutant=run(prefix,{[module.href]:target.href}),output=mutant.stdout+mutant.stderr;assert.notEqual(mutant.status,0,`${name}: mutant survived\n${output}`);assert.match(output,/name: 'AssertionError'/,`${name}: dies by AssertionError\n${output}`);assert.match(output,new RegExp(esc(message)),`${name}: dies on ${message}\n${output}`);console.log(`KILLED ${name} -> ${message}`);}finally{await unlink(target).catch(e=>{if(e.code!=="ENOENT")throw e;});assert.equal(await readFile(module,"utf8"),original);}}
console.log(`${cases.length}/${cases.length} people directory mutants killed`);
