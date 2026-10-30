// single-run-activation.mjs — reviewed, single-run host activation (SHU-63).
//
// WHY THIS EXISTS
//
// Dispatch has always required TWO gates in different layers: the committed
// `enable_dispatch` flag and the runtime ENABLE_DISPATCH switch. Neither alone
// can arm anything, and the committed flag is asserted false by the suite
// (eligibility.test.mjs: "the fixture lane is a lane, never an activation";
// shu224-dispatch-scope.test.mjs: "committed scope is pinned … while dispatch
// stays disabled"). That contract is correct and is NOT weakened here.
//
// What was missing — and what stopped the approved live fixture at launch — is
// any way to authorize ONE run without changing the committed gate. SUPERVISOR.md
// already names the requirement: "Live activation requires a separately reviewed
// host service configuration and rollback plan." This module is that mechanism.
//
// WHAT IT IS
//
// An operator-owned, host-local, single-use activation record (a small JSON file
// outside the repository) that substitutes for the COMMITTED flag for exactly one
// bounded run. It never substitutes for the runtime switch: ENABLE_DISPATCH=true
// is still required, so a forgotten activation file cannot arm anything by itself.
//
// DESIGN RULES, in order of importance
//
//   1. FAIL CLOSED. Unreadable, malformed, unexpected, stale, spent,
//      mis-targeted, mis-revisioned or mis-permissioned authorizations REFUSE
//      dispatch outright. There is no fallback, no warning-and-continue, and no
//      "board-wide" reading — every refusal returns before any write or launch.
//   2. IT CAN NEVER WIDEN THE BOARD. The bound target must be the single issue the
//      committed `dispatch_scope` already allows. An activation cannot select a
//      card the committed configuration would not have selected. A board-wide
//      configuration (no dispatch_scope) is refused outright.
//   3. IT CAN NEVER RAISE CAPACITY. `slots` must equal the committed
//      `max_dispatch`; a record claiming more capacity than the committed
//      configuration is refused rather than honoured.
//   4. IT CAN NEVER BE REPLAYED. It expires, and it is spent once the bound
//      target reaches a parked/terminal receipt. One episode, then it is dead.
//   5. IT IS BOUND TO THE CODE THAT IS RUNNING. The named coordinator revision
//      must equal the revision of the checkout being executed, so an activation
//      cannot arm a coordinator that was never reviewed against it.
//
// WHY "ONE USE" IS ONE EPISODE — AND HOW THE EPISODE'S END IS DECIDED
//
// The approved run contract is build → exact-head BLOCK → return to the writer →
// same-branch revision → automatic re-review → PASS. So "one claim ever" would
// stall the loop this exists to authorize — and so would spending the activation
// on ANY terminal receipt, because the loop's own steps produce them:
//
//   BUILD_READY    -> COMPLETED
//   REVISION_READY -> COMPLETED
//   BLOCKED        -> HOLD
//   PASS           -> COMPLETED
//
// (That mapping is `terminalVerdictCoherent` in reconcile.mjs.) An earlier revision
// of this module spent the activation on the builder's own COMPLETED and was
// BLOCKed in review for it: the review step could never be dispatched, and every
// subsequent tick hard-refused. A coherent step's END is therefore derived from
// ROUTING semantics. The sole receipt-stage stop is an incoherent terminal HOLD:
// it has no successor to route and already means human review is required.
//
//   * a routable successor (a review order after BUILD_READY/REVISION_READY, a
//     revise order after a routable BLOCKED)      -> the episode CONTINUES
//   * PASS                                         -> the episode ENDED
//   * revision rounds exhausted                    -> the episode ENDED
//   * retryable failures at `max_failed_attempts`  -> the episode ENDED
//   * a verdict-less/incoherent terminal HOLD          -> the episode ENDED
//   * a terminal verdict carrying contradictory facts (lane mismatch,
//     forged/stale head)                               -> the episode ENDED
//   * no eligible reviewer / no active writer          -> the episode CONTINUES
//                                                         until availability or expiry
//
// The judgement is the routing module's own: this file calls
// `routeSuccessorFromReceipts()` and `outcomeForEvidenceStage()` directly rather
// than re-deriving verdict semantics.
//
// When the routing cannot decide AT ALL — it has a verdict, but the durable
// lineage lacks the provenance needed to mint an order — the episode is treated as
// ONGOING. That asymmetry is deliberate: spending the authorization kills the loop
// (the defect this rule exists to fix), whereas an over-long-lived authorization is
// already bounded by expiry, target, revision, one slot and the runtime switch.
// Failing that way round is the cheaper mistake.

import { readTwoFixtureEvidence } from "./two-fixture-evidence.mjs";
import { readProgressionPush } from './two-fixture-progression.mjs';
import { readFixtureAncestry } from './two-fixture-evidence.mjs';
import { validateTwoFixtureActivation } from "./two-fixture-activation.mjs";
import { resolveFixtureLane, resolveReviewOnlyLane, resolveQueueConfigReview } from "./workspace-scope.mjs";
import { cardContract } from "./card-contracts-reader.mjs";
import { validReviewFindings } from "./review-findings.mjs";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BROKER_GIT_CONFIG_ARGS, brokerGitEnv } from "./push-broker.mjs";
import { routeSuccessorFromReceipts, outcomeForEvidenceStage, verdictMatchesLane, reviewVerdictProvenanceValid, repairReviseOrder } from "./review-routing.mjs";
// SHU-249: the reviewer-lane set is derived from the ONE launch vocabulary, so
// the activation record's accepted lanes and the routing module's review
// capability can never drift apart.
import { ACTIVATION_REVIEWER_LANES, ACTIVATION_WRITER_LANES, adapterForLane, familyForLane, RUNTIME_FAMILY } from "./launch-vocabulary.mjs";

// The exact key set. A record is rejected for a missing key AND for an extra one:
// a configuration surface nobody reviewed is how scope creep enters security code.
export const SINGLE_RUN_ACTIVATION_KEYS = Object.freeze([
  "activation_id",
  "target_issue_id",
  "authorization_ref",
  "coordinator_revision",
  "slots",
  "expires_at",
]);

// Reviewed optional keys. The record may name a reviewer lane to
// bootstrap an episode's very first review, because a fresh lineage has no
// review-role entry and the routing (correctly) refuses to invent one. Both
// present and absent are valid shapes; any OTHER key is still refused, so widening
// what the record may declare stays a reviewed schema change rather than a free
// extension point. The value is validated as a known reviewer-capable lane, and
// the routing additionally refuses a lane in the write lane's own family.
// SHU-227 adds initial_target_sha: the approved worker input, constant across
// the episode even while the branch advances through review and revision.
// SHU-231: `supersedes_attempt_ids` names the specific retained evidence this
// approval retires. It is optional like `reviewer_lane` — but nothing else about
// the exact-key-set rule relaxes: an unreviewed extra key still refuses.
// SHU-71: `writer_lane` names the lane of the episode's first build, so a run
// can reverse the roles (a Claude build reviewed by Codex) without relabelling
// the card. It is read only for the first build: every revision returns to the
// runtime of the build receipt, so the writer is fixed for the whole episode.
// SHU-303: a review-only run names the pull request it reviews, that PR's
// base, and the model family that wrote it. The three come together or not at
// all, and only on a committed review-only lane (step 3 below): the record picks
// which PR head a standing review card judges, never which card runs.
export const REVIEW_ONLY_ACTIVATION_KEYS = Object.freeze(["review_pr", "review_base_sha", "pr_author_family"]);
// Self-repair B1: a landing-repair run names the pull request whose checks went
// red after a PASS, the passed episode it repairs, the CI findings its one
// revision is given and their digest, and its round bound. The five come
// together or not at all, never beside the review-only group, and only on a
// committed card lane (step 3 below). The record binds which head is repaired
// (initial_target_sha) and with which lanes; it never picks the card.
export const REPAIR_ACTIVATION_KEYS = Object.freeze(["repair_pr", "repair_of", "repair_findings", "repair_evidence_digest", "max_rounds"]);
export const OPTIONAL_ACTIVATION_KEYS = Object.freeze(["reviewer_lane", "initial_target_sha", "supersedes_attempt_ids", "writer_lane", ...REVIEW_ONLY_ACTIVATION_KEYS, ...REPAIR_ACTIVATION_KEYS]);
// One repair round, and only one: the record says so, and anything else refuses.
export const REPAIR_MAX_ROUNDS = 1;
export const PR_AUTHOR_FAMILIES = Object.freeze([...new Set(Object.values(RUNTIME_FAMILY))]);
export const MAX_REVIEW_PR = 9999999;

