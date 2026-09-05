// Lifecycle tests (GPT lifecycle BLOCK @ f03d445) — the executable coordinator
// must poll active RUNNING runs through monitorRun() and persist terminal
// transitions (COMPLETED / FAILED / HOLD), so the pilot slot is never occupied
// forever. Multi-process shape: independent main() calls over ONE persistent
// fake Linear store; the durable-read branch feeds the lifecycle pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseReceiptsFromComments, receiptCommentBody, parseEvidenceFromComments } from "../reconcile.mjs";

const SHA = "c".repeat(40);
const TRIGGER = "agtch_life_1";

const FIXTURE_NODE = {
  id: "11111111-aaaa-4bbb-8ccc-000000000001",
  identifier: "SHU-FIXTURE-001",
  title: "Fixture: seeded-defect probe card",
  state: { name: "Todo" },
  priorityLabel: "High",
  labels: { nodes: [{ name: "fixture-safe" }] },
  assignee: null,
  delegate: null,
  parent: null,
  relations: { nodes: [] },
};
const SECOND_NODE = {
  id: "11111111-aaaa-4bbb-8ccc-000000000099",
  identifier: "SHU-099",
  title: "Second eligible card",
  state: { name: "Todo" },
  priorityLabel: "High",
  labels: { nodes: [{ name: "fixture-safe" }] },
  assignee: null,
  delegate: null,
  parent: null,
  relations: { nodes: [] },
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
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
  };
  const dir = mkdtempSync(join(tmpdir(), "coordinator-life-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

let clockMs = 1700000000000;
const tick = () => new Date((clockMs += 1000)).toISOString();

// persistentStore — one Linear fake across process-runs: issues served from a
// mutable list, comments stored per issue, callback/evidence comments accepted.
// commentCreate REJECTS non-UUID issue ids (GPT BLOCK #3: real Linear comment
// mutations require the issue UUID, never the human identifier).
function persistentStore(issueNodes, commentBodies) {
  const uuidByIdentifier = new Map(issueNodes.map((n) => [n.identifier, n.id]));
  const impl = async (url, opts) => {
    assert.equal(url, "https://api.linear.app/graphql");
    const { query } = JSON.parse(opts.body);
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes: issueNodes } });
    if (query.includes("CoordinatorIssueComments")) {
      const issueId = JSON.parse(opts.body).variables.issueId;
      const nodes = issueNodes.some((n) => n.id === issueId || n.identifier === issueId) ? [...commentBodies] : [];
      return respond({ issue: { comments: { nodes } } });
    }
    if (query.includes("commentCreate")) {
      const { issueId, body } = JSON.parse(opts.body).variables;
      if (issueId !== issueNodes[0].id && !issueNodes.some((n) => n.id === issueId)) {
        throw new Error(`NON-UUID comment write attempted (${issueId}) — real Linear mutations require the issue UUID`);
      }
      commentBodies.push({ body, createdAt: tick() });
      return respond({ commentCreate: { success: true, comment: { id: `c${commentBodies.length}` } } });
    }
    return respond({});
  };
  impl.comments = commentBodies;
  return impl;
}

// waAgent — counts TRIGGER POSTs separately from poll GETs; poll outcome is set
// by the test between runs (default: still queued = RUNNING persists).
function waAgent() {
  let triggers = 0;
  let pollBody = { object: "workspace_agent.trigger_run", id: "apirun_life_1", status: "queued", agent_id: null, error: null };
  const impl = async (url, opts) => {
    if (url.includes("/runs/")) {
      return { status: 200, ok: true, json: async () => ({ ...pollBody }) };
    }
    triggers += 1;
    return { status: 202, ok: true, json: async () => ({ conversation_url: "https://chatgpt.com/c/life", agent_trigger_run_id: "apirun_life_1" }) };
  };
  impl.triggers = () => triggers;
  impl.setPoll = (body) => {
    pollBody = { object: "workspace_agent.trigger_run", id: "apirun_life_1", status: "queued", agent_id: null, error: null, ...body };
  };
  return impl;
}

const ENV = {
  ENABLE_DISPATCH: "true",
  LINEAR_API_TOKEN: "tok",
  GITHUB_TOKEN: "",
  WORKSPACE_AGENT_ACCESS_TOKEN: "wa-tok",
  WORKSPACE_AGENT_TRIGGER_ID: TRIGGER,
  DISPATCH_TARGET_SHA: SHA,
};

