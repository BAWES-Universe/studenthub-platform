// shu73-enforcement.test.mjs — machine-enforced exact-head + author/provenance
// independence at VERDICT FOLD time (SHU-73, Hermes 2026-09-09).
//
// Covers:
//   1. reviewVerdictIndependent unit gates (review-routing.mjs)
//   2. classifyEvidenceLinks / hasIndependentEvidence (reconcile.mjs)
//   3. Fold integration through nextReceiptState: a conforming independent PASS
//      completes; an author-session PASS holds; an unobserved review verdict
//      holds; a privileged-attestation-only PASS holds.
//   4. Mutation proof (Opus standard — prove the mutation landed, then show the
//      mutant misbehaves): each load-bearing guard is removed in a COPY of the
//      coordinator (never the working tree), the mutation is marker-verified as
//      applied, and a child process running against the mutated copy shows the
//      fold WRONGLY completes — proving the guard is what refuses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { reviewVerdictIndependent } from "../review-routing.mjs";
import { classifyEvidenceLinks, hasIndependentEvidence, nextReceiptState } from "../reconcile.mjs";

const SHA = "c".repeat(40);
const BUILDER_SESSION = "claude:builder-y";
const REVIEWER_SESSION = "claude:reviewer-x";

function reviewReceipt({ worker_identity = REVIEWER_SESSION, attempt = "bbbbbbbb-2222-4222-8332-222222222222" } = {}) {
  return {
    issue_id: "SHU-FIXTURE-073",
    attempt_id: attempt,
    authorization_ref: "SHU-73",
    stage: "RUNNING",
    requested_worker: "claude-verifier",
    worker_identity,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "fixture/shu73",
    target_sha: SHA,
    external_run_id: "run_123",
    adapter_status: "in_progress",
    evidence_links: [],
    notes: [],
    last_activity: "2026-09-09T00:00:00.000Z",
    timestamps: { reserved: "2026-09-09T00:00:00.000Z", launch: "2026-09-09T00:00:01.000Z", heartbeat: null, terminal: null },
  };
}

function buildReceipt() {
  return {
    issue_id: "SHU-FIXTURE-073",
    attempt_id: "aaaaaaaa-1111-4222-8331-111111111111",
    authorization_ref: "SHU-73",
    stage: "COMPLETED",
    requested_worker: "codex-builder",
    worker_identity: BUILDER_SESSION,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "fixture/shu73",
    target_sha: SHA,
    result_sha: SHA,
    external_run_id: "run_122",
    adapter_status: "completed",
    evidence_links: ["https://github.com/BAWES-Universe/studenthub-platform/commit/cccc"],
  };
}

const lineage = [buildReceipt()];

function passEvent(links) {
  return {
    type: "run_status",
    status: "completed",
    callback: { links, attempt_id: reviewReceipt().attempt_id, target_sha: SHA, stage: "PASS", result_sha: SHA },
    worker_identity: REVIEWER_SESSION,
  };
}

// ---------------------------------------------------------------------------
// 1. reviewVerdictIndependent unit gates
// ---------------------------------------------------------------------------
test("SHU-73: an author session can never satisfy an independent review verdict", () => {
  const verdict = reviewVerdictIndependent(reviewReceipt({ worker_identity: BUILDER_SESSION }), lineage);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /is an author of the reviewed lineage/);
});

test("SHU-73: a distinct observed reviewer session satisfies the independence gate", () => {
  const verdict = reviewVerdictIndependent(reviewReceipt({ worker_identity: REVIEWER_SESSION }), lineage);
  assert.equal(verdict.ok, true);
});

test("SHU-73: an unobserved review verdict is ambiguous and fails closed", () => {
  const verdict = reviewVerdictIndependent(reviewReceipt({ worker_identity: null }), lineage);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ambiguous provenance/);
});

test("SHU-73: the independence rule constrains review lanes only, never writer verdicts", () => {
  const writer = { ...buildReceipt(), stage: "RUNNING", worker_identity: BUILDER_SESSION, requested_worker: "codex-builder" };
  const verdict = reviewVerdictIndependent(writer, lineage);
  assert.equal(verdict.ok, true);
});

test("SHU-73: a review with no lineage falls back to session-presence, never to default independence", () => {
  assert.equal(reviewVerdictIndependent(reviewReceipt({ worker_identity: null }), []).ok, false);
  assert.equal(reviewVerdictIndependent(reviewReceipt({ worker_identity: REVIEWER_SESSION }), []).ok, true);
});

