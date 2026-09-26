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

test("LAUNCH_UNKNOWN can durably bind a discovered local session without becoming pollable RUNNING", () => {
  const launched = launch(reserve()).receipt;
  const discovered = nextReceiptState(launched, {
    type: "run_discovered",
    external_run_id: "codexrun_0199a213-81c0-7800-8aa1-bbab2a035a53",
    worker_identity: `codex:${launched.attempt_id}`,
  });
  assert.equal(discovered.accepted, true);
  assert.equal(discovered.receipt.stage, "LAUNCH_UNKNOWN");
  assert.equal(discovered.receipt.adapter_status, "in_progress");
  assert.equal(validateReceipt(discovered.receipt).valid, true, validateReceipt(discovered.receipt).errors?.join("; "));
  const conflicting = nextReceiptState(discovered.receipt, {
    type: "run_discovered",
    external_run_id: "codexrun_1199a213-81c0-7800-8aa1-bbab2a035a53",
    worker_identity: `codex:${launched.attempt_id}`,
  });
  assert.equal(conflicting.accepted, false, "a second session can never replace the durable identity");
});

test("run_discovered is accepted only from LAUNCH_UNKNOWN and requires both identities", () => {
  const reserved = reserve();
  const validEvent = {
    type: "run_discovered",
    external_run_id: "codexrun_0199a213-81c0-7800-8aa1-bbab2a035a53",
    worker_identity: `codex:${reserved.attempt_id}`,
  };
  const wrongStage = nextReceiptState(reserved, validEvent);
  assert.equal(wrongStage.accepted, false);
  assert.match(wrongStage.reason, /requires LAUNCH_UNKNOWN/);

  const launched = launch(reserved).receipt;
  for (const event of [
    { ...validEvent, external_run_id: "" },
    { ...validEvent, worker_identity: "" },
    { ...validEvent, external_run_id: null },
    { ...validEvent, worker_identity: null },
  ]) {
    const missing = nextReceiptState(launched, event);
    assert.equal(missing.accepted, false);
    assert.match(missing.reason, /requires provider run and worker identities/);
    assert.equal(missing.receipt.stage, "LAUNCH_UNKNOWN");
    assert.equal(missing.receipt.external_run_id, null);
  }
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
    config: { max_dispatch: 1, adapter_pause_map: { "codex-cli": true } }, // SHU-63: builder lane adapter is codex-cli
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

// ---------------------------------------------------------------------------
// SHU-140 — reconciliation-only recovery of a dangling LAUNCH_UNKNOWN.
//
// A chain stuck at LAUNCH_UNKNOWN is active forever (TERMINAL_STAGES excludes
// it) and so holds the single max_dispatch slot forever, and a dispatch-off tick
// is read-only and cannot repair it. reconcile-dangling.mjs is the separate,
// explicit operator operation that terminalizes exactly one such attempt, and
// ONLY when every condition below is independently established at run time.
//
// The DECISION proofs inject every probe. The PROBE proofs below them run the
// shipped default probes for real, against a real directory tree and a real
// (synthetic) /proc built with node core fs — because a suite that only pins the
// decision logic cannot see a probe that reports "I found nothing" when it never
// looked, which is exactly how a fail-open reaches production. No real git, no
// real /proc, no socket and no network are used, so this file's audited
// capability set stays [].
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { TERMINAL_STAGES } from "../reconcile.mjs";
import {
  RECONCILE_REFUSAL_CODES,
  defaultPushReceipt,
  defaultSupervisorStore,
  WORKER_DISPOSITIONS,
  classifyWorkerSighting,
  defaultWorkerLiveness,
  defaultWorkerProcesses,
  defaultWorktree,
  describeWorkerSighting,
  main as reconcileMain,
  parseReconcileArgs,
  probeFreshness,
  processStartToken,
  readProcessIdentity,
  reconcileDanglingAttempt,
  resolveChain,
  sendSupervisorStatus,
  supervisorDisownsAttempt,
  terminalizeReceipt,
  workerVerdict,
} from "../reconcile-dangling.mjs";

const DANGLING = "7f3a1c20-9b44-4d17-8c02-6e5a1d4b9f83";
const BASE_SHA = "c".repeat(40);
const NOW = "2026-09-25T12:00:00.000Z";
const BEFORE = "2026-09-25T11:00:00.000Z";

// The real shape: several comment records of ONE attempt_id — a RESERVED one and
// two LAUNCH_UNKNOWN ones — of which the newest is what the tick resolves.
function danglingChain() {
  const reserved = reserve({
    attempt_id: DANGLING,
    issue_id: "SHU-140",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    branch: "coordinator/shu-140",
    workspace_scope: "scoped",
    allowed_paths: ["tools/fixture/scan-vacuous.mjs"],
    scoped_base_sha: BASE_SHA,
  });
  const first = { ...nextReceiptState(reserved, { type: "launch", at: "2026-09-20T01:00:00.000Z" }).receipt, last_activity: "2026-09-20T01:00:00.000Z" };
  const second = { ...nextReceiptState(first, { type: "launch", at: "2026-09-20T02:00:00.000Z" }).receipt, last_activity: "2026-09-20T02:00:00.000Z" };
  return [{ ...reserved, last_activity: "2026-09-20T00:00:00.000Z" }, first, second];
}

// A world in which every condition genuinely holds. Each test degrades exactly
// one probe, so a refusal can only come from the guard that test names.
function cleanWorld(overrides = {}) {
  const posted = [];
  const supervisorRequests = [];
  const io = {
    config: {},
    linearIssueId: "linear-issue-shu-140",
    receiptsOnDisk: danglingChain(),
    posted,
    supervisorRequests,
    readReceipts: async () => ({ observed_at: NOW, receipts: io.receiptsOnDisk, linearIdByAttempt: new Map([[DANGLING, "linear-issue-shu-140"]]) }),
    supervisorStatus: async ({ receipt }) => {
      supervisorRequests.push({ operation: "status", attempt_id: receipt.attempt_id });
      return { observed_at: NOW, response: { ok: false, stage: "HOLD", hold_code: "MISSING_CLAIM", reason: "supervisor attempt unavailable" } };
    },
    workerProcesses: async () => ({ observed_at: NOW, pids: [], sightings: [] }),
    workerLiveness: async () => ({ observed_at: NOW, observations: [] }),
    worktree: async () => ({ observed_at: NOW, root_configured: true, present: true, head: BASE_SHA, porcelain: "" }),
    branchHead: async () => ({ observed_at: NOW, ok: true, sha: SHA }),
    pushReceipt: async () => ({ observed_at: NOW, readable: true, record: null }),
    supervisorStore: async () => ({ observed_at: NOW, readable: true, records: [] }),
    postReceipt: async ({ receipt, linearIssueId }) => {
      posted.push({ receipt, linearIssueId });
      // Durable state really does change: the newest record for the attempt is
      // now the terminal one, exactly as a second read of the thread would see.
      io.receiptsOnDisk = [...io.receiptsOnDisk, { ...receipt, last_activity: receipt.last_activity ?? NOW }];
    },
    ...overrides,
  };
  return io;
}

// A match-time sighting in the shape defaultWorkerProcesses() produces: the pid,
// where the pid came from, and the kernel identity captured at that instant.
function sighting(overrides = {}) {
  return {
    pid: 4242,
    source: "supervisor_record",
    also_seen_by: [],
    source_path: `/srv/shu/state/supervisor/launches/${DANGLING}.json`,
    source_paths: [`/srv/shu/state/supervisor/launches/${DANGLING}.json`],
    recorded_token: null,
    recorded_tokens: [null],
    observed_token: "900900",
    observed_uid: 1000,
    record_token_match: null,
    ...overrides,
  };
}

const activeSlots = (receipts) => receipts.filter((r) => !TERMINAL_STAGES.includes(r.stage))
  .reduce((ids, r) => ids.add(r.attempt_id), new Set()).size;

const run = (io) => reconcileDanglingAttempt({ attempt_id: DANGLING, env: {}, io, now: () => NOW });

test("SHU-140 reconcile-dangling: a dangling LAUNCH_UNKNOWN with a signed MISSING_CLAIM and clean evidence is terminalized to HOLD and frees the slot", async () => {
  const io = cleanWorld();
  assert.equal(resolveChain(io.receiptsOnDisk, DANGLING).stage, "LAUNCH_UNKNOWN");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the dangling chain holds the one slot before recovery");

  const result = await run(io);

  assert.equal(result.ok, true, `expected terminalization, got ${result.refusal ?? "?"} (${result.detail ?? ""})`);
  assert.equal(result.action, "TERMINALIZED");
  assert.equal(result.stage, "HOLD");
  assert.ok(TERMINAL_STAGES.includes(result.receipt.stage), "the written stage must be terminal");
  assert.equal(result.receipt.attempt_id, DANGLING, "terminalization is bound to the requested attempt");
  assert.ok(result.receipt.timestamps.terminal, "a terminal receipt must carry a terminal timestamp");
  assert.match(result.receipt.notes.at(-1), /reconciled dangling LAUNCH_UNKNOWN/);

  // The write happened exactly once, on the attempt's own issue.
  assert.equal(io.posted.length, 1);
  assert.equal(io.posted[0].linearIssueId, "linear-issue-shu-140");
  // The slot is free: the newest record for the attempt is terminal.
  assert.equal(resolveChain(io.receiptsOnDisk, DANGLING).stage, "HOLD");
  assert.equal(activeSlots([resolveChain(io.receiptsOnDisk, DANGLING)]), 0, "the slot must be released");
  // Only the supervisor's `status` operation was ever used.
  assert.deepEqual(io.supervisorRequests, [{ operation: "status", attempt_id: DANGLING }]);

  // ...and the signing path itself can sign nothing else. submit() would run
  // store.accept() and schedule(launch); status returns before both.
  const sent = [];
  const signed = await sendSupervisorStatus({
    receipt: resolveChain(danglingChain(), DANGLING),
    env: { SHU_SUPERVISOR_SECRET: "s".repeat(64), SHU_SUPERVISOR_SOCKET: "/nonexistent.sock" },
    transport: async ({ request }) => { sent.push(request); return { ok: false, stage: "HOLD", hold_code: "MISSING_CLAIM" }; },
  });
  assert.equal(signed.hold_code, "MISSING_CLAIM");
  assert.deepEqual(sent.map((r) => r.operation), ["status"]);
  await assert.rejects(
    async () => sendSupervisorStatus({ receipt: resolveChain(danglingChain(), DANGLING), env: { SHU_SUPERVISOR_SECRET: "s".repeat(64) }, transport: async () => ({}), operation: "submit" }),
    /may only send the supervisor `status` operation/,
  );
});

test("SHU-140 reconcile-dangling: a supervisor claim refuses SUPERVISOR_CLAIM_PRESENT and preserves the slot", async () => {
  // Three independent ways the supervisor can still own this attempt. None of
  // them is a generic failure and none of them may release the slot.
  const claims = [
    ["an accepted/running answer", { supervisorStatus: async () => ({ observed_at: NOW, response: { ok: true, stage: "RUNNING", durable: true } }) }],
    ["a different hold code", { supervisorStatus: async () => ({ observed_at: NOW, response: { ok: false, stage: "HOLD", hold_code: "AWAITING_LAUNCH" } }) }],
    ["a durable store record", { supervisorStore: async () => ({ observed_at: NOW, readable: true, records: ["orders"] }) }],
  ];
  for (const [label, overrides] of claims) {
    const io = cleanWorld(overrides);
    const result = await run(io);
    assert.equal(result.ok, false, `${label} must refuse`);
    assert.equal(result.code, "SUPERVISOR_CLAIM_PRESENT", `${label}: ${result.code}`);
    assert.equal(result.refusal, "RECONCILE_REFUSED: SUPERVISOR_CLAIM_PRESENT");
    assert.equal(io.posted.length, 0, `${label}: nothing may be written`);
    assert.equal(activeSlots(io.receiptsOnDisk), 1, `${label}: the slot must be preserved`);
  }
  // Only MISSING_CLAIM establishes the absence — the unit answers on its own.
  assert.equal(supervisorDisownsAttempt({ ok: false, hold_code: "MISSING_CLAIM" }), null);
  assert.equal(supervisorDisownsAttempt({ ok: false, hold_code: "BRANCH_OCCUPIED" }).code, "SUPERVISOR_CLAIM_PRESENT");
  assert.equal(supervisorDisownsAttempt({ ok: true, stage: "ACCEPTED" }).code, "SUPERVISOR_CLAIM_PRESENT");
});

test("SHU-140 reconcile-dangling: a live worker process refuses WORKER_LIVE", async () => {
  const io = cleanWorld({
    workerProcesses: async () => ({ observed_at: NOW, pids: [4242], sightings: [sighting({ pid: 4242 })] }),
    // Re-checked: still there, still the SAME process. Only this is WORKER_LIVE.
    workerLiveness: async () => ({ observed_at: NOW, observations: [{ pid: 4242, exists: true, exists_known: true, start_token: "900900", uid: 1000 }] }),
  });
  const result = await run(io);
  assert.equal(result.code, "WORKER_LIVE");
  assert.equal(result.refusal, "RECONCILE_REFUSED: WORKER_LIVE");
  assert.match(result.detail, /4242/);
  assert.match(result.detail, /disposition=CONFIRMED_LIVE/);
  assert.equal(io.posted.length, 0, "a live worker must not be terminalized around");
  assert.equal(activeSlots(io.receiptsOnDisk), 1);
});

test("SHU-140 reconcile-dangling: a changed worktree, a moved branch or a push receipt each refuse by name", async () => {
  const cases = [
    ["WORKTREE_CHANGED", { worktree: async () => ({ observed_at: NOW, root_configured: true, present: true, head: "d".repeat(40), porcelain: "" }) }],
    ["WORKTREE_CHANGED", { worktree: async () => ({ observed_at: NOW, root_configured: true, present: true, head: BASE_SHA, porcelain: " M tools/fixture/scan-vacuous.mjs\n" }) }],
    ["BRANCH_MOVED", { branchHead: async () => ({ observed_at: NOW, ok: true, sha: "e".repeat(40) }) }],
    ["PUSH_RECEIPT_PRESENT", { pushReceipt: async () => ({ observed_at: NOW, readable: true, record: "/state/push-" + DANGLING + ".json" }) }],
  ];
  for (const [code, overrides] of cases) {
    const io = cleanWorld(overrides);
    const result = await run(io);
    assert.equal(result.ok, false);
    assert.equal(result.code, code, `expected ${code}, got ${result.code} (${result.detail})`);
    assert.equal(result.refusal, `RECONCILE_REFUSED: ${code}`);
    assert.equal(io.posted.length, 0, `${code}: an external effect may exist; nothing may be written`);
    assert.equal(activeSlots(io.receiptsOnDisk), 1, `${code}: the slot must be preserved`);
  }
});

test("SHU-140 reconcile-dangling: missing or stale evidence refuses EVIDENCE_MISSING or EVIDENCE_STALE", async () => {
  // MISSING: a probe that did not answer, a supervisor reply carrying no hold
  // code (a transport fault is not an absence of claim), an unreadable store,
  // an unanswered branch read, and a probe that threw.
  const missing = [
    ["no such attempt", { readReceipts: async () => ({ observed_at: NOW, receipts: [], linearIdByAttempt: new Map() }) }],
    ["transport fault, no hold code", { supervisorStatus: async () => ({ observed_at: NOW, response: { ok: false, stage: "HOLD", reason: "supervisor unavailable" } }) }],
    ["process table unreadable", { workerProcesses: async () => ({ observed_at: NOW, pids: null }) }],
    ["branch head unanswered", { branchHead: async () => ({ observed_at: NOW, ok: false, sha: null }) }],
    ["push receipts unreadable", { pushReceipt: async () => ({ observed_at: NOW, readable: false, record: null }) }],
    ["supervisor store unreadable", { supervisorStore: async () => ({ observed_at: NOW, readable: false, records: [] }) }],
    ["probe threw", { worktree: async () => { throw new Error("ENOENT"); } }],
    ["probe carried no observation time", { worktree: async () => ({ root_configured: true, present: true, head: BASE_SHA, porcelain: "" }) }],
  ];
  for (const [label, overrides] of missing) {
    const io = cleanWorld(overrides);
    const result = await run(io);
    assert.equal(result.code, "EVIDENCE_MISSING", `${label}: ${result.code} (${result.detail})`);
    assert.equal(result.refusal, "RECONCILE_REFUSED: EVIDENCE_MISSING");
    assert.equal(io.posted.length, 0, `${label}: nothing may be written`);
  }

  // STALE: an answer observed BEFORE this invocation is a cached snapshot. Each
  // probe is checked independently, so any one of them being carried over is
  // enough to refuse.
  for (const key of ["readReceipts", "supervisorStatus", "workerProcesses", "worktree", "branchHead", "pushReceipt", "supervisorStore"]) {
    const fresh = cleanWorld();
    const io = cleanWorld({ [key]: async (args) => ({ ...(await fresh[key](args)), observed_at: BEFORE }) });
    const result = await run(io);
    assert.equal(result.code, "EVIDENCE_STALE", `${key}: ${result.code} (${result.detail})`);
    assert.equal(result.refusal, "RECONCILE_REFUSED: EVIDENCE_STALE");
    assert.equal(io.posted.length, 0, `${key}: nothing may be written`);
    assert.equal(activeSlots(io.receiptsOnDisk), 1, `${key}: the slot must be preserved`);
  }

  // The freshness rule itself: an observation at or after the start is accepted,
  // one from before it is not, and an absent observation is missing.
  assert.equal(probeFreshness({ observed_at: NOW }, NOW), null);
  assert.equal(probeFreshness({ observed_at: BEFORE }, NOW).code, "EVIDENCE_STALE");
  assert.equal(probeFreshness({}, NOW).code, "EVIDENCE_MISSING");
  assert.equal(probeFreshness(null, NOW).code, "EVIDENCE_MISSING");
});

test("SHU-140 reconcile-dangling: a repeated invocation refuses ALREADY_TERMINAL, writes nothing and launches nothing", async () => {
  const io = cleanWorld();
  const first = await run(io);
  assert.equal(first.ok, true);
  assert.equal(io.posted.length, 1);
  const contactsAfterFirst = io.supervisorRequests.length;

  const second = await run(io);
  assert.equal(second.ok, false);
  assert.equal(second.code, "ALREADY_TERMINAL");
  assert.equal(second.refusal, "RECONCILE_REFUSED: ALREADY_TERMINAL");
  assert.equal(io.posted.length, 1, "a second run must write nothing");
  // Idempotence is decided from the durable chain BEFORE any supervisor contact,
  // so the second run cannot create a slot, a receipt or a launch.
  assert.equal(io.supervisorRequests.length, contactsAfterFirst, "a second run must not contact the supervisor at all");
  assert.equal(activeSlots([resolveChain(io.receiptsOnDisk, DANGLING)]), 0, "the slot stays released");

  const third = await run(io);
  assert.equal(third.code, "ALREADY_TERMINAL");
  assert.equal(io.posted.length, 1);

  // A live stage is refused by its own name, never terminalized as "dangling".
  const running = cleanWorld();
  running.receiptsOnDisk = [{ ...resolveChain(danglingChain(), DANGLING), stage: "RUNNING", external_run_id: "apirun_live", last_activity: "2026-09-21T00:00:00.000Z" }];
  const live = await run(running);
  assert.equal(live.code, "NOT_DANGLING");
  assert.equal(running.posted.length, 0);

  // No refusal is ever generic: every code this operation can emit is declared.
  for (const code of ["ALREADY_TERMINAL", "NOT_DANGLING", "SUPERVISOR_CLAIM_PRESENT", "WORKER_LIVE",
    "WORKER_STALE_RECORD", "WORKER_UNVERIFIED",
    "WORKTREE_CHANGED", "BRANCH_MOVED", "PUSH_RECEIPT_PRESENT", "EVIDENCE_MISSING", "EVIDENCE_STALE"]) {
    assert.ok(RECONCILE_REFUSAL_CODES.includes(code), `undeclared refusal code ${code}`);
  }
});

// ---------------------------------------------------------------------------
// SHU-140 — the DEFAULT PROBES themselves.
//
// Everything above injects its probes and therefore pins only the decision
// logic. These cases run the shipped probes, because the failures that matter
// are the ones where a probe answers "nothing found" without having looked:
// every condition this operation checks is an ABSENCE claim, so "I could not
// look" mistaken for "there is nothing there" is the single failure that
// releases the slot over live work.
// ---------------------------------------------------------------------------

function sandbox(t) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "shu140-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ONE clock, injected, for the invocation AND for the probes it runs. Freshness
// compares a probe's observation against the invocation's start, so those two
// instants must come from the same clock or the comparison measures clock skew
// instead of the age of the evidence. Reading the host's wall clock for either
// half makes the verdict depend on what time of day the suite runs: an earlier
// revision derived the start from `Date.now()` while these worlds stamped the
// fixed NOW, which passed only while real UTC happened to be before NOW and went
// EVIDENCE_STALE at 12:00 — and a year ahead, or a year behind, every time.
// Every assertion below therefore also pins observed_at to the injected instant,
// so a probe that goes back to reading the wall clock fails here rather than in
// whichever timezone or clock-shifted job runs next.
const clock = () => NOW;

// Every shipped-probe result below goes through this: it asserts the probe
// stamped the INJECTED instant rather than the host's wall clock. Without it the
// `now: clock` arguments would be decorative — a probe that quietly went back to
// `new Date()` would still satisfy every structural assertion, and would only
// resurface as EVIDENCE_STALE in a differently-clocked job.
const stamped = (probe) => {
  assert.equal(probe.observed_at, NOW, "a probe must stamp the injected clock, never the host wall clock");
  return probe;
};

// A supervisor state dir in the shape SupervisorStore's constructor makes.
function supervisorStateDir(t, records = {}) {
  const dir = sandbox(t);
  for (const kind of ["orders", "runs", "launches", "completions"]) {
    fs.mkdirSync(nodePath.join(dir, kind));
    if (records[kind]) fs.writeFileSync(nodePath.join(dir, kind, `${DANGLING}.json`), JSON.stringify(records[kind]));
  }
  return dir;
}

// A /proc in the shape the kernel presents: numeric directories with cmdline,
// environ, a cwd symlink and a stat line whose 22nd field is the start token.
function fakeProc(t, processes) {
  const dir = sandbox(t);
  for (const [pid, spec] of Object.entries(processes)) {
    const entry = nodePath.join(dir, String(pid));
    fs.mkdirSync(entry);
    fs.writeFileSync(nodePath.join(entry, "cmdline"), spec.cmdline ?? "");
    fs.writeFileSync(nodePath.join(entry, "environ"), spec.environ ?? "");
    // /proc/<pid>/stat is `pid (comm) state ...`, so the line below already
    // carries fields 1-3 and `fields` starts at field 4. starttime is field 22,
    // i.e. fields[18]. An earlier revision wrote it at fields[19] — field 23 —
    // which no production reader ever looks at, so every token comparison in
    // this file silently compared the same constant against itself. The
    // read-back assertion below is what makes that impossible to reintroduce:
    // the fixture must produce a stat line the SHIPPED reader agrees with.
    const fields = Array.from({ length: 30 }, (_, i) => String(i + 4));
    fields[18] = spec.start_token ?? "111111";
    fs.writeFileSync(nodePath.join(entry, "stat"), `${pid} (node) S ${fields.join(" ")}`);
    assert.equal(processStartToken(dir, pid), spec.start_token ?? "111111",
      "the /proc fixture must put the start token where the shipped reader looks for it");
    if (spec.cwd) fs.symlinkSync(spec.cwd, nodePath.join(entry, "cwd"));
  }
  fs.writeFileSync(nodePath.join(dir, "uptime"), "1 1"); // a non-numeric entry is ignored
  return dir;
}

test("SHU-140 reconcile-dangling probe: an unconfigured or unreadable worktree root is EVIDENCE_MISSING, never a measured-clean worktree", async (t) => {
  const measured = [];
  const gitImpl = (dir, args) => { measured.push([dir, args.join(" ")]); return args[0] === "rev-parse" ? `${"b".repeat(40)}` : "?? dirty.txt"; };
  const receipt = { attempt_id: DANGLING };

  // 1. The root is not configured. The worktree was NOT measured, and the probe
  //    must say so rather than reporting an absent worktree.
  const unset = stamped(defaultWorktree({ receipt, env: {}, gitImpl, now: clock }));
  assert.equal(unset.root_configured, false, "an unconfigured root must not claim to have been read");
  assert.deepEqual(measured, [], "nothing can be measured without a root");

  // 2. Root configured, attempt worktree present: HEAD and porcelain are read.
  const root = sandbox(t);
  fs.mkdirSync(nodePath.join(root, DANGLING));
  const present = stamped(defaultWorktree({ receipt, env: { SHU_WORKTREE_ROOT: root }, gitImpl, now: clock }));
  assert.equal(present.root_configured, true);
  assert.equal(present.present, true);
  assert.equal(present.head, "b".repeat(40));
  assert.equal(present.porcelain, "?? dirty.txt");

  // 3. Root configured, attempt worktree genuinely gone: absent, but MEASURED.
  const emptyRoot = sandbox(t);
  const absent = stamped(defaultWorktree({ receipt, env: { SHU_WORKTREE_ROOT: emptyRoot }, gitImpl, now: clock }));
  assert.equal(absent.root_configured, true);
  assert.equal(absent.present, false);

  // 4. Root configured but unlistable: the probe THROWS. It must never answer
  //    "absent", which existsSync() would have done for exactly this fault.
  const notADir = nodePath.join(sandbox(t), "root-is-a-file");
  fs.writeFileSync(notADir, "");
  assert.throws(() => defaultWorktree({ receipt, env: { SHU_WORKTREE_ROOT: notADir }, gitImpl, now: clock }),
    (error) => ["ENOTDIR", "ENOENT"].includes(error.code), "an unreadable root must throw, not report absence");

  // End to end, with the REAL probe: a worktree that has moved off its base AND
  // is dirty, and SHU_WORKTREE_ROOT simply not set. Fail-open here would write
  // the terminal HOLD having never looked at that worktree at all.
  const io = cleanWorld({ worktree: async (args) => stamped(defaultWorktree({ ...args, gitImpl })) });
  const blind = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: {}, io, now: clock });
  assert.equal(blind.ok, false, "an unmeasured worktree must not be terminalized around");
  assert.equal(blind.code, "EVIDENCE_MISSING", `got ${blind.code} (${blind.detail})`);
  assert.match(blind.detail, /SHU_WORKTREE_ROOT/);
  assert.equal(io.posted.length, 0, "nothing may be written");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot must be preserved");

  // ...and with the root configured, the same dirty, diverged worktree is seen
  // and refused BY NAME. Same world, one environment variable different.
  const seen = cleanWorld({ worktree: async (args) => stamped(defaultWorktree({ ...args, gitImpl })) });
  const looked = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: { SHU_WORKTREE_ROOT: root }, io: seen, now: clock });
  assert.equal(looked.code, "WORKTREE_CHANGED", `got ${looked.code} (${looked.detail})`);
  assert.equal(seen.posted.length, 0);
});

