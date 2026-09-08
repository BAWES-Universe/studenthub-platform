// review-routing adversarial tests (SHU-68, Hermes claim 2026-09-07).
//
// Acceptance covered: role reversals, stale-head rejection (delegated to the
// existing callbackEvidenceValid tests — this suite covers routing), author
// exclusion across revisions, reviewer-turned-author rotation, no-reviewer
// exhaustion -> visible HOLD, automatic findings handoff, unsupported combos
// fail visibly, shared-identity/derived-identity never counts as independence.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORK_ORDER_VERSION,
  ROLES,
  RUNTIMES,
  validWorkOrder,
  capabilitiesFor,
  provenanceEntry,
  authorSet,
  eligibleReviewers,
  activeWriter,
  nextWorkOrder,
  freshAttempt,
  WORK_ORDER_MARKER,
  renderWorkOrderDirective,
  parseWorkOrderDirective,
} from "../review-routing.mjs";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function baseOrder(over = {}) {
  return {
    version: WORK_ORDER_VERSION,
    role: "build",
    runtime: "codex-cli",
    issue_id: "SHU-68",
    attempt_id: "11111111-1111-4111-8111-111111111111",
    target_sha: SHA,
    authorization_ref: "SHU-68",
    ...over,
  };
}

test("work order: all three roles are valid on runtimes that support them", () => {
  for (const runtime of RUNTIMES) {
    for (const role of ["build", "review", "revise"]) {
      const r = validWorkOrder(baseOrder({ role, runtime }));
      if (role === "review" || runtime !== "workspace-agents") {
        assert.equal(r.ok, true, `${runtime}/${role}: ${r.reason}`);
      }
    }
  }
});

test("work order: unknown role / unknown runtime / bad sha fail closed", () => {
  assert.equal(validWorkOrder(baseOrder({ role: "ship" })).ok, false);
  assert.equal(validWorkOrder(baseOrder({ runtime: "workspace-agents" })).ok, false);
  assert.equal(validWorkOrder(baseOrder({ target_sha: "short" })).ok, false);
  assert.equal(validWorkOrder(baseOrder({ attempt_id: "" })).ok, false);
  assert.equal(validWorkOrder(null).ok, false);
});

test("capabilities: review is read-only (no commit/push), build/revise are write roles", () => {
  assert.deepEqual(capabilitiesFor({ role: "review" }), ["read", "test"]);
  assert.ok(capabilitiesFor({ role: "build" }).includes("commit"));
  assert.ok(capabilitiesFor({ role: "revise" }).includes("worktree-write"));
  assert.ok(!capabilitiesFor({ role: "review" }).includes("commit"));
  assert.deepEqual(capabilitiesFor({}), []);
});

test("author set: build/revise actors are authors; a review actor that edited is an author", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  assert.deepEqual([...authorSet(entries)], ["codex:s1"]);
  const edited = [
    ...entries,
    provenanceEntry({ attempt_id: "3", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA, kind: "edited" }),
  ];
  assert.deepEqual([...authorSet(edited)].sort(), ["claude:v1", "codex:s1"]);
});

test("author exclusion: an author can never be an eligible reviewer of their own change", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  const eligible = eligibleReviewers(entries);
  assert.equal(eligible.some((e) => e.actor === "codex:s1"), false, "builder must not review own work");
  assert.equal(eligible.some((e) => e.actor === "claude:v1"), true, "independent reviewer remains eligible");
});

test("route: completed build -> independent review on a fresh attempt", () => {
  const entries = [
    provenanceEntry({ attempt_id: "11111111-1111-4111-8111-111111111111", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA, result_sha: SHA2 }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  const requested = baseOrder();
  const r = nextWorkOrder({ requested, entries, review_round: 0 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.order.role, "review");
  assert.equal(r.order.runtime, "claude-code");
  assert.equal(r.order.actor, "claude:v1");
  assert.notEqual(r.order.attempt_id, requested.attempt_id, "review must be a fresh attempt");
});

test("route: BLOCKED review -> revision routes back to the ACTIVE WRITER, same runtime", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  const requested = baseOrder({ role: "review", runtime: "claude-code", outcome: "BLOCKED", review_runtimes: ["claude-code"] });
  const r = nextWorkOrder({ requested, entries, review_round: 1 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.order.role, "revise");
  assert.equal(r.order.runtime, "codex-cli", "revision goes back to the writer's runtime");
  assert.equal(r.order.actor, "codex:s1");
});

test("route: reviewer that EDITED becomes an author and rotates out next round", () => {
  const build = provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA });
  const editReview = provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA, kind: "edited" });
  // After the editing reviewer, a NEW independent reviewer must be found:
  const fresh = provenanceEntry({ attempt_id: "3", actor: "hermes:h1", role: "review", runtime: "hermes-pool", target_sha: SHA });
  const entries = [build, editReview, fresh];
  const authors = authorSet(entries);
  assert.ok(authors.has("claude:v1"), "editing reviewer is now an author");
  const eligible = eligibleReviewers(entries);
  assert.equal(eligible.some((e) => e.actor === "claude:v1"), false, "edited-then-reviewing actor is ineligible");
  assert.equal(eligible.some((e) => e.actor === "hermes:h1"), true, "a genuinely fresh reviewer remains eligible");
});

