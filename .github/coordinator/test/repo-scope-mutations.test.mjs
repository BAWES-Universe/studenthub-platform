import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Mutate independent copies of the current source; each probe must die at a
// named assertion of repo-scope.test.mjs, never at syntax or module loading.
const cases = [
  ["M1 repo-mode path refusal removed", "workspace-scope.mjs", '  if (refused !== undefined) return { ok: false, reason: `repo-mode ${name} may not include ${refused}` };', "", "SHU-296 R2"],
  ["M2 receipt-level repo path refusal skipped", "workspace-scope.mjs", 'return paths.ok && workspace_scope === "repo" ? validateRepoModePaths(paths.paths) : paths;', "return paths;", "SHU-296 R2"],
  ["M3 contract-level repo path refusal skipped", "workspace-scope.mjs", "    const owned = validateRepoModePaths(paths.paths, { name: key });\n    if (!owned.ok) return owned;\n", "", "SHU-296 R3"],
  ["M4 repo outside-path diff skipped", "workspace-result.mjs", "  if (boundBase) {\n    const fullDiff", '  if (workspace_scope === "scoped") {\n    const fullDiff', "SHU-296 R6"],
  ["M5 repo snapshot starts empty", "workspace-result.mjs", 'const boundBase = workspace_scope === "scoped" || workspace_scope === "repo";', 'const boundBase = workspace_scope === "scoped";', "SHU-296 R6"],
  ["M6 repo scope carries a scoped base", "workspace-scope.mjs", '  if (workspace_scope === "repo" && scoped_base_sha !== null) return { ok: false, reason: "repo workspace must not carry a scoped_base_sha" };\n', "", "SHU-296 R1"],
  ["M7 receipt mode not bound to the contract", "workspace-scope.mjs", "  if (!mode.ok || mode.workspace_scope !== receipt.workspace_scope) {", "  if (!mode.ok) {", "SHU-296 R4"],
  ["M8 every writer installs", "attempt-workspace.mjs", "if (repoScope && git([", "if (git([", "SHU-296 R9"],
  ["M9 install keeps the default timeout", "attempt-workspace.mjs", "{ runEnv, timeout: DEPENDENCY_INSTALL_TIMEOUT_MS }", "{ runEnv }", "SHU-296 R7"],
  ["M10 install failure loses its fixed code", "attempt-workspace.mjs", '{ workspaceCode: "DEPENDENCY_INSTALL_FAILED" });', "{});", "SHU-296 R8"],
  ["M11 npm inherits the coordinator environment", "attempt-workspace.mjs", "const runEnv = { ...workerEnv, npm_config_cache", "const runEnv = { ...process.env, ...workerEnv, npm_config_cache", "SHU-296 R7"],
];

for (const [name, file, from, to, pattern] of cases) test(`SHU-296 mutation: ${name}`, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "shu296-mutation-"));
  try {
    fs.cpSync(new URL("../", import.meta.url), dir, { recursive: true });
    const target = path.join(dir, file), source = fs.readFileSync(target, "utf8");
    assert.equal(source.split(from).length, 2, `${name}: mutation anchor must occur exactly once`);
    fs.writeFileSync(target, source.replace(from, to));
    const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/repo-scope.test.mjs")],
      { encoding: "utf8", timeout: 60_000, env });
    assert.equal(run.status, 1, `${name} survived or the named test did not execute:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /AssertionError/, `${name} must die at a named assertion`);
    assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name} must not be killed by syntax/load failure`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
