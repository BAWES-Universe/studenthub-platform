// test/episode-boundary.test.mjs — SHU-231.
//
// The episode boundary: an AUTHORIZED NEW episode must be reachable while the
// previous episode's terminal evidence is RETAINED — and the retention rule
// (never delete a receipt to reset a budget) must keep holding.
//
// Scope is exactly two decisions:
//   1. the one-use spend check            (episodeVerdict)
//   2. the terminal-receipt parking rule  (selectNextReservation)
// Everything else — capacity, lifecycle reconciliation, backfill and the
// cumulative failure budget — stays GLOBAL and keeps seeing every receipt.
//
// Episode identity is the existing `activation_id`; `supersedes_attempt_ids` is
// the explicit, reviewable statement of which retained evidence this approval
// retires. Untagged-and-unnamed still spends: fail closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as reconcile from "../reconcile.mjs";
import * as routing from "../review-routing.mjs";
import * as activation from "../single-run-activation.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, REVISION } from "./fixture/episode-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COORD = join(HERE, "..");
const TARGET = "SHU-140";
const CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";
const NOW = new Date("2026-09-10T12:00:00.000Z");
const COMMITTED = JSON.parse(fs.readFileSync(join(COORD, "config.json"), "utf8"));
const NEW_EPISODE = "shu63fixture0003";
const SPENT_EPISODE = "shu63fixture0002";
// The REAL retained attempt from the 2026-09-10 fixture run (RESERVED ->
// LAUNCH_UNKNOWN -> HOLD, no verdict). It is on the card and stays there.
const PRIOR = "8dd0526b-8e5b-4505-930a-97d272bfa346";
const OTHER = "1f1f1f1f-1111-4111-8111-111111111111";
const A = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

const record = (over = {}) => ({
  activation_id: NEW_EPISODE,
  target_issue_id: TARGET,
  authorization_ref: CONTRACT,
  coordinator_revision: REVISION,
  slots: 1,
  expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
  ...over,
});

