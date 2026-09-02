import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "../../../packages/contracts/src/index.js";
import { createWorkerHeartbeat } from "../src/index.js";

test("worker heartbeat uses the shared platform contract", () => {
  const heartbeat = createWorkerHeartbeat(new Date("2026-09-02T00:00:00.000Z"));

  assert.equal(heartbeat.status, "ok");
  assert.equal(heartbeat.component, "worker");
  assert.equal(heartbeat.contractVersion, PLATFORM_CONTRACT_VERSION);
  assert.equal(heartbeat.timestamp, "2026-09-02T00:00:00.000Z");
});
