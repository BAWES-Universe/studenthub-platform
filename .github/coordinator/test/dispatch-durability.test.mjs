// Dispatch durability tests — repeated-run no-duplicate proof, crash-after-
// reservation, quota pause durability, and fail-closed receipt reads, driven
// through main() with ONE PERSISTENT fake Linear store so the second run
// retrieves the first run's comments through the REAL durable-read branch
// (LINEAR_ISSUE_COMMENTS_QUERY) — GPT/Codex review #2 bar.
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
} from "../reconcile.mjs";

const SHA = "b".repeat(40);
const TRIGGER = "agtch_durable_1";

function makeIssueNodes() {
  return [
    {
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
    },
    {
      id: "11111111-aaaa-4bbb-8ccc-000000000099",
      identifier: "SHU-099",
      title: "Second eligible card (proves max_dispatch accounting)",
      state: { name: "Todo" },
      priorityLabel: "High",
      labels: { nodes: [{ name: "fixture-safe" }] },
      assignee: null,
      delegate: null,
      parent: null,
      relations: { nodes: [] },
    },
  ];
}

function tempConfig(overrides = {}) {
  const cfg = {
    pilot_repo: "BAWES-Universe/studenthub-platform",
    team: "SHU",
    max_dispatch: 1,
    enable_dispatch: true,
    adapter_pause_map: {},
    wake_actor_allowlist: ["BAWES"],
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
    ...overrides,
  };
  const dir = mkdtempSync(join(tmpdir(), "coordinator-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

// fakeLinearStore — ONE persistent store across runs: serves issues from a
// mutable node list and stores/returns comment nodes per issue, exactly like the
// live LINEAR_ISSUE_COMMENTS_QUERY read path.
function fakeLinearStore(issueNodes, commentBodies, { failComments = false } = {}) {
  const impl = async (url, opts) => {
    assert.equal(url, "https://api.linear.app/graphql");
    const { query } = JSON.parse(opts.body);
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("CoordinatorIssues")) {
      return respond({ issues: { nodes: issueNodes } });
    }
    if (query.includes("CoordinatorIssueComments")) {
      if (failComments) throw new Error("simulated comment-read outage");
      const issueId = JSON.parse(opts.body).variables.issueId;
      const nodes = issueNodes.some((n) => n.id === issueId || n.identifier === issueId) ? [...commentBodies] : [];
      return respond({ issue: { comments: { nodes } } });
    }
    if (query.includes("commentCreate")) {
      const vars = JSON.parse(opts.body).variables;
      commentBodies.push({ body: vars.body, createdAt: new Date().toISOString() });
      return respond({ commentCreate: { success: true, comment: { id: `c${commentBodies.length}` } } });
    }
    return respond({});
  };
  impl.comments = commentBodies;
  return impl;
}

function fakeWorkspaceAgents({ mode }) {
  let calls = 0;
  const impl = async (url, opts) => {
    calls += 1;
    assert.equal(url, `https://api.chatgpt.com/v1/workspace_agents/${TRIGGER}/trigger`);
    if (mode === "transport-fail") throw new Error("ECONNRESET");
    if (mode === "quota") return { status: 429, ok: false, json: async () => ({}) };
    // Official 202 shape: { conversation_url, agent_trigger_run_id }.
    return { status: 202, ok: true, json: async () => ({ conversation_url: "https://chatgpt.com/c/durable_1", agent_trigger_run_id: "apirun_durable_1" }) };
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

async function runMain({ configPath, wa, linear, failComments = false }) {
  const out = [];
  const code = await main([], ENV, {
    configPath,
    stdout: (s) => out.push(s),
    fetchImpl: async (url, opts) => {
      if (url.includes("api.linear.app")) return linear(url, opts);
      return wa(url, opts);
    },
    fetchDurable: true, // REAL durable-read branch — no injected receipts
  });
  return { code, out };
}

test("repeated run over one persistent store NEVER double-reserves or double-dispatches", async () => {
  const nodes = makeIssueNodes();
  const store = fakeLinearStore(nodes, []);
  const wa = fakeWorkspaceAgents({ mode: "accept" });
  const configPath = tempConfig();

  // Run 1 (fresh process state): durable scan (empty) -> reserve -> re-read
  // verification -> launch 202 -> RUNNING persisted.
  const r1 = await runMain({ configPath, wa, linear: store });
  assert.equal(r1.code, 0, r1.out.join("\n"));
  assert.equal(wa.calls(), 1, "exactly one adapter launch on the first run");
  const after1 = parseReceiptsFromComments(store.comments);
  assert.equal(after1.length, 1, "durable receipts dedupe to the newest per attempt");
  assert.equal(after1[0].stage, "RUNNING");
  assert.equal(after1[0].external_run_id, "apirun_durable_1");
  assert.equal(after1[0].worker_identity, null, "worker_identity is never fabricated from the run id (GPT review #1)");
  const attempt = after1[0].attempt_id;

  // Run 2 (fresh process state again): the durable-read branch retrieves run 1's
  // comments through LINEAR_ISSUE_COMMENTS_QUERY and the active receipt consumes
  // the slot — zero new launches, zero new reservations.
  const wa2 = fakeWorkspaceAgents({ mode: "accept" });
  const r2 = await runMain({ configPath, wa: wa2, linear: store });
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(wa2.calls(), 0, "second run must NOT launch a duplicate worker");
  const after2 = parseReceiptsFromComments(store.comments);
  assert.equal(after2.length, 1, "no second RESERVED written");
  assert.equal(after2[0].attempt_id, attempt, "attempt identity is stable across runs");
});

test("active receipt on a card that left the pickable set still consumes max_dispatch", async () => {
  const nodes = makeIssueNodes();
  const store = fakeLinearStore(nodes, []);
  const wa = fakeWorkspaceAgents({ mode: "accept" });
  const configPath = tempConfig();
  await runMain({ configPath, wa, linear: store });
  assert.equal(wa.calls(), 1);

  // Run 2: the launched card moved to In Progress (a real post-dispatch state),
  // leaving SHU-099 eligible. The RUNNING receipt on the In-Progress card must
  // STILL be read (all-issues durable scan) and still consume max_dispatch=1 —
  // otherwise SHU-099 would get a second worker.
  nodes[0].state = { name: "In Progress" };
  const wa2 = fakeWorkspaceAgents({ mode: "accept" });
  const r2 = await runMain({ configPath, wa: wa2, linear: store });
  assert.equal(r2.code, 0, r2.out.join("\n"));
  assert.equal(wa2.calls(), 0, "active receipt on a non-pickable card must still block dispatch");
});

test("crash after reservation: surviving LAUNCH_UNKNOWN holds the slot across processes", async () => {
  const nodes = makeIssueNodes();
  const store = fakeLinearStore(nodes, []);
  const wa = fakeWorkspaceAgents({ mode: "transport-fail" });
  const configPath = tempConfig();
  const r1 = await runMain({ configPath, wa, linear: store });
  assert.equal(wa.calls(), 1);
  const unknown = parseReceiptsFromComments(store.comments);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].stage, "LAUNCH_UNKNOWN", "transport failure persists LAUNCH_UNKNOWN, not RESERVED");

  // Fresh process, same store: the durable read finds LAUNCH_UNKNOWN -> slot held.
  const wa2 = fakeWorkspaceAgents({ mode: "accept" });
  const r2 = await runMain({ configPath, wa: wa2, linear: store });
  assert.equal(wa2.calls(), 0, "LAUNCH_UNKNOWN must never auto-relaunch without reconciliation");
  assert.equal(parseReceiptsFromComments(store.comments).length, 1);
});

test("quota failure persists FAILED + durable pause marker; the pause survives a fresh process", async () => {
  const nodes = makeIssueNodes();
  const store = fakeLinearStore(nodes, []);
  const wa = fakeWorkspaceAgents({ mode: "quota" });
  const configPath = tempConfig();
  await runMain({ configPath, wa, linear: store });
  const failed = parseReceiptsFromComments(store.comments);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stage, "FAILED");
  assert.equal(failed[0].external_run_id, null, "refused trigger invents no phantom run id");
  const paused = parsePausedAdapters(store.comments);
  assert.ok(paused.includes("workspace-agents"), "pause marker persisted alongside the FAILED receipt");

  // Fresh process: durable pause marker read back -> even a free slot will not
  // auto-launch a doomed attempt.
  const wa2 = fakeWorkspaceAgents({ mode: "accept" });
  const r2 = await runMain({ configPath, wa: wa2, linear: store });
  assert.equal(wa2.calls(), 0, "a paused adapter must not auto-launch in a fresh process");
  assert.equal(r2.code, 0);

  // Unit-level: paused adapter blocks the next reservation even when slot is free.
  const blocked = selectNextReservation({
    ready: [{ id: "SHU-FIXTURE-001", priority: "High", state: "Todo", requested_worker: "codex-builder" }],
    config: { max_dispatch: 1, adapter_pause_map: { "workspace-agents": true } },
    receipts: [],
  });
  assert.equal(blocked.candidate, null);
  assert.match(blocked.skipped[0].reason, /paused/);
});

test("any receipt-read failure PREVENTS dispatch (fail closed)", async () => {
  const nodes = makeIssueNodes();
  const store = fakeLinearStore(nodes, [], { failComments: true });
  const wa = fakeWorkspaceAgents({ mode: "accept" });
  const configPath = tempConfig();
  const r1 = await runMain({ configPath, wa, linear: store });
  assert.equal(r1.code, 2, "dispatch must be prevented when durable state cannot be read");
  assert.equal(wa.calls(), 0, "no worker may launch when the durable read path is down");
  assert.match(r1.out.join("\n"), /DISPATCH PREVENTED/);
});

test("manual_claim HOLD from LAUNCH_UNKNOWN is validator-valid (pre-acceptance shape)", async () => {
  const nodes = makeIssueNodes();
  const store = fakeLinearStore(nodes, []);
  const wa = fakeWorkspaceAgents({ mode: "transport-fail" });
  const configPath = tempConfig();
  await runMain({ configPath, wa, linear: store });
  const [unknown] = parseReceiptsFromComments(store.comments);
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
