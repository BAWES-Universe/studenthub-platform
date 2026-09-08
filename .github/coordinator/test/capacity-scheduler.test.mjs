import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  CapacityScheduler,
  readableTaskStatus,
  validateCapacityPolicy,
} from "../capacity-scheduler.mjs";

function stateDir() {
  return mkdtempSync(join(tmpdir(), "shu70-capacity-"));
}

function policy(overrides = {}) {
  return {
    global_limit: 3,
    review_reserve: 1,
    hosts: { brick: 3, studenthub: 2 },
    accounts: { anthropic_shared: 2, openai_shared: 2 },
    runtimes: { "hermes-pool": 3, "codex-cli": 2, "claude-code": 2, "gpt-6": 1 },
    budget_micros: 1_000_000,
    max_deadline_ms: 3_600_000,
    max_retries: 2,
    max_revisions: 3,
    reservation_ttl_ms: 30_000,
    premium_runtimes: ["gpt-6"],
    premium_approvals: [],
    ...overrides,
  };
}

function task(id, overrides = {}) {
  return {
    task_id: id,
    role: "build",
    runtime: "hermes-pool",
    host: "brick",
    account: "anthropic_shared",
    repo: "BAWES-Universe/studenthub-platform",
    branch: `lane/${id}`,
    worktree: `/srv/worktrees/${id}`,
    overlap_keys: [],
    blocked_by: [],
    estimated_cost_micros: 10_000,
    deadline_ms: 60_000,
    retry: 0,
    revision: 0,
    priority: 2,
    ...overrides,
  };
}

test("four-task batch reserves review progress, one writer per branch, and isolated worktrees", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy() });
  const results = scheduler.reserveMany([
    task("build-a", { branch: "lane/shared" }),
    task("build-b", { branch: "lane/shared", worktree: "/srv/worktrees/b" }),
    task("review-c", { role: "review", runtime: "claude-code", account: "openai_shared" }),
    task("build-d", { host: "studenthub", account: "openai_shared" }),
  ]);
  assert.equal(results[0].status, "reserved");
  assert.equal(results[1].code, "BRANCH_WRITER_ACTIVE");
  assert.equal(results[2].status, "reserved", "review is considered first regardless of input order");
  assert.equal(results[3].status, "reserved");
  const active = Object.values(scheduler.snapshot().reservations).filter((r) => ["reserved", "running", "launch_unknown", "hold"].includes(r.status));
  assert.equal(active.length, 3);
  assert.equal(new Set(active.map((r) => r.worktree)).size, 3);
  assert.equal(active.filter((r) => r.branch === "lane/shared" && ["build", "revise"].includes(r.role)).length, 1);
});

test("Hermes sessions sharing one provider account consume one shared quota", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy({ accounts: { anthropic_shared: 1, openai_shared: 2 } }) });
  assert.equal(scheduler.reserve(task("hermes-1")).status, "reserved");
  const second = scheduler.reserve(task("hermes-2"));
  assert.equal(second.code, "ACCOUNT_CAPACITY");
  assert.match(second.hold_reason, /shared account anthropic_shared/);
});

test("LAUNCH_UNKNOWN and ambiguous HOLD retain capacity", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy({ accounts: { anthropic_shared: 1, openai_shared: 2 } }) });
  scheduler.reserve(task("unknown"));
  scheduler.transition("unknown", "launch_unknown", { hold_reason: "worker acceptance ambiguous" });
  assert.equal(scheduler.reserve(task("next")).code, "ACCOUNT_CAPACITY");
  scheduler.transition("unknown", "hold", { hold_reason: "liveness unknown" });
  assert.equal(scheduler.reserve(task("still-next")).code, "ACCOUNT_CAPACITY");
});

