// launch-vocabulary.mjs — the SINGLE SOURCE OF TRUTH for the coordinator's
// launch vocabulary (SHU-249).
//
// WHY THIS FILE EXISTS:
//   Before SHU-249 the launch vocabulary was re-declared in four places — the
//   receipt enum (reconcile.REQUESTED_WORKERS), the hardcoded adapter if-chain
//   (reconcile.adapterNameFor), the reviewer-lane set
//   (review-routing.REVIEW_LANES) and an INDEPENDENT role set
//   (capacity-scheduler.ROLES). Adding a lane therefore meant remembering four
//   unrelated edits, and two of the copies (adapterNameFor, the scope default)
//   fell back SILENTLY instead of failing closed.
//
//   Everything below is declared once: the roles, the runtimes, the runtime x
//   role capability matrix, the runtime -> adapter map, the lane table, the
//   receipt-version gate and the role-authority resolver. The enum, the adapter
//   map, the activation reviewer set and the capacity role set are DERIVED from
//   it, so a new lane is one table row and cannot half-land.
//
// ROLE AUTHORITY (SHU-249, the point of the change):
//   A lane NAME is a launch channel, not an authority. Receipts at the legacy
//   receipt_version keep reading the LEGACY, lane-derived role byte-for-byte
//   (retained receipts are append-only and are never rewritten or backfilled).
//   Receipts at the role-authority version must DECLARE `role` and `runtime`,
//   and those fields are authoritative: routing and validation prefer them and
//   HOLD on any disagreement with the lane-derived role — never a silent pick,
//   never a fallback to the lane name.

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_BUILD = "build";
export const ROLE_REVIEW = "review";
export const ROLE_REVISE = "revise";

// The complete role vocabulary. build/revise are WRITE roles; review is
// READ-ONLY (no commit/push authority).
export const ROLES = Object.freeze([ROLE_BUILD, ROLE_REVIEW, ROLE_REVISE]);
export const WRITER_ROLES = Object.freeze([ROLE_BUILD, ROLE_REVISE]);

export function isRole(value) {
  return ROLES.includes(value);
}

export function isWriterRole(value) {
  return WRITER_ROLES.includes(value);
}

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

export const RUNTIMES = Object.freeze(["codex-cli", "claude-code", "hermes-pool"]);

export function isRuntime(value) {
  return RUNTIMES.includes(value);
}

// Runtime x role capability matrix. Every supported runtime may execute every
// role; an unsupported combo is refused at work-order validation, before any
// launch side effect.
export const RUNTIME_ROLE_SUPPORT = Object.freeze({
  "codex-cli": Object.freeze([ROLE_BUILD, ROLE_REVISE, ROLE_REVIEW]),
  "claude-code": Object.freeze([ROLE_REVIEW, ROLE_BUILD, ROLE_REVISE]),
  "hermes-pool": Object.freeze([ROLE_BUILD, ROLE_REVISE, ROLE_REVIEW]),
});

export function runtimeSupportsRole(runtime, role) {
  return RUNTIME_ROLE_SUPPORT[runtime]?.includes(role) === true;
}

// Runtime -> the adapter module that executes it. This is the adapter MAP: the
// lane name no longer decides the adapter (it is looked up from the lane's
// declared runtime), so a new lane cannot silently inherit Codex.
export const RUNTIME_ADAPTER = Object.freeze({
  "codex-cli": "codex-cli",
  "claude-code": "claude-code",
  "hermes-pool": "hermes-pool",
});

export function adapterForRuntime(runtime) {
  return RUNTIME_ADAPTER[runtime] ?? null;
}

// Runtime -> independence family. Independence is a FAMILY property, not a
// string difference: two lanes of the same family are the same verifier.
export const RUNTIME_FAMILY = Object.freeze({
  "codex-cli": "codex",
  "claude-code": "claude",
  "hermes-pool": "hermes",
});

export function runtimeFamily(runtime) {
  return RUNTIME_FAMILY[runtime] ?? null;
}

// ---------------------------------------------------------------------------
// Lanes — one row per (runtime, role) a lane may declare
// ---------------------------------------------------------------------------
//
// `role`   — the LEGACY, lane-derived role. This is exactly what the deployed
//            coordinator derives from these names today (byte-for-byte), and it
//            is the disagreement baseline for an authoritative receipt.
// `roles`  — what the lane may actually execute. A writer lane executes both
//            build and revise (a revise is the same writer returning to the
//            branch); a verifier lane executes review only.

function laneDefinition(runtime, role, roles) {
  return Object.freeze({ runtime, role, roles: Object.freeze(roles), family: RUNTIME_FAMILY[runtime] });
}

