// Eligibility resolver tests — every exclusion rule, ordering, never-invent-backlog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computeEligibility, requestedWorkerFor, compareIdentifiers } from "../reconcile.mjs";

const CONFIG = { pilot_repo: "BAWES-Universe/studenthub-platform", max_dispatch: 1, adapter_pause_map: {} };

// Minimal valid pickable card (state Todo, no claims, no links).
function card(overrides = {}) {
  return {
    id: "SHU-1",
    title: "t",
    state: "Todo",
    priority: "Medium",
    labels: [],
    assignee: null,
    delegate: null,
    linkedPRs: [],
    parent: null,
    blockers: [],
    ...overrides,
  };
}

function eligibleIds(issues, openPRs = []) {
  return computeEligibility({ issues, openPRs, config: CONFIG }).ready.map((i) => i.id);
}

test("plain Backlog/Todo cards with no claims are ready", () => {
  const { ready, excluded } = computeEligibility({
    issues: [card({ id: "SHU-10", state: "Backlog" }), card({ id: "SHU-11", state: "Todo" })],
    openPRs: [],
    config: CONFIG,
  });
  assert.deepEqual(excluded, []);
  assert.deepEqual(ready.map((i) => i.id), ["SHU-10", "SHU-11"]);
});

test("excluded: delegated card (delegate claim)", () => {
  const { ready, excluded } = computeEligibility({
    issues: [card({ id: "SHU-20", delegate: { name: "gpt-implementer" } })],
    openPRs: [],
    config: CONFIG,
  });
  assert.deepEqual(ready, []);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].id, "SHU-20");
  assert.match(excluded[0].reason, /delegated to gpt-implementer/);
});

test("excluded: needs:decision label", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-21", labels: ["needs:decision"] })],
    openPRs: [],
    config: CONFIG,
  });
  assert.equal(excluded[0].reason, "label needs:decision");
});

test("excluded: parent not Done", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-22", parent: { id: "SHU-1", state: "In Progress" } })],
    openPRs: [],
    config: CONFIG,
  });
  assert.match(excluded[0].reason, /parent SHU-1 not Done/);
});

test("excluded: blocker not Done", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-23", blockers: [{ id: "SHU-2", state: "Todo" }] })],
    openPRs: [],
    config: CONFIG,
  });
  assert.match(excluded[0].reason, /blocked by SHU-2/);
});

test("eligible: parent Done and blockers Done do not exclude", () => {
  const ids = eligibleIds([
    card({ id: "SHU-24", parent: { id: "SHU-1", state: "Done" }, blockers: [{ id: "SHU-2", state: "Done" }] }),
  ]);
  assert.deepEqual(ids, ["SHU-24"]);
});

test("excluded: linked to an open PR (normalized open linkedPR)", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-25", linkedPRs: [{ number: 7, state: "OPEN" }] })],
    openPRs: [],
    config: CONFIG,
  });
  assert.match(excluded[0].reason, /open PR/);
});

test("excluded: linked to an open PR (live openPRs list)", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-26", linkedPRs: [{ number: 9, state: "MERGED" }] })],
    openPRs: [{ number: 9, state: "open" }],
    config: CONFIG,
  });
  assert.match(excluded[0].reason, /open PR/);
});

test("excluded: R3 card without named verifier label", () => {
  for (const r3card of [
    card({ id: "SHU-27", priority: "R3" }),
    card({ id: "SHU-28", labels: ["r3"] }),
  ]) {
    const { excluded } = computeEligibility({ issues: [r3card], openPRs: [], config: CONFIG });
    assert.equal(excluded.length, 1);
    assert.match(excluded[0].reason, /R3 card without a named verifier/);
  }
});

test("eligible: R3 card WITH named verifier label", () => {
  const ids = eligibleIds([card({ id: "SHU-29", priority: "R3", labels: ["verifier:opus"] })]);
  assert.deepEqual(ids, ["SHU-29"]);
});

test("excluded: unknown / inaccessible state — never invent backlog", () => {
  for (const bad of [{ state: null }, { state: undefined }, { state: "" }, { state: "SomeCustomState" }]) {
    const { ready, excluded } = computeEligibility({ issues: [card({ id: "SHU-30", ...bad })], openPRs: [], config: CONFIG });
    assert.deepEqual(ready, [], `state ${JSON.stringify(bad.state)} must not be invented into backlog`);
    assert.equal(excluded[0].id, "SHU-30");
    assert.match(excluded[0].reason, /never invent backlog|not in \{Backlog, Todo\}/);
  }
});

