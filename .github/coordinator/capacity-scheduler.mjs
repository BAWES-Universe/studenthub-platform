// Capacity-aware scheduling policy and durable local ledger (SHU-70).
//
// This module is role/runtime neutral. It does not launch workers. A caller
// supplies explicit host and shared-account identities; a single host-local
// lock serializes the capacity snapshot plus reservation write. A lock is
// never stolen by age, because an ambiguous prior writer is not authority to
// oversubscribe.

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CAPACITY_LEDGER_VERSION = "1.0.0";
export const ACTIVE_CAPACITY_STATUSES = Object.freeze(["reserved", "dispatching", "running", "launch_unknown", "hold"]);
export const TERMINAL_CAPACITY_STATUSES = Object.freeze(["completed", "failed", "expired", "canceled"]);
const CAPACITY_STATUSES = new Set([...ACTIVE_CAPACITY_STATUSES, ...TERMINAL_CAPACITY_STATUSES]);
const ROLES = new Set(["build", "review", "revise"]);
const WRITER_ROLES = new Set(["build", "revise"]);
const RESOURCES = new Set(["global", "host", "account", "runtime"]);
const PAUSE_REASONS = new Set(["quota", "authentication", "access", "maintenance", "operator_hold"]);
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,255}$/;

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory()) throw new Error(`unsafe capacity state directory: ${path}`);
    fchmodSync(fd, 0o700);
    const current = lstatSync(path);
    if (current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== opened.dev
      || current.ino !== opened.ino) {
      throw new Error(`capacity state directory changed during validation: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableJson(path, value) {
  privateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateLedger(parsed) {
  if (!plainObject(parsed)
    || parsed.version !== CAPACITY_LEDGER_VERSION
    || !nonNegativeInteger(parsed.spent_micros)
    || !plainObject(parsed.reservations)
    || !plainObject(parsed.pauses)) {
    throw new Error("invalid capacity ledger");
  }
  for (const [taskId, reservation] of Object.entries(parsed.reservations)) {
    if (!SAFE_ID.test(taskId)
      || !plainObject(reservation)
      || reservation.version !== CAPACITY_LEDGER_VERSION
      || reservation.task_id !== taskId
      || !CAPACITY_STATUSES.has(reservation.status)
      || !ROLES.has(reservation.role)
      || !nonNegativeInteger(reservation.estimated_cost_micros)
      || !positiveInteger(reservation.deadline_ms)
      || !nonNegativeInteger(reservation.retry)
      || !nonNegativeInteger(reservation.revision)
      || !validTimestamp(reservation.accepted_at)
      || !Array.isArray(reservation.overlap_keys)
      || !reservation.overlap_keys.every((id) => typeof id === "string" && SAFE_ID.test(id))) {
      throw new Error("invalid capacity ledger");
    }
    for (const field of ["runtime", "host", "account", "repo", "branch", "worktree"]) {
      if (typeof reservation[field] !== "string" || !SAFE_ID.test(reservation[field])) throw new Error("invalid capacity ledger");
    }
    if (reservation.status === "reserved" && !validTimestamp(reservation.reservation_expires_at)) {
      throw new Error("invalid capacity ledger");
    }
    if (reservation.actual_cost_micros !== undefined && !nonNegativeInteger(reservation.actual_cost_micros)) {
      throw new Error("invalid capacity ledger");
    }
  }
  for (const [key, pause] of Object.entries(parsed.pauses)) {
    const validKey = key === "global" || /^(?:host|account|runtime):[A-Za-z0-9._:/-]{1,255}$/.test(key);
    if (!validKey
      || !plainObject(pause)
      || !PAUSE_REASONS.has(pause.reason)
      || (pause.until !== null && !validTimestamp(pause.until))
      || !validTimestamp(pause.created_at)) {
      throw new Error("invalid capacity ledger");
    }
  }
  return parsed;
}

function readLedger(path) {
  if (!existsSync(path)) return { version: CAPACITY_LEDGER_VERSION, spent_micros: 0, reservations: {}, pauses: {} };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe capacity ledger file");
  return validateLedger(JSON.parse(readFileSync(path, "utf8")));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function limitsMap(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} limits are required`);
  for (const [id, limit] of Object.entries(value)) {
    if (!SAFE_ID.test(id) || !positiveInteger(limit)) throw new Error(`${name} limit ${id || "<empty>"} must use a safe id and positive integer`);
  }
  return { ...value };
}

