// test/episode-successor-dispatch.test.mjs — SHU-225.
//
// Option A as amended by Opus on SHU-63: an ARMED single-run episode continues
// past its own terminal receipt by RE-ADMITTING the bound issue to the EXISTING
// selectNextReservation -> RESERVED -> launch path. No second dispatcher exists.
//
// The two failure modes this file exists to prevent:
//   * a successor launched around the guards the reservation path enforces
//     (scope, capacity, pause, retry cap, RESERVED-before-launch, pre-claim
//     recheck) — M8;
//   * the parking exception leaking outside an authorized episode — M1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as reconcile from "../reconcile.mjs";
import * as routing from "../review-routing.mjs";
import * as activation from "../single-run-activation.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, SHA_REVISED, REVISION } from "./fixture/episode-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COORD = join(HERE, "..");
const TARGET = "SHU-140";
const OTHER = "SHU-090";
const CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";
const NOW = new Date("2026-09-10T12:00:00.000Z");
const ATTEMPT = (tag) => ({
  build: "11111111-1111-4111-8111-111111111111",
  review: "22222222-2222-4222-8222-222222222222",
  revise: "33333333-3333-4333-8333-333333333333",
  rereview: "44444444-4444-4444-8444-444444444444",
}[tag]);

// A durable receipt shaped for routing (provenance needs a worker identity).
function receipt({
  issue = TARGET,
  attempt = ATTEMPT("build"),
  worker = "codex-builder",
  stage = "COMPLETED",
  verdict = "BUILD_READY",
  identity = "codex-cli:session-1",
  target = SHA_INPUT,
  result = null,
  at = "2026-09-10T12:00:00.000Z",
} = {}) {
  return {
    receipt_version: "1.0.0",
    issue_id: issue,
    attempt_id: attempt,
    authorization_ref: CONTRACT,
    stage,
    requested_worker: worker,
    worker_identity: identity,
    repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${issue}`,
    target_sha: target,
    external_run_id: `run_${String(attempt).slice(0, 6)}`,
    adapter_status: "completed",
    timestamps: { reserved: at, launch: at, heartbeat: null, terminal: at },
    evidence_links: [],
    last_activity: at,
    notes: [],
    verdict_stage: verdict,
    ...(result ? { result_sha: result } : {}),
  };
}

const successorOrder = () => ({
  version: "1.0.0",
  role: "review",
  runtime: "claude-code",
  actor: "claude-verifier",
  requested_worker: "claude-verifier",
  issue_id: TARGET,
  attempt_id: "99999999-9999-4999-8999-999999999999",
  target_sha: SHA_WRITE,
  authorization_ref: CONTRACT,
});

const readyIssue = (id = TARGET) => ({
  id,
  linearId: `11111111-aaaa-4bbb-8ccc-00000000000${id.slice(-1)}`,
  priority: "High",
  title: "fixture",
  requested_worker: "codex-builder",
});

// ---------------------------------------------------------------------------
// Invariants — the launch path is unchanged, and the exception is bounded
// ---------------------------------------------------------------------------

test("SHU-225 I1/I2: without an armed activation the parking rule is byte-for-byte unchanged", () => {
  const parked = [receipt({ stage: "COMPLETED", verdict: "BUILD_READY" })];
  const parkedAndOtherTest = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: { max_dispatch: 1 },
    receipts: parked,
  });
  assert.equal(parkedAndOtherTest.candidate, null, "parking is unchanged without an armed activation");
  assert.match(parkedAndOtherTest.skipped[0].reason, /parked for human\/next-step/);
  assert.equal(parkedAndOtherTest.successor, undefined, "no successor is ever minted without an episode");
});

test("SHU-225 I1/I2: the SAME receipts DO continue once the episode's successor is supplied", () => {
  const parked = [receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE })];
  const withContinuation = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: { max_dispatch: 1 },
    receipts: parked,
    episodeContinuations: new Map([[TARGET, { successor: successorOrder() }]]),
  });
  assert.equal(withContinuation.candidate?.id, TARGET, "the bound issue is re-admitted for its next step");
  assert.equal(withContinuation.successor?.role, "review");
  assert.equal(withContinuation.adapter, "claude-code", "the successor's own lane selects the adapter");
});

test("SHU-225 I2 (M1): a terminal receipt on ANOTHER card never becomes selectable", () => {
  const selection = reconcile.selectNextReservation({
    ready: [readyIssue(OTHER)],
    config: { max_dispatch: 1 },
    receipts: [receipt({ issue: OTHER, stage: "COMPLETED", verdict: "BUILD_READY" })],
  });
  assert.equal(selection.candidate, null, "parking is unchanged without an armed activation");
  assert.match(selection.skipped[0].reason, /parked for human\/next-step/);
});

test("SHU-225 I3: a successor never takes a second slot — capacity stays global", () => {
  const selection = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: { max_dispatch: 1 },
    receipts: [
      receipt({ attempt: ATTEMPT("review"), worker: "claude-verifier", stage: "RUNNING", verdict: null, issue: OTHER }),
      receipt({ stage: "COMPLETED", verdict: "BUILD_READY" }),
    ],
    episodeContinuations: new Map([[TARGET, { successor: successorOrder() }]]),
  });
  assert.equal(selection.candidate, null, "the successor never takes a second slot (max_dispatch stays global)");
  assert.match(selection.skipped[0].reason, /max_dispatch=1 reached/);
});

test("SHU-225 I3: a successor is only selectable once its predecessor's receipt is terminal", () => {
  const selection = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: { max_dispatch: 2 },
    receipts: [receipt({ stage: "RUNNING", verdict: null })],
    episodeContinuations: new Map([[TARGET, { successor: successorOrder() }]]),
  });
  assert.equal(selection.candidate, null, "an active predecessor keeps the issue out of selection");
  assert.match(selection.skipped[0].reason, /already has an active receipt/);
});

test("SHU-225 I3: a paused successor adapter is skipped, exactly like a first dispatch", () => {
  const selection = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: { max_dispatch: 1, adapter_pause_map: { "claude-code": true } },
    receipts: [receipt({ stage: "COMPLETED", verdict: "BUILD_READY" })],
    episodeContinuations: new Map([[TARGET, { successor: successorOrder() }]]),
  });
  assert.equal(selection.candidate, null, "the pause map is not bypassed by being mid-episode");
  assert.match(selection.skipped[0].reason, /is paused/);
});

test("SHU-225 I2 (M2): the episode's exception covers only its own bound issue", () => {
  const selection = reconcile.selectNextReservation({
    ready: [readyIssue(OTHER)],
    // Board-wide scope: nothing but the continuation's own key protects this.
    config: { max_dispatch: 1 },
    receipts: [receipt({ issue: OTHER, stage: "COMPLETED", verdict: "BUILD_READY" })],
    episodeContinuations: new Map([[TARGET, { successor: successorOrder() }]]),
  });
  assert.equal(selection.candidate, null, "the successor exception never covers a different card");
});

test("SHU-225 I8 (M7): a spent episode is never re-selectable", () => {
  const spent = [
    receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE }),
    receipt({ attempt: ATTEMPT("review"), worker: "claude-verifier", identity: "claude-code:session-2", stage: "COMPLETED", verdict: "PASS", target: SHA_WRITE, at: "2026-09-10T13:00:00.000Z" }),
  ];
  const verdict = activation.episodeVerdict({ receipts: spent, targetIssueId: TARGET, config: {} });
  assert.equal(verdict.ended, true, "a spent episode is never re-selectable");
  assert.match(verdict.reason, /PASS/);
  assert.equal(verdict.successor, undefined, "a finished loop names no successor");
});

test("SHU-225 I8: exhaustion and capped failures still end the episode (termination unchanged)", () => {
  const exhausted = [
    receipt({ stage: "COMPLETED", verdict: "BUILD_READY" }),
    receipt({ attempt: ATTEMPT("review"), worker: "claude-verifier", identity: "claude-code:s1", stage: "HOLD", verdict: "BLOCKED", at: "2026-09-10T13:00:00.000Z" }),
    receipt({ attempt: ATTEMPT("revise"), stage: "COMPLETED", verdict: "REVISION_READY", at: "2026-09-10T13:10:00.000Z" }),
    receipt({ attempt: ATTEMPT("rereview"), worker: "claude-verifier", identity: "claude-code:s2", stage: "HOLD", verdict: "BLOCKED", at: "2026-09-10T13:20:00.000Z" }),
  ];
  // Two review rounds against max_revise: 1 -> the revision budget is exhausted
  // (the field promises max_revise revision attempts; the second BLOCK arrives
  // past it), which is an ENDING, not an availability hold.
  assert.equal(activation.episodeVerdict({ receipts: exhausted, targetIssueId: TARGET, config: { max_revise: 1 } }).ended, true);
  assert.match(activation.episodeVerdict({ receipts: exhausted, targetIssueId: TARGET, config: { max_revise: 1 } }).reason, /exhaust/);
  assert.equal(activation.episodeVerdict({ receipts: exhausted, targetIssueId: TARGET, config: { max_revise: 3 } }).ended, false, "with budget left the episode continues");
  const failed = [1, 2].map((n) => receipt({ attempt: `00000000-0000-4000-8000-00000000000${n}`, stage: "FAILED", verdict: null }));
  assert.equal(activation.episodeVerdict({ receipts: failed, targetIssueId: TARGET, config: {} }).ended, false, "below the cap the episode is still in flight");
  const capped = [1, 2, 3].map((n) => receipt({ attempt: `00000000-0000-4000-8000-00000000000${n}`, stage: "FAILED", verdict: null }));
  assert.equal(activation.episodeVerdict({ receipts: capped, targetIssueId: TARGET, config: { max_failed_attempts: 3 } }).ended, true, "at the cap the episode ends");
});

test("SHU-225 I4: the successor is the same issue as the activation target and the committed scope", () => {
  const selection = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: { max_dispatch: 1, dispatch_scope: { issue_ids: [TARGET] } },
    receipts: [receipt({ stage: "COMPLETED", verdict: "BUILD_READY" })],
    episodeContinuations: new Map([[TARGET, { successor: successorOrder() }]]),
  });
  assert.equal(selection.candidate.id, TARGET);
  assert.equal(selection.successor.issue_id, TARGET, "the successor never names another card");
});

// ---------------------------------------------------------------------------
// The trusted first-review bootstrap
// ---------------------------------------------------------------------------

test("SHU-225 I5: a fresh BUILD_READY with no review receipt routes exactly ONE bootstrapped review", () => {
  const lineage = [receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE })];
  const routed = routing.routeSuccessorFromReceipts({
    issueReceipts: lineage,
    terminal: lineage[0],
    evidenceStage: "BUILD_READY",
    evidenceResultSha: SHA_WRITE,
    max_revise: 3,
    bootstrapReviewer: { lane: "claude-verifier" },
  });
  assert.equal(routed.ok, true);
  assert.equal(routed.bootstrapped, true, "the first review is bootstrapped from the trusted record");
  assert.equal(routed.order.role, "review");
  assert.equal(routed.order.requested_worker, "claude-verifier", "the reviewer lane comes only from the trusted record");
  assert.equal(routed.order.runtime, "claude-code");
  assert.equal(routed.order.target_sha, SHA_WRITE, "the review binds the write's OUTPUT head");
  assert.equal(routed.order.attempt_id, routing.freshAttempt(ATTEMPT("build"), "review", 1), "the successor attempt is DERIVED, never minted fresh");
});

test("SHU-225 I5: with no bootstrap declared the routing still holds visibly (no behaviour change)", () => {
  const lineage = [receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE })];
  const routed = routing.routeSuccessorFromReceipts({
    issueReceipts: lineage, terminal: lineage[0], evidenceStage: "BUILD_READY", evidenceResultSha: SHA_WRITE, max_revise: 3,
  });
  assert.equal(routed.ok, false);
  assert.equal(routed.hold, "no_eligible_reviewer", "no fabricated reviewer — the pre-existing HOLD");
});

test("SHU-225 I5 (M4) / I10: the bootstrap is one-shot, and lineage owns routing afterwards", () => {
  const buildReceipt = receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE });
  const reviewReceipt = receipt({ attempt: ATTEMPT("review"), worker: "claude-verifier", identity: "claude-code:session-2", stage: "HOLD", verdict: "BLOCKED", target: SHA_WRITE, at: "2026-09-10T13:00:00.000Z" });
  const writeLane = { requested_worker: "codex-builder" };

  // ONE-SHOT: with a review-role entry already in the lineage the record's lane is
  // inert, whatever the reviewer's eligibility. (Bound by the M4 mutation.)
  const entriesWithReview = [buildReceipt, reviewReceipt].map((r) => routing.provenanceFromReceipt(r)).filter(Boolean);
  assert.equal(
    routing.bootstrapReviewerFor({ requested: writeLane, entries: entriesWithReview, bootstrapReviewer: { lane: "claude-verifier" } }),
    null,
    "bootstrap is one-shot: a real review receipt makes the record's lane inert",
  );
  assert.equal(
    routing.bootstrapReviewerFor({ requested: writeLane, entries: [routing.provenanceFromReceipt(buildReceipt)], bootstrapReviewer: { lane: "claude-verifier" } })?.lane,
    "claude-verifier",
    "…and before any review exists it is exactly what unlocks the first review",
  );

  // LINEAGE OWNS ROUTING: on a later round the minted order names the reviewer
  // SESSION from the lineage, never the record's lane string. (Bound by M10.)
  const later = routing.nextWorkOrder({
    requested: {
      version: routing.WORK_ORDER_VERSION, role: "revise", runtime: "codex-cli", requested_worker: "codex-builder",
      issue_id: TARGET, attempt_id: ATTEMPT("revise"), target_sha: SHA_WRITE, authorization_ref: CONTRACT,
      review_runtimes: ["codex-cli", "claude-code"],
    },
    entries: entriesWithReview,
    max_revise: 3,
    review_round: 1,
    bootstrapReviewer: { lane: "claude-verifier" },
  });
  assert.equal(later.ok, true, "the revision routes a re-review");
  assert.equal(later.order.actor, "claude-code:session-2", "after the first review, lineage owns routing");
  assert.notEqual(later.order.actor, "claude-verifier", "the record's lane never overrides lineage");
  assert.equal(later.order.requested_worker, "claude-verifier", "the lane maps from the lineage reviewer's runtime");
});

test("SHU-225 I5/I6 (M5): a same-family reviewer lane is refused — independence is CHECKED", () => {
  const lineage = [receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE })];
  const sameFamily = routing.routeSuccessorFromReceipts({
    issueReceipts: lineage, terminal: lineage[0], evidenceStage: "BUILD_READY", evidenceResultSha: SHA_WRITE, max_revise: 3,
    bootstrapReviewer: { lane: "codex-builder" },
  });
  assert.equal(sameFamily.ok, false, "a builder-family reviewer is self-verification, not review");
  assert.equal(sameFamily.hold, "no_eligible_reviewer");
});

test("SHU-225 I5/I6 (M9): an unrecognised reviewer lane is refused, never inferred from card text", () => {
  const lineage = [receipt({ stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE })];
  for (const lane of ["verifier:claude", "claude", "", "builder-family"]) {
    const routed = routing.routeSuccessorFromReceipts({
      issueReceipts: lineage, terminal: lineage[0], evidenceStage: "BUILD_READY", evidenceResultSha: SHA_WRITE, max_revise: 3,
      bootstrapReviewer: { lane },
    });
    assert.equal(routed.ok, false, `lane ${JSON.stringify(lane)} must not be accepted`);
  }
});

test("SHU-225 I6: the activation record's reviewer_lane shape is validated, and stays an exact-key-set surface", () => {
  const base = {
    activation_id: "shu225testrecord",
    target_issue_id: TARGET,
    authorization_ref: CONTRACT,
    coordinator_revision: REVISION,
    slots: 1,
    expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
  };
  assert.equal(activation.validateActivationRecord({ ...base }).ok, true, "absent is valid");
  assert.equal(activation.validateActivationRecord({ ...base, reviewer_lane: "claude-verifier" }).ok, true, "a known lane is valid");
  assert.equal(activation.validateActivationRecord({ ...base, reviewer_lane: "verifier:claude" }).ok, false, "an unrecognised lane refuses");
  assert.equal(activation.validateActivationRecord({ ...base, reviewer_lane: 7 }).ok, false, "a malformed lane refuses");
  assert.equal(activation.validateActivationRecord({ ...base, reviewer_lane: "claude-verifier", extra: 1 }).ok, false, "an unreviewed extra key still refuses");
  assert.equal(activation.validateActivationRecord({ ...base, reviewer_lane: "claude-verifier", unrelated_key: true }).ok, false);
});

test("SHU-225 I6: the bootstrap lane comes from the record ONLY — never from card labels or comment text", () => {
  const h = createEpisodeHarness({ withReviewerLane: false, extraNodes: [{ ...h_node(), labels: { nodes: [{ name: "repo:platform" }, { name: "worker:claude-verifier" }, { name: "verifier:claude" }] } }] });
  try {
    const status = activation.singleRunActivationStatus({
      filePath: h.activationPath, config: h.config, receipts: [], now: NOW, dir: COORD, gitHead: REVISION,
    });
    assert.equal(status.state, "armed");
    assert.equal(status.reviewer_lane, null, "no record field, no bootstrap lane");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// MUTATIONS — M1..M10 from the SHU-225 spec.
// Each removes ONE guard and must fail a NAMED assertion (never crash).
// ---------------------------------------------------------------------------

const MUTATIONS = [
  {
    // M1 — the blast radius. The parking exception must require the episode.
    name: "M1: parking exception applied without an armed activation",
    file: "reconcile.mjs",
    from: "    if (parkedIssueIds.has(issue.id) && !episodeContinuations.has(issue.id)) {",
    to: "    if (false) { // SHU225-MUT-M1",
    assertion: `const sel = reconcile.selectNextReservation({ ready: [readyIssue(OTHER)], config: { max_dispatch: 1 }, receipts: [receipt({ issue: OTHER })] });
assert.equal(sel.candidate, null, "parking is unchanged without an armed activation");`,
    failure: /parking is unchanged without an armed activation/,
  },
  {
    // M2 — the successor must be the activation's own bound issue.
    name: "M2: the successor exception is not bound to the target card",
    file: "reconcile.mjs",
    from: "    const continuation = episodeContinuations.get(issue.id) ?? null;",
    to: "    const continuation = episodeContinuations.size > 0 ? [...episodeContinuations.values()][0] : null; // SHU225-MUT-M2",
    assertion: `const sel = reconcile.selectNextReservation({ ready: [readyIssue(OTHER)], config: { max_dispatch: 1 }, receipts: [receipt({ issue: OTHER })], episodeContinuations: new Map([[TARGET, { successor: succ() }]]) });
assert.equal(sel.candidate, null, "the successor exception never covers a different card");`,
    failure: /the successor exception never covers a different card/,
  },
  {
    // M3 — capacity stays global; a successor never takes a second slot.
    name: "M3: the successor is exempt from the global capacity count",
    file: "reconcile.mjs",
    from: "  if (active.length >= maxDispatch) {",
    to: "  if (false) { // SHU225-MUT-M3",
    assertion: `const receipts = [receipt({ issue: OTHER, attempt: A("review"), worker: "claude-verifier", stage: "RUNNING", verdict: null }), receipt({})];
const sel = reconcile.selectNextReservation({ ready: [readyIssue(TARGET)], config: { max_dispatch: 1 }, receipts, episodeContinuations: new Map([[TARGET, { successor: succ() }]]) });
assert.equal(sel.candidate, null, "the successor never takes a second slot (max_dispatch stays global)");`,
    failure: /the successor never takes a second slot/,
  },
  {
    // M4 — the bootstrap is consumed only while the lineage has no review entry.
    name: "M4: the bootstrap reviewer is consumed even when a review entry exists",
    file: "review-routing.mjs",
    from: "  if ((entries ?? []).some((e) => e && e.role === \"review\")) return null;",
    to: "  if (false) return null; // SHU225-MUT-M4",
    assertion: `const entries = [routing.provenanceFromReceipt(receipt({})), routing.provenanceFromReceipt(receipt({ attempt: A("review"), worker: "claude-verifier", identity: "claude-code:s2", stage: "HOLD", verdict: "BLOCKED" }))].filter(Boolean);
const boot = routing.bootstrapReviewerFor({ requested: { requested_worker: "codex-builder" }, entries, bootstrapReviewer: { lane: "claude-verifier" } });
assert.equal(boot, null, "bootstrap is one-shot");`,
    failure: /bootstrap is one-shot/,
  },
  {
    // M5 — independence is CHECKED against the write lane's family.
    name: "M5: the independence validation is skipped",
    file: "review-routing.mjs",
    from: "  if (!writeFamily || !reviewFamily || writeFamily === reviewFamily) return null;",
    to: "  if (!writeFamily || !reviewFamily) return null; // SHU225-MUT-M5",
    assertion: `const boot = routing.bootstrapReviewerFor({ requested: { requested_worker: "codex-builder" }, entries: [routing.provenanceFromReceipt(receipt({}))].filter(Boolean), bootstrapReviewer: { lane: "codex-builder" } });
assert.equal(boot, null, "a same-family reviewer lane is refused");`,
    failure: /a same-family reviewer lane is refused/,
  },
  {
    // M6 — the successor attempt id is DERIVED, so a restart re-derives it.
    name: "M6: the successor attempt id is minted fresh instead of derived",
    file: "reconcile.mjs",
    from: "    ...(successor?.attempt_id ? { attempt_id: successor.attempt_id } : {}),",
    to: "    ...(false ? { attempt_id: successor.attempt_id } : {}), // SHU225-MUT-M6",
    needsHarness: true,
    assertion: `const h = createEpisodeHarness();
try {
  await h.runTick(); const build = h.latestFor("codex-builder");
  await h.runTick();
  h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
  h.completeRun(build.external_run_id);
  await h.runTick(); await h.runTick();
  const review = h.receipts().find((r) => r.requested_worker === "claude-verifier");
  const derived = routing.freshAttempt(build.attempt_id, "review", 1);
  assert.equal(review?.attempt_id, derived, "the successor attempt id is derived from its predecessor");
} finally { h.cleanup(); }`,
    failure: /the successor attempt id is derived from its predecessor/,
  },
  {
    // M7 — a spent episode must never take the parking exception.
    name: "M7: a PASS episode no longer ends (so it could keep the exception)",
    file: "single-run-activation.mjs",
    from: "    return { ended: true, reason: \"review PASS — the episode is complete\" };",
    to: "    return { ended: false, reason: \"review PASS — the episode is complete\" }; // SHU225-MUT-M7",
    assertion: `const spent = [receipt({}), receipt({ attempt: A("review"), worker: "claude-verifier", identity: "claude-code:s2", stage: "COMPLETED", verdict: "PASS", result: SHA_WRITE, at: "2026-09-10T13:00:00.000Z" })];
const v = act.episodeVerdict({ receipts: spent, targetIssueId: TARGET, config: {} });
assert.equal(v.ended, true, "a spent episode is never re-selectable");`,
    failure: /a spent episode is never re-selectable/,
  },
  {
    // M8 — the successor rides the SAME RESERVED-before-launch path. No bypass.
    name: "M8: the successor is launched without its durable RESERVED receipt",
    file: "reconcile.mjs",
    from: "  await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(receipt) }, linearToken, fetchImpl);",
    to: "  if (!successor) await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(receipt) }, linearToken, fetchImpl); // SHU225-MUT-M8",
    needsHarness: true,
    assertion: `const h = createEpisodeHarness();
try {
  await h.runTick(); const build = h.latestFor("codex-builder");
  await h.runTick();
  h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
  h.completeRun(build.external_run_id);
  await h.runTick(); await h.runTick();
  const reservedForSuccessor = h.comments.some((c) => String(c.body).includes('"stage": "RESERVED"') && !String(c.body).includes(build.attempt_id));
  assert.equal(reservedForSuccessor, true, "the successor is RESERVED before it is launched");
} finally { h.cleanup(); }`,
    failure: /the successor is RESERVED before it is launched/,
  },
  {
    // M9 — the reviewer lane comes ONLY from the trusted record.
    name: "M9: an unrecognised reviewer lane is accepted (label-shaped value)",
    file: "review-routing.mjs",
    from: "  if (typeof lane !== \"string\" || !REVIEW_LANES.includes(lane)) return null;",
    to: "  if (typeof lane !== \"string\") return null; // SHU225-MUT-M9",
    assertion: `const boot = routing.bootstrapReviewerFor({ requested: { requested_worker: "codex-builder" }, entries: [routing.provenanceFromReceipt(receipt({}))].filter(Boolean), bootstrapReviewer: { lane: "verifier:claude" } });
assert.equal(boot, null, "the reviewer lane comes only from the trusted record");`,
    failure: /the reviewer lane comes only from the trusted record/,
  },
  {
    // M10 — after the first review, lineage owns routing; the record goes inert.
    name: "M10: the record's reviewer overrides lineage on later rounds",
    file: "review-routing.mjs",
    from: "    const reviewer = eligible[0];",
    to: "    const reviewer = bootstrapReviewerFor({ requested, entries: [], bootstrapReviewer }) ? { actor: bootstrapReviewer.lane, runtime: runtimeForRequestedWorker(bootstrapReviewer.lane) } : eligible[0]; // SHU225-MUT-M10",
    assertion: `const entries = [routing.provenanceFromReceipt(receipt({})), routing.provenanceFromReceipt(receipt({ attempt: A("review"), worker: "claude-verifier", identity: "claude-code:session-2", stage: "HOLD", verdict: "BLOCKED", at: "2026-09-10T13:00:00.000Z" }))].filter(Boolean);
const later = routing.nextWorkOrder({ requested: { version: routing.WORK_ORDER_VERSION, role: "revise", runtime: "codex-cli", requested_worker: "codex-builder", issue_id: TARGET, attempt_id: A("revise"), target_sha: SHA_WRITE, authorization_ref: CONTRACT, review_runtimes: ["codex-cli", "claude-code"] }, entries, max_revise: 3, review_round: 1, bootstrapReviewer: { lane: "claude-verifier" } });
assert.equal(later.order?.actor, "claude-code:session-2", "after the first review, lineage owns routing");`,
    failure: /after the first review, lineage owns routing/,
  },
];

const MUTATION_PRELUDE = `
const TARGET = "SHU-140";
const OTHER = "SHU-090";
const CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";
const REVISION = "d".repeat(40);
const SHA_INPUT = "a".repeat(40);
const SHA_WRITE = "b".repeat(40);
const A = (t) => ({ build: "11111111-1111-4111-8111-111111111111", review: "22222222-2222-4222-8222-222222222222", revise: "33333333-3333-4333-8333-333333333333" }[t]);
function receipt(o = {}) {
  return { receipt_version: "1.0.0", issue_id: o.issue ?? TARGET, attempt_id: o.attempt ?? A("build"), authorization_ref: CONTRACT,
    stage: o.stage ?? "COMPLETED", requested_worker: o.worker ?? "codex-builder", worker_identity: o.identity ?? "codex-cli:session-1",
    repo: "r", branch: "b", target_sha: o.target ?? SHA_INPUT, external_run_id: "run1", adapter_status: "completed",
    timestamps: { reserved: "t", launch: "t", heartbeat: null, terminal: "t" }, evidence_links: [],
    last_activity: o.at ?? "2026-09-10T12:00:00.000Z", notes: [], verdict_stage: o.verdict === undefined ? "BUILD_READY" : o.verdict,
    ...(o.result ? { result_sha: o.result } : {}) };
}
function succ() {
  return { version: "1.0.0", role: "review", runtime: "claude-code", actor: "claude-verifier", requested_worker: "claude-verifier",
    issue_id: TARGET, attempt_id: "99999999-9999-4999-8999-999999999999", target_sha: SHA_WRITE, authorization_ref: CONTRACT };
}
function readyIssue(id = TARGET) {
  return { id, linearId: "11111111-aaaa-4bbb-8ccc-000000000777", priority: "High", title: "fixture", requested_worker: "codex-builder" };
}
const routing = await import("./review-routing.mjs");
const reconcile = await import("./reconcile.mjs");
const act = await import("./single-run-activation.mjs");
const { createEpisodeHarness } = await import("./test/fixture/episode-harness.mjs");
`;

test("SHU-225 MUTATIONS: every invariant has a load-bearing guard (M1..M10)", () => {
  const root = mkdtempSync(join(tmpdir(), "shu225-mut-"));
  const results = [];
  try {
    for (const m of MUTATIONS) {
      const dir = join(root, m.name.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40));
      mkdirSync(dir, { recursive: true });
      cpSync(COORD, dir, { recursive: true });
      const target = join(dir, m.file);
      const source = readFileSync(target, "utf8");
      if (!source.includes(m.from)) {
        results.push({ name: m.name, killed: false, why: "source marker missing" });
        continue;
      }
      writeFileSync(target, source.replace(m.from, m.to));
      const probe = join(dir, "shu225-probe.mjs");
      writeFileSync(probe, `${MUTATION_PRELUDE}\n${m.assertion}\nconsole.log("PROBE_PASSED");\n`);
      let killed = false;
      let why = "";
      try {
        execFileSync("node", [probe], { cwd: dir, stdio: "pipe" });
        why = "probe still passed — mutation survived";
      } catch (err) {
        const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        if (m.failure.test(text)) killed = true;
        else why = `probe failed for the wrong reason: ${String(text).split("\n").find((l) => l.includes("Error")) ?? "unknown"}`;
      }
      results.push({ name: m.name, killed, why });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const survived = results.filter((r) => !r.killed);
  assert.deepEqual(survived, [], `mutations survived:\n${survived.map((r) => `  ${r.name} — ${r.why}`).join("\n")}`);
  assert.equal(results.length, 10, "all ten mutations from the spec are exercised");
});

function h_node() {
  return {
    id: "11111111-aaaa-4bbb-8ccc-000000000888",
    identifier: "SHU-141",
    title: "label carrier",
    state: { name: "Todo" },
    priorityLabel: "Low",
    labels: { nodes: [{ name: "repo:platform" }] },
    assignee: null, delegate: null, parent: null, relations: { nodes: [] },
  };
}

test("SHU-225 I9: a refused successor path writes nothing (activation refused -> exit 2, zero writes)", async () => {
  const h = createEpisodeHarness({ withReviewerLane: true, expiresInMs: -60_000 });
  try {
    const t = await h.runTick();
    assert.equal(t.code, 2, "an expired activation refuses");
    assert.equal(h.triggers["codex-cli"] + h.triggers["claude-code"], 0, "no launch");
    assert.equal(h.receipts().length, 0, "no receipt");
    assert.equal(h.comments.length, 0, "no Linear write at all");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// THE end-to-end proof: the coordinator itself launches every step
// ---------------------------------------------------------------------------

test("SHU-225: the coordinator drives build -> BLOCK -> revision -> re-review -> PASS with NO seeded successor receipts", async () => {
  const h = createEpisodeHarness();
  try {
    // 1. The build. One authorization, one slot, no seeded anything.
    let t = await h.runTick();
    assert.equal(t.code, 0, t.text);
    assert.equal(h.triggers["codex-cli"], 1, "the builder is launched by the activation");
    const build = h.latestFor("codex-builder");
    assert.equal(build.stage, "RUNNING");
    assert.equal(build.target_sha, SHA_INPUT, "the build starts at the bound input head");

    // 2. The builder reports BUILD_READY; the poll sees the run finish.
    await h.runTick(); // poll tick: identity
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.completeRun(build.external_run_id);
    t = await h.runTick();
    assert.equal(t.code, 0, t.text);
    assert.equal(h.receiptFor(build.attempt_id).stage, "COMPLETED");
    assert.equal(h.receiptFor(build.attempt_id).verdict_stage, "BUILD_READY");

    // 3. THE CRUX: with the card parked and NOTHING seeded, the coordinator posts
    //    the review order and launches the reviewer itself.
    t = await h.runTick();
    assert.equal(t.code, 0, t.text);
    assert.match(t.text, /POSTED review order \(actor=claude-verifier/, "the first review is bootstrapped from the trusted record");
    assert.match(t.text, /dispatch: episode successor — review via claude-verifier/);
    assert.equal(h.triggers["claude-code"], 1, "the coordinator launched the reviewer itself");
    const review = h.latestFor("claude-verifier");
    assert.equal(review.stage, "RUNNING");
    assert.equal(review.target_sha, SHA_WRITE, "the review is bound to the write's output head");
    // The successor was RESERVED before it was launched, exactly like a first dispatch.
    const reserved = h.comments.some((c) => String(c.body).includes('"stage": "RESERVED"') && String(c.body).includes(review.attempt_id));
    assert.equal(reserved, true, "the successor is RESERVED before it is launched");

    // 4. The reviewer BLOCKs — the seeded defect was found.
    await h.runTick();
    h.postCallback({ attemptId: review.attempt_id, stage: "BLOCKED", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
    h.completeRun(review.external_run_id);
    t = await h.runTick();
    assert.equal(h.receiptFor(review.attempt_id).stage, "HOLD");
    assert.equal(h.receiptFor(review.attempt_id).verdict_stage, "BLOCKED");

    // 5. The revision goes back to the WRITER's lane, automatically.
    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — revise via codex-builder/);
    assert.equal(h.triggers["codex-cli"], 2, "the revision is launched by the coordinator");
    const revise = h.latestFor("codex-builder");
    assert.equal(revise.stage, "RUNNING");

    // 6. The revision reports REVISION_READY and moves the branch head.
    await h.runTick();
    h.postCallback({ attemptId: revise.attempt_id, stage: "REVISION_READY", targetSha: SHA_WRITE, resultSha: SHA_REVISED });
    h.completeRun(revise.external_run_id);
    await h.runTick();
    assert.equal(h.receiptFor(revise.attempt_id).verdict_stage, "REVISION_READY");

    // 7. The re-review is routed from LINEAGE (not the record) and launched.
    t = await h.runTick();
    assert.match(t.text, /dispatch: episode successor — review via claude-verifier/);
    assert.equal(h.triggers["claude-code"], 2, "the re-review is launched by the coordinator");
    const rereview = h.latestFor("claude-verifier");
    assert.equal(rereview.target_sha, SHA_REVISED, "the re-review binds the revision's output head");

    // 8. PASS ends the episode.
    await h.runTick();
    h.postCallback({ attemptId: rereview.attempt_id, stage: "PASS", targetSha: SHA_REVISED, resultSha: SHA_REVISED });
    h.completeRun(rereview.external_run_id);
    t = await h.runTick();
    assert.equal(h.receiptFor(rereview.attempt_id).stage, "COMPLETED");
    assert.equal(h.receiptFor(rereview.attempt_id).verdict_stage, "PASS");

    // 9. The authorization is spent: nothing further is launched.
    const before = { ...h.triggers };
    t = await h.runTick();
    assert.equal(t.code, 2, "after PASS the activation refuses");
    assert.match(t.text, /activation=REFUSED/);
    assert.match(t.text, /activation is spent/);
    assert.deepEqual(h.triggers, before, "a spent episode launches nothing");

    // The whole episode: four launches, one per step, no human relay anywhere.
    assert.deepEqual(h.triggers, { "codex-cli": 2, "claude-code": 2, "hermes-pool": 0 });
    const stages = h.receipts().map((r) => `${r.requested_worker}:${r.stage}/${r.verdict_stage ?? "-"}`);
    assert.deepEqual(stages, [
      "codex-builder:COMPLETED/BUILD_READY",
      "claude-verifier:HOLD/BLOCKED",
      "codex-builder:COMPLETED/REVISION_READY",
      "claude-verifier:COMPLETED/PASS",
    ]);
  } finally {
    h.cleanup();
  }
});

test("SHU-225 I7: replay at every boundary cannot duplicate a successor", async () => {
  const h = createEpisodeHarness();
  try {
    await h.runTick();
    const build = h.latestFor("codex-builder");
    await h.runTick();
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.completeRun(build.external_run_id);
    await h.runTick();

    // Replay the successor boundary three times: exactly one review attempt.
    await h.runTick();
    await h.runTick();
    await h.runTick();
    const reviews = h.receipts().filter((r) => r.requested_worker === "claude-verifier");
    assert.equal(reviews.length, 1, "a replay at the successor boundary never duplicates");
    assert.equal(h.triggers["claude-code"], 1);
    assert.equal(reviews[0].attempt_id, routing.freshAttempt(build.attempt_id, "review", 1), "the successor attempt id is derived from its predecessor");

    // A restart while the successor is ACTIVE also cannot duplicate.
    await h.runTick();
    assert.equal(h.receipts().filter((r) => r.requested_worker === "claude-verifier").length, 1);
    assert.equal(h.triggers["claude-code"], 1);
  } finally {
    h.cleanup();
  }
});

test("SHU-225 I10: with no activation the successor path is unreachable and parking is unchanged", async () => {
  const h = createEpisodeHarness({ configOverrides: { enable_dispatch: false } });
  try {
    // Same durable state as a mid-episode card (a terminal COMPLETED receipt), but
    // NO --activation argument. Dispatch needs the committed switch AND the runtime
    // switch; with the committed switch pinned false the coordinator is inert.
    await h.runTick(); // real build under the activation
    const build = h.latestFor("codex-builder");
    await h.runTick();
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.completeRun(build.external_run_id);
    await h.runTick();
    assert.equal(h.receiptFor(build.attempt_id).stage, "COMPLETED");

    const out = [];
    const code = await reconcile.main([], { ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "tok", GITHUB_TOKEN: "" }, {
      configPath: h.configPath,
      skipActivationPreflight: true,
      now: () => NOW,
      gitHead: REVISION,
      stdout: (s) => out.push(s),
      fetchDurable: true,
      pollRuns: true,
      adapterModules: h.adapters,
      fetchImpl: h.fetchImpl,
    });
    const text = out.join("\n");
    assert.equal(code, 0, "no activation supplied -> the disabled default, not a refusal");
    assert.match(text, /dispatch_scope=|activation=not requested|DRY/i);
    assert.equal(h.triggers["claude-code"], 0, "no activation, no successor launch");
    assert.match(text, /parked for human\/next-step/, "the parked issue stays parked");
  } finally {
    h.cleanup();
  }
});
