// SHU-303 — every review-only guard is pinned: removing it makes its named test
// in review-only.test.mjs fail by assertion.
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
    name: "M1 let a reviewer judge its own family's pull request",
    file: "single-run-activation.mjs",
    from: "    if (familyForLane(record.reviewer_lane) === record.pr_author_family) {",
    to: "    if (false) { // SHU303-M1",
    pattern: "SHU-303 R1:",
  },
  {
    name: "M2 let a review-only record name a writer",
    file: "single-run-activation.mjs",
    from: '    if ("writer_lane" in record) return { ok: false, reason: "a review-only activation has no writer_lane" };',
    to: "    // SHU303-M2",
    pattern: "SHU-303 R1:",
  },
  {
    name: "M3 accept part of the review-only group",
    file: "single-run-activation.mjs",
    from: "    if (reviewKeys.length !== REVIEW_ONLY_ACTIVATION_KEYS.length) {",
    to: "    if (false) { // SHU303-M3",
    pattern: "SHU-303 R1:",
  },
  {
    name: "M4 let the record pick a reviewer its lane does not list",
    file: "single-run-activation.mjs",
    from: "    if (!reviewLane.reviewer_lanes.includes(record.reviewer_lane)) {",
    to: "    if (false) { // SHU303-M4",
    pattern: "SHU-303 R2:",
  },
  {
    name: "M5 let a review-only record arm a lane that is not a review lane",
    file: "single-run-activation.mjs",
    from: '  } else if ("review_pr" in record) {',
    to: "  } else if (false) { // SHU303-M5",
    pattern: "SHU-303 R2:",
  },
  {
    name: "M6 route a review-only BLOCK to a revision",
    file: "single-run-activation.mjs",
    from: "  if (reviewOnly) {\n    const at = terminal.target_sha",
    to: "  if (false) { // SHU303-M6\n    const at = terminal.target_sha",
    pattern: "SHU-303 E1:",
  },
  {
    name: "M7 file an incident card for a review-only BLOCK",
    file: "incident-reporting.mjs",
    from: "  if (/^review-only verdict (?:PASS|BLOCKED) at /.test(reason ?? \"\")) return null;",
    to: "  // SHU303-M7",
    pattern: "SHU-303 E2:",
  },
  {
    name: "M8 review without a GitHub token",
    file: "reconcile.mjs",
    from: '  if (!githubToken) return { ok: false, code: "UNREADABLE_HEAD", reason: "a review-only run needs the GitHub token to read its pull request" };',
    to: "  // SHU303-M8",
    pattern: "SHU-303 P1:",
  },
  {
    name: "M9 review a fork",
    file: "reconcile.mjs",
    from: "  if (pull.head?.repo?.full_name !== repo || pull.base?.repo?.full_name !== repo) {",
    to: "  if (false) { // SHU303-M9",
    pattern: "SHU-303 P1:",
  },
  {
    name: "M10 review a head that moved",
    file: "reconcile.mjs",
    from: "  if (pull.head?.sha !== head_sha) {",
    to: "  if (false) { // SHU303-M10",
    pattern: "SHU-303 P1:",
  },
  {
    name: "M11 review from a base that is not the PR's fork point",
    file: "reconcile.mjs",
    from: "  if (compare?.merge_base_commit?.sha !== base_sha) {",
    to: "  if (false) { // SHU303-M11",
    pattern: "SHU-303 P1:",
  },
  {
    name: "M12 reserve a review the pull request check refused",
    file: "reconcile.mjs",
    from: "    if (!pull.ok) {\n      if (io.stdout) io.stdout(`dispatch: ABORTED before reservation — review-only HOLD=",
    to: "    pull.branch ??= \"feature/reviewed\"; if (false) { // SHU303-M12\n      if (io.stdout) io.stdout(`dispatch: ABORTED before reservation — review-only HOLD=",
    pattern: "SHU-303 P3:",
  },
  {
    name: "M13 review on the dispatch branch instead of the PR's own",
    file: "reconcile.mjs",
    from: "    branch = pull.branch;",
    to: "    // SHU303-M13",
    pattern: "SHU-303 P2:",
  },
  {
    name: "M14 drop the base from the reservation",
    file: "reconcile.mjs",
    from: "    ...(reviewOnly ? { review_base_sha: singleRunActivation.review_base_sha } : {}),",
    to: "    // SHU303-M14",
    pattern: "SHU-303 P2:",
  },
  {
    name: "M15 let review_base_sha ride on a writer receipt",
    file: "reconcile.mjs",
    from: '    if (!authority.ok || authority.role !== "review") errors.push("review_base_sha belongs only on a review receipt");',
    to: "    // SHU303-M15",
    pattern: "SHU-303 H2:",
  },
  {
    name: "M16 let a stored base change",
    file: "reconcile.mjs",
    from: '  "review_base_sha",\n]);',
    to: "]); // SHU303-M16",
    pattern: "SHU-303 H2:",
  },
  {
    name: "M17 let the host launch another base",
    file: "supervisor-authorization.mjs",
    from: "          || order.review_base_sha !== activation.review_base_sha) return denied(\"REVIEW_BINDING\");",
    to: "          ) return denied(\"REVIEW_BINDING\"); // SHU303-M17",
    pattern: "SHU-303 H1:",
  },
  {
    name: "M18 drop the base from the signed order",
    file: "supervisor-dispatch.mjs",
    from: '"scoped_base_sha", "review_base_sha"].filter(',
    to: '"scoped_base_sha"].filter( // SHU303-M18\n      ',
    pattern: "SHU-303 H1:",
  },
  {
    name: "M19 diff only part of the change",
    file: "review-change.mjs",
    from: '    let diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", base_sha, target_sha, "--"]);',
    to: '    let diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", base_sha, target_sha, "--", "src"]); // SHU303-M19',
    pattern: "SHU-303 V1:",
  },
  {
    name: "M20 accept a base that is not an ancestor",
    file: "review-change.mjs",
    from: '    await git(["merge-base", "--is-ancestor", base_sha, target_sha]);',
    to: "    // SHU303-M20",
    pattern: "SHU-303 V1:",
  },
  {
    name: "M21 run the host's fixture tests for a review-only run",
    file: "workspace-scope.mjs",
    from: "  if (reviewOnlyCard(issueId)) return [];",
    to: "  // SHU303-M21",
    pattern: "SHU-303 V2:",
  },
];

for (const mutation of CASES) {
  test(`SHU-303 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu303-mutation-"));
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
        path.join(root, "test", "review-only.test.mjs"),
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
