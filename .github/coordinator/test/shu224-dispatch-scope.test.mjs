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
  dispatch_scope_mode: "bounded",
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
  assert.deepEqual(config.dispatch_scope.issue_ids, ["SHU-548", "SHU-555", "SHU-549", "SHU-550", "SHU-551", "SHU-552", "SHU-553"], "SHU-224: the scope names the current card queue (SHU-312): the second re-cut of the stopped upload card, the cards that wait on it and the re-cut area card, with every stopped and landed card left out");
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
