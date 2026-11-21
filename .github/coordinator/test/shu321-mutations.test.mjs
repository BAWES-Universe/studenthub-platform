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
    name: "M2 drop the contracts edit-in-place check",
    from: 'if (contracts && file.status !== "modified") return',
    to: 'if (false /* SHU321-M2 */) return',
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
    // M16: a stopped queue reviews too; skipping it is now the mutant.
    name: "M6 never review on QUEUE_STOPPED",
    from: '    if (next.skipped === "QUEUE_DONE" || next.skipped === "QUEUE_STOPPED") done = next;',
    to: '    if (next.skipped === "QUEUE_DONE") done = next; // SHU321-M6',
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
    from: "queueConfigReviewLanes(config).includes(record.target_issue_id)",
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
    from: '  if (pausedNow) return { skipped: "PAUSED",',
    to: '  if (false) return { skipped: "PAUSED", // SHU321-M10\n',
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
    name: "M14 let a product path reach .github",
    from: '  if (typeof file !== "string" || file.startsWith(".github/") || file === ".github") return false;',
    to: '  if (typeof file !== "string") return false; // SHU321-M14',
    pattern: "Box review C4:",
  },
  {
    name: "M15 review coordinator code under the product label",
    from: "    if (!change.ok && hasLabel(pull, policy.productLabel)) change = queueConfigChange(files, head, commits, productPath);",
    to: "    if (!change.ok && hasLabel(pull, policy.productLabel)) change = queueConfigChange(files, head, commits, () => true); // SHU321-M15",
    pattern: "Box review C4:",
  },
  {
    name: "M16 let another label stand beside the product label",
    from: "    if (hasLabel(pull, policy.productLabel) && (hasLabel(pull, policy.label) || hasLabel(pull, policy.codeLabel))) continue;",
    to: "    if (false) continue; // SHU321-M16",
    pattern: "Box review C4:",
  },
  {
    name: "M11 drop the Claude-Session trailer check",
    from: "  if (!commits.every((entry) => SESSION_TRAILER_RE.test(",
    to: "  if (false && !commits.every((entry) => SESSION_TRAILER_RE.test( // SHU321-M11\n",
    pattern: "SHU-321 R1:",
  },
  // M18 G2: review slots, oldest head first, verdict-only cap, give-back, ticks.
  {
    name: "M17 review a pull request whose review is still in flight",
    from: "    if (claims.inFlight) continue;",
    to: "    // SHU321-M17",
    pattern: "M18 G2 S1:",
  },
  {
    name: "M18 take a slot whose review is still running",
    from: "  const slots = policy.slotLanes.map((lane, i) => ({ slot: i + 1, lane, busy: busy.has(lane) }));",
    to: "  const slots = policy.slotLanes.map((lane, i) => ({ slot: i + 1, lane, busy: false })); // SHU321-M18",
    pattern: "M18 G2 S1:",
  },
  {
    name: "M19 claim a review outside the selection lock",
    from: "  const release = cardWorkers(config) > 1 ? await takeSelectLock(io, paths, limits) : () => {};",
    to: "  const release = () => {}; // SHU321-M19",
    pattern: "M18 G2 S1:",
  },
  {
    name: "M20 take a slot another worker has armed",
    from: '    if (typeof record?.target_issue_id === "string") busy.add(record.target_issue_id);',
    to: "    // SHU321-M20",
    pattern: "M18 G2 S1:",
  },
  {
    name: "M21 count a review that reached no verdict",
    from: "    if (!claimCounts(claim)) continue;",
    to: "    // SHU321-M21",
    pattern: "M18 G2 S2:",
  },
  {
    name: "M22 count only claims that recorded a verdict",
    from: "const claimCounts = (claim) => claim?.verdict !== REVIEW_NO_VERDICT;",
    to: 'const claimCounts = (claim) => ["PASS", "BLOCKED"].includes(claim?.verdict); // SHU321-M22',
    pattern: "M18 G2 S2:",
  },
  {
    name: "M23 read an unknown ending as no verdict",
    from: '  return "UNKNOWN";\n}',
    to: "  return REVIEW_NO_VERDICT; // SHU321-M23\n}",
    pattern: "M18 G2 S2:",
  },
  {
    name: "M24 keep the claim of a review whose pull request moved",
    from: "    if (movedTo) {",
    to: "    if (false) { // SHU321-M24",
    pattern: "M18 G2 S3:",
  },
  {
    name: "M25 give back a claim whose pull request did not move",
    from: "    return SHA_RE.test(now ?? \"\") && now !== head ? now : null;",
    to: "    return SHA_RE.test(now ?? \"\") ? now : null; // SHU321-M25",
    pattern: "M18 G2 S3:",
  },
  {
    name: "M26 give back the claim of a review with a verdict",
    from: "  if (verdict === REVIEW_NO_VERDICT) {",
    to: "  if (true) { // SHU321-M26",
    pattern: "M18 G2 S3:",
  },
  {
    name: "M27 review the lowest number first, whatever a head's age",
    from: "  waiting.sort((a, b) => (a.since === b.since ? 0 : a.since < b.since ? -1 : 1) || a.pull.number - b.pull.number);",
    to: "  waiting.sort((a, b) => a.pull.number - b.pull.number); // SHU321-M27",
    pattern: "M18 G2: the head that has waited longest",
  },
  {
    name: "M28 tick a review on the card interval",
    from: '      const tickEvery = plan.kind === "review" ?',
    to: '      const tickEvery = false /* SHU321-M28 */ ?',
    pattern: "M18 G2 S5:",
  },
  {
    name: "M29 read Linear or GitHub pull requests while every slot is busy",
    from: "  if (!free) return { busy:",
    to: "  if (false) return { busy: // SHU321-M29\n",
    pattern: "M18 G2 S4:",
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
