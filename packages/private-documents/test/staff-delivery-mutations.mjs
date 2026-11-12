import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const source=new URL('../../../dist/packages/private-documents/src/staff-delivery.js',import.meta.url);
const suite=fileURLToPath(new URL('./staff-delivery.test.mjs',import.meta.url));
const original=await readFile(source,'utf8');
const mutations=[
 ['drop staff gate','STAFFDOC_GATE',"if (!grants.some(grant => (grant.role === 'staff' || grant.role === 'admin')","if (false && !grants.some(grant => (grant.role === 'staff' || grant.role === 'admin')",'other documents denied'],
 ['accept self scope','STAFFDOC_GATE',"&& grant.scope === 'subtree' // STAFFDOC_MUTANT_SCOPE","&& true // STAFFDOC_MUTANT_SCOPE",'selfstaff documents denied'],
 ['accept non-operator organization','STAFFDOC_GATE','&& this.staffOrgIds.has(grant.orgId)))','&& true))','foreign documents denied'],
 ['change MAC label on issue and deliver','STAFFDOC_BIND',"mac(payload, label = 'staff-delivery-v1')","mac(payload, label = 'staff-delivery-v2')",'positive literal label pin'],
 ['drop viewer binding','STAFFDOC_BIND','if (claim.viewer !== viewer)','if (false && claim.viewer !== viewer)','viewer binding'],
 ['drop version binding','STAFFDOC_BIND','if (row.version !== claim.version)','if (false && row.version !== claim.version)','version binding'],
 ['skip audit write','STAFFDOC_AUDIT',"await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId, kind: this.auditKind(purpose, 'issue'), documentType: type, documentVersion: row.version });",'await Promise.resolve();','civil audit kinds'],
 ['serve after failed audit write','STAFFDOC_AUDIT',"catch {\n                return unavailable();\n            } // STAFFDOC_MUTANT_DELIVER_AUDIT","catch { /* swallowed */ } // STAFFDOC_MUTANT_DELIVER_AUDIT",'failed delivery audit returns no bytes'],
 ['skip read hydrator','STAFFDOC_BYTES','if (hydrate)\n                await hydrate(row.id); // STAFFDOC_MUTANT_HYDRATE','if (false && hydrate)\n                await hydrate(row.id); // STAFFDOC_MUTANT_HYDRATE','stored R2 bytes served'],
];
function run(moduleUrl,token){
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=^'+token+' ',suite],{encoding:'utf8',timeout:30000,env:{...process.env,STAFFDOC_MODULE:moduleUrl}});
 assert.equal(result.error,undefined,token+' runner must execute');
 assert.equal(result.signal,null,token+' runner must not be killed');
 return {...result,output:result.stdout+result.stderr};
}
for(const [label,token,needle,replacement,message] of mutations){
 assert.equal(original.split(needle).length-1,1,label+': needle binds exactly once');
 const target=new URL(`../../../dist/packages/private-documents/src/staff-delivery-mutant-${process.pid}.js`,import.meta.url);
 try{
  const control=run(source.href,token);assert.equal(control.status,0,`${label}: passing control\n${control.output}`);
  await writeFile(target,original.replace(needle,replacement));
  const mutant=run(pathToFileURL(fileURLToPath(target)).href,token);
  assert.notEqual(mutant.status,0,label+': mutant survived');
  assert.match(mutant.output,new RegExp('not ok \\d+ - '+token+' '),label+': named assertion absent\n'+mutant.output);
  assert.match(mutant.output,/AssertionError/,label+': no AssertionError\n'+mutant.output);
  assert.match(mutant.output,new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),label+': expected assertion message absent\n'+mutant.output);
  assert.doesNotMatch(mutant.output,/SyntaxError|ERR_MODULE_NOT_FOUND/,label+': invalid mutant');
  console.log(`KILLED ${label} -> ${token} ${message}`);
 }finally{
  await unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
  assert.equal(await readFile(source,'utf8'),original,label+': original file unchanged');
 }
}
