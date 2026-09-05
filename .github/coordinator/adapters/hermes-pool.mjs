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

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, linkSync, statSync } from "node:fs";
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

// A lease file is named by attempt_id and NOTHING else. attempt_id is a UUID by
// schema, so anything that is not one can never name a lease. This is the only
// place a path segment is derived, and it is validated here rather than at the
// call sites (CWE-22: external_run_id is rehydrated from a Linear comment
// WITHOUT validation, so an unvalidated join lets a forged comment steer the
// read outside <poolDir>/leases).
const ATTEMPT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Receipt-schema-compatible run identifier. The shared receipt schema requires
// ^apirun_[A-Za-z0-9_-]+$, so the raw UUID can never be the external_run_id —
// a durable receipt carrying one is schema-invalid, and the comment parser
// rehydrates receipts without validating, so it would keep being used.
export const HERMES_RUN_ID_PREFIX = "apirun_hermes_";
export function hermesRunId(attemptId) {
  return `${HERMES_RUN_ID_PREFIX}${attemptId}`;
}
// Does this run id name exactly this attempt? Used instead of trusting run_id.
export function runIdMatchesAttempt(runId, attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_ID_RE.test(attemptId)) return false;
  if (runId === undefined || runId === null) return true; // absent: fall back to attempt_id
  return runId === hermesRunId(attemptId);
}

function leasePath(poolDir, attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_ID_RE.test(attemptId)) return null;
  return join(poolDir, "leases", `${attemptId}.json`);
}

function launchClaimPath(poolDir, attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_ID_RE.test(attemptId)) return null;
  return join(poolDir, "leases", `${attemptId}.launch-claim`);
}

function processIsAlive(pid, io = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (io.isProcessAlive) return io.isProcessAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    return null; // EPERM or an unknown probe failure is not proof of death
  }
}

// CLAIM PHASES. The phase is what makes an abandoned claim recoverable OR
// permanently unsafe, so it is advanced BEFORE each irreversible step, never
// after:
//   pre_spawn      — the claim exists; io.spawn has NOT been called. No worker
//                    can exist, so another coordinator may safely take over.
//   spawn_attempted— io.spawn is about to be / is being called. A worker MAY
//                    exist; taking over could double-launch.
//   spawned        — spawn confirmed. A worker definitely existed.
export const CLAIM_PHASES = Object.freeze(["pre_spawn", "spawn_attempted", "spawned"]);
const RETRY_SAFE_PHASE = "pre_spawn";

// The claim is held only across io.spawn plus two small writes, so a claim
// older than this was left by a process that is not coming back.
const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;

const nowMs = (io) => {
  const t = Date.parse(io.now ? io.now() : new Date().toISOString());
  return Number.isFinite(t) ? t : Date.now();
};

function claimBody(attemptId, io, phase) {
  return JSON.stringify({
    attempt_id: attemptId,
    owner_pid: process.pid,
    owner_host: io.hostname ? io.hostname() : hostname(),
    phase,
    claimed_at: io.now ? io.now() : new Date().toISOString(),
  });
}

// Exclusive create that is also ATOMIC IN CONTENT. writeFileSync(...,"wx")
// creates the file and then writes it, so a crash in between leaves a
// zero-length claim — precisely the window this mutex exists to survive.
// Writing a complete temp file and hard-linking it into place means the claim
// is never observable half-written, and link() still fails EEXIST atomically.
function createClaimExclusive(p, body) {
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    linkSync(tmp, p);
    return { ok: true };
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false, exists: true };
    if (err?.code === "EPERM" || err?.code === "ENOSYS" || err?.code === "EXDEV") {
      // Filesystem without usable hard links: fall back to the exclusive write.
      try {
        writeFileSync(p, body, { flag: "wx" });
        return { ok: true };
      } catch (err2) {
        if (err2?.code === "EEXIST") return { ok: false, exists: true };
        return { ok: false, err: err2 };
      }
    }
    return { ok: false, err };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // temp cleanup is best-effort and never changes the claim outcome
    }
  }
}

