import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DurableSupervisor, signedSupervisorRequest, SUPERVISOR_PROTOCOL_VERSION } from "../supervisor.mjs";
import { carriedSupervisorOutcome, supervisorOrder } from "../supervisor-dispatch.mjs";
import { runFixtureDriver, restoreFixture } from "../fixture-driver.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from "./fixture/episode-harness.mjs";

const SECRET = "shu250-deterministic-secret-at-least-32-bytes";
function setup(t, options = {}) {
  const h = createEpisodeHarness({ githubToken: "fake-token" });
  const stateDir = join(h.dir, "supervisor");
  const children = [], contracts = [], scheduled = [], spawnPhases = [];
  const make = () => new DurableSupervisor({ stateDir, secret: SECRET, schedule: fn => scheduled.push(fn),
    spawnWorker: (order, contract) => {
      spawnPhases.push(supervisor.store.readLaunch(order.attempt_id).phase);
      const child = new EventEmitter();
      child.pid = 100 + children.length; child.processStartToken = `start-${child.pid}`;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      children.push(child); contracts.push(contract); return child;
    }, ...options });
  let supervisor = make();
  h.adapters["codex-cli"].launchBuilder = () => new Promise(resolve => setTimeout(() => resolve({ stage: "HOLD" }), 1500));
  const io = { supervisorTransport: ({ request }) => supervisor.submit(request) };
  const tick = extra => h.runTick({ env: { SHU_SUPERVISOR_SECRET: SECRET }, io: { ...io, ...extra } });
  const drain = async () => { while (scheduled.length) await scheduled.shift()(); };
  const complete = (result, exit_code = 0, index = 0) => {
    const contract = contracts[index];
    assert.equal(supervisor.store.recordCompletion({ ...contract, version: SUPERVISOR_PROTOCOL_VERSION,
      exit_code, finished_at: "2026-09-10T12:01:00.000Z", result }).ok, true);
    children[index].emit("exit", exit_code);
  };
  const callback = (stage = "BUILD_READY", result_sha = SHA_WRITE) => ({ stage: "COMPLETED", worker_identity: "codex:worker-observed",
    callback: { attempt_id: contracts[0].attempt_id, target_sha: SHA_INPUT, result_sha, stage, links: ["https://example.invalid/worker-artifact"] } });
  t.after(() => { for (const child of children) child.emit("exit", 1); h.cleanup(); });
  return { h, tick, drain, children, contracts, complete, callback, io, spawnPhases,
    get supervisor() { return supervisor; }, restart() { scheduled.length = 0; supervisor = make(); return supervisor.recover(); } };
}

test("SHU-250: real tick returns while a long-running supervised child executes", async t => {
  const f = setup(t);
  const start = performance.now();
  await f.tick();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, "SHU250_RESPONSIVE: tick must return within 1000ms without awaiting worker");
  await f.drain();
  assert.equal(f.spawnPhases[0], "spawn_attempted", "SHU250_PRESPAWN: durable spawn_attempted must precede process creation");
  assert.equal(f.children.length, 1);
  const later = performance.now(); await f.tick();
  assert.ok(performance.now() - later < 1000, "SHU250_RESPONSIVE: later tick must return while worker executes");
  assert.equal(f.h.receipts()[0].stage, "RUNNING");
  assert.equal(f.supervisor.store.readRun(f.contracts[0].attempt_id).status, "running");
  t.diagnostic(`submission tick ${elapsed.toFixed(1)}ms; later tick ${(performance.now() - later).toFixed(1)}ms; child still running`);
});

test("SHU-250: concurrent ticks recover the same durable attempt with one launch", async t => {
  const f = setup(t);
  // Lose acknowledgement after durable acceptance; both subsequent real ticks
  // read the same LAUNCH_UNKNOWN receipt and submit the same signed order.
  await f.tick({ supervisorTransport: async ({ request }) => { await f.supervisor.submit(request); throw new Error("crash after submit"); } });
  assert.equal(f.h.receipts()[0].stage, "LAUNCH_UNKNOWN");
  await Promise.all([f.tick(), f.tick()]); await f.drain();
  assert.equal(f.children.length, 1, "SHU250_ONCE: concurrent ticks must launch exactly once");
  assert.equal(f.supervisor.store.attempts().length, 1);
});

test("SHU-250: crash after submission recovers once and ambiguous restart HOLDs", async t => {
  const f = setup(t); await f.tick();
  f.restart(); await f.drain();
  assert.equal(f.children.length, 1, "SHU250_RECOVERY: accepted order must recover exactly once");
  const [held] = f.restart(); await f.drain();
  assert.equal(held.status, "hold"); assert.equal(f.children.length, 1);
});

