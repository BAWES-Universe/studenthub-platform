// Eligibility resolver tests — every exclusion rule, ordering, never-invent-backlog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computeEligibility, requestedWorkerFor, compareIdentifiers, resolveAuthorizationRef } from "../reconcile.mjs";

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
    repo: "BAWES-Universe/studenthub-platform",
    repoResolutionError: null,
    ...overrides,
  };
}

function eligibleIds(issues, openPRs = []) {
  return computeEligibility({ issues, openPRs, config: CONFIG }).ready.map((i) => i.id);
}

test("numeric Linear fixture id resolves to the dedicated fixture contract before the canonical-card fallback", () => {
  const config = { fixture_lane: { id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" } };
  assert.equal(resolveAuthorizationRef(card({ id: "SHU-140" }), config), "FIXTURE-OPUS-CONTRACT-20260905");
  assert.equal(
    resolveAuthorizationRef(card({ id: "SHU-140", authorization_ref: "SHU-999" }), config),
    "FIXTURE-OPUS-CONTRACT-20260905",
    "fixture card authorization cannot override the configured fixture contract",
  );
});

test("a misconfigured numeric fixture id fails closed instead of falling back to its card id", () => {
  const config = { fixture_lane: { id: "SHU-140", authorization_ref: "not-an-approved-contract" } };
  assert.equal(resolveAuthorizationRef(card({ id: "SHU-140" }), config), null);
  assert.equal(resolveAuthorizationRef(card({ id: "SHU-141" }), config), "SHU-141");
});

test("SHU-222 mutation guard: only Todo is ready; Backlog is parked", () => {
  const { ready, excluded } = computeEligibility({
    issues: [card({ id: "SHU-10", state: "Backlog" }), card({ id: "SHU-11", state: "Todo" })],
    openPRs: [],
    config: CONFIG,
  });
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].reason, /Backlog.*not in \{Todo\}/);
  assert.deepEqual(ready.map((i) => i.id), ["SHU-11"]);
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

test("SHU-222 mutation guard: risk:R2 and risk:R3 require a named verifier", () => {
  for (const riskyCard of [
    card({ id: "SHU-27", priority: "R3" }),
    card({ id: "SHU-28", labels: ["risk:R3"] }),
    card({ id: "SHU-34", labels: ["risk:R2"] }),
  ]) {
    const { excluded } = computeEligibility({ issues: [riskyCard], openPRs: [], config: CONFIG });
    assert.equal(excluded.length, 1);
    assert.match(excluded[0].reason, /R[23] card without a named verifier/);
  }
});

test("eligible: R2/R3 card WITH named verifier label", () => {
  const ids = eligibleIds([
    card({ id: "SHU-29", labels: ["risk:R3", "verifier:opus"] }),
    card({ id: "SHU-35", labels: ["risk:R2", "verifier:codex"] }),
  ]);
  assert.deepEqual(ids, ["SHU-29", "SHU-35"]);
});

test("SHU-222: an implementation cannot be assigned to its named verifier runtime", () => {
  const { ready, excluded } = computeEligibility({
    issues: [card({ id: "SHU-29", labels: ["type:implementation", "risk:R3", "verifier:codex"] })],
    openPRs: [],
    config: CONFIG,
  });
  assert.deepEqual(ready, []);
  assert.match(excluded[0].reason, /authored by its named verifier \(codex\)/);
  const ids = eligibleIds([card({
    id: "SHU-29",
    labels: ["type:implementation", "risk:R3", "verifier:codex", "worker:hermes-box"],
  })]);
  assert.deepEqual(ids, ["SHU-29"]);
});

test("excluded: unknown / inaccessible state — never invent backlog", () => {
  for (const bad of [{ state: null }, { state: undefined }, { state: "" }, { state: "SomeCustomState" }]) {
    const { ready, excluded } = computeEligibility({ issues: [card({ id: "SHU-30", ...bad })], openPRs: [], config: CONFIG });
    assert.deepEqual(ready, [], `state ${JSON.stringify(bad.state)} must not be invented into backlog`);
    assert.equal(excluded[0].id, "SHU-30");
    assert.match(excluded[0].reason, /never invent backlog|not in \{Todo\}/);
  }
});

test("excluded: state not Todo (Backlog, In Progress, Done, Canceled)", () => {
  for (const state of ["Backlog", "In Progress", "Done", "Canceled", "Triage"]) {
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

test("SHU-222 mutation guard: unresolved repository ownership is held", () => {
  for (const repoResolutionError of [
    "missing repo:<name> ownership label",
    "multiple repository ownership labels: repo:platform, repo:legacy",
    "unknown repository ownership label: repo:other",
  ]) {
    const { ready, excluded } = computeEligibility({
      issues: [card({ id: "SHU-36", repo: null, repoResolutionError })],
      openPRs: [],
      config: CONFIG,
    });
    assert.deepEqual(ready, []);
    assert.match(excluded[0].reason, /repository ownership HOLD/);
  }
});

test("SHU-222: unavailable claim evidence is held", () => {
  const { ready, excluded } = computeEligibility({
    issues: [card({ id: "SHU-37", claimEvidenceError: "GitHub lookup failed" })],
    openPRs: [],
    config: CONFIG,
  });
  assert.deepEqual(ready, []);
  assert.match(excluded[0].reason, /claim evidence HOLD/);
});

test("ready sorted by priority then stable identifier tie-breaker", () => {
  const issues = [
    card({ id: "SHU-50", priority: "Low", state: "Todo" }),
    card({ id: "SHU-9", priority: "High", state: "Todo" }),
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
