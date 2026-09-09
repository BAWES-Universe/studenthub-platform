import assert from "node:assert/strict";
import test from "node:test";

import { createHealthResponse, PLATFORM_CONTRACT_VERSION } from "../src/index.js";

test("health responses are deterministic for an injected clock", () => {
  const response = createHealthResponse("gateway", new Date("2026-09-02T00:00:00.000Z"), null);

  assert.deepEqual(response, {
    status: "ok",
    component: "gateway",
    contractVersion: PLATFORM_CONTRACT_VERSION,
    revision: null,
    timestamp: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(Object.isFrozen(response), true);
});

test("health responses echo an injected source revision verbatim", () => {
  const sha = "5b0dfa00f32bf9851cab3c5b00ab0cc1c02f2dfd";
  const response = createHealthResponse(
    "gateway",
    new Date("2026-09-02T00:00:00.000Z"),
    sha,
  );

  assert.equal(response.revision, sha);
});

test("health responses never trust a runtime SOURCE_REVISION override", () => {
  const previous = process.env.SOURCE_REVISION;
  try {
    process.env.SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
    const response = createHealthResponse("gateway");
    assert.equal(response.revision, null);
  } finally {
    if (previous === undefined) {
      delete process.env.SOURCE_REVISION;
    } else {
      process.env.SOURCE_REVISION = previous;
    }
  }
});
