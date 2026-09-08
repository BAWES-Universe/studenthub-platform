// SHU-68 wiring tests (Hermes 2026-09-08) — the real-path integration slice.
//
// Coverage:
//   * Pure bridge: receipt -> provenance entries (worker identity required),
//     lane/verdict compatibility (builder BLOCK is a machine HOLD, never a
//     revise order), verdict stage -> outcome mapping.
//   * routeSuccessorFromReceipts end states: completed build -> review order
//     bound to the EVIDENCE result head; review BLOCK -> revise order back to
//     the active writer; PASS -> terminal; revisions exhausted -> visible
//     HOLD; no eligible reviewer -> visible HOLD.
//   * main()-level wiring: a polled COMPLETED build with an eligible reviewer
//     in the lineage posts a coordinator-work-order directive to the card;
//     without any reviewer it posts NOTHING (visible hold); dispatch-disabled
//     makes zero writes (existing BLOCK #1 covers the broad gate — here we
//     assert a terminal verdict under disabled dispatch still posts nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  parseReceiptsFromComments,
  receiptCommentBody,
  parseEvidenceFromComments,
  parseWorkOrderDirectiveFromComments,
  maybePostSuccessorDirective,
  backfillSuccessorDirectives,
  createReceipt,
  nextReceiptState,
  terminalVerdictCoherent,
} from "../reconcile.mjs";
import {
  roleForRequestedWorker,
  runtimeForRequestedWorker,
  provenanceFromReceipt,
  outcomeForEvidenceStage,
  verdictMatchesLane,
  routeSuccessorFromReceipts,
  renderWorkOrderDirective,
  parseWorkOrderDirective,
  WORK_ORDER_VERSION,
} from "../review-routing.mjs";

const SHA = "c".repeat(40);
const SHA2 = "d".repeat(40);
const TRIGGER = "agtch_wire_1";
const TRUSTED_CALLBACK_ACTOR = "linear-worker-test";

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