test("SHU-140 reconcile-dangling probe: an unreadable supervisor store reports readable:false, never an empty one", async (t) => {
  const receipt = { attempt_id: DANGLING };
  const order = { attempt_id: DANGLING, issue_id: "SHU-140" };

  // 1. A real durable order is found by listing orders/, not by existsSync.
  const held = stamped(defaultSupervisorStore({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: supervisorStateDir(t, { orders: order, runs: { status: "accepted" } }) }, now: clock }));
  assert.equal(held.readable, true);
  assert.deepEqual(held.records, ["orders", "runs"]);

  // 2. All four directories readable, no record for this attempt: a genuine,
  //    established absence.
  const empty = stamped(defaultSupervisorStore({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: supervisorStateDir(t) }, now: clock }));
  assert.equal(empty.readable, true);
  assert.deepEqual(empty.records, []);

  // 3. The reviewer's fault: the SAME durable order is still on disk, but the
  //    record directories cannot be listed. existsSync() answers false for this
  //    and would have reported an empty store over a live order.
  const broken = supervisorStateDir(t, { orders: order });
  fs.rmSync(nodePath.join(broken, "orders"), { recursive: true });
  fs.writeFileSync(nodePath.join(broken, "orders"), "not a directory");
  const unreadable = stamped(defaultSupervisorStore({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: broken }, now: clock }));
  assert.equal(unreadable.readable, false, "a store that could not be listed must not report readable");
  assert.deepEqual(unreadable.records, []);

  // 4. A state dir missing one of the four kinds is not a store we may draw an
  //    absence from either: SupervisorStore always creates all four.
  const partial = supervisorStateDir(t, { orders: order });
  fs.rmSync(nodePath.join(partial, "launches"), { recursive: true });
  assert.equal(stamped(defaultSupervisorStore({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: partial }, now: clock })).readable, false);

  // 5. Same fault by permission rather than by type, where the host allows it.
  if (process.getuid && process.getuid() !== 0) {
    const denied = supervisorStateDir(t, { orders: order });
    fs.chmodSync(nodePath.join(denied, "orders"), 0o000);
    const probed = stamped(defaultSupervisorStore({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: denied }, now: clock }));
    fs.chmodSync(nodePath.join(denied, "orders"), 0o700); // restore before the sandbox is removed
    assert.equal(probed.readable, false);
  }

  // 6. Unset is not "no records" either.
  assert.equal(stamped(defaultSupervisorStore({ receipt, env: {}, now: clock })).readable, false);

  // End to end, with the REAL probe and the supervisor's catch-all MISSING_CLAIM
  // answer: the status answer alone must NOT be enough. status() returns
  // MISSING_CLAIM from a catch-all that fires on any read fault, so the store
  // probe is the second opinion — and it is only a second opinion if it can
  // prove it actually read the store.
  const io = cleanWorld({ supervisorStore: async (args) => stamped(defaultSupervisorStore(args)) });
  const result = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: { SHU_SUPERVISOR_STATE_DIR: broken }, io, now: clock });
  assert.equal(result.ok, false, "the slot must not be released over an unreadable store");
  assert.equal(result.code, "EVIDENCE_MISSING", `got ${result.code} (${result.detail})`);
  assert.equal(io.posted.length, 0, "nothing may be written");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot must be preserved");

  // The order really is still on disk after the refusal: the supervisor still
  // owns the attempt and this operation left it alone.
  assert.ok(fs.readFileSync(nodePath.join(broken, "orders"), "utf8"));
});

test("SHU-140 reconcile-dangling probe: a supervisor-forked worker is detected despite empty argv and an attempt_id-free environment", async (t) => {
  const worktreeRoot = sandbox(t);
  const worktreeDir = nodePath.join(worktreeRoot, DANGLING);
  fs.mkdirSync(worktreeDir);
  const receipt = { attempt_id: DANGLING };

  // The real shape: supervisor-worker.mjs forks with EMPTY argv and
  // supervisorChildEnvironment() is a fixed allow-list of names, so neither
  // /proc/<pid>/cmdline nor /proc/<pid>/environ ever contains the attempt_id.
  const stealth = { cmdline: "/usr/bin/node /opt/coordinator/supervisor-worker.mjs ", environ: "PATH=/usr/bin HOME=/home/runner " };
  const proc = fakeProc(t, { 4242: { ...stealth, cwd: worktreeDir, start_token: "900900" }, 7: { cmdline: "/usr/bin/sshd ", environ: "PATH=/usr/bin " } });
  assert.ok(!fs.readFileSync(nodePath.join(proc, "4242", "cmdline"), "utf8").includes(DANGLING), "the fixture must not leak the attempt_id into argv");
  assert.ok(!fs.readFileSync(nodePath.join(proc, "4242", "environ"), "utf8").includes(DANGLING), "the fixture must not leak the attempt_id into the environment");

  // 1. The supervisor's own launches/ record is what binds the pid to the
  //    attempt. A scan that only greps argv and environ sees nothing at all.
  const launched = supervisorStateDir(t, { launches: { attempt_id: DANGLING, phase: "launched", pid: 4242 } });
  const byRecord = stamped(defaultWorkerProcesses({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: launched }, procRoot: proc, now: clock }));
  assert.deepEqual(byRecord.pids, [4242], "the supervisor's recorded, still-live worker pid must be seen");

  // 2. And where no record can be read, the worker is still visible by WHERE it
  //    is working: its cwd is the attempt's own worktree.
  const byCwd = stamped(defaultWorkerProcesses({ receipt, env: { SHU_WORKTREE_ROOT: worktreeRoot }, procRoot: proc, now: clock }));
  assert.deepEqual(byCwd.pids, [4242], "a process whose cwd is the attempt worktree is a live worker");

  // 3. A recorded pid that has died leaves nothing behind in /proc.
  const dead = fakeProc(t, { 7: { cmdline: "/usr/bin/sshd " } });
  assert.deepEqual(stamped(defaultWorkerProcesses({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: launched }, procRoot: dead, now: clock })).pids, []);

  // 4. ...and a pid that was RECYCLED by an unrelated process is not our worker:
  //    the kernel's process-start token no longer matches the recorded one.
  const recycled = supervisorStateDir(t, { runs: { attempt_id: DANGLING, status: "running", pid: 4242, process_token: "555" } });
  assert.deepEqual(stamped(defaultWorkerProcesses({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: recycled }, procRoot: proc, now: clock })).pids, [],
    "a mismatched process-start token means the pid was reused");

  // 5. The original argv/environ sighting still works for a worker that does
  //    carry the attempt_id.
  const loud = fakeProc(t, { 99: { cmdline: `/usr/bin/node --attempt ${DANGLING} ` } });
  assert.deepEqual(stamped(defaultWorkerProcesses({ receipt, env: {}, procRoot: loud, now: clock })).pids, [99]);

  // 6. Fail closed on both read faults: an unlistable /proc and an unlistable
  //    supervisor store are EVIDENCE_MISSING, never "no worker".
  const notADir = nodePath.join(sandbox(t), "proc-is-a-file");
  fs.writeFileSync(notADir, "");
  assert.throws(() => defaultWorkerProcesses({ receipt, env: {}, procRoot: notADir, now: clock }), (e) => ["ENOTDIR", "ENOENT"].includes(e.code));
  const brokenStore = supervisorStateDir(t, { launches: { pid: 4242 } });
  fs.rmSync(nodePath.join(brokenStore, "launches"), { recursive: true });
  fs.writeFileSync(nodePath.join(brokenStore, "launches"), "not a directory");
  assert.throws(() => defaultWorkerProcesses({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: brokenStore }, procRoot: proc, now: clock }),
    (e) => e.code === "ENOTDIR", "an unreadable launches/ must not read as 'no worker'");
  const absentDir = supervisorStateDir(t, { launches: { pid: 4242 } });
  fs.rmSync(nodePath.join(absentDir, "launches"), { recursive: true });
  assert.throws(() => defaultWorkerProcesses({ receipt, env: { SHU_SUPERVISOR_STATE_DIR: absentDir }, procRoot: proc, now: clock }),
    (e) => e.code === "ENOENT", "a MISSING record directory is a store we did not read, not an absent worker");

  // End to end, with the REAL probe: the live worker is refused BY NAME and the
  // slot is preserved.
  const io = cleanWorld({
    workerProcesses: async (args) => stamped(defaultWorkerProcesses({ ...args, procRoot: proc })),
    workerLiveness: async (args) => stamped(defaultWorkerLiveness({ ...args, procRoot: proc })),
  });
  const result = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: { SHU_SUPERVISOR_STATE_DIR: launched, SHU_WORKTREE_ROOT: worktreeRoot }, io, now: clock });
  assert.equal(result.code, "WORKER_LIVE", `got ${result.code} (${result.detail})`);
  assert.match(result.detail, /4242/);
  assert.match(result.detail, /disposition=CONFIRMED_LIVE/);
  assert.equal(io.posted.length, 0, "a live worker must not be terminalized around");
  assert.equal(activeSlots(io.receiptsOnDisk), 1);
});

// ---------------------------------------------------------------------------
// SHU-140 — WORKER IDENTITY: a sighting is not a live worker.
//
// The production failure this pins: the operation refused
// `RECONCILE_REFUSED: WORKER_LIVE -- live worker process(es) 2770495`, and
// within seconds pid 2770495 had no /proc entry, no cmdline, no cwd, no exe and
// was unknown to ps, with no trace of it anywhere in the journal. The refusal
// named a number and nothing else, so the operator could neither confirm nor
// disprove it after the fact.
//
// Two separate defects:
//   1. a pid SIGHTED at match time was reported as a CONFIRMED live worker
//      without ever being re-checked, so a process that exited — or a pid that
//      was handed to something else — still read as "live worker";
//   2. the refusal carried no evidence: no start token, no cmdline, no source
//      file, no named check, so nothing about it could be reconstructed later.
//
// Every case below therefore separates the two observations in time: what was
// sighted, and what is there at the verdict. `procRoot` is injected twice, so
// "the world changed between the sighting and the verdict" is expressible
// without any timing dependence at all — no sleeps, no wall clock, no races.
// ---------------------------------------------------------------------------

// A /proc entry whose stat is unreadable: the pid is THERE, but the kernel's
// process-start token cannot be taken, so its identity cannot be established.
function procWithoutStat(t, pid, spec = {}) {
  const dir = fakeProc(t, { [pid]: spec });
  fs.rmSync(nodePath.join(dir, String(pid), "stat"));
  return dir;
}

// The world reaches the worker checks with both observations injected: what the
// process table looked like at match time, and what it looks like at the verdict.
function workerWorld(t, { sightingProc, verdictProc, env = {}, overrides = {} } = {}) {
  const io = cleanWorld({
    workerProcesses: async (args) => stamped(defaultWorkerProcesses({ ...args, procRoot: sightingProc })),
    workerLiveness: async (args) => stamped(defaultWorkerLiveness({ ...args, procRoot: verdictProc ?? sightingProc })),
    ...overrides,
  });
  return { io, run: () => reconcileDanglingAttempt({ attempt_id: DANGLING, env, io, now: clock }) };
}

test("SHU-140 worker-identity: a live process re-checked with the same start token is the only sighting called WORKER_LIVE", async (t) => {
  const worktreeRoot = sandbox(t);
  fs.mkdirSync(nodePath.join(worktreeRoot, DANGLING));
  const proc = fakeProc(t, { 2770495: { cmdline: "/usr/bin/node /opt/coordinator/supervisor-worker.mjs ", cwd: nodePath.join(worktreeRoot, DANGLING), start_token: "900900" } });

  // The SAME /proc for both observations: nothing changed, so the pid is still
  // the process that was sighted and the kernel agrees.
  const { io, run: go } = workerWorld(t, { sightingProc: proc, env: { SHU_WORKTREE_ROOT: worktreeRoot } });
  const result = await go();

  assert.equal(result.code, "WORKER_LIVE", `got ${result.code} (${result.detail})`);
  assert.equal(result.refusal, "RECONCILE_REFUSED: WORKER_LIVE");
  assert.match(result.detail, /pid=2770495/);
  assert.match(result.detail, /disposition=CONFIRMED_LIVE/);
  // WHAT WAS VERIFIED is stated, not implied: the token at the sighting and the
  // token at the re-check are both in the record, and they are equal.
  assert.match(result.detail, /token_at_sighting=900900/);
  assert.match(result.detail, /token_at_recheck=900900/);
  assert.match(result.detail, /check=process-start token at sighting vs re-check/);
  assert.equal(result.evidence.sightings.length, 1);
  assert.equal(io.posted.length, 0, "a confirmed live worker must not be terminalized around");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot is preserved");
});

