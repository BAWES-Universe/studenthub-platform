import { test } from "node:test";
import assert from "node:assert/strict";
import { withBatchedComments } from "./fixture/linear-board.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  backfillSuccessorDirectives,
  main,
  receiptsWithinDispatchScope,
  receiptsForLifecycle,
  reconcileOnce,
  resolveDispatchScope,
  selectNextReservation,
} from "../reconcile.mjs";

const COORDINATOR_DIR = fileURLToPath(new URL("..", import.meta.url));
const TARGET = {
  id: "SHU-140",
  priority: "Low",
  requested_worker: "codex-builder",
};
const REAL = {
  id: "SHU-90",
  priority: "Urgent",
  requested_worker: "codex-builder",
};
const SCOPED = {
  max_dispatch: 1,
  adapter_pause_map: {},
  dispatch_scope: { issue_ids: ["SHU-140"] },
};

function select(ready, config = SCOPED, receipts = []) {
  return selectNextReservation({ ready, config, receipts });
}

test("SHU-224: a higher-priority real card cannot beat the scoped fixture", () => {
  const result = select([REAL, TARGET]);
  assert.equal(result.candidate?.id, "SHU-140");
  assert.match(result.skipped.find((item) => item.id === "SHU-90")?.reason ?? "", /outside trusted dispatch_scope/);
});

test("SHU-224: a missing or ineligible scoped target selects nothing and never falls back", () => {
  const result = select([REAL]);
  assert.equal(result.candidate, null);
  assert.match(result.skipped[0].reason, /unavailable or ineligible.*no fallback/);
});

test("SHU-224: eligibility may reject the target without exposing another ready card", () => {
  const issue = (id, state, priority) => ({
    id,
    title: id,
    state,
    priority,
    labels: ["repo:platform"],
    assignee: null,
    delegate: null,
    linkedPRs: [],
    parent: null,
    blockers: [],
    repo: "BAWES-Universe/studenthub-platform",
  });
  const { eligibility, selection } = reconcileOnce({
    issues: [issue("SHU-90", "Todo", "Urgent"), issue("SHU-140", "Backlog", "Low")],
    openPRs: [],
    config: SCOPED,
    receipts: [],
  });
  assert.deepEqual(eligibility.ready.map((card) => card.id), ["SHU-90"]);
  assert.equal(selection.candidate, null);
  assert.match(selection.skipped[0].reason, /unavailable or ineligible.*no fallback/);
});

test("SHU-224: terminal scoped target parks the run and a later tick cannot select a real card", () => {
  const receipt = { issue_id: "SHU-140", stage: "COMPLETED" };
  const result = select([REAL, TARGET], SCOPED, [receipt]);
  assert.equal(result.candidate, null);
  assert.match(result.skipped.find((item) => item.id === "SHU-140")?.reason ?? "", /terminal COMPLETED\/HOLD/);
  assert.match(result.skipped.find((item) => item.id === "SHU-90")?.reason ?? "", /outside trusted dispatch_scope/);
});

test("SHU-224: malformed, empty, ambiguous, and noncanonical scopes fail closed", () => {
  const invalid = [
    null,
    {},
    { issue_ids: [] },
    { issue_ids: ["SHU-140", "SHU-90"] },
    { issue_ids: ["SHU-FIXTURE-001"] },
    { issue_ids: ["SHU-140"], extra: true },
  ];
  for (const dispatch_scope of invalid) {
    const result = select([REAL, TARGET], { ...SCOPED, dispatch_scope });
    assert.equal(result.candidate, null);
    assert.match(result.skipped[0].reason, /invalid dispatch_scope.*no fallback/);
  }
});

test("SHU-224: absent scope preserves board-wide selection", () => {
  const config = { max_dispatch: 1, adapter_pause_map: {} };
  assert.equal(resolveDispatchScope(config).configured, false);
  assert.equal(select([REAL, TARGET], config).candidate?.id, "SHU-90");
});

