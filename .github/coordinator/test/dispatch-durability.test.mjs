// Dispatch durability tests — repeated-run no-duplicate proof, crash-after-
// reservation, and durable adapter-pause semantics, driven through main() with
// mocked Linear + adapter network (GPT/Codex review: durable-receipt findings).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  parseReceiptsFromComments,
  parsePausedAdapters,
  selectNextReservation,
  validateReceipt,
  nextReceiptState,
  receiptCommentBody,
} from "../reconcile.mjs";

const SHA = "b".repeat(40);
const TRIGGER = "agtch_durable_1";

const FIXTURE_NODE = {
  id: "11111111-aaaa-4bbb-8ccc-000000000001",
  identifier: "SHU-FIXTURE-001",
  title: "Fixture: seeded-defect probe card",
  state: { name: "Todo" },
  priorityLabel: "High",
  labels: { nodes: [{ name: "fixture-safe" }, { name: "coordinator:pilot" }] },
  assignee: null,
  parent: null,
  children: { nodes: [] },
};

function tempConfig(overrides = {}) {
  const cfg = {
    pilot_repo: "BAWES-Universe/studenthub-platform",
    team: "SHU",
    max_dispatch: 1,
    enable_dispatch: true,
    adapter_pause_map: {},
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
    ...overrides,
  };
  const dir = mkdtempSync(join(tmpdir(), "coordinator-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

// fakeLinear — answers CoordinatorIssues with the fixture card and captures every
// commentCreate body so tests can assert the durable comment trail. sendLinear
// returns body.data, so mocks mimic a real GraphQL HTTP response.
function fakeLinear(commentBodies) {
  const impl = async (url, opts) => {
    assert.equal(url, "https://api.linear.app/graphql");
    const { query } = JSON.parse(opts.body);
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("CoordinatorIssues")) {
      return respond({ issues: { nodes: [FIXTURE_NODE] } });
    }
    if (query.includes("commentCreate")) {
      const vars = JSON.parse(opts.body).variables;
      commentBodies.push({ body: vars.body, createdAt: new Date().toISOString() }); // API node shape
      return respond({ commentCreate: { success: true, comment: { id: `c${commentBodies.length}` } } });
    }
    return respond({});
  };
  impl.calls = commentBodies;
  return impl;
}

function fakeWorkspaceAgents({ mode }) {
  let calls = 0;
  const impl = async (url, opts) => {
    calls += 1;
    assert.equal(url, `https://api.chatgpt.com/v1/workspace_agents/${TRIGGER}/trigger`);
    if (mode === "transport-fail") throw new Error("ECONNRESET");
    if (mode === "quota") return { status: 429, ok: false, json: async () => ({}) };
    return { status: 202, ok: true, json: async () => ({ id: "apirun_durable_1", status: "queued" }) };
  };
  impl.calls = () => calls;
  return impl;
}

const ENV = {
  ENABLE_DISPATCH: "true",
  LINEAR_API_TOKEN: "tok",
  GITHUB_TOKEN: "",
  WORKSPACE_AGENT_ACCESS_TOKEN: "wa-tok",
  WORKSPACE_AGENT_TRIGGER_ID: TRIGGER,
  DISPATCH_TARGET_SHA: SHA, // every dispatch is bound to a real head
};

async function runMain({ configPath, wa, comments, receipts = [] }) {
  const out = [];
  const code = await main([], ENV, {
    configPath,
    stdout: (s) => out.push(s),
    fetchImpl: async (url, opts) => {
      if (url.includes("api.linear.app")) return fakeLinear(comments)(url, opts);
      return wa(url, opts);
    },
    fetchDurable: false,
    receipts,
  });
  return { code, out };
}

test("repeated run over the same durable state NEVER double-reserves or double-dispatches", async () => {
  const comments = [];
  const wa = fakeWorkspaceAgents({ mode: "accept" });
  const configPath = tempConfig();

  // Run 1: reserve -> launch -> RUNNING persisted (two durable comments total).
  const r1 = await runMain({ configPath, wa, comments });
  assert.equal(r1.code, 0);
  assert.equal(wa.calls(), 1, "exactly one adapter launch on the first run");
  const receipts1 = parseReceiptsFromComments(comments);
  assert.equal(receipts1.length, 1, "durable receipts dedupe to the newest per attempt");
  assert.equal(receipts1[0].stage, "RUNNING");
  assert.equal(receipts1[0].external_run_id, "apirun_durable_1");
  const attempt = receipts1[0].attempt_id;

  // Run 2: same state, RUNNING receipt present -> no new reservation, no launch.
  const comments2 = [];
  const wa2 = fakeWorkspaceAgents({ mode: "accept" });
  const r2 = await runMain({ configPath, wa: wa2, comments: comments2, receipts: receipts1 });
  assert.equal(r2.code, 0);
  assert.equal(wa2.calls(), 0, "second run must NOT launch a duplicate worker");
  assert.equal(comments2.length, 0, "second run must NOT write a second RESERVED receipt");
  const receipts2 = parseReceiptsFromComments(comments);
  assert.equal(receipts2[0].attempt_id, attempt, "attempt identity is stable across runs");
});

test("crash after reservation: surviving LAUNCH_UNKNOWN receipt holds the slot — no duplicate launch", async () => {
  const comments = [];
  const wa = fakeWorkspaceAgents({ mode: "transport-fail" });
  const configPath = tempConfig();
  const r1 = await runMain({ configPath, wa, comments });
  assert.equal(wa.calls(), 1);
  const unknown = parseReceiptsFromComments(comments);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].stage, "LAUNCH_UNKNOWN", "transport failure persists LAUNCH_UNKNOWN, not RESERVED");

  // Second run sees the active LAUNCH_UNKNOWN receipt: slot held, no new launch,
  // no new reservation — recovery is reconciliation, not a blind relaunch.
  const comments2 = [];
  const wa2 = fakeWorkspaceAgents({ mode: "accept" });
  const r2 = await runMain({ configPath, wa: wa2, comments: comments2, receipts: unknown });
  assert.equal(wa2.calls(), 0, "LAUNCH_UNKNOWN must never auto-relaunch without reconciliation");
  assert.equal(comments2.length, 0);
});

