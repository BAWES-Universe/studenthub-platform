// CI before review: a coordinator build or revise head is checked by its own CI
// before a reviewer spends a round on it. Green reviews as before, pending
// waits (up to wait_minutes, then reviews as before), red goes back to the
// writer as a revise carrying the CI output, at most max_ci_revise times an
// episode. Off unless enabled is exactly true (the committed config.json turns
// it on), and never for a review-only run or a landing repair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as routing from "../review-routing.mjs";
import { episodeVerdict } from "../single-run-activation.mjs";
import { reviewFindingsContext } from "../review-findings.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, SHA_REVISED } from "./fixture/episode-harness.mjs";

const TARGET = "SHU-140";
const CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";
const NOW = new Date("2026-09-10T12:00:00.000Z");
const ON = Object.freeze({ enabled: true, wait_minutes: 45, max_ci_revise: 2 });
const SETTINGS = Object.freeze({ wait_minutes: 45, max_ci_revise: 2 });
const MINUTE = 60 * 1000;
const A = {
  build: "11111111-1111-4111-8111-111111111111",
  review: "22222222-2222-4222-8222-222222222222",
  revise: "33333333-3333-4333-8333-333333333333",
  ci1: "55555555-5555-4555-8555-555555555555",
  ci2: "66666666-6666-4666-8666-666666666666",
};