test("SHU-140 worker-identity: a pid that vanished between the sighting and the verdict refuses WORKER_STALE_RECORD, never WORKER_LIVE", async (t) => {
  const worktreeRoot = sandbox(t);
  fs.mkdirSync(nodePath.join(worktreeRoot, DANGLING));
  // Exactly the production shape: sighted by cwd inside the attempt worktree...
  const sighted = fakeProc(t, { 2770495: { cmdline: "/usr/bin/node /opt/coordinator/host-tick.sh ", cwd: nodePath.join(worktreeRoot, DANGLING), start_token: "900900" } });
  // ...and by the verdict there is no /proc/2770495 at all. This is what the
  // operator measured on the host: no entry, no cmdline, no cwd, no exe.
  const gone = fakeProc(t, { 7: { cmdline: "/usr/bin/sshd " } });

  const { io, run: go } = workerWorld(t, { sightingProc: sighted, verdictProc: gone, env: { SHU_WORKTREE_ROOT: worktreeRoot } });
  const result = await go();

  assert.notEqual(result.code, "WORKER_LIVE", "a pid with no /proc entry is NOT a confirmed live worker");
  assert.equal(result.code, "WORKER_STALE_RECORD", `got ${result.code} (${result.detail})`);
  assert.equal(result.refusal, "RECONCILE_REFUSED: WORKER_STALE_RECORD");
  // The refusal says precisely what was and was not verified.
  assert.match(result.detail, /pid=2770495/);
  assert.match(result.detail, /disposition=VANISHED/);
  assert.match(result.detail, /token_at_sighting=900900/);
  assert.match(result.detail, /token_at_recheck=absent/);
  assert.match(result.detail, /check=\/proc\/<pid> presence at re-check/);
  // ...and it says WHERE the pid came from, which the old refusal never did.
  assert.match(result.detail, /source=worktree_cwd/);
  assert.match(result.detail, new RegExp(`source_path=${sighted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/2770495/cwd`));

  // Still a refusal: the world changed under this invocation, so nothing is
  // terminalized on it and the slot is preserved.
  assert.equal(result.ok, false);
  assert.equal(io.posted.length, 0, "nothing may be written");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot is preserved");
});

test("SHU-140 worker-identity: a reused pid whose process-start token changed refuses WORKER_STALE_RECORD, never WORKER_LIVE", async (t) => {
  // The supervisor's own run record binds pid 2770495 to this attempt.
  const recorded = supervisorStateDir(t, { runs: { attempt_id: DANGLING, status: "running", pid: 2770495, process_token: "900900" } });
  const sighted = fakeProc(t, { 2770495: { cmdline: "/usr/bin/node /opt/coordinator/supervisor-worker.mjs ", start_token: "900900" } });
  // By the verdict the pid belongs to an unrelated process: same number, later
  // start token. PID reuse, simulated exactly as the kernel presents it.
  const reused = fakeProc(t, { 2770495: { cmdline: "/usr/sbin/cron -f ", start_token: "4242424" } });

  const { io, run: go } = workerWorld(t, { sightingProc: sighted, verdictProc: reused, env: { SHU_SUPERVISOR_STATE_DIR: recorded } });
  const result = await go();

  assert.notEqual(result.code, "WORKER_LIVE", "a recycled pid is somebody else's process, not a confirmed live worker");
  assert.equal(result.code, "WORKER_STALE_RECORD", `got ${result.code} (${result.detail})`);
  assert.match(result.detail, /disposition=TOKEN_CHANGED/);
  assert.match(result.detail, /token_at_sighting=900900/);
  assert.match(result.detail, /token_at_recheck=4242424/);
  assert.match(result.detail, /source=supervisor_record/);
  assert.match(result.detail, new RegExp(`source_path=.*runs/${DANGLING}\\.json`));
  assert.equal(io.posted.length, 0);
  assert.equal(activeSlots(io.receiptsOnDisk), 1);

  // The OTHER token mismatch — the record's process_token disagreeing with the
  // live process at match time — is equally never a confirmed live worker, and
  // is equally reported by name rather than silently dropped.
  const stale = supervisorStateDir(t, { runs: { attempt_id: DANGLING, status: "running", pid: 2770495, process_token: "555" } });
  const mismatched = workerWorld(t, { sightingProc: sighted, env: { SHU_SUPERVISOR_STATE_DIR: stale } });
  const second = await mismatched.run();
  assert.notEqual(second.code, "WORKER_LIVE");
  assert.equal(second.code, "WORKER_STALE_RECORD", `got ${second.code} (${second.detail})`);
  assert.match(second.detail, /disposition=RECORD_TOKEN_MISMATCH/);
  assert.match(second.detail, /recorded_token=555/);
  assert.match(second.detail, /token_at_sighting=900900/);
  assert.equal(mismatched.io.posted.length, 0);
});

test("SHU-140 worker-identity: a missing or unreadable /proc entry is auditable — WORKER_UNVERIFIED by name, from structured metadata and never a command line", async (t) => {
  const worktreeRoot = sandbox(t);
  fs.mkdirSync(nodePath.join(worktreeRoot, DANGLING));
  const SECRET = "ghp_liveworkersecretvalue";
  const LONG = `/usr/bin/node /opt/coordinator/supervisor-worker.mjs --api-token ${SECRET} SUPERVISOR_TOKEN=${SECRET} ${"x".repeat(200)} `;

  // 1. readProcessIdentity distinguishes the three /proc answers that the old
  //    code collapsed into one: absent, present-but-unreadable, and present.
  const absent = readProcessIdentity(fakeProc(t, { 7: {} }), 2770495);
  assert.deepEqual({ exists: absent.exists, token: absent.start_token }, { exists: false, token: null });
  const blind = procWithoutStat(t, 2770495, { cwd: nodePath.join(worktreeRoot, DANGLING), cmdline: LONG });
  const unreadable = readProcessIdentity(blind, 2770495);
  assert.equal(unreadable.exists, true, "the pid IS there — that is not the same as it being ours");
  assert.equal(unreadable.start_token, null, "an unreadable stat must yield no token, never a guessed one");

  // 2. The identity is STRUCTURED METADATA the kernel owns, and nothing else.
  //    There is no `cmdline` field to redact, so there is no code path that can
  //    persist an argument value — and the field that replaces it as "which
  //    process was this", the owning uid, is one no process can author.
  assert.deepEqual(Object.keys(unreadable).sort(), ["exists", "exists_known", "pid", "start_token", "uid"],
    "a process identity may carry no command line and no argument text at all");
  assert.equal(unreadable.uid, process.getuid ? process.getuid() : unreadable.uid,
    "the owning uid comes from the kernel's own /proc/<pid> inode");
  assert.ok(!JSON.stringify(unreadable).includes(SECRET), "a credential must never reach a captured identity");
  assert.ok(!JSON.stringify(unreadable).includes("supervisor-worker.mjs"),
    "not even a harmless argument is captured: the mechanism, not the instance, is what is removed");

  // 3. End to end: the pid is present and cannot be identified, so the operation
  //    fails CLOSED under its own name — never WORKER_LIVE (it is not proved) and
  //    never a release (it is not disproved either).
  const { io, run: go } = workerWorld(t, { sightingProc: blind, env: { SHU_WORKTREE_ROOT: worktreeRoot } });
  const result = await go();
  assert.notEqual(result.code, "WORKER_LIVE", "an unidentifiable process is not a CONFIRMED live worker");
  assert.equal(result.code, "WORKER_UNVERIFIED", `got ${result.code} (${result.detail})`);
  assert.match(result.detail, /pid=2770495/);
  assert.match(result.detail, /disposition=UNVERIFIED/);
  assert.match(result.detail, /token_at_sighting=unreadable/);
  assert.match(result.detail, /check=\/proc\/<pid>\/stat field 22 readability/);
  // The refusal still explains itself fully without any argument text: uid, the
  // comparison that could not be made, and the binding that was not established.
  assert.match(result.detail, /uid=\d+/, "the refusal must say which uid owned the process it could not identify");
  assert.match(result.detail, /identity_check=start_token_unreadable/);
  assert.match(result.detail, /record_token_check=no_record_token/);
  assert.match(result.detail, /independently_bound=yes/);
  assert.ok(!result.detail.includes(SECRET), "the refusal must never carry a credential");
  assert.ok(!result.detail.includes("cmdline"), "no command line field may exist to carry one");
  assert.equal(io.posted.length, 0, "an unverified process must not be terminalized around");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot is preserved");

  // 4. A liveness re-check that simply does not answer for a sighted pid is the
  //    same fail-closed outcome: "I could not look" is never "it is gone".
  const silent = cleanWorld({
    workerProcesses: async () => ({ observed_at: NOW, pids: [2770495], sightings: [sighting({ pid: 2770495 })] }),
    workerLiveness: async () => ({ observed_at: NOW, observations: [] }),
  });
  const unobserved = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: {}, io: silent, now: clock });
  assert.equal(unobserved.code, "WORKER_UNVERIFIED", `got ${unobserved.code} (${unobserved.detail})`);
  assert.match(unobserved.detail, /disposition=UNOBSERVED/);
  assert.match(unobserved.detail, /identity_check=not_observed/, "a re-check that never answered establishes no identity result");
  assert.equal(silent.posted.length, 0);

  // 5. A probe that reports pids but no sightings has established no identity at
  //    all, so there is nothing to re-check: EVIDENCE_MISSING, not an empty world.
  const numbersOnly = cleanWorld({ workerProcesses: async () => ({ observed_at: NOW, pids: [2770495] }) });
  const bare = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: {}, io: numbersOnly, now: clock });
  assert.equal(bare.code, "EVIDENCE_MISSING", `got ${bare.code} (${bare.detail})`);
  assert.equal(numbersOnly.posted.length, 0);
});

test("SHU-140 worker-identity: a stale supervisor record whose pid was never live cannot by itself block recovery, and every other safeguard still protects the slot", async (t) => {
  // A durable supervisor record naming pid 2770495 — and a process table in
  // which that pid does not exist at all. Nothing was SIGHTED, so there is no
  // live worker to confirm and nothing to disprove.
  const recorded = supervisorStateDir(t, { launches: { attempt_id: DANGLING, phase: "launched", pid: 2770495 } });
  const proc = fakeProc(t, { 7: { cmdline: "/usr/bin/sshd " } });
  const env = { SHU_SUPERVISOR_STATE_DIR: recorded };

  const probed = stamped(defaultWorkerProcesses({ receipt: { attempt_id: DANGLING }, env, procRoot: proc, now: clock }));
  assert.deepEqual(probed.pids, [], "a record naming a dead pid is not a live worker");
  assert.deepEqual(probed.sightings, [], "and it is not a sighting either: nothing was seen in the process table");

  // 1. The stale record does NOT produce a worker refusal — that is the guard
  //    this case exists for. But the slot is still protected, by a DIFFERENT,
  //    untouched safeguard: the supervisor store still holds a record for this
  //    attempt, so the attempt is not ours to terminalize.
  const held = workerWorld(t, {
    sightingProc: proc, env,
    overrides: { supervisorStore: async (args) => stamped(defaultSupervisorStore(args)) },
  });
  const blocked = await held.run();
  assert.ok(!String(blocked.code).startsWith("WORKER_"), `a never-live record must not raise a worker refusal, got ${blocked.code} (${blocked.detail})`);
  assert.equal(blocked.code, "SUPERVISOR_CLAIM_PRESENT", `got ${blocked.code} (${blocked.detail})`);
  assert.match(blocked.detail, /launches/);
  assert.equal(held.io.posted.length, 0, "nothing may be written while the supervisor still holds a record");
  assert.equal(activeSlots(held.io.receiptsOnDisk), 1, "the slot is preserved");

  // 2. Every OTHER work-effect safeguard is still re-checked and still refuses
  //    over the very same never-live record. The stale record removes no guard.
  for (const [code, overrides] of [
    ["WORKTREE_CHANGED", { worktree: async () => ({ observed_at: NOW, root_configured: true, present: true, head: "d".repeat(40), porcelain: "" }) }],
    ["BRANCH_MOVED", { branchHead: async () => ({ observed_at: NOW, ok: true, sha: "e".repeat(40) }) }],
    ["PUSH_RECEIPT_PRESENT", { pushReceipt: async () => ({ observed_at: NOW, readable: true, record: `/state/push-${DANGLING}.json` }) }],
    ["SUPERVISOR_CLAIM_PRESENT", { supervisorStatus: async () => ({ observed_at: NOW, response: { ok: true, stage: "ACCEPTED" } }) }],
    ["EVIDENCE_MISSING", { worktree: async () => ({ observed_at: NOW, root_configured: false, present: false, head: null, porcelain: null }) }],
  ]) {
    const guarded = workerWorld(t, { sightingProc: proc, env, overrides });
    const refusedBy = await guarded.run();
    assert.equal(refusedBy.code, code, `expected ${code}, got ${refusedBy.code} (${refusedBy.detail})`);
    assert.equal(guarded.io.posted.length, 0, `${code}: nothing may be written`);
    assert.equal(activeSlots(guarded.io.receiptsOnDisk), 1, `${code}: the slot is preserved`);
  }

  // 3. And ONLY when the record is genuinely gone — the supervisor's signed
  //    MISSING_CLAIM, a readable store with no record for this attempt, and
  //    every work-effect safeguard holding — does the never-live record stop
  //    blocking recovery and the slot is released.
  fs.rmSync(nodePath.join(recorded, "launches", `${DANGLING}.json`));
  const free = workerWorld(t, {
    sightingProc: proc, env,
    overrides: { supervisorStore: async (args) => stamped(defaultSupervisorStore(args)) },
  });
  const released = await free.run();
  assert.equal(released.ok, true, `expected terminalization, got ${released.code} (${released.detail})`);
  assert.equal(released.receipt.stage, "HOLD");
  assert.equal(free.io.posted.length, 1);
  assert.equal(activeSlots([resolveChain(free.io.receiptsOnDisk, DANGLING)]), 0, "the slot is released only once every safeguard held");
});

// ---------------------------------------------------------------------------
// SHU-140 — the three defects a review of the sighting machinery found.
//
// Each case below is a value or a claim that the reviewed revision published,
// reproduced through the SHIPPED probes. None of them released the slot — but
// two of them put a false statement in the audit trail, and the first put a
// live credential in it, and an auditable refusal is exactly the property this
// module exists to hold.
// ---------------------------------------------------------------------------

// A command line is redacted PER ARGV ENTRY, because /proc separates argv with
// NULs and those NULs are the only evidence of where one argument ends.
// Flattening them to spaces first and then hiding one whitespace-delimited word
// per match published every credential that contained a space, and every
// credential that names itself rather than its flag.
// THE MECHANISM, NOT THE INSTANCE. An earlier revision of this module carried a
// redacted command line in the refusal detail, in `evidence.sightings` and on
// stdout, and defended it with a keyword blacklist. A review then demonstrated
// six real /proc argv shapes the blacklist still published END TO END through
// main() — `X-Api-Key: <value>`, a secret as the entry after `-p`, `-u
// user:pass`, a JSON body carrying a token, `password: <value>`, and argv a
// caller had already flattened. Each instance was individually fixable; the
// class was not, because a blacklist must enumerate every way a credential can
// be spelled and the argv captured is whatever the agent shelled out to.
//
// So no command line is captured at all, and this test pins the ABSENCE: every
// shape below is driven through the shipped main() with a distinct planted
// secret, and the captured output bytes are searched for each one. A blacklist
// cannot make this test pass — only having no argument text in the output can.
test("SHU-140 worker-identity: no argument value can reach the refusal detail, the evidence, stdout or an exception, because no command line is ever captured", async (t) => {
  const NUL = "\u0000";
  const argv = (...args) => `${args.join(NUL)}${NUL}`;

  // The six shapes the review PROVED leaked, the ones a blacklist did catch, and
  // an argv with no credential in it at all — which must be just as absent, or
  // the mechanism is back. `needles` are the substrings that must not appear;
  // the first of each is the planted secret.
  const cases = [
    { name: "SHORT flag -p, value is the next entry", cmdline: argv("mysql", "-h", "db", "-p", "s3cret_p_flag_AAA"), needles: ["s3cret_p_flag_AAA", "mysql"] },
    { name: "curl -u user:password", cmdline: argv("curl", "-u", "admin:s3cret_userinfo_BBB", "https://x/"), needles: ["s3cret_userinfo_BBB", "admin:"] },
    { name: "HEADER colon form, sensitive name", cmdline: argv("curl", "-s", "-H", "X-Api-Key: s3cret_apikey_CCC", "https://api.internal/v1/jobs"), needles: ["s3cret_apikey_CCC", "X-Api-Key"] },
    { name: "JSON payload carrying a token", cmdline: argv("node", "--data", '{"token":"s3cret_json_DDD"}'), needles: ["s3cret_json_DDD", "--data"] },
    { name: "password colon form", cmdline: argv("node", "--opt", "password: s3cret_colon_EEE"), needles: ["s3cret_colon_EEE", "--opt"] },
    { name: "pre-flattened argv (no NULs at all)", cmdline: "node --password alpha_s3cret_FFF omega_s3cret_FFF2 --port 8080", needles: ["omega_s3cret_FFF2", "--port"] },
    { name: "sensitive flag, value with spaces", cmdline: argv("node", "--password", "my s3cret_spaced_GGG phrase"), needles: ["s3cret_spaced_GGG", "--password"] },
    { name: "Bearer under a sensitive flag", cmdline: argv("node", "--auth-header", "Bearer s3cret_bearer_HHH"), needles: ["s3cret_bearer_HHH", "Bearer"] },
    { name: "Authorization under a neutral flag", cmdline: argv("curl", "--header", "Authorization: Bearer s3cret_authz_III"), needles: ["s3cret_authz_III", "Authorization"] },
    { name: "lower-case assignment, no dash", cmdline: argv("node", "api_key=s3cret_assign_JJJ"), needles: ["s3cret_assign_JJJ", "api_key"] },
    { name: "credential in a URL's userinfo", cmdline: argv("git", "https://x-access-token:s3cret_url_KKK@github.com/o/r"), needles: ["s3cret_url_KKK", "x-access-token"] },
    { name: "postgres connection URI", cmdline: argv("psql", "postgresql://u:s3cret_pg_LLL@h/db"), needles: ["s3cret_pg_LLL", "postgresql"] },
    { name: "a value far beyond any truncation bound", cmdline: argv("node", "--token", "s3cret_long_MMM", "x".repeat(4000)), needles: ["s3cret_long_MMM", "--token"] },
    { name: "argv with NO credential in it at all", cmdline: argv("/usr/bin/node", "/opt/coordinator/supervisor-worker.mjs", "--worker"), needles: ["supervisor-worker.mjs", "--worker"] },
  ];

  const leaks = [];
  for (const shape of cases) {
    const worktreeRoot = sandbox(t);
    const worktreeDir = nodePath.join(worktreeRoot, DANGLING);
    fs.mkdirSync(worktreeDir);
    const proc = fakeProc(t, { 2770495: { cmdline: shape.cmdline, cwd: worktreeDir, start_token: "900900" } });
    // The fixture really does carry the secret where /proc would: if this failed,
    // every assertion below would pass for the wrong reason.
    assert.ok(fs.readFileSync(nodePath.join(proc, "2770495", "cmdline"), "utf8").includes(shape.needles[0]),
      `${shape.name}: the /proc fixture must actually contain the planted secret`);

    const env = { SHU_WORKTREE_ROOT: worktreeRoot };
    const { io, run: go } = workerWorld(t, { sightingProc: proc, env });
    const result = await go();
    assert.equal(result.code, "WORKER_LIVE", `${shape.name}: got ${result.code} (${result.detail})`);

    // ...and through the SHIPPED main(), which is what writes the unit's journal.
    const printed = [];
    const exit = await reconcileMain(["--reconcile-dangling", DANGLING], env,
      { ...io, now: clock, stdout: (line) => printed.push(line) });
    assert.equal(exit, 3, `${shape.name}: a confirmed live worker must refuse`);

    // Every durable sink this refusal has, searched as bytes.
    const sinks = {
      detail: String(result.detail),
      evidence: JSON.stringify(result.evidence ?? null),
      stdout: printed.join("\n"),
      posted: JSON.stringify(io.posted),
    };
    for (const [sink, text] of Object.entries(sinks)) {
      for (const needle of shape.needles) {
        if (text.includes(needle)) leaks.push(`${shape.name}: '${needle}' in ${sink}`);
      }
    }
    // The refusal is still fully self-describing WITHOUT any argument text.
    assert.match(sinks.stdout, /WORKER_SIGHTING pid=2770495 uid=\d+ disposition=CONFIRMED_LIVE/);
    assert.match(sinks.stdout, /check=process-start token at sighting vs re-check/);
    assert.match(sinks.stdout, /source=worktree_cwd/);
    assert.match(sinks.stdout, /token_at_sighting=900900 token_at_recheck=900900/);
    assert.match(sinks.stdout, /identity_check=start_token_unchanged/);
    assert.match(sinks.stdout, /record_token_check=no_record_token/);
    assert.match(sinks.stdout, /independently_bound=yes/);
    assert.equal(io.posted.length, 0, `${shape.name}: nothing may be written on a refusal`);
  }
  assert.deepEqual(leaks, [], `no argument value may reach any durable sink:\n${leaks.join("\n")}`);

  // A THROWN message is a sink too: a record this probe cannot parse must be
  // named as EVIDENCE_MISSING without quoting a byte of the file it could not
  // read. The record body here is a credential, which is the realistic case.
  const stateDir = supervisorStateDir(t, { launches: { attempt_id: DANGLING, pid: 2770495 } });
  fs.writeFileSync(nodePath.join(stateDir, "runs", `${DANGLING}.json`), "not json: token=s3cret_unparseable_NNN");
  const broken = cleanWorld({ workerProcesses: async (args) => stamped(defaultWorkerProcesses({ ...args, procRoot: fakeProc(t, { 2770495: { start_token: "900900" } }) })) });
  const thrown = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: { SHU_SUPERVISOR_STATE_DIR: stateDir }, io: broken, now: clock });
  assert.equal(thrown.code, "EVIDENCE_MISSING", `got ${thrown.code} (${thrown.detail})`);
  assert.ok(!String(thrown.detail).includes("s3cret_unparseable_NNN"), `a probe failure must not quote what it read, got ${thrown.detail}`);
  assert.equal(broken.posted.length, 0);

  // And the mechanism cannot be reintroduced by accident: the module exports no
  // command-line redactor and no truncation bound, because it captures nothing
  // that would need either.
  const shipped = await import("../reconcile-dangling.mjs");
  assert.equal(shipped.redactCommandLine, undefined, "a command-line redactor is the rejected mechanism, not the fix");
  assert.equal(shipped.WORKER_CMDLINE_MAX, undefined, "there is no command line to bound");
});

