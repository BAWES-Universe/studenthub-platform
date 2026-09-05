// hermes-pool adapter — Hermes FULL-SESSION worker pool (SHU-62).
//
// Hands a coordinator-reserved card to a Hermes full-session worker on the
// always-on host and tracks the attempt through a HOST-LOCAL durable lease.
// Mirrors the workspace-agents adapter's outcome contract exactly so the
// coordinator is provider-independent:
//
//   launchBuilder(...) -> { stage: RUNNING | LAUNCH_UNKNOWN | FAILED, ... }
//   monitorRun(...)    -> { stage: RUNNING | COMPLETED | HOLD | FAILED | UNCHANGED, ... }
//
// Lease protocol (per attempt_id, under <poolDir>/leases/<attempt_id>.json):
//   - the lease is written {status:"queued"} BEFORE the worker spawns
//     (reserve precedes launch — the host-local analogue of the durable
//     RESERVED receipt in Linear);
//   - the worker updates the lease to running/done/failed with heartbeat
//     timestamps as it progresses;
//   - a second launch of the SAME attempt_id never re-spawns: the existing
//     lease's state is returned (idempotent retry contract).
//
// Callback contract (identical to the Workspace Agents lane): the worker runs
// the card in an isolated worktree and posts a "coordinator-callback v1"
// comment on the Linear issue with { attempt_id, target_sha,
// stage: BUILD_READY | REVISION_READY | BLOCKED | FAILED, links: [...] }.
// monitorRun validates that callback (same bar as the machine: same attempt,
// same bound head, explicit SUCCESS stage) — done-without-valid-callback is
// HOLD, never COMPLETED.
//
// Worker spawn (FULL-SESSION, not a thin cron — SHU-62 requirement):
//   <HERMES_BIN or "hermes"> -z <work order> --worktree
//   cwd: the pilot repo clone (io.repoDir). Hermes creates an isolated
//   worktree for the card; the work order carries attempt_id + the callback
//   contract so the worker can produce a valid callback.
//
// Fail-closed rules: missing/corrupt lease -> UNCHANGED (never a manufactured
// failure); spawn failure (hermes missing) -> FAILED SPAWN_FAILED without
// pause (retryable, capped by max_failed_attempts); lease write failure ->
// LAUNCH_UNKNOWN (nothing durable was written); stale heartbeat while running
// -> still RUNNING (timeout alone never changes state).
//
// Everything is injectable (io.poolDir, io.repoDir, io.spawn, io.hostname,
// io.now, env.HERMES_BIN) — the module is fully testable with a mocked worker
// and temp dir; NO live spawn happens in tests or while dispatch is disabled.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";

export const HERMES_POOL_DEFAULT_DIR = join(homedir(), ".hermes", "coordinator-pool");

// The only callback stages that may authorize COMPLETED — same contract as the
// workspace-agents lane (adapter tests pin both to the same enum).
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY"]);

export function launchIdempotencyKey({ attempt_id, target_sha }) {
  return `${attempt_id}:LAUNCH_UNKNOWN:${target_sha}`;
}

function poolDirFor(io = {}) {
  return io.poolDir ?? HERMES_POOL_DEFAULT_DIR;
}

function leasePath(poolDir, attemptId) {
  return join(poolDir, "leases", `${attemptId}.json`);
}

function readLease(poolDir, attemptId) {
  const p = leasePath(poolDir, attemptId);
  if (!existsSync(p)) return { ok: false, reason: "no lease" };
  try {
    const lease = JSON.parse(readFileSync(p, "utf8"));
    return { ok: true, lease };
  } catch {
    return { ok: false, reason: "corrupt lease" };
  }
}

function writeLease(poolDir, lease, io = {}) {
  mkdirSync(join(poolDir, "leases"), { recursive: true });
  writeFileSync(leasePath(poolDir, lease.attempt_id), JSON.stringify(lease, null, 2));
}