export const LANES = Object.freeze({
  // The three deployed lanes. Names, roles, runtimes and families are unchanged.
  "codex-builder": laneDefinition("codex-cli", ROLE_BUILD, [ROLE_BUILD, ROLE_REVISE]),
  "claude-verifier": laneDefinition("claude-code", ROLE_REVIEW, [ROLE_REVIEW]),
  "hermes-box": laneDefinition("hermes-pool", ROLE_BUILD, [ROLE_BUILD, ROLE_REVISE]),
  // SHU-249 role-reversal vocabulary: the remaining (runtime, role) pairs, so
  // every runtime can be launched in every role by a lane whose lane-derived
  // role AGREES with the trusted one.
  "codex-verifier": laneDefinition("codex-cli", ROLE_REVIEW, [ROLE_REVIEW]),
  "claude-builder": laneDefinition("claude-code", ROLE_BUILD, [ROLE_BUILD, ROLE_REVISE]),
  "hermes-verifier": laneDefinition("hermes-pool", ROLE_REVIEW, [ROLE_REVIEW]),
});

export const LANE_NAMES = Object.freeze(Object.keys(LANES));

// The historical lane-derived role is what `default_role` already carries;
// these helpers only add null-safety (an unknown lane fails closed as null —
// never "assume build", never "assume the last branch").
export function laneDefinitionFor(laneName) {
  return LANES[laneName] ?? null;
}

export function roleForLane(laneName) {
  return LANES[laneName]?.role ?? null;
}

export function runtimeForLane(laneName) {
  return LANES[laneName]?.runtime ?? null;
}

export function familyForLane(laneName) {
  return LANES[laneName]?.family ?? null;
}

export function laneSupportsRole(laneName, role) {
  return LANES[laneName]?.roles.includes(role) === true;
}

// Lane -> adapter, FAIL CLOSED. An unknown lane is a programming error, not a
// reason to default to Codex: returning null here is what the callers used to
// paper over with `return "codex-cli"` (SHU-249 site 3).
export function adapterForLane(laneName) {
  const definition = LANES[laneName];
  if (!definition) return null;
  return RUNTIME_ADAPTER[definition.runtime] ?? null;
}

export function adapterNameForLane(laneName) {
  const adapter = adapterForLane(laneName);
  if (!adapter) throw new Error(`unknown coordinator lane ${JSON.stringify(laneName)} — refusing to default an adapter`);
  return adapter;
}

export function laneNamesForRuntime(runtime) {
  return LANE_NAMES.filter((name) => LANES[name].runtime === runtime);
}

// The lane that launches a (runtime, role) pair. Revise is a WRITE role served
// by the runtime's writer lane. Returns null when no lane exists, so callers
// fail closed instead of inventing one.
export function laneForRuntimeRole(runtime, role) {
  const wanted = role === ROLE_REVISE ? ROLE_BUILD : role;
  for (const name of LANE_NAMES) {
    const definition = LANES[name];
    if (definition.runtime === runtime && definition.role === wanted) return name;
  }
  return null;
}

// The legacy runtime -> lane inverse. Kept EXACTLY as deployed: codex-cli ->
// codex-builder, claude-code -> claude-verifier, hermes-pool -> hermes-box.
// New callers that know the role should prefer laneForRuntimeRole().
const LEGACY_DEFAULT_ROLE = Object.freeze({
  "codex-cli": ROLE_BUILD,
  "claude-code": ROLE_REVIEW,
  "hermes-pool": ROLE_BUILD,
});

export function workerForRuntime(runtime) {
  const role = LEGACY_DEFAULT_ROLE[runtime];
  return role ? laneForRuntimeRole(runtime, role) : null;
}

// Lanes that may perform review, in requested_worker vocabulary. Derived from
// the capability matrix (this is what the deployed coordinator already computes,
// now sourced from the vocabulary instead of a locally rebuilt table).
export const REVIEW_LANES = Object.freeze(
  LANE_NAMES.filter((name) => runtimeSupportsRole(LANES[name].runtime, ROLE_REVIEW)),
);

// Lanes whose DECLARED role is a write role / the review role.
export const WRITER_LANES = Object.freeze(LANE_NAMES.filter((name) => isWriterRole(LANES[name].role)));
export const REVIEW_ROLE_LANES = Object.freeze(LANE_NAMES.filter((name) => LANES[name].role === ROLE_REVIEW));

// ---------------------------------------------------------------------------
// Receipt version gate + role authority
// ---------------------------------------------------------------------------