// A supervisor record that disagrees with the kernel disproves nothing about a
// process we can SEE working in the attempt's own worktree. The record is the
// very thing this operation was invoked because it does not trust.
test("SHU-140 worker-identity: a process sighted working IN the attempt worktree is not exonerated by a stale supervisor record, and a record mismatch alone still refuses WORKER_STALE_RECORD", async (t) => {
  const worktreeRoot = sandbox(t);
  const worktreeDir = nodePath.join(worktreeRoot, DANGLING);
  fs.mkdirSync(worktreeDir);
  // The kernel says pid 2770495 started at token 900900 and its cwd is the
  // attempt's OWN worktree. The supervisor's run record for the same attempt
  // carries a STALE process_token: the record disagrees with the kernel.
  const proc = fakeProc(t, { 2770495: { cmdline: "/usr/bin/node /opt/coordinator/supervisor-worker.mjs ", cwd: worktreeDir, start_token: "900900" } });
  const stale = supervisorStateDir(t, { runs: { attempt_id: DANGLING, status: "running", pid: 2770495, process_token: "555" } });
  const env = { SHU_SUPERVISOR_STATE_DIR: stale, SHU_WORKTREE_ROOT: worktreeRoot };

  const probed = stamped(defaultWorkerProcesses({ receipt: { attempt_id: DANGLING }, env, procRoot: proc, now: clock }));
  assert.equal(probed.sightings.length, 1, "one process, sighted two ways");
  // The record's disagreement is still recorded as the fact it is...
  assert.equal(probed.sightings[0].record_token_match, false, "the record really does disagree with the kernel, and the audit must keep saying so");
  assert.deepEqual(probed.sightings[0].also_seen_by, ["worktree_cwd"]);
  // ...but it does not delete a pid that an INDEPENDENT sighting saw working
  // here. `pids` is the pids that would have been reported live, and a cwd
  // sighting reported this one live before any record was ever consulted.
  assert.equal(probed.sightings[0].independently_bound, true, "a cwd inside the attempt worktree binds the pid to the attempt BY OBSERVATION");
  assert.deepEqual(probed.pids, [2770495], "a record mismatch must not suppress a pid an independent sighting saw");

  // End to end: WORKER_LIVE, and the line says why the record did not decide it.
  const { io, run: go } = workerWorld(t, { sightingProc: proc, env });
  const result = await go();
  assert.equal(result.code, "WORKER_LIVE", `a process working in the attempt worktree is live, got ${result.code} (${result.detail})`);
  assert.notEqual(result.code, "WORKER_STALE_RECORD", "'provably not that process' must never be claimed about a process seen in the attempt's own worktree");
  assert.match(result.detail, /disposition=CONFIRMED_LIVE/);
  assert.match(result.detail, /source=supervisor_record\+worktree_cwd/);
  assert.match(result.detail, /recorded_token=555/, "the disagreeing record stays in the evidence");
  assert.match(result.detail, /independently_bound=yes/, "the line must explain its own disposition");
  assert.equal(io.posted.length, 0, "a live worker must not be terminalized around");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot is preserved");

  // ...and the guard is NOT weakened. With nothing behind the pid but the
  // record that disagrees — no cwd, no attempt_id anywhere — it is still
  // disproved, under its own distinct name.
  const recordOnly = fakeProc(t, { 2770495: { cmdline: "/usr/bin/node /opt/coordinator/supervisor-worker.mjs ", start_token: "900900" } });
  const alone = workerWorld(t, { sightingProc: recordOnly, env: { SHU_SUPERVISOR_STATE_DIR: stale } });
  const second = await alone.run();
  assert.equal(second.code, "WORKER_STALE_RECORD", `got ${second.code} (${second.detail})`);
  assert.match(second.detail, /disposition=RECORD_TOKEN_MISMATCH/);
  assert.match(second.detail, /independently_bound=no/);
  assert.equal(alone.io.posted.length, 0, "nothing may be written on a refusal");

  // The argv/environ sighting is independent evidence in the same way: it is a
  // process naming this attempt with no record behind it at all.
  const byArgv = fakeProc(t, { 2770495: { cmdline: `/usr/bin/node worker.mjs --attempt ${DANGLING} `, start_token: "900900" } });
  const scanned = stamped(defaultWorkerProcesses({ receipt: { attempt_id: DANGLING }, env: { SHU_SUPERVISOR_STATE_DIR: stale }, procRoot: byArgv, now: clock }));
  assert.deepEqual(scanned.pids, [2770495], "a process carrying the attempt_id is independent evidence too");
  assert.equal(scanned.sightings[0].independently_bound, true);
  assert.equal(classifyWorkerSighting(scanned.sightings[0], readProcessIdentity(byArgv, 2770495)).disposition, "CONFIRMED_LIVE");
});

// RECORD ORDER MUST NOT DECIDE A DISPOSITION. `note()` used to let the FIRST
// sighting of a pid win every field, so an earlier record kind that named the pid
// without a `process_token` suppressed a later kind's DISAGREEING token outright:
// the disposition flipped from RECORD_TOKEN_MISMATCH to CONFIRMED_LIVE and the
// audit line printed `recorded_token=none`, with the disagreement gone from the
// evidence. The repair is not to pick the "strongest" record — that discards the
// conflict just as thoroughly, in the other direction — but to KEEP BOTH tokens
// and re-run the comparison over all of them, fail-closed.
test("SHU-140 worker-identity: a record read first cannot shadow a later record's disagreeing process_token — both tokens reach the audit line and the disagreement still refuses", async (t) => {
  const PID = 2770495;
  const LIVE = "900900";
  const STALE = "STALE999";
  // One live process, whose kernel start token is LIVE. Every case below differs
  // only in which record kinds name its pid, and in what order they are read.
  const live = () => fakeProc(t, { [PID]: { cmdline: "/usr/bin/node worker.mjs ", start_token: LIVE } });

  const probe = (records, procRoot) => stamped(defaultWorkerProcesses({
    receipt: { attempt_id: DANGLING }, env: { SHU_SUPERVISOR_STATE_DIR: supervisorStateDir(t, records) },
    procRoot, now: clock,
  }));

  // 1. THE DEFECT: an UNTOKENED `orders` record is read before the tokened
  //    `runs` record (SUPERVISOR_RECORD_KINDS is orders, runs, launches,
  //    completions). The untokened one must not swallow the disagreement.
  const shadowedProc = live();
  const shadowed = probe({
    orders: { attempt_id: DANGLING, pid: PID },
    runs: { attempt_id: DANGLING, status: "running", pid: PID, process_token: STALE },
  }, shadowedProc);
  assert.equal(shadowed.sightings.length, 1, "one pid, named by two records");
  assert.equal(shadowed.sightings[0].record_token_match, false,
    "a later record's disagreeing token must decide, whatever was read before it");
  assert.deepEqual(shadowed.sightings[0].recorded_tokens, [null, STALE],
    "both records' token evidence is kept, in read order, with `none` for the untokened one");
  assert.deepEqual(shadowed.pids, [], "a mismatch with no independent sighting behind it is not a live pid");

  // End to end: it refuses by name, and BOTH tokens are in the audit line.
  const { io, run: go } = workerWorld(t, {
    sightingProc: shadowedProc,
    env: { SHU_SUPERVISOR_STATE_DIR: supervisorStateDir(t, {
      orders: { attempt_id: DANGLING, pid: PID },
      runs: { attempt_id: DANGLING, status: "running", pid: PID, process_token: STALE },
    }) },
  });
  const result = await go();
  assert.equal(result.code, "WORKER_STALE_RECORD", `got ${result.code} (${result.detail})`);
  assert.notEqual(result.code, "WORKER_LIVE", "a record that disagrees with the kernel is never a confirmed live worker");
  assert.match(result.detail, /disposition=RECORD_TOKEN_MISMATCH/);
  assert.match(result.detail, new RegExp(`recorded_token=none\\+${STALE}`),
    "the untokened record AND the disagreeing one are both represented");
  assert.match(result.detail, /record_token_check=mismatch/);
  assert.match(result.detail, new RegExp(`token_at_sighting=${LIVE}`), "the live token is in the same line as the record's");
  assert.match(result.detail, /identity_check=not_reached/, "the record decided before the identity comparison ran");
  assert.match(result.detail, /independently_bound=no/);
  // 2. The duplicate-source wart: two record kinds are ONE source, named once.
  assert.match(result.detail, /source=supervisor_record /);
  assert.ok(!result.detail.includes("supervisor_record+supervisor_record"),
    `two records of the same kind of source must render once, got ${result.detail}`);
  // ...and both files that named the pid are still in the line, in read order.
  assert.match(result.detail, /source_path=\S*orders\S*,\S*runs\S*/);
  assert.equal(io.posted.length, 0, "nothing may be written on a refusal");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot is preserved");

  // 3. THE REVERSE ORDER, which is the arrangement the shipped writers actually
  //    produce today (writeRun records a token, markLaunch does not, and `runs`
  //    is read before `launches`). The outcome must not depend on which came
  //    first, so it is asserted from the other direction too.
  const reversed = probe({
    runs: { attempt_id: DANGLING, status: "running", pid: PID, process_token: STALE },
    launches: { attempt_id: DANGLING, phase: "launched", pid: PID },
  }, live());
  assert.equal(reversed.sightings[0].record_token_match, false, "order must not change the answer");
  assert.deepEqual(reversed.sightings[0].recorded_tokens, [STALE, null]);

  // 4. FAIL-CLOSED, not "strongest evidence": a record that AGREES with the
  //    kernel must not exonerate one that disagrees. Both are printed.
  const conflicting = probe({
    orders: { attempt_id: DANGLING, pid: PID, process_token: LIVE },
    runs: { attempt_id: DANGLING, status: "running", pid: PID, process_token: STALE },
  }, live());
  assert.equal(conflicting.sightings[0].record_token_match, false,
    "one agreeing record may never outvote a disagreeing one");
  const conflictLine = describeWorkerSighting(workerVerdict(conflicting.sightings,
    [readProcessIdentity(live(), PID)]).verdicts[0]);
  assert.match(conflictLine, new RegExp(`recorded_token=${LIVE}\\+${STALE}`), `got ${conflictLine}`);
  assert.match(conflictLine, /disposition=RECORD_TOKEN_MISMATCH/);

  // 5. CONTROL: the tokened record ALONE already refused before this fix, so the
  //    cases above cannot be passing for some unrelated reason.
  const control = probe({ runs: { attempt_id: DANGLING, status: "running", pid: PID, process_token: STALE } }, live());
  assert.equal(control.sightings[0].record_token_match, false);
  assert.deepEqual(control.sightings[0].recorded_tokens, [STALE]);
  assert.match(describeWorkerSighting(workerVerdict(control.sightings, [readProcessIdentity(live(), PID)]).verdicts[0]),
    new RegExp(`recorded_token=${STALE} record_token_check=mismatch`), "a single record still renders as a bare token");

  // 6. An INDEPENDENT sighting still outranks the record, and the retained
  //    conflict is still visible — the record's disagreement never disappears,
  //    it just does not get to decide a process we can see working here.
  const worktreeRoot = sandbox(t);
  const worktreeDir = nodePath.join(worktreeRoot, DANGLING);
  fs.mkdirSync(worktreeDir);
  const inWorktree = fakeProc(t, { [PID]: { cmdline: "/usr/bin/node worker.mjs ", cwd: worktreeDir, start_token: LIVE } });
  const bound = stamped(defaultWorkerProcesses({
    receipt: { attempt_id: DANGLING },
    env: {
      SHU_SUPERVISOR_STATE_DIR: supervisorStateDir(t, {
        orders: { attempt_id: DANGLING, pid: PID },
        runs: { attempt_id: DANGLING, status: "running", pid: PID, process_token: STALE },
      }),
      SHU_WORKTREE_ROOT: worktreeRoot,
    },
    procRoot: inWorktree, now: clock,
  }));
  assert.equal(bound.sightings[0].independently_bound, true);
  assert.equal(bound.sightings[0].record_token_match, false, "the record still disagrees, and the audit must keep saying so");
  const boundLine = describeWorkerSighting(workerVerdict(bound.sightings, [readProcessIdentity(inWorktree, PID)]).verdicts[0]);
  assert.match(boundLine, /disposition=CONFIRMED_LIVE/);
  assert.match(boundLine, /source=supervisor_record\+worktree_cwd/, `got ${boundLine}`);
  assert.match(boundLine, new RegExp(`recorded_token=none\\+${STALE} record_token_check=mismatch`), `got ${boundLine}`);
  assert.match(boundLine, /independently_bound=yes/);
});

// "I could not look" must never render as a fact. VANISHED states that /proc was
// looked at and the process was gone, so it is reserved for an absence the
// kernel actually confirmed — ENOENT, and nothing else.
test("SHU-140 worker-identity: a /proc entry that could not be READ at the re-check is PRESENCE_UNREADABLE and refuses WORKER_UNVERIFIED, never VANISHED and never 'absent'", async (t) => {
  const worktreeRoot = sandbox(t);
  const worktreeDir = nodePath.join(worktreeRoot, DANGLING);
  fs.mkdirSync(worktreeDir);
  const sighted = fakeProc(t, { 2770495: { cmdline: "/usr/bin/node /opt/coordinator/supervisor-worker.mjs ", cwd: worktreeDir, start_token: "900900" } });

  // 1. readProcessIdentity separates "the kernel says it is gone" from "I could
  //    not look at all". Only ENOENT is a KNOWN absence.
  const gone = readProcessIdentity(fakeProc(t, { 7: {} }), 2770495);
  assert.deepEqual({ exists: gone.exists, known: gone.exists_known }, { exists: false, known: true }, "ENOENT is a known absence");
  // A /proc that is no longer a directory: ENOTDIR, so nothing at all is known.
  const notProc = nodePath.join(sandbox(t), "proc-replaced-by-a-file");
  fs.writeFileSync(notProc, "");
  const blind = readProcessIdentity(notProc, 2770495);
  assert.deepEqual({ exists: blind.exists, known: blind.exists_known }, { exists: false, known: false }, "a non-ENOENT stat fault establishes NOTHING about existence");
  // ...and the errno the review named, wherever this uid can actually be denied.
  // Run as a uid that cannot be denied (root) this case is unreachable, and the
  // ENOTDIR case above pins the same contract without needing a permission.
  const denied = sandbox(t);
  fs.mkdirSync(nodePath.join(denied, "2770495"));
  fs.chmodSync(denied, 0o000);
  try {
    let code = null;
    try { fs.statSync(nodePath.join(denied, "2770495")); } catch (error) { code = error.code; }
    if (code === "EACCES") assert.equal(readProcessIdentity(denied, 2770495).exists_known, false, "EACCES must never read as an absence");
  } finally { fs.chmodSync(denied, 0o755); }

  // 2. The classifier gives it its own name, and that name is not a disproof.
  const sight = sighting({ pid: 2770495, record_token_match: null });
  assert.equal(classifyWorkerSighting(sight, blind).disposition, "PRESENCE_UNREADABLE");
  assert.notEqual(classifyWorkerSighting(sight, blind).disposition, "VANISHED", "an unreadable /proc is not a proved exit");
  assert.ok(WORKER_DISPOSITIONS.PRESENCE_UNREADABLE, "every disposition must be declared with what it means");
  const grouped = workerVerdict([sight], [blind]);
  assert.equal(grouped.unverified.length, 1, "neither proved nor disproved: it fails closed as unverified");
  assert.equal(grouped.disproved.length, 0, "it must never be grouped as a disproof");
  assert.equal(grouped.confirmed.length, 0, "and it is certainly not a confirmation");
  // The audit line never states the absence it did not establish.
  const line = describeWorkerSighting(grouped.verdicts[0]);
  assert.match(line, /token_at_recheck=unreadable/);
  assert.ok(!line.includes("token_at_recheck=absent"), `"absent" claims /proc was looked at, got ${line}`);
  // ...while a KNOWN absence still says absent, and is still a disproof.
  assert.match(describeWorkerSighting(workerVerdict([sight], [gone]).verdicts[0]), /token_at_recheck=absent/);
  assert.equal(workerVerdict([sight], [gone]).disproved.length, 1, "a kernel-confirmed absence is still VANISHED");

  // 3. End to end, through the shipped probes: the pid was sighted, the re-check
  //    could not look, so the operation fails closed under its own name.
  const { io, run: go } = workerWorld(t, { sightingProc: sighted, verdictProc: notProc, env: { SHU_WORKTREE_ROOT: worktreeRoot } });
  const result = await go();
  assert.equal(result.code, "WORKER_UNVERIFIED", `got ${result.code} (${result.detail})`);
  assert.notEqual(result.code, "WORKER_STALE_RECORD", "a re-check that never happened must not be reported as a disproof");
  assert.match(result.detail, /disposition=PRESENCE_UNREADABLE/);
  assert.match(result.detail, /check=\/proc\/<pid> presence at re-check \(unreadable\)/);
  assert.ok(!result.detail.includes("disposition=VANISHED"), "an unverified re-check must never be reported as a proved exit");
  assert.equal(io.posted.length, 0, "nothing may be written");
  assert.equal(activeSlots(io.receiptsOnDisk), 1, "the slot is preserved");
});

