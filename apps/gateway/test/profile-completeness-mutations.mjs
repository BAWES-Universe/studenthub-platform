import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../../dist/apps/gateway/src/", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js", import.meta.url));
const indexUrl = new URL("index.js", root), webUrl = new URL("web-ui.js", root), completenessUrl = new URL("profile-completeness.js", root), routesUrl = new URL("routes/index.js", root);
const originals = new Map(await Promise.all([indexUrl,webUrl,completenessUrl,routesUrl].map(async url=>[url.href,await readFile(url,"utf8")] )));
const created=[];
const bind=(source,needle,label)=>{assert.equal(source.split(needle).length-1,1,`${label} needle binds exactly once`);};
const run=(module,pattern)=>{const result=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${pattern}`,suite],{encoding:"utf8",timeout:30000,env:{...process.env,SHU581_GATEWAY_MODULE:module}});assert.equal(result.error,undefined,`${pattern} runner executes`);return{...result,output:result.stdout+result.stderr};};
async function kill(name,pattern,message,dependencies,mutateIndex=(value)=>value){
  const suffix=`mutant-${process.pid}-${created.length}`; let index=originals.get(indexUrl.href);
  for(const [url,needle,replacement,importNeedle] of dependencies){const source=originals.get(url.href);bind(source,needle,name);const target=new URL(`${url.pathname.split('/').pop().replace(/\.js$/,"")}-${suffix}.js`,url);await writeFile(target,source.replace(needle,replacement));created.push(target);bind(index,importNeedle,name);index=index.replace(importNeedle,importNeedle.replace(/\.js"/,`-${suffix}.js"`));}
  index=mutateIndex(index);const target=new URL(`index-${suffix}.js`,root);await writeFile(target,index);created.push(target);
  const control=run(indexUrl.href,pattern);assert.equal(control.status,0,`${name} control passes\n${control.output}`);
  const mutant=run(target.href,pattern);assert.notEqual(mutant.status,0,`${name} mutant survived\n${mutant.output}`);assert.match(mutant.output,/not ok/);assert.match(mutant.output,/AssertionError/);assert.match(mutant.output,new RegExp(message));assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${name}`);
}
try{
  await kill("Q14_4_DERIVED storing result","Q14_4_DERIVED","derived result must not be stored",[[completenessUrl,"  return { result, profile:","  Object.assign(profile, { storedCompleteness: result });\n  return { result, profile:",'from "./profile-completeness.js"']]);
  await kill("Q14_4_CHECKLIST dropped link","Q14_4_CHECKLIST real profile route joins every en","personal_photo words must carry their own target",[[webUrl,'if (requirement === "personal_photo" || requirement === "civil_front" || requirement === "civil_back") return "/profile/documents";','if (requirement === "civil_front" || requirement === "civil_back") return "/profile/documents";','from "./web-ui.js"']]);
  await kill("Q14_4_CHECKLIST changed target","Q14_4_CHECKLIST real profile route joins every en","education words must carry their own target",[[webUrl,'if (requirement === "education" || requirement === "skill") return "/profile/background";','if (requirement === "education" || requirement === "skill") return "/profile/documents";','from "./web-ui.js"']]);
  await kill("Q14_4_STATUS gatherer failure changes status","Q14_4_STATUS real profile route keeps 200 when background fails","200",[],index=>{const needle="const rendered = completeness ? { status: 200, body: completeness.profile } : result;";bind(index,needle,"status");return index.replace(needle,'const rendered = completeness?.result.kind === "unavailable" ? { status: 503, body: { error: "failed" } } : completeness ? { status: 200, body: completeness.profile } : result;');});
  await kill("Q14_4_SHOWN second documents list","Q14_4_SHOWN counting fakes","fixed reads for 0 records",[[routesUrl,"await prepareProfileAvatar(ctx.request, ctx.response, ctx.documents); return false;","await prepareProfileAvatar(ctx.request, ctx.response, ctx.documents); await prepareProfileAvatar(ctx.request, ctx.response, ctx.documents); return false;",'from "./routes/index.js"']]);
}finally{for(const url of created.reverse())await unlink(url).catch(error=>{if(error.code!=="ENOENT")throw error;});for(const [href,original] of originals)assert.equal(await readFile(new URL(href),"utf8"),original,"original built file remains unchanged");}