export function validateCapacityPolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("capacity policy is required");
  if (!positiveInteger(policy.global_limit)) throw new Error("global_limit must be a positive integer");
  const reviewReserve = policy.review_reserve ?? 1;
  if (!nonNegativeInteger(reviewReserve) || reviewReserve >= policy.global_limit) {
    throw new Error("review_reserve must be non-negative and smaller than global_limit");
  }
  if (!positiveInteger(policy.budget_micros)) throw new Error("budget_micros must be explicit and positive");
  for (const field of ["max_deadline_ms", "max_retries", "max_revisions", "reservation_ttl_ms"]) {
    if (!nonNegativeInteger(policy[field]) || (field.endsWith("_ms") && policy[field] === 0)) {
      throw new Error(`${field} must be explicitly bounded`);
    }
  }
  for (const field of ["premium_runtimes", "premium_approvals"]) {
    if (policy[field] !== undefined && (!Array.isArray(policy[field]) || !policy[field].every((id) => typeof id === "string" && SAFE_ID.test(id)))) {
      throw new Error(`${field} must be an array of safe identifiers`);
    }
  }
  return {
    global_limit: policy.global_limit,
    review_reserve: reviewReserve,
    budget_micros: policy.budget_micros,
    max_deadline_ms: policy.max_deadline_ms,
    max_retries: policy.max_retries,
    max_revisions: policy.max_revisions,
    reservation_ttl_ms: policy.reservation_ttl_ms,
    hosts: limitsMap(policy.hosts, "host"),
    accounts: limitsMap(policy.accounts, "account"),
    runtimes: policy.runtimes ? limitsMap(policy.runtimes, "runtime") : {},
    premium_runtimes: new Set(policy.premium_runtimes ?? []),
    premium_approvals: new Set(policy.premium_approvals ?? []),
  };
}

function taskValidation(task, policy) {
  if (!task || typeof task !== "object" || typeof task.task_id !== "string" || !task.task_id) return "task_id is required";
  if (!ROLES.has(task.role)) return "role must be build, review, or revise";
  for (const field of ["runtime", "host", "account", "repo", "branch", "worktree"]) {
    if (typeof task[field] !== "string" || !task[field]) return `${field} is required`;
  }
  for (const field of ["task_id", "runtime", "host", "account", "repo", "branch", "worktree"]) {
    if (!SAFE_ID.test(task[field])) return `${field} contains unsafe characters or is too long`;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repo)) return "repo must be owner/name";
  if (!task.worktree.startsWith("/") || task.worktree.includes("..")) return "worktree must be an absolute confined path";
  for (const field of ["blocked_by", "overlap_keys", "fallback_runtimes"]) {
    const values = task[field] ?? [];
    if (!Array.isArray(values) || !values.every((id) => typeof id === "string" && SAFE_ID.test(id))) {
      return `${field} must contain safe identifiers`;
    }
  }
  if (!(task.host in policy.hosts)) return `capacity unknown for host ${task.host}`;
  if (!(task.account in policy.accounts)) return `capacity unknown for shared account ${task.account}`;
  if (!nonNegativeInteger(task.estimated_cost_micros)) return "estimated cost is unknown";
  if (!positiveInteger(task.deadline_ms) || task.deadline_ms > policy.max_deadline_ms) return "deadline exceeds policy bound";
  if (!nonNegativeInteger(task.retry) || task.retry > policy.max_retries) return "retry count exceeds policy bound";
  if (!nonNegativeInteger(task.revision) || task.revision > policy.max_revisions) return "revision count exceeds policy bound";
  if (policy.premium_runtimes.has(task.runtime) && !policy.premium_approvals.has(task.task_id)) {
    return `premium runtime ${task.runtime} requires trusted policy approval for ${task.task_id}`;
  }
  return null;
}