test("excluded: state not in {Backlog,Todo} (In Progress, Done, Canceled)", () => {
  for (const state of ["In Progress", "Done", "Canceled", "Triage"]) {
    const { excluded } = computeEligibility({ issues: [card({ id: "SHU-31", state })], openPRs: [], config: CONFIG });
    assert.match(excluded[0].reason, new RegExp(`state "${state}" not in`));
  }
});

test("excluded: active assignee claim", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-32", assignee: { name: "bob" } })],
    openPRs: [],
    config: CONFIG,
  });
  assert.match(excluded[0].reason, /assigned to bob \(active claim\)/);
});

test("excluded: card naming an out-of-pilot repo", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-33", repo: "BAWES-Universe/somewhere-else" })],
    openPRs: [],
    config: CONFIG,
  });
  assert.match(excluded[0].reason, /outside pilot repo/);
});

test("ready sorted by priority then stable identifier tie-breaker", () => {
  const issues = [
    card({ id: "SHU-50", priority: "Low", state: "Backlog" }),
    card({ id: "SHU-9", priority: "High", state: "Backlog" }),
    card({ id: "SHU-10", priority: "High", state: "Todo" }), // numeric tie-break: SHU-9 < SHU-10
    card({ id: "SHU-51", priority: "Urgent" }),
    card({ id: "SHU-52", priority: "Medium" }),
  ];
  const { ready } = computeEligibility({ issues, openPRs: [], config: CONFIG });
  assert.deepEqual(
    ready.map((i) => i.id),
    ["SHU-51", "SHU-9", "SHU-10", "SHU-52", "SHU-50"], // Urgent, High(SHU-9), High(SHU-10), Medium, Low
  );
  // Determinism: two identical runs produce identical orderings.
  const again = computeEligibility({ issues, openPRs: [], config: CONFIG });
  assert.deepEqual(again.ready, ready);
});

test("compareIdentifiers is numeric-aware and stable", () => {
  assert.ok(compareIdentifiers("SHU-9", "SHU-10") < 0);
  assert.ok(compareIdentifiers("SHU-10", "SHU-9") > 0);
  assert.equal(compareIdentifiers("SHU-9", "SHU-9"), 0);
  assert.ok(compareIdentifiers("SHU-FIXTURE-001", "SHU-9") > 0); // no numeric suffix → string compare
});

test("requestedWorkerFor: explicit worker label wins; default codex-builder", () => {
  assert.equal(requestedWorkerFor(card({ labels: ["worker:claude-verifier"] })), "claude-verifier");
  assert.equal(requestedWorkerFor(card({ labels: ["worker:hermes-box"] })), "hermes-box");
  assert.equal(requestedWorkerFor(card({ labels: ["worker:codex-builder"] })), "codex-builder");
  assert.equal(requestedWorkerFor(card({})), "codex-builder");
  // free-text worker-ish labels never select a family
  assert.equal(requestedWorkerFor(card({ labels: ["worker:someone-else"] })), "codex-builder");
});

test("snapshot fixture: exactly one eligible card, exclusions carry reasons", () => {
  const snap = JSON.parse(
    fs.readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"),
  );
  const { ready, excluded } = computeEligibility({ issues: snap.issues, openPRs: snap.openPRs, config: CONFIG });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, "SHU-FIXTURE-001");
  assert.equal(ready[0].state, "Todo");
  assert.equal(excluded.length, 5);
  const byId = Object.fromEntries(excluded.map((x) => [x.id, x.reason]));
  assert.ok(byId["SHU-201"].includes("In Progress"));
  assert.ok(byId["SHU-202"].includes("assigned to bob"));
  assert.ok(byId["SHU-203"].includes("needs:decision"));
  assert.ok(byId["SHU-204"].includes("open PR"));
  assert.ok(byId["SHU-205"].includes("R3"));
  // Deterministic ordering of excluded by identifier.
  assert.deepEqual(excluded.map((x) => x.id), ["SHU-201", "SHU-202", "SHU-203", "SHU-204", "SHU-205"]);
});
