// tools/fixture/scan-vacuous.mjs — SHU-63 fixture lane (NON-PRODUCTION).
//
// This lane exists only to exercise the unattended build -> BLOCK -> revision ->
// re-review loop on the SHU-140 fixture card. It is never merged to main.
//
// CONTRACT
// scanVacuousTests(fileText) reports test bodies that contain no assertion
// call. A "test body" is the block of the callback that a `test(...)` or
// `it(...)` call receives: the brace-delimited block of the arrow function or
// function expression found inside that call's own argument list. Text outside
// the argument list can never become a body, and neither an options object nor
// a destructured parameter is a body. A callback with a concise expression body
// has no block to report, so it is never reported. A body is VACUOUS when no
// assertion call appears inside it.
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

/**
 * Yield the index of every character of `source` at or after `from` that is
 * code: characters inside comments, string and template literals, and regex
 * literals are skipped. This is the single place that knows how to step over
 * non-code text, so every scan below stays consistent with every other one.
 */
function* codeIndices(source, from) {
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = from; i < source.length; i += 1) {
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
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && startsRegex(source, i)) {
      const end = regexEnd(source, i);
      if (end !== i) {
        i = end;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    yield i;
  }
}

// Blank every non-code character, keeping line breaks and every source index
// exactly where it was. split("") keeps the mapping code-unit aligned.
function codeOnly(source) {
  const blanked = source
    .split("")
    .map((ch) => (ch === "\n" || ch === "\r" ? ch : " "));
  for (const i of codeIndices(source, 0)) blanked[i] = source[i];
  return blanked.join("");
}

// Index of the next code character at or after `index`, skipping whitespace and
// comments only. Used to look at the token that follows `=>`.
function nextCodeIndex(source, index) {
  for (const i of codeIndices(source, index)) {
    if (!/\s/.test(source[i])) return i;
  }
  return source.length;
}

function isFunctionKeyword(source, index) {
  if (!source.startsWith("function", index)) return false;
  const before = source[index - 1];
  const after = source[index + "function".length];
  return !/[\w$]/.test(before ?? "") && !/[\w$]/.test(after ?? "");
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

// Match the block that opens at `openIndex`.
function blockAt(source, openIndex) {
  let depth = 0;

  for (const i of codeIndices(source, openIndex)) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: openIndex, end: i, text: source.slice(openIndex, i + 1) };
      }
    }
  }
  return null;
}

/**
 * Locate the callback body of the test call whose opening parenthesis is at
 * `parenIndex`. The search never leaves that argument list, so a later
 * statement's block can never be mistaken for this call's body. Returns null
 * when the call has no block body — including a callback written with a concise
 * expression body, which has no braces to report.
 *
 * Only the callback the call receives directly can carry the body, so the
 * `=>` and `function` tokens that mark it are recognised at the top level of
 * the argument list alone: paren depth 1 with no object, array or parameter
 * list open around them. A `=>` nested in a parameter default value, in an
 * options object or in another call's arguments belongs to that inner
 * function, not to the test.
 */
function locateBody(source, parenIndex) {
  let depth = 0;
  let nesting = 0;
  let sawFunction = false;

  for (const i of codeIndices(source, parenIndex)) {
    const ch = source[i];
    const topLevel = depth === 1 && nesting === 0;

    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return null;
    } else if (ch === "[") {
      nesting += 1;
    } else if (ch === "]") {
      nesting -= 1;
    } else if (ch === "{") {
      // The body of a function expression is the first block that follows the
      // keyword at the top level, which skips the parameter list and any
      // destructuring or default value inside it.
      if (topLevel && sawFunction) return blockAt(source, i);
      nesting += 1;
    } else if (ch === "}") {
      nesting -= 1;
    } else if (ch === "=" && source[i + 1] === ">") {
      if (!topLevel) continue;
      // The body is the block that directly follows the arrow; anything else
      // there is a concise expression body.
      const bodyStart = nextCodeIndex(source, i + 2);
      return source[bodyStart] === "{" ? blockAt(source, bodyStart) : null;
    } else if (topLevel && isFunctionKeyword(source, i)) {
      sawFunction = true;
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
  // literals from candidate discovery. locateBody still receives the original
  // source so the reported brace indices remain exact.
  const searchableText = codeOnly(fileText);
  TEST_CALL_RE.lastIndex = 0;
  let match;
  while ((match = TEST_CALL_RE.exec(searchableText)) !== null) {
    const callIndex = match.index;
    const body = locateBody(fileText, callIndex + match[0].length - 1);
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
