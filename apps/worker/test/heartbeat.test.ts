import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "@studenthub/contracts";
import { createWorkerHeartbeat } from "../src/index.js";
import {runWorkerCommand}from"../src/index.js";import{InMemoryJobStore}from"../../../packages/observability/src/jobs.js";

test("worker heartbeat uses the shared platform contract", () => {
  const heartbeat = createWorkerHeartbeat(new Date("2026-09-02T00:00:00.000Z"));

  assert.equal(heartbeat.status, "ok");
  assert.equal(heartbeat.component, "worker");
  assert.equal(heartbeat.contractVersion, PLATFORM_CONTRACT_VERSION);
  assert.equal(heartbeat.timestamp, "2026-09-02T00:00:00.000Z");
});
test("SHU198_WORKER named jobs use runner and unknown records nothing",async()=>{const store=new InMemoryJobStore();await runWorkerCommand(["run","heartbeat"],store);assert.equal(store.runs[0]?.jobName,"heartbeat");await assert.rejects(runWorkerCommand(["run","unknown"],store));assert.equal(store.runs.length,1)});
