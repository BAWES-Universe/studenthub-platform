// Hermes pool adapter tests (SHU-62) — lease protocol, spawn semantics,
// callback validation, fail-closed rules, and a main()-level dispatch flow for
// a hermes-box requested worker (per-family adapter routing). Everything is
// mocked: temp lease dir + injected spawn; no live process is ever spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBuilder, monitorRun, validateCallbackEvidence, buildWorkOrder, launchIdempotencyKey } from "../adapters/hermes-pool.mjs";
import { main, parseReceiptsFromComments, receiptCommentBody, adapterNameFor, adapterModuleFor } from "../reconcile.mjs";

const SHA = "d".repeat(40);
const ATTEMPT = "aaaaaaaa-1111-4222-8333-444444444444";
const ISSUE = "SHU-FIXTURE-001";
// The pool's receipt-schema-valid run id for ATTEMPT (external_run_id must match
// ^apirun_[A-Za-z0-9_-]+$; the raw UUID does not).
const RUN_ID = `apirun_hermes_${ATTEMPT}`;

function tempPool() {
  return mkdtempSync(join(tmpdir(), "hermes-pool-"));
}
function poolIo(poolDir, spawnImpl) {
  return { poolDir, spawn: spawnImpl, hostname: () => "test-host", now: () => "2026-09-05T12:00:00.000Z" };
}
function leaseAt(poolDir, attempt) {
  const p = join(poolDir, "leases", `${attempt}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function spawnRecorder(calls) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { pid: 4242, on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } };
  };
}
function validEvidence(attempt = ATTEMPT) {
  return { links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/77"], attempt_id: attempt, target_sha: SHA, stage: "BUILD_READY" };
}
const BASE = { issue_id: ISSUE, authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", attempt_id: ATTEMPT, target_sha: SHA, task_context: "probe the fixture" };

test("launch: lease is written QUEUED before the spawn, then RUNNING with a real worker identity", async () => {
  const pool = tempPool();
  let leaseAtSpawnTime = null;
  const calls = [];
  const spawn = (bin, args, opts) => {
    leaseAtSpawnTime = leaseAt(pool, ATTEMPT); // the lease MUST already exist (reserve precedes launch)
    calls.push({ bin, args });
    return { pid: 7, on: () => {} };
  };
  const out = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(out.stage, "RUNNING");
  assert.equal(out.adapter_status, "in_progress");
  assert.equal(out.external_run_id, `apirun_hermes_${ATTEMPT}`);
  assert.equal(out.worker_identity, "hermes:test-host:pid7");
  assert.equal(leaseAtSpawnTime.status, "claiming", "the durable queued lease must be atomically claimed BEFORE the worker spawns");
  const lease = leaseAt(pool, ATTEMPT);
  assert.equal(lease.status, "running");
  assert.equal(lease.worker_id, "hermes:test-host:pid7");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "hermes", "default worker binary is hermes");
  assert.deepEqual(calls[0].args, ["-z", buildWorkOrder(BASE), "--worktree"]);
});

test("launch: the work order echoes attempt_id + callback contract + bound head (no secrets)", () => {
  const order = buildWorkOrder(BASE);
  assert.ok(order.includes(`Attempt: ${ATTEMPT}`), "worker must echo the exact attempt_id");
  assert.ok(order.includes("coordinator-callback v1"));
  assert.ok(order.includes("BUILD_READY"));
  assert.ok(order.includes(`Bound head: ${SHA}`));
  assert.ok(order.includes("FIXTURE-OPUS-CONTRACT-20260905"));
  assert.ok(!order.includes("Bearer") && !order.includes("ghp_") && !order.includes("sk-"), "work order never carries credentials");
});

test("launch: duplicate attempt_id NEVER re-spawns (idempotent retry contract)", async () => {
  const pool = tempPool();
  const calls = [];
  const spawn = spawnRecorder(calls);
  const first = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(first.stage, "RUNNING");
  // Same attempt, fresh process semantics: lease exists -> return mapped state, no spawn.
  const second = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(second.stage, "RUNNING");
  assert.equal(second.external_run_id, `apirun_hermes_${ATTEMPT}`);
  assert.equal(calls.length, 1, "a duplicate launch must never double-spawn");
});

test("launch: spawn failure (hermes missing) -> FAILED SPAWN_FAILED, no pause", async () => {
  const pool = tempPool();
  const out = await launchBuilder({
    ...BASE,
    io: poolIo(pool, () => {
      throw new Error("ENOENT");
    }),
    env: {},
  });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "SPAWN_FAILED");
  assert.notEqual(out.pause_adapter, true, "spawn failure is retryable, not an adapter pause");
  const lease = leaseAt(pool, ATTEMPT);
  assert.equal(lease.status, "failed");
  assert.equal(lease.error.code, "SPAWN_FAILED");
});

test("launch: no spawn wiring -> LAUNCH_UNKNOWN (activation wiring missing, never a phantom worker)", async () => {
  const pool = tempPool();
  const out = await launchBuilder({ ...BASE, io: poolIo(pool, null), env: {} });
  assert.equal(out.stage, "LAUNCH_UNKNOWN");
  assert.equal(leaseAt(pool, ATTEMPT).status, "queued", "lease stays queued — the slot is durably held for reconciliation");
});

test("monitor: a running lease -> RUNNING with granular status + worker identity", async () => {
  const pool = tempPool();
  const spawn = spawnRecorder([]);
  await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  const running = await monitorRun({ run_id: RUN_ID, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} });
  assert.equal(running.stage, "RUNNING");
  assert.equal(running.adapter_status, "in_progress");
  assert.equal(running.worker_identity, "hermes:test-host:pid4242");
});

test("monitor: done + validated BUILD_READY callback -> COMPLETED", async () => {
  const pool = tempPool();
  const spawn = spawnRecorder([]);
  await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  const lease = leaseAt(pool, ATTEMPT);
  lease.status = "done";
  lease.worker_id = "hermes:test-host:pid4242";
  writeFileSync(join(pool, "leases", `${ATTEMPT}.json`), JSON.stringify(lease));
  const out = await monitorRun({ run_id: RUN_ID, attempt_id: ATTEMPT, target_sha: SHA, evidence: validEvidence(), current_head: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} });
  assert.equal(out.stage, "COMPLETED");
  assert.equal(out.worker_identity, "hermes:test-host:pid4242");
  assert.deepEqual(out.evidence_links, validEvidence().links);
});

test("monitor: done WITHOUT callback -> HOLD; BLOCKED stage -> HOLD; stale head -> HOLD", async () => {
  const pool = tempPool();
  const spawn = spawnRecorder([]);
  await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  const setLease = () => {
    const lease = leaseAt(pool, ATTEMPT);
    lease.status = "done";
    writeFileSync(join(pool, "leases", `${ATTEMPT}.json`), JSON.stringify(lease));
  };
  const args = { run_id: RUN_ID, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} };
  setLease();
  const noCb = await monitorRun({ ...args });
  assert.equal(noCb.stage, "HOLD", "done without a validated callback is HOLD, never COMPLETED");
  const blocked = await monitorRun({ ...args, evidence: { ...validEvidence(), stage: "BLOCKED" } });
  assert.equal(blocked.stage, "HOLD", "BLOCKED callback never authorizes COMPLETED");
  const staleHead = await monitorRun({ ...args, evidence: validEvidence(), current_head: "e".repeat(40) });
  assert.equal(staleHead.stage, "HOLD", "old PASS against a moved head is stale");
  const noStage = await monitorRun({ ...args, evidence: { links: ["https://x"], attempt_id: ATTEMPT, target_sha: SHA } });
  assert.equal(noStage.stage, "HOLD", "missing stage fails closed");
});

test("monitor: failed lease -> FAILED with the worker error code", async () => {
  const pool = tempPool();
  const spawn = spawnRecorder([]);
  await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  const lease = leaseAt(pool, ATTEMPT);
  lease.status = "failed";
  lease.error = { code: "WORKER_FAILED", kind: "run_failed" };
  writeFileSync(join(pool, "leases", `${ATTEMPT}.json`), JSON.stringify(lease));
  const out = await monitorRun({ run_id: RUN_ID, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "WORKER_FAILED");
});

test("monitor: missing / corrupt lease -> UNCHANGED (fail closed, never a manufactured failure)", async () => {
  const pool = tempPool();
  const missing = await monitorRun({ run_id: RUN_ID, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, () => {}), env: {} });
  assert.equal(missing.stage, "UNCHANGED");
  assert.match(missing.reason, /no lease/);
  mkdtempSync(pool);
  mkdirSync(join(pool, "leases"), { recursive: true });
  writeFileSync(join(pool, "leases", `${ATTEMPT}.json`), "{ not json");
  const corrupt = await monitorRun({ run_id: RUN_ID, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, () => {}), env: {} });
  assert.equal(corrupt.stage, "UNCHANGED");
  assert.match(corrupt.reason, /corrupt lease/);
});

test("validateCallbackEvidence: missing stage fails closed; only success stages pass", () => {
  assert.equal(validateCallbackEvidence({ evidence: validEvidence(), attempt_id: ATTEMPT, target_sha: SHA }), true);
  assert.equal(validateCallbackEvidence({ evidence: { ...validEvidence(), stage: "REVISION_READY" }, attempt_id: ATTEMPT, target_sha: SHA }), true);
  assert.equal(validateCallbackEvidence({ evidence: { links: ["x"], attempt_id: ATTEMPT, target_sha: SHA }, attempt_id: ATTEMPT, target_sha: SHA }), false, "missing stage");
  assert.equal(validateCallbackEvidence({ evidence: { ...validEvidence(), stage: "BLOCKED" }, attempt_id: ATTEMPT, target_sha: SHA }), false);
  assert.equal(validateCallbackEvidence({ evidence: { ...validEvidence(), stage: "FAILED" }, attempt_id: ATTEMPT, target_sha: SHA }), false);
  assert.equal(validateCallbackEvidence({ evidence: { ...validEvidence(), attempt_id: "other" }, attempt_id: ATTEMPT, target_sha: SHA }), false);
  assert.equal(validateCallbackEvidence({ evidence: validEvidence(), attempt_id: ATTEMPT, target_sha: SHA, current_head: "e".repeat(40) }), false);
});

test("adapterNameFor + adapterModuleFor route hermes-box to hermes-pool", async () => {
  assert.equal(adapterNameFor("hermes-box"), "hermes-pool");
  assert.equal(adapterNameFor("codex-builder"), "workspace-agents");
  assert.equal(adapterNameFor("claude-verifier"), "workspace-agents", "documented fallback until SHU-61");
  const pool = await adapterModuleFor({ requested_worker: "hermes-box" });
  assert.ok(pool.launchBuilder && pool.monitorRun, "hermes-pool exposes the adapter interface");
  const wa = await adapterModuleFor({ requested_worker: "codex-builder" });
  assert.ok(wa.launchBuilder && wa.monitorRun, "workspace-agents still routes for codex-builder");
});

// ---- main()-level integration: a hermes-box worker dispatched end-to-end ----
const FIXTURE_NODE = {
  id: "11111111-aaaa-4bbb-8ccc-000000000001",
  identifier: ISSUE,
  title: "Fixture: seeded-defect probe card",
  state: { name: "Todo" },
  priorityLabel: "High",
  labels: { nodes: [{ name: "fixture-safe" }, { name: "worker:hermes-box" }] },
  assignee: null,
  delegate: null,
  parent: null,
  relations: { nodes: [] },
};
const ENV = {
  ENABLE_DISPATCH: "true",
  LINEAR_API_TOKEN: "tok",
  GITHUB_TOKEN: "",
  WORKSPACE_AGENT_ACCESS_TOKEN: "ignored", // hermes-pool does not use these
  WORKSPACE_AGENT_TRIGGER_ID: "ignored",
  DISPATCH_TARGET_SHA: SHA,
};
function tempConfig() {
  const cfg = {
    pilot_repo: "BAWES-Universe/studenthub-platform",
    team: "SHU",
    max_dispatch: 1,
    enable_dispatch: true,
    adapter_pause_map: {},
    wake_actor_allowlist: ["BAWES"],
    max_failed_attempts: 3,
    fixture_lane: { id: ISSUE, authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
  };
  const dir = mkdtempSync(join(tmpdir(), "shu62-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}
let clockMs = 1700000000000;
const tick = () => new Date((clockMs += 1000)).toISOString();
function fakeLinearStore(comments) {
  const impl = async (url, opts) => {
    assert.equal(url, "https://api.linear.app/graphql");
    const { query } = JSON.parse(opts.body);
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes: [FIXTURE_NODE] } });
    if (query.includes("CoordinatorIssueComments")) {
      const issueId = JSON.parse(opts.body).variables.issueId;
      const nodes = FIXTURE_NODE.id === issueId || FIXTURE_NODE.identifier === issueId ? [...comments] : [];
      return respond({ issue: { comments: { nodes } } });
    }
    if (query.includes("commentCreate")) {
      const { issueId, body } = JSON.parse(opts.body).variables;
      assert.ok(issueId === FIXTURE_NODE.id, `comment writes must use the issue UUID, got ${issueId}`);
      comments.push({ body, createdAt: tick() });
      return respond({ commentCreate: { success: true, comment: { id: `c${comments.length}` } } });
    }
    return respond({});
  };
  impl.comments = comments;
  return impl;
}
function runMain({ comments, poolDir, spawnCalls }) {
  const store = fakeLinearStore(comments);
  const out = [];
  return main([], ENV, {
    configPath: tempConfig(),
    stdout: (s) => out.push(s),
    fetchImpl: async (url, opts) => {
      assert.ok(url.includes("api.linear.app"), `unexpected fetch to ${url}`);
      return store(url, opts);
    },
    fetchDurable: true,
    pollRuns: true,
    poolDir,
    spawn: (bin, args, opts) => {
      spawnCalls.push({ bin, args });
      return { pid: 9000, on: () => {} };
    },
    hostname: () => "test-host",
    now: tick,
  }).then((code) => ({ code, out }));
}

test("main(): hermes-box card dispatches through hermes-pool — lease written, one spawn, durable RUNNING", async () => {
  const comments = [];
  const pool = tempPool();
  const spawnCalls = [];
  const r1 = await runMain({ comments, poolDir: pool, spawnCalls });
  assert.equal(r1.code, 0, r1.out.join("\n"));
  assert.equal(spawnCalls.length, 1, "exactly one full-session worker spawn");
  assert.equal(spawnCalls[0].bin, "hermes");
  assert.equal(spawnCalls[0].args[0], "-z", "full-session one-shot prompt flag");
  assert.equal(spawnCalls[0].args[2], "--worktree", "isolated worktree for the card");
  const order = spawnCalls[0].args[1];
  assert.ok(order.includes(`Attempt: `), "work order carries the attempt");
  assert.ok(order.includes("coordinator-callback v1"), "work order carries the callback contract");
  const receipt = parseReceiptsFromComments(comments)[0];
  assert.equal(receipt.stage, "RUNNING", "durable receipt is RUNNING, never left at RESERVED");
  assert.equal(receipt.external_run_id, `apirun_hermes_${receipt.attempt_id}`, "pool run id is schema-valid and derived from the lease key");
  assert.equal(receipt.worker_identity, "hermes:test-host:pid9000");
  const lease = JSON.parse(readFileSync(join(pool, "leases", `${receipt.attempt_id}.json`), "utf8"));
  assert.equal(lease.status, "running");
  // The LAUNCH_UNKNOWN / recovery path also routes here (same adapter name check).
  assert.equal(adapterNameFor("hermes-box"), "hermes-pool");
  assert.match(r1.out.join("\n"), /via hermes-pool/, "report names the pool adapter for the hermes-box worker");
});

test("main(): second process run polls the same lease — zero new spawns, state unchanged", async () => {
  const comments = [];
  const pool = tempPool();
  const spawnCalls = [];
  await runMain({ comments, poolDir: pool, spawnCalls });
  assert.equal(spawnCalls.length, 1);
  const r2 = await runMain({ comments, poolDir: pool, spawnCalls });
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(spawnCalls.length, 1, "polling the RUNNING lease must never spawn a second worker");
  assert.equal(parseReceiptsFromComments(comments).filter((r) => r.stage === "RUNNING").length, 1);
});

test("main(): worker done WITHOUT callback -> durable HOLD via the pool lease", async () => {
  const comments = [];
  const pool = tempPool();
  const spawnCalls = [];
  await runMain({ comments, poolDir: pool, spawnCalls });
  const [running] = parseReceiptsFromComments(comments);
  // The worker finishes: lease -> done, but no coordinator-callback on the issue.
  const leasePath = join(pool, "leases", `${running.attempt_id}.json`);
  const lease = JSON.parse(readFileSync(leasePath, "utf8"));
  lease.status = "done";
  lease.worker_id = "hermes:test-host:pid9000";
  writeFileSync(leasePath, JSON.stringify(lease));
  const r2 = await runMain({ comments, poolDir: pool, spawnCalls });
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.ok(r2.out.some((l) => l.includes("RUNNING -> HOLD")), r2.out.join("\n"));
  const held = parseReceiptsFromComments(comments)[0];
  assert.equal(held.stage, "HOLD", "done without validated callback must persist HOLD");
  assert.ok(held.notes.join(" ").includes("completed"), "hold note explains the completed-without-callback state");
});

test("idempotency key contract matches the cross-adapter convention", () => {
  assert.equal(launchIdempotencyKey({ attempt_id: ATTEMPT, target_sha: SHA }), `${ATTEMPT}:LAUNCH_UNKNOWN:${SHA}`);
});

// ---------------------------------------------------------------------------
// Regression tests for the CodeRabbit + Sentry findings on PR #22 (Opus,
// exact-head verification of d46440b). Each one FAILS on that head.
// ---------------------------------------------------------------------------
import { EventEmitter } from "node:events";
import { validateReceipt, createReceipt, nextReceiptState } from "../reconcile.mjs";

// F1 (Sentry + CodeRabbit): the pool returned the raw UUID attempt_id as
// external_run_id. The receipt schema requires ^apirun_[A-Za-z0-9_-]+$, so every
// durable RUNNING/COMPLETED/HOLD receipt the pool produced was schema-invalid —
// and the parser rehydrates receipts WITHOUT validating, so the lifecycle would
// keep running on an invalid record.
test("F1: the pool's external_run_id satisfies the shared receipt schema", async () => {
  const pool = tempPool();
  const out = await launchBuilder({ ...BASE, io: poolIo(pool, spawnRecorder([])), env: {} });
  assert.equal(out.stage, "RUNNING");
  assert.match(out.external_run_id, /^apirun_[A-Za-z0-9_-]+$/, "run id must satisfy the receipt-schema pattern");

  // Prove it end-to-end: the receipt this launch produces must actually validate.
  const made = createReceipt({
    issue_id: ISSUE,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "hermes-box",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "feat/shu-62-hermes-pool",
    target_sha: SHA,
    attempt_id: ATTEMPT,
    reserved_at: "2026-09-05T12:00:00.000Z",
  });
  assert.ok(made.ok, `fixture receipt must be valid: ${JSON.stringify(made.errors)}`);
  let t = nextReceiptState(made.receipt, { type: "launch" });
  assert.ok(t.accepted);
  t = nextReceiptState(t.receipt, {
    type: "worker_ack",
    external_run_id: out.external_run_id,
    adapter_status: out.adapter_status,
    worker_identity: out.worker_identity,
  });
  assert.ok(t.accepted, "worker_ack must be accepted");
  const v = validateReceipt(t.receipt);
  assert.equal(v.valid, true, `durable pool receipt must be schema-valid: ${v.errors.join("; ")}`);
});

// F2 (CodeRabbit): the lease is written "queued" BEFORE the spawn. With no spawn
// wiring the launch returns LAUNCH_UNKNOWN but leaves that queued lease behind.
// The next reconciliation found it and mapped queued -> RUNNING: a phantom
// worker that never started, holding the slot forever.
test("F2: a pre-spawn queued lease NEVER reports RUNNING (no phantom worker)", async () => {
  const pool = tempPool();
  const first = await launchBuilder({ ...BASE, io: { poolDir: pool }, env: {} }); // no spawn wiring
  assert.equal(first.stage, "LAUNCH_UNKNOWN");
  assert.equal(leaseAt(pool, ATTEMPT).status, "queued");

  // Recovery retry, still without spawn wiring: must stay recoverable, never RUNNING.
  const second = await launchBuilder({ ...BASE, io: { poolDir: pool }, env: {} });
  assert.notEqual(second.stage, "RUNNING", "a lease that never spawned must not be reported as a running worker");
  assert.equal(second.stage, "LAUNCH_UNKNOWN");

  // Once spawn wiring exists the SAME attempt spawns exactly once and only then RUNs.
  const calls = [];
  const third = await launchBuilder({ ...BASE, io: poolIo(pool, spawnRecorder(calls)), env: {} });
  assert.equal(third.stage, "RUNNING", "recovery with real wiring must start the worker");
  assert.equal(calls.length, 1, "exactly one spawn for the recovered attempt");
  assert.equal(leaseAt(pool, ATTEMPT).status, "running");
});

test("F2b: concurrent recovery processes atomically claim one launch", async () => {
  const pool = tempPool();
  const reserved = await launchBuilder({ ...BASE, io: { poolDir: pool }, env: {} });
  assert.equal(reserved.stage, "LAUNCH_UNKNOWN");

  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    // Keep pid absent until the explicit spawn event so awaitSpawn cannot
    // settle process A before process B enters the recovery path.
    child.pid = undefined;
    children.push(child);
    return child;
  };

  // Keep process A suspended after it has claimed the lease and invoked spawn.
  // Process B then races the same durable queued attempt from a separate
  // launchBuilder invocation. Exactly one process may reach io.spawn.
  const first = launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const second = launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(children.length, 1, "one durable attempt must never launch two workers concurrently");
  children[0].emit("spawn");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.stage, "RUNNING");
  assert.equal(b.stage, "LAUNCH_UNKNOWN");
});

test("F2c: a successful spawn with no durable running transition keeps the launch claim", async () => {
  const pool = tempPool();
  let spawnCount = 0;
  const spawn = () => {
    spawnCount += 1;
    // Simulate loss of the lease between spawn confirmation and the parent's
    // running-state merge. The first worker exists, so recovery must not spawn
    // another merely because durable state is uncertain.
    unlinkSync(join(pool, "leases", `${ATTEMPT}.json`));
    return { pid: 9300, on: () => {} };
  };
  const first = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(first.stage, "RUNNING");

  const second = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(second.stage, "LAUNCH_UNKNOWN");
  assert.equal(spawnCount, 1, "uncertain persistence after a real spawn must never double-launch");
});

// Originally this asserted FAILED + pause for ANY dead same-host owner, because
// the phase was recorded and then never advanced or read, so "pre_spawn" could
// not be trusted to mean anything and every crash had to be assumed unsafe. The
// phase is now advanced BEFORE io.spawn, so it is a real proof: a dead owner
// still at pre_spawn provably never started a worker and is safe to retry. The
// unsafe half of the original assertion is pinned in the sibling test below.
test("F2d: a dead same-host owner PAST the spawn attempt fails visibly and pauses", async () => {
  const pool = tempPool();
  const reserved = await launchBuilder({ ...BASE, io: { poolDir: pool }, env: {} });
  assert.equal(reserved.stage, "LAUNCH_UNKNOWN");
  writeFileSync(
    join(pool, "leases", `${ATTEMPT}.launch-claim`),
    JSON.stringify({ attempt_id: ATTEMPT, owner_pid: 9911, owner_host: "test-host", phase: "spawn_attempted", claimed_at: "2026-09-05T00:00:00.000Z" }),
  );
  let spawns = 0;
  const out = await launchBuilder({
    ...BASE,
    io: { ...poolIo(pool, () => { spawns += 1; }), isProcessAlive: (pid) => (pid === 9911 ? false : null) },
    env: {},
  });
  assert.equal(out.stage, "FAILED", "a dead owner must not leave LAUNCH_UNKNOWN occupying the slot forever");
  assert.equal(out.error_code, "STALE_LAUNCH_CLAIM");
  assert.equal(out.pause_adapter, true, "ambiguous crash-after-spawn must require explicit reconciliation");
  assert.equal(spawns, 0, "owner death alone is never authority to launch another worker");
});

// A claim written by an older coordinator carries no phase at all. It cannot be
// proved retry-safe, so it must take the conservative path.
test("F2d': a dead owner whose claim has NO phase is treated as unsafe", async () => {
  const pool = tempPool();
  await launchBuilder({ ...BASE, io: { poolDir: pool }, env: {} });
  writeFileSync(
    join(pool, "leases", `${ATTEMPT}.launch-claim`),
    JSON.stringify({ attempt_id: ATTEMPT, owner_pid: 9911, owner_host: "test-host" }),
  );
  let spawns = 0;
  const out = await launchBuilder({
    ...BASE,
    io: { ...poolIo(pool, () => { spawns += 1; }), isProcessAlive: (pid) => (pid === 9911 ? false : null) },
    env: {},
  });
  assert.equal(out.stage, "FAILED", "an unprovable phase can never authorize a retry");
  assert.equal(spawns, 0);
});

test("F2e: an alive or unprovable claim owner remains LAUNCH_UNKNOWN", async () => {
  const pool = tempPool();
  await launchBuilder({ ...BASE, io: { poolDir: pool }, env: {} });
  writeFileSync(
    join(pool, "leases", `${ATTEMPT}.launch-claim`),
    JSON.stringify({ attempt_id: ATTEMPT, owner_pid: 9912, owner_host: "test-host", phase: "pre_spawn" }),
  );
  const alive = await launchBuilder({
    ...BASE,
    io: { ...poolIo(pool, spawnRecorder([])), isProcessAlive: () => true },
    env: {},
  });
  assert.equal(alive.stage, "LAUNCH_UNKNOWN");
  const unknown = await launchBuilder({
    ...BASE,
    io: { ...poolIo(pool, spawnRecorder([])), isProcessAlive: () => null },
    env: {},
  });
  assert.equal(unknown.stage, "LAUNCH_UNKNOWN");
});

// F3 (CodeRabbit): child_process.spawn reports a missing binary by EMITTING
// "error", not by throwing. The adapter attached no error listener, so a missing
// hermes binary would (a) be reported as RUNNING and (b) surface as an unhandled
// "error" event that terminates the coordinator.
test("F3: an asynchronous spawn error becomes FAILED, not RUNNING, and never escapes", async () => {
  const pool = tempPool();
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = undefined;
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn hermes ENOENT"), { code: "ENOENT" })));
    return child;
  };
  const out = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(out.stage, "FAILED", "an async spawn failure must fail closed, not report a running worker");
  assert.equal(out.error_code, "SPAWN_FAILED");
  assert.equal(leaseAt(pool, ATTEMPT).status, "failed");
});

test("F3: a successful async spawn still reaches RUNNING once the spawn event fires", async () => {
  const pool = tempPool();
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 9191;
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const out = await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  assert.equal(out.stage, "RUNNING");
  assert.equal(out.worker_identity, "hermes:test-host:pid9191");
  assert.equal(leaseAt(pool, ATTEMPT).status, "running");
});

// F4 (CodeRabbit): the parent wrote its stale in-memory lease AFTER io.spawn
// returned. A worker that had already reached a terminal state in that window had
// its result replaced with "running", stranding the attempt.
test("F4: the parent's post-spawn write never overwrites a worker's terminal lease state", async () => {
  const pool = tempPool();
  // The worker finishes (and writes the lease) before the parent's post-spawn write.
  const spawn = (bin, args, opts) => {
    const cur = leaseAt(pool, ATTEMPT);
    mkdirSync(join(pool, "leases"), { recursive: true });
    writeFileSync(
      join(pool, "leases", `${ATTEMPT}.json`),
      JSON.stringify({ ...cur, status: "done", granular: "completed", worker_id: "hermes:worker:pid555" }, null, 2),
    );
    return { pid: 555, on: () => {} };
  };
  await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  const lease = leaseAt(pool, ATTEMPT);
  assert.equal(lease.status, "done", "a worker-owned terminal state must survive the parent's spawn-field write");
  assert.equal(lease.granular, "completed");
  assert.ok(lease.spawn && lease.spawn.pid === 555, "parent-owned spawn fields are still merged in");
});

// F5 (CodeRabbit, CWE-22): external_run_id is rehydrated from a Linear comment
// WITHOUT validation and was joined straight into the lease path, so a forged
// comment could make the coordinator read a .json file outside <poolDir>/leases.
test("F5: a forged external_run_id cannot steer the lease read outside the pool", async () => {
  const pool = tempPool();
  const outside = mkdtempSync(join(tmpdir(), "hermes-outside-"));
  writeFileSync(
    join(outside, "stolen.json"),
    JSON.stringify({ attempt_id: ATTEMPT, target_sha: SHA, status: "done", worker_id: "attacker" }),
  );
  await launchBuilder({ ...BASE, io: poolIo(pool, spawnRecorder([])), env: {} });

  const forged = join("..", "..", outside.split("/").pop(), "stolen");
  const out = await monitorRun({
    run_id: `${"../".repeat(6)}${outside.replace(/^\//, "")}/stolen`,
    attempt_id: ATTEMPT,
    target_sha: SHA,
    evidence: validEvidence(),
    io: { poolDir: pool },
  });
  assert.equal(out.stage, "UNCHANGED", "a run id that does not identify this attempt must be refused");
  assert.notEqual(out.worker_identity, "attacker");

  const alsoForged = await monitorRun({
    run_id: forged,
    attempt_id: ATTEMPT,
    target_sha: SHA,
    evidence: validEvidence(),
    io: { poolDir: pool },
  });
  assert.equal(alsoForged.stage, "UNCHANGED");
});

