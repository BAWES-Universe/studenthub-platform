import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  {
    name: "M1 restore HTTP-only callback links",
    from: '    if (url.protocol === "file:" && allowedFileLink(url, link, { cwd, evidence_dir, fsImpl })) continue;',
    to: "    if (false) continue;",
    pattern: "SHU-240 A1",
  },
  {
    name: "M2 accept every local file",
    from: "    return roots.some((root) => inside(root, resolved));",
    to: "    return true;",
    pattern: "SHU-240 A2",
  },
];

for (const mutation of CASES) {
  test(`SHU-240 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu240-mutation-"));
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
        path.join(root, "test", "shu240-evidence-binding.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 45_000 });
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
