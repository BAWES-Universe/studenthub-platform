// Recruit R5: the employer document delivery rules each die by a named test.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,unlink,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const source=new URL('../../../dist/packages/private-documents/src/employer-delivery.js',import.meta.url);
const original=await readFile(source,'utf8');
const suite=fileURLToPath(new URL('./employer-delivery.test.mjs',import.meta.url));
const mutations=[
 ['no-sight','EMPLOYERDOC_SIGHT','if (!await this.options.sight.maySee(viewer, subject, requestId))','if (false)'],
 ['any-viewer','EMPLOYERDOC_BIND','if (claim.viewer !== viewer)','if (false)'],
 ['no-expiry','EMPLOYERDOC_BIND','|| now < claim.issuedAt || now >= claim.expiresAt','|| now < claim.issuedAt'],
 ['any-version','EMPLOYERDOC_BIND',"rows[0].version !== version",'false'],
 ['staff-label','EMPLOYERDOC_BIND',"'employer-delivery-v1\\u0000' + payload","'staff-delivery-v1\\u0000' + payload"],
 ['no-audit-fail','EMPLOYERDOC_AUDIT','catch {\n                    return unavailable();\n                } // EMPLOYERDOC_MUTANT_AUDIT','catch { }'],
];
const run=(pattern,module)=>{const r=spawnSync(process.execPath,['--test','--test-reporter=tap',...(pattern?[`--test-name-pattern=^${pattern} `]:[]),suite],{encoding:'utf8',env:{...process.env,...(module?{EMPLOYERDOC_MODULE:module}:{})},timeout:60000});return {...r,output:r.stdout+r.stderr};};
assert.equal(run().status,0,'unmutated suite passes');
for(const [name,pattern,from,to] of mutations){
 assert.equal(original.split(from).length-1,1,`${name} binds once`);
 const target=new URL(`../../../dist/packages/private-documents/src/employer-delivery-mutation-${process.pid}.js`,import.meta.url);
 try{await writeFile(target,original.replace(from,to));const r=run(pattern,`${target.href}?m=${name}`);assert.notEqual(r.status,0,`${name} survived\n${r.output}`);assert.match(r.output,new RegExp(`not ok \\d+ - ${pattern} `));}
 finally{await unlink(target).catch(()=>{});}
}
process.stdout.write(`${mutations.length}/${mutations.length} employer delivery mutations killed\n`);
