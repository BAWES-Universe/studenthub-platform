// SHU-73 — exact-head verdict binding plus fail-closed review provenance.
//
// The current one-slot fixture routes build and review through structurally
// separate lanes. Worker identities contain attempt ids, so these tests do not
// claim stable actor independence across future role reversal; SHU-71 owns that
// acceptance. They do establish that a review verdict needs an adapter-observed
// session and that supplied-but-unreadable lineage cannot disappear into an
// empty author set at the terminal fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { workerIdentity as claudeWorkerIdentity } from "../adapters/claude-code.mjs";
import { workerIdentity as codexWorkerIdentity } from "../adapters/codex-cli.mjs";
import { reviewVerdictProvenanceValid } from "../review-routing.mjs";
import { nextReceiptState } from "../reconcile.mjs";

const SHA = "c".repeat(40);
const BUILD_ATTEMPT = "aaaaaaaa-1111-4222-8331-111111111111";
const REVIEW_ATTEMPT = "bbbbbbbb-2222-4222-8332-222222222222";
const BUILDER_SESSION = codexWorkerIdentity(BUILD_ATTEMPT);
const REVIEWER_SESSION = claudeWorkerIdentity(REVIEW_ATTEMPT);

function reviewReceipt({ worker_identity = REVIEWER_SESSION } = {}) {
  return {
    issue_id: "SHU-FIXTURE-073",
    attempt_id: REVIEW_ATTEMPT,
    authorization_ref: "SHU-73",
    stage: "RUNNING",
    requested_worker: "claude-verifier",
    worker_identity,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "fixture/shu73",
    target_sha: SHA,
    external_run_id: `clauderun_${REVIEW_ATTEMPT.replaceAll("-", "")}`,
    adapter_status: "in_progress",
    evidence_links: [],
    notes: [],
    last_activity: "2026-09-09T00:00:00.000Z",
    timestamps: { reserved: "2026-09-09T00:00:00.000Z", launch: "2026-09-09T00:00:01.000Z", heartbeat: null, terminal: null },
  };
}

function buildReceipt(overrides = {}) {
  return {
    issue_id: "SHU-FIXTURE-073",
    attempt_id: BUILD_ATTEMPT,
    authorization_ref: "SHU-73",
    stage: "COMPLETED",
    requested_worker: "codex-builder",
    worker_identity: BUILDER_SESSION,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "fixture/shu73",
    target_sha: SHA,
    result_sha: SHA,
    external_run_id: `codexrun_${BUILD_ATTEMPT.replaceAll("-", "")}`,
    adapter_status: "completed",
    evidence_links: ["https://github.com/BAWES-Universe/studenthub-platform/commit/cccc"],
    ...overrides,
  };
}

function passEvent() {
  return {
    type: "run_status",
    status: "completed",
    callback: {
      links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/48"],
      attempt_id: REVIEW_ATTEMPT,
      target_sha: SHA,
      stage: "PASS",
      result_sha: SHA,
    },
    worker_identity: REVIEWER_SESSION,
  };
}

test("SHU-73: current adapter identities exercise the production-shaped build/review prefixes", () => {
  assert.equal(BUILDER_SESSION, `codex:${BUILD_ATTEMPT}`);
  assert.equal(REVIEWER_SESSION, `claude:${REVIEW_ATTEMPT}`);
});

test("SHU-73: a production-shaped observed review session has readable lineage", () => {
  assert.deepEqual(reviewVerdictProvenanceValid(reviewReceipt(), [buildReceipt()]), { ok: true });
});

test("SHU-73: an unobserved review session fails closed", () => {
  const verdict = reviewVerdictProvenanceValid(reviewReceipt({ worker_identity: null }), [buildReceipt()]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ambiguous provenance/);
});

test("SHU-73: writer results are not review-provenance claims", () => {
  assert.deepEqual(reviewVerdictProvenanceValid({ ...buildReceipt(), stage: "RUNNING" }, [buildReceipt()]), { ok: true });
});

test("SHU-73: a standalone observed review falls back only to session presence", () => {
  assert.deepEqual(reviewVerdictProvenanceValid(reviewReceipt(), []), { ok: true });
});