function activeReservations(state) {
  return Object.values(state.reservations).filter((reservation) => ACTIVE_CAPACITY_STATUSES.includes(reservation.status));
}

function resourceKey(scope, id) {
  if (!RESOURCES.has(scope)) throw new Error(`unknown pause scope ${scope}`);
  if (scope !== "global" && (typeof id !== "string" || !SAFE_ID.test(id))) throw new Error("pause resource id must be safe");
  return scope === "global" ? "global" : `${scope}:${id}`;
}

function pauseFor(task, state, nowMs) {
  const keys = ["global", `host:${task.host}`, `account:${task.account}`, `runtime:${task.runtime}`];
  for (const key of keys) {
    const pause = state.pauses[key];
    if (!pause) continue;
    if (pause.until && Date.parse(pause.until) <= nowMs) {
      delete state.pauses[key];
      continue;
    }
    return { key, ...pause };
  }
  return null;
}

function decision(code, reason, details = {}) {
  let nextAction = "wait_for_capacity";
  let humanDecision = null;
  if (code === "DEPENDENCY_BLOCKED") nextAction = "wait_for_dependencies";
  if (code === "RESOURCE_PAUSED") nextAction = details.until ? `retry_after:${details.until}` : "wait_for_resource_recovery";
  if (code === "PREMIUM_APPROVAL_REQUIRED") {
    nextAction = "wait_for_product_approval";
    humanDecision = reason;
  }
  if (code === "CAPACITY_UNKNOWN" || code === "COST_UNKNOWN") {
    nextAction = "wait_for_operator_configuration";
    humanDecision = reason;
  }
  if (code === "UNSAFE_FALLBACK") {
    nextAction = "wait_for_runtime_decision";
    humanDecision = reason;
  }
  return { ok: false, status: "hold", code, hold_reason: reason, next_automatic_action: nextAction, human_decision: humanDecision };
}

function evaluate(task, state, policy, nowMs) {
  const validation = taskValidation(task, policy);
  if (validation) {
    if (validation.includes("premium")) return decision("PREMIUM_APPROVAL_REQUIRED", validation);
    if (validation.includes("capacity unknown")) return decision("CAPACITY_UNKNOWN", validation);
    if (validation.includes("cost is unknown")) return decision("COST_UNKNOWN", validation);
    return decision("POLICY_BOUND", validation);
  }
  if ((task.blocked_by ?? []).length > 0) {
    return decision("DEPENDENCY_BLOCKED", `blocked by ${task.blocked_by.join(", ")}`);
  }
  if (state.reservations[task.task_id] && ACTIVE_CAPACITY_STATUSES.includes(state.reservations[task.task_id].status)) {
    const existing = state.reservations[task.task_id];
    const same = ["role", "runtime", "host", "account", "repo", "branch", "worktree"].every((field) => existing[field] === task[field]);
    return same
      ? { ok: true, status: existing.status, duplicate: true, reservation: existing }
      : decision("TASK_REBIND", "task_id is already bound to different execution resources");
  }
  if (state.reservations[task.task_id]) {
    return decision("TASK_ID_REUSED", "terminal task_id cannot be reused; mint a fresh attempt");
  }
  const pause = pauseFor(task, state, nowMs);
  if (pause) {
    if ((task.fallback_runtimes ?? []).length > 0) {
      return decision("UNSAFE_FALLBACK", `runtime fallback from ${task.runtime} requires an explicit new work order`);
    }
    return decision("RESOURCE_PAUSED", `${pause.key} paused: ${pause.reason}`, { until: pause.until });
  }

  const active = activeReservations(state);
  const collidingWriter = active.find((reservation) =>
    WRITER_ROLES.has(task.role)
    && WRITER_ROLES.has(reservation.role)
    && reservation.repo === task.repo
    && reservation.branch === task.branch);
  if (collidingWriter) return decision("BRANCH_WRITER_ACTIVE", `writer ${collidingWriter.task_id} already owns ${task.repo}:${task.branch}`);
  const collidingWorktree = active.find((reservation) => reservation.worktree === task.worktree);
  if (collidingWorktree) return decision("WORKTREE_ACTIVE", `worktree already owned by ${collidingWorktree.task_id}`);
  const overlap = active.find((reservation) =>
    (task.overlap_keys ?? []).some((key) => (reservation.overlap_keys ?? []).includes(key)));
  if (overlap) return decision("OVERLAP_ACTIVE", `overlaps active task ${overlap.task_id}`);

  if (active.length >= policy.global_limit) return decision("GLOBAL_CAPACITY", "global capacity reached");
  const activeWriters = active.filter((reservation) => WRITER_ROLES.has(reservation.role)).length;
  if (WRITER_ROLES.has(task.role) && activeWriters >= policy.global_limit - policy.review_reserve) {
    return decision("REVIEW_RESERVE", `${policy.review_reserve} global slot(s) reserved for review progress`);
  }
  const counts = (field, value) => active.filter((reservation) => reservation[field] === value).length;
  if (counts("host", task.host) >= policy.hosts[task.host]) return decision("HOST_CAPACITY", `host ${task.host} capacity reached`);
  if (counts("account", task.account) >= policy.accounts[task.account]) {
    return decision("ACCOUNT_CAPACITY", `shared account ${task.account} capacity reached`);
  }
  if (task.runtime in policy.runtimes && counts("runtime", task.runtime) >= policy.runtimes[task.runtime]) {
    return decision("RUNTIME_CAPACITY", `runtime ${task.runtime} capacity reached`);
  }
  const committed = active.reduce((sum, reservation) => sum + reservation.estimated_cost_micros, 0);
  if (state.spent_micros + committed + task.estimated_cost_micros > policy.budget_micros) {
    return decision("BUDGET_CAPACITY", "explicit spending budget would be exceeded");
  }
  return { ok: true };
}

