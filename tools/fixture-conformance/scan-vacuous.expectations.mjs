// SHU-63 fixture — declared acceptance oracle for the `scanVacuousTests` contract.
//
// Each row states the report the helper MUST produce for `src`, per the CONTRACT
// block of tools/fixture/scan-vacuous.mjs: a body is VACUOUS when no assertion
// CALL appears inside it, where an assertion call is `expect(...)`, a node:assert
// call, a node:test context assertion, or a `throw` statement.
//
// Assertion text that appears only inside a comment, a string literal, a template
// literal, or a regex literal is not a call, so such a body IS vacuous. Likewise
// `throw` counts only as a statement: a body whose only `throw` names a property
// (`reporter.throw`, `{ throw: handler }`, `{ throw() {} }`) IS vacuous.
//
// This directory is the fixture's acceptance oracle. It lives OUTSIDE the
// fixture's own directory on purpose: it is consumed by the reviewer at review
// time, and the fixture lane runs no package script over it, so a row that
// disagrees with the contract is invisible to `node --test` and can only be
// caught by reading it against the contract.
export const EXPECTATIONS = Object.freeze([
  {
    name: "a body with no assertion at all",
    src: 'test("empty", () => { const a = 1; });',
    expected: ["empty"],
  },
  {
    name: "a callable node:assert call",
    src: 'test("callable", () => { assert(value); });',
    expected: [],
  },
  {
    name: "a method-style expect call",
    src: 'test("ok", () => { expect(1).toBe(1); });',
    expected: [],
  },
  {
    name: "a node:test context assertion",
    src: 'test("ctx", (t) => { t.assert.deepEqual(a, b); });',
    expected: [],
  },
  {
    name: "a bare rethrow inside a catch",
    src: 'test("rethrow", () => { try { risky(); } catch (err) { throw err; } });',
    expected: [],
  },
  {
    // `throw` is reserved, so these three uses all name a property rather than
    // heading a throw statement, and the body asserts nothing.
    name: "a body whose only `throw` reads a property",
    src: 'test("property", () => { reporter.throw; });',
    expected: ["property"],
  },
  {
    name: "a body whose only `throw` is a property key",
    src: 'test("key", () => { const handlers = { throw: onError }; });',
    expected: ["key"],
  },
  {
    name: "a body whose only `throw` names a method",
    src: 'test("method", () => { const stub = { throw() {} }; });',
    expected: ["method"],
  },
  {
    name: "a throw statement with a parenthesised operand",
    src: 'test("parens", () => { throw (new Error("boom")); });',
    expected: [],
  },
  {
    name: "a body whose assertion is mentioned only inside a block comment",
    src: 'test("commented", () => { /* assert.ok(x); */ const a = 1; });',
    expected: ["commented"],
  },
  {
    name: "a body whose assertion is mentioned only inside a string literal",
    src: 'test("stub", () => { const s = "assert.equal(1, 2)"; });',
    expected: ["stub"],
  },
  {
    name: "a body whose assertion is mentioned only inside a template literal",
    src: "test(\"tpl\", () => { const s = `assert.equal(1, 2)`; });",
    expected: ["tpl"],
  },
  {
    name: "a body whose assertion is mentioned only inside a regex literal",
    src: 'test("re", () => { const matcher = /assert\\.ok\\(value\\)/; });',
    expected: ["re"],
  },
  {
    // A regex literal is valid wherever a statement is, including directly
    // after the `)` of a condition, so the fake declaration it spells out is
    // not a test declaration and contributes no body.
    name: "a fake test declaration inside a regex literal in statement position",
    src: 'if (ready) /test\\("fake", \\(\\) => \\{ work\\(\\); \\}\\)/.test(value);',
    expected: [],
  },
]);