test("SHU-224: unscoped terminal receipts cannot publish successor directives", async () => {
  let writes = 0;
  const considered = await backfillSuccessorDirectives({
    receipts: [{ issue_id: "SHU-90", stage: "COMPLETED", verdict_stage: "BUILD_READY" }],
    commentsByIssue: new Map(),
    dispatchEnabled: true,
    linearToken: "synthetic-token",
    linearIdFor: new Map([["SHU-90", "uuid-real"]]),
    config: SCOPED,
    fetchImpl: async () => {
      writes += 1;
      throw new Error("unscoped receipt attempted a write");
    },
    stdout: () => undefined,
  });
  assert.equal(considered, 0);
  assert.equal(writes, 0);
});

test("SHU-224: successor backfill is scoped while lifecycle retains every capacity-consuming receipt", () => {
  const receipts = [
    { issue_id: "SHU-90", stage: "RUNNING" },
    { issue_id: "SHU-140", stage: "RUNNING" },
  ];
  assert.deepEqual(receiptsWithinDispatchScope(receipts, SCOPED), [receipts[1]]);
  assert.deepEqual(receiptsWithinDispatchScope(receipts, { ...SCOPED, dispatch_scope: {} }), []);
  assert.deepEqual(receiptsWithinDispatchScope(receipts, { max_dispatch: 1 }), receipts);
  assert.deepEqual(receiptsForLifecycle(receipts, SCOPED), receipts);
});

test("M15 W3: with more than one card worker lifecycle reconciles only the receipts of the worker's own card; one worker reconciles every receipt", async () => {
  const receipts = [
    { issue_id: "SHU-90", stage: "LAUNCH_UNKNOWN" },
    null,
    { issue_id: "SHU-140", stage: "RUNNING" },
  ];
  const two = { ...SCOPED, workers: { max: 2 } };
  assert.deepEqual(receiptsForLifecycle(receipts, two), [receipts[2]], "worker 2's coordinator never resumes worker 1's receipts");
  assert.deepEqual(receiptsForLifecycle(receipts, SCOPED), [receipts[0], receipts[2]], "one worker: every receipt");
  assert.deepEqual(receiptsForLifecycle(receipts, { ...SCOPED, workers: { max: 1 } }), [receipts[0], receipts[2]]);
  // No dispatch scope: nothing narrows the tick, so every receipt, as before.
  assert.deepEqual(receiptsForLifecycle(receipts, { max_dispatch: 1, workers: { max: 2 } }), [receipts[0], receipts[2]]);
  // A whole tick: worker 2's coordinator, scoped to SHU-140, polls its own
  // card's run and never worker 1's SHU-90 run, so it can never pause an
  // adapter from it. One worker polls both, as before.
  const own = { attempt_id: "00000000-0000-4000-8000-000000000140", issue_id: "SHU-140", stage: "RUNNING",
    requested_worker: "codex-builder", external_run_id: "codexrun_00000000-0000-4000-8000-000000000140" };
  const tick = await outOfScopeLifecycleTick({ workers: { max: 2 } }, [own]);
  assert.equal(tick.exit, 0);
  assert.deepEqual(tick.monitored, [own.attempt_id]);
  assert.equal(tick.linearWrites, 0);
  const one = await outOfScopeLifecycleTick({}, [own]);
  assert.deepEqual(one.monitored, ["00000000-0000-4000-8000-000000000090", own.attempt_id]);
});

