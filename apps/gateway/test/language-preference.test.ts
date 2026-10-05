import assert from "node:assert/strict";
import test from "node:test";

import { failedScenarios, runSafeWriteConformance, SAFE_WRITE_SCENARIOS } from "@studenthub/safe-write-contract";
import { buildSafeWrite, LANGUAGE_POLICY } from "../src/language-preference.js";

test("SHU-84/AC-01 CONFORMANCE the builder the gateway serves passes SHU-82's suite unmodified", async () => {
  const report = await runSafeWriteConformance((input) => buildSafeWrite(input));
  assert.deepEqual(failedScenarios(report), []);
  assert.equal(report.results.length, SAFE_WRITE_SCENARIOS.length);
  assert.equal(report.ok, true);
});

test("SHU-84/AC-01 CONFORMANCE the served policy permits exactly one field", () => {
  assert.deepEqual(LANGUAGE_POLICY, { allowed: ["language"], maxValueLength: 2 });
  assert.ok(Object.isFrozen(LANGUAGE_POLICY) && Object.isFrozen(LANGUAGE_POLICY.allowed));
});
