// SHU-63 fixture — declared acceptance oracle for the `scanVacuousTests` contract.
//
// Each row states the report the helper MUST produce for `src`, per the contract
// documented in tools/fixture/scan-vacuous.mjs (lines 19-22): a body is VACUOUS
// when no assertion CALL appears inside it, where an assertion call is
// `expect(...)`, a node:assert call, a node:test context assertion, or a `throw`
// statement.
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
    name: "a body whose assertion is mentioned only inside a block comment",
    src: 'test("commented", () => { /* assert.ok(x); */ const a = 1; });',
    expected: ["commented"],
  },
]);