// ---------------------------------------------------------------------------
// 2. Evidence classification
// ---------------------------------------------------------------------------
test("SHU-73: plain-string evidence links are independently checkable by default", () => {
  const classified = classifyEvidenceLinks(["https://github.com/x/pull/1"]);
  assert.deepEqual(classified, [{ url: "https://github.com/x/pull/1", evidence_class: "independently_checkable" }]);
  assert.equal(hasIndependentEvidence({ links: ["https://github.com/x/pull/1"] }), true);
});

test("SHU-73: privileged_attestation lines are preserved and cannot satisfy the independent-evidence requirement alone", () => {
  const links = [{ url: "https://coolify.internal/console", evidence_class: "privileged_attestation" }];
  assert.equal(classifyEvidenceLinks(links)[0].evidence_class, "privileged_attestation");
  assert.equal(hasIndependentEvidence({ links }), false);
});

test("SHU-73: one independent line among privileged lines satisfies the requirement", () => {
  const links = [
    { url: "https://coolify.internal/console", evidence_class: "privileged_attestation" },
    "https://staging.studenthub.co/health",
  ];
  assert.equal(hasIndependentEvidence({ links }), true);
});

// ---------------------------------------------------------------------------
// 3. Fold integration through nextReceiptState
// ---------------------------------------------------------------------------
test("SHU-73: a conforming independent PASS completes and records classified evidence", () => {
  const transition = nextReceiptState(reviewReceipt(), passEvent(["https://github.com/x/pull/1"]), { current_head: SHA, lineage });
  assert.equal(transition.accepted, true);
  assert.equal(transition.receipt.stage, "COMPLETED");
  assert.equal(transition.receipt.verdict_evidence[0].evidence_class, "independently_checkable");
});

test("SHU-73: a PASS from the author's own session HOLDS at the fold, never COMPLETED", () => {
  const transition = nextReceiptState(
    reviewReceipt({ worker_identity: BUILDER_SESSION }),
    { ...passEvent(["https://github.com/x/pull/1"]), worker_identity: BUILDER_SESSION },
    { current_head: SHA, lineage },
  );
  assert.equal(transition.accepted, true);
  assert.equal(transition.receipt.stage, "HOLD");
  assert.match(transition.receipt.notes.at(-1), /NOT independently closable/);
});

test("SHU-73: an unobserved review verdict folds HOLD at the fold", () => {
  const transition = nextReceiptState(reviewReceipt({ worker_identity: null }), passEvent(["https://github.com/x/pull/1"]), { current_head: SHA, lineage });
  assert.equal(transition.receipt.stage, "HOLD");
  assert.match(transition.receipt.notes.at(-1), /ambiguous provenance/);
});

test("SHU-73: a review PASS backed only by privileged attestation folds HOLD", () => {
  const links = [{ url: "https://coolify.internal/console", evidence_class: "privileged_attestation" }];
  const transition = nextReceiptState(reviewReceipt(), passEvent(links), { current_head: SHA, lineage });
  assert.equal(transition.receipt.stage, "HOLD");
  assert.match(transition.receipt.notes.at(-1), /independently checkable/);
});

test("SHU-73: a stale-head PASS still HOLDS (existing guard preserved on current main)", () => {
  const transition = nextReceiptState(reviewReceipt(), passEvent(["https://github.com/x/pull/1"]), { current_head: "f".repeat(40), lineage });
  assert.equal(transition.receipt.stage, "HOLD");
});

// ---------------------------------------------------------------------------
// 4. Mutation proof — copy the coordinator, remove ONE guard, marker-verify
// the mutation applied, then show the mutant WRONGLY completes the fold.
// ---------------------------------------------------------------------------
const COORDINATOR_DIR = fileURLToPath(new URL("..", import.meta.url)); // .github/coordinator/