test("resource-scoped quota pause blocks one account while unrelated work continues", () => {
  let now = Date.parse("2026-09-08T12:00:00Z");
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy(), now: () => now });
  scheduler.pauseResource({ scope: "account", id: "anthropic_shared", reason: "quota", until: "2026-09-08T13:00:00Z" });
  const paused = scheduler.reserve(task("paused", { fallback_runtimes: [] }));
  assert.equal(paused.code, "RESOURCE_PAUSED");
  assert.equal(paused.next_automatic_action, "retry_after:2026-09-08T13:00:00Z");
  assert.equal(scheduler.reserve(task("unrelated", { account: "openai_shared", runtime: "codex-cli" })).status, "reserved");
  now = Date.parse("2026-09-08T13:00:01Z");
  assert.equal(scheduler.reserve(task("after-backoff")).status, "reserved", "expired pause clears automatically");
});

test("builders cannot consume the reviewer reserve", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy({ global_limit: 3, review_reserve: 1 }) });
  assert.equal(scheduler.reserve(task("builder-1")).status, "reserved");
  assert.equal(scheduler.reserve(task("builder-2", { account: "openai_shared", runtime: "codex-cli" })).status, "reserved");
  assert.equal(scheduler.reserve(task("builder-3", { host: "studenthub" })).code, "REVIEW_RESERVE");
  assert.equal(scheduler.reserve(task("review", { role: "review", host: "studenthub" })).status, "reserved");
});

test("unknown host/account quota and unknown cost are never interpreted as unlimited", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy() });
  const host = scheduler.reserve(task("unknown-host", { host: "mystery" }));
  assert.equal(host.code, "CAPACITY_UNKNOWN");
  assert.ok(host.human_decision);
  const account = scheduler.reserve(task("unknown-account", { account: "new_subscription" }));
  assert.equal(account.code, "CAPACITY_UNKNOWN");
  const cost = scheduler.reserve(task("unknown-cost", { estimated_cost_micros: null }));
  assert.equal(cost.code, "COST_UNKNOWN");
});

test("premium escalation and provider fallback require explicit new authority", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy() });
  const premium = scheduler.reserve(task("premium", { runtime: "gpt-6" }));
  assert.equal(premium.code, "PREMIUM_APPROVAL_REQUIRED");
  assert.ok(premium.human_decision);
  const trusted = new CapacityScheduler({ stateDir: stateDir(), policy: policy({ premium_approvals: ["approved"] }) });
  assert.equal(trusted.reserve(task("approved", { runtime: "gpt-6", premium_approved: true })).status, "reserved");

  scheduler.pauseResource({ scope: "account", id: "anthropic_shared", reason: "quota", until: null });
  const fallback = scheduler.reserve(task("fallback", { fallback_runtimes: ["codex-cli"] }));
  assert.equal(fallback.code, "UNSAFE_FALLBACK");
  assert.match(fallback.human_decision, /explicit new work order/);
  assert.equal(fallback.task.runtime, "hermes-pool");
});

test("deadlines, retries, revisions and total spending are bounded", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy({ budget_micros: 20_000 }) });
  assert.equal(scheduler.reserve(task("deadline", { deadline_ms: 3_600_001 })).code, "POLICY_BOUND");
  assert.equal(scheduler.reserve(task("retry", { retry: 3 })).code, "POLICY_BOUND");
  assert.equal(scheduler.reserve(task("revision", { revision: 4 })).code, "POLICY_BOUND");
  assert.equal(scheduler.reserve(task("cost-1", { estimated_cost_micros: 15_000 })).status, "reserved");
  assert.equal(scheduler.reserve(task("cost-2", { estimated_cost_micros: 6_000 })).code, "BUDGET_CAPACITY");
  scheduler.transition("cost-1", "completed", { actual_cost_micros: 12_000 });
  assert.equal(scheduler.snapshot().spent_micros, 12_000);
  assert.equal(scheduler.reserve(task("cost-3", { estimated_cost_micros: 9_000 })).code, "BUDGET_CAPACITY");
});