// F5b: even a well-formed run id must be cross-checked against the lease it
// loads — the lease's own attempt_id and target_sha must match this attempt.
test("F5b: a lease whose attempt_id or target_sha disagrees with the receipt is refused", async () => {
  const pool = tempPool();
  await launchBuilder({ ...BASE, io: poolIo(pool, spawnRecorder([])), env: {} });
  const lease = leaseAt(pool, ATTEMPT);
  writeFileSync(
    join(pool, "leases", `${ATTEMPT}.json`),
    JSON.stringify({ ...lease, target_sha: "e".repeat(40), status: "done" }, null, 2),
  );
  const out = await monitorRun({
    run_id: undefined,
    attempt_id: ATTEMPT,
    target_sha: SHA,
    evidence: validEvidence(),
    io: { poolDir: pool },
  });
  assert.equal(out.stage, "UNCHANGED", "a lease bound to a different head must never satisfy this attempt");
});

// F6 (CodeRabbit): LAUNCH_UNKNOWN recovery was skipped whenever the Workspace
// Agents credentials were absent — a gate applied BEFORE adapter routing. A
// hermes-box attempt needs no Workspace Agents credential at all, so its receipt
// could never be recovered and the slot was held forever.
test("F6: hermes-box LAUNCH_UNKNOWN recovery runs without Workspace Agents credentials", async () => {
  const comments = [];
  const pool = tempPool();
  const spawnCalls = [];
  const noWaEnv = { ...ENV, WORKSPACE_AGENT_ACCESS_TOKEN: "", WORKSPACE_AGENT_TRIGGER_ID: "" };
  const store = fakeLinearStore(comments);
  const runWith = (io) =>
    main([], noWaEnv, {
      configPath: tempConfig(),
      stdout: () => {},
      fetchImpl: async (url, opts) => store(url, opts),
      fetchDurable: true,
      pollRuns: true,
      hostname: () => "test-host",
      now: tick,
      ...io,
    });

  // Run 1: no spawn wiring -> the attempt persists as LAUNCH_UNKNOWN.
  await runWith({ poolDir: pool });
  const first = parseReceiptsFromComments(comments)[0];
  assert.equal(first.stage, "LAUNCH_UNKNOWN", "no spawn wiring must leave a recoverable LAUNCH_UNKNOWN receipt");

  // Run 2: spawn wiring present, Workspace Agents credentials still absent.
  // The hermes lane must recover — its adapter never touches those credentials.
  await runWith({
    poolDir: pool,
    spawn: (bin, args) => {
      spawnCalls.push({ bin, args });
      return { pid: 9100, on: () => {} };
    },
  });
  assert.equal(spawnCalls.length, 1, "hermes recovery must not be gated on a credential its adapter never uses");
  const after = parseReceiptsFromComments(comments).find((r) => r.attempt_id === first.attempt_id);
  assert.equal(after.stage, "RUNNING", "the recovered attempt reaches RUNNING");
  assert.equal(after.worker_identity, "hermes:test-host:pid9100");
});

