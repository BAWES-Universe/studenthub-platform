// tools/fixture/scan-vacuous.mjs — SHU-63 fixture lane (NON-PRODUCTION).
//
// This lane exists only to exercise the unattended build -> BLOCK -> revision ->
// re-review loop on the SHU-140 fixture card. It is never merged to main.
//
// CONTRACT
// scanVacuousTests(fileText) reports test bodies that contain no assertion
// call. A "test body" is the body of a `test(...)` or `it(...)` call: the first
// brace-delimited block that follows the call's opening parenthesis. A body is
// VACUOUS when no assertion call appears inside it.
//
// An assertion call is documented as `expect(...)`, a node:assert call
// (`assert(...)`, `assert.ok(...)`, `assert.equal(...)`, ...), a node:test
// context assertion (`t.assert.*`), or a `throw` statement.
//
// SEEDED REVISION — the recognition set above is NOT complete in this revision:
// only `expect(` is recognised today. `assert`, `t.assert` and `throw` are
// documented but unimplemented (see the fixture issue). That is the bounded work
// the builder lane is asked to finish.
//
// Returns an array of { name, start, end } in source order, where `start`/`end`
// are the indices of the body's braces.

const TEST_CALL_RE = /\b(?:test|it)\s*\(/g;
const RECOGNISED_ASSERTION_RE = /\bexpect\s*\(/;

function testName(source, callIndex) {
  const quoteIndex = source.indexOf("\"", callIndex);
  const altQuoteIndex = source.indexOf("'", callIndex);
  const indexes = [quoteIndex, altQuoteIndex].filter((i) => i !== -1);
  if (indexes.length === 0) return null;
  const start = Math.min(...indexes);
  const quote = source[start];
  const end = source.indexOf(quote, start + 1);
  if (end === -1) return null;
  return source.slice(start + 1, end);
}

function braceBody(source, callIndex) {
  const open = source.indexOf("{", callIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start: open, end: i, text: source.slice(open, i + 1) };
    }
  }
  return null;
}

/**
 * Report the test bodies in `fileText` that contain no recognised assertion.
 * Pure: no I/O, no globals. Throws TypeError for a non-string input.
 */
export function scanVacuousTests(fileText) {
  if (typeof fileText !== "string") {
    throw new TypeError("scanVacuousTests(fileText): fileText must be a string");
  }
  const report = [];
  TEST_CALL_RE.lastIndex = 0;
  let match;
  while ((match = TEST_CALL_RE.exec(fileText)) !== null) {
    const callIndex = match.index;
    const body = braceBody(fileText, callIndex + match[0].length - 1);
    if (!body) continue;
    if (RECOGNISED_ASSERTION_RE.test(body.text)) continue;
    report.push({ name: testName(fileText, callIndex), start: body.start, end: body.end });
  }
  return report;
}
