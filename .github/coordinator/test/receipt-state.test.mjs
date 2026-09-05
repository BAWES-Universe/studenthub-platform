// Receipt state machine tests — every transition + the invariants from the
// design: reserve-before-launch, timeout-no-release, LAUNCH_UNKNOWN retry reuses
// the Idempotency-Key, completed-without-callback -> HOLD, quota pauses the
// adapter (and the next slot skips it), conflicting manual claim -> HOLD,
// stale-SHA verdicts rejected, target_sha bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReceipt,
  nextReceiptState,
  validateReceipt,
  selectNextReservation,
  idempotencyKey,
  launchIdempotencyKey,
  callbackEvidenceValid,
  authorizationRefValid,
} from "../reconcile.mjs";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function reserve(overrides = {}) {
  const { ok, receipt, errors } = createReceipt({
    issue_id: "SHU-42",
    authorization_ref: "SHU-42",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "chore/coordinator-dry-run",
    target_sha: SHA,
    attempt_id: "11111111-2222-4333-8444-555555555555",
    ...overrides,
  });
  assert.ok(ok, `reservation must succeed: ${errors?.join("; ")}`);
  return receipt;
}

function stageOf(receipt) {
  return receipt.stage;
}

function launch(receipt) {
  const r = nextReceiptState(receipt, { type: "launch" });
  assert.equal(r.accepted, true);
  return r;
}

test("RESERVED receipt is persisted with no run identity and validates", () => {
  const receipt = reserve();
  assert.equal(receipt.stage, "RESERVED");
  assert.equal(receipt.external_run_id, null);
  assert.equal(receipt.worker_identity, null);
  assert.equal(receipt.adapter_status, null);
  assert.equal(receipt.timestamps.launch, null);
  assert.equal(validateReceipt(receipt).valid, true);
});

test("invariant: launch cannot happen before a RESERVED receipt exists", () => {
  const r = nextReceiptState(null, { type: "launch" });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /requires an existing receipt/);
});

test("invariant: worker ack from RESERVED is out of order (reserve precedes launch)", () => {
  const r = nextReceiptState(reserve(), {
    type: "worker_ack",
    external_run_id: "apirun_abc123",
    adapter_status: "queued",
  });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /out of order from stage RESERVED/);
});

test("reserve -> launch -> LAUNCH_UNKNOWN holds the slot", () => {
  const r = launch(reserve());
  assert.equal(stageOf(r.receipt), "LAUNCH_UNKNOWN");
  assert.equal(r.receipt.external_run_id, null); // no run id until ack
  assert.ok(r.receipt.timestamps.launch);
  assert.equal(r.accepted, true);
});

test("worker ack -> RUNNING stores external_run_id IMMEDIATELY and retains granular adapter_status", () => {
  const r = launch(reserve());
  const ack = nextReceiptState(r.receipt, {
    type: "worker_ack",
    external_run_id: "apirun_run_12345",
    adapter_status: "queued", // granular upstream status preserved, not collapsed
    worker_identity: "wa-session-99",
  });
  assert.equal(ack.accepted, true);
  assert.equal(stageOf(ack.receipt), "RUNNING");
  assert.equal(ack.receipt.external_run_id, "apirun_run_12345");
  assert.equal(ack.receipt.adapter_status, "queued");
  assert.equal(ack.receipt.worker_identity, "wa-session-99");
  assert.equal(validateReceipt(ack.receipt).valid, true);
});

test("run_status queued/in_progress/suspended keeps RUNNING and updates adapter_status", () => {
  let receipt = launch(reserve()).receipt;
  receipt = nextReceiptState(receipt, { type: "worker_ack", external_run_id: "apirun_1", adapter_status: "queued" }).receipt;
  for (const status of ["queued", "in_progress", "suspended"]) {
    const r = nextReceiptState(receipt, { type: "run_status", status });
    assert.equal(stageOf(r.receipt), "RUNNING");
    assert.equal(r.receipt.adapter_status, status);
    receipt = r.receipt;
  }
});

test("run completed WITH validated callback -> COMPLETED with evidence links", () => {
  const started = launch(reserve()).receipt;
  const acked = nextReceiptState(started, { type: "worker_ack", external_run_id: "apirun_2", adapter_status: "in_progress" }).receipt;
  const callback = {
    links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/77"],
    attempt_id: acked.attempt_id,
    target_sha: SHA,
    stage: "BUILD_READY",
  };
  const r = nextReceiptState(acked, { type: "run_status", status: "completed", callback });
  assert.equal(r.accepted, true);
  assert.equal(stageOf(r.receipt), "COMPLETED");
  assert.equal(r.receipt.adapter_status, "completed");
  assert.equal(r.receipt.evidence_links.length, 1);
  assert.ok(r.receipt.timestamps.terminal);
  assert.equal(validateReceipt(r.receipt).valid, true);
});

