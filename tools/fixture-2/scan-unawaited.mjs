// SHU-254 fixture helper — NON-PRODUCTION path, never merged.
// Reported task: list calls to known async helpers that are not awaited.
const ASYNC_HELPERS = ["fetchJson", "sendMail", "loadConfig"];

// Blanks out comments and string/template literals so helper-shaped text that is
// not a call (quoted text, trailing `// sendMail()`) is never reported. Returns
// the code-only text of `line`; `state` carries block comments and unterminated
// template literals across lines. Regex literals are not parsed — a quote inside
// one is read as a string, which is acceptable for this fixture.
function stripNonCode(line, state) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        out += " ";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    const frame = state.stack[state.stack.length - 1];
    if (frame.kind === "string") {
      if (ch === "\\") {
        i += 2;
      } else if (ch === frame.quote) {
        state.stack.pop();
        out += " ";
        i += 1;
      } else if (frame.quote === "`" && ch === "$" && next === "{") {
        // `${...}` holds real code, so go back to scanning it as such.
        state.stack.push({ kind: "code", braceDepth: 0 });
        out += " ";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "/") break; // rest of the line is a comment
    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      out += " ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.stack.push({ kind: "string", quote: ch });
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "{") {
      frame.braceDepth += 1;
    } else if (ch === "}") {
      if (frame.braceDepth === 0 && state.stack.length > 1) {
        state.stack.pop(); // closes the enclosing `${`
        out += " ";
        i += 1;
        continue;
      }
      frame.braceDepth = Math.max(0, frame.braceDepth - 1);
    }
    out += ch;
    i += 1;
  }
  // Only template literals survive a line break; drop a dangling quote so one
  // stray `'` cannot swallow the rest of the file.
  const frame = state.stack[state.stack.length - 1];
  if (frame.kind === "string" && frame.quote !== "`") state.stack.pop();
  return out;
}

export function findUnawaitedCalls(fileText) {
  const lines = String(fileText).split("\n");
  const findings = [];
  const state = { inBlockComment: false, stack: [{ kind: "code", braceDepth: 0 }] };
  for (let i = 0; i < lines.length; i++) {
    const code = stripNonCode(lines[i], state);
    if (/^\s*\*/.test(lines[i])) continue; // doc-comment continuation line
    for (const helper of ASYNC_HELPERS) {
      const call = new RegExp(`\\b${helper}\\s*\\(`, "g");
      let match;
      while ((match = call.exec(code)) !== null) {
        const before = code.slice(0, match.index);
        // Any amount of whitespace, and an optional `(`, may sit after `await`.
        if (/(?:^|[^.\w$])await[\s(]+$/.test(before)) continue;
        findings.push({ line: i + 1, helper });
        break; // at most one finding per helper per line
      }
    }
  }
  return findings;
}
