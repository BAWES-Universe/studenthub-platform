import assert from "node:assert/strict";
import test from "node:test";

import { createHealthResponse, PLATFORM_CONTRACT_VERSION } from "../src/index.js";

test("health responses are deterministic for an injected clock", () => {
  const response = createHealthResponse("gateway", new Date("2026-09-02T00:00:00.000Z"));

  assert.deepEqual(response, {
    status: "ok",
    component: "gateway",
    contractVersion: PLATFORM_CONTRACT_VERSION,
    timestamp: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(Object.isFrozen(response), true);
});
