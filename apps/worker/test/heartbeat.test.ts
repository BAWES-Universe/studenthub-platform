import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "@studenthub/contracts";
import { createWorkerHeartbeat,writeJobAlert } from "../src/index.js";
import { spawnSync } from "node:child_process";
import{JOB_NAMES,createJobRegistry,MemoryJobRunsStore}from"../../../packages/observability/src/jobs.js";
import{createAdminJobs,renderAdminJobs}from"../../gateway/src/admin-jobs.js";

test("worker heartbeat uses the shared platform contract", () => {
  const heartbeat = createWorkerHeartbeat(new Date("2026-09-02T00:00:00.000Z"));

  assert.equal(heartbeat.status, "ok");
  assert.equal(heartbeat.component, "worker");
  assert.equal(heartbeat.contractVersion, PLATFORM_CONTRACT_VERSION);
  assert.equal(heartbeat.timestamp, "2026-09-02T00:00:00.000Z");
});

test("SHU198_WORKER unknown job exits non-zero without opening storage",()=>{const run=spawnSync(process.execPath,[new URL("../src/index.js",import.meta.url).pathname,"run","unknown"],{encoding:"utf8"});assert.notEqual(run.status,0)});
test("SHU198_WORKER production alert sink writes only scrubbed alert fields",()=>{let output="";writeJobAlert({code:"job_failed",jobName:"heartbeat",owner:"platform-on-call",runbook:"docs/runbooks/alerts.md#job_failed"},text=>{output+=text});assert.deepEqual(JSON.parse(output),{code:"job_failed",jobName:"heartbeat",owner:"platform-on-call",runbook:"docs/runbooks/alerts.md#job_failed"})});
test("SHU189_DELIVERY worker registry exposes email delivery interval",()=>{assert.ok(JOB_NAMES.includes("email_delivery"));const jobs=createJobRegistry(new MemoryJobRunsStore(),()=>{},async()=>0);assert.equal(jobs.find(j=>j.name==="email_delivery")?.intervalMs,60_000)});
test("SHU189_DELIVERY Jobs page renders the registered email delivery row",async()=>{const store=new MemoryJobRunsStore(),jobs=createJobRegistry(store,()=>{},async()=>0);const page=createAdminJobs({get:async()=>({personId:"admin"})}as never,{listGrantsForPrincipal:async()=>[{orgId:"root",role:"admin",scope:"self"}]}as never,store,jobs);const result=await page.open("session");assert.equal(result.status,200);assert.match(renderAdminJobs(result),/<th>email_delivery<\/th>/)});