test("reserved acknowledgement expires, but running/unknown work never releases by age", () => {
  let now = Date.parse("2026-09-08T12:00:00Z");
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy({ accounts: { anthropic_shared: 1, openai_shared: 2 }, reservation_ttl_ms: 10 }), now: () => now });
  scheduler.reserve(task("reserved"));
  now += 11;
  assert.equal(scheduler.reserve(task("replacement")).status, "reserved");
  scheduler.transition("replacement", "dispatching");
  now += 1_000_000;
  assert.equal(scheduler.reserve(task("never-age-out")).code, "ACCOUNT_CAPACITY");
  scheduler.transition("replacement", "launch_unknown");
  assert.equal(scheduler.reserve(task("still-never-age-out")).code, "ACCOUNT_CAPACITY");
});

test("terminal task identity is immutable and cannot be recycled", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy() });
  scheduler.reserve(task("one-attempt"));
  scheduler.transition("one-attempt", "completed", { actual_cost_micros: 1_000 });
  const reused = scheduler.reserve(task("one-attempt"));
  assert.equal(reused.code, "TASK_ID_REUSED");
  assert.equal(scheduler.snapshot().spent_micros, 1_000);
});

test("dependency, overlap, and worktree exclusions fail before capacity is consumed", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy() });
  const blocked = scheduler.reserve(task("blocked", { blocked_by: ["SHU-67"] }));
  assert.equal(blocked.code, "DEPENDENCY_BLOCKED");
  assert.equal(scheduler.reserve(task("owner", { overlap_keys: ["coordinator-schema"] })).status, "reserved");
  assert.equal(scheduler.reserve(task("overlap", { overlap_keys: ["coordinator-schema"], account: "openai_shared" })).code, "OVERLAP_ACTIVE");
  assert.equal(scheduler.reserve(task("same-worktree", { worktree: "/srv/worktrees/owner", account: "openai_shared" })).code, "WORKTREE_ACTIVE");
  assert.equal(Object.keys(scheduler.snapshot().reservations).length, 1);
});

test("task input cannot self-authorize premium runtime or leak arbitrary pause text", () => {
  const scheduler = new CapacityScheduler({ stateDir: stateDir(), policy: policy() });
  assert.equal(scheduler.reserve(task("self-approved", { runtime: "gpt-6", premium_approved: true })).code, "PREMIUM_APPROVAL_REQUIRED");
  assert.throws(() => scheduler.pauseResource({
    scope: "account",
    id: "anthropic_shared",
    reason: "Bearer ghp_secret",
  }), /non-secret reason code/);
});

test("policy refuses implicit global budget and unbounded retry/deadline settings", () => {
  assert.throws(() => validateCapacityPolicy({ ...policy(), budget_micros: null }), /budget_micros/);
  assert.throws(() => validateCapacityPolicy({ ...policy(), max_deadline_ms: null }), /max_deadline/);
  assert.throws(() => validateCapacityPolicy({ ...policy(), max_retries: null }), /max_retries/);
});

test("readable status is allowlisted and never echoes prompts, tokens, or secrets", () => {
  const sensitiveTask = task("safe-status", { token: "ghp_secret", prompt: "private prompt", password: "hunter2" });
  const status = readableTaskStatus(sensitiveTask, {
    status: "hold",
    hold_reason: "account capacity reached",
    next_automatic_action: "wait_for_capacity",
    human_decision: null,
  });
  assert.deepEqual(Object.keys(status), [
    "task_id", "role", "runtime", "status", "hold_reason", "next_automatic_action", "human_decision", "estimated_cost_micros",
  ]);
  assert.doesNotMatch(JSON.stringify(status), /ghp_secret|private prompt|hunter2/);
  const hostile = readableTaskStatus({ ...sensitiveTask, task_id: "Bearer ghp_bad", runtime: "sk-secret" }, {
    status: "hold",
    hold_reason: "Bearer ghp_bad",
    human_decision: "use github_pat_secret",
  });
  assert.doesNotMatch(JSON.stringify(hostile), /ghp_bad|github_pat_secret|sk-secret/);
});

