// SHU-71: routing reads an issue's receipts as lineage order, newest write last.
// Linear returned SHU-140's comments newest first, so the parsed list came out
// reversed and a review's revision was routed to the OLDEST writer on the card
// (a v1 Codex build) instead of the Claude writer whose head was reviewed.
// Replaying try 5's receipts showed it. The parser now orders receipts by when
// each attempt was first written, whatever order the comments arrive in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReceipt, foldLaunchOutcome, parseReceiptsFromComments, receiptCommentBody } from "../reconcile.mjs";
import { laneForRuntimeRole } from "../launch-vocabulary.mjs";
import { routeSuccessorFromReceipts } from "../review-routing.mjs";

const S = "5".repeat(40);
const W = "6".repeat(40);
const OLD_BASE = "7".repeat(40);
const OLD_RESULT = "8".repeat(40);
const ACTOR = "linear-actor-coordinator";
let n = 0;
const id = () => `bbbbbbbb-cccc-4ddd-8eee-${String(++n).padStart(12, "0")}`;

function receipt(role, runtime, { target_sha, episode_id }) {
  const made = createReceipt({ receipt_version: "1.1.0", role, runtime, requested_worker: laneForRuntimeRole(runtime, role),
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-140", target_sha, episode_id, attempt_id: id(), reserved_at: "2026-10-01T05:00:00.000Z" });
  assert.equal(made.ok, true, made.reason);
  return made.receipt;
}
function finish(r, stage, { result_sha = null, actor, lineage = [] }) {
  const head = result_sha ?? r.target_sha;
  return foldLaunchOutcome(r, { stage: "COMPLETED", external_run_id: `fixture_${r.attempt_id}`, worker_identity: actor,
    callback: { attempt_id: r.attempt_id, target_sha: r.target_sha, result_sha, stage, links: ["https://example.invalid/evidence"] } },
  { current_head: head, expected_head: head, lineage, now: () => new Date("2026-10-01T05:01:00.000Z") }).receipt;
}
const comment = (r, createdAt) => ({ body: receiptCommentBody(r), createdAt, user: { id: ACTOR } });

function card(verdict) {
  // An untagged 2026-09-10 Codex build, then this episode's Claude build and the Codex review of it.
  const old = finish(receipt("build", "codex-cli", { target_sha: OLD_BASE, episode_id: null }), "BUILD_READY",
    { result_sha: OLD_RESULT, actor: "codex:v1-builder" });
  const build = finish(receipt("build", "claude-code", { target_sha: S, episode_id: "shu71-reversed-5" }), "BUILD_READY",
    { result_sha: W, actor: "claude:writer" });
  const review = finish(receipt("review", "codex-cli", { target_sha: W, episode_id: "shu71-reversed-5" }), verdict,
    { actor: "codex:reviewer", lineage: [old, build] });
  assert.deepEqual([review.stage, review.verdict_stage], ["HOLD", verdict]);
  // Linear's order: newest first. The old build is re-posted last, as a dangling
  // sweep may do; its place stays that of its FIRST comment.
  const comments = [
    comment(old, "2026-10-01T05:20:00.000Z"),
    comment(review, "2026-10-01T05:10:00.000Z"),
    comment(build, "2026-10-01T05:00:00.000Z"),
    comment(old, "2026-09-10T12:00:00.000Z"),
  ];
  return { old, build, review, comments };
}

test("SHU71_RECEIPT_ORDER: receipts come back oldest first whatever order Linear returns comments in", () => {
  const { old, build, review, comments } = card("BLOCKED");
  const ids = (list) => parseReceiptsFromComments(list, [ACTOR]).map((r) => r.attempt_id);
  const expected = [old.attempt_id, build.attempt_id, review.attempt_id];
  assert.deepEqual(ids(comments), expected, "newest-first comments");
  assert.deepEqual(ids([...comments].reverse()), expected, "oldest-first comments");
  assert.deepEqual(ids([comments[2], comments[0], comments[3], comments[1]]), expected, "shuffled comments");
  // Untimestamped comments keep their array order, ahead of timestamped ones.
  const bare = comments.map(({ body, user }) => ({ body, user }));
  assert.deepEqual(ids([bare[2], bare[1], comments[3]]), [build.attempt_id, review.attempt_id, old.attempt_id]);
});

test("SHU71_RECEIPT_ORDER_ROUTE: a Codex BLOCK or FAILED review of a Claude build revises with Claude, not the card's oldest writer", () => {
  for (const verdict of ["BLOCKED", "FAILED"]) {
    const { review, comments } = card(verdict);
    const once = comments.slice(1); // each receipt written once, newest first
    const routed = routeSuccessorFromReceipts({ issueReceipts: parseReceiptsFromComments(once, [ACTOR]), terminal: review,
      evidenceStage: verdict, authoritativeHead: W, max_revise: 3 });
    assert.equal(routed.ok, true, `${verdict}: ${routed.reason}`);
    assert.deepEqual([routed.order.role, routed.order.runtime, routed.order.actor, routed.order.requested_worker],
      ["revise", "claude-code", "claude:writer", laneForRuntimeRole("claude-code", "revise")], verdict);
  }
});
