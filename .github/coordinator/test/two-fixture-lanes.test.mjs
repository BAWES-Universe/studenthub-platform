import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { main, resolveAuthorizationRef, resolveDispatchScope, selectNextReservation } from "../reconcile.mjs";
import { initialWorkspaceScope, successorWorkspaceScope, resolveFixtureLane, normalizeReceiptWorkspaceScope, validateFixtureScopePolicy } from "../workspace-scope.mjs";
import { routeSuccessorFromReceipts } from "../review-routing.mjs";
import { prepareAttemptWorkspace } from "../attempt-workspace.mjs";
import { singleRunActivationStatus } from "../single-run-activation.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const ids = ["SHU-140", "SHU-254"];
const ready = ids.map((id) => ({ id, requested_worker: "codex-builder" }));
const secondPaths = ["tools/fixture-2/scan-unawaited.mjs", "tools/fixture-2/test/scan-unawaited.test.mjs"];
const secondTrap = "tools/fixture-2-conformance/scan-unawaited.expectations.mjs";

function receipt(id, phase, paths) {
  return { issue_id: id, attempt_id: "11111111-1111-4111-8111-111111111111", target_sha: "a".repeat(40),
    repo: config.pilot_repo, requested_worker: "codex-builder", workspace_scope: "scoped", scope_phase: phase,
    allowed_paths: paths, scoped_base_sha: "b".repeat(40) };
}

test("TWO_LANES: issue resolution preserves legacy shape and isolates initial and revision paths", () => {
  const first = resolveFixtureLane(config, ids[0]), second = resolveFixtureLane(config, ids[1]);
  assert.deepEqual(second.initial_build_paths, secondPaths, "SHU254_LANE: exact initial paths");
  assert.deepEqual(second.revision_paths, [...secondPaths, secondTrap], "SHU254_LANE: exact revision paths");
  assert.equal(second.seeded_defect_path, secondTrap);
  assert.equal(resolveFixtureLane({ fixture_lane: first }, ids[0]), first);
  assert.equal(resolveFixtureLane({ fixture_lane: first }, ids[1]), null);
  assert.equal(resolveFixtureLane(config, "SHU-999"), null);
  assert.throws(() => resolveFixtureLane({ ...config, fixture_lanes: [first] }, ids[0]), /unique issue ids/);
  for (const lane of [first, second]) {
    assert.equal(validateFixtureScopePolicy(lane).ok, true);
    assert.equal(resolveAuthorizationRef({ id: lane.id }, config), lane.authorization_ref);
    assert.deepEqual(initialWorkspaceScope({ issueId: lane.id, requestedWorker: "codex-builder", fixtureLane: resolveFixtureLane(config, lane.id) }).allowed_paths,
      lane.initial_build_paths, `${lane.id}_LANE: initial scope belongs to issue`);
    assert.deepEqual(successorWorkspaceScope("revise", resolveFixtureLane(config, lane.id)).allowed_paths, lane.revision_paths);
    assert.equal(lane.initial_build_paths.includes(lane.seeded_defect_path), false);
    for (const phase of ["initial", "revision"]) {
      const paths = phase === "initial" ? lane.initial_build_paths : lane.revision_paths;
      assert.equal(normalizeReceiptWorkspaceScope(receipt(lane.id, phase, paths)).ok, true);
    }
  }
  assert.equal(first.revision_paths.some((p) => second.revision_paths.includes(p)), false);
});

test("LANE_MISMATCH: swapped attempt paths are refused before workspace I/O in both phases", () => {
  for (const id of ids) {
    const other = resolveFixtureLane(config, ids.find((v) => v !== id));
    assert.throws(() => initialWorkspaceScope({ issueId: id, requestedWorker: "codex-builder", fixtureLane: other }), /LANE_MISMATCH/);
    for (const phase of ["initial", "revision"]) {
      const wrong = receipt(id, phase, phase === "initial" ? other.initial_build_paths : other.revision_paths);
      assert.equal(normalizeReceiptWorkspaceScope(wrong).ok, false, "LANE_MISMATCH: swapped attempt paths must be refused");
      assert.throws(() => prepareAttemptWorkspace({ receipt: wrong, env: {} }), /LANE_MISMATCH/,
        "LANE_MISMATCH: preparation must refuse before filesystem access");
    }
  }
});

test("TWO_SUCCESSORS: exact-head BLOCK routes each writer to its own revision lane", () => {
  for (const id of ids) {
    const lane = resolveFixtureLane(config, id);
    const build = { ...receipt(id, "initial", lane.initial_build_paths), authorization_ref: lane.authorization_ref,
      worker_identity: "codex-session", branch: `coordinator/${id}`, result_sha: "c".repeat(40), verdict_stage: "BUILD_READY" };
    const review = { ...build, attempt_id: "22222222-2222-4222-8222-222222222222", requested_worker: "claude-verifier",
      worker_identity: "claude-session", target_sha: build.result_sha, result_sha: null, verdict_stage: "BLOCKED", stage: "HOLD",
      workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };
    const input = { issueReceipts: [build, review], terminal: review, evidenceStage: "BLOCKED", authoritativeHead: build.result_sha };
    const routed = routeSuccessorFromReceipts({ ...input, fixtureLane: lane });
    assert.equal(routed.ok, true, routed.reason);
    assert.deepEqual(routed.order.allowed_paths, lane.revision_paths, "TWO_SUCCESSORS: issue owns revision paths");
    const wrong = routeSuccessorFromReceipts({ ...input, fixtureLane: resolveFixtureLane(config, ids.find((v) => v !== id)) });
    assert.equal(wrong.ok, false, "LANE_MISMATCH: successor refuses another issue's lane");
    assert.match(wrong.reason, /LANE_MISMATCH/);
  }
});

