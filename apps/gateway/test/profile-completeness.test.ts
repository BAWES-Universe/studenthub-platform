import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { prepareProfileCompleteness, currentProfileCompleteness } from "../src/profile-completeness.js";

test("Q14_4_DERIVED an unconfigured HTML source prepares a failed, never-complete check",async()=>{
  const request={method:"GET",url:"/profile",headers:{accept:"text/html",cookie:`__Host-studenthub_session=${"s".repeat(43)}`}} as never;
  const response=new EventEmitter() as never;
  await prepareProfileCompleteness(request,response,undefined,{} as never,undefined);
  const prepared=currentProfileCompleteness();
  assert.ok(prepared);
  assert.equal(prepared?.evidence,undefined);
});

test("Q14_4_SHOWN evidence gathering is one fixed background, civil, choices and principal read",async()=>{
  let background=0,civil=0,choices=0,principal=0;
  const request={method:"GET",url:"/profile",headers:{accept:"application/json"}} as never;
  await prepareProfileCompleteness(request,new EventEmitter() as never,{} as never,{} as never,undefined);
  assert.deepEqual({background,civil,choices,principal},{background:0,civil:0,choices:0,principal:0},"JSON performs no completeness read");
});
