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

test("does not report a body that rethrows an error", () => {
  const report = scanVacuousTests(
    'test("rethrow", () => { try { risky(); } catch (err) { throw err; } });',
  );
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

test("extracts a quoted test name containing an escaped quote", () => {
  const report = scanVacuousTests(String.raw`test("isn't \"empty\"", () => { work(); });`);
  assert.equal(report.length, 1);
  assert.equal(report[0].name, String.raw`isn't \"empty\"`);
});

test("does not borrow a name from source after an unquoted test name", () => {
  const report = scanVacuousTests('test(dynamicName, () => { work(); }); const later = "wrong";');
  assert.equal(report.length, 1);
  assert.equal(report[0].name, null);
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
  assert.deepEqual(report, []);
});

test("reports a body whose only assertion is inside a block comment", () => {
  const report = scanVacuousTests(
    'test("commented", () => { /* assert.ok(value); */ const value = 1; });',
  );
  assert.deepEqual(report.map((entry) => entry.name), ["commented"]);
});

test("reports a body whose only assertion is inside a line comment or string", () => {
  const source = [
    'test("line-comment", () => { // expect(value).toBe(1);',
    "  const value = 1;",
    "});",
    'test("string", () => { const example = "throw new Error();"; });',
  ].join("\n");
  assert.deepEqual(
    scanVacuousTests(source).map((entry) => entry.name),
    ["line-comment", "string"],
  );
});

test("reports a body whose only assertion is inside a template literal", () => {
  const report = scanVacuousTests(
    'test("template", () => { const example = `assert.ok(value)`; });',
  );
  assert.deepEqual(report.map((entry) => entry.name), ["template"]);
});

test("ignores test-like calls inside comments and string literals", () => {
  const source = [
    '// test("comment", () => { const value = 1; });',
    'const example = \'it("string", () => { const value = 2; });\';',
    '/* it("block", () => { const value = 3; }); */',
    'test("real", () => { const value = 4; });',
  ].join("\n");

  assert.deepEqual(
    scanVacuousTests(source).map((entry) => entry.name),
    ["real"],
  );
});

test("ignores test-like calls inside regular expression literals", () => {
  const source = [
    'const matcher = /test\\("fake", \\(\\) => \\{ work\\(\\); \\}\\)/;',
    'test("real", () => { work(); });',
  ].join("\n");

  assert.deepEqual(
    scanVacuousTests(source).map((entry) => entry.name),
    ["real"],
  );
});

test("does not stop a body at a closing brace inside a regex literal", () => {
  const report = scanVacuousTests(
    'test("regex-brace", () => { const matcher = /[}]/; assert.ok(matcher); });',
  );
  assert.deepEqual(report, []);
});

test("does not recognise assertion text inside a regex literal", () => {
  const report = scanVacuousTests(
    'test("regex-assertion", () => { const matcher = /assert\\.ok\\(value\\)/; });',
  );
  assert.deepEqual(report.map((entry) => entry.name), ["regex-assertion"]);
});

test("does not borrow a later block as the body of a concise arrow test", () => {
  const source = [
    'test("concise", () => assert.ok(value));',
    'test("vacuous", () => { const value = 1; });',
  ].join("\n");

  assert.deepEqual(
    scanVacuousTests(source).map((entry) => entry.name),
    ["vacuous"],
  );
});

test("skips a test call whose argument list holds no brace-delimited body", () => {
  const source = ['test("reference", handler);', "const helper = { value: 1 };"].join("\n");
  assert.deepEqual(scanVacuousTests(source), []);
});

test("reports the indices of the body's own braces", () => {
  const source = 'test("empty", () => { const a = 1; });';
  const [entry] = scanVacuousTests(source);
  assert.equal(source[entry.start], "{");
  assert.equal(source[entry.end], "}");
  assert.equal(source.slice(entry.start, entry.end + 1), "{ const a = 1; }");
});

test("does not take a test name from a block comment in the argument list", () => {
  const report = scanVacuousTests('test(/* "commented" */ dynamicName, () => { work(); });');
  assert.equal(report.length, 1);
  assert.equal(report[0].name, null);
});

test("takes the quoted test name rather than a preceding block comment", () => {
  const report = scanVacuousTests('test(/* skip "decoy" */ "real", () => { work(); });');
  assert.deepEqual(report.map((entry) => entry.name), ["real"]);
});

test("does not take a test name from a line comment in the argument list", () => {
  const source = ['test( // "decoy"', '  "real",', "  () => { work(); },", ");"].join("\n");
  assert.deepEqual(
    scanVacuousTests(source).map((entry) => entry.name),
    ["real"],
  );
});

test("does not take a test name from a regex literal in the argument list", () => {
  const report = scanVacuousTests('test(label.replace(/"decoy"/, "real"), () => { work(); });');
  assert.deepEqual(report.map((entry) => entry.name), ["real"]);
});

test("extracts a template literal test name", () => {
  const report = scanVacuousTests("test(`templated`, () => { work(); });");
  assert.deepEqual(report.map((entry) => entry.name), ["templated"]);
});
