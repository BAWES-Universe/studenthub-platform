// Eligibility resolver tests — every exclusion rule, ordering, never-invent-backlog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computeEligibility, requestedWorkerFor, compareIdentifiers, resolveAuthorizationRef, SAME_FAMILY_VERIFIERS, WORKER_FAMILIES, repairCardFor, normalizeLinearIssue } from "../reconcile.mjs";
import { repairEligible, readOpenPulls, REPAIR_PULL_PAGE, REPAIR_PULL_MAX_PAGES } from "../repair-eligibility.mjs";

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

test("eligible: child of an In Progress parent with no open blockers is eligible (SHU-219)", () => {
  const ids = eligibleIds([
    card({ id: "SHU-22", parent: { id: "SHU-1", state: "In Progress" } }),
  ]);
  assert.deepEqual(ids, ["SHU-22"]);
});

test("excluded: child of a Canceled parent is excluded (SHU-219)", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-22", parent: { id: "SHU-1", state: "Canceled" } })],
    openPRs: [],
    config: CONFIG,
  });
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].reason, /children of a canceled parent/);
});

test("excluded: child of a Duplicate parent is excluded (SHU-219)", () => {
  const { excluded } = computeEligibility({
    issues: [card({ id: "SHU-22", parent: { id: "SHU-1", state: "Duplicate" } })],
    openPRs: [],
    config: CONFIG,
  });
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].reason, /children of a canceled parent/);
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

test("SHU-223: a claude-verifier implementation cannot name a Claude-family verifier", () => {
  for (const verifier of ["claude", "opus", "sonnet", "haiku", "fable"]) {
    const { ready, excluded } = computeEligibility({
      issues: [card({
        id: "SHU-223",
        labels: ["type:implementation", "risk:R2", `verifier:${verifier}`, "worker:claude-verifier"],
      })],
      openPRs: [],
      config: CONFIG,
    });
    assert.deepEqual(ready, [], `verifier:${verifier} must not review a claude-verifier implementation`);
    assert.equal(excluded.length, 1);
    assert.match(excluded[0].reason, new RegExp(`authored by its named verifier \\(${verifier}\\)`));
  }
});

test("SHU-223: existing Codex and Hermes same-family exclusions still hold", () => {
  const sameFamily = [
    ["codex-builder", "codex"],
    ["codex-builder", "gpt"],
    ["codex-builder", "gpt-6"],
    ["hermes-box", "hermes"],
  ];
  for (const [worker, verifier] of sameFamily) {
    const { ready, excluded } = computeEligibility({
      issues: [card({
        id: "SHU-223",
        labels: ["type:implementation", "risk:R3", `verifier:${verifier}`, `worker:${worker}`],
      })],
      openPRs: [],
      config: CONFIG,
    });
    assert.deepEqual(ready, [], `worker:${worker} must not be reviewed by verifier:${verifier}`);
    assert.match(excluded[0].reason, /authored by its named verifier/);
  }

  // A card with no worker:<family> label is routed to codex-builder, so the
  // Codex exclusion must apply to it without an explicit worker label too.
  const { ready } = computeEligibility({
    issues: [card({ id: "SHU-223", labels: ["type:implementation", "risk:R3", "verifier:codex"] })],
    openPRs: [],
    config: CONFIG,
  });
  assert.deepEqual(ready, []);
});

test("SHU-223: independent cross-family verifiers stay eligible", () => {
  const independent = [
    ["claude-verifier", "codex"],
    ["claude-verifier", "gpt"],
    ["claude-verifier", "hermes"],
    ["codex-builder", "opus"],
    ["codex-builder", "claude"],
    ["codex-builder", "hermes"],
    ["hermes-box", "opus"],
    ["hermes-box", "codex"],
  ];
  for (const [worker, verifier] of independent) {
    const ids = eligibleIds([card({
      id: "SHU-223",
      labels: ["type:implementation", "risk:R3", `verifier:${verifier}`, `worker:${worker}`],
    })]);
    assert.deepEqual(ids, ["SHU-223"], `worker:${worker} + verifier:${verifier} is independent and must stay eligible`);
  }

  // The guard is scoped to implementation cards: a verification card naming its
  // own family is the normal case and must not be excluded by this rule.
  const ids = eligibleIds([card({
    id: "SHU-224",
    labels: ["type:verification", "risk:R3", "verifier:opus", "worker:claude-verifier"],
  })]);
  assert.deepEqual(ids, ["SHU-224"]);
});

