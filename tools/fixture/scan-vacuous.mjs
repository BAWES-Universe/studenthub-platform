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
// Returns an array of { name, start, end } in source order, where `start`/`end`
// are the indices of the body's braces.

const TEST_CALL_RE = /\b(?:test|it)\s*\(/g;
const RECOGNISED_ASSERTION_RE =
  /\b(?:expect|assert(?:\s*\.\s*[A-Za-z_$][\w$]*)?|t\s*\.\s*assert\s*\.\s*[A-Za-z_$][\w$]*)\s*\(|\bthrow\b/;

function codeOnly(source) {
  let result = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n" || ch === "\r") {
        lineComment = false;
        result += ch;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      result += ch === "\n" || ch === "\r" ? ch : " ";
      if (ch === "*" && next === "/") {
        result += " ";
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      result += ch === "\n" || ch === "\r" ? ch : " ";
      if (ch === "\\") {
        if (i + 1 < source.length) {
          result += " ";
          i += 1;
        }
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      result += "  ";
      lineComment = true;
      i += 1;
    } else if (ch === "/" && next === "*") {
      result += "  ";
      blockComment = true;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      result += " ";
      quote = ch;
    } else {
      result += ch;
    }
  }

  return result;
}

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
  let open = -1;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = callIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
    } else if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      if (open === -1) open = i;
      depth += 1;
    } else if (ch === "}" && open !== -1) {
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
  // Keep source positions intact while excluding test-like text in comments and
  // literals from candidate discovery. braceBody still receives the original
  // source so the reported brace indices remain exact.
  const searchableText = codeOnly(fileText);
  TEST_CALL_RE.lastIndex = 0;
  let match;
  while ((match = TEST_CALL_RE.exec(searchableText)) !== null) {
    const callIndex = match.index;
    const body = braceBody(fileText, callIndex + match[0].length - 1);
    if (!body) continue;
    if (RECOGNISED_ASSERTION_RE.test(codeOnly(body.text))) continue;
    report.push({ name: testName(fileText, callIndex), start: body.start, end: body.end });
  }
  return report;
}
