// CI before review — every guard is pinned: removing it makes its named
// "CI before review:" test in ci-before-review.test.mjs fail by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");

const CASES = [
  {
    name: "C1 turn the gate on without enabled: true",
    file: "review-routing.mjs",
    from: '  if (!gate || typeof gate !== "object" || gate.enabled !== true) return null;',
    to: '  if (!gate || typeof gate !== "object") return null; // CI-M1',
    pattern: "CI before review: the gate is off unless enabled",
  },
  {
    name: "C2 gate every armed review whatever the committed flag says",
    file: "reconcile.mjs",
    from: "        const ciSettings = ciBeforeReviewSettings(config);",
    to: "        const ciSettings = { wait_minutes: 45, max_ci_revise: 2 }; // CI-M2",
    pattern: "CI before review: with the flag off",
  },
  {
    name: "C3 gate a review-only run or a landing repair",
    file: "review-routing.mjs",
    from: "    && activation?.review_only !== true && activation?.landing_repair !== true;",
    to: "    ; // CI-M3",
    pattern: "CI before review: only a review of a build or revise head is gated",
  },
  {
    name: "C4 review a red head instead of revising it",
    file: "review-routing.mjs",
    from: '    return { action: "revise", reason:',
    to: '    return { action: "review", reason:',
    pattern: "CI before review: red",
  },
  {
    name: "C5 dispatch the review although a CI revise was minted",
    file: "reconcile.mjs",
    from: "  return minted.order;",
    to: "  return successor; // CI-M5",
    pattern: "CI before review: red checks dispatch a CI revise",
  },
  {
    name: "C6 review a head whose CI is still running",
    file: "review-routing.mjs",
    from: '  return { action: "hold", reason:',
    to: '  return { action: "review", reason:',
    pattern: "CI before review: pending",
  },
  {
    name: "C7 let the tick dispatch the review while CI holds it",
    file: "reconcile.mjs",
    from: '    return null;\n  }\n  if (decision.action === "review") {',
    to: '    return successor; // CI-M7\n  }\n  if (decision.action === "review") {',
    pattern: "CI before review: pending checks hold the review",
  },
  {
    name: "C8 hold a head forever when CI never settles",
    file: "review-routing.mjs",
    from: "  if (!(waitedMs < waitMs)) {",
    to: "  if (false) { // CI-M8",
    pattern: "CI before review: checks still pending past wait_minutes",
  },
  {
    name: "C9 mint CI revises past max_ci_revise",
    file: "review-routing.mjs",
    from: "    if (ciRevises >= settings.max_ci_revise) {",
    to: "    if (false) { // CI-M9",
    pattern: "CI before review: (red mints a revise until|after max_ci_revise)",
  },
  {
    name: "C10 count CI revises against max_revise",
    file: "review-routing.mjs",
    from: '  const review_round = entries.filter((e) => e.role === "review").length;',
    to: '  const review_round = entries.filter((e) => e.role === "review" || e.role === "revise").length; // CI-M10',
    pattern: "CI before review: CI revises are counted on their own",
  },
  {
    name: "C11 bind CI findings of another head to the revise",
    file: "review-routing.mjs",
    from: ' || findings.source !== "ci" || findings.target_sha !== review.target_sha) {',
    to: ' || findings.source !== "ci") { // CI-M11',
    pattern: "CI before review: a CI revise is shaped like a routed revise",
  },
];

for (const mutation of CASES) {
  test(`CI before review: mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-before-review-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, mutation.file);
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "ci-before-review.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 120_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.signal, null, `${mutation.name}: a timeout or crash is not a mutation kill`);
      assert.equal(run.status, 1, `${mutation.name}: mutation survived\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(output, new RegExp(`not ok \\d+ - ${mutation.pattern}`), `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name}: infrastructure crashes do not count`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