test("TWO_SCOPE: committed selection admits exactly SHU-140 and SHU-254", () => {
  assert.deepEqual([...resolveDispatchScope(config).issueIds], ids, "TWO_SCOPE: exact committed issues");
  for (const id of ids) assert.equal(selectNextReservation({ ready: [{ id, requested_worker: "codex-builder" }], config }).candidate?.id, id);
  for (const id of ["SHU-90", "SHU-255", "SHU-0140", "SHU-254-extra"]) {
    assert.equal(selectNextReservation({ ready: [{ id, requested_worker: "codex-builder" }], config }).candidate, null);
  }
  for (const issue_ids of [[], ["SHU-140", "SHU-140"], [...ids, "SHU-90"], ["SHU-254", "SHU-90"]]) {
    assert.equal(resolveDispatchScope({ dispatch_scope: { issue_ids } }).valid, false);
  }
});

test("TWO_CAPACITY: two active receipts fit and a third is refused by capacity", () => {
  assert.equal(config.max_dispatch, 2, "TWO_CAPACITY: committed capacity is two");
  const receipts = [];
  for (const id of ids) {
    const selected = selectNextReservation({ ready, config, receipts });
    assert.equal(selected.candidate?.id, id, "TWO_CAPACITY: both reservations fit");
    receipts.push({ issue_id: id, stage: "RUNNING" });
  }
  // A fresh, in-scope candidate plus two unrelated active receipts proves the
  // refusal is global capacity, not scope, parking, or duplicate-issue rejection.
  const full = selectNextReservation({ ready, config, receipts: receipts.map((r, i) => ({ ...r, issue_id: `SHU-${900 + i}` })) });
  assert.equal(full.candidate, null, "TWO_CAPACITY: third reservation refused");
  assert.match(full.skipped[0].reason, /^max_dispatch=2 reached \(2 active\)$/);
});

test("DISPATCH_DISABLED: two-lane tick has zero launches and zero writes with runtime gate true", async () => {
  assert.equal(config.enable_dispatch, false, "DISPATCH_DISABLED: committed gate stays false");
  let launches = 0, writes = 0;
  const node = (id) => ({ id: `uuid-${id}`, identifier: id, title: id, state: { name: "Todo" }, priorityLabel: "High",
    labels: { nodes: [{ name: "repo:platform" }] }, assignee: null, delegate: null, parent: null, relations: { nodes: [] } });
  const output = [];
  const code = await main([], { ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "synthetic-token" }, {
    fetchDurable: false, openPRsOverride: [], receipts: [], skipActivationPreflight: true,
    fetchImpl: async (_url, options) => {
      const { query } = JSON.parse(options.body);
      if (/\bmutation\b/.test(query)) writes += 1;
      return { ok: true, status: 200, json: async () => ({ data: query.includes("CoordinatorIssues")
        ? { issues: { nodes: ids.map(node), pageInfo: { hasNextPage: false, endCursor: null } } } : {} }) };
    },
    adapterModules: { "codex-cli": { launchBuilder: async () => { launches += 1; return { stage: "RUNNING" }; } } },
    prepareWorkspace: async () => { writes += 1; return { cwd: "/unused" }; },
    stdout: (line) => output.push(line),
  });
  assert.equal(code, 0);
  assert.equal(launches, 0, "DISPATCH_DISABLED: zero launches");
  assert.equal(writes, 0, "DISPATCH_DISABLED: zero writes");
  assert.match(output.join("\n"), /dispatch disabled, no writes/);
  assert.equal(singleRunActivationStatus({ filePath: "/unused", config, io: { readFileSync: () => { throw new Error("must not read activation"); } } }).state, "refused");
});

for (const [name, file, from, to, pattern, message] of [
  ["swapped lane receipt accepted", "workspace-scope.mjs", "if (JSON.stringify(receipt.allowed_paths) !== JSON.stringify(expected)) {", "if (false) {", "^LANE_MISMATCH:", "LANE_MISMATCH: swapped attempt paths must be refused"],
  ["second lane resolves to first", "workspace-scope.mjs", "return lanes.find((lane) => lane.id === issueId) ?? null;", "return lanes[0] ?? null;", "^TWO_LANES:", "SHU254_LANE: exact initial paths"],
  ["scope admits third issue", "config.json", '"SHU-254"\n', '"SHU-254", "SHU-90"\n', "^TWO_SCOPE:", "TWO_SCOPE: exact committed issues"],
  ["capacity ignores active receipts", "reconcile.mjs", "if (active.length >= maxDispatch) {", "if (false) {", "^TWO_CAPACITY:", "TWO_CAPACITY: third reservation refused"],
  ["committed dispatch enabled", "config.json", '"enable_dispatch": false', '"enable_dispatch": true', "^DISPATCH_DISABLED:", "DISPATCH_DISABLED: committed gate stays false"],
]) test(`TWO_LANES MUTATION: ${name}`, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "two-lanes-mutant-"));
  try {
    fs.cpSync(new URL("../", import.meta.url), dir, { recursive: true });
    const target = path.join(dir, file), source = fs.readFileSync(target, "utf8");
    assert.equal(source.split(from).length, 2, `${name}: unique mutation anchor`);
    fs.writeFileSync(target, source.replace(from, to));
    const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/two-fixture-lanes.test.mjs")], { env, encoding: "utf8", timeout: 30000 });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, output);
    assert.match(output, /AssertionError/, output);
    assert.ok(output.includes(message), output);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