test("SHU-140 reconcile-dangling probe: a push receipt is read from a listed directory, and an unlistable one is not an absent receipt", async (t) => {
  const receipt = { attempt_id: DANGLING };

  const withRecord = sandbox(t);
  fs.writeFileSync(nodePath.join(withRecord, `push-${DANGLING}.json`), JSON.stringify({ stage: "PENDING", attempt_id: DANGLING }));
  const found = stamped(defaultPushReceipt({ receipt, env: { SHU_WORKSPACE_STATE_DIR: withRecord }, now: clock }));
  assert.equal(found.readable, true);
  assert.equal(found.record, nodePath.join(withRecord, `push-${DANGLING}.json`));

  const withoutRecord = sandbox(t);
  fs.writeFileSync(nodePath.join(withoutRecord, "push-00000000-0000-4000-8000-000000000000.json"), "{}");
  const clean = stamped(defaultPushReceipt({ receipt, env: { SHU_WORKSPACE_STATE_DIR: withoutRecord }, now: clock }));
  assert.equal(clean.readable, true);
  assert.equal(clean.record, null, "another attempt's push receipt is not this attempt's");

  const notADir = nodePath.join(sandbox(t), "state-is-a-file");
  fs.writeFileSync(notADir, "");
  assert.equal(stamped(defaultPushReceipt({ receipt, env: { SHU_WORKSPACE_STATE_DIR: notADir }, now: clock })).readable, false);
  assert.equal(stamped(defaultPushReceipt({ receipt, env: {}, now: clock })).readable, false);

  // End to end, with the REAL probe: a landed push is refused by name.
  const io = cleanWorld({ pushReceipt: async (args) => stamped(defaultPushReceipt(args)) });
  const result = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: { SHU_WORKSPACE_STATE_DIR: withRecord }, io, now: clock });
  assert.equal(result.code, "PUSH_RECEIPT_PRESENT", `got ${result.code} (${result.detail})`);
  assert.equal(io.posted.length, 0);
});

test("SHU-140 reconcile-dangling: the remaining guards — binding, measurability, the state machine's veto, the write, and the CLI", async () => {
  // A receipt with no scoped_base_sha gives the worktree comparison nothing to
  // compare against, so the worktree condition cannot be established at all.
  const noBase = cleanWorld();
  noBase.receiptsOnDisk = noBase.receiptsOnDisk.map((r) => { const { scoped_base_sha, ...rest } = r; return rest; });
  const unbound = await run(noBase);
  assert.equal(unbound.code, "EVIDENCE_MISSING", `got ${unbound.code} (${unbound.detail})`);
  assert.match(unbound.detail, /scoped_base_sha/);
  assert.equal(noBase.posted.length, 0);

  // A worktree that is present but could not be measured is missing evidence,
  // never a clean worktree.
  for (const partial of [{ head: null, porcelain: "" }, { head: BASE_SHA, porcelain: null }]) {
    const io = cleanWorld({ worktree: async () => ({ observed_at: NOW, root_configured: true, present: true, ...partial }) });
    const result = await run(io);
    assert.equal(result.code, "EVIDENCE_MISSING", `${JSON.stringify(partial)}: ${result.code}`);
    assert.match(result.detail, /could not be measured/);
    assert.equal(io.posted.length, 0);
  }

  // The attempt_id must be a UUID, and the check happens before ANY probe: a
  // malformed id must not cause a supervisor contact or a board read.
  for (const bad of [undefined, null, "", "SHU-140", DANGLING.toUpperCase(), `${DANGLING} `]) {
    const io = cleanWorld();
    const result = await reconcileDanglingAttempt({ attempt_id: bad, env: {}, io, now: () => NOW });
    assert.equal(result.code, "EVIDENCE_MISSING", `${JSON.stringify(bad)}: ${result.code}`);
    assert.match(result.detail, /attempt_id UUID is required/);
    assert.equal(io.supervisorRequests.length, 0, "a malformed attempt_id must not reach the supervisor");
    assert.equal(io.posted.length, 0);
  }

  // Without a resolved Linear issue there is nowhere to write the receipt, and
  // "nowhere to write" must not degrade into "write somewhere else".
  const homeless = cleanWorld({ linearIssueId: null });
  homeless.readReceipts = async () => ({ observed_at: NOW, receipts: homeless.receiptsOnDisk, linearIdByAttempt: new Map() });
  const lost = await run(homeless);
  assert.equal(lost.code, "EVIDENCE_MISSING", `got ${lost.code} (${lost.detail})`);
  assert.match(lost.detail, /Linear issue/);
  assert.equal(homeless.posted.length, 0);
  assert.equal(homeless.supervisorRequests.length, 0, "the issue is resolved before any supervisor contact");

  // The state machine, not this module, has the last word on whether a stage may
  // be terminalized: a rejected transition is a refusal by name, never a write.
  const dangling = resolveChain(danglingChain(), DANGLING);
  const allowed = terminalizeReceipt(dangling, { attempt_id: DANGLING, at: NOW });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.receipt.stage, "HOLD");
  assert.ok(allowed.receipt.timestamps.terminal);
  for (const stage of ["RESERVED", "COMPLETED", "FAILED", "HOLD"]) {
    const vetoed = terminalizeReceipt({ ...dangling, stage }, { attempt_id: DANGLING, at: NOW });
    assert.equal(vetoed.ok, false, `${stage} must not be terminalizable by this operation`);
    assert.equal(vetoed.code, "NOT_DANGLING", `${stage}: ${vetoed.code}`);
    assert.equal(vetoed.receipt, undefined, `${stage}: no receipt may be produced`);
  }

  // A write that did not confirm is named, so an operator is never left reading
  // a stack trace to find out whether the HOLD comment landed.
  const failing = cleanWorld({ postReceipt: async () => { throw new Error("Linear 503 Service Unavailable"); } });
  const unconfirmed = await run(failing);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, "WRITE_UNCONFIRMED");
  assert.equal(unconfirmed.refusal, "RECONCILE_REFUSED: WRITE_UNCONFIRMED");
  assert.match(unconfirmed.detail, /503/);
  assert.ok(RECONCILE_REFUSAL_CODES.includes("WRITE_UNCONFIRMED"));

  // Configuration that cannot be loaded is named too, not an escaping throw.
  const unconfigured = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: {},
    io: { ...cleanWorld(), config: undefined, configPath: "/nonexistent/shu140/config.json" }, now: () => NOW });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "EVIDENCE_MISSING");
  assert.match(unconfigured.detail, /configuration could not be loaded/);

  // The CLI accepts exactly one flag with exactly one UUID, so no dispatch or
  // activation switch can be smuggled onto the command line.
  assert.deepEqual(parseReconcileArgs(["--reconcile-dangling", DANGLING]), { ok: true, attempt_id: DANGLING });
  for (const argv of [[], ["--reconcile-dangling"], ["--reconcile-dangling", "not-a-uuid"],
    ["--reconcile-dangling", DANGLING, "--enable-dispatch"], ["--enable-dispatch", "--reconcile-dangling", DANGLING],
    ["--reconcile-dangling", DANGLING, "--arm-activation", "SHU-140"], [DANGLING]]) {
    const parsed = parseReconcileArgs(argv);
    assert.equal(parsed.ok, false, `${JSON.stringify(argv)} must be rejected`);
    assert.equal(parsed.attempt_id, undefined);
  }

  // ...and main() reports each outcome with its own exit code, writing nothing
  // on a refusal.
  const lines = [];
  assert.equal(await reconcileMain(["--reconcile-dangling", DANGLING, "--enable-dispatch"], {}, { now: () => NOW, stdout: (l) => lines.push(l) }), 2);
  assert.match(lines.at(-1), /exactly one argument/);
  const refused = cleanWorld({
    workerProcesses: async () => ({ observed_at: NOW, pids: [4242], sightings: [sighting({ pid: 4242 })] }),
    workerLiveness: async () => ({ observed_at: NOW, observations: [{ pid: 4242, exists: true, exists_known: true, start_token: "900900", uid: 1000 }] }),
  });
  assert.equal(await reconcileMain(["--reconcile-dangling", DANGLING], {}, { ...refused, now: () => NOW, stdout: (l) => lines.push(l) }), 3);
  assert.match(lines.at(-2), /RECONCILE_REFUSED: WORKER_LIVE.*slot preserved, nothing written/);
  // The journal carries the EVIDENCE, not just the verdict: the refusal is
  // reconstructible from these lines without access to the host.
  assert.match(lines.at(-1), /^WORKER_SIGHTING pid=4242 uid=1000 disposition=CONFIRMED_LIVE check=\S/);
  assert.equal(refused.posted.length, 0);
  const world = cleanWorld();
  assert.equal(await reconcileMain(["--reconcile-dangling", DANGLING], {}, { ...world, now: () => NOW, stdout: (l) => lines.push(l) }), 0);
  assert.match(lines.at(-1), /^RECONCILE_TERMINALIZED attempt=.* stage=HOLD slot=released$/);
  assert.equal(world.posted.length, 1);
});

// ---------------------------------------------------------------------------
// SHU-140 — exposing the reviewed recovery through the coordinator SERVICE
// ---------------------------------------------------------------------------
//
// reconcile-dangling.mjs works but cannot be run from the host: the transport
// credential is pinned to /run/credentials/shu-coordinator.service, so a
// transient unit materialises its credentials under its own unit name and the
// operation refuses ACT_CREDENTIAL_UNAVAILABLE. recovery-request.mjs lets the
// ALREADY-REVIEWED unit, running its ALREADY-REVIEWED ExecStart, be ASKED to
// perform the recovery instead of a tick, so the operation inherits the existing
// systemd credential delivery without any of it moving.
//
// The request file is real on disk in these proofs — a 0600 file in a real
// directory, consumed for real — because single use, replay refusal and "the
// ordinary wake is untouched" are properties of the filesystem handshake, not of
// a decision function. No socket, no network, no real git and no spawned
// process: the file's audited capability set stays [].
import { fileURLToPath } from "node:url";
import { ACTIVATION_FILE } from "../service/credential-delivery.mjs";
import { coordinatorEntry, coordinatorTickArgs } from "../service/coordinator-tick.mjs";
import {
  RECOVERY_CONSUMED_DIR,
  RECOVERY_NOTHING_WRITTEN_SUFFIX,
  RECOVERY_OPERATIONS,
  RECOVERY_OPERATION_NAMES,
  RECOVERY_REFUSAL_CODES,
  RECOVERY_REFUSED_EXIT,
  RECOVERY_REQUEST_FIELDS,
  RECOVERY_REQUEST_FILE,
  RECOVERY_REQUEST_MARKER,
  RECOVERY_REQUEST_MAX_BYTES,
  RECOVERY_UNCONFIRMED_SUFFIX,
  RECOVERY_WEDGED_CODES,
  RECOVERY_WEDGED_EXIT,
  consumeRecoveryRequest,
  recoveryPaths,
  recoveryRefusal,
  recoveryRefusalExit,
  recoveryRefusalLine,
  runRecoveryRequest,
} from "../service/recovery-request.mjs";
import { reconcileDanglingAttempt as reviewedOperation } from "../reconcile-dangling.mjs";

const REQUEST_ID = "3f2b19c4-6d51-4a8e-9b03-72c1ee40d95a";
const SECOND_REQUEST_ID = "8ae2d70f-51c6-4b93-a1d4-0c7f6e2b3a55";
const FOREIGN_ATTEMPT = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const TICK_ARGV = ["--activation", ACTIVATION_FILE];

function validRequest(overrides = {}) {
  return {
    request: RECOVERY_REQUEST_MARKER,
    operation: "reconcile-dangling",
    request_id: REQUEST_ID,
    attempt_id: DANGLING,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    ...overrides,
  };
}

// A real private state directory, exactly as the unit's
// Environment=SHU_WORKSPACE_STATE_DIR= supplies one.
function stateDir(t) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "shu140-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An operator's request, written the way the documented command writes it:
// create private, then rename into place.
function placeRequest(dir, body, { mode = 0o600, file = RECOVERY_REQUEST_FILE } = {}) {
  const target = nodePath.join(dir, file);
  const staged = `${target}.staging`;
  fs.writeFileSync(staged, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  fs.chmodSync(staged, mode);
  fs.renameSync(staged, target);
  return target;
}

const consumedRecord = (dir, id) => nodePath.join(dir, RECOVERY_CONSUMED_DIR, `${id}.json`);
const requestPresent = (dir) => fs.existsSync(nodePath.join(dir, RECOVERY_REQUEST_FILE));

// A spy that answers like a successful recovery and records exactly how it was
// called. Every refusal proof asserts this was never reached.
function operationSpy(answer = (args) => ({ ok: true, action: "TERMINALIZED", attempt_id: args.attempt_id, stage: "HOLD" })) {
  const calls = [];
  const spy = async (args) => { calls.push(args); return answer(args); };
  spy.calls = calls;
  return spy;
}

test("SHU-140 recovery-request: with no request present the tick runs unchanged, dry-run semantics intact, and nothing is read, consumed or written", async (t) => {
  const dir = stateDir(t);
  const env = { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false" };

  // The recovery branch's entire contribution to an ordinary wake.
  const lines = [];
  assert.deepEqual(await runRecoveryRequest({ env, io: {}, out: (l) => lines.push(l) }), { present: false, exitCode: null });
  assert.deepEqual(lines, [], "an ordinary wake must say nothing about recovery");
  assert.deepEqual(fs.readdirSync(dir), [], "an ordinary wake must create nothing, not even the consumed ledger");

  // ...and the tick itself receives exactly the arguments it always did. With
  // dispatch off that is the empty argv, which is what makes the tick read-only.
  const ticks = [];
  const entry = (e) => coordinatorEntry(TICK_ARGV, e, {
    tick: (args, passed) => { ticks.push({ args, passed }); return 0; },
    stdout: (l) => lines.push(l),
  });
  assert.equal(await entry(env), 0);
  assert.deepEqual(ticks.at(-1).args, [], "dispatch-off ticks must still be invoked with no activation argv");
  assert.equal(ticks.at(-1).passed, env, "the tick must receive the unmodified environment");
  assert.deepEqual(ticks.at(-1).args, coordinatorTickArgs(TICK_ARGV, env), "the entry must pass through exactly coordinatorTickArgs");

  // The pass-through is unconditional, so the dispatch-on argv is unchanged too.
  const armed = { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "true" };
  assert.equal(await entry(armed), 0);
  assert.deepEqual(ticks.at(-1).args, TICK_ARGV);
  assert.deepEqual(ticks.at(-1).args, coordinatorTickArgs(TICK_ARGV, armed));

  // The tick's own exit code is returned verbatim, never reinterpreted.
  for (const code of [0, 2, 1]) {
    assert.equal(await coordinatorEntry(TICK_ARGV, env, { tick: () => code, stdout: (l) => lines.push(l) }), code);
  }

  // No state directory means no channel at all — never a guessed path.
  for (const blind of [{}, { SHU_WORKSPACE_STATE_DIR: "" }, { SHU_WORKSPACE_STATE_DIR: "relative/state" }]) {
    assert.equal(recoveryPaths(blind), null, `${JSON.stringify(blind)} must expose no request path`);
    assert.deepEqual(consumeRecoveryRequest({ env: blind }), { present: false });
  }

  // The argv contract is still checked FIRST: a drifted ExecStart fails before
  // anything is read or consumed.
  await assert.rejects(async () => coordinatorEntry(["--activation", "/not/the/activation.json"], env, {
    tick: () => { throw new Error("the tick must not run"); },
    recovery: () => { throw new Error("recovery must not be consulted before the argv contract"); },
  }), /ACT_ACTIVATION_PATH/);
  assert.deepEqual(fs.readdirSync(dir), [], "a refused argv must leave the state directory untouched");
  assert.deepEqual(lines, [], "nothing on this path may print a recovery line");
});

test("SHU-140 recovery-request: a valid single-use request runs ONLY the reviewed recovery, bound to exactly that attempt, and the tick does not run", async (t) => {
  const dir = stateDir(t);
  const env = { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false" };
  placeRequest(dir, validRequest());

  const spy = operationSpy();
  const lines = [];
  const exit = await coordinatorEntry(TICK_ARGV, env, {
    tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
    stdout: (l) => lines.push(l),
    recoveryIo: { operation: spy },
  });

  assert.equal(exit, 0);
  // EXACT BINDING: one call, this attempt, and no other argument that could
  // widen it — no argv, no scope, no adapter, no target.
  assert.equal(spy.calls.length, 1, "exactly one operation invocation");
  assert.deepEqual(Object.keys(spy.calls[0]).sort(), ["attempt_id", "env", "io", "now"]);
  assert.equal(spy.calls[0].attempt_id, DANGLING);
  assert.deepEqual(spy.calls[0].io, {}, "production runs inject nothing: every probe is the reviewed default");
  assert.equal(spy.calls[0].env, env);
  assert.equal(spy.calls[0].now, undefined, "the operation keeps its own single injected clock");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^RECOVERY_TERMINALIZED attempt=7f3a1c20-9b44-4d17-8c02-6e5a1d4b9f83 stage=HOLD slot=released authorization_ref=FIXTURE-OPUS-CONTRACT-20260905 request_id=3f2b19c4-6d51-4a8e-9b03-72c1ee40d95a$/);

  // Consumed: the request is gone and its id is recorded, canonically and with
  // no timestamp — journald records when, and no clock decides validity.
  assert.equal(requestPresent(dir), false, "the request must be consumed");
  assert.deepEqual(JSON.parse(fs.readFileSync(consumedRecord(dir, REQUEST_ID), "utf8")), validRequest());
  assert.equal(fs.statSync(consumedRecord(dir, REQUEST_ID)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), [RECOVERY_CONSUMED_DIR], "nothing else may be created");

  // ...and end to end through the REAL reviewed operation: the dangling chain is
  // terminalized, the slot is released, and only `status` ever reaches the
  // supervisor.
  const live = stateDir(t);
  placeRequest(live, validRequest({ request_id: SECOND_REQUEST_ID }));
  const world = cleanWorld();
  assert.equal(activeSlots(world.receiptsOnDisk), 1);
  const endToEnd = [];
  const liveExit = await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: live, ENABLE_DISPATCH: "false" }, {
    tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
    stdout: (l) => endToEnd.push(l),
    recoveryIo: { operationIo: world, now: () => NOW },
  });
  assert.equal(liveExit, 0);
  assert.equal(world.posted.length, 1, "exactly one Linear comment");
  assert.equal(world.posted[0].receipt.attempt_id, DANGLING);
  assert.equal(resolveChain(world.receiptsOnDisk, DANGLING).stage, "HOLD");
  assert.equal(activeSlots([resolveChain(world.receiptsOnDisk, DANGLING)]), 0, "the slot must be released");
  assert.deepEqual(world.supervisorRequests, [{ operation: "status", attempt_id: DANGLING }]);
  assert.match(endToEnd.at(-1), /^RECOVERY_TERMINALIZED attempt=.* stage=HOLD slot=released /);
});

