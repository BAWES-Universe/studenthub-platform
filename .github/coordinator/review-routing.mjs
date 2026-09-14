// review-routing.mjs — role-neutral work orders + independent review routing
// (SHU-68, Hermes claim 2026-09-07).
//
// Separates ROLE (build | review | revise) from RUNTIME (codex-cli | claude-code
// | hermes-pool). A work order names both independently; unsupported role x
// runtime combinations fail visibly, never silently re-route.
//
// Immutable-identity problem: every coordinator participant commits under the
// repo owner's Git identity, so Git history alone cannot separate author from
// reviewer. Independence is therefore decided from trusted launch receipts
// (attempt_id + actor session + role + runtime), never from Git author strings
// or self-reported session identifiers alone.
//
// Rules (SHU-68 acceptance + Opus review):
//  - Role comes from trusted task state, not adapter name or free text; a
//    caller cannot label a write job "review" to bypass the gate.
//  - Ambiguous provenance -> ineligible/HOLD, never "independent by default".
//  - A provider/model swap never erases an author session.
//  - Revision attempts are bounded; exhaustion is a visible HOLD, never a
//    relaunch storm.

import { fixtureScopeConfigured, successorWorkspaceScope, validateWorkspaceScope } from "./workspace-scope.mjs";
import {
  ROLES, RUNTIMES, RUNTIME_ROLE_SUPPORT, RUNTIME_FAMILY, LANES, LANE_NAMES,
  REVIEW_LANES, familyForLane, laneForRuntimeRole, roleForLane, runtimeForLane,
  resolveReceiptRoleAuthority, workerForRuntime as laneForRuntimeDefault,
} from "./launch-vocabulary.mjs";

export const WORK_ORDER_VERSION = "1.0.0";

// The role/runtime/lane vocabulary is SINGLE-SOURCED in launch-vocabulary.mjs
// (SHU-249). These names stay exported here because they are this module's
// public surface, but they are derived, never re-declared.
export { ROLES, RUNTIMES, RUNTIME_ROLE_SUPPORT, RUNTIME_FAMILY, REVIEW_LANES };

// Capabilities each role requires. build/revise are WRITE roles; review is
// READ-ONLY (no commit/push authority).
export const ROLE_CAPABILITIES = Object.freeze({
  build: ["worktree-write", "commit", "test"],
  revise: ["worktree-write", "commit", "test"],
  review: ["read", "test"],
});

// Maps a role to the name of the callback stage that signals SUCCESS for that
// role in the coordinator's receipt machinery (codex-cli/codex-contract use
// BUILD_READY/REVISION_READY; claude-verifier uses PASS). This is a callback
// STAGE name, not a prompt or instruction sent to any runtime.
export const ROLE_SUCCESS_STAGE = Object.freeze({
  build: "BUILD_READY",
  revise: "REVISION_READY",
  review: "PASS",
});

export function validWorkOrder(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "work order is not an object" };
  if (order.version !== WORK_ORDER_VERSION) return { ok: false, reason: `work order version ${order?.version ?? "unset"} != ${WORK_ORDER_VERSION}` };
  if (!ROLES.includes(order.role)) return { ok: false, reason: `unknown role ${String(order.role)}` };
  if (!RUNTIMES.includes(order.runtime)) return { ok: false, reason: `unknown runtime ${String(order.runtime)}` };
  if (!RUNTIME_ROLE_SUPPORT[order.runtime].includes(order.role)) {
    return { ok: false, reason: `runtime ${order.runtime} cannot perform role ${order.role}` };
  }
  if (typeof order.issue_id !== "string" || order.issue_id.length === 0) return { ok: false, reason: "missing issue_id" };
  // attempt_id is lineage state AND the successor seed: freshAttempt slices it
  // to mint the next id. A non-UUID value (e.g. "x") routes to a malformed
  // successor (Codex BLOCK, SHU-68) that the receipt schema rejects, so it
  // must fail here, before routing. Canonical UUID shape; version/variant are
  // not restricted because launch receipts may carry any real UUID.
  if (typeof order.attempt_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order.attempt_id)) {
    return { ok: false, reason: "missing/invalid attempt_id (must be UUID-shaped)" };
  }
  if (typeof order.target_sha !== "string" || !/^[0-9a-f]{40}$/.test(order.target_sha)) return { ok: false, reason: "missing/invalid target_sha" };
  if (typeof order.authorization_ref !== "string" || order.authorization_ref.length === 0) return { ok: false, reason: "missing authorization_ref" };
  if (["workspace_scope", "scope_phase", "allowed_paths"].some((field) => Object.hasOwn(order, field))) {
    const scope = validateWorkspaceScope(order);
    if (!scope.ok) return { ok: false, reason: `invalid workspace authority: ${scope.reason}` };
  }
  return { ok: true };
}

