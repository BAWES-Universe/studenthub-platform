// SHU-63 — single-run activation: bindings, fail-closed matrix, and mutations.
//
// The committed `enable_dispatch: false` and its existing assertions are NOT
// weakened by this mechanism: an activation substitutes for the COMMITTED flag for
// one bounded run and never for the runtime ENABLE_DISPATCH switch. Every test here
// asserts a refusal as hard as it asserts an arm, because a mechanism whose only
// observable behaviour is "sometimes allows dispatch" is indistinguishable from a
// hole.
//
// The target and contract values are READ FROM the committed config rather than
// hardcoded, so this suite follows the configuration instead of pinning a second,
// silently-diverging copy of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACTIVATION_ID_RE,
  MAX_ACTIVATION_WINDOW_MS,
  SINGLE_RUN_ACTIVATION_KEYS,
  parseActivationArgs,
  renderActivationLine,
  singleRunActivationStatus,
  validateActivationRecord,
  activationAllowsTarget,
  coherentTerminal,
  episodeVerdict,
} from "../single-run-activation.mjs";
import { routeSuccessorFromReceipts } from "../review-routing.mjs";
import {
  dispatchEnabledFor,
  main,
  terminalVerdictCoherent,
  createReceipt,
  parseReceiptsFromComments,
  receiptCommentBody,
} from "../reconcile.mjs";

const COORDINATOR_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_PATH = join(COORDINATOR_DIR, "config.json");
const COMMITTED = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const TARGET = COMMITTED.dispatch_scope.issue_ids[0];
const CONTRACT = COMMITTED.fixture_lane.authorization_ref;
const OTHER_ISSUE = "SHU-999";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER_REVISION = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = new Date("2026-09-10T12:00:00.000Z");

function makeFile(content, mode = 0o600) {
  const dir = fs.mkdtempSync(join(tmpdir(), "shu63-activation-"));
  const file = join(dir, "activation.json");
  if (content !== null) {
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    fs.chmodSync(file, mode);
  }
  return { dir, file };
}

