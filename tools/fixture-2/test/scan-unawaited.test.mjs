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

test("SHU-254 fixture: final line still honours await and comments", () => {
  assert.deepEqual(findUnawaitedCalls('const a = 1;\nawait sendMail(a);'), []);
  assert.deepEqual(findUnawaitedCalls('const a = 1;\n// sendMail(a);'), []);
});

test("SHU-254 fixture: empty source yields no findings", () => {
  assert.deepEqual(findUnawaitedCalls(''), []);
});

test("SHU-254 fixture: reports code following a closed block comment", () => {
  assert.deepEqual(findUnawaitedCalls('/* note */ fetchJson();'), [
    { line: 1, helper: "fetchJson" },
  ]);
  assert.deepEqual(findUnawaitedCalls('const a = 1; /* note */ sendMail(a);'), [
    { line: 1, helper: "sendMail" },
  ]);
});

test("SHU-254 fixture: a trailing comment does not hide the call before it", () => {
  assert.deepEqual(findUnawaitedCalls('loadConfig(); // see SHU-254'), [
    { line: 1, helper: "loadConfig" },
  ]);
});

test("SHU-254 fixture: an interrupted await still counts as awaited", () => {
  assert.deepEqual(findUnawaitedCalls('await /* note */ fetchJson("/x");'), []);
});

test("SHU-254 fixture: ignores helpers inside a multi-line block comment", () => {
  const src = '/*\n * fetchJson("/x");\n * sendMail(a);\n */\nconst b = 2;';
  assert.deepEqual(findUnawaitedCalls(src), []);
});

test("SHU-254 fixture: a slash inside a string literal is not a comment", () => {
  assert.deepEqual(findUnawaitedCalls('const url = "http://x"; sendMail(url);'), [
    { line: 1, helper: "sendMail" },
  ]);
  assert.deepEqual(findUnawaitedCalls('fetchJson("http://x");'), [
    { line: 1, helper: "fetchJson" },
  ]);
});

test("SHU-254 fixture: a slash inside a multi-line template literal is not a comment", () => {
  const src = "const message = `first\nhttp://example`; sendMail();";
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "sendMail" }]);
});

test("SHU-254 fixture: scans the line that closes a multi-line template literal", () => {
  const src = "const t = `a\nb`; loadConfig(); // done";
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "loadConfig" }]);
  assert.deepEqual(findUnawaitedCalls("const t = `a\nb`; await loadConfig();"), []);
});

test("SHU-254 fixture: an unterminated quote does not swallow later lines", () => {
  const src = "const s = 'oops;\nsendMail(a);";
  assert.deepEqual(findUnawaitedCalls(src), [{ line: 2, helper: "sendMail" }]);
});

test("SHU-254 fixture: an apostrophe in a block comment does not swallow the code", () => {
  assert.deepEqual(findUnawaitedCalls("/* don't wait */ fetchJson();"), [
    { line: 1, helper: "fetchJson" },
  ]);
});

test("SHU-254 fixture: resumes scanning on the line that closes a block comment", () => {
  const src = '/* fetchJson("/x");\n   still a comment */ sendMail(a);\nloadConfig();';
  assert.deepEqual(findUnawaitedCalls(src), [
    { line: 2, helper: "sendMail" },
    { line: 3, helper: "loadConfig" },
  ]);
});