// F5c: the WRITE side of the path guard. leasePath is the only place a path
// segment is derived, so it validates the segment itself rather than trusting
// callers — an attempt id that is not a UUID must never name a file at all.
test("F5c: a traversal-shaped attempt_id can never create a lease outside the pool", async () => {
  const pool = tempPool();
  const escapeDir = mkdtempSync(join(tmpdir(), "hermes-escape-"));
  const evil = join("..", "..", escapeDir.split("/").pop(), "pwned");
  const out = await launchBuilder({
    ...BASE,
    attempt_id: evil,
    io: poolIo(pool, spawnRecorder([])),
    env: {},
  });
  assert.notEqual(out.stage, "RUNNING", "an unnameable attempt must never reach RUNNING");
  assert.equal(existsSync(join(escapeDir, "pwned.json")), false, "no lease may be written outside <poolDir>/leases");
});

// ---------------------------------------------------------------------------
// Abandoned-claim liveness (Opus, adversarial review of ed262fb).
//
// ed262fb made the launch mutex genuinely atomic — that property holds and is
// re-pinned below. What it did not fix is LIVENESS: an abandoned claim could
// leave the attempt permanently unrecoverable and, in the most likely
// deployment, silently. These tests pin the recovery rules.
// ---------------------------------------------------------------------------
import { utimesSync } from "node:fs";