test("SHU-223: every recognized worker family declares its same-family verifiers", () => {
  for (const family of WORKER_FAMILIES) {
    const declared = SAME_FAMILY_VERIFIERS[family];
    assert.ok(
      Array.isArray(declared) && declared.length > 0,
      `worker family ${family} has no same-family verifier list — a new family must declare one, never fall through to "independent"`,
    );
  }
  assert.deepEqual(
    Object.keys(SAME_FAMILY_VERIFIERS).sort(),
    [...WORKER_FAMILIES].sort(),
    "SAME_FAMILY_VERIFIERS and WORKER_FAMILIES must describe exactly the same set of worker families",
  );
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

test("snapshot fixture: two eligible cards, exclusions carry reasons (SHU-219 parent rule)", () => {
  const snap = JSON.parse(
    fs.readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"),
  );
  const { ready, excluded } = computeEligibility({ issues: snap.issues, openPRs: snap.openPRs, config: CONFIG });
  assert.equal(ready.length, 2);
  const readyIds = ready.map((x) => x.id).sort();
  assert.deepEqual(readyIds, ["SHU-140", "SHU-206"]);
  assert.equal(excluded.length, 6);
  const byId = Object.fromEntries(excluded.map((x) => [x.id, x.reason]));
  assert.ok(byId["SHU-201"].includes("In Progress"));
  assert.ok(byId["SHU-202"].includes("assigned to bob"));
  assert.ok(byId["SHU-203"].includes("needs:decision"));
  assert.ok(byId["SHU-204"].includes("open PR"));
  assert.ok(byId["SHU-205"].includes("R3"));
  // SHU-207: child of a Canceled parent — excluded by Rule 6.
  assert.ok(byId["SHU-207"].includes("children of a canceled parent"));
  // Deterministic ordering of excluded by identifier.
  assert.deepEqual(excluded.map((x) => x.id), ["SHU-201", "SHU-202", "SHU-203", "SHU-204", "SHU-205", "SHU-207"]);
});

// The snapshot board must stay bound to the LIVE fixture lane: config.json says
// which card is the fixture card, and the fixture card's contract ref must be the
// SEPARATELY APPROVED constant — not whatever config.json happens to say.
//
// Two distinct drift failures, both real:
//   * the lane id stops identifying the fixture card. Resolution then falls to the
//     CANDIDATE's own id, not to the lane id: a numeric id resolves to its own
//     ordinary Linear identifier (an unauthorized contract ref — worse than a
//     refusal), a non-numeric one resolves to null and dispatch refuses loudly.
//     (Sentry HIGH + CodeRabbit Major on PR #64: the lane id had moved to Linear's
//     minted SHU-140 while the snapshot still carried the pre-mint placeholder.)
//   * the lane's contract ref is edited to some other value. Nothing about
//     resolution breaks — the fixture simply runs on an unauthorized contract.
//
// So both the identity AND the contract ref are pinned here. The ref is pinned as
// a literal on purpose: reading it back out of the config under test is exactly
// how a contract edit would go unnoticed (Codex, verification round 2).
const APPROVED_FIXTURE_CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";
const FIXTURE_MARKER_LABELS = ["fixture-safe", "coordinator:pilot"];

test("fixture lane: exactly one card is the fixture card, and only it resolves to the approved fixture contract", () => {
  const snapshot = JSON.parse(
    fs.readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"),
  );
  const realConfig = JSON.parse(
    fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"),
  );
  const lane = realConfig.fixture_lane ?? {};

  assert.ok(lane.id, "config.json must configure a fixture lane id");
  assert.equal(realConfig.enable_dispatch, false, "the fixture lane is a lane, never an activation");
  assert.match(
    String(lane.id),
    /^SHU-[0-9]+$/,
    "the fixture lane id must be the Linear-minted card identifier (SHU-<n>), not a pre-mint placeholder",
  );
  assert.equal(
    lane.authorization_ref,
    APPROVED_FIXTURE_CONTRACT,
    "the fixture lane's contract ref must be the separately approved constant, not an edited value",
  );

  // The fixture card is identified by its id AND its fixture markers. A lane id
  // pointed at some other real card must not pass this test.
  const configured = snapshot.issues.filter((issue) => issue.id === lane.id);
  assert.equal(
    configured.length,
    1,
    `snapshot must contain exactly one card with the configured fixture lane id "${lane.id}" `
      + `(snapshot ids: ${snapshot.issues.map((i) => i.id).join(", ")})`,
  );
  const [fixtureCard] = configured;
  const markerLabels = fixtureCard.labels ?? [];
  assert.ok(
    FIXTURE_MARKER_LABELS.every((label) => markerLabels.includes(label)),
    `the card carrying the configured fixture lane id "${lane.id}" must be the fixture card `
      + `(labels: ${markerLabels.join(", ")})`,
  );

  // Exactly ONE card in the board may be granted the approved contract — that is
  // what stops a misconfigured lane id from handing the contract to a real card.
  const granted = snapshot.issues
    .filter((issue) => resolveAuthorizationRef(issue, realConfig) === APPROVED_FIXTURE_CONTRACT)
    .map((issue) => issue.id);
  assert.deepEqual(
    granted,
    [lane.id],
    "only the fixture card may resolve to the approved fixture contract",
  );

  // The fixture card resolves to the APPROVED CONTRACT, never to its own minted
  // Linear identifier and never to a candidate-supplied value.
  assert.equal(resolveAuthorizationRef(fixtureCard, realConfig), APPROVED_FIXTURE_CONTRACT);
  assert.equal(
    resolveAuthorizationRef({ ...fixtureCard, authorization_ref: "SHU-999" }, realConfig),
    APPROVED_FIXTURE_CONTRACT,
    "a fixture card cannot override its configured contract ref",
  );
});

// ---------------------------------------------------------------------------
// Self-repair B1: the shared repair predicate, and its narrow use in eligibility
// ---------------------------------------------------------------------------

const B1_REPO = CONFIG.pilot_repo;
const B1_OWNER = "48918d3d-f843-483f-bb23-2ba6c7ace499";
const B1_HEAD = "a".repeat(40);
const B1_REPAIR = { repair_pr: 293, initial_target_sha: B1_HEAD };

function b1Pull(over = {}) {
  return { number: 293, state: "open", title: "[SHU-327] organization writes refuse a deleted organization",
    base: { ref: "main", repo: { full_name: B1_REPO } },
    head: { ref: "coordinator/SHU-327", sha: B1_HEAD, repo: { full_name: B1_REPO } }, ...over };
}

function b1Input(over = {}) {
  return {
    issue: card({ id: "SHU-327", state: "In Progress", assignee: { name: "Khalid", id: B1_OWNER }, linkedPRs: [{ number: 293, state: "OPEN" }] }),
    repair: B1_REPAIR, owners: [B1_OWNER], pulls: { complete: true, items: [b1Pull()] }, repo: B1_REPO, ...over,
  };
}

test("Self-repair B1: P1 a repair admits only Todo or In Progress, undelegated, unassigned or owner-assigned by id", () => {
  assert.deepEqual(repairEligible(b1Input()), { ok: true, reason: null });
  assert.equal(repairEligible(b1Input({ issue: { ...b1Input().issue, state: "Todo", assignee: null } })).ok, true);
  for (const state of ["Backlog", "In Review", "Done", "Canceled", null]) {
    assert.match(repairEligible(b1Input({ issue: { ...b1Input().issue, state } })).reason, /is not one of Todo, In Progress/, String(state));
  }
  assert.match(repairEligible(b1Input({ issue: { ...b1Input().issue, delegate: { id: "agent-1" } } })).reason, /delegated/);
  assert.match(repairEligible(b1Input({ issue: { ...b1Input().issue, delegate: { name: "Agent" } } })).reason, /delegated/);
  for (const assignee of [{ name: "Khalid" }, { name: "Khalid", id: "someone-else" }, { id: "" }]) {
    assert.match(repairEligible(b1Input({ issue: { ...b1Input().issue, assignee } })).reason,
      /assigned to someone other than the configured owner \(compared by Linear user id\)/, JSON.stringify(assignee));
  }
  assert.match(repairEligible(b1Input({ owners: [] })).reason, /assigned to someone other/);
  assert.match(repairEligible(b1Input({ owners: undefined })).reason, /assigned to someone other/);
  assert.match(repairEligible(b1Input({ issue: { ...b1Input().issue, assignee: { name: B1_OWNER } } })).reason,
    /assigned to someone other/, "a display name equal to an owner id is still a name");
});

test("Self-repair B1: P2 a repair needs a complete read with exactly one claiming PR, its repair_pr", () => {
  for (const pulls of [undefined, null, { complete: false, items: [b1Pull()] }, { complete: "true", items: [b1Pull()] }, { complete: true }]) {
    assert.match(repairEligible(b1Input({ pulls })).reason, /could not be read completely/, JSON.stringify(pulls));
  }
  assert.match(repairEligible(b1Input({ pulls: { complete: false, items: [], reason: "page cap" } })).reason, /\(page cap\)/);
  assert.match(repairEligible(b1Input({ pulls: { complete: true, items: [] } })).reason, /0 open pull requests claim the card/);
  assert.match(repairEligible(b1Input({ pulls: { complete: true, items: [b1Pull(), b1Pull({ number: 300 })] } })).reason, /2 open pull requests claim the card/);
  assert.match(repairEligible(b1Input({ pulls: { complete: true, items: [b1Pull({ number: 300 })] } })).reason, /is #300, not repair_pr #293/);
});

test("Self-repair B1: P3 the repair PR is this repository's, from coordinator/<card> to main, open, at the bound head", () => {
  const pr = b1Pull();
  const with_ = (over) => repairEligible(b1Input({ pulls: { complete: true, items: [{ ...pr, ...over }] } }));
  assert.match(with_({ base: { ...pr.base, repo: { full_name: "BAWES-Universe/other" } } }).reason, /is not a BAWES-Universe\/studenthub-platform pull request/);
  assert.match(with_({ head: { ...pr.head, repo: { full_name: "fork/studenthub-platform" } } }).reason, /is not a BAWES-Universe\/studenthub-platform pull request/);
  assert.match(repairEligible(b1Input({ repo: undefined })).reason, /is not a <unconfigured> pull request/);
  assert.match(with_({ base: { ...pr.base, ref: "develop" } }).reason, /based on develop, not main/);
  assert.match(with_({ head: { ...pr.head, ref: "coordinator/SHU-328" } }).reason, /from coordinator\/SHU-328, not coordinator\/SHU-327/);
  assert.match(with_({ state: "closed" }).reason, /is closed, not open/);
  assert.match(with_({ head: { ...pr.head, sha: "b".repeat(40) } }).reason, /head is b{40}, not the bound head a{40}/);
  // A later step binds its own head (the revise's output) instead of the passed one.
  assert.equal(repairEligible({ ...b1Input({ pulls: { complete: true, items: [{ ...pr, head: { ...pr.head, sha: "c".repeat(40) } }] } }), head: "c".repeat(40) }).ok, true);
  assert.match(repairEligible(b1Input({ repair: { repair_pr: 293 } })).reason, /repair binding is incomplete/);
  assert.match(repairEligible(b1Input({ repair: { ...B1_REPAIR, repair_pr: "293" } })).reason, /repair binding is incomplete/);
  assert.match(repairEligible(b1Input({ issue: null })).reason, /cannot be read/);
});

test("Self-repair B1: P4 eligibility uses the repair predicate for the bound repair card only", () => {
  const repairCard = { issueId: "SHU-327", repair: B1_REPAIR, owners: [B1_OWNER], repo: B1_REPO, head: B1_HEAD,
    pulls: { complete: true, items: [b1Pull()] } };
  const bound = b1Input().issue;
  const other = card({ id: "SHU-328", state: "In Progress", assignee: { name: "Khalid", id: B1_OWNER }, linkedPRs: [{ number: 294, state: "OPEN" }] });
  const todo = card({ id: "SHU-329" });
  const { ready, excluded } = computeEligibility({ issues: [bound, other, todo], openPRs: [{ number: 293 }, { number: 294 }], config: CONFIG, repairCard });
  assert.deepEqual(ready.map((i) => i.id), ["SHU-327", "SHU-329"]);
  assert.deepEqual(excluded, [{ id: "SHU-328", reason: 'state "In Progress" not in {Todo}' }], "every other card keeps today's rules");
  // Without the repair, the bound card is judged as before.
  assert.deepEqual(computeEligibility({ issues: [bound], openPRs: [{ number: 293 }], config: CONFIG }).excluded,
    [{ id: "SHU-327", reason: 'state "In Progress" not in {Todo}' }]);
  const todoBound = { ...bound, state: "Todo" };
  assert.deepEqual(computeEligibility({ issues: [todoBound], openPRs: [{ number: 293 }], config: CONFIG }).excluded,
    [{ id: "SHU-327", reason: "assigned to Khalid (active claim)" }]);
  // A refusal is named, and the later rules still apply to the bound card.
  const refusedRepair = computeEligibility({ issues: [bound], openPRs: [], config: CONFIG, repairCard: { ...repairCard, pulls: { complete: false, items: [] } } });
  assert.match(refusedRepair.excluded[0].reason, /^landing repair — the open pull requests claiming the card could not be read completely/);
  const blocked = computeEligibility({ issues: [{ ...bound, blockers: [{ id: "SHU-1", state: "Todo" }] }], openPRs: [], config: CONFIG, repairCard });
  assert.match(blocked.excluded[0].reason, /blocked by SHU-1/);
  const foreignRepo = computeEligibility({ issues: [{ ...bound, repo: "BAWES-Universe/other" }], openPRs: [], config: CONFIG, repairCard });
  assert.match(foreignRepo.excluded[0].reason, /outside pilot repo/);
});

test("Self-repair B1: P5 the board keeps assignee and delegate ids, and the repair card reads every PR page", async () => {
  const node = { identifier: "SHU-327", id: "lin-1", title: "t", state: { name: "In Progress" }, labels: { nodes: [{ name: "repo:studenthub-platform" }] },
    assignee: { id: B1_OWNER, displayName: "Khalid" }, delegate: { id: "agent-1" } };
  const issue = normalizeLinearIssue(node);
  assert.deepEqual(issue.assignee, { name: "Khalid", id: B1_OWNER });
  assert.deepEqual(issue.delegate, { id: "agent-1" });
  assert.deepEqual(normalizeLinearIssue({ ...node, assignee: { displayName: "Khalid" }, delegate: null }).assignee, { name: "Khalid" }, "a name-only node is as before");
  assert.equal(normalizeLinearIssue({ ...node, assignee: null }).assignee, null);

  const pages = (counts) => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const n = counts[page - 1] ?? 0;
      const items = Array.from({ length: n }, (_, i) => (page === 2 && i === 0 ? b1Pull() : { number: page * 1000 + i, title: "other", head: { ref: `feature/${i}` } }));
      return { ok: true, status: 200, json: async () => items };
    };
    return { urls, fetchImpl };
  };
  const two = pages([REPAIR_PULL_PAGE, 7]);
  const read = await readOpenPulls({ repo: B1_REPO, token: "t", fetchImpl: two.fetchImpl });
  assert.equal(read.complete, true);
  assert.equal(read.items.length, REPAIR_PULL_PAGE + 7);
  assert.equal(two.urls.length, 2);
  assert.match(two.urls[0], /\/pulls\?state=open&per_page=100&page=1$/);
  const capped = pages(Array(REPAIR_PULL_MAX_PAGES + 1).fill(REPAIR_PULL_PAGE));
  const full = await readOpenPulls({ repo: B1_REPO, token: "t", fetchImpl: capped.fetchImpl });
  assert.equal(full.complete, false, "a read that stops at its page cap is incomplete");
  assert.match(full.reason, /page cap/);
  assert.equal(capped.urls.length, REPAIR_PULL_MAX_PAGES);
  assert.equal((await readOpenPulls({ repo: B1_REPO, token: "", fetchImpl: two.fetchImpl })).complete, false);
  assert.equal((await readOpenPulls({ repo: B1_REPO, token: "t", fetchImpl: async () => ({ ok: false, status: 502 }) })).complete, false);
  assert.equal((await readOpenPulls({ repo: B1_REPO, token: "t", fetchImpl: async () => { throw new TypeError("fetch failed"); } })).complete, false);
  assert.equal((await readOpenPulls({ repo: B1_REPO, token: "t", fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })).complete, false);

  const armed = { state: "armed", landing_repair: true, target_issue_id: "SHU-327", initial_target_sha: B1_HEAD, writer_lane: "codex-builder",
    reviewer_lane: "claude-verifier", repair_pr: 293, repair_of: "card-SHU-327-passed-0001", repair_findings: {}, repair_evidence_digest: "0".repeat(64), max_rounds: 1 };
  const config = { ...CONFIG, linear_callback_actor_ids: [B1_OWNER] };
  const built = await repairCardFor(armed, { config, githubToken: "t", fetchImpl: pages([REPAIR_PULL_PAGE, 7]).fetchImpl });
  assert.equal(built.issueId, "SHU-327");
  assert.equal(built.head, B1_HEAD);
  assert.deepEqual(built.owners, [B1_OWNER]);
  assert.equal(built.pulls.complete, true);
  assert.deepEqual(built.pulls.items.map((pr) => pr.number), [293], "only the pull requests claiming the card are kept");
  assert.equal(built.repair.repair_pr, 293);
  assert.equal((await repairCardFor({ ...armed, successor: { target_sha: "c".repeat(40) } }, { config, githubToken: "t", fetchImpl: two.fetchImpl })).head, "c".repeat(40));
  assert.equal((await repairCardFor(armed, { config, githubToken: "" })).pulls.complete, false);
  for (const activation of [null, { ...armed, state: "refused" }, { ...armed, landing_repair: undefined }]) {
    assert.equal(await repairCardFor(activation, { config, githubToken: "t", fetchImpl: () => assert.fail("no read without a repair") }), null);
  }
});
