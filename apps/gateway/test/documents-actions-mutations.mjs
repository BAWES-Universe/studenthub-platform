import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile,writeFile,unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const actions=new URL('../../../dist/apps/gateway/src/documents-actions-http.js',import.meta.url),avatar=new URL('../../../dist/apps/gateway/src/profile-avatar.js',import.meta.url);
const suites={actions:fileURLToPath(new URL('../../../dist/apps/gateway/test/documents-actions-http.test.js',import.meta.url)),avatar:fileURLToPath(new URL('../../../dist/apps/gateway/test/profile-avatar.test.js',import.meta.url))};
const cases=[
 ['Q14_2_REMOVE',actions,suites.actions,"!document || !equal(supplied, stamp(service, personId, type, document.version))","!document"],
 ['Q14_2_VIEW',actions,suites.actions,"action === 'view' ? request.method !== 'POST'","action === 'view' ? false"],
 ['Q14_2_OWNER',actions,suites.actions,"request.headers.origin !== service.options.origin","false"],
 ['Q14_2_AVATAR',avatar,suites.avatar,"await service.issueDelivery(session, photo.id).then(v => v.url).catch(() => undefined)","await service.issueDelivery(session, photo.id).then(v => v.url)"],
 ['Q14_2_AVATAR',avatar,suites.avatar,"v.url","photo.id"],
];
for(const [index,[token,source,suite,needle,replacement]] of cases.entries()){const original=await readFile(source,'utf8');assert.equal(original.split(needle).length-1,1,`${token} ${fileURLToPath(source)} needle binds once`);const target=new URL(`./shu558-mutant-${process.pid}-${index}.js`,source);try{await writeFile(target,original.replace(needle,replacement));const result=spawnSync(process.execPath,['--test',`--test-name-pattern=^${token}`,suite],{encoding:'utf8',timeout:30000,env:{...process.env,SHU558_ACTIONS_MODULE:target.href,SHU558_AVATAR_MODULE:target.href}});assert.equal(result.error,undefined);assert.notEqual(result.status,0,`${token} mutant survived`);assert.match(result.stdout+result.stderr,/AssertionError|ERR_ASSERTION/);}finally{await unlink(target).catch(()=>undefined);}}
