import assert from "node:assert/strict";
import test from "node:test";

import { generateDataset } from "../../fixtures/src/generate.js";
import { runFullImportDryRun } from "../src/dry-run.js";

test("full-import dry run imports fixtures and reconciles the materialized store", () => {
  const result = runFullImportDryRun("shu-0032");

  assert.equal(result.ok, true);
  assert.equal(result.import.ok, true);
  assert.equal(result.reconciliation.clean, true);
  assert.deepEqual(result.reconciliation.differences, []);
  assert.equal(JSON.stringify(result).includes("@fixture.invalid"), false);
});

test("full-import dry run fails when invariants prevent a complete import", () => {
  const source = generateDataset("shu-0032");
  const broken = { ...source, requests: source.requests.slice(1) };
  const result = runFullImportDryRun("shu-0032", broken);

  assert.equal(result.ok, false);
  assert.equal(result.import.ok, false);
  assert.equal(result.reconciliation.clean, false);
});
