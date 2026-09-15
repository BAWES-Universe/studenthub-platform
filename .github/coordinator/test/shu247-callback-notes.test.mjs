import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callbackBindingValid,
  callbackEvidenceValid,
  nextReceiptState,
} from "../reconcile.mjs";

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
