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
import { createReceipt, receiptCommentBody, resolveAuthorizationRef } from "../reconcile.mjs";
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

test("CARD_LANE_HOST_GATE: the host gate never reads the SHU-71 pair's threads for a card order", async () => {
  const { workOrderAuthorization } = await import("../supervisor-authorization.mjs");
  const config = { ...CONFIG, max_dispatch: 1, dispatch_scope: { issue_ids: ["SHU-197"] } };
  const now = new Date("2026-10-04T12:00:00.000Z");
  const record = { activation_id: "card-lane-run-0003", target_issue_id: "SHU-197", authorization_ref: "SHU-197",
    coordinator_revision: SHA, slots: 1, expires_at: new Date(now.getTime() + 3600_000).toISOString(),
    writer_lane: "codex-builder", reviewer_lane: "claude-verifier" };
  const order = { issue_id: "SHU-197", runtime: "codex-cli", authorization_ref: "SHU-197",
    workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU197_PATHS], scoped_base_sha: "e".repeat(40) };
  let reads = 0;
  const check = (over = {}, cfg = config) => workOrderAuthorization({ ...order, ...over }, {
    config: cfg, wait: () => {},
    evidenceRun: () => { reads += 1; throw new Error("pair thread unreadable"); },
    env: { ENABLE_DISPATCH: "true", SHU71_EVIDENCE_BROKER: "true", SHU_SUPERVISOR_ACTIVATION_FILE: "/isolated/activation" },
    activation: { now, gitHead: SHA, io: { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }), readFile: () => JSON.stringify(record) } },
  });
  assert.deepEqual(check(), { ok: true, code: null }, "an unreadable pair thread does not deny a card order");
  assert.equal(reads, 0, "the pair's threads are never read for a single-card scope");
  assert.equal(check({ authorization_ref: "SHU-1" }).code, "HOST_AUTH_LANE_REF");
  assert.equal(check({ allowed_paths: [...SHU197_PATHS, "Dockerfile"] }).code, "HOST_AUTH_ATTEMPT_SCOPE");
  // Under the pair scope the read still happens and a failed read still denies.
  const pair = { ...CONFIG, max_dispatch: 2, dispatch_scope: { issue_ids: ["SHU-140", "SHU-254"] } };
  assert.equal(check({ issue_id: "SHU-140", authorization_ref: CONFIG.fixture_lane.authorization_ref, allowed_paths: [] }, pair).code, "HOST_AUTH_EVIDENCE_UNAVAILABLE");
  assert.ok(reads > 0);
  // One fixture scoped alone still reads its thread: its receipts decide spent
  // and retry. Three FAILED attempts exhaust SHU-140, so the gate refuses
  // (GPT, PR #214 finding 1).
  const fixture = CONFIG.fixture_lane;
  const failed = [1, 2, 3].map((n) => {
    const made = createReceipt({ issue_id: fixture.id, authorization_ref: fixture.authorization_ref, requested_worker: fixture.writer_lane,
      repo: CONFIG.pilot_repo, branch: `coordinator/${fixture.id}`, target_sha: SHA, reserved_at: `2026-10-04T11:0${n}:00.000Z` });
    assert.ok(made.ok, JSON.stringify(made.errors));
    return { body: receiptCommentBody({ ...made.receipt, stage: "FAILED" }), createdAt: `2026-10-04T11:0${n}:30.000Z`, user: { id: CONFIG.linear_receipt_actor_ids[0] } };
  });
  const single = { ...CONFIG, max_dispatch: 1, dispatch_scope: { issue_ids: [fixture.id] } };
  const spent = (evidenceRun) => workOrderAuthorization({ issue_id: fixture.id, runtime: "codex-cli", authorization_ref: fixture.authorization_ref,
    workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...fixture.initial_build_paths], scoped_base_sha: "e".repeat(40) }, {
    config: single, wait: () => {}, evidenceRun,
    env: { ENABLE_DISPATCH: "true", SHU71_EVIDENCE_BROKER: "true", SHU_SUPERVISOR_ACTIVATION_FILE: "/isolated/activation" },
    activation: { now, gitHead: SHA, io: { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }),
      readFile: () => JSON.stringify({ ...record, target_issue_id: fixture.id, authorization_ref: fixture.authorization_ref,
        writer_lane: fixture.writer_lane, reviewer_lane: fixture.reviewer_lane }) } },
  });
  reads = 0;
  const answer = () => { reads += 1; return JSON.stringify({ heads: {}, issues: [{ id: fixture.id, linearId: "uuid-SHU-140" }], comments: failed }); };
  assert.equal(spent(answer).code, "HOST_AUTH_ACTIVATION_SPENT", "a spent single fixture is refused");
  assert.ok(reads > 0, "a single-fixture scope reads its thread");
  assert.equal(spent(() => { throw new Error("thread unreadable"); }).code, "HOST_AUTH_EVIDENCE_UNAVAILABLE", "and an unread thread still denies it");
});

// Every later card has its own lane in config.json and its own reviewed
// contract in card-contracts.mjs, and the committed scope names exactly one of
// them. These tests cover each committed card lane in turn, so a new card
// needs only its contract and its lane, and no test edits.
const WRITER_RUNTIME = { "codex-builder": "codex-cli", "claude-builder": "claude-code" };
const REVIEWER_RUNTIME = { "claude-verifier": "claude-code", "codex-verifier": "codex-cli" };
const LATER_CARDS = CONFIG.card_lanes.filter((entry) => entry.id !== "SHU-197");

