// Durable host-local worker supervisor (SHU-67).
//
// The one-shot coordinator is a client of this module. It submits an
// authenticated, attempt-bound work order over an owner-only Unix socket and
// receives an acknowledgement only after that order is durable. The persistent
// supervisor owns worker processes and terminal state. A missing supervisor is
// HOLD; callers must never fall back to spawning a worker themselves.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { validWorkOrder } from "./review-routing.mjs";

export const SUPERVISOR_PROTOCOL_VERSION = "1.0.0";
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_DEADLINE_MS = 60 * 60 * 1000;
export const MAX_REQUEST_BYTES = 64 * 1024;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

function canonical(value) {
  return JSON.stringify(sorted(value));
}

function assertSecret(secret) {
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? "");
  if (bytes.length < 32) throw new Error("supervisor secret must be at least 32 bytes");
  return bytes;
}

function validateBoundOrder(order) {
  const base = validWorkOrder(order);
  if (!base.ok) return base;
  if (typeof order.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(order.repo)) {
    return { ok: false, reason: "missing/invalid repo binding" };
  }
  if (
    typeof order.branch !== "string"
    || order.branch.length === 0
    || order.branch.length > 255
    || order.branch.includes("..")
    || /[\x00-\x20~^:?*[\\]/.test(order.branch)
  ) {
    return { ok: false, reason: "missing/invalid branch binding" };
  }
  if (Buffer.byteLength(canonical(order)) > MAX_REQUEST_BYTES / 2) {
    return { ok: false, reason: "work order is too large" };
  }
  return { ok: true };
}

function macFor(order, secret) {
  return createHmac("sha256", assertSecret(secret))
    .update(`${SUPERVISOR_PROTOCOL_VERSION}\n${canonical(order)}`)
    .digest("base64url");
}

export function signedSupervisorRequest(order, secret) {
  const valid = validateBoundOrder(order);
  if (!valid.ok) throw new Error(valid.reason);
  return {
    version: SUPERVISOR_PROTOCOL_VERSION,
    order,
    mac: macFor(order, secret),
  };
}

export function verifySupervisorRequest(request, secret) {
  if (!request || request.version !== SUPERVISOR_PROTOCOL_VERSION || typeof request.mac !== "string") {
    return { ok: false, reason: "invalid supervisor envelope" };
  }
  const valid = validateBoundOrder(request.order);
  if (!valid.ok) return valid;
  let expected;
  try {
    expected = Buffer.from(macFor(request.order, secret));
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const supplied = Buffer.from(request.mac);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "work-order authentication failed" };
  }
  return { ok: true };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe supervisor directory: ${path}`);
  chmodSync(path, 0o700);
}

function syncDir(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableReplace(path, value) {
  ensureDir(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDir(dirname(path));
}

function durableCreate(path, value) {
  ensureDir(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    syncDir(dirname(path));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJson(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe supervisor state file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export class SupervisorStore {
  constructor(root) {
    this.root = root;
    this.ordersDir = join(root, "orders");
    this.runsDir = join(root, "runs");
    this.launchesDir = join(root, "launches");
    this.completionsDir = join(root, "completions");
    ensureDir(this.ordersDir);
    ensureDir(this.runsDir);
    ensureDir(this.launchesDir);
    ensureDir(this.completionsDir);
  }

  paths(attemptId) {
    if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw new Error("invalid attempt id path");
    return {
      order: join(this.ordersDir, `${attemptId}.json`),
      run: join(this.runsDir, `${attemptId}.json`),
      launch: join(this.launchesDir, `${attemptId}.json`),
      completion: join(this.completionsDir, `${attemptId}.json`),
    };
  }

  accept(order, now) {
    const paths = this.paths(order.attempt_id);
    const durableOrder = {
      protocol: SUPERVISOR_PROTOCOL_VERSION,
      order,
      digest: createHash("sha256").update(canonical(order)).digest("hex"),
    };
    const created = durableCreate(paths.order, durableOrder);
    if (!created) {
      const existing = readJson(paths.order);
      if (canonical(existing.order) !== canonical(order)) {
        return { ok: false, stage: "HOLD", reason: "attempt_id is already bound to a different work order" };
      }
    }
    if (!existsSync(paths.run)) {
      durableCreate(paths.run, {
        attempt_id: order.attempt_id,
        issue_id: order.issue_id,
        repo: order.repo,
        branch: order.branch,
        target_sha: order.target_sha,
        status: "accepted",
        accepted_at: now,
      });
    }
    return { ok: true, duplicate: !created, run: this.readRun(order.attempt_id) };
  }

  readOrder(attemptId) {
    return readJson(this.paths(attemptId).order).order;
  }

  readRun(attemptId) {
    return readJson(this.paths(attemptId).run);
  }

  writeRun(attemptId, run) {
    durableReplace(this.paths(attemptId).run, run);
    return run;
  }

  claimLaunch(attemptId, value) {
    return durableCreate(this.paths(attemptId).launch, value);
  }

  markLaunch(attemptId, value) {
    durableReplace(this.paths(attemptId).launch, value);
  }

  readLaunch(attemptId) {
    return readJson(this.paths(attemptId).launch);
  }

  hasLaunch(attemptId) {
    return existsSync(this.paths(attemptId).launch);
  }

  hasCompletion(attemptId) {
    return existsSync(this.paths(attemptId).completion);
  }

  readCompletion(attemptId) {
    return readJson(this.paths(attemptId).completion);
  }

  recordCompletion(completion) {
    const { attempt_id: attemptId, completion_token: token, target_sha: targetSha } = completion ?? {};
    const paths = this.paths(attemptId);
    if (!existsSync(paths.order) || !existsSync(paths.launch)) {
      return { ok: false, reason: "unknown completion attempt" };
    }
    const order = this.readOrder(attemptId);
    const launch = this.readLaunch(attemptId);
    const tokenHash = createHash("sha256").update(String(token ?? "")).digest("hex");
    if (!token || tokenHash !== launch.completion_token_hash || targetSha !== order.target_sha) {
      return { ok: false, reason: "completion binding failed" };
    }
    const exitCode = completion.exit_code;
    if (!(exitCode === null || Number.isInteger(exitCode))) return { ok: false, reason: "invalid completion exit code" };
    if (completion.signal !== null && completion.signal !== undefined && (
      typeof completion.signal !== "string" || completion.signal.length > 32
    )) return { ok: false, reason: "invalid completion signal" };
    if (typeof completion.finished_at !== "string" || !Number.isFinite(Date.parse(completion.finished_at))) {
      return { ok: false, reason: "invalid completion timestamp" };
    }
    const durable = {
      attempt_id: attemptId,
      target_sha: targetSha,
      status: exitCode === 0 ? "completed" : "failed",
      exit_code: exitCode,
      signal: completion.signal ?? null,
      output_bytes: Number.isSafeInteger(completion.output_bytes) && completion.output_bytes >= 0
        ? completion.output_bytes
        : 0,
      finished_at: completion.finished_at,
      completion_token: token,
    };
    const created = durableCreate(paths.completion, durable);
    if (!created && canonical(this.readCompletion(attemptId)) !== canonical(durable)) {
      return { ok: false, reason: "conflicting terminal completion" };
    }
    return { ok: true, duplicate: !created, completion: this.validatedCompletion(attemptId).completion };
  }

  validatedCompletion(attemptId) {
    if (!this.hasCompletion(attemptId) || !this.hasLaunch(attemptId)) {
      return { ok: false, reason: "completion evidence is missing" };
    }
    const stored = this.readCompletion(attemptId);
    const launch = this.readLaunch(attemptId);
    const order = this.readOrder(attemptId);
    const tokenHash = createHash("sha256").update(String(stored.completion_token ?? "")).digest("hex");
    if (!stored.completion_token || tokenHash !== launch.completion_token_hash || stored.target_sha !== order.target_sha) {
      return { ok: false, reason: "durable completion binding failed" };
    }
    const completion = { ...stored };
    delete completion.completion_token;
    return { ok: true, completion };
  }

  attempts() {
    const ids = new Set();
    for (const name of readdirSync(this.ordersDir)) if (name.endsWith(".json")) ids.add(name.slice(0, -5));
    for (const name of readdirSync(this.runsDir)) if (name.endsWith(".json")) ids.add(name.slice(0, -5));
    for (const name of readdirSync(this.completionsDir)) if (name.endsWith(".json")) ids.add(name.slice(0, -5));
    return [...ids].sort();
  }

  repairAccepted(attemptId, now) {
    const paths = this.paths(attemptId);
    if (!existsSync(paths.order) || existsSync(paths.run)) return;
    const order = this.readOrder(attemptId);
    durableCreate(paths.run, {
      attempt_id: attemptId,
      issue_id: order.issue_id,
      repo: order.repo,
      branch: order.branch,
      target_sha: order.target_sha,
      status: "accepted",
      accepted_at: now,
      repaired_after_restart: true,
    });
  }
}

// Called by the worker wrapper with the per-attempt token it received at
// launch. This filesystem path remains available while the daemon is down;
// callers cannot bypass binding validation by writing a result file directly.
export function recordSupervisorCompletion({ stateDir, completion }) {
  return new SupervisorStore(stateDir).recordCompletion(completion);
}

export function supervisorRunOccupiesCapacity(run) {
  return ["accepted", "running", "hold"].includes(run?.status);
}

export class DurableSupervisor {
  constructor({
    stateDir,
    secret,
    spawnWorker,
    now = () => new Date().toISOString(),
    schedule = (fn) => setImmediate(fn),
    probeProcess = () => null,
    processStartToken = (child) => child?.processStartToken ?? null,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  }) {
    assertSecret(secret);
    if (typeof spawnWorker !== "function") throw new Error("spawnWorker is required");
    this.secret = secret;
    this.spawnWorker = spawnWorker;
    this.now = now;
    this.schedule = schedule;
    this.probeProcess = probeProcess;
    this.processStartToken = processStartToken;
    this.maxOutputBytes = maxOutputBytes;
    this.deadlineMs = deadlineMs;
    this.store = new SupervisorStore(stateDir);
    this.children = new Map();
    this.shutdownHolds = new Set();
  }

  async submit(request) {
    const verified = verifySupervisorRequest(request, this.secret);
    if (!verified.ok) return { ok: false, stage: "HOLD", reason: verified.reason };
    const accepted = this.store.accept(request.order, this.now());
    if (!accepted.ok) return accepted;
    const run = accepted.run;
    if (run.status === "accepted" && !this.store.hasLaunch(request.order.attempt_id)) {
      this.schedule(() => void this.launch(request.order.attempt_id));
    }
    return {
      ok: true,
      stage: run.status.toUpperCase(),
      attempt_id: request.order.attempt_id,
      target_sha: request.order.target_sha,
      durable: true,
      duplicate: accepted.duplicate,
    };
  }

  async launch(attemptId) {
    const run = this.store.readRun(attemptId);
    if (run.status !== "accepted") return run;
    const claimed = this.store.claimLaunch(attemptId, {
      attempt_id: attemptId,
      phase: "reserved",
      reserved_at: this.now(),
    });
    if (!claimed) return this.store.readRun(attemptId);

    // This durable marker is deliberately before spawn. If the daemon dies
    // across this boundary, restart holds for inspection instead of risking a
    // duplicate child.
    const completionToken = randomBytes(32).toString("base64url");
    this.store.markLaunch(attemptId, {
      attempt_id: attemptId,
      phase: "spawn_attempted",
      spawn_attempted_at: this.now(),
      completion_token_hash: createHash("sha256").update(completionToken).digest("hex"),
    });

    let child;
    try {
      child = this.spawnWorker(this.store.readOrder(attemptId), {
        attempt_id: attemptId,
        target_sha: this.store.readOrder(attemptId).target_sha,
        completion_token: completionToken,
      });
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) throw new Error("worker returned no pid");
    } catch (error) {
      return this.store.writeRun(attemptId, {
        ...run,
        status: "failed",
        finished_at: this.now(),
        error_code: "SPAWN_FAILED",
        reason: "worker spawn failed",
      });
    }

    const processToken = this.processStartToken(child);
    const identityKnown = typeof processToken === "string" && processToken.length > 0 && processToken.length <= 255;

    const running = this.store.writeRun(attemptId, {
      ...run,
      status: identityKnown ? "running" : "hold",
      pid: child.pid,
      process_token: identityKnown ? processToken : null,
      started_at: this.now(),
      output_bytes: 0,
      ...(!identityKnown ? {
        error_code: "PROCESS_IDENTITY_UNKNOWN",
        reason: "worker started without durable process-start evidence",
      } : {}),
    });
    this.children.set(attemptId, child);
    let terminal = false;
    let outputBytes = 0;

    const finish = (status, details = {}) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(deadline);
      this.children.delete(attemptId);
      if (this.shutdownHolds.delete(attemptId)) return;
      const latest = this.store.readRun(attemptId);
      const completion = {
        attempt_id: attemptId,
        completion_token: completionToken,
        target_sha: latest.target_sha,
        exit_code: status === "completed" ? 0 : (details.exit_code ?? 1),
        signal: details.signal ?? null,
        output_bytes: outputBytes,
        finished_at: this.now(),
      };
      const recorded = status === "hold" ? null : this.store.recordCompletion(completion);
      this.store.writeRun(attemptId, {
        ...this.store.readRun(attemptId),
        status,
        output_bytes: outputBytes,
        finished_at: this.now(),
        ...details,
        ...(recorded?.ok ? { completion_durable: true } : {}),
      });
    };
    const output = (chunk) => {
      if (terminal) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > this.maxOutputBytes) {
        finish("hold", { error_code: "OUTPUT_LIMIT", reason: "worker output exceeded bounded capture" });
        child.kill?.("SIGTERM");
      }
    };
    child.stdout?.on?.("data", output);
    child.stderr?.on?.("data", output);
    child.stdout?.on?.("error", () => finish("hold", { error_code: "OUTPUT_STREAM_ERROR", reason: "worker stdout failed" }));
    child.stderr?.on?.("error", () => finish("hold", { error_code: "OUTPUT_STREAM_ERROR", reason: "worker stderr failed" }));
    child.once?.("error", (error) => finish("failed", { error_code: "WORKER_ERROR", reason: String(error?.message ?? error) }));
    child.once?.("exit", (code, signal) => finish(code === 0 ? "completed" : "failed", {
      exit_code: code,
      signal: signal ?? null,
      ...(code === 0 ? {} : { error_code: "WORKER_EXIT" }),
    }));
    const deadline = setTimeout(() => {
      finish("hold", { error_code: "DEADLINE", reason: "worker exceeded its deadline" });
      child.kill?.("SIGTERM");
    }, this.deadlineMs);
    deadline.unref?.();
    return running;
  }

  recover() {
    const results = [];
    for (const attemptId of this.store.attempts()) {
      this.store.repairAccepted(attemptId, this.now());
      const run = this.store.readRun(attemptId);
      if (this.store.hasCompletion(attemptId)) {
        const validated = this.store.validatedCompletion(attemptId);
        results.push(this.store.writeRun(attemptId, validated.ok ? {
          ...run,
          ...validated.completion,
          completion_durable: true,
          recovered_at: this.now(),
        } : {
          ...run,
          status: "hold",
          error_code: "INVALID_COMPLETION",
          reason: validated.reason,
          recovered_at: this.now(),
        }));
        continue;
      }
      if (run.status === "accepted") {
        if (this.store.hasLaunch(attemptId)) {
          results.push(this.store.writeRun(attemptId, {
            ...run,
            status: "hold",
            recovered_at: this.now(),
            error_code: "AMBIGUOUS_LAUNCH",
            reason: "launch was attempted before restart; refusing duplicate spawn",
          }));
        } else {
          this.schedule(() => void this.launch(attemptId));
          results.push(run);
        }
      } else if (run.status === "running") {
        const alive = this.probeProcess(run);
        if (alive === true) {
          results.push(run);
        } else {
          results.push(this.store.writeRun(attemptId, {
            ...run,
            status: "hold",
            recovered_at: this.now(),
            error_code: alive === false ? "COMPLETION_LOST" : "LIVENESS_UNKNOWN",
            reason: alive === false
              ? "worker ended while supervisor was unavailable; terminal evidence is unknown"
              : "worker identity could not be proven after restart",
          }));
        }
      } else {
        results.push(run);
      }
    }
    return results;
  }

  shutdown({ terminateChildren = false } = {}) {
    for (const [attemptId, child] of this.children) {
      if (!terminateChildren) continue;
      this.store.writeRun(attemptId, {
        ...this.store.readRun(attemptId),
        status: "hold",
        error_code: "SUPERVISOR_SHUTDOWN",
        reason: "supervisor explicitly terminated its child during shutdown",
        shutdown_at: this.now(),
      });
      this.shutdownHolds.add(attemptId);
      child.kill?.("SIGTERM");
    }
  }
}

// Entry point for the bounded one-shot coordinator. Keeping the dispatch check
// outside the transport makes the no-side-effect invariant independently
// testable. `transport` is normally submitToSupervisor.
export async function submitIfDispatchEnabled({ dispatchEnabled, transport, ...request }) {
  if (dispatchEnabled !== true) {
    return { ok: true, stage: "DISABLED", reason: "dispatch disabled; supervisor not contacted" };
  }
  return transport(request);
}

export async function listenSupervisor({
  supervisor,
  socketPath,
  maxRequestBytes = MAX_REQUEST_BYTES,
  serverFactory = (handler) => net.createServer(handler),
  onServerError = () => {},
}) {
  if (existsSync(socketPath)) throw new Error(`supervisor socket already exists: ${socketPath}`);
  ensureDir(dirname(socketPath));
  const server = serverFactory((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let body = "";
    let answered = false;
    const respond = (response) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.on("data", async (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBytes) {
        respond({ ok: false, stage: "HOLD", reason: "supervisor request too large" });
        return;
      }
      const newline = body.indexOf("\n");
      if (newline === -1 || answered) return;
      try {
        respond(await supervisor.submit(JSON.parse(body.slice(0, newline))));
      } catch {
        respond({ ok: false, stage: "HOLD", reason: "invalid supervisor request" });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  server.on("error", onServerError);
  return server;
}

export function submitToSupervisor({ socketPath, request, timeoutMs = 5_000 }) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, stage: "HOLD", reason: "supervisor acknowledgement timed out" }), timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        finish({ ok: false, stage: "HOLD", reason: "supervisor response too large" });
        return;
      }
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(body.slice(0, newline)));
      } catch {
        finish({ ok: false, stage: "HOLD", reason: "invalid supervisor response" });
      }
    });
    socket.on("error", () => finish({ ok: false, stage: "HOLD", reason: "supervisor unavailable; direct spawn is forbidden" }));
  });
}