const CLAIM = (pool) => join(pool, "leases", `${ATTEMPT}.launch-claim`);
const OLD = "2026-09-05T00:00:00.000Z"; // far older than the claim TTL
const NOW = "2026-09-05T12:00:00.000Z";
function writeClaimFile(pool, body) {
  mkdirSync(join(pool, "leases"), { recursive: true });
  writeFileSync(CLAIM(pool), typeof body === "string" ? body : JSON.stringify(body));
}
// Leaves a queued, pre-spawn lease behind exactly as a launch with no spawn
// wiring does, then plants the claim a crashed coordinator would have left.
async function abandonedAttempt(pool, claimBody) {
  await launchBuilder({ ...BASE, io: { poolDir: pool, hostname: () => "hostA", now: () => NOW }, env: {} });
  writeClaimFile(pool, claimBody);
}

// A claim whose owner never reached io.spawn proves NO worker exists, so the
// attempt is safe to retry. Before this, the host gate meant any coordinator
// with a different hostname — a container or a fresh Actions runner, i.e. the
// deployment target — could never reach the abandonment branch at all, and the
// attempt sat at LAUNCH_UNKNOWN forever holding the only dispatch slot.
test("abandoned pre-spawn claim from a FOREIGN host is recovered, not deadlocked", async () => {
  const pool = tempPool();
  const calls = [];
  await abandonedAttempt(pool, { attempt_id: ATTEMPT, owner_pid: 999999, owner_host: "hostA", phase: "pre_spawn", claimed_at: OLD });
  const out = await launchBuilder({
    ...BASE,
    io: { poolDir: pool, hostname: () => "hostB", now: () => NOW, spawn: spawnRecorder(calls) },
    env: {},
  });
  assert.equal(out.stage, "RUNNING", "a claim that provably never spawned must be recoverable from any host");
  assert.equal(calls.length, 1, "exactly one worker for the recovered attempt");
});

