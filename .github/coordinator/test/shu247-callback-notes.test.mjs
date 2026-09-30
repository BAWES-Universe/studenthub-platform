import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  callbackBindingValid,
  callbackEvidenceValid,
  createReceipt,
  nextReceiptState,
} from "../reconcile.mjs";
import { episodeVerdict } from "../single-run-activation.mjs";
import { supervisorOrder } from "../supervisor-dispatch.mjs";
import { buildCodexPrompt } from "../adapters/codex-cli.mjs";
import { signedSupervisorRequest } from "../supervisor.mjs";
import {
  REVIEW_FINDINGS_LINK_LENGTH_MAX,
  REVIEW_FINDINGS_LINKS_MAX,
  REVIEW_FINDINGS_SUMMARY_MAX,
  reviewFindingsContext,
  reviewFindingsFromCallback,
  validReviewFindings,
} from "../review-findings.mjs";

const RUN7_HEAD = "690fd9eafb2d5f4b4309dda477fba3e07a8ae1af";
const RUN7_ATTEMPT = "44d54ef6-2257-4d4a-8f66-5d4af6610001";

function running(overrides = {}) {
  return {
    receipt_version: "1.0.0",
    issue_id: "SHU-140",
    attempt_id: RUN7_ATTEMPT,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    episode_id: "shu63fixture0012",
    stage: "RUNNING",
    requested_worker: "claude-verifier",
    worker_identity: null,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-140",
    target_sha: RUN7_HEAD,
    workspace_scope: "full",
    scope_phase: "review",
    allowed_paths: [],
    scoped_base_sha: null,
    external_run_id: "clauderun_44d54ef622574d4a8f665d4af6610001",
    adapter_status: "in_progress",
    timestamps: {
      reserved: "2026-09-13T15:43:13.934Z",
      launch: "2026-09-13T15:43:14.110Z",
      heartbeat: null,
      terminal: null,
    },
    evidence_links: [],
    last_activity: "2026-09-13T15:43:14.110Z",
    notes: [],
    ...overrides,
  };
}

function callback(overrides = {}) {
  return {
    attempt_id: RUN7_ATTEMPT,
    target_sha: RUN7_HEAD,
    stage: "BLOCKED",
    links: [
      "file:///srv/shu/state/reviewer-evidence/44d54ef6-2257-4d4a-8f66-5d4af6610001.review-test.1.json",
    ],
    ...overrides,
  };
}

function fold(receipt, evidence, context = {}) {
  return nextReceiptState(receipt, {
    type: "run_status",
    status: "completed",
    callback: evidence,
    reason_code: "REVIEW_TESTS_PASSED",
    at: "2026-09-13T15:46:28.706Z",
  }, {
    current_head: RUN7_HEAD,
    expected_head: RUN7_HEAD,
    lineage: [],
    ...context,
  }).receipt;
}

test("SHU-247 A1: Run #7's exact bound BLOCK records a truthful durable HOLD note", () => {
  const receipt = running();
  const evidence = callback();
  const ctx = { current_head: RUN7_HEAD, expected_head: RUN7_HEAD, lineage: [] };

  assert.equal(callbackBindingValid(receipt, evidence, ctx), true, "the Run #7 BLOCK binding must be valid");
  assert.equal(callbackEvidenceValid(receipt, evidence, ctx), false, "BLOCKED must remain outside success stages");

  const held = fold(receipt, evidence);
  assert.equal(held.stage, "HOLD", "a BLOCK must never authorize COMPLETED");
  assert.equal(held.verdict_stage, "BLOCKED", "the bound BLOCK remains durable routing evidence");
  assert.match(held.notes[0], /validated callback.*BLOCKED verdict recorded.*HOLD/);
  assert.doesNotMatch(held.notes[0], /REJECTED|mismatch|stale head/);
  assert.match(held.notes.at(-1), /adapter reason code: REVIEW_TESTS_PASSED/, "adapter reason codes remain append-only audit evidence");
});

