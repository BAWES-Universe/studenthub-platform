import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
const actionsModule=process.env.SHU549_ACTIONS_MODULE??new URL('../src/documents-actions-http.js',import.meta.url).href;
const {handleDocumentsActions}=await import(actionsModule) as typeof import('../src/documents-actions-http.js');

const SESSION='s'.repeat(43), ORIGIN='http://student.test';
function rig(t: TestContext) {
  let rows=[{id:'private-id',version:'11111111-1111-4111-8111-111111111111',type:'personal-photo',mime:'image/png',size:8}],lists=0,removes=0,deliveries=0;
  const service={options:{origin:ORIGIN,signingKey:Buffer.alloc(32,7)},async list(){lists++;return rows;},async issueDelivery(_s:string,id:string){deliveries++;assert.equal(id,'private-id');return{url:`${ORIGIN}/private-documents/delivery?t=signed`,expiresAt:60};},async remove(_s:string,_key:string,input:{expectedVersion:string}){removes++;if(rows[0]?.version!==input.expectedVersion)throw Object.assign(new Error('conflict'),{status:409});rows=[];return{status:200};}};
  const login={profile:async()=>({status:200,body:{personId:'person-1'}})};
  const server=createServer((request,response)=>{void handleDocumentsActions(request,response,service as never,login as never).then(handled=>{if(!handled){response.writeHead(404);response.end();}});});
  return new Promise<{url:string;counts:()=>{lists:number;removes:number;deliveries:number};replace:()=>void}>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();assert.ok(address&&typeof address!=='string');resolve({url:`http://127.0.0.1:${address.port}`,counts:()=>({lists,removes,deliveries}),replace:()=>{rows=[{...rows[0]!,version:'22222222-2222-4222-8222-222222222222'}];}});});});
}
const headers={cookie:`__Host-studenthub_session=${SESSION}`};

test('Q14_2_REMOVE confirm is opaque and stale removal is refused',async t=>{const f=await rig(t);const confirm=await fetch(f.url+'/profile/documents/personal-photo/remove',{headers});assert.equal(confirm.status,200);const html=await confirm.text();assert.doesNotMatch(html,/private-id|11111111-1111/);const stamp=/name="stamp" value="([^"]+)"/.exec(html)![1]!,submission=/name="submission" value="([^"]+)"/.exec(html)![1]!;f.replace();const result=await fetch(f.url+'/profile/documents/personal-photo/remove',{method:'POST',redirect:'manual',headers:{...headers,origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({stamp,submission})});assert.equal(result.status,409);assert.equal(f.counts().removes,0);});

test('Q14_2_VIEW is post-only, same-origin, and mints on click',async t=>{const f=await rig(t);assert.equal((await fetch(f.url+'/profile/documents/personal-photo/view',{headers})).status,404);assert.equal(f.counts().deliveries,0);const denied=await fetch(f.url+'/profile/documents/personal-photo/view',{method:'POST',headers:{...headers,origin:'https://evil.invalid'}});assert.equal(denied.status,403);assert.equal(f.counts().lists,0);const viewed=await fetch(f.url+'/profile/documents/personal-photo/view',{method:'POST',redirect:'manual',headers:{...headers,origin:ORIGIN}});assert.equal(viewed.status,303);assert.equal(viewed.headers.get('location'),`${ORIGIN}/private-documents/delivery?t=signed`);assert.deepEqual(f.counts(),{lists:1,removes:0,deliveries:1});});

test('Q14_2_OWNER session, origin and slot guards precede document access',async t=>{const f=await rig(t);assert.equal((await fetch(f.url+'/profile/documents/resume/view',{method:'POST',headers:{origin:ORIGIN}})).status,401);assert.equal((await fetch(f.url+'/profile/documents/unknown/view',{method:'POST',headers})).status,404);assert.equal((await fetch(f.url+'/profile/documents/personal-photo/view',{method:'POST',headers:{...headers,origin:'https://evil.invalid'}})).status,403);assert.deepEqual(f.counts(),{lists:0,removes:0,deliveries:0});});