test("abandoned pre-spawn claim on the SAME host retries without pausing the adapter", async () => {
  const pool = tempPool();
  const calls = [];
  await abandonedAttempt(pool, { attempt_id: ATTEMPT, owner_pid: 4242, owner_host: "hostA", phase: "pre_spawn", claimed_at: OLD });
  const out = await launchBuilder({
    ...BASE,
    io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn: spawnRecorder(calls), isProcessAlive: () => false },
    env: {},
  });
  assert.equal(out.stage, "RUNNING");
  assert.equal(calls.length, 1);
  assert.notEqual(out.pause_adapter, true, "a crash that never reached spawn must not halt the whole hermes lane");
});

// The mirror image: once io.spawn has been ATTEMPTED, a worker may exist, so
// retrying is unsafe and the attempt must become an operator-visible fault.
test("abandoned claim past the spawn attempt is a visible fault, never a silent retry", async () => {
  for (const phase of ["spawn_attempted", "spawned"]) {
    const pool = tempPool();
    const calls = [];
    await abandonedAttempt(pool, { attempt_id: ATTEMPT, owner_pid: 4242, owner_host: "hostA", phase, claimed_at: OLD });
    const out = await launchBuilder({
      ...BASE,
      io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn: spawnRecorder(calls), isProcessAlive: () => false },
      env: {},
    });
    assert.equal(out.stage, "FAILED", `${phase}: a worker may exist, so this can never silently retry`);
    assert.equal(out.error_code, "STALE_LAUNCH_CLAIM");
    assert.equal(calls.length, 0, `${phase}: never spawn a second worker`);
  }
});