test("completed WITHOUT validated callback -> HOLD (never auto-COMPLETED)", () => {
  const started = launch(reserve()).receipt;
  const acked = nextReceiptState(started, { type: "worker_ack", external_run_id: "apirun_3", adapter_status: "in_progress" }).receipt;
  const r = nextReceiptState(acked, { type: "run_status", status: "completed", callback: null });
  assert.equal(r.accepted, true);
  assert.equal(stageOf(r.receipt), "HOLD");
  assert.match(r.receipt.notes.at(-1), /WITHOUT validated callback/);
});

test("invariant: stale-SHA verdict is rejected — old PASS never satisfies a changed head", () => {
  const started = launch(reserve()).receipt; // bound to SHA
  const acked = nextReceiptState(started, { type: "worker_ack", external_run_id: "apirun_4", adapter_status: "in_progress" }).receipt;
  // (a) verdict names a different target_sha than the receipt is bound to:
  const stale = nextReceiptState(acked, {
    type: "run_status",
    status: "completed",
    callback: { links: ["https://github.com/x/pull/1"], attempt_id: acked.attempt_id, target_sha: SHA2 },
  });
  assert.notEqual(stageOf(stale.receipt), "COMPLETED");
  assert.equal(stageOf(stale.receipt), "HOLD");
  // (b) the live head has moved past the bound sha (ctx.current_head):
  const movedHead = nextReceiptState(acked, {
    type: "run_status",
    status: "completed",
    callback: { links: ["https://github.com/x/pull/1"], attempt_id: acked.attempt_id, target_sha: SHA },
  }, { current_head: SHA2 });
  assert.notEqual(stageOf(movedHead.receipt), "COMPLETED");
  // (c) callbackEvidenceValid alone is false for both mismatches
  assert.equal(callbackEvidenceValid(acked, { links: ["x"], attempt_id: acked.attempt_id, target_sha: SHA2 }), false);
  assert.equal(callbackEvidenceValid(acked, { links: ["x"], attempt_id: acked.attempt_id, target_sha: SHA }, { current_head: SHA2 }), false);
  assert.equal(callbackEvidenceValid(acked, { links: ["x"], attempt_id: "different-attempt", target_sha: SHA }), false);
  assert.equal(callbackEvidenceValid(acked, { links: [], attempt_id: acked.attempt_id, target_sha: SHA }), false);
  assert.equal(callbackEvidenceValid(acked, { links: ["x"], attempt_id: acked.attempt_id, target_sha: SHA }), false, "missing stage must fail closed");
});

test("invariant: timeout alone NEVER changes state and NEVER releases the slot", () => {
  const receipt = launch(reserve()).receipt; // LAUNCH_UNKNOWN, slot held
  const r = nextReceiptState(receipt, { type: "timeout", after_ms: 900000 });
  assert.equal(r.accepted, true); // observed
  assert.equal(stageOf(r.receipt), "LAUNCH_UNKNOWN"); // state unchanged
  assert.equal(r.receipt.external_run_id, null); // no phantom run
  const running = nextReceiptState(receipt, { type: "worker_ack", external_run_id: "apirun_5", adapter_status: "in_progress" }).receipt;
  const t2 = nextReceiptState(running, { type: "timeout", after_ms: 3600000 });
  assert.equal(stageOf(t2.receipt), "RUNNING"); // still held through a timeout
});

test("invariant: LAUNCH_UNKNOWN retry reuses the SAME Idempotency-Key (attempt_id immutable)", () => {
  const first = launch(reserve());
  assert.equal(first.idempotency_key, launchIdempotencyKey(first.receipt));
  const key1 = first.idempotency_key;
  // Retry while LAUNCH_UNKNOWN:
  const retry = nextReceiptState(first.receipt, { type: "launch" });
  assert.equal(retry.accepted, true);
  assert.equal(retry.receipt.attempt_id, first.receipt.attempt_id, "attempt_id must never be re-minted");
  assert.equal(retry.idempotency_key, key1, "retry must reuse the identical Idempotency-Key string");
  // idempotencyKey of the RESERVED receipt would differ — that is WHY the launch
  // key embeds LAUNCH_UNKNOWN, never the pre-launch stage:
  assert.notEqual(idempotencyKey(reserve()), key1);
  assert.match(key1, /^[0-9a-f-]{36}:LAUNCH_UNKNOWN:[0-9a-f]{40}$/);
});