test("existing lock HOLDs visibly and is never stolen by elapsed time", () => {
  const root = stateDir();
  const scheduler = new CapacityScheduler({ stateDir: root, policy: policy() });
  mkdirSync(join(root, "capacity-ledger.lock"), { mode: 0o700 });
  const result = scheduler.reserve(task("locked"));
  assert.equal(result.code, "SCHEDULER_BUSY");
  assert.equal(existsSync(join(root, "capacity-ledger.json")), false);
  rmdirSync(join(root, "capacity-ledger.lock"));
});

test("state hardening does not follow a symlink or chmod its target", () => {
  const root = stateDir();
  const target = join(root, "target");
  const link = join(root, "state-link");
  mkdirSync(target, { mode: 0o777 });
  chmodSync(target, 0o777);
  symlinkSync(target, link);
  assert.throws(() => new CapacityScheduler({ stateDir: link, policy: policy() }), /ELOOP|ENOTDIR|unsafe/);
  assert.equal(statSync(target).mode & 0o777, 0o777, "rejected symlink target permissions must remain untouched");
});

test("malformed persisted costs fail closed without replacing forensic evidence", () => {
  const root = stateDir();
  const ledgerPath = join(root, "capacity-ledger.json");
  const corrupted = `${JSON.stringify({
    version: "1.0.0",
    spent_micros: "not-a-number",
    reservations: {},
    pauses: {},
  })}\n`;
  writeFileSync(ledgerPath, corrupted, { mode: 0o600 });
  const scheduler = new CapacityScheduler({ stateDir: root, policy: policy() });
  const result = scheduler.reserve(task("must-not-fail-open"));
  assert.equal(result.code, "LEDGER_INVALID");
  assert.equal(result.status, "hold");
  assert.equal(readFileSync(ledgerPath, "utf8"), corrupted, "corrupt ledger remains available for diagnosis");
  assert.equal(existsSync(join(root, "capacity-ledger.lock")), false, "transaction lock is released");
});

test("four concurrent processes cannot oversubscribe a two-slot ledger", async () => {
  const root = stateDir();
  const gate = join(root, "start");
  const moduleUrl = pathToFileURL(join(process.cwd(), ".github/coordinator/capacity-scheduler.mjs")).href;
  const concurrentPolicy = policy({ global_limit: 2, review_reserve: 0, hosts: { brick: 4, studenthub: 4 }, accounts: { anthropic_shared: 4, openai_shared: 4 } });
  const serializedPolicy = JSON.stringify(concurrentPolicy);
  const script = `
    import { existsSync } from "node:fs";
    import { CapacityScheduler } from ${JSON.stringify(moduleUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    while (!existsSync(process.env.GATE)) await sleep(2);
    const scheduler = new CapacityScheduler({ stateDir: process.env.STATE, policy: JSON.parse(process.env.POLICY) });
    const task = JSON.parse(process.env.TASK);
    let result;
    for (let i = 0; i < 100; i += 1) {
      result = scheduler.reserve(task);
      if (result.code !== "SCHEDULER_BUSY") break;
      await sleep(2);
    }
    process.stdout.write(JSON.stringify({ status: result.status, code: result.code }));
  `;
  const children = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        STATE: root,
        GATE: gate,
        POLICY: serializedPolicy,
        TASK: JSON.stringify(task(`concurrent-${index}`, { account: index % 2 ? "openai_shared" : "anthropic_shared" })),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  mkdirSync(gate);
  const results = await Promise.all(children);
  assert.equal(results.filter((result) => result.status === "reserved").length, 2);
  assert.equal(results.filter((result) => result.code === "GLOBAL_CAPACITY").length, 2);
  const final = new CapacityScheduler({ stateDir: root, policy: concurrentPolicy });
  assert.equal(Object.values(final.snapshot().reservations).filter((r) => r.status === "reserved").length, 2);
});
