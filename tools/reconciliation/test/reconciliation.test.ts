import assert from "node:assert/strict";
import test from "node:test";

import { generateDataset } from "../../fixtures/src/generate.js";
import type { FixtureDataset } from "../../fixtures/src/types.js";
import { findUnredacted } from "../src/redaction.js";
import { reconcile } from "../src/reconcile.js";

const source = generateDataset("shu-0032");

test("identical datasets reconcile clean", () => {
  const report = reconcile(source, generateDataset("shu-0032"));

  assert.equal(report.clean, true);
  assert.deepEqual(report.differences, []);
  for (const entity of ["organizations", "candidates", "requests", "applications"] as const) {
    assert.equal(report.counts[entity].source, report.counts[entity].target);
    assert.equal(report.hashes[entity].source, report.hashes[entity].target);
  }
});

test("a missing row is reported by id against the right entity", () => {
  const target: FixtureDataset = { ...source, candidates: source.candidates.slice(1) };

  const report = reconcile(source, target);
  const difference = report.differences.find((entry) => entry.entity === "candidates");

  assert.equal(report.clean, false);
  assert.deepEqual(difference?.missingInTarget, [source.candidates[0]!.id]);
  assert.deepEqual(difference?.extraInTarget, []);
  assert.deepEqual(difference?.changed, []);
  assert.equal(report.counts.candidates.target, report.counts.candidates.source - 1);
});

test("a changed row is reported as changed, not as missing plus extra", () => {
  const target: FixtureDataset = {
    ...source,
    candidates: source.candidates.map((candidate, index) =>
      index === 2 ? { ...candidate, status: "inactive" as const } : candidate,
    ),
  };

  const difference = reconcile(source, target).differences.find(
    (entry) => entry.entity === "candidates",
  );

  assert.deepEqual(difference?.changed, [source.candidates[2]!.id]);
  assert.deepEqual(difference?.missingInTarget, []);
  assert.deepEqual(difference?.extraInTarget, []);
});

test("reports carry counts, hashes and ids — never field values", () => {
  const target: FixtureDataset = { ...source, candidates: source.candidates.slice(2) };
  const serialised = JSON.stringify(reconcile(source, target));

  for (const candidate of source.candidates) {
    assert.equal(serialised.includes(candidate.email), false, candidate.id);
    assert.equal(serialised.includes(candidate.displayName), false, candidate.id);
  }
  assert.deepEqual(findUnredacted(JSON.parse(serialised)), []);
});

test("the redaction guard catches a real address or a phone-shaped run", () => {
  const leaky = { note: "reach me at person@example.com" };
  const phoneish = { note: "ref 96599123456" };

  assert.deepEqual(findUnredacted(leaky), [{ kind: "email", at: "$.note" }]);
  assert.deepEqual(findUnredacted(phoneish), [{ kind: "digits", at: "$.note" }]);
  assert.deepEqual(findUnredacted({ note: "candidate-0001@fixture.invalid" }), []);
});

test("a content digest is not mistaken for a phone number", () => {
  // sha256 hex routinely contains 7+ consecutive digits; digests are our own
  // hashes and must not trip the contact-data check.
  assert.deepEqual(findUnredacted({ hash: "a".repeat(1) + "1234567890123456789012345678901234567890123456789012345678901b" }), []);
  assert.deepEqual(findUnredacted({ digest: "ab12cd3456789f" }), []);
});

test("a bare digit run is still caught even at digest length", () => {
  // All-decimal, no a-f: a phone number, not a digest.
  assert.deepEqual(findUnredacted({ note: "961234567890" }), [{ kind: "digits", at: "$.note" }]);
});

test("the guard walks nested structures and names the path", () => {
  const nested = { rows: [{ ok: "fine" }, { contact: "real.person@bawes.net" }] };

  assert.deepEqual(findUnredacted(nested), [{ kind: "email", at: "$.rows[1].contact" }]);
});
