import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js",import.meta.url));
const cases=[
  {token:"Q14_4_DERIVED",file:fileURLToPath(new URL("../../../dist/apps/gateway/src/profile-completeness.js",import.meta.url)),needle:'documentTypesOnFile: input.avatar ? { state: "available"',replacement:'documentTypesOnFile: { state: "available", value: [] }, ignored: input.avatar ? { state: "available"',message:"Q14_4_DERIVED cached documents",env:"SHU594_COMPLETENESS_MODULE"},
  {token:"Q14_4_CHECKLIST",file:fileURLToPath(new URL("../../../dist/apps/gateway/src/web-ui.js",import.meta.url)),needle:'requirement === "education" || requirement === "skill" ? "/profile/background"',replacement:'requirement === "education" || requirement === "skill" ? "/wrong-background"',message:"Q14_4_CHECKLIST exact links",env:"SHU594_WEB_UI_MODULE"},
];
for(const item of cases){
  const original=readFileSync(item.file,"utf8"); assert.equal(original.split(item.needle).length-1,1,`${item.token} needle binds once`);
  const control=spawnSync(process.execPath,["--test","--test-name-pattern",`^${item.token} `,suite],{encoding:"utf8"}); assert.equal(control.error,undefined,`${item.token} control executes`); assert.equal(control.status,0,`${item.token} control passes`);
  const mutant=item.file.replace(/\.js$/,`.shu594-${item.token}.mjs`);
  try{writeFileSync(mutant,original.replace(item.needle,item.replacement)); const run=spawnSync(process.execPath,["--test","--test-name-pattern",`^${item.token} `,suite],{encoding:"utf8",env:{...process.env,[item.env]:pathToFileURL(mutant).href}}); const output=run.stdout+run.stderr; assert.notEqual(run.status,0); assert.match(output,/not ok/); assert.match(output,/AssertionError/); assert.match(output,new RegExp(item.message)); assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/); console.log(`KILLED ${item.token}`);}finally{try{unlinkSync(mutant)}catch{} assert.equal(readFileSync(item.file,"utf8"),original);}
}