function expireReservations(state, nowMs) {
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.status === "reserved" && Date.parse(reservation.reservation_expires_at) <= nowMs) {
      reservation.status = "expired";
      reservation.hold_reason = "reservation acknowledgement deadline expired before launch";
      reservation.next_automatic_action = "create_fresh_attempt_if_retry_budget_allows";
    }
  }
}

function priority(task) {
  return Number.isFinite(task.priority) ? task.priority : 999;
}

function taskOrder(a, b) {
  const roleA = a.role === "review" ? 0 : 1;
  const roleB = b.role === "review" ? 0 : 1;
  return roleA - roleB || priority(a) - priority(b) || a.task_id.localeCompare(b.task_id);
}

export function readableTaskStatus(task, outcome) {
  const redact = (value) => {
    if (typeof value !== "string") return null;
    return value
      .replace(/\bBearer\s+\S+/gi, "[redacted]")
      .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]+/g, "[redacted]");
  };
  const safeId = (value) => typeof value === "string"
    && SAFE_ID.test(value)
    && !/^(?:ghp_|github_pat_|sk-)/i.test(value)
    ? value
    : "[redacted]";
  return {
    task_id: safeId(task.task_id),
    role: task.role,
    runtime: safeId(task.runtime),
    status: outcome.status,
    hold_reason: redact(outcome.hold_reason),
    next_automatic_action: outcome.next_automatic_action ?? (outcome.status === "reserved" ? "mark_dispatching_then_submit" : null),
    human_decision: redact(outcome.human_decision),
    estimated_cost_micros: nonNegativeInteger(task.estimated_cost_micros) ? task.estimated_cost_micros : null,
  };
}

export class CapacityScheduler {
  constructor({ stateDir, policy, now = () => Date.now() }) {
    this.stateDir = stateDir;
    this.policy = validateCapacityPolicy(policy);
    this.now = now;
    this.ledgerPath = join(stateDir, "capacity-ledger.json");
    this.lockPath = join(stateDir, "capacity-ledger.lock");
    privateDirectory(stateDir);
  }