// A crash between the exclusive create and the body write leaves a zero-length
// file — the exact window the mutex exists to survive. It must not fall through
// to the silent "already claimed" path.
test("a corrupt or empty abandoned claim is surfaced, not silently held forever", async () => {
  for (const body of ["", "{ not json"]) {
    const pool = tempPool();
    const calls = [];
    await abandonedAttempt(pool, body);
    // An unreadable claim has no claimed_at to age out, so the code falls back
    // to the file's own mtime — a REAL clock value. Backdate it rather than
    // racing "now" against a zero TTL.
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(CLAIM(pool), hourAgo, hourAgo);
    const out = await launchBuilder({
      ...BASE,
      io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn: spawnRecorder(calls) },
      env: {},
    });
    assert.equal(out.stage, "FAILED", "an unreadable claim must become an operator-visible fault");
    assert.equal(out.error_code, "STALE_LAUNCH_CLAIM");
    assert.equal(calls.length, 0);
  }
});

// Safety guards: a claim that is still LIVE must never be taken over.
test("a fresh claim is never stolen, whatever its phase or host", async () => {
  for (const phase of ["pre_spawn", "spawn_attempted", "spawned"]) {
    const pool = tempPool();
    const calls = [];
    await abandonedAttempt(pool, { attempt_id: ATTEMPT, owner_pid: 4242, owner_host: "hostB", phase, claimed_at: NOW });
    const out = await launchBuilder({
      ...BASE,
      io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn: spawnRecorder(calls) },
      env: {},
    });
    assert.equal(out.stage, "LAUNCH_UNKNOWN", `${phase}: a live claim is held by someone else — wait, never take over`);
    assert.equal(calls.length, 0);
  }
});

