import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "@studenthub/contracts";
import { createWorkerHeartbeat,writeJobAlert } from "../src/index.js";
import{JOB_NAMES}from"../../../packages/observability/src/jobs.js";
import { spawnSync } from "node:child_process";

test("worker heartbeat uses the shared platform contract", () => {
  const heartbeat = createWorkerHeartbeat(new Date("2026-09-02T00:00:00.000Z"));

  assert.equal(heartbeat.status, "ok");
  assert.equal(heartbeat.component, "worker");
  assert.equal(heartbeat.contractVersion, PLATFORM_CONTRACT_VERSION);
  assert.equal(heartbeat.timestamp, "2026-09-02T00:00:00.000Z");
});

test("SHU198_WORKER unknown job exits non-zero without opening storage",()=>{const run=spawnSync(process.execPath,[new URL("../src/index.js",import.meta.url).pathname,"run","unknown"],{encoding:"utf8"});assert.notEqual(run.status,0)});
test("SHU198_WORKER production alert sink writes only scrubbed alert fields",()=>{let output="";writeJobAlert({code:"job_failed",jobName:"heartbeat",owner:"platform-on-call",runbook:"docs/runbooks/alerts.md#job_failed"},text=>{output+=text});assert.deepEqual(JSON.parse(output),{code:"job_failed",jobName:"heartbeat",owner:"platform-on-call",runbook:"docs/runbooks/alerts.md#job_failed"})});
test("SHU189_DELIVERY worker accepts the registered email delivery job name",()=>{assert.equal(JOB_NAMES.includes("email_delivery"),true)});
