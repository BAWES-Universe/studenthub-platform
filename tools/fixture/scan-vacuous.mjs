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
// Only a bare `test`/`it` reference declares a test. A property call such as
// `matcher.test(value)` or `harness.it(...)` is not a test declaration and so
// contributes no body; that excludes the dotted subtest forms (`t.test(...)`)
// too.
//
// An assertion call is documented as `expect(...)`, a node:assert call
// (`assert(...)`, `assert.ok(...)`, `assert.equal(...)`, ...), a node:test
// context assertion (`t.assert.*`), or a `throw` statement.
//
// Only a `throw` statement asserts. `throw` is a reserved word, so its legal
// non-statement uses all name a property -- a property read (`reporter.throw`),
// a property key (`{ throw: handler }`), and a method definition
// (`{ throw() {} }`) -- and none of those make a body non-vacuous.
//
// Returns an array of { name, start, end } in source order, where `start`/`end`
// are the indices of the body's braces.

const TEST_CALL_RE = /\b(?:test|it)\s*\(/g;
const RECOGNISED_ASSERTION_CALL_RE =
  /\b(?:expect|assert(?:\s*\.\s*[A-Za-z_$][\w$]*)?|t\s*\.\s*assert\s*\.\s*[A-Za-z_$][\w$]*)\s*\(/;
const THROW_TOKEN_RE = /\bthrow\b/g;
// Characters that close or separate an expression, so none of them can begin
// the operand a throw statement requires.
const NON_OPERAND_START = ":;,)]}";

const REGEX_PREFIX_PUNCTUATION = "([{:;,=!?&|+-*%^~<>";
const REGEX_PREFIX_KEYWORD_RE =
  /^(?:return|throw|case|delete|typeof|void|new|in|of|yield|await|else|do)$/;
// `)` normally ends an expression, so a following `/` divides. The exception is
// the `)` that closes one of these heads: what follows it is a statement, and a
// statement may begin with a regex literal (`if (ready) /re/.test(value);`).
const STATEMENT_HEAD_KEYWORD_RE = /^(?:if|while|for|with)$/;

function precedingWord(text) {
  return /([A-Za-z_$][\w$]*)$/.exec(text)?.[1] ?? "";
}

// Index of the `"`/`'`/`` ` `` that opens the literal closed at `closeIndex`,
// or `closeIndex` itself when no opener is found.
function quoteStart(text, closeIndex) {
  const quote = text[closeIndex];
  for (let i = closeIndex - 1; i >= 0; i -= 1) {
    if (text[i] !== quote) continue;
    let backslashes = 0;
    while (text[i - 1 - backslashes] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return i;
  }
  return closeIndex;
}

// Index of the `(` matched by the `)` at `closeIndex`, or -1. Quoted text is
// stepped over so a parenthesis inside a string literal cannot close the group.
function matchingOpenParen(text, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = quoteStart(text, i);
    } else if (ch === ")") {
      depth += 1;
    } else if (ch === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function startsRegex(source, index) {
  const prefix = source.slice(0, index).trimEnd();
  if (prefix === "") return true;
  const previous = prefix.at(-1);
  if (REGEX_PREFIX_PUNCTUATION.includes(previous)) return true;
  if (previous === ")") {
    const open = matchingOpenParen(prefix, prefix.length - 1);
    if (open === -1) return false;
    return STATEMENT_HEAD_KEYWORD_RE.test(
      precedingWord(prefix.slice(0, open).trimEnd()),
    );
  }
  return REGEX_PREFIX_KEYWORD_RE.test(precedingWord(prefix));
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

function isPropertyCall(source, index) {
  // `\b` in TEST_CALL_RE treats the dot of `matcher.test(value)` as a word
  // boundary, so the member name matches like a bare call. Anything whose
  // callee is a property access is not a test declaration.
  return source.slice(0, index).trimEnd().endsWith(".");
}

// Index of the first non-whitespace character at or after `from`, or -1.
function nextCodeIndex(code, from) {
  for (let i = from; i < code.length; i += 1) {
    if (!/\s/.test(code[i])) return i;
  }
  return -1;
}

// Index just past the `)` matched by the `(` at `openIndex`, or -1. Only valid
// on code-only text, where a parenthesis inside a literal is already blanked.
function afterMatchingCloseParen(code, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === "(") {
      depth += 1;
    } else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Whether `code` (code-only text) contains a `throw` statement. A bare `throw`
// token is not enough: the contract recognises only the statement, so the
// property uses of the reserved word are rejected here.
function hasThrowStatement(code) {
  THROW_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = THROW_TOKEN_RE.exec(code)) !== null) {
    // `reporter.throw` / `reporter?.throw` reads a property named `throw`.
    if (code.slice(0, match.index).trimEnd().endsWith(".")) continue;

    const operand = nextCodeIndex(code, match.index + match[0].length);
    // A throw statement throws an operand; `{ throw: handler }` has a `:` here
    // because the word is a property key instead.
    if (operand === -1 || NON_OPERAND_START.includes(code[operand])) continue;

    // `{ throw() {} }` defines a method named `throw`. A throw statement may
    // also parenthesise its operand (`throw (err);`), but then the `)` cannot
    // be followed by the `{` that opens a method body.
    if (code[operand] === "(") {
      const afterClose = afterMatchingCloseParen(code, operand);
      const following = afterClose === -1 ? -1 : nextCodeIndex(code, afterClose);
      if (following !== -1 && code[following] === "{") continue;
    }

    return true;
  }
  return false;
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
    // Skipped before braceBody: a property call has no body of its own, so the
    // scan would otherwise run on and borrow an unrelated later block.
    if (isPropertyCall(searchableText, callIndex)) continue;
    const body = braceBody(fileText, callIndex + match[0].length - 1);
    if (!body) continue;
    const bodyCode = codeOnly(body.text);
    if (RECOGNISED_ASSERTION_CALL_RE.test(bodyCode)) continue;
    if (hasThrowStatement(bodyCode)) continue;
    report.push({
      name: testName(fileText, callIndex, body.start),
      start: body.start,
      end: body.end,
    });
  }
  return report;
}