test("SHU-250: conflicting retry HOLDs without scheduling or launching", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  const order = f.supervisor.store.readOrder(f.contracts[0].attempt_id);
  const response = await f.supervisor.submit(signedSupervisorRequest({ ...order, branch: "different" }, SECRET));
  assert.equal(response.stage, "HOLD", "SHU250_CONFLICT: conflicting retry must HOLD before launch");
  await f.drain(); assert.equal(f.children.length, 1);
});

test("SHU-250: worker death surfaces a terminal HOLD receipt without blocking later tick", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  f.children[0].emit("exit", 1, "SIGKILL");
  const start = performance.now(); await f.tick();
  assert.equal(f.h.receipts()[0].stage, "HOLD");
  assert.ok(performance.now() - start < 1000, "SHU250_DEATH: worker death must not block a later tick");
});

test("SHU-250: completion with no worker evidence HOLDs", async t => {
  const f = setup(t); await f.tick(); await f.drain(); f.complete(null);
  await f.tick();
  assert.equal(f.h.receipts()[0].stage, "HOLD", "SHU250_NO_EVIDENCE: completion without worker callback must HOLD");
});

test("SHU-250: carried result SHA disagrees with verified head and HOLDs", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  // Also exercise a review transport directly: input head matches but a forged
  // result_sha must not be accepted merely because reviews do not move heads.
  const receipt = { ...f.h.receipts()[0], requested_worker: "claude-verifier", role: "review", runtime: "claude-code" };
  const response = { version: SUPERVISOR_PROTOCOL_VERSION, ok: true, durable: true, stage: "COMPLETED",
    attempt_id: receipt.attempt_id, target_sha: receipt.target_sha, result: f.callback("PASS") };
  assert.equal(carriedSupervisorOutcome(response, receipt, { current_head: SHA_INPUT, headVerified: true }).stage, "HOLD",
    "SHU250_RESULT_SHA: carried result_sha must equal the verified head");
  f.complete(f.callback()); await f.tick();
  assert.equal(f.h.receipts()[0].stage, "HOLD", "SHU250_RESULT_SHA: carried result_sha must equal the verified head");
});

test("SHU-250: bound callback and observed identity survive completion and restart", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  f.h.branchHead.value = SHA_WRITE; f.complete(f.callback()); f.restart();
  await f.tick();
  const receipt = f.h.receipts()[0];
  assert.equal(receipt.stage, "COMPLETED"); assert.equal(receipt.result_sha, SHA_WRITE);
  assert.equal(receipt.worker_identity, "codex:worker-observed");
});

test("SHU-250: stopped heartbeat never declares a live worker dead", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  const contract = f.contracts[0];
  f.children[0].emit("message", { ...contract, version: SUPERVISOR_PROTOCOL_VERSION, type: "heartbeat", at: "2026-09-10T12:00:10.000Z" });
  await f.tick();
  assert.equal(f.h.receipts()[0].timestamps.heartbeat, "2026-09-10T12:00:10.000Z");
  // Remove heartbeat transport entirely while the process remains alive.
  const run = f.supervisor.store.readRun(contract.attempt_id);
  f.supervisor.store.writeRun(contract.attempt_id, { ...run, heartbeat: null });
  await f.tick();
  assert.equal(f.h.receipts()[0].stage, "RUNNING", "SHU250_HEARTBEAT: missing heartbeat must never cause terminal failure");
});

test("SHU-250: unknown socket and result contract versions fail closed", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  const receipt = f.h.receipts()[0];
  const response = { version: "future", ok: true, durable: true, attempt_id: receipt.attempt_id, target_sha: receipt.target_sha, stage: "RUNNING" };
  assert.equal(carriedSupervisorOutcome(response, receipt).stage, "HOLD");
  const request = signedSupervisorRequest(supervisorOrder(receipt), SECRET); request.version = "future";
  assert.equal((await f.supervisor.submit(request)).stage, "HOLD");
  assert.equal(f.supervisor.store.recordCompletion({ ...f.contracts[0], version: "future", result: f.callback(), exit_code: 0 }).ok, false);
});

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "shu250-driver-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let card = { assigneeId: "original-owner", stateId: "backlog" };
  return { journalPath: join(dir, "journal.json"), issueId: "SHU-999", fixtureId: "SHU-999", todoStateId: "todo",
    readIssue: async () => ({ ...card }), updateIssue: async (_id, value) => { card = { ...value }; }, wait: async () => {} };
}
test("SHU-250: fixture driver unassigns and restores on terminal path", async t => {
  const f = fixture(t); let ticks = 0;
  await runFixtureDriver({ ...f, tick: async () => {
    assert.deepEqual(await f.readIssue(), { assigneeId: null, stateId: "todo" }); return { terminal: ++ticks === 2 };
  } });
  assert.deepEqual(await f.readIssue(), { assigneeId: "original-owner", stateId: "backlog" }, "SHU250_RESTORE: terminal path must restore original assignment and state");
  assert.equal(fs.existsSync(f.journalPath), false);
});

