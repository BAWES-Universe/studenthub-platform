// Hermes pool adapter tests (SHU-62) — lease protocol, spawn semantics,
// callback validation, fail-closed rules, and a main()-level dispatch flow for
// a hermes-box requested worker (per-family adapter routing). Everything is
// mocked: temp lease dir + injected spawn; no live process is ever spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBuilder, monitorRun, validateCallbackEvidence, buildWorkOrder, launchIdempotencyKey } from "../adapters/hermes-pool.mjs";
import { main, parseReceiptsFromComments, receiptCommentBody, adapterNameFor, adapterModuleFor } from "../reconcile.mjs";

const SHA = "d".repeat(40);
const ATTEMPT = "aaaaaaaa-1111-4222-8333-444444444444";
const ISSUE = "SHU-FIXTURE-001";

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
  assert.equal(out.external_run_id, ATTEMPT);
  assert.equal(out.worker_identity, "hermes:test-host:pid7");
  assert.equal(leaseAtSpawnTime.status, "queued", "lease must be durable BEFORE the worker spawns");
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
  assert.equal(second.external_run_id, ATTEMPT);
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

test("monitor: queued / running lease -> RUNNING with granular status + worker identity", async () => {
  const pool = tempPool();
  const spawn = spawnRecorder([]);
  await launchBuilder({ ...BASE, io: poolIo(pool, spawn), env: {} });
  const running = await monitorRun({ run_id: ATTEMPT, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} });
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
  const out = await monitorRun({ run_id: ATTEMPT, attempt_id: ATTEMPT, target_sha: SHA, evidence: validEvidence(), current_head: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} });
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
  const args = { run_id: ATTEMPT, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} };
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
  const out = await monitorRun({ run_id: ATTEMPT, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, spawn), env: {} });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "WORKER_FAILED");
});

test("monitor: missing / corrupt lease -> UNCHANGED (fail closed, never a manufactured failure)", async () => {
  const pool = tempPool();
  const missing = await monitorRun({ run_id: ATTEMPT, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, () => {}), env: {} });
  assert.equal(missing.stage, "UNCHANGED");
  assert.match(missing.reason, /no lease/);
  mkdtempSync(pool);
  mkdirSync(join(pool, "leases"), { recursive: true });
  writeFileSync(join(pool, "leases", `${ATTEMPT}.json`), "{ not json");
  const corrupt = await monitorRun({ run_id: ATTEMPT, attempt_id: ATTEMPT, target_sha: SHA, token: "ignored", io: poolIo(pool, () => {}), env: {} });
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
  assert.equal(receipt.external_run_id, receipt.attempt_id, "pool run id is the lease key (attempt_id)");
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
