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

test("SHU-254 fixture: examines the final line", () => {
  const src = 'const a = 1;\nsendMail(a);';
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "sendMail" }]);
});

test("SHU-254 fixture: reports a single-line source", () => {
  assert.deepEqual(findUnawaitedCalls('loadConfig();'), [
    { line: 1, helper: "loadConfig" },
  ]);
});

test("SHU-254 fixture: ignores helper-shaped text inside string literals", () => {
  assert.deepEqual(findUnawaitedCalls('"fetchJson()"'), []);
  assert.deepEqual(findUnawaitedCalls("const s = 'it\\'s sendMail()';"), []);
  assert.deepEqual(findUnawaitedCalls("const s = `loadConfig()`;"), []);
});

test("SHU-254 fixture: ignores trailing inline comments", () => {
  assert.deepEqual(findUnawaitedCalls("const x = 1; // sendMail()"), []);
  assert.deepEqual(findUnawaitedCalls("const x = 1; /* fetchJson() */"), []);
});

test("SHU-254 fixture: ignores calls inside a multi-line block comment", () => {
  const src = "/*\n sendMail();\n*/\nconst b = 2;";
  assert.deepEqual(findUnawaitedCalls(src), []);
});

test("SHU-254 fixture: accepts any spacing after await", () => {
  assert.deepEqual(findUnawaitedCalls("await  loadConfig()"), []);
  assert.deepEqual(findUnawaitedCalls("await\tsendMail(1);"), []);
  assert.deepEqual(findUnawaitedCalls("await (fetchJson());"), []);
});

test("SHU-254 fixture: still reports real calls beside quoted and awaited text", () => {
  assert.deepEqual(findUnawaitedCalls('log("fetchJson()"); sendMail(1);'), [
    { line: 1, helper: "sendMail" },
  ]);
  assert.deepEqual(findUnawaitedCalls("await fetchJson(); fetchJson();"), [
    { line: 1, helper: "fetchJson" },
  ]);
  assert.deepEqual(findUnawaitedCalls("const s = `x${loadConfig()}`;"), [
    { line: 1, helper: "loadConfig" },
  ]);
});