export function capabilitiesFor(order) {
  const caps = ROLE_CAPABILITIES[order?.role];
  return caps ? [...caps] : [];
}

// One trusted launch receipt collapsed to the identity facts routing needs.
// `actor` is the immutable worker session identity from the receipt.
// `requested_worker` is carried for auditability only: authorship is decided
// from the trusted ROLE, never from the lane name (SHU-249). Keeping the lane on
// the entry is what lets a mutation test prove that distinction is load-bearing.
export function provenanceEntry({ attempt_id, actor, role, runtime, requested_worker = null, target_sha, result_sha = null, kind = "launch" }) {
  return { attempt_id, actor, role, runtime, requested_worker, target_sha, result_sha, kind };
}

// Actors who have TOUCHED the change under review. build/revise launch actors
// are authors. A review actor that EDITED (kind "edited") becomes an author
// for the next round and rotates out of eligibility.
export function authorSet(entries) {
  const authors = new Set();
  for (const e of entries ?? []) {
    if (!e || typeof e !== "object") continue;
    if ((e.role === "build" || e.role === "revise") && typeof e.actor === "string" && e.actor.length) {
      authors.add(e.actor);
    }
    if (e.role === "review" && e.kind === "edited" && typeof e.actor === "string" && e.actor.length) {
      authors.add(e.actor);
    }
  }
  return authors;
}

