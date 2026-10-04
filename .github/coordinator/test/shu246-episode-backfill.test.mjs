import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  backfillSuccessorDirectives,
  parseWorkOrderDirectiveFromComments,
  receiptCommentBody,
  terminalVerdictCoherent,
} from "../reconcile.mjs";
import {
  episodeScopeFor,
  episodeVerdict,
} from "../single-run-activation.mjs";
import {
  parseWorkOrderDirective,
  renderWorkOrderDirective,
  routeSuccessorFromReceipts,
} from "../review-routing.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const ISSUE = config.fixture_lane.id;
const REPO = config.pilot_repo;
const BRANCH = `coordinator/${ISSUE}`;
const CURRENT_EPISODE = "shu63fixture0012";
const RETIRED_EPISODE = "shu63fixture0010";
const SEED_HEAD = "ba3e6dac52040b512eb17bb64a7c07d597a69401";
const BUILD_HEAD = "690fd9eafb2d5f4b4309dda477fba3e07a8ae1af";
const OLD_HEAD = "8253c455a976ffbeee409e41afec57e25f10b006";
const LINEAR_ID = "11111111-2222-4333-8444-555555555555";

const MSG = Object.freeze({
  reviewRound: "SHU246_EPISODE_REVIEW_ROUND: prior episodes must not spend the current episode revision budget",
  exhaustion: "SHU246_EPISODE_EXHAUSTION: one episode over max_revise must still exhaust in both paths",
  noEpisode: "SHU246_NO_EPISODE_PARITY: an absent armed episode must preserve global backfill byte-for-byte",
  retiredTerminal: "SHU246_RETIRED_TERMINAL: a retired episode terminal must not be replayed",
  scopedWriter: "SHU246_CURRENT_SCOPED_WRITER: Run #7 BLOCK must bind the current episode writer, never the retired writer",
  preserved: "SHU246_HISTORY_PRESERVED: episode scoping is read-only and must not rewrite retained receipts",
});

const scope = episodeScopeFor({ activation_id: CURRENT_EPISODE, supersedes_attempt_ids: [] });

function attempt(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function base(overrides = {}) {
  return {
    receipt_version: "1.0.0",
    issue_id: ISSUE,
    attempt_id: attempt(1),
    episode_id: CURRENT_EPISODE,
    authorization_ref: config.fixture_lane.authorization_ref,
    stage: "COMPLETED",
    verdict_stage: "BUILD_READY",
    requested_worker: "codex-builder",
    worker_identity: "codex:current-writer",
    repo: REPO,
    branch: BRANCH,
    target_sha: SEED_HEAD,
    result_sha: BUILD_HEAD,
    external_run_id: "codexrun_shu246",
    adapter_status: "completed",
    workspace_scope: "scoped",
    scope_phase: "initial",
    allowed_paths: [...config.fixture_lane.initial_build_paths],
    scoped_base_sha: "4a75e9a9e42acff8b955e6b82a917eec9475452d",
    timestamps: {
      reserved: "2026-09-13T15:40:00.000Z",
      launch: "2026-09-13T15:40:01.000Z",
      heartbeat: null,
      terminal: "2026-09-13T15:42:00.000Z",
    },
    evidence_links: [],
    notes: [],
    last_activity: "2026-09-13T15:42:00.000Z",
    ...overrides,
  };
}

function review(overrides = {}) {
  return base({
    attempt_id: attempt(2),
    stage: "HOLD",
    verdict_stage: "BLOCKED",
    requested_worker: "claude-verifier",
    worker_identity: "claude:current-reviewer",
    target_sha: BUILD_HEAD,
    result_sha: undefined,
    workspace_scope: "full",
    scope_phase: "review",
    allowed_paths: [],
    scoped_base_sha: null,
    timestamps: {
      reserved: "2026-09-13T15:43:00.000Z",
      launch: "2026-09-13T15:43:01.000Z",
      heartbeat: null,
      terminal: "2026-09-13T15:47:14.000Z",
    },
    last_activity: "2026-09-13T15:47:14.000Z",
    ...overrides,
  });
}

function priorReviews(count) {
  return Array.from({ length: count }, (_, index) => review({
    attempt_id: attempt(100 + index),
    episode_id: `shu63fixture000${index + 4}`,
    worker_identity: `claude:retired-${index}`,
    target_sha: OLD_HEAD,
    last_activity: `2026-09-12T0${index}:00:00.000Z`,
  }));
}

function runBackfill(receipts, options = {}) {
  const episodeScope = Object.hasOwn(options, "episodeScope") ? options.episodeScope : scope;
  const max_revise = options.max_revise ?? 3;
  const bodies = [];
  const lines = [];
  const promise = backfillSuccessorDirectives({
    receipts,
    commentsByIssue: new Map([[ISSUE, []]]),
    dispatchEnabled: true,
    linearToken: "linear-token",
    githubToken: "",
    linearIdFor: new Map([[ISSUE, LINEAR_ID]]),
    config: { ...config, max_revise },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body).variables.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { commentCreate: { success: true } } }),
      };
    },
    stdout: (line) => lines.push(line),
    episodeScope,
  });
  return { promise, bodies, lines };
}

