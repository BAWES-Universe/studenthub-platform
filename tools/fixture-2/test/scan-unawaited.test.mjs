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

test("SHU-254 fixture: ignores an awaited call on the final line", () => {
  const src = 'const a = 1;\nconst data = await sendMail("/x");';
  assert.deepEqual(findUnawaitedCalls(src), []);
});

test("SHU-254 fixture: handles a trailing newline", () => {
  const src = 'loadConfig();\n';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 1, helper: "loadConfig" }]);
});