test("a live same-host owner is never displaced even with an old timestamp", async () => {
  const pool = tempPool();
  const calls = [];
  await abandonedAttempt(pool, { attempt_id: ATTEMPT, owner_pid: 4242, owner_host: "hostA", phase: "pre_spawn", claimed_at: OLD });
  const out = await launchBuilder({
    ...BASE,
    io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn: spawnRecorder(calls), isProcessAlive: () => true },
    env: {},
  });
  assert.equal(out.stage, "LAUNCH_UNKNOWN", "a provably running owner outranks any staleness heuristic");
  assert.equal(calls.length, 0);
});

// Re-pin the property ed262fb established, so a liveness fix cannot regress it.
test("concurrent launches on one attempt still produce exactly one worker", async () => {
  const pool = tempPool();
  const calls = [];
  await launchBuilder({ ...BASE, io: { poolDir: pool, hostname: () => "hostA", now: () => NOW }, env: {} });
  const io = { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn: spawnRecorder(calls) };
  const [a, b] = await Promise.all([launchBuilder({ ...BASE, io, env: {} }), launchBuilder({ ...BASE, io, env: {} })]);
  assert.equal(calls.length, 1, "the launch mutex must stay atomic");
  assert.equal([a.stage, b.stage].filter((s) => s === "RUNNING").length, 1);
});