test("failure -> FAILED with error code in notes; quota/access failure pauses the adapter", () => {
  let receipt = launch(reserve()).receipt;
  receipt = nextReceiptState(receipt, { type: "worker_ack", external_run_id: "apirun_6", adapter_status: "in_progress" }).receipt;
  const hard = nextReceiptState(receipt, { type: "run_status", status: "failed", error_code: "EXEC_TIMEOUT" });
  assert.equal(stageOf(hard.receipt), "FAILED");
  assert.equal(hard.receipt.adapter_status, "failed");
  assert.ok(hard.receipt.timestamps.terminal);
  assert.match(hard.receipt.notes.join(" "), /EXEC_TIMEOUT/);
  assert.notEqual(hard.pause_adapter, true);

  // quota (429) / access (403) failures set pause_adapter so orchestration pauses
  // the adapter — the next slot must NOT auto-launch a doomed attempt.
  const quota = launch(reserve()).receipt;
  for (const kind of ["quota", "access"]) {
    const failed = nextReceiptState(quota, { type: "run_status", status: "failed", error_kind: kind, error_code: "HTTP_429" });
    assert.equal(stageOf(failed.receipt), "FAILED");
    assert.equal(failed.pause_adapter, true, `${kind} failure must pause the adapter`);
  }
});

test("pre-acceptance quota failure (trigger refused before any run) -> FAILED with no phantom run id", () => {
  // The adapter trigger itself was refused (429 wall) — no apirun_ ever existed.
  const r = nextReceiptState(reserve(), { type: "run_status", status: "failed", error_kind: "quota", error_code: "HTTP_429" });
  assert.equal(r.accepted, true);
  assert.equal(stageOf(r.receipt), "FAILED");
  assert.equal(r.receipt.external_run_id, null, "no run id may be invented for a refused trigger");
  assert.equal(r.receipt.worker_identity, null);
  assert.equal(r.receipt.adapter_status, null);
  assert.equal(r.pause_adapter, true);
  assert.ok(r.receipt.timestamps.terminal);
  assert.match(r.receipt.notes.at(-1), /rejected before run acceptance/);
  assert.equal(validateReceipt(r.receipt).valid, true, "pre-acceptance FAILED must validate");
});

test("pause invariant: next reservation for the SAME paused adapter is skipped", () => {
  const eligible = [
    { id: "SHU-60", priority: "High", state: "Todo", title: "a", requested_worker: "codex-builder" },
    { id: "SHU-61", priority: "High", state: "Todo", title: "b", requested_worker: "codex-builder" },
  ];
  // unpaused config -> first eligible card reserved
  const clean = selectNextReservation({ ready: eligible, config: { max_dispatch: 1, adapter_pause_map: {} }, receipts: [] });
  assert.equal(clean.candidate.id, "SHU-60");
  // adapter paused (e.g. after a 429) -> no candidate, and the skip reason says why
  const paused = selectNextReservation({
    ready: eligible,
    config: { max_dispatch: 1, adapter_pause_map: { "workspace-agents": true } },
    receipts: [],
  });
  assert.equal(paused.candidate, null);
  assert.equal(paused.skipped.length, 2);
  assert.match(paused.skipped[0].reason, /paused/);
  // Active-receipt blocking under max_dispatch is covered by its own test below;
  // this test is strictly about the adapter pause map.
});

test("max_dispatch=1: an active receipt blocks further reservations", () => {
  const eligible = [
    { id: "SHU-70", priority: "High", state: "Todo", title: "a", requested_worker: "codex-builder" },
    { id: "SHU-71", priority: "High", state: "Todo", title: "b", requested_worker: "codex-builder" },
  ];
  const active = [
    { issue_id: "SHU-70", stage: "RUNNING" },
  ];
  const r = selectNextReservation({ ready: eligible, config: { max_dispatch: 1, adapter_pause_map: {} }, receipts: active });
  assert.equal(r.candidate, null);
  assert.match(r.skipped[0].reason, /max_dispatch=1/);
  // a TERMINAL receipt does not occupy the slot, but the COMPLETED issue itself
  // is parked (human/next-step decides) — the NEXT eligible card is selected.
  const terminal = selectNextReservation({
    ready: eligible,
    config: { max_dispatch: 1, adapter_pause_map: {} },
    receipts: [{ issue_id: "SHU-70", stage: "COMPLETED" }],
  });
  assert.equal(terminal.candidate.id, "SHU-71");
  assert.match(terminal.skipped[0].reason, /parked/);
});

