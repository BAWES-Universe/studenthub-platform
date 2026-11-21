import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {E2CaseFailure,safeE2Failure} from './e2-safe-progress.mjs';
test('E2 failure record only contains closed stages, failure kind, booleans and counters',()=>{
 const secret='must-never-be-recorded';
 const error=new E2CaseFailure(secret,{name:secret,message:secret},{connectCookie:true,callbacks:1,profileReads:secret,url:secret,cookie:secret});
 assert.deepEqual(safeE2Failure(error),{stage:'fixture',failureKind:'operation',connectCookie:true,callbacks:1});
 assert.equal(JSON.stringify(error).includes(secret),false);
 assert.equal(safeE2Failure(new Error(secret)),undefined);
 assert.equal(safeE2Failure({evidence:{stage:secret}}),undefined);
});
test('required E2 matrix has no diagnostic filter; fixture supplies latest exact provider origin',async()=>{
 const source=await readFile(new URL('./universe-embed-e2.mjs',import.meta.url),'utf8');
 assert.ok(source.includes('runUniverseEmbedE2(options) { return runE2Cases(options,universeEmbedE2Names); }'));
 const fixture=await readFile(new URL('./universe-embed-e2-fixture.mjs',import.meta.url),'utf8');
 assert.ok(fixture.includes('authorizationOrigin:providerOrigin'));
 const diagnostic=await readFile(new URL('./diagnose-e2.mjs',import.meta.url),'utf8');
 assert.ok(diagnostic.includes("fullMatrixAcceptance:'NOT_ESTABLISHED'"));
 assert.equal(diagnostic.includes('console.error'),false);
});