// Is an existing claim still held by a live owner? Tri-state, and only the
// definite answers are acted on.
//   "live"      — a running owner; wait, never take over.
//   "abandoned" — provably or near-certainly not coming back.
//   "unknown"   — cannot tell; treat as live (wait) rather than guess.
function claimLiveness(prior, io) {
  const thisHost = io.hostname ? io.hostname() : hostname();
  if (prior && prior.owner_host === thisHost) {
    const alive = processIsAlive(prior.owner_pid, io);
    if (alive === true) return "live"; // a running owner outranks any heuristic
    if (alive === false) return "abandoned";
  }
  // Different host, or liveness unprovable: fall back to age. The hold window
  // is a spawn plus two writes, so an old claim is an abandoned one. This is
  // the ONLY signal available when the hostname is not stable across runs —
  // containers and per-job CI runners, i.e. the actual deployment target.
  const ttl = Number.isFinite(io.claimTtlMs) ? io.claimTtlMs : DEFAULT_CLAIM_TTL_MS;
  const claimedAt = Date.parse(prior?.claimed_at ?? "");
  if (!Number.isFinite(claimedAt)) return "unknown";
  return nowMs(io) - claimedAt >= ttl ? "abandoned" : "live";
}

// A normal lease overwrite is not a claim: two processes can both read queued,
// both write claiming, and both spawn. The exclusive sidecar is the launch
// mutex. It is held from immediately before the claiming transition until spawn
// has either failed durably or reached a confirmed running state.
function acquireLaunchClaim(poolDir, attemptId, io = {}) {
  const p = launchClaimPath(poolDir, attemptId);
  if (p === null) return { ok: false, reason: "invalid attempt id — refusing launch claim" };
  mkdirSync(join(poolDir, "leases"), { recursive: true });
  const created = createClaimExclusive(p, claimBody(attemptId, io, "pre_spawn"));
  if (created.ok) return { ok: true, path: p, phase: "pre_spawn" };
  if (!created.exists) return { ok: false, reason: `launch claim failed: ${created.err?.message ?? "unknown"}` };

  // A claim already exists. Decide between waiting, taking over, and faulting.
  let prior = null;
  let readable = true;
  try {
    prior = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    readable = false; // zero-length or corrupt — a crash mid-write
  }
  const liveness = readable ? claimLiveness(prior, io) : unreadableClaimLiveness(p, io);
  if (liveness !== "abandoned") {
    // Someone may still be working. Waiting is correct and recoverable.
    return { ok: false, reason: "launch already claimed by another coordinator" };
  }
  if (readable && prior?.phase === RETRY_SAFE_PHASE) {
    // The owner is gone and never reached io.spawn, so NO worker exists. Taking
    // the claim over is the only way this reservation is ever recoverable, and
    // it cannot double-launch. Stamp it as ours before proceeding.
    try {
      writeFileSync(p, claimBody(attemptId, io, "pre_spawn"));
      return { ok: true, path: p, phase: "pre_spawn", took_over: true };
    } catch (err) {
      return { ok: false, reason: `could not take over abandoned launch claim: ${err.message}` };
    }
  }
  // Abandoned past the point of no return, or unreadable so the phase cannot be
  // established. A worker may exist: never retry, and never sit silently on a
  // held slot either — surface it.
  return {
    ok: false,
    stale: true,
    reason: readable
      ? `abandoned launch claim at phase ${prior?.phase ?? "unknown"} (owner pid ${prior?.owner_pid ?? "?"} on ${prior?.owner_host ?? "?"})`
      : "abandoned launch claim is unreadable — the spawn phase cannot be established",
  };
}

// An unreadable claim has no claimed_at to age out, so use the file's own mtime.
function unreadableClaimLiveness(p, io) {
  const ttl = Number.isFinite(io.claimTtlMs) ? io.claimTtlMs : DEFAULT_CLAIM_TTL_MS;
  try {
    // mtime comes from the filesystem, so it is compared against the REAL
    // clock — mixing it with an injected io.now would compare two different
    // time bases and silently misjudge staleness.
    return Date.now() - statSync(p).mtimeMs >= ttl ? "abandoned" : "live";
  } catch {
    return "unknown";
  }
}

// Advance the phase of a claim WE hold. Ordering is the whole contract: this
// must land before the step it describes, never after.
function advanceClaimPhase(claim, attemptId, io, phase) {
  if (!claim?.ok || !claim.path) return false;
  try {
    // io.writeFileImpl is the injection seam for this write specifically: the
    // "refuse to spawn when the phase is not durable" branch is otherwise
    // unreachable from a test, and an untested fail-closed branch is exactly
    // the defect this module keeps finding elsewhere.
    (io.writeFileImpl ?? writeFileSync)(claim.path, claimBody(attemptId, io, phase));
    claim.phase = phase;
    return true;
  } catch {
    // The caller decides. Advancing to spawn_attempted MUST succeed before the
    // spawn: if it does not and we spawned anyway, a later crash would read
    // "pre_spawn", conclude no worker exists, and launch a second one.
    return false;
  }
}