test("route: no eligible reviewer -> visible HOLD, never a relaunch storm", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    // only the builder exists; no independent reviewer session anywhere
  ];
  const r = nextWorkOrder({ requested: baseOrder(), entries, review_round: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.hold, "no_eligible_reviewer");
  assert.equal(r.order, undefined, "no order minted -> no launch");
});

test("route: revisions are BOUND — exhaustion is a terminal HOLD at max_revise+1", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  // max_revise: 3 promises THREE revision attempts: rounds 1..3 each BLOCK
  // and each schedules its revision. Exhaustion begins only at round 4.
  const requested = baseOrder({ role: "review", runtime: "claude-code", outcome: "BLOCKED" });
  const r3 = nextWorkOrder({ requested, entries, review_round: 3, max_revise: 3 });
  assert.equal(r3.ok, true, `round 3 BLOCK must still schedule revision #3: ${r3.reason}`);
  assert.equal(r3.order.role, "revise");
  const r4 = nextWorkOrder({ requested, entries, review_round: 4, max_revise: 3 });
  assert.equal(r4.ok, false);
  assert.equal(r4.hold, "revisions_exhausted");
  assert.equal(r4.exhausted, true);
});

test("route: BLOCKED outcome NEVER leaks into successor orders (revise or next review)", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  // A completed BLOCKED review must produce a revise order born WITHOUT the
  // result-only outcome — a new instruction is not already completed/blocked.
  const requested = baseOrder({ role: "review", runtime: "claude-code", outcome: "BLOCKED", review_runtimes: ["claude-code"] });
  const revise = nextWorkOrder({ requested, entries, review_round: 1 });
  assert.equal(revise.ok, true, revise.reason);
  assert.equal(revise.order.role, "revise");
  assert.equal(revise.order.outcome, undefined, "revise order must not inherit outcome:BLOCKED");
  assert.equal("outcome" in revise.order, false, "result-only key must be stripped, not nulled");

  // A completed revise (outcome BUILD_READY) must produce a review order born
  // WITHOUT the completed outcome — same leak class on the review side.
  const revisedEntries = [...entries, provenanceEntry({ attempt_id: revise.order.attempt_id, actor: "codex:s1", role: "revise", runtime: "codex-cli", target_sha: SHA2, result_sha: SHA2 })];
  const review = nextWorkOrder({
    requested: { ...revise.order, role: "revise", outcome: "BUILD_READY", review_runtimes: ["claude-code"] },
    entries: revisedEntries,
    review_round: 1,
  });
  assert.equal(review.ok, true, review.reason);
  assert.equal(review.order.role, "review");
  assert.equal("outcome" in review.order, false, "review order must not inherit outcome:BUILD_READY");

  // Round-trip through the directive: a successor directive must render and
  // re-parse outcome-free. The renderer normalizes a missing outcome to null
  // (explicit in the directive JSON) — the leak would be a non-null inherited
  // value like "BLOCKED", which must never appear on a fresh instruction.
  const body = renderWorkOrderDirective(revise.order);
  const parsed = parseWorkOrderDirective(body);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.order.outcome, null, "successor directive must be born without a completed outcome");
});

