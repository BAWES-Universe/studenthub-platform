// SHU-71 stage-4 try 4: the Claude writer found the real defect and prepared
// the change, but every Edit and Write was denied ("don't ask mode"): the
// launch passed --permission-mode dontAsk and no rule allowing any edit, so a
// Claude writer could never leave a change. The writer may now edit exactly
// its authorized paths, and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaudeArgs, launchBuilder, writerEditRules } from "../adapters/claude-code.mjs";

const ID = "77777777-7777-4777-8777-777777777777";
const SHA = "a".repeat(40);
const PATHS = ["tools/fixture/scan-vacuous.mjs", "tools/fixture/test/scan-vacuous.test.mjs"];
const writer = (over = {}) => ({ role: "build", attempt_id: ID, target_sha: SHA, workspace_scope: "scoped", scope_phase: "initial",
  allowed_paths: PATHS, scoped_base_sha: SHA, task_context: "fixture", ...over });

test("SHU71_WRITER_EDIT_RULES: a writer may edit exactly its authorized paths, and the reviewer edits nothing", () => {
  for (const [role, scope_phase] of [["build", "initial"], ["revise", "revision"]]) {
    const args = buildClaudeArgs(writer({ role, scope_phase }));
    const at = args.indexOf("--allowedTools");
    assert.ok(at > 0, `${role}: an edit allow-rule is passed`);
    assert.deepEqual(args.slice(at + 1, at + 3), ["Edit(./tools/fixture/scan-vacuous.mjs)", "Edit(./tools/fixture/test/scan-vacuous.test.mjs)"],
      "one cwd-anchored Edit rule per authorized path");
    assert.deepEqual(args.slice(at + 3, at + 5), ["--permission-mode", "dontAsk"],
      "the variadic rule list ends at a flag, and every other tool call stays denied");
    assert.equal(args.filter((arg) => arg === "--allowedTools").length, 1);
    assert.ok(!args.at(-1).startsWith("Edit("), "the prompt is never swallowed into the rule list");
  }
  const review = buildClaudeArgs({ role: "review", attempt_id: ID, target_sha: SHA, task_context: "fixture" });
  assert.equal(review.includes("--allowedTools"), false, "the reviewer is read-only");
  assert.ok(!review.some((arg) => arg.startsWith("Edit(")));
  assert.deepEqual(writerEditRules({ workspace_scope: "full", allowed_paths: [] }), ["Edit(./**)"],
    "a full-workspace writer edits inside its workspace only");
});

test("SHU71_WRITER_EDIT_RULES_LAUNCHED: the launched writer carries its own path rules, not the whole workspace", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-edit-launch-"));
  try {
    let launchedArgs = null;
    const result = await launchBuilder({
      issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ID, target_sha: SHA,
      repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", role: "build", runtime: "claude-code",
      workspace_scope: "scoped", scope_phase: "initial", allowed_paths: PATHS, scoped_base_sha: SHA,
      oauth_token: "fixture-token", cwd: home,
      env: { HOME: home, SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper", SHU_WORKER_UID: String(process.getuid() + 1) },
      readHeadImpl: async () => SHA, persistEnvelopeImpl: () => ({ link: "file:///fixture-envelope" }),
      execFileImpl: (bin, args, options, cb) => { launchedArgs = args; cb(null, JSON.stringify({ type: "result", session_id: ID,
        structured_output: { attempt_id: ID, target_sha: SHA, result_sha: null, stage: "BUILD_READY", links: [PATHS[0]] } }), ""); },
      io: { pushBrokerImpl: async () => ({ ok: true, remote_head: "b".repeat(40) }) },
    });
    assert.equal(result.stage, "COMPLETED", result.reason);
    const at = launchedArgs.indexOf("--allowedTools");
    assert.deepEqual(launchedArgs.slice(at + 1, at + 4),
      ["Edit(./tools/fixture/scan-vacuous.mjs)", "Edit(./tools/fixture/test/scan-vacuous.test.mjs)", "--permission-mode"]);
    assert.ok(!launchedArgs.includes("Edit(./**)"), "a scoped writer never gets the whole workspace");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("SHU71_WRITER_EDIT_RULES_UNSAFE: a path the CLI would split apart holds before any model time", async () => {
  for (const bad of ["tools/a b.mjs", "tools/a,b.mjs", "tools/a(b).mjs"]) {
    assert.throws(() => writerEditRules({ workspace_scope: "scoped", allowed_paths: [bad] }), /edit permission rules/, bad);
  }
  assert.throws(() => writerEditRules({ workspace_scope: "scoped", allowed_paths: [] }), /edit permission rules/);
  assert.throws(() => writerEditRules({ allowed_paths: PATHS }), /edit permission rules/, "an unstated scope is refused, never widened");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-edit-rules-"));
  try {
    let launched = false;
    const held = await launchBuilder({
      issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ID, target_sha: SHA,
      repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", role: "build", runtime: "claude-code",
      workspace_scope: "scoped", scope_phase: "initial", allowed_paths: ["tools/a b.mjs"], scoped_base_sha: SHA,
      oauth_token: "fixture-token", cwd: home,
      env: { HOME: home, SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper", SHU_WORKER_UID: String(process.getuid() + 1) },
      readHeadImpl: async () => SHA, execFileImpl: () => { launched = true; },
    });
    assert.equal(held.stage, "HOLD");
    assert.match(held.reason, /edit permission rules/);
    assert.equal(launched, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
