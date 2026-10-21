// Self-repair B1 — every landing-repair guard is pinned: removing it makes its
// named "Self-repair B1:" test fail by assertion, in the file that owns it.
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
    name: "M1 accept part of the repair group",
    file: "single-run-activation.mjs",
    from: "    if (repairKeys.length !== REPAIR_ACTIVATION_KEYS.length) {",
    to: "    if (false) { // B1-M1",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: R1",
  },
  {
    name: "M2 let a repair carry the review-only keys",
    file: "single-run-activation.mjs",
    from: "    if (REVIEW_ONLY_ACTIVATION_KEYS.some((key) => key in record)) {",
    to: "    if (false) { // B1-M2",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: R1",
  },
  {
    name: "M3 allow more than one round",
    file: "single-run-activation.mjs",
    from: "    if (record.max_rounds !== REPAIR_MAX_ROUNDS) return",
    to: "    if (false) return",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: R1",
  },
  {
    name: "M4 let a repair name its own episode as the passed one",
    file: "single-run-activation.mjs",
    from: "    if (record.repair_of === record.activation_id) return",
    to: "    if (false) return",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: R2",
  },
  {
    name: "M5 accept findings taken at another head",
    file: "single-run-activation.mjs",
    from: "    if (record.repair_findings.target_sha !== record.initial_target_sha) {",
    to: "    if (false) { // B1-M5",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: R3",
  },
  {
    name: "M6 accept a digest that is not the findings'",
    file: "single-run-activation.mjs",
    from: "    if (typeof record.repair_evidence_digest !== \"string\" || record.repair_evidence_digest !== digest) {",
    to: "    if (false) { // B1-M6",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: R3",
  },
  {
    name: "M7 arm a repair on a lane that is not a card",
    file: "single-run-activation.mjs",
    from: "  if (landingRepair && !cardContract(scopeIssue)) return",
    to: "  if (false) return",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: S1",
  },
  {
    name: "M8 bootstrap from another episode's PASS",
    file: "single-run-activation.mjs",
    from: "    .filter((r) => r.episode_id === repair.repair_of && r.stage",
    to: "    .filter((r) => r.stage",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: E2",
  },
  {
    name: "M9 bootstrap from a PASS without trusted provenance",
    file: "single-run-activation.mjs",
    from: "      && reviewVerdictProvenanceValid(r, issueReceipts).ok)",
    to: "      )",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: E2",
  },
  {
    name: "M10 bootstrap from a PASS on another branch",
    file: "single-run-activation.mjs",
    from: "      && r.branch === branch\n",
    to: "\n",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: E2",
  },
  {
    name: "M11 repair a branch that moved",
    file: "single-run-activation.mjs",
    from: "  if (authoritativeHead !== null && authoritativeHead !== head) {",
    to: "  if (false) { // B1-M11",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: E3",
  },
  {
    name: "M12 give a repair the configured revision rounds",
    file: "single-run-activation.mjs",
    from: "      max_revise: repair ? 0 : Number.isInteger",
    to: "      max_revise: Number.isInteger",
    tests: "single-run-activation.test.mjs",
    pattern: "Self-repair B1: E4",
  },
  {
    name: "M13 accept findings of any source",
    file: "review-findings.mjs",
    from: "    && (!Object.hasOwn(findings, \"source\") || REVIEW_FINDINGS_SOURCES.includes(findings.source))\n",
    to: "\n",
    tests: "shu247-callback-notes.test.mjs",
    pattern: "Self-repair B1: F1",
  },
  {
    name: "M14 render CI output as a reviewer's report",
    file: "review-findings.mjs",
    from: "  if (receipt.review_findings.source === \"ci\") {",
    to: "  if (false) { // B1-M14",
    tests: "shu247-callback-notes.test.mjs",
    pattern: "Self-repair B1: F2",
  },
  {
    name: "M15 admit an assignee who is not an owner",
    file: "repair-eligibility.mjs",
    from: " || !Array.isArray(owners) || !owners.includes(id)) {",
    to: ") { // B1-M15",
    tests: "eligibility.test.mjs",
    pattern: "Self-repair B1: P1",
  },
  {
    name: "M16 trust an incomplete PR read",
    file: "repair-eligibility.mjs",
    from: "  if (!pulls || pulls.complete !== true || !Array.isArray(pulls.items)) {",
    to: "  if (!pulls || !Array.isArray(pulls.items)) { // B1-M16",
    tests: "eligibility.test.mjs",
    pattern: "Self-repair B1: P2",
  },
  {
    name: "M17 repair a PR whose head moved",
    file: "repair-eligibility.mjs",
    from: "  if (pr.head?.sha !== head) return",
    to: "  if (false) return",
    tests: "eligibility.test.mjs",
    pattern: "Self-repair B1: P3",
  },
  {
    name: "M18 call a capped PR read complete",
    file: "repair-eligibility.mjs",
    from: "  return incomplete(`more than ${maxPages * REPAIR_PULL_PAGE} open pull requests; the read stops at its page cap`);",
    to: "  return { complete: true, items: [...byNumber.values()], reason: null }; // B1-M18",
    tests: "eligibility.test.mjs",
    pattern: "Self-repair B1: P5",
  },
  {
    name: "M19 judge every card by the repair predicate",
    file: "reconcile.mjs",
    from: "    if (repairCard && repairCard.issueId === id) {",
    to: "    if (repairCard) { // B1-M19",
    tests: "eligibility.test.mjs",
    pattern: "Self-repair B1: P4",
  },
  {
    name: "M20 drop the repair from the live-head episode decision",
    file: "reconcile.mjs",
    from: "        authoritativeHead: live.head,\n        repair: repairFromActivation(singleRunActivation, config),\n",
    to: "        authoritativeHead: live.head,\n",
    tests: "episode-successor-dispatch.test.mjs",
    pattern: "Self-repair B1: D2",
  },
  {
    name: "M21 let card-prepare judge a repair by today's rule",
    file: "service/card-prepare.mjs",
    from: "export function cardAction(issue, repair = null) {\n  if (repair) {",
    to: "export function cardAction(issue, repair = null) {\n  if (false) { // B1-M21",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B1: C1",
  },
  {
    name: "M22 publish a second revise directive for a repair",
    file: "reconcile.mjs",
    from: "      max_revise: landingRepair ? 0 : Number.isInteger(config.max_revise)",
    to: "      max_revise: Number.isInteger(config.max_revise)",
    tests: "shu246-episode-backfill.test.mjs",
    pattern: "Self-repair B1: K1",
  },
];

for (const mutation of CASES) {
  test(`Self-repair B1: mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-repair-b1-mutation-"));
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
        path.join(root, "test", mutation.tests),
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
