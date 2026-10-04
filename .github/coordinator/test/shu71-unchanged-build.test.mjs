// SHU-71 stage-4 try 3: the Claude writer ran, found nothing it thought needed
// changing and returned BUILD_READY with an empty workspace. The broker refused
// the empty result, the adapter held, and the HOLD ended the episode before any
// reviewer saw the head. An unchanged initial build is the writer's claim that
// the bound head already meets the card; the reviewer is the one who judges it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "../adapters/claude-code.mjs";
import * as codex from "../adapters/codex-cli.mjs";
import { UNCHANGED_BUILD_NOTE, unchangedInitialBuild } from "../push-broker.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_REVISED } from "./fixture/episode-harness.mjs";

const ID = "66666666-6666-4666-8666-666666666666";
const EMPTY = Object.freeze({ ok: false, stage: "HOLD", pause_adapter: true, reason_code: "RESULT_EMPTY",
  reason: "workspace result refused: workspace result contains no changes" });
const SCOPE_REFUSED = Object.freeze({ ok: false, stage: "HOLD", pause_adapter: true, reason_code: "RESULT_SCOPE_REFUSED",
  reason: "workspace result refused: RESULT_SCOPE_REFUSED: path outside immutable allowance (x)" });

test("SHU71_UNCHANGED_BUILD_RULE: only an initial build's named empty result is reviewable", () => {
  assert.equal(unchangedInitialBuild(EMPTY, { role: "build", scope_phase: "initial" }), true);
  assert.equal(unchangedInitialBuild(EMPTY, { role: "revise", scope_phase: "revision" }), false, "a revision must answer its findings");
  assert.equal(unchangedInitialBuild(EMPTY, { role: "build", scope_phase: "revision" }), false);
  assert.equal(unchangedInitialBuild(EMPTY, { role: null, scope_phase: "initial" }), false, "an unresolved role keeps the refusal");
  assert.equal(unchangedInitialBuild(SCOPE_REFUSED, { role: "build", scope_phase: "initial" }), false, "every other refusal still holds");
  assert.equal(unchangedInitialBuild({ ...EMPTY, ok: true }, { role: "build", scope_phase: "initial" }), false);
});

function claudeWriter({ role, scope_phase, stage, broker }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-unchanged-"));
  return claude.launchBuilder({
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ID, target_sha: SHA_INPUT,
    repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", role,
    workspace_scope: "scoped", scope_phase, allowed_paths: ["allowed.txt"], scoped_base_sha: SHA_INPUT,
    oauth_token: "fixture-token", cwd: home,
    env: { HOME: home, SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper", SHU_WORKER_UID: String(process.getuid() + 1) },
    readHeadImpl: async () => SHA_INPUT, persistEnvelopeImpl: () => ({ link: "file:///fixture-envelope" }),
    execFileImpl: (bin, args, options, cb) => cb(null, JSON.stringify({ type: "result", session_id: ID,
      structured_output: { attempt_id: ID, target_sha: SHA_INPUT, result_sha: null, stage, links: ["allowed.txt"] } }), ""),
    io: { pushBrokerImpl: async () => broker },
  }).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

test("SHU71_UNCHANGED_BUILD_CLAUDE: the Claude writer hands an unchanged build to review at the bound head", async () => {
  const build = await claudeWriter({ role: "build", scope_phase: "initial", stage: "BUILD_READY", broker: EMPTY });
  assert.equal(build.stage, "COMPLETED", build.reason);
  assert.equal(build.callback.result_sha, SHA_INPUT, "the result is the bound head itself");
  assert.equal(build.pause_adapter, undefined);
  assert.ok(build.audit_notes.includes(UNCHANGED_BUILD_NOTE), "the receipt says nothing was published");

  const revise = await claudeWriter({ role: "revise", scope_phase: "revision", stage: "REVISION_READY", broker: EMPTY });
  assert.equal(revise.stage, "HOLD", "an unchanged revision is still refused");
  assert.equal(revise.reason_code, "RESULT_EMPTY");

  const scoped = await claudeWriter({ role: "build", scope_phase: "initial", stage: "BUILD_READY", broker: SCOPE_REFUSED });
  assert.equal(scoped.stage, "HOLD", "any other broker refusal still holds");
  assert.equal(scoped.reason_code, "RESULT_SCOPE_REFUSED");
});

function codexWriter({ role, scope_phase, stage, broker }) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-unchanged-codex-"));
  const final = JSON.stringify({ attempt_id: ID, target_sha: SHA_INPUT, result_sha: null, stage, links: ["allowed.txt"] });
  const stdout = [{ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }, { type: "turn.started" },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: final } }, { type: "turn.completed" }]
    .map((line) => JSON.stringify(line)).join("\n");
  return codex.launchBuilder({
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ID, target_sha: SHA_INPUT,
    role, runtime: "codex-cli", workspace_scope: "full", scope_phase, allowed_paths: [], scoped_base_sha: null,
    task_context: "fixture", cwd: "/repo",
    env: { PATH: "/usr/bin", HOME: "/root", CODEX_HOME: "/root/.codex", SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper" },
    readHeadImpl: async () => SHA_INPUT,
    execFileImpl: (_file, _args, _opts, cb) => queueMicrotask(() => cb(null, stdout, "")),
    io: { codexStateDir: state, pushBrokerEnabled: true, worktreeRoot: "/repo", pushRemoteUrl: "https://example.invalid/r.git",
      pushBrokerImpl: async () => broker },
  }).finally(() => fs.rmSync(state, { recursive: true, force: true }));
}

