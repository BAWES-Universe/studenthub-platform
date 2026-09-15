import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  {
    name: "M1 restore URL-only evidence",
    from: "    if (allowedSourceCitation(link, { target_sha, cwd, fsImpl })) continue;",
    to: "    if (false) continue;",
    pattern: "SHU-245 A1",
  },
  {
    name: "M2 accept a foreign attempt",
    from: '  if (callback.attempt_id !== attempt_id) return { valid: false, field: "attempt_id", detail: "does not match the bound attempt" };',
    to: '  if (false) return { valid: false, field: "attempt_id", detail: "does not match the bound attempt" };',
    pattern: "SHU-245 A2",
  },
  {
    name: "M3 accept a foreign callback head",
    from: '  if (callback.target_sha !== target_sha) return { valid: false, field: "target_sha", detail: "does not match the bound head" };',
    to: '  if (false) return { valid: false, field: "target_sha", detail: "does not match the bound head" };',
    pattern: "SHU-245 A2",
  },
  {
    name: "M4 drop mandatory machine evidence",
    from: '  if (!hasFileEvidence) return { valid: false, field: "links", detail: "must include canonical local machine evidence" };',
    to: '  if (false) return { valid: false, field: "links", detail: "must include canonical local machine evidence" };',
    pattern: "SHU-245 A3",
  },
  {
    name: "M5 accept a citation from a foreign head",
    from: "  if (!SHA_RE.test(citedSha) || citedSha !== target_sha) return false;",
    to: "  if (!SHA_RE.test(citedSha)) return false;",
    pattern: "SHU-245 A4",
  },
  {
    name: "M6 admit the git control path",
    from: '  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return false;',
    to: '  if (parts.some((part) => !part || part === "." || part === "..")) return false;',
    pattern: "SHU-245 A4",
  },
];

for (const mutation of CASES) {
  test(`SHU-245 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu245-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = path.join(root, "adapters", "claude-code.mjs");
      const original = fs.readFileSync(target, "utf8");
      assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test", `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu245-reviewer-citations.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 45_000 });
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
