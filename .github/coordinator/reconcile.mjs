// Coordinator — deterministic dry-run skeleton (BAWES-Universe/studenthub-platform).
//
// WHY THIS FILE IS SHAPED THIS WAY:
//   - Every decision here is a PURE function of (issues, openPRs, config, receipts, events).
//     No LLM, no randomness inside the resolver, no hidden state. I/O (Linear, GitHub, the
//     workspace-agents adapter, filesystem) is injected so tests mock the network entirely.
//   - DISPATCH IS DISABLED BY DEFAULT: unless ENABLE_DISPATCH === "true" in the environment,
//     main() only prints a dry-run report and makes ZERO writes. This PR grants no merge
//     authority and changes no production behavior — it is a reviewable, testable skeleton
//     for a future deterministic dispatch pilot.
//   - Receipt invariants (each is asserted in test/receipt-state.test.mjs):
//       * RESERVED is persisted BEFORE any launch is sent.
//       * launch sent -> LAUNCH_UNKNOWN (outcome unknown, slot held).
//       * Idempotent retry while LAUNCH_UNKNOWN REUSES the same Idempotency-Key
//         (attempt_id is minted once at reservation and never re-minted).
//       * worker ack -> RUNNING; external_run_id (apirun_...) is stored IMMEDIATELY,
//         and the granular upstream adapter_status is preserved, never collapsed.
//       * completed WITHOUT a validated callback -> HOLD, never COMPLETED.
//       * quota/access failure -> FAILED and pauses the adapter (adapter_pause_map[adapter]=true)
//         so the next slot does not auto-launch a doomed attempt.
//       * timeout alone NEVER changes stage and NEVER releases the slot.
//       * conflicting manual claim / missing evidence -> HOLD.
//       * an old PASS never satisfies a changed head: verdicts are bound to target_sha.
//
// Linear API token names only — no secrets live in this repository.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants / enums (single source of truth for both resolver and validator)
// ---------------------------------------------------------------------------

export const STAGES = Object.freeze(["RESERVED", "LAUNCH_UNKNOWN", "RUNNING", "COMPLETED", "FAILED", "HOLD"]);
export const REQUESTED_WORKERS = Object.freeze(["codex-builder", "claude-verifier", "hermes-box"]);
export const ADAPTER_STATUSES = Object.freeze(["queued", "in_progress", "suspended", "completed", "failed"]);
export const TERMINAL_STAGES = Object.freeze(["COMPLETED", "FAILED", "HOLD"]);

// Free text is never an acceptable authorization: only real Linear issue refs or
// seeded FIXTURE refs (fixture lane contract is defined separately by the Opus
// acceptance contract — see config.json fixture_lane).
export const AUTHORIZATION_REF_RE = /^(SHU-[0-9]+|FIXTURE-[A-Z0-9-]+)$/;
export const TARGET_SHA_RE = /^[0-9a-f]{40}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Linear states a card may be picked up from. Anything else (including an unknown
// or inaccessible state) is ineligible — the resolver NEVER invents backlog.
export const PICKABLE_STATES = Object.freeze(["Backlog", "Todo"]);

export function authorizationRefValid(ref) {
  return typeof ref === "string" && AUTHORIZATION_REF_RE.test(ref);
}

// The Idempotency-Key for the workspace-agents trigger. It is derived from the
// immutable attempt_id + stage + the bound target_sha.
export function idempotencyKey({ attempt_id, stage, target_sha }) {
  return `${attempt_id}:${stage}:${target_sha}`;
}

// launchIdempotencyKey — the key actually sent with EVERY trigger attempt.
// The stage embedded is LAUNCH_UNKNOWN (the state that identifies "the launch"),
// never the pre-launch RESERVED stage: if the key changed between the first send
// and a retry, the retry would be a NEW upstream run — the exact double-launch
// bug the invariant forbids. Retries therefore reproduce a byte-identical key.
export function launchIdempotencyKey({ attempt_id, target_sha }) {
  return idempotencyKey({ attempt_id, stage: "LAUNCH_UNKNOWN", target_sha });
}

// Stable, deterministic identifier ordering: numeric suffix when both ids carry
// one (SHU-9 < SHU-10), plain string comparison otherwise. Never locale-dependent.
export function compareIdentifiers(a, b) {
  // Numeric-aware ONLY for canonical identifiers (SHU-<n>): "SHU-2" < "SHU-10".
  // Anything else (SHU-FIXTURE-*, FIXTURE-*) compares lexicographically so a
  // fixture id never collides with a real card's numeric ordering space.
  const num = (s) => {
    const m = /^SHU-([0-9]+)$/.exec(s);
    return m ? Number(m[1]) : NaN;
  };
  const na = num(a);
  const nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const PRIORITY_RANK = Object.freeze({
  Urgent: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  "No priority": 4,
});

function priorityRank(p) {
  return PRIORITY_RANK[p] ?? 5; // unknown priorities sort last, deterministically
}

// R3 cards require a NAMED verifier (repo convention: "Independent verifier approved
// R2/R3 work" — see .github/pull_request_template.md). R3-ness is carried as the
// priority value or an r3 label; a verifier is a label of the form verifier:<name>.
const R3_RE = /^r3$/i;
const R3_PRIORITY_RE = /^r3$/i;
const VERIFIER_LABEL_RE = /^verifier:/i;
const NEEDS_DECISION_RE = /^needs:decision$/i;
const WORKER_LABEL_RE = /^worker:(codex-builder|claude-verifier|hermes-box)$/;

function hasLabel(issue, re) {
  return Array.isArray(issue.labels) && issue.labels.some((l) => re.test(String(l)));
}

function stateLabel(state) {
  return state === null || state === undefined || state === "" ? "<unknown/inaccessible>" : String(state);
}

// ---------------------------------------------------------------------------
// Eligibility — pure resolver
// ---------------------------------------------------------------------------

// issue (normalized Linear card):
//   { id, title, state, priority, labels[], assignee|null, delegate|null,
//     linkedPRs:[{number,state}], parent:{id,state}|null, blockers:[{id,state}] }
// Exclusion rules are checked in a fixed order so the reported reason is stable.
export function computeEligibility({ issues, openPRs = [], config = {} }) {
  const openPRNumbers = new Set(openPRs.map((p) => (typeof p === "number" ? p : p.number)).filter((n) => n !== undefined));
  const pilotRepo = config.pilot_repo ?? "BAWES-Universe/studenthub-platform";

  const ready = [];
  const excluded = [];

  for (const issue of issues ?? []) {
    const id = issue.id;
    const exclude = (reason) => excluded.push({ id, reason });

    // Rule 1: unknown/inaccessible state — never invent backlog. A card we cannot
    // read the state of must not be silently treated as Backlog.
    if (issue.state === null || issue.state === undefined || issue.state === "") {
      exclude(`state ${stateLabel(issue.state)} — unknown/inaccessible (never invent backlog)`);
      continue;
    }
    // Rule 2: state must be pickable.
    if (!PICKABLE_STATES.includes(issue.state)) {
      exclude(`state "${issue.state}" not in {${PICKABLE_STATES.join(", ")}}`);
      continue;
    }
    // Rule 3: explicit delegation claim → another worker owns it.
    if (issue.delegate && (issue.delegate.name || issue.delegate.id)) {
      exclude(`delegated to ${issue.delegate.name ?? issue.delegate.id} (claim)`);
      continue;
    }
    // Rule 4: active assignee claim.
    if (issue.assignee && (issue.assignee.name || issue.assignee.id)) {
      exclude(`assigned to ${issue.assignee.name ?? issue.assignee.id} (active claim)`);
      continue;
    }
    // Rule 5: linked to an open PR (work in flight) — both normalized linkedPRs and
    // live open-PR links are honored.
    const openLinked = (issue.linkedPRs ?? []).some((pr) => String(pr.state).toUpperCase() === "OPEN" || openPRNumbers.has(pr.number));
    if (openLinked) {
      exclude("linked to an open PR");
      continue;
    }
    // Rule 6: parent not Done.
    if (issue.parent && issue.parent.state !== "Done") {
      exclude(`parent ${issue.parent.id ?? "?"} not Done (${stateLabel(issue.parent.state)})`);
      continue;
    }
    // Rule 7: any blocker not Done.
    const openBlocker = (issue.blockers ?? []).find((b) => b.state !== "Done");
    if (openBlocker) {
      exclude(`blocked by ${openBlocker.id ?? "?"} (${stateLabel(openBlocker.state)})`);
      continue;
    }
    // Rule 8: label needs:decision → unresolved decision required before dispatch.
    if (hasLabel(issue, NEEDS_DECISION_RE)) {
      exclude("label needs:decision");
      continue;
    }
    // Rule 9: R3 card without a NAMED verifier label.
    const isR3 = R3_RE.test(String(issue.priority ?? "")) || hasLabel(issue, R3_PRIORITY_RE);
    if (isR3 && !hasLabel(issue, VERIFIER_LABEL_RE)) {
      exclude("R3 card without a named verifier label (verifier:<name>)");
      continue;
    }
    // Rule 10: sanity guard — a card must claim to belong to the pilot repo family.
    // (Snapshot issues carry repo optionally; live Linear issues are scoped by the
    // team query, so this only rejects cards that explicitly name another repo.)
    if (issue.repo && issue.repo !== pilotRepo) {
      exclude(`repo ${issue.repo} outside pilot repo ${pilotRepo}`);
      continue;
    }

    ready.push({
      id,
      linearId: issue.linearId ?? null, // kept through selection: Linear comment writes need the UUID
      title: issue.title ?? "",
      state: issue.state,
      priority: issue.priority ?? "No priority",
      requested_worker: requestedWorkerFor(issue),
    });
  }

  // Sort: priority (Urgent first) then stable tie-breaker on identifier.
  ready.sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return compareIdentifiers(a.id, b.id);
  });
  excluded.sort((a, b) => compareIdentifiers(a.id, b.id));

  return { ready, excluded };
}