// The claim must record that it reached the spawn attempt BEFORE io.spawn runs,
// or a crash inside spawn would look retry-safe and double-launch.
test("the claim records the spawn attempt BEFORE the worker is started", async () => {
  const pool = tempPool();
  let phaseAtSpawnTime = null;
  const spawn = () => {
    phaseAtSpawnTime = JSON.parse(readFileSync(CLAIM(pool), "utf8")).phase;
    return { pid: 7, on: () => {} };
  };
  await launchBuilder({ ...BASE, io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, spawn }, env: {} });
  assert.notEqual(phaseAtSpawnTime, "pre_spawn", "a crash inside io.spawn must not look like it never spawned");
});

// P4 from the review: the worker started but the running-lease write was lost.
// The receipt is RUNNING, so launchBuilder never runs again — only monitorRun,
// which saw a pre-spawn lease and returned UNCHANGED forever.
test("a spawned worker whose lease write was lost becomes visible, not invisible", async () => {
  const pool = tempPool();
  await launchBuilder({ ...BASE, io: { poolDir: pool, hostname: () => "hostA", now: () => NOW }, env: {} });
  const lease = leaseAt(pool, ATTEMPT);
  writeFileSync(join(pool, "leases", `${ATTEMPT}.json`), JSON.stringify({ ...lease, status: "claiming" }));
  writeClaimFile(pool, { attempt_id: ATTEMPT, owner_pid: 4242, owner_host: "hostA", phase: "spawned", claimed_at: OLD });
  const out = await monitorRun({
    run_id: `apirun_hermes_${ATTEMPT}`,
    attempt_id: ATTEMPT,
    target_sha: SHA,
    io: { poolDir: pool, hostname: () => "hostA", now: () => NOW, isProcessAlive: () => false },
  });
  assert.equal(out.stage, "HOLD", "a worker that really started must never be held UNCHANGED forever");
});

// If the spawn_attempted phase cannot be made durable, spawning anyway would
// leave a claim reading "pre_spawn" while a worker exists — which is precisely
// the licence another coordinator uses to take over and double-launch.
test("a phase advance that will not persist refuses to start the worker", async () => {
  const pool = tempPool();
  const calls = [];
  const out = await launchBuilder({
    ...BASE,
    io: {
      poolDir: pool,
      hostname: () => "hostA",
      now: () => NOW,
      spawn: spawnRecorder(calls),
      writeFileImpl: () => {
        throw new Error("ENOSPC");
      },
    },
    env: {},
  });
  assert.equal(calls.length, 0, "never start a worker the claim cannot account for");
  assert.equal(out.stage, "LAUNCH_UNKNOWN", "the slot is held and the attempt stays recoverable");
  assert.match(out.reason, /could not record the spawn attempt/);
});
