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
// Only a plain call opens a test body. A member call (`matcher.test(line)`), a
// declaration (`function test(a) { ... }`), and an identifier that merely ends
// in `test`/`it` (`$test(...)`, `#test(...)`, `audit(...)`) are not test calls.
//
// An assertion call is documented as `expect(...)`, a node:assert call
// (`assert(...)`, `assert.ok(...)`, `assert.equal(...)`, ...), a node:test
// context assertion (`t.assert.*`), or a `throw` statement.
//
// Returns an array of { name, start, end } in source order, where `start`/`end`
// are the indices of the body's braces.

const TEST_CALL_RE = /(?<![#$\w])(?:test|it)\s*\(/g;
const RECOGNISED_ASSERTION_RE =
  /\b(?:expect|assert(?:\s*\.\s*[A-Za-z_$][\w$]*)?|t\s*\.\s*assert\s*\.\s*[A-Za-z_$][\w$]*)\s*\(|\bthrow\b/;

function startsRegex(source, index) {
  const prefix = source.slice(0, index).trimEnd();
  if (prefix === "") return true;
  const previous = prefix.at(-1);
  if ("([{:;,=!?&|+-*%^~<>".includes(previous)) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(prefix)?.[1];
  return /^(?:return|throw|case|delete|typeof|void|new|in|of|yield|await|else|do)$/.test(
    word ?? "",
  );
}

function regexEnd(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
    } else if (ch === "[" && !inClass) {
      inClass = true;
    } else if (ch === "]" && inClass) {
      inClass = false;
    } else if (ch === "/" && !inClass) {
      while (/[A-Za-z]/.test(source[i + 1] ?? "")) i += 1;
      return i;
    } else if (ch === "\n" || ch === "\r") {
      return start;
    }
  }
  return start;
}

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
    } else if (ch === "/" && startsRegex(source, i)) {
      const end = regexEnd(source, i);
      if (end !== i) {
        result += " ".repeat(end - i + 1);
        i = end;
      } else {
        result += ch;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      result += " ";
      quote = ch;
    } else {
      result += ch;
    }
  }

  return result;
}

function testName(source, callIndex, bodyStart) {
  for (let start = callIndex; start < bodyStart; start += 1) {
    const quote = source[start];
    if (quote !== '"' && quote !== "'") continue;

    let name = "";
    for (let i = start + 1; i < bodyStart; i += 1) {
      const ch = source[i];
      if (ch === quote) return name;
      if (ch === "\\" && i + 1 < bodyStart) {
        name += source.slice(i, i + 2);
        i += 1;
      } else {
        name += ch;
      }
    }
    return null;
  }
  return null;
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
    } else if (ch === "/" && startsRegex(source, i)) {
      const end = regexEnd(source, i);
      if (end !== i) i = end;
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

// A `test`/`it` identifier only opens a test body when it is called on its own.
// The regex lookbehind rejects the identifiers it is glued to (`$test(`,
// `#test(`, `audit(`); this rejects the two forms that put a token in front:
// a member call (`matcher.test(line)`, `matcher?.test(line)`) and a function
// declaration. `source` is the code-only text, so comments and literals are
// already blanked to spaces and cannot hide the preceding token.
function isTestCall(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;
  if (source[i] === ".") return false;
  const word = /([A-Za-z_$][\w$]*)$/.exec(source.slice(0, i + 1))?.[1];
  return word !== "function";
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
    if (!isTestCall(searchableText, callIndex)) continue;
    const body = braceBody(fileText, callIndex + match[0].length - 1);
    if (!body) continue;
    if (RECOGNISED_ASSERTION_RE.test(codeOnly(body.text))) continue;
    report.push({
      name: testName(fileText, callIndex, body.start),
      start: body.start,
      end: body.end,
    });
  }
  return report;
}