test("route: malformed attempt_id is rejected before routing — no non-UUID successor can be minted", () => {
  // Codex repro: validWorkOrder accepted attempt_id "x", routing emitted a
  // non-UUID successor the receipt schema rejects. Must fail closed here.
  for (const bad of ["x", "3187094a-2257-4-8-x0001", "not-a-uuid", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111"]) {
    const r = validWorkOrder(baseOrder({ role: "review", attempt_id: bad }));
    assert.equal(r.ok, false, `attempt_id ${bad} must be rejected`);
  }
  const ok = validWorkOrder(baseOrder({ role: "review", attempt_id: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(ok.ok, true, ok.reason);
  // And a successor minted from ANY valid UUID attempt stays UUID-shaped:
  for (const prior of [
    "11111111-1111-4111-8111-111111111111",
    "00000000-0000-4000-8000-000000000000",
    "ffffffff-ffff-4fff-afff-ffffffffffff",
  ]) {
    const fresh = freshAttempt(prior, "review", 1);
    assert.match(fresh, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/, `freshAttempt from ${prior} must be UUID-v4-shaped`);
    assert.equal(validWorkOrder(baseOrder({ role: "review", attempt_id: fresh })).ok, true, "fresh successor must itself validate");
  }
});

test("route: PASS is terminal (stop before merge)", () => {
  const r = nextWorkOrder({ requested: baseOrder({ role: "review", outcome: "PASS" }), entries: [], review_round: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.terminal, true);
});

test("freshAttempt: deterministic, lineage-traceable, unique per stage/round", () => {
  const prior = "11111111-1111-4111-8111-111111111111";
  const a = freshAttempt(prior, "review", 1);
  const b = freshAttempt(prior, "review", 1);
  const c = freshAttempt(prior, "revise", 1);
  assert.equal(a, b, "deterministic");
  assert.notEqual(a, c, "stage changes the id");
  assert.notEqual(a, prior, "never reuses the prior attempt");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("shared Git identity can never fabricate independence (derived actor is not a session)", () => {
  // Two 'actors' that are merely labels derived from the SAME attempt are not
  // independent — eligibleReviewers must key on distinct review SESSIONS and
  // must exclude anyone already in the author set even under a shared label.
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "shared:owner", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "1", actor: "shared:owner", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  const eligible = eligibleReviewers(entries);
  assert.equal(eligible.length, 0, "relabeled author session is not independence");
});

test("work-order directive: rendered directive round-trips and carries the exact head", () => {
  const order = baseOrder({ role: "review", runtime: "claude-code", actor: "claude:v1", outcome: null });
  const body = renderWorkOrderDirective(order);
  assert.match(body, /coordinator-work-order v1/);
  assert.match(body, /role review/);
  const parsed = parseWorkOrderDirective(body);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.order.role, "review");
  assert.equal(parsed.order.runtime, "claude-code");
  assert.equal(parsed.order.actor, "claude:v1");
  assert.equal(parsed.order.target_sha, SHA, "the exact head is in the directive");
});

test("work-order directive: BLOCK revision directive names the writer as actor (card is the instruction channel)", () => {
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  const requested = baseOrder({ role: "review", runtime: "claude-code", outcome: "BLOCKED" });
  const r = nextWorkOrder({ requested, entries, review_round: 1 });
  assert.equal(r.ok, true, r.reason);
  const body = renderWorkOrderDirective(r.order);
  assert.match(body, /role revise/);
  assert.match(body, /actor codex:s1/, "the directive names who acts next — no human relay needed");
  const parsed = parseWorkOrderDirective(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.order.actor, "codex:s1");
  assert.equal(parsed.order.writer, null, "directive renderer emits writer:null when not set");
});

test("work-order directive: malformed / non-directive text is never trusted as an order", () => {
  assert.equal(parseWorkOrderDirective("just a comment").ok, false);
  assert.equal(parseWorkOrderDirective("<!-- coordinator-work-order v1 -->\nno json").ok, false);
  assert.equal(parseWorkOrderDirective("<!-- coordinator-work-order v1 -->\n```json\n{not json}\n```").ok, false);
  assert.equal(parseWorkOrderDirective(null).ok, false);
  const invalid = parseWorkOrderDirective("<!-- coordinator-work-order v1 -->\n```json\n{\"version\":\"1.0.0\",\"role\":\"ship\",\"runtime\":\"codex-cli\"}\n```");
  assert.equal(invalid.ok, false, "an invalid role never parses to an order");
});

test("routing round-trip: BLOCK -> revise directive -> next build review cycle stays author-excluding", () => {
  // Full loop the fixture will exercise: build by codex:s1 -> review by claude:v1
  // BLOCKs -> revise directive names codex:s1 -> after revise, claude:v1 reviews
  // again (still not an author) and PASSes.
  const entries = [
    provenanceEntry({ attempt_id: "1", actor: "codex:s1", role: "build", runtime: "codex-cli", target_sha: SHA }),
    provenanceEntry({ attempt_id: "2", actor: "claude:v1", role: "review", runtime: "claude-code", target_sha: SHA }),
  ];
  const blocked = nextWorkOrder({ requested: baseOrder({ role: "review", runtime: "claude-code", outcome: "BLOCKED" }), entries, review_round: 1 });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.order.role, "revise");
  const revisedEntries = [...entries, provenanceEntry({ attempt_id: blocked.order.attempt_id, actor: "codex:s1", role: "revise", runtime: "codex-cli", target_sha: SHA2, result_sha: SHA2 })];
  const again = nextWorkOrder({ requested: { ...blocked.order, role: "revise", outcome: "BUILD_READY", review_runtimes: ["claude-code"] }, entries: revisedEntries, review_round: 1 });
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.order.role, "review");
  assert.equal(again.order.actor, "claude:v1", "non-author reviewer reviews the revision");
  assert.notEqual(again.order.target_sha, SHA, "re-review binds the NEW head");
});
