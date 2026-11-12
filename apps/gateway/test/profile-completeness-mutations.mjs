import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const suite=fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js",import.meta.url));
const source=name=>fileURLToPath(new URL(`../../../dist/apps/gateway/src/${name}.js`,import.meta.url));
const cases=[
  {token:"Q14_4_DERIVED",file:source("index"),needle:"const gathered = await gatherProfileCompleteness({ principalId: requesterPrincipalId,",replacement:"await documents?.list(cookieValue(request.headers.cookie, \"__Host-studenthub_session\")); const gathered = await gatherProfileCompleteness({ principalId: requesterPrincipalId,",message:"Expected values to be strictly deep-equal",env:"SHU594_GATEWAY_MODULE"},
  {token:"Q14_4_NOWRITE",file:source("index"),needle:"completeness = gathered.result;",replacement:"await login.web.profileCompleteness?.civilId.write?.(requesterPrincipalId, gathered.result); completeness = gathered.result;",message:"Q14_4_NOWRITE remains 200",env:"SHU594_GATEWAY_MODULE"},
  {token:"Q14_4_CHECKLIST",file:source("web-ui"),needle:'const href = target(requirement), words = copy',replacement:'const href = requirement === "personal_photo" ? undefined : target(requirement), words = copy',message:"Q14_4_CHECKLIST exact links",env:"SHU594_WEB_UI_MODULE"},
  {token:"Q14_4_CHECKLIST",file:source("web-ui"),needle:'requirement === "education" || requirement === "skill" ? "/profile/background"',replacement:'requirement === "education" || requirement === "skill" ? "/wrong-background"',message:"Q14_4_CHECKLIST exact links",env:"SHU594_WEB_UI_MODULE"},
  {token:"Q14_4_STATUS",file:source("web-ui"),needle:'completeness.kind === "unavailable" ? `<section',replacement:'completeness.kind === "unavailable" && false ? `<section',message:"Q14_4_STATUS remains 200",env:"SHU594_WEB_UI_MODULE"},
  {token:"Q14_4_COMPAT",file:source("web-ui"),needle:'if (!completeness && (key === "isProfileCompleted" || key === "pendingFields") && hasWrites)',replacement:'if ((key === "isProfileCompleted" || key === "pendingFields") && hasWrites)',message:"Q14_4_COMPAT completeness row derived value",env:"SHU594_WEB_UI_MODULE"},
];
for(const [index,item] of cases.entries()){
  const original=readFileSync(item.file,"utf8");assert.equal(original.split(item.needle).length-1,1,`${item.token} needle binds once`);
  const control=spawnSync(process.execPath,["--test","--test-name-pattern",`^${item.token} `,suite],{encoding:"utf8"});assert.equal(control.error,undefined,`${item.token} control executes`);assert.equal(control.status,0,`${item.token} control passes`);
  const mutant=item.file.replace(/\.js$/,`.shu594-${item.token}-${index}.mjs`),gatewayMutant=source("index").replace(/\.js$/,`.shu594-gateway-${item.token}-${index}.mjs`);
  try{
    writeFileSync(mutant,original.replace(item.needle,item.replacement));
    const env={...process.env,[item.env]:pathToFileURL(mutant).href};
    if(item.file===source("web-ui")){const gateway=readFileSync(source("index"),"utf8").replaceAll('"./web-ui.js"',`"./${mutant.split("/").at(-1)}"`);writeFileSync(gatewayMutant,gateway);env.SHU594_GATEWAY_MODULE=pathToFileURL(gatewayMutant).href;}
    const run=spawnSync(process.execPath,["--test","--test-name-pattern",`^${item.token} `,suite],{encoding:"utf8",env});const output=run.stdout+run.stderr;assert.notEqual(run.status,0);assert.match(output,/not ok/);assert.match(output,/AssertionError/);assert.match(output,new RegExp(item.message));assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);console.log(`KILLED ${item.token}`);
  }finally{try{unlinkSync(mutant)}catch{}try{unlinkSync(gatewayMutant)}catch{}assert.equal(readFileSync(item.file,"utf8"),original);}
}
