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

// The committed scope is a card queue, one slot, and every card in it must have
// a committed card lane. The box narrows the queue to the one armed card before
// reconcile reads it (see the narrowing test below). The ids are pinned so a
// regression cannot quietly point the scope back at an earlier, Done card.
// Dispatch stays disabled; only a signed single-run activation arms it.
test("SHU-224: committed scope is pinned to the current card lanes while dispatch stays disabled", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  assert.equal(config.enable_dispatch, false);
  assert.deepEqual(Object.keys(config.dispatch_scope), ["issue_ids"]);
  assert.deepEqual(config.dispatch_scope.issue_ids, ["SHU-604", "SHU-605", "SHU-606", "SHU-607", "SHU-608"], "SHU-224: the scope names the current card queue (SHU-312): the staff civil ID check split in three after SHU-600 stopped, and the People directory in two, since SHU-598 landed by hand");
  const after = (id) => config.card_lanes.find((lane) => lane.id === id).after;
  // Only the real waits: the box keeps cards that share files apart by itself
  // (Velocity A), so no card waits on another just to stay off its files.
  assert.equal(after("SHU-494"), undefined, "SHU-224: SHU-494 waits on nothing");
  assert.deepEqual(after("SHU-495"), ["SHU-494"], "SHU-224: SHU-495 waits on SHU-494");
  assert.equal(after("SHU-496"), undefined, "SHU-224: SHU-496 waits on nothing");
  assert.equal(after("SHU-497"), undefined, "SHU-224: SHU-497 waits on nothing");
  assert.deepEqual(after("SHU-498"), ["SHU-497"], "SHU-224: SHU-498 waits on SHU-497");
  assert.deepEqual(after("SHU-499"), ["SHU-498", "SHU-495"], "SHU-224: SHU-499 waits on SHU-498 and on SHU-495, so the email stores are on the root barrel before the prep records it");
  assert.deepEqual(after("SHU-500"), ["SHU-499"], "SHU-224: SHU-500 waits on SHU-499");
  assert.deepEqual(after("SHU-501"), ["SHU-499"], "SHU-224: SHU-501 waits on SHU-499");
  assert.deepEqual(after("SHU-502"), ["SHU-500", "SHU-499"], "SHU-224: SHU-502 waits on SHU-500 and SHU-499");
  assert.deepEqual(after("SHU-503"), ["SHU-499"], "SHU-224: SHU-503 waits on SHU-499");
  assert.deepEqual(after("SHU-504"), ["SHU-503", "SHU-499"], "SHU-224: SHU-504 waits on SHU-503 and SHU-499");
  assert.deepEqual(after("SHU-505"), ["SHU-500", "SHU-504", "SHU-499"], "SHU-224: SHU-505 waits on SHU-500, SHU-504 and SHU-499");
  assert.deepEqual(after("SHU-506"), ["SHU-503", "SHU-500", "SHU-499"], "SHU-224: SHU-506 waits on SHU-503, SHU-500 and SHU-499");
  assert.deepEqual(after("SHU-507"), ["SHU-500", "SHU-503", "SHU-506", "SHU-499"], "SHU-224: SHU-507 waits on SHU-500, SHU-503, SHU-506 and SHU-499");
  assert.deepEqual(after("SHU-508"), ["SHU-506", "SHU-499"], "SHU-224: SHU-508 waits on SHU-506 and SHU-499");
  // The re-cut of SHU-500's chain, appended: each waits on the re-cut ids of
  // the cards it built on, and on SHU-503, SHU-504 and SHU-499 as before.
  assert.deepEqual(after("SHU-513"), ["SHU-499"], "SHU-224: SHU-513 waits on SHU-499");
  assert.deepEqual(after("SHU-514"), ["SHU-499"], "SHU-224: SHU-514 waits on SHU-499");
  assert.deepEqual(after("SHU-515"), ["SHU-513", "SHU-499"], "SHU-224: SHU-515 waits on SHU-513 and SHU-499");
  assert.deepEqual(after("SHU-516"), ["SHU-513", "SHU-504", "SHU-499"], "SHU-224: SHU-516 waits on SHU-513, SHU-504 and SHU-499");
  assert.deepEqual(after("SHU-517"), ["SHU-503", "SHU-513", "SHU-499"], "SHU-224: SHU-517 waits on SHU-503, SHU-513 and SHU-499");
  assert.deepEqual(after("SHU-518"), ["SHU-513", "SHU-503", "SHU-517", "SHU-499"], "SHU-224: SHU-518 waits on SHU-513, SHU-503, SHU-517 and SHU-499");
  assert.deepEqual(after("SHU-519"), ["SHU-517", "SHU-499"], "SHU-224: SHU-519 waits on SHU-517 and SHU-499");
  const RECUT_500 = ["SHU-513", "SHU-514", "SHU-515", "SHU-516", "SHU-517", "SHU-518", "SHU-519"];
  const STOPPED_500 = ["SHU-500", "SHU-501", "SHU-502", "SHU-505", "SHU-506", "SHU-507", "SHU-508"];
  for (const id of RECUT_500) {
    assert.ok(!(after(id) ?? []).some((need) => STOPPED_500.includes(need)), `SHU-224: ${id} waits on no stopped card`);
  }
  // The re-cut of SHU-503's chain, appended: the same waits under the new ids.
  assert.deepEqual(after("SHU-521"), ["SHU-499"], "SHU-224: SHU-521 waits on SHU-499");
  assert.deepEqual(after("SHU-522"), ["SHU-521", "SHU-499"], "SHU-224: SHU-522 waits on SHU-521 and SHU-499");
  assert.deepEqual(after("SHU-523"), ["SHU-513", "SHU-522", "SHU-499"], "SHU-224: SHU-523 waits on SHU-513, SHU-522 and SHU-499");
  assert.deepEqual(after("SHU-524"), ["SHU-521", "SHU-513", "SHU-499"], "SHU-224: SHU-524 waits on SHU-521, SHU-513 and SHU-499");
  assert.deepEqual(after("SHU-525"), ["SHU-513", "SHU-521", "SHU-524", "SHU-499"], "SHU-224: SHU-525 waits on SHU-513, SHU-521, SHU-524 and SHU-499");
  assert.deepEqual(after("SHU-526"), ["SHU-524", "SHU-499"], "SHU-224: SHU-526 waits on SHU-524 and SHU-499");
  const RECUT_503 = { "SHU-503": "SHU-521", "SHU-504": "SHU-522", "SHU-516": "SHU-523", "SHU-517": "SHU-524", "SHU-518": "SHU-525", "SHU-519": "SHU-526" };
  const STOPPED = [...STOPPED_500, ...Object.keys(RECUT_503)];
  for (const id of Object.values(RECUT_503)) {
    assert.ok(!(after(id) ?? []).some((need) => STOPPED.includes(need)), `SHU-224: ${id} waits on no stopped card`);
  }
  for (const id of config.dispatch_scope.issue_ids) {
    assert.ok(config.card_lanes.some((lane) => lane.id === id), "SHU-224: each scoped card has a card lane");
  }
  // SHU-494 re-cuts SHU-489 with the job-registration files added to its paths.
  const lane494 = config.card_lanes.find((lane) => lane.id === "SHU-494");
  for (const file of ["packages/notifications/src/index.ts", "packages/observability/src/index.ts", "packages/observability/test/jobs-mutations.mjs", "apps/gateway/src/admin-jobs.ts"]) {
    assert.ok(lane494.initial_build_paths.includes(file), `SHU-224: SHU-494 may change ${file}`);
  }
  // SHU-499 runs after the email cards, so its notifications area re-exports their stores.
  const lane499 = config.card_lanes.find((lane) => lane.id === "SHU-499");
  const contract499 = JSON.parse(fs.readFileSync(join(COORDINATOR_DIR, "card-contracts.json"), "utf8")).cards["SHU-499"] ?? {};
  for (const file of ["apps/gateway/src/admin-outbox.ts", "apps/gateway/test/admin-outbox.test.ts", "apps/gateway/src/notifications-http.ts", "apps/gateway/test/notifications-http.test.ts"]) {
    assert.ok(lane499.initial_build_paths.includes(file), `SHU-224: SHU-499 may change ${file}`);
  }
  assert.match(contract499.brief ?? "", /move every export line those two cards added, names unchanged, into notifications\/index\.ts/, "SHU-224: SHU-499 moves the email store exports into notifications");
  assert.match(contract499.acceptance ?? "", /notifications exposes exactly the names SHU-494 and SHU-495 export from the root/, "SHU-224: SHU-499 acceptance keeps the email store exports");
  // The re-cut cards list the route-order test, and the cards that add copy
  // the profile copy and its key-count test; their briefs say how to change them.
  const contracts = JSON.parse(fs.readFileSync(join(COORDINATOR_DIR, "card-contracts.json"), "utf8")).cards;
  for (const id of RECUT_500) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    const copy = id !== "SHU-517";
    const files = ["apps/gateway/test/routes-order.test.ts", ...(copy ? ["apps/gateway/test/profile-kit.test.ts", "apps/gateway/src/ui/profile-copy.ts"] : [])];
    for (const file of files) {
      assert.ok(lane.initial_build_paths.includes(file) && lane.revision_paths.includes(file), `SHU-224: ${id} may change ${file}`);
      assert.ok(contracts[id].brief.includes(`- ${file}\n`), `SHU-224: ${id}'s brief lists ${file}`);
    }
    assert.deepEqual(lane.initial_build_paths, contracts[id].initial_build_paths, `SHU-224: ${id}'s lane and contract list the same paths`);
    assert.deepEqual(lane.revision_paths, contracts[id].revision_paths, `SHU-224: ${id}'s lane and contract list the same revision paths`);
    assert.match(contracts[id].brief, /appending its name to that list .* bumping the length assertion by one per route, keeping every existing name in its order/, `SHU-224: ${id} says how to change the route-order test`);
    assert.equal(/U1_COPY key count/.test(contracts[id].brief), copy, `SHU-224: ${id} says how to change the U1_COPY count only where it adds copy`);
    assert.match(contracts[id].brief, /Before you finish, run git status and compare every changed or added file with your paths/, `SHU-224: ${id} checks its own paths`);
    assert.match(contracts[id].acceptance, /re-queued under a fresh id .*; SHU-50[0-8] never lands\./, `SHU-224: ${id} names the card it replaces`);
  }
  // SHU-521 and SHU-522 re-cut SHU-503 and SHU-504 with the route-order test
  // and the profile copy pair in their paths and the same guard; SHU-521 also
  // says how a sequential repeat of a submission is answered. SHU-523 to
  // SHU-526 keep their contracts with only the ids remapped.
  const recutIds = (text) => text.replace(/\bSHU-(503|504|516|517|518|519)\b/g, (id) => RECUT_503[id]);
  for (const [from, id] of Object.entries(RECUT_503)) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    assert.deepEqual(lane.initial_build_paths, contracts[id].initial_build_paths, `SHU-224: ${id}'s lane and contract list the same paths`);
    assert.deepEqual(lane.revision_paths, contracts[id].revision_paths, `SHU-224: ${id}'s lane and contract list the same revision paths`);
    assert.ok(contracts[id].acceptance.endsWith(`; ${from} never lands.`) || contracts[id].acceptance.includes(`; ${from} never lands. Appending route names`), `SHU-224: ${id} names the card it replaces`);
    if (from === "SHU-503" || from === "SHU-504") {
      for (const file of ["apps/gateway/test/routes-order.test.ts", "apps/gateway/test/profile-kit.test.ts", "apps/gateway/src/ui/profile-copy.ts"]) {
        assert.ok(lane.initial_build_paths.includes(file) && lane.revision_paths.includes(file), `SHU-224: ${id} may change ${file}`);
        assert.ok(contracts[id].brief.includes(`- ${file}\n`), `SHU-224: ${id}'s brief lists ${file}`);
      }
      assert.match(contracts[id].brief, /appending its name to that list .* bumping the length assertion by one per route, keeping every existing name in its order/, `SHU-224: ${id} says how to change the route-order test`);
      assert.match(contracts[id].brief, /U1_COPY key count/, `SHU-224: ${id} says how to change the U1_COPY count`);
      assert.match(contracts[id].brief, /Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nYour paths/, `SHU-224: ${id} ends its guard with the path self-check`);
    } else {
      const base = contracts[from];
      assert.deepEqual(contracts[id].initial_build_paths, base.initial_build_paths, `SHU-224: ${id} keeps ${from}'s paths`);
      assert.equal(contracts[id].brief, recutIds(base.brief), `SHU-224: ${id} keeps ${from}'s brief but for the ids`);
    }
  }
  assert.match(contracts["SHU-521"].brief, /A sequential repeat .* answers 409 .*it never expects 303 for the second post\./, "SHU-224: SHU-521 says how a sequential repeat is answered");
  // The re-cut of SHU-521's chain is the whole queue: no lane waits on a
  // landed or stopped card, and only on cards earlier in the queue.
  const RECUT_521 = { "SHU-521": "SHU-531", "SHU-515": "SHU-537", "SHU-522": "SHU-532", "SHU-523": "SHU-533", "SHU-524": "SHU-534", "SHU-525": "SHU-535", "SHU-526": "SHU-536" };
  assert.equal(after("SHU-531"), undefined, "SHU-224: SHU-531 waits on nothing");
  assert.equal(after("SHU-537"), undefined, "SHU-224: SHU-537 waits on nothing");
  assert.deepEqual(after("SHU-532"), ["SHU-531"], "SHU-224: SHU-532 waits on SHU-531");
  assert.deepEqual(after("SHU-533"), ["SHU-532"], "SHU-224: SHU-533 waits on SHU-532");
  assert.deepEqual(after("SHU-534"), ["SHU-531"], "SHU-224: SHU-534 waits on SHU-531");
  assert.deepEqual(after("SHU-535"), ["SHU-531", "SHU-534"], "SHU-224: SHU-535 waits on SHU-531 and SHU-534");
  assert.deepEqual(after("SHU-536"), ["SHU-534"], "SHU-224: SHU-536 waits on SHU-534");
  const recut521 = (text) => text.replace(/\bSHU-(515|521|522|523|524|525|526)\b/g, (id) => RECUT_521[id]);
  for (const [from, id] of Object.entries(RECUT_521)) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    const base = contracts[from];
    assert.deepEqual(lane.initial_build_paths, base.initial_build_paths, `SHU-224: ${id} keeps ${from}'s paths`);
    assert.deepEqual(lane.revision_paths, base.revision_paths, `SHU-224: ${id} keeps ${from}'s revision paths`);
    assert.deepEqual(contracts[id].initial_build_paths, base.initial_build_paths, `SHU-224: ${id}'s contract keeps ${from}'s paths`);
    assert.ok(contracts[id].acceptance.endsWith(`; ${from} never lands.`), `SHU-224: ${id} names the card it replaces`);
    if (from !== "SHU-521") assert.equal(contracts[id].brief, recut521(base.brief), `SHU-224: ${id} keeps ${from}'s brief but for the ids`);
  }
  // SHU-531's brief closes the four findings that stopped SHU-521.
  const brief531 = contracts["SHU-531"].brief;
  assert.match(brief531, /reads the built file \.\.\/\.\.\/\.\.\/dist\/apps\/gateway\/src\/documents-upload-http\.js, never \.\.\/src\/documents-upload-http\.js/, "SHU-224: SHU-531 says which file the mutants rewrite");
  assert.match(brief531, /Every needle is executable code, never a comment/, "SHU-224: SHU-531 keeps needles out of comments");
  assert.match(brief531, /keeping the old version until the new one commits \(item 4\)/, "SHU-224: SHU-531 has a mutant for item 4");
  assert.match(brief531, /Tests go through the route\./, "SHU-224: SHU-531 tests through the route");
  assert.match(brief531, /- No date: My documents shows format and size only/, "SHU-224: SHU-531 settles the date");
  assert.doesNotMatch(contracts["SHU-531"].acceptance, /UPL_DATE/, "SHU-224: SHU-531 does not ask for a date");
  assert.match(brief531, /- The last attempt at this card \(SHU-521\)[\s\S]*\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nYour paths/, "SHU-224: SHU-531 keeps the path self-check last");
  // SHU-531 stopped on browser-acceptance, whose documents scenarios still
  // expected a read-only page in a file outside its paths. Its re-cut and
  // the cards that wait on it are the queue now.
  const RECUT_531 = { "SHU-531": "SHU-539", "SHU-532": "SHU-540", "SHU-533": "SHU-541", "SHU-534": "SHU-542", "SHU-535": "SHU-543", "SHU-536": "SHU-544" };
  assert.equal(after("SHU-539"), undefined, "SHU-224: SHU-539 waits on nothing");
  assert.deepEqual(after("SHU-540"), ["SHU-539"], "SHU-224: SHU-540 waits on SHU-539");
  assert.deepEqual(after("SHU-541"), ["SHU-540"], "SHU-224: SHU-541 waits on SHU-540");
  assert.deepEqual(after("SHU-542"), ["SHU-539"], "SHU-224: SHU-542 waits on SHU-539");
  assert.deepEqual(after("SHU-543"), ["SHU-539", "SHU-542"], "SHU-224: SHU-543 waits on SHU-539 and SHU-542");
  assert.deepEqual(after("SHU-544"), ["SHU-542"], "SHU-224: SHU-544 waits on SHU-542");
  const recut531 = (text) => text.replace(/\bSHU-(531|532|533|534|535|536)\b/g, (id) => RECUT_531[id]);
  const BROWSER = "tools/browser-acceptance/run.mjs";
  for (const [from, id] of Object.entries(RECUT_531)) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    const base = contracts[from];
    const widened = from === "SHU-531" || from === "SHU-532";
    const paths = widened ? [...base.initial_build_paths, BROWSER] : base.initial_build_paths;
    assert.deepEqual(lane.initial_build_paths, paths, `SHU-224: ${id} keeps ${from}'s paths${widened ? " and adds the browser acceptance file" : ""}`);
    assert.deepEqual(lane.revision_paths, widened ? [...base.revision_paths, BROWSER] : base.revision_paths, `SHU-224: ${id} keeps ${from}'s revision paths`);
    assert.deepEqual(contracts[id].initial_build_paths, paths, `SHU-224: ${id}'s contract matches its lane`);
    assert.ok(contracts[id].acceptance.endsWith(`; ${from} never lands.`), `SHU-224: ${id} names the card it replaces`);
    if (widened) assert.match(contracts[id].brief, /\n- tools\/browser-acceptance\/run\.mjs\n\nOut of scope:/, `SHU-224: ${id}'s brief lists the browser acceptance file in its paths`);
    else assert.equal(contracts[id].brief, recut531(base.brief), `SHU-224: ${id} keeps ${from}'s brief but for the ids`);
  }
  const brief539 = contracts["SHU-539"].brief;
  assert.match(brief539, /four `main dl > div` slots, each `#document-<slot>` with its `dt` label/, "SHU-224: SHU-539 keeps the slot structure the scenarios read");
  assert.match(brief539, /In documentPage, change only the read-only assertion\./, "SHU-224: SHU-539 changes only the read-only assertion");
  assert.match(contracts["SHU-539"].acceptance, /\(UPL_BROWSER\)/, "SHU-224: SHU-539 holds the browser scenarios to pass");
  assert.match(contracts["SHU-540"].brief, /After SHU-539 it expects exactly one upload form in each slot\./, "SHU-224: SHU-540 knows what SHU-539 left in run.mjs");
  assert.match(brief539, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nYour paths/, "SHU-224: SHU-539 keeps the path self-check last");
  // SHU-537 stopped on four golden tests outside its paths and left commits
  // on its branch; SHU-546 is its contract with both test files added.
  assert.equal(after("SHU-546"), undefined, "SHU-224: SHU-546 waits on nothing");
  const GOLDENS = ["apps/gateway/test/db-subpaths.test.ts", "apps/gateway/test/wiring-runtime.test.ts"];
  const lane546 = config.card_lanes.find((entry) => entry.id === "SHU-546");
  assert.deepEqual(lane546.initial_build_paths, [...contracts["SHU-537"].initial_build_paths, ...GOLDENS], "SHU-224: SHU-546 keeps SHU-537's paths and adds the golden tests");
  assert.deepEqual(lane546.revision_paths, [...contracts["SHU-537"].revision_paths, ...GOLDENS], "SHU-224: SHU-546 keeps SHU-537's revision paths and adds the golden tests");
  assert.deepEqual(contracts["SHU-546"].initial_build_paths, lane546.initial_build_paths, "SHU-224: SHU-546's contract matches its lane");
  assert.match(contracts["SHU-546"].brief, /\n- apps\/gateway\/test\/db-subpaths\.test\.ts\n- apps\/gateway\/test\/wiring-runtime\.test\.ts\n\nOut of scope:/, "SHU-224: SHU-546's brief lists the golden tests in its paths");
  assert.match(contracts["SHU-546"].brief, /raise each pool count by exactly the pools you add/, "SHU-224: SHU-546 says how the pool count moves");
  assert.ok(contracts["SHU-546"].acceptance.endsWith("; SHU-537 never lands."), "SHU-224: SHU-546 names the card it replaces");
  // SHU-539 stopped on a Q14_1_OWNER test (404 for a second signed-in
  // person) and left commits on its branch; it and the cards waiting on it
  // are re-cut again.
  const RECUT_539 = { "SHU-539": "SHU-548", "SHU-540": "SHU-549", "SHU-541": "SHU-550", "SHU-542": "SHU-551", "SHU-543": "SHU-552", "SHU-544": "SHU-553" };
  assert.equal(after("SHU-548"), undefined, "SHU-224: SHU-548 waits on nothing");
  assert.deepEqual(after("SHU-549"), ["SHU-548"], "SHU-224: SHU-549 waits on SHU-548");
  assert.deepEqual(after("SHU-550"), ["SHU-549"], "SHU-224: SHU-550 waits on SHU-549");
  assert.deepEqual(after("SHU-551"), ["SHU-548"], "SHU-224: SHU-551 waits on SHU-548");
  assert.deepEqual(after("SHU-552"), ["SHU-548", "SHU-551"], "SHU-224: SHU-552 waits on SHU-548 and SHU-551");
  assert.deepEqual(after("SHU-553"), ["SHU-551"], "SHU-224: SHU-553 waits on SHU-551");
  const recut539 = (text) => text.replace(/\bSHU-(539|540|541|542|543|544)\b/g, (id) => RECUT_539[id]);
  for (const [from, id] of Object.entries(RECUT_539)) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    const base = contracts[from];
    assert.deepEqual(lane.initial_build_paths, base.initial_build_paths, `SHU-224: ${id} keeps ${from}'s paths`);
    assert.deepEqual(lane.revision_paths, base.revision_paths, `SHU-224: ${id} keeps ${from}'s revision paths`);
    assert.deepEqual(contracts[id].initial_build_paths, base.initial_build_paths, `SHU-224: ${id}'s contract keeps ${from}'s paths`);
    assert.ok(contracts[id].acceptance.endsWith(`; ${from} never lands.`), `SHU-224: ${id} names the card it replaces`);
    if (from !== "SHU-539") assert.equal(contracts[id].brief, recut539(base.brief), `SHU-224: ${id} keeps ${from}'s brief but for the ids`);
  }
  assert.match(contracts["SHU-548"].brief, /A signed-in person's own slot, one of the four slot names, is never 404\./, "SHU-224: SHU-548 says a person's own slot is never 404");
  assert.match(contracts["SHU-548"].brief, /Never change the expected status to make the test pass\./, "SHU-224: SHU-548 keeps the expected 303");
  assert.match(contracts["SHU-548"].brief, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nYour paths/, "SHU-224: SHU-548 keeps the path self-check last");
  // SHU-546 stopped: the PostgreSQL stale-revision mutant survived, and it
  // left commits on its branch; SHU-555 is its contract with the missing
  // database test spelled out.
  assert.equal(after("SHU-555"), undefined, "SHU-224: SHU-555 waits on nothing");
  const lane555 = config.card_lanes.find((entry) => entry.id === "SHU-555");
  assert.deepEqual(lane555.initial_build_paths, contracts["SHU-546"].initial_build_paths, "SHU-224: SHU-555 keeps SHU-546's paths");
  assert.deepEqual(lane555.revision_paths, contracts["SHU-546"].revision_paths, "SHU-224: SHU-555 keeps SHU-546's revision paths");
  assert.deepEqual(contracts["SHU-555"].initial_build_paths, lane555.initial_build_paths, "SHU-224: SHU-555's contract matches its lane");
  assert.ok(contracts["SHU-555"].acceptance.endsWith("; SHU-546 never lands."), "SHU-224: SHU-555 names the card it replaces");
  assert.match(contracts["SHU-555"].brief, /^Card SHU-555:/, "SHU-224: SHU-555's brief names its own card");
  assert.match(contracts["SHU-555"].brief, /saves again with the old expected revision, and asserts \{ok:false, reason:"stale_revision"\}/, "SHU-224: SHU-555 asks for the stale-revision database test");
  assert.match(contracts["SHU-555"].brief, /never drop a mutant to make the script pass/, "SHU-224: SHU-555 keeps every mutant");
  assert.match(contracts["SHU-555"].brief, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nYour paths/, "SHU-224: SHU-555 keeps the path self-check last");
  // SHU-549 stopped on mutants dying by thrown errors and SHU-551 on a builder
  // exit; both leave the queue with the cards that wait on them.
  const RECUT_549 = { "SHU-549": "SHU-558", "SHU-550": "SHU-559", "SHU-551": "SHU-560", "SHU-552": "SHU-561", "SHU-553": "SHU-562" };
  assert.equal(after("SHU-558"), undefined, "SHU-224: SHU-558 waits on nothing");
  assert.equal(after("SHU-560"), undefined, "SHU-224: SHU-560 waits on nothing");
  assert.deepEqual(after("SHU-559"), ["SHU-558"], "SHU-224: SHU-559 waits on SHU-558");
  assert.deepEqual(after("SHU-561"), ["SHU-560"], "SHU-224: SHU-561 waits on SHU-560 alone, since SHU-548 landed");
  assert.deepEqual(after("SHU-562"), ["SHU-560"], "SHU-224: SHU-562 waits on SHU-560");
  const recut549 = (text) => text.replace(/\bSHU-(549|550|551|552|553)\b/g, (id) => RECUT_549[id]);
  for (const [from, id] of Object.entries(RECUT_549)) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    const base = contracts[from];
    assert.deepEqual(lane.initial_build_paths, base.initial_build_paths, `SHU-224: ${id} keeps ${from}'s paths`);
    assert.deepEqual(lane.revision_paths, base.revision_paths, `SHU-224: ${id} keeps ${from}'s revision paths`);
    assert.deepEqual(contracts[id].initial_build_paths, base.initial_build_paths, `SHU-224: ${id}'s contract keeps ${from}'s paths`);
    assert.ok(contracts[id].acceptance.endsWith(`; ${from} never lands.`), `SHU-224: ${id} names the card it replaces`);
    if (from !== "SHU-549") assert.equal(contracts[id].brief, recut549(base.brief), `SHU-224: ${id} keeps ${from}'s brief but for the ids`);
  }
  assert.ok(contracts["SHU-558"].initial_build_paths.includes("tools/browser-acceptance/run.mjs"), "SHU-224: SHU-558 keeps the browser acceptance file for its Remove and View controls");
  assert.match(contracts["SHU-558"].brief, /every mutant to die by an AssertionError in its named test/, "SHU-224: SHU-558 says how a mutant dies");
  assert.match(contracts["SHU-558"].brief, /Never drop or weaken a mutant to make the script pass\./, "SHU-224: SHU-558 keeps every mutant");
  assert.match(contracts["SHU-558"].brief, /real CandidateDocuments rig/, "SHU-224: SHU-558 pins the missing tests on the real rig");
  assert.match(contracts["SHU-558"].brief, /answers 409 and removes nothing/, "SHU-224: SHU-558 pins the foreign stamp");
  assert.match(contracts["SHU-558"].brief, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nYour paths/, "SHU-224: SHU-558 keeps the path self-check last");
  // SHU-563 is appended after the installed queue and waits on nothing.
  assert.equal(after("SHU-563"), undefined, "SHU-224: SHU-563 waits on nothing");
  const lane563 = config.card_lanes.find((entry) => entry.id === "SHU-563");
  assert.deepEqual(lane563.initial_build_paths, [...contracts["SHU-563"].initial_build_paths], "SHU-224: SHU-563's lane matches its contract");
  assert.deepEqual(lane563.revision_paths, [...contracts["SHU-563"].revision_paths], "SHU-224: SHU-563's revision paths match its contract");
  assert.ok(lane563.initial_build_paths.includes("packages/db/migrations/0220_candidate_document_read_audit.sql"), "SHU-224: SHU-563 owns migration 0220");
  assert.ok(!lane563.initial_build_paths.some((path) => path.startsWith("apps/") || path.startsWith("tools/")), "SHU-224: SHU-563 touches no gateway or browser file");
  assert.ok(lane563.initial_build_paths.includes("packages/private-documents/test/r2-postgres.test.mjs"), "SHU-224: SHU-563's PostgreSQL tests live in the one file npm run test:db runs for this package");
  assert.match(contracts["SHU-563"].brief, /BEFORE TRUNCATE/, "SHU-224: SHU-563's read audit table refuses TRUNCATE");
  assert.match(contracts["SHU-563"].brief, /reader pool/, "SHU-224: SHU-563 keeps reads off the writer pool");
  assert.match(contracts["SHU-563"].brief, /^Card SHU-563:/, "SHU-224: SHU-563's brief names its own card");
  assert.match(contracts["SHU-563"].brief, /Without readPath, everything stays exactly as today/, "SHU-224: SHU-563 keeps every store without the read path as it is");
  assert.match(contracts["SHU-563"].brief, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nFinish with/, "SHU-224: SHU-563 keeps the path self-check last");
  // SHU-566 to SHU-568 re-cut SHU-560 to SHU-562 after SHU-560 stopped; only the real waits are kept.
  assert.equal(after("SHU-566"), undefined, "SHU-224: SHU-566 waits on nothing");
  assert.deepEqual(after("SHU-567"), ["SHU-566"], "SHU-224: SHU-567 waits only on SHU-566");
  assert.deepEqual(after("SHU-568"), ["SHU-566"], "SHU-224: SHU-568 waits only on SHU-566");
  for (const [from, to] of [["SHU-560", "SHU-566"], ["SHU-561", "SHU-567"], ["SHU-562", "SHU-568"]]) {
    assert.deepEqual([...contracts[to].initial_build_paths], [...contracts[from].initial_build_paths], `SHU-224: ${to} keeps ${from}'s paths`);
    assert.deepEqual(config.card_lanes.find((entry) => entry.id === to).initial_build_paths, [...contracts[to].initial_build_paths], `SHU-224: ${to}'s lane matches its contract`);
    assert.match(contracts[to].brief, new RegExp(`^Card ${to}:`), `SHU-224: ${to}'s brief names its own card`);
    assert.match(contracts[to].acceptance, new RegExp(`${to} is ${from}'s contract re-queued under a fresh id [^;]*; ${from} never lands\\.$`), `SHU-224: ${to} says which card it replaces`);
  }
  assert.match(contracts["SHU-566"].brief, /RETURNING o\.id/, "SHU-224: SHU-566 says how to qualify its RETURNING columns");
  assert.match(contracts["SHU-566"].brief, /Export PostgresCivilIdOcrStore[^\n]*packages\/db\/src\/profile\/index\.ts/, "SHU-224: SHU-566 exports its store from the profile area");
  assert.match(contracts["SHU-566"].acceptance, /OCR_BASELINE: the first sweep[^;]*reads nothing/, "SHU-224: SHU-566 does not flag or read the photos already stored when it first runs");
  assert.match(contracts["SHU-566"].brief, /name: 'AssertionError'/, "SHU-224: SHU-566's mutants must die by AssertionError");
  assert.match(contracts["SHU-566"].brief, /\n- Before you finish, [^\n]*\n[\s\S]*\n\nFinish with/, "SHU-224: SHU-566 keeps its finishing lines last");
  // SHU-570 re-cuts SHU-559 after it stopped: the derived checklist is HTML only,
  // JSON keeps zero document reads, and the two test files it may extend are in its paths.
  for (const id of ["SHU-558", "SHU-559", "SHU-560", "SHU-561", "SHU-562", "SHU-563", "SHU-564", "SHU-566", "SHU-567", "SHU-568", "SHU-570", "SHU-573", "SHU-574", "SHU-575", "SHU-576", "SHU-577", "SHU-579", "SHU-581", "SHU-584", "SHU-586", "SHU-588", "SHU-590", "SHU-592", "SHU-594", "SHU-596", "SHU-598", "SHU-600"]) assert.ok(!config.dispatch_scope.issue_ids.includes(id), `SHU-224: stopped or landed ${id} is not dispatched again`);
  assert.equal(after("SHU-570"), undefined, "SHU-224: SHU-570 waits on nothing, since SHU-558 has landed");
  const lane570 = config.card_lanes.find((entry) => entry.id === "SHU-570");
  assert.deepEqual(lane570.initial_build_paths, [...contracts["SHU-570"].initial_build_paths], "SHU-224: SHU-570's lane matches its contract");
  assert.deepEqual(lane570.revision_paths, [...contracts["SHU-570"].revision_paths], "SHU-224: SHU-570's revision paths match its contract");
  assert.deepEqual([...contracts["SHU-570"].initial_build_paths], [...contracts["SHU-559"].initial_build_paths, "apps/gateway/test/profile-journey.test.ts", "apps/gateway/test/documents-page.test.ts"], "SHU-224: SHU-570 keeps SHU-559's paths and adds the two tests it may extend");
  assert.match(contracts["SHU-570"].brief, /^Card SHU-570:/, "SHU-224: SHU-570's brief names its own card");
  assert.doesNotMatch(contracts["SHU-570"].brief, /SHU-559 is|in both JSON and HTML/, "SHU-224: SHU-570 no longer asks for derived values on the JSON path");
  assert.match(contracts["SHU-570"].brief, /JSON stays as it is\./, "SHU-224: SHU-570 keeps JSON GET /profile at zero document reads");
  assert.match(contracts["SHU-570"].brief, /Labels come only from the copy\./, "SHU-224: SHU-570 forbids the label override");
  assert.match(contracts["SHU-570"].brief, /\n- apps\/gateway\/test\/profile-kit\.test\.ts\n- apps\/gateway\/test\/profile-journey\.test\.ts\n- apps\/gateway\/test\/documents-page\.test\.ts\n\nOut of scope:/, "SHU-224: SHU-570's brief lists its added paths");
  assert.match(contracts["SHU-570"].brief, /keep every existing test in them as it is\.\n- Before you finish, [^\n]*\n\nYour paths/, "SHU-224: SHU-570 keeps the path self-check last, after its review points");
  assert.match(contracts["SHU-570"].acceptance, /GET \/profile as HTML carries isProfileCompleted/, "SHU-224: SHU-570's acceptance derives on HTML only");
  assert.match(contracts["SHU-570"].acceptance, /Q14_4_JSON: a JSON GET \/profile makes no documents list/, "SHU-224: SHU-570 pins zero document reads on JSON");
  assert.match(contracts["SHU-570"].acceptance, /SHU-570 is SHU-559's contract re-queued under a fresh id [^;]*; SHU-559 never lands\.$/, "SHU-224: SHU-570 says which card it replaces");
  // SHU-573 to SHU-575 re-cut SHU-566 to SHU-568 after SHU-566's builder returned FAILED in its sandbox;
  // SHU-576 and SHU-577 split SHU-570 after it stopped twice.
  assert.equal(after("SHU-573"), undefined, "SHU-224: SHU-573 waits on nothing");
  assert.deepEqual(after("SHU-574"), ["SHU-573"], "SHU-224: SHU-574 waits only on SHU-573");
  assert.deepEqual(after("SHU-575"), ["SHU-573"], "SHU-224: SHU-575 waits only on SHU-573");
  assert.equal(after("SHU-576"), undefined, "SHU-224: SHU-576 waits on nothing");
  assert.deepEqual(after("SHU-577"), ["SHU-576"], "SHU-224: SHU-577 waits only on SHU-576");
  for (const [from, to] of [["SHU-566", "SHU-573"], ["SHU-567", "SHU-574"], ["SHU-568", "SHU-575"]]) {
    assert.deepEqual([...contracts[to].initial_build_paths], [...contracts[from].initial_build_paths], `SHU-224: ${to} keeps ${from}'s paths`);
    assert.match(contracts[to].acceptance, new RegExp(`${to} is ${from}'s contract re-queued under a fresh id [^;]*; ${from} never lands\\.$`), `SHU-224: ${to} says which card it replaces`);
  }
  for (const id of ["SHU-573", "SHU-574", "SHU-575", "SHU-576", "SHU-577"]) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    assert.deepEqual(lane.initial_build_paths, [...contracts[id].initial_build_paths], `SHU-224: ${id}'s lane matches its contract`);
    assert.deepEqual(lane.revision_paths, [...contracts[id].revision_paths], `SHU-224: ${id}'s revision paths match its contract`);
    assert.match(contracts[id].brief, new RegExp(`^Card ${id}:`), `SHU-224: ${id}'s brief names its own card`);
    assert.match(contracts[id].brief, /never return FAILED because of a sandbox limit/, `SHU-224: ${id} hands in its work when only the sandbox stops the full run`);
    assert.match(contracts[id].brief, /\n\nFinish with [^\n]*$/, `SHU-224: ${id} keeps its finishing paragraph last`);
  }
  assert.match(contracts["SHU-573"].brief, /one-row marker table that migration 0218 creates; the marker is mandatory/, "SHU-224: SHU-573's baseline marker is mandatory");
  assert.match(contracts["SHU-573"].acceptance, /with an empty store, the first sweep writes the marker and no job/, "SHU-224: SHU-573 pins the empty store then upload case");
  assert.deepEqual([...contracts["SHU-576"].initial_build_paths, ...contracts["SHU-577"].initial_build_paths].sort(), [...contracts["SHU-570"].initial_build_paths, "apps/gateway/test/profile-completeness-mutations.mjs"].sort(), "SHU-224: the two halves of SHU-570 share its paths between them, and SHU-577 adds its gateway mutation script");
  assert.ok(contracts["SHU-577"].initial_build_paths.includes("apps/gateway/test/profile-completeness-mutations.mjs"), "SHU-224: SHU-577 may write the gateway mutation script its acceptance requires");
  assert.match(contracts["SHU-577"].acceptance, /\(6\) mutants [^;]*in apps\/gateway\/test\/profile-completeness-mutations\.mjs/, "SHU-224: SHU-577's acceptance names that script");
  assert.match(contracts["SHU-577"].acceptance, /no part of the HTML page says complete; JSON follows item \(5\)/, "SHU-224: SHU-577's failure clause covers the HTML page and leaves JSON to item (5)");
  assert.doesNotMatch(contracts["SHU-577"].brief, /no part of the page or JSON says complete/, "SHU-224: SHU-577 never says JSON must not say complete");
  assert.match(contracts["SHU-577"].acceptance, /Q14_4_JSON: a JSON GET \/profile makes no documents list, no delivery and no completeness read/, "SHU-224: SHU-577 keeps JSON GET /profile at zero document reads");
  assert.match(contracts["SHU-573"].acceptance, /a photo uploaded after it is queued, read and flagged/, "SHU-224: SHU-573 reads and flags a photo uploaded after the baseline");
  assert.match(contracts["SHU-573"].acceptance, /the current-suggestion read never returns a baseline job/, "SHU-224: SHU-573 never shows a baseline job as a suggestion");
  assert.ok(contracts["SHU-576"].initial_build_paths.every((path) => path.startsWith("packages/profile/")), "SHU-224: SHU-576 changes only packages/profile");
  assert.match(contracts["SHU-576"].brief, /Imported nationality has no catalogue id\./, "SHU-224: SHU-576 says what an imported-only nationality does");
  assert.match(contracts["SHU-576"].brief, /called \.trim\(\) on false/, "SHU-224: SHU-576 says mutants on boolean fields die by assertion");
  assert.match(contracts["SHU-577"].brief, /A completeness failure never changes the page's status\./, "SHU-224: SHU-577 keeps the page status when evidence fails");
  assert.match(contracts["SHU-577"].acceptance, /Q14_4_STATUS: [^;]*answers 200/, "SHU-224: SHU-577 pins status 200 when a source fails");
  assert.match(contracts["SHU-577"].acceptance, /real GET \/profile through createGatewayServer/, "SHU-224: SHU-577 tests go through the real route");
  for (const id of ["SHU-576", "SHU-577"]) {
    assert.doesNotMatch(contracts[id].brief, /in both the JSON and the HTML path|as JSON and as HTML both carry|SHU-559/, `SHU-224: ${id} has no JSON-and-HTML leftovers and no stale ids`);
    assert.match(contracts[id].acceptance, new RegExp(`${id} is the [^;]* half of SHU-570's contract[^;]*; SHU-570 never lands\\.$`), `SHU-224: ${id} says which card it splits`);
  }
  // SHU-579 follows up SHU-573's review findings; it shares no file with SHU-574 or SHU-575.
  assert.equal(after("SHU-579"), undefined, "SHU-224: SHU-579 waits on nothing");
  const lane579 = config.card_lanes.find((entry) => entry.id === "SHU-579");
  assert.deepEqual(lane579.initial_build_paths, [...contracts["SHU-579"].initial_build_paths], "SHU-224: SHU-579's lane matches its contract");
  assert.deepEqual(lane579.revision_paths, [...contracts["SHU-579"].revision_paths], "SHU-224: SHU-579's revision paths match its contract");
  for (const id of ["SHU-574", "SHU-575"]) assert.ok(contracts[id].initial_build_paths.every((path) => !contracts["SHU-579"].initial_build_paths.includes(path)), `SHU-224: SHU-579 shares no file with ${id}`);
  assert.match(contracts["SHU-579"].brief, /^Card SHU-579:/, "SHU-224: SHU-579's brief names its own card");
  for (const token of ["OCR_LEASE", "OCR_THROTTLE", "OCR_ORG", "OCR_EXPIRED_NULL", "OCR_ACCEPT_COMPLETE", "OCR_DATES", "OCR_PHOTO_THROW"]) assert.match(contracts["SHU-579"].acceptance, new RegExp(`${token}: `), `SHU-224: SHU-579 pins ${token}`);
  assert.match(contracts["SHU-579"].acceptance, /OCR_LEASE: [^;]*times two reads[^;]*every claimed job it has not finished yet[^]*?neither a claimed job still waiting its turn in the batch nor a late front job/, "SHU-224: SHU-579's lease covers the whole batch, back-photo reads and waiting jobs included");
  assert.match(contracts["SHU-579"].brief, /Renewing only the job about to be read is not enough/, "SHU-224: SHU-579 rules out per-job renewal alone");
  assert.match(contracts["SHU-579"].brief, /never return FAILED because of a sandbox limit/, "SHU-224: SHU-579 hands in its work when only the sandbox stops the full run");
  assert.match(contracts["SHU-579"].brief, /\n- packages\/profile\/test\/civil-id-ocr-mutations\.mjs\n\nOut of scope:/, "SHU-224: SHU-579's brief lists its paths one per line");
  // SHU-581 re-cuts SHU-577 and SHU-584 re-cuts SHU-574, each with its contract gaps settled.
  assert.equal(after("SHU-581"), undefined, "SHU-224: SHU-581 waits on nothing, since SHU-576 has landed");
  assert.equal(after("SHU-584"), undefined, "SHU-224: SHU-584 waits on nothing, since SHU-573 has landed");
  for (const id of ["SHU-579", "SHU-581", "SHU-584", "SHU-586", "SHU-588", "SHU-590", "SHU-592", "SHU-594", "SHU-596", "SHU-598", "SHU-600"]) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    assert.deepEqual(lane.initial_build_paths, [...contracts[id].initial_build_paths], `SHU-224: ${id}'s lane matches its contract`);
    assert.deepEqual(lane.revision_paths, [...contracts[id].revision_paths], `SHU-224: ${id}'s revision paths match its contract`);
    assert.match(contracts[id].brief, new RegExp(`^Card ${id}:`), `SHU-224: ${id}'s brief names its own card`);
    assert.match(contracts[id].brief, /A mutation script writes each mutant and runs the tests against it[^\n]*documents-page-mutations\.mjs[^\n]*never a regular expression over a source file\./, `SHU-224: ${id} says how a mutation script and a route or Postgres test must work`);
  }
  assert.deepEqual([...contracts["SHU-584"].initial_build_paths], [...contracts["SHU-574"].initial_build_paths, "apps/gateway/src/index.ts"], "SHU-224: SHU-584 keeps SHU-574's paths and adds the gateway entry for the sidebar count");
  assert.ok(!contracts["SHU-584"].initial_build_paths.includes("apps/gateway/src/candidate-documents-http.ts"), "SHU-224: SHU-584 leaves the candidate documents handler alone");
  assert.doesNotMatch(contracts["SHU-584"].acceptance, /\/private-documents\/staff-delivery/, "SHU-224: SHU-584's acceptance never names the unreachable route");
  assert.match(contracts["SHU-584"].acceptance, /REV_ROUTES: [^;]*index\.ts[^;]*synchronous renderWorkspace/, "SHU-224: SHU-584 passes the sidebar count in from the route");
  assert.match(contracts["SHU-584"].acceptance, /GET \/workspace\/civil-ids\/delivery and reached by a real GET through createGatewayServer with no Origin header/, "SHU-224: SHU-584 serves staff images on a reachable route");
  assert.match(contracts["SHU-584"].acceptance, /postgres-civil-id-review\.test\.ts opens a real database/, "SHU-224: SHU-584's Postgres test opens a real database");
  assert.match(contracts["SHU-584"].acceptance, /SHU-584 is SHU-574's contract re-queued under a fresh id [^;]*; SHU-574 never lands\.$/, "SHU-224: SHU-584 says which card it replaces");
  assert.deepEqual([...contracts["SHU-581"].initial_build_paths], [...contracts["SHU-577"].initial_build_paths, "apps/gateway/test/contributions.test.ts", "apps/gateway/src/index.ts"], "SHU-224: SHU-581 keeps SHU-577's paths and adds the PREP_NAV digests");
  assert.match(contracts["SHU-581"].brief, /browserEdit: \{ async notice\(\) \{ return \{\}; \} \}/, "SHU-224: SHU-581 names the route-test fixture");
  assert.match(contracts["SHU-581"].brief, /profileDocument never stamps or changes a field's freshness itself/, "SHU-224: SHU-581 keeps the derived freshness out of the renderer");
  assert.match(contracts["SHU-581"].brief, /Regenerate exactly those 10 expected digests/, "SHU-224: SHU-581 regenerates the PREP_NAV digests and nothing else");
  assert.match(contracts["SHU-581"].brief, /Keep the principal read and readOwn exactly where they are/, "SHU-224: SHU-581 keeps the principal read out of the gatherer");
  assert.match(contracts["SHU-581"].acceptance, /Q14_4_ROUTE: [^;]*real GET \/profile through createGatewayServer[^]*?at least one in Arabic/, "SHU-224: SHU-581 proves the page through the real route");
  assert.match(contracts["SHU-581"].acceptance, /Q14_4_RENDER_PURE: /, "SHU-224: SHU-581 pins the pure renderer");
  assert.match(contracts["SHU-581"].acceptance, /no item links to #field-civilId/, "SHU-224: SHU-581 shows no dead civil ID link");
  assert.match(contracts["SHU-581"].acceptance, /SHU-581 is SHU-577's contract re-queued under a fresh id [^;]*; SHU-577 never lands\.$/, "SHU-224: SHU-581 says which card it replaces");
  // SHU-586 re-cuts SHU-575, which stopped after its revisions ran out on contract gaps.
  assert.equal(after("SHU-586"), undefined, "SHU-224: SHU-586 waits on nothing, since SHU-573 has landed and it shares no file with SHU-579");
  assert.deepEqual([...contracts["SHU-586"].initial_build_paths], [...contracts["SHU-575"].initial_build_paths, "apps/gateway/src/index.ts"], "SHU-224: SHU-586 keeps SHU-575's paths and adds the gateway entry for the one suggestion read");
  for (const path of contracts["SHU-586"].initial_build_paths) assert.ok(!contracts["SHU-579"].initial_build_paths.includes(path), `SHU-224: SHU-586 shares no path with SHU-579 (${path})`);
  assert.doesNotMatch(contracts["SHU-586"].brief, /We are reading your photo/, "SHU-224: SHU-586 drops the reading state the current-suggestion read never returns");
  assert.match(contracts["SHU-586"].brief, /read only in the HTML branch of the GET \/profile handler in apps\/gateway\/src\/index\.ts/, "SHU-224: SHU-586 names the one place the suggestion is read");
  assert.match(contracts["SHU-586"].acceptance, /OCRP_SEAM: [^;]*exactly one read for HTML GET \/profile and zero for JSON GET \/profile, a preview page and the documents page/, "SHU-224: SHU-586 proves the read runs on My profile only");
  assert.match(contracts["SHU-586"].acceptance, /OCRP_E2E: [^;]*runCivilIdOcr from FakeCivilIdOcrReader into InMemoryCivilIdOcrStore shows on a real GET \/profile/, "SHU-224: SHU-586 shows a worker-read suggestion end to end");
  assert.match(contracts["SHU-586"].acceptance, /SHU-586 is SHU-575's contract re-queued under a fresh id [^;]*; SHU-575 never lands\.$/, "SHU-224: SHU-586 says which card it replaces");
  // SHU-588 re-cuts SHU-581, which stopped on a path gap: the principal's email never reached the profile body.
  assert.equal(after("SHU-588"), undefined, "SHU-224: SHU-588 waits on nothing");
  assert.deepEqual([...contracts["SHU-588"].initial_build_paths], [...contracts["SHU-581"].initial_build_paths, "packages/login-contract/src/types.ts", "apps/gateway/src/login-application.ts", "apps/gateway/test/login-application.test.ts", "apps/gateway/src/login-runtime.ts"], "SHU-224: SHU-588 keeps SHU-581's paths and adds the login files that carry the principal's email");
  assert.match(contracts["SHU-588"].brief, /calls authzStore\.getPrincipal\(personId\) and throws the result away/, "SHU-224: SHU-588 reuses the principal read the login already makes");
  assert.match(contracts["SHU-588"].brief, /without it, profile\(\) calls roleFor exactly as today and the body stays \{ personId, role \}/, "SHU-224: SHU-588 keeps the profile body unchanged without the new method");
  assert.match(contracts["SHU-588"].brief, /escapeHtml turns an apostrophe into &#39;/, "SHU-224: SHU-588 says how to find escaped copy in a page");
  assert.match(contracts["SHU-588"].acceptance, /Q14_4_EMAIL: [^;]*renders 'Profile complete'/, "SHU-224: SHU-588 proves 'Profile complete' is reachable");
  assert.match(contracts["SHU-588"].acceptance, /Q14_4_NOWRITE: [^;]*write methods throw/, "SHU-224: SHU-588 proves no write with fakes inside its paths");
  assert.match(contracts["SHU-588"].acceptance, /Q14_4_STATUS's civil ID case fails the gatherer's own civil ID read while readOwn succeeds/, "SHU-224: SHU-588 states which civil ID failure the page survives");
  assert.doesNotMatch(contracts["SHU-588"].acceptance, /real store seams/, "SHU-224: SHU-588 drops the no-write test its paths could not hold");
  assert.match(contracts["SHU-588"].acceptance, /SHU-588 is SHU-581's contract re-queued under a fresh id [^;]*; SHU-581 never lands\.$/, "SHU-224: SHU-588 says which card it replaces");
  // SHU-590 re-cuts SHU-584, which used up its revisions on build faults.
  assert.equal(after("SHU-590"), undefined, "SHU-224: SHU-590 waits on nothing");
  assert.deepEqual([...contracts["SHU-590"].initial_build_paths], [...contracts["SHU-584"].initial_build_paths], "SHU-224: SHU-590 keeps SHU-584's paths");
  assert.match(contracts["SHU-590"].brief, /The rejected branch states reason IS NOT NULL explicitly/, "SHU-224: SHU-590 closes the NULL CHECK gap");
  assert.match(contracts["SHU-590"].brief, /every insert uses a subject and a reviewer that differ/, "SHU-224: SHU-590 exercises each CHECK on its own");
  assert.match(contracts["SHU-590"].brief, /'list a released or decided row', 'clear needs_review without a decision' and 'read the state twice'/, "SHU-224: SHU-590 names the mutants the last script left out");
  assert.match(contracts["SHU-590"].acceptance, /REV_EXACT: a wrong Origin and a cross-site Sec-Fetch-Site are each 403 before the body is read/, "SHU-224: SHU-590 asserts the exact origin refusal");
  assert.match(contracts["SHU-590"].acceptance, /SHU-590 is SHU-584's contract re-queued under a fresh id [^;]*; SHU-584 never lands\.$/, "SHU-224: SHU-590 says which card it replaces");
  // SHU-592 re-cuts SHU-586, which used up its revisions on build faults.
  assert.equal(after("SHU-592"), undefined, "SHU-224: SHU-592 waits on nothing");
  assert.deepEqual([...contracts["SHU-592"].initial_build_paths], [...contracts["SHU-586"].initial_build_paths], "SHU-224: SHU-592 keeps SHU-586's paths");
  assert.doesNotMatch(contracts["SHU-592"].brief, /We are reading your photo/, "SHU-224: SHU-592 keeps the reading state out");
  assert.match(contracts["SHU-592"].brief, /The person id comes from requesterPrincipalId[^\n]*Never read result\.body\?\.personId after readOwn/, "SHU-224: SHU-592 names where the person id comes from");
  assert.match(contracts["SHU-592"].brief, /do not touch section\(\) or row\(\)/, "SHU-224: SHU-592 keeps the other profile rows where they are");
  assert.match(contracts["SHU-592"].brief, /A direct call to handleCivilIdSuggestion or profileDocument never stands in for an acceptance test/, "SHU-224: SHU-592 runs every acceptance test through the server");
  assert.match(contracts["SHU-592"].acceptance, /OCRP_CASES: duplicate number, expired expiry, KW and BH length refusals, double POST with one submission id \(raced and one after the other, both 303\), values already on file \(303 and resolved, then 409 for a retry after it\), replaced photo version/, "SHU-224: SHU-592 lists the cases the last run missed");
  assert.match(contracts["SHU-592"].brief, /CivilIdStore\.submissionRecorded, passed in through wiring\/profile\.ts/, "SHU-224: SHU-592 answers a finished accept's retry with the same 303");
  assert.match(contracts["SHU-592"].brief, /CIV answers nothing_to_save when the read number and expiry are already on file\. On accept that is not a refusal/, "SHU-224: SHU-592 clears a suggestion that matches what is on file");
  assert.match(contracts["SHU-592"].acceptance, /SHU-592 is SHU-586's contract re-queued under a fresh id [^;]*; SHU-586 never lands\.$/, "SHU-224: SHU-592 says which card it replaces");
  // SHU-594 re-cuts SHU-588, which used up its revisions on test faults.
  assert.equal(after("SHU-594"), undefined, "SHU-224: SHU-594 waits on nothing");
  assert.deepEqual([...contracts["SHU-594"].initial_build_paths], [...contracts["SHU-588"].initial_build_paths], "SHU-224: SHU-594 keeps SHU-588's paths");
  assert.match(contracts["SHU-594"].brief, /A test never matches, or refuses, the bare text 'Profile complete'/, "SHU-224: SHU-594 forbids the bare-text match");
  assert.match(contracts["SHU-594"].brief, /assert it as \/<h2>Profile complete<\\\/h2>\//, "SHU-224: SHU-594 anchors the complete state to its heading");
  assert.match(contracts["SHU-594"].brief, /the list is Display name and Phone number, in that order/, "SHU-224: SHU-594 spells out the clear-a-field list");
  assert.match(contracts["SHU-594"].acceptance, /Q14_4_ANCHOR: no test matches or refuses the bare text 'Profile complete'/, "SHU-224: SHU-594 adds the anchor clause");
  assert.match(contracts["SHU-594"].acceptance, /SHU-594 is SHU-588's contract re-queued under a fresh id [^;]*; SHU-588 never lands\.$/, "SHU-224: SHU-594 says which card it replaces");
  // SHU-596 re-cuts SHU-590, which used up its revisions on build and test faults.
  assert.equal(after("SHU-596"), undefined, "SHU-224: SHU-596 waits on nothing");
  assert.deepEqual([...contracts["SHU-596"].initial_build_paths], [...contracts["SHU-590"].initial_build_paths], "SHU-224: SHU-596 keeps SHU-590's paths");
  assert.match(contracts["SHU-596"].brief, /The person id for the Civil ID row's decision comes from requesterPrincipalId[^\n]*Never read result\.body\?\.personId after readOwn/, "SHU-224: SHU-596 names where the person id comes from");
  assert.match(contracts["SHU-596"].brief, /Both mutation scripts [^\n]*write each mutant and run the tests against it/, "SHU-224: SHU-596 asks for mutation scripts that write mutants");
  assert.match(contracts["SHU-596"].brief, /imports PostgresCivilIdReviewStore/, "SHU-224: SHU-596's db test drives the real store");
  assert.match(contracts["SHU-596"].acceptance, /REV_PERSON: the Civil ID row's decision is read with requesterPrincipalId/, "SHU-224: SHU-596 adds the person-id clause");
  assert.match(contracts["SHU-596"].acceptance, /SHU-596 is SHU-590's contract re-queued under a fresh id [^;]*; SHU-590 never lands\.$/, "SHU-224: SHU-596 says which card it replaces");
  // SHU-598 re-cuts SHU-592, which used up its revisions on test faults.
  assert.equal(after("SHU-598"), undefined, "SHU-224: SHU-598 waits on nothing");
  assert.deepEqual([...contracts["SHU-598"].initial_build_paths], [...contracts["SHU-592"].initial_build_paths], "SHU-224: SHU-598 keeps SHU-592's paths");
  assert.doesNotMatch(contracts["SHU-598"].brief, /We are reading your photo/, "SHU-224: SHU-598 keeps the reading state out");
  assert.match(contracts["SHU-598"].brief, /SYNTHETIC_PROFILE_FIXTURES\.unavailable from packages\/profile\/src\/fixtures\.ts/, "SHU-224: SHU-598 measures the counts on the real projection");
  assert.match(contracts["SHU-598"].brief, /CIVIL_ID_MESSAGES\.stale_revision in packages\/profile\/src\/civil-id\.ts/, "SHU-224: SHU-598 names the real 409 message");
  assert.match(contracts["SHU-598"].brief, /no createGatewayServer\(\.\.\., login as never\)/, "SHU-224: SHU-598 forbids the hand-built login");
  assert.match(contracts["SHU-598"].acceptance, /OCRP_REAL: every count, id list and message a test expects comes from the real code/, "SHU-224: SHU-598 adds the real-code clause");
  assert.match(contracts["SHU-598"].acceptance, /SHU-598 is SHU-592's contract re-queued under a fresh id [^;]*; SHU-592 never lands\.$/, "SHU-224: SHU-598 says which card it replaces");
  assert.match(contracts["SHU-598"].brief, /takes its expiry from the test's own Asia\/Kuwait date through the clock port[^\n]*The separate expired-date case stays as it is\./, "SHU-224: SHU-598 derives the not-expired date from the test's clock");
  // SHU-600 re-cuts SHU-596, which used up its revisions on build and test faults.
  assert.equal(after("SHU-600"), undefined, "SHU-224: SHU-600 waits on nothing");
  assert.deepEqual([...contracts["SHU-600"].initial_build_paths], [...contracts["SHU-596"].initial_build_paths, "apps/gateway/src/civil-id-http.ts", "apps/gateway/test/civil-id-http.test.ts"], "SHU-224: SHU-600 keeps SHU-596's paths and adds the Civil ID row and its test");
  assert.match(contracts["SHU-600"].brief, /\n- apps\/gateway\/src\/civil-id-http\.ts\n- apps\/gateway\/test\/civil-id-http\.test\.ts\n\nOut of scope:/, "SHU-224: SHU-600's brief lists its added paths");
  assert.match(contracts["SHU-600"].brief, /seeds principals with \(id\) or \(id, display_name, email\) only/, "SHU-224: SHU-600 seeds principals with its real columns");
  assert.match(contracts["SHU-600"].brief, /Staff delivery reads the photo through the trusted read hydrator/, "SHU-224: SHU-600 loads R2 photos before serving them");
  assert.match(contracts["SHU-600"].brief, /literal label 'staff-delivery-v1'/, "SHU-224: SHU-600 pins the staff label with a positive test");
  assert.match(contracts["SHU-600"].brief, /renderCivilIdRow in apps\/gateway\/src\/civil-id-http\.ts takes the decision[^\n]*PROFILE_COPY/, "SHU-224: SHU-600 renders the decision inside the row from the copy");
  assert.match(contracts["SHU-600"].acceptance, /REV_FAULTS: the db test seeds principals/, "SHU-224: SHU-600 adds the review-faults clause");
  assert.match(contracts["SHU-600"].acceptance, /SHU-600 is SHU-596's contract re-queued under a fresh id [^;]*; SHU-596 never lands\.$/, "SHU-224: SHU-600 says which card it replaces");
  // SHU-600 stopped after six whole-card runs, so the staff civil ID check is
  // split in three and the People directory, the next lane 1 card, in two.
  assert.equal(after("SHU-604"), undefined, "SHU-224: SHU-604 (the review store) waits on nothing");
  assert.equal(after("SHU-605"), undefined, "SHU-224: SHU-605 (the staff image links) waits on nothing: its audit store is a port");
  assert.deepEqual(after("SHU-606"), ["SHU-604", "SHU-605"], "SHU-224: SHU-606 (the pages) waits on the store and the image links it wires");
  assert.deepEqual(after("SHU-607"), ["SHU-604"], "SHU-224: SHU-607 (the directory query) waits on the decisions table its civil ID state reads");
  assert.deepEqual(after("SHU-608"), ["SHU-607"], "SHU-224: SHU-608 (the People page) waits on the query it renders");
  const migrations = fs.readdirSync(join(COORDINATOR_DIR, "../../packages/db/migrations"));
  for (const [id, file] of [["SHU-604", "0219_civil_id_reviews.sql"], ["SHU-607", "0227_people_directory_indexes.sql"]]) {
    assert.ok(contracts[id].initial_build_paths.includes(`packages/db/migrations/${file}`), `SHU-224: ${id} owns ${file}`);
    assert.ok(!migrations.some((name) => name.slice(0, 5) === file.slice(0, 5)), `SHU-224: ${id}'s migration number ${file.slice(0, 4)} is not taken by a landed migration`);
  }
  assert.ok(!contracts["SHU-608"].acceptance.includes("/workspace/people/"), "SHU-224: SHU-608 asks for no link to a Person page no route serves");
  assert.match(contracts["SHU-604"].acceptance, /a released row whose needs_review is still true gives null from stateFor and stays out of listPending/, "SHU-224: SHU-604 keeps released civil IDs out of waiting");
  for (const id of ["SHU-604", "SHU-605", "SHU-606", "SHU-607", "SHU-608"]) {
    const lane = config.card_lanes.find((entry) => entry.id === id);
    assert.deepEqual(lane.initial_build_paths, [...contracts[id].initial_build_paths], `SHU-224: ${id}'s lane matches its contract`);
    assert.deepEqual(lane.revision_paths, [...contracts[id].revision_paths], `SHU-224: ${id}'s revision paths match its contract`);
    assert.match(contracts[id].brief, new RegExp(`^Card ${id}:`), `SHU-224: ${id}'s brief names its own card`);
    assert.match(contracts[id].brief, /A mutation script writes each mutant and runs the tests against it/, `SHU-224: ${id} says a mutation script writes its mutants`);
    assert.match(contracts[id].brief, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nFinish with/, `SHU-224: ${id} keeps the path self-check`);
    const listed = contracts[id].brief.slice(contracts[id].brief.indexOf("\nYour paths"), contracts[id].brief.indexOf("\n\nOut of scope:")).split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    assert.deepEqual(listed, [...contracts[id].initial_build_paths], `SHU-224: ${id}'s brief lists exactly its paths`);
  }
  assert.match(contracts["SHU-604"].brief, /reason !~ '\[\\u0001-\\u001F\\u007F-\\u009F\]'\)\. Write the pattern as a plain '\.\.\.' literal with single backslashes/, "SHU-224: SHU-604 spells out the control-character CHECK as a plain literal");
  assert.match(contracts["SHU-604"].brief, /reason IS NOT NULL AND char_length\(reason\) BETWEEN 1 AND 300/, "SHU-224: SHU-604's rejected branch states reason IS NOT NULL");
  assert.match(contracts["SHU-604"].brief, /INSERT INTO principals\(id\) or \(id, display_name, email\) only/, "SHU-224: SHU-604 seeds principals with their real columns");
  assert.match(contracts["SHU-604"].brief, /PostgresPersonProfileStore\.CivilIdReviewStore/, "SHU-224: SHU-604 attaches its store without a new export");
  assert.match(contracts["SHU-605"].brief, /'staff-delivery-v1' \+ '\\u0000' \+ payload/, "SHU-224: SHU-605 names the staff MAC label");
  assert.match(contracts["SHU-605"].acceptance, /literal label 'staff-delivery-v1'[^;]*accepted/, "SHU-224: SHU-605 pins the label with a positive test");
  assert.match(contracts["SHU-605"].acceptance, /documentReadHydrator before find/, "SHU-224: SHU-605 loads R2 photos before serving them");
  assert.ok(contracts["SHU-605"].initial_build_paths.every((path) => path.startsWith("packages/private-documents/")), "SHU-224: SHU-605 stays inside packages/private-documents");
  assert.match(contracts["SHU-606"].brief, /startRealProfileServer[^\n]*Never build a login application or call createGatewayServer\(\.\.\., login\) by hand outside that helper/, "SHU-224: SHU-606 requires the shared real profile server");
  assert.match(contracts["SHU-606"].brief, /My profile reads the civil ID twice per render[^\n]*do not assert one/, "SHU-224: SHU-606 says the civil ID is read twice per render");
  assert.match(contracts["SHU-606"].acceptance, /sibling files of the compiled module[^;]*swap-module\.mjs/, "SHU-224: SHU-606 mutates sibling files through the swap hook");
  assert.match(contracts["SHU-608"].acceptance, /sibling files of the compiled module[^;]*swap-module\.mjs/, "SHU-224: SHU-608 mutates sibling files through the swap hook");
  assert.ok(!contracts["SHU-606"].initial_build_paths.includes("apps/gateway/src/candidate-documents-http.ts"), "SHU-224: SHU-606 leaves the candidate documents handler alone");
  assert.doesNotMatch(contracts["SHU-581"].brief + contracts["SHU-581"].acceptance, /waits on SHU-576/, "SHU-224: SHU-581 does not wait on the landed rules card");
  // SHU-564 is appended after SHU-563 and waits on nothing.
  assert.equal(after("SHU-564"), undefined, "SHU-224: SHU-564 waits on nothing");
  const lane564 = config.card_lanes.find((entry) => entry.id === "SHU-564");
  assert.deepEqual(lane564.initial_build_paths, [...contracts["SHU-564"].initial_build_paths], "SHU-224: SHU-564's lane matches its contract");
  assert.deepEqual(lane564.revision_paths, [...contracts["SHU-564"].revision_paths], "SHU-224: SHU-564's revision paths match its contract");
  assert.deepEqual([...lane564.initial_build_paths], ["apps/gateway/src/documents-actions-http.ts", "apps/gateway/test/documents-actions-http.test.ts", "apps/gateway/test/documents-actions-mutations.mjs"], "SHU-224: SHU-564 changes only the document actions and their tests");
  assert.match(contracts["SHU-564"].brief, /^Card SHU-564:/, "SHU-224: SHU-564's brief names its own card");
  assert.match(contracts["SHU-564"].brief, /\n- apps\/gateway\/test\/documents-actions-mutations\.mjs\n\nOut of scope:/, "SHU-224: SHU-564's brief lists its paths one per line");
  assert.match(contracts["SHU-564"].brief, /\n- Before you finish, run git status and compare every changed or added file with your paths[^\n]*\n\nFinish with/, "SHU-224: SHU-564 keeps the path self-check last");
  assert.equal(config.max_dispatch, 1, "SHU-224: one card, one slot");
});

test("SHU-224: every step of the committed queue narrows to one armed card that resolveDispatchScope accepts", async () => {
  const { planRun } = await import("../service/card-run.mjs");
  const { narrowQueueScope } = await import("../single-run-activation.mjs");
  const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  const queue = config.dispatch_scope.issue_ids;
  assert.ok(queue.length > 1);
  assert.equal(resolveDispatchScope(config).valid, false, "SHU-224: the queue as committed, with no armed card, scopes nothing");
  const file = (text) => ({ lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }), readFile: () => text });
  for (const id of queue) {
    const record = planRun({ config, revision: "a".repeat(40), now: new Date("2026-11-05T13:30:00.000Z"), cardId: id }).record;
    const narrowed = narrowQueueScope(config, "/isolated/activation", file(JSON.stringify(record)));
    const scope = resolveDispatchScope(narrowed);
    assert.equal(scope.valid, true, `SHU-224: ${id} narrows to a valid scope`);
    assert.deepEqual([...scope.issueIds], [id], `SHU-224: ${id} narrows to itself alone`);
  }
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
