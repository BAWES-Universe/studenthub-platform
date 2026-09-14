import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const classNames = ["activation_records", "workspace_authority", "supervisor_secrets", "coordinator_environment",
  "ssh_credentials", "codex_session_sidecars", "claude_session_sidecars", "coordinator_logs", "sibling_attempts"];

const CASES = [
  ...classNames.map((name) => ({
    name: `protected class ${name} omitted`, file: "service/reviewer-isolation.mjs",
    from: `  \"${name}\",`, to: "", pattern: "SHU261 deployed identities",
  })),
  { name: "model launches directly as coordinator", file: "adapters/claude-code.mjs",
    from: "? isolatedReviewerModelCommand({ isolationWrapper: reviewEvidence.isolation_wrapper, cwd, args })",
    to: '? { file: "claude", args }', pattern: "SHU261 model review" },
  { name: "sibling is only read-only", file: "reviewer-sandbox.sh",
    from: 'systemd_args+=("--property=InaccessiblePaths=$sibling")', to: 'systemd_args+=("--property=ReadOnlyPaths=$sibling")', pattern: "SHU261 wrapper contract" },
  { name: "hardlink refusal removed", file: "reviewer-sandbox.sh",
    from: '-type f -links +1 -print -quit)', to: '-type f -links +999 -print -quit)', pattern: "SHU261 wrapper contract" },
  { name: "same-identity serialization removed", file: "reviewer-sandbox.sh",
    from: "if ! /usr/bin/flock -n 9; then", to: "if false; then", pattern: "SHU261 wrapper contract" },
  { name: "process visibility restored", file: "reviewer-sandbox.sh",
    from: '  --property=ProtectProc=invisible \\\n', to: "", pattern: "SHU261 wrapper contract" },
  { name: "direct protected path ignored", file: "review-execution-child.mjs",
    from: "    const denied = protectedFileDenied(probe.path);", to: "    const denied = true;", pattern: "SHU261 active attack" },
  { name: "symlink attack ignored", file: "review-execution-child.mjs",
    from: "    if (probe.symlink_path) symlink &&= protectedFileDenied(probe.symlink_path);", to: "    if (probe.symlink_path) symlink &&= true;", pattern: "SHU261 active attack" },
  { name: "traversal attack ignored", file: "review-execution-child.mjs",
    from: "    if (probe.traversal_path) traversal &&= protectedFileDenied(probe.traversal_path);", to: "    if (probe.traversal_path) traversal &&= true;", pattern: "SHU261 active attack" },
  { name: "descriptor leakage ignored", file: "review-execution-child.mjs",
    from: "export function inheritedDescriptorDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  if (!canary) return true;",
    to: "export function inheritedDescriptorDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  return true;", pattern: "SHU261 active attack" },
  { name: "environment leakage ignored", file: "review-execution-child.mjs",
    from: "  return !canary || !Object.values(env).some((value) => String(value).includes(canary));",
    to: "  return true;", pattern: "SHU261 active attack" },
  { name: "reviewer OAuth copied into inspectable argv", file: "reviewer-sandbox.sh",
    from: 'environment_args=("--setenv=CLAUDE_CODE_OAUTH_TOKEN")',
    to: 'environment_args=("--setenv=CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")', pattern: "SHU261 wrapper contract" },
  { name: "process inspection ignored", file: "review-execution-child.mjs",
    from: "export function processInspectionDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  if (!canary) return true;",
    to: "export function processInspectionDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  return true;", pattern: "SHU261 active attack" },
];

for (const mutation of CASES) test(`SHU-261 mutation: ${mutation.name}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu261-mutation-"));
  try {
    fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
    const target = path.join(root, mutation.file);
    const original = fs.readFileSync(target, "utf8");
    assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
    fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`,
      path.join(root, "test/shu261-reviewer-isolation.test.mjs")], { cwd: root, env: childEnv, encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
    assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
