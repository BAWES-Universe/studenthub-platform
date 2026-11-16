import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { candidates, evidence, preflight, runFile } from "./run.mjs";

async function temp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "changed-test-preflight-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const headScript = 'import test from "node:test";\n';
const real = headScript + 'test("actual", () => {});\n';
const fixtures = [
  ["structured success", real, ["actual"], "PASS", null],
  ["assertion failure", headScript + 'test("actual", () => {throw Error("fail")});\n', [], "FAIL", "test_runner_failure"],
  ["printed PASS", 'console.log("PASS");\n', [], "NO_RUN", "no_completed_tests"],
  ["printed result object", 'console.log(JSON.stringify({outcome:"PASS"}));\n', [], "NO_RUN", "no_completed_tests"],
  ["all skipped", headScript + 'test.skip("actual", () => {});\n', [], "NO_RUN", "no_completed_tests"],
  ["empty suite", 'import {describe} from "node:test"; describe("suite",()=>{});\n', [], "NO_RUN", "no_completed_tests"],
  ["early process exit", 'process.exit(0);\n', [], "NO_RUN", "no_completed_tests"],
  ["named test absent", real, ["missing"], "NO_RUN", "changed_named_test_missing"],
  ["named test skipped", real + 'test.skip("skip", () => {});\n', ["skip"], "NO_RUN", "changed_named_test_missing"],
  ["invalid module", 'import "does-not-exist-for-preflight";\n', [], "FAIL", "test_runner_failure"],
  ["bounded output", real + 'console.log("a".repeat(70000));\n', [], "UNAVAILABLE", "output_limit"],
  ["silent hung child", 'setInterval(() => {}, 10);\n', [], "TIMEOUT", "file_timeout", 500],
  ["runner env minimized", headScript + 'test("env",()=>{if(process.env.PREFLIGHT_CANARY) throw Error("leaked")});\n', [], "PASS", null],
];
for (const [label, src, names, expected, reason, budget = 3000] of fixtures) {
  test(label, async (t) => {
    const dir = await temp(t);
    const file = path.join(dir, "fixture.test.mjs");
    await writeFile(file, src);
    process.env.PREFLIGHT_CANARY = "synthetic";
    try {
      const result = await runFile(dir, file, names, budget);
      assert.equal(result.outcome, expected);
      assert.equal(result.reason, reason);
      if (expected === "PASS") assert.equal(result.exitCode, 0);
    } finally {
      delete process.env.PREFLIGHT_CANARY;
    }
  });
}

test("NUL-delimited selection refuses ambiguous, traversal and non-test paths", () => {
  assert.deepEqual(candidates(["a.test.ts", "a.test.ts", "two spaces.test.mjs", "a.ts", "../a.test.ts", "a\nb.test.ts", "/a.test.ts"].join("\0")), ["a.test.ts", "two spaces.test.mjs"]);
});

test("exact head, changed-only execution, compiled TS mapping, unsupported and missing setup", async (t) => {
  const cwd = await temp(t);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "preflight@example.invalid");
  git("config", "user.name", "Preflight Fixture");
  await writeFile(path.join(cwd, "unchanged.test.mjs"), 'throw Error("must not run")');
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await mkdir(path.join(cwd, "dist"));
  await mkdir(path.join(cwd, "packages/db/test"), { recursive: true });
  await writeFile(path.join(cwd, "probe.test.ts"), real);
  await writeFile(path.join(cwd, "package.json"), '{"type":"module"}');
  await writeFile(path.join(cwd, "packages/db/test/postgres-fixture.test.ts"), "throw Error('not a live DB')");
  await symlink("unchanged.test.mjs", path.join(cwd, "symlink.test.mjs"));
  git("add", ".");
  git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  await writeFile(path.join(cwd, "dist/probe.test.js"), real);
  const report = await preflight({ cwd, base, head });
  assert.equal(report.head, head);
  assert.equal(report.mergeBase, base);
  assert.deepEqual(report.results.map(({ file, outcome, reason }) => [file, outcome, reason]), [
    ["packages/db/test/postgres-fixture.test.ts", "UNAVAILABLE", "requires_postgres"],
    ["probe.test.ts", "PASS", null],
    ["symlink.test.mjs", "UNAVAILABLE", "missing_or_unsafe_file"],
  ]);
  const failedSetup = await preflight({ cwd, base, head, setup: "failure" });
  assert.equal(failedSetup.results.length, 3);
  assert.ok(failedSetup.results.every(({ reason }) => reason === "dependency_or_build_setup"));
  const wrong = await preflight({ cwd, base, head: base });
  assert.equal(wrong.reason, "head_not_verified");
  const expired = await preflight({ cwd, base, head, totalMs: 0 });
  assert.ok(expired.results.every(({ outcome, reason }) => outcome === "TIMEOUT" && reason === "total_budget_exhausted"));
  const { sha256 } = evidence(report);
  assert.equal(sha256, createHash("sha256").update(JSON.stringify(report)).digest("hex"));
});

test("empty diff has no verdict and executes no tests", async (t) => {
  const cwd = await temp(t);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.email=p@example.invalid", "-c", "user.name=Fixture", "commit", "--allow-empty", "-qm", "base");
  const head = git("rev-parse", "HEAD");
  const report = await preflight({ cwd, base: head, head });
  assert.equal(report.state, "NO_CHANGED_TESTS");
  assert.deepEqual(report.results, []);
});