test("quota failure persists FAILED receipt AND a durable adapter-pause marker", async () => {
  const comments = [];
  const wa = fakeWorkspaceAgents({ mode: "quota" });
  const configPath = tempConfig();
  const r1 = await runMain({ configPath, wa, comments });
  assert.equal(wa.calls(), 1);
  const failed = parseReceiptsFromComments(comments);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stage, "FAILED");
  assert.equal(failed[0].external_run_id, null, "refused trigger invents no phantom run id");
  const paused = parsePausedAdapters(comments);
  assert.ok(paused.includes("workspace-agents"), "pause marker persisted alongside the FAILED receipt");

  // A paused adapter blocks the next reservation even when the slot is free.
  const blocked = selectNextReservation({
    ready: [{ id: "SHU-FIXTURE-001", priority: "High", state: "Todo", requested_worker: "codex-builder" }],
    config: { max_dispatch: 1, adapter_pause_map: { "workspace-agents": true } },
    receipts: [],
  });
  assert.equal(blocked.candidate, null);
  assert.match(blocked.skipped[0].reason, /paused/);
});

test("manual_claim HOLD from LAUNCH_UNKNOWN is validator-valid (pre-acceptance shape)", async () => {
  // Build a real LAUNCH_UNKNOWN receipt through the state machine from RESERVED.
  const comments = [];
  const wa = fakeWorkspaceAgents({ mode: "transport-fail" });
  const configPath = tempConfig();
  await runMain({ configPath, wa, comments });
  const [unknown] = parseReceiptsFromComments(comments);
  assert.equal(unknown.stage, "LAUNCH_UNKNOWN");
  const held = nextReceiptState(unknown, { type: "manual_claim", actor: "human-operator" });
  assert.equal(held.accepted, true);
  assert.equal(held.receipt.stage, "HOLD");
  assert.equal(validateReceipt(held.receipt).valid, true, "pre-acceptance HOLD (null run fields) must validate");
});

test("malformed durable records never crash the validator", () => {
  const broken = {
    receipt_version: "1.0.0",
    issue_id: "SHU-99",
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    authorization_ref: "SHU-99",
    stage: "HOLD",
    requested_worker: "codex-builder",
    worker_identity: null,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "x",
    target_sha: SHA,
    external_run_id: null,
    adapter_status: null,
    timestamps: null, // corrupt record read back from a Linear comment
    evidence_links: null,
    notes: null,
    last_activity: "2026-09-05T00:00:00.000Z",
  };
  const out = validateReceipt(broken);
  assert.equal(out.valid, false);
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
});