// One dispatch-on tick with a RUNNING receipt for SHU-90 while the scope is
// SHU-140 (and any further receipts): the attempts whose runs were polled, and
// how many Linear writes the tick made.
async function outOfScopeLifecycleTick(extraConfig = {}, extraReceipts = []) {
  const dir = fs.mkdtempSync(join(tmpdir(), "shu224-main-"));
  try {
    const configPath = join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ ...SCOPED, enable_dispatch: true, ...extraConfig }));
    const monitored = [];
    let linearWrites = 0;
    const issueNode = (id) => ({
      id: `uuid-${id}`,
      identifier: id,
      title: id,
      state: { name: "Todo" },
      priorityLabel: "High",
      labels: { nodes: [{ name: "repo:platform" }] },
      assignee: null,
      delegate: null,
      parent: null,
      relations: { nodes: [] },
    });
    const fetchImpl = async (_url, options) => {
      const { query } = JSON.parse(options.body);
      if (query.includes("CoordinatorIssues")) {
        return { ok: true, status: 200, json: async () => ({ data: { issues: {
          nodes: withBatchedComments([issueNode("SHU-90"), issueNode("SHU-140")], []),
          pageInfo: { hasNextPage: false, endCursor: null },
        } } }) };
      }
      if (query.includes("commentCreate")) linearWrites += 1;
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    };
    const exit = await main([], {
      ENABLE_DISPATCH: "true",
      LINEAR_API_TOKEN: "synthetic-token",
    }, {
      configPath,
      fetchImpl,
      fetchDurable: false,
      openPRsOverride: [],
      skipActivationPreflight: true,
      receipts: [{
        attempt_id: "00000000-0000-4000-8000-000000000090",
        issue_id: "SHU-90",
        stage: "RUNNING",
        requested_worker: "codex-builder",
        external_run_id: "codexrun_00000000-0000-4000-8000-000000000090",
      }, ...extraReceipts],
      adapterModules: { "codex-cli": { monitorRun: async ({ attempt_id }) => { monitored.push(attempt_id); return { kind: "UNCHANGED" }; } } },
      stdout: () => undefined,
    });
    return { exit, monitorCalls: monitored.length, monitored, linearWrites };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("SHU-224: an unscoped active receipt remains lifecycle-reconcilable during the scoped run", async () => {
  const { exit, monitorCalls, linearWrites } = await outOfScopeLifecycleTick();
  assert.equal(exit, 0);
  assert.equal(monitorCalls, 1);
  assert.equal(linearWrites, 0);
});

