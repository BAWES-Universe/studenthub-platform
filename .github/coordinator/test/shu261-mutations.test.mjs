import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const classNames = ["activation_records", "workspace_authority", "supervisor_secrets", "coordinator_environment",
  "ssh_credentials", "codex_session_sidecars", "service_home_claude_sidecars", "claude_session_sidecars", "coordinator_logs", "sibling_attempts"];

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
    from: "    symlink &&= protectedFileDenied(probe.symlink_path);", to: "    symlink &&= true;", pattern: "SHU261 active attack" },
  { name: "traversal attack ignored", file: "review-execution-child.mjs",
    from: "    traversal &&= protectedFileDenied(probe.traversal_path);", to: "    traversal &&= true;", pattern: "SHU261 active attack" },
  { name: "descriptor leakage ignored", file: "review-execution-child.mjs",
    from: "export function inheritedDescriptorDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  if (!CANARY.fd.test(canary ?? \"\")) return false;",
    to: "export function inheritedDescriptorDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  return true;", pattern: "SHU261 active attack" },
  { name: "environment leakage ignored", file: "review-execution-child.mjs",
    from: "  return CANARY.environment.test(canary ?? \"\")\n    && !Object.values(env).some((value) => String(value).includes(canary));",
    to: "  return true;", pattern: "SHU261 active attack" },
  { name: "reviewer OAuth copied into inspectable argv", file: "reviewer-sandbox.sh",
    from: 'environment_args=("--setenv=CLAUDE_CODE_OAUTH_TOKEN")',
    to: 'environment_args=("--setenv=CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")', pattern: "SHU261 wrapper contract" },
  { name: "process inspection ignored", file: "review-execution-child.mjs",
    from: "export function processInspectionDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  if (!CANARY.process.test(canary ?? \"\")) return false;",
    to: "export function processInspectionDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {\n  return true;", pattern: "SHU261 active attack" },
  { name: "missing protected-path canary accepted", file: "review-execution-child.mjs",
    from: "  if (!raw) return { ok: false, classes: {}, symlink: \"INVALID\", traversal: \"INVALID\" };",
    to: "  if (!raw) return { ok: true, classes: {}, symlink: \"DENIED\", traversal: \"DENIED\" };", pattern: "SHU261 canaries" },
  { name: "unknown protected class accepted", file: "review-execution-child.mjs",
    from: "!KNOWN_PROTECTED_CLASSES.has(probe.class)",
    to: "!/^[a-z][a-z0-9_]+$/.test(probe.class ?? \"\")", pattern: "SHU261 canaries" },
  { name: "missing descriptor canary accepted", file: "review-execution-child.mjs",
    from: "  if (!CANARY.fd.test(canary ?? \"\")) return false;",
    to: "  if (!canary) return true;", pattern: "SHU261 canaries" },
  { name: "missing environment canary accepted", file: "review-execution-child.mjs",
    from: "  return CANARY.environment.test(canary ?? \"\")",
    to: "  return !canary || CANARY.environment.test(canary ?? \"\")", pattern: "SHU261 canaries" },
  { name: "missing process canary accepted", file: "review-execution-child.mjs",
    from: "  if (!CANARY.process.test(canary ?? \"\")) return false;",
    to: "  if (!canary) return true;", pattern: "SHU261 canaries" },
  ...["protected-paths-json", "fd-canary", "env-canary", "process-canary"].map((option) => ({
    name: `${option} propagation removed`, file: "review-execution.mjs",
    from: `      "--${option}", ${option === "protected-paths-json" ? "JSON.stringify(protectedPaths)" : option === "fd-canary" ? "fdCanary" : option === "env-canary" ? "environmentCanary" : "processCanary"},\n`,
    to: "", pattern: "SHU261 canaries",
  })),
  { name: "cleanup stops at first callback failure", file: "service/reviewer-host-validation.mjs",
    from: "    try { await callback(); }\n    catch (error) { cleanupErrors.push(error); }",
    to: "    await callback();", pattern: "SHU261 cleanup" },
  { name: "sudo SETENV restored", file: "service/shu-reviewer.sudoers",
    from: "NOPASSWD:NOSETENV:", to: "NOPASSWD:SETENV:", pattern: "SHU261 wrapper contract" },
  { name: "root interpreter uses caller PATH", file: "reviewer-sandbox.sh",
    from: "#!/bin/bash -p", to: "#!/usr/bin/env bash", pattern: "SHU261 wrapper contract" },
  { name: "root ambient environment clearing removed", file: "reviewer-sandbox.sh",
    from: "done < <(compgen -e)", to: "done < <(printf '')", pattern: "SHU261 wrapper contract" },
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