test("conflicting manual claim -> HOLD", () => {
  for (const from of ["LAUNCH_UNKNOWN", "RUNNING"]) {
    let receipt = launch(reserve()).receipt;
    if (from === "RUNNING") {
      receipt = nextReceiptState(receipt, { type: "worker_ack", external_run_id: "apirun_8", adapter_status: "in_progress" }).receipt;
    }
    const r = nextReceiptState(receipt, { type: "manual_claim", actor: "human-operator", detail: "I own this work now" });
    assert.equal(r.accepted, true);
    assert.equal(stageOf(r.receipt), "HOLD");
    assert.match(r.receipt.notes.at(-1), /conflicting manual claim by human-operator/);
  }
});

test("manual_claim cannot disturb a validated COMPLETED or a FAILED receipt", () => {
  const started = launch(reserve()).receipt;
  const acked = nextReceiptState(started, { type: "worker_ack", external_run_id: "apirun_9", adapter_status: "in_progress" }).receipt;
  const done = nextReceiptState(acked, {
    type: "run_status",
    status: "completed",
    callback: { links: ["https://github.com/x/pull/2"], attempt_id: acked.attempt_id, target_sha: SHA, stage: "BUILD_READY" },
  }).receipt;
  const claim = nextReceiptState(done, { type: "manual_claim", actor: "human-operator" });
  assert.equal(claim.accepted, false);
  assert.equal(stageOf(claim.receipt), "COMPLETED");
});

test("terminal stages accept no further events (no state churn after COMPLETED/FAILED/HOLD)", () => {
  const started = launch(reserve()).receipt;
  const acked = nextReceiptState(started, { type: "worker_ack", external_run_id: "apirun_10", adapter_status: "in_progress" }).receipt;
  const held = nextReceiptState(acked, { type: "run_status", status: "completed", callback: null }).receipt;
  assert.equal(stageOf(held), "HOLD");
  for (const ev of [
    { type: "launch" },
    { type: "worker_ack", external_run_id: "apirun_11", adapter_status: "in_progress" },
    { type: "run_status", status: "failed" },
    { type: "timeout" },
  ]) {
    const r = nextReceiptState(held, ev);
    assert.equal(r.accepted, false);
    assert.equal(stageOf(r.receipt), "HOLD");
  }
});

test("explicit hold event (missing evidence) -> HOLD from RUNNING", () => {
  const acked = nextReceiptState(launch(reserve()).receipt, { type: "worker_ack", external_run_id: "apirun_12", adapter_status: "in_progress" }).receipt;
  const r = nextReceiptState(acked, { type: "hold", reason: "verifier evidence missing" });
  assert.equal(stageOf(r.receipt), "HOLD");
  assert.match(r.receipt.notes.at(-1), /verifier evidence missing/);
});

test("idempotent duplicate worker_ack keeps a single run identity", () => {
  let receipt = launch(reserve()).receipt;
  const ack1 = nextReceiptState(receipt, { type: "worker_ack", external_run_id: "apirun_dup", adapter_status: "queued" }).receipt;
  const ack2 = nextReceiptState(ack1, { type: "worker_ack", external_run_id: "apirun_dup", adapter_status: "in_progress" }).receipt;
  assert.equal(ack2.external_run_id, "apirun_dup");
  assert.equal(ack2.adapter_status, "in_progress");
});

test("authorizationRefValid accepts contract refs only (free text rejected)", () => {
  assert.equal(authorizationRefValid("SHU-123"), true);
  assert.equal(authorizationRefValid("SHU-0"), true);
  assert.equal(authorizationRefValid("FIXTURE-AUTHZ-001"), true);
  assert.equal(authorizationRefValid("FIXTURE-001"), true);
  assert.equal(authorizationRefValid("please dispatch this card"), false);
  assert.equal(authorizationRefValid("SHU-FIXTURE-001"), false); // not a Linear ref; fixture lane awaits its contract
  assert.equal(authorizationRefValid(""), false);
  assert.equal(authorizationRefValid(null), false);
});