function tempConfig() {
  const cfg = {
    pilot_repo: "BAWES-Universe/studenthub-platform",
    team: "SHU",
    max_dispatch: 1,
    enable_dispatch: true,
    adapter_pause_map: {},
    wake_actor_allowlist: ["BAWES"],
    linear_callback_actor_ids: [TRUSTED_CALLBACK_ACTOR],
    max_failed_attempts: 3,
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
  };
  const dir = mkdtempSync(join(tmpdir(), "coordinator-wire-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

let clockMs = 1793200000000; // 2026-09-09 — AFTER the seeded receipts' 2026-09-05 timestamps, so durable transitions win the dedup
const tick = () => new Date((clockMs += 1000)).toISOString();

// Minimal persistent Linear store (mirrors lifecycle.test.mjs shape).
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
      return respond({ commentCreate: { success: true, comment: { id: "c-" + commentBodies.length } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };
  return impl;
}

// workspace-agents-shaped fake adapter injected under codex-cli (SHU-63 pivot).
// Poll GETs (…/runs/<id>) return the test-set poll body; everything else is a
// trigger POST (counted).
function waAgent() {
  let triggers = 0;
  let pollBody = { object: "workspace_agent.trigger_run", id: "apirun_wire_1", status: "queued", agent_id: null, error: null };
  const impl = async (url, opts) => {
    if (url.includes("/runs/")) {
      return { status: 200, ok: true, json: async () => ({ ...pollBody }) };
    }
    triggers += 1;
    return { status: 202, ok: true, json: async () => ({ conversation_url: "https://chatgpt.com/c/wire", agent_trigger_run_id: "apirun_wire_1" }) };
  };
  impl.triggers = () => triggers;
  impl.setPoll = (over) => {
    pollBody = { object: "workspace_agent.trigger_run", id: "apirun_wire_1", status: "queued", agent_id: null, error: null, ...over };
  };
  return impl;
}

const waCompat = (() => {
  let mod = null;
  const load = () => (mod ??= import("../adapters/workspace-agents.mjs"));
  return {
    launchBuilder: async (o) => (await load()).launchBuilder({ ...o, token: "wa-tok", api_trigger_id: TRIGGER }),
    monitorRun: async (o) => (await load()).monitorRun({ ...o, token: "wa-tok", api_trigger_id: TRIGGER }),
  };
})();

const ENV = {
  ENABLE_DISPATCH: "true",
  LINEAR_API_TOKEN: "tok",
  GITHUB_TOKEN: "",
  WORKSPACE_AGENT_ACCESS_TOKEN: "wa-tok",
  WORKSPACE_AGENT_TRIGGER_ID: TRIGGER,
  DISPATCH_TARGET_SHA: SHA,
};

// ---------------------------------------------------------------------------
// Pure bridge
// ---------------------------------------------------------------------------

test("bridge: role/runtime mapping covers the three worker lanes", () => {
  assert.equal(roleForRequestedWorker("codex-builder"), "build");
  assert.equal(roleForRequestedWorker("claude-verifier"), "review");
  assert.equal(roleForRequestedWorker("hermes-box"), "build");
  assert.equal(roleForRequestedWorker("nonsense"), null);
  assert.equal(runtimeForRequestedWorker("codex-builder"), "codex-cli");
  assert.equal(runtimeForRequestedWorker("claude-verifier"), "claude-code");
  assert.equal(runtimeForRequestedWorker("hermes-box"), "hermes-pool");
});

test("bridge: provenanceFromReceipt requires a worker identity — anonymous receipts never route", () => {
  const anonymous = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: null,
    target_sha: SHA,
  };
  assert.equal(provenanceFromReceipt(anonymous), null, "no identity -> no provenance entry (ambiguous authorship HOLDs routing)");
  const known = { ...anonymous, worker_identity: "codex:s1" };
  const entry = provenanceFromReceipt(known);
  assert.ok(entry);
  assert.equal(entry.actor, "codex:s1");
  assert.equal(entry.role, "build");
  assert.equal(entry.runtime, "codex-cli");
  assert.equal(entry.result_sha, null);
});

test("bridge: verdict stages map to the intended routing outcome", () => {
  assert.deepEqual(outcomeForEvidenceStage("BUILD_READY"), { role: "build", outcome: null });
  assert.deepEqual(outcomeForEvidenceStage("REVISION_READY"), { role: "revise", outcome: null });
  assert.deepEqual(outcomeForEvidenceStage("PASS"), { role: "review", outcome: "PASS" });
  assert.deepEqual(outcomeForEvidenceStage("BLOCKED"), { role: "review", outcome: "BLOCKED" });
  assert.deepEqual(outcomeForEvidenceStage("FAILED"), { role: "review", outcome: "FAILED" });
  assert.equal(outcomeForEvidenceStage("in_progress"), null);
});

test("bridge: lane/verdict compatibility — a builder BLOCK is a HOLD, a verifier BUILD_READY is incoherent", () => {
  // Writer lanes only route BUILD_READY / REVISION_READY.
  assert.equal(verdictMatchesLane("codex-builder", "BUILD_READY"), true);
  assert.equal(verdictMatchesLane("codex-builder", "REVISION_READY"), true);
  assert.equal(verdictMatchesLane("codex-builder", "BLOCKED"), false, "builder BLOCK is an in-scope blocker -> machine HOLD, never a revise order");
  assert.equal(verdictMatchesLane("codex-builder", "PASS"), false);
  // Review lane only routes review verdicts.
  assert.equal(verdictMatchesLane("claude-verifier", "PASS"), true);
  assert.equal(verdictMatchesLane("claude-verifier", "BLOCKED"), true);
  assert.equal(verdictMatchesLane("claude-verifier", "FAILED"), true);
  assert.equal(verdictMatchesLane("claude-verifier", "BUILD_READY"), false);
  assert.equal(verdictMatchesLane("claude-verifier", null), false);
});

test("routeSuccessorFromReceipts: completed build -> review order bound to the EVIDENCE result head", () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage: "COMPLETED",
  };
  const reviewer = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    target_sha: SHA2,
    stage: "RUNNING",
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build, reviewer],
    terminal: build,
    evidenceStage: "BUILD_READY",
    evidenceResultSha: SHA2, // the exact commit the builder produced
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.order.role, "review");
  assert.equal(r.order.runtime, "claude-code");
  assert.equal(r.order.actor, "claude:v1", "the eligible non-author reviewer is chosen");
  assert.equal(r.order.target_sha, SHA2, "review binds the WRITE's OUTPUT head from evidence, never the stale input target");
  assert.notEqual(r.order.attempt_id, build.attempt_id, "fresh attempt for the review");
});