function makeRun(store, wa) {
  const out = [];
  return main([], ENV, {
    configPath: tempConfig(),
    stdout: (s) => out.push(s),
    fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
    fetchDurable: true,
    pollRuns: true,
  }).then((code) => ({ code, out }));
}

function callbackComment(attempt_id) {
  return {
    body: [
      "<!-- coordinator-callback v1 -->",
      "coordinator-callback v1",
      "```json",
      JSON.stringify({ attempt_id, target_sha: SHA, stage: "BUILD_READY", links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/99"] }),
      "```",
    ].join("\n"),
    createdAt: tick(),
  };
}

test("lifecycle: polled completed WITHOUT callback -> durable HOLD; the issue is parked, never auto-redispatched", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  const r1 = await makeRun(store, wa);
  assert.equal(r1.code, 0, r1.out.join("\n"));
  assert.equal(wa.triggers(), 1);
  assert.equal(parseReceiptsFromComments(comments)[0].stage, "RUNNING", "run 1 persists RUNNING");

  // Run 2 (fresh process): lifecycle polls the RUNNING run; upstream completed
  // but NO callback evidence on the issue -> durable HOLD, zero new triggers.
  wa.setPoll({ status: "completed", agent_id: "agt_life_1" });
  const r2 = await makeRun(store, wa);
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(wa.triggers(), 1, "polling must never launch a second worker");
  const held = parseReceiptsFromComments(comments);
  assert.equal(held.length, 1);
  assert.equal(held[0].stage, "HOLD", "completed without validated callback must persist HOLD");
  assert.equal(held[0].adapter_status, "completed");
  assert.ok(r2.out.some((l) => l.includes("RUNNING -> HOLD")), `lifecycle transition logged: ${r2.out.join("\n")}`);

  // Run 3: HOLD is terminal -> the SLOT is free, but the HOLD issue is parked
  // for a human — no auto-redispatch, no second worker.
  const r3 = await makeRun(store, wa);
  assert.equal(wa.triggers(), 1, "a terminal HOLD issue is parked for human review, never auto-redispatched");
  const after3 = parseReceiptsFromComments(comments);
  assert.equal(after3[0].stage, "HOLD");
});

test("lifecycle: polled completed WITH matching callback -> durable COMPLETED with agent_id", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  const r1 = await makeRun(store, wa);
  assert.equal(wa.triggers(), 1);
  const [running] = parseReceiptsFromComments(comments);

  // The worker posts its structured callback to the issue thread (durable), then
  // the next run polls completed and validates it against the SAME attempt.
  comments.push(callbackComment(running.attempt_id));
  wa.setPoll({ status: "completed", agent_id: "agt_life_2" });
  const r2 = await makeRun(store, wa);
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(wa.triggers(), 1, "the poll itself never launches");
  const done = parseReceiptsFromComments(comments);
  assert.equal(done.length, 1);
  assert.equal(done[0].stage, "COMPLETED", "validated callback + completed poll must persist COMPLETED");
  assert.equal(done[0].worker_identity, "agt_life_2", "agent_id from the poll is persisted");
  assert.ok(done[0].evidence_links.length >= 1, "callback evidence links persisted");

  // COMPLETED parks the issue (the fixture proof STOPS before merge — the card
  // waits for the human/next step, never auto-redispatches).
  const r3 = await makeRun(store, wa);
  assert.equal(wa.triggers(), 1, "a COMPLETED issue is parked, not relaunched");
  assert.equal(parseReceiptsFromComments(comments)[0].stage, "COMPLETED");
});

test("lifecycle: upstream failure -> durable FAILED; the slot retries with exactly ONE new attempt", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  await makeRun(store, wa);
  assert.equal(wa.triggers(), 1);

  wa.setPoll({ status: "failed", agent_id: "agt_life_3", error: { code: "run_failed" } });
  const r2 = await makeRun(store, wa);
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(wa.triggers(), 1, "polling never launches");
  const failed = parseReceiptsFromComments(comments);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stage, "FAILED", "upstream failure must persist FAILED");
  assert.equal(failed[0].adapter_status, "failed");
  assert.equal(failed[0].worker_identity, "agt_life_3");

  // FAILED is the retryable terminal: the next run launches exactly ONE new
  // attempt — never two, never zero (a genuine failure is not a park).
  const r3 = await makeRun(store, wa);
  assert.equal(wa.triggers(), 2, "exactly one retry after a genuine run failure");
  const after3 = parseReceiptsFromComments(comments);
  assert.equal(after3.filter((r) => r.stage === "RUNNING").length, 1);
  assert.equal(after3.filter((r) => r.stage === "FAILED").length, 1);
});

