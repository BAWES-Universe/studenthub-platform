import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source=new URL('../../../dist/apps/gateway/src/documents-upload-http.js',import.meta.url);
const suite=fileURLToPath(new URL('../../../dist/apps/gateway/test/documents-upload-http.test.js',import.meta.url));
const original=await readFile(source,'utf8');
const mutants=[
  {name:'body bound',needle:'if (total > LIMIT) {',replacement:'if (false) {',test:'Q14_1_LIMIT'},
  {name:'Origin check',needle:"request.headers.origin !== service.options.origin",replacement:'false',test:'Q14_1_OWNER'},
  {name:'server finalize key',needle:'service.finalize(session, finalizeKey,',replacement:'service.finalize(session, undefined,',test:'Q14_1_ONE_PATH'},
  {name:'finalize step',needle:'const finalized = await service.finalize(session, finalizeKey, { uploadId: ticket.uploadId });',replacement:'const finalized = { status: 200 };',test:'Q14_1_UPLOAD'},
  {name:'refused finalize',needle:'if (finalized.status !== 200)',replacement:'if (false)',test:'Q14_1_REFUSALS'},
  {name:'old version check',needle:'expectedVersion: current?.version ?? null',replacement:'expectedVersion: null',test:'Q14_1_REPLACE'},
];
function run(module,pattern){return spawnSync(process.execPath,['--test','--test-reporter=tap',`--test-name-pattern=^${pattern}`,suite],{encoding:'utf8',timeout:30000,env:{...process.env,SHU531_UPLOAD_MODULE:module}});}
for(const mutant of mutants){
  assert.equal(original.split(mutant.needle).length-1,1,`${mutant.name} needle binds once`);
  const target=new URL(`../../../dist/apps/gateway/src/documents-upload-mutant-${process.pid}-${mutant.name.replaceAll(' ','-')}.js`,import.meta.url);
  try{
    const control=run(source.href,mutant.test);assert.equal(control.error,undefined,`${mutant.name} control starts`);assert.equal(control.status,0,control.stdout+control.stderr);
    await writeFile(target,original.replace(mutant.needle,mutant.replacement));
    const changed=run(target.href,mutant.test);assert.equal(changed.error,undefined,`${mutant.name} mutant starts`);assert.notEqual(changed.status,0,`${mutant.name} survived\n${changed.stdout}${changed.stderr}`);assert.match(changed.stdout+changed.stderr,/AssertionError|assert/);
  }finally{await unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error;});assert.equal(await readFile(source,'utf8'),original);}
}
