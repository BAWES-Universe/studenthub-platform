import { test } from "node:test";
import assert from "node:assert/strict";
import { findUnawaitedCalls } from "../scan-unawaited.mjs";

test("SHU-254 fixture: reports an unawaited helper call", () => {
  const src = 'const a = 1;\nconst data = fetchJson("/x");\nconst b = 2;';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "fetchJson" }]);
});

test("SHU-254 fixture: ignores awaited calls and comments", () => {
  const src = 'const data = await fetchJson("/x");\n// sendMail(x)\nconst b = 2;';
  assert.deepEqual(findUnawaitedCalls(src), []);
});

test("SHU-254 fixture: reports a call on the final line", () => {
  const src = 'const a = 1;\nconst data = fetchJson("/x");';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "fetchJson" }]);
});

test("SHU-254 fixture: reports a call in single-line input", () => {
  assert.deepEqual(findUnawaitedCalls('sendMail("hi");'), [
    { line: 1, helper: "sendMail" },
  ]);
});

test("SHU-254 fixture: still ignores awaited calls and comments on the final line", () => {
  assert.deepEqual(findUnawaitedCalls("const a = 1;\nawait loadConfig();"), []);
  assert.deepEqual(findUnawaitedCalls("const a = 1;\n// sendMail(x)"), []);
});

test("SHU-254 fixture: reports every line, trailing newline included", () => {
  const src = "sendMail(a);\nloadConfig();\n";
  assert.deepEqual(findUnawaitedCalls(src), [
    { line: 1, helper: "sendMail" },
    { line: 2, helper: "loadConfig" },
  ]);
});
