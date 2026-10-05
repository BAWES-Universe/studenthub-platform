import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  {
    name: "M1 admit retired episode terminals",
    from: "    .filter((r) => receiptInEpisodeScope(r, episodeScope))\n    .filter((r) => terminalVerdictCoherent(r, r.verdict_stage));",
    to: "    .filter((r) => terminalVerdictCoherent(r, r.verdict_stage));",
    pattern: "SHU-246 A4 / Run #7",
    assertion: "SHU246_RETIRED_TERMINAL",
  },
  {
    name: "M2 restore issue-wide routing lineage",
    from: "      (r) => r && r.issue_id === issueId && receiptInEpisodeScope(r, episodeScope),",
    to: "      (r) => r && r.issue_id === issueId,",
    pattern: "SHU-246 A1",
    assertion: "SHU246_EPISODE_REVIEW_ROUND",
  },
  {
    name: "M3 select the Run #7 retired scoped writer",
    from: "      (r) => r && r.issue_id === issueId && receiptInEpisodeScope(r, episodeScope),",
    to: "      (r) => r && r.issue_id === issueId,",
    pattern: "SHU-246 A4 / Run #7",
    assertion: "SHU246_CURRENT_SCOPED_WRITER",
  },
  {
    name: "M4 drop main-to-backfill episode scope wiring",
    from: "    bootstrapByIssue: episodeBootstrap,\n    episodeScope,",
    to: "    bootstrapByIssue: episodeBootstrap,",
    pattern: "SHU-246 A5",
    assertion: "SHU246_CURRENT_SCOPED_WRITER",
  },
];

for (const mutation of CASES) {
  test(`SHU-246 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu246-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = path.join(root, "reconcile.mjs");
      const original = fs.readFileSync(target, "utf8");
      assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu246-episode-backfill.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 45_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.ok(output.includes(mutation.assertion), `${mutation.name} must die at ${mutation.assertion}:\n${output}`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
