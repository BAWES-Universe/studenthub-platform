import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  { name: "M1 restore subscription-breaking bare mode", file: "adapters/claude-code.mjs",
    from: '    "--restricted",', to: '    "--bare",', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A1/A2" },
  { name: "M2 remove restricted mode", file: "adapters/claude-code.mjs",
    from: '    "--restricted",', to: '    "--disable-slash-commands",', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A1/A2" },
  { name: "M3 admit API-key fallback", file: "adapters/claude-code.mjs",
    from: "    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {", to: "    if (false) {", testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A1/A2" },
  { name: "M4 expose command and write tools", file: "adapters/claude-code.mjs",
    from: '    "--tools", "Read,Glob,Grep",', to: '    "--tools", "Read,Glob,Grep,Bash,Edit,Write",', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A3/A4" },
  { name: "M5 expose web tools", file: "adapters/claude-code.mjs",
    from: '    "--tools", "Read,Glob,Grep",', to: '    "--tools", "Read,Glob,Grep,WebFetch,WebSearch",', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A3/A4" },
  { name: "M6 stop denying MCP tools", file: "adapters/claude-code.mjs",
    from: '    "--disallowedTools", "mcp__*",', to: '    "--disallowedTools", "",', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A3/A4" },
  { name: "M7 load ambient MCP config", file: "adapters/claude-code.mjs",
    from: '    "--strict-mcp-config",', to: '    "--mcp-config", ".mcp.json",', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A3/A4" },
  { name: "M8 inherit hostile Claude configuration", file: "adapters/claude-code.mjs",
    from: '"SHELL", "CI"]', to: '"SHELL", "CI", "CLAUDE_CONFIG_DIR"]', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A5" },
  { name: "M9 trust readable siblings", file: "review-execution.mjs",
    from: '      && report?.sibling_workspace_probe === "DENIED"', to: "      && true", testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A6/A7/A8" },
  { name: "M10 trust writable workspaces", file: "review-execution.mjs",
    from: '      && report?.workspace_write_probe === "DENIED"', to: "      && true", testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A6/A7/A8" },
  { name: "M11 weaken exact-attempt binding", file: "review-execution.mjs",
    from: "    if (path.basename(resolvedCwd) !== attempt_id) {", to: "    if (false) {", testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A6/A7: attempt" },
  { name: "M12 weaken exact-head binding", file: "adapters/claude-code.mjs",
    from: "  if (checkoutHead !== target_sha) {", to: "  if (false) {", testFile: "claude-contract.test.mjs", pattern: "checkout must resolve" },
  { name: "M13 restore world-readable attempt directories", file: "attempt-workspace.mjs",
    from: "      else fs.chmodSync(cwd, 0o750);", to: "      else fs.chmodSync(cwd, 0o755);",
    alsoFrom: '  if ((stat.mode & 0o777) !== 0o750) throw new Error("attempt workspace must remain mode 0750");',
    alsoTo: '  if (false) throw new Error("attempt workspace must remain mode 0750");',
    testFile: "attempt-workspace.test.mjs", pattern: "empty root provisions" },
  { name: "M14 stop masking sibling workspaces", file: "reviewer-sandbox.sh",
    from: '  systemd_args+=("--property=InaccessiblePaths=$sibling")', to: '  systemd_args+=("--property=ReadOnlyPaths=$sibling")', testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A7: shipped" },
  { name: "M15 retain reviewer ACL after execution", file: "reviewer-sandbox.sh",
    from: 'cleanup() { /usr/bin/setfacl -x "u:${reviewer_uid}" -- "$canonical_workspace" || true; }', to: "cleanup() { true; }", testFile: "shu239-reviewer-launch.test.mjs", pattern: "SHU-239 A7: shipped" },
];

for (const mutation of CASES) {
  test(`SHU-239 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu239-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = path.join(root, mutation.file);
      const original = fs.readFileSync(target, "utf8");
      assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      let mutated = original.replace(mutation.from, mutation.to);
      if (mutation.alsoFrom) {
        assert.equal(mutated.split(mutation.alsoFrom).length, 2, `${mutation.name}: secondary mutation anchor must be unique`);
        mutated = mutated.replace(mutation.alsoFrom, mutation.alsoTo);
      }
      fs.writeFileSync(target, mutated);
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", mutation.testFile)], { cwd: root, env: childEnv, encoding: "utf8", timeout: 45_000 });
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
