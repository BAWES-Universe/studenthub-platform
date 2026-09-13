import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const cases = [
  ["SHU-244 M25 reader reverts to adapter root", "workspace-result.mjs", 'const baseBundle = baseBundlePath(env, attempt_id, { mustExist: true });', 'const baseBundle = path.join(stateDir, `${attempt_id}.base.bundle`);', "SHU-244 A10"],
  ["SHU-244 M26 broker drops typed bundle refusal", "push-broker.mjs", 'error.workspaceCode === "BASE_BUNDLE_UNAVAILABLE" ? { reason_code: error.workspaceCode } : {}', 'false ? { reason_code: error.workspaceCode } : {}', "SHU-244 A11"],
  ["SHU-244 M27 adapter drops bundle refusal code", "adapters/codex-cli.mjs", 'push.reason_code === "BASE_BUNDLE_UNAVAILABLE" ? push.reason_code : reasonCode', 'reasonCode', "SHU-241 A4"],
  ["M1 trap admitted initially", "config.json", '      "tools/fixture/test/scan-vacuous.test.mjs"\n', '      "tools/fixture/test/scan-vacuous.test.mjs",\n      "tools/fixture-conformance/scan-vacuous.expectations.mjs"\n', "SHU-241 A1"],
  ["M2 literal-path guard removed", "workspace-scope.mjs", '        path.posix.normalize(entry) !== entry || /[*?[\\]{}!]/.test(entry)) {', '        path.posix.normalize(entry) !== entry) {', "SHU-241 A1"],
  ["M3 full tree bundled instead of scoped tree", "attempt-workspace.mjs", 'git(["read-tree", "--empty"]);', 'git(["read-tree", target_sha]);', "SHU-241 A2:"],
  ["M4 scoped base given the full target as parent", "attempt-workspace.mjs", 'const scopedBase = git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", scopedCommitMessage(target_sha, scope.paths)]);\n    if (git(["rev-list", "--parents", "-n", "1", scopedBase]) !== scopedBase) throw new Error("scoped base must be parentless");', 'const scopedBase = git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", target_sha, "-m", scopedCommitMessage(target_sha, scope.paths)]);', "SHU-241 A2:"],
  ["M5 private base import removed", "workspace-result.mjs", '  if (workspace_scope === "scoped") {\n    const baseBundle', '  if (false) {\n    const baseBundle', "SHU-241 A3"],
  ["M6 scoped snapshot starts empty", "workspace-result.mjs", 'await git("read-tree", workspace_scope === "scoped" ? target_sha : "--empty");', 'await git("read-tree", "--empty");', "SHU-241 A3"],
  ["M7 outside diff ignored", "workspace-result.mjs", '    if (outside.length) {', '    if (false) {', "SHU-241 A4"],
  ["M8 revision reuses initial scope", "workspace-scope.mjs", 'allowed_paths: policy.revision_paths', 'allowed_paths: policy.initial_build_paths', "SHU-241 A5"],
  ["M9 FAILED unlocks revision", "review-routing.mjs", '  if (scopedContractReceipt && verdict.role === "review" && evidenceStage !== "BLOCKED" && evidenceStage !== "PASS") {', '  if (false && scopedContractReceipt) {', "SHU-241 A5"],
  ["M10 wrong writer accepted", "review-routing.mjs", 'writer.requested_worker !== "codex-builder"', 'writer.requested_worker !== "hermes-box"', "SHU-241 A5"],
  ["M11 branch binding removed", "review-routing.mjs", 'writer.branch !== terminal.branch', 'false', "SHU-241 A5"],
  ["M12 exact reviewed head removed", "review-routing.mjs", 'terminal.target_sha !== writer.result_sha', 'false', "SHU-241 A5"],
  ["M13 receipt drops allowed paths", "reconcile.mjs", '    allowed_paths: [...allowed_paths],', '    allowed_paths: [],', "SHU-241 A6"],
  ["M14 reviewer scope refusal removed", "adapters/claude-code.mjs", '  if (workspace_scope !== "full" || scope_phase !== "review" || !Array.isArray(allowed_paths) || allowed_paths.length !== 0 || scoped_base_sha !== null) {', '  if (false) {', "SHU-241 A6"],
  ["M15 scoped-base attempt binding removed", "attempt-workspace.mjs", ', "scoped_base_sha"];', '];', "SHU-241 A6"],
  ["M16 directive drops scope", "review-routing.mjs", '        allowed_paths: order.allowed_paths,', '        allowed_paths: [],', "SHU-241 A6"],
  ["M17 worker bundle remote retained", "attempt-workspace.mjs", '["config", "--remove-section", "remote.origin"]', '["remote"]', "SHU-241 A2:"],
  ["M18 reviewer missing-object check removed", "attempt-workspace.mjs", 'git(["fsck", "--full", "--no-dangling"]);', 'git(["rev-parse", "HEAD"]);', "SHU-241 A7"],
  ["M19 stable scope refusal code removed", "adapters/codex-cli.mjs", 'const reasonCode = /\\bRESULT_SCOPE_REFUSED\\b/.test(String(push.reason ?? "")) ? "RESULT_SCOPE_REFUSED" : undefined;', 'const reasonCode = undefined;', "SHU-241 A4"],
  ["M20 full target omitted from scoped derivation", "attempt-workspace.mjs", 'target_sha ${target_sha}', 'target_sha fixed', "SHU-241 A2:"],
  ["M21 exact path order omitted from scoped derivation", "attempt-workspace.mjs", 'allowed_paths ${JSON.stringify(allowed_paths)}', 'allowed_paths ${JSON.stringify([...allowed_paths].sort())}', "SHU-241 A2:"],
  ["M22 full-tree path membership disabled", "workspace-result.mjs", 'const outside = paths.find((name) => !allowed.has(name));', 'const outside = undefined;', "SHU-241 A4"],
  ["M23 recovery launch drops retained scope", "reconcile.mjs", 'const options = { ...adapterLaunchOptions(adapter, env, { resume }), ...normalized.scope };', 'const options = adapterLaunchOptions(adapter, env, { resume });', "SHU-241 A8"],
  ["M24 partial scope metadata receives legacy fallback", "workspace-scope.mjs", '  if (present.length === 0) {', '  if (present.length < WORKSPACE_SCOPE_FIELDS.length) {', "SHU-241 A9"],
];

for (const [name, file, from, to, pattern] of cases) test(`SHU-241 mutation: ${name}`, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "shu241-mutation-"));
  try {
    fs.cpSync(new URL("../", import.meta.url), dir, { recursive: true });
    const target = path.join(dir, file), source = fs.readFileSync(target, "utf8");
    assert.equal(source.split(from).length, 2, `${name}: mutation anchor must occur exactly once`);
    fs.writeFileSync(target, source.replace(from, to));
    const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/shu241-scoped-build.test.mjs")],
      { encoding: "utf8", timeout: 30_000, env });
    assert.equal(run.status, 1, `${name} survived or the named test did not execute:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /AssertionError/, `${name} must die at a named assertion`);
    assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name} must not be killed by syntax/load failure`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