function record(over = {}) {
  return {
    activation_id: "shu63-fixture-run-0001",
    target_issue_id: TARGET,
    authorization_ref: CONTRACT,
    coordinator_revision: REVISION,
    slots: 1,
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

// Compute a status for a record written to a real file, then clean up.
function statusOf(over = {}, opts = {}) {
  const { dir, file } = makeFile(record(over), opts.mode ?? 0o600);
  try {
    return singleRunActivationStatus({
      filePath: file,
      config: opts.config ?? COMMITTED,
      receipts: opts.receipts ?? [],
      now: opts.now ?? NOW,
      // "gitHead" in opts, not ?? — an explicit null must stay null so the
      // unresolvable-revision case is actually exercised.
      gitHead: "gitHead" in opts ? opts.gitHead : REVISION,
      io: opts.io,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The runtime switch, as the operator sets it for the run window.
const SWITCH_ON = { ENABLE_DISPATCH: "true" };
const NO_SWITCH = {};

// A durable receipt in the shape the coordinator itself writes. Used both to
// exercise the episode rule directly and to seed history for the multi-tick walk.
function mkReceipt({
  issue_id = TARGET,
  attempt_id,
  requested_worker = "codex-builder",
  stage = "COMPLETED",
  verdict_stage = null,
  worker_identity = "session-1",
  last_activity = null,
}) {
  // createReceipt is a validated factory returning {ok, receipt|errors}.
  const created = createReceipt({
    issue_id,
    authorization_ref: CONTRACT,
    requested_worker,
    repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${issue_id}`,
    target_sha: REVISION,
    attempt_id: attemptIdFor(attempt_id),
  });
  if (!created.ok) throw new Error(`fixture receipt rejected: ${created.errors.join("; ")}`);
  const receipt = {
    ...created.receipt,
    stage,
    worker_identity,
    external_run_id: stage === "RESERVED" ? null : `codexrun_${attempt_id}`,
    adapter_status: stage === "RESERVED" ? null : stage === "FAILED" ? "failed" : "completed",
    // COMPLETED/HOLD require validated evidence links in the receipt contract.
    evidence_links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/1"],
    timestamps: {
      reserved: "2026-09-10T11:00:00.000Z",
      launch: stage === "RESERVED" ? null : "2026-09-10T11:00:05.000Z",
      heartbeat: null,
      terminal: stage === "RESERVED" || stage === "RUNNING" ? null : "2026-09-10T11:05:00.000Z",
    },
    last_activity: last_activity ?? `2026-09-10T11:${String(attemptOrder(attempt_id)).padStart(2, "0")}:00.000Z`,
  };
  if (verdict_stage) receipt.verdict_stage = verdict_stage;
  return receipt;
}

// Deterministic, ordered last_activity for the seeded steps: the episode rule
// takes the NEWEST verdict-bearing terminal, so the fixtures must be ordered.
const STEP_ORDER = new Map();
function attemptOrder(attempt_id) {
  if (!STEP_ORDER.has(attempt_id)) STEP_ORDER.set(attempt_id, STEP_ORDER.size);
  return STEP_ORDER.get(attempt_id);
}

// The receipt contract requires a UUID attempt id; tests want to name steps. Map
// each label to a stable, schema-valid UUID (and reuse the same map for the ORDER
// above, so a step's ordering and its id stay in step).
const ATTEMPT_IDS = new Map();
function attemptIdFor(label) {
  if (!ATTEMPT_IDS.has(label)) {
    const n = ATTEMPT_IDS.size + 1;
    ATTEMPT_IDS.set(label, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  }
  return ATTEMPT_IDS.get(label);
}

// Convenience: an activation status over a receipt list.
const statusWith = (receipts) => statusOf({}, { receipts });

// ---------------------------------------------------------------------------
// The default path is untouched
// ---------------------------------------------------------------------------

test("SHU-63 activation ABSENT: the committed gates decide exactly as before", () => {
  // The 5-combination truth table, re-asserted with the new third argument present
  // in the signature: behaviour when no activation is supplied must not drift.
  const cfgF = { enable_dispatch: false, max_dispatch: 1 };
  const cfgT = { enable_dispatch: true, max_dispatch: 1 };
  const combos = [
    ["config:false env:unset", cfgF, {}, false],
    ["config:false env:true", cfgF, SWITCH_ON, false],
    ["config:true env:unset", cfgT, {}, false],
    ["config:true env:false", cfgT, { ENABLE_DISPATCH: "false" }, false],
    ["config:true env:true", cfgT, SWITCH_ON, true],
  ];
  for (const [label, config, env, expected] of combos) {
    assert.equal(dispatchEnabledFor(env, config), expected, `${label} (no activation)`);
    // ...and identically when an activation object exists but is not armed.
    assert.equal(dispatchEnabledFor(env, config, { state: "absent" }), expected, `${label} (activation absent)`);
    assert.equal(dispatchEnabledFor(env, config, { state: "refused", reason: "x" }), expected, `${label} (activation refused)`);
  }
  assert.equal(
    singleRunActivationStatus({ filePath: null, config: COMMITTED }).state,
    "absent",
    "no --activation means the mechanism is not in play at all",
  );
  assert.equal(renderActivationLine({ state: "absent" }), "activation=absent (committed gates only)");
});

test("SHU-63 activation: the committed config still carries enable_dispatch: false", () => {
  // The mechanism exists precisely so this stays true. If a future change flips it,
  // this assertion and the two pre-existing ones fail together — which is the point.
  assert.equal(COMMITTED.enable_dispatch, false);
});

test("SHU-63 activation ARMED: arms one run, and still requires the runtime switch", () => {
  const status = statusOf();
  assert.equal(status.state, "armed", status.reason ?? "");
  assert.equal(status.target_issue_id, TARGET);
  assert.equal(status.slots, 1);

  // Armed + runtime switch, with the committed flag false: dispatch runs.
  assert.equal(dispatchEnabledFor(SWITCH_ON, COMMITTED, status), true, "armed activation opens the committed gate for this run");
  // Armed WITHOUT the runtime switch: still closed. A forgotten activation file on
  // disk cannot arm anything by itself.
  assert.equal(dispatchEnabledFor(NO_SWITCH, COMMITTED, status), false, "the runtime switch is still required");
  assert.match(renderActivationLine(status), /^activation=ARMED /);
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

test("SHU-63 activation argv: absent, accepted, and refused shapes", () => {
  assert.deepEqual(parseActivationArgs([]), { path: null, error: null });
  assert.deepEqual(parseActivationArgs(["--activation", "/tmp/a.json"]), { path: "/tmp/a.json", error: null });
  assert.deepEqual(parseActivationArgs(["--activation=/tmp/a.json"]), { path: "/tmp/a.json", error: null });
  // A typo must not silently run with a weaker configuration than the operator asked for.
  assert.match(parseActivationArgs(["--activation"]).error, /requires a file path/);
  assert.match(parseActivationArgs(["--activation="]).error, /requires a file path/);
  assert.match(parseActivationArgs(["--activation", "--force"]).error, /requires a file path/);
  assert.match(parseActivationArgs(["--activation", "/a", "--activation", "/b"]).error, /more than once/);
  assert.match(parseActivationArgs(["--dry-run"]).error, /unexpected argument/);
  assert.match(parseActivationArgs(["--activation", "/a", "extra"]).error, /unexpected argument/);
});

// ---------------------------------------------------------------------------
// Every binding fails closed
// ---------------------------------------------------------------------------

test("SHU-63 activation: missing, malformed, stale, replayed, wrong-target, wrong-revision all fail closed", () => {
  const cases = [
    ["file missing", () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "shu63-missing-"));
      try {
        return singleRunActivationStatus({ filePath: join(dir, "nope.json"), config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["path is a directory", () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "shu63-dir-"));
      try {
        return singleRunActivationStatus({ filePath: dir, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["path is a symlink", () => {
      const { dir, file } = makeFile(record());
      const link = join(dir, "link.json");
      fs.symlinkSync(file, link);
      try {
        return singleRunActivationStatus({ filePath: link, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["group/world readable (0644)", () => statusOf({}, { mode: 0o644 })],
    ["world readable (0604)", () => statusOf({}, { mode: 0o604 })],
    ["group writable (0660)", () => statusOf({}, { mode: 0o660 })],
    ["not JSON", () => {
      const { dir, file } = makeFile("this is not json {");
      try {
        return singleRunActivationStatus({ filePath: file, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["JSON array, not object", () => {
      const { dir, file } = makeFile([record()]);
      try {
        return singleRunActivationStatus({ filePath: file, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["missing key", () => statusOf({ slots: undefined })],
    ["unreviewed extra key", () => statusOf({ force: true })],
    ["bad activation_id", () => statusOf({ activation_id: "short" })],
    ["non-canonical target", () => statusOf({ target_issue_id: "SHU-FIXTURE-001" })],
    ["bad authorization_ref", () => statusOf({ authorization_ref: "free text approval" })],
    ["wrong contract ref", () => statusOf({ authorization_ref: "FIXTURE-SOME-OTHER-CONTRACT" })],
    ["bad revision shape", () => statusOf({ coordinator_revision: "HEAD" })],
    ["wrong revision", () => statusOf({}, { gitHead: OTHER_REVISION })],
    ["revision unresolvable", () => statusOf({}, { gitHead: null, io: { revisionResolver: () => null } })],
    ["wrong target", () => statusOf({ target_issue_id: OTHER_ISSUE })],
    ["slots 2", () => statusOf({ slots: 2 })],
    ["slots 0", () => statusOf({ slots: 0 })],
    ["slots 1 but committed cap 2", () => statusOf({}, { config: { ...COMMITTED, max_dispatch: 2 } })],
    ["expired", () => statusOf({ expires_at: new Date(NOW.getTime() - 1000).toISOString() })],
    ["expiry beyond the reviewed window", () => statusOf({ expires_at: new Date(NOW.getTime() + MAX_ACTIVATION_WINDOW_MS + 60000).toISOString() })],
    ["not a timestamp", () => statusOf({ expires_at: "tomorrow" })],
    ["board-wide config (no scope)", () => statusOf({}, { config: { ...COMMITTED, dispatch_scope: undefined } })],
    ["scope of two issues", () => statusOf({}, { config: { ...COMMITTED, dispatch_scope: { issue_ids: [TARGET, OTHER_ISSUE] } } })],
    ["fixture lane inconsistent with scope", () => statusOf({}, { config: { ...COMMITTED, fixture_lane: { id: OTHER_ISSUE, authorization_ref: CONTRACT } } })],
    ["episode ended (PASS verdict)", () => statusWith([
      mkReceipt({ attempt_id: "step-pass", requested_worker: "claude-verifier", stage: "COMPLETED", verdict_stage: "PASS" }),
    ])],
    ["episode ended (retryable failures exhausted)", () => statusWith([
      mkReceipt({ attempt_id: "fail-1", stage: "FAILED" }),
      mkReceipt({ attempt_id: "fail-2", stage: "FAILED" }),
      mkReceipt({ attempt_id: "fail-3", stage: "FAILED" }),
    ])],
  ];

  for (const [label, run] of cases) {
    const status = run();
    assert.equal(status.state, "refused", `${label}: must refuse (got ${status.state})`);
    assert.equal(status.valid, false, `${label}: must be invalid`);
    assert.ok(status.reason && status.reason.length > 0, `${label}: must name a reason`);
    // The refusal must be total: no configuration of the two existing gates may
    // turn a refused activation into an armed run.
    for (const config of [{ ...COMMITTED, enable_dispatch: false }, { ...COMMITTED, enable_dispatch: true }]) {
      assert.equal(dispatchEnabledFor(SWITCH_ON, config, status), config.enable_dispatch === true,
        `${label}: a refused activation must never arm dispatch by itself`);
    }
    assert.match(renderActivationLine(status), /^activation=REFUSED \(/);
  }
});

test("SHU-63 activation: the loop's OWN verdict stages do not spend it (review BLOCK #1)", () => {
  // The builder's success persists as COMPLETED and the reviewer's rejection as
  // HOLD — these ARE the loop's mid-episode stages (terminalVerdictCoherent:
  // BUILD_READY/REVISION_READY -> COMPLETED, BLOCKED -> HOLD). Spending the
  // authorization on either one makes the next step undispatachable and every
  // following tick hard-refuses instead of continuing the loop. That is the defect
  // Opus blocked; it is pinned here so it cannot return.
  assert.equal(
    statusWith([mkReceipt({ attempt_id: "b1", stage: "COMPLETED", verdict_stage: "BUILD_READY" })]).state,
    "armed",
    "the review step cannot be dispatched: the builder's own COMPLETED receipt already spent the activation",
  );
  assert.equal(
    statusWith([
      mkReceipt({ attempt_id: "b1", stage: "COMPLETED", verdict_stage: "BUILD_READY" }),
      mkReceipt({ attempt_id: "b2", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED" }),
    ]).state,
    "armed",
    "a routable BLOCKED schedules the revision under the SAME authorization",
  );
  assert.equal(
    statusWith([
      mkReceipt({ attempt_id: "b1", stage: "COMPLETED", verdict_stage: "BUILD_READY" }),
      mkReceipt({ attempt_id: "b2", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED" }),
      mkReceipt({ attempt_id: "b3", stage: "COMPLETED", verdict_stage: "REVISION_READY" }),
    ]).state,
    "armed",
    "the re-review after a revision stays inside the same episode",
  );
  // A terminal carrying no verdict at all is mid-flight, not an ending.
  assert.equal(statusWith([mkReceipt({ attempt_id: "n1", stage: "COMPLETED" })]).state, "armed");
  // Retryable run failures stay inside the episode below the cap...
  assert.equal(statusWith([mkReceipt({ attempt_id: "f1", stage: "FAILED" })]).state, "armed");
  assert.equal(
    statusWith([mkReceipt({ attempt_id: "f1", stage: "FAILED" }), mkReceipt({ attempt_id: "f2", stage: "FAILED" })]).state,
    "armed",
  );
  // ...and another issue's terminal verdict never touches this binding.
  assert.equal(
    statusWith([
      mkReceipt({ issue_id: OTHER_ISSUE, attempt_id: "o1", requested_worker: "claude-verifier", stage: "COMPLETED", verdict_stage: "PASS" }),
    ]).state,
    "armed",
  );
});

test("SHU-63 activation: the episode ENDS on PASS, exhausted attempts, or a verdict the routing cannot continue", () => {
  const pass = statusWith([
    mkReceipt({ attempt_id: "p1", requested_worker: "claude-verifier", stage: "COMPLETED", verdict_stage: "PASS" }),
  ]);
  assert.equal(pass.state, "refused");
  assert.match(pass.reason, /the episode for .* ended/);
  assert.match(pass.reason, /PASS/);

  const exhausted = statusWith([
    mkReceipt({ attempt_id: "x1", stage: "FAILED" }),
    mkReceipt({ attempt_id: "x2", stage: "FAILED" }),
    mkReceipt({ attempt_id: "x3", stage: "FAILED" }),
  ]);
  assert.equal(exhausted.state, "refused", "an exhausted episode is over");
  assert.match(exhausted.reason, /retryable failures exhausted/);

  // A verdict from the wrong lane is a contradiction in the durable facts, not an
  // availability gap: a builder lane cannot carry a review PASS.
  const wrongLane = statusWith([
    mkReceipt({ attempt_id: "w1", requested_worker: "hermes-box", stage: "COMPLETED", verdict_stage: "PASS" }),
  ]);
  assert.equal(wrongLane.state, "refused", "a verdict-level contradiction ends the episode rather than staying armed");
  assert.match(wrongLane.reason, /no routable successor/);
});

test("SHU-63 activation: a mid-episode step with a ROUTABLE successor is never spent early", () => {
  // Exercise the routing path this rule delegates to: a writer lineage plus a
  // reviewer BLOCK routes a revise order, so the episode continues.
  const lineage = [
    mkReceipt({ attempt_id: "a1", stage: "COMPLETED", verdict_stage: "BUILD_READY", worker_identity: "builder-session" }),
    mkReceipt({ attempt_id: "a2", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED", worker_identity: "reviewer-session" }),
  ];
  const verdict = episodeVerdict({ receipts: lineage, targetIssueId: TARGET, config: { max_failed_attempts: 3, max_revise: 3 } });
  assert.equal(verdict.ended, false, verdict.reason);
  assert.equal(verdict.successor?.role, "revise", "a routable BLOCKED hands the work back to the writer");
  assert.equal(statusWith(lineage).state, "armed");
});

test("SHU-63 activation: exhaustion is evaluated BEFORE hold, when the routing reports both", () => {
  // `revisions_exhausted` carries BOTH `exhausted: true` AND `hold:
  // "revisions_exhausted"`. The episode ends only because `episodeVerdict` tests
  // `exhausted` before `hold`: if the hold branch were reached first, an exhausted
  // loop would keep the authorization alive forever — and that is precisely the
  // bound that makes the availability-hold asymmetry safe. Nothing pinned this
  // ordering until now (a reorder left the whole suite green), so it is pinned here
  // and bound by the EXHAUST-ORDER mutation.
  const lineage = [
    mkReceipt({ attempt_id: "e1", stage: "COMPLETED", verdict_stage: "BUILD_READY", worker_identity: "builder-1", last_activity: "2026-09-11T01:00:00.000Z" }),
    mkReceipt({ attempt_id: "e2", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED", worker_identity: "reviewer-1", last_activity: "2026-09-11T02:00:00.000Z" }),
    mkReceipt({ attempt_id: "e3", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED", worker_identity: "reviewer-2", last_activity: "2026-09-11T03:00:00.000Z" }),
  ];
  const config = { ...COMMITTED, max_revise: 1, max_failed_attempts: 3 };
  // Both flags, straight from the production router.
  const routed = routeSuccessorFromReceipts({
    issueReceipts: lineage,
    terminal: lineage[2],
    evidenceStage: "BLOCKED",
    evidenceResultSha: null,
    max_revise: 1,
    authoritativeHead: null,
  });
  assert.equal(routed.exhausted, true, "the router reports exhaustion");
  assert.equal(routed.hold, "revisions_exhausted", "and reports a hold at the same time — both flags are present");
  // With both present, exhaustion wins: the episode ENDS rather than continuing on
  // the hold branch.
  const verdict = episodeVerdict({ receipts: lineage, targetIssueId: TARGET, config });
  assert.equal(verdict.ended, true, `exhaustion must win over hold: ${verdict.reason}`);
  assert.match(verdict.reason, /exhaust/);
  assert.equal(statusOf({}, { receipts: lineage, config }).state, "refused", "and the authorization is spent");
});

test("SHU-63 activation: an empty reviewer pool keeps the SAME activation alive until availability returns — or expiry", () => {
  // `no_eligible_reviewer`: a successor is DUE, the routing simply cannot name a
  // free actor yet. That is an availability gap, not a verdict — spending the
  // authorization here would kill an in-flight fixture and require a human to mint
  // a fresh one mid-loop.
  const held = [
    mkReceipt({ attempt_id: "r1", stage: "COMPLETED", verdict_stage: "BUILD_READY", worker_identity: "builder-1", last_activity: "2026-09-11T01:00:00.000Z" }),
  ];
  const { dir, file } = makeFile(record());
  try {
    // ONE file, reused across every state below: the point is that the SAME bounded
    // activation stays in force, not that a fresh one can be minted per step.
    const statusOfFile = (receipts, now) => singleRunActivationStatus({
      filePath: file,
      config: COMMITTED,
      receipts,
      now: now ?? NOW,
      gitHead: REVISION,
    });
    const routed = routeSuccessorFromReceipts({
      issueReceipts: held, terminal: held[0], evidenceStage: "BUILD_READY",
      evidenceResultSha: null, max_revise: 3, authoritativeHead: null,
    });
    assert.equal(routed.hold, "no_eligible_reviewer", "the router reports the availability gap");

    const whileHeld = statusOfFile(held);
    assert.equal(whileHeld.state, "armed", "an empty reviewer pool must not spend the authorization");
    assert.match(whileHeld.episode, /hold/);

    // Availability returns: a fresh reviewer session appears in the lineage.
    const available = [
      ...held,
      mkReceipt({ attempt_id: "r2", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED", worker_identity: "reviewer-1", last_activity: "2026-09-11T02:00:00.000Z" }),
    ];
    const afterAvailability = statusOfFile(available);
    assert.equal(afterAvailability.state, "armed", "the same activation is still the one in force");
    assert.equal(afterAvailability.activation_id, whileHeld.activation_id, "and it is literally the same authorization");
    const nowRoutable = routeSuccessorFromReceipts({
      issueReceipts: available, terminal: available[1], evidenceStage: "BLOCKED",
      evidenceResultSha: null, max_revise: 3, authoritativeHead: null,
    });
    assert.ok(nowRoutable.order, "and the successor is routable under it now");

    // Still bounded: past its expiry the same file is refused like any other.
    const afterExpiry = statusOfFile(available, new Date(NOW.getTime() + 2 * 60 * 60 * 1000));
    assert.equal(afterExpiry.state, "refused", "the keep-alive is bounded by the expiry");
    assert.match(afterExpiry.reason, /expired/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SHU-63 activation: no writer to hand the revision to keeps the SAME activation alive until availability returns — or expiry", () => {
  // `no_active_writer`: the reviewer BLOCKed and a revision is DUE, but the lineage
  // names no writer to route it back to. Same class of gap, same rule.
  const held = [
    mkReceipt({ attempt_id: "w1", requested_worker: "claude-verifier", stage: "HOLD", verdict_stage: "BLOCKED", worker_identity: "reviewer-1", last_activity: "2026-09-11T02:00:00.000Z" }),
  ];
  const { dir, file } = makeFile(record());
  try {
    const statusOfFile = (receipts, now) => singleRunActivationStatus({
      filePath: file,
      config: COMMITTED,
      receipts,
      now: now ?? NOW,
      gitHead: REVISION,
    });
    const routed = routeSuccessorFromReceipts({
      issueReceipts: held, terminal: held[0], evidenceStage: "BLOCKED",
      evidenceResultSha: null, max_revise: 3, authoritativeHead: null,
    });
    assert.equal(routed.hold, "no_active_writer", "the router reports the gap, not an ending");

    const whileHeld = statusOfFile(held);
    assert.equal(whileHeld.state, "armed", "a missing writer must not spend the authorization");

    // Availability returns: the writer's earlier attempt is in the lineage, so a
    // revise order can be addressed to it. Its timestamp stays BEFORE the review's,
    // so the BLOCK remains the deciding verdict.
    const available = [
      mkReceipt({ attempt_id: "w0", stage: "COMPLETED", verdict_stage: "BUILD_READY", worker_identity: "builder-1", last_activity: "2026-09-11T01:00:00.000Z" }),
      held[0],
    ];
    const afterAvailability = statusOfFile(available);
    assert.equal(afterAvailability.state, "armed");
    assert.equal(afterAvailability.activation_id, whileHeld.activation_id, "the same authorization carries it");
    const nowRoutable = routeSuccessorFromReceipts({
      issueReceipts: available, terminal: available[1], evidenceStage: "BLOCKED",
      evidenceResultSha: null, max_revise: 3, authoritativeHead: null,
    });
    assert.equal(nowRoutable.order?.role, "revise", "the revision is now routable back to the writer");

    const afterExpiry = statusOfFile(available, new Date(NOW.getTime() + 2 * 60 * 60 * 1000));
    assert.equal(afterExpiry.state, "refused", "and the keep-alive is still bounded by the expiry");
    assert.match(afterExpiry.reason, /expired/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SHU-63 activation: the duplicated coherence predicate agrees with reconcile's", () => {
  // coherentTerminal deliberately duplicates terminalVerdictCoherent to avoid an
  // import cycle. Bind them together across the whole matrix so they cannot drift.
  const verdictStages = ["BUILD_READY", "REVISION_READY", "PASS", "BLOCKED", "FAILED", null, "garbage"];
  const receiptStages = ["COMPLETED", "HOLD", "FAILED", "RUNNING", "RESERVED"];
  for (const verdict_stage of verdictStages) {
    for (const stage of receiptStages) {
      const receipt = { stage, verdict_stage };
      assert.equal(
        coherentTerminal(receipt),
        terminalVerdictCoherent(receipt, verdict_stage),
        `coherence disagreement at ${stage}/${String(verdict_stage)}`,
      );
    }
  }
});

test("SHU-63 activation: the claim-time target check is narrow by construction", () => {
  const armed = statusOf();
  assert.equal(activationAllowsTarget(armed, TARGET), true);
  assert.equal(activationAllowsTarget(armed, OTHER_ISSUE), false);
  // No activation in play: the committed scope is the only boundary, unchanged.
  assert.equal(activationAllowsTarget({ state: "absent" }, OTHER_ISSUE), true);
  assert.equal(activationAllowsTarget(null, OTHER_ISSUE), true);
});

test("SHU-63 activation: the record shape is exactly the reviewed key set", () => {
  assert.equal(validateActivationRecord(record()).ok, true);
  for (const key of SINGLE_RUN_ACTIVATION_KEYS) {
    const missing = { ...record() };
    delete missing[key];
    assert.equal(validateActivationRecord(missing).ok, false, `${key} is required`);
  }
  assert.ok(ACTIVATION_ID_RE.test("shu63-fixture-run-0001"));
  assert.equal(ACTIVATION_ID_RE.test("has spaces"), false);
});

// ---------------------------------------------------------------------------
// Integration: the coordinator process itself
// ---------------------------------------------------------------------------

test("SHU-63 activation: an ABSENT activation leaves the coordinator an inert dry run", async () => {
  const out = [];
  const code = await main([], {}, {
    skipActivationPreflight: true,
    openPRsOverride: [],
    stdout: (s) => out.push(s),
    fetchImpl: async () => {
      throw new Error("no network expected on a disabled dry run");
    },
  });
  const text = out.join("\n");
  assert.equal(code, 0, "a disabled coordinator exits 0");
  assert.match(text, /DRY-RUN \(dispatch disabled, no writes\)/);
  assert.match(text, /activation=absent \(committed gates only\)/);
});

test("SHU-63 activation: the RUNNING revision is what bounds an activation, end to end", async () => {
  // No injected revision: the coordinator resolves its own checkout. The record
  // carries a placeholder revision, so this proves the binding is against the code
  // actually executing rather than against anything the activation declares.
  const { dir, file } = makeFile(record());
  const out = [];
  try {
    const code = await main(["--activation", file], SWITCH_ON, {
      skipActivationPreflight: true,
      openPRsOverride: [],
      stdout: (s) => out.push(s),
      fetchImpl: async () => {
        throw new Error("no network expected when the activation is refused");
      },
    });
    const text = out.join("\n");
    assert.equal(code, 2);
    assert.match(text, /single-run activation REFUSED \(activation is bound to revision 0123456789abcdef/);
    assert.match(text, /but this coordinator is [0-9a-f]{40}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SHU-63 activation: a REFUSED activation exits 2, says why, and writes nothing", async () => {
  const { dir, file } = makeFile(record({ slots: 2 }));
  const out = [];
  try {
    const code = await main(["--activation", file], SWITCH_ON, {
      skipActivationPreflight: true,
      openPRsOverride: [],
      stdout: (s) => out.push(s),
      gitHead: REVISION, // bind to the record so the SLOTS refusal is the one under test
      fetchImpl: async () => {
        throw new Error("no network expected when the activation is refused");
      },
    });
    const text = out.join("\n");
    assert.equal(code, 2, "a refused activation is a refusal, not a quiet dry run");
    assert.match(text, /dispatch: PREVENTED — single-run activation REFUSED/);
    assert.match(text, /requests 2 slots/);
    assert.doesNotMatch(text, /RESERVED|dispatch: .* -> /, "no launch or receipt write may follow a refusal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SHU-63 activation: an invalid flag shape is refused before anything runs", async () => {
  const out = [];
  const code = await main(["--activation"], SWITCH_ON, {
    skipActivationPreflight: true,
    openPRsOverride: [],
    stdout: (s) => out.push(s),
    fetchImpl: async () => {
      throw new Error("no network expected");
    },
  });
  assert.equal(code, 2);
  assert.match(out.join("\n"), /single-run activation REFUSED \(--activation requires a file path\)/);
});

// ---------------------------------------------------------------------------
// End-to-end: ONE authorization across the WHOLE episode
// ---------------------------------------------------------------------------

const TRUSTED_ACTOR = "11111111-2222-4333-8444-555555555555";
const EPISODE_TRIGGER = "agtch_episode_1";

// A persistent Linear store across ticks: issues from a mutable node list, receipt
// comments stored per issue, commentCreate requiring the real UUID (as Linear does).
function episodeStore(issueNodes, commentBodies) {
  return async (url, opts) => {
    const { query } = JSON.parse(opts.body);
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes: issueNodes } });
    if (query.includes("CoordinatorIssueComments")) {
      const issueId = JSON.parse(opts.body).variables.issueId;
      const known = issueNodes.some((n) => n.id === issueId || n.identifier === issueId);
      return respond({ issue: { comments: { nodes: known ? [...commentBodies] : [] } } });
    }
    if (query.includes("commentCreate")) {
      const { issueId, body } = JSON.parse(opts.body).variables;
      if (!issueNodes.some((n) => n.id === issueId)) throw new Error(`non-UUID comment write attempted (${issueId})`);
      commentBodies.push({ body, createdAt: new Date().toISOString() });
      return respond({ commentCreate: { success: true, comment: { id: `c${commentBodies.length}` } } });
    }
    return respond({});
  };
}

// The builder lane transport: counts launches, poll outcome settable by the test.
function episodeAgent() {
  let triggers = 0;
  let poll = { object: "workspace_agent.trigger_run", id: "apirun_episode_1", status: "queued", agent_id: null, error: null };
  const impl = async (url) => {
    if (url.includes("/runs/")) return { status: 200, ok: true, json: async () => ({ ...poll }) };
    triggers += 1;
    return { status: 202, ok: true, json: async () => ({ conversation_url: "https://chatgpt.com/c/episode", agent_trigger_run_id: "apirun_episode_1" }) };
  };
  impl.triggers = () => triggers;
  impl.setPoll = (body) => { poll = { ...poll, ...body }; };
  return impl;
}

const episodeAdapter = (() => {
  let mod = null;
  const load = () => (mod ??= import("../adapters/workspace-agents.mjs"));
  return {
    launchBuilder: async (o) => (await load()).launchBuilder({ ...o, token: "wa-tok", api_trigger_id: EPISODE_TRIGGER }),
    monitorRun: async (o) => (await load()).monitorRun({ ...o, token: "wa-tok", api_trigger_id: EPISODE_TRIGGER }),
  };
})();

// The PRODUCTION configuration shape for the fixture: the committed flag is FALSE,
// the board is scoped to the single target, and the activation supplies the missing
// authorization. If the mechanism is wrong, this is where it shows.
function episodeConfigPath() {
  const dir = fs.mkdtempSync(join(tmpdir(), "shu63-episode-cfg-"));
  const p = join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify({
    pilot_repo: "BAWES-Universe/studenthub-platform",
    team: "SHU",
    max_dispatch: 1,
    enable_dispatch: false,
    adapter_pause_map: {},
    wake_actor_allowlist: ["BAWES"],
    linear_callback_actor_ids: [TRUSTED_ACTOR],
    max_failed_attempts: 3,
    dispatch_scope: { issue_ids: [TARGET] },
    fixture_lane: { id: TARGET, authorization_ref: CONTRACT },
  }));
  return p;
}

function callbackCommentFor(attempt_id, stage) {
  return {
    user: { id: TRUSTED_ACTOR, displayName: "Worker" },
    body: [
      "<!-- coordinator-callback v1 -->",
      "coordinator-callback v1",
      "```json",
      JSON.stringify({
        attempt_id,
        target_sha: REVISION,
        stage,
        links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/1"],
      }),
      "```",
    ].join("\n"),
    createdAt: new Date().toISOString(),
  };
}

test("SHU-63 activation: ONE authorization carries build -> BLOCK -> revision -> re-review -> PASS, then refuses", async () => {
  const issueNodes = [{
    id: "11111111-aaaa-4bbb-8ccc-000000000777",
    identifier: TARGET,
    title: "Activation episode target",
    state: { name: "Todo" },
    priorityLabel: "High",
    labels: { nodes: [{ name: "repo:platform" }] },
    assignee: null,
    delegate: null,
    parent: null,
    relations: { nodes: [] },
  }];
  const comments = [];
  const store = episodeStore(issueNodes, comments);
  const wa = episodeAgent();
  const configPath = episodeConfigPath();
  const { dir, file } = makeFile(record());
  const env = {
    ENABLE_DISPATCH: "true",
    LINEAR_API_TOKEN: "tok",
    GITHUB_TOKEN: "",
    WORKSPACE_AGENT_ACCESS_TOKEN: "wa-tok",
    WORKSPACE_AGENT_TRIGGER_ID: EPISODE_TRIGGER,
    DISPATCH_TARGET_SHA: REVISION,
  };
  // Each tick is a REAL coordinator run over the REAL durable-read branch, with the
  // activation evaluated by production code. The only things the test plays are the
  // worker (its callback comment) and the clock's ordering.
  const tick = async () => {
    const out = [];
    const code = await main(["--activation", file], env, {
      configPath,
      // The activation's expiry is evaluated against this clock. Without it the
      // episode test reads the LIVE wall clock, and since the fixture record expires
      // an hour after NOW, the test was a time bomb that went red at 13:00Z on the
      // day it was written — while the guard it exercises was behaving correctly.
      // Every other test in this file already freezes the clock; this one must too.
      now: () => NOW,
      skipActivationPreflight: true,
      stdout: (s) => out.push(s),
      fetchDurable: true,
      pollRuns: true,
      gitHead: REVISION,
      adapterModules: { "codex-cli": episodeAdapter },
      fetchImpl: async (url, opts) => (url.includes("api.linear.app") ? store(url, opts) : wa(url, opts)),
    });
    const text = out.join("\n");
    return { code, text, armed: /activation=ARMED/.test(text), refused: /single-run activation REFUSED/.test(text) };
  };
  // Fixture times are ordered AFTER whatever the live clock stamps on real receipts.
  const later = (n) => `2026-09-11T0${n}:00:00.000Z`;

  try {
    // (1) The episode begins: the activation alone authorizes the builder launch —
    //     the committed flag is false, so nothing else can be doing it.
    const t0 = await tick();
    assert.equal(t0.refused, false, `tick 0 must not refuse:\n${t0.text}`);
    assert.equal(t0.armed, true, `tick 0 must be ARMED:\n${t0.text}`);
    assert.equal(wa.triggers(), 1, "the activation authorized exactly one builder launch");
    const launched = parseReceiptsFromComments(comments).find((r) => r.requested_worker === "codex-builder");
    assert.ok(launched, "the RESERVED receipt is durable before any launch");

    // (2) builder BUILD_READY -> COMPLETED. The loop's first verdict must NOT spend it.
    comments.push(callbackCommentFor(launched.attempt_id, "BUILD_READY"));
    wa.setPoll({ status: "completed" });
    const t1 = await tick();
    assert.equal(t1.refused, false, `the builder's own COMPLETED spent the authorization:\n${t1.text}`);
    assert.equal(t1.armed, true, "still ARMED after the builder's terminal receipt");
    const built = parseReceiptsFromComments(comments).find((r) => r.attempt_id === launched.attempt_id);
    assert.equal(built.stage, "COMPLETED", "the lifecycle persisted the builder's terminal state");
    assert.equal(built.verdict_stage, "BUILD_READY");

    // (3) reviewer BLOCKED -> HOLD (the reviewer lane runs in its own lane).
    comments.push({
      body: receiptCommentBody(mkReceipt({
        attempt_id: "episode-review", requested_worker: "claude-verifier", stage: "HOLD",
        verdict_stage: "BLOCKED", worker_identity: "reviewer-session", last_activity: later(1),
      })),
      createdAt: new Date().toISOString(),
    });
    const t2 = await tick();
    assert.equal(t2.refused, false, `a reviewer BLOCK spent the authorization:\n${t2.text}`);
    assert.equal(t2.armed, true, "still ARMED after a reviewer BLOCK");

    // (4) the writer's revision -> REVISION_READY, then the automatic re-review.
    comments.push({
      body: receiptCommentBody(mkReceipt({
        attempt_id: "episode-revision", stage: "COMPLETED", verdict_stage: "REVISION_READY",
        worker_identity: "builder-session", last_activity: later(2),
      })),
      createdAt: new Date().toISOString(),
    });
    const t3 = await tick();
    assert.equal(t3.refused, false, `the revision spent the authorization:\n${t3.text}`);
    assert.equal(t3.armed, true, "still ARMED after the revision");

    // (5) re-review PASS -> the episode is over. NOW it is spent, and it stays spent.
    comments.push({
      body: receiptCommentBody(mkReceipt({
        attempt_id: "episode-rereview", requested_worker: "claude-verifier", stage: "COMPLETED",
        verdict_stage: "PASS", worker_identity: "reviewer-session-2", last_activity: later(3),
      })),
      createdAt: new Date().toISOString(),
    });
    const t4 = await tick();
    assert.equal(t4.refused, true, `PASS must spend the authorization:\n${t4.text}`);
    assert.equal(t4.code, 2, "a spent authorization refuses loudly, it does not quietly do nothing");
    assert.match(t4.text, /activation is spent: the episode for .* ended/);
    assert.match(t4.text, /PASS/);
    const triggersAtEnd = wa.triggers();
    assert.equal(triggersAtEnd, 1, "no further dispatch is authorized once the episode has ended");

    // (6) ...and it cannot run again: a plain re-run is refused identically.
    const t5 = await tick();
    assert.equal(t5.refused, true, "the same authorization cannot start a second run");
    assert.equal(wa.triggers(), triggersAtEnd, "and it launches nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MUTATIONS — every guard above must be load-bearing
// ---------------------------------------------------------------------------

const MUTATION_PRELUDE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mod from MODULE_URL;
const COMMITTED = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const TARGET = COMMITTED.dispatch_scope.issue_ids[0];
const CONTRACT = COMMITTED.fixture_lane.authorization_ref;
const REV = ${JSON.stringify(REVISION)};
const NOW = new Date("2026-09-10T12:00:00.000Z");
function rec(over = {}) {
  return { activation_id: "shu63-fixture-run-0001", target_issue_id: TARGET, authorization_ref: CONTRACT,
           coordinator_revision: REV, slots: 1,
           expires_at: new Date(NOW.getTime() + 3600000).toISOString(), ...over };
}
function withFile(r, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shu63-mut-"));
  const file = path.join(dir, "activation.json");
  fs.writeFileSync(file, JSON.stringify(r));
  fs.chmodSync(file, mode);
  return file;
}
function status(over = {}, opts = {}) {
  return mod.singleRunActivationStatus({
    filePath: withFile(rec(over), opts.mode ?? 0o600),
    config: opts.config ?? COMMITTED,
    receipts: opts.receipts ?? [],
    now: NOW,
    gitHead: opts.gitHead ?? REV,
  });
}
function statusWith(receipts) {
  return mod.singleRunActivationStatus({ filePath: withFile(rec()), config: COMMITTED, receipts, now: NOW, gitHead: REV });
}
function symlinkStatus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shu63-sym-"));
  const real = path.join(dir, "real.json");
  fs.writeFileSync(real, JSON.stringify(rec()));
  fs.chmodSync(real, 0o600);
  const link = path.join(dir, "link.json");
  fs.symlinkSync(real, link);
  return mod.singleRunActivationStatus({ filePath: link, config: COMMITTED, receipts: [], now: NOW, gitHead: REV });
}
const COMMITTED_CONFIG = COMMITTED;
const ENV_ON = { ENABLE_DISPATCH: "true" };
const ARMED = { state: "armed" };
`;

test("SHU-63 activation MUTATIONS: every binding, permission, expiry and gate guard is killed", () => {
  const mutations = [
    {
      name: "runtime switch dropped for the activation path",
      file: "reconcile.mjs",
      from: "  return envGate && activation?.state === \"armed\";",
      to: "  return activation?.state === \"armed\"; // SHU63-MUTATION-ENV",
      assertion: `assert.equal(mod.dispatchEnabledFor({}, COMMITTED_CONFIG, ARMED), false,
        "an armed activation still requires the runtime switch");`,
      failure: /an armed activation still requires the runtime switch/,
    },
    {
      name: "committed two-gate path dropped",
      file: "reconcile.mjs",
      from: "  if (config.enable_dispatch === true && envGate) return true; // committed path, unchanged",
      to: "  if (false) return true; // SHU63-MUTATION-COMMITTED",
      assertion: `assert.equal(mod.dispatchEnabledFor(ENV_ON, { enable_dispatch: true, max_dispatch: 1 }), true,
        "the committed two-gate path still enables dispatch");`,
      failure: /the committed two-gate path still enables dispatch/,
    },
    {
      name: "target binding removed",
      file: "single-run-activation.mjs",
      from: "  if (record.target_issue_id !== scopeIssue) {",
      to: "  if (false) { // SHU63-MUTATION-TARGET",
      assertion: `assert.equal(status({ target_issue_id: "SHU-999" }).state, "refused",
        "an activation cannot name a target outside the committed scope");`,
      failure: /an activation cannot name a target outside the committed scope/,
    },
    {
      name: "contract reference binding removed",
      file: "single-run-activation.mjs",
      from: "  if (fixtureLane.authorization_ref && record.authorization_ref !== fixtureLane.authorization_ref) {",
      to: "  if (false) { // SHU63-MUTATION-CONTRACT",
      assertion: `assert.equal(status({ authorization_ref: "FIXTURE-OTHER-CONTRACT-20260101" }).state, "refused",
        "an activation cannot present a different contract reference");`,
      failure: /an activation cannot present a different contract reference/,
    },
    {
      name: "revision binding removed",
      file: "single-run-activation.mjs",
      from: "  if (record.coordinator_revision !== revision) {",
      to: "  if (false) { // SHU63-MUTATION-REVISION",
      assertion: `assert.equal(status({}, { gitHead: "fedcba9876543210fedcba9876543210fedcba98" }).state, "refused",
        "an activation bound to another revision cannot arm this coordinator");`,
      failure: /an activation bound to another revision cannot arm this coordinator/,
    },
    {
      name: "slots binding removed (capacity could be widened)",
      file: "single-run-activation.mjs",
      from: "  if (record.slots !== 1) return refused(`activation requests ${record.slots} slots; a single-run activation is one slot`);",
      to: "  if (false) return refused(`activation requests ${record.slots} slots; a single-run activation is one slot`); // SHU63-MUTATION-SLOTS",
      assertion: `assert.equal(status({ slots: 2 }, { config: { ...COMMITTED_CONFIG, max_dispatch: 2 } }).state, "refused",
        "a single-run activation can never declare more than one slot");`,
      failure: /a single-run activation can never declare more than one slot/,
    },
    {
      name: "expiry wall removed",
      file: "single-run-activation.mjs",
      from: "  if (expiry <= at) return refused(",
      to: "  if (false) return refused(",
      assertion: `assert.equal(status({ expires_at: new Date(NOW.getTime() - 1000).toISOString() }).state, "refused",
        "an expired activation cannot arm anything");`,
      failure: /an expired activation cannot arm anything/,
    },
    {
      name: "expiry window bound removed",
      file: "single-run-activation.mjs",
      from: "  if (expiry - at > MAX_ACTIVATION_WINDOW_MS) {",
      to: "  if (false) { // SHU63-MUTATION-WINDOW",
      assertion: `assert.equal(status({ expires_at: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000).toISOString() }).state, "refused",
        "an unbounded expiry window is refused");`,
      failure: /an unbounded expiry window is refused/,
    },
    {
      name: "EXHAUST-ORDER: exhaustion checked after hold (both flags present)",
      file: "single-run-activation.mjs",
      from: "  if (routed.exhausted === true) return { ended: true, reason: \"revision attempts exhausted — the episode is over\" };",
      to: "  if (false) return { ended: true, reason: \"revision attempts exhausted — the episode is over\" }; // SHU63-MUTATION-EXHAUST-ORDER",
      assertion: `const exh = [{ issue_id: TARGET, attempt_id: "00000000-0000-4000-8000-0000000000f1", stage: "COMPLETED", verdict_stage: "BUILD_READY",
          requested_worker: "codex-builder", worker_identity: "builder", target_sha: REV, last_activity: "2026-09-11T01:00:00.000Z" }]
        .concat([1, 2, 3, 4].map((n) => ({ issue_id: TARGET, attempt_id: "00000000-0000-4000-8000-0000000000f" + (n + 1), stage: "HOLD",
          verdict_stage: "BLOCKED", requested_worker: "claude-verifier", worker_identity: "reviewer-" + n, target_sha: REV,
          last_activity: "2026-09-11T0" + (n + 1) + ":00:00.000Z" })));
        assert.equal(statusWith(exh).state, "refused",
          "exhaustion must end the episode even though the routing reports a hold at the same time");`,
      failure: /exhaustion must end the episode even though the routing reports a hold at the same time/,
    },
    {
      name: "PREMATURE SPENDING: a routable successor is spent anyway",
      file: "single-run-activation.mjs",
      from: "  if (routed.ok && routed.order) {",
      to: "  if (false) { // SHU63-MUTATION-EARLY-SPEND",
      assertion: `assert.equal(statusWith([
          { issue_id: TARGET, attempt_id: "00000000-0000-4000-8000-0000000000a1", stage: "COMPLETED", verdict_stage: "BUILD_READY",
            requested_worker: "codex-builder", worker_identity: "builder", target_sha: REV, last_activity: "2026-09-10T11:00:00.000Z" },
          { issue_id: TARGET, attempt_id: "00000000-0000-4000-8000-0000000000a2", stage: "HOLD", verdict_stage: "BLOCKED",
            requested_worker: "claude-verifier", worker_identity: "reviewer", target_sha: REV, last_activity: "2026-09-10T11:01:00.000Z" },
        ]).state, "armed",
        "a routable successor must never be spent early");`,
      failure: /a routable successor must never be spent early/,
    },
    {
      name: "PREMATURE SPENDING: retryable failures spend the episode",
      file: "single-run-activation.mjs",
      from: "  if (failed >= maxFailed) return { ended: true, reason: `retryable failures exhausted (${failed}/${maxFailed})` };",
      to: "  if (false) return { ended: true, reason: `retryable failures exhausted (${failed}/${maxFailed})` }; // SHU63-MUTATION-FAILCAP",
      assertion: `assert.equal(statusWith([1, 2, 3].map((n) => ({
          issue_id: TARGET, attempt_id: "00000000-0000-4000-8000-0000000000b" + n, stage: "FAILED",
          requested_worker: "codex-builder", worker_identity: "builder", target_sha: REV, last_activity: "2026-09-10T11:0" + n + ":00.000Z",
        }))).state, "refused",
        "retryable failures at the cap end the episode");`,
      failure: /retryable failures at the cap end the episode/,
    },
    {
      name: "symlink guard removed (unbound guard, review note)",
      file: "single-run-activation.mjs",
      from: "  if (stat.isSymbolicLink()) return { ok: false, reason: \"activation file is a symlink\" };",
      to: "  if (false) return { ok: false, reason: \"activation file is a symlink\" }; // SHU63-MUTATION-SYM",
      assertion: `const s = symlinkStatus();
        assert.equal(s.state, "refused", "a symlinked activation file is refused");
        assert.match(s.reason, /symlink/,
          "the refusal must NAME the symlink: the regular-file check would also refuse it, so the operator-visible diagnosis is what this guard binds");`,
      failure: /the refusal must NAME the symlink/,
    },
    {
      name: "file permission guard removed",
      file: "single-run-activation.mjs",
      from: "  if ((stat.mode & FORBIDDEN_MODE_BITS) !== 0) {",
      to: "  if (false) { // SHU63-MUTATION-PERMS",
      assertion: `assert.equal(status({}, { mode: 0o644 }).state, "refused",
        "a broadly readable activation file is refused");`,
      failure: /a broadly readable activation file is refused/,
    },
    {
      name: "unknown-key guard removed",
      file: "single-run-activation.mjs",
      from: "  if (missing.length > 0 || unknown.length > 0) {",
      to: "  if (missing.length > 0) { // SHU63-MUTATION-KEYS",
      assertion: `assert.equal(mod.validateActivationRecord({ ...rec(), force: true }).ok, false,
        "an unreviewed extra key is refused");`,
      failure: /an unreviewed extra key is refused/,
    },
    {
      name: "board-wide guard removed",
      file: "single-run-activation.mjs",
      from: "  if (!Array.isArray(scopeIds) || scopeIds.length !== 1) {",
      to: "  if (!Array.isArray(scopeIds) || scopeIds.length < 1) { // SHU63-MUTATION-SCOPE",
      assertion: `assert.equal(status({}, { config: { ...COMMITTED_CONFIG, dispatch_scope: { issue_ids: [TARGET, "SHU-999"] } } }).state, "refused",
        "an activation requires a committed single-issue scope");`,
      failure: /an activation requires a committed single-issue scope/,
    },
  ];

  for (const mutation of mutations) {
    const tmp = fs.mkdtempSync(join(tmpdir(), "shu63-activation-mutant-"));
    try {
      fs.cpSync(COORDINATOR_DIR, tmp, { recursive: true });
      const target = join(tmp, mutation.file);
      const source = fs.readFileSync(target, "utf8");
      assert.ok(source.includes(mutation.from), `${mutation.name}: source marker exists`);
      const mutated = source.replace(mutation.from, mutation.to);
      assert.notEqual(mutated, source, `${mutation.name}: mutation landed`);
      fs.writeFileSync(target, mutated);

      const probePath = join(tmp, "shu63-mutant-guard.mjs");
      const prelude = MUTATION_PRELUDE
        .replace("MODULE_URL", JSON.stringify(pathToFileURL(mutation.file === "reconcile.mjs" ? join(tmp, "reconcile.mjs") : join(tmp, "single-run-activation.mjs")).href))
        .replace("CONFIG_PATH", JSON.stringify(join(tmp, "config.json")));
      fs.writeFileSync(probePath, `${prelude}\n${mutation.assertion}\n`);
      const child = spawnSync(process.execPath, [probePath], { encoding: "utf8", timeout: 30000 });
      assert.notEqual(child.status, 0, `${mutation.name}: guard must fail\n${child.stdout}\n${child.stderr}`);
      assert.match(`${child.stdout}\n${child.stderr}`, mutation.failure, `${mutation.name}: named assertion failed`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});