export const ACTIVATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const LINEAR_ISSUE_ID_RE = /^SHU-[0-9]+$/;
export const REVISION_RE = /^[0-9a-f]{40}$/;
// Canonical attempt-id shape (minted by randomUUID at RESERVED). Version and
// variant are not restricted: a receipt may carry any real UUID.
export const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AUTHORIZATION_REF_RE = /^(SHU-[0-9]+|FIXTURE-[A-Z0-9-]+)$/;

// Self-repair B1: the one JSON form a digest is taken over. Object keys are
// sorted at every depth and nothing else is changed, so the same findings
// always give the same bytes however they were written. Only JSON values are
// accepted; anything else throws rather than being silently dropped the way
// JSON.stringify drops undefined, so two different records never share a digest.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON has no non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON cannot hold a ${typeof value}`);
}

// The sha256 hex of the canonical findings: what repair_evidence_digest binds.
export function repairEvidenceDigest(findings) {
  return createHash("sha256").update(canonicalJson(findings)).digest("hex");
}

// An expiry that reaches further than a day is not an expiry, it is a permanence.
export const MAX_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
// SHU-71 try 8: /tmp (a 3.8G tmpfs on the host) was full, so the broker's
// fetch into its temporary repository died with ENOSPC after a fifteen-minute
// build and spent the episode. The coordinator starts no launch while the temp
// filesystem holds less than this (reconcile.mjs, before each reservation).
export const MIN_TMP_FREE_BYTES = 1024 * 1024 * 1024;

// Free bytes where the broker and attempt workspaces put their temporary
// repositories. null when it cannot be read.
function tmpFreeBytes(io = {}) {
  if (typeof io.tmpFreeBytes === "function") return io.tmpFreeBytes();
  try {
    const stat = fs.statfsSync(tmpdir());
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

// Room to publish. null when the temp filesystem can hold a launch's workspace
// and its result. Deliberately not part of the activation status: that status
// is re-read before a finished result is published, and the result's own
// snapshot must never be what refuses it.
export function tmpFloorRefusal(io = {}) {
  const free = tmpFreeBytes(io);
  if (!Number.isFinite(free)) return `free space in ${tmpdir()} could not be read (fail closed)`;
  if (free < MIN_TMP_FREE_BYTES) {
    return `only ${Math.floor(free / 1048576)} MiB free in ${tmpdir()}; a launch needs at least ${MIN_TMP_FREE_BYTES / 1048576} MiB`;
  }
  return null;
}

// SHU-71: a named writer must be a writer lane the supervisor can start beside
// a named reviewer, and the two may share neither a family nor an adapter, so a
// lane never reviews its own work. null when the pair is acceptable.
function writerPairError(writerLane, reviewerLane) {
  if (typeof writerLane !== "string" || !ACTIVATION_WRITER_LANES.includes(writerLane)) {
    return `writer_lane must be one of ${ACTIVATION_WRITER_LANES.join(", ")} (got ${JSON.stringify(writerLane)})`;
  }
  if (typeof reviewerLane !== "string") return "writer_lane requires reviewer_lane in the same record";
  if (familyForLane(writerLane) === familyForLane(reviewerLane) || adapterForLane(writerLane) === adapterForLane(reviewerLane)) {
    return `writer_lane ${writerLane} and reviewer_lane ${reviewerLane} are the same family — a lane never reviews its own work`;
  }
  return null;
}

// The durable stages a receipt can rest in (mirrors reconcile.mjs TERMINAL_STAGES).
export const TERMINAL_RECEIPT_STAGES = Object.freeze(["COMPLETED", "FAILED", "HOLD"]);
export const DEFAULT_MAX_FAILED_ATTEMPTS = 3;
export const DEFAULT_MAX_REVISE = 3;

// Permission shape accepted for the activation file: no group/world write, and no
// world access at all. 0600 (operator only) and 0640 (operator + coordinator group)
// both pass; 0660, 0644, 0604 and 0777 all fail. Ownership is not asserted because
// the record is a capability declaration, not a secret — what matters is that no
// other account can edit or read it.
const FORBIDDEN_MODE_BITS = 0o022 | 0o007;

// ---------------------------------------------------------------------------
// The episode: when does this target's run chain end?
// ---------------------------------------------------------------------------

// Mirrors reconcile.mjs `terminalVerdictCoherent`. Duplicated DELIBERATELY: that
// helper lives in reconcile.mjs, which imports THIS module, so importing it back
// would make the two circular. test/single-run-activation.test.mjs pins the two
// definitions to agree across the whole verdict matrix, so they cannot drift apart
// without a test failing.
export function coherentTerminal(receipt) {
  if (!receipt || !TERMINAL_RECEIPT_STAGES.includes(receipt.stage)) return false;
  const verdict = outcomeForEvidenceStage(receipt.verdict_stage);
  if (!verdict) return false;
  if (verdict.outcome === "BLOCKED" || verdict.outcome === "FAILED") return receipt.stage === "HOLD";
  return receipt.stage === "COMPLETED";
}

// The attempt whose verdict decides where the loop goes next: the newest
// verdict-bearing terminal, ordered by last_activity — the same field the durable
// read uses for its "newest wins" rule — and stable on ties.
export function latestCoherentTerminal(issueReceipts = []) {
  const coherent = (issueReceipts ?? []).filter(coherentTerminal);
  if (coherent.length === 0) return null;
  return coherent
    .slice()
    .sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? "")))
    .pop();
}

// episodeScopeFor — the ONE place the episode boundary is defined (SHU-231).
//
// The episode identity is the existing `activation_id`: already unique, already
// validated, already stable across restart. `supersedes_attempt_ids` is the
// explicit, reviewable statement of which RETAINED evidence this approval
// retires. Retiring evidence is never deletion: no code path here or below
// removes, archives or rewrites a receipt.
export function episodeScopeFor(record) {
  if (!record || typeof record.activation_id !== "string") return null;
  const supersedes = Array.isArray(record.supersedes_attempt_ids) ? record.supersedes_attempt_ids : [];
  return { episode_id: record.activation_id, supersedes: new Set(supersedes) };
}

// receiptInEpisodeScope — may this receipt SPEND this approval, or PARK this
// issue? Exactly two decisions, nothing else.
//
//   * no armed episode        -> true  (global behaviour, byte-for-byte as before)
//   * same episode            -> true  (tagged with this activation_id)
//   * another episode         -> false (a previous episode's terminal is not ours)
//   * untagged legacy receipt -> true UNLESS this approval names it. Untagged and
//     unnamed still spends: FAIL CLOSED. To retire retained evidence the approver
//     must name that exact attempt, which is the reviewable statement — an
//     id-only or date-only edit can therefore never reauthorize a spent approval.
export function receiptInEpisodeScope(receipt, scope) {
  if (!scope) return true;
  if (!receipt || typeof receipt !== "object") return true;
  if (receipt.episode_id === scope.episode_id) return true;
  if (receipt.episode_id) return false;
  return !scope.supersedes.has(receipt.attempt_id);
}

