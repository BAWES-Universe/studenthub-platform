// SHU-254 fixture helper — NON-PRODUCTION path, never merged.
// Reported task: list calls to known async helpers that are not awaited.
const ASYNC_HELPERS = ["fetchJson", "sendMail", "loadConfig"];

export function findUnawaitedCalls(fileText) {
  const lines = String(fileText).split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    for (const helper of ASYNC_HELPERS) {
      if (new RegExp(`(?<!\\bawait\\s+)\\b${helper}\\s*\\(`).test(line)) {
        findings.push({ line: i + 1, helper });
      }
    }
  }
  return findings;
}