test("receipt resolution is by explicit createdAt ordering, not array order", () => {
  // Array deliberately out of order: the RUNNING comment (older) comes LAST.
  const older = { createdAt: "2026-09-05T10:00:00.000Z", body: receiptCommentBody({ ...JSON.parse(JSON.stringify(requireReceipt("RUNNING"))), stage: "RUNNING" }) };
  const newer = { createdAt: "2026-09-05T11:00:00.000Z", body: receiptCommentBody({ ...JSON.parse(JSON.stringify(requireReceipt("RUNNING"))), stage: "HOLD", external_run_id: null, adapter_status: "completed" }) };
  const receipts = parseReceiptsFromComments([newer, older]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].stage, "HOLD", "newest createdAt must win even when it appears first in the array");
});

function requireReceipt(stage) {
  const attempt_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  return {
    receipt_version: "1.0.0",
    issue_id: "SHU-FIXTURE-001",
    attempt_id,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage,
    requested_worker: "codex-builder",
    worker_identity: null,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-FIXTURE-001",
    target_sha: SHA,
    external_run_id: stage === "RUNNING" ? "apirun_life_1" : null,
    adapter_status: stage === "RUNNING" ? "queued" : stage === "HOLD" ? "completed" : null,
    timestamps: { reserved: "2026-09-05T09:00:00.000Z", launch: "2026-09-05T09:01:00.000Z", heartbeat: null, terminal: stage === "HOLD" ? "2026-09-05T11:00:00.000Z" : null },
    evidence_links: [],
    last_activity: "2026-09-05T11:00:00.000Z",
    notes: ["x"],
  };
}

