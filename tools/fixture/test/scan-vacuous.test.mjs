// tools/fixture/test/scan-vacuous.test.mjs — SHU-63 fixture lane (NON-PRODUCTION).
//
// Tests for the documented scanVacuousTests contract (see ../scan-vacuous.mjs).
// Never merged to main.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanVacuousTests } from "../scan-vacuous.mjs";

test("reports a test body that contains no assertion call", () => {
  const report = scanVacuousTests('test("empty", () => { const a = 1; });');
  assert.equal(report.length, 1);
  assert.equal(report[0].name, "empty");
});

test("does not report a test body that calls expect", () => {
  const report = scanVacuousTests('test("ok", () => { expect(1).toBe(1); });');
  assert.equal(report.length, 0);
});

test("does not report node:assert calls", () => {
  const source = [
    'test("callable", () => { assert(value); });',
    'test("method", () => { assert.equal(actual, expected); });',
  ].join("\n");
  assert.deepEqual(scanVacuousTests(source), []);
});

test("does not report node:test context assertions", () => {
  const report = scanVacuousTests(
    'test("context", (t) => { t.assert.deepEqual(actual, expected); });',
  );
  assert.deepEqual(report, []);
});

test("does not report a body that throws", () => {
  const report = scanVacuousTests('it("throws", () => { throw new Error("boom"); });');
  assert.deepEqual(report, []);
});

test("returns an empty report for a file that declares no tests", () => {
  const report = scanVacuousTests("export const x = 1;\n");
  assert.deepEqual(report, []);
});

test("reports every vacuous body in source order", () => {
  const source = [
    'test("first", () => { const a = 1; });',
    'test("second", () => { expect(a).toBe(1); });',
    'test("third", () => { let b = 2; });',
  ].join("\n");
  const report = scanVacuousTests(source);
  assert.deepEqual(report.map((r) => r.name), ["first", "third"]);
});

test("rejects a non-string argument with a TypeError", () => {
  assert.throws(() => scanVacuousTests(42), TypeError);
});

// A body that asserts is never reported.
test("a body that already asserts is not reported", () => {
  const report = scanVacuousTests('test("asserts", () => { assert.ok(true); });');
  assert.deepEqual(report, []);
});

// SHU-232-SEEDED-VACUOUS
test("does not stop a body at a closing brace inside a string literal", () => {
  const report = scanVacuousTests(
    'test("string-brace", () => { const value = "}"; assert.ok(value); });',
  );
  const expected = [];
  assert.deepEqual(expected, []);
});