// Eligible reviewers: actors NOT in the author set, whose runtime supports
// review. Freshness is carried by the attempt (new attempt_id), so relabeling
// or resuming an author's session never appears fresh.
export function eligibleReviewers(entries, { candidateRuntimes = RUNTIMES } = {}) {
  const authors = authorSet(entries);
  const eligible = [];
  const seen = new Set();
  for (const e of entries ?? []) {
    if (!e || typeof e !== "object") continue;
    if (e.role !== "review") continue;
    if (typeof e.actor !== "string" || !e.actor.length) continue;
    if (authors.has(e.actor)) continue;
    if (!candidateRuntimes.includes(e.runtime)) continue;
    const key = `${e.runtime}:${e.actor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({ actor: e.actor, runtime: e.runtime, attempt_id: e.attempt_id });
  }
  return eligible;
}

// The most recent build/revise actor is the active writer revisions route to.
export function activeWriter(entries) {
  for (let i = (entries ?? []).length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && (e.role === "build" || e.role === "revise") && typeof e.actor === "string" && e.actor.length) {
      return { actor: e.actor, runtime: e.runtime };
    }
  }
  return null;
}

// The output head of the most recent build/revise entry (its result_sha), or
// null when no completed write recorded a result. Re-review must bind this
// head — the head the completed write actually produced — never the stale
// input target the write started from.
export function latestResultSha(entries, withinAttempt = null) {
  const list = entries ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e || typeof e !== "object") continue;
    if (e.role !== "build" && e.role !== "revise") continue;
    if (withinAttempt && e.attempt_id !== withinAttempt) continue;
    if (typeof e.result_sha === "string" && /^[0-9a-f]{40}$/.test(e.result_sha)) return e.result_sha;
  }
  return null;
}

// Decide the next work order from review state. Pure: no side effects.
//
// state.requested      — the work order that just completed
// state.entries        — provenance entries for this lineage
// state.max_revise     — max revision attempts before exhaustion (default 3)
// state.review_round   — 1-based count of completed review rounds
//
// Returns { ok, order?, terminal?, reason?, hold?, exhausted? }.

// Result-only keys carried by a COMPLETED order (receipt state). They describe
// what the completed work did; they must never be inherited by the successor
// instruction, which has not happened yet. A revise order born with
// outcome:"BLOCKED" (or a review born with outcome:"BUILD_READY") is a new
// instruction that is already "completed" — the leak Codex BLOCKed on.
const RESULT_ONLY_KEYS = new Set(["outcome", "result_sha", "summary", "error"]);

// Mint a successor order from a completed one: copy the instruction fields
// (version/role/runtime/actor/issue/attempt/refs/heads/constraints), strip
// every result-only key, then apply the routing overrides.
function mintOrder(requested, overrides) {
  const base = {};
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (!RESULT_ONLY_KEYS.has(key)) base[key] = value;
  }
  return { ...base, ...overrides };
}

export function nextWorkOrder(state = {}) {
  const { requested = null, entries = [], max_revise = 3, review_round = 0, bootstrapReviewer = null, fixtureLane = null } = state;
  if (!requested || typeof requested !== "object") return { ok: false, reason: "no completed work order to route from" };
  const role = requested.role;

  if (role === "build" || role === "revise") {
    const eligible = eligibleReviewers(entries, { candidateRuntimes: requested.review_runtimes ?? RUNTIMES });
    // The review binds the WRITE's output head (result_sha) when the completed
    // build/revise moved the branch — never the stale input target_sha.
    const outputHead = latestResultSha(entries, requested.attempt_id) ?? requested.target_sha;
    if (eligible.length === 0) {
      // SHU-225 first-review bootstrap: a brand-new episode has no review-role
      // entry, so the HOLD below would be permanent and the loop could never take
      // its first review step. The trusted activation record may name ONE reviewer
      // lane for that first review; every guard lives in bootstrapReviewerFor, and
      // a refused bootstrap falls through to the same visible HOLD as before.
      const boot = bootstrapReviewerFor({ requested, entries, bootstrapReviewer });
      if (boot) {
        return {
          ok: true,
          bootstrapped: true,
          reason: `first review bootstrapped from the trusted activation record (lane ${boot.requested_worker})`,
          order: mintOrder(requested, {
            role: "review",
            runtime: boot.runtime,
            actor: boot.actor,
            requested_worker: boot.requested_worker,
            target_sha: outputHead,
            attempt_id: freshAttempt(requested.attempt_id, "review", review_round + 1),
            ...successorWorkspaceScope("review", fixtureLane),
          }),
        };
      }
      return { ok: false, reason: "no eligible non-author reviewer — visible HOLD until a fresh session is available", exhausted: false, hold: "no_eligible_reviewer" };
    }
    const reviewer = eligible[0];
    // SHU-249: the successor lane is chosen by ROLE, not by the runtime's legacy
    // default lane. A review minted for a Codex runtime must launch on the
    // Codex REVIEW lane (codex-verifier); reusing the builder lane here would
    // make the successor receipt's trusted role disagree with its lane, which
    // the role-authority resolver then HOLDs.
    const reviewLane = laneForRuntimeRole(reviewer.runtime, "review");
    if (!reviewLane) {
      return { ok: false, reason: `no review lane exists for runtime ${String(reviewer.runtime)} — visible HOLD`, exhausted: false, hold: "no_review_lane" };
    }
    return {
      ok: true,
      order: mintOrder(requested, {
        role: "review",
        runtime: reviewer.runtime,
        actor: reviewer.actor,
        // The successor is launched through the same claim path as a first
        // dispatch, so it carries a requested_worker lane like any other.
        requested_worker: reviewLane,
        target_sha: outputHead,
        attempt_id: freshAttempt(requested.attempt_id, "review", review_round + 1),
        ...successorWorkspaceScope("review", fixtureLane),
      }),
    };
  }

  if (role === "review") {
    const outcome = requested.outcome;
    if (outcome === "BLOCKED" || outcome === "FAILED") {
      // review_round is the 1-based round of the review that just BLOCKed.
      // Revision R is scheduled when round R BLOCKs; exhaustion begins only
      // when a BLOCK arrives past max_revise (rounds 1..max_revise each get
      // their revision attempt — the field promises max_revise attempts).
      if (review_round > max_revise) {
        return { ok: false, reason: `revision attempts exhausted after ${review_round} rounds — HOLD`, exhausted: true, hold: "revisions_exhausted" };
      }
      const writer = activeWriter(entries);
      if (!writer) return { ok: false, reason: "no active writer to route the revision to — HOLD", exhausted: false, hold: "no_active_writer" };
      const writerLane = laneForRuntimeRole(writer.runtime, "revise");
      if (!writerLane) {
        return { ok: false, reason: `no writer lane exists for runtime ${String(writer.runtime)} — visible HOLD`, exhausted: false, hold: "no_writer_lane" };
      }
      return {
        ok: true,
        order: mintOrder(requested, {
          role: "revise",
          runtime: writer.runtime,
          actor: writer.actor,
          // Back to the lane that wrote: the revise is the SAME writer family.
          requested_worker: writerLane,
          attempt_id: freshAttempt(requested.attempt_id, "revise", review_round + 1),
          ...successorWorkspaceScope("revise", fixtureLane),
        }),
      };
    }
    if (outcome === "PASS") {
      return { ok: true, terminal: true, reason: "review PASS — loop complete, stop before merge" };
    }
    return { ok: false, reason: `unexpected review outcome ${String(outcome)}` };
  }

  return { ok: false, reason: `cannot route from role ${String(role)}` };
}

// Deterministic fresh attempt id per (prior, stage, round): lineage-traceable,
// unique per launch, uuid-v4-shaped.
export function freshAttempt(priorAttemptId, stage, round) {
  const prior = priorAttemptId ?? "00000000-0000-4000-8000-000000000000";
  const seed = `${prior}:${stage}:${round}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0");
  let h2 = 0x811c9dc5;
  for (let i = 0; i < stage.length; i++) {
    h2 ^= stage.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const stageTag = h2.toString(16).padStart(8, "0").slice(0, 4);
  const roundTag = round.toString(16).padStart(4, "0");
  return `${hex}-${stageTag}-4${prior.slice(1, 4)}-8${prior.slice(4, 7)}-${prior.slice(0, 8)}${roundTag}`;
}

// Render a routed work order as the machine-readable directive posted to the
// Linear card. The card — not a human relay — is the instruction channel: the
// named actor reads role/runtime/exact head/stage and executes without anyone
// forwarding messages. Round-trips through parseWorkOrderDirective.
export const WORK_ORDER_MARKER = "coordinator-work-order v1";

export function renderWorkOrderDirective(order) {
  const v = validWorkOrder(order);
  if (!v.ok) throw new Error(`cannot render invalid work order: ${v.reason}`);
  return [
    `<!-- ${WORK_ORDER_MARKER} -->`,
    `**Work order (SHU-68 routing)** — role ${order.role} · runtime ${order.runtime} · actor ${order.actor ?? "coordinator-assigned"}`,
    "```json",
    JSON.stringify(
      {
        version: order.version,
        role: order.role,
        runtime: order.runtime,
        actor: order.actor ?? null,
        issue_id: order.issue_id,
        attempt_id: order.attempt_id,
        authorization_ref: order.authorization_ref,
        target_sha: order.target_sha,
        base_sha: order.base_sha ?? null,
        outcome: order.outcome ?? null,
        writer: order.writer ?? null,
        workspace_scope: order.workspace_scope,
        scope_phase: order.scope_phase,
        allowed_paths: order.allowed_paths,
        scoped_base_sha: order.scoped_base_sha ?? null,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

// Parse a directive back into an order object. Returns { ok, order? } —
// a malformed or forged-looking directive is never trusted as an order.
export function parseWorkOrderDirective(body) {
  if (typeof body !== "string" || !body.includes(`<!-- ${WORK_ORDER_MARKER} -->`)) {
    return { ok: false, reason: "not a work-order directive" };
  }
  const m = /```json\n([\s\S]*?)\n```/.exec(body);
  if (!m) return { ok: false, reason: "no JSON block in directive" };
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { ok: false, reason: "directive JSON does not parse" };
  }
  if (validWorkOrder(parsed).ok) return { ok: true, order: parsed };
  return { ok: false, reason: validWorkOrder(parsed).reason };
}

// ---------------------------------------------------------------------------
// Reconcile wiring bridge (SHU-68 real-path integration, Hermes 2026-09-08)
// ---------------------------------------------------------------------------
// Translate the coordinator's durable receipts + validated evidence into the
// pure routing state nextWorkOrder() consumes. This is the ONLY seam between
// reconcile.mjs's lifecycle receipts and the role-neutral routing module: it
// runs after a RUNNING receipt transitions to a terminal stage with a verdict.
//
// Guards preserved (all fail closed):
//   * A terminal receipt without worker identity yields NO provenance entry
//     for routing (ambiguous authorship must never mint an order).
//   * Evidence must bind the same attempt_id the receipt carries.
//   * A verdict only routes when its stage is a real review/write outcome.

// Work order role for a launched receipt, by requested worker lane.
//
// SHU-249: this is the LEGACY, lane-derived role and it exists for two things
// only — reading retained receipts at the legacy receipt_version (byte-for-byte
// as deployed), and acting as the disagreement baseline for an authoritative
// receipt. It is NOT how a new receipt's role is decided: that is
// resolveReceiptRoleAuthority() in launch-vocabulary.mjs, which refuses rather
// than falling back to this mapping. Both mappings are table lookups over the
// one vocabulary.
export function roleForRequestedWorker(requestedWorker) {
  return roleForLane(requestedWorker);
}

// Runtime name for a requested worker lane (matches RUNTIMES vocabulary).
export function runtimeForRequestedWorker(requestedWorker) {
  return runtimeForLane(requestedWorker);
}

// Inverse: the lane that owns a runtime. Used when routing has a runtime (the
// eligible reviewer, or the active writer) and the LAUNCH needs the lane name —
// the successor is dispatched through the same claim path as a first dispatch,
// so it must carry a requested_worker exactly as one. The legacy inverse is
// preserved (codex-builder / claude-verifier / hermes-box).
export function workerForRuntime(runtime) {
  return laneForRuntimeDefault(runtime);
}

// Families (SHU-225). Independence is a FAMILY property, not a string
// difference: two lanes of the same family are the same verifier, so a
// first-review bootstrap that names the write lane's own family is self-review.
// Both maps are derived from the one lane table in launch-vocabulary.mjs.
export const WORKER_FAMILY = Object.freeze(Object.fromEntries(
  LANE_NAMES.map((lane) => [lane, LANES[lane].family]),
));

export function runtimeFamily(runtime) {
  return RUNTIME_FAMILY[runtime] ?? null;
}

export function workerFamily(requestedWorker) {
  return familyForLane(requestedWorker);
}

// bootstrapReviewerFor — the TRUSTED first-review bootstrap (SHU-225, Option A as
// amended on SHU-63). A brand-new episode's lineage holds no review-role entry, so
// no reviewer is eligible and the first review order can never be minted: the loop
// stalls permanently on its first step. The operator-owned single-run activation
// record may name exactly ONE reviewer lane to bootstrap that first review.
//
// It is deliberately narrow, and every narrowing is a refusal rather than a guess:
//   * only when the lineage holds ZERO review-role entries — once a real review
//     receipt exists, durable lineage owns routing and this returns null (inert);
//   * the lane must be a known reviewer-capable worker (unknown -> null -> HOLD);
//   * independence is CHECKED, not declared: the lane's family must differ from
//     the family of the write lane that just completed, and both families must be
//     known. A same-family lane is self-verification, never review.
// The lane is not a fabricated session: the order's `actor` is the LANE identity,
// while the receipt records whatever session the adapter actually launches.
export function bootstrapReviewerFor({ requested = {}, entries = [], bootstrapReviewer = null } = {}) {
  if (!bootstrapReviewer || typeof bootstrapReviewer !== "object") return null;
  const lane = bootstrapReviewer.lane;
  if (typeof lane !== "string" || !REVIEW_LANES.includes(lane)) return null;
  if ((entries ?? []).some((e) => e && e.role === "review")) return null;
  const writeFamily = workerFamily(requested?.requested_worker);
  const reviewFamily = workerFamily(lane);
  if (!writeFamily || !reviewFamily || writeFamily === reviewFamily) return null;
  return { lane, requested_worker: lane, runtime: runtimeForRequestedWorker(lane), actor: lane, bootstrapped: true };
}

// Collapse a durable launch receipt to the identity facts routing needs.
// `kind: "edited"` is only set when the caller can prove the review edited
// code (reconcile does not fabricate it from links alone).
export function provenanceFromReceipt(receipt, { kind = "launch" } = {}) {
  if (!receipt || typeof receipt !== "object") return null;
  // SHU-249: the receipt's role comes from the TRUSTED field when the receipt
  // declares one (role-authority version) and from the lane only for the legacy
  // version. A receipt whose authority cannot be resolved yields NO provenance
  // entry: ambiguous authorship must never mint an order, and it must never be
  // silently re-read through the lane name.
  const authority = resolveReceiptRoleAuthority(receipt);
  if (!authority.ok) return null;
  const { role, runtime } = authority;
  // A worker_identity is REQUIRED for routing: an anonymous launch receipt
  // proves nothing about who acted, so it can neither exclude an author nor
  // qualify as an eligible fresh reviewer (ambiguous provenance -> HOLD).
  if (typeof receipt.worker_identity !== "string" || receipt.worker_identity.length === 0) return null;
  if (typeof receipt.target_sha !== "string" || !/^[0-9a-f]{40}$/.test(receipt.target_sha)) return null;
  return provenanceEntry({
    attempt_id: receipt.attempt_id,
    actor: receipt.worker_identity,
    role,
    runtime,
    requested_worker: receipt.requested_worker ?? null,
    target_sha: receipt.target_sha,
    result_sha: typeof receipt.result_sha === "string" && /^[0-9a-f]{40}$/.test(receipt.result_sha) ? receipt.result_sha : null,
    kind,
  });
}

// Verdict stage -> routing outcome. BUILD_READY completes a BUILD whose
// successor is a REVIEW; REVISION_READY completes a REVISE (same routing
// branch — nextWorkOrder treats build|revise writes alike — but the role is
// kept truthful for lineage); PASS/BLOCKED/FAILED are REVIEW verdicts whose
// successors differ by outcome. Null when the stage is not a verdict at all
// (e.g. an intermediate poll status).
export function outcomeForEvidenceStage(stage) {
  if (stage === "BUILD_READY") return { role: "build", outcome: null };
  if (stage === "REVISION_READY") return { role: "revise", outcome: null };
  if (stage === "PASS") return { role: "review", outcome: "PASS" };
  if (stage === "BLOCKED") return { role: "review", outcome: "BLOCKED" };
  if (stage === "FAILED") return { role: "review", outcome: "FAILED" };
  return null;
}

// Lane/verdict compatibility — a receipt may ONLY route when the verdict stage
// matches the lane that produced it. A builder (write lane) that reports
// BLOCKED has NOT completed a review: that is an in-scope blocker → machine
// HOLD, never a revise order. Conversely a verifier (review lane) reporting
// BUILD_READY is incoherent. Mismatched verdicts fail closed (no route).
// Lane-name keying is valid only while each lane carries exactly one role.
// A future two-role lane must switch this check to the order's role.
export function verdictMatchesLane(requestedWorker, evidenceStage) {
  const verdict = outcomeForEvidenceStage(evidenceStage);
  if (!verdict) return false;
  const lane = roleForRequestedWorker(requestedWorker);
  if (!lane) return false;
  if (lane === "review") return verdict.role === "review"; // verifier: PASS/BLOCKED/FAILED only
  return verdict.role === "build" || verdict.role === "revise"; // writer: BUILD_READY/REVISION_READY only
}

// ---------------------------------------------------------------------------
// Fold-time review-provenance gate (SHU-73)
// ---------------------------------------------------------------------------
// Routing-time eligibility picks the current, structurally separate review
// lane when an order is minted. At verdict fold time this guard requires the
// adapter-observed session and refuses wholly unreadable lineage instead of
// silently treating it as an empty author set. The worker identities currently
// contain attempt ids, so this function does not claim stable cross-role actor
// independence; SHU-71 owns that requirement before role reversal is enabled.
//
//   receipt          — the terminal-bound receipt whose verdict is folding
//   lineageReceipts  — ALL durable receipts for the same issue (every attempt),
//                      oldest first; used to rebuild the author set. When the
//                      caller has no lineage (standalone fold), author exclusion
//                      cannot be evaluated and the gate falls back to the
//                      session-presence requirement only — never to "independent
//                      by default" from self-declared labels.
export function reviewVerdictProvenanceValid(receipt, lineageReceipts = []) {
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "no receipt to evaluate" };
  // Writer (build/revise) verdicts are not independence claims — the rule only
  // constrains REVIEW verdicts.
  //
  // SHU-249: the verdict's role is read from the TRUSTED authority, not from
  // roleForRequestedWorker(). Under role reversal the lane name is exactly what
  // is being flipped, so reading it here would let a reversed-role receipt
  // relabel itself out of the gate. A receipt whose role authority cannot be
  // resolved is refused rather than assumed non-review.
  const authority = resolveReceiptRoleAuthority(receipt);
  if (!authority.ok) {
    return { ok: false, reason: `review verdict has no resolvable launch role — ${authority.reason}` };
  }
  if (authority.role !== "review") return { ok: true };
  // An observed verifier session is REQUIRED. worker_identity is only ever set
  // from an adapter ack/poll (never fabricated, never self-declared), so its
  // absence means the verdict cannot be attributed to a distinct reviewer.
  if (typeof receipt.worker_identity !== "string" || receipt.worker_identity.length === 0) {
    return { ok: false, reason: "review verdict without an observed verifier session (worker_identity) — ambiguous provenance" };
  }
  const supplied = lineageReceipts ?? [];
  const entries = supplied.map((r) => provenanceFromReceipt(r)).filter(Boolean);
  if (supplied.length > 0 && entries.length === 0) {
    return { ok: false, reason: "reviewed lineage carries no readable provenance — authorship ambiguous" };
  }
  const authors = authorSet(entries);
  if (receipt.receipt_version === "1.1.0" && entries.some((entry) =>
    authors.has(entry.actor) && entry.runtime === authority.runtime)) {
    return { ok: false, reason: "review runtime is an author family of the reviewed lineage — not independent" };
  }
  if (authors.has(receipt.worker_identity)) {
    return { ok: false, reason: `verifier session ${receipt.worker_identity} is an author of the reviewed lineage — not independent` };
  }
  return { ok: true };
}

// Route ONE terminal verdict-bearing receipt to its successor work order. This
// is the reconcile-facing bridge over nextWorkOrder(): it rebuilds the lineage
// from durable receipts and validates the verdict against the verified head.
//
//   state.terminal     — the receipt that just became terminal (must carry the
//     worker identity and the evidence attempt binding).
//   state.evidenceStage — validated verdict stage bound to terminal.attempt_id.
//   state.evidenceResultSha — the exact commit the completed WRITE produced
//     (from the validated callback evidence). Receipts never carry result_sha,
//     so the successor review binds this output head, never the stale input
//     target_sha. Ignored for review verdicts.
//   state.max_revise   — bound on revision rounds (default 3).
//   state.authoritativeHead — the VERIFIED live branch head (github token
//     available + fetched). When present, a successor review binds THIS head and
//     any evidenceResultSha that disagrees is stale/forged — the write did not
//     produce it — so routing fails closed (Codex BLOCK #1, SHU-68): an
//     attacker-chosen 40-hex never becomes a review target. Without it (no token
//     / head unverifiable), fall back to the durable receipt result_sha, then the
//     bound target_sha.
//
// Returns { ok, order?, terminal?, reason?, hold?, exhausted?, forged? }.
export function routeSuccessorFromReceipts(state = {}) {
  const {
    issueReceipts = [],
    terminal = null,
    evidenceStage = null,
    evidenceResultSha = null,
    max_revise = 3,
    authoritativeHead = null,
    bootstrapReviewer = null,
    fixtureLane = null,
  } = state;
  if (!terminal || typeof terminal !== "object") {
    return { ok: false, reason: "no terminal receipt to route from" };
  }
  if (fixtureLane && fixtureLane.id !== terminal.issue_id) {
    return { ok: false, reason: "LANE_MISMATCH: successor fixture does not match terminal issue" };
  }
  // SHU-249: the terminal receipt's role/runtime come from the TRUSTED field
  // when it declares one. A receipt whose authority cannot be resolved (unknown
  // lane, missing authoritative role, or a trusted role contradicting the lane)
  // is refused here — it never routes on the lane-derived role instead.
  const terminalAuthority = resolveReceiptRoleAuthority(terminal);
  if (!terminalAuthority.ok) {
    return { ok: false, hold: "role_authority_invalid", reason: `terminal receipt has no resolvable launch role — ${terminalAuthority.reason}` };
  }
  if (terminalAuthority.role === "review") {
    const independent = reviewVerdictProvenanceValid(terminal, issueReceipts);
    if (!independent.ok) return { ...independent, hold: "author_exclusion" };
  }
  const scopedWriter = issueReceipts.filter((r) => r && ["BUILD_READY", "REVISION_READY"].includes(r.verdict_stage) && r.workspace_scope === "scoped").at(-1);
  const scopedContractReceipt = fixtureLane?.id === terminal.issue_id && fixtureScopeConfigured(fixtureLane) && Boolean(scopedWriter);
  if (scopedContractReceipt) {
    const terminalScope = validateWorkspaceScope(terminal);
    if (!terminalScope.ok) return { ok: false, reason: `terminal workspace authority invalid: ${terminalScope.reason}` };
  }
  const verdict = outcomeForEvidenceStage(evidenceStage);
  if (!verdict) {
    return { ok: false, reason: `evidence stage ${String(evidenceStage)} is not a routing verdict` };
  }
  // Lane/verdict compatibility: a builder BLOCK is an in-scope blocker (HOLD),
  // not a review verdict; a verifier BUILD_READY is incoherent. Fail closed.
  if (!verdictMatchesLane(terminal.requested_worker, evidenceStage)) {
    return { ok: false, reason: `verdict ${String(evidenceStage)} does not match lane ${String(terminal.requested_worker)} — machine HOLD, no route` };
  }
  // Authoritative-head binding (Codex BLOCK #1, SHU-68). When the VERIFIED head
  // is known, a conflicting evidence result_sha is forged or stale — fail closed.
  const authoritative = typeof authoritativeHead === "string" && /^[0-9a-f]{40}$/.test(authoritativeHead);
  if (authoritative && typeof evidenceResultSha === "string" && /^[0-9a-f]{40}$/.test(evidenceResultSha) && evidenceResultSha !== authoritativeHead) {
    return {
      ok: false,
      forged: true,
      reason: `evidence result_sha ${evidenceResultSha} does not match verified authoritative head ${authoritativeHead} — FORGED or stale; FAIL CLOSED`,
    };
  }
  // Effective output head: verified head when known, else durable receipt
  // result_sha (replay path), else the supplied evidence result_sha, else the
  // bound input target_sha (no write advanced the branch).
  const durableResultSha = typeof terminal.result_sha === "string" && /^[0-9a-f]{40}$/.test(terminal.result_sha) ? terminal.result_sha : null;
  const outputHead = authoritative ? authoritativeHead : durableResultSha ?? evidenceResultSha;
  // Provenance lineage: every receipt that actually ran (has a worker
  // identity), oldest first. Reviews that EDITED are authors — reconcile can
  // only mark kind:"edited" with proof; the pure bridge never fabricates it.
  const entries = [];
  for (const receipt of issueReceipts) {
    const entry = provenanceFromReceipt(receipt);
    if (!entry) continue;
    // Stamp the completed write's OUTPUT head — the head a successor review must
    // bind. Prefer the authoritative/durable head over the volatile evidence.
    if (receipt.attempt_id === terminal.attempt_id && (entry.role === "build" || entry.role === "revise")) {
      if (typeof outputHead === "string" && /^[0-9a-f]{40}$/.test(outputHead)) {
        entry.result_sha = outputHead;
      }
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    return { ok: false, reason: "no provenance entries — every receipt lacks worker identity (ambiguous authorship HOLDs routing)" };
  }
  // The completed order: role from the verdict + worker lane, outcome only for
  // review verdicts. target_sha is the head this attempt was bound to.
  const requested = {
    version: WORK_ORDER_VERSION,
    role: verdict.role,
    runtime: terminalAuthority.runtime,
    // The completed order's own lane. Routing uses it for two things: the
    // revise goes back to the WRITER's lane, and the first-review bootstrap
    // checks independence against the family of the lane that just wrote.
    requested_worker: terminal.requested_worker,
    issue_id: terminal.issue_id,
    attempt_id: terminal.attempt_id,
    target_sha: terminal.target_sha,
    authorization_ref: terminal.authorization_ref ?? terminal.issue_id,
    review_runtimes: RUNTIMES.filter((r) => RUNTIME_ROLE_SUPPORT[r]?.includes("review")),
    outcome: verdict.outcome,
    workspace_scope: terminal.workspace_scope ?? (verdict.role === "review" ? "full" : "full"),
    scope_phase: terminal.scope_phase ?? (verdict.role === "review" ? "review" : "initial"),
    allowed_paths: Array.isArray(terminal.allowed_paths) ? [...terminal.allowed_paths] : [],
    scoped_base_sha: terminal.scoped_base_sha ?? null,
  };
  if (!requested.runtime) {
    return { ok: false, reason: `cannot route from unknown worker lane ${String(terminal.requested_worker)}` };
  }
  // review_round: count of completed review attempts already in the lineage.
  const review_round = entries.filter((e) => e.role === "review").length;
  if (scopedContractReceipt && verdict.role === "review" && evidenceStage !== "BLOCKED" && evidenceStage !== "PASS") {
    return { ok: false, reason: "fixture revision authority requires a validated BLOCKED verdict" };
  }
  if (scopedContractReceipt && evidenceStage === "BLOCKED") {
    const writer = scopedWriter;
    if (writer?.receipt_version === "1.1.0") {
      const writerAuthority = resolveReceiptRoleAuthority(writer);
      if (!writerAuthority.ok || !["build", "revise"].includes(writerAuthority.role) || terminal.branch !== writer.branch || terminal.issue_id !== writer.issue_id || writer.result_sha !== terminal.target_sha) {
        return { ok: false, reason: "validated BLOCK does not bind the active writer role and exact reviewed head" };
      }
    } else if (!writer || writer.requested_worker !== "codex-builder" || writer.branch !== terminal.branch || writer.issue_id !== terminal.issue_id || terminal.target_sha !== writer.result_sha) {
      return { ok: false, reason: "validated BLOCK does not bind the active same-branch Codex writer and exact reviewed head" };
    }
  }
  return nextWorkOrder({ requested, entries, max_revise, review_round, bootstrapReviewer, fixtureLane });
}