test("SHU-247 A2: a bound FAILED verdict is recorded truthfully without becoming COMPLETED", () => {
  const held = fold(running(), callback({ stage: "FAILED" }));
  assert.equal(held.stage, "HOLD");
  assert.equal(held.verdict_stage, "FAILED");
  assert.match(held.notes[0], /validated callback.*FAILED verdict recorded.*HOLD/);
  assert.doesNotMatch(held.notes[0], /REJECTED|mismatch|stale head/);
});

test("SHU-247 A3: actual attempt, target, and live-head mismatches remain rejected and fail closed", () => {
  const cases = [
    ["foreign attempt", callback({ attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), {}],
    ["foreign callback head", callback({ target_sha: "b".repeat(40) }), {}],
    ["stale live head", callback(), { current_head: "c".repeat(40) }],
    ["invalid expected head", callback(), { expected_head: "not-a-sha" }],
  ];

  for (const [label, evidence, context] of cases) {
    const held = fold(running(), evidence, context);
    assert.equal(held.stage, "HOLD", `${label}: fail closed`);
    assert.equal(held.verdict_stage, undefined, `${label}: rejected evidence cannot become a routing fact`);
    assert.match(held.notes[0], /callback REJECTED.*mismatch or stale head.*HOLD/, `${label}: rejection remains explicit`);
    assert.match(held.notes.at(-1), /adapter reason code: REVIEW_TESTS_PASSED/, `${label}: reason code remains retained`);
  }
});

test("SHU-247 A4: malformed and non-verdict callbacks remain rejected and fail closed", () => {
  const cases = [
    ["missing links", callback({ links: [] })],
    ["missing stage", callback({ stage: undefined })],
    ["unknown stage", callback({ stage: "NEEDS_WORK" })],
    ["non-object callback", "malformed"],
  ];

  for (const [label, evidence] of cases) {
    const held = fold(running(), evidence);
    assert.equal(held.stage, "HOLD", `${label}: fail closed`);
    assert.equal(held.verdict_stage, undefined, `${label}: rejected evidence cannot become a routing fact`);
    assert.match(held.notes[0], /callback REJECTED.*HOLD/, `${label}: rejection remains explicit`);
  }
});

// V1 contract step 3: the revision is dispatched with the review's findings.
const CONFIG = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const ISSUE = CONFIG.fixture_lane.id;
const CONTRACT = CONFIG.fixture_lane.authorization_ref;
const HEAD = "6e43b7e6f17823efdbe492e16c57f7edcb692164";
const BUILD = "b247dd03-bab3-4a11-8ed9-c5582f6322c6";
const REVIEW = "44179638-2257-4000-8000-000000000001";
const SUMMARY = 'DEFECT 1 (blocking): tools/fixture-conformance/scan-vacuous.expectations.mjs:45-49 declares expected: [] for the string-literal row; the contract says ["stub"].';
const LINKS = [
  "file:///srv/shu/state/reviewer-evidence/44179638.review-test.1.json",
  `tools/fixture-conformance/scan-vacuous.expectations.mjs@${HEAD}:45-49`,
];

function rfReceipt({ attempt_id, requested_worker, stage, verdict_stage, minute, ...rest }) {
  const created = createReceipt({
    issue_id: ISSUE, authorization_ref: CONTRACT, requested_worker, attempt_id,
    repo: "BAWES-Universe/studenthub-platform", branch: `coordinator/${ISSUE}`, target_sha: HEAD,
    reserved_at: "2026-09-30T06:45:00.000Z",
  });
  if (!created.ok) throw new Error(created.errors.join("; "));
  return {
    ...created.receipt, stage, worker_identity: `${requested_worker}-session`,
    external_run_id: `run_${attempt_id}`, adapter_status: stage === "RUNNING" ? "in_progress" : "completed",
    evidence_links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/1"],
    timestamps: { reserved: "2026-09-30T06:45:00.000Z", launch: "2026-09-30T06:45:01.000Z", heartbeat: null,
      terminal: stage === "RUNNING" ? null : `2026-09-30T06:${minute}:00.000Z` },
    last_activity: `2026-09-30T06:${minute}:00.000Z`,
    ...(verdict_stage ? { verdict_stage } : {}),
    ...rest,
  };
}

function rfFold(active, evidence) {
  return nextReceiptState(active, { type: "run_status", status: "completed", callback: evidence, at: "2026-09-30T06:50:00.000Z" },
    { current_head: HEAD, expected_head: HEAD, lineage: [] }).receipt;
}

const rfBlocked = (over = {}) => ({ attempt_id: REVIEW, target_sha: HEAD, stage: "BLOCKED", links: LINKS, summary: SUMMARY, ...over });

test("review findings: the reviewer's BLOCK reaches the revise worker's task context through durable receipts", () => {
  const build = rfReceipt({ attempt_id: BUILD, requested_worker: "codex-builder", stage: "COMPLETED", verdict_stage: "BUILD_READY", minute: 47, result_sha: HEAD });
  const review = rfFold(rfReceipt({ attempt_id: REVIEW, requested_worker: "claude-verifier", stage: "RUNNING", minute: 48 }), rfBlocked());
  assert.equal(review.stage, "HOLD");
  assert.deepEqual(review.review_findings, { verdict_stage: "BLOCKED", target_sha: HEAD, summary: SUMMARY, links: LINKS });

  // Receipts travel as JSON comments; the findings must survive that round trip.
  const lineage = JSON.parse(JSON.stringify([build, review]));
  const verdict = episodeVerdict({ receipts: lineage, targetIssueId: ISSUE, config: CONFIG });
  assert.equal(verdict.successor?.role, "revise", verdict.reason);
  assert.deepEqual(verdict.successor.review_findings, review.review_findings);

  const { successor } = verdict;
  const reserved = createReceipt({
    receipt_version: "1.1.0", role: successor.role, runtime: successor.runtime,
    issue_id: ISSUE, authorization_ref: CONTRACT, requested_worker: successor.requested_worker,
    repo: "BAWES-Universe/studenthub-platform", branch: `coordinator/${ISSUE}`, target_sha: successor.target_sha,
    workspace_scope: successor.workspace_scope, scope_phase: successor.scope_phase,
    allowed_paths: successor.allowed_paths, scoped_base_sha: "d41a275b365534c8c173c529d36c4bc25b9a3070",
    attempt_id: successor.attempt_id, review_findings: successor.review_findings,
  });
  assert.equal(reserved.ok, true, reserved.errors?.join("; "));
  assert.deepEqual(reserved.receipt.review_findings, review.review_findings);

  const order = supervisorOrder(reserved.receipt);
  assert.match(order.task_context, new RegExp(`Review findings \\(the independent reviewer BLOCKED ${HEAD}; address them\\)`));
  assert.ok(order.task_context.includes(JSON.stringify(SUMMARY)), "the reviewer's own words reach the writer");
  assert.ok(order.task_context.includes(JSON.stringify(LINKS[1])), "the reviewer's citations reach the writer");
  assert.deepEqual(supervisorOrder(structuredClone(reserved.receipt)), order, "a resubmitted order is identical");
  assert.ok(buildCodexPrompt({ ...order, scope_phase: "revision" }).includes(order.task_context), "the codex prompt carries the findings as given");

  for (const escaped of ["\"", "\\", "\u0001", "\u00e9"]) {
    const largest = reviewFindingsFromCallback(rfBlocked({ summary: escaped.repeat(REVIEW_FINDINGS_SUMMARY_MAX),
      links: Array.from({ length: REVIEW_FINDINGS_LINKS_MAX }, () => escaped.repeat(REVIEW_FINDINGS_LINK_LENGTH_MAX)) }));
    assert.equal(validReviewFindings(largest), true);
    assert.ok(largest.summary, "the summary survives the budget");
    assert.doesNotThrow(() => signedSupervisorRequest(supervisorOrder({ ...reserved.receipt, review_findings: largest }), "s".repeat(32)),
      "the largest findings a reviewer can produce still fit the supervisor's work-order limit");
    assert.equal(validReviewFindings({ ...largest, links: [...largest.links, escaped.repeat(REVIEW_FINDINGS_LINK_LENGTH_MAX)] }), false);
  }
});

test("review findings: only a bound review BLOCK is kept, and only a revision at that head receives it", () => {
  const writer = rfFold(rfReceipt({ attempt_id: REVIEW, requested_worker: "codex-builder", stage: "RUNNING", minute: 48 }), rfBlocked());
  assert.equal(writer.verdict_stage, "BLOCKED");
  assert.equal(writer.review_findings, undefined, "a writer's own BLOCKED is not review findings");

  const foreign = rfFold(rfReceipt({ attempt_id: REVIEW, requested_worker: "claude-verifier", stage: "RUNNING", minute: 48 }), rfBlocked({ target_sha: "c".repeat(40) }));
  assert.equal(foreign.review_findings, undefined, "an unbound callback never becomes findings");

  const build = rfReceipt({ attempt_id: BUILD, requested_worker: "codex-builder", stage: "COMPLETED", verdict_stage: "BUILD_READY", minute: 47, result_sha: HEAD });
  const stale = rfReceipt({ attempt_id: REVIEW, requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED", minute: 48,
    review_findings: { verdict_stage: "BLOCKED", target_sha: "d".repeat(40), summary: SUMMARY, links: LINKS } });
  const verdict = episodeVerdict({ receipts: [build, stale], targetIssueId: ISSUE, config: CONFIG });
  assert.equal(verdict.successor?.role, "revise", verdict.reason);
  assert.equal(verdict.successor.review_findings, undefined, "findings about another head are not handed on");

  const buildOnly = episodeVerdict({ receipts: [build], targetIssueId: ISSUE, config: CONFIG });
  assert.equal(buildOnly.successor?.review_findings, undefined);

  const findings = { verdict_stage: "BLOCKED", target_sha: HEAD, summary: SUMMARY, links: LINKS };
  const review = createReceipt({ issue_id: ISSUE, authorization_ref: CONTRACT, requested_worker: "claude-verifier",
    repo: "BAWES-Universe/studenthub-platform", branch: `coordinator/${ISSUE}`, target_sha: HEAD, review_findings: findings });
  assert.equal(review.receipt.review_findings, undefined, "a review reservation never carries findings");
  assert.equal(reviewFindingsContext({ scope_phase: "review", review_findings: findings }), "");
  assert.equal(reviewFindingsContext({ scope_phase: "revision" }), "");
  assert.equal(reviewFindingsContext({ scope_phase: "revision", review_findings: { ...findings, links: "x" } }), "");
});

test("review findings: credential-shaped text is dropped and the summary is bounded", () => {
  const token = `ghp_${"a".repeat(36)}`;
  assert.equal(reviewFindingsFromCallback(rfBlocked({ stage: "PASS" })), null);
  assert.equal(reviewFindingsFromCallback(rfBlocked({ summary: `leaked ${token}` })).summary, null);
  assert.deepEqual(reviewFindingsFromCallback(rfBlocked({ links: [token, LINKS[1]] })).links, [LINKS[1]]);
  assert.equal(reviewFindingsFromCallback(rfBlocked({ summary: token, links: [token] })), null);
  for (const linear of [`lin_api_${"b".repeat(40)}`, `lin_oauth_${"c".repeat(64)}`]) {
    assert.equal(reviewFindingsFromCallback(rfBlocked({ summary: `quoted ${linear}` })).summary, null, "a Linear credential never reaches a Linear comment");
    assert.deepEqual(reviewFindingsFromCallback(rfBlocked({ links: [`notes/${linear}`, LINKS[1]] })).links, [LINKS[1]]);
  }
  const oversized = "a".repeat(REVIEW_FINDINGS_LINK_LENGTH_MAX + 1);
  assert.deepEqual(reviewFindingsFromCallback(rfBlocked({ links: [oversized, LINKS[1]] })).links, [LINKS[1]]);
  assert.equal(validReviewFindings({ ...reviewFindingsFromCallback(rfBlocked()), links: [oversized] }), false);
  const long = reviewFindingsFromCallback(rfBlocked({ summary: "x".repeat(REVIEW_FINDINGS_SUMMARY_MAX + 50) }));
  assert.equal(long.summary.length, REVIEW_FINDINGS_SUMMARY_MAX);
  assert.equal(validReviewFindings(long), true);
  assert.equal(validReviewFindings({ ...long, summary: "x".repeat(REVIEW_FINDINGS_SUMMARY_MAX + 1) }), false);
});