test("SHU-250: failed run restores and failed restore retains recoverable journal", async t => {
  const f = fixture(t);
  await assert.rejects(runFixtureDriver({ ...f, tick: async () => { throw new Error("run failed"); } }), /run failed/);
  assert.equal((await f.readIssue()).assigneeId, "original-owner");
  await assert.rejects(runFixtureDriver({ ...f, tick: async () => ({ terminal: true }),
    updateIssue: async (id, patch) => { if (patch.assigneeId) throw new Error("restore unavailable"); await f.updateIssue(id, patch); } }), /restore unavailable/);
  assert.equal(fs.existsSync(f.journalPath), true);
  await assert.rejects(runFixtureDriver({ ...f, tick: async () => ({ terminal: true }) }), /restore the retained journal/);
  await restoreFixture(f); assert.equal((await f.readIssue()).assigneeId, "original-owner");
});

const mutations = [
  ["awaited in-process launch", "reconcile.mjs", 'launch = await dispatchAdapterModule.launchBuilder({', 'launch = await (await loadAdapterModule(adapter, io)).launchBuilder({', "real tick returns", "SHU250_RESPONSIVE: tick must return within 1000ms without awaiting worker"],
  ["drop pre-spawn marker", "supervisor.mjs", `this.store.markLaunch(attemptId, {
      attempt_id: attemptId,
      phase: "spawn_attempted",
      spawn_attempted_at: this.now(),
      completion_token_hash: createHash("sha256").update(completionToken).digest("hex"),
    });`, '', "real tick returns", "SHU250_PRESPAWN: durable spawn_attempted must precede process creation"],
  ["conflicting retry", "supervisor.mjs", 'if (!accepted.ok) return accepted;', 'if (!accepted.ok) { this.spawnWorker(request.order, {}); return { ok: true, stage: "RUNNING" }; }', "conflicting retry HOLDs", "SHU250_CONFLICT: conflicting retry must HOLD before launch"],
  ["drop terminal fixture restore", "fixture-driver.mjs", 'await restoreFixture({ journalPath, readIssue, updateIssue });', '/* restore removed */', "fixture driver unassigns", "SHU250_RESTORE: terminal path must restore original assignment and state"],
  ["accept no evidence", "supervisor-dispatch.mjs", 'return { ...identity, stage: "HOLD", reason: "completion has no bound callback evidence" };', 'return { ...identity, stage: "FAILED", error_code: "exit-only" };', "completion with no worker evidence", "SHU250_NO_EVIDENCE: completion without worker callback must HOLD"],
  ["accept unbound result SHA", "supervisor-dispatch.mjs", '|| (callback.result_sha != null && callback.result_sha !== current_head)', '', "carried result SHA disagrees", "SHU250_RESULT_SHA: carried result_sha must equal the verified head"],
  ["missing heartbeat terminal", "supervisor-dispatch.mjs", 'if (["ACCEPTED", "RUNNING"].includes(response.stage)) {', 'if (response.stage === "RUNNING" && !response.heartbeat) return { ...identity, stage: "FAILED" };\n  if (["ACCEPTED", "RUNNING"].includes(response.stage)) {', "stopped heartbeat", "SHU250_HEARTBEAT: missing heartbeat must never cause terminal failure"],
];
for (const [name, file, before, after, pattern, named] of mutations) {
  test(`SHU-250 mutation: ${name}`, () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "shu250-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), dir, { recursive: true });
      const path = join(dir, file), original = fs.readFileSync(path, "utf8");
      assert.equal(original.split(before).length, 2, `unique mutation anchor: ${name}`);
      fs.writeFileSync(path, original.replace(before, after));
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, join(dir, "test/supervisor-dispatch.test.mjs")], { env, encoding: "utf8", timeout: 15000 });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 1, output); assert.match(output, /AssertionError/); assert.ok(output.includes(named), output);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("SHU-250: different attempts cannot own the same branch concurrently", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  const order = f.supervisor.store.readOrder(f.contracts[0].attempt_id);
  const conflict = { ...order, attempt_id: "99999999-1111-4222-8333-444444444444" };
  assert.equal((await f.supervisor.submit(signedSupervisorRequest(conflict, SECRET))).stage, "HOLD");
  await f.drain(); assert.equal(f.children.length, 1, "SHU250_BRANCH: one unfinished child per branch");
});