function ordersFrom(bodies) {
  return bodies
    .map((body) => parseWorkOrderDirective(body))
    .filter((parsed) => parsed.ok)
    .map((parsed) => parsed.order);
}

test("SHU-246 A1: prior episode reviews do not spend the current revision budget", async () => {
  const receipts = [review(), base(), ...priorReviews(5)];
  const before = JSON.stringify(receipts);
  const activation = episodeVerdict({
    receipts,
    targetIssueId: ISSUE,
    config: { ...config, max_revise: 3 },
    episodeScope: scope,
  });
  assert.equal(activation.ended, false, MSG.reviewRound);
  assert.equal(activation.successor?.role, "revise", MSG.reviewRound);

  const backfill = runBackfill(receipts);
  await backfill.promise;
  const revisions = ordersFrom(backfill.bodies).filter((order) => order.role === "revise");
  assert.equal(revisions.length, 1, MSG.reviewRound);
  assert.equal(revisions[0].attempt_id, activation.successor.attempt_id, MSG.reviewRound);
  assert.equal(revisions[0].actor, "codex:current-writer", MSG.reviewRound);
  assert.equal(JSON.stringify(receipts), before, MSG.preserved);
});

test("SHU-246 A2: current episode exhaustion remains fail-closed", async () => {
  const currentReviews = Array.from({ length: 4 }, (_, index) => review({
    attempt_id: attempt(20 + index),
    worker_identity: `claude:current-${index}`,
    last_activity: `2026-09-13T15:${44 + index}:00.000Z`,
  }));
  const receipts = [...currentReviews.slice().reverse(), base()];
  const activation = episodeVerdict({
    receipts,
    targetIssueId: ISSUE,
    config: { ...config, max_revise: 3 },
    episodeScope: scope,
  });
  assert.equal(activation.ended, true, MSG.exhaustion);
  assert.match(activation.reason, /exhausted/, MSG.exhaustion);

  const backfill = runBackfill(receipts);
  await backfill.promise;
  assert.equal(ordersFrom(backfill.bodies).filter((order) => order.role === "revise").length, 0, MSG.exhaustion);
  assert.ok(backfill.lines.some((line) => line.includes("revision attempts exhausted")), MSG.exhaustion);
});

test("SHU-246 A3: no armed episode preserves global routing byte-for-byte", async () => {
  const receipts = [review(), base(), ...priorReviews(2)];
  const expectedBodies = receipts
    .filter((terminal) => terminalVerdictCoherent(terminal, terminal.verdict_stage))
    .map((terminal) => routeSuccessorFromReceipts({
      issueReceipts: receipts,
      terminal,
      evidenceStage: terminal.verdict_stage,
      evidenceResultSha: terminal.result_sha ?? null,
      max_revise: 10,
      fixtureLane: config.fixture_lane,
    }))
    .filter((routed) => routed.ok && routed.order)
    .map((routed) => renderWorkOrderDirective(routed.order));
  const omitted = runBackfill(receipts, { episodeScope: undefined, max_revise: 10 });
  const explicitNull = runBackfill(receipts, { episodeScope: null, max_revise: 10 });
  const [omittedCount, nullCount] = await Promise.all([omitted.promise, explicitNull.promise]);
  assert.equal(omittedCount, receipts.length, MSG.noEpisode);
  assert.equal(omittedCount, nullCount, MSG.noEpisode);
  assert.deepEqual(omitted.bodies, expectedBodies, MSG.noEpisode);
  assert.deepEqual(omitted.bodies, explicitNull.bodies, MSG.noEpisode);
  assert.deepEqual(omitted.lines, explicitNull.lines, MSG.noEpisode);
});