// Worker family is chosen from an explicit worker:<family> label; default family
// for the pilot is codex-builder (deterministic — never guessed from free text).
export function requestedWorkerFor(issue) {
  if (Array.isArray(issue.labels)) {
    for (const label of issue.labels) {
      const m = WORKER_LABEL_RE.exec(String(label));
      if (m) return m[1];
    }
  }
  return "codex-builder";
}

// Adapter name for a worker family. The pilot has exactly one adapter; verifier /
// box families still route through it (requested_worker documents the family).
export function adapterNameFor(_requestedWorker) {
  return "workspace-agents"; // pilot: single builder adapter
}

// dispatchEnabledFor — dispatch requires BOTH gates in DIFFERENT layers (CodeRabbit):
// the in-repo config flag (enable_dispatch: false committed by default) AND the
// workflow environment variable. One gate alone never enables dispatch.
export function dispatchEnabledFor(env = {}, config = {}) {
  return config.enable_dispatch === true && (env.ENABLE_DISPATCH ?? "false").toLowerCase() === "true";
}

// resolveAuthorizationRef — a dispatch is only legal against an APPROVED contract:
//   1. an explicit candidate.authorization_ref that passes the regex;
//   2. a canonical card id (SHU-<n>) — the ratified card IS the contract ref;
//   3. the fixture lane's configured authorization_ref for fixture probes
//      (SHU-FIXTURE-001 itself never matches ^SHU-[0-9]+$ — Sentry HIGH fix).
// Anything else resolves to null and the dispatch is REFUSED loudly.
export function resolveAuthorizationRef(candidate, config = {}) {
  if (candidate.authorization_ref && authorizationRefValid(candidate.authorization_ref)) return candidate.authorization_ref;
  if (typeof candidate.id === "string" && /^SHU-[0-9]+$/.test(candidate.id)) return candidate.id;
  const fixtureLane = config.fixture_lane ?? {};
  if (fixtureLane.id && candidate.id === fixtureLane.id) {
    if (fixtureLane.authorization_ref && authorizationRefValid(fixtureLane.authorization_ref)) return fixtureLane.authorization_ref;
    return null; // fixture lane misconfigured — refuse loudly, never guess
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipts — creation + pure state machine
// ---------------------------------------------------------------------------

export function receiptSchemaPath() {
  return path.join(__dirname, "receipt-schema.json");
}

// Receipt schema is static — parse once, reuse (CodeRabbit: don't re-read the
// file on every validation call).
let _receiptSchema = null;
function receiptSchema() {
  if (_receiptSchema === null) _receiptSchema = JSON.parse(fs.readFileSync(receiptSchemaPath(), "utf8"));
  return _receiptSchema;
}

// validateReceipt — hand-rolled validator over the canonical receipt-schema.json.
// Enforces: presence of all schema-declared fields, primitive types, enums,
// patterns (attempt_id uuid, authorization_ref contract-bound, target_sha 40-hex,
// apirun_ prefix for external_run_id) plus the stage invariants the schema's
// allOf expresses in JSON Schema form. Returns {valid, errors:[...]}.
// NEVER throws on malformed input: receipts are read back from Linear comment
// bodies (parseReceiptCommentBody), so a corrupt persisted record must yield a
// validation result, not a TypeError (CodeRabbit).
export function validateReceipt(receipt) {
  const errors = [];
  const schema = receiptSchema();

  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, errors: ["receipt must be an object"] };
  }
  for (const field of schema.required) {
    if (!(field in receipt)) errors.push(`missing required field "${field}"`);
  }
  if (errors.length) return { valid: false, errors };

  const expectType = (field, types) => {
    if (!types.includes(typeof receipt[field])) {
      errors.push(`field "${field}" must be of type ${types.join("|")}, got ${typeof receipt[field]}`);
    }
  };
  const expectPattern = (field, re) => {
    if (typeof receipt[field] === "string" && !re.test(receipt[field])) {
      errors.push(`field "${field}" fails pattern ${re}`);
    }
  };
  const expectEnum = (field, values) => {
    if (!values.includes(receipt[field])) {
      errors.push(`field "${field}" must be one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  };

  if (receipt.receipt_version !== "1.0.0") errors.push(`receipt_version must be "1.0.0"`);
  expectType("issue_id", ["string"]);
  expectPattern("attempt_id", UUID_RE);
  expectType("authorization_ref", ["string"]);
  if (!authorizationRefValid(receipt.authorization_ref)) {
    errors.push(`authorization_ref "${receipt.authorization_ref}" is not an approved contract ref (^(SHU-[0-9]+|FIXTURE-[A-Z0-9-]+)$) — free text rejected`);
  }
  expectEnum("stage", STAGES);
  expectEnum("requested_worker", REQUESTED_WORKERS);
  expectType("repo", ["string"]);
  expectType("branch", ["string"]);
  expectPattern("target_sha", TARGET_SHA_RE);
  expectType("last_activity", ["string"]);
  for (const [field, allowed] of [
    ["worker_identity", ["string", "null"]],
    ["external_run_id", ["string", "null"]],
    ["adapter_status", ["string", "null"]],
  ]) {
    const t = receipt[field] === null ? "null" : typeof receipt[field];
    if (!allowed.includes(t)) errors.push(`field "${field}" must be ${allowed.join("|")} (nullable)`);
  }
  if (receipt.external_run_id !== null) {
    expectPattern("external_run_id", /^apirun_[A-Za-z0-9_-]+$/);
  }
  if (receipt.adapter_status !== null) {
    expectEnum("adapter_status", ADAPTER_STATUSES);
  }
  if (!receipt.timestamps || typeof receipt.timestamps !== "object" || Array.isArray(receipt.timestamps)) {
    errors.push("field timestamps must be an object");
  } else {
    for (const ts of ["reserved", "launch", "heartbeat", "terminal"]) {
      if (!(ts in receipt.timestamps)) errors.push(`timestamps missing "${ts}"`);
      else if (receipt.timestamps[ts] !== null && typeof receipt.timestamps[ts] !== "string") {
        errors.push(`timestamps.${ts} must be a string or null`);
      }
    }
    if (typeof receipt.timestamps.reserved !== "string") {
      errors.push("timestamps.reserved must be set at reservation time");
    }
  }
  for (const [field, itemType] of [
    ["evidence_links", "string"],
    ["notes", "string"],
  ]) {
    if (!Array.isArray(receipt[field])) errors.push(`field "${field}" must be an array`);
    else if (receipt[field].some((x) => typeof x !== itemType)) {
      errors.push(`field "${field}" must contain only ${itemType}s`);
    }
  }

  // ---- Cross-field stage invariants (mirrors the allOf in the schema file). ----
  // RESERVED/LAUNCH_UNKNOWN: no run can exist before launch is acknowledged.
  // RUNNING/COMPLETED: an accepted run exists (external_run_id + granular status).
  // worker_identity is OPTIONAL in every stage until the poll response supplies
  // the documented agent_id — it is NEVER fabricated from the run id (GPT review
  // #1); the only hard rule is the contradiction check below (identity without a
  // run id is impossible).
  // FAILED: either a post-acceptance run failure (fields set) or a trigger refused
  // before acceptance (quota/access wall) — in which case run fields stay null.
  // HOLD: reachable BOTH pre-acceptance (manual_claim from RESERVED/LAUNCH_UNKNOWN)
  // and post-acceptance (completed-without-callback) — each shape validates against
  // the run fields it actually carries (CodeRabbit).
  const stage = receipt.stage;
  const runId = receipt.external_run_id;
  const workerIdentity = receipt.worker_identity;
  const adapterStatus = receipt.adapter_status;
  if (stage === "RESERVED" || stage === "LAUNCH_UNKNOWN") {
    if (runId !== null) errors.push(`stage ${stage} must have external_run_id null (no run exists yet)`);
    if (workerIdentity !== null) errors.push(`stage ${stage} must have worker_identity null (no run identity yet)`);
    if (adapterStatus !== null) errors.push(`stage ${stage} must have adapter_status null`);
  } else if (stage === "FAILED") {
    const postAcceptance = runId !== null;
    if (postAcceptance) {
      if (adapterStatus !== "failed") errors.push("FAILED with a run requires adapter_status \"failed\"");
    } else {
      // Pre-acceptance rejection (trigger refused: quota/access/4xx) — no run ever existed.
      if (workerIdentity !== null) errors.push("FAILED without a run must keep worker_identity null");
      if (adapterStatus !== null) errors.push("FAILED without a run must keep adapter_status null (no upstream run status exists)");
    }
  } else if (stage === "HOLD") {
    if (runId === null) {
      // Pre-acceptance HOLD (manual_claim / refused run before any ack): no run
      // identity exists — nulls are CORRECT here, not a validation failure.
      if (workerIdentity !== null) errors.push("HOLD without a run must keep worker_identity null");
      if (adapterStatus !== null) errors.push("HOLD without a run must keep adapter_status null");
    } else {
      // Post-acceptance HOLD (completed-without-callback): the run was acknowledged.
      if (!ADAPTER_STATUSES.includes(adapterStatus)) {
        errors.push(`HOLD with a run requires a granular adapter_status (${ADAPTER_STATUSES.join("|")})`);
      }
    }
  } else {
    // RUNNING / COMPLETED imply an accepted run.
    if (runId === null) errors.push(`stage ${stage} requires external_run_id (run accepted by the API)`);
    if (!ADAPTER_STATUSES.includes(adapterStatus)) {
      errors.push(`stage ${stage} requires a granular adapter_status (${ADAPTER_STATUSES.join("|")})`);
    }
  }
  // worker_identity and external_run_id travel together: a claimed identity with no
  // run id is contradictory (the reverse — apirun_ stored, identity backfilled by
  // the worker ack — is the normal ordering and allowed).
  if (workerIdentity !== null && runId === null) {
    errors.push("worker_identity set while external_run_id null is contradictory");
  }
  // Guarded derefs: structural errors above already recorded malformed
  // timestamps/evidence_links — never let a corrupt record crash the validator.
  const timestamps = receipt.timestamps && typeof receipt.timestamps === "object" && !Array.isArray(receipt.timestamps) ? receipt.timestamps : null;
  if (timestamps && (stage === "COMPLETED" || stage === "FAILED" || stage === "HOLD")) {
    if (timestamps.terminal === null) errors.push(`stage ${stage} requires timestamps.terminal`);
  }
  if (timestamps && stage === "RESERVED") {
    if (timestamps.launch !== null) errors.push("RESERVED must not carry a launch timestamp (reserve precedes launch)");
  }
  if (stage === "COMPLETED") {
    if (!Array.isArray(receipt.evidence_links) || receipt.evidence_links.length === 0) {
      errors.push("COMPLETED requires validated evidence_links (no callback, no COMPLETED)");
    }
  }

  return { valid: errors.length === 0, errors };
}

// createReceipt — pure factory. Persisting the RESERVED receipt is the very first
// write of any dispatch; nothing is launched until that receipt exists.
// Input shape mirrors the schema; returns {ok, receipt?, errors?}.
export function createReceipt({
  issue_id,
  authorization_ref,
  requested_worker,
  repo,
  branch,
  target_sha,
  attempt_id = randomUUID(),
  reserved_at = new Date().toISOString(),
}) {
  const candidate = {
    receipt_version: "1.0.0",
    issue_id,
    attempt_id,
    authorization_ref,
    stage: "RESERVED",
    requested_worker,
    worker_identity: null,
    repo,
    branch,
    target_sha,
    external_run_id: null,
    adapter_status: null,
    timestamps: { reserved: reserved_at, launch: null, heartbeat: null, terminal: null },
    evidence_links: [],
    last_activity: reserved_at,
    notes: [`reserved (attempt ${attempt_id})`],
  };
  const { valid, errors } = validateReceipt(candidate);
  if (!valid) return { ok: false, errors };
  return { ok: true, receipt: candidate };
}

// callbackEvidenceValid — a callback only counts if it references the SAME attempt
// and the SAME bound head, and (when the callback declares a stage) an explicitly
// SUCCESSFUL stage. An old PASS against a moved head is rejected: the receipt
// is bound to target_sha, and if the live head (ctx.current_head) has advanced
// past it, the verdict describes a superseded tree and cannot satisfy this
// receipt. BLOCKED/FAILED callbacks never authorize COMPLETED (GPT BLOCK #2).
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY"]);

export function callbackEvidenceValid(receipt, evidence, ctx = {}) {
  if (!evidence || typeof evidence !== "object") return false;
  if (!Array.isArray(evidence.links) || evidence.links.length === 0) return false;
  if (evidence.attempt_id !== receipt.attempt_id) return false;
  if (evidence.target_sha !== receipt.target_sha) return false;
  if (ctx.current_head && ctx.current_head !== receipt.target_sha) return false;
  if (evidence.stage !== undefined && evidence.stage !== null && !SUCCESS_CALLBACK_STAGES.includes(evidence.stage)) {
    return false; // BLOCKED / FAILED / unknown stages never authorize COMPLETED
  }
  return true;
}

const nowIso = (at) => at ?? new Date().toISOString();

// nextReceiptState — pure transition. Returns
//   { receipt, accepted, reason?, pause_adapter?, idempotency_key? }
// `accepted:false` means the event was out of order or invalid for the current
// stage — the receipt is returned UNCHANGED (slot never released, stage never
// downgraded). Terminal stages (COMPLETED/FAILED/HOLD) accept no further events.
export function nextReceiptState(receipt, event, ctx = {}) {
  const unchanged = (reason) => ({ receipt, accepted: false, reason });

  if (!receipt || typeof receipt !== "object") {
    return unchanged(`event ${event?.type ?? "?"} requires an existing receipt (reserve first)`);
  }
  if (TERMINAL_STAGES.includes(receipt.stage)) {
    return unchanged(`stage ${receipt.stage} is terminal — no further transitions`);
  }

  const copy = () => structuredClone(receipt);
  const at = () => nowIso(event.at);
  const note = (text) => {
    const next = copy();
    next.notes = [...next.notes, text];
    next.last_activity = at();
    return next;
  };

  switch (event.type) {
    case "launch": {
      // launch is only legal from RESERVED (first send) or LAUNCH_UNKNOWN (retry).
      // Retry REUSES the same Idempotency-Key: attempt_id is immutable, stage stays
      // LAUNCH_UNKNOWN, target_sha stays bound — never mint a new launch identity.
      if (receipt.stage !== "RESERVED" && receipt.stage !== "LAUNCH_UNKNOWN") {
        return unchanged(`cannot launch from stage ${receipt.stage}`);
      }
      const next = note(
        receipt.stage === "RESERVED"
          ? "launch sent; outcome unknown (LAUNCH_UNKNOWN) — slot held"
          : "launch retried after LAUNCH_UNKNOWN — SAME Idempotency-Key reused (attempt_id immutable)",
      );
      next.stage = "LAUNCH_UNKNOWN";
      if (next.timestamps.launch === null) next.timestamps.launch = at();
      return { receipt: next, accepted: true, idempotency_key: launchIdempotencyKey(next) };
    }
    case "worker_ack": {
      // A worker/API ack is only meaningful after a launch was sent. RESERVED has
      // no run yet — an ack there is out of order and must not fabricate a run.
      if (receipt.stage !== "LAUNCH_UNKNOWN" && receipt.stage !== "RUNNING") {
        return unchanged(`worker ack out of order from stage ${receipt.stage} (launch first)`);
      }
      const { external_run_id, adapter_status = "in_progress", worker_identity } = event;
      if (typeof external_run_id !== "string" || external_run_id.length === 0) {
        return unchanged("worker_ack requires external_run_id (apirun_... stored immediately once the API accepts)");
      }
      const next = note(`worker ack — run ${external_run_id} accepted (adapter_status=${adapter_status})`);
      next.stage = "RUNNING";
      next.external_run_id = external_run_id; // stored IMMEDIATELY — never deferred
      next.adapter_status = ADAPTER_STATUSES.includes(adapter_status) ? adapter_status : "in_progress";
      // worker_identity stays null until the poll response supplies the
      // documented agent_id — NEVER fabricated from the run id (GPT review #1).
      if (typeof event.worker_identity === "string" && event.worker_identity.length) {
        next.worker_identity = event.worker_identity;
      }
      next.timestamps.heartbeat = at();
      return { receipt: next, accepted: true };
    }
    case "run_status": {
      const { status, error_code, error_kind } = event;
      if (status === "queued" || status === "in_progress" || status === "suspended") {
        if (receipt.stage !== "RUNNING") {
          return unchanged(`run_status ${status} requires an acknowledged run (stage RUNNING)`);
        }
        const next = note(`adapter status: ${status}`);
        next.adapter_status = status;
        // The poll response supplies the documented agent_id — the ONLY source of
        // worker_identity (never fabricated, GPT review #1 / lifecycle BLOCK).
        if (typeof event.worker_identity === "string" && event.worker_identity.length) {
          next.worker_identity = event.worker_identity;
        }
        next.timestamps.heartbeat = at();
        return { receipt: next, accepted: true };
      }
      if (status === "completed") {
        if (receipt.stage !== "RUNNING") {
          return unchanged(`run_status completed requires an acknowledged run (stage RUNNING)`);
        }
        const callback = event.callback ?? null;
        // Completed WITHOUT a validated callback is HOLD — never COMPLETED. Only
        // evidence bound to the same attempt_id + target_sha (+ current head) counts.
        if (callback && callbackEvidenceValid(receipt, callback, ctx)) {
          const next = note("run completed WITH validated callback (attempt + target_sha match)");
          next.stage = "COMPLETED";
          next.adapter_status = "completed";
          next.evidence_links = [...next.evidence_links, ...callback.links];
          if (typeof event.worker_identity === "string" && event.worker_identity.length) {
            next.worker_identity = event.worker_identity; // poll's agent_id, persisted with the terminal state
          }
          next.timestamps.terminal = at();
          return { receipt: next, accepted: true };
        }
        const next = note(
          callback
            ? "run completed but callback REJECTED (attempt/target_sha mismatch or stale head) — HOLD"
            : "run completed WITHOUT validated callback — HOLD (manual review required)",
        );
        next.stage = "HOLD";
        next.adapter_status = "completed";
        if (typeof event.worker_identity === "string" && event.worker_identity.length) {
          next.worker_identity = event.worker_identity; // agent_id is known even when the callback is not
        }
        next.timestamps.terminal = at();
        return { receipt: next, accepted: true };
      }
      if (status === "failed") {
        // A hard failure is terminal. When it arrives with NO run id, the trigger
        // was refused before acceptance (quota/access wall at the API) — the FAILED
        // receipt then carries no phantom run identity. Such failures pause the
        // adapter so the next slot never auto-launches a doomed attempt.
        if (receipt.stage !== "RESERVED" && receipt.stage !== "RUNNING" && receipt.stage !== "LAUNCH_UNKNOWN") {
          return unchanged(`run_status failed out of order from stage ${receipt.stage}`);
        }
        const preAcceptance = receipt.external_run_id === null;
        const quotaOrAccess = error_kind === "quota" || error_kind === "access";
        const next = note(
          `run failed${preAcceptance ? " (rejected before run acceptance)" : ""}${error_code ? ` (error code ${error_code})` : ""}${quotaOrAccess ? " — QUOTA/ACCESS failure, adapter will be paused" : ""}`,
        );
        next.stage = "FAILED";
        if (!preAcceptance) {
          next.adapter_status = "failed"; // granular upstream status; stays null when no run existed
          if (typeof event.worker_identity === "string" && event.worker_identity.length) {
            next.worker_identity = event.worker_identity; // poll supplies agent_id on failed runs too
          }
        }
        next.timestamps.terminal = at();
        return { receipt: next, accepted: true, pause_adapter: quotaOrAccess };
      }
      return unchanged(`unknown run_status "${status}"`);
    }
    case "callback": {
      // Direct validated-callback event (evidence arrives independently of a run
      // poll, e.g. GitHub/Linear evidence harvested by the reconciler).
      if (receipt.stage !== "RUNNING" && receipt.stage !== "LAUNCH_UNKNOWN") {
        return unchanged(`callback out of order from stage ${receipt.stage}`);
      }
      const evidence = { links: event.links ?? [], attempt_id: event.attempt_id, target_sha: event.target_sha };
      // COMPLETED requires an ACKNOWLEDGED run (external_run_id present). Evidence
      // for a run whose ack was lost (LAUNCH_UNKNOWN) holds for reconciliation —
      // never mint COMPLETED without a run identity (CodeRabbit).
      if (receipt.external_run_id === null) {
        const next = note("callback received but the run was never acknowledged (LAUNCH_UNKNOWN) — HOLD for reconciliation");
        next.stage = "HOLD";
        next.timestamps.terminal = at();
        return { receipt: next, accepted: true };
      }
      if (callbackEvidenceValid(receipt, evidence, ctx)) {
        const next = note("validated callback received (attempt + target_sha match)");
        next.stage = "COMPLETED";
        next.evidence_links = [...next.evidence_links, ...evidence.links];
        next.timestamps.terminal = at();
        return { receipt: next, accepted: true };
      }
      // Stale/mismatched verdicts never satisfy this receipt — the machine holds
      // (slot retained) instead of inventing a PASS.
      const next = note("callback REJECTED (attempt_id or target_sha mismatch / stale head) — HOLD");
      next.stage = "HOLD";
      next.timestamps.terminal = at();
      return { receipt: next, accepted: true };
    }
    case "manual_claim": {
      // A conflicting manual claim (human asserts the work / disputes the run)
      // freezes the attempt for review. Never auto-resolves, never releases the
      // slot to another adapter behind the claimant's back.
      if (receipt.stage !== "LAUNCH_UNKNOWN" && receipt.stage !== "RUNNING" && receipt.stage !== "RESERVED") {
        return unchanged(`manual_claim not applicable from stage ${receipt.stage}`);
      }
      const next = note(
        `conflicting manual claim by ${event.actor ?? "unknown"}${event.detail ? ` (${event.detail})` : ""} — HOLD for resolution`,
      );
      next.stage = "HOLD";
      next.timestamps.terminal = at();
      return { receipt: next, accepted: true };
    }
    case "hold": {
      // Explicit hold (e.g. evidence missing after review).
      if (receipt.stage !== "RUNNING" && receipt.stage !== "LAUNCH_UNKNOWN") {
        return unchanged(`hold not applicable from stage ${receipt.stage}`);
      }
      const next = note(`held: ${event.reason ?? "no reason given"}`);
      next.stage = "HOLD";
      next.timestamps.terminal = at();
      return { receipt: next, accepted: true };
    }
    case "timeout": {
      // Timeout alone NEVER changes state and NEVER releases the slot: the run may
      // still be progressing upstream, and releasing would double-dispatch. Only an
      // audit note is appended.
      return { receipt: note(`timeout observed (${event.after_ms ?? "?"}ms) — state unchanged, slot retained`), accepted: true };
    }
    default:
      return unchanged(`unknown event type "${event.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Selection — which eligible issue gets the (single) dispatch slot
// ---------------------------------------------------------------------------

// selectNextReservation — deterministic slot allocation over the ready list.
// Honors max_dispatch (number of concurrently ACTIVE — non-terminal — receipts)
// and adapter_pause_map: a paused adapter is skipped so the next slot does not
// auto-launch a doomed attempt. Returns { candidate, adapter, skipped:[{id,reason}] }.
export function selectNextReservation({ ready = [], config = {}, receipts = [] }) {
  const maxDispatch = Number.isInteger(config.max_dispatch) ? config.max_dispatch : 1;
  const active = receipts.filter((r) => r && !TERMINAL_STAGES.includes(r.stage));
  const activeIssueIds = new Set(active.map((r) => r.issue_id));
  // Terminal COMPLETED/HOLD receipts mean the outcome awaits a human or the next
  // step — the coordinator never auto-redispatches the SAME issue off a terminal
  // COMPLETED/HOLD (lifecycle policy: only the agreed terminal result releases the
  // SLOT; the ISSUE itself stays parked until a human moves it). FAILED is the
  // retryable terminal (revision loops relaunch after a genuine run failure).
  const parkedIssueIds = new Set(
    receipts.filter((r) => r && (r.stage === "COMPLETED" || r.stage === "HOLD")).map((r) => r.issue_id),
  );
  const pauseMap = config.adapter_pause_map ?? {};
  const skipped = [];

  if (active.length >= maxDispatch) {
    return { candidate: null, adapter: null, skipped: [{ id: "*", reason: `max_dispatch=${maxDispatch} reached (${active.length} active)` }] };
  }

  for (const issue of ready) {
    if (activeIssueIds.has(issue.id)) {
      skipped.push({ id: issue.id, reason: "already has an active receipt" });
      continue;
    }
    if (parkedIssueIds.has(issue.id)) {
      skipped.push({ id: issue.id, reason: "issue has a terminal COMPLETED/HOLD receipt — parked for human/next-step, not auto-redispatched" });
      continue;
    }
    // Retry cap (GPT BLOCK #5 / CodeRabbit): FAILED is retryable, but NOT
    // unboundedly — after max_failed_attempts FAILED receipts the issue parks
    // for a human instead of minting a new attempt every tick forever.
    const maxFailed = Number.isInteger(config.max_failed_attempts) ? config.max_failed_attempts : 3;
    const failedCount = receipts.filter((r) => r && r.issue_id === issue.id && r.stage === "FAILED").length;
    if (failedCount >= maxFailed) {
      skipped.push({ id: issue.id, reason: `max failed attempts reached (${failedCount} >= ${maxFailed}) — parked for human review` });
      continue;
    }
    const adapter = adapterNameFor(issue.requested_worker);
    if (pauseMap[adapter] === true) {
      skipped.push({ id: issue.id, reason: `adapter ${adapter} is paused (adapter_pause_map) — no auto-launch of doomed attempts` });
      continue;
    }
    return { candidate: issue, adapter, skipped };
  }
  return { candidate: null, adapter: null, skipped };
}

// ---------------------------------------------------------------------------
// I/O behind injectable seams (never called in dry-run mode)
// ---------------------------------------------------------------------------

// sendLinear — single injectable GraphQL seam for ALL Linear reads/writes. Tests
// substitute fetchImpl; production uses global fetch. Token name only, no value.
export async function sendLinear(query, variables, token, fetchImpl = fetch) {
  if (!token) {
    const err = new Error("LINEAR_API_TOKEN is required for Linear I/O");
    err.code = "NO_LINEAR_TOKEN";
    throw err;
  }
  const res = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token, // token format: <api-key> (Linear accepts bare key)
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.errors?.length) {
    const err = new Error(body?.errors?.[0]?.message ?? `Linear HTTP ${res.status}`);
    err.code = `LINEAR_HTTP_${res.status}`;
    throw err;
  }
  return body.data;
}

export const LINEAR_ISSUES_QUERY = `
  query CoordinatorIssues($team: String!) {
    issues(team: { key: $team }, filter: { state: { type: { neq: "canceled" } } }) {
      nodes {
        id
        identifier
        title
        state { name }
        priorityLabel
        labels { nodes { name } }
        assignee { displayName }
        delegate { displayName }
        parent { identifier state { name } }
        relations {
          nodes {
            type
            relatedIssue { identifier state { name } }
          }
        }
      }
    }
  }`;

export const LINEAR_COMMENT_CREATE_MUTATION = `
  mutation CoordinatorReserve($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }`;

export const LINEAR_ISSUE_COMMENTS_QUERY = `
  query CoordinatorIssueComments($issueId: String!) {
    issue(id: $issueId) {
      comments(first: 100, orderBy: createdAt) {
        nodes { body createdAt }
      }
    }
  }`;

// normalizeLinearIssue — best-effort normalization of a Linear issue node into the
// resolver's shape. Fields the API does not expose map to neutral values; the
// resolver never invents backlog for a state it cannot see.
// NOTE (GPT review #4): children are NOT Linear's blocking relation. Blocking is
// read from `relations` of type "blockedBy"; delegation from the `delegate` field.
export function normalizeLinearIssue(node, repo) {
  const blockers = (node.relations?.nodes ?? [])
    .filter((r) => r?.type === "blockedBy")
    .map((r) => r.relatedIssue)
    .filter((i) => i?.identifier && i?.state?.name && i.state.name !== "Done" && i.state.name !== "Canceled")
    .map((i) => ({ id: i.identifier, state: i.state.name }));
  return {
    id: node.identifier,
    linearId: node.id ?? null, // Linear API calls need the UUID, not the identifier
    title: node.title ?? "",
    state: node.state?.name ?? null,
    priority: node.priorityLabel ?? "No priority",
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    assignee: node.assignee?.displayName ? { name: node.assignee.displayName } : null,
    delegate: node.delegate?.displayName ? { name: node.delegate.displayName } : null,
    linkedPRs: [],
    parent: node.parent ? { id: node.parent.identifier, state: node.parent.state?.name ?? null } : null,
    blockers,
    repo,
  };
}

export async function fetchLinearIssues({ token, repo, team = "SHU", fetchImpl = fetch }) {
  const data = await sendLinear(LINEAR_ISSUES_QUERY, { team }, token, fetchImpl);
  return (data?.issues?.nodes ?? []).map((n) => normalizeLinearIssue(n, repo));
}

// fetchIssueComments — read an issue's comment thread (durable receipts + pause
// markers + worker callbacks live there). issueId is the Linear UUID when known,
// else the identifier (mocked tests / snapshot mode tolerate either).
export async function fetchIssueComments({ issueId, token, fetchImpl = fetch }) {
  const data = await sendLinear(LINEAR_ISSUE_COMMENTS_QUERY, { issueId }, token, fetchImpl);
  return data?.issue?.comments?.nodes ?? [];
}

// fetchBranchHead — current commit SHA of a branch (stale-SHA checks in the
// lifecycle pass). Reads only; contents:read token suffices.
export async function fetchBranchHead({ repo, branch, token, fetchImpl = fetch }) {
  if (!token || !repo || !branch) return null;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.commit?.sha ?? null;
}

// Receipt comments: the receipt JSON is embedded in a fenced block so it can be
// round-tripped from the Linear thread (durable source of truth for the pilot).
export function receiptCommentBody(receipt) {
  return [
    `<!-- coordinator-receipt v1 (dry-run pilot) -->`,
    `**Coordinator dispatch receipt** — attempt ${receipt.attempt_id}`,
    `\`\`\`json`,
    JSON.stringify(receipt, null, 2),
    `\`\`\``,
  ].join("\n");
}

export function parseReceiptCommentBody(body) {
  const m = /```json\n([\s\S]*?)\n```/.exec(body ?? "");
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// PAUSE_MARKER_RE — durable adapter-pause notice written as a Linear comment on the
// issue whose dispatch hit the wall (quota/access). Read back on every reconcile so
// a paused adapter never auto-launches a doomed attempt after a workflow restart
// (CodeRabbit: the in-memory pause died with the process).
export const PAUSE_MARKER_RE = /^coordinator-pause:\s*([a-z0-9-]+)$/m;

// parseReceiptsFromComments — reconstruct durable receipts from Linear comment
// bodies. Resolution is by EXPLICIT createdAt ordering (GPT lifecycle BLOCK #5):
// the newest comment per attempt_id wins, regardless of the order the API or any
// future code change returns nodes in. A stale RESERVED comment can therefore
// never replace a newer terminal one. Fallbacks: receipt.last_activity, then the
// array position (query uses orderBy createdAt ascending).
export function parseReceiptsFromComments(comments = []) {
  const byAttempt = new Map(); // attempt_id -> { receipt, createdAt }
  for (const comment of comments ?? []) {
    const parsed = parseReceiptCommentBody(comment?.body);
    if (parsed && typeof parsed === "object" && parsed.receipt_version === "1.0.0" && parsed.attempt_id) {
      const prior = byAttempt.get(parsed.attempt_id);
      const createdAt = typeof comment?.createdAt === "string" ? comment.createdAt : null;
      if (!prior) {
        byAttempt.set(parsed.attempt_id, { receipt: parsed, createdAt });
        continue;
      }
      // Newest-by-createdAt wins; a comment WITHOUT a timestamp loses to one
      // with one; a tie keeps the LATER array element (query is createdAt ASC).
      const ct = prior.createdAt;
      const replace = createdAt === null ? false : ct === null ? true : createdAt >= ct;
      if (replace) byAttempt.set(parsed.attempt_id, { receipt: parsed, createdAt });
    }
  }
  return [...byAttempt.values()].map((entry) => entry.receipt);
}

// COORDINATOR_CALLBACK_MARKER_RE + parseEvidenceFromComments — workers publish
// their structured callback as a Linear comment on the issue (adapter contract:
// issue/attempt ids, branch, commit SHA, stage BUILD_READY/REVISION_READY/
// BLOCKED/FAILED, CI/evidence links). The lifecycle pass loads this evidence so a
// polled "completed" run can be validated against the SAME attempt + bound head.
// Selection is deterministic by explicit createdAt (newest wins) — an older
// successful callback can never mask a newer BLOCKED/FAILED one (GPT BLOCK #2).
export const COORDINATOR_CALLBACK_MARKER_RE = /^coordinator-callback v1$/m;

export function parseEvidenceFromComments(comments = [], attempt_id) {
  let best = null;
  for (const comment of comments ?? []) {
    if (!comment?.body || !COORDINATOR_CALLBACK_MARKER_RE.test(comment.body)) continue;
    const m = /```json\n([\s\S]*?)\n```/.exec(comment.body);
    if (!m) continue;
    try {
      const cb = JSON.parse(m[1]);
      if (!cb || cb.attempt_id !== attempt_id) continue;
      const candidate = {
        links: Array.isArray(cb.links) ? cb.links : [],
        attempt_id: cb.attempt_id,
        target_sha: typeof cb.target_sha === "string" ? cb.target_sha : null,
        stage: typeof cb.stage === "string" ? cb.stage : null, // BUILD_READY | REVISION_READY | BLOCKED | FAILED
      };
      const createdAt = typeof comment.createdAt === "string" ? comment.createdAt : null;
      if (!best || (createdAt && (!best.createdAt || createdAt > best.createdAt))) {
        best = { ...candidate, createdAt };
      }
    } catch {
      // malformed callback comment — ignore, the next one may parse
    }
  }
  return best ? { links: best.links, attempt_id: best.attempt_id, target_sha: best.target_sha, stage: best.stage } : null;
}

export function parsePausedAdapters(comments = []) {
  const paused = new Set();
  for (const comment of comments ?? []) {
    const m = PAUSE_MARKER_RE.exec(comment?.body ?? "");
    if (m) paused.add(m[1]);
  }
  return [...paused];
}

// ---------------------------------------------------------------------------
// Wake-hint gating (issue_comment events)
// ---------------------------------------------------------------------------

// Comments are WAKE HINTS ONLY: they trigger a re-reconcile, and authorization is
// ALWAYS reconstructed from durable Linear/GitHub state — never from comment text.
// Bot authors (GitHub apps end with [bot]) are skipped so agent chatter cannot
// spam the reconcile slot.
export function isWakeHintAllowed(actor, allowlist = ["BAWES"]) {
  // Wake hints are honored ONLY from known actors on an explicit allowlist
  // (GPT review #5): bots are never hints, and an unknown actor fails closed.
  if (typeof actor !== "string" || actor.length === 0) return false;
  if (/\[bot\]$/i.test(actor)) return false;
  return allowlist.includes(actor);
}

// ---------------------------------------------------------------------------
// Dry-run / dispatch entrypoint
// ---------------------------------------------------------------------------

export function loadConfig(file = path.join(__dirname, "config.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadSnapshot(file = path.join(__dirname, "test", "fixtures", "snapshot.json")) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return { issues: raw.issues ?? [], openPRs: raw.openPRs ?? [], meta: raw.meta ?? {} };
}

function printReport({ config, source, eligibility, selection, dispatchEnabled }) {
  const lines = [];
  lines.push(`coordinator reconcile — ${dispatchEnabled ? "DISPATCH ENABLED" : "DRY-RUN (dispatch disabled, no writes)"}`);
  lines.push(`pilot_repo=${config.pilot_repo}  max_dispatch=${config.max_dispatch}  source=${source}`);
  lines.push(`eligible=${eligibility.ready.length}  excluded=${eligibility.excluded.length}`);
  for (const issue of eligibility.ready) {
    lines.push(`  READY    ${issue.id.padEnd(18)} ${issue.priority.padEnd(11)} ${issue.title}`);
  }
  for (const x of eligibility.excluded) {
    lines.push(`  EXCLUDED ${x.id.padEnd(18)} ${x.reason}`);
  }
  lines.push(`adapter_pause_map=${JSON.stringify(config.adapter_pause_map ?? {})}`);
  if (selection.candidate) {
    lines.push(`next reservation (if dispatch were on): ${selection.candidate.id} via ${selection.adapter}`);
  } else {
    lines.push(`next reservation: none` + (selection.skipped.length ? ` — ${selection.skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")}` : ""));
  }
  return lines.join("\n");
}

// reconcileOnce — pure-ish orchestration shared by dry-run and dispatch paths.
// Returns { report, plan } and performs NO I/O except what the caller injects.
export function reconcileOnce({ issues, openPRs, config, receipts = [], event = {} }) {
  const eligibility = computeEligibility({ issues, openPRs, config });
  const selection = selectNextReservation({ ready: eligibility.ready, config, receipts });
  return { eligibility, selection };
}

async function liveIssues({ config, linearToken, githubToken, fetchImpl = fetch }) {
  // Best-effort live pull: Linear issues scoped to the team + open PRs from the
  // pilot repo (links matched by issue id mentioned in PR title/body/head).
  const issues = await fetchLinearIssues({ token: linearToken, repo: config.pilot_repo, team: config.team ?? "SHU", fetchImpl });
  let openPRs = [];
  if (githubToken) {
    const res = await fetchImpl(`https://api.github.com/repos/${config.pilot_repo}/pulls?state=open&per_page=100`, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "User-Agent": "coordinator-dry-run" },
    });
    if (res.ok) openPRs = await res.json();
  }
  // Heuristic link: open PRs whose head ref or body names an issue id.
  const idsInFlight = new Set();
  for (const pr of openPRs) {
    const blob = `${pr.title ?? ""} ${pr.body ?? ""} ${pr.head?.ref ?? ""}`;
    for (const issue of issues) {
      if (new RegExp(`\\b${issue.id}\\b`).test(blob)) idsInFlight.add(issue.id);
    }
  }
  for (const issue of issues) {
    if (idsInFlight.has(issue.id)) issue.linkedPRs = [{ number: null, state: "OPEN" }];
  }
  return { issues, openPRs };
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const config0 = loadConfig(io.configPath);
  const config = { ...config0, adapter_pause_map: { ...(config0.adapter_pause_map ?? {}) } };
  const dispatchEnabled = dispatchEnabledFor(env, config);
  const linearToken = env.LINEAR_API_TOKEN ?? "";
  const githubToken = env.GITHUB_TOKEN ?? "";
  const fetchImpl = io.fetchImpl ?? fetch;

  // Wake-hint filter: an issue_comment from a non-allowlisted actor is not a
  // wake hint (GPT review #5 — explicit allowlist, not just 'not a bot').
  if ((env.GITHUB_EVENT_NAME ?? "") === "issue_comment") {
    if (!isWakeHintAllowed(env.GITHUB_ACTOR, config.wake_actor_allowlist)) {
      const out = `issue_comment wake hint from actor ${env.GITHUB_ACTOR ?? "<unknown>"} ignored — no reconcile`;
      if (io.stdout) io.stdout(out);
      return 0;
    }
  }

  // Data source: LINEAR_API_TOKEN present -> live Linear (+GitHub for PR links);
  // absent -> LOCAL SNAPSHOT mode (deterministic, CI-safe, offline).
  let issues;
  let openPRs = [];
  let source;
  if (linearToken) {
    ({ issues, openPRs } = await liveIssues({ config, linearToken, githubToken, fetchImpl }));
    source = "live Linear";
  } else {
    const snap = loadSnapshot(io.snapshotPath);
    issues = snap.issues;
    openPRs = snap.openPRs;
    source = `local snapshot (${path.basename(io.snapshotPath ?? "snapshot.json")})`;
  }

  // Durable state: read receipts + adapter-pause markers back from Linear comment
  // bodies BEFORE deciding anything. A surviving RESERVED/RUNNING receipt consumes
  // the slot (no duplicate reservation); a pause marker keeps a quota-walled
  // adapter from auto-launching on the next issue (CodeRabbit persistence fix).
  //
  // GPT review #2: comments are fetched for EVERY non-canceled issue — not just
  // cards currently eligible. A launched card that moved to In Progress is then
  // still represented by its active receipt and still consumes max_dispatch.
  // Any receipt-read failure FAILS CLOSED: dispatch is prevented for the whole
  // run (a card whose durable state cannot be read must never be launched at).
  let receipts = [...(io.receipts ?? [])];
  let durableReadFailed = false;
  const commentsByIssue = new Map(); // issue id/identifier -> raw comment nodes (evidence source)
  if (linearToken && io.fetchDurable !== false) {
    const pausedAdapters = new Set(Object.keys(config.adapter_pause_map).filter((k) => config.adapter_pause_map[k]));
    for (const issue of issues) {
      try {
        const comments = await fetchIssueComments({ issueId: issue.linearId ?? issue.id, token: linearToken, fetchImpl });
        commentsByIssue.set(issue.id, comments);
        if (issue.linearId) commentsByIssue.set(issue.linearId, comments);
        receipts = receipts.concat(parseReceiptsFromComments(comments));
        for (const adapter of parsePausedAdapters(comments)) pausedAdapters.add(adapter);
      } catch (err) {
        durableReadFailed = true;
        if (io.stdout) io.stdout(`durable read failed for ${issue.id}: ${err.message} — DISPATCH PREVENTED (fail closed)`);
      }
    }
    for (const adapter of pausedAdapters) config.adapter_pause_map[adapter] = true;
  }

  // ---- LIFECYCLE PASS (GPT lifecycle BLOCK @ f03d445) ----
  // Before selecting new work, poll every active RUNNING receipt through the
  // adapter's monitorRun() and durably persist terminal transitions. Without
  // this the first accepted trigger would occupy the only slot forever, and
  // worker_identity would never be learned (only polling supplies agent_id).
  // GPT BLOCK #3: Linear comment mutations require the issue UUID, not the
  // identifier. Resolve identifier -> linearId from the fetched issue set;
  // a receipt whose issue is not in the map FAILS CLOSED (no write, state kept).
  const linearIdFor = new Map(issues.filter((i) => i.linearId).map((i) => [i.id, i.linearId]));
  const resolveLinearIssueId = (receipt, what) => {
    const uuid = linearIdFor.get(receipt.issue_id);
    if (!uuid) {
      if (io.stdout) io.stdout(`lifecycle: ${what} for ${receipt.issue_id} SKIPPED — no issue UUID mapping (fail closed, state unchanged)`);
      return null;
    }
    return uuid;
  };

  const adapterModule = await import("./adapters/workspace-agents.mjs"); // lifecycle poll + dispatch share one import
  let lifecyclePersisted = false; // a terminal transition was durably written this run
  // GPT BLOCK #1: lifecycle polling/mutation is part of DISPATCH. Disabled means
  // compute/report only and ZERO writes — never poll upstream or persist receipts
  // while both dispatch gates are false.
  if (dispatchEnabled && linearToken && io.pollRuns !== false) {
    const waToken = env.WORKSPACE_AGENT_ACCESS_TOKEN ?? "";
    const waTrigger = env.WORKSPACE_AGENT_TRIGGER_ID ?? "";
    for (const receipt of receipts.filter((r) => r.stage === "RUNNING" && typeof r.external_run_id === "string" && r.external_run_id.length)) {
      // Callback evidence from the durable issue thread (same attempt_id bound);
      // selection is deterministic by newest createdAt (GPT BLOCK #2).
      const evidence = parseEvidenceFromComments(commentsByIssue.get(receipt.issue_id) ?? [], receipt.attempt_id) ?? undefined;
      // Head verification is TRI-STATE (GPT BLOCK #4): no GitHub token -> the
      // bound target_sha IS the reference head; token present -> the live branch
      // head must resolve, and an unreadable/missing head must prevent COMPLETED
      // (HOLD), never silently become "head matches".
      let headVerified = true;
      let current_head = receipt.target_sha;
      if (githubToken && receipt.repo && receipt.branch) {
        try {
          const head = await fetchBranchHead({ repo: receipt.repo, branch: receipt.branch, token: githubToken, fetchImpl });
          if (head) {
            current_head = head;
          } else {
            headVerified = false;
          }
        } catch {
          headVerified = false; // head could not be verified — never assume equality
        }
      }
      let outcome;
      try {
        outcome = await adapterModule.monitorRun({
          run_id: receipt.external_run_id,
          attempt_id: receipt.attempt_id,
          target_sha: receipt.target_sha,
          evidence,
          current_head: headVerified ? current_head : undefined,
          token: waToken,
          api_trigger_id: waTrigger,
          fetchImpl,
        });
      } catch (err) {
        if (io.stdout) io.stdout(`lifecycle: poll failed for ${receipt.issue_id} ${receipt.external_run_id}: ${err.message} — state unchanged, slot held`);
        continue;
      }
      let event = null;
      if (outcome.stage === "RUNNING") {
        event = { type: "run_status", status: outcome.adapter_status, worker_identity: outcome.worker_identity ?? null };
      } else if (outcome.stage === "COMPLETED") {
        if (!headVerified) {
          // Completed upstream but the live head could not be verified — HOLD,
          // never COMPLETED (GPT BLOCK #4: fail closed on unverifiable head).
          event = { type: "run_status", status: "completed", reason: "head could not be verified" };
        } else {
          event = {
            type: "run_status",
            status: "completed",
            callback: { links: outcome.evidence_links ?? [], attempt_id: receipt.attempt_id, target_sha: receipt.target_sha, stage: evidence?.stage ?? null },
            worker_identity: outcome.worker_identity ?? null,
          };
        }
      } else if (outcome.stage === "HOLD") {
        event = { type: "run_status", status: "completed" }; // completed without validated callback → machine HOLDs
      } else if (outcome.stage === "FAILED") {
        event = { type: "run_status", status: "failed", error_code: outcome.error_code, error_kind: outcome.error_kind, worker_identity: outcome.worker_identity ?? null };
      } else {
        continue; // UNCHANGED (transient poll failure or missing credentials) — never touch state, never release the slot
      }
      const transition = nextReceiptState(receipt, event);
      if (!transition.accepted) {
        if (io.stdout) io.stdout(`lifecycle: transition REJECTED for ${receipt.issue_id} (${transition.reason ?? "unknown"}) — slot held`);
        continue;
      }
      const nextReceipt = transition.receipt;
      const changed =
        nextReceipt.stage !== receipt.stage ||
        nextReceipt.adapter_status !== receipt.adapter_status ||
        nextReceipt.worker_identity !== receipt.worker_identity;
      if (!changed) continue;
      const linearIssueId = resolveLinearIssueId(receipt, "receipt persistence");
      if (!linearIssueId) continue; // fail closed: never write to a wrong/unresolved issue
      await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(nextReceipt) }, linearToken, fetchImpl);
      lifecyclePersisted = true;
      if (transition.pause_adapter === true) {
        const adapter = adapterNameFor(receipt.requested_worker);
        config.adapter_pause_map[adapter] = true;
        await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
      }
      const idx = receipts.indexOf(receipt);
      if (idx >= 0) receipts[idx] = nextReceipt;
      if (io.stdout) io.stdout(`lifecycle: ${receipt.issue_id} ${receipt.stage} -> ${nextReceipt.stage} (worker_identity=${nextReceipt.worker_identity ?? "null"}, external_run_id=${nextReceipt.external_run_id ?? "null"})`);
    }
  }

  const { eligibility, selection } = reconcileOnce({ issues, openPRs, config, receipts });
  const report = printReport({ config, source, eligibility, selection, dispatchEnabled });

  if (!dispatchEnabled) {
    // DRY-RUN: report only. ZERO writes — no Linear comments, no adapter calls,
    // no receipts, no state files. Exit 0 so CI treats the skeleton as healthy.
    const out = io.stdout ?? ((s) => console.log(s));
    out(report);
    return 0;
  }

  // ---- DISPATCH PATH (unreachable unless ENABLE_DISPATCH=true). ----
  // Reviewable, injectable glue exercised only via unit tests with mocked
  // sendLinear/fetch. Ordering invariants:
  //   (0) a durable-read failure ANYWHERE above prevents all dispatch (fail closed);
  //   (1) authorization_ref must be contract-bound (free text REFUSED);
  //   (2) the RESERVED receipt is persisted (Linear comment) BEFORE any launch;
  //   (3) the persisted reservation is RE-READ and validated before launching;
  //   (4) the adapter trigger carries the launch Idempotency-Key so retries after
  //       LAUNCH_UNKNOWN reuse the exact same upstream key.
  if (io.stdout) io.stdout(report);
  if (durableReadFailed) {
    if (io.stdout) io.stdout(`dispatch: PREVENTED — durable receipt state could not be fully read (fail closed); reconcile after the read path recovers`);
    return 2;
  }
  if (lifecyclePersisted) {
    // One decision per reconcile tick: this run already advanced active runs to
    // their terminal states — new dispatch waits for the next tick so a retry
    // never compounds onto a transition made seconds ago in the same process.
    if (io.stdout) io.stdout(`dispatch: DEFERRED — lifecycle transitions were persisted this run; selection resumes next reconcile`);
    return 0;
  }
  const { candidate, skipped } = selection;
  if (!candidate) {
    if (io.stdout) io.stdout(`dispatch: no reservation — ${skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")}`);
    return 0;
  }
  const authorization_ref = resolveAuthorizationRef(candidate, config);
  if (!authorization_ref) {
    throw new Error(`dispatch refused: no contract-bound authorization_ref for ${candidate.id} (free text and unapproved fixture ids are rejected)`);
  }
  const repo = candidate.repo ?? config.pilot_repo;
  const branch = candidate.branch ?? env.DISPATCH_BRANCH ?? `coordinator/${candidate.id}`;
  const target_sha = candidate.target_sha ?? env.DISPATCH_TARGET_SHA ?? null;
  if (!target_sha || !TARGET_SHA_RE.test(target_sha)) {
    throw new Error(`dispatch refused: no bound head for ${candidate.id} — target_sha is required (old PASS must never satisfy a changed head)`);
  }
  const { ok: reservedOk, receipt, errors } = createReceipt({
    issue_id: candidate.id,
    authorization_ref,
    requested_worker: candidate.requested_worker,
    repo,
    branch,
    target_sha,
  });
  if (!reservedOk) {
    throw new Error(`dispatch refused: reservation invalid — ${errors.join("; ")}`);
  }
  // Persist RESERVED *before* anything reaches the adapter (reserve precedes launch).
  const linearIssueId = candidate.linearId ?? receipt.issue_id; // UUID for the real API, identifier tolerated by mocks
  await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(receipt) }, linearToken, fetchImpl);

  // GPT review #3: RE-READ and validate the authoritative reservation before
  // launching. A missing, failed, or colliding reservation must never authorize
  // a worker — launch only when this attempt's RESERVED receipt is durably
  // present AND no other active receipt owns the issue.
  const verifyComments = await fetchIssueComments({ issueId: linearIssueId, token: linearToken, fetchImpl });
  const durable = parseReceiptsFromComments(verifyComments);
  const ownReservation = durable.find((r) => r.attempt_id === receipt.attempt_id && r.stage === "RESERVED");
  const otherActive = durable.find((r) => r.attempt_id !== receipt.attempt_id && !TERMINAL_STAGES.includes(r.stage));
  if (!ownReservation) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before launch — reservation ${receipt.attempt_id} not durably present after write; slot held`);
    return 2;
  }
  if (otherActive) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before launch — conflicting active receipt ${otherActive.attempt_id} (${otherActive.stage}) owns ${candidate.id}; slot held`);
    return 2;
  }

  const dispatchAdapterModule = await import("./adapters/workspace-agents.mjs");
  const launch = await dispatchAdapterModule.launchBuilder({
    issue_id: receipt.issue_id,
    authorization_ref: receipt.authorization_ref,
    attempt_id: receipt.attempt_id,
    target_sha: receipt.target_sha,
    task_context: `Authorized contract ref ${receipt.authorization_ref}; deterministic dispatch pilot; issue ${receipt.issue_id} on ${receipt.branch} @ ${receipt.target_sha}`,
    api_trigger_id: env.WORKSPACE_AGENT_TRIGGER_ID ?? "",
    token: env.WORKSPACE_AGENT_ACCESS_TOKEN ?? "",
    fetchImpl,
  });
  // Drive the state machine IN ORDER: the launch event first (RESERVED ->
  // LAUNCH_UNKNOWN, launch timestamp set), THEN fold the adapter outcome on top
  // (ack -> RUNNING / stays LAUNCH_UNKNOWN / upstream failure). A worker ack
  // straight from RESERVED is out of order by design — launch always precedes it.
  let transition = nextReceiptState(receipt, { type: "launch" });
  if (transition.accepted) {
    if (launch.stage === "RUNNING") {
      transition = nextReceiptState(transition.receipt, {
        type: "worker_ack",
        external_run_id: launch.external_run_id,
        adapter_status: launch.adapter_status,
      });
    } else if (launch.stage !== "LAUNCH_UNKNOWN") {
      transition = nextReceiptState(transition.receipt, {
        type: "run_status",
        status: "failed",
        error_code: launch.error_code,
        error_kind: launch.error_kind,
      });
    }
  }
  if (!transition.accepted) {
    if (io.stdout) io.stdout(`dispatch: ${candidate.id} transition REJECTED (${transition.reason ?? "unknown reason"}) — state unchanged, slot held`);
    return 2;
  }
  const next = transition.receipt;
  if (launch.conversation_url && typeof launch.conversation_url === "string") {
    next.notes = [...next.notes, `conversation_url: ${launch.conversation_url}`]; // documented 202 field — evidence link for the run
  }
  // DURABLE RECEIPT: the transitioned state (RUNNING/LAUNCH_UNKNOWN/FAILED) is
  // persisted to Linear IMMEDIATELY — the durable receipt must never sit at
  // RESERVED after the API accepted the run (CodeRabbit).
  await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(next) }, linearToken, fetchImpl);
  // DURABLE PAUSE: quota/access failures persist an adapter-pause marker so a
  // workflow restart cannot auto-launch a doomed attempt (in-memory pause dies
  // with the process — CodeRabbit). Safe default when the map key is absent.
  if (launch.pause_adapter) {
    const adapter = adapterNameFor(candidate.requested_worker);
    config.adapter_pause_map[adapter] = true;
    await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
  }
  if (io.stdout) io.stdout(`dispatch: ${candidate.id} ${receipt.stage} -> ${next.stage} (external_run_id=${next.external_run_id ?? "null"}, pause_adapter=${launch.pause_adapter === true})`);
  return next.stage === "RUNNING" || next.stage === "LAUNCH_UNKNOWN" ? 0 : 2;
}

// CLI entry: `node .github/coordinator/reconcile.mjs`
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`coordinator reconcile failed: ${err.message}`);
    process.exitCode = 1;
  }
}
