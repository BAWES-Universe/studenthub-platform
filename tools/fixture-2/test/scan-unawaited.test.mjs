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
  const src = 'const a = 1;\nsendMail(a);';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "sendMail" }]);
});

test("SHU-254 fixture: reports a call on a single-line input", () => {
  const src = 'loadConfig();';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 1, helper: "loadConfig" }]);
});

test("SHU-254 fixture: still ignores an awaited call on the final line", () => {
  const src = 'const a = 1;\nconst data = await loadConfig();';
  assert.deepEqual(findUnawaitedCalls(src), []);
});