test("routeSuccessorFromReceipts: a review BLOCK routes a REVISE back to the active writer", () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage: "COMPLETED",
  };
  const review = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    target_sha: SHA,
    stage: "HOLD",
    last_activity: tick(),
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build, review],
    terminal: review,
    evidenceStage: "BLOCKED",
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.order.role, "revise");
  assert.equal(r.order.runtime, "codex-cli");
  assert.equal(r.order.actor, "codex:s1", "revision goes back to the ACTIVE WRITER");
  assert.equal("outcome" in r.order, false, "a fresh revise order must not inherit the BLOCKED outcome");
});

test("routeSuccessorFromReceipts: PASS is terminal — no successor order", () => {
  const review = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    target_sha: SHA,
    stage: "COMPLETED",
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [review],
    terminal: review,
    evidenceStage: "PASS",
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.terminal, true, "PASS ends the loop — stop before merge");
  assert.equal(r.order, undefined);
});

test("routeSuccessorFromReceipts: no eligible reviewer -> visible HOLD, nothing minted", () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    stage: "COMPLETED",
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build],
    terminal: build,
    evidenceStage: "BUILD_READY",
    evidenceResultSha: SHA,
  });
  assert.equal(r.ok, false);
  assert.equal(r.hold, "no_eligible_reviewer");
  assert.equal(r.order, undefined, "no order -> no directive -> no launch storm");
});

test("routeSuccessorFromReceipts: revision exhaustion is a terminal HOLD, never an endless loop", () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    stage: "COMPLETED",
  };
  const review = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    target_sha: SHA,
    stage: "HOLD",
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build, review],
    terminal: review,
    evidenceStage: "BLOCKED",
    max_revise: 1,
  });
  assert.equal(r.ok, true, `round 1 BLOCK schedules revision 1: ${r.reason}`);
  // Second BLOCK (review_round 2 > max_revise 1) is exhausted.
  const second = {
    ...review,
    attempt_id: "33333333-3333-4333-8333-333333333333",
    worker_identity: "claude:v2",
  };
  const r2 = routeSuccessorFromReceipts({
    issueReceipts: [build, review, second],
    terminal: second,
    evidenceStage: "BLOCKED",
    max_revise: 1,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.exhausted, true);
  assert.equal(r2.hold, "revisions_exhausted");
});

test("routeSuccessorFromReceipts: lane mismatch fails closed (builder BLOCK never routes)", () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    stage: "HOLD",
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build],
    terminal: build,
    evidenceStage: "BLOCKED",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not match lane/);
});

test("directive round-trip: a routed order renders and re-parses as a valid work order", () => {
  const order = {
    version: WORK_ORDER_VERSION,
    role: "review",
    runtime: "claude-code",
    actor: "claude:v1",
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "44444444-4444-4444-8444-444444444444",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    target_sha: SHA2,
  };
  const body = renderWorkOrderDirective(order);
  assert.match(body, /coordinator-work-order v1/);
  const parsed = parseWorkOrderDirective(body);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.order.actor, "claude:v1");
  assert.equal(parsed.order.target_sha, SHA2);
});

// ---------------------------------------------------------------------------
// main()-level wiring
// ---------------------------------------------------------------------------

