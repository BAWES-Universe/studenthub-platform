import assert from "node:assert/strict";
import test from "node:test";

import { generateDataset } from "../../fixtures/src/generate.js";
import type { FixtureDataset } from "../../fixtures/src/types.js";
import { checkInvariants } from "../src/invariants.js";
import { ImportStore, runImport } from "../src/import.js";

const dataset = generateDataset("shu-0032");

test("a generated dataset satisfies every invariant", () => {
  assert.deepEqual(checkInvariants(dataset), []);
});

test("import is idempotent — the second run writes nothing", () => {
  const store = new ImportStore();

  const first = runImport(store, dataset);
  assert.equal(first.ok, true);
  assert.equal(first.conflicts.length, 0);
  const writtenRows = store.size;
  assert.ok(writtenRows > 0);

  const second = runImport(store, dataset);
  assert.equal(second.ok, true);
  assert.equal(store.size, writtenRows, "repeat import must not write new rows");
  assert.deepEqual(second.inserted, {
    organizations: 0,
    candidates: 0,
    requests: 0,
    applications: 0,
  });
  assert.deepEqual(second.unchanged, first.inserted);
});

test("a changed row is reported as a conflict and never overwritten", () => {
  const store = new ImportStore();
  runImport(store, dataset);

  const mutated: FixtureDataset = {
    ...dataset,
    candidates: dataset.candidates.map((candidate, index) =>
      index === 0 ? { ...candidate, status: "inactive" as const, displayName: "Zulu Zulu" } : candidate,
    ),
  };

  const result = runImport(store, mutated);

  assert.equal(result.ok, false);
  assert.equal(result.conflicts.length, 1);
  const [conflict] = result.conflicts;
  assert.equal(conflict?.entity, "candidates");
  assert.equal(conflict?.id, dataset.candidates[0]?.id);
  assert.notEqual(conflict?.existingHash, conflict?.incomingHash);
  assert.deepEqual(store.get("candidates", conflict!.id), dataset.candidates[0]);
  assert.equal(JSON.stringify(result.conflicts).includes("Zulu"), false);
});

test("referential breaks are reported with rule, entity and id", () => {
  const broken: FixtureDataset = {
    ...dataset,
    applications: [
      { id: "app-9999", requestId: "req-missing", candidateId: "cand-missing", stage: "applied" },
    ],
  };

  const violations = checkInvariants(broken);
  const rules = violations.map((violation) => violation.rule).sort();

  assert.deepEqual(rules, [
    "referential.application.candidate",
    "referential.application.request",
  ]);
  for (const violation of violations) {
    assert.equal(violation.entity, "applications");
    assert.equal(violation.id, "app-9999");
    assert.ok(violation.detail.length > 0);
  }
});

test("an invariant failure aborts the import before any write", () => {
  const store = new ImportStore();
  const broken: FixtureDataset = {
    ...dataset,
    requests: dataset.requests.map((request, index) =>
      index === 0 ? { ...request, openings: 0 } : request,
    ),
  };

  const result = runImport(store, broken);

  assert.equal(result.ok, false);
  assert.equal(store.size, 0, "nothing may be written when invariants fail");
  assert.ok(result.violations.some((violation) => violation.rule === "business.request.openings"));
});

test("duplicate contact is reported by digest, not by address", () => {
  const duplicated: FixtureDataset = {
    ...dataset,
    candidates: [
      dataset.candidates[0]!,
      { ...dataset.candidates[1]!, email: dataset.candidates[0]!.email },
    ],
  };

  const violations = checkInvariants(duplicated).filter(
    (violation) => violation.rule === "business.candidate.uniqueEmail",
  );

  assert.equal(violations.length, 1);
  assert.equal(JSON.stringify(violations).includes(dataset.candidates[0]!.email), false);
});

test("duplicate ids are rejected before import", () => {
  const duplicated: FixtureDataset = {
    ...dataset,
    organizations: [dataset.organizations[0]!, dataset.organizations[0]!],
  };

  const store = new ImportStore();
  const result = runImport(store, duplicated);

  assert.equal(result.ok, false);
  assert.equal(store.size, 0);
  assert.ok(result.violations.some((violation) => violation.rule === "structural.entity.uniqueId"));
});
