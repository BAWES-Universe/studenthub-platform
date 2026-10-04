// card-lanes.test.mjs
//
// After SHU-71's fixtures, the loop runs real StudentHub cards. A card lane is a
// fixture lane without a seeded defect: exact writer paths, a reviewer that sees
// the whole declared scope and runs its tests, and a brief and acceptance check
// pinned in reviewed code (card-contracts.mjs). These tests pin that a card lane
// can be named by config but never widened by it, that the writer and the
// reviewer both get the card's brief, and that an activation cannot choose who
// builds or judges a card.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_CONTRACTS, SHU197_PATHS, cardBrief, cardContract } from "../card-contracts.mjs";
import {
  fixtureAcceptance,
  fixtureReviewScope,
  fixtureReviewTests,
  initialWorkspaceScope,
  resolveFixtureLane,
  successorWorkspaceScope,
  validateAllowedPaths,
  validateFixtureAttemptScope,
  validateFixtureScopePolicy,
} from "../workspace-scope.mjs";
import { resolveAuthorizationRef } from "../reconcile.mjs";
import { singleRunActivationStatus } from "../single-run-activation.mjs";
import { buildCodexPrompt, buildCodexReviewPrompt } from "../adapters/codex-cli.mjs";
import { buildClaudePrompt } from "../adapters/claude-code.mjs";

const CONFIG = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../config.json", import.meta.url)), "utf8"));
const LANE = CONFIG.card_lanes.find((lane) => lane.id === "SHU-197");
const SHA = "a".repeat(40);

test("CARD_LANE_CONFIG: the committed SHU-197 lane is exactly its reviewed contract", () => {
  assert.ok(LANE, "config.json names the SHU-197 card lane");
  assert.equal(LANE.authorization_ref, "SHU-197");
  assert.equal(LANE.writer_lane, "codex-builder");
  assert.equal(LANE.reviewer_lane, "claude-verifier");
  assert.equal(Object.hasOwn(LANE, "seeded_defect_path"), false);
  assert.deepEqual(resolveFixtureLane(CONFIG, "SHU-197"), LANE);
  const policy = validateFixtureScopePolicy(LANE);
  assert.equal(policy.ok, true, policy.reason);
  assert.deepEqual(policy.initial_build_paths, [...SHU197_PATHS]);
  assert.equal(policy.seeded_defect_path, null);
  for (const contract of Object.values(CARD_CONTRACTS)) {
    assert.equal(validateAllowedPaths(contract.initial_build_paths).ok, true);
    assert.equal(validateAllowedPaths(contract.revision_paths).ok, true);
  }
});

test("CARD_LANE_NOT_WIDENED: config cannot widen, trap or invent a card lane", () => {
  const widened = { ...LANE, initial_build_paths: [...LANE.initial_build_paths, "deploy/coolify/compose.yaml"] };
  assert.match(validateFixtureScopePolicy(widened).reason, /differ from the reviewed exact SHU-197 contract/);
  const revised = { ...LANE, revision_paths: [...LANE.revision_paths, "Dockerfile"] };
  assert.match(validateFixtureScopePolicy(revised).reason, /differ from the reviewed exact SHU-197 contract/);
  const trapped = { ...LANE, seeded_defect_path: "deploy/coolify/preflight.mjs" };
  assert.match(validateFixtureScopePolicy(trapped).reason, /has no seeded defect/);
  assert.throws(() => resolveFixtureLane({ card_lanes: [{ ...LANE, id: "SHU-998" }] }, "SHU-998"), /reviewed card contract/);
  assert.throws(() => resolveFixtureLane({ card_lanes: {} }, "SHU-197"), /card_lanes must be an array/);
  assert.throws(() => resolveFixtureLane({ ...CONFIG, card_lanes: [LANE, LANE] }, "SHU-197"), /unique issue ids/);
  assert.throws(() => initialWorkspaceScope({ issueId: "SHU-197", requestedWorker: "codex-builder", fixtureLane: widened }), /differ/);
});