test("SHU-246 A4 / Run #7: scoped writer and eligible terminal both come from the armed episode", async () => {
  // Exact Run #7 ordering: Linear comments are newest first, so without the
  // episode boundary `.at(-1)` selects this retired writer.
  const currentBlock = review({ attempt_id: "44d54ef6-2257-4d4a-8f66-5d4af6610001" });
  const currentWriter = base({
    attempt_id: "5d4af661-8f86-4df8-8004-b1c2031573c7",
    worker_identity: "codex:5d4af661",
  });
  const retiredWriter = base({
    attempt_id: "83c9dbfa-0f09-4ff5-87e4-46eca64f1996",
    episode_id: RETIRED_EPISODE,
    worker_identity: "codex:83c9dbfa",
    result_sha: OLD_HEAD,
    scoped_base_sha: "1111111111111111111111111111111111111111",
    last_activity: "2026-09-12T15:42:00.000Z",
  });
  const receipts = [currentBlock, currentWriter, retiredWriter];
  const before = JSON.stringify(receipts);
  const backfill = runBackfill(receipts);
  const considered = await backfill.promise;
  const orders = ordersFrom(backfill.bodies);
  const revisions = orders.filter((order) => order.role === "revise");

  assert.equal(considered, 2, MSG.retiredTerminal);
  assert.equal(revisions.length, 1, MSG.scopedWriter);
  assert.equal(revisions[0].actor, "codex:5d4af661", MSG.scopedWriter);
  assert.equal(revisions[0].target_sha, BUILD_HEAD, MSG.scopedWriter);
  assert.ok(!orders.some((order) => order.actor === "codex:83c9dbfa"), MSG.scopedWriter);
  assert.ok(!backfill.lines.some((line) => line.includes(retiredWriter.attempt_id)), MSG.retiredTerminal);
  assert.equal(JSON.stringify(receipts), before, MSG.preserved);
});

test("SHU-246 A5: main wires the armed episode boundary into backfill", async () => {
  const h = createEpisodeHarness({
    activationId: CURRENT_EPISODE,
    configOverrides: {
      fixture_lane: config.fixture_lane,
      max_revise: 3,
      // Keep the synthetic tick at the publication boundary. The episode is
      // armed, but no adapter is launched by this test.
      adapter_pause_map: { "codex-cli": true },
    },
  });
  try {
    const currentBlock = review({ attempt_id: "44d54ef6-2257-4d4a-8f66-5d4af6610001" });
    const currentWriter = base({
      attempt_id: "5d4af661-8f86-4df8-8004-b1c2031573c7",
      worker_identity: "codex:5d4af661",
    });
    const retiredWriter = base({
      attempt_id: "83c9dbfa-0f09-4ff5-87e4-46eca64f1996",
      episode_id: RETIRED_EPISODE,
      worker_identity: "codex:83c9dbfa",
      result_sha: OLD_HEAD,
      scoped_base_sha: "1111111111111111111111111111111111111111",
      last_activity: "2026-09-12T15:42:00.000Z",
    });
    for (const [index, receipt] of [currentBlock, currentWriter, retiredWriter].entries()) {
      h.comments.push({ body: receiptCommentBody(receipt), createdAt: `2026-09-13T15:4${index}:00.000Z` });
    }

    const tick = await h.runTick();
    assert.equal(tick.code, 0, `${MSG.scopedWriter}: ${tick.text}`);
    const revisions = parseWorkOrderDirectiveFromComments(h.comments).filter((order) => order.role === "revise");
    assert.equal(revisions.length, 1, MSG.scopedWriter);
    assert.equal(revisions[0].actor, "codex:5d4af661", MSG.scopedWriter);
    assert.equal(h.triggers["codex-cli"], 0, MSG.scopedWriter);
  } finally {
    h.cleanup();
  }
});