test("SHU-140 recovery-request: the request is single-use — a replayed request_id refuses REQUEST_REPLAYED, and a fresh request for a terminalized attempt refuses ALREADY_TERMINAL, neither writing", async (t) => {
  const dir = stateDir(t);
  const env = { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false" };
  const world = cleanWorld();
  const lines = [];
  const run = (io = {}) => coordinatorEntry(TICK_ARGV, env, {
    tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
    stdout: (l) => lines.push(l),
    recoveryIo: { operationIo: world, now: () => NOW, ...io },
  });

  // First use: terminalized, one write.
  placeRequest(dir, validRequest());
  assert.equal(await run(), 0);
  assert.equal(world.posted.length, 1);
  assert.equal(requestPresent(dir), false);

  // The consumed file alone does not re-run anything: the next wake is an
  // ordinary tick again, so a refusal can never wedge the timer.
  const ticks = [];
  assert.equal(await coordinatorEntry(TICK_ARGV, env, { tick: (args) => { ticks.push(args); return 0; }, stdout: (l) => lines.push(l) }), 0);
  assert.deepEqual(ticks, [[]]);

  // REPLAY: the same request_id presented again loses the O_EXCL create and is
  // refused by name, having run nothing at all.
  const spy = operationSpy();
  placeRequest(dir, validRequest());
  assert.equal(await run({ operation: spy }), RECOVERY_REFUSED_EXIT);
  assert.equal(spy.calls.length, 0, "a replayed request must not reach the operation");
  assert.match(lines.at(-1), /^RECOVERY_REFUSED: REQUEST_REPLAYED — request 3f2b19c4-6d51-4a8e-9b03-72c1ee40d95a was already consumed/);
  assert.match(lines.at(-1), /nothing written, slot preserved$/);
  assert.equal(requestPresent(dir), false, "a replayed request is consumed too, so the timer returns to ordinary ticks");
  assert.equal(world.posted.length, 1, "no second write");

  // A FRESH request_id for the same, now terminal, attempt is idempotent: the
  // reviewed operation reads terminality from the durable chain before any
  // supervisor contact and refuses ALREADY_TERMINAL without writing.
  const contactsBefore = world.supervisorRequests.length;
  placeRequest(dir, validRequest({ request_id: SECOND_REQUEST_ID }));
  assert.equal(await run(), RECOVERY_REFUSED_EXIT);
  assert.match(lines.at(-1), /^RECONCILE_REFUSED: ALREADY_TERMINAL — attempt .* is already HOLD; nothing written, slot preserved$/);
  assert.equal(world.posted.length, 1, "a second use must write nothing");
  assert.equal(world.supervisorRequests.length, contactsBefore, "a second use must not contact the supervisor");
  assert.equal(requestPresent(dir), false);
  assert.ok(fs.existsSync(consumedRecord(dir, SECOND_REQUEST_ID)), "a refused request is still recorded as spent");

  // Two records, two request ids, one write.
  assert.deepEqual(fs.readdirSync(nodePath.join(dir, RECOVERY_CONSUMED_DIR)).sort(), [`${REQUEST_ID}.json`, `${SECOND_REQUEST_ID}.json`].sort());
});

test("SHU-140 recovery-request: a foreign, malformed, unauthorized or insecure request is refused BY NAME, consumed, and never reaches the operation", async (t) => {
  const cases = [
    ["not JSON at all", "{ this is not json", "REQUEST_MALFORMED", /not parseable JSON/],
    ["a JSON array", "[]", "REQUEST_MALFORMED", /not a JSON object/],
    ["a missing field", (() => { const r = validRequest(); delete r.authorization_ref; return r; })(), "REQUEST_MALFORMED", /exactly the fields/],
    ["a smuggled extra field", { ...validRequest(), enable_dispatch: true }, "REQUEST_MALFORMED", /exactly the fields/],
    ["a wrong marker", validRequest({ request: "coordinator-recovery v2" }), "REQUEST_MALFORMED", /request marker/],
    ["a non-UUID request_id", validRequest({ request_id: "request-1" }), "REQUEST_MALFORMED", /request_id must be a UUID/],
    ["a malformed attempt id", validRequest({ attempt_id: "SHU-140" }), "REQUEST_ATTEMPT_INVALID", /attempt_id must be a UUID/],
    ["an upper-case attempt id", validRequest({ attempt_id: DANGLING.toUpperCase() }), "REQUEST_ATTEMPT_INVALID", /attempt_id must be a UUID/],
    ["a submit operation", validRequest({ operation: "submit" }), "REQUEST_OPERATION_UNKNOWN", /only operation this channel can name is reconcile-dangling/],
    ["a dispatch operation", validRequest({ operation: "dispatch" }), "REQUEST_OPERATION_UNKNOWN", /only operation this channel can name is reconcile-dangling/],
    ["a launch operation", validRequest({ operation: "launch" }), "REQUEST_OPERATION_UNKNOWN", /only operation this channel can name is reconcile-dangling/],
    ["free-text authorization", validRequest({ authorization_ref: "because I said so" }), "REQUEST_UNAUTHORIZED", /card ref/],
    ["no authorization", validRequest({ authorization_ref: "" }), "REQUEST_UNAUTHORIZED", /card ref/],
  ];
  for (const [label, body, code, detail] of cases) {
    const dir = stateDir(t);
    placeRequest(dir, body);
    const spy = operationSpy();
    const lines = [];
    const exit = await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false" }, {
      tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
      stdout: (l) => lines.push(l),
      recoveryIo: { operation: spy },
    });
    assert.equal(exit, RECOVERY_REFUSED_EXIT, `${label} must refuse`);
    assert.equal(spy.calls.length, 0, `${label} must never reach the operation`);
    assert.match(lines.at(-1), new RegExp(`^RECOVERY_REFUSED: ${code} `), `${label}: ${lines.at(-1)}`);
    assert.match(lines.at(-1), detail, `${label}: ${lines.at(-1)}`);
    assert.ok(RECOVERY_REFUSAL_CODES.includes(code));
    assert.equal(requestPresent(dir), false, `${label}: the request must still be consumed`);
    // The file's bytes are operator input and must never be echoed.
    if (typeof body === "string") assert.equal(lines.at(-1).includes(body), false, `${label}: the request body must not be echoed`);
  }

  // A world-readable request is refused: 0600 is the contract, not a suggestion.
  for (const mode of [0o644, 0o660, 0o666, 0o700]) {
    const dir = stateDir(t);
    placeRequest(dir, validRequest(), { mode });
    const spy = operationSpy();
    const lines = [];
    assert.equal(await runRecoveryRequest({ env: { SHU_WORKSPACE_STATE_DIR: dir }, io: { operation: spy }, out: (l) => lines.push(l) }).then((r) => r.exitCode), RECOVERY_REFUSED_EXIT);
    assert.match(lines.at(-1), /^RECOVERY_REFUSED: REQUEST_INSECURE — the request is mode 0\d{3}, not 0600/);
    assert.equal(spy.calls.length, 0);
    assert.equal(requestPresent(dir), false);
  }

  // A symlink is not a request, however inviting its target looks.
  const linked = stateDir(t);
  const elsewhere = nodePath.join(linked, "somewhere-else.json");
  fs.writeFileSync(elsewhere, JSON.stringify(validRequest()), { mode: 0o600 });
  fs.symlinkSync(elsewhere, nodePath.join(linked, RECOVERY_REQUEST_FILE));
  const linkLines = [];
  const linkSpy = operationSpy();
  assert.equal((await runRecoveryRequest({ env: { SHU_WORKSPACE_STATE_DIR: linked }, io: { operation: linkSpy }, out: (l) => linkLines.push(l) })).exitCode, RECOVERY_REFUSED_EXIT);
  assert.match(linkLines.at(-1), /^RECOVERY_REFUSED: REQUEST_INSECURE — the request path is a symbolic link/);
  assert.equal(linkSpy.calls.length, 0);
  assert.equal(fs.existsSync(elsewhere), true, "the link's target is somebody else's file and must not be removed");

  // A FOREIGN but well-formed attempt id passes the request layer and is refused
  // by the reviewed operation's own name, having written nothing: the request
  // channel narrows what may be asked, the operation still decides.
  const foreign = stateDir(t);
  placeRequest(foreign, validRequest({ attempt_id: FOREIGN_ATTEMPT }));
  const world = cleanWorld();
  const foreignLines = [];
  assert.equal(await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: foreign, ENABLE_DISPATCH: "false" }, {
    tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
    stdout: (l) => foreignLines.push(l),
    recoveryIo: { operationIo: world, now: () => NOW },
  }), RECOVERY_REFUSED_EXIT);
  assert.match(foreignLines.at(-1), /^RECONCILE_REFUSED: EVIDENCE_MISSING — no durable receipt for attempt 0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d/);
  assert.equal(world.posted.length, 0, "a foreign attempt must not be written for");
  assert.equal(activeSlots(world.receiptsOnDisk), 1, "the real dangling chain's slot must be preserved");
});

test("SHU-140 recovery-request: the recovery path cannot reach dispatch, submit or launch — statically and by construction", async (t) => {
  const moduleUrl = new URL("../service/recovery-request.mjs", import.meta.url);
  const source = fs.readFileSync(moduleUrl, "utf8");

  // (a) The module's static imports are exactly these four, and the only names
  // it takes from the tick module are two validators.
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(specifiers.sort(), ["../reconcile-dangling.mjs", "../reconcile.mjs", "node:fs", "node:path"]);
  assert.match(source, /^import \{ UUID_RE, authorizationRefValid \} from "\.\.\/reconcile\.mjs";$/m);
  assert.match(source, /^import \{ reconcileDanglingAttempt \} from "\.\.\/reconcile-dangling\.mjs";$/m);

  // (b) No dynamic import, and no dispatch/submit/launch vocabulary in the code
  // itself. The launchers are reached ONLY through reconcile.mjs's dynamic
  // import(), which nothing here can perform or name.
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  for (const forbidden of ["import(", "require(", "dispatchModuleFor", "adapterModuleFor", "adapterFor", "preparedLaunchOptions",
    "adapterLaunchOptions", "submitToSupervisor", "signedSupervisorRequest", "supervisorAdapter", "supervisorOrder",
    "store.accept", "schedule(", ".launch(", "adapters/", "child_process", "spawn", "systemctl", "ENABLE_DISPATCH=", "ExecStart"]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} must not appear in the recovery request path`);
  }

  // (c) The transitive STATIC import closure of the recovery entry point
  // contains no adapter and no worker launcher — and adds nothing whatsoever to
  // the closure the reviewed operation already had.
  const closureOf = (entry) => {
    const seen = new Set();
    const queue = [nodePath.resolve(fileURLToPath(entry))];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const m of text.matchAll(/^import\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["'];?$/gm)) {
        queue.push(nodePath.resolve(nodePath.dirname(file), m[1]));
      }
    }
    return seen;
  };
  const recovery = closureOf(moduleUrl);
  const reviewed = closureOf(new URL("../reconcile-dangling.mjs", import.meta.url));
  assert.ok(recovery.size > 20, `the closure must actually have been walked, got ${recovery.size}`);
  for (const file of recovery) {
    assert.equal(/[/\\]adapters[/\\]/.test(file), false, `${file} is an adapter and must not be statically reachable`);
    assert.equal(file.endsWith("supervisor-worker.mjs"), false, `${file} forks workers and must not be statically reachable`);
    assert.equal(file.endsWith("capacity-scheduler.mjs"), false, `${file} schedules launches and must not be statically reachable`);
  }
  assert.deepEqual([...recovery].filter((f) => !reviewed.has(f)), [nodePath.resolve(fileURLToPath(moduleUrl))],
    "the recovery entry point must add NOTHING to the reviewed operation's static closure but itself");

  // (d) By construction: the operation table is frozen, has exactly one entry,
  // and that entry IS the reviewed operation. It cannot be extended at run time.
  assert.deepEqual(RECOVERY_OPERATION_NAMES, ["reconcile-dangling"]);
  assert.equal(Object.keys(RECOVERY_OPERATIONS).length, 1);
  assert.equal(RECOVERY_OPERATIONS["reconcile-dangling"], reviewedOperation);
  assert.ok(Object.isFrozen(RECOVERY_OPERATIONS) && Object.isFrozen(RECOVERY_OPERATION_NAMES) && Object.isFrozen(RECOVERY_REQUEST_FIELDS));
  assert.throws(() => { RECOVERY_OPERATIONS.submit = () => { throw new Error("unreachable"); }; }, TypeError);
  assert.throws(() => { RECOVERY_OPERATION_NAMES.push("dispatch"); }, TypeError);
  assert.equal(RECOVERY_OPERATIONS.submit, undefined);

  // (e) The one operation it can reach still signs `status` and nothing else —
  // supervisor.mjs submit()'s status branch returns before store.accept() and
  // before schedule(launch), so a submit would mint a slot, a receipt, a launch
  // marker and a child process.
  await assert.rejects(
    async () => sendSupervisorStatus({
      receipt: resolveChain(danglingChain(), DANGLING),
      env: { SHU_SUPERVISOR_SECRET: "s".repeat(64) },
      transport: async () => ({}),
      operation: "submit",
    }),
    /may only send the supervisor `status` operation/,
  );

  // (f) By construction at the entry point: with a request present the tick is
  // never invoked, and with no request the recovery operation is never invoked.
  const withRequest = stateDir(t);
  placeRequest(withRequest, validRequest());
  const spy = operationSpy();
  await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: withRequest, ENABLE_DISPATCH: "false" }, {
    tick: () => { throw new Error("REACHED THE TICK"); },
    stdout: () => {},
    recoveryIo: { operation: spy },
  });
  assert.equal(spy.calls.length, 1);
  const withoutRequest = stateDir(t);
  const idle = operationSpy();
  await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: withoutRequest, ENABLE_DISPATCH: "false" }, {
    tick: () => 0,
    stdout: () => { throw new Error("an ordinary wake must print no recovery line"); },
    recoveryIo: { operation: idle },
  });
  assert.equal(idle.calls.length, 0);
});

test("SHU-140 recovery-request: ENABLE_DISPATCH=false and the timer-disabled state are preserved across the invocation, and dispatch-on refuses outright", async (t) => {
  const dir = stateDir(t);
  const env = { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false", SHU_SUPERVISOR_SOCKET: "/nonexistent.sock" };
  const before = JSON.stringify(env);
  const processDispatchBefore = process.env.ENABLE_DISPATCH;
  placeRequest(dir, validRequest());

  const world = cleanWorld();
  const lines = [];
  assert.equal(await coordinatorEntry(TICK_ARGV, env, {
    tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
    stdout: (l) => lines.push(l),
    recoveryIo: { operationIo: world, now: () => NOW },
  }), 0);

  // The environment the service runs under is not touched, in either direction.
  assert.equal(JSON.stringify(env), before, "the recovery must not mutate the service environment");
  assert.equal(env.ENABLE_DISPATCH, "false");
  assert.equal(process.env.ENABLE_DISPATCH, processDispatchBefore, "the process environment must be untouched");

  // Nothing is armed: the only filesystem effect is the consumed ledger inside
  // the service's own private state directory.
  assert.deepEqual(fs.readdirSync(dir).sort(), [RECOVERY_CONSUMED_DIR]);
  assert.deepEqual(fs.readdirSync(nodePath.join(dir, RECOVERY_CONSUMED_DIR)), [`${REQUEST_ID}.json`]);
  assert.equal(world.posted.length, 1, "exactly one Linear comment and no other effect");

  // The reviewed operation is handed the dispatch-off environment unchanged, so
  // nothing downstream can read a different posture than the unit declares.
  assert.equal(await coordinatorEntry(TICK_ARGV, env, { tick: (args) => (args.length === 0 ? 0 : 1), stdout: (l) => lines.push(l) }), 0,
    "the next ordinary wake is still a dispatch-off, no-activation tick");

  // ...and a request that arrives while dispatch is ARMED is refused by name,
  // consumed, and never run: recovery is a dispatch-off posture operation.
  const armedDir = stateDir(t);
  placeRequest(armedDir, validRequest({ request_id: SECOND_REQUEST_ID }));
  const spy = operationSpy();
  const armedLines = [];
  assert.equal(await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: armedDir, ENABLE_DISPATCH: "true" }, {
    tick: () => { throw new Error("the tick must not run when a recovery request is present"); },
    stdout: (l) => armedLines.push(l),
    recoveryIo: { operation: spy },
  }), RECOVERY_REFUSED_EXIT);
  assert.match(armedLines.at(-1), /^RECOVERY_REFUSED: REQUEST_DISPATCH_ENABLED — ENABLE_DISPATCH is true; recovery runs only with dispatch off and the timer disabled/);
  assert.equal(spy.calls.length, 0);
  assert.equal(requestPresent(armedDir), false);

  // A refusal exits 2, which the unit lists in SuccessExitStatus=, so a correct
  // refusal cannot trip Restart=on-failure into StartLimitBurst= and leave the
  // unit failed. Nothing here starts, enables or arms a unit or a timer.
  assert.equal(RECOVERY_REFUSED_EXIT, 2);
  const unit = fs.readFileSync(new URL("../service/shu-coordinator.service.in", import.meta.url), "utf8");
  assert.match(unit, /^SuccessExitStatus=2$/m);
  assert.match(unit, /^Environment=ENABLE_DISPATCH=false$/m);
  assert.match(unit, /^ExecStart=@COORDINATOR_EXEC@$/m, "the reviewed ExecStart is unchanged: no one-off run is installed");
});
// ---------------------------------------------------------------------------
// SHU-140 — the OPERATOR REQUESTER, and the documentation pinned to the code.
//
// CodeRabbit #174 (inline 4105414868) caught RECONCILE-DANGLING.md documenting
// `STATE_DIR=/srv/shu/state` while the unit exports
// SHU_WORKSPACE_STATE_DIR=/srv/shu/state/workspaces. An operator following that
// command literally wrote /srv/shu/state/recovery-request.json, the entry
// point's single open() on $SHU_WORKSPACE_STATE_DIR/recovery-request.json still
// failed ENOENT, the wake was an ordinary dry-run tick, and NOTHING said a
// request had been missed — a confident silent failure.
//
// Correcting the documented literal fixed that day's value. It did NOT close
// the failure mode: the next hand-typed directory is just as free to be wrong,
// and the wrongness is still invisible. request-recovery.mjs closes it at the
// source — the operator supplies no directory at all, the command OBTAINS the
// unit's own, and a disagreement is refused BY NAME before any file exists.
//
// No clock, no wall time, no host systemd: the unit read is injected.
import { WORKSPACE_STATE_DIR } from "../service/units.mjs";
import {
  REQUEST_REFUSED_EXIT,
  REQUEST_USAGE_EXIT,
  REQUEST_WRITTEN_PREFIX,
  UNIT_ENVIRONMENT_COMMAND,
  main as requestRecoveryMain,
  parseUnitEnvironment,
  unitStateDir,
} from "../service/request-recovery.mjs";

const DOCUMENTED_ATTEMPT = "9c461519-4bc8-4e75-8d65-d61b8954e1f0";

// A world with BOTH directories real on disk: the unit's own, and the wrong one
// from #174 that sits right next to it. Every case below proves something about
// which of the two ends up holding a file.
function requesterWorld(label) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `shu140-requester-${label}-`));
  const unit = nodePath.join(root, "state", "workspaces");
  const wrong = nodePath.join(root, "state");
  fs.mkdirSync(unit, { recursive: true });
  const calls = [];
  const execFor = (stdout, overrides = {}) => (command, args) => {
    calls.push([command, args]);
    if (overrides.throws) throw Object.assign(new Error("no systemctl"), { code: "ENOENT" });
    return { status: 0, stdout, stderr: "", ...overrides };
  };
  return {
    root, unit, wrong, calls, execFor,
    request: (dir) => recoveryPaths({ SHU_WORKSPACE_STATE_DIR: dir }).request,
    entries: (dir) => fs.readdirSync(dir).sort(),
    // The deployed unit's real answer shape: several assignments on one line.
    deployed: (dir = unit) =>
      `ENABLE_DISPATCH=false SHU_SUPERVISOR_SOCKET=/run/shu/supervisor.sock SHU_WORKSPACE_STATE_DIR=${dir}\n`,
  };
}

function runRequester(argv, env, io) {
  const out = [];
  const err = [];
  const exitCode = requestRecoveryMain(argv, env, { ...io, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { exitCode, out, err };
}

// (1) POSITIVE. The request lands at exactly the unit-configured path, 0600, and
// nowhere else — and the SERVICE SIDE really consumes it, so "written" means
// "the tick will see it", not "a file exists somewhere".
test("SHU-140 request-recovery: the request is written 0600 at exactly the unit's own $SHU_WORKSPACE_STATE_DIR/recovery-request.json and nowhere else", () => {
  const world = requesterWorld("positive");
  const before = world.entries(world.wrong);

  const run = runRequester(
    ["--attempt", DOCUMENTED_ATTEMPT, "--authorization-ref", "SHU-140", "--request-id", REQUEST_ID],
    {},
    { exec: world.execFor(world.deployed()) },
  );

  // (a) It asked the DEPLOYED UNIT, with exactly the reviewed read command, and
  // asked it exactly once. This is where the directory came from.
  assert.deepEqual(world.calls, [["systemctl", ["show", "-p", "Environment", "--value", "shu-coordinator.service"]]]);
  assert.deepEqual([...UNIT_ENVIRONMENT_COMMAND], ["systemctl", "show", "-p", "Environment", "--value", "shu-coordinator.service"]);

  // (b) Success, and the ONLY thing printed is the path it created.
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.err, []);
  assert.deepEqual(run.out, [`${REQUEST_WRITTEN_PREFIX}${world.request(world.unit)}`]);

  // (c) EXACTLY the unit's path, mode 0600, and no staging residue beside it.
  assert.deepEqual(world.entries(world.unit), [RECOVERY_REQUEST_FILE]);
  assert.equal(fs.statSync(world.request(world.unit)).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(world.request(world.unit)).isFile(), true);

  // (d) NOWHERE ELSE: the neighbouring wrong directory is untouched.
  assert.deepEqual(world.entries(world.wrong), before);
  assert.equal(before.includes(RECOVERY_REQUEST_FILE), false);

  // (e) The bytes are exactly the five reviewed fields the service side accepts.
  const written = JSON.parse(fs.readFileSync(world.request(world.unit), "utf8"));
  assert.deepEqual(Object.keys(written).sort(), [...RECOVERY_REQUEST_FIELDS].sort());
  assert.equal(written.request, RECOVERY_REQUEST_MARKER);
  assert.equal(written.operation, RECOVERY_OPERATION_NAMES[0]);
  assert.equal(written.attempt_id, DOCUMENTED_ATTEMPT);
  assert.equal(written.authorization_ref, "SHU-140");
  assert.equal(written.request_id, REQUEST_ID);

  // (f) A SECOND INVOCATION DOES NOT SILENTLY REPLACE A PENDING REQUEST. The
  // channel is one slot, so `mv -f` would drop the first request with no signal
  // while still printing REQUEST_WRITTEN — the same silent loss this command
  // exists to prevent. It refuses REQUEST_PENDING and the first request stands.
  const second = runRequester(
    ["--attempt", FOREIGN_ATTEMPT, "--authorization-ref", "SHU-140", "--request-id", SECOND_REQUEST_ID],
    {},
    { exec: world.execFor(world.deployed()) },
  );
  assert.equal(second.exitCode, REQUEST_REFUSED_EXIT);
  assert.deepEqual(second.out, [], "a replaced request must never be reported as written");
  assert.match(second.err[0], /^RECOVERY_REQUEST_REFUSED: REQUEST_PENDING — /);
  assert.deepEqual(world.entries(world.unit), [RECOVERY_REQUEST_FILE], "no staging residue from the refused second request");
  assert.equal(JSON.parse(fs.readFileSync(world.request(world.unit), "utf8")).attempt_id, DOCUMENTED_ATTEMPT,
    "the pending request is untouched: the first attempt still owns the slot");

  // (g) THE HANDSHAKE ITSELF: the reader consumes what this writer produced.
  const taken = consumeRecoveryRequest({ env: { SHU_WORKSPACE_STATE_DIR: world.unit } });
  assert.equal(taken.present, true);
  assert.equal(taken.refusal, undefined, `the service side must accept the request this command writes: ${taken.refusal?.refusal ?? ""}`);
  assert.equal(taken.request.attempt_id, DOCUMENTED_ATTEMPT);
});

// (2) THE NEGATIVE THAT MATTERS. A mismatched directory cannot produce anything
// an operator could read as a successful request: the refusal is BY NAME, it
// happens before any file exists, neither path holds a request or a staging
// file afterwards, and no tick — then or later — can see one.
test("SHU-140 request-recovery: a mismatched state directory refuses STATE_DIR_MISMATCH before any file is created, leaving no request at either path and nothing a tick could see", async () => {
  const world = requesterWorld("mismatch");
  const argv = ["--attempt", DOCUMENTED_ATTEMPT, "--authorization-ref", "SHU-140", "--request-id", REQUEST_ID];

  // The two ways a wrong directory reaches this command: typed as a flag, and
  // inherited from the invoking environment. Both are SUPPLIED, so both are only
  // ever checked against the unit's own value.
  const supplied = [
    ["--state-dir", [...argv, "--state-dir", world.wrong], {}],
    ["the environment", argv, { SHU_WORKSPACE_STATE_DIR: world.wrong }],
  ];

  for (const [origin, commandLine, env] of supplied) {
    const run = runRequester(commandLine, env, { exec: world.execFor(world.deployed()) });

    // (a) REFUSED BY NAME, and NOTHING that reads as success. No REQUEST_WRITTEN
    // line at all — this is the difference between a misrouted request and a
    // refused one.
    assert.equal(run.exitCode, REQUEST_REFUSED_EXIT, `${origin}: a mismatch must refuse`);
    assert.deepEqual(run.out, [], `${origin}: a refusal must print nothing on stdout`);
    assert.equal(run.err.length, 1, `${origin}: exactly one named refusal line`);
    assert.match(run.err[0], /^RECOVERY_REQUEST_REFUSED: STATE_DIR_MISMATCH — /, `${origin}: refused by name`);
    assert.match(run.err[0], /nothing written$/);
    // The named repair is in the line: both directories, and the real one.
    assert.ok(run.err[0].includes(world.wrong) && run.err[0].includes(world.unit), `${origin}: the refusal must name both directories`);

    // (b) NO FILE ANYWHERE. Not at the supplied path, not at the unit's path, and
    // no staging residue at either — the refusal happened before any create.
    for (const [what, dir] of [["the supplied", world.wrong], ["the unit's", world.unit]]) {
      const entries = world.entries(dir);
      assert.equal(entries.includes(RECOVERY_REQUEST_FILE), false, `${origin}: no request at ${what} path`);
      assert.deepEqual(entries.filter((e) => e.endsWith(".staging")), [], `${origin}: no staging residue at ${what} path`);
    }
    assert.deepEqual(world.entries(world.unit), [], `${origin}: the unit's state directory is byte-for-byte as it was`);

    // (c) NOTHING A TICK COULD SEE. The reader, asked about either directory,
    // finds no request — so the wake stays an ordinary tick in both worlds.
    for (const dir of [world.unit, world.wrong]) {
      assert.deepEqual(consumeRecoveryRequest({ env: { SHU_WORKSPACE_STATE_DIR: dir } }), { present: false });
    }
  }

  // (d) And the unit's own entry point, run for real against the unit's state
  // directory, takes the ORDINARY TICK branch: the recovery operation is never
  // reached, because there is no request to reach it with.
  const ticks = [];
  const exit = await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: world.unit, ENABLE_DISPATCH: "false" }, {
    tick: (args) => { ticks.push(args); return 0; },
    operation: () => { throw new Error("the recovery operation must be unreachable after a refused request"); },
    stdout: () => { throw new Error("an ordinary wake emits no RECOVERY_ line"); },
  });
  assert.equal(exit, 0);
  assert.deepEqual(ticks, [[]], "dispatch-off ordinary wake, byte-identical argv");
});

