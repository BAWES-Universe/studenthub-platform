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
//       * worker ack -> RUNNING; provider run id is stored IMMEDIATELY,
//         and the granular upstream adapter_status is preserved, never collapsed.
//       * completed WITHOUT a validated callback -> HOLD, never COMPLETED.
//       * quota/access failure -> FAILED and pauses the adapter (adapter_pause_map[adapter]=true)
//         so the next slot does not auto-launch a doomed attempt.
//       * timeout alone NEVER changes stage and NEVER releases the slot.
//       * conflicting manual claim / missing evidence -> HOLD.
//       * an old PASS never satisfies a changed head: verdicts are bound to target_sha.
//
// Linear API token names only — no secrets live in this repository.

import { preflightActivation, describeUnmetActivation, ACTIVATION_REQUIREMENTS } from "./activation.mjs";
import { routeSuccessorFromReceipts, renderWorkOrderDirective, parseWorkOrderDirective, outcomeForEvidenceStage, roleForRequestedWorker, reviewVerdictProvenanceValid } from "./review-routing.mjs";
import { parseActivationArgs, singleRunActivationStatus, activationAllowsTarget, renderActivationLine, episodeVerdict, latestCoherentTerminal, episodeScopeFor, receiptInEpisodeScope } from "./single-run-activation.mjs";
import fs from "node:fs";
import { deriveScopedBaseShaFromRemote, prepareAttemptWorkspace, workspaceFailureCode } from "./attempt-workspace.mjs";
import { initialWorkspaceScope, validateWorkspaceScope } from "./workspace-scope.mjs";
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
export const LINEAR_ISSUE_ID_RE = /^SHU-[0-9]+$/;

// Linear states a card may be picked up from. Anything else (including an unknown
// or inaccessible state) is ineligible — the resolver NEVER invents backlog.
export const PICKABLE_STATES = Object.freeze(["Todo"]);

export function authorizationRefValid(ref) {
  return typeof ref === "string" && AUTHORIZATION_REF_RE.test(ref);
}

// A dispatch scope is trusted operator configuration, never card or environment
// input. SHU-224 deliberately supports exactly one canonical Linear identifier:
// the fixture needs one issue, and accepting an empty or ambiguous allowlist
// would make its safety boundary harder to inspect. An absent key preserves the
// board-wide production behavior; a present-but-invalid key denies all work.
export function resolveDispatchScope(config = {}) {
  if (!Object.prototype.hasOwnProperty.call(config, "dispatch_scope")) {
    return { configured: false, valid: true, issueIds: null, reason: null };
  }
  const raw = config.dispatch_scope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { configured: true, valid: false, issueIds: new Set(), reason: "dispatch_scope must be an object" };
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "issue_ids") {
    return { configured: true, valid: false, issueIds: new Set(), reason: "dispatch_scope must contain only issue_ids" };
  }
  if (!Array.isArray(raw.issue_ids) || raw.issue_ids.length !== 1) {
    return { configured: true, valid: false, issueIds: new Set(), reason: "dispatch_scope.issue_ids must contain exactly one issue" };
  }
  const [issueId] = raw.issue_ids;
  if (typeof issueId !== "string" || !LINEAR_ISSUE_ID_RE.test(issueId)) {
    return { configured: true, valid: false, issueIds: new Set(), reason: "dispatch_scope issue must be a canonical SHU-<number> identifier" };
  }
  return { configured: true, valid: true, issueIds: new Set([issueId]), reason: null };
}

function dispatchScopeAllows(scope, issueId) {
  return scope.valid && (!scope.configured || scope.issueIds.has(issueId));
}

export function receiptsWithinDispatchScope(receipts = [], config = {}) {
  const scope = resolveDispatchScope(config);
  if (!scope.valid) return [];
  return receipts.filter((receipt) => receipt && dispatchScopeAllows(scope, receipt.issue_id));
}

