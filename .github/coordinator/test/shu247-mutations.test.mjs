import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  {
    name: "M1 restore the false rejection note",
    from: "            ? `run completed WITH validated callback (attempt + target_sha match); ${heldVerdictStage} verdict recorded — HOLD`",
    to: '            ? "run completed but callback REJECTED (attempt/target_sha mismatch or stale head) — HOLD"',
    pattern: "SHU-247 A1",
  },
  {
    name: "M2 classify a terminal verdict by callback presence instead of binding",
    from: "        const heldVerdictStage = callbackBindingValid(receipt, callback, ctx)",
    to: "        const heldVerdictStage = callback",
    pattern: "SHU-247 A3",
  },
  {
    name: "M3 drop truthful FAILED verdict handling",
    from: "          && (callback.stage === \"BLOCKED\" || callback.stage === \"FAILED\")",
    to: "          && callback.stage === \"BLOCKED\"",
    pattern: "SHU-247 A2",
  },
  {
    name: "M4 use success-only evidence validation for held verdicts",
    from: "        const heldVerdictStage = callbackBindingValid(receipt, callback, ctx)",
    to: "        const heldVerdictStage = callbackEvidenceValid(receipt, callback, ctx)",
    pattern: "SHU-247 A2",
  },
];

for (const mutation of CASES) {
  test(`SHU-247 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu247-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = path.join(root, "reconcile.mjs");
      const original = fs.readFileSync(target, "utf8");
      assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test", `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu247-callback-notes.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 45_000 });
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