// A production-shaped receipt: created by the coordinator's OWN validated factory,
// then advanced to the stage under test.
function receiptFor({
  attempt_id = PRIOR,
  stage = "HOLD",
  episode_id = null,
  verdict_stage = null,
  requested_worker = "codex-builder",
  last_activity = "2026-09-10T21:19:52.623Z",
  issue_id = TARGET,
  target_sha = SHA_INPUT,
} = {}) {
  const created = reconcile.createReceipt({
    issue_id,
    authorization_ref: CONTRACT,
    requested_worker,
    repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${issue_id}`,
    target_sha,
    attempt_id,
    episode_id,
    reserved_at: "2026-09-10T21:18:38.244Z",
  });
  if (!created.ok) throw new Error(`fixture receipt rejected: ${created.errors.join("; ")}`);
  const r = {
    ...created.receipt,
    stage,
    worker_identity: stage === "RESERVED" ? null : "codex-cli:session-1",
    external_run_id: stage === "RESERVED" ? null : "codexrun_fixture",
    adapter_status: stage === "RESERVED" ? null : "completed",
    timestamps: {
      reserved: "2026-09-10T21:18:38.244Z",
      launch: null,
      heartbeat: null,
      terminal: stage === "HOLD" || stage === "COMPLETED" ? last_activity : null,
    },
    evidence_links: stage === "RESERVED" ? [] : ["https://example.invalid/evidence"],
    last_activity,
    notes: [],
  };
  if (verdict_stage) r.verdict_stage = verdict_stage;
  return r;
}

const readyIssue = (id = TARGET) => ({
  id,
  linearId: "11111111-aaaa-4bbb-8ccc-000000000777",
  priority: "High",
  title: "fixture",
  requested_worker: "codex-builder",
});

const scopedConfig = { max_dispatch: 1, dispatch_scope: { issue_ids: [TARGET] } };
const scopeFor = (activation_id = NEW_EPISODE, supersedes = []) => activation.episodeScopeFor({ activation_id, supersedes_attempt_ids: supersedes });

function statusWith(rec, receipts) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "shu231-act-"));
  const file = join(dir, "activation.json");
  fs.writeFileSync(file, JSON.stringify(rec));
  fs.chmodSync(file, 0o600);
  return activation.singleRunActivationStatus({
    filePath: file, config: COMMITTED, receipts, now: NOW, dir: COORD, gitHead: REVISION,
  });
}

// The card's real, retained evidence: three receipts of one attempt, untagged.
const retainedHold = () => ([
  receiptFor({ stage: "RESERVED", last_activity: "2026-09-10T21:18:38.244Z" }),
  receiptFor({ stage: "LAUNCH_UNKNOWN", last_activity: "2026-09-10T21:18:38.393Z" }),
  receiptFor({ stage: "HOLD", last_activity: "2026-09-10T21:19:52.623Z" }),
]);

async function seedRetained(h, receipts) {
  for (const r of receipts) h.comments.push({ body: reconcile.receiptCommentBody(r), createdAt: r.last_activity });
}

// Drive one whole build -> BLOCK -> revise -> re-review -> PASS episode, as in
// the SHU-225 acceptance test: the coordinator makes every launch itself.
async function driveFullEpisode(h, { expectCode2AtEnd = true } = {}) {
  let t = await h.runTick();
  assert.equal(t.code, 0, t.text);
  const build = h.latestFor("codex-builder");
  await h.runTick();
  h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
  h.branchHead.value = SHA_WRITE;
  h.completeRun(build.external_run_id);
  t = await h.runTick();
  assert.equal(h.receiptFor(build.attempt_id).stage, "COMPLETED", t.text);

  t = await h.runTick();
  const review = h.latestFor("claude-verifier");
  assert.equal(h.triggers["claude-code"], 1, `the coordinator launched the reviewer itself:\n${t.text}`);
  await h.runTick();
  h.postCallback({ attemptId: review.attempt_id, stage: "BLOCKED", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
  h.completeRun(review.external_run_id);
  t = await h.runTick();
  assert.equal(h.receiptFor(review.attempt_id).stage, "HOLD", t.text);

  t = await h.runTick();
  const revise = h.latestFor("codex-builder");
  assert.equal(h.triggers["codex-cli"], 2, `the revision is launched by the coordinator:\n${t.text}`);
  await h.runTick();
  h.postCallback({ attemptId: revise.attempt_id, stage: "REVISION_READY", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
  h.completeRun(revise.external_run_id);
  t = await h.runTick();
  assert.equal(h.receiptFor(revise.attempt_id).verdict_stage, "REVISION_READY", t.text);

  t = await h.runTick();
  const rereview = h.latestFor("claude-verifier");
  assert.equal(h.triggers["claude-code"], 2, "the re-review is launched by the coordinator");
  await h.runTick();
  h.postCallback({ attemptId: rereview.attempt_id, stage: "PASS", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
  h.completeRun(rereview.external_run_id);
  t = await h.runTick();
  assert.equal(h.receiptFor(rereview.attempt_id).verdict_stage, "PASS", t.text);

  const before = { ...h.triggers };
  t = await h.runTick();
  if (expectCode2AtEnd) {
    assert.equal(t.code, 2, "after PASS the activation refuses");
    assert.match(t.text, /activation is spent/);
  }
  assert.deepEqual(h.triggers, before, "a spent episode launches nothing");
  return t;
}

// ---------------------------------------------------------------------------
// ACCEPTANCE
// ---------------------------------------------------------------------------

test("SHU-231 A1: a RETAINED HOLD does not block a fresh authorized episode — all four launches, nothing seeded, nothing deleted", async () => {
  const h = createEpisodeHarness({ githubToken: "ghtok", activationId: NEW_EPISODE, supersedesAttemptIds: [PRIOR] });
  try {
    await seedRetained(h, retainedHold());
    const seededAtStart = h.comments.filter((c) => String(c.body).includes(PRIOR)).length;
    assert.equal(seededAtStart, 3, "the prior attempt's receipts are genuinely on the card");

    await driveFullEpisode(h);

    // Four launches, one per step: the coordinator did all of it itself.
    assert.deepEqual(h.triggers, { "codex-cli": 2, "claude-code": 2, "hermes-pool": 0 });
    // The episode's OWN receipts (the retained prior attempt is still on the card).
    const episodesOwn = h.receipts().filter((r) => r.attempt_id !== PRIOR);
    const stages = episodesOwn.map((r) => `${r.requested_worker}:${r.stage}/${r.verdict_stage ?? "-"}`);
    assert.deepEqual(stages, [
      "codex-builder:COMPLETED/BUILD_READY",
      "claude-verifier:HOLD/BLOCKED",
      "codex-builder:COMPLETED/REVISION_READY",
      "claude-verifier:COMPLETED/PASS",
    ]);

    // Every receipt the coordinator wrote carries this episode's identity...
    assert.equal(episodesOwn.length, 4);
    for (const r of episodesOwn) assert.equal(r.episode_id, NEW_EPISODE, "the coordinator stamps episode_id on its own receipts");
    // ...and NOT ONE retained receipt was touched.
    assert.equal(h.comments.filter((c) => String(c.body).includes(PRIOR)).length, 3, "no receipt is deleted, archived or rewritten");
    const priorHold = reconcile.parseReceiptsFromComments(h.comments).find((r) => r.attempt_id === PRIOR);
    assert.equal(priorHold.stage, "HOLD", "the retired evidence survives verbatim");
    assert.equal(priorHold.verdict_stage, undefined, "the retired evidence is not retro-edited into a verdict");
  } finally {
    h.cleanup();
  }
});

test("SHU-231 A2: the SAME retained HOLD, unnamed, still refuses — zero writes, zero launches", async () => {
  const h = createEpisodeHarness({ githubToken: "ghtok", activationId: NEW_EPISODE });
  try {
    await seedRetained(h, retainedHold());
    const t = await h.runTick();
    assert.equal(t.code, 2, `an unnamed retained HOLD must still spend the approval:\n${t.text}`);
    assert.match(t.text, /activation is spent/);
    assert.match(t.text, /8dd0526b/);
    assert.deepEqual(h.triggers, { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 }, "a refused activation launches nothing");
    assert.equal(h.comments.filter((c) => String(c.body).includes("coordinator-receipt")).length, 3, "a refusal writes no receipt");
  } finally {
    h.cleanup();
  }
});

test("SHU-231 A2 (unit): the spend check is the ONLY thing that changed — an unnamed retained terminal always spends", () => {
  const kept = statusWith(record(), retainedHold());
  assert.equal(kept.state, "refused");
  assert.match(kept.reason, /activation is spent/);

  const named = statusWith(record({ supersedes_attempt_ids: [PRIOR] }), retainedHold());
  assert.equal(named.state, "armed", "naming the retired attempt is what admits the new episode");
  assert.equal(named.episode, "no attempt has been dispatched yet");
});

test("SHU-231 A3: naming the attempt while REUSING the spent activation_id refuses", async () => {
  // The spent episode's receipts are TAGGED with the reused identity, so they are
  // in scope by identity — superseding cannot launder them, because episode_id wins.
  const spentReceipts = [receiptFor({ stage: "HOLD", episode_id: SPENT_EPISODE, last_activity: "2026-09-10T13:00:00.000Z" })];
  const s = statusWith(record({ activation_id: SPENT_EPISODE, supersedes_attempt_ids: [PRIOR] }), spentReceipts);
  assert.equal(s.state, "refused", "reusing the spent activation_id cannot reauthorize it");
  assert.match(s.reason, /activation is spent/);

  const h = createEpisodeHarness({ githubToken: "ghtok", activationId: SPENT_EPISODE, supersedesAttemptIds: [PRIOR] });
  try {
    await seedRetained(h, [receiptFor({ stage: "HOLD", episode_id: SPENT_EPISODE, last_activity: "2026-09-10T13:00:00.000Z" })]);
    const t = await h.runTick();
    assert.equal(t.code, 2, t.text);
    assert.deepEqual(h.triggers, { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 });
  } finally {
    h.cleanup();
  }
});

test("SHU-231 A4: a HOLD produced WITHIN the current episode still spends it (SHU-225 untouched)", () => {
  const inEpisode = [
    receiptFor({ attempt_id: PRIOR, last_activity: "2026-09-10T21:19:52.623Z" }),
    receiptFor({ attempt_id: A("9"), stage: "HOLD", episode_id: NEW_EPISODE, last_activity: "2026-09-10T22:30:00.000Z" }),
  ];
  const s = statusWith(record({ supersedes_attempt_ids: [PRIOR] }), inEpisode);
  assert.equal(s.state, "refused", "an in-episode terminal still ends the episode");
  assert.match(s.reason, /ended HOLD without a coherent verdict/);
});

test("SHU-231 A5: restart/resume keeps ONE episode identity and one first step", async () => {
  const h = createEpisodeHarness({ activationId: NEW_EPISODE });
  try {
    await h.runTick();
    const build = h.latestFor("codex-builder");
    assert.equal(build.episode_id, NEW_EPISODE, "the episode is stamped on the first receipt");
    await h.runTick();
    await h.runTick();
    assert.equal(h.triggers["codex-cli"], 1, "a restart re-derives the same episode, never a second first step");
    assert.equal(h.receipts().find((r) => r.requested_worker === "codex-builder").attempt_id, build.attempt_id, "the attempt id is stable across restarts");

    await h.runTick();
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.branchHead.value = SHA_WRITE;
    h.completeRun(build.external_run_id);
    await h.runTick();
    await h.runTick();
    const reviews = h.receipts().filter((r) => r.requested_worker === "claude-verifier");
    assert.equal(reviews.length, 1, "a replay never duplicates the successor");
    assert.equal(reviews[0].attempt_id, routing.freshAttempt(build.attempt_id, "review", 1));
    assert.equal(reviews[0].episode_id, NEW_EPISODE, "a mid-episode successor carries the same episode");
  } finally {
    h.cleanup();
  }
});

test("SHU-231 A6: a prior-episode receipt that is still ACTIVE keeps holding the slot — capacity stays global", () => {
  const running = receiptFor({ attempt_id: A("7"), stage: "RUNNING", episode_id: SPENT_EPISODE, last_activity: "2026-09-10T22:00:00.000Z" });
  const sel = reconcile.selectNextReservation({
    ready: [readyIssue()],
    config: scopedConfig,
    receipts: [running],
    episodeScope: scopeFor(),
    episodeIssueIds: new Set([TARGET]),
  });
  assert.equal(sel.candidate, null, "capacity stays global — a prior-episode active receipt still holds the slot");
  assert.match(sel.skipped[0].reason, /max_dispatch=1 reached/);
});

test("SHU-231 A7: a fresh episode never replenishes the cumulative failure budget", () => {
  const failed = [A("3"), A("4"), A("5")].map((id) => receiptFor({ attempt_id: id, stage: "FAILED", episode_id: SPENT_EPISODE, last_activity: "2026-09-10T22:00:00.000Z" }));
  const v = activation.episodeVerdict({
    receipts: failed, targetIssueId: TARGET, config: { ...COMMITTED },
    episodeScope: scopeFor(),
  });
  assert.equal(v.ended, true, "3 prior FAILED receipts park the card regardless of episode");
  assert.match(v.reason, /retryable failures exhausted \(3\/3\)/);

  const sel = reconcile.selectNextReservation({
    ready: [readyIssue()], config: { ...scopedConfig, max_failed_attempts: 3 }, receipts: failed,
    episodeScope: scopeFor(), episodeIssueIds: new Set([TARGET]),
  });
  assert.equal(sel.candidate, null, "the selector parks it too — the budget is not replenished");
  assert.match(sel.skipped[0].reason, /max failed attempts reached/);
});

test("SHU-231 A8: with no activation, parking and spending are byte-for-byte unchanged", () => {
  // Parking: a terminal COMPLETED receipt with NO scope and NO admission.
  const sel = reconcile.selectNextReservation({
    ready: [readyIssue()], config: scopedConfig,
    receipts: [receiptFor({ attempt_id: A("6"), stage: "COMPLETED", verdict_stage: "BUILD_READY" })],
  });
  assert.equal(sel.candidate, null, "parking is unchanged when no activation is armed");
  assert.match(sel.skipped[0].reason, /parked for human\/next-step/);

  // Spending: no scope supplied => the historical, global reading.
  const v = activation.episodeVerdict({ receipts: retainedHold(), targetIssueId: TARGET, config: { ...COMMITTED } });
  assert.equal(v.ended, true, "without an episode scope the retained HOLD still ends the episode");

  // ...and the committed switch is still off, so nothing is reachable anyway.
  assert.equal(COMMITTED.enable_dispatch, false);
});

test("SHU-231 A9: a callback for the RETIRED attempt cannot satisfy the new attempt", async () => {
  const h = createEpisodeHarness({ githubToken: "ghtok", activationId: NEW_EPISODE, supersedesAttemptIds: [PRIOR] });
  try {
    await seedRetained(h, retainedHold());
    await h.runTick();
    const build = h.latestFor("codex-builder");
    assert.notEqual(build.attempt_id, PRIOR, "the new episode mints its own attempt");
    // The old attempt's callback arrives late, claiming the old artifact.
    h.postCallback({ attemptId: PRIOR, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    await h.runTick();
    assert.equal(h.receiptFor(build.attempt_id).verdict_stage, undefined, "a retired attempt's callback cannot satisfy the new attempt");
    assert.equal(h.receiptFor(build.attempt_id).stage, "RUNNING");
    const priorHold = reconcile.parseReceiptsFromComments(h.comments).find((r) => r.attempt_id === PRIOR);
    assert.equal(priorHold.stage, "HOLD", "the retired receipt is not promoted by the stale callback");
  } finally {
    h.cleanup();
  }
});

test("SHU-231 A10: one attempt_id under two episodes is a durable conflict, never a silent override", () => {
  assert.ok(reconcile.RECEIPT_IMMUTABLE_FIELDS.includes("episode_id"), "episode_id is an immutable receipt field");
  const comments = [
    { body: reconcile.receiptCommentBody(receiptFor({ stage: "HOLD", episode_id: SPENT_EPISODE, last_activity: "2026-09-10T13:00:00.000Z" })), createdAt: "2026-09-11T00:00:00.000Z" },
    { body: reconcile.receiptCommentBody(receiptFor({ stage: "HOLD", episode_id: NEW_EPISODE, last_activity: "2026-09-10T13:00:00.000Z" })), createdAt: "2026-09-11T00:01:00.000Z" },
  ];
  const parsed = reconcile.parseReceiptsFromComments(comments);
  assert.equal(parsed.length, 2, "the forged record is surfaced, not collapsed away");
});

// ---------------------------------------------------------------------------
// MUTATIONS — each removes ONE guard and must fail a NAMED assertion.
// ---------------------------------------------------------------------------

const PRELUDE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as reconcile from "./reconcile.mjs";
import * as activation from "./single-run-activation.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, REVISION } from "./test/fixture/episode-harness.mjs";
const TARGET = "SHU-140";
const CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";
const NOW = new Date("2026-09-10T12:00:00.000Z");
const COMMITTED = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const NEW_EPISODE = "shu63fixture0003";
const SPENT_EPISODE = "shu63fixture0002";
const PRIOR = "8dd0526b-8e5b-4505-930a-97d272bfa346";
const scopedConfig = { max_dispatch: 1, dispatch_scope: { issue_ids: [TARGET] } };
const readyIssue = () => ({ id: TARGET, linearId: "11111111-aaaa-4bbb-8ccc-000000000777", priority: "High", title: "fixture", requested_worker: "codex-builder" });
function rf(over = {}) {
  const o = { attempt_id: PRIOR, stage: "HOLD", episode_id: null, verdict_stage: null,
    requested_worker: "codex-builder", last_activity: "2026-09-10T21:19:52.623Z", issue_id: TARGET, ...over };
  const created = reconcile.createReceipt({ issue_id: o.issue_id, authorization_ref: CONTRACT, requested_worker: o.requested_worker,
    repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/" + o.issue_id, target_sha: SHA_INPUT,
    attempt_id: o.attempt_id, episode_id: o.episode_id, reserved_at: "2026-09-10T21:18:38.244Z" });
  if (!created.ok) throw new Error(created.errors.join("; "));
  const r = { ...created.receipt, stage: o.stage, worker_identity: "codex-cli:session-1", external_run_id: "codexrun_f",
    adapter_status: "completed", timestamps: { reserved: "2026-09-10T21:18:38.244Z", launch: null, heartbeat: null, terminal: o.last_activity },
    evidence_links: ["https://example.invalid/evidence"], last_activity: o.last_activity, notes: [] };
  if (o.verdict_stage) r.verdict_stage = o.verdict_stage;
  return r;
}
const retained = () => [rf({ stage: "RESERVED" }), rf({ stage: "LAUNCH_UNKNOWN" }), rf({ stage: "HOLD" })];
`;

const MUTATIONS = [
  {
    // M1 — the supersede requirement is what stops an id-only edit from
    // reauthorizing a spent approval.
    name: "M1: any new activation_id treated as a new episode (supersede requirement dropped)",
    file: "single-run-activation.mjs",
    from: "  return !scope.supersedes.has(receipt.attempt_id);",
    to: "  return false; // SHU231-MUT-M1",
    assertion: `const h = createEpisodeHarness({ githubToken: "ghtok", activationId: NEW_EPISODE });
try {
  for (const r of retained()) h.comments.push({ body: reconcile.receiptCommentBody(r), createdAt: r.last_activity });
  const t = await h.runTick();
  assert.equal(t.code, 2, "an unnamed retained HOLD must still spend the approval");
} finally { h.cleanup(); }`,
    failure: /an unnamed retained HOLD must still spend the approval/,
  },
  {
    // M2 — the failure budget is cumulative across episodes on purpose.
    name: "M2: the failure budget scoped to the episode",
    file: "single-run-activation.mjs",
    from: "  const failed = issueReceipts.filter((r) => r.stage === \"FAILED\").length;",
    to: "  const failed = scopedReceipts.filter((r) => r.stage === \"FAILED\").length; // SHU231-MUT-M2",
    assertion: `const ids = ["33333333-3333-4333-8333-333333333333","44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"];
const receipts = ids.map((id) => rf({ attempt_id: id, stage: "FAILED", episode_id: SPENT_EPISODE }));
const v = activation.episodeVerdict({ receipts, targetIssueId: TARGET, config: COMMITTED,
  episodeScope: { episode_id: NEW_EPISODE, supersedes: new Set() } });
assert.equal(v.ended, true, "the cumulative failure budget stays global — a new episode cannot replenish it");`,
    failure: /the cumulative failure budget stays global/,
  },
  {
    // M3 — capacity/lifecycle must keep seeing every receipt.
    name: "M3: capacity scoped by episode",
    file: "reconcile.mjs",
    from: "  const active = receipts.filter((r) => r && !TERMINAL_STAGES.includes(r.stage));",
    to: "  const active = receipts.filter((r) => r && !TERMINAL_STAGES.includes(r.stage) && receiptInEpisodeScope(r, episodeScope)); // SHU231-MUT-M3",
    assertion: `const sel = reconcile.selectNextReservation({ ready: [readyIssue()], config: scopedConfig,
  receipts: [rf({ attempt_id: "77777777-7777-4777-8777-777777777777", stage: "RUNNING", episode_id: SPENT_EPISODE })],
  episodeScope: { episode_id: NEW_EPISODE, supersedes: new Set() }, episodeIssueIds: new Set([TARGET]) });
assert.equal(sel.candidate, null, "capacity stays global — a prior-episode active receipt still holds the slot");`,
    failure: /capacity stays global/,
  },
  {
    // M4 — the first-step admission is strictly for a FRESH episode.
    name: "M4: a started episode re-admitted for its first step (spent episode un-parked)",
    file: "reconcile.mjs",
    from: "    if (!episodeHasStarted) episodeIssueIds.add(singleRunActivation.target_issue_id);",
    to: "    if (true) episodeIssueIds.add(singleRunActivation.target_issue_id); // SHU231-MUT-M4",
    assertion: `const h = createEpisodeHarness({ withReviewerLane: false });
try {
  await h.runTick();
  const build = h.latestFor("codex-builder");
  await h.runTick();
  h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
  h.branchHead.value = SHA_WRITE;
  h.completeRun(build.external_run_id);
  await h.runTick(); await h.runTick();
  assert.equal(h.triggers["codex-cli"], 1, "a mid-episode availability hold never re-dispatches the episode's first step");
} finally { h.cleanup(); }`,
    failure: /a mid-episode availability hold never re-dispatches/,
  },
  {
    // M5 — the immutability of episode_id is what makes a forgery a conflict.
    name: "M5: episode_id omitted from RECEIPT_IMMUTABLE_FIELDS",
    file: "reconcile.mjs",
    from: "  \"episode_id\",\n]);",
    to: "]); // SHU231-MUT-M5",
    assertion: `const comments = [
  { body: reconcile.receiptCommentBody(rf({ stage: "HOLD", episode_id: SPENT_EPISODE, last_activity: "2026-09-10T13:00:00.000Z" })), createdAt: "2026-09-11T00:00:00.000Z" },
  { body: reconcile.receiptCommentBody(rf({ stage: "HOLD", episode_id: NEW_EPISODE, last_activity: "2026-09-10T13:00:00.000Z" })), createdAt: "2026-09-11T00:01:00.000Z" },
];
assert.equal(reconcile.parseReceiptsFromComments(comments).length, 2, "one attempt under two episodes is a durable conflict");`,
    failure: /one attempt under two episodes is a durable conflict/,
  },
  {
    // M6 — the blast radius: no armed episode, no episode scoping.
    name: "M6: the new parking scope applied when no activation is armed",
    file: "reconcile.mjs",
    from: "      .filter((r) => r && (r.stage === \"COMPLETED\" || r.stage === \"HOLD\") && receiptInEpisodeScope(r, episodeScope))",
    to: "      .filter((r) => r && (r.stage === \"COMPLETED\" || r.stage === \"HOLD\") && (episodeScope ? receiptInEpisodeScope(r, episodeScope) : false)) // SHU231-MUT-M6",
    assertion: `const sel = reconcile.selectNextReservation({ ready: [readyIssue()], config: scopedConfig,
  receipts: [rf({ attempt_id: "66666666-6666-4666-8666-666666666666", stage: "COMPLETED", verdict_stage: "BUILD_READY" })] });
assert.equal(sel.candidate, null, "parking is unchanged when no activation is armed");`,
    failure: /parking is unchanged when no activation is armed/,
  },
  {
    // M7 — the episode identity must survive a restart.
    name: "M7: episode identity regenerated on restart",
    file: "single-run-activation.mjs",
    from: "  return { episode_id: record.activation_id, supersedes: new Set(supersedes) };",
    to: "  return { episode_id: \"episode-\" + Math.random().toString(36).slice(2), supersedes: new Set(supersedes) }; // SHU231-MUT-M7",
    assertion: `const h = createEpisodeHarness();
const rec = { activation_id: NEW_EPISODE, target_issue_id: TARGET, authorization_ref: CONTRACT,
  coordinator_revision: REVISION, slots: 1, expires_at: new Date(NOW.getTime() + 3600000).toISOString() };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shu231-m7-"));
const file = path.join(dir, "activation.json");
fs.writeFileSync(file, JSON.stringify(rec));
fs.chmodSync(file, 0o600);
const s = activation.singleRunActivationStatus({ filePath: file, config: COMMITTED,
  receipts: [rf({ attempt_id: PRIOR, stage: "COMPLETED", episode_id: NEW_EPISODE, verdict_stage: "PASS", last_activity: "2026-09-10T13:00:00.000Z" })],
  now: NOW, dir: ".", gitHead: REVISION });
assert.equal(s.state, "refused", "a receipt of THIS episode spends it — a restart must not forget the episode identity");`,
    failure: /a restart must not forget the episode identity/,
  },
];

test("SHU-231 MUTATIONS: the boundary, the global stays and the retention rule are each load-bearing", () => {
  for (const mut of MUTATIONS) {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "shu231-mutant-"));
    try {
      fs.cpSync(COORD, tmp, { recursive: true });
      const target = join(tmp, mut.file);
      const source = fs.readFileSync(target, "utf8");
      assert.ok(source.includes(mut.from), `${mut.name}: source marker exists`);
      const mutated = source.replace(mut.from, mut.to);
      assert.notEqual(mutated, source, `${mut.name}: mutation landed`);
      fs.writeFileSync(target, mutated);

      const probe = join(tmp, "shu231-mutant-probe.mjs");
      fs.writeFileSync(probe, `${PRELUDE}\n${mut.assertion}\n`);
      const child = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 120000, cwd: tmp });
      assert.notEqual(child.status, 0, `${mut.name}: guard must fail\n${child.stdout}\n${child.stderr}`);
      assert.match(`${child.stdout}\n${child.stderr}`, mut.failure, `${mut.name}: named assertion failed`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});
