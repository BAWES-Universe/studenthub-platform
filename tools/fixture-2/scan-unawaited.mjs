// SHU-254 fixture helper — NON-PRODUCTION path, never merged.
// Reported task: list calls to known async helpers that are not awaited.
const ASYNC_HELPERS = ["fetchJson", "sendMail", "loadConfig"];

// Blanks out comment spans line by line so that code sharing a line with a
// comment is still scanned. Each removed span leaves one space behind, keeping
// `await /* note */ fetchJson()` recognisable as awaited. Quoted text is copied
// through verbatim so a literal such as "http://x" is not read as a comment.
// Block comments and template literals carry across lines; an unterminated ' or
// " string ends with its line, so a stray apostrophe cannot swallow the rest of
// the file.
function stripComments(lines) {
  const stripped = [];
  let inBlock = false;
  let quote = null;
  for (const line of lines) {
    let code = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) break;
        inBlock = false;
        code += " ";
        i = end + 2;
        continue;
      }
      if (quote) {
        if (ch === "\\") {
          code += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        code += ch;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        code += ch;
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
      code += ch;
      i += 1;
    }
    stripped.push(code);
    if (quote !== "`") quote = null;
  }
  return stripped;
}

export function findUnawaitedCalls(fileText) {
  const lines = stripComments(String(fileText).split("\n"));
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
