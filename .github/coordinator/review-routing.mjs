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

export const WORK_ORDER_VERSION = "1.0.0";

export const ROLES = Object.freeze(["build", "review", "revise"]);

export const RUNTIMES = Object.freeze(["codex-cli", "claude-code", "hermes-pool"]);

// Capabilities each role requires. build/revise are WRITE roles; review is
// READ-ONLY (no commit/push authority).
export const ROLE_CAPABILITIES = Object.freeze({
  build: ["worktree-write", "commit", "test"],
  revise: ["worktree-write", "commit", "test"],
  review: ["read", "test"],
});

// Which roles each runtime may perform. Unsupported combos fail at validation,
// before any launch side effect.
export const RUNTIME_ROLE_SUPPORT = Object.freeze({
  "codex-cli": ["build", "revise", "review"],
  "claude-code": ["review", "build", "revise"],
  "hermes-pool": ["build", "revise", "review"],
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
  return { ok: true };
}

export function capabilitiesFor(order) {
  const caps = ROLE_CAPABILITIES[order?.role];
  return caps ? [...caps] : [];
}

// One trusted launch receipt collapsed to the identity facts routing needs.
// `actor` is the immutable worker session identity from the receipt.
export function provenanceEntry({ attempt_id, actor, role, runtime, target_sha, result_sha = null, kind = "launch" }) {
  return { attempt_id, actor, role, runtime, target_sha, result_sha, kind };
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
  const { requested = null, entries = [], max_revise = 3, review_round = 0 } = state;
  if (!requested || typeof requested !== "object") return { ok: false, reason: "no completed work order to route from" };
  const role = requested.role;

  if (role === "build" || role === "revise") {
    const eligible = eligibleReviewers(entries, { candidateRuntimes: requested.review_runtimes ?? RUNTIMES });
    if (eligible.length === 0) {
      return { ok: false, reason: "no eligible non-author reviewer — visible HOLD until a fresh session is available", exhausted: false, hold: "no_eligible_reviewer" };
    }
    const reviewer = eligible[0];
    // The review binds the WRITE's output head (result_sha) when the completed
    // build/revise moved the branch — never the stale input target_sha.
    const outputHead = latestResultSha(entries, requested.attempt_id) ?? requested.target_sha;
    return {
      ok: true,
      order: mintOrder(requested, {
        role: "review",
        runtime: reviewer.runtime,
        actor: reviewer.actor,
        target_sha: outputHead,
        attempt_id: freshAttempt(requested.attempt_id, "review", review_round + 1),
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
      return {
        ok: true,
        order: mintOrder(requested, {
          role: "revise",
          runtime: writer.runtime,
          actor: writer.actor,
          attempt_id: freshAttempt(requested.attempt_id, "revise", review_round + 1),
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
// A "codex-builder" receipt is a build (first write) — later writes on the
// same issue are revise orders minted by routing, so they carry role revise
// from the directive, not from the worker label.
export function roleForRequestedWorker(requestedWorker) {
  if (requestedWorker === "claude-verifier") return "review";
  if (requestedWorker === "codex-builder") return "build";
  if (requestedWorker === "hermes-box") return "build";
  return null;
}

// Runtime name for a requested worker lane (matches RUNTIMES vocabulary).
export function runtimeForRequestedWorker(requestedWorker) {
  if (requestedWorker === "claude-verifier") return "claude-code";
  if (requestedWorker === "codex-builder") return "codex-cli";
  if (requestedWorker === "hermes-box") return "hermes-pool";
  return null;
}

// Collapse a durable launch receipt to the identity facts routing needs.
// `kind: "edited"` is only set when the caller can prove the review edited
// code (reconcile does not fabricate it from links alone).
export function provenanceFromReceipt(receipt, { kind = "launch" } = {}) {
  if (!receipt || typeof receipt !== "object") return null;
  const role = roleForRequestedWorker(receipt.requested_worker);
  const runtime = runtimeForRequestedWorker(receipt.requested_worker);
  // A worker_identity is REQUIRED for routing: an anonymous launch receipt
  // proves nothing about who acted, so it can neither exclude an author nor
  // qualify as an eligible fresh reviewer (ambiguous provenance -> HOLD).
  if (typeof receipt.worker_identity !== "string" || receipt.worker_identity.length === 0) return null;
  if (!role || !runtime) return null;
  if (typeof receipt.target_sha !== "string" || !/^[0-9a-f]{40}$/.test(receipt.target_sha)) return null;
  return provenanceEntry({
    attempt_id: receipt.attempt_id,
    actor: receipt.worker_identity,
    role,
    runtime,
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
export function verdictMatchesLane(requestedWorker, evidenceStage) {
  const verdict = outcomeForEvidenceStage(evidenceStage);
  if (!verdict) return false;
  const lane = roleForRequestedWorker(requestedWorker);
  if (!lane) return false;
  if (lane === "review") return verdict.role === "review"; // verifier: PASS/BLOCKED/FAILED only
  return verdict.role === "build" || verdict.role === "revise"; // writer: BUILD_READY/REVISION_READY only
}

// Compute the successor work order for an issue after ONE receipt reaches a
// verdict-bearing terminal stage. Pure: returns the directive to post, or a
// hold reason — never launches anything itself.
//
//   state.issueReceipts — ALL durable receipts for the issue (every attempt),
//     oldest first; used to rebuild the provenance lineage.
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
  } = state;
  if (!terminal || typeof terminal !== "object") {
    return { ok: false, reason: "no terminal receipt to route from" };
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
    runtime: runtimeForRequestedWorker(terminal.requested_worker),
    issue_id: terminal.issue_id,
    attempt_id: terminal.attempt_id,
    target_sha: terminal.target_sha,
    authorization_ref: terminal.authorization_ref ?? terminal.issue_id,
    review_runtimes: RUNTIMES.filter((r) => RUNTIME_ROLE_SUPPORT[r]?.includes("review")),
    outcome: verdict.outcome,
  };
  if (!requested.runtime) {
    return { ok: false, reason: `cannot route from unknown worker lane ${String(terminal.requested_worker)}` };
  }
  // review_round: count of completed review attempts already in the lineage.
  const review_round = entries.filter((e) => e.role === "review").length;
  return nextWorkOrder({ requested, entries, max_revise, review_round });
}