test("SHU71_UNCHANGED_BUILD_CODEX: the Codex writer follows the same rule", async () => {
  const build = await codexWriter({ role: "build", scope_phase: "initial", stage: "BUILD_READY", broker: EMPTY });
  assert.equal(build.stage, "COMPLETED", build.reason);
  assert.equal(build.callback.result_sha, SHA_INPUT);
  assert.ok(!build.callback.links.some((link) => link.startsWith("pushed:")), "nothing is claimed as pushed");

  const revise = await codexWriter({ role: "revise", scope_phase: "revision", stage: "REVISION_READY", broker: EMPTY });
  assert.equal(revise.stage, "HOLD");
  assert.equal(revise.pause_adapter, true);

  const scoped = await codexWriter({ role: "build", scope_phase: "initial", stage: "BUILD_READY", broker: SCOPE_REFUSED });
  assert.equal(scoped.stage, "HOLD");
  assert.equal(scoped.reason_code, "RESULT_SCOPE_REFUSED");
});

test("SHU71_UNCHANGED_BUILD_REVIEWED: the episode reviews the unchanged head, and the BLOCK returns to the writer", async () => {
  const committed = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).fixture_lane;
  const fixture_lane = { id: "SHU-140", authorization_ref: committed.authorization_ref, initial_build_paths: committed.initial_build_paths,
    revision_paths: committed.revision_paths, seeded_defect_path: committed.seeded_defect_path };
  const h = createEpisodeHarness({ githubToken: "ghtok", writerLane: "claude-builder", reviewerLane: "codex-verifier", configOverrides: { fixture_lane } });
  const tick = h.runTick;
  h.runTick = (options = {}) => tick({ ...options, io: { deriveScopedBaseSha: async () => "d".repeat(40), ...(options.io ?? {}) } });
  try {
    await h.runTick();
    const build = h.latestFor("claude-builder");
    await h.runTick();
    // The branch never moves: nothing was published.
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_INPUT });
    h.completeRun(build.external_run_id);
    let t = await h.runTick();
    assert.equal(h.receiptFor(build.attempt_id).verdict_stage, "BUILD_READY", t.text);

    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — review via codex-verifier/, t.text);
    const review = h.latestFor("codex-verifier");
    assert.equal(review.target_sha, SHA_INPUT, "the reviewer judges the unchanged head");

    await h.runTick();
    h.postCallback({ attemptId: review.attempt_id, stage: "BLOCKED", targetSha: SHA_INPUT, resultSha: SHA_INPUT });
    h.completeRun(review.external_run_id);
    await h.runTick();
    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — revise via claude-builder/, t.text);
    const revise = h.latestFor("claude-builder");
    assert.equal(revise.role, "revise");
    assert.equal(revise.target_sha, SHA_INPUT);

    await h.runTick();
    h.postCallback({ attemptId: revise.attempt_id, stage: "REVISION_READY", targetSha: SHA_INPUT, resultSha: SHA_REVISED });
    h.branchHead.value = SHA_REVISED;
    h.completeRun(revise.external_run_id);
    await h.runTick();
    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — review via codex-verifier/);
    assert.equal(h.latestFor("codex-verifier").target_sha, SHA_REVISED);
  } finally {
    h.cleanup();
  }
});