test("SHU-73: supplied lineage with no readable provenance fails closed", () => {
  const unreadable = [buildReceipt({ worker_identity: null })];
  const verdict = reviewVerdictProvenanceValid(reviewReceipt(), unreadable);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no readable provenance/);
});

test("SHU-73: the defensive session comparison rejects a represented author match", () => {
  const verdict = reviewVerdictProvenanceValid(reviewReceipt({ worker_identity: BUILDER_SESSION }), [buildReceipt()]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /is an author/);
});

test("SHU-73: a production-shaped observed PASS completes without invented evidence classes", () => {
  const transition = nextReceiptState(reviewReceipt(), passEvent(), { current_head: SHA, lineage: [buildReceipt()] });
  assert.equal(transition.accepted, true);
  assert.equal(transition.receipt.stage, "COMPLETED");
  assert.equal(Object.hasOwn(transition.receipt, "verdict_evidence"), false);
});

test("SHU-73: an unobserved PASS folds to HOLD", () => {
  const transition = nextReceiptState(reviewReceipt({ worker_identity: null }), passEvent(), { current_head: SHA, lineage: [buildReceipt()] });
  assert.equal(transition.receipt.stage, "HOLD");
  assert.match(transition.receipt.notes.at(-1), /provenance is not closable/);
});

test("SHU-73: unreadable supplied lineage folds to HOLD", () => {
  const transition = nextReceiptState(reviewReceipt(), passEvent(), {
    current_head: SHA,
    lineage: [buildReceipt({ worker_identity: null })],
  });
  assert.equal(transition.receipt.stage, "HOLD");
  assert.match(transition.receipt.notes.at(-1), /no readable provenance/);
});

test("SHU-73: stale-head PASS still folds to HOLD", () => {
  const transition = nextReceiptState(reviewReceipt(), passEvent(), { current_head: "f".repeat(40), lineage: [buildReceipt()] });
  assert.equal(transition.receipt.stage, "HOLD");
});

test("SHU-73: the removed direct callback event cannot complete a receipt", () => {
  const receipt = reviewReceipt();
  const transition = nextReceiptState(receipt, {
    type: "callback",
    links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/48"],
    attempt_id: REVIEW_ATTEMPT,
    target_sha: SHA,
    stage: "PASS",
  }, { current_head: SHA, lineage: [buildReceipt()] });
  assert.equal(transition.accepted, false);
  assert.equal(transition.receipt, receipt);
  assert.match(transition.reason, /unknown event type/);
});

test("SHU-73 mutation: removing the unreadable-lineage guard wrongly completes", () => {
  const coordinatorDir = fileURLToPath(new URL("..", import.meta.url));
  const temporary = fs.mkdtempSync(join(tmpdir(), "shu73-lineage-mutant-"));
  try {
    fs.cpSync(coordinatorDir, temporary, { recursive: true });
    const target = join(temporary, "review-routing.mjs");
    const original = fs.readFileSync(target, "utf8");
    const guard = `  if (supplied.length > 0 && entries.length === 0) {
    return { ok: false, reason: "reviewed lineage carries no readable provenance — authorship ambiguous" };
  }`;
    assert.equal(original.split(guard).length - 1, 1, "unreadable-lineage guard must be uniquely present");
    const mutated = original.replace(guard, "  // SHU73-UNREADABLE-LINEAGE-GUARD-REMOVED");
    assert.equal(mutated.includes(guard), false, "guard removal must land");
    assert.equal(mutated.includes("SHU73-UNREADABLE-LINEAGE-GUARD-REMOVED"), true, "mutation marker must land");
    fs.writeFileSync(target, mutated);

    const scenario = `
      import { nextReceiptState } from ${JSON.stringify("file://" + join(temporary, "reconcile.mjs"))};
      const review = ${JSON.stringify(reviewReceipt())};
      const event = ${JSON.stringify(passEvent())};
      const unreadable = [${JSON.stringify(buildReceipt({ worker_identity: null }))}];
      const out = nextReceiptState(review, event, { current_head: ${JSON.stringify(SHA)}, lineage: unreadable });
      console.log(JSON.stringify({ stage: out.receipt.stage }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, `mutant scenario crashed: ${child.stderr}`);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.stage, "COMPLETED", "without the guard, unreadable lineage must wrongly complete");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