function callbackComment(attempt_id, { stage = "BUILD_READY", result_sha = null, target_sha = SHA } = {}) {
  const payload = { attempt_id, target_sha, stage, links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/99"] };
  if (result_sha) payload.result_sha = result_sha;
  return {
    user: { id: TRUSTED_CALLBACK_ACTOR, displayName: "Worker" },
    body: [
      "<!-- coordinator-callback v1 -->",
      "coordinator-callback v1",
      "```json",
      JSON.stringify(payload),
      "```",
    ].join("\n"),
    createdAt: tick(),
  };
}

function seededReceipt({ stage, requested_worker = "codex-builder", worker_identity = null, attempt_id, external_run_id = "apirun_wire_1", last_activity }) {
  return {
    receipt_version: "1.0.0",
    issue_id: "SHU-FIXTURE-001",
    attempt_id,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage,
    requested_worker,
    worker_identity,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-FIXTURE-001",
    target_sha: SHA,
    external_run_id,
    adapter_status: stage === "RUNNING" ? "queued" : stage === "COMPLETED" ? "completed" : stage === "HOLD" ? "completed" : null,
    timestamps: { reserved: "2026-09-05T09:00:00.000Z", launch: "2026-09-05T09:01:00.000Z", heartbeat: null, terminal: stage === "COMPLETED" || stage === "HOLD" ? "2026-09-05T11:00:00.000Z" : null },
    evidence_links: [],
    last_activity: last_activity ?? "2026-09-05T10:00:00.000Z",
    notes: [],
  };
}

test("security: callback comments require an immutable trusted Linear actor id", () => {
  const attempt = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const trusted = callbackComment(attempt, { stage: "BUILD_READY" });
  const forged = {
    ...callbackComment(attempt, { stage: "BLOCKED" }),
    user: { id: "attacker", displayName: "Attacker" },
    createdAt: "9999-12-31T23:59:59.999Z",
  };
  assert.equal(parseEvidenceFromComments([trusted, forged], attempt, [TRUSTED_CALLBACK_ACTOR])?.stage, "BUILD_READY");
  assert.equal(parseEvidenceFromComments([forged], attempt, [TRUSTED_CALLBACK_ACTOR]), null);
  assert.equal(parseEvidenceFromComments([trusted], attempt, []), null, "an unconfigured allowlist fails closed");
});

test("security: a rejected attempt or target callback never becomes a durable verdict", () => {
  const attempt = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const made = createReceipt({
    issue_id: "SHU-FIXTURE-001",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-FIXTURE-001",
    target_sha: SHA,
    attempt_id: attempt,
  });
  assert.equal(made.ok, true);
  let receipt = nextReceiptState(made.receipt, { type: "launch" }).receipt;
  receipt = nextReceiptState(receipt, {
    type: "worker_ack",
    external_run_id: "apirun_wire_security",
    adapter_status: "in_progress",
    worker_identity: "codex:s1",
  }).receipt;
  const held = nextReceiptState(receipt, {
    type: "run_status",
    status: "completed",
    callback: { attempt_id: attempt, target_sha: SHA2, stage: "BUILD_READY", links: ["https://example.invalid/evidence"] },
  }).receipt;
  assert.equal(held.stage, "HOLD");
  assert.equal(held.verdict_stage, undefined);
  assert.equal(held.result_sha, undefined);
});

test("security: backfill rejects incoherent HOLD plus success verdict", async () => {
  const held = {
    ...seededReceipt({
      stage: "HOLD",
      requested_worker: "codex-builder",
      worker_identity: "codex:s1",
      attempt_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    }),
    verdict_stage: "BUILD_READY",
    result_sha: SHA2,
  };
  assert.equal(terminalVerdictCoherent(held, held.verdict_stage), false);
  let writes = 0;
  const considered = await backfillSuccessorDirectives({
    receipts: [held],
    commentsByIssue: new Map([[held.issue_id, []]]),
    linearToken: "linear",
    linearIdFor: new Map([[held.issue_id, FIXTURE_NODE.id]]),
    fetchImpl: async () => { writes += 1; throw new Error("must not write"); },
    stdout: () => {},
  });
  assert.equal(considered, 0);
  assert.equal(writes, 0);
});

test("security: backfill fails closed when an expected live branch head is unreadable", async () => {
  const terminal = {
    ...seededReceipt({
      stage: "COMPLETED",
      requested_worker: "codex-builder",
      worker_identity: "codex:s1",
      attempt_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    }),
    verdict_stage: "BUILD_READY",
    result_sha: SHA2,
  };
  const reviewer = seededReceipt({
    stage: "RUNNING",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  let linearWrites = 0;
  const considered = await backfillSuccessorDirectives({
    receipts: [reviewer, terminal],
    commentsByIssue: new Map([[terminal.issue_id, []]]),
    linearToken: "linear",
    githubToken: "github",
    linearIdFor: new Map([[terminal.issue_id, FIXTURE_NODE.id]]),
    fetchImpl: async (url) => {
      if (String(url).includes("api.github.com")) throw new Error("head unavailable");
      linearWrites += 1;
      throw new Error("must not write");
    },
    stdout: () => {},
  });
  assert.equal(considered, 1);
  assert.equal(linearWrites, 0);
});

test("wiring: a polled COMPLETED build with an eligible reviewer posts the review directive via the durable backfill pass", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  // Durable state at reconcile start, exactly as a prior launch would leave it:
  // * a claude-verifier session that reviewed this issue before (COMPLETED,
  //   worker identity known, did NOT edit -> still an eligible non-author);
  // * the builder attempt already RUNNING (launched by an earlier process).
  const reviewerReceipt = seededReceipt({
    stage: "COMPLETED",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    external_run_id: "apirun_wire_review",
    last_activity: "2026-09-05T09:30:00.000Z",
  });
  comments.push({ body: receiptCommentBody(reviewerReceipt), createdAt: "2026-09-05T09:31:00.000Z" });
  const builderRunning = seededReceipt({
    stage: "RUNNING",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    attempt_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    external_run_id: "apirun_wire_1",
    last_activity: "2026-09-05T09:40:00.000Z",
  });
  comments.push({ body: receiptCommentBody(builderRunning), createdAt: "2026-09-05T09:41:00.000Z" });

  // Worker posts BUILD_READY + result_sha; poll completes. On THIS reconcile the
  // lifecycle pass transitions RUNNING -> COMPLETED and persists the DURABLE
  // verdict facts (verdict_stage + result_sha) on the terminal receipt.
  comments.push(callbackComment(builderRunning.attempt_id, { result_sha: SHA2 }));
  wa.setPoll({ status: "completed", agent_id: "codex:s1" });
  const runReconcile = async (out) =>
    main([], ENV, {
      skipActivationPreflight: true,
      configPath: tempConfig(),
      adapterModules: { "codex-cli": waCompat },
      stdout: (s) => out.push(s),
      fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
      fetchDurable: true,
      pollRuns: true,
    });
  const out1 = [];
  await runReconcile(out1);
  // Transition persisted, but the directive NOT yet posted (backfill runs on a
  // reconcile with no lifecycle transition). This is the crash-window: the
  // terminal receipt is durable, so a restart self-heals.
  assert.ok(!parseWorkOrderDirectiveFromComments(comments).some((o) => o.role === "review"), "directive deferred to backfill pass");

  // SECOND reconcile: no lifecycle transition -> the durable backfill pass derives
  // the same deterministic successor attempt and posts it exactly once.
  const out2 = [];
  await runReconcile(out2);
  assert.ok(out2.some((l) => l.includes("POSTED review order")), `backfill posted: ${out2.join("\n")}`);
  const directives = parseWorkOrderDirectiveFromComments(comments);
  assert.equal(directives.length, 1, "exactly one work-order directive on the card");
  assert.equal(directives[0].role, "review");
  assert.equal(directives[0].actor, "claude:v1");
  assert.equal(directives[0].target_sha, SHA2, "review directive binds the evidence result head");

  // THIRD reconcile: idempotent — the same successor attempt is already on the
  // card, so the backfill post is deduplicated (NO duplicate directive).
  const out3 = [];
  await runReconcile(out3);
  assert.ok(!out3.some((l) => l.includes("POSTED review order")), `no duplicate on replay: ${out3.join("\n")}`);
  assert.equal(parseWorkOrderDirectiveFromComments(comments).length, 1, "one directive even after replay");
});

test("wiring: no eligible reviewer -> visible hold, ZERO directives posted", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  const wa = waAgent();
  // Builder RUNNING (launched earlier), poll completes with BUILD_READY — but
  // the lineage has NO review-role receipt with a worker identity, so routing
  // must HOLD visibly and post nothing (no relaunch storm, no fabricated
  // reviewer).
  const builderRunning = seededReceipt({
    stage: "RUNNING",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    attempt_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    external_run_id: "apirun_wire_1",
    last_activity: "2026-09-05T09:40:00.000Z",
  });
  comments.push({ body: receiptCommentBody(builderRunning), createdAt: "2026-09-05T09:41:00.000Z" });
  comments.push(callbackComment(builderRunning.attempt_id, { result_sha: SHA2 }));
  wa.setPoll({ status: "completed", agent_id: "codex:s1" });
  const runReconcile = async (out) =>
    main([], ENV, {
      skipActivationPreflight: true,
      configPath: tempConfig(),
      adapterModules: { "codex-cli": waCompat },
      stdout: (s) => out.push(s),
      fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
      fetchDurable: true,
      pollRuns: true,
    });
  const out1 = [];
  await runReconcile(out1); // transition RUNNING -> COMPLETED, persists durable verdict facts
  const out2 = [];
  await runReconcile(out2); // backfill pass: no eligible reviewer -> visible HOLD, nothing posted
  assert.ok(out2.some((l) => l.includes("no eligible non-author reviewer")), `visible hold logged: ${out2.join("\n")}`);
  assert.equal(parseWorkOrderDirectiveFromComments(comments).length, 0, "no directive without an eligible reviewer");
});

test("wiring: dispatch-disabled makes zero writes even when a verdict-bearing receipt is seeded", async () => {
  const comments = [];
  const store = persistentStore([FIXTURE_NODE], comments);
  // Seed a COMPLETED builder receipt + BUILD_READY evidence + eligible reviewer:
  // the exact state that WOULD post a directive under dispatch-enabled.
  const builderDone = seededReceipt({
    stage: "COMPLETED",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    last_activity: "2026-09-05T10:00:00.000Z",
  });
  comments.push({ body: receiptCommentBody(builderDone), createdAt: "2026-09-05T10:01:00.000Z" });
  comments.push(callbackComment(builderDone.attempt_id, { result_sha: SHA2 }));
  const writesBefore = comments.length;

  const disabledEnv = { ...ENV, ENABLE_DISPATCH: "false" };
  const cfgPath = tempConfig();
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const disabledCfgPath = join(mkdtempSync(join(tmpdir(), "coordinator-wire-off-")), "config.json");
  writeFileSync(disabledCfgPath, JSON.stringify({ ...cfg, enable_dispatch: false }));
  const out = [];
  const code = await main([], disabledEnv, {
    skipActivationPreflight: true,
    configPath: disabledCfgPath,
    adapterModules: { "codex-cli": waCompat },
    stdout: (s) => out.push(s),
    fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
    fetchDurable: true,
    pollRuns: true,
  });
  assert.equal(code, 0, out.join("\n"));
  assert.equal(comments.length, writesBefore, "dispatch-disabled: zero Linear writes, no directive");
  assert.ok(!out.some((l) => l.includes("posted ")), out.join("\n"));
});

// ---------------------------------------------------------------------------
// maybePostSuccessorDirective direct (pure async) — the terminal-stage guard
// ---------------------------------------------------------------------------

test("directive helper: infra FAILED receipt never routes even with a stray verdict comment", async () => {
  const out = [];
  const failed = seededReceipt({
    stage: "FAILED",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    external_run_id: null,
    last_activity: "2026-09-05T10:00:00.000Z",
  });
  const r = await maybePostSuccessorDirective({
    issue_id: "SHU-FIXTURE-001",
    issueReceipts: [failed],
    terminal: failed,
    verdictStage: "BUILD_READY", // stray: an infra FAILED receipt carries no verdict
    linearIssueId: FIXTURE_NODE.id,
    linearToken: "tok",
    config: { max_revise: 3 },
    fetchImpl: async () => { throw new Error("no write expected"); },
    stdout: (s) => out.push(s),
  });
  assert.equal(r, null, "FAILED terminal + any stage must never route");
});

test("directive helper: BUILD_READY only routes from a COMPLETED receipt", async () => {
  const out = [];
  const held = seededReceipt({
    stage: "HOLD",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    last_activity: "2026-09-05T10:00:00.000Z",
  });
  const r = await maybePostSuccessorDirective({
    issue_id: "SHU-FIXTURE-001",
    issueReceipts: [held],
    terminal: held,
    verdictStage: "BUILD_READY", // success stage cannot explain a HOLD terminal
    linearIssueId: FIXTURE_NODE.id,
    linearToken: "tok",
    config: { max_revise: 3 },
    fetchImpl: async () => { throw new Error("no write expected"); },
    stdout: (s) => out.push(s),
  });
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// Codex BLOCK #1 regression — forged evidence cannot route or choose a head
// ---------------------------------------------------------------------------

test("routing: forged result_sha (≠ verified authoritative head) FAILS CLOSED — attacker cannot choose the successor head", async () => {
  // A completed codex-builder receipt with a worker identity (eligible lineage)
  // + an attacker-chosen result_sha that the VERIFIED authoritative branch head
  // refutes. routeSuccessorFromReceipts must refuse to route (no order -> no
  // directive -> no launch), exactly what Codex's probe (attacker SHA eeeee...)
  // demanded.
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage: "COMPLETED",
  };
  const attackerSha = "e".repeat(40); // Codex's probe used this shape
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build],
    terminal: build,
    evidenceStage: "BUILD_READY",
    evidenceResultSha: attackerSha,
    authoritativeHead: SHA2, // the real verified branch head
  });
  assert.equal(r.ok, false);
  assert.equal(r.forged, true, "confirm the failure is flagged as forged");
  assert.match(r.reason, /does not match verified authoritative head|FORGED/i);
  assert.equal(r.order, undefined, "no successor order from forged evidence");
});