test("CARD_LANE_SCOPE: writer, reviser and reviewer scopes follow the card contract", () => {
  const initial = initialWorkspaceScope({ issueId: "SHU-197", requestedWorker: "codex-builder", fixtureLane: LANE });
  assert.deepEqual(initial, { workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU197_PATHS], scoped_base_sha: null });
  assert.deepEqual(successorWorkspaceScope("revise", LANE).allowed_paths, [...SHU197_PATHS]);
  assert.equal(successorWorkspaceScope("review", LANE).workspace_scope, "full");
  assert.equal(validateFixtureAttemptScope({ issue_id: "SHU-197", ...initial }).ok, true);
  const outside = { issue_id: "SHU-197", ...initial, allowed_paths: [...SHU197_PATHS, "Dockerfile"] };
  assert.match(validateFixtureAttemptScope(outside).reason, /LANE_MISMATCH/);
  assert.equal(resolveAuthorizationRef({ id: "SHU-197", authorization_ref: "SHU-1" }, CONFIG), "SHU-197");
});

test("CARD_LANE_REVIEW: the reviewer sees the whole scope, runs the card's tests and holds it to its acceptance", () => {
  assert.deepEqual(fixtureReviewScope("SHU-197"), [...SHU197_PATHS]);
  assert.deepEqual(fixtureReviewTests("SHU-197"), [
    "deploy/coolify/test/config-schema.test.mjs",
    "deploy/coolify/test/integration-register.test.mjs",
  ]);
  assert.equal(fixtureAcceptance("SHU-197"), cardContract("SHU-197").acceptance);
  assert.notEqual(fixtureAcceptance("SHU-197"), fixtureAcceptance("SHU-140"));
  assert.equal(fixtureReviewScope("SHU-999"), null);
  assert.equal(fixtureAcceptance("SHU-999"), null);
});

test("CARD_LANE_PROMPTS: the writer and the reviewer of a card both get its brief; a fixture gets none", () => {
  const brief = cardBrief("SHU-197");
  assert.match(brief, /INT-27 \|/);
  const input = { issue_id: "SHU-197", authorization_ref: "SHU-197", attempt_id: "attempt-1", target_sha: SHA, task_context: "ctx" };
  const scoped = { ...input, workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU197_PATHS] };
  for (const [name, prompt] of [
    ["codex writer", buildCodexPrompt(scoped)],
    ["codex reviewer", buildCodexReviewPrompt(input)],
    ["claude writer", buildClaudePrompt({ ...input, role: "build", allowed_paths: [...SHU197_PATHS] })],
    ["claude reviewer", buildClaudePrompt({ ...input, role: "review" })],
  ]) assert.ok(prompt.includes(brief), `${name} prompt carries the card brief`);
  assert.match(buildCodexReviewPrompt(input), /against the card brief above/);
  const fixture = { ...input, issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" };
  assert.doesNotMatch(buildCodexReviewPrompt(fixture), /Card brief/);
  assert.match(buildCodexReviewPrompt(fixture), /the contract the files and their folders document/);
});

test("CARD_LANE_BRIEF: the pinned register has the 27 inventory rows with known states", () => {
  const rows = cardBrief("SHU-197").split("\n").filter((line) => /^INT-\d\d \|/.test(line)).map((line) => line.split(" | "));
  assert.deepEqual(rows.map((row) => row[0]), Array.from({ length: 27 }, (_, i) => `INT-${String(i + 1).padStart(2, "0")}`));
  for (const row of rows) {
    assert.equal(row.length, 6, row.join(" | "));
    assert.ok(["rotate-revoke", "operator-check", "db-state-unknown", "none"].includes(row[3]), row[0]);
    assert.ok(["keep", "replace", "drop", "pending"].includes(row[4]), row[0]);
    assert.match(row[5], /^SHU-\d+(, SHU-\d+)*$/, row[0]);
  }
  // Khalid's D-OP1 decisions on SHU-213 (2026-10-04): Xero, Jira and the wallet are dropped.
  for (const id of ["INT-22", "INT-24", "INT-25"]) assert.equal(rows.find((row) => row[0] === id)[4], "drop", id);
});

