// SHU-254 fixture helper — NON-PRODUCTION path, never merged.
// Reported task: list calls to known async helpers that are not awaited.
const ASYNC_HELPERS = ["fetchJson", "sendMail", "loadConfig"];

// Blanks out comment and string spans line by line so that code sharing a line
// with either is still scanned. Each removed span leaves one space behind, so
// `await /* note */ fetchJson()` stays recognisable as awaited and `fetchJson("x")`
// keeps its call shape. Literal text is dropped rather than copied through, so
// helper-shaped text such as "fetchJson()" inside a literal is never scanned,
// while a literal such as "http://x" is still not read as a comment. Block
// comments and template literals carry across lines; an unterminated ' or " string
// ends with its line, so a stray apostrophe cannot swallow the rest of the file.
// A template's `${ ... }` interpolation is code, so a call made there is scanned.
function stripNonCode(lines) {
  const stripped = [];
  let inBlock = false;
  // Nesting of template literals and their interpolations, innermost last; the
  // base frame is the file's own code. An interpolation frame counts the braces
  // it has opened, so the `}` that closes it returns us to its template.
  const frames = [{ kind: "code" }];
  for (const line of lines) {
    let code = "";
    let i = 0;
    while (i < line.length) {
      const frame = frames[frames.length - 1];
      const ch = line[i];
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) break;
        inBlock = false;
        code += " ";
        i = end + 2;
        continue;
      }
      if (frame.kind === "template") {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "`") {
          frames.pop();
          code += " ";
          i += 1;
          continue;
        }
        if (line.slice(i, i + 2) === "${") {
          frames.push({ kind: "interp", depth: 0 });
          code += " ";
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipString(line, i);
        code += " ";
        continue;
      }
      if (ch === "`") {
        frames.push({ kind: "template" });
        code += " ";
        i += 1;
        continue;
      }
      const pair = line.slice(i, i + 2);
      if (pair === "//") break;
      if (pair === "/*") {
        inBlock = true;
        i += 2;
        continue;
      }
      if (frame.kind === "interp") {
        if (ch === "{") {
          frame.depth += 1;
        } else if (ch === "}") {
          if (frame.depth === 0) {
            frames.pop();
            code += " ";
            i += 1;
            continue;
          }
          frame.depth -= 1;
        }
      }
      code += ch;
      i += 1;
    }
    stripped.push(code);
  }
  return stripped;
}

// Index just past the ' or " literal opening at `start`, or the end of the line
// when that literal is never closed.
function skipString(line, start) {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

export function findUnawaitedCalls(fileText) {
  const lines = stripNonCode(String(fileText).split("\n"));
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const helper of ASYNC_HELPERS) {
      if (new RegExp(`(?<!\\bawait\\s+)\\b${helper}\\s*\\(`).test(line)) {
        findings.push({ line: i + 1, helper });
      }
    }
  }
  return findings;
}
