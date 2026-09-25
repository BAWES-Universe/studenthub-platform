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
  defaultWorkerProcesses,
  defaultWorktree,
  main as reconcileMain,
  parseReconcileArgs,
  probeFreshness,
  reconcileDanglingAttempt,
  resolveChain,
  sendSupervisorStatus,
  supervisorDisownsAttempt,
  terminalizeReceipt,
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
    workerProcesses: async () => ({ observed_at: NOW, pids: [] }),
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
  const io = cleanWorld({ workerProcesses: async () => ({ observed_at: NOW, pids: [4242] }) });
  const result = await run(io);
  assert.equal(result.code, "WORKER_LIVE");
  assert.equal(result.refusal, "RECONCILE_REFUSED: WORKER_LIVE");
  assert.match(result.detail, /4242/);
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
    const fields = Array.from({ length: 30 }, (_, i) => String(i + 3));
    fields[19] = spec.start_token ?? "111111";
    fs.writeFileSync(nodePath.join(entry, "stat"), `${pid} (node) S ${fields.join(" ")}`);
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
  const io = cleanWorld({ workerProcesses: async (args) => stamped(defaultWorkerProcesses({ ...args, procRoot: proc })) });
  const result = await reconcileDanglingAttempt({ attempt_id: DANGLING, env: { SHU_SUPERVISOR_STATE_DIR: launched, SHU_WORKTREE_ROOT: worktreeRoot }, io, now: clock });
  assert.equal(result.code, "WORKER_LIVE", `got ${result.code} (${result.detail})`);
  assert.match(result.detail, /4242/);
  assert.equal(io.posted.length, 0, "a live worker must not be terminalized around");
  assert.equal(activeSlots(io.receiptsOnDisk), 1);
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
  const refused = cleanWorld({ workerProcesses: async () => ({ observed_at: NOW, pids: [4242] }) });
  assert.equal(await reconcileMain(["--reconcile-dangling", DANGLING], {}, { ...refused, now: () => NOW, stdout: (l) => lines.push(l) }), 3);
  assert.match(lines.at(-1), /RECONCILE_REFUSED: WORKER_LIVE.*slot preserved, nothing written/);
  assert.equal(refused.posted.length, 0);
  const world = cleanWorld();
  assert.equal(await reconcileMain(["--reconcile-dangling", DANGLING], {}, { ...world, now: () => NOW, stdout: (l) => lines.push(l) }), 0);
  assert.match(lines.at(-1), /^RECONCILE_TERMINALIZED attempt=.* stage=HOLD slot=released$/);
  assert.equal(world.posted.length, 1);
});