test("CARD_LANE_EVERY_CARD: each committed card lane is its own reviewed contract, and the scope names exactly one of them", () => {
  assert.ok(LATER_CARDS.length > 0, "config.json names at least one card after SHU-197");
  for (const lane of LATER_CARDS) {
    const contract = cardContract(lane.id);
    assert.ok(contract, `${lane.id} has a reviewed contract`);
    assert.equal(lane.authorization_ref, lane.id);
    assert.ok(Object.hasOwn(WRITER_RUNTIME, lane.writer_lane), `${lane.id} names a known writer lane`);
    assert.ok(Object.hasOwn(REVIEWER_RUNTIME, lane.reviewer_lane), `${lane.id} names a known reviewer lane`);
    assert.notEqual(WRITER_RUNTIME[lane.writer_lane], REVIEWER_RUNTIME[lane.reviewer_lane], `${lane.id} is reviewed by another model family`);
    assert.deepEqual(resolveFixtureLane(CONFIG, lane.id), lane);
    assert.equal(validateFixtureScopePolicy(lane).ok, true);
    assert.deepEqual(lane.initial_build_paths, [...contract.initial_build_paths]);
    assert.deepEqual(lane.revision_paths, [...contract.revision_paths]);
    assert.deepEqual(fixtureReviewTests(lane.id), contract.revision_paths.filter((path) => path.endsWith(".test.mjs")));
    assert.ok(fixtureReviewTests(lane.id).length > 0, `${lane.id} has tests for the reviewer to run`);
    assert.equal(fixtureAcceptance(lane.id), contract.acceptance);
    for (const other of Object.keys(CARD_CONTRACTS).filter((id) => id !== lane.id)) {
      assert.notEqual(fixtureAcceptance(lane.id), fixtureAcceptance(other), `${lane.id} and ${other} have their own acceptance`);
      assert.notEqual(cardBrief(lane.id), cardBrief(other), `${lane.id} and ${other} have their own brief`);
    }
    assert.match(cardBrief(lane.id), new RegExp(`^Card ${lane.id}: `));
    const widened = { ...lane, revision_paths: [...lane.revision_paths, "deploy/coolify/compose.yaml"] };
    assert.match(validateFixtureScopePolicy(widened).reason, new RegExp(`differ from the reviewed exact ${lane.id} contract`));
  }
  assert.deepEqual(CONFIG.card_lanes.map((lane) => lane.id).sort(), Object.keys(CARD_CONTRACTS).sort(),
    "every reviewed card contract has exactly one committed card lane");
  assert.equal(CONFIG.dispatch_scope.issue_ids.length, 1, "one card at a time");
  const [scoped] = CONFIG.dispatch_scope.issue_ids;
  assert.ok(LATER_CARDS.some((lane) => lane.id === scoped), "the scope names a committed card lane with a contract");
});

test("CARD_LANE_EVERY_CARD_ARMED_TICK: an armed tick of each committed card lane launches its writer on exactly its paths, and its reviewer lane judges the result", async () => {
  const { createEpisodeHarness, SHA_INPUT, SHA_WRITE } = await import("./fixture/episode-harness.mjs");
  for (const lane of LATER_CARDS) {
    const paths = [...cardContract(lane.id).initial_build_paths];
    const h = createEpisodeHarness({
      issueId: lane.id,
      authorizationRef: lane.id,
      writerLane: lane.writer_lane,
      reviewerLane: lane.reviewer_lane,
      githubToken: "fake-token",
      configOverrides: { fixture_lane: CONFIG.fixture_lane, fixture_lanes: CONFIG.fixture_lanes, card_lanes: CONFIG.card_lanes },
    });
    try {
      const scoped = { deriveScopedBaseSha: async ({ allowed_paths }) => { assert.deepEqual(allowed_paths, paths); return "e".repeat(40); } };
      const tick = await h.runTick({ io: scoped });
      assert.equal(tick.code, 0, `${lane.id}: ${tick.text}`);
      assert.equal(h.launched.length, 1, `${lane.id}: ${tick.text}`);
      const [build] = h.launched;
      assert.equal(build.lane, WRITER_RUNTIME[lane.writer_lane], lane.id);
      assert.equal(build.target_sha, SHA_INPUT);
      assert.deepEqual(build.allowed_paths, paths);
      const receipt = h.receiptFor(build.attempt_id);
      assert.equal(receipt.authorization_ref, lane.id);
      assert.equal(receipt.requested_worker, lane.writer_lane);

      h.branchHead.value = SHA_WRITE;
      h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
      h.completeRun(build.run_id);
      for (let i = 0; i < 4 && h.launched.length < 2; i++) {
        const next = await h.runTick({ now: new Date(Date.parse("2026-09-10T12:00:00.000Z") + (i + 1) * 60_000), io: scoped });
        assert.notEqual(next.code, 1, `${lane.id}: ${next.text}`);
      }
      assert.equal(h.launched.length, 2, `${lane.id}: ${JSON.stringify(h.receipts().map((r) => [r.requested_worker, r.stage, r.verdict_stage]))}`);
      const review = h.launched[1];
      assert.equal(review.lane, REVIEWER_RUNTIME[lane.reviewer_lane], lane.id);
      assert.equal(review.target_sha, SHA_WRITE);
      assert.equal(h.receiptFor(review.attempt_id).requested_worker, lane.reviewer_lane);
    } finally { h.cleanup(); }
  }
});