// Map a lease to the adapter outcome contract.
function leaseOutcome(lease) {
  if (lease.status === "queued") {
    return { stage: "RUNNING", adapter_status: "queued", external_run_id: lease.attempt_id, worker_identity: lease.worker_id ?? null };
  }
  if (lease.status === "running") {
    return { stage: "RUNNING", adapter_status: lease.granular ?? "in_progress", external_run_id: lease.attempt_id, worker_identity: lease.worker_id ?? null };
  }
  if (lease.status === "failed") {
    return {
      stage: "FAILED",
      adapter_status: "failed",
      error_code: lease.error?.code ?? "WORKER_FAILED",
      error_kind: lease.error?.kind ?? "run_failed",
      worker_identity: lease.worker_id ?? null,
    };
  }
  // done: terminal mapping needs callback validation — monitorRun decides.
  return { stage: "DONE", adapter_status: "done", external_run_id: lease.attempt_id, worker_identity: lease.worker_id ?? null };
}

export function validateCallbackEvidence({ evidence, attempt_id, target_sha, current_head }) {
  if (!evidence || typeof evidence !== "object") return false;
  if (!Array.isArray(evidence.links) || evidence.links.length === 0) return false;
  if (evidence.attempt_id !== attempt_id) return false;
  if (evidence.target_sha !== target_sha) return false;
  if (current_head && current_head !== target_sha) return false;
  if (evidence.stage === undefined || evidence.stage === null || !SUCCESS_CALLBACK_STAGES.includes(evidence.stage)) {
    return false; // BLOCKED / FAILED / unknown / MISSING stages never authorize COMPLETED
  }
  return true;
}

export function buildWorkOrder({ issue_id, authorization_ref, target_sha, attempt_id, task_context }) {
  return [
    task_context,
    `Authorized contract ref: ${authorization_ref}`,
    `Bound head: ${target_sha}`,
    `Attempt: ${attempt_id}`,
    `Repo/branch: see the coordinator card — work in an isolated git worktree of the pilot repo.`,
    'On completion, post a "coordinator-callback v1" comment on this Linear issue with a JSON block: { attempt_id, target_sha, stage: BUILD_READY | REVISION_READY | BLOCKED | FAILED, links: [CI/PR evidence URLs] }. Echo the exact attempt_id and target_sha above.',
  ].join("\n");
}