// (3) NEGATIVE. If the unit's value cannot be OBTAINED or cannot be PARSED, the
// directory is unknown — never guessed, never defaulted — and nothing is written.
test("SHU-140 request-recovery: an unobtainable or unparseable unit SHU_WORKSPACE_STATE_DIR refuses STATE_DIR_UNKNOWN and writes nothing", () => {
  const world = requesterWorld("unknown");
  const argv = ["--attempt", DOCUMENTED_ATTEMPT, "--authorization-ref", "SHU-140", "--request-id", REQUEST_ID];

  const unobtainable = [
    ["systemctl is not installed", { throws: true }, ""],
    ["systemctl exited non-zero", { status: 1 }, ""],
    ["systemctl was killed", { status: null }, ""],
    ["no stdout at all", { stdout: undefined }, undefined],
    ["the unit declares no such variable", {}, "ENABLE_DISPATCH=false SHU_SUPERVISOR_SOCKET=/run/shu/supervisor.sock\n"],
    ["an empty Environment block", {}, "\n"],
    ["an unterminated quoted value", {}, `SHU_WORKSPACE_STATE_DIR="${world.unit}\n`],
    ["a malformed assignment", {}, `SHU_WORKSPACE_STATE_DIR\n`],
    ["a stray backslash", {}, `SHU_WORKSPACE_STATE_DIR=${world.unit}\\x\n`],
    ["the variable declared twice", {}, `SHU_WORKSPACE_STATE_DIR=${world.unit} SHU_WORKSPACE_STATE_DIR=${world.wrong}\n`],
    ["a relative value", {}, "SHU_WORKSPACE_STATE_DIR=srv/shu/state/workspaces\n"],
    ["an unnormalised value", {}, "SHU_WORKSPACE_STATE_DIR=/srv/shu/state/../state/workspaces\n"],
  ];

  for (const [why, overrides, stdout] of unobtainable) {
    const run = runRequester(argv, {}, { exec: world.execFor(stdout, overrides) });
    assert.equal(run.exitCode, REQUEST_REFUSED_EXIT, `${why}: must refuse`);
    assert.deepEqual(run.out, [], `${why}: nothing that reads as success`);
    assert.equal(run.err.length, 1, `${why}: exactly one named refusal line`);
    assert.match(run.err[0], /^RECOVERY_REQUEST_REFUSED: STATE_DIR_UNKNOWN — /, `${why}: refused by name`);
    // NOTHING WRITTEN, in either directory, including no staging residue.
    assert.deepEqual(world.entries(world.unit), [], `${why}: the unit's directory must stay empty`);
    assert.deepEqual(world.entries(world.wrong).filter((e) => e !== "workspaces"), [], `${why}: the neighbouring directory must stay empty`);
    for (const dir of [world.unit, world.wrong]) {
      assert.deepEqual(consumeRecoveryRequest({ env: { SHU_WORKSPACE_STATE_DIR: dir } }), { present: false }, `${why}: no tick can see a request`);
    }
  }

  // The parser itself: what it accepts, and that "I could not read it" is null —
  // never an empty environment that would read as "the variable is simply absent
  // for a good reason". Both land on STATE_DIR_UNKNOWN above; they are separated
  // here so a regression names which half broke.
  assert.deepEqual(parseUnitEnvironment('A=1 B="two words" C=x'), [["A", "1"], ["B", "two words"], ["C", "x"]]);
  assert.deepEqual(parseUnitEnvironment(""), []);
  assert.equal(parseUnitEnvironment('A="unterminated'), null);
  assert.equal(parseUnitEnvironment("=novalue"), null);
  assert.equal(parseUnitEnvironment(undefined), null);
  assert.equal(unitStateDir(`SHU_WORKSPACE_STATE_DIR=${WORKSPACE_STATE_DIR}`).stateDir, WORKSPACE_STATE_DIR);
  assert.equal(unitStateDir("ENABLE_DISPATCH=false").ok, false);

  // Bad usage is a USAGE error, not a refusal, and still writes nothing: an
  // unknown flag can never be quietly ignored into a request.
  for (const bad of [[], ["--attempt", DOCUMENTED_ATTEMPT], ["--attempt", DOCUMENTED_ATTEMPT, "--authorization-ref", "SHU-140", "--enable-dispatch", "true"],
    ["--attempt", DOCUMENTED_ATTEMPT, "--attempt", DOCUMENTED_ATTEMPT, "--authorization-ref", "SHU-140"]]) {
    const run = runRequester(bad, {}, { exec: world.execFor(world.deployed()) });
    assert.equal(run.exitCode, REQUEST_USAGE_EXIT, `${bad.join(" ")}: bad usage exits 2`);
    assert.deepEqual(run.out, []);
    assert.deepEqual(world.entries(world.unit), []);
  }
});

