import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(new URL('../../../',import.meta.url).pathname),hasDb=Boolean(process.env.DATABASE_URL);
const mutations=[
 ['read query locks','RA_NO_LOCK','r2-storage.js',"SELECT snapshot FROM candidate_document_snapshot WHERE singleton = true'","SELECT snapshot FROM candidate_document_snapshot WHERE singleton = true FOR UPDATE'",'r2-postgres.test.mjs',true],
 ['read uses writer pool','RA_NO_LOCK','r2-storage.js',"const rows = await this.reader.query('SELECT snapshot","const rows = await this.pool.query('SELECT snapshot",'r2-postgres.test.mjs',true],
 ['audit uses writer pool','RA_NO_LOCK','r2-storage.js',"await this.reader.query('INSERT INTO candidate_document_read_audit","await this.pool.query('INSERT INTO candidate_document_read_audit",'r2-postgres.test.mjs',true],
 ['audit insert skipped','RA_AUDIT_ROW','r2-storage.js',"await this.reader.query('INSERT INTO candidate_document_read_audit (id, operation, principal_ref, occurred_at) VALUES (gen_random_uuid(), $1, $2, to_timestamp($3 / 1000.0))', [entry.operation, entry.principalRef, entry.at]);","await Promise.resolve();",'r2-postgres.test.mjs',true],
 ['hydrates every row','RA_HYDRATE','r2-storage.js','return fn(s);','await Promise.all([...refs.keys()].map(id => s[documentReadHydrator](id))); return fn(s);','read-audit.test.mjs',false],
 ['audit rejection swallowed','RA_FAIL_CLOSED','candidate-lifecycle.js',"catch {\n                throw new LifecycleError(503, 'unavailable');\n            }","catch { return result; }",'read-audit.test.mjs',false],
 ['audit before ownership','RA_DENIED','candidate-lifecycle.js','const result = await readPath.read(async (s) => {','await readPath.audit({ operation, principalRef: hash(principalId), at: this.now() }); const result = await readPath.read(async (s) => {','read-audit.test.mjs',false]
];
const sandbox=await mkdtemp(join(tmpdir(),'shu563-mutations-'));
try{
 await cp(join(root,'dist'),join(sandbox,'dist'),{recursive:true});await cp(join(root,'packages/private-documents/test'),join(sandbox,'packages/private-documents/test'),{recursive:true});await cp(join(root,'node_modules'),join(sandbox,'node_modules'),{recursive:true});
 for(const name of ['contracts','idempotency-contract','db'])await cp(join(root,'packages',name),join(sandbox,'packages',name),{recursive:true});
 await writeFile(join(sandbox,'package.json'),'{"type":"module"}');
 for(const [label,name,file,from,to,test,db] of mutations){
  if(db&&!hasDb){console.log('SKIP '+label+': DATABASE_URL not set');continue;}
  const target=join(sandbox,'dist/packages/private-documents/src',file),original=await readFile(target,'utf8');assert.equal(original.split(from).length-1,1,label+': unique source anchor');
  try{await writeFile(target,original.replace(from,to));const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=^'+name+' ',join(sandbox,'packages/private-documents/test',test)],{encoding:'utf8',timeout:30000,env:process.env});const output=result.stdout+result.stderr;
   assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.notEqual(result.status,0,label+': survived');assert.match(output,/AssertionError|ERR_ASSERTION/,label+': no assertion failure\n'+output);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);console.log('KILLED '+label+' -> '+name);
  }finally{await writeFile(target,original);}
 }
}finally{await rm(sandbox,{recursive:true,force:true});}