function runAgainstMutatedCoordinator(mutate, { worker = BUILDER_SESSION, links = ["https://github.com/x/pull/1"], targetFile = "reconcile.mjs" } = {}) {
  const tmp = fs.mkdtempSync(join(tmpdir(), "shu73-mutant-"));
  try {
    fs.cpSync(COORDINATOR_DIR, tmp, { recursive: true });
    const target = join(tmp, targetFile);
    const original = fs.readFileSync(target, "utf8");
    const { mutated, markers } = mutate(original);
    fs.writeFileSync(target, mutated);
    // Marker proof the mutation actually landed on the copy.
    for (const [label, present, needle] of markers) {
      assert.equal(mutated.includes(needle), present, `mutation marker ${label} not in the state expected (needle ${needle})`);
    }
    const scenario = `
      import { nextReceiptState } from ${JSON.stringify("file://" + join(tmp, "reconcile.mjs"))};
      const SHA = "c".repeat(40);
      const review = { issue_id: "SHU-FIXTURE-073", attempt_id: "bbbbbbbb-2222-4222-8332-222222222222",
        authorization_ref: "SHU-73", stage: "RUNNING", requested_worker: "claude-verifier",
        worker_identity: ${JSON.stringify(worker)}, repo: "r", branch: "b", target_sha: SHA,
        external_run_id: "run_123", adapter_status: "in_progress", evidence_links: [],
        notes: [], last_activity: "2026-09-09T00:00:00.000Z",
        timestamps: { reserved: "2026-09-09T00:00:00.000Z", launch: "2026-09-09T00:00:01.000Z", heartbeat: null, terminal: null } };
      const build = { issue_id: "SHU-FIXTURE-073", attempt_id: "aaaaaaaa-1111-4222-8331-111111111111",
        authorization_ref: "SHU-73", stage: "COMPLETED", requested_worker: "codex-builder",
        worker_identity: ${JSON.stringify(BUILDER_SESSION)}, repo: "r", branch: "b", target_sha: SHA, result_sha: SHA,
        external_run_id: "run_122", adapter_status: "completed", evidence_links: [] };
      const event = { type: "run_status", status: "completed",
        callback: { links: ${JSON.stringify(links)}, attempt_id: review.attempt_id,
          target_sha: SHA, stage: "PASS", result_sha: SHA },
        worker_identity: ${JSON.stringify(worker)} };
      const out = nextReceiptState(review, event, { current_head: SHA, lineage: [build] });
      console.log(JSON.stringify({ stage: out.receipt.stage }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 0, `mutant scenario crashed: ${child.stderr}`);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("SHU-73 MUTATION A: removing fold-time author exclusion makes an author PASS wrongly COMPLETE", () => {
  // The author-exclusion guard lives in review-routing.mjs (reviewVerdictIndependent);
  // reconcile.mjs calls it at the fold. Mutate the module that owns the check.
  const result = runAgainstMutatedCoordinator(
    (src) => {
      const guard = "if (authors.has(receipt.worker_identity)) {";
      assert.ok(src.includes(guard), "author-exclusion guard present in the original");
      return {
        mutated: src.replace(guard, "if (false) { // SHU73-MUTATION-A"),
        markers: [
          ["A-guard-removed-in-mutant", false, guard],
          ["A-marker-applied", true, "SHU73-MUTATION-A"],
        ],
      };
    },
    { targetFile: "review-routing.mjs" },
  );
  // The unmutated fold HOLDS (covered above); the mutant must WRONGLY COMPLETE,
  // proving the author-exclusion line is what refuses the author's PASS.
  assert.equal(result.stage, "COMPLETED", "mutant without author exclusion must wrongly COMPLETE — guard is load-bearing");
});

test("SHU-73 MUTATION B: removing the independent-evidence requirement lets a privileged-only PASS wrongly COMPLETE", () => {
  const result = runAgainstMutatedCoordinator(
    (src) => {
      const segment = 'callback.stage !== "PASS" || hasIndependentEvidence(callback)';
      assert.ok(src.includes(segment), "independent-evidence requirement present in the original");
      return {
        // `|| true` disables the gate without breaking syntax; the marker comment
        // proves the mutation landed.
        mutated: src.replace(segment, 'callback.stage !== "PASS" || true /* SHU73-MUTATION-B */'),
        markers: [
          ["B-needle-removed", false, "|| hasIndependentEvidence(callback)"],
          ["B-marker-applied", true, "SHU73-MUTATION-B"],
        ],
      };
    },
    // Non-author reviewer + privileged-only evidence: the ONLY thing standing
    // between this verdict and COMPLETED is the independent-evidence gate.
    { worker: REVIEWER_SESSION, links: [{ url: "https://coolify.internal/console", evidence_class: "privileged_attestation" }] },
  );
  assert.equal(result.stage, "COMPLETED", "mutant without the independent-evidence gate must wrongly COMPLETE — gate is load-bearing");
});