function readLaunchClaim(poolDir, attemptId) {
  const p = launchClaimPath(poolDir, attemptId);
  if (p === null || !existsSync(p)) return { ok: false };
  try {
    return { ok: true, claim: JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return { ok: false, corrupt: true };
  }
}

function releaseLaunchClaim(claim) {
  if (!claim?.ok || !claim.path) return;
  try {
    unlinkSync(claim.path);
  } catch {
    // A stale claim cannot cause a duplicate launch: running/terminal leases
    // return before claim acquisition. Cleanup failure must not hide the real
    // spawn outcome or crash coordination.
  }
}

function readLease(poolDir, attemptId) {
  const p = leasePath(poolDir, attemptId);
  if (p === null) return { ok: false, reason: "invalid attempt id — refusing to derive a lease path" };
  if (!existsSync(p)) return { ok: false, reason: "no lease" };
  try {
    const lease = JSON.parse(readFileSync(p, "utf8"));
    return { ok: true, lease };
  } catch {
    return { ok: false, reason: "corrupt lease" };
  }
}

function writeLease(poolDir, lease, { exclusive = false } = {}) {
  const p = leasePath(poolDir, lease.attempt_id);
  if (p === null) throw new Error("invalid attempt id — refusing to write a lease");
  mkdirSync(join(poolDir, "leases"), { recursive: true });
  // "wx" makes first creation atomic: two coordinators cannot both believe they
  // reserved the same attempt.
  writeFileSync(p, JSON.stringify(lease, null, 2), exclusive ? { flag: "wx" } : undefined);
}

// The parent owns spawn bookkeeping; the WORKER owns run status. The parent's
// post-spawn write must therefore never clobber a status the worker has already
// advanced — re-read and merge instead of writing a stale in-memory object.
const WORKER_OWNED_TERMINAL = Object.freeze(["done", "failed"]);
function mergeParentSpawnFields(poolDir, attemptId, fields) {
  const cur = readLease(poolDir, attemptId);
  const base = cur.ok ? cur.lease : null;
  if (!base) return null;
  const workerMovedOn = WORKER_OWNED_TERMINAL.includes(base.status);
  const merged = {
    ...base,
    worker_id: base.worker_id ?? fields.worker_id ?? null,
    spawn: fields.spawn,
    // Only the parent's own pre-spawn state may be advanced to "running"; a
    // worker-owned terminal state stands.
    status: workerMovedOn ? base.status : fields.status,
    granular: workerMovedOn ? base.granular : fields.granular,
    heartbeat: workerMovedOn ? base.heartbeat : fields.heartbeat,
  };
  writeLease(poolDir, merged);
  return merged;
}

// Pre-spawn lease states: the reservation is durable but NO worker exists yet.
// These are recoverable, and must never be reported as a running worker.
const PRE_SPAWN_STATUSES = Object.freeze(["queued", "claiming"]);

// Map a lease to the adapter outcome contract.
function leaseOutcome(lease) {
  if (PRE_SPAWN_STATUSES.includes(lease.status)) {
    // NO worker was ever started for this lease. Reporting RUNNING here made a
    // phantom worker that consumed the slot forever; the honest answer is that
    // the launch outcome is still unknown and the attempt is recoverable.
    return { stage: "LAUNCH_UNKNOWN", reason: `lease is pre-spawn (${lease.status}) — no worker started` };
  }
  if (lease.status === "running") {
    return { stage: "RUNNING", adapter_status: lease.granular ?? "in_progress", external_run_id: hermesRunId(lease.attempt_id), worker_identity: lease.worker_id ?? null };
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
  return { stage: "DONE", adapter_status: "done", external_run_id: hermesRunId(lease.attempt_id), worker_identity: lease.worker_id ?? null };
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
  const now = () => (io.now ? io.now() : new Date().toISOString());
  const existing = readLease(poolDir, attempt_id);
  let lease;
  const mapped = existing.ok ? leaseOutcome(existing.lease) : null;
  if (mapped && mapped.stage === "DONE") {
    return { stage: "FAILED", error_code: "ATTEMPT_ALREADY_TERMINAL", error_kind: "duplicate_launch", reason: `attempt ${attempt_id} already reached a terminal lease state (${existing.lease.status})` };
  }
  if (mapped && mapped.stage !== "LAUNCH_UNKNOWN") {
    // A worker EXISTS for this attempt (running) or the attempt is terminal.
    // Idempotent retry contract: never re-spawn, return the mapped lease state.
    return mapped;
  }
  if (existing.ok) {
    // PRE-SPAWN lease from an earlier attempt that never started a worker.
    // Resuming it is not a double-launch — no worker exists — and it is the only
    // way the reservation can ever be recovered. Claim it first so a concurrent
    // coordinator cannot resume the same lease.
    lease = { ...existing.lease };
  } else if (existing.reason !== "no lease") {
    // Corrupt or unnameable lease: never overwrite durable state we cannot read.
    return { stage: "LAUNCH_UNKNOWN", reason: existing.reason };
  } else {
    lease = {
      attempt_id,
      issue_id,
      authorization_ref,
      target_sha,
      requested_worker: "hermes-box",
      status: "queued",
      granular: "queued",
      worker_id: null,
      heartbeat: now(),
      created: now(),
      spawn: {},
    };
    try {
      // Exclusive create: if another coordinator won the race, adopt its lease
      // rather than overwriting the reservation.
      writeLease(poolDir, lease, { exclusive: true });
    } catch (err) {
      if (err && err.code === "EEXIST") {
        const raced = readLease(poolDir, attempt_id);
        const racedOutcome = raced.ok ? leaseOutcome(raced.lease) : null;
        if (racedOutcome && racedOutcome.stage !== "LAUNCH_UNKNOWN") return racedOutcome;
        return { stage: "LAUNCH_UNKNOWN", reason: "lease created concurrently — retry recovers it" };
      }
      // Nothing durable was written — the launch outcome is unknown by definition.
      return { stage: "LAUNCH_UNKNOWN", reason: `lease write failed: ${err.message}` };
    }
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
  const launchClaim = acquireLaunchClaim(poolDir, attempt_id, io);
  if (!launchClaim.ok) {
    if (launchClaim.stale) {
      return {
        stage: "FAILED",
        error_code: "STALE_LAUNCH_CLAIM",
        error_kind: "launch_ownership_lost",
        pause_adapter: true,
        reason: `${launchClaim.reason}; automatic retry is unsafe because spawn may already have occurred`,
      };
    }
    return { stage: "LAUNCH_UNKNOWN", reason: launchClaim.reason };
  }
  lease = { ...lease, status: "claiming", granular: "queued", heartbeat: now() };
  try {
    writeLease(poolDir, lease);
  } catch (err) {
    releaseLaunchClaim(launchClaim);
    return { stage: "LAUNCH_UNKNOWN", reason: `lease claim persistence failed: ${err.message}` };
  }
  const failClosed = (message) => {
    lease.status = "failed";
    lease.granular = "failed";
    lease.error = { code: "SPAWN_FAILED", kind: "run_failed", message };
    try {
      writeLease(poolDir, lease);
    } catch {
      // lease dir unwritable after spawn failure — nothing durable; report FAILED regardless
    }
    releaseLaunchClaim(launchClaim);
    return { stage: "FAILED", error_code: "SPAWN_FAILED", error_kind: "run_failed", reason: `worker spawn failed: ${message}` };
  };

  // BEFORE the irreversible step: from here on a worker may exist, so an
  // abandoned claim must never be retried. Advancing after io.spawn would leave
  // a crash inside spawn looking retry-safe.
  if (!advanceClaimPhase(launchClaim, attempt_id, io, "spawn_attempted")) {
    // Refusing to spawn is the only safe option: a claim still reading
    // "pre_spawn" would license a takeover that double-launches this worker.
    releaseLaunchClaim(launchClaim);
    return { stage: "LAUNCH_UNKNOWN", reason: "could not record the spawn attempt durably — refusing to start a worker" };
  }
  let child;
  try {
    child = io.spawn(bin, args, { cwd: io.repoDir ?? process.cwd() });
  } catch (err) {
    return failClosed(err.message);
  }
  // child_process.spawn does NOT throw when the binary is missing: it returns a
  // ChildProcess that later EMITS "error". Returning RUNNING here would report a
  // worker that never started, and an unhandled "error" event terminates the
  // coordinator process. Wait for whichever of spawn/error settles first.
  const started = await awaitSpawn(child);
  if (!started.ok) return failClosed(started.err?.message ?? "spawn error");
  advanceClaimPhase(launchClaim, attempt_id, io, "spawned");

  const workerId = `hermes:${io.hostname ? io.hostname() : hostname()}:pid${child.pid ?? "unknown"}`;
  const spawnFields = {
    status: "running",
    granular: "in_progress",
    worker_id: workerId,
    heartbeat: now(),
    spawn: { bin, args, pid: child.pid ?? null },
  };
  let spawnStatePersisted = false;
  try {
    // The worker may already have advanced (or finished) the lease between
    // io.spawn returning and this write. Merge parent-owned spawn fields onto
    // the CURRENT lease instead of overwriting it with a stale in-memory copy.
    const merged = mergeParentSpawnFields(poolDir, attempt_id, spawnFields);
    if (merged) {
      lease = merged;
      spawnStatePersisted = !PRE_SPAWN_STATUSES.includes(merged.status);
    }
  } catch {
    // Lease update failed AFTER spawn: the worker IS running — report RUNNING;
    // the coordinator's durable receipt already holds the slot.
  }
  // If the post-spawn lease transition was not durable, retain the exclusive
  // claim. A later recovery may see LAUNCH_UNKNOWN, and releasing here would
  // let it start a second worker even though this spawn succeeded.
  if (spawnStatePersisted) releaseLaunchClaim(launchClaim);
  return { stage: "RUNNING", adapter_status: "in_progress", external_run_id: hermesRunId(attempt_id), worker_identity: workerId };
}

// awaitSpawn — settle on the child's first spawn/error event.
//
// A real ChildProcess sets `pid` synchronously on success and leaves it
// undefined on failure, then emits "spawn" or "error" on a later tick. An
// injected test double is a plain object with no event API; that is treated as
// an immediate success so the injectable seam stays simple.
async function awaitSpawn(child) {
  if (!child || typeof child.once !== "function") return { ok: true };
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      // Keep a permanent listener so a LATER error (e.g. a failed kill) can
      // never surface as an unhandled "error" event and kill the coordinator.
      if (typeof child.on === "function") child.on("error", () => {});
      resolve(v);
    };
    child.once("error", (err) => done({ ok: false, err }));
    child.once("spawn", () => done({ ok: true }));
    // A successful spawn has a pid immediately; a failed one never does. This
    // keeps a double that emits nothing from hanging the run, without ever
    // pre-empting the ENOENT "error" of a real failed spawn.
    setImmediate(() => {
      if (child.pid !== undefined && child.pid !== null) done({ ok: true });
    });
  });
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
  // The lease is addressed by attempt_id ONLY. run_id arrives from a receipt
  // rehydrated out of a Linear comment without validation, so it is checked
  // against this attempt rather than used to build a path (CWE-22).
  if (!runIdMatchesAttempt(run_id, attempt_id)) {
    return { stage: "UNCHANGED", reason: "run id does not identify this attempt — refusing the lease read" };
  }
  const read = readLease(poolDir, attempt_id);
  if (!read.ok) {
    // Missing/corrupt lease: fail closed — never manufacture a failure, never
    // release the slot (the durable Linear receipt remains authoritative).
    return { stage: "UNCHANGED", reason: read.reason };
  }
  const lease = read.lease;
  // The loaded lease must be the one this attempt is bound to. A lease naming a
  // different attempt or a different head can never satisfy this receipt.
  if (lease.attempt_id !== attempt_id) {
    return { stage: "UNCHANGED", reason: "lease attempt_id does not match this attempt" };
  }
  if (target_sha !== undefined && lease.target_sha !== undefined && lease.target_sha !== target_sha) {
    return { stage: "UNCHANGED", reason: "lease is bound to a different head — stale, never authoritative for this attempt" };
  }
  const base = { external_run_id: hermesRunId(lease.attempt_id), worker_identity: lease.worker_id ?? null };
  if (PRE_SPAWN_STATUSES.includes(lease.status)) {
    // Pre-spawn: no worker exists *according to the lease*. Never RUNNING — that
    // manufactured a phantom worker.
    //
    // But the lease is not the only record. If the launch claim shows the spawn
    // was attempted and its owner is gone, then a worker DID start and the
    // running-lease write was lost. This receipt is already RUNNING, so
    // launchBuilder never runs for it again and only this poll can ever speak:
    // returning UNCHANGED would hide a real worker forever behind a held slot.
    // HOLD is terminal and operator-visible, which is what an untracked worker
    // warrants.
    const claim = readLaunchClaim(poolDir, attempt_id);
    if (claim.ok && claim.claim?.phase && claim.claim.phase !== "pre_spawn" && claimLiveness(claim.claim, io) === "abandoned") {
      return {
        ...base,
        stage: "HOLD",
        adapter_status: "completed",
        reason: `worker was spawned (claim phase ${claim.claim.phase}) but the running lease was never persisted and its owner is gone — manual reconciliation`,
      };
    }
    return { stage: "UNCHANGED", reason: `lease is pre-spawn (${lease.status}) — no worker started` };
  }
  if (lease.status === "running") {
    return { ...base, stage: "RUNNING", adapter_status: lease.granular ?? "in_progress" };
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
