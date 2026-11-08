import assert from "node:assert/strict";
import test from "node:test";
import { HttpLegacyLogin } from "../src/legacy-login.js";

test("Q14_L_LEGACY_READONLY login sends only Basic auth and discards legacy token", async () => {
  let seen: {url:string;init:RequestInit}|undefined;
  const transport = new HttpLegacyLogin({baseUrl:"https://legacy.test/api/",allowedHost:"legacy.test"}, async (url,init) => {
    seen={url:String(url),init:init!}; return new Response(JSON.stringify({operation:"success",id:42,token:"discard-me",token_status:1}),{status:200});
  });
  assert.deepEqual(await transport.login({email:"person@example.test",password:"secret-value"}),{kind:"ok",candidateId:"42"});
  assert.equal(seen?.url,"https://legacy.test/api/v1/auth/login"); assert.equal(seen?.init.method,"GET");
  assert.ok(String((seen?.init.headers as Record<string,string>).authorization).startsWith("Basic "));
  assert.doesNotMatch(seen!.url,/person|secret|example/); assert.equal("token" in await transport.login({email:"x",password:"y"}),false);
});

test("Q14_L_LEGACY_READONLY pins fixed shapes, missing and non-numeric ids, timeout, and two-step POST", async () => {
  const responses=[new Response("no",{status:401}),new Response("oops",{status:500}),new Response("{",{status:200}),new Response(JSON.stringify({operation:"success",token_status:1}),{status:200}),new Response(JSON.stringify({operation:"success",id:"not-numeric",token_status:1}),{status:200}),new Response(JSON.stringify({operation:"success",token_status:0,token:"pending"}),{status:200}),new Response(JSON.stringify({operation:"success",id:"7",token_status:1}),{status:200})];
  const calls:Array<{url:string;init:RequestInit}> = [];
  const login=new HttpLegacyLogin({baseUrl:"https://legacy.test",allowedHost:"legacy.test",timeoutMs:100},async(url,init)=>{calls.push({url:String(url),init:init!});const response=responses.shift();if(response)return response;return new Promise<Response>((_resolve,reject)=>{const keepAlive=setTimeout(()=>reject(new Error("timeout transport did not abort")),200);init?.signal?.addEventListener("abort",()=>{clearTimeout(keepAlive);reject(init.signal?.reason);},{once:true});});});
  assert.equal((await login.login({email:"x",password:"y"})).kind,"bad_credentials");
  assert.equal((await login.login({email:"x",password:"y"})).kind,"unavailable");
  assert.equal((await login.login({email:"x",password:"y"})).kind,"unavailable");
  assert.equal((await login.login({email:"x",password:"y"})).kind,"unavailable");
  assert.equal((await login.login({email:"x",password:"y"})).kind,"unavailable");
  assert.deepEqual(await login.login({email:"x",password:"y"}),{kind:"two_step",pendingToken:"pending"});
  assert.deepEqual(await login.confirmTwoStep({pendingToken:"p",otp:"123456"}),{kind:"ok",candidateId:"7"});
  assert.equal(calls.at(-1)?.url,"https://legacy.test/v1/auth/login-two-step"); assert.equal(calls.at(-1)?.init.method,"POST");
  assert.equal((await login.login({email:"timeout",password:"secret"})).kind,"unavailable");
  assert.equal(calls.length,8);assert.ok(calls.every(call=>!call.url.includes("secret")&&!call.url.includes("timeout")));
});

test("Q14_L_LEGACY_READONLY two-step status without a pending token never links on the bare id", async () => {
  const bodies=[{operation:"success",id:42,token_status:0},{operation:"success",id:42,token_status:0,token:""},{operation:"success",id:42,token_status:0,token:7}];
  const login=new HttpLegacyLogin({baseUrl:"https://legacy.test",allowedHost:"legacy.test"},async()=>new Response(JSON.stringify(bodies.shift()),{status:200}));
  for (let i=0;i<3;i++) assert.deepEqual(await login.login({email:"x",password:"y"}),{kind:"unavailable"});
});

test("Q14_L_LEGACY_READONLY refuses unsafe configuration", () => {
  assert.throws(()=>new HttpLegacyLogin({baseUrl:"http://legacy.test",allowedHost:"legacy.test"}),/https/);
  assert.throws(()=>new HttpLegacyLogin({baseUrl:"https://production.test",allowedHost:"staging.test"}),/host/);
});