// 1.0.0 — the deployed version. Role is DERIVED from the lane name; declaring
//         role/runtime on this version is refused (version-gated), so a retained
//         receipt can never be reinterpreted.
// 1.1.0 — role and runtime are REQUIRED and AUTHORITATIVE.
export const RECEIPT_VERSION_LEGACY = "1.0.0";
export const RECEIPT_VERSION_ROLE_AUTHORITY = "1.1.0";
export const RECEIPT_VERSIONS = Object.freeze([RECEIPT_VERSION_LEGACY, RECEIPT_VERSION_ROLE_AUTHORITY]);

export function isReceiptVersion(value) {
  return RECEIPT_VERSIONS.includes(value);
}

// resolveReceiptRoleAuthority — the ONE place a receipt's role is decided.
//
// Returns one of:
//   { ok: true,  role, runtime, source: "lane" }       — legacy: lane-derived
//   { ok: true,  role, runtime, source: "authority" }  — trusted field, agreeing
//   { ok: false, reason, conflict? }                   — refused (HOLD)
//
// A refusal is ALWAYS a refusal: there is deliberately no branch that falls back
// to the lane-derived role when the authoritative field is missing, unknown or
// contradictory.
export function resolveReceiptRoleAuthority(receipt = {}) {
  if (!receipt || typeof receipt !== "object") {
    return { ok: false, reason: "no receipt to resolve a launch role from" };
  }
  const laneName = receipt.requested_worker;
  const definition = LANES[laneName] ?? null;
  if (!definition) {
    return { ok: false, reason: `unknown worker lane ${JSON.stringify(laneName)} — a role cannot be derived from it` };
  }
  // An absent version is the pre-version legacy shape (durable records always
  // carry one — validateReceipt requires it — but routing bridges also accept
  // the historical in-memory shape). It is read exactly as 1.0.0, never as
  // "trust whatever role field happens to be present".
  const version = receipt.receipt_version ?? RECEIPT_VERSION_LEGACY;
  const hasRole = receipt.role !== undefined && receipt.role !== null;
  const hasRuntime = receipt.runtime !== undefined && receipt.runtime !== null;

  if (version === RECEIPT_VERSION_LEGACY) {
    if (hasRole || hasRuntime) {
      return { ok: false, reason: `receipt_version ${RECEIPT_VERSION_LEGACY} is lane-derived and must not declare a role or runtime` };
    }
    return { ok: true, role: definition.role, runtime: definition.runtime, source: "lane" };
  }
  if (version !== RECEIPT_VERSION_ROLE_AUTHORITY) {
    return { ok: false, reason: `unsupported receipt_version ${JSON.stringify(version)}` };
  }
  if (!hasRole || !hasRuntime) {
    return { ok: false, reason: `receipt_version ${RECEIPT_VERSION_ROLE_AUTHORITY} requires an authoritative role and runtime — role from the lane name is not authority` };
  }
  if (!isRole(receipt.role)) {
    return { ok: false, reason: `unknown authoritative role ${JSON.stringify(receipt.role)}` };
  }
  if (!isRuntime(receipt.runtime)) {
    return { ok: false, reason: `unknown authoritative runtime ${JSON.stringify(receipt.runtime)}` };
  }
  // A writer lane legitimately executes both build and revise (a revise is the
  // same writer returning to the branch), so the baseline is the set of roles
  // the lane may execute — not the single legacy default role. Anything the
  // lane cannot execute is a disagreement and HOLDs.
  if (!definition.roles.includes(receipt.role)) {
    return {
      ok: false,
      conflict: true,
      reason: `authoritative role ${receipt.role} disagrees with the lane-derived role ${definition.role} for ${laneName} — HOLD, no silent fallback`,
    };
  }
  if (receipt.runtime !== definition.runtime) {
    return {
      ok: false,
      conflict: true,
      reason: `authoritative runtime ${receipt.runtime} disagrees with the lane-derived runtime ${definition.runtime} for ${laneName} — HOLD, no silent fallback`,
    };
  }
  return { ok: true, role: receipt.role, runtime: receipt.runtime, source: "authority" };
}

// roleForReceipt — the trusted role of a receipt, or null when the receipt is
// not admissible. Callers that must not silently continue use the full
// resolver above and fail closed on !ok.
export function roleForReceipt(receipt) {
  const authority = resolveReceiptRoleAuthority(receipt);
  return authority.ok ? authority.role : null;
}

// The scope phase a fresh reservation starts in. Keyed to the ROLE: a review
// execution reviews the complete tree, every write role starts at its scoped or
// full initial tree. This used to be `requested_worker === "claude-verifier"`,
// which is why re-keying it to the role INVERTED the name-keyed default.
export function defaultScopePhaseForRole(role) {
  return role === ROLE_REVIEW ? "review" : "initial";
}