test("SHU-250: invalid heartbeat version HOLDs and callback binding is never rewritten", async t => {
  const f = setup(t); await f.tick(); await f.drain();
  f.children[0].emit("message", { version: "future", type: "heartbeat" });
  assert.equal(f.supervisor.store.readRun(f.contracts[0].attempt_id).status, "hold");
  const receipt = f.h.receipts()[0], result = f.callback();
  result.callback.attempt_id = "wrong-attempt";
  const response = { version: SUPERVISOR_PROTOCOL_VERSION, ok: true, durable: true,
    attempt_id: receipt.attempt_id, target_sha: receipt.target_sha, stage: "COMPLETED", result };
  assert.equal(carriedSupervisorOutcome(response, receipt, { current_head: SHA_WRITE, headVerified: true }).stage, "HOLD");
});

test("SHU-250: bounded driver exhaustion restores fixture", async t => {
  const f = fixture(t); let ticks = 0;
  await assert.rejects(runFixtureDriver({ ...f, maxTicks: 2, tick: async () => { ticks++; return { terminal: false }; } }), /tick limit/);
  assert.equal(ticks, 2); assert.equal((await f.readIssue()).assigneeId, "original-owner");
});

for (const selfReview of [false, true]) {
  test(`SHU-250: supervised review ${selfReview ? "rejects its author" : "persists observed identity before PASS"}`, async t => {
    const f = setup(t); await f.tick(); await f.drain();
    f.h.branchHead.value = SHA_WRITE; f.complete(f.callback()); await f.tick(); await f.tick(); await f.drain();
    const review = f.h.receipts().find(r => r.requested_worker === "claude-verifier");
    assert.ok(review, "review successor must be launched");
    f.complete({ stage: "COMPLETED", worker_identity: selfReview ? "codex:worker-observed" : "claude:observed-reviewer",
      callback: { attempt_id: review.attempt_id, target_sha: SHA_WRITE, result_sha: SHA_WRITE, stage: "PASS", links: ["https://example.invalid/review"] } }, 0, 1);
    await f.tick();
    assert.equal(f.h.receiptFor(review.attempt_id).stage, selfReview ? "HOLD" : "COMPLETED");
  });
}

test("SHU-250: adapter refusal cannot be overridden by its successful callback", async t => {
  const f = setup(t); await f.tick(); await f.drain(); f.h.branchHead.value = SHA_WRITE;
  f.complete({ ...f.callback(), stage: "HOLD", pause_adapter: true }); await f.tick();
  assert.equal(f.h.receipts()[0].stage, "HOLD");
});

test("SHU-250: child wrapper transports adapter artifact verbatim and rechecks authority", async t => {
  const { executeSupervisedOrder } = await import("../supervisor-worker.mjs");
  const f = setup(t); await f.tick(); await f.drain();
  const policy = join(f.h.dir, "policy.mjs"); fs.writeFileSync(policy, 'export const authorizeWorkOrder = () => true;');
  const result = f.callback(); const messages = [];
  await executeSupervisedOrder({ order: f.supervisor.store.readOrder(f.contracts[0].attempt_id), contract: f.contracts[0],
    stateDir: join(f.h.dir, "supervisor"), authorizationModule: policy }, {
    send: message => messages.push(message), loadAdapter: async () => ({ launchBuilder: async options => {
      assert.equal(options.io.resultStillAuthorized(), true); return result;
    } }),
  });
  assert.deepEqual(f.supervisor.store.validatedCompletion(f.contracts[0].attempt_id).completion.result, result);
  assert.equal(messages[0].type, "heartbeat");
  const denied = join(f.h.dir, "denied.mjs"); fs.writeFileSync(denied, 'export const authorizeWorkOrder = () => false;');
  await assert.rejects(executeSupervisedOrder({ order: {}, authorizationModule: denied }, {
    loadAdapter: async () => { assert.fail("denied order must not load adapter"); },
  }), /authorization refused/);
});

test("SHU-250: legacy ambiguous launch is never resubmitted as a fresh supervised child", async t => {
  const f = setup(t);
  f.h.adapters["codex-cli"].launchBuilder = async () => ({ stage: "LAUNCH_UNKNOWN" });
  await f.h.runTick();
  let contacts = 0;
  await f.tick({ supervisorTransport: async () => { contacts++; return { ok: false }; } });
  assert.equal(contacts, 0, "legacy ambiguous launch must not contact supervisor");
  assert.equal(f.h.receipts()[0].stage, "LAUNCH_UNKNOWN");
  assert.equal(f.supervisor.store.attempts().length, 0);
});
