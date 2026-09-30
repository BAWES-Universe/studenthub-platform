// SHU-71 stage 2: a Claude build reviewed by Codex. The armed activation may
// name the first build's writer lane; every writer journals its pushes where the
// two-fixture progression reader looks; the Claude writer is told it has no shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as activation from "../single-run-activation.mjs";
import * as reconcile from "../reconcile.mjs";
import { coordinatorJournalDirectory } from "../push-broker.mjs";
import { readProgressionPush } from "../two-fixture-progression.mjs";
import { defaultPushReceipt } from "../reconcile-dangling.mjs";
import * as claude from "../adapters/claude-code.mjs";
import { executeSupervisedOrder } from "../supervisor-worker.mjs";
import { ACTIVATION_REVIEWER_LANES, ACTIVATION_WRITER_LANES, LAUNCHABLE_RUNTIMES, WRITER_LANES, adapterForLane, familyForLane, runtimeForLane } from "../launch-vocabulary.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, SHA_REVISED, REVISION } from "./fixture/episode-harness.mjs";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const base = {
  activation_id: "shu71writerlane",
  target_issue_id: "SHU-140",
  authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
  coordinator_revision: REVISION,
  slots: 1,
  expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
};

test("SHU71_WRITER_LANE: the record names a launchable writer and its reviewer, never two lanes of one family", () => {
  assert.equal(activation.validateActivationRecord({ ...base, writer_lane: "claude-builder", reviewer_lane: "codex-verifier" }).ok, true);
  assert.equal(activation.validateActivationRecord({ ...base, writer_lane: "codex-builder", reviewer_lane: "claude-verifier" }).ok, true);
  for (const lane of ["hermes-box", "claude-verifier", "codex-verifier", "worker:claude-builder", "", 7, null]) {
    const verdict = activation.validateActivationRecord({ ...base, writer_lane: lane, reviewer_lane: "codex-verifier" });
    assert.equal(verdict.ok, false, `writer_lane ${JSON.stringify(lane)} must refuse`);
    assert.match(verdict.reason, /writer_lane must be one of codex-builder, claude-builder \(/, "SHU71_WRITER_LAUNCHABLE");
  }
  const alone = activation.validateActivationRecord({ ...base, writer_lane: "claude-builder" });
  assert.equal(alone.ok, false, "SHU71_WRITER_PAIR: a writer lane without its reviewer refuses");
  assert.match(alone.reason, /requires reviewer_lane/);
  for (const [writer, reviewer] of [["claude-builder", "claude-verifier"], ["codex-builder", "codex-verifier"]]) {
    const verdict = activation.validateActivationRecord({ ...base, writer_lane: writer, reviewer_lane: reviewer });
    assert.equal(verdict.ok, false, `${writer} reviewed by ${reviewer} must refuse`);
    assert.match(verdict.reason, /same family/, "SHU71_WRITER_INDEPENDENCE");
  }
  assert.equal(activation.validateActivationRecord({ ...base, writer_lane: "claude-builder", reviewer_lane: "codex-verifier", unrelated_key: 1 }).ok, false, "the key set stays exact");
  // Independence comes from the lane registry, not the lane names.
  for (const writer of ACTIVATION_WRITER_LANES) {
    for (const reviewer of ACTIVATION_REVIEWER_LANES) {
      const ok = activation.validateActivationRecord({ ...base, writer_lane: writer, reviewer_lane: reviewer }).ok;
      assert.equal(ok, familyForLane(writer) !== familyForLane(reviewer) && adapterForLane(writer) !== adapterForLane(reviewer), `${writer}/${reviewer}`);
    }
  }
});

test("SHU71_WRITER_LAUNCHABLE: every writer lane an activation may not name runs on the runtime the supervisor cannot start", async (t) => {
  const excluded = WRITER_LANES.filter((lane) => !ACTIVATION_WRITER_LANES.includes(lane));
  assert.deepEqual(excluded, ["hermes-box"]);
  // Drive the real supervisor with a Hermes order: the adapter receives no spawn
  // and cannot start a worker. When the Hermes runtime is wired this fails, and
  // LAUNCHABLE_RUNTIMES must be revisited with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-hermes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authorizationModule = path.join(dir, "authorize.mjs");
  fs.writeFileSync(authorizationModule, "export const authorizeWorkOrder = () => true;\n");
  const hermes = await import("../adapters/hermes-pool.mjs");
  let launched = null;
  const loadAdapter = async () => ({
    launchBuilder: async (options) => {
      launched = await hermes.launchBuilder({ ...options, io: { ...options.io, poolDir: path.join(dir, "pool") } });
      launched.sawSpawn = Object.hasOwn(options.io, "spawn");
      return launched;
    },
    monitorRun: async () => launched,
  });
  const order = { runtime: "hermes-pool", role: "build", issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    attempt_id: "66666666-6666-4666-8666-666666666666", target_sha: SHA_INPUT, repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", task_context: "ctx" };
  await executeSupervisedOrder({ order, contract: {}, stateDir: path.join(dir, "state"), authorizationModule }, { env: {}, loadAdapter }).catch(() => {});
  assert.equal(launched?.sawSpawn, false, "the supervisor passes the Hermes adapter no spawn");
  assert.equal(launched?.stage, "LAUNCH_UNKNOWN", "so a Hermes build can only hold");
  for (const lane of ACTIVATION_WRITER_LANES) assert.ok(LAUNCHABLE_RUNTIMES.includes(runtimeForLane(lane)));
});

test("SHU71_WRITER_ELIGIBILITY: the activation's writer lane replaces only the card's worker label", () => {
  const issue = (labels = []) => ({ id: "SHU-140", title: "fixture", state: "Todo", priority: "High", labels: ["repo:platform", ...labels], repo: "BAWES-Universe/studenthub-platform", blockers: [] });
  const config = { pilot_repo: "BAWES-Universe/studenthub-platform" };
  const plain = reconcile.computeEligibility({ issues: [issue()], config });
  assert.equal(plain.ready[0].requested_worker, "codex-builder", "the default is unchanged without an activation lane");
  const named = reconcile.computeEligibility({ issues: [issue()], config, writerLanes: new Map([["SHU-140", "claude-builder"]]) });
  assert.equal(named.ready[0].requested_worker, "claude-builder", "SHU71_WRITER_LANE_APPLIED");
  const other = reconcile.computeEligibility({ issues: [{ ...issue(), id: "SHU-141" }], config, writerLanes: new Map([["SHU-140", "claude-builder"]]) });
  assert.equal(other.ready[0].requested_worker, "codex-builder", "another card keeps its own lane");
  // The implementation/verifier conflict rule sees the lane that will really write.
  const r2 = ["type:implementation", "risk:R2", "verifier:claude"];
  assert.equal(reconcile.computeEligibility({ issues: [issue(r2)], config }).ready.length, 1, "a Codex write may be verified by Claude");
  const conflict = reconcile.computeEligibility({ issues: [issue(r2)], config, writerLanes: new Map([["SHU-140", "claude-builder"]]) });
  assert.equal(conflict.ready.length, 0, "SHU71_WRITER_CONFLICT: a Claude write is never verified by Claude");
  assert.match(conflict.excluded[0].reason, /authored by its named verifier/);
});

test("SHU71_PUSH_JOURNAL: every writer journals where the progression reader looks", async (t) => {
  assert.equal(coordinatorJournalDirectory({ CODEX_HOME: "/x/codex", HOME: "/home/u" }), "/x/codex/coordinator-runs");
  assert.equal(coordinatorJournalDirectory({ HOME: "/home/u" }), "/home/u/.codex/coordinator-runs");
  assert.equal(coordinatorJournalDirectory({ SHU_WORKSPACE_STATE_DIR: "/srv/state" }), null, "the workspace state dir is not a journal");
  assert.equal(coordinatorJournalDirectory({ HOME: "relative" }), null, "SHU71_JOURNAL_ABSOLUTE: only an absolute home resolves");
  assert.equal(coordinatorJournalDirectory({ CODEX_HOME: "codex", HOME: "/home/u" }), null);
  assert.throws(() => readProgressionPush({ attempt_id: "55555555-5555-4555-8555-555555555555" }, {}), /unresolvable/,
    "SHU71_PROGRESSION_UNRESOLVED: an unresolvable journal is a refusal, never 'no push'");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-journal-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, SHU_WORKSPACE_STATE_DIR: path.join(home, "workspaces") };
  const ID = "55555555-5555-4555-8555-555555555555";
  let brokerStateDir = null;
  const result = await claude.launchBuilder({
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ID, target_sha: SHA_INPUT,
    repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", role: "build",
    workspace_scope: "scoped", scope_phase: "initial", allowed_paths: ["allowed.txt"], scoped_base_sha: SHA_INPUT,
    oauth_token: "fixture-token", cwd: home, env: { ...env, SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper", SHU_WORKER_UID: String(process.getuid() + 1) },
    readHeadImpl: async () => SHA_INPUT, persistEnvelopeImpl: () => ({ link: "file:///fixture-envelope" }),
    execFileImpl: (bin, args, options, cb) => cb(null, JSON.stringify({ type: "result", session_id: ID, structured_output: { attempt_id: ID, target_sha: SHA_INPUT, result_sha: null, stage: "BUILD_READY", links: ["allowed.txt"] } }), ""),
    io: { pushBrokerImpl: async (input) => { brokerStateDir = input.stateDir; return { ok: true, remote_head: SHA_WRITE }; } },
  });
  assert.equal(result.stage, "COMPLETED", result.reason);
  assert.equal(brokerStateDir, path.join(home, ".codex", "coordinator-runs"), "SHU71_CLAUDE_JOURNAL: the Claude writer journals to the shared push journal");

  // The progression reader finds a journal written there.
  fs.mkdirSync(brokerStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(brokerStateDir, `push-${ID}.json`), JSON.stringify({ attempt_id: ID, result_sha: SHA_WRITE }), { mode: 0o600 });
  assert.deepEqual(readProgressionPush({ attempt_id: ID }, env), { attempt_id: ID, result_sha: SHA_WRITE }, "SHU71_PROGRESSION_READS_JOURNAL");

  // The reconcile-dangling probe reads the same journal: a push there is a push.
  fs.mkdirSync(env.SHU_WORKSPACE_STATE_DIR);
  assert.equal(defaultPushReceipt({ receipt: { attempt_id: ID }, env }).record, path.join(brokerStateDir, `push-${ID}.json`), "SHU71_DANGLING_READS_JOURNAL");
  assert.equal(defaultPushReceipt({ receipt: { attempt_id: ID }, env: { SHU_WORKSPACE_STATE_DIR: env.SHU_WORKSPACE_STATE_DIR } }).readable, false,
    "SHU71_DANGLING_UNRESOLVED: without the journal nothing is readable");
  assert.equal(defaultPushReceipt({ receipt: { attempt_id: ID }, env: { HOME: path.join(home, "absent") } }).readable, false,
    "a journal directory that cannot be listed is not an absent push");

  // A Claude writer whose journal cannot resolve holds before any model time.
  let launched = false;
  const held = await claude.launchBuilder({
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ID, target_sha: SHA_INPUT,
    repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", role: "build",
    workspace_scope: "scoped", scope_phase: "initial", allowed_paths: ["allowed.txt"], scoped_base_sha: SHA_INPUT,
    oauth_token: "fixture-token", cwd: home, env: { SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper", SHU_WORKER_UID: String(process.getuid() + 1) },
    readHeadImpl: async () => SHA_INPUT, execFileImpl: () => { launched = true; },
  });
  assert.equal(held.stage, "HOLD");
  assert.match(held.reason, /push journal/, "SHU71_CLAUDE_JOURNAL_REQUIRED");
  assert.equal(launched, false);
});

test("SHU71_CLAUDE_WRITER_PROMPT: the Claude writer is told it cannot run commands; the reviewer is unchanged", () => {
  const input = { issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: "a", target_sha: SHA_INPUT, task_context: "ctx" };
  for (const role of ["build", "revise"]) {
    const prompt = claude.buildClaudePrompt({ ...input, role });
    assert.match(prompt, /You have no shell here, so you cannot run tests or any other command/);
    assert.match(prompt, /your launch has no network sandbox, so it is given file tools only/, "SHU71_CLAUDE_WRITER_WHY");
    // The writer's own tests are among its authorized paths; the lane's
    // out-of-scope oracle is the reviewer's to judge, never the first writer's.
    assert.doesNotMatch(prompt, /Declared scope/, "SHU71_CLAUDE_WRITER_SCOPE");
  }
  assert.doesNotMatch(claude.buildClaudePrompt({ ...input, role: "review" }), /no shell here/);
});

test("SHU71_REVERSED_EPISODE: Claude builds, Codex reviews, the revision returns to Claude, Codex re-reviews", async () => {
  // A non-legacy writer is always scoped, so the lane carries the committed SHU-140 scope.
  const committed = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).fixture_lane;
  const fixture_lane = { id: "SHU-140", authorization_ref: committed.authorization_ref, initial_build_paths: committed.initial_build_paths,
    revision_paths: committed.revision_paths, seeded_defect_path: committed.seeded_defect_path };
  const h = createEpisodeHarness({ githubToken: "ghtok", writerLane: "claude-builder", reviewerLane: "codex-verifier", configOverrides: { fixture_lane } });
  const tick = h.runTick;
  h.runTick = (options = {}) => tick({ ...options, io: { deriveScopedBaseSha: async () => "d".repeat(40), ...(options.io ?? {}) } });
  try {
    let t = await h.runTick();
    assert.equal(t.code, 0, t.text);
    assert.match(t.text, /activation=ARMED .* writer=claude-builder reviewer=codex-verifier/, "SHU71_PAIR_ECHOED: the run record shows who writes and who verifies");
    assert.equal(h.triggers["claude-code"], 1, "the activation's writer lane launches the build");
    assert.equal(h.triggers["codex-cli"], 0);
    const build = h.latestFor("claude-builder");
    assert.equal(build?.stage, "RUNNING", t.text);
    assert.equal(build.role, "build");
    assert.equal(build.runtime, "claude-code");

    await h.runTick();
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.branchHead.value = SHA_WRITE;
    h.completeRun(build.external_run_id);
    t = await h.runTick();
    assert.equal(h.receiptFor(build.attempt_id).verdict_stage, "BUILD_READY", t.text);

    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — review via codex-verifier/);
    const review = h.latestFor("codex-verifier");
    assert.equal(review?.target_sha, SHA_WRITE, t.text);
    assert.equal(h.triggers["codex-cli"], 1, "Codex reviews the Claude build");

    await h.runTick();
    h.postCallback({ attemptId: review.attempt_id, stage: "BLOCKED", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
    h.completeRun(review.external_run_id);
    await h.runTick();
    assert.equal(h.receiptFor(review.attempt_id).verdict_stage, "BLOCKED");

    // The writer is fixed for the episode: the revision follows the build
    // receipt even if the record stops naming a writer.
    const record = JSON.parse(fs.readFileSync(h.activationPath, "utf8"));
    delete record.writer_lane;
    fs.writeFileSync(h.activationPath, JSON.stringify(record));
    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — revise via claude-builder/, "SHU71_WRITER_FIXED: the revision returns to the Claude writer");
    const revise = h.latestFor("claude-builder");
    assert.equal(revise.role, "revise");

    await h.runTick();
    h.postCallback({ attemptId: revise.attempt_id, stage: "REVISION_READY", targetSha: SHA_WRITE, resultSha: SHA_REVISED });
    h.branchHead.value = SHA_REVISED;
    h.completeRun(revise.external_run_id);
    await h.runTick();

    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — review via codex-verifier/);
    const rereview = h.latestFor("codex-verifier");
    assert.equal(rereview.target_sha, SHA_REVISED);
    await h.runTick();
    h.postCallback({ attemptId: rereview.attempt_id, stage: "PASS", targetSha: SHA_REVISED, resultSha: SHA_REVISED });
    h.completeRun(rereview.external_run_id);
    await h.runTick();

    assert.deepEqual(h.receipts().map((r) => `${r.requested_worker}:${r.stage}/${r.verdict_stage ?? "-"}`), [
      "claude-builder:COMPLETED/BUILD_READY",
      "codex-verifier:HOLD/BLOCKED",
      "claude-builder:COMPLETED/REVISION_READY",
      "codex-verifier:COMPLETED/PASS",
    ]);
    assert.deepEqual(h.triggers, { "codex-cli": 2, "claude-code": 2, "hermes-pool": 0 });
  } finally {
    h.cleanup();
  }
});

test("SHU71_WRITER_LANE_SAME_FAMILY_REFUSED: an activation naming a writer and reviewer of one family launches nothing", async () => {
  const h = createEpisodeHarness({ writerLane: "claude-builder", reviewerLane: "claude-verifier" });
  try {
    const t = await h.runTick();
    assert.equal(t.code, 2, t.text);
    assert.match(t.text, /same family/);
    assert.deepEqual(h.triggers, { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 });
  } finally {
    h.cleanup();
  }
});