test("parseEvidenceFromComments extracts the callback for the matching attempt only", () => {
  const mine = callbackComment("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const other = callbackComment("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
  const ev = parseEvidenceFromComments([other, mine], "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.ok(ev);
  assert.equal(ev.target_sha, SHA);
  assert.ok(ev.links.length === 1);
  assert.equal(parseEvidenceFromComments([other], "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), null);
});

test("BLOCK #1: dispatch-disabled mode makes ZERO workspace calls and ZERO Linear writes", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  // Seed the durable store with an existing RUNNING receipt (as a previous
  // enabled run would leave behind), then run with dispatch DISABLED.
  const enabledCfg = tempConfig();
  await main(
    [],
    ENV,
    {
      configPath: enabledCfg,
      stdout: () => {},
      fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
      fetchDurable: true,
      pollRuns: true,
    },
  );
  assert.equal(parseReceiptsFromComments(comments)[0].stage, "RUNNING");
  const writesBefore = comments.length;
  const triggersBefore = wa.triggers();

  const disabledEnv = { ...ENV, ENABLE_DISPATCH: "false" };
  const out = [];
  const cfg = JSON.parse(readFileSync(enabledCfg, "utf8"));
  const disabledCfgPath = join(mkdtempSync(join(tmpdir(), "coordinator-off-")), "config.json");
  writeFileSync(disabledCfgPath, JSON.stringify({ ...cfg, enable_dispatch: false }));
  const code = await main([], disabledEnv, {
    configPath: disabledCfgPath,
    stdout: (s) => out.push(s),
    fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
    fetchDurable: true,
    pollRuns: true,
  });
  assert.equal(code, 0);
  assert.equal(wa.triggers(), triggersBefore, "disabled mode must never call Workspace Agents");
  assert.equal(comments.length, writesBefore, "disabled mode must never write Linear comments");
});

test("BLOCK #2: a BLOCKED/FAILED callback never authorizes COMPLETED; newest callback wins", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  await makeRun(store, wa);
  const [running] = parseReceiptsFromComments(comments);

  const cb = (stage, createdAt) => ({
    body: [
      "<!-- coordinator-callback v1 -->",
      "coordinator-callback v1",
      "```json",
      JSON.stringify({ attempt_id: running.attempt_id, target_sha: SHA, stage, links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/99"] }),
      "```",
    ].join("\n"),
    createdAt,
  });
  // Newer BLOCKED callback must win over an older BUILD_READY one — and BLOCKED
  // must never produce COMPLETED even when the upstream run status says completed.
  comments.push(cb("BUILD_READY", tick()));
  comments.push(cb("BLOCKED", tick()));
  wa.setPoll({ status: "completed", agent_id: "agt_life_blocked" });
  const r2 = await makeRun(store, wa);
  assert.equal(r2.code, 0, r2.out.join("\n"));
  const after = parseReceiptsFromComments(comments);
  assert.equal(after.length, 1);
  assert.equal(after[0].stage, "HOLD", "BLOCKED callback must yield HOLD, never COMPLETED");
  assert.match(after[0].notes.join(" "), /callback REJECTED|without validated callback|completed/i);
});

test("BLOCK #3: lifecycle terminal writes use the issue UUID (store rejects identifiers)", async () => {
  // The UUID-enforcing store throws on identifier writes; a lifecycle terminal
  // transition therefore only succeeds when the coordinator resolves UUIDs.
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  const r1 = await makeRun(store, wa);
  assert.equal(r1.code, 0, r1.out.join("\n"));
  wa.setPoll({ status: "failed", agent_id: "agt_life_uuid", error: { code: "run_failed" } });
  const r2 = await makeRun(store, wa);
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(parseReceiptsFromComments(comments)[0].stage, "FAILED", "terminal write succeeded via the issue UUID");
});

test("BLOCK #4: an unreadable live GitHub head prevents COMPLETED (HOLD, never assume equality)", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  const env = { ...ENV, GITHUB_TOKEN: "gh-tok", DISPATCH_TARGET_SHA: SHA };
  const runOnce = async () => {
    const out = [];
    return main([], env, {
      configPath: tempConfig(),
      stdout: (s) => out.push(s),
      fetchImpl: async (url, opts) => {
        if (url.includes("api.linear.app")) return store(url, opts);
        if (url.includes("api.github.com")) return { status: 404, ok: false, json: async () => ({}) }; // branch unreadable
        return wa(url, opts);
      },
      fetchDurable: true,
      pollRuns: true,
    }).then((code) => ({ code, out }));
  };
  const r1 = await runOnce();
  assert.equal(parseReceiptsFromComments(comments)[0].stage, "RUNNING");
  // Worker posts a VALID callback, upstream completed — but the branch head
  // cannot be verified (404) → HOLD, never COMPLETED.
  const [running] = parseReceiptsFromComments(comments);
  comments.push(callbackComment(running.attempt_id));
  wa.setPoll({ status: "completed", agent_id: "agt_life_head" });
  const r2 = await runOnce();
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(parseReceiptsFromComments(comments)[0].stage, "HOLD", "unverifiable live head must HOLD a completed run");
  assert.ok(r2.out.some((l) => l.includes("RUNNING -> HOLD")), r2.out.join("\n"));
});

test("BLOCK #5: retries are capped — after max_failed_attempts the issue parks and never relaunches", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  const runOnce = async () => {
    const out = [];
    const code = await main([], ENV, {
      configPath: tempConfig(),
      stdout: (s) => out.push(s),
      fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
      fetchDurable: true,
      pollRuns: true,
    });
    return { code, out };
  };
  const failCount = () => parseReceiptsFromComments(comments).filter((r) => r.stage === "FAILED").length;

  // Ticks: launch1 (RUNNING) -> poll FAILED#1 -> relaunch2 -> FAILED#2 ->
  // relaunch3 -> FAILED#3 -> next tick must PARK (no 4th launch).
  const r1 = await runOnce(); // launch attempt 1
  assert.equal(r1.code, 0, r1.out.join("\n"));
  assert.equal(wa.triggers(), 1);
  for (let k = 1; k <= 3; k++) {
    wa.setPoll({ status: "failed", agent_id: `agt_life_r${k}`, error: { code: "run_failed" } });
    const pollRun = await runOnce(); // poll -> durable FAILED #k (dispatch deferred)
    assert.equal(pollRun.code, 0, pollRun.out.join("\n"));
    assert.equal(failCount(), k, `FAILED #${k} persisted`);
    await runOnce(); // next tick: relaunch (k<3) or park (k==3)
  }
  assert.equal(wa.triggers(), 3, "retries are capped at max_failed_attempts=3 — never a 4th launch");

  // The parked state is durable across processes: another full tick, still 3.
  const finalRun = await runOnce();
  assert.equal(finalRun.code, 0, finalRun.out.join("\n"));
  assert.equal(wa.triggers(), 3, "a parked issue never relaunches");
  assert.ok(finalRun.out.some((l) => l.includes("max failed attempts")), finalRun.out.join("\n"));
});