// Self-repair B1: the repair facts episodeVerdict needs, from a validated
// record or from the armed status (both carry the same names), or null when
// the source is not a landing repair. Nothing else turns a repair on.
export function repairFromActivation(source, config = {}) {
  if (!source || typeof source !== "object" || !REPAIR_ACTIVATION_KEYS.every((key) => Object.hasOwn(source, key))) return null;
  return Object.freeze({
    activation_id: typeof source.activation_id === "string" ? source.activation_id : null,
    repair_pr: source.repair_pr,
    repair_of: source.repair_of,
    repair_findings: source.repair_findings,
    repair_evidence_digest: source.repair_evidence_digest,
    max_rounds: source.max_rounds,
    initial_target_sha: source.initial_target_sha ?? null,
    writer_lane: source.writer_lane ?? null,
    reviewer_lane: source.reviewer_lane ?? null,
    branch: typeof source.target_issue_id === "string" ? `coordinator/${source.target_issue_id}` : null,
    repo: config?.pilot_repo ?? null,
  });
}

// Self-repair B1: the first step of a landing repair. Its episode has no
// receipt yet, and routing has nothing to route from (the episode it repairs
// ended at PASS), so the one revise is synthesized here, and only from a PASS
// that may vouch for the head: the repaired episode's own exact-head PASS on
// the card's branch, in the role-authority receipt version, from a review lane,
// whose verifier is independent of the lineage it reviewed. Anything less ends
// the repair with a named reason; it never falls back to a build.
function repairBootstrap({ repair, issueReceipts, targetIssueId, config, authoritativeHead }) {
  const head = repair.initial_target_sha;
  const branch = `coordinator/${targetIssueId}`;
  const pass = issueReceipts
    .filter((r) => r.episode_id === repair.repair_of && r.stage === "COMPLETED" && r.verdict_stage === "PASS"
      && r.receipt_version === "1.1.0"
      && verdictMatchesLane(r.requested_worker, r.verdict_stage)
      && r.target_sha === head
      && r.branch === branch
      && r.repo === repair.repo
      && reviewVerdictProvenanceValid(r, issueReceipts).ok)
    .sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? "")))
    .pop();
  if (!pass) return { ended: true, reason: `repair has no trusted PASS of ${repair.repair_of} at ${head}` };
  // The live head is only known on the dispatching pass; the pure status
  // passes null. A branch that moved off the passed head is not this repair's.
  if (authoritativeHead !== null && authoritativeHead !== head) {
    return { ended: true, reason: `repair target moved: the branch is at ${authoritativeHead}, not the passed head ${head}` };
  }
  let minted;
  try {
    minted = repairReviseOrder({ pass, repairId: repair.activation_id, lineageReceipts: issueReceipts, fixtureLane: resolveFixtureLane(config, targetIssueId) });
  } catch (err) {
    return { ended: true, reason: `repair revise cannot be minted (${err?.message ?? "error"})` };
  }
  if (!minted.ok) return { ended: true, reason: `repair revise cannot be minted (${minted.reason})` };
  if (minted.order.requested_worker !== repair.writer_lane) {
    return { ended: true, reason: `repair revise lane ${minted.order.requested_worker} is not the record's writer_lane ${repair.writer_lane}` };
  }
  if (!validReviewFindings(repair.repair_findings) || repair.repair_findings.target_sha !== minted.order.target_sha) {
    return { ended: true, reason: `repair findings are not bound to the passed head ${head}` };
  }
  return {
    ended: false,
    reason: `mid-episode: landing repair of #${repair.repair_pr} — the one revise is routable`,
    successor: { ...minted.order, review_findings: repair.repair_findings },
  };
}

// Decide whether the bound target's episode has ENDED, using the production
// routing semantics. Returns { ended, reason, successor? } and NEVER throws: an
// internal routing failure must surface as "cannot decide" (ongoing), not as a
// crashed coordinator.
//
// Self-repair B1: `repair` (repairFromActivation) makes this a landing-repair
// episode. With no receipt of its own yet it synthesizes the one revise
// (repairBootstrap); after that it routes exactly as any episode does, with
// max_revise 0 for this call only, so the re-review's BLOCK (round 1) is
// exhausted and its PASS ends it. Absent, nothing below changes.
export function episodeVerdict({ receipts = [], targetIssueId, config = {}, bootstrapReviewer = null, authoritativeHead = null, episodeScope = null, repair = null } = {}) {
  const issueReceipts = (receipts ?? []).filter((r) => r && r.issue_id === targetIssueId);
  // SHU-231: only the SPEND / TERMINAL / ROUTING inputs are episode-scoped. The
  // receipt list itself is never filtered for anything else.
  const scopedReceipts = episodeScope ? issueReceipts.filter((r) => receiptInEpisodeScope(r, episodeScope)) : issueReceipts;

  // Retryable run failures end the episode only at the cap — the same bound the
  // selector uses to park an issue (reconcile.mjs). SHU-231: this is evaluated
  // GLOBALLY, before any episode scoping, because a new episode must NEVER
  // replenish retries — replenishing a budget needs its own authority and its own
  // approval, never a side effect of a new activation_id.
  const maxFailed = Number.isInteger(config?.max_failed_attempts) ? config.max_failed_attempts : DEFAULT_MAX_FAILED_ATTEMPTS;
  const failed = issueReceipts.filter((r) => r.stage === "FAILED").length;
  if (failed >= maxFailed) return { ended: true, reason: `retryable failures exhausted (${failed}/${maxFailed})` };

  if (scopedReceipts.length === 0) {
    if (repair) return repairBootstrap({ repair, issueReceipts, targetIssueId, config, authoritativeHead });
    return { ended: false, reason: "no attempt has been dispatched yet" };
  }

  // HOLD is deliberately not retryable. A newer attempt that completed without
  // a coherent, bound verdict requires human review; routing again from an older
  // BUILD_READY would mint a new successor from the wrong predecessor forever.
  // Valid review BLOCKED/FAILED receipts are coherent HOLDs and still route the
  // revision below. Availability holds (no reviewer/writer) are routing results,
  // not receipt stages, and remain armed as adjudicated on PR #68.
  const latestTerminalReceipt = scopedReceipts
    .filter((r) => r && TERMINAL_RECEIPT_STAGES.includes(r.stage))
    .slice()
    .sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? "")))
    .pop();
  if (latestTerminalReceipt?.stage === "HOLD" && !coherentTerminal(latestTerminalReceipt)) {
    return {
      ended: true,
      reason: `attempt ${latestTerminalReceipt.attempt_id ?? "<unknown>"} ended HOLD without a coherent verdict — human review required`,
    };
  }

  const terminal = latestCoherentTerminal(scopedReceipts);
  if (!terminal) return { ended: false, reason: "mid-episode: no verdict-bearing terminal yet" };

  // A PASS verdict is an ending on its own terms: the loop is complete. It is
  // decided from the verdict rather than from the routing, because the routing also
  // needs a usable lineage to name a next actor, and a finished loop has no next
  // actor to name. The lane must match, though: a builder lane cannot carry a PASS,
  // and that contradiction is left to the routing to name below.
  if (terminal.receipt_version === "1.1.0") {
    const authority = reviewVerdictProvenanceValid(terminal, issueReceipts);
    if (!authority.ok) return { ended: true, reason: `role authority or author exclusion HOLD — ${authority.reason}` };
  }
  const verdict = outcomeForEvidenceStage(terminal.verdict_stage);
  if (verdict?.outcome === "PASS" && verdictMatchesLane(terminal.requested_worker, terminal.verdict_stage)) {
    return { ended: true, reason: "review PASS — the episode is complete" };
  }
  // SHU-303: a review-only run has no writer to revise, so its first coherent
  // verdict ends it. PASS and BLOCKED are the review's answer; any other
  // verdict is a run that could not review, reported as such.
  // A malformed review_lanes ends the episode by naming the configuration, so
  // nothing launches on it and the stop says why.
  let reviewOnly;
  try { reviewOnly = Boolean(resolveReviewOnlyLane(config, targetIssueId)); }
  catch (error) { return { ended: true, reason: `committed review_lanes is invalid (${error.message}) — no episode runs on it` }; }
  if (reviewOnly) {
    const at = terminal.target_sha ?? "<unknown head>";
    if (["PASS", "BLOCKED"].includes(verdict?.outcome) && verdictMatchesLane(terminal.requested_worker, terminal.verdict_stage)) {
      return { ended: true, reason: `review-only verdict ${verdict.outcome} at ${at} — the episode is complete` };
    }
    return { ended: true, reason: `review-only run ended ${terminal.verdict_stage ?? "without a verdict"} at ${at} without a review verdict` };
  }

  let routed;
  try {
    routed = routeSuccessorFromReceipts({
      issueReceipts: scopedReceipts,
      terminal,
      evidenceStage: terminal.verdict_stage,
      evidenceResultSha: terminal.result_sha ?? null,
      // Self-repair B1: one round. The synthesized revise is not a review, so
      // the first re-review is round 1, and its BLOCK is past max_revise 0.
      max_revise: repair ? 0 : Number.isInteger(config?.max_revise) ? config.max_revise : DEFAULT_MAX_REVISE,
      // main() re-runs this decision with the freshly fetched branch head before a
      // successor may enter selection. The activation-status call remains pure and
      // passes null; it can establish shape/spend state but never authorize launch.
      authoritativeHead,
      // SHU-225: the trusted record's first-review lane, when it declares one. It
      // only ever unlocks a review the lineage could not otherwise name (zero
      // review entries); every later step is routed from real receipts.
      bootstrapReviewer,
      fixtureLane: resolveFixtureLane(config, terminal.issue_id),
    });
  } catch (err) {
    return { ended: false, reason: `mid-episode: routing could not decide (${err?.message ?? "error"})` };
  }

  if (routed.ok && routed.order) {
    // V1 contract step 3: the revision is dispatched with the review's findings.
    // They come from the BLOCKED review receipt at the very head being revised.
    const findings = routed.order.scope_phase === "revision" && validReviewFindings(terminal.review_findings)
      && terminal.review_findings.target_sha === routed.order.target_sha ? terminal.review_findings : null;
    const successor = findings ? { ...routed.order, review_findings: findings } : routed.order;
    return { ended: false, reason: `mid-episode: ${routed.order.role} successor is routable`, successor };
  }
  if (routed.ok && routed.terminal) return { ended: true, reason: "review PASS — the episode is complete" };

  // Not every routing refusal means the episode is over, and the difference matters
  // in one direction only: spending the authorization kills the loop.
  //
  //   ENDED (a verdict-level determination, or a contradiction in the durable facts
  //   that needs a human): revisions exhausted, a forged/stale head, a verdict from
  //   the wrong lane, an unexpected outcome, a role that cannot be routed.
  //
  //   NOT ENDED (the routing could not NAME the next actor — an availability or
  //   lineage gap, not an ending): no eligible reviewer, no active writer, a
  //   lineage without provenance, an unknown worker lane. These are reported and
  //   left to expire rather than allowed to kill a loop that is still in flight.
  if (routed.exhausted === true) return { ended: true, reason: "revision attempts exhausted — the episode is over" };
  if (routed.forged === true) return { ended: true, reason: `refused on contradictory facts (${routed.reason})` };
  if (routed.hold) return { ended: false, reason: `mid-episode: routing holds (${routed.hold}) — no next actor named yet` };
  if (/no provenance entries/.test(routed.reason ?? "")) {
    return { ended: false, reason: "mid-episode: a successor is due but the durable lineage lacks provenance to mint its order" };
  }
  if (/unknown worker lane/.test(routed.reason ?? "")) {
    return { ended: false, reason: "mid-episode: the lineage names a worker lane this coordinator cannot route" };
  }
  return { ended: true, reason: `no routable successor (${routed.reason ?? "no order"})` };
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

