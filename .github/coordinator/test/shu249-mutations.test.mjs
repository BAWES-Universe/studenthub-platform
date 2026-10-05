import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cases = [
  ["M1 re-key role to lane name", "launch-vocabulary.mjs", 'return { ok: true, role: receipt.role, runtime: receipt.runtime, source: "authority" };', 'return { ok: true, role: definition.role, runtime: receipt.runtime, source: "authority" };', "SHU-249 A1", "SHU-249 A1 trusted revise role must not be re-keyed to the lane default"],
  ["M2 drop role-aware author exclusion", "review-routing.mjs", '(e.role === "build" || e.role === "revise") && typeof e.actor', '(e.requested_worker === "codex-builder") && typeof e.actor', "SHU-249 A3", "SHU-249 A3 role-aware author exclusion must reject Claude self-review"],
  ["M3 restore two-name workspace allowlist", "attempt-workspace.mjs", '!LANE_NAMES.includes(receipt?.requested_worker)', '!["codex-builder", "claude-verifier"].includes(receipt?.requested_worker)', "SHU-249 A4", "SHU-249 A4 every vocabulary lane must obtain its bound workspace: invalid attempt workspace binding"],
  ["M4 drop disagreement HOLD", "launch-vocabulary.mjs", 'if (!definition.roles.includes(receipt.role)) {', 'if (false) {', "SHU-249 A5", "SHU-249 A5 role disagreement must HOLD without silent fallback"],
  ["M5 restore name-keyed scope default", "workspace-scope.mjs", 'if (role === "review") return { workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };', 'if (requestedWorker === "claude-verifier") return { workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };', "SHU-249 A6", "SHU-249 A6 scope defaults must follow the trusted role"],
];

for (const [name, file, from, to, pattern, message] of cases) test(`SHU-249 mutation: ${name}`, (t) => {
  const root = path.resolve(".shu249-tmp"); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "mutation-"));
  try {
    fs.cpSync(new URL("../", import.meta.url), dir, { recursive: true });
    const target = path.join(dir, file), source = fs.readFileSync(target, "utf8");
    // Scope has the same role check in successorWorkspaceScope; mutate only
    // the initialWorkspaceScope occurrence, leaving successor behavior intact.
    const expectedAnchors = (name.startsWith("M5") || name.startsWith("M2")) ? 3 : 2;
    assert.equal(source.split(from).length, expectedAnchors, `${name}: mutation anchor count`);
    fs.writeFileSync(target, source.replace(from, to));
    const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/shu249-role-authority.test.mjs")], { encoding: "utf8", timeout: 30000, env });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, `${name} must fail its named assertion:\n${output}`);
    assert.match(output, /name: 'AssertionError'/);
    assert.ok(output.includes(message), `${name} must produce the requested named AssertionError:\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    t.diagnostic(`${name}: AssertionError: ${message}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
