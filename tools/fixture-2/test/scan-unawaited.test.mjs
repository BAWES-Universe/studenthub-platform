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

test("SHU-254 fixture: reports a call on the final line without a trailing newline", () => {
  const src = 'const a = 1;\nsendMail(a);';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "sendMail" }]);
});

test("SHU-254 fixture: reports a call on the final line with a trailing newline", () => {
  const src = 'const a = 1;\nloadConfig();\n';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "loadConfig" }]);
});

test("SHU-254 fixture: reports a call in a single-line file", () => {
  assert.deepEqual(findUnawaitedCalls('fetchJson("/x");'), [
    { line: 1, helper: "fetchJson" },
  ]);
});