test("CARD_LANE_ACTIVATION: an activation cannot pick who builds or who judges a card", () => {
  const config = { ...CONFIG, max_dispatch: 1, dispatch_scope: { issue_ids: ["SHU-197"] } };
  const now = new Date("2026-10-04T12:00:00.000Z");
  const statusOf = (over) => {
    const dir = fs.mkdtempSync(join(tmpdir(), "card-lane-activation-"));
    const file = join(dir, "activation.json");
    fs.writeFileSync(file, JSON.stringify({
      activation_id: "card-lane-run-0001", target_issue_id: "SHU-197", authorization_ref: "SHU-197",
      coordinator_revision: SHA, slots: 1, expires_at: new Date(now.getTime() + 3600_000).toISOString(),
      writer_lane: "codex-builder", reviewer_lane: "claude-verifier", ...over,
    }));
    fs.chmodSync(file, 0o600);
    try { return singleRunActivationStatus({ filePath: file, config, receipts: [], now, gitHead: SHA }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const armed = statusOf({});
  assert.equal(armed.state, "armed", armed.reason);
  assert.equal(armed.writer_lane, "codex-builder");
  assert.match(statusOf({ writer_lane: "claude-builder", reviewer_lane: "codex-verifier" }).reason, /writer_lane claude-builder is not the card lane's codex-builder/);
  assert.match(statusOf({ reviewer_lane: "claude-builder" }).reason, /reviewer_lane claude-builder is not the card lane's claude-verifier/);
  const missing = statusOf({ writer_lane: undefined, reviewer_lane: undefined });
  assert.notEqual(missing.state, "armed");
  assert.match(statusOf({ authorization_ref: "SHU-1" }).reason, /not the lane contract SHU-197/);
  const unconfigured = { ...config, card_lanes: [] };
  const dir = fs.mkdtempSync(join(tmpdir(), "card-lane-activation-"));
  try {
    const file = join(dir, "activation.json");
    fs.writeFileSync(file, JSON.stringify({ activation_id: "card-lane-run-0002", target_issue_id: "SHU-197", authorization_ref: "SHU-197",
      coordinator_revision: SHA, slots: 1, expires_at: new Date(now.getTime() + 3600_000).toISOString(), writer_lane: "codex-builder", reviewer_lane: "claude-verifier" }));
    fs.chmodSync(file, 0o600);
    const refused = singleRunActivationStatus({ filePath: file, config: unconfigured, receipts: [], now, gitHead: SHA });
    assert.notEqual(refused.state, "armed", "a card with no committed lane never arms");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CARD_LANE_ARMED_TICK: an armed SHU-197 tick launches Codex on exactly the card's paths, and the review goes to Claude", async () => {
  const { createEpisodeHarness, SHA_INPUT, SHA_WRITE } = await import("./fixture/episode-harness.mjs");
  const h = createEpisodeHarness({
    issueId: "SHU-197",
    authorizationRef: "SHU-197",
    writerLane: "codex-builder",
    reviewerLane: "claude-verifier",
    githubToken: "fake-token",
    configOverrides: { fixture_lane: CONFIG.fixture_lane, fixture_lanes: CONFIG.fixture_lanes, card_lanes: CONFIG.card_lanes },
  });
  try {
    const scoped = { deriveScopedBaseSha: async ({ allowed_paths }) => { assert.deepEqual(allowed_paths, [...SHU197_PATHS]); return "e".repeat(40); } };
    const tick = await h.runTick({ io: scoped });
    assert.equal(tick.code, 0, tick.text);
    assert.equal(h.launched.length, 1, tick.text);
    const [build] = h.launched;
    assert.equal(build.lane, "codex-cli");
    assert.equal(build.target_sha, SHA_INPUT);
    assert.equal(build.workspace_scope, "scoped");
    assert.deepEqual(build.allowed_paths, [...SHU197_PATHS]);
    const receipt = h.receiptFor(build.attempt_id);
    assert.equal(receipt.authorization_ref, "SHU-197");
    assert.equal(receipt.requested_worker, "codex-builder");

    h.branchHead.value = SHA_WRITE;
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.completeRun(build.run_id);
    for (let i = 0; i < 4 && h.launched.length < 2; i++) {
      const next = await h.runTick({ now: new Date(Date.parse("2026-09-10T12:00:00.000Z") + (i + 1) * 60_000), io: scoped });
      assert.notEqual(next.code, 1, next.text);
    }
    assert.equal(h.launched.length, 2, JSON.stringify(h.receipts().map((r) => [r.requested_worker, r.stage, r.verdict_stage])));
    const review = h.launched[1];
    assert.equal(review.lane, "claude-code");
    assert.equal(review.target_sha, SHA_WRITE);
    assert.equal(h.receiptFor(review.attempt_id).requested_worker, "claude-verifier");
  } finally { h.cleanup(); }
});
