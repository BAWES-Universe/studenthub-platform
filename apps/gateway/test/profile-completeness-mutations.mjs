import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const gathererUrl=new URL("../../../dist/apps/gateway/src/profile-completeness.js",import.meta.url);
const rendererUrl=new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url);
const suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js",import.meta.url));
const dist=fileURLToPath(new URL("../../../dist",import.meta.url));
const gatherer=await readFile(gathererUrl,"utf8"),renderer=await readFile(rendererUrl,"utf8");
const mutations=[
  {name:"second documents list",source:gathererUrl,text:gatherer,needle:"const avatar = currentProfileAvatar();",replacement:'const avatar = { documents: await state.dependencies.documents.list("s".repeat(43)) }; // mutant lists a second time',test:"Q14_4_SHOWN"},
  {name:"stored result",source:gathererUrl,text:gatherer,needle:"return applyProfileCompleteness(profile, result);",replacement:'await state.dependencies.records.service.storeCompleteness(result); return applyProfileCompleteness(profile, result); // mutant stores derived state',test:"Q14_4_SHOWN"},
  {name:"dropped item target",source:rendererUrl,text:renderer,needle:'if (requirement === "education" || requirement === "skill") return "/profile/background";',replacement:'if (requirement === "education" || requirement === "skill") return undefined;',test:"Q14_4_CHECKLIST"},
  {name:"failure changes status",source:gathererUrl,text:gatherer,needle:"return applyProfileCompleteness(profile, result);",replacement:'if(result.kind==="unavailable")throw Error("mutant status");return applyProfileCompleteness(profile,result);',test:"Q14_4_STATUS"},
];
const control=spawnSync(process.execPath,["--test","--test-reporter=tap",suite],{encoding:"utf8",timeout:30000,env:process.env});
assert.equal(control.error,undefined,"control runner executes");
assert.equal(control.status,0,`passing control\n${control.stdout}${control.stderr}`);
for(const mutation of mutations){
  assert.equal(mutation.text.split(mutation.needle).length-1,1,`${mutation.name} needle binds once`);
  const directory=await mkdtemp(join(dirname(dist),".shu577-mutant-"));
  try{
    await cp(dist,directory,{recursive:true});
    const relative=mutation.source===gathererUrl?"apps/gateway/src/profile-completeness.js":"apps/gateway/src/web-ui.js";
    await writeFile(join(directory,relative),mutation.text.replace(mutation.needle,mutation.replacement));
    const mutantSuite=join(directory,"apps/gateway/test/profile-completeness.test.js");
    const run=spawnSync(process.execPath,["--test","--test-reporter=tap",`--test-name-pattern=^${mutation.test}`,mutantSuite],{encoding:"utf8",timeout:30000,env:process.env});
    assert.equal(run.error,undefined,`${mutation.name} runner executes`);
    const output=run.stdout+run.stderr;
    assert.notEqual(run.status,0,`${mutation.name} survived\n${output}`);
    assert.match(output,/AssertionError/,`${mutation.name} dies by assertion`);
    console.log(`KILLED ${mutation.name} -> ${mutation.test}`);
  }finally{await rm(directory,{recursive:true,force:true});}
}