// `node reconcile.mjs` (no arguments) is the unchanged, fully-disabled path: the
// mechanism is simply absent. `--activation <path>` opts into it. Any other
// argument is refused rather than ignored, so a typo cannot silently run with a
// weaker configuration than the operator believed they asked for.
export function parseActivationArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  let activationPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") return { path: null, error: `unexpected non-string argument` };
    if (arg === "--activation") {
      const next = args[i + 1];
      if (typeof next !== "string" || next.length === 0 || next.startsWith("--")) {
        return { path: null, error: "--activation requires a file path" };
      }
      if (activationPath !== null) return { path: null, error: "--activation given more than once" };
      activationPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--activation=")) {
      const value = arg.slice("--activation=".length);
      if (value.length === 0) return { path: null, error: "--activation requires a file path" };
      if (activationPath !== null) return { path: null, error: "--activation given more than once" };
      activationPath = value;
      continue;
    }
    return { path: null, error: `unexpected argument: ${arg}` };
  }
  return { path: activationPath, error: null };
}

// ---------------------------------------------------------------------------
// SHU-312: a committed queue of cards
// ---------------------------------------------------------------------------

// dispatch_scope may list up to MAX_CARD_QUEUE committed card lanes, in the
// order the card-run timer runs them. Only the timer reads the order; the
// coordinator still runs one card per episode, the armed activation's own.
// M15: with more than one card worker a longer queue keeps every worker fed.
export const MAX_CARD_QUEUE = 20;
const FIXTURE_PAIR = Object.freeze(["SHU-140", "SHU-254"]);

// The committed queue, or why the scope is not one. A single id is not a
// queue, and neither is the fixture pair, which keeps its own handling.
export function cardQueue(config = {}) {
  const ids = config?.dispatch_scope?.issue_ids;
  if (!Array.isArray(ids) || ids.length < 2) return { queue: false, ids: null, reason: null };
  if (ids.length === 2 && FIXTURE_PAIR.every((id) => ids.includes(id))) return { queue: false, ids: null, reason: null };
  const no = (reason) => ({ queue: true, ok: false, ids: null, reason });
  if (ids.length > MAX_CARD_QUEUE) return no(`a card queue lists at most ${MAX_CARD_QUEUE} cards`);
  if (new Set(ids).size !== ids.length) return no("a card queue names each card once");
  const cards = config.card_lanes ?? [];
  for (const id of ids) {
    if (typeof id !== "string" || !LINEAR_ISSUE_ID_RE.test(id)) return no("a card queue names canonical SHU-<number> cards");
    let lane;
    try {
      if (resolveReviewOnlyLane(config, id)) return no(`${id} is a review-only lane; a card queue holds build cards only`);
      lane = resolveFixtureLane(config, id);
    } catch (error) {
      return no(`committed configuration is invalid: ${error.message}`);
    }
    if (!lane || !Array.isArray(cards) || !cards.some((card) => card?.id === id) || !cardContract(id)) {
      return no(`${id} is not a committed card lane`);
    }
  }
  // M15: a lane may name the queued cards it builds on (after). Each must come
  // earlier in the same queue, so the order stays a valid sequential order and
  // one worker runs exactly as before; more workers wait on these cards only.
  const after = {};
  for (const [index, id] of ids.entries()) {
    const needs = cards.find((card) => card?.id === id)?.after;
    if (needs === undefined) continue;
    if (!Array.isArray(needs) || needs.some((need) => typeof need !== "string" || !ids.slice(0, index).includes(need))) {
      return no(`${id} after must name cards earlier in the same queue`);
    }
    after[id] = [...needs];
  }
  return { queue: true, ok: true, ids: [...ids], after, reason: null };
}

// The configuration one tick works with. Under a queue, the scope narrows to
// the armed activation's target when that target is in the queue; otherwise
// the queue stays as committed, which every scope check refuses, so a queue
// with no armed card scopes nothing. The record is only read here to pick
// the scope: singleRunActivationStatus still checks every binding of it
// against the narrowed configuration, and a record that changes between the
// two reads names another target than the scope and is refused.
export function narrowQueueScope(config, filePath, io = {}) {
  const queue = cardQueue(config);
  if (!queue.queue || !queue.ok || typeof filePath !== "string" || !filePath) return config;
  const file = readActivationText(filePath, io);
  if (!file.ok) return config;
  let record;
  try { record = JSON.parse(file.text); } catch { return config; }
  // SHU-321: the committed queue_config_review lane is the one exception. Once
  // the queue is done the timer may arm it on a queue config pull request, so
  // a record targeting that lane, and no other review lane, narrows to it.
  if (validateActivationRecord(record).ok && record.target_issue_id === queueConfigReviewLane(config)) {
    return { ...config, dispatch_scope: { issue_ids: [record.target_issue_id] } };
  }
  if (!validateActivationRecord(record).ok || !queue.ids.includes(record.target_issue_id)) return config;
  return { ...config, dispatch_scope: { issue_ids: [record.target_issue_id] } };
}