// launchBuilder — reserve (lease queued) -> spawn the full-session worker.
export async function launchBuilder({
  issue_id,
  authorization_ref,
  attempt_id,
  target_sha,
  task_context,
  fetchImpl = fetch, // unused by the pool lane (callback channel is Linear/GitHub via the worker), kept for interface parity
  io = {},
  env = {},
}) {
  const poolDir = poolDirFor(io);
  const existing = readLease(poolDir, attempt_id);
  if (existing.ok) {
    // Idempotent retry (LAUNCH_UNKNOWN recovery reuses the SAME attempt): the
    // lease already exists — never re-spawn, return its mapped state.
    const mapped = leaseOutcome(existing.lease);
    if (mapped.stage === "DONE") {
      return { stage: "FAILED", error_code: "ATTEMPT_ALREADY_TERMINAL", error_kind: "duplicate_launch", reason: `attempt ${attempt_id} already reached a terminal lease state (${existing.lease.status})` };
    }
    return mapped;
  }

  const lease = {
    attempt_id,
    issue_id,
    authorization_ref,
    target_sha,
    requested_worker: "hermes-box",
    status: "queued",
    granular: "queued",
    worker_id: null,
    heartbeat: io.now ? io.now() : new Date().toISOString(),
    created: io.now ? io.now() : new Date().toISOString(),
    spawn: {},
  };
  try {
    writeLease(poolDir, lease, io);
  } catch (err) {
    // Nothing durable was written — the launch outcome is unknown by definition.
    return { stage: "LAUNCH_UNKNOWN", reason: `lease write failed: ${err.message}` };
  }

  const bin = env.HERMES_BIN ?? "hermes";
  const workOrder = buildWorkOrder({ issue_id, authorization_ref, target_sha, attempt_id, task_context });
  // FULL-SESSION worker: `hermes -z <order> --worktree` runs the complete
  // agent session (all tools) non-interactively in an isolated worktree of the
  // repo at io.repoDir. The worker updates the lease as it progresses.
  const args = ["-z", workOrder, "--worktree"];
  if (!io.spawn) {
    // No spawn impl injected and we are NOT being asked to spawn for real:
    // leave the lease queued and report the run as accepted — the coordinator
    // only reaches here with dispatch enabled; real spawn is wired at
    // activation (SHU-63) via io.spawn. Fail-closed default: treat as accepted
    // but UNKNOWN so nothing is fabricated.
    return { stage: "LAUNCH_UNKNOWN", reason: "no spawn impl configured — worker not started (activation wiring)" };
  }
  let child;
  try {
    child = io.spawn(bin, args, { cwd: io.repoDir ?? process.cwd() });
  } catch (err) {
    lease.status = "failed";
    lease.error = { code: "SPAWN_FAILED", kind: "run_failed", message: err.message };
    try {
      writeLease(poolDir, lease, io);
    } catch {
      // lease dir unwritable after spawn failure — nothing durable; report FAILED regardless
    }
    return { stage: "FAILED", error_code: "SPAWN_FAILED", error_kind: "run_failed", reason: `worker spawn failed: ${err.message}` };
  }
  const workerId = `hermes:${io.hostname ? io.hostname() : hostname()}:pid${child.pid ?? "unknown"}`;
  lease.status = "running";
  lease.granular = "in_progress";
  lease.worker_id = workerId;
  lease.heartbeat = io.now ? io.now() : new Date().toISOString();
  lease.spawn = { bin, args, pid: child.pid ?? null };
  try {
    writeLease(poolDir, lease, io);
  } catch {
    // Lease update failed AFTER spawn: the worker IS running — report RUNNING;
    // the coordinator's durable receipt already holds the slot.
  }
  return { stage: "RUNNING", adapter_status: "in_progress", external_run_id: attempt_id, worker_identity: workerId };
}

// monitorRun — read the lease, validate any callback evidence, map to outcome.
export async function monitorRun({
  run_id,
  attempt_id,
  target_sha,
  evidence,
  current_head,
  token, // unused by the pool lane (host-local), kept for interface parity
  fetchImpl = fetch,
  io = {},
  env = {},
}) {
  const poolDir = poolDirFor(io);
  const read = readLease(poolDir, run_id ?? attempt_id);
  if (!read.ok) {
    // Missing/corrupt lease: fail closed — never manufacture a failure, never
    // release the slot (the durable Linear receipt remains authoritative).
    return { stage: "UNCHANGED", reason: read.reason };
  }
  const lease = read.lease;
  const base = { external_run_id: lease.attempt_id, worker_identity: lease.worker_id ?? null };
  if (lease.status === "queued" || lease.status === "running") {
    return { ...base, stage: "RUNNING", adapter_status: lease.status === "queued" ? "queued" : lease.granular ?? "in_progress" };
  }
  if (lease.status === "failed") {
    return { ...base, stage: "FAILED", adapter_status: "failed", error_code: lease.error?.code ?? "WORKER_FAILED", error_kind: lease.error?.kind ?? "run_failed" };
  }
  if (lease.status === "done") {
    const valid = validateCallbackEvidence({ evidence, attempt_id: lease.attempt_id, target_sha: lease.target_sha, current_head });
    if (valid) {
      return { ...base, stage: "COMPLETED", adapter_status: "completed", evidence_links: evidence.links };
    }
    return { ...base, stage: "HOLD", adapter_status: "completed", reason: "worker done but callback missing/invalid/stale-head — manual review" };
  }
  return { stage: "UNCHANGED", reason: `unknown lease status ${lease.status}` };
}
