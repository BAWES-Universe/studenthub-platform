// SHU-71, 26 Nov: two card workers started together, and both coordinators
// settled the same ended episode's review: two identical HOLD receipts for one
// attempt, a second apart. A cross-card lifecycle write is published by one
// card worker only (ownsCrossCardSettles), however many reconcile at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReceipt, nextReceiptState, receiptCommentBody, ownsCrossCardSettles, workerOfActivation, ENDED_EPISODE_REVIEW } from "../reconcile.mjs";
import { workerActivationFile, MAX_CARD_WORKERS } from "../service/credential-delivery.mjs";
import { SUPERVISOR_PROTOCOL_VERSION } from "../supervisor.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const DESK = "SHU-304";
const REPO = "BAWES-Universe/studenthub-platform";
const HEAD = "a".repeat(40);
const BASE = "e".repeat(40);
const SUPERVISOR_SECRET = "s".repeat(48);
const EPISODE = "shu-304-run-20260909T230000Z";

// The durable FAILED record the supervisor that ran the attempt holds.
const failedAnswer = (order) => ({ version: SUPERVISOR_PROTOCOL_VERSION, ok: true, durable: true, attempt_id: order.attempt_id,
  target_sha: order.target_sha, stage: "FAILED", launch_receipt: { attempt_id: order.attempt_id }, heartbeat: null, result: null });

// One board, holding another card's review stuck at LAUNCH_UNKNOWN from an
// episode that has ended. Each tick is a card worker's coordinator scoped to
// its own card (SHU-140), so the review is due on every one of them.
function endedReviewBoard() {
  const h = createEpisodeHarness({ configOverrides: { workers: { max: 2 }, dispatch_scope: { issue_ids: ["SHU-140"] } },
    extraNodes: [{ id: "uuid-SHU-304", identifier: DESK, title: "review desk", state: { name: "Todo" }, priorityLabel: "Low",
      labels: { nodes: [{ name: "repo:platform" }] }, assignee: null, delegate: null, parent: null, relations: { nodes: [] } }] });
  const made = createReceipt({ receipt_version: "1.1.0", issue_id: DESK, authorization_ref: DESK, requested_worker: "codex-verifier",
    role: "review", runtime: "codex-cli", repo: REPO, branch: "feature/reviewed", target_sha: HEAD,
    workspace_scope: "full", scope_phase: "review", episode_id: EPISODE, review_base_sha: BASE });
  assert.ok(made.ok, JSON.stringify(made.errors));
  const unknown = nextReceiptState(made.receipt, { type: "launch" }).receipt;
  h.comments.push({ body: receiptCommentBody(unknown), createdAt: unknown.last_activity });
  const holds = () => h.comments.filter((c) => c.body.includes(unknown.attempt_id) && c.body.includes(`held: ${ENDED_EPISODE_REVIEW}`)).length;
  // Each status answer yields first, so concurrent ticks interleave as two
  // processes would: both have read the board before either writes.
  const tick = (io = {}) => h.runTick({ env: { SHU_SUPERVISOR_SECRET: SUPERVISOR_SECRET }, io: {
    supervisorTransport: async ({ request }) => { await new Promise((resolve) => setImmediate(resolve)); return failedAnswer(request.order); },
    ...io } });
  return { h, unknown, holds, tick };
}

test("CROSS_CARD_SETTLE_RACE: without an owner, two concurrent reconciles each publish the HOLD (the 26 Nov duplicate)", async () => {
  const { h, holds, tick } = endedReviewBoard();
  try {
    await Promise.all([tick(), tick()]);
    assert.equal(holds(), 2, "the race the fix closes is reproduced by this fixture");
  } finally { h.cleanup(); }
});

test("CROSS_CARD_SETTLE_ONCE: two card workers reconciling the same ended-episode review at once publish exactly one HOLD", async () => {
  const { h, unknown, holds, tick } = endedReviewBoard();
  try {
    // Both card runs hold their run locks, as workers 1 and 2 did at 04:00.
    const bothRunning = (worker) => worker === 1 || worker === 2;
    const [one, two] = await Promise.all([
      tick({ cardWorker: 1, cardRunLockHeld: bothRunning }),
      tick({ cardWorker: 2, cardRunLockHeld: bothRunning }),
    ]);
    assert.equal(holds(), 1, `exactly one HOLD comment\n--- worker 1\n${one.text}\n--- worker 2\n${two.text}`);
    assert.equal(h.receiptFor(unknown.attempt_id).stage, "HOLD");
    assert.match(two.text, /ENDED_EPISODE_REVIEW SHU-304 attempt \S+ LAUNCH_UNKNOWN in episode \S+ left to a lower card worker/);
    assert.match(one.text, /LAUNCH_UNKNOWN -> HOLD \(ENDED_EPISODE_REVIEW/);
    // A later tick of either worker reads the HOLD and writes nothing more.
    await Promise.all([tick({ cardWorker: 1, cardRunLockHeld: bothRunning }), tick({ cardWorker: 2, cardRunLockHeld: bothRunning })]);
    assert.equal(holds(), 1, "the settled review is not settled again");
  } finally { h.cleanup(); }
});

test("CROSS_CARD_SETTLE_LIVENESS: with no lower worker running, worker 2 settles the review itself", async () => {
  const { h, unknown, holds, tick } = endedReviewBoard();
  try {
    const run = await tick({ cardWorker: 2, cardRunLockHeld: (worker) => worker === 2 });
    assert.equal(holds(), 1, run.text);
    assert.equal(h.receiptFor(unknown.attempt_id).stage, "HOLD");
  } finally { h.cleanup(); }
});

test("CROSS_CARD_SETTLE_OWNER: the lowest running card worker owns cross-card writes; an unreadable lock defers", () => {
  assert.equal(ownsCrossCardSettles(1, () => true), true, "worker 1 always owns");
  assert.equal(ownsCrossCardSettles(null, () => true), true, "no card worker named: one coordinator, as before");
  assert.equal(ownsCrossCardSettles(2, (n) => n === 1), false, "worker 1 running");
  assert.equal(ownsCrossCardSettles(2, () => false), true, "worker 1 not running");
  assert.equal(ownsCrossCardSettles(3, (n) => n === 2), false, "worker 2 running");
  assert.equal(ownsCrossCardSettles(3, () => false), true);
  assert.equal(ownsCrossCardSettles(2, () => { throw new Error("EACCES"); }), false, "unreadable counts as held");
  for (let worker = 1; worker <= MAX_CARD_WORKERS; worker += 1) assert.equal(workerOfActivation(workerActivationFile(worker)), worker);
  assert.equal(workerOfActivation("/tmp/activation.json"), null);
  assert.equal(workerOfActivation(null), null);
});
