// SHU-86 — every card-run guard is pinned: removing it makes its named test in
// card-run.test.mjs fail by assertion.
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
    name: "M1 arm a busy host",
    from: '    if (busy.length) refuse("CARD_RUN_HOST_BUSY", busy.join("; "));',
    to: "    // SHU86-M1",
    pattern: "SHU-86 C6:",
  },
  {
    name: "M2 arm without a verified receipt at HEAD",
    from: '  if (receipt?.state !== "VERIFIED" || receipt?.revision !== head) {',
    to: "  if (false) { // SHU86-M2",
    pattern: "SHU-86 C7:",
  },
  {
    name: "M3 arm a dirty checkout or one off main",
    from: "  if (!SHA_RE.test(head) || head !== main || dirty) refuse(",
    to: "  if (!SHA_RE.test(head)) refuse( // SHU86-M3\n",
    pattern: "SHU-86 C7:",
  },
  {
    name: "M4 arm a card whose branch moved off the revision",
    from: "      if (head !== revision) refuse(",
    to: "      if (false) refuse( // SHU86-M4\n",
    pattern: "SHU-86 C8:",
  },
  {
    name: "M5 arm a unit with no resident drop-in",
    from: "    if (!io.fs.existsSync(path.join(dir, RESIDENT_DROP_IN))) refuse(",
    to: "    if (false) refuse( // SHU86-M5\n",
    pattern: "SHU-86 C16:",
  },
  {
    name: "M6 tick without reading back the supervisor's environment",
    from: '  if (!environ.includes("ENABLE_DISPATCH=true") || !environ.includes(`DISPATCH_TARGET_SHA=${target}`)) {',
    to: "  if (false) { // SHU86-M6",
    pattern: "SHU-86 C10:",
  },
  {
    name: "M7 keep ticking a card that is not eligible",
    from: "        if (ticks.length === 1 && outcome.eligible === 0) {",
    to: "        if (false) { // SHU86-M7",
    pattern: "SHU-86 C11:",
  },
  {
    name: "M8 tick past the run window",
    from: "      const deadline = Date.parse(plan.record.expires_at);",
    to: "      const deadline = Date.parse(plan.record.expires_at) + 24 * 60 * 60 * 1000; // SHU86-M8",
    pattern: "SHU-86 C12:",
  },
  {
    name: "M9 revert under a running worker",
    from: "  while (workerCount(io) !== 0) {",
    to: "  while (false) { // SHU86-M9",
    pattern: "SHU-86 C13:",
  },
  {
    name: "M10 accept another run's armed activation",
    from: "  if (activationId && armedId !== activationId) {",
    to: "  if (false) { // SHU86-M10",
    pattern: "SHU-86 C4:",
  },
  {
    name: "M11 pick a reviewer from the author's family",
    from: ".find((lane) => familyForLane(lane) !== review.authorFamily);",
    to: ".find(() => true); // SHU86-M11",
    pattern: "SHU-86 C3:",
  },
  {
    name: "M12 run a fixture lane as a card",
    from: "    if (!(config.card_lanes ?? []).some((lane) => lane?.id === id) || !cardLane) {",
    to: "    if (!cardLane) { // SHU86-M12",
    pattern: "SHU-86 C2:",
  },
  {
    name: "M13 leave a failed arm unreverted",
    from: '      result = { ok: false, outcome: "ERROR", reason: error.message, code: error.code ?? "CARD_RUN_ERROR" };',
    to: "      throw error; // SHU86-M13",
    pattern: "SHU-86 C10:",
  },
  {
    name: "M14 take another run's lock",
    from: '{ flag: "wx", mode: 0o600 }',
    to: "{ mode: 0o600 } /* SHU86-M14 */",
    pattern: "SHU-86 C14:",
  },
  {
    name: "M15 leave the activation record armed after revert",
    from: "    io.fs.renameSync(paths.activation, retired);",
    to: "    // SHU86-M15",
    pattern: "SHU-86 C9:",
  },
  {
    name: "M16 leave the dispatch drop-ins after revert",
    from: "      if (io.fs.existsSync(file)) io.fs.unlinkSync(file);",
    to: "      // SHU86-M16",
    pattern: "SHU-86 C9:",
  },
  {
    name: "M17 read a review PASS as a stop",
    from: '/^review PASS\\b/.test(reason) ? "PASS"',
    to: 'false /* SHU86-M17 */ ? "PASS"',
    pattern: "SHU-86 C4:",
  },
  {
    name: "M18 keep ticking when the tick does not report this run armed",
    from: "  if (!armedId) return {",
    to: "  if (false) return { // SHU86-M18\n",
    pattern: "SHU-86 C4:",
  },
  {
    name: "M19 ignore a leftover build or review worktree",
    from: "if (/^(build-|review-pr)/.test(name))",
    to: "if (false) // SHU86-M19\n",
    pattern: "SHU-86 C5:",
  },
  {
    name: "M20 take a pull request on a card run",
    from: '    if (review) refuse("CARD_RUN_REVIEW_INPUT",',
    to: '    if (false) refuse("CARD_RUN_REVIEW_INPUT", // SHU86-M20\n',
    pattern: "SHU-86 C2:",
  },
];

for (const mutation of CASES) {
  test(`SHU-86 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu86-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, FILE);
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
