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
// WHY "ONE USE" IS ONE EPISODE, NOT ONE CLAIM
//
// The approved run contract is build → exact-head BLOCK → return to the writer →
// same-branch revision → automatic re-review → PASS. A revision is a later
// dispatch on the same target under the same authorization, so a rule of "one
// claim ever" would stall the loop it exists to authorize. One use therefore
// means one EPISODE for the bound target: from the first claim until that target
// parks or completes. Attempts inside the episode remain bounded exactly as they
// already were (max_failed_attempts, max_dispatch=1). Once the episode ends, the
// activation can never authorize anything again.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

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

export const ACTIVATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const LINEAR_ISSUE_ID_RE = /^SHU-[0-9]+$/;
export const REVISION_RE = /^[0-9a-f]{40}$/;
export const AUTHORIZATION_REF_RE = /^(SHU-[0-9]+|FIXTURE-[A-Z0-9-]+)$/;

// An expiry that reaches further than a day is not an expiry, it is a permanence.
export const MAX_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Receipt stages that mean "this target's episode is over". FAILED is deliberately
// absent: it is the retryable terminal, and the revision loop depends on it.
export const SPENT_RECEIPT_STAGES = Object.freeze(["COMPLETED", "HOLD"]);

// Permission shape accepted for the activation file: no group/world write, and no
// world access at all. 0600 (operator only) and 0640 (operator + coordinator group)
// both pass; 0660, 0644, 0604 and 0777 all fail. Ownership is not asserted because
// the record is a capability declaration, not a secret — what matters is that no
// other account can edit or read it.
const FORBIDDEN_MODE_BITS = 0o022 | 0o007;

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
    const out = execFileSync("git", ["-c", `safe.directory=${dir}`, "-C", dir, "rev-parse", "HEAD"], {
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

function refused(reason) {
  return { requested: true, state: "refused", valid: false, reason, target_issue_id: null, activation_id: null, expires_at: null };
}

function readActivationText(filePath, io = {}) {
  const lstat = io.lstat ?? ((p) => fs.lstatSync(p));
  let stat;
  try {
    stat = lstat(filePath);
  } catch (err) {
    return { ok: false, reason: `activation file does not exist or cannot be read (${err?.code ?? err?.message ?? "error"})` };
  }
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
  const expected = [...SINGLE_RUN_ACTIVATION_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    return { ok: false, reason: `activation must contain exactly ${expected.join(", ")} (got ${keys.join(", ") || "none"})` };
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
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

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
  io = {},
} = {}) {
  if (!filePath) return { requested: false, state: "absent", valid: true, reason: null, target_issue_id: null, activation_id: null, expires_at: null };

  // (1) Target binding — must be the single committed dispatch_scope issue.
  const scopeIds = config?.dispatch_scope?.issue_ids;
  if (!Array.isArray(scopeIds) || scopeIds.length !== 1) {
    return refused("a single-run activation requires a committed single-issue dispatch_scope; this configuration is board-wide");
  }
  const [scopeIssue] = scopeIds;
  const fixtureLane = config?.fixture_lane ?? {};
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

  // (3) The activation must name the scoped target and, where the lane carries an
  //     approved contract reference, the same contract reference.
  if (record.target_issue_id !== scopeIssue) {
    return refused(`activation target ${record.target_issue_id} is not the scoped issue ${scopeIssue}`);
  }
  if (fixtureLane.authorization_ref && record.authorization_ref !== fixtureLane.authorization_ref) {
    return refused(`activation authorization_ref ${record.authorization_ref} is not the lane contract ${fixtureLane.authorization_ref}`);
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
  if (expiry <= at) return refused(`activation expired at ${record.expires_at}`);
  if (expiry - at > MAX_ACTIVATION_WINDOW_MS) {
    return refused(`activation expiry is more than ${MAX_ACTIVATION_WINDOW_MS / 3600000}h away — the window is not bounded`);
  }

  // (7) One use — spent once the bound target's episode has ended.
  const spent = (Array.isArray(receipts) ? receipts : []).filter(
    (r) => r && r.issue_id === record.target_issue_id && SPENT_RECEIPT_STAGES.includes(r.stage),
  );
  if (spent.length > 0) {
    return refused(`activation is spent: ${record.target_issue_id} already has a ${spent[0].stage} receipt`);
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
  };
}

// The belt-and-braces check at claim time: the issue about to be claimed must be
// the activated target. The committed scope already guarantees this; this exists so
// that a future change to selection logic cannot quietly dispatch something else
// under a live activation.
export function activationAllowsTarget(activation, issueId) {
  if (!activation || activation.state !== "armed") return true;
  return activation.target_issue_id === issueId;
}

// ---------------------------------------------------------------------------
// Operator-facing rendering
// ---------------------------------------------------------------------------

export function renderActivationLine(activation) {
  if (!activation || activation.state === "absent") return "activation=absent (committed gates only)";
  if (activation.state === "armed") {
    return `activation=ARMED id=${activation.activation_id} target=${activation.target_issue_id} ref=${activation.authorization_ref} revision=${activation.coordinator_revision} slots=${activation.slots} expires=${activation.expires_at}`;
  }
  return `activation=REFUSED (${activation.reason})`;
}