test("SHU-224: invalid trusted scope prevents dispatch before any mutation", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "shu224-invalid-"));
  try {
    const configPath = join(dir, "config.json");
    const snapshotPath = join(dir, "snapshot.json");
    fs.writeFileSync(configPath, JSON.stringify({ ...SCOPED, enable_dispatch: true, dispatch_scope: { issue_ids: [] } }));
    fs.writeFileSync(snapshotPath, JSON.stringify({ issues: [], openPRs: [] }));
    let externalCalls = 0;
    const exit = await main([], { ENABLE_DISPATCH: "true" }, {
      configPath,
      snapshotPath,
      fetchImpl: async () => { externalCalls += 1; throw new Error("invalid scope reached I/O"); },
      stdout: () => undefined,
    });
    assert.equal(exit, 2);
    assert.equal(externalCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// After SHU-71 stage 5 the committed scope is one real card at a time, one
// slot, and that card must have a committed card lane. The id is pinned so a
// regression cannot quietly point the scope back at an earlier, Done card.
// Dispatch stays disabled; only a signed single-run activation arms it.
test("SHU-224: committed scope is pinned to the current card lanes while dispatch stays disabled", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  assert.equal(config.enable_dispatch, false);
  assert.deepEqual(Object.keys(config.dispatch_scope), ["issue_ids"]);
  assert.deepEqual(config.dispatch_scope.issue_ids, ["SHU-402", "SHU-374"], "SHU-224: the scope names the current card queue (SHU-312)");
  for (const id of config.dispatch_scope.issue_ids) {
    assert.ok(config.card_lanes.some((lane) => lane.id === id), "SHU-224: each scoped card has a card lane");
  }
  assert.equal(config.max_dispatch, 1, "SHU-224: one card, one slot");
});

test("SHU-224 MUTATIONS: selection, shape, and receipt-scope bypasses are killed", () => {
  const mutations = [
    {
      name: "selection scope ignored",
      from: "if (scope.configured && !scope.issueIds.has(issue.id)) {",
      to: "if (false) { // SHU-224-MUTATION-SELECTION",
      assertion: `
        const ready = [
          { id: "SHU-90", priority: "Urgent", requested_worker: "codex-builder" },
          { id: "SHU-140", priority: "Low", requested_worker: "codex-builder" },
        ];
        assert.equal(mod.selectNextReservation({ ready, config, receipts: [] }).candidate?.id, "SHU-140",
          "scope prevents a higher-priority real card");
      `,
      failure: /scope prevents a higher-priority real card/,
    },
    {
      name: "ambiguous scope accepted",
      from: "if (!Array.isArray(raw.issue_ids) || raw.issue_ids.length !== 1) {",
      to: "if (!Array.isArray(raw.issue_ids)) { // SHU-224-MUTATION-AMBIGUOUS",
      assertion: `
        assert.equal(mod.resolveDispatchScope({ dispatch_scope: { issue_ids: ["SHU-140", "SHU-90"] } }).valid, false,
          "ambiguous scope fails closed");
      `,
      failure: /ambiguous scope fails closed/,
    },
    {
      name: "receipt scope ignored",
      from: "return receipts.filter((receipt) => receipt && dispatchScopeAllows(scope, receipt.issue_id));",
      to: "return receipts.filter((receipt) => receipt); // SHU-224-MUTATION-RECEIPTS",
      assertion: `
        const receipts = [{ issue_id: "SHU-90" }, { issue_id: "SHU-140" }];
        assert.deepEqual(mod.receiptsWithinDispatchScope(receipts, config).map((r) => r.issue_id), ["SHU-140"],
          "successor backfill excludes real-card receipts");
      `,
      failure: /successor backfill excludes real-card receipts/,
    },
    {
      name: "lifecycle incorrectly scoped",
      from: "  if (cardWorkers(config) === 1 || !scope.configured) return present;",
      to: "  return receiptsWithinDispatchScope(receipts, config); // SHU-224-MUTATION-LIFECYCLE-SCOPE",
      assertion: `
        const receipts = [{ issue_id: "SHU-90", stage: "RUNNING" }, { issue_id: "SHU-140", stage: "RUNNING" }];
        assert.deepEqual(mod.receiptsForLifecycle(receipts, config).map((r) => r.issue_id), ["SHU-90", "SHU-140"],
          "capacity-consuming receipts remain lifecycle-reconcilable");
      `,
      failure: /capacity-consuming receipts remain lifecycle-reconcilable/,
    },
    {
      name: "lifecycle unscoped with two card workers",
      from: "  return present.filter((receipt) => dispatchScopeAllows(scope, receipt.issue_id));",
      to: "  return present; // SHU-224-MUTATION-WORKER-LIFECYCLE",
      assertion: `
        const receipts = [{ issue_id: "SHU-90", stage: "RUNNING" }, { issue_id: "SHU-140", stage: "RUNNING" }];
        assert.deepEqual(mod.receiptsForLifecycle(receipts, { ...config, workers: { max: 2 } }).map((r) => r.issue_id), ["SHU-140"],
          "a card worker reconciles only its own card's receipts");
      `,
      failure: /a card worker reconciles only its own card's receipts/,
    },
  ];

  for (const mutation of mutations) {
    const tmp = fs.mkdtempSync(join(tmpdir(), "shu224-mutant-"));
    try {
      fs.cpSync(COORDINATOR_DIR, tmp, { recursive: true });
      const target = join(tmp, "reconcile.mjs");
      const source = fs.readFileSync(target, "utf8");
      assert.ok(source.includes(mutation.from), `${mutation.name}: source marker exists`);
      const mutated = source.replace(mutation.from, mutation.to);
      assert.notEqual(mutated, source, `${mutation.name}: mutation landed`);
      fs.writeFileSync(target, mutated);

      const probePath = join(tmp, "shu224-mutant-guard.mjs");
      fs.writeFileSync(probePath, `
        import assert from "node:assert/strict";
        import * as mod from ${JSON.stringify(pathToFileURL(target).href)};
        const config = { max_dispatch: 1, adapter_pause_map: {}, dispatch_scope: { issue_ids: ["SHU-140"] } };
        ${mutation.assertion}
      `);
      const child = spawnSync(process.execPath, [probePath], { encoding: "utf8", timeout: 30000 });
      assert.notEqual(child.status, 0, `${mutation.name}: guard must fail\n${child.stdout}\n${child.stderr}`);
      assert.match(`${child.stdout}\n${child.stderr}`, mutation.failure, `${mutation.name}: named assertion failed`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});