function queueConfigReviewLane(config) {
  try { return resolveQueueConfigReview(config)?.lane ?? null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// The running coordinator's own revision
// ---------------------------------------------------------------------------

// The revision an activation is bound to is the revision of the checkout that is
// being executed — resolved from git, never from the activation file itself (a
// self-declared binding proves nothing). `safe.directory` is passed inline because
// the coordinator runs as a non-root service account against an operator-owned
// checkout. Any failure to resolve is a refusal, never a skip.
export function resolveCoordinatorRevision({ dir, gitHead, io = {} } = {}) {
  if (typeof gitHead === "string") return REVISION_RE.test(gitHead) ? gitHead : null;
  if (typeof io.gitHead === "string") return REVISION_RE.test(io.gitHead) ? io.gitHead : null;
  if (typeof io.revisionResolver === "function") return io.revisionResolver(dir) ?? null;
  try {
    // Git's ownership exception names the checkout ROOT, not the coordinator
    // subdirectory. Resolve from the executing module, never process.cwd() or
    // inherited GIT_DIR/GIT_WORK_TREE; do not edit system/global Git trust.
    let root = fs.realpathSync(dir);
    while (!fs.existsSync(path.join(root, ".git"))) {
      const parent = path.dirname(root);
      if (parent === root) return null;
      root = parent;
    }
    const out = execFileSync("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${root}`, "-C", root, "rev-parse", "HEAD"], {
      env: brokerGitEnv(process.env),
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return REVISION_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

// Self-repair B1: a spent or expired landing repair keeps its validated repair
// binding in the refusal, so the reporter decides the episode with the repair's
// own one-round cap (and its passed head and lanes) exactly as the spend did,
// rather than re-deciding it as an ordinary episode that would still route a
// second revise and so report no stop.
const REPAIR_REPORTING_KEYS = Object.freeze([...REPAIR_ACTIVATION_KEYS, "initial_target_sha", "writer_lane", "reviewer_lane"]);
function repairReporting(source) {
  if (!source || !REPAIR_ACTIVATION_KEYS.every((key) => Object.hasOwn(source, key))) return {};
  return Object.fromEntries(REPAIR_REPORTING_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

function refused(reason, reporting = null) {
  const safe = reporting &&
    typeof reporting.activation_id === "string" && ACTIVATION_ID_RE.test(reporting.activation_id) &&
    typeof reporting.target_issue_id === "string" && LINEAR_ISSUE_ID_RE.test(reporting.target_issue_id) &&
    typeof reporting.coordinator_revision === "string" && REVISION_RE.test(reporting.coordinator_revision) &&
    typeof reporting.expires_at === "string" && Number.isFinite(Date.parse(reporting.expires_at)) &&
    ["expired", "spent"].includes(reporting.reporting_exception)
      ? reporting
      : null;
  return {
    requested: true,
    state: "refused",
    valid: false,
    reason,
    target_issue_id: safe?.target_issue_id ?? null,
    activation_id: safe?.activation_id ?? null,
    coordinator_revision: safe?.coordinator_revision ?? null,
    expires_at: safe?.expires_at ?? null,
    reporting_exception: safe?.reporting_exception ?? null,
    ...repairReporting(safe),
  };
}

function reportingRefusal(record, reporting_exception) {
  return {
    activation_id: record.activation_id,
    target_issue_id: record.target_issue_id,
    coordinator_revision: record.coordinator_revision,
    expires_at: record.expires_at,
    reporting_exception,
    ...repairReporting(record),
  };
}

function readActivationText(filePath, io = {}) {
  const lstat = io.lstat ?? ((p) => fs.lstatSync(p));
  let stat;
  try {
    stat = lstat(filePath);
  } catch (err) {
    return { ok: false, reason: `activation file does not exist or cannot be read (${err?.code ?? err?.message ?? "error"})` };
  }
  // Reported explicitly rather than left to the regular-file check below: lstat does
  // not follow the link, so a symlink trips BOTH checks — and what this guard binds
  // is the operator-visible diagnosis (pinned by the SYM mutation), not the refusal,
  // which is doubly guaranteed.
  if (stat.isSymbolicLink()) return { ok: false, reason: "activation file is a symlink" };
  if (!stat.isFile()) return { ok: false, reason: "activation file is not a regular file" };
  if ((stat.mode & FORBIDDEN_MODE_BITS) !== 0) {
    return { ok: false, reason: `activation file permissions too broad (${(stat.mode & 0o7777).toString(8)}): must not be group/world writable or world readable` };
  }
  const read = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  try {
    return { ok: true, text: read(filePath) };
  } catch (err) {
    return { ok: false, reason: `activation file cannot be read (${err?.code ?? err?.message ?? "error"})` };
  }
}

export function validateActivationRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "activation must be a JSON object" };
  }
  const keys = Object.keys(record).sort();
  if (Object.hasOwn(record, "initial_target_sha") && (typeof record.initial_target_sha !== "string" || !REVISION_RE.test(record.initial_target_sha))) {
    return { ok: false, reason: "initial_target_sha must be a 40-character lowercase commit SHA" };
  }
  const required = [...SINGLE_RUN_ACTIVATION_KEYS].sort();
  const allowed = [...SINGLE_RUN_ACTIVATION_KEYS, ...OPTIONAL_ACTIVATION_KEYS].sort();
  const missing = required.filter((k) => !keys.includes(k));
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (missing.length > 0 || unknown.length > 0) {
    return {
      ok: false,
      reason: `activation must contain exactly ${allowed.join(", ")} (missing ${missing.join(", ") || "nothing"}; unrecognised ${unknown.join(", ") || "nothing"})`,
    };
  }
  if (typeof record.activation_id !== "string" || !ACTIVATION_ID_RE.test(record.activation_id)) {
    return { ok: false, reason: "activation_id must be 8-64 characters of [A-Za-z0-9_-]" };
  }
  if (typeof record.target_issue_id !== "string" || !LINEAR_ISSUE_ID_RE.test(record.target_issue_id)) {
    return { ok: false, reason: "target_issue_id must be a canonical SHU-<number> identifier" };
  }
  if (typeof record.authorization_ref !== "string" || !AUTHORIZATION_REF_RE.test(record.authorization_ref)) {
    return { ok: false, reason: "authorization_ref must be a Linear issue ref or a seeded FIXTURE ref" };
  }
  if (typeof record.coordinator_revision !== "string" || !REVISION_RE.test(record.coordinator_revision)) {
    return { ok: false, reason: "coordinator_revision must be a 40-character lowercase git SHA" };
  }
  if (!Number.isInteger(record.slots) || record.slots < 1) {
    return { ok: false, reason: "slots must be a positive integer" };
  }
  if (typeof record.expires_at !== "string" || Number.isNaN(Date.parse(record.expires_at))) {
    return { ok: false, reason: "expires_at must be an ISO-8601 timestamp" };
  }
  // SHU-225: the optional first-review bootstrap lane. Absent is valid (no
  // bootstrap — the routing then holds visibly, exactly as before this change).
  // Present must be a KNOWN reviewer-capable lane on a runtime the supervisor can
  // start (SHU-71: a Hermes reviewer can only hold); an unrecognised value refuses
  // rather than being ignored, because a silently-dropped reviewer declaration
  // would leave an operator believing a review was configured when it was not.
  if ("reviewer_lane" in record) {
    if (typeof record.reviewer_lane !== "string" || !ACTIVATION_REVIEWER_LANES.includes(record.reviewer_lane)) {
      return { ok: false, reason: `reviewer_lane must be one of ${ACTIVATION_REVIEWER_LANES.join(", ")} (got ${JSON.stringify(record.reviewer_lane)})` };
    }
  }
  // SHU-71: a named writer must be a writer lane the supervisor can start, and
  // the record must name its reviewer too, so the approved pair is the record's
  // and never resolved later from mutable config. Independence is read from the
  // lane registry: the two lanes may share neither a family nor an adapter.
  if ("writer_lane" in record) {
    const pairError = writerPairError(record.writer_lane, record.reviewer_lane);
    if (pairError) return { ok: false, reason: pairError };
  }
  // Self-repair B1: the landing-repair group. It repairs one card lane's
  // passed head, so it needs that head and both lanes, binds findings taken
  // at that very head, and allows one round. Every refusal names its rule.
  const repairKeys = REPAIR_ACTIVATION_KEYS.filter((key) => key in record);
  if (repairKeys.length > 0) {
    if (repairKeys.length !== REPAIR_ACTIVATION_KEYS.length) {
      return { ok: false, reason: `a landing-repair activation needs ${REPAIR_ACTIVATION_KEYS.join(", ")} together (got ${repairKeys.join(", ")})` };
    }
    if (REVIEW_ONLY_ACTIVATION_KEYS.some((key) => key in record)) {
      return { ok: false, reason: "a landing-repair activation cannot carry the review-only keys" };
    }
    if (record.max_rounds !== REPAIR_MAX_ROUNDS) return { ok: false, reason: `max_rounds must be ${REPAIR_MAX_ROUNDS}: a landing repair runs one round` };
    if (!Number.isSafeInteger(record.repair_pr) || record.repair_pr < 1 || record.repair_pr > MAX_REVIEW_PR) {
      return { ok: false, reason: "repair_pr must be a pull request number" };
    }
    if (typeof record.repair_of !== "string" || !ACTIVATION_ID_RE.test(record.repair_of)) {
      return { ok: false, reason: "repair_of must be the passed episode's activation id" };
    }
    if (record.repair_of === record.activation_id) return { ok: false, reason: "repair_of must name another episode than this activation" };
    if (!("initial_target_sha" in record)) return { ok: false, reason: "a landing-repair activation must name the head it repairs in initial_target_sha" };
    if (typeof record.writer_lane !== "string" || typeof record.reviewer_lane !== "string") {
      return { ok: false, reason: "a landing-repair activation must name its writer_lane and reviewer_lane" };
    }
    if (!validReviewFindings(record.repair_findings) || record.repair_findings.source !== "ci") {
      return { ok: false, reason: "repair_findings must be valid CI findings (source \"ci\")" };
    }
    if (record.repair_findings.target_sha !== record.initial_target_sha) {
      return { ok: false, reason: "repair_findings must be taken at initial_target_sha" };
    }
    let digest;
    try { digest = repairEvidenceDigest(record.repair_findings); } catch { digest = null; }
    if (typeof record.repair_evidence_digest !== "string" || record.repair_evidence_digest !== digest) {
      return { ok: false, reason: "repair_evidence_digest is not the sha256 of the canonical repair_findings" };
    }
  }
  // SHU-303: the review-only group. A review-only run has no writer, reviews
  // the exact head the record approves, and its reviewer may not be of the
  // family that wrote the pull request.
  const reviewKeys = REVIEW_ONLY_ACTIVATION_KEYS.filter((key) => key in record);
  if (reviewKeys.length > 0) {
    if (reviewKeys.length !== REVIEW_ONLY_ACTIVATION_KEYS.length) {
      return { ok: false, reason: `a review-only activation needs ${REVIEW_ONLY_ACTIVATION_KEYS.join(", ")} together (got ${reviewKeys.join(", ")})` };
    }
    if (!Number.isInteger(record.review_pr) || record.review_pr < 1 || record.review_pr > MAX_REVIEW_PR) {
      return { ok: false, reason: "review_pr must be a pull request number" };
    }
    if (typeof record.review_base_sha !== "string" || !REVISION_RE.test(record.review_base_sha)) {
      return { ok: false, reason: "review_base_sha must be a 40-character lowercase commit SHA" };
    }
    if (!PR_AUTHOR_FAMILIES.includes(record.pr_author_family)) {
      return { ok: false, reason: `pr_author_family must be one of ${PR_AUTHOR_FAMILIES.join(", ")}` };
    }
    if (!("initial_target_sha" in record)) return { ok: false, reason: "a review-only activation must name the head it reviews in initial_target_sha" };
    if (record.review_base_sha === record.initial_target_sha) return { ok: false, reason: "review_base_sha must differ from the reviewed head" };
    if ("writer_lane" in record) return { ok: false, reason: "a review-only activation has no writer_lane" };
    if (typeof record.reviewer_lane !== "string") return { ok: false, reason: "a review-only activation must name its reviewer_lane" };
    if (familyForLane(record.reviewer_lane) === record.pr_author_family) {
      return { ok: false, reason: `reviewer_lane ${record.reviewer_lane} is of the pull request author's family ${record.pr_author_family} — a family never reviews its own work` };
    }
  }
  // SHU-231: the episode boundary. Optional; when present it must be a
  // non-empty, duplicate-free list of canonical attempt UUIDs. An EMPTY list is
  // refused rather than ignored, because it reads as "I retired something" while
  // retiring nothing — the approver must name the evidence being retired.
  if ("supersedes_attempt_ids" in record) {
    const ids = record.supersedes_attempt_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: false, reason: "supersedes_attempt_ids must be a non-empty array of prior attempt ids" };
    }
    if (ids.some((v) => typeof v !== "string" || !ATTEMPT_ID_RE.test(v))) {
      return { ok: false, reason: "supersedes_attempt_ids must contain only canonical attempt UUIDs" };
    }
    if (new Set(ids).size !== ids.length) {
      return { ok: false, reason: "supersedes_attempt_ids must not repeat an attempt id" };
    }
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// SHU-71 run 4: how many times, and how far apart, the pair's branch heads are
// read again before a head behind the receipt-bound progression refuses.
export const STALE_HEAD_RETRIES = 2;
export const STALE_HEAD_WAIT_MS = 3000;

// Returns the single decision the caller needs. `state` is one of:
//   "absent"  — no --activation was given; the committed gates decide alone
//   "armed"   — a valid, unspent, unexpired, correctly-bound authorization
//   "refused" — an activation was requested and every part of it failed closed
//
// Every check below runs in a fixed order so the refusal reason is the FIRST
// failing binding, which is what an operator needs to see.
export function singleRunActivationStatus({
  filePath = null,
  config = {},
  receipts = [],
  now = new Date(),
  dir,
  gitHead,
  initialTargetSha,
  io = {},
  env = {},
  issues = [],
  unreadIssueIds = new Set(),
} = {}) {
  if (!filePath) return { requested: false, state: "absent", valid: true, reason: null, target_issue_id: null, activation_id: null, expires_at: null };

  // Explicit versioned extension; legacy records keep their original checks.
  const envelope = readActivationText(filePath, io);
  let pairRecord;
  try { pairRecord = envelope.ok ? JSON.parse(envelope.text) : null; } catch { /* legacy diagnosis below */ }
  if (config.dispatch_scope?.issue_ids?.length === 2 && !pairRecord?.target_issue_id && pairRecord?.kind !== "two-fixture-v1") {
    return { ...refused(`ACT_MALFORMED: ${envelope.ok ? "missing or invalid two-fixture record kind" : envelope.reason}`), code: "ACT_MALFORMED", kind: "two-fixture-v1" };
  }
  if (pairRecord?.kind === "two-fixture-v1") {
    const readRef = (ref) => {
      try {
        // Match resolveCoordinatorRevision: trust only the real checkout root
        // containing dir; unresolved roots refuse before invoking Git.
        let checkoutRoot = fs.realpathSync(dir);
        while (!fs.existsSync(path.join(checkoutRoot, ".git"))) {
          const parent = path.dirname(checkoutRoot);
          if (parent === checkoutRoot) return null;
          checkoutRoot = parent;
        }
        return execFileSync("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${checkoutRoot}`, "-C", dir, "rev-parse", "--verify", ref], {
          env: brokerGitEnv(process.env), encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch { return null; }
    };
    const readEvidence = () => io.fixtureHeadResolver
      ? { heads: Object.fromEntries(["SHU-140", "SHU-254"].map(id => [`coordinator/${id}`, io.fixtureHeadResolver(`coordinator/${id}`)])), issues }
      : readTwoFixtureEvidence(config, env, io.evidenceRun);
    const revision = resolveCoordinatorRevision({ dir, gitHead, io });
    const mainRevision = io.mainRevision ?? readRef("refs/heads/main");
    const validatePair = (evidence, at = now) => validateTwoFixtureActivation({ record: pairRecord, config,
      revision, mainRevision, heads: evidence.heads, issues: evidence.issues, env, now: at,
      receipts, readPush: io.readProgressionPush ?? (receipt => readProgressionPush(receipt, env)),
      isAncestor: io.fixtureAncestryResolver ?? ((base, head) => readFixtureAncestry(config, env, base, head)) });
    // SHU-71 run 7: a card whose thread the tick could not read contributes no
    // receipts, so its lane's progression falls back to the seed and the live
    // head reads as stale. That is a read to retry next tick, never a stale seed.
    const unreadFixture = pairRecord.fixtures?.find?.(fixture => unreadIssueIds.has(fixture?.issue_id));
    if (unreadFixture) {
      return { ...refused(`ACT_EVIDENCE_UNAVAILABLE: the receipts on ${unreadFixture.issue_id} could not be read; refused this tick`), code: "ACT_EVIDENCE_UNAVAILABLE", kind: "two-fixture-v1" };
    }
    const started = Date.now();
    let evidence = readEvidence();
    let status = validatePair(evidence);
    // SHU-71 run 4: the broker journals a push (PENDING) before sending it, and
    // the branch heads are read before that journal. A push landing in between
    // leaves the heads one push behind the receipt-bound progression, which
    // reads as a rewind (run 4 refused in the very second its push landed).
    // Read the heads again, a bounded number of times, before refusing; a real
    // rewind or a lost push still refuses.
    for (let retry = 0; status.code === "ACT_STALE_SEED_HEAD" && !io.fixtureHeadResolver && retry < STALE_HEAD_RETRIES; retry++) {
      (io.staleHeadWait ?? (delay => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); }))(STALE_HEAD_WAIT_MS);
      evidence = readEvidence();
      // Each read is judged at its own time: a retry that runs past expires_at refuses.
      status = validatePair(evidence, io.staleHeadClock?.() ?? new Date(new Date(now).getTime() + Date.now() - started));
    }
    // SHU-71 run 3: an evidence read that failed reaches the validator as no
    // cards at all. Still refused, but named for what it is: a read to retry,
    // not a record that cannot arm.
    if (status.code === "ACT_PARTIAL_ARMING" && evidence.unavailable === true) {
      return { ...status, code: "ACT_EVIDENCE_UNAVAILABLE", reason: "ACT_EVIDENCE_UNAVAILABLE: fixture evidence could not be read; refused this tick" };
    }
    if (!status.valid || status.state !== "armed") return status;
    // SHU-71 stage 5: a lane may name its writer beside its reviewer. Both sit
    // in the signed lane definition, which must equal the committed lane, so
    // the pair is reviewed config and never read from card labels.
    const writerLanes = {};
    for (const fixture of status.fixtures) {
      if (fixture.lane.writer_lane === undefined) continue;
      const pairError = writerPairError(fixture.lane.writer_lane, fixture.lane.reviewer_lane);
      if (pairError) return { ...refused(`ACT_LANE_CROSS: ${fixture.issue_id} ${pairError}`), code: "ACT_LANE_CROSS", kind: "two-fixture-v1" };
      writerLanes[fixture.issue_id] = fixture.lane.writer_lane;
    }
    const episodes = status.fixtures.map(fixture => ({ fixture, episode: episodeVerdict({ receipts,
      targetIssueId: fixture.issue_id, config, bootstrapReviewer: fixture.lane.reviewer_lane ? { lane: fixture.lane.reviewer_lane } : null, episodeScope: episodeScopeFor(status) }) }));
    const ongoing = episodes.filter(entry => !entry.episode.ended);
    if (!ongoing.length) return refused("activation is spent: both fixture episodes ended");
    const selected = ongoing.find(entry => !receipts.some(r => r.issue_id === entry.fixture.issue_id && !TERMINAL_RECEIPT_STAGES.includes(r.stage))) ?? ongoing[0];
    return { ...status, target_issue_id: selected.fixture.issue_id,
      authorization_ref: selected.fixture.lane.authorization_ref, reviewer_lane: selected.fixture.lane.reviewer_lane, initial_target_sha: selected.fixture.seed_head,
      writer_lane: writerLanes[selected.fixture.issue_id] ?? null, writer_lanes: writerLanes,
      successor: selected.episode.successor ?? null, episode: selected.episode.reason,
      target_issue_ids: ongoing.map(entry => entry.fixture.issue_id) };
  }

  // (1) Target binding — must be the single committed dispatch_scope issue.
  const scopeIds = config?.dispatch_scope?.issue_ids;
  if (!Array.isArray(scopeIds) || scopeIds.length !== 1) {
    return refused("a single-run activation requires a committed single-issue dispatch_scope; this configuration is board-wide");
  }
  const [scopeIssue] = scopeIds;
  // A malformed committed lane list is a named refusal, never a crashed tick.
  let reviewLane;
  let fixtureLane;
  try {
    reviewLane = resolveReviewOnlyLane(config, scopeIssue);
    fixtureLane = reviewLane ?? resolveFixtureLane(config, scopeIssue) ?? config?.fixture_lane ?? {};
  } catch (error) {
    return refused(`committed configuration is invalid: ${error.message}`);
  }
  if (fixtureLane.id && fixtureLane.id !== scopeIssue) {
    return refused(`committed configuration is inconsistent: fixture_lane.id ${fixtureLane.id} is not the scoped issue ${scopeIssue}`);
  }

  // (2) File integrity and shape.
  const file = readActivationText(filePath, io);
  if (!file.ok) return refused(file.reason);
  let record;
  try {
    record = JSON.parse(file.text);
  } catch (err) {
    return refused(`activation file is not valid JSON (${err?.message ?? "parse error"})`);
  }
  const shape = validateActivationRecord(record);
  if (!shape.ok) return refused(shape.reason);
  // The original approved input is constant across ticks. Successors have new
  // routed heads; compare this field to the operator input, not successor heads.
  if (Object.hasOwn(record, "initial_target_sha") && record.initial_target_sha !== initialTargetSha) {
    return refused("activation initial_target_sha does not match DISPATCH_TARGET_SHA (or the operator input is missing)");
  }

  // (3) The activation must name the scoped target and, where the lane carries an
  //     approved contract reference, the same contract reference.
  if (record.target_issue_id !== scopeIssue) {
    return refused(`activation target ${record.target_issue_id} is not the scoped issue ${scopeIssue}`);
  }
  if (fixtureLane.authorization_ref && record.authorization_ref !== fixtureLane.authorization_ref) {
    return refused(`activation authorization_ref ${record.authorization_ref} is not the lane contract ${fixtureLane.authorization_ref}`);
  }
  // A real card runs only with the writer and reviewer its committed lane names,
  // so an activation can never pick who builds or who judges a card.
  if (cardContract(scopeIssue)) {
    if (!fixtureLane.writer_lane || record.writer_lane !== fixtureLane.writer_lane) {
      return refused(`activation writer_lane ${record.writer_lane ?? "(none)"} is not the card lane's ${fixtureLane.writer_lane ?? "(none)"}`);
    }
    if (!fixtureLane.reviewer_lane || record.reviewer_lane !== fixtureLane.reviewer_lane) {
      return refused(`activation reviewer_lane ${record.reviewer_lane ?? "(none)"} is not the card lane's ${fixtureLane.reviewer_lane ?? "(none)"}`);
    }
  }

  // Self-repair B1: a landing repair revises a card's passed head, so it arms
  // only a committed card lane; a review-only or fixture lane has no such head.
  const landingRepair = "repair_pr" in record;
  if (landingRepair && reviewLane) return refused(`activation names repair_pr but ${scopeIssue} is a review-only lane`);
  if (landingRepair && !cardContract(scopeIssue)) return refused(`activation names repair_pr but ${scopeIssue} is not a committed card lane`);
  // SHU-303: a review-only lane runs only review-only records, with one of the
  // reviewers its committed lane lists; a review-only record runs nowhere else.
  if (reviewLane) {
    if (!("review_pr" in record)) return refused(`activation for review-only lane ${scopeIssue} must name review_pr, review_base_sha and pr_author_family`);
    if (!reviewLane.reviewer_lanes.includes(record.reviewer_lane)) {
      return refused(`activation reviewer_lane ${record.reviewer_lane} is not one of the review lane's ${reviewLane.reviewer_lanes.join(", ")}`);
    }
  } else if ("review_pr" in record) {
    return refused(`activation names review_pr but ${scopeIssue} is not a review-only lane`);
  }

  // (4) Revision binding — resolved from the running checkout, never self-declared.
  const revision = resolveCoordinatorRevision({ dir, gitHead, io });
  if (!revision) return refused("the running coordinator revision could not be resolved (fail closed)");
  if (record.coordinator_revision !== revision) {
    return refused(`activation is bound to revision ${record.coordinator_revision} but this coordinator is ${revision}`);
  }

  // (5) Capacity binding — an activation may never exceed the committed cap.
  if (record.slots !== 1) return refused(`activation requests ${record.slots} slots; a single-run activation is one slot`);
  const maxDispatch = Number.isInteger(config?.max_dispatch) ? config.max_dispatch : 1;
  if (record.slots !== maxDispatch) {
    return refused(`activation slots (${record.slots}) do not match committed max_dispatch (${maxDispatch})`);
  }

  // (6) Expiry — must be in the future and within the reviewed window.
  const expiry = new Date(record.expires_at).getTime();
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(at)) return refused("current time could not be resolved (fail closed)");
  if (expiry <= at) return refused(`activation expired at ${record.expires_at}`, reportingRefusal(record, "expired"));
  if (expiry - at > MAX_ACTIVATION_WINDOW_MS) {
    return refused(`activation expiry is more than ${MAX_ACTIVATION_WINDOW_MS / 3600000}h away — the window is not bounded`);
  }

  // (7) One use — spent once the bound target's episode has ended.
  //     The episode — not a single step — is the unit of use: see episodeVerdict().
  const episode = episodeVerdict({
    receipts,
    targetIssueId: record.target_issue_id,
    config,
    // SHU-231: spend is decided inside this episode's boundary. The receipt list
    // itself is untouched — capacity, lifecycle and the failure budget still see
    // every historical receipt.
    episodeScope: episodeScopeFor(record),
    // SHU-225: the record's own first-review lane is the ONLY source of a
    // bootstrap reviewer. Card labels and comment text are never consulted.
    bootstrapReviewer: record.reviewer_lane ? { lane: record.reviewer_lane } : null,
    // Self-repair B1: null unless the record is a landing repair.
    repair: repairFromActivation(record, config),
  });
  if (episode.ended) {
    return refused(
      `activation is spent: the episode for ${record.target_issue_id} ended — ${episode.reason}`,
      reportingRefusal(record, "spent"),
    );
  }

  return {
    requested: true,
    state: "armed",
    valid: true,
    reason: null,
    target_issue_id: record.target_issue_id,
    activation_id: record.activation_id,
    authorization_ref: record.authorization_ref,
    coordinator_revision: record.coordinator_revision,
    slots: record.slots,
    expires_at: record.expires_at,
    reviewer_lane: record.reviewer_lane ?? null,
    writer_lane: record.writer_lane ?? null,
    supersedes_attempt_ids: record.supersedes_attempt_ids ?? [],
    initial_target_sha: record.initial_target_sha ?? null,
    ...(reviewLane ? { review_only: true, review_pr: record.review_pr, review_base_sha: record.review_base_sha, pr_author_family: record.pr_author_family } : {}),
    ...(landingRepair ? { landing_repair: true, repair_pr: record.repair_pr, repair_of: record.repair_of, repair_findings: record.repair_findings,
      repair_evidence_digest: record.repair_evidence_digest, max_rounds: record.max_rounds } : {}),
    episode: episode.reason,
    // SHU-225: the episode's routable successor, when one exists. This is what
    // re-admits the issue to selection for the NEXT step of the SAME episode.
    successor: episode.successor ?? null,
  };
}

// The belt-and-braces check at claim time: the issue about to be claimed must be
// the activated target. The committed scope already guarantees this; this exists so
// that a future change to selection logic cannot quietly dispatch something else
// under a live activation.
// The name an operator needs for an activation that is not armed: its own
// ACT_* code when it has one, else what the refusal says about its lifetime.
export function activationRefusalCode(activation) {
  if (/^ACT_[A-Z0-9_]{2,32}$/.test(activation?.code ?? "")) return activation.code;
  if (["expired", "spent"].includes(activation?.reporting_exception)) return `ACTIVATION_${activation.reporting_exception.toUpperCase()}`;
  if (/^activation is spent/.test(activation?.reason ?? "")) return "ACTIVATION_SPENT";
  return "ACTIVATION_REFUSED";
}

// SHU-71 run 6: the check made just before a worker crosses the adapter
// boundary. A failed evidence read is read again, a bounded number of times,
// as the tick and the worker's own check do; any refusal comes back named.
export const FINAL_CHECK_RETRIES = 2;
export const FINAL_CHECK_WAIT_MS = 3000;
export function finalLaunchActivation(check, issueId, wait = delay => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); }) {
  let activation = check();
  for (let retry = 0; activation?.code === "ACT_EVIDENCE_UNAVAILABLE" && retry < FINAL_CHECK_RETRIES; retry++) {
    wait(FINAL_CHECK_WAIT_MS);
    activation = check();
  }
  if (activation?.state !== "armed") return { ok: false, code: activationRefusalCode(activation) };
  if (!activationAllowsTarget(activation, issueId)) return { ok: false, code: "ACTIVATION_TARGET_NOT_ALLOWED" };
  return { ok: true, code: null };
}

export function activationAllowsTarget(activation, issueId) {
  if (!activation || activation.state !== "armed") return true;
  if (activation.kind === "two-fixture-v1") return activation.target_issue_ids.includes(issueId);
  return activation.target_issue_id === issueId;
}

// ---------------------------------------------------------------------------
// Operator-facing rendering
// ---------------------------------------------------------------------------

export function renderActivationLine(activation) {
  if (!activation || activation.state === "absent") return "activation=absent (committed gates only)";
  if (activation.state === "armed") {
    const pair = activation.writer_lane ? ` writer=${activation.writer_lane} reviewer=${activation.reviewer_lane}`
      : activation.review_only ? ` review-only pr=#${activation.review_pr} head=${activation.initial_target_sha} base=${activation.review_base_sha} reviewer=${activation.reviewer_lane}` : "";
    const repair = activation.landing_repair ? ` landing-repair pr=#${activation.repair_pr} head=${activation.initial_target_sha} of=${activation.repair_of}` : "";
    return `activation=ARMED id=${activation.activation_id} target=${activation.target_issue_id} ref=${activation.authorization_ref} revision=${activation.coordinator_revision} slots=${activation.slots} expires=${activation.expires_at}${pair}${repair}`;
  }
  return `activation=REFUSED (${activation.reason})`;
}