// (4) The OPERATOR DOCUMENTATION is pinned to the code's own constant — and the
// doc must no longer ask the operator to supply a directory at all, because that
// question is what #174 got wrong and what nobody can get wrong twice.
test("SHU-140 recovery-request: the documented request path is the code's WORKSPACE_STATE_DIR, the operator is never asked to supply a state directory, and the doc names the silent-ignore trap", () => {
  const doc = fs.readFileSync(new URL("../RECONCILE-DANGLING.md", import.meta.url), "utf8");

  // (a) The operator command block exists and is the one we are pinning.
  const section = doc.split("### The operator command")[1];
  assert.ok(section, "RECONCILE-DANGLING.md must still document the operator command");
  const block = section.match(/```sh\n([\s\S]*?)\n```/)?.[1];
  assert.ok(block, "the operator command must still be a fenced sh block");

  // (b) The command is the reviewed requester, still for the same attempt, still
  // running the existing unit afterwards — no timer enable, nothing armed.
  assert.match(block, /node \.github\/coordinator\/service\/request-recovery\.mjs/,
    "the operator must use the reviewed requester, not a hand-rolled write");
  assert.match(block, /--attempt 9c461519-4bc8-4e75-8d65-d61b8954e1f0/, "the documented attempt must be unchanged");
  assert.equal(DOCUMENTED_ATTEMPT, "9c461519-4bc8-4e75-8d65-d61b8954e1f0");
  assert.match(block, /--authorization-ref SHU-140/);
  assert.match(block, /^sudo systemctl start shu-coordinator\.service$/m, "the existing unit is started, unmodified");
  for (const armed of ["systemctl enable", "shu-coordinator.timer", "ENABLE_DISPATCH=true", "--activation", "ExecStart"]) {
    assert.equal(block.includes(armed), false, `the operator command must not ${armed}`);
  }

  // (c) THE POINT OF THIS FIX: the operator is never asked for a directory. No
  // STATE_DIR= to mistype, no --state-dir to pass, and no absolute path in the
  // command at all — the command obtains it from the unit.
  for (const supplied of ["STATE_DIR=", "--state-dir", "/srv/"]) {
    assert.equal(block.includes(supplied), false,
      `the documented command must not ask the operator to supply a state directory (${supplied})`);
  }
  assert.match(section, /systemctl show -p Environment --value shu-coordinator\.service/,
    "the doc must say the command obtains the directory from the deployed unit");
  assert.match(section.replace(/`/g, ""), /only to be checked/,
    "the doc must say --state-dir is only ever checked, never trusted");

  // (d) THE PIN: the absolute path the doc prints is the code's constant,
  // resolved through recoveryPaths() itself rather than a second copy of the
  // join. Change units.mjs or change the doc and this fails.
  const resolved = recoveryPaths({ SHU_WORKSPACE_STATE_DIR: WORKSPACE_STATE_DIR });
  assert.equal(resolved.request, nodePath.join(WORKSPACE_STATE_DIR, RECOVERY_REQUEST_FILE));
  assert.equal(resolved.request, "/srv/shu/state/workspaces/recovery-request.json");
  const printed = [...doc.matchAll(/\/srv\/\S*?recovery-request\.json/g)].map((m) => m[0]);
  assert.ok(printed.length > 0, "the doc must state the absolute request path at least once");
  for (const each of printed) assert.equal(each, resolved.request);
  assert.ok(section.includes(`${REQUEST_WRITTEN_PREFIX}${resolved.request}`),
    "the doc must show the success line with the deployed path the command prints");

  // (e) The prose must state where that value comes from, so a reader can check
  // it against the unit and the source instead of trusting the doc.
  const prose = section.replace(/`/g, "");
  assert.match(prose, /SHU_WORKSPACE_STATE_DIR/, "the doc must name the unit's environment variable");
  assert.match(prose, /WORKSPACE_STATE_DIR from service\/units\.mjs/,
    "the doc must name units.mjs WORKSPACE_STATE_DIR as the origin of the value");

  // (f) The substitution chain the deployed unit uses is unchanged: the template
  // takes SHU_WORKSPACE_STATE_DIR from @WORKSPACE_STATE_DIR@, which is (d)'s
  // constant. Without this, (d) could agree with a constant the unit never sees.
  const unit = fs.readFileSync(new URL("../service/shu-coordinator.service.in", import.meta.url), "utf8");
  assert.match(unit, /^Environment=SHU_WORKSPACE_STATE_DIR=@WORKSPACE_STATE_DIR@$/m);
  assert.match(unit, /^Environment=ENABLE_DISPATCH=false$/m, "the dispatch-off posture is unchanged");
  assert.match(unit, /^ExecStart=@COORDINATOR_EXEC@$/m, "the reviewed ExecStart is unchanged");

  // (g) The trap itself must be written down — in the mechanism AND where the
  // operator types the command — so the failure mode cannot be silent twice, and
  // the refusal codes that close it must be documented by name.
  assert.match(doc, /\$SHU_WORKSPACE_STATE_DIR\/recovery-request\.json/,
    "the doc must state the request path in terms of the environment variable");
  const mechanism = doc.split("### The mechanism")[1].split("### ")[0];
  for (const [label, text] of [["the mechanism", mechanism], ["the operator command", section.split("```")[0]]]) {
    assert.match(text, /silently ignored/, `${label} must say a misplaced request is silently ignored`);
  }
  for (const code of ["STATE_DIR_UNKNOWN", "STATE_DIR_MISMATCH"]) {
    assert.ok(section.includes(`RECOVERY_REQUEST_REFUSED: ${code}`), `the doc must name ${code}`);
  }
});

// ---------------------------------------------------------------------------
// SHU-140 — THE WEDGE. Reviewer BLOCK §B2 on PR #174.
//
// recovery-request.mjs claimed, in its own header and in RECONCILE-DANGLING.md,
// that "a refusal can never wedge the timer into refusing forever — the next wake
// finds no request and is an ordinary tick again". That held only while the object
// at the request path could be unlinked. discard() was best-effort AND its result
// was thrown away on the isFile() branch, so a DIRECTORY at
// $SHU_WORKSPACE_STATE_DIR/recovery-request.json — an operator typo, a `mkdir`, a
// `cp -r`/rsync of a staging tree — made every wake refuse REQUEST_INSECURE and
// exit 2. The tick never ran again; and because the unit lists
// SuccessExitStatus=2, systemd reported the unit as SUCCEEDING, so `systemctl
// status` and `is-failed` both looked healthy while the coordinator had silently
// stopped. With dispatch later armed it would silently never dispatch.
//
// The property these cases pin is not "the wedge cannot happen" — a directory at
// that path is the operator's to create. It is: a request that outlives its own
// refusal is refused BY ITS OWN NAME and exits OUTSIDE the codes the unit calls
// success, so the state is visible instead of silent. The contrast cases below it
// pin the other half, which the original comment got right and which must not
// regress into "everything fails the unit": a refusal the next wake CAN recover
// from still exits 2, and that next wake really does run an ordinary tick.
//
// No clock, no wall time, no systemd, no network: every case is a real directory
// under TMPDIR plus the module's existing io.fsImpl seam.
// ---------------------------------------------------------------------------

// Real fs, with named calls replaced. The module reaches fs.constants through its
// own import, so a seam only has to cover the calls it makes.
function fsSeam(overrides = {}) {
  const seam = {
    openSync: fs.openSync, fstatSync: fs.fstatSync, readFileSync: fs.readFileSync,
    closeSync: fs.closeSync, unlinkSync: fs.unlinkSync, mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
  };
  return { ...seam, ...overrides };
}

// One wake through the real entry point, reporting whether the TICK ran. Wedge or
// not is a property of the unit's actual ExecStart path, not of a helper.
async function wake(dir, { fsImpl, operation = operationSpy(), env = {} } = {}) {
  const lines = [];
  let ticked = false;
  const exitCode = await coordinatorEntry(TICK_ARGV, { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false", ...env }, {
    tick: () => { ticked = true; return 0; },
    stdout: (line) => lines.push(line),
    recoveryIo: { operation, ...(fsImpl ? { fsImpl } : {}) },
  });
  return { exitCode, ticked, line: lines.at(-1) ?? null, operation };
}

test("SHU-140 recovery-request: a request that outlives its refusal is refused REQUEST_UNREMOVABLE and exits OUTSIDE the unit's SuccessExitStatus=, so a permanently-refusing coordinator fails the unit instead of reporting success", async (t) => {
  // (a) THE EXIT CODE IS THE FIX. A wedged refusal must not land on a code the
  // unit calls success, or systemd reports a stopped coordinator as healthy.
  assert.ok(RECOVERY_WEDGED_CODES.includes("REQUEST_UNREMOVABLE"));
  assert.ok(RECOVERY_REFUSAL_CODES.includes("REQUEST_UNREMOVABLE"));
  assert.notEqual(RECOVERY_WEDGED_EXIT, RECOVERY_REFUSED_EXIT,
    "a wedge that exits like an ordinary refusal is exactly the silent failure §B2 found");
  const unit = fs.readFileSync(new URL("../service/shu-coordinator.service.in", import.meta.url), "utf8");
  const success = unit.match(/^SuccessExitStatus=(.*)$/m)?.[1].trim().split(/[\s,]+/) ?? [];
  assert.deepEqual(success, ["2"], "the reviewed unit's success set is unchanged");
  assert.equal(success.includes(String(RECOVERY_WEDGED_EXIT)), false,
    "the wedged exit must NOT be listed as success, or `systemctl is-failed` stays green on a stopped coordinator");
  assert.equal(success.includes(String(RECOVERY_REFUSED_EXIT)), true,
    "an ordinary refusal must still be success: it is correct and must not trip StartLimitBurst=");
  // It is also distinct from the deployed ExecStart's `flock --conflict-exit-code 2`
  // and from a bad-usage 2, so the journal line cannot be mistaken for either.
  assert.equal(RECOVERY_WEDGED_EXIT, 4);

  // (b) A DIRECTORY at the request path. This is §B2's scenario verbatim, and the
  // point is that it stays wedged across wakes AND says so on every one of them.
  const dirAtPath = stateDir(t);
  fs.mkdirSync(nodePath.join(dirAtPath, RECOVERY_REQUEST_FILE));
  for (const nth of [1, 2, 3]) {
    const result = await wake(dirAtPath);
    assert.equal(result.exitCode, RECOVERY_WEDGED_EXIT, `wake ${nth} must fail the unit, not report success`);
    assert.match(result.line, /^RECOVERY_REFUSED: REQUEST_UNREMOVABLE — /, `wake ${nth}: ${result.line}`);
    // The ORIGINAL reason is kept: the operator is told both what was wrong with
    // the object and that it is now refusing every wake.
    assert.match(result.line, /REQUEST_INSECURE was refused/, `wake ${nth} must keep the underlying reason`);
    assert.match(result.line, /could not be removed \(EISDIR\)/, `wake ${nth} must name the unlink failure`);
    assert.match(result.line, /every later wake would refuse it again and the coordinator would never tick/);
    // The path is named, because removing it by hand is the whole repair.
    assert.ok(result.line.includes(nodePath.join(dirAtPath, RECOVERY_REQUEST_FILE)),
      `wake ${nth} must name the path to remove: ${result.line}`);
    assert.equal(result.ticked, false, "the tick must not run when a request is present");
    assert.equal(result.operation.calls.length, 0, "nothing may reach the operation");
    assert.equal(fs.existsSync(nodePath.join(dirAtPath, RECOVERY_CONSUMED_DIR)), false,
      "an unconsumable request must not be recorded as consumed");
  }
  assert.equal(fs.existsSync(nodePath.join(dirAtPath, RECOVERY_REQUEST_FILE)), true,
    "the object is the operator's to remove; the point is that the refusal SAYS so");

  // (c) A SHU_WORKSPACE_STATE_DIR that is not a directory. Same permanent refusal
  // (the open and the unlink both fail ENOTDIR), so it must fail the unit too.
  const notADirParent = stateDir(t);
  const notADir = nodePath.join(notADirParent, "state-dir-is-a-file");
  fs.writeFileSync(notADir, "not a directory", { mode: 0o600 });
  const broken = await wake(notADir);
  assert.equal(broken.exitCode, RECOVERY_WEDGED_EXIT);
  assert.match(broken.line, /^RECOVERY_REFUSED: REQUEST_UNREMOVABLE — REQUEST_UNREADABLE was refused/);
  assert.match(broken.line, /could not be removed \(ENOTDIR\)/);
  assert.equal(broken.ticked, false);

  // (d) THE OTHER HALF OF THE WEDGE: removal failing AFTER the single-use ledger
  // entry is written. The request_id is spent but the file is still there, so the
  // next wake would refuse REQUEST_REPLAYED forever. The refusal must name that,
  // and must tell the operator the id is spent so they issue a new one.
  const spent = stateDir(t);
  placeRequest(spent, validRequest());
  const stubborn = await wake(spent, {
    fsImpl: fsSeam({
      unlinkSync: (target) => {
        if (target === nodePath.join(spent, RECOVERY_REQUEST_FILE)) {
          const error = new Error("EPERM: operation not permitted"); error.code = "EPERM"; throw error;
        }
        return fs.unlinkSync(target);
      },
    }),
  });
  assert.equal(stubborn.exitCode, RECOVERY_WEDGED_EXIT);
  assert.match(stubborn.line, /^RECOVERY_REFUSED: REQUEST_UNREMOVABLE — the consumed request at /);
  assert.match(stubborn.line, /could not be removed \(EPERM\)/);
  assert.match(stubborn.line, new RegExp(`request_id ${REQUEST_ID} is already spent`));
  assert.equal(stubborn.operation.calls.length, 0, "a request that cannot be released must not run the operation");
  assert.equal(fs.existsSync(consumedRecord(spent, REQUEST_ID)), true,
    "the ledger entry precedes removal, so the spent id is durable — that is the fail-closed direction");

  // (e) recoveryRefusalExit() is the single place the mapping lives, and it maps
  // ONLY the wedge away from the refusal exit.
  for (const code of RECOVERY_REFUSAL_CODES) {
    const expected = code === "REQUEST_UNREMOVABLE" ? RECOVERY_WEDGED_EXIT : RECOVERY_REFUSED_EXIT;
    assert.equal(recoveryRefusalExit(recoveryRefusal(code, "detail")), expected, `${code} must exit ${expected}`);
  }
  // An operation's own RECONCILE_REFUSED code is not a wedge: the request was
  // consumed and the next wake ticks.
  assert.equal(recoveryRefusalExit({ code: "ALREADY_TERMINAL" }), RECOVERY_REFUSED_EXIT);
  assert.equal(recoveryRefusalExit(undefined), RECOVERY_REFUSED_EXIT);

  // (f) Nothing here armed anything: no unit edit, no timer, no dispatch.
  assert.match(unit, /^Environment=ENABLE_DISPATCH=false$/m);
  assert.match(unit, /^ExecStart=@COORDINATOR_EXEC@$/m);
});

test("SHU-140 recovery-request: a refusal the next wake can recover from still exits 2 AND really does leave that next wake an ordinary tick, and an oversize request is refused REQUEST_TOO_LARGE before a byte of it is read", async (t) => {
  // (a) EVERY RECOVERABLE REFUSAL, proved recoverable by taking the next wake for
  // real. This is the property the old comment asserted and never tested: it is
  // why the fix above had to be a new refusal name rather than "fail the unit on
  // anything that goes wrong".
  const recoverable = [
    ["an unreadable mode-000 request", (dir) => {
      fs.writeFileSync(nodePath.join(dir, RECOVERY_REQUEST_FILE), JSON.stringify(validRequest()), { mode: 0o000 });
    }, /^RECOVERY_REFUSED: REQUEST_UNREADABLE — the request could not be opened: EACCES/],
    ["a world-readable request", (dir) => placeRequest(dir, validRequest(), { mode: 0o644 }),
      /^RECOVERY_REFUSED: REQUEST_INSECURE — the request is mode 0644, not 0600/],
    ["an unparseable request", (dir) => placeRequest(dir, "{ not json"),
      /^RECOVERY_REFUSED: REQUEST_MALFORMED — the request is not parseable JSON/],
    ["a symlinked request", (dir) => {
      const target = nodePath.join(dir, "elsewhere.json");
      fs.writeFileSync(target, JSON.stringify(validRequest()), { mode: 0o600 });
      fs.symlinkSync(target, nodePath.join(dir, RECOVERY_REQUEST_FILE));
    }, /^RECOVERY_REFUSED: REQUEST_INSECURE — the request path is a symbolic link/],
    ["a smuggled extra field", (dir) => placeRequest(dir, { ...validRequest(), enable_dispatch: true }),
      /^RECOVERY_REFUSED: REQUEST_MALFORMED — the request must carry exactly the fields/],
  ];
  for (const [label, place, expected] of recoverable) {
    const dir = stateDir(t);
    place(dir);
    const first = await wake(dir);
    assert.equal(first.exitCode, RECOVERY_REFUSED_EXIT, `${label} must exit 2, not fail the unit: ${first.line}`);
    assert.notEqual(first.exitCode, RECOVERY_WEDGED_EXIT, `${label} is recoverable and must not be reported as a wedge`);
    assert.match(first.line, expected, `${label}: ${first.line}`);
    assert.equal(first.ticked, false, `${label}: the tick must not run on the wake that refuses`);
    assert.equal(requestPresent(dir), false, `${label}: the request must be gone`);

    // THE NEXT WAKE IS AN ORDINARY TICK. Not "should be" — taken.
    const second = await wake(dir);
    assert.equal(second.ticked, true, `${label}: the next wake must run the tick`);
    assert.equal(second.exitCode, 0, `${label}: the next wake is an ordinary dispatch-off tick`);
    assert.equal(second.line, null, `${label}: an ordinary wake says nothing about recovery`);
  }

  // (b) THE SIZE CAP (reviewer note N2). stat is already in hand from the fstat,
  // so the bytes must never be read: an operator may paste anything into that
  // file, and reading a multi-gigabyte paste into the unit before refusing it is
  // a fault the cap costs one comparison to close.
  assert.equal(RECOVERY_REQUEST_MAX_BYTES, 4096);
  assert.ok(JSON.stringify(validRequest()).length < RECOVERY_REQUEST_MAX_BYTES / 4,
    "a real request is an order of magnitude under the cap");
  const oversize = stateDir(t);
  // Deliberately VALID json for a valid request, padded past the cap: the refusal
  // must be the size, not a shape violation reached after reading it all.
  const padded = { ...validRequest(), authorization_ref: "SHU-140" };
  fs.writeFileSync(nodePath.join(oversize, RECOVERY_REQUEST_FILE),
    `${JSON.stringify(padded)}${" ".repeat(RECOVERY_REQUEST_MAX_BYTES + 1)}`, { mode: 0o600 });
  const reads = [];
  const big = await wake(oversize, {
    fsImpl: fsSeam({ readFileSync: (...args) => { reads.push(args[0]); return fs.readFileSync(...args); } }),
  });
  assert.equal(reads.length, 0, "an oversize request's bytes must NEVER be read into the unit");
  assert.equal(big.exitCode, RECOVERY_REFUSED_EXIT);
  assert.match(big.line, new RegExp(`^RECOVERY_REFUSED: REQUEST_TOO_LARGE — the request is \\d+ bytes, over the ${RECOVERY_REQUEST_MAX_BYTES}-byte cap`));
  assert.equal(big.operation.calls.length, 0);
  assert.equal(requestPresent(oversize), false, "an oversize request is still consumed");
  // Nothing of the file's content reaches the journal: only its size.
  assert.equal(big.line.includes(padded.request_id), false, "the request's bytes must not be echoed");
  // And it is recoverable, like every other refusal that is not the wedge.
  assert.equal((await wake(oversize)).ticked, true);

  // (c) A request exactly AT the cap is still read: the cap is a bound, not an
  // off-by-one that refuses legitimate requests.
  const atCap = stateDir(t);
  const body = JSON.stringify(validRequest());
  fs.writeFileSync(nodePath.join(atCap, RECOVERY_REQUEST_FILE),
    `${body}${" ".repeat(RECOVERY_REQUEST_MAX_BYTES - body.length)}`, { mode: 0o600 });
  assert.equal(fs.statSync(nodePath.join(atCap, RECOVERY_REQUEST_FILE)).size, RECOVERY_REQUEST_MAX_BYTES);
  const exact = await wake(atCap);
  assert.equal(exact.exitCode, 0, `a request at exactly the cap must be accepted: ${exact.line}`);
  assert.equal(exact.operation.calls.length, 1);
  assert.equal(exact.operation.calls[0].attempt_id, DANGLING);
});

test("SHU-140 recovery-request: the uid ownership guard refuses a request the service does not own, consumes it, and writes no ledger entry", async (t) => {
  // Reviewer note N3: this guard was the one surviving mutant — live and correct,
  // but unproved, because a foreign-owned file cannot be created without root.
  // The module's existing io.fsImpl seam is enough: fstat is what the guard reads,
  // and it is read from the OPEN DESCRIPTOR, so this is the real code path.
  assert.equal(typeof process.getuid, "function", "this guard exists on POSIX; the suite runs there");
  const own = process.getuid();
  const foreign = own + 1;

  const dir = stateDir(t);
  placeRequest(dir, validRequest());
  const result = await wake(dir, {
    fsImpl: fsSeam({
      fstatSync: (fd) => {
        const real = fs.fstatSync(fd);
        // Everything else is the truth: a regular file, 0600, its real size. Only
        // the owner differs, so ONLY the ownership guard can be what refuses.
        return { ...real, mode: real.mode, size: real.size, uid: foreign, isFile: () => true };
      },
    }),
  });
  assert.equal(result.exitCode, RECOVERY_REFUSED_EXIT);
  assert.match(result.line, new RegExp(`^RECOVERY_REFUSED: REQUEST_INSECURE — the request is owned by uid ${foreign}, not the service's own uid ${own}`));
  assert.equal(result.operation.calls.length, 0, "a request the service does not own must never reach the operation");
  assert.equal(result.ticked, false);
  // Consumed, but NOT recorded: the ledger records requests that were acted on or
  // could have been, and a foreign-owned file was never a request of ours.
  assert.equal(requestPresent(dir), false, "a foreign-owned request is still consumed");
  assert.equal(fs.existsSync(consumedRecord(dir, REQUEST_ID)), false, "no ledger entry is written for it");
  // It is recoverable: the next wake ticks.
  assert.equal((await wake(dir)).ticked, true);

  // The guard is an EQUALITY on the service's own uid, not a range: a request the
  // service does own, with everything else identical, is accepted.
  const mine = stateDir(t);
  placeRequest(mine, validRequest());
  const accepted = await wake(mine, {
    fsImpl: fsSeam({ fstatSync: (fd) => { const real = fs.fstatSync(fd); return { ...real, mode: real.mode, size: real.size, uid: own, isFile: () => true }; } }),
  });
  assert.equal(accepted.exitCode, 0, `the service's own request must be accepted: ${accepted.line}`);
  assert.equal(accepted.operation.calls.length, 1);
});

test("SHU-140 recovery-request: WRITE_UNCONFIRMED is the one refusal NOT reported as \"nothing written\", and every other refusal still is", async (t) => {
  // Reviewer note N1. WRITE_UNCONFIRMED means the terminal HOLD comment MAY HAVE
  // LANDED and the documented repair is to re-run; appending "nothing written" to
  // it tells the operator the opposite of the truth, on the operator-facing host
  // path where it costs the most.
  assert.equal(RECOVERY_NOTHING_WRITTEN_SUFFIX, "; nothing written, slot preserved");
  assert.match(RECOVERY_UNCONFIRMED_SUFFIX, /NOT confirmed and may have landed/);
  assert.equal(RECOVERY_UNCONFIRMED_SUFFIX.includes("nothing written"), false,
    "the unconfirmed suffix must not contain the claim it exists to avoid");

  // (a) The line builder, per code.
  const unconfirmed = recoveryRefusalLine({
    refusal: "RECONCILE_REFUSED: WRITE_UNCONFIRMED", code: "WRITE_UNCONFIRMED",
    detail: "the terminal HOLD comment did not confirm: socket hang up",
  });
  assert.equal(unconfirmed.includes("nothing written"), false, unconfirmed);
  assert.ok(unconfirmed.endsWith(RECOVERY_UNCONFIRMED_SUFFIX), unconfirmed);
  assert.match(unconfirmed, /^RECONCILE_REFUSED: WRITE_UNCONFIRMED — the terminal HOLD comment did not confirm: socket hang up/);

  // Every OTHER refusal in either vocabulary keeps the literal-truth suffix.
  for (const code of [...RECOVERY_REFUSAL_CODES, "ALREADY_TERMINAL", "EVIDENCE_MISSING", "WORKER_LIVE", "PUSH_RECEIPT_PRESENT"]) {
    const line = recoveryRefusalLine({ refusal: `X: ${code}`, code, detail: "d" });
    assert.ok(line.endsWith(RECOVERY_NOTHING_WRITTEN_SUFFIX), `${code}: ${line}`);
  }
  // A refusal with no code at all is treated as the safe, common case.
  assert.ok(recoveryRefusalLine({ refusal: "X: Y", detail: null }).endsWith(RECOVERY_NOTHING_WRITTEN_SUFFIX));

  // (b) END TO END: the operation's code must TRAVEL, or the branch above is
  // unreachable from the host path this PR adds.
  const dir = stateDir(t);
  placeRequest(dir, validRequest());
  const lines = [];
  const outcome = await runRecoveryRequest({
    env: { SHU_WORKSPACE_STATE_DIR: dir, ENABLE_DISPATCH: "false" },
    out: (line) => lines.push(line),
    io: {
      operation: async () => ({
        ok: false, code: "WRITE_UNCONFIRMED", refusal: "RECONCILE_REFUSED: WRITE_UNCONFIRMED",
        detail: "the terminal HOLD comment did not confirm: socket hang up",
      }),
    },
  });
  assert.equal(outcome.exitCode, RECOVERY_REFUSED_EXIT, "an unconfirmed write is a refusal, not a wedge");
  assert.equal(lines.at(-1).includes("nothing written"), false, lines.at(-1));
  assert.match(lines.at(-1), /re-run the recovery to repair$/);

  // (c) The reviewed operation really does use that code for that case, so this
  // is not a test against a string this file invented.
  const reconcileSource = fs.readFileSync(new URL("../reconcile-dangling.mjs", import.meta.url), "utf8");
  assert.match(reconcileSource, /refusal\("WRITE_UNCONFIRMED", `the terminal HOLD comment did not confirm/);

  // (d) And the doc says which refusal is the exception, so the journal line and
  // the runbook agree.
  const doc = fs.readFileSync(new URL("../RECONCILE-DANGLING.md", import.meta.url), "utf8");
  assert.match(doc, /`WRITE_UNCONFIRMED` is the one refusal whose line does \*\*not\*\* say "nothing\nwritten"/);
});