  withLock(operation) {
    try {
      mkdirSync(this.lockPath, { mode: 0o700 });
      syncDirectory(this.stateDir);
    } catch (error) {
      if (error.code === "EEXIST") return decision("SCHEDULER_BUSY", "another scheduler transaction owns the capacity ledger");
      throw error;
    }
    try {
      let state;
      try {
        state = readLedger(this.ledgerPath);
      } catch {
        return decision("LEDGER_INVALID", "capacity ledger is invalid; no reservation was written");
      }
      expireReservations(state, this.now());
      const result = operation(state);
      durableJson(this.ledgerPath, state);
      return result;
    } finally {
      rmdirSync(this.lockPath);
      syncDirectory(this.stateDir);
    }
  }

  reserve(task) {
    const [result] = this.reserveMany([task]);
    return result;
  }

  reserveMany(tasks) {
    if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
    const locked = this.withLock((state) => tasks
      .map((task, inputIndex) => ({ task, inputIndex }))
      .sort((a, b) => taskOrder(a.task, b.task))
      .map(({ task, inputIndex }) => {
        const result = evaluate(task, state, this.policy, this.now());
        if (!result.ok) return { ...result, input_index: inputIndex, task: readableTaskStatus(task, result) };
        if (result.duplicate) return { ...result, input_index: inputIndex, task: readableTaskStatus(task, result) };
        const acceptedAt = new Date(this.now()).toISOString();
        const reservation = {
          version: CAPACITY_LEDGER_VERSION,
          task_id: task.task_id,
          role: task.role,
          runtime: task.runtime,
          host: task.host,
          account: task.account,
          repo: task.repo,
          branch: task.branch,
          worktree: task.worktree,
          overlap_keys: [...(task.overlap_keys ?? [])],
          status: "reserved",
          estimated_cost_micros: task.estimated_cost_micros,
          deadline_ms: task.deadline_ms,
          retry: task.retry,
          revision: task.revision,
          accepted_at: acceptedAt,
          reservation_expires_at: new Date(this.now() + this.policy.reservation_ttl_ms).toISOString(),
        };
        state.reservations[task.task_id] = reservation;
        const outcome = { ok: true, status: "reserved", duplicate: false, reservation };
        return { ...outcome, input_index: inputIndex, task: readableTaskStatus(task, outcome) };
      }));
    if (Array.isArray(locked)) return locked.sort((a, b) => a.input_index - b.input_index);
    return tasks.map((task, inputIndex) => ({ ...locked, input_index: inputIndex, task: readableTaskStatus(task, locked) }));
  }

  transition(taskId, status, { actual_cost_micros = 0, hold_reason = null, next_automatic_action = null } = {}) {
    if (![...ACTIVE_CAPACITY_STATUSES, ...TERMINAL_CAPACITY_STATUSES].includes(status)) throw new Error(`invalid capacity status ${status}`);
    if (!nonNegativeInteger(actual_cost_micros)) throw new Error("actual cost must be non-negative integer micros");
    return this.withLock((state) => {
      const current = state.reservations[taskId];
      if (!current) return decision("RESERVATION_MISSING", `no reservation for ${taskId}`);
      const wasTerminal = TERMINAL_CAPACITY_STATUSES.includes(current.status);
      if (wasTerminal && current.status !== status) return decision("TERMINAL_RESERVATION", `${taskId} is already terminal`);
      current.status = status;
      current.hold_reason = hold_reason;
      current.next_automatic_action = next_automatic_action;
      current.updated_at = new Date(this.now()).toISOString();
      if (!wasTerminal && TERMINAL_CAPACITY_STATUSES.includes(status)) {
        current.actual_cost_micros = actual_cost_micros;
        state.spent_micros += actual_cost_micros;
      }
      return { ok: true, status, reservation: { ...current } };
    });
  }

  pauseResource({ scope, id = null, reason, until = null }) {
    if (!PAUSE_REASONS.has(reason)) throw new Error("pause reason must be a non-secret reason code");
    if (until !== null && !Number.isFinite(Date.parse(until))) throw new Error("pause expiry must be an ISO timestamp or null");
    const key = resourceKey(scope, id);
    return this.withLock((state) => {
      state.pauses[key] = { reason, until, created_at: new Date(this.now()).toISOString() };
      return { ok: true, key, pause: { ...state.pauses[key] } };
    });
  }

  snapshot() {
    const state = readLedger(this.ledgerPath);
    expireReservations(state, this.now());
    return state;
  }
}
