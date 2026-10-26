// SHU-321 — every guard of the queue config review is pinned: removing it
// makes its named test in card-run.test.mjs fail by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");
const FILE = "service/card-run.mjs";

const CASES = [
  {
    name: "M1 drop the path allowlist",
    from: "    if (!names.every(allowed)) return",
    to: "    if (false) /* SHU321-M1 */ return",
    pattern: "SHU-321 R2:",
  },
  {
    name: "M2 drop the contracts deletions check",
    from: '(file.status !== "modified" || file.deletions !== 0)',
    to: '(file.status !== "modified") /* SHU321-M2 */',
    pattern: "SHU-321 R2:",
  },
  {
    name: "M3 claim a head without the exclusive flag",
    from: '{ mode: 0o600, flag: "wx" }',
    to: '{ mode: 0o600, flag: "w" } /* SHU321-M3 */',
    pattern: "SHU-321 R4:",
  },
  {
    name: "M4 allow claude-verifier to review a Claude change",
    from: "plan.record?.reviewer_lane !== QUEUE_CONFIG_REVIEWER",
    to: '![QUEUE_CONFIG_REVIEWER, "claude-verifier"].includes(plan.record?.reviewer_lane) /* SHU321-M4 */',
    pattern: "SHU-321 R3:",
  },
  {
    name: "M5 drop the fork and draft checks",
    from: "pull.draft === false && pull.head?.repo?.full_name === repo && ",
    to: "/* SHU321-M5 */ ",
    pattern: "SHU-321 R2:",
  },
  {
    name: "M6 review on QUEUE_STOPPED",
    from: '    if (next.skipped === "QUEUE_DONE") done = next;',
    to: '    if (next.skipped === "QUEUE_DONE" || next.skipped === "QUEUE_STOPPED") done = next; // SHU321-M6',
    pattern: "SHU-321 R5:",
  },
  {
    name: "M7 drop the label check",
    from: "pull.labels.some((entry) => entry?.name === label)",
    to: "true /* SHU321-M7 */",
    pattern: "SHU-321 R1:",
  },
  {
    name: "M8 let narrowQueueScope accept any review lane",
    file: "single-run-activation.mjs",
    from: "record.target_issue_id === queueConfigReviewLane(config)",
    to: "resolveReviewOnlyLane(config, record.target_issue_id) /* SHU321-M8 */",
    pattern: "SHU-321 R6:",
  },
  {
    name: "M9 drop the per-pull-request cap",
    from: "    if (claims.atRevision >= policy.maxHeadsPerPr) {",
    to: "    if (false) { // SHU321-M9",
    pattern: "SHU-321 R4:",
  },
  {
    name: "M10 drop the pause recheck before arming",
    from: "  if (pausedNow) return skip(",
    to: "  if (false) return skip( // SHU321-M10\n",
    pattern: "SHU-321 R5:",
  },
  {
    name: "M12 review coordinator code under the queue label",
    from: "    let change = hasLabel(pull, policy.label) ? queueConfigChange(files, head, commits) : { ok: false };",
    to: "    let change = hasLabel(pull, policy.label) ? queueConfigChange(files, head, commits, coordinatorCodePath) : { ok: false }; // SHU321-M12",
    pattern: "Box review C1:",
  },
  {
    name: "M13 let a coordinator code path climb out",
    from: '  return !file.split("/").some((part) => !part || part === "." || part === "..");',
    to: "  return true; // SHU321-M13",
    pattern: "Box review C1:",
  },
  {
    name: "M11 drop the Claude-Session trailer check",
    from: "  if (!commits.every((entry) => SESSION_TRAILER_RE.test(",
    to: "  if (false && !commits.every((entry) => SESSION_TRAILER_RE.test( // SHU321-M11\n",
    pattern: "SHU-321 R1:",
  },
];

for (const mutation of CASES) {
  test(`SHU-321 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu321-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, mutation.file ?? FILE);
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "card-run.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 60_000 });
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

test("SHU-321 mutation the unmutated suite passes", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-name-pattern=SHU-321 R", path.join(HERE, "card-run.test.mjs")],
    { cwd: COORDINATOR, env: childEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 8$/m);
});
