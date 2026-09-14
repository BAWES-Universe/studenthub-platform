import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';

// Run the real compiled gateway/service/storage graph in an isolated copy. No
// monkeypatched test implementation and no syntax/import/process failures count.
const root=resolve(new URL('../../../',import.meta.url).pathname);
const mutations=[
 ['M17 staged retention omitted','SHU-145/NC-RETENTION','candidate-lifecycle.js',
  " + (s.lifecycle?.uploads.filter(t => t.data !== undefined).length ?? 0)", '', undefined,
  'NC-RETENTION: cleanup must count every staged body plus retired copies'],
 ['M18 finalized duplicate retained','SHU-145/NC-DUPLICATE','candidate-lifecycle.js',
  'delete t.data;\n            delete t.digest;', '', undefined,
  'NC-DUPLICATE: successful finalize must release the superseded staged body'],
 ['M19 read audit omitted','SHU-145/NC-READ-AUDIT','candidate-lifecycle.js',
  'auditRead(s, principalId, operation) {', 'auditRead(s, principalId, operation) { return;', undefined,
  'NC-READ-AUDIT: successful private reads must commit durable audit rows'],
 ['M20 character length credential comparison','SHU-145/NC-MULTIBYTE','candidate-lifecycle.js',
  'suppliedBytes.length !== expectedBytes.length', 'uploadCredential.length !== expected.length', undefined,
  'NC-MULTIBYTE: wrong upload credential must return 403, never 503'],
 ['M1 bucket-prefix credential','SHU-145/AC-02','candidate-lifecycle.js','objectKey !== t.objectKey',"!objectKey.startsWith('uploads/')"],
 ['M2 public ACL write','SHU-145/AC-01','index.js',"data: bytes.toString('base64'), acl: 'private'","data: bytes.toString('base64'), acl: 'public-read'"],
 ['M3 delivery expiry removed','SHU-145/AC-03','index.js','Number(claim.exp) <= now','false'],
 ['M4 delete old object before metadata commit','SHU-145/AC-04','candidate-lifecycle.js',
  'finalize(credential, key, input) {',
  `async finalize(credential, key, input) {
    // Deliberately reproduce the legacy destructive ordering using a separate committed transaction.
    await this.options.store.transaction(async s => {
      const ticket = s.lifecycle?.uploads.find(t => t.id === input.uploadId);
      const old = ticket && s.documents.find(d => d.version === ticket.expectedVersion);
      if (old) s.documents.splice(s.documents.indexOf(old), 1);
    });`],
 ['M12 erase old bytes outside the failed metadata transaction','SHU-145/AC-04','candidate-lifecycle.js',
  'finalize(credential, key, input) {',
  `async finalize(credential, key, input) {
    await this.options.store.transaction(async s => {
      const ticket = s.lifecycle?.uploads.find(t => t.id === input.uploadId);
      const old = ticket && s.documents.find(d => d.version === ticket.expectedVersion);
      if (old) { old.data = Buffer.from('89504e470d0a1a0a','hex').toString('base64'); old.size = 8; }
    });`],
 ['M5 upload expiry removed','SHU-145/AC-03','candidate-lifecycle.js','now >= t.expiresAt','false'],
 ['M6 principal-bound finalization removed','SHU-145/NC-AUTH','candidate-lifecycle.js','ticket.principalId !== principalId','false'],
 ['M7 content validation removed','SHU-145/NC-CONTENT','candidate-content.js','export function validateCandidateContent(type, mime, bytes) {','export function validateCandidateContent(type, mime, bytes) { return;'],
 ['M8 stale replacement admitted','SHU-145/NC-CONCURRENT','candidate-lifecycle.js','(previous?.version ?? null) !== t.expectedVersion','false'],
 ['M9 cleanup lost','SHU-145/AC-05','candidate-lifecycle.js','enqueue(s, d) {','enqueue(s, d) { return;'],
 ['M10 credentials logged','SHU-145/NC-LOGS','candidate-lifecycle.js','this.options.audit?.({ operation, code })',"this.options.audit?.({ operation, code, objectKey: 'uploads/leaked' })"],
 ['M13 R2 signed size omitted','SHU-145/R2-01','r2-storage.js','ContentLength: t.size,','', 'r2-lifecycle.test.mjs'],
 ['M14 durable orphan reservation omitted','SHU-145/R2-02','r2-storage.js','await this.snapshots.reserve(key);','', 'r2-lifecycle.test.mjs'],
 ['M15 expected direct-upload digest ignored','SHU-145/R2-04','candidate-lifecycle.js','t.expectedDigest !== undefined && hash(bytes) !== t.expectedDigest','false', 'r2-lifecycle.test.mjs'],
 ['M16 immutable readback digest ignored','SHU-145/R2-06','r2-storage.js','digest(bytes) !== ref.digest','false', 'r2-lifecycle.test.mjs'],
 ['M11 staged digest ignored','SHU-145/NC-FINALIZE','candidate-lifecycle.js','hash(bytes) !== t.digest','false'],
];
const sandbox=await mkdtemp(join(tmpdir(),'shu145-mutations-'));
try {
 await cp(join(root,'dist'),join(sandbox,'dist'),{recursive:true});
 await cp(join(root,'packages/private-documents/test'),join(sandbox,'packages/private-documents/test'),{recursive:true});
 await cp(join(root,'node_modules'),join(sandbox,'node_modules'),{recursive:true});
 // Workspace links point to package dist folders. Copy the few package manifests/build outputs used by gateway imports.
 for(const name of ['actor-assertion','contracts','login-contract','idempotency-contract','safe-write-contract','db']) {
  await cp(join(root,'packages',name),join(sandbox,'packages',name),{recursive:true});
 }
 await writeFile(join(sandbox,'package.json'),'{"type":"module"}');
 for(const [label,named,file,from,to,test='candidate-lifecycle.test.mjs',assertionText] of mutations){
  const target=join(sandbox,'dist/packages/private-documents/src',file),original=await readFile(target,'utf8');
  assert.equal(original.split(from).length-1,1,`${label}: unique source anchor`);
  try {
   await writeFile(target,original.replace(from,to));
   const result=spawnSync(process.execPath,['--test','--test-reporter=tap',`--test-name-pattern=^${named} `,join(sandbox,'packages/private-documents/test',test)],{encoding:'utf8',timeout:30000});
   const output=result.stdout+result.stderr;
   assert.equal(result.error,undefined,`${label}: process failure`);
   assert.equal(result.signal,null,`${label}: process signal`);
   assert.notEqual(result.status,0,`${label}: survived`);
   assert.match(output,new RegExp(`not ok \\d+ - ${named} `),`${label}: named assertion absent\n${output}`);
   assert.match(output,/AssertionError|ERR_ASSERTION/,`${label}: no assertion failure\n${output}`);
   assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,`${label}: harness crash`);
   if(assertionText)assert.ok(output.includes(assertionText),`${label}: exact AssertionError text absent\n${output}`);
   console.log(`KILLED ${label} -> ${named}${assertionText ? `: AssertionError: ${assertionText}` : ''}`);
  } finally {await writeFile(target,original);}
 }
 console.log(`${mutations.length}/${mutations.length} named assertion kills`);
} finally {await rm(sandbox,{recursive:true,force:true});}