// Dispatch scope limits NEW reservations and successor routing. It must never
// hide an in-flight receipt from lifecycle reconciliation: every non-terminal
// receipt still consumes the global max_dispatch capacity, so every such
// receipt must retain a path to terminal state.
export function receiptsForLifecycle(receipts = [], _config = {}) {
  return receipts.filter(Boolean);
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

// Repository policy requires independent verification for both R2 and R3 work
// (`.github/pull_request_template.md`). Linear carries that contract in labels
// such as `risk:R3`; older snapshots used the priority string directly.
const REVIEW_RISK_RE = /^risk:(R[23])$/i;
const LEGACY_REVIEW_PRIORITY_RE = /^R[23]$/i;
const VERIFIER_LABEL_RE = /^verifier:([^:\s]+)$/i;
const NEEDS_DECISION_RE = /^needs:decision$/i;
// Worker families the coordinator recognizes. SAME_FAMILY_VERIFIERS must cover
// every one of them — a coordinator test enforces that, so a new worker family
// cannot be added without an explicit verifier-independence decision.
export const WORKER_FAMILIES = Object.freeze(["codex-builder", "claude-verifier", "hermes-box"]);
const WORKER_LABEL_RE = new RegExp(`^worker:(${WORKER_FAMILIES.join("|")})$`);
// Rule 6 (SHU-219): a sub-issue completes BEFORE its parent, so only a parent
// that is terminal-canceled (Canceled/Duplicate) makes a child ineligible.
// Open or Done parents are fine; Rule 7 blockers are the ordering mechanism.
const PARENT_TERMINAL_EXCLUDED_STATES = new Set(["Canceled", "Duplicate"]);

export const DEFAULT_REPO_LABEL_MAP = Object.freeze({
  "repo:platform": "BAWES-Universe/studenthub-platform",
  "repo:legacy": "BAWES-Universe/studenthub",
  "repo:infrastructure": "BAWES-Universe/studenthub-infrastructure",
});

function hasLabel(issue, re) {
  return Array.isArray(issue.labels) && issue.labels.some((l) => re.test(String(l)));
}

function matchingLabels(issue, re) {
  return Array.isArray(issue.labels) ? issue.labels.filter((label) => re.test(String(label))) : [];
}

export function resolveRepositoryOwnership(labels, repoLabelMap = DEFAULT_REPO_LABEL_MAP) {
  const normalizedMap = Object.fromEntries(
    Object.entries({ ...DEFAULT_REPO_LABEL_MAP, ...(repoLabelMap ?? {}) })
      .map(([label, repo]) => [String(label).toLowerCase(), repo]),
  );
  const repoLabels = [...new Set((labels ?? [])
    .map((label) => String(label))
    .filter((label) => /^repo:/i.test(label)))];
  if (repoLabels.length === 0) {
    return { repo: null, error: "missing repo:<name> ownership label" };
  }
  if (repoLabels.length > 1) {
    return { repo: null, error: `multiple repository ownership labels: ${repoLabels.join(", ")}` };
  }
  const label = repoLabels[0];
  const repo = normalizedMap[label.toLowerCase()];
  if (typeof repo !== "string" || repo.length === 0) {
    return { repo: null, error: `unknown repository ownership label: ${label}` };
  }
  return { repo, error: null };
}

function requiredReviewRisk(issue) {
  const risks = matchingLabels(issue, REVIEW_RISK_RE)
    .map((label) => REVIEW_RISK_RE.exec(String(label))?.[1]?.toUpperCase())
    .filter(Boolean);
  if (risks.includes("R3")) return "R3";
  if (risks.includes("R2")) return "R2";
  const priority = String(issue.priority ?? "").toUpperCase();
  return LEGACY_REVIEW_PRIORITY_RE.test(priority) ? priority : null;
}

function namedVerifier(issue) {
  for (const label of issue.labels ?? []) {
    const match = VERIFIER_LABEL_RE.exec(String(label));
    if (match) return match[1].toLowerCase();
  }
  return null;
}

// SHU-223 — same-family review is self-verification, not independent review, so a
// type:implementation card may not name a verifier drawn from its own worker's
// family. This map is the single source of truth and must cover every entry in
// WORKER_FAMILIES: previously claude-verifier fell through to "no conflict", so a
// Claude-family worker could name verifier:claude or verifier:opus even though
// ELIGIBILITY.md said an implementation worker cannot be its own verifier.
export const SAME_FAMILY_VERIFIERS = Object.freeze({
  "codex-builder": Object.freeze(["codex", "gpt", "gpt-6"]),
  "claude-verifier": Object.freeze(["claude", "opus", "sonnet", "haiku", "fable"]),
  "hermes-box": Object.freeze(["hermes"]),
});

function verifierConflictsWithImplementationWorker(issue, verifier) {
  if (!verifier || !hasLabel(issue, /^type:implementation$/i)) return false;
  // Array.isArray also keeps an inherited key (e.g. "constructor") from ever
  // resolving to something truthy here.
  const sameFamily = SAME_FAMILY_VERIFIERS[requestedWorkerFor(issue)];
  return Array.isArray(sameFamily) && sameFamily.includes(verifier);
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
    // Rule 6: parent terminal-canceled → child must not run. Open or Done
    // parents are eligible — a sub-issue completes before its parent, and
    // excluding children of In Progress parents deadlocks every epic slice.
    if (issue.parent && PARENT_TERMINAL_EXCLUDED_STATES.has(issue.parent.state)) {
      exclude(`parent ${issue.parent.id ?? "?"} is ${stateLabel(issue.parent.state)} — children of a canceled parent must not run`);
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
    // Rule 9: repository policy requires a NAMED independent verifier for R2/R3.
    const reviewRisk = requiredReviewRisk(issue);
    const verifier = namedVerifier(issue);
    if (reviewRisk && !verifier) {
      exclude(`${reviewRisk} card without a named verifier label (verifier:<name>)`);
      continue;
    }
    if (reviewRisk && verifierConflictsWithImplementationWorker(issue, verifier)) {
      exclude(`${reviewRisk} implementation would be authored by its named verifier (${verifier})`);
      continue;
    }
    // Rule 10: repository ownership comes from the card's repo:<name> label,
    // never from whichever repository happened to be queried for open PRs.
    if (issue.repoResolutionError) {
      exclude(`repository ownership HOLD — ${issue.repoResolutionError}`);
      continue;
    }
    if (!issue.repo) {
      exclude("repository ownership HOLD — no authoritative repository was resolved");
      continue;
    }
    if (issue.repo !== pilotRepo) {
      exclude(`repo ${issue.repo} outside pilot repo ${pilotRepo}`);
      continue;
    }
    // An unavailable authoritative PR/claim lookup is evidence missing, not
    // evidence that no claim exists.
    if (issue.claimEvidenceError) {
      exclude(`claim evidence HOLD — ${issue.claimEvidenceError}`);
      continue;
    }

    ready.push({
      id,
      linearId: issue.linearId ?? null, // kept through selection: Linear comment writes need the UUID
      title: issue.title ?? "",
      state: issue.state,
      priority: issue.priority ?? "No priority",
      labels: [...(issue.labels ?? [])],
      repo: issue.repo,
      verifier,
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

// Adapter name for a worker family (pause-map markers and dispatch routing).
// The union of the two lanes that landed in parallel: codex-builder stays on
// Workspace Agents, hermes-box routes to the Hermes pool (SHU-62), and
// claude-verifier routes to the Claude Code subscription adapter (SHU-61).
export function adapterNameFor(requestedWorker) {
  if (requestedWorker === "hermes-box") return "hermes-pool";
  if (requestedWorker === "claude-verifier") return "claude-code";
  if (requestedWorker === "codex-builder") return "codex-cli"; // SHU-63 pivot: local Codex CLI (personal ChatGPT), WA inert
  return "codex-cli";
}

// ONE loader for every lane. io.adapterModules is the injection seam the
// main()-level tests use to drive an adapter without touching the real one.
export async function loadAdapterModule(adapter, io = {}) {
  if (io.adapterModules?.[adapter]) return io.adapterModules[adapter];
  if (adapter === "workspace-agents") return import("./adapters/workspace-agents.mjs"); // inert post-pivot: kept for a future managed workspace
  if (adapter === "codex-cli") return import("./adapters/codex-cli.mjs");
  if (adapter === "claude-code") return import("./adapters/claude-code.mjs");
  if (adapter === "hermes-pool") return import("./adapters/hermes-pool.mjs");
  throw new Error(`unknown coordinator adapter: ${adapter}`);
}

// Resolve the adapter for a receipt or a selection candidate.
export async function adapterModuleFor(receiptOrCandidate, io = {}) {
  return loadAdapterModule(adapterNameFor(receiptOrCandidate?.requested_worker), io);
}

export function adapterLaunchOptions(adapter, env, { resume = false } = {}) {
  if (adapter === "workspace-agents") {
    return {
      api_trigger_id: env.WORKSPACE_AGENT_TRIGGER_ID ?? "",
      token: env.WORKSPACE_AGENT_ACCESS_TOKEN ?? "",
    };
  }
  if (adapter === "codex-cli") {
    return {
      cwd: env.CODEX_WORKTREE_PATH ?? process.cwd(),
      env,
      resume,
    };
  }
  if (adapter === "claude-code") {
    return {
      oauth_token: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      cwd: env.CLAUDE_WORKTREE_PATH ?? process.cwd(),
      env,
      resume,
    };
  }
  if (adapter === "hermes-pool") {
    // Host-local lane: its wiring is io (pool dir, spawn, hostname, clock),
    // which the caller passes alongside these options rather than through env.
    return {};
  }
  throw new Error(`unknown coordinator adapter: ${adapter}`);
}

// Preparation is part of the existing launch boundary, after the reservation is
// durable. Injected adapters remain the seam for tests of unrelated properties;
// real local adapters always provision and validate an attempt-specific checkout.
export async function preparedLaunchOptions(adapter, receipt, env, io = {}, { resume = false } = {}) {
  const options = adapterLaunchOptions(adapter, env, { resume });
  if (!["codex-cli", "claude-code"].includes(adapter)) return options;
  const prepare = io.prepareWorkspace ?? (io.adapterModules?.[adapter] ? null : prepareAttemptWorkspace);
  if (!prepare) return options;
  const workspace = await prepare({ receipt, env, resume });
  if (!workspace?.cwd || !path.isAbsolute(workspace.cwd)) throw new Error("workspace preparation returned no absolute checkout");
  return { ...options, cwd: workspace.cwd };
}

// dispatchEnabledFor — dispatch requires BOTH gates in DIFFERENT layers (CodeRabbit):
// the in-repo config flag (enable_dispatch: false committed by default) AND the
// workflow environment variable. One gate alone never enables dispatch.
// SHU-63 adds a THIRD, strictly narrower way in, and only for one bounded run: an
// operator-owned single-run activation (see single-run-activation.mjs). It
// substitutes for the COMMITTED flag — never for the runtime switch — so the
// committed `enable_dispatch: false` and its assertions stay exactly as they were,
// and a forgotten activation file still cannot arm anything on its own. `armed` is
// only ever produced by singleRunActivationStatus(), which fails closed on every
// binding (missing, malformed, stale, replayed, wrong target, wrong revision).
export function dispatchEnabledFor(env = {}, config = {}, activation = null) {
  const envGate = (env.ENABLE_DISPATCH ?? "false").toLowerCase() === "true";
  if (config.enable_dispatch === true && envGate) return true; // committed path, unchanged
  return envGate && activation?.state === "armed";
}

// resolveAuthorizationRef — a dispatch is only legal against an APPROVED contract:
//   1. the fixture lane's configured authorization_ref for fixture probes;
//   2. an explicit candidate.authorization_ref that passes the regex;
//   3. a canonical card id (SHU-<n>) — the ratified card IS the contract ref.
// The fixture check must precede every candidate-supplied fallback because Linear
// mints ordinary-looking identifiers (for example SHU-140) for fixture cards and
// the fixture must stay pinned to its separately approved contract.
// Anything else resolves to null and the dispatch is REFUSED loudly.
export function resolveAuthorizationRef(candidate, config = {}) {
  const fixtureLane = config.fixture_lane ?? {};
  if (fixtureLane.id && candidate.id === fixtureLane.id) {
    if (fixtureLane.authorization_ref && authorizationRefValid(fixtureLane.authorization_ref)) return fixtureLane.authorization_ref;
    return null; // fixture lane misconfigured — refuse loudly, never guess
  }
  if (candidate.authorization_ref && authorizationRefValid(candidate.authorization_ref)) return candidate.authorization_ref;
  if (typeof candidate.id === "string" && /^SHU-[0-9]+$/.test(candidate.id)) return candidate.id;
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
  if (["workspace_scope", "scope_phase", "allowed_paths", "scoped_base_sha"].some((field) => Object.hasOwn(receipt, field))) {
    if (!["workspace_scope", "scope_phase", "allowed_paths", "scoped_base_sha"].every((field) => Object.hasOwn(receipt, field))) {
      errors.push("workspace scope fields must be present together");
    } else if (!Array.isArray(receipt.allowed_paths) || receipt.allowed_paths.some((x) => typeof x !== "string")) {
      errors.push('field "allowed_paths" must contain only strings');
    } else {
      const scope = validateWorkspaceScope(receipt, { requireScopedBase: true });
      if (!scope.ok) errors.push(`workspace scope invalid: ${scope.reason}`);
    }
  }
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
    expectPattern("external_run_id", /^(?:apirun|clauderun|codexrun)_[A-Za-z0-9_-]+$/);
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
  // RESERVED has no run. LAUNCH_UNKNOWN may carry a discovered durable run id:
  // the provider session exists, but the launch/terminal outcome is still unknown.
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
  if (stage === "RESERVED") {
    if (runId !== null) errors.push("stage RESERVED must have external_run_id null (no run exists yet)");
    if (workerIdentity !== null) errors.push("stage RESERVED must have worker_identity null (no run identity yet)");
    if (adapterStatus !== null) errors.push("stage RESERVED must have adapter_status null");
  } else if (stage === "LAUNCH_UNKNOWN") {
    const discovered = runId !== null;
    if (discovered) {
      if (typeof workerIdentity !== "string" || !workerIdentity.length) errors.push("LAUNCH_UNKNOWN with a discovered run requires worker_identity");
      if (adapterStatus !== "in_progress") errors.push("LAUNCH_UNKNOWN with a discovered run requires adapter_status \"in_progress\"");
    } else {
      if (workerIdentity !== null) errors.push("LAUNCH_UNKNOWN without a run must keep worker_identity null");
      if (adapterStatus !== null) errors.push("LAUNCH_UNKNOWN without a run must keep adapter_status null");
    }
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
  workspace_scope = "full",
  scope_phase = requested_worker === "claude-verifier" ? "review" : "initial",
  allowed_paths = [],
  scoped_base_sha = null,
  episode_id = null,
  attempt_id = randomUUID(),
  reserved_at = new Date().toISOString(),
}) {
  const candidate = {
    receipt_version: "1.0.0",
    issue_id,
    attempt_id,
    authorization_ref,
    // SHU-231: the episode this attempt belongs to (null when no episode is
    // armed, i.e. the historically-tagged migration state). Untagged legacy
    // receipts stay readable exactly as before.
    episode_id,
    stage: "RESERVED",
    requested_worker,
    worker_identity: null,
    repo,
    branch,
    target_sha,
    workspace_scope,
    scope_phase,
    allowed_paths: [...allowed_paths],
    scoped_base_sha,
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
// and the SAME bound head, and an explicitly SUCCESSFUL stage. An old PASS
// against a moved head is rejected: the receipt
// is bound to target_sha, and if the live head (ctx.current_head) has advanced
// past it, the verdict describes a superseded tree and cannot satisfy this
// receipt. BLOCKED/FAILED callbacks never authorize COMPLETED (GPT BLOCK #2).
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY", "PASS"]);
export const CALLBACK_EVIDENCE_STAGES = Object.freeze([...SUCCESS_CALLBACK_STAGES, "BLOCKED", "FAILED"]);

// Bind every verdict-bearing callback to the durable attempt and head. This is
// deliberately broader than callbackEvidenceValid: BLOCKED/FAILED are valid
// review outcomes that route from HOLD, but can never authorize COMPLETED.
export function callbackBindingValid(receipt, evidence, ctx = {}) {
  if (!evidence || typeof evidence !== "object") return false;
  if (!Array.isArray(evidence.links) || evidence.links.length === 0) return false;
  if (evidence.attempt_id !== receipt.attempt_id) return false;
  if (evidence.target_sha !== receipt.target_sha) return false;
  const expectedHead = Object.hasOwn(ctx, "expected_head") ? ctx.expected_head : receipt.target_sha;
  if (!TARGET_SHA_RE.test(expectedHead ?? "")) return false;
  if (ctx.current_head && ctx.current_head !== expectedHead) return false;
  return CALLBACK_EVIDENCE_STAGES.includes(evidence.stage);
}

export function callbackEvidenceValid(receipt, evidence, ctx = {}) {
  return callbackBindingValid(receipt, evidence, ctx) && SUCCESS_CALLBACK_STAGES.includes(evidence.stage);
}

const nowIso = (at) => (at instanceof Date ? at.toISOString() : at) ?? new Date().toISOString();

// nextReceiptState — pure transition. Returns
//   { receipt, accepted, reason?, pause_adapter?, idempotency_key? }
// `accepted:false` means the event was out of order or invalid for the current
// stage — the receipt is returned UNCHANGED (slot never released, stage never
// downgraded). Terminal stages (COMPLETED/FAILED/HOLD) accept no further events.
// adapterFor — kept as the by-family alias over the single loader above.
export function adapterFor(requestedWorker, io = {}) {
  return loadAdapterModule(adapterNameFor(requestedWorker), io);
}

export function nextReceiptState(receipt, event, ctx = {}) {
  const unchanged = (reason) => ({ receipt, accepted: false, reason });

  if (!receipt || typeof receipt !== "object") {
    return unchanged(`event ${event?.type ?? "?"} requires an existing receipt (reserve first)`);
  }
  if (TERMINAL_STAGES.includes(receipt.stage)) {
    return unchanged(`stage ${receipt.stage} is terminal — no further transitions`);
  }

  const copy = () => structuredClone(receipt);
  const at = () => nowIso(event.at ?? ctx.now?.());
  const note = (text) => {
    const next = copy();
    next.notes = [...next.notes, text];
    next.last_activity = at();
    return next;
  };
  const appendAdapterAudit = (next) => {
    const links = Array.isArray(event.audit_evidence_links)
      ? event.audit_evidence_links.filter((link) => typeof link === "string" && link.length > 0)
      : [];
    const notes = Array.isArray(event.audit_notes)
      ? event.audit_notes.filter((entry) => typeof entry === "string" && entry.length > 0)
      : [];
    if (typeof event.reason_code === "string" && event.reason_code.length > 0) {
      notes.push(`adapter reason code: ${event.reason_code}`);
    }
    next.evidence_links = [...next.evidence_links, ...links];
    next.notes = [...next.notes, ...notes];
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
        return unchanged("worker_ack requires a provider external_run_id stored once the run is acknowledged");
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
    case "run_discovered": {
      // Some local CLIs emit their durable session identity before their process
      // has a trustworthy terminal outcome. Persist that identity while retaining
      // LAUNCH_UNKNOWN so recovery resumes it rather than treating it as pollable.
      if (receipt.stage !== "LAUNCH_UNKNOWN") {
        return unchanged(`run_discovered requires LAUNCH_UNKNOWN, got ${receipt.stage}`);
      }
      const { external_run_id, worker_identity } = event;
      if (typeof external_run_id !== "string" || !external_run_id.length || typeof worker_identity !== "string" || !worker_identity.length) {
        return unchanged("run_discovered requires provider run and worker identities");
      }
      if (receipt.external_run_id && receipt.external_run_id !== external_run_id) {
        return unchanged("run_discovered conflicts with the durable run identity");
      }
      const next = note(`durable run ${external_run_id} discovered; exact-id recovery required`);
      next.external_run_id = external_run_id;
      next.worker_identity = worker_identity;
      next.adapter_status = "in_progress";
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
          const isReviewLane = roleForRequestedWorker(receipt.requested_worker) === "review";
          // Fold-time provenance gate (SHU-73): require an adapter-observed
          // review session and refuse a supplied lineage that cannot be read.
          // Current one-slot independence is established structurally when the
          // build/review lanes are routed. Cross-role actor identity is a SHU-71
          // acceptance concern and is not claimed by this receipt-level check.
          const provenance = isReviewLane ? reviewVerdictProvenanceValid(receipt, ctx.lineage ?? []) : { ok: true };
          if (!provenance.ok) {
            const next = note(`run completed but review provenance is not closable — HOLD (${provenance.reason})`);
            next.stage = "HOLD";
            next.adapter_status = "completed";
            // A rejected verdict never becomes a durable routing fact. Preserve
            // the adapter-observed identity for diagnosis.
            if (typeof event.worker_identity === "string" && event.worker_identity.length) {
              next.worker_identity = event.worker_identity;
            }
            next.timestamps.terminal = at();
            return { receipt: next, accepted: true };
          }
          const next = appendAdapterAudit(note("run completed WITH validated callback (attempt + target_sha match)"));
          next.stage = "COMPLETED";
          next.adapter_status = "completed";
          next.evidence_links = [...next.evidence_links, ...callback.links];
          // Durable verdict facts (SHU-68 wiring replay): the terminal receipt
          // records the verdict stage + output head that routing consumed, so a
          // crash AFTER this persist can re-derive the successor directive on the
          // next reconcile without re-reading volatile state. Extra fields are
          // tolerated by validateReceipt (checked fields only).
          if (typeof callback.stage === "string" && callback.stage.length) next.verdict_stage = callback.stage;
          if (typeof callback.result_sha === "string" && /^[0-9a-f]{40}$/.test(callback.result_sha)) {
            next.result_sha = callback.result_sha;
          }
          if (typeof event.worker_identity === "string" && event.worker_identity.length) {
            next.worker_identity = event.worker_identity; // poll's agent_id, persisted with the terminal state
          }
          next.timestamps.terminal = at();
          return { receipt: next, accepted: true };
        }
        const next = appendAdapterAudit(note(
          event.reason_code
            ? `run completed without an acceptable verifier result — HOLD (${event.reason_code})`
            : callback
              ? "run completed but callback REJECTED (attempt/target_sha mismatch or stale head) — HOLD"
              : "run completed WITHOUT validated callback — HOLD (manual review required)",
        ));
        next.stage = "HOLD";
        next.adapter_status = "completed";
        // Durable verdict facts on HOLD too: a REVIEW BLOCK/FAIL that reached the
        // machine as "completed without SUCCESS callback" still carries a real
        // verdict the routing layer must replay after a crash. Persist the bound
        // callback's stage + output head whenever the callback is attempt-bound
        // (BLOCKED/FAILED never authorize COMPLETED — GPT lifecycle BLOCK — but
        // they ARE durable routing input). Unbound/no callback -> no verdict.
        if (callbackBindingValid(receipt, callback, ctx) && (callback.stage === "BLOCKED" || callback.stage === "FAILED")) {
          next.verdict_stage = callback.stage;
          if (typeof callback.result_sha === "string" && /^[0-9a-f]{40}$/.test(callback.result_sha)) {
            next.result_sha = callback.result_sha;
          }
        }
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
        const next = appendAdapterAudit(note(
          `run failed${preAcceptance ? " (rejected before run acceptance)" : ""}${error_code ? ` (error code ${error_code})` : ""}${quotaOrAccess ? " — QUOTA/ACCESS failure, adapter will be paused" : ""}`,
        ));
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
      const next = appendAdapterAudit(note(`held: ${event.reason ?? "no reason given"}`));
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

// Lanes whose activation contract must hold before any worker starts. Only the
// local-CLI builder lane carries it today; a hosted lane has no brick box and no
// host-local session state, so the requirements would not apply to it.
export const ACTIVATION_GATED_ADAPTERS = Object.freeze(["codex-cli"]);

// activationPreflightFor — null when the lane carries no contract, otherwise the
// preflight result. Kept beside the dispatch path so the gate and the lane list
// cannot drift apart.
export function activationPreflightFor(adapter, { env = {}, io = {}, cwd = undefined } = {}) {
  // Named opt-out for tests whose subject is some OTHER dispatch property, in
  // the same style as io.pollRuns / io.fetchDurable / io.adapterModules. It is
  // greppable, it is never set by the workflow, and production therefore always
  // runs the contract.
  if (io.skipActivationPreflight === true) return null;
  if (!ACTIVATION_GATED_ADAPTERS.includes(adapter)) return null;
  const stateDir = io.codexStateDir
    ?? (env.CODEX_HOME ? `${env.CODEX_HOME}/coordinator-runs` : (env.HOME ? `${env.HOME}/.codex/coordinator-runs` : null));
  return preflightActivation({ env, stateDir, cwd, io });
}

// resolveLiveHead — the tri-state rule both terminal-launch paths must apply.
// No GitHub token means the bound head IS the reference; a token present but an
// unreadable head is NEVER "head matches". Shared so dispatch and recovery
// cannot drift apart, which is exactly how recovery lost this guard.
export async function resolveLiveHead(receipt, { githubToken, fetchImpl }) {
  if (!githubToken || !receipt.repo || !receipt.branch) {
    return { verified: true, head: receipt.target_sha };
  }
  try {
    const head = await fetchBranchHead({ repo: receipt.repo, branch: receipt.branch, token: githubToken, fetchImpl });
    return head ? { verified: true, head } : { verified: false, head: null };
  } catch {
    return { verified: false, head: null };
  }
}

// Activation proves that the configured GitHub credential can read the exact
// repository commit before a local worker is started. Probing the commit (not
// the destination branch) also supports a first-time builder branch that does
// not exist until Codex pushes it.
export async function verifyActivationTarget(adapter, { repo, target_sha, githubToken, fetchImpl }) {
  if (!ACTIVATION_GATED_ADAPTERS.includes(adapter)) return { ok: true };
  if (!githubToken || !repo || !target_sha) return { ok: false, reason: "GitHub target verification is not configured" };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(target_sha)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) return { ok: false, reason: `GitHub target probe returned HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (body?.sha !== target_sha) return { ok: false, reason: "GitHub target probe returned an unexpected commit" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `GitHub target probe failed: ${error?.message ?? "unknown"}` };
  }
}

// Fold any adapter's normalized launch result through the same receipt machine.
// Remote adapters usually return RUNNING. A synchronous adapter such as
// `claude -p` can return its terminal result in the launch call; it is still
// acknowledged first so terminal receipts retain a durable run identity.
export function foldLaunchOutcome(receipt, launch, ctx = {}) {
  let transition = receipt.stage === "LAUNCH_UNKNOWN"
    ? { receipt, accepted: true, idempotency_key: launchIdempotencyKey(receipt) }
    : nextReceiptState(receipt, { type: "launch" }, ctx);
  if (!transition.accepted) return transition;

  if (launch.stage === "LAUNCH_UNKNOWN") {
    const hasDiscoveredRun = typeof launch.external_run_id === "string" && launch.external_run_id.length > 0;
    return hasDiscoveredRun
      ? nextReceiptState(transition.receipt, {
          type: "run_discovered",
          external_run_id: launch.external_run_id,
          worker_identity: launch.worker_identity,
        }, ctx)
      : transition;
  }

  const hasRun = typeof launch.external_run_id === "string" && launch.external_run_id.length > 0;
  if (hasRun) {
    transition = nextReceiptState(transition.receipt, {
      type: "worker_ack",
      external_run_id: launch.external_run_id,
      adapter_status: launch.stage === "RUNNING" ? launch.adapter_status : "in_progress",
      worker_identity: launch.worker_identity,
    }, ctx);
    if (!transition.accepted || launch.stage === "RUNNING") return transition;
  }

  if (launch.stage === "HOLD" && launch.pause_adapter === true) {
    // A broker/setup refusal can carry the worker's otherwise valid callback.
    // That callback cannot override the host's refusal and become COMPLETED.
    return nextReceiptState(transition.receipt, {
      type: "hold",
      reason: launch.reason ?? "adapter refused and paused",
      reason_code: launch.reason_code,
      audit_evidence_links: launch.audit_evidence_links,
      audit_notes: launch.audit_notes,
    }, ctx);
  }
  if (launch.stage === "COMPLETED" || launch.stage === "HOLD") {
    // ctx carries current_head. A synchronous adapter reaches COMPLETED here
    // WITHOUT passing through the lifecycle poll, so the stale-head guard in
    // callbackEvidenceValid only runs if the caller resolves the live head and
    // forwards it — see the dispatch path.
    return nextReceiptState(
      transition.receipt,
      {
        type: "run_status",
        status: "completed",
        callback: launch.callback,
        worker_identity: launch.worker_identity,
        reason_code: launch.reason_code,
        audit_evidence_links: launch.audit_evidence_links,
        audit_notes: launch.audit_notes,
      },
      ctx,
    );
  }
  return nextReceiptState(transition.receipt, {
    type: "run_status",
    status: "failed",
    error_code: launch.error_code,
    error_kind: launch.error_kind,
    worker_identity: launch.worker_identity,
    reason_code: launch.reason_code,
    audit_evidence_links: launch.audit_evidence_links,
    audit_notes: launch.audit_notes,
  }, ctx);
}

// ---------------------------------------------------------------------------
// Selection — which eligible issue gets the (single) dispatch slot
// ---------------------------------------------------------------------------

// selectNextReservation — deterministic slot allocation over the ready list.
// Honors max_dispatch (number of concurrently ACTIVE — non-terminal — receipts)
// and adapter_pause_map: a paused adapter is skipped so the next slot does not
// auto-launch a doomed attempt. Returns { candidate, adapter, skipped, successor? }.
//
// SHU-225: `episodeContinuations` maps issue_id -> { successor } for the ONE issue
// of an ARMED single-run episode whose routed successor is due. A terminal receipt
// normally parks an issue permanently; inside an authorized episode the successor
// is what re-admits that same issue for its NEXT step. It is an INPUT to this
// function, never a bypass around it: the continuation still has to clear scope,
// capacity, the retry cap, the adapter pause map and the pre-claim recheck in the
// caller, exactly like a first dispatch, and the launch still writes RESERVED
// before anything reaches an adapter. With no armed activation the map is empty
// and parking behaviour is byte-for-byte unchanged.
export function selectNextReservation({ ready = [], config = {}, receipts = [], episodeContinuations = new Map(), episodeScope = null, episodeIssueIds = new Set() }) {
  const scope = resolveDispatchScope(config);
  if (!scope.valid) {
    return { candidate: null, adapter: null, skipped: [{ id: "*", reason: `invalid dispatch_scope — ${scope.reason}; no fallback` }] };
  }
  const maxDispatch = Number.isInteger(config.max_dispatch) ? config.max_dispatch : 1;
  const active = receipts.filter((r) => r && !TERMINAL_STAGES.includes(r.stage));
  const activeIssueIds = new Set(active.map((r) => r.issue_id));
  // Terminal COMPLETED/HOLD receipts mean the outcome awaits a human or the next
  // step — the coordinator never auto-redispatches the SAME issue off a terminal
  // COMPLETED/HOLD (lifecycle policy: only the agreed terminal result releases the
  // SLOT; the ISSUE itself stays parked until a human moves it). FAILED is the
  // retryable terminal (revision loops relaunch after a genuine run failure).
  // SHU-231: parking is episode-scoped — the second and LAST decision the episode
  // boundary touches. A terminal receipt from a PREVIOUS episode must not park the
  // card for a freshly authorized episode; a terminal produced INSIDE the current
  // episode still parks it; an untagged-and-unnamed legacy terminal still parks it
  // (fail closed). With no armed episode `episodeScope` is null, every receipt
  // counts, and parking is byte-for-byte unchanged. Capacity, the retry cap and
  // lifecycle are computed from the UNFILTERED list below and stay global.
  const parkedIssueIds = new Set(
    receipts
      .filter((r) => r && (r.stage === "COMPLETED" || r.stage === "HOLD") && receiptInEpisodeScope(r, episodeScope))
      .map((r) => r.issue_id),
  );
  const pauseMap = config.adapter_pause_map ?? {};
  const skipped = [];

  if (active.length >= maxDispatch) {
    return { candidate: null, adapter: null, skipped: [{ id: "*", reason: `max_dispatch=${maxDispatch} reached (${active.length} active)` }] };
  }

  let sawScopedIssue = false;
  for (const issue of ready) {
    // SHU-224-SCOPE-GUARD: a configured single-issue run must never fall
    // through to a higher-priority or subsequent board-wide candidate.
    if (scope.configured && !scope.issueIds.has(issue.id)) {
      skipped.push({ id: issue.id, reason: "outside trusted dispatch_scope" });
      continue;
    }
    sawScopedIssue = true;
    if (activeIssueIds.has(issue.id)) {
      skipped.push({ id: issue.id, reason: "already has an active receipt" });
      continue;
    }
    // SHU-225 keyed this escape on "a successor was routed". SHU-231 adds the
    // other half: "an episode is authorized". A FRESH episode has no successor
    // yet, so keying it on a successor alone made a newly approved run
    // unreachable. Both remain INPUTS to this function — never a bypass — so
    // scope, capacity, the retry cap, the pause map and the pre-claim recheck all
    // still apply, and the launch still writes RESERVED before any adapter runs.
    if (parkedIssueIds.has(issue.id) && !episodeContinuations.has(issue.id) && !episodeIssueIds.has(issue.id)) {
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
    // SHU-225: the episode continuation selects the SUCCESSOR's own lane, so a
    // paused successor adapter is skipped here just like a first dispatch — the
    // pause map is not bypassed by being mid-episode.
    const continuation = episodeContinuations.get(issue.id) ?? null;
    const successor = continuation?.successor ?? null;
    const requestedWorker = successor?.requested_worker ?? issue.requested_worker;
    const adapter = adapterNameFor(requestedWorker);
    if (pauseMap[adapter] === true) {
      skipped.push({ id: issue.id, reason: `adapter ${adapter} is paused (adapter_pause_map) — no auto-launch of doomed attempts` });
      continue;
    }
    return { candidate: issue, adapter, skipped, successor, continuation: Boolean(continuation) };
  }
  if (scope.configured && !sawScopedIssue) {
    const [issueId] = scope.issueIds;
    skipped.unshift({ id: issueId, reason: "dispatch_scope target is unavailable or ineligible — no fallback" });
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
  query CoordinatorIssues($team: String!, $after: String) {
    issues(filter: { team: { key: { eq: $team } }, state: { type: { neq: "canceled" } } }, first: 100, after: $after) {
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
      pageInfo { hasNextPage endCursor }
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
        nodes { body createdAt user { id displayName } }
      }
    }
  }`;

// normalizeLinearIssue — best-effort normalization of a Linear issue node into the
// resolver's shape. Fields the API does not expose map to neutral values; the
// resolver never invents backlog for a state it cannot see.
// NOTE (GPT review #4): children are NOT Linear's blocking relation. Blocking is
// read from `relations` of type "blockedBy"; delegation from the `delegate` field.
export function normalizeLinearIssue(node, _queriedRepo, repoLabelMap = DEFAULT_REPO_LABEL_MAP) {
  const labels = (node.labels?.nodes ?? []).map((l) => l.name);
  const ownership = resolveRepositoryOwnership(labels, repoLabelMap);
  const blockers = (node.relations?.nodes ?? [])
    .filter((r) => r?.type === "blockedBy")
    .map((r) => ({
      id: r?.relatedIssue?.identifier ?? null,
      state: r?.relatedIssue?.state?.name ?? null,
    }));
  return {
    id: node.identifier,
    linearId: node.id ?? null, // Linear API calls need the UUID, not the identifier
    title: node.title ?? "",
    state: node.state?.name ?? null,
    priority: node.priorityLabel ?? "No priority",
    labels,
    assignee: node.assignee?.displayName ? { name: node.assignee.displayName } : null,
    delegate: node.delegate?.displayName ? { name: node.delegate.displayName } : null,
    linkedPRs: [],
    parent: node.parent ? { id: node.parent.identifier, state: node.parent.state?.name ?? null } : null,
    blockers,
    repo: ownership.repo,
    repoResolutionError: ownership.error,
  };
}

export async function fetchLinearIssues({ token, repo, team = "SHU", repoLabelMap = DEFAULT_REPO_LABEL_MAP, fetchImpl = fetch }) {
  const nodes = [];
  let after = null;
  const seenCursors = new Set();
  for (;;) {
    const data = await sendLinear(LINEAR_ISSUES_QUERY, { team, after }, token, fetchImpl);
    const page = data?.issues;
    nodes.push(...(page?.nodes ?? []));
    if (!page?.pageInfo?.hasNextPage) break;

    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor)) {
      const err = new Error("Linear issues pagination returned an invalid or repeated cursor");
      err.code = "LINEAR_PAGINATION_INVALID";
      throw err;
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  return nodes.map((n) => normalizeLinearIssue(n, repo, repoLabelMap));
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
// Fields that can never legitimately differ between two records of one attempt.
// Shared by the comment parser and main()'s conflict check so both layers apply
// the SAME rule — a control that only one layer enforces is unreachable if the
// other collapses its inputs first.
export const RECEIPT_IMMUTABLE_FIELDS = Object.freeze([
  "issue_id",
  "authorization_ref",
  "requested_worker",
  "repo",
  "branch",
  "target_sha",
  "workspace_scope",
  "scope_phase",
  "allowed_paths",
  "scoped_base_sha",
  // SHU-231: the episode a receipt belongs to. Stamped by the coordinator at
  // RESERVED, so two records claiming one attempt_id under DIFFERENT episodes are
  // a conflict -> HOLD, never a silent override of a spent approval.
  "episode_id",
]);

function immutableFieldEqual(a, b, field) {
  if (field === "allowed_paths") return JSON.stringify(a?.[field]) === JSON.stringify(b?.[field]);
  return a?.[field] === b?.[field];
}

export function parseReceiptsFromComments(comments = []) {
  const byAttempt = new Map(); // attempt_id -> { receipt, createdAt }
  const conflicts = []; // records held back so main()'s conflict check can fire
  for (const comment of comments ?? []) {
    const parsed = parseReceiptCommentBody(comment?.body);
    if (parsed && typeof parsed === "object" && parsed.receipt_version === "1.0.0" && parsed.attempt_id) {
      const prior = byAttempt.get(parsed.attempt_id);
      const createdAt = typeof comment?.createdAt === "string" ? comment.createdAt : null;
      if (!prior) {
        byAttempt.set(parsed.attempt_id, { receipt: parsed, createdAt });
        continue;
      }
      // IMMUTABLE-FIELD CONFLICT: two records claiming one attempt_id but
      // disagreeing on a field that can never legitimately change means durable
      // state is corrupt or forged. Collapsing them here would hide the conflict
      // from main()'s fail-closed check and silently prefer whichever comment is
      // NEWEST — i.e. the forged one, since Linear comments are writable by
      // anyone with issue access. Keep BOTH so main() sees the disagreement and
      // prevents dispatch. (Opus, exact-head verification of PR #21.)
      if (RECEIPT_IMMUTABLE_FIELDS.some((field) => !immutableFieldEqual(prior.receipt, parsed, field))) {
        conflicts.push(parsed);
        continue;
      }
      // Newest-by-createdAt wins; a comment WITHOUT a timestamp loses to one
      // with one; a tie keeps the LATER array element (query is createdAt ASC).
      const ct = prior.createdAt;
      const replace = createdAt === null ? false : ct === null ? true : createdAt >= ct;
      if (replace) byAttempt.set(parsed.attempt_id, { receipt: parsed, createdAt });
    }
  }
  return [...byAttempt.values()].map((entry) => entry.receipt).concat(conflicts);
}

// COORDINATOR_CALLBACK_MARKER_RE + parseEvidenceFromComments — workers publish
// their structured callback as a Linear comment on the issue (adapter contract:
// issue/attempt ids, branch, commit SHA, stage BUILD_READY/REVISION_READY/PASS/
// BLOCKED/FAILED, CI/evidence links). The lifecycle pass loads this evidence so a
// polled "completed" run can be validated against the SAME attempt + bound head.
// Selection is deterministic by explicit createdAt (newest wins) — an older
// successful callback can never mask a newer BLOCKED/FAILED one (GPT BLOCK #2).
export const COORDINATOR_CALLBACK_MARKER_RE = /^coordinator-callback v1$/m;

// Linear issue comments are an untrusted transport. Accept callback evidence
// only from immutable Linear actor IDs configured for the worker identities;
// display names are mutable and therefore cannot establish authorship.
export function parseEvidenceFromComments(comments = [], attempt_id, allowedActorIds = []) {
  const allowed = new Set((allowedActorIds ?? []).filter((id) => typeof id === "string" && id.length));
  if (allowed.size === 0) return null;
  let best = null;
  for (const comment of comments ?? []) {
    if (!comment?.body || !COORDINATOR_CALLBACK_MARKER_RE.test(comment.body)) continue;
    if (!allowed.has(comment.user?.id)) continue;
    const m = /```json\n([\s\S]*?)\n```/.exec(comment.body);
    if (!m) continue;
    try {
      const cb = JSON.parse(m[1]);
      if (!cb || cb.attempt_id !== attempt_id) continue;
      const candidate = {
        links: Array.isArray(cb.links) ? cb.links : [],
        attempt_id: cb.attempt_id,
        target_sha: typeof cb.target_sha === "string" ? cb.target_sha : null,
        result_sha: typeof cb.result_sha === "string" ? cb.result_sha : null, // exact commit the write produced (review binds this head)
        stage: typeof cb.stage === "string" ? cb.stage : null, // BUILD_READY | REVISION_READY | PASS | BLOCKED | FAILED
      };
      const createdAt = typeof comment.createdAt === "string" ? comment.createdAt : null;
      if (!best || (createdAt && (!best.createdAt || createdAt > best.createdAt))) {
        best = { ...candidate, createdAt };
      }
    } catch {
      // malformed callback comment — ignore, the next one may parse
    }
  }
  return best
    ? { links: best.links, attempt_id: best.attempt_id, target_sha: best.target_sha, result_sha: best.result_sha, stage: best.stage }
    : null;
}

export function parsePausedAdapters(comments = []) {
  const paused = new Set();
  for (const comment of comments ?? []) {
    const m = PAUSE_MARKER_RE.exec(comment?.body ?? "");
    if (m) paused.add(m[1]);
  }
  return [...paused];
}

// Parse every parseable work-order directive from a comment thread (newest
// last). Used by tests and by consumers that read the card as the instruction
// channel. Non-directive comments are skipped.
export function parseWorkOrderDirectiveFromComments(comments = []) {
  const orders = [];
  for (const comment of comments ?? []) {
    const parsed = parseWorkOrderDirective(comment?.body ?? "");
    if (parsed.ok && parsed.order) orders.push(parsed.order);
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Successor-directive replay/backfill (SHU-68 wiring, Codex BLOCK #2 resolved)
// ---------------------------------------------------------------------------
// The directive is derived from the DURABLE receipt verdict facts (verdict_stage
// + result_sha recorded on the terminal receipt at persist time) and routeSuccessor
// is idempotent: freshAttempt derives the successor attempt_id deterministically
// from the prior attempt + stage + round. So recomputing it on a later reconcile
// yields the SAME successor attempt, and posting is deduplicated against the
// card's existing directives (parseWorkOrderDirectiveFromComments). A crash after
// the terminal persist but before the directive post therefore self-heals on the
// next dispatch-enabled reconcile — exactly once, never duplicated.
export async function backfillSuccessorDirectives({
  receipts = [],
  commentsByIssue = new Map(),
  dispatchEnabled = false,
  linearToken = "",
  githubToken = "",
  linearIdFor = new Map(),
  config = {},
  env = {},
  fetchImpl = fetch,
  stdout = null,
  bootstrapByIssue = new Map(),
}) {
  const out = stdout ?? ((s) => console.log(s));
  // Defense in depth: this is the only helper that publishes successor
  // directives, so it owns a dispatch gate instead of relying solely on its
  // current caller's control flow.
  if (!dispatchEnabled) return 0;
  if (!linearToken) return 0;
  const dispatchScope = resolveDispatchScope(config);
  if (!dispatchScope.valid) return 0;
  let considered = 0;
  // Durable, terminal, verdict-bearing receipts across all issues. Older-infra
  // FAILED receipts carry no verdict_stage and are skipped (never route).
  const eligible = receiptsWithinDispatchScope(receipts, config)
    .filter((r) => terminalVerdictCoherent(r, r.verdict_stage));
  for (const terminal of eligible) {
    considered += 1;
    const issueId = terminal.issue_id;
    const comments = commentsByIssue.get(issueId) ?? commentsByIssue.get(terminal.linearId ?? "") ?? [];
    const linearIssueId = linearIdFor.get(issueId) ?? terminal.linearId ?? null;
    // Existing directives on THIS card, dedup keyed by successor attempt_id.
    const existing = parseWorkOrderDirectiveFromComments(comments);
    const lineage = (receipts ?? []).filter((r) => r && r.issue_id === issueId);
    // Authoritative head binding (Codex BLOCK #1): when a githubToken + branch
    // are present, fetch the LIVE branch head and bind routing to it — an
    // attacker/volatile result_sha that differs fails closed. If a live head is
    // expected but cannot be verified, publication also fails closed.
    let authoritativeHead = null;
    let branchHeadUnverified = false;
    if (githubToken && terminal.repo && terminal.branch) {
      try {
        const head = await fetchBranchHead({ repo: terminal.repo, branch: terminal.branch, token: githubToken, fetchImpl });
        if (head) {
          authoritativeHead = head;
        } else {
          branchHeadUnverified = true;
        }
      } catch {
        branchHeadUnverified = true;
      }
    }
    if (branchHeadUnverified) {
      out(`backfill: ${issueId} attempt ${terminal.attempt_id} -> no post (live branch head could not be verified — HOLD, fail closed)`);
      continue;
    }
    const routed = routeSuccessorFromReceipts({
      issueReceipts: lineage,
      terminal,
      evidenceStage: terminal.verdict_stage,
      evidenceResultSha: terminal.result_sha ?? null,
      max_revise: Number.isInteger(config.max_revise) ? config.max_revise : 3,
      authoritativeHead,
      // SHU-225: the first-review bootstrap, and ONLY for the issue the armed
      // activation is bound to. Any other card's lineage routes exactly as it did
      // before this change — a bootstrap is never board-wide.
      bootstrapReviewer: bootstrapByIssue.get(issueId) ?? null,
      fixtureLane: config.fixture_lane ?? null,
    });
    if (!routed.ok || !routed.order) {
      // PASS / no eligible reviewer / exhaustion / lane mismatch / forged — nothing to post.
      out(`backfill: ${issueId} attempt ${terminal.attempt_id} (${terminal.verdict_stage}) -> no post (${routed.reason ?? "no order"})${branchHeadUnverified ? " [branch head unverifiable]" : ""}`);
      continue;
    }
    if (existing.some((o) => o.attempt_id === routed.order.attempt_id)) {
      out(`backfill: ${issueId} attempt ${terminal.attempt_id} -> successor ${routed.order.attempt_id} ALREADY POSTED, skip`);
      continue;
    }
    if (!linearIssueId) {
      out(`backfill: ${issueId} attempt ${terminal.attempt_id} -> successor ${routed.order.attempt_id} (no linearIssueId — skipped)`);
      continue;
    }
    const body = renderWorkOrderDirective(routed.order);
    await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body }, linearToken, fetchImpl);
    out(`backfill: ${issueId} attempt ${terminal.attempt_id} -> POSTED ${routed.order.role} order (actor=${routed.order.actor ?? "coordinator-assigned"}, attempt=${routed.order.attempt_id})`);
  }
  return considered;
}

// A durable verdict may route only when it explains the terminal state that
// persisted it. Success/PASS belongs to COMPLETED; BLOCKED/FAILED belongs to
// HOLD. Infrastructure FAILED and every mismatched pair are non-routable.
export function terminalVerdictCoherent(terminal, verdictStage) {
  if (!terminal || !TERMINAL_STAGES.includes(terminal.stage)) return false;
  const verdict = outcomeForEvidenceStage(verdictStage);
  if (!verdict) return false;
  if (verdict.outcome === "BLOCKED" || verdict.outcome === "FAILED") return terminal.stage === "HOLD";
  return terminal.stage === "COMPLETED";
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

function printReport({ config, source, eligibility, selection, dispatchEnabled, activation = null }) {
  const lines = [];
  lines.push(`coordinator reconcile — ${dispatchEnabled ? "DISPATCH ENABLED" : "DRY-RUN (dispatch disabled, no writes)"}`);
  lines.push(`pilot_repo=${config.pilot_repo}  max_dispatch=${config.max_dispatch}  source=${source}`);
  const scope = resolveDispatchScope(config);
  lines.push(scope.configured
    ? `dispatch_scope=${scope.valid ? [...scope.issueIds].join(",") : `INVALID (${scope.reason})`}`
    : "dispatch_scope=board-wide");
  lines.push(renderActivationLine(activation));
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
export function reconcileOnce({ issues, openPRs, config, receipts = [], event = {}, episodeContinuations = new Map(), episodeScope = null, episodeIssueIds = new Set() }) {
  const eligibility = computeEligibility({ issues, openPRs, config });
  const selection = selectNextReservation({ ready: eligibility.ready, config, receipts, episodeContinuations, episodeScope, episodeIssueIds });
  return { eligibility, selection };
}

function issueReferencePattern(issueId) {
  return new RegExp(`\\b${String(issueId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

export function pullRequestClaimsIssue(pr, issueId) {
  const idPattern = issueReferencePattern(issueId);
  if (idPattern.test(String(pr?.head?.ref ?? ""))) return true;
  if (idPattern.test(String(pr?.title ?? ""))) return true;
  const escapedId = String(issueId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const closingReference = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?[ \\t]*(?:[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)?#?${escapedId}\\b`, "im");
  return closingReference.test(String(pr?.body ?? ""));
}

export function bindClaimingPullRequests(issues, openPRs) {
  for (const issue of issues ?? []) {
    const claims = (openPRs ?? [])
      .filter((pr) => pullRequestClaimsIssue(pr, issue.id))
      .map((pr) => ({ number: pr.number ?? null, state: "OPEN" }));
    if (claims.length) issue.linkedPRs = [...(issue.linkedPRs ?? []), ...claims];
  }
  return issues;
}

async function liveIssues({ config, linearToken, githubToken, openPRsOverride, fetchImpl = fetch }) {
  // Linear supplies work state and repo:<name> ownership. GitHub supplies active
  // PR claims. The query repository must never overwrite the card's ownership.
  const issues = await fetchLinearIssues({
    token: linearToken,
    repo: config.pilot_repo,
    team: config.team ?? "SHU",
    repoLabelMap: config.repo_label_map,
    fetchImpl,
  });
  let openPRs = [];
  let claimEvidenceError = null;
  if (Array.isArray(openPRsOverride)) {
    openPRs = openPRsOverride;
  } else if (!githubToken) {
    claimEvidenceError = "GITHUB_TOKEN is unavailable; open PR claims cannot be checked";
  } else {
    const res = await fetchImpl(`https://api.github.com/repos/${config.pilot_repo}/pulls?state=open&per_page=100`, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "User-Agent": "coordinator-dry-run" },
    });
    if (res.ok) {
      openPRs = await res.json();
      if (!Array.isArray(openPRs)) {
        claimEvidenceError = "GitHub open PR response was not an array";
        openPRs = [];
      }
    } else {
      claimEvidenceError = `GitHub open PR lookup failed with HTTP ${res.status}`;
    }
  }
  if (claimEvidenceError) {
    for (const issue of issues) issue.claimEvidenceError = claimEvidenceError;
  } else {
    bindClaimingPullRequests(issues, openPRs);
  }
  return { issues, openPRs };
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const config0 = loadConfig(io.configPath);
  const config = { ...config0, adapter_pause_map: { ...(config0.adapter_pause_map ?? {}) } };
  const dispatchScope = resolveDispatchScope(config);
  // SHU-63: an operator's --activation declaration is parsed here, but its STATUS is
  // computed after the durable receipts are read — the one-use binding needs them.
  const activationArg = parseActivationArgs(argv);
  const linearToken = env.LINEAR_API_TOKEN ?? "";
  const githubToken = env.GITHUB_TOKEN ?? "";
  const fetchImpl = io.fetchImpl ?? fetch;
  // Offline coordinator tests already opt out of the live activation contract;
  // let those tests inject a known-empty PR set without weakening live runs.
  const openPRsOverride = io.openPRsOverride ?? (io.skipActivationPreflight === true ? [] : undefined);

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
    ({ issues, openPRs } = await liveIssues({ config, linearToken, githubToken, openPRsOverride, fetchImpl }));
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

  // A receipt may arrive through more than one input seam (or be copied into a
  // second comment thread). Resolve globally by immutable attempt_id before any
  // lifecycle action so one reconcile can never poll or retry the same attempt
  // twice. Newest last_activity wins; ties keep the first observed record.
  const receiptByAttempt = new Map();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.attempt_id !== "string") continue;
    const previous = receiptByAttempt.get(receipt.attempt_id);
    if (
      previous &&
      RECEIPT_IMMUTABLE_FIELDS.some((field) => !immutableFieldEqual(previous, receipt, field))
    ) {
      durableReadFailed = true;
      if (io.stdout) io.stdout(`durable receipt conflict for attempt ${receipt.attempt_id} — immutable fields disagree; DISPATCH PREVENTED (fail closed)`);
      continue;
    }
    if (!previous || String(receipt.last_activity ?? "") > String(previous.last_activity ?? "")) {
      receiptByAttempt.set(receipt.attempt_id, receipt);
    }
  }
  receipts = [...receiptByAttempt.values()];

  // ---- SHU-63 SINGLE-RUN ACTIVATION ------------------------------------------
  // Computed here, after the durable receipts are final and immediately before the
  // lifecycle/dispatch decision it gates, because "one use" is defined against the
  // bound target's receipt history. A REFUSED activation is not a dry run: it is
  // reported and exits 2 with zero writes (see the PREVENTED branch below), so an
  // expired, replayed or mis-bound authorization can never be mistaken for a
  // quiet, disabled coordinator.
  let singleRunActivation = activationArg.error
    ? { requested: true, state: "refused", valid: false, reason: activationArg.error, target_issue_id: null, activation_id: null, expires_at: null }
    : singleRunActivationStatus({
        filePath: activationArg.path,
        config,
        receipts,
        now: io.now ? io.now() : new Date(),
        dir: __dirname,
        gitHead: io.gitHead,
        initialTargetSha: env.DISPATCH_TARGET_SHA,
        io,
      });
  // SHU-231: the episode boundary derived from the trusted record. It is non-null
  // only when the record actually names an episode, and it is APPLIED only where
  // an armed episode is in force (spend below; parking once armed) — so an absent,
  // spent or refused activation leaves every decision global and unchanged.
  const activationEpisodeScope = episodeScopeFor({
    activation_id: singleRunActivation.activation_id ?? null,
    supersedes_attempt_ids: singleRunActivation.supersedes_attempt_ids,
  });
  let dispatchEnabled = dispatchEnabledFor(env, config, singleRunActivation);

  // A pure activation-status pass cannot fetch GitHub, so its successor is only a
  // candidate. Before that candidate can re-enter selection, re-derive it from the
  // same durable terminal using the LIVE branch head. This is the launch boundary:
  // a head the coordinator cannot read, or evidence that disagrees with it, refuses
  // the activation and can never fall through to another card.
  if (
    dispatchEnabled &&
    singleRunActivation.state === "armed" &&
    singleRunActivation.target_issue_id &&
    singleRunActivation.successor &&
    githubToken &&
    !receipts.some((r) =>
      r &&
      r.issue_id === singleRunActivation.target_issue_id &&
      !TERMINAL_STAGES.includes(r.stage)
    )
  ) {
    const targetReceipts = receipts.filter((r) => r && r.issue_id === singleRunActivation.target_issue_id);
    const terminal = latestCoherentTerminal(targetReceipts);
    const live = terminal
      ? await resolveLiveHead(terminal, { githubToken, fetchImpl })
      : { verified: false, head: null };
    if (!live.verified) {
      singleRunActivation = {
        ...singleRunActivation,
        state: "refused",
        valid: false,
        reason: "activation successor live branch head could not be verified — HOLD, fail closed",
        successor: null,
      };
    } else {
      const verifiedEpisode = episodeVerdict({
        receipts,
        targetIssueId: singleRunActivation.target_issue_id,
        config,
        bootstrapReviewer: singleRunActivation.reviewer_lane ? { lane: singleRunActivation.reviewer_lane } : null,
        episodeScope: activationEpisodeScope,
        authoritativeHead: live.head,
      });
      if (verifiedEpisode.ended) {
        singleRunActivation = {
          ...singleRunActivation,
          state: "refused",
          valid: false,
          reason: `activation is spent: the episode for ${singleRunActivation.target_issue_id} ended — ${verifiedEpisode.reason}`,
          successor: null,
        };
      } else {
        singleRunActivation = {
          ...singleRunActivation,
          episode: verifiedEpisode.reason,
          successor: verifiedEpisode.successor ?? null,
        };
      }
    }
  }
  // The authoritative-head pass may have changed ARMED -> REFUSED. Recompute
  // before lifecycle so a refused activation cannot poll, persist, or launch.
  dispatchEnabled = dispatchEnabledFor(env, config, singleRunActivation);

  // A worker and snapshot may outlast the approval. The host broker checks
  // this authority again before snapshotting and before publishing a result.
  const resultStillAuthorized = (issueId) => {
    const current = singleRunActivation.requested
      ? singleRunActivationStatus({ filePath: activationArg.path, config, receipts,
        dir: __dirname, now: io.now?.() ?? new Date(), gitHead: io.gitHead,
        initialTargetSha: env.DISPATCH_TARGET_SHA, io }) : singleRunActivation;
    return dispatchEnabledFor(env, config, current) && activationAllowsTarget(current, issueId);
  };

  // ---- SHU-225: EPISODE-SCOPED CONTINUATION ---------------------------------
  // An ARMED episode whose routing has named a successor may re-admit that ONE
  // issue (the activation's bound target) to selection for the next step. Two maps
  // are derived here, from the trusted record plus the durable receipts only:
  //
  //   episodeContinuations  -> the successor that re-admits the parked issue
  //   episodeBootstrap      -> the record's reviewer lane, for the FIRST review
  //                            only, and only for the bound target
  //
  // Both are empty unless dispatch is enabled (i.e. an armed activation or the
  // committed switch) and the episode is unfinished, so a spent episode, a
  // refused activation and the disabled default all leave parking byte-for-byte
  // unchanged. Neither map can widen the run: the successor is the SAME issue as
  // the committed dispatch_scope and the activation target, and every guard in
  // selection + the pre-claim recheck still applies to it.
  const episodeContinuations = new Map();
  const episodeBootstrap = new Map();
  // SHU-231: an ARMED episode admits its own bound issue to selection through the
  // existing seam, so a fresh episode can take its FIRST step without inventing a
  // successor it cannot have yet. Populated only while genuinely armed: a spent,
  // refused or absent activation contributes nothing here.
  const episodeIssueIds = new Set();
  let episodeScope = null;
  if (dispatchEnabled && singleRunActivation.state === "armed" && singleRunActivation.target_issue_id) {
    episodeScope = activationEpisodeScope;
    // ...but ONLY for the episode's FIRST step. Once this episode owns any receipt,
    // the routed successor is the sole way forward (SHU-225): admitting it
    // unconditionally would let a mid-episode availability hold (no eligible
    // reviewer, no active writer) re-dispatch the episode's first step forever.
    const episodeHasStarted = receipts.some(
      (r) => r && r.issue_id === singleRunActivation.target_issue_id && receiptInEpisodeScope(r, episodeScope),
    );
    if (!episodeHasStarted) episodeIssueIds.add(singleRunActivation.target_issue_id);
    if (singleRunActivation.reviewer_lane) {
      episodeBootstrap.set(singleRunActivation.target_issue_id, { lane: singleRunActivation.reviewer_lane });
    }
    if (singleRunActivation.successor) {
      episodeContinuations.set(singleRunActivation.target_issue_id, {
        successor: singleRunActivation.successor,
        activation_id: singleRunActivation.activation_id,
      });
    }
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

  let lifecyclePersisted = false; // a lifecycle transition was durably written this run
  // GPT BLOCK #1: lifecycle polling/mutation is part of DISPATCH. Disabled means
  // compute/report only and ZERO writes — never poll upstream or persist receipts
  // while both dispatch gates are false.
  // durableReadFailed also gates the LIFECYCLE block, not just dispatch: a
  // corrupt or self-contradicting durable read must never drive a transition
  // either (PR #24).
  if (dispatchEnabled && dispatchScope.valid && !durableReadFailed && linearToken && io.pollRuns !== false) {
    // Reconcile uncertain launches before polling acknowledged runs. A transport
    // failure after POST may mean the upstream accepted the run but the response
    // was lost. Retrying the SAME attempt uses the SAME Idempotency-Key, so it can
    // recover the documented run id without double-launching. Leaving these
    // receipts untouched forever would permanently consume max_dispatch.
    const lifecycleStartReceipts = receiptsForLifecycle(receipts, config);
    for (const receipt of lifecycleStartReceipts.filter((r) => r.stage === "LAUNCH_UNKNOWN")) {
      const adapter = adapterNameFor(receipt.requested_worker);
      // A paused adapter must not be re-entered through RECOVERY either — the
      // pause exists so the next slot does not auto-launch a doomed attempt
      // (PR #24).
      if (config.adapter_pause_map[adapter]) continue;
      // Credential gate is PER ADAPTER (CodeRabbit, PR #22). Applied before
      // adapter routing it meant a hermes-box attempt — whose adapter never
      // touches these credentials — could never be recovered.
      if (adapter === "workspace-agents" && (!(env.WORKSPACE_AGENT_ACCESS_TOKEN ?? "") || !(env.WORKSPACE_AGENT_TRIGGER_ID ?? ""))) {
        if (io.stdout) io.stdout(`lifecycle: launch reconciliation for ${receipt.issue_id} SKIPPED — Workspace Agents credentials unavailable; slot held`);
        continue;
      }
      const adapterModule = await loadAdapterModule(adapter, io);
      const conflicting = receipts.find(
        (other) =>
          other.issue_id === receipt.issue_id &&
          other.attempt_id !== receipt.attempt_id &&
          !TERMINAL_STAGES.includes(other.stage),
      );
      if (conflicting) {
        if (io.stdout) io.stdout(`lifecycle: launch reconciliation for ${receipt.issue_id} SKIPPED — conflicting active attempt ${conflicting.attempt_id}; slot held`);
        continue;
      }
      const linearIssueId = resolveLinearIssueId(receipt, "launch reconciliation");
      if (!linearIssueId) continue;

      // Recovery is a worker launch too. Rechecking only first dispatch lets a
      // later coordinator with missing credentials, wrong host, or ephemeral
      // state resume an existing Codex session around the activation contract.
      const activation = activationPreflightFor(adapter, { env, io, cwd: env.CODEX_WORKTREE_PATH ?? undefined });
      if (activation && !activation.ok) {
        if (io.stdout) io.stdout(`lifecycle: launch reconciliation for ${receipt.issue_id} SKIPPED — activation contract unmet for ${adapter}: ${describeUnmetActivation(activation.unmet)}`);
        config.adapter_pause_map[adapter] = true;
        await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
        continue;
      }
      const activationTarget = activation ? await verifyActivationTarget(adapter, {
        repo: receipt.repo,
        target_sha: receipt.target_sha,
        githubToken,
        fetchImpl,
      }) : { ok: true };
      if (!activationTarget.ok) {
        if (io.stdout) io.stdout(`lifecycle: launch reconciliation for ${receipt.issue_id} SKIPPED — activation GitHub probe failed for ${adapter}: ${activationTarget.reason}`);
        config.adapter_pause_map[adapter] = true;
        await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
        continue;
      }

      let launch;
      try {
        const options = await preparedLaunchOptions(adapter, receipt, env, io, { resume: true });
        launch = await adapterModule.launchBuilder({
          recovery: true, // host-local authorization required by Hermes recovery
          external_run_id: receipt.external_run_id ?? null, // codex-cli exact-id resume target (codexrun_<uuid>)
          repo: receipt.repo,
          branch: receipt.branch,
          issue_id: receipt.issue_id,
          authorization_ref: receipt.authorization_ref,
          attempt_id: receipt.attempt_id,
          target_sha: receipt.target_sha,
          task_context: `Authorized contract ref ${receipt.authorization_ref}; deterministic dispatch pilot; issue ${receipt.issue_id} on ${receipt.branch} @ ${receipt.target_sha}`,
          ...options,
          fetchImpl,
          io: { ...io, resultStillAuthorized: () => resultStillAuthorized(receipt.issue_id) },
          env,
        });
      } catch (err) {
        if (io.stdout) io.stdout(`lifecycle: launch reconciliation failed for ${receipt.issue_id}: ${err.message} — state unchanged, slot held`);
        continue;
      }
      if (launch.stage === "LAUNCH_UNKNOWN" && !(typeof launch.external_run_id === "string" && launch.external_run_id.length)) continue;

      // STALE-HEAD GUARD, same rule as the dispatch path. A synchronous adapter
      // can return a terminal COMPLETED straight from launchBuilder during
      // recovery too, which never passes through the poll where the live head is
      // normally resolved. Leaving it out here let a stale verdict complete a
      // superseded SHA (CodeRabbit, 8b73ebe).
      let recoveryCtx = {};
      if (launch.stage === "COMPLETED") {
        const resolved = await resolveLiveHead(receipt, { githubToken, fetchImpl });
        if (!resolved.verified) {
          launch = { ...launch, stage: "HOLD", callback: undefined, reason: "live head could not be verified — HOLD" };
        } else {
          // A builder starts at target_sha and is expected to move its work
          // branch. Its callback binds the resulting commit separately; using
          // target_sha here would reject every successful builder as stale.
          const expectedHead = receipt.requested_worker === "codex-builder"
            ? launch.callback?.result_sha
            : receipt.target_sha;
          recoveryCtx = {
            current_head: resolved.head,
            expected_head: expectedHead,
            // Fold-time author exclusion (SHU-73): the lineage lets the fold
            // reject a review verdict whose observed session is a lineage author.
            lineage: (receipts ?? []).filter((r) => r && r.issue_id === receipt.issue_id),
          };
        }
      }
      const transition = foldLaunchOutcome(receipt, launch, { ...recoveryCtx, now: io.now });
      if (!transition.accepted) continue;
      const nextReceipt = transition.receipt;
      if (launch.conversation_url && typeof launch.conversation_url === "string") {
        nextReceipt.notes = [...nextReceipt.notes, `conversation_url: ${launch.conversation_url}`];
      }
      await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(nextReceipt) }, linearToken, fetchImpl);
      lifecyclePersisted = true;
      if (transition.pause_adapter === true || launch.pause_adapter === true) {
        config.adapter_pause_map[adapter] = true;
        await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
      }
      const idx = receipts.indexOf(receipt);
      if (idx >= 0) receipts[idx] = nextReceipt;
      if (io.stdout) io.stdout(`lifecycle: ${receipt.issue_id} LAUNCH_UNKNOWN -> ${nextReceipt.stage} using the same attempt/idempotency key`);
    }

    for (const receipt of lifecycleStartReceipts.filter((r) => r.stage === "RUNNING" && typeof r.external_run_id === "string" && r.external_run_id.length)) {
      const adapter = adapterNameFor(receipt.requested_worker);
      const adapterModule = await loadAdapterModule(adapter, io);
      // Callback evidence from the durable issue thread (same attempt_id bound);
      // selection is deterministic by newest createdAt (GPT BLOCK #2).
      const evidence = parseEvidenceFromComments(
        commentsByIssue.get(receipt.issue_id) ?? [],
        receipt.attempt_id,
        config.linear_callback_actor_ids,
      ) ?? undefined;
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
        // ONE resolution per receipt. Resolving again here dropped `io`, so the
        // injection seam was bypassed and monitoring could run a different
        // implementation than the launch did (CodeRabbit, 8b73ebe).
        outcome = await adapterModule.monitorRun({
          run_id: receipt.external_run_id,
          attempt_id: receipt.attempt_id,
          target_sha: receipt.target_sha,
          evidence,
          current_head: headVerified ? current_head : undefined,
          ...adapterLaunchOptions(adapter, env),
          fetchImpl,
          io, // hermes-pool lease reads (SHU-62); ignored by workspace-agents
          env,
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
            callback: { links: outcome.evidence_links ?? [], attempt_id: receipt.attempt_id, target_sha: receipt.target_sha, stage: evidence?.stage ?? null, result_sha: evidence?.result_sha ?? null },
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
      const transition = nextReceiptState(receipt, event, {
        now: io.now,
        current_head,
        // A write attempt is expected to move its branch. Bind its callback to
        // the resulting head, while reviews remain bound to their input head.
        expected_head: !githubToken || roleForRequestedWorker(receipt.requested_worker) === "review"
          ? receipt.target_sha
          : evidence?.result_sha,
        // Fold-time author exclusion (SHU-73): the lineage lets the fold reject
        // a review verdict whose observed session is a lineage author.
        lineage: (receipts ?? []).filter((r) => r && r.issue_id === receipt.issue_id),
      });
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
        config.adapter_pause_map[adapter] = true;
        await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
      }
      const idx = receipts.indexOf(receipt);
      if (idx >= 0) receipts[idx] = nextReceipt;
      if (io.stdout) io.stdout(`lifecycle: ${receipt.issue_id} ${receipt.stage} -> ${nextReceipt.stage} (worker_identity=${nextReceipt.worker_identity ?? "null"}, external_run_id=${nextReceipt.external_run_id ?? "null"})`);
    }
  }

  const { eligibility, selection } = reconcileOnce({ issues, openPRs, config, receipts, episodeContinuations, episodeScope, episodeIssueIds });
  const report = printReport({ config, source, eligibility, selection, dispatchEnabled, activation: singleRunActivation });

  if (singleRunActivation.requested && singleRunActivation.state === "refused") {
    // An activation was supplied and every binding failed closed. This is NOT a
    // dry run: report it, refuse loudly, and write nothing.
    const out = io.stdout ?? ((s) => console.log(s));
    out(report);
    out(`dispatch: PREVENTED — single-run activation REFUSED (${singleRunActivation.reason}); no fallback, no writes`);
    return 2;
  }
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
  if (!dispatchScope.valid) {
    if (io.stdout) io.stdout(`dispatch: PREVENTED — invalid trusted dispatch_scope (${dispatchScope.reason}); no fallback`);
    return 2;
  }
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

  // ---- SHU-68 replay/backfill (Codex BLOCK #2, resolved): ----
  // Successor-directive publication is derived from the DURABLE receipt verdict
  // facts, computed idempotently from the deterministic successor attempt id new
  // each reconcile, and posted only if no post for that successor attempt already
  // exists on the card. This is what makes a crash after the terminal persist
  // (but before the directive) self-healing: the next reconcile re-derives the
  // same successor attempt and posts it exactly once. It runs only on a tick
  // where no lifecycle transition was persisted, before new dispatch, so a
  // directive is never raced by a fresh launch of the same successor.
  if (io.stdout) io.stdout(`dispatch: backfill successor directives from durable terminal receipts`);
  const backfilled = await backfillSuccessorDirectives({
    receipts,
    commentsByIssue,
    dispatchEnabled,
    linearToken,
    githubToken,
    linearIdFor,
    config,
    env,
    fetchImpl,
    stdout: io.stdout,
    bootstrapByIssue: episodeBootstrap,
  });
  if (io.stdout) io.stdout(`dispatch: backfill complete — ${backfilled} directive(s) considered`);
  let { candidate } = selection;
  const { skipped } = selection;
  if (!candidate) {
    if (io.stdout) io.stdout(`dispatch: no reservation — ${skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")}`);
    return 0;
  }

  // The initial read can become stale while lifecycle/backfill work runs. Re-read
  // Linear claims, repository labels, blockers, verifier assignment and GitHub
  // PR claims immediately before the reservation comment becomes the claim.
  // Any lookup failure or eligibility change aborts with zero reservation write.
  if (linearToken) {
    let refreshed;
    try {
      refreshed = await liveIssues({ config, linearToken, githubToken, openPRsOverride, fetchImpl });
    } catch (error) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — authoritative eligibility recheck failed: ${error.message}`);
      return 2;
    }
    const refreshedIssue = refreshed.issues.find((issue) => issue.id === candidate.id);
    if (!refreshedIssue) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — ${candidate.id} disappeared from the authoritative Linear result`);
      return 2;
    }
    if (!dispatchScopeAllows(dispatchScope, refreshedIssue.id)) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — ${refreshedIssue.id} is outside trusted dispatch_scope`);
      return 2;
    }
    if (!activationAllowsTarget(singleRunActivation, refreshedIssue.id)) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — ${refreshedIssue.id} is not the activated target`);
      return 2;
    }
    const refreshedEligibility = computeEligibility({ issues: [refreshedIssue], openPRs: refreshed.openPRs, config });
    if (refreshedEligibility.ready.length !== 1) {
      const reason = refreshedEligibility.excluded[0]?.reason ?? "candidate is no longer eligible";
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — ${candidate.id}: ${reason}`);
      return 2;
    }
    candidate = refreshedEligibility.ready[0];
    let refreshedComments;
    try {
      refreshedComments = await fetchIssueComments({ issueId: candidate.linearId ?? candidate.id, token: linearToken, fetchImpl });
    } catch (error) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — active receipt lookup failed for ${candidate.id}: ${error.message}`);
      return 2;
    }
    const activeClaim = parseReceiptsFromComments(refreshedComments)
      .find((receipt) => receipt.issue_id === candidate.id && !TERMINAL_STAGES.includes(receipt.stage));
    if (activeClaim) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before claim — ${candidate.id} already has active receipt ${activeClaim.attempt_id} (${activeClaim.stage})`);
      return 2;
    }
  }
  const authorization_ref = resolveAuthorizationRef(candidate, config);
  if (!authorization_ref) {
    throw new Error(`dispatch refused: no contract-bound authorization_ref for ${candidate.id} (free text and unapproved fixture ids are rejected)`);
  }
  const repo = candidate.repo ?? config.pilot_repo;
  const branch = candidate.branch ?? env.DISPATCH_BRANCH ?? `coordinator/${candidate.id}`;
  // SHU-225: when this selection is the ARMED episode's routed successor, the claim
  // carries the successor's own lane, bound head and deterministic attempt id. This
  // is the ONLY place a successor is turned into work — there is no second
  // dispatcher — so everything below (the RESERVED receipt, the durable re-read,
  // the launch-intent write, the pre-claim recheck above) applies unchanged.
  const successor = selection.successor ?? null;
  const requested_worker = successor?.requested_worker ?? candidate.requested_worker;
  const target_sha = successor?.target_sha ?? candidate.target_sha ?? env.DISPATCH_TARGET_SHA ?? null;
  let workspaceScope;
  try {
    workspaceScope = successor
      ? { workspace_scope: successor.workspace_scope, scope_phase: successor.scope_phase, allowed_paths: successor.allowed_paths, scoped_base_sha: successor.scoped_base_sha ?? null }
      : initialWorkspaceScope({ issueId: candidate.id, requestedWorker: requested_worker, fixtureLane: config.fixture_lane });
    const scopeCheck = validateWorkspaceScope(workspaceScope);
    if (!scopeCheck.ok) throw new Error(scopeCheck.reason);
  } catch (error) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before reservation — workspace scope refused (${error.message})`);
    return 2;
  }
  if (!successor && singleRunActivation.initial_target_sha && target_sha !== singleRunActivation.initial_target_sha) {
    if (io.stdout) io.stdout("dispatch: initial target differs from the activation — refused before reservation");
    return 2;
  }
  if (!target_sha || !TARGET_SHA_RE.test(target_sha)) {
    throw new Error(`dispatch refused: no bound head for ${candidate.id} — target_sha is required (old PASS must never satisfy a changed head)`);
  }
  const adapter = adapterNameFor(requested_worker);
  if (successor) {
    if (io.stdout) {
      io.stdout(`dispatch: episode successor — ${successor.role} via ${requested_worker} (attempt ${successor.attempt_id}, head ${target_sha}) under the armed activation`);
    }
    // Recheck at the write boundary, not merely while deriving selection. Linear
    // refresh/backfill can take long enough for the branch to move after the first
    // read. A successor is never RESERVED unless its bound head is still live.
    if (githubToken) {
      const live = await resolveLiveHead({ repo, branch, target_sha }, { githubToken, fetchImpl });
      if (!live.verified || live.head !== target_sha) {
        if (io.stdout) {
          io.stdout(`dispatch: ABORTED before reservation — successor head ${target_sha} is not the verified live branch head ${live.head ?? "<unreadable>"}`);
        }
        return 2;
      }
    }
  }
  const linearIssueId = candidate.linearId ?? candidate.id; // UUID for the real API, identifier tolerated by mocks

  // Activation is checked before minting and persisting a reservation. A
  // refused preflight sent no launch, and RESERVED receipts are not processed
  // by launch recovery; writing one here would consume the slot permanently
  // even after the operator repaired the missing wiring.
  const activation = activationPreflightFor(adapter, { env, io, cwd: env.CODEX_WORKTREE_PATH ?? undefined });
  if (activation && !activation.ok) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before reservation — SHU-63 activation contract unmet for ${adapter}: ${describeUnmetActivation(activation.unmet)}`);
    config.adapter_pause_map[adapter] = true;
    await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
    return 2;
  }
  const activationTarget = activation
    ? await verifyActivationTarget(adapter, { repo, target_sha, githubToken, fetchImpl })
    : { ok: true };
  if (!activationTarget.ok) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before reservation — activation GitHub probe failed for ${adapter}: ${activationTarget.reason}`);
    config.adapter_pause_map[adapter] = true;
    await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: `coordinator-pause: ${adapter}` }, linearToken, fetchImpl).catch(() => undefined);
    return 2;
  }
  if (workspaceScope.workspace_scope === "scoped") {
    try {
      const derive = io.deriveScopedBaseSha ?? deriveScopedBaseShaFromRemote;
      workspaceScope.scoped_base_sha = await derive({ target_sha, allowed_paths: workspaceScope.allowed_paths,
        remoteUrl: env.SHU_PUSH_REMOTE_URL, allowedRepo: repo, allowedHost: env.SHU_PUSH_ALLOWED_HOST ?? "github.com", env });
      const boundScope = validateWorkspaceScope(workspaceScope, { requireScopedBase: true });
      if (!boundScope.ok) throw new Error(boundScope.reason);
    } catch (error) {
      if (io.stdout) io.stdout(`dispatch: ABORTED before reservation — scoped base derivation refused (${error.message})`);
      return 2;
    }
  }

  const { ok: reservedOk, receipt, errors } = createReceipt({
    reserved_at: nowIso(io.now?.()),
    issue_id: candidate.id,
    authorization_ref,
    requested_worker,
    repo,
    branch,
    target_sha,
    ...workspaceScope,
    // SHU-231: stamp the episode on every receipt the coordinator writes. Null when
    // no episode is armed, so the disabled/global path is unchanged.
    episode_id: episodeScope?.episode_id ?? null,
    // SHU-225 I7 (idempotency): a successor's attempt id is DERIVED from its
    // predecessor (freshAttempt over the predecessor attempt + role + round), not
    // minted fresh. A restart at any boundary therefore re-derives the SAME
    // attempt — and the reservation below is written once — instead of minting a
    // second successor for the same step. A first dispatch keeps randomUUID().
    ...(successor?.attempt_id ? { attempt_id: successor.attempt_id } : {}),
  });
  if (!reservedOk) {
    throw new Error(`dispatch refused: reservation invalid — ${errors.join("; ")}`);
  }
  // Persist RESERVED *before* anything reaches the adapter (reserve precedes launch).
  await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(receipt) }, linearToken, fetchImpl);

  // GPT review #3: RE-READ and validate the authoritative reservation before
  // launching. A missing, failed, or colliding reservation must never authorize
  // a worker — launch only when this attempt's RESERVED receipt is durably
  // present AND no other active receipt owns the issue.
  const verifyComments = await fetchIssueComments({ issueId: linearIssueId, token: linearToken, fetchImpl });
  const durable = parseReceiptsFromComments(verifyComments);
  const ownReservation = durable.find((r) => r.attempt_id === receipt.attempt_id && r.stage === "RESERVED");
  const otherActive = durable.find((r) => r.attempt_id !== receipt.attempt_id && !TERMINAL_STAGES.includes(r.stage));
  // Same immutable-field rule as the initial read: a record wearing THIS
  // attempt_id but disagreeing on repo/branch/target_sha was not written by this
  // run. A check that only the initial read applies is a TOCTOU hole — the
  // forgery window is exactly between that read and this one.
  const impostor = durable.find(
    (r) => r.attempt_id === receipt.attempt_id && RECEIPT_IMMUTABLE_FIELDS.some((f) => !immutableFieldEqual(r, receipt, f)),
  );
  if (impostor) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before launch — durable receipt conflict for attempt ${receipt.attempt_id}, immutable fields disagree; slot held`);
    return 2;
  }
  if (!ownReservation) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before launch — reservation ${receipt.attempt_id} not durably present after write; slot held`);
    return 2;
  }
  if (otherActive) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before launch — conflicting active receipt ${otherActive.attempt_id} (${otherActive.stage}) owns ${candidate.id}; slot held`);
    return 2;
  }

  // Write-ahead launch intent: persist LAUNCH_UNKNOWN only after activation is
  // known-good and before crossing the adapter boundary. A refused preflight did
  // not send a launch, so recording LAUNCH_UNKNOWN there would be false history.
  const launchIntent = nextReceiptState(receipt, { type: "launch" }, { now: io.now });
  if (!launchIntent.accepted) {
    if (io.stdout) io.stdout(`dispatch: ABORTED before launch — could not persist launch intent for ${candidate.id}`);
    return 2;
  }
  await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(launchIntent.receipt) }, linearToken, fetchImpl);

  const dispatchAdapterModule = await loadAdapterModule(adapter, io);
  let launch;
  let options;
  try {
    options = await preparedLaunchOptions(adapter, receipt, env, io);
    // Fetching/cloning can outlast the approval. Recheck before crossing into
    // the worker; preparation does not extend an activation's lifetime.
    if (singleRunActivation.requested) {
      const currentActivation = singleRunActivationStatus({ filePath: activationArg.path, config,
        receipts, dir: __dirname, now: io.now?.() ?? new Date(), gitHead: io.gitHead, initialTargetSha: env.DISPATCH_TARGET_SHA, io });
      if (currentActivation.state !== "armed" || !activationAllowsTarget(currentActivation, receipt.issue_id)) throw new Error("activation no longer allows this launch");
    }
  } catch (error) {
    const diagnosis = workspaceFailureCode(error);
    const held = nextReceiptState(launchIntent.receipt, { type: "hold",
      reason: `attempt workspace preparation or final activation check refused (${diagnosis}); no worker launched` }, { now: io.now });
    await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(held.receipt) }, linearToken, fetchImpl);
    if (io.stdout) io.stdout(`dispatch: ${candidate.id} HOLD before worker launch — workspace preparation or final activation check refused (${diagnosis})`);
    return 2;
  }
  if (!launch) {
    launch = await dispatchAdapterModule.launchBuilder({
    // Reservation binding (PR #24): the host-local lease records repo/branch so
    // recovery can prove a Linear receipt matches a reservation this coordinator
    // actually made. Without these the lease is created unbound and strict
    // binding can never be satisfied afterwards.
    repo: receipt.repo,
    branch: receipt.branch,
    issue_id: receipt.issue_id,
    authorization_ref: receipt.authorization_ref,
    attempt_id: receipt.attempt_id,
    target_sha: receipt.target_sha,
    workspace_scope: receipt.workspace_scope,
    scope_phase: receipt.scope_phase,
    allowed_paths: [...receipt.allowed_paths],
    scoped_base_sha: receipt.scoped_base_sha,
    task_context: `Authorized contract ref ${receipt.authorization_ref}; deterministic dispatch pilot; issue ${receipt.issue_id} on ${receipt.branch} @ ${receipt.target_sha}`,
    ...options,
    fetchImpl,
    io: { ...io, resultStillAuthorized: () => resultStillAuthorized(receipt.issue_id) },
    env,
    });
  }
  // Drive the state machine IN ORDER: the launch event first (RESERVED ->
  // LAUNCH_UNKNOWN, launch timestamp set), THEN fold the adapter outcome on top
  // (ack -> RUNNING / stays LAUNCH_UNKNOWN / upstream failure). A worker ack
  // straight from RESERVED is out of order by design — launch always precedes it.
  // STALE-HEAD GUARD on the synchronous path. A `claude -p` verification can run
  // for half an hour and returns its terminal result straight from launchBuilder,
  // bypassing the lifecycle poll where the live head is normally resolved. Apply
  // the SAME tri-state rule here, or a verdict describing a superseded tree would
  // satisfy a receipt bound to target_sha.
  let launchCtx = {};
  if (launch.stage === "COMPLETED") {
    const resolved = await resolveLiveHead(receipt, { githubToken, fetchImpl });
    if (!resolved.verified) {
      launch = { ...launch, stage: "HOLD", callback: undefined, reason: "live head could not be verified — HOLD" };
    } else {
      const expectedHead = receipt.requested_worker === "codex-builder"
        ? launch.callback?.result_sha
        : receipt.target_sha;
      launchCtx = {
        current_head: resolved.head,
        expected_head: expectedHead,
        // Fold-time author exclusion (SHU-73): lineage receipts for this issue.
        lineage: (receipts ?? []).filter((r) => r && r.issue_id === receipt.issue_id),
      };
    }
  }
  const transition = foldLaunchOutcome(launchIntent.receipt, launch, { ...launchCtx, now: io.now });
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
  return next.stage === "RUNNING" || next.stage === "LAUNCH_UNKNOWN" || next.stage === "COMPLETED" ? 0 : 2;
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
