import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const source=new URL('../../../dist/apps/gateway/src/documents-upload-http.js',import.meta.url);
const suite=fileURLToPath(new URL('../../../dist/apps/gateway/test/documents-upload-http.test.js',import.meta.url));
const original=await readFile(source,'utf8');
const cases=[
 ['Q14_1_LIMIT','size > LIMIT', 'false'],
 ['Q14_1_OWNER',"request.headers.origin !== service.options.origin",'false'],
 ['Q14_1_ONE_PATH',"key(form.submission, 'finalize')","undefined"],
 ['Q14_1_ONE_PATH','await service.finalize(session, key(form.submission, \'finalize\'), { uploadId: ticket.uploadId });',''],
 ['Q14_1_REFUSALS','await service.finalize(session, key(form.submission, \'finalize\'), { uploadId: ticket.uploadId });',''],
 ['Q14_1_REPLACE','expectedVersion: current?.version ?? null','expectedVersion: null'],
];
function run(module,pattern){return spawnSync(process.execPath,['--test','--test-reporter=tap',`--test-name-pattern=^${pattern}`,suite],{encoding:'utf8',timeout:30000,env:{...process.env,SHU539_UPLOAD_MODULE:module}});}
for(const [pattern,needle,replacement] of cases){
 assert.equal(original.split(needle).length-1,1,`${pattern} needle binds once`);
 const target=new URL(`../../../dist/apps/gateway/src/documents-upload-mutant-${process.pid}.js`,import.meta.url);
 try{
  const control=run(source.href,pattern);assert.equal(control.error,undefined);assert.equal(control.status,0,control.stdout+control.stderr);
  await writeFile(target,original.replace(needle,replacement));const mutant=run(target.href,pattern);
  assert.equal(mutant.error,undefined);assert.notEqual(mutant.status,0,`${pattern} mutant survived`);assert.match(mutant.stdout+mutant.stderr,/AssertionError|not ok/);
 }finally{await unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error;});assert.equal(await readFile(source,'utf8'),original);}
}
