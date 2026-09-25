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
// Every probe here is injected, so these proofs need no git, no /proc, no
// socket and no network: the audited capability set for this file stays [].
// ---------------------------------------------------------------------------
import { TERMINAL_STAGES } from "../reconcile.mjs";
import {
  RECONCILE_REFUSAL_CODES,
  probeFreshness,
  reconcileDanglingAttempt,
  resolveChain,
  sendSupervisorStatus,
  supervisorDisownsAttempt,
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
    worktree: async () => ({ observed_at: NOW, present: true, head: BASE_SHA, porcelain: "" }),
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
    ["WORKTREE_CHANGED", { worktree: async () => ({ observed_at: NOW, present: true, head: "d".repeat(40), porcelain: "" }) }],
    ["WORKTREE_CHANGED", { worktree: async () => ({ observed_at: NOW, present: true, head: BASE_SHA, porcelain: " M tools/fixture/scan-vacuous.mjs\n" }) }],
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
    ["probe carried no observation time", { worktree: async () => ({ present: true, head: BASE_SHA, porcelain: "" }) }],
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
