import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const source=new URL('../../../dist/packages/private-documents/src/index.js',import.meta.url);
const original=await readFile(source,'utf8');
const testFile=fileURLToPath(new URL('./private-documents.test.mjs',import.meta.url));
const mutations=[
 ['unsigned delivery enabled','NC-UNSIGNED',"return this.run('deliver', credential, async (i, s) => {", "return this.run('deliver', credential, async (i, s) => { return {bytes: Buffer.from(s.documents[0].data, 'base64'), headers: {}};"],
 ['document organization ignored','NC-CROSSORG','{ orgId: scope.orgId, role }',"{ orgId: 'org-a', role }"],
 ['delete leaves active reference','AC-REPLACE','s.documents.splice(s.documents.indexOf(d), 1);',''],
 ['public ACL request accepted','NC-PUBLIC',"if (value !== undefined && value !== 'private')","if (false)"],
 ['public ACL written on upload','AC01',"data: bytes.toString('base64'), acl: 'private'","data: bytes.toString('base64'), acl: 'public-read'"],
 ['public ACL written on copy','NC-PUBLIC',"version: randomUUID(), acl: 'private'","version: randomUUID(), acl: 'public-read'"],
 ['authorization bypass','NC-AUTH','async authorize(identity, scope) {',"async authorize(identity, scope) { return scope.personId ?? 'owner';"],
 ['person boundary removed','NC-AUTH',"if (scope.personId !== undefined && result.context.principalId !== scope.personId)","if (false)"],
 ['expiry removed','NC-EXPIRY','Number(claim.exp) <= now','false'],
 ['signature ignored','NC-SIGNATURE','signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))','false'],
 ['subject binding removed','NC-SUBJECT',"claim.subject !== this.mac('subject:' + principal)",'false'],
 ['version binding removed','AC-REPLACE','claim.version !== d.version','false'],
 ['content signature ignored','NC-UPLOAD',"if (!(type === 'video' ? mp4 : type === 'resume' ? pdf : type === 'commercial-licence' ? pdf || image : image))","if (false)"],
 ['raw storage exception leaked','NC-FAILURE','throw new DocumentError(code);\n        }','throw error;\n        }'],
 ['metadata contents leaked','NC-LOGS','function metadata(d) { return { id: d.id,','function metadata(d) { return { data: d.data, id: d.id,'],
 ['retired replacement lost','NC-COMMIT','s.retired.push(previous);',''],
 ['file permissions ignored','NC-FS','(stat.mode & 0o777) !== 0o600','false'],
];
for(const [name,pattern,from,to] of mutations) {
 assert.equal(original.split(from).length-1,1,`mutation must bind exactly once: ${name}`);
 const target=new URL(`./mutation-${process.pid}.js`,source);
 try {
  await writeFile(target,original.replace(from,to));
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',`--test-name-pattern=^${pattern} `,testFile],{encoding:'utf8',env:{...process.env,SHU101_TEST_MODULE:target.href},timeout:30000});
  const output=result.stdout+result.stderr;
  assert.equal(result.error,undefined,`${name}: process failed`);
  assert.notEqual(result.status,0,`${name} survived`);
  assert.match(output,new RegExp(`not ok [0-9]+ - ${pattern} `),`${name}: named test did not fail\n${output}`);
  assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/,`${name}: infrastructure failure`);
  console.log(`KILLED ${name} -> ${pattern}`);
 } finally {await unlink(target).catch(()=>{});}
}
console.log(`${mutations.length}/${mutations.length} mutations killed`);
