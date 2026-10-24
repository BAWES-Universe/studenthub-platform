// SHU-71 stage-4 try 5: Claude built SHU-140 and a Codex review of that build
// was refused as "review runtime is an author family of the reviewed lineage".
// The lineage was every receipt ever written for SHU-140, including the v1 runs'
// Codex builds on lane states the reviewed head does not contain. A review in an
// episode is judged against the work its head contains: this episode's attempts
// and any earlier write the head was built on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
import { laneForRuntimeRole } from "../launch-vocabulary.mjs";
import { reviewedLineage, reviewVerdictProvenanceValid } from "../review-routing.mjs";
import { episodeVerdict } from "../single-run-activation.mjs";

const S = "5".repeat(40);         // the episode's seed (not produced by any receipt)
const W = "6".repeat(40);         // what this episode's Claude build produced
const OLD_BASE = "7".repeat(40);  // an earlier episode's lane state
const OLD_RESULT = "8".repeat(40);
const EPISODE = "shu71-reversed-5";
let n = 0;
const id = () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, "0")}`;

function receipt(role, runtime, { target_sha, episode_id = EPISODE } = {}) {
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
// A v1-era Codex build of SHU-140 on a lane state this episode never contains.
const oldCodexBuild = (episode_id = "shu71-v1-run-6") =>
  finish(receipt("build", "codex-cli", { target_sha: OLD_BASE, episode_id }), "BUILD_READY", { result_sha: OLD_RESULT, actor: "codex:v1-builder" });
const claudeBuild = () => finish(receipt("build", "claude-code", { target_sha: S }), "BUILD_READY", { result_sha: W, actor: "claude:writer" });
const codexReview = (verdict, lineage) =>
  finish(receipt("review", "codex-cli", { target_sha: W }), verdict, { actor: "codex:reviewer", lineage });

test("SHU71_LINEAGE_OTHER_EPISODE: a Codex build on a lane state this head does not contain is not an author", () => {
  const history = [oldCodexBuild(), oldCodexBuild(null)];
  const build = claudeBuild();
  const lineage = [...history, build];
  assert.deepEqual(reviewedLineage(codexReview("PASS", []), lineage), [build]);
  const review = codexReview("PASS", lineage);
  assert.equal(review.stage, "COMPLETED", review.notes?.at(-1));
  assert.deepEqual(reviewVerdictProvenanceValid(review, [...lineage, review]), { ok: true });
});

test("SHU71_LINEAGE_ANCESTOR: an earlier Codex write the head was built on still makes Codex an author", () => {
  // The earlier episode's Codex build produced S, the seed this episode built on.
  const seededByCodex = finish(receipt("build", "codex-cli", { target_sha: OLD_BASE, episode_id: "shu71-v1-run-6" }),
    "BUILD_READY", { result_sha: S, actor: "codex:v1-builder" });
  const build = claudeBuild();
  const review = codexReview("PASS", [seededByCodex, build]);
  assert.equal(review.stage, "HOLD");
  assert.match(reviewVerdictProvenanceValid(review, [seededByCodex, build, review]).reason, /author family of the reviewed lineage/);
  // and one link further back: Codex wrote the parent of the Claude revision that produced S.
  const grandparent = finish(receipt("build", "codex-cli", { target_sha: "9".repeat(40), episode_id: "old-a" }),
    "BUILD_READY", { result_sha: OLD_BASE, actor: "codex:older" });
  const parent = finish(receipt("revise", "claude-code", { target_sha: OLD_BASE, episode_id: "old-b" }),
    "REVISION_READY", { result_sha: S, actor: "claude:older" });
  const deep = codexReview("PASS", [grandparent, parent, build]);
  assert.match(reviewVerdictProvenanceValid(deep, [grandparent, parent, build, deep]).reason, /author family/);
  // An episode whose first act is a review of an earlier Codex result has no write of its own to start from.
  const earlier = oldCodexBuild();
  const firstReview = finish(receipt("review", "codex-cli", { target_sha: OLD_RESULT }), "PASS", { actor: "codex:reviewer", lineage: [earlier] });
  assert.equal(firstReview.stage, "HOLD");
  assert.match(reviewVerdictProvenanceValid(firstReview, [earlier, firstReview]).reason, /author family/);
});

test("SHU71_LINEAGE_UNRECORDED: an earlier write that started from this head and recorded no result still counts", () => {
  const held = { ...receipt("build", "codex-cli", { target_sha: S, episode_id: "shu71-reversed-4" }),
    stage: "HOLD", worker_identity: "codex:held", result_sha: undefined };
  const build = claudeBuild();
  const review = codexReview("PASS", [held, build]);
  assert.equal(review.stage, "HOLD", "it may have pushed before it ended, so it is treated as an author");
  assert.match(reviewVerdictProvenanceValid(review, [held, build, review]).reason, /author family/);
});

test("SHU71_LINEAGE_UNTAGGED: a review outside any episode keeps the whole issue as its lineage", () => {
  const history = [oldCodexBuild()];
  const build = finish(receipt("build", "claude-code", { target_sha: S, episode_id: null }), "BUILD_READY", { result_sha: W, actor: "claude:writer" });
  const review = finish(receipt("review", "codex-cli", { target_sha: W, episode_id: null }), "PASS",
    { actor: "codex:reviewer", lineage: [...history, build] });
  assert.equal(review.stage, "HOLD");
  assert.equal(reviewedLineage(review, [...history, build]).length, 2);
});

test("SHU71_LINEAGE_EPISODE: the episode routes a Codex BLOCK to the Claude reviser despite older Codex builds", () => {
  const history = [oldCodexBuild(), oldCodexBuild(null)];
  const build = claudeBuild();
  const review = codexReview("BLOCKED", [...history, build]);
  assert.deepEqual([review.stage, review.verdict_stage], ["HOLD", "BLOCKED"]);
  const verdict = episodeVerdict({ receipts: [...history, build, review], targetIssueId: "SHU-140",
    episodeScope: { episode_id: EPISODE, supersedes: new Set() }, authoritativeHead: W });
  assert.equal(verdict.ended, false, verdict.reason);
  assert.equal(verdict.successor?.role, "revise", verdict.reason);
  assert.equal(verdict.successor?.runtime, "claude-code");
});

// SHU-304 on #308 and #314: a review-only run's episode holds nothing but the
// review. When the run is acknowledged and completes inside one tick, the
// fold's lineage still has the review's own copy from before the ack, with no
// worker_identity. That copy is the reviewer, not an author.
const reviewOnly = () => {
  const reserved = receipt("review", "codex-cli", { target_sha: W, episode_id: "shu-304-run-review-only" });
  const stale = { ...reserved, stage: "LAUNCH_UNKNOWN" };
  return { reserved, stale };
};

test("SHU71_LINEAGE_OWN_ATTEMPT: a review's own pre-ack copy is not an unreadable author", () => {
  const { reserved, stale } = reviewOnly();
  assert.equal(stale.worker_identity ?? null, null);
  const review = finish(reserved, "PASS", { actor: "codex:reviewer", lineage: [stale] });
  assert.equal(review.stage, "COMPLETED", review.notes?.at(-1));
  assert.deepEqual(reviewedLineage(review, [stale]), []);
  assert.deepEqual(reviewVerdictProvenanceValid(review, [stale]), { ok: true });
  // Another attempt with no readable provenance is still refused.
  const other = { ...stale, attempt_id: id(), role: "build", runtime: "claude-code", requested_worker: laneForRuntimeRole("claude-code", "build") };
  assert.match(reviewVerdictProvenanceValid(review, [stale, other]).reason, /authorship ambiguous/);
  // A write that carries the review's own attempt id is not left out.
  const sameIdWrite = { ...other, attempt_id: review.attempt_id };
  assert.match(reviewVerdictProvenanceValid(review, [stale, sameIdWrite]).reason, /authorship ambiguous/);
  const held = finish(reviewOnly().reserved, "PASS", { actor: "codex:reviewer", lineage: [other] });
  assert.equal(held.stage, "HOLD", "an unreadable author still holds a PASS back");
});

test("SHU71_LINEAGE_OWN_ATTEMPT mutation: keeping the review's own copy in its lineage holds the verdict", () => {
  const coordinatorDir = fileURLToPath(new URL("..", import.meta.url));
  const temporary = fs.mkdtempSync(join(tmpdir(), "shu71-own-attempt-mutant-"));
  try {
    fs.cpSync(coordinatorDir, temporary, { recursive: true });
    const target = join(temporary, "review-routing.mjs");
    const original = fs.readFileSync(target, "utf8");
    const filter = "(r) => !ownReviewCopy(own, r)";
    assert.equal(original.split(filter).length - 1, 1, "the own-attempt filter must be uniquely present");
    fs.writeFileSync(target, original.replace(filter, "() => true"));
    const { reserved, stale } = reviewOnly();
    const scenario = `
      import { foldLaunchOutcome } from ${JSON.stringify("file://" + join(temporary, "reconcile.mjs"))};
      const r = ${JSON.stringify(reserved)};
      const out = foldLaunchOutcome(r, { stage: "COMPLETED", external_run_id: "fixture_" + r.attempt_id, worker_identity: "codex:reviewer",
        callback: { attempt_id: r.attempt_id, target_sha: r.target_sha, result_sha: null, stage: "PASS", links: ["https://example.invalid/evidence"] } },
        { current_head: r.target_sha, expected_head: r.target_sha, lineage: [${JSON.stringify(stale)}], now: () => new Date("2026-10-01T05:01:00.000Z") });
      console.log(JSON.stringify({ stage: out.receipt.stage }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, `mutant scenario crashed: ${child.stderr}`);
    assert.equal(JSON.parse(child.stdout.trim().split("\n").at(-1)).stage, "HOLD", "without the filter the review-only verdict is held");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