test("routing: matching authoritative head routes and binds the VERIFIED head, not the volatile evidence", async () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage: "COMPLETED",
  };
  const reviewer = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    target_sha: SHA2,
    stage: "RUNNING",
  };
  const r = routeSuccessorFromReceipts({
    issueReceipts: [build, reviewer],
    terminal: build,
    evidenceStage: "BUILD_READY",
    evidenceResultSha: "d".repeat(40), // volatile evidence, ignored in favor of verified head
    authoritativeHead: SHA2,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.order.target_sha, SHA2, "review binds the authoritative verified head");
});

test("routing: replay determinism — same input yields the SAME successor attempt id (backfill dedup key)", async () => {
  const build = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    requested_worker: "codex-builder",
    worker_identity: "codex:s1",
    target_sha: SHA,
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    stage: "COMPLETED",
  };
  const reviewer = {
    issue_id: "SHU-FIXTURE-001",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    requested_worker: "claude-verifier",
    worker_identity: "claude:v1",
    target_sha: SHA2,
    stage: "RUNNING",
  };
  const mk = () => routeSuccessorFromReceipts({
    issueReceipts: [build, reviewer],
    terminal: build,
    evidenceStage: "BUILD_READY",
    authoritativeHead: SHA2,
  });
  const a = mk();
  const b = mk();
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.order.attempt_id, b.order.attempt_id, "deterministic successor attempt — the backfill dedup key");
  assert.equal(a.order.target_sha, b.order.target_sha, "deterministic head binding");
});