function receipt({ attempt = A.build, worker = "codex-builder", stage = "COMPLETED", verdict = "BUILD_READY",
  identity = "codex-cli:session-1", target = SHA_INPUT, result = null, at = "2026-09-10T12:00:00.000Z", extra = {} } = {}) {
  return {
    receipt_version: "1.0.0", issue_id: TARGET, attempt_id: attempt, authorization_ref: CONTRACT, stage,
    requested_worker: worker, worker_identity: identity, repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${TARGET}`, target_sha: target, external_run_id: `run_${attempt.slice(0, 6)}`,
    adapter_status: "completed", timestamps: { reserved: at, launch: at, heartbeat: null, terminal: at },
    evidence_links: [], last_activity: at, notes: [], verdict_stage: verdict,
    ...(result ? { result_sha: result } : {}), ...extra,
  };
}
const ciFindingsAt = (head, summary = "Failing checks: application-checks: failure") =>
  ({ verdict_stage: "BLOCKED", source: "ci", target_sha: head, summary, links: [] });
const reviewSuccessor = () => ({
  version: routing.WORK_ORDER_VERSION, role: "review", runtime: "claude-code", actor: "claude-verifier",
  requested_worker: "claude-verifier", issue_id: TARGET, attempt_id: routing.freshAttempt(A.build, "review", 1),
  target_sha: SHA_WRITE, authorization_ref: CONTRACT, workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null,
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

test("CI before review: the gate is off unless enabled is exactly true, with defaults of 45 minutes and 2 revises", () => {
  for (const config of [{}, { ci_before_review: null }, { ci_before_review: { enabled: false } }, { ci_before_review: { enabled: "true" } }]) {
    assert.equal(routing.ciBeforeReviewSettings(config), null, JSON.stringify(config));
  }
  assert.deepEqual(routing.ciBeforeReviewSettings({ ci_before_review: { enabled: true } }), { wait_minutes: 45, max_ci_revise: 2 });
  assert.deepEqual(routing.ciBeforeReviewSettings({ ci_before_review: { enabled: true, wait_minutes: 10, max_ci_revise: 0 } }), { wait_minutes: 10, max_ci_revise: 0 });
  assert.deepEqual(routing.ciBeforeReviewSettings({ ci_before_review: { enabled: true, wait_minutes: -1, max_ci_revise: 1.5 } }), { wait_minutes: 45, max_ci_revise: 2 });
});

test("CI before review: only a review of a build or revise head is gated, never a review-only run or a landing repair", () => {
  const successor = reviewSuccessor();
  assert.equal(routing.ciBeforeReviewApplies({ settings: SETTINGS, activation: { state: "armed" }, successor }), true);
  assert.equal(routing.ciBeforeReviewApplies({ settings: null, activation: { state: "armed" }, successor }), false, "flag off");
  assert.equal(routing.ciBeforeReviewApplies({ settings: SETTINGS, activation: { state: "armed", review_only: true }, successor }), false, "review-only run");
  assert.equal(routing.ciBeforeReviewApplies({ settings: SETTINGS, activation: { state: "armed", landing_repair: true }, successor }), false, "landing repair");
  assert.equal(routing.ciBeforeReviewApplies({ settings: SETTINGS, activation: { state: "armed" }, successor: { ...successor, role: "revise" } }), false, "a revise is not gated");
  assert.equal(routing.ciBeforeReviewApplies({ settings: SETTINGS, activation: { state: "armed" }, successor: null }), false);
});

test("CI before review: green proceeds to review", () => {
  const decision = routing.ciBeforeReviewDecision({ checks: { green: true }, waitedMs: 0, settings: SETTINGS });
  assert.equal(decision.action, "review");
  assert.equal(decision.note, undefined, "a green review needs no note");
});

test("CI before review: pending or unreported checks hold inside wait_minutes", () => {
  for (const checks of [{ green: false, note: "checks are still running" }, { green: false, note: "no check has reported yet" },
    { green: false, note: "the checks could not be read in full" }, undefined]) {
    assert.equal(routing.ciBeforeReviewDecision({ checks, waitedMs: 44 * MINUTE, settings: SETTINGS }).action, "hold", JSON.stringify(checks));
  }
});

test("CI before review: checks still pending past wait_minutes proceed to review with a note that CI did not settle", () => {
  const decision = routing.ciBeforeReviewDecision({ checks: { green: false, note: "checks are still running" }, waitedMs: 45 * MINUTE, settings: SETTINGS });
  assert.equal(decision.action, "review");
  assert.match(decision.note, /CI did not settle within 45 minutes/);
  assert.equal(routing.ciBeforeReviewDecision({ checks: { green: false }, waitedMs: Number.NaN, settings: SETTINGS }).action, "review",
    "an unreadable write timestamp reviews as before");
});

test("CI before review: red mints a revise until max_ci_revise, then proceeds to review", () => {
  const red = { red: ["application-checks: failure"] };
  assert.equal(routing.ciBeforeReviewDecision({ checks: red, waitedMs: 0, settings: SETTINGS, ciRevises: 0 }).action, "revise");
  assert.equal(routing.ciBeforeReviewDecision({ checks: red, waitedMs: 0, settings: SETTINGS, ciRevises: 1 }).action, "revise");
  const capped = routing.ciBeforeReviewDecision({ checks: red, waitedMs: 0, settings: SETTINGS, ciRevises: 2 });
  assert.equal(capped.action, "review", "max_ci_revise exceeded proceeds to review");
  assert.match(capped.note, /max_ci_revise 2 reached/);
});

test("CI before review: a CI revise is shaped like a routed revise, bound to the head under review, with CI findings", () => {
  const lineage = [receipt({ result: SHA_WRITE })];
  const findings = ciFindingsAt(SHA_WRITE);
  const minted = routing.ciReviseOrder({ review: reviewSuccessor(), lineageReceipts: lineage, ciRound: 1, findings });
  assert.equal(minted.ok, true, minted.reason);
  const order = minted.order;
  assert.equal(order.role, "revise");
  assert.equal(order.runtime, "codex-cli");
  assert.equal(order.actor, "codex-cli:session-1", "the active writer");
  assert.equal(order.requested_worker, "codex-builder");
  assert.equal(order.target_sha, SHA_WRITE, "the revise starts from the head CI judged");
  assert.equal(order.attempt_id, routing.freshAttempt(reviewSuccessor().attempt_id, "ci-revise", 1));
  assert.notEqual(routing.ciReviseOrder({ review: reviewSuccessor(), lineageReceipts: lineage, ciRound: 2, findings }).order.attempt_id, order.attempt_id);
  assert.equal(order.scope_phase, "revision");
  assert.deepEqual(order.review_findings, findings);
  assert.equal(routing.validWorkOrder(order).ok, true);
  const context = reviewFindingsContext({ scope_phase: order.scope_phase, review_findings: order.review_findings });
  assert.match(context, /<ci-findings>/);
  assert.equal(routing.ciReviseOrder({ review: reviewSuccessor(), lineageReceipts: lineage, ciRound: 1, findings: ciFindingsAt(SHA_INPUT) }).ok, false,
    "findings of another head never bind");
  assert.equal(routing.ciReviseOrder({ review: reviewSuccessor(), lineageReceipts: lineage, ciRound: 1, findings: { ...findings, source: undefined } }).ok, false,
    "only CI findings make a CI revise");
  assert.equal(routing.ciReviseOrder({ review: reviewSuccessor(), lineageReceipts: [], ciRound: 1, findings }).ok, false, "no writer, no revise");
});

test("CI before review: CI revises are counted on their own and never consume max_revise", () => {
  const ciRevise = (attempt, at, from, to) => receipt({ attempt, worker: "codex-builder", verdict: "REVISION_READY", target: from, result: to, at,
    extra: { receipt_version: "1.1.0", role: "revise", runtime: "codex-cli", scope_phase: "revision", review_findings: ciFindingsAt(from) } });
  const receipts = [
    receipt({ result: SHA_WRITE }),
    ciRevise(A.ci1, "2026-09-10T12:10:00.000Z", SHA_WRITE, SHA_REVISED),
    ciRevise(A.ci2, "2026-09-10T12:20:00.000Z", SHA_REVISED, "e".repeat(40)),
    receipt({ attempt: A.review, worker: "claude-verifier", identity: "claude-code:session-2", stage: "HOLD", verdict: "BLOCKED",
      target: "e".repeat(40), at: "2026-09-10T12:30:00.000Z" }),
  ];
  assert.equal(routing.ciReviseCount(receipts), 2);
  assert.equal(routing.ciReviseCount([...receipts, { ...receipts[1] }]), 2, "copies of one attempt count once");
  const verdict = episodeVerdict({ receipts, targetIssueId: TARGET, config: { max_revise: 1 } });
  assert.equal(verdict.ended, false, verdict.reason);
  assert.equal(verdict.successor?.role, "revise", "the first review BLOCK still gets its revise after two CI revises");
});

// ---------------------------------------------------------------------------
// The armed tick
// ---------------------------------------------------------------------------

function job(id, head, conclusion = "failure") {
  return { id, name: conclusion === "success" ? "coordinator-tests" : "application-checks", status: "completed", conclusion,
    head_sha: head, app: { slug: "github-actions" } };
}

// The harness's fake GitHub, plus the commit checks and Actions jobs CI reads.
function ciWorld(h, { checks = () => [] } = {}) {
  const reads = [];
  const ok = (body) => ({ status: 200, ok: true, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    const runs = /\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(u);
    if (runs) {
      reads.push(runs[1]);
      const list = checks(runs[1]);
      return ok({ total_count: list.length, check_runs: list });
    }
    if (/\/commits\/[0-9a-f]{40}\/status\?/.test(u)) return ok({ state: "pending", statuses: [] });
    const jobRead = /\/actions\/jobs\/(\d+)(\/logs)?$/.exec(u);
    if (jobRead && !jobRead[2]) {
      const listed = checks(null).find((run) => run.id === Number(jobRead[1]));
      return ok({ id: Number(jobRead[1]), head_sha: listed?.head_sha ?? null });
    }
    if (jobRead) {
      return { status: 200, ok: true, json: async () => null, body: (async function* () {
        yield "2026-09-10T11:59:00.0000000Z not ok 3 - widget renders the empty state\n";
        yield "2026-09-10T11:59:00.0000000Z AssertionError [ERR_ASSERTION]: expected 2 to equal 3\n";
      })() };
    }
    return h.fetchImpl(url, opts);
  };
  const contexts = [];
  const adapterModules = Object.fromEntries(Object.entries(h.adapters).map(([name, adapter]) => [name, {
    ...adapter,
    async launchBuilder(order) {
      contexts.push({ lane: name, attempt_id: order.attempt_id, target_sha: order.target_sha, task_context: order.task_context });
      return adapter.launchBuilder(order);
    },
  }]));
  const tick = (options = {}) => h.runTick({ ...options, io: { fetchImpl, adapterModules, ...(options.io ?? {}) } });
  return { reads, contexts, tick };
}

// Drive one armed episode to a completed build whose push moved the branch to
// SHA_WRITE; the next tick routes its review.
async function builtEpisode({ ci = ON, checks, config = {} } = {}) {
  const h = createEpisodeHarness({ githubToken: "ghtok", configOverrides: { ...config, ...(ci ? { ci_before_review: ci } : {}) } });
  const world = ciWorld(h, { checks });
  await world.tick();
  const build = h.launched[0];
  h.branchHead.value = SHA_WRITE;
  h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
  h.completeRun(build.run_id);
  await world.tick();
  assert.equal(h.receiptFor(build.attempt_id).stage, "COMPLETED", "precondition: the pushed build folds");
  return { h, world, build };
}

test("CI before review: with the flag off the review is dispatched exactly as today and no check is read", async () => {
  const { h, world } = await builtEpisode({ ci: null, checks: (head) => [job(201, head ?? SHA_WRITE)] });
  try {
    await world.tick();
    assert.equal(h.triggers["claude-code"], 1, "the review launched");
    assert.equal(h.launched.at(-1).target_sha, SHA_WRITE);
    assert.deepEqual(world.reads, [], "no CI read with the flag off");
  } finally { h.cleanup(); }
});

test("CI before review: green checks at the build head dispatch the review", async () => {
  const { h, world } = await builtEpisode({ checks: (head) => [job(101, head ?? SHA_WRITE, "success")] });
  try {
    const t = await world.tick();
    assert.deepEqual(world.reads, [SHA_WRITE], "CI is read at the exact build head");
    assert.equal(h.triggers["claude-code"], 1, "green reviews as before");
    assert.match(t.text, /ci-before-review: review b{40} — CI is green/);
    const review = h.latestFor("claude-verifier");
    assert.equal(review.target_sha, SHA_WRITE);
    assert.ok(!review.notes.some((note) => note.startsWith("ci-before-review:")), "a green review carries no CI note");
  } finally { h.cleanup(); }
});

test("CI before review: pending checks hold the review, and a later tick dispatches it once green", async () => {
  let green = false;
  const { h, world } = await builtEpisode({ checks: (head) => [green ? job(101, head ?? SHA_WRITE, "success") : { ...job(101, head ?? SHA_WRITE, "success"), status: "in_progress", conclusion: null }] });
  try {
    const held = await world.tick({ now: new Date(NOW.getTime() + 10 * MINUTE) });
    assert.equal(h.triggers["claude-code"], 0, "pending CI holds the review");
    assert.equal(h.triggers["codex-cli"], 1, "and starts nothing else");
    assert.equal(h.receipts().filter((r) => r.attempt_id !== h.launched[0].attempt_id).length, 0, "nothing is reserved while CI runs");
    assert.match(held.text, /ci-before-review: HOLD review of b{40} — CI has not settled \(checks are still running\)/);
    green = true;
    await world.tick({ now: new Date(NOW.getTime() + 12 * MINUTE) });
    assert.equal(h.triggers["claude-code"], 1, "the next tick re-checks and reviews");
  } finally { h.cleanup(); }
});

test("CI before review: checks still pending past wait_minutes dispatch the review with a note that CI did not settle", async () => {
  const { h, world } = await builtEpisode({ checks: () => [] });
  try {
    await world.tick({ now: new Date(NOW.getTime() + 44 * MINUTE) });
    assert.equal(h.triggers["claude-code"], 0, "inside the wait nothing reported holds");
    await world.tick({ now: new Date(NOW.getTime() + 46 * MINUTE) });
    assert.equal(h.triggers["claude-code"], 1, "past the wait the review goes as before");
    const review = h.latestFor("claude-verifier");
    assert.ok(review.notes.some((note) => /^ci-before-review: CI did not settle within 45 minutes/.test(note)), review.notes.join(" | "));
  } finally { h.cleanup(); }
});

test("CI before review: red checks dispatch a CI revise to the writer with ci-findings bound to the build head", async () => {
  const { h, world, build } = await builtEpisode({ checks: (head) => [job(201, head ?? SHA_WRITE), job(101, head ?? SHA_WRITE, "success")] });
  try {
    const t = await world.tick();
    assert.equal(h.triggers["claude-code"], 0, "no review is spent on a red head");
    assert.equal(h.triggers["codex-cli"], 2, "the writer gets the head back");
    const revise = h.receipts().find((r) => r.attempt_id !== build.attempt_id);
    const review = routing.freshAttempt(build.attempt_id, "review", 1);
    assert.equal(revise.attempt_id, routing.freshAttempt(review, "ci-revise", 1), "the CI revise attempt is derived, not random");
    assert.equal(revise.requested_worker, "codex-builder");
    assert.equal(revise.target_sha, SHA_WRITE);
    assert.equal(revise.scope_phase, "revision");
    assert.equal(revise.review_findings.source, "ci");
    assert.equal(revise.review_findings.target_sha, SHA_WRITE, "the findings bind the build head");
    assert.match(revise.review_findings.summary, /^Failing checks: application-checks: failure\n/);
    assert.match(revise.review_findings.summary, /not ok 3 - widget renders the empty state/, "the failing log tail is carried");
    assert.deepEqual(revise.review_findings.links, [`check-run/201@${SHA_WRITE}`]);
    const prompt = world.contexts.find((c) => c.attempt_id === revise.attempt_id)?.task_context ?? "";
    assert.match(prompt, /CI failed at b{40}/);
    assert.match(prompt, /<ci-findings>.*not ok 3 - widget renders the empty state.*<\/ci-findings>/s);
    assert.match(t.text, /CI is red \(application-checks: failure\) at b{40} — CI revise 1\/2 via codex-builder/);
  } finally { h.cleanup(); }
});

test("CI before review: a failing advisory third-party check neither holds nor revises the head; the landing's external policy decides", async () => {
  const advisory = (head) => ({ id: 301, name: "seer-advisory", status: "completed", conclusion: "failure", head_sha: head, app: { slug: "seer-by-sentry" } });
  const { h, world } = await builtEpisode({ config: { external_checks: { required: ["sentry"] } },
    checks: (head) => [job(101, head ?? SHA_WRITE, "success"), advisory(head ?? SHA_WRITE)] });
  try {
    await world.tick();
    assert.equal(h.triggers["codex-cli"], 1, "no CI revise for an advisory check");
    assert.equal(h.triggers["claude-code"], 1, "the review is dispatched");
    assert.equal(h.latestFor("claude-verifier").target_sha, SHA_WRITE);
  } finally { h.cleanup(); }
});

test("CI before review: a failing third-party check the policy names as required still mints a CI revise", async () => {
  const required = (head) => ({ id: 302, name: "sentry-checks", status: "completed", conclusion: "failure", head_sha: head, app: { slug: "sentry" } });
  const { h, world } = await builtEpisode({ config: { external_checks: { required: ["sentry"] } },
    checks: (head) => [job(101, head ?? SHA_WRITE, "success"), required(head ?? SHA_WRITE)] });
  try {
    await world.tick();
    assert.equal(h.triggers["claude-code"], 0, "no review is spent on a head a required check failed");
    assert.equal(h.triggers["codex-cli"], 2, "the writer gets the head back");
  } finally { h.cleanup(); }
});

test("CI before review: after max_ci_revise CI revises a red head is reviewed, and the revises spent no review round", async () => {
  const red = (head) => [job(head === SHA_WRITE ? 201 : head === SHA_REVISED ? 202 : 203, head ?? SHA_WRITE)];
  const { h, world } = await builtEpisode({ checks: (head) => (head ? red(head) : [job(201, SHA_WRITE), job(202, SHA_REVISED), job(203, "e".repeat(40))]) });
  try {
    for (const [from, to] of [[SHA_WRITE, SHA_REVISED], [SHA_REVISED, "e".repeat(40)]]) {
      await world.tick();
      const revise = h.launched.at(-1);
      assert.equal(revise.lane, "codex-cli", `a CI revise of ${from.slice(0, 4)}`);
      h.branchHead.value = to;
      h.postCallback({ attemptId: revise.attempt_id, stage: "REVISION_READY", targetSha: from, resultSha: to });
      h.completeRun(revise.run_id);
      await world.tick();
      assert.equal(h.receiptFor(revise.attempt_id).stage, "COMPLETED", "the CI revise folds like any revise");
      assert.equal(h.receiptFor(revise.attempt_id).review_findings?.source, "ci", "its CI findings stay on the durable receipt");
    }
    assert.equal(routing.ciReviseCount(h.receipts()), 2);
    await world.tick();
    assert.equal(h.triggers["codex-cli"], 3, "no third CI revise");
    assert.equal(h.triggers["claude-code"], 1, "the cap spent, the red head is reviewed as before");
    const review = h.latestFor("claude-verifier");
    assert.equal(review.target_sha, "e".repeat(40));
    assert.ok(review.notes.some((note) => /max_ci_revise 2 reached/.test(note)), review.notes.join(" | "));
  } finally { h.cleanup(); }
});

// The shipped setting itself: every other test injects its own gate, so this one
// reads the committed config.json and drives an armed episode with exactly the
// ci_before_review block it ships.
test("CI before review: the committed config.json turns the gate on, and its settings send a red build head back to the writer", async () => {
  const committed = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  assert.deepEqual(routing.ciBeforeReviewSettings(committed), SETTINGS, "the committed gate is on with 45 minutes and 2 revises");
  const { h, world } = await builtEpisode({ ci: committed.ci_before_review, checks: (head) => [job(201, head ?? SHA_WRITE)] });
  try {
    await world.tick();
    assert.ok(world.reads.length > 0 && world.reads.every((sha) => sha === SHA_WRITE), "the committed gate reads CI at the build head");
    assert.equal(h.triggers["claude-code"], 0, "no review is spent on a red head");
    assert.equal(h.triggers["codex-cli"], 2, "the writer gets the head back");
  } finally { h.cleanup(); }
});
