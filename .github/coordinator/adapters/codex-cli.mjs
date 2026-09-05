// Codex CLI adapter — subscription-authenticated BUILDER lane (SHU-63 pivot).
//
// Replaces the hosted Workspace Agents lane: Khalid has a PERSONAL ChatGPT
// account, and Workspace Agents (API triggers / access tokens / agtch_...)
// exist only for Enterprise/Business workspaces (verified 2026-09-05 against
// OpenAI help + auth docs). Codex CLI logs in with a personal ChatGPT account
// (`codex login`, device code — headless-safe) and runs non-interactively.
//
// Official contract (verified against the Codex CLI reference and non-interactive docs):
//   codex exec --json --sandbox workspace-write -C <dir> [PROMPT]
//   codex exec resume <SESSION_ID> [PROMPT]      <- resume by EXACT id, NEVER --last
//   --json  -> stdout is JSONL; the FIRST event is {"type":"thread.started","thread_id":"<uuid>"}
//   --output-schema <FILE> -> model's final response constrained to the schema
//   sandbox modes: read-only | workspace-write | danger-full-access
//
// The thread_id IS the durable session identity: it is bound to the attempt via
// external_run_id (`codexrun_<uuid>`) the moment the CLI reports it. Recovery
// resumes with `codex exec resume <exact-thread-id>` only. An uncertain launch
// WITHOUT a durably recorded thread id produces a visible HOLD + adapter pause —
// never another spawn (GPT requirement).

import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { hostname as nodeHostname } from "node:os";
import path from "node:path";

export const ADAPTER_NAME = "codex-cli";
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY"]);
export const CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY", "BLOCKED", "FAILED"]);
const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CALLBACK_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["attempt_id", "target_sha", "stage", "links"],
  properties: {
    attempt_id: { type: "string" },
    target_sha: { type: "string" },
    stage: { type: "string", enum: CALLBACK_STAGES },
    links: { type: "array", items: { type: "string" }, minItems: 1 },
    summary: { type: "string" },
  },
});

const QUOTA_RE = /(?:rate|usage|spending|plan|subscription|credit)[-_ ]?limit|quota|capacity/i;
// Authentication-expiry shapes: 401, expired, invalid token, "please sign in".
// These surface a VISIBLE re-authentication HOLD (GPT requirement), never a
// silent retry loop and never a fabricated upstream failure.
const REAUTH_RE = /(?:401|expired|invalid(?: oauth)? token|authentication|re-?auth|sign ?in|login required)/i;
// Everything else access-shaped (403, forbidden, scope/permission) stays a
// FAILED access error.
const ACCESS_RE = /(?:forbidden|403|unauthori[sz]ed)/i;

// The thread id is stored IN external_run_id (codexrun_<uuid>) so the durable
// receipt alone carries the exact resume target.
export function externalRunId(threadId) {
  return `codexrun_${threadId}`;
}
export function threadIdFromRunId(runId) {
  if (typeof runId === "string" && runId.startsWith("codexrun_")) {
    const id = runId.slice("codexrun_".length);
    return THREAD_ID_RE.test(id) ? id : null;
  }
  return null;
}
export function workerIdentity(attemptId) {
  return `codex:${attemptId}`;
}

// Explicit child environment: allowlist only. OPENAI_API_KEY / OPENAI_BASE_URL
// are deliberately ABSENT so subscription auth (~/.codex/auth.json, created by
// `codex login`) can never be silently replaced by metered credentials.
export function buildCodexEnvironment(parentEnv = {}) {
  const childEnv = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "CI"]) {
    if (typeof parentEnv[key] === "string") childEnv[key] = parentEnv[key];
  }
  return childEnv;
}

export function buildCodexPrompt({ issue_id, authorization_ref, attempt_id, target_sha, task_context }) {
  return [
    "You are the authorized BUILDER for one StudentHub change in an isolated git worktree.",
    `Issue: ${issue_id}`,
    `Authorized contract ref: ${authorization_ref}`,
    `Bound head: ${target_sha}`,
    `Attempt: ${attempt_id}`,
    task_context,
    "The checkout is at the exact bound head. Do NOT merge. Do NOT touch anything outside this worktree.",
    "Implement the change, run the relevant tests, and push the work to the SAME branch as a normal PR.",
    "When finished, your FINAL message must be EXACTLY ONE JSON object matching the provided schema:",
    `{"attempt_id":"${attempt_id}","target_sha":"${target_sha}","stage":"BUILD_READY|REVISION_READY|BLOCKED|FAILED","links":["<PR url or evidence urls>"],"summary":"<short note>"}`,
    "Use BUILD_READY for first-time work, REVISION_READY when addressing review findings on the same branch, BLOCKED only for an in-scope blocker you cannot resolve, FAILED for an upstream/run failure.",
  ].filter(Boolean).join("\n");
}

function buildBaseArgs(input, { schemaFile, cwd }) {
  return [
    "--json",
    "--sandbox", "workspace-write", // GPT: never danger-full-access, never --full-auto
    "-C", cwd,
    "--output-schema", schemaFile,
  ];
}

export function buildCodexArgs(input, { resume = false, sessionId = null, schemaFile, cwd } = {}) {
  const prompt = buildCodexPrompt(input);
  const baseArgs = buildBaseArgs(input, { schemaFile, cwd });
  if (resume) {
    // Resume by EXACT thread id only — --last is forbidden (GPT requirement).
    if (!sessionId || !THREAD_ID_RE.test(sessionId)) {
      throw new Error(`codex resume requires an exact thread id, got: ${String(sessionId)}`);
    }
    return ["exec", ...baseArgs, "resume", sessionId, prompt];
  }
  return ["exec", ...baseArgs, prompt];
}

function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function runSpawn(spawnImpl, file, args, options, onStdoutLine, onSpawn = null, killGraceMs = 30_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(file, args, options);
      onSpawn?.(child);
    } catch (error) {
      child?.kill?.("SIGKILL");
      resolve({ error, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let pending = "";
    let spawnError = null;
    let settled = false;
    let hardTimer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (pending.length) onStdoutLine(pending);
      resolve({ error, stdout, stderr });
    };
    const timer = setTimeout(() => {
      spawnError = Object.assign(new Error("codex process timed out"), { killed: true, signal: "SIGTERM" });
      child.kill?.("SIGTERM");
      hardTimer = setTimeout(() => {
        child.kill?.("SIGKILL");
        finish(spawnError);
      }, killGraceMs);
    }, options.timeout);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onStdoutLine(line, child);
    });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      if (code === 0 && !signal && !spawnError) finish(null);
      else finish(spawnError ?? Object.assign(new Error(`codex exited with code ${String(code)}`), { code, signal, killed: Boolean(signal) }));
    });
  });
}

async function readHead({ cwd, execFileImpl, env }) {
  const result = await runExecFile(execFileImpl, "git", ["rev-parse", "HEAD"], {
    cwd,
    env: buildCodexEnvironment(env),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.stdout.trim();
}

export function parseThreadStarted(stdout) {
  if (typeof stdout !== "string") return null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "thread.started" && THREAD_ID_RE.test(String(event.thread_id ?? ""))) {
        return String(event.thread_id);
      }
    } catch {
      // non-JSONL line — ignore
    }
  }
  return null;
}

export function parseFinalMessage(stdout) {
  // The model's FINAL agent message carries the schema-constrained callback.
  // JSONL events: item.completed with item.type "agent_message" — take the LAST.
  let last = null;
  if (typeof stdout !== "string") return null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string" && event.item.text.trim().length) last = event.item.text;
      }
    } catch {
      // ignore non-JSONL
    }
  }
  return last;
}

export function parseCodexCallback(stdout) {
  const text = parseFinalMessage(stdout);
  if (!text) return null;
  try {
    const callback = JSON.parse(text);
    return callback && typeof callback === "object" ? callback : null;
  } catch {
    return null;
  }
}

export function callbackValid(callback, { attempt_id, target_sha }) {
  if (!callback || typeof callback !== "object") return false;
  if (callback.attempt_id !== attempt_id || callback.target_sha !== target_sha) return false;
  if (!CALLBACK_STAGES.includes(callback.stage)) return false;
  if (!Array.isArray(callback.links) || callback.links.length === 0) return false;
  return callback.links.every((link) => {
    if (typeof link !== "string") return false;
    try {
      return ["http:", "https:"].includes(new URL(link).protocol);
    } catch {
      return false;
    }
  });
}

function failureFrom(error, stdout, stderr, { threadId }) {
  // Only stderr + process metadata classify failures — model stdout (reviewed
  // code can contain "quota"/"capacity") never manufactures an account failure.
  const detail = `${stderr}\n${error?.message ?? ""}`;
  if (QUOTA_RE.test(detail)) {
    return { stage: "FAILED", error_code: "CODEX_QUOTA", error_kind: "quota", pause_adapter: true, ok: false };
  }
  if (REAUTH_RE.test(detail)) {
    // GPT: authentication expiry must surface a VISIBLE re-authentication HOLD.
    return { stage: "HOLD", reason: "Codex authentication expired — re-run `codex login` on the worker host", pause_adapter: true, ok: false };
  }
  if (ACCESS_RE.test(detail)) {
    return { stage: "FAILED", error_code: "CODEX_ACCESS", error_kind: "access", pause_adapter: true, ok: false };
  }
  if (error?.killed || error?.signal) {
    // Killed AFTER the thread id was durably recorded -> LAUNCH_UNKNOWN:
    // recovery resumes the exact session. Killed BEFORE any thread id ->
    // visible HOLD + pause (an uncertain launch must NEVER spawn again).
    if (threadId) {
      return { stage: "LAUNCH_UNKNOWN", external_run_id: externalRunId(threadId), reason: "codex killed after thread.started; session held for exact-id resume", ok: false };
    }
    return { stage: "HOLD", reason: "codex died before any thread id was recorded — refusing to re-spawn", pause_adapter: true, ok: false };
  }
  return { stage: "FAILED", error_code: error?.code ? `CODEX_${error.code}` : "CODEX_PROCESS_FAILED", ok: false };
}

function writeSchemaFile(schemaFile, schema) {
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
}

function stateDirectory(env, io) {
  if (typeof io.codexStateDir === "string" && io.codexStateDir.length) return io.codexStateDir;
  const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, ".codex") : null);
  return codexHome ? path.join(codexHome, "coordinator-runs") : null;
}

function sidecarPath(stateDir, attemptId) {
  return path.join(stateDir, `${attemptId}.json`);
}

function resumeClaimPath(stateDir, attemptId) {
  return path.join(stateDir, `${attemptId}.resume-claim.json`);
}

function resumeOwnerPath(stateDir, attemptId) {
  return path.join(stateDir, `${attemptId}.resume-owner.json`);
}

function readBoundResumeRecord(file, { attempt_id, target_sha, thread_id }) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "invalid", record: null };
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record?.version !== 1 || record?.attempt_id !== attempt_id || record?.target_sha !== target_sha || record?.thread_id !== thread_id) {
      return { status: "invalid", record: null };
    }
    return { status: "valid", record };
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing", record: null } : { status: "invalid", record: null };
  }
}

function writeExclusiveRecord({ stateDir, finalPath, record }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(stateDir, `.${path.basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tempPath, finalPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

function releaseResumeClaim(stateDir, attemptId) {
  for (const file of [resumeOwnerPath(stateDir, attemptId), resumeClaimPath(stateDir, attemptId)]) {
    try { fs.unlinkSync(file); } catch { /* terminal cleanup is best effort */ }
  }
}

export function readDurableSession({ stateDir, attempt_id, target_sha }) {
  return readDurableSessionRecord({ stateDir, attempt_id, target_sha })?.thread_id ?? null;
}

function readDurableSessionRecord({ stateDir, attempt_id, target_sha }) {
  if (!stateDir) return null;
  let record;
  try {
    const file = sidecarPath(stateDir, attempt_id);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (record?.attempt_id !== attempt_id || record?.target_sha !== target_sha || !THREAD_ID_RE.test(String(record?.thread_id ?? ""))) {
    return null;
  }
  return { ...record, thread_id: String(record.thread_id) };
}

function processStartToken(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return afterName[19] || null; // proc(5): field 22 (starttime), after pid/comm
  } catch {
    return null;
  }
}

function recordedProcessState(record, { hostnameImpl = nodeHostname, processStartImpl = processStartToken } = {}) {
  if (!record?.owner_host || !Number.isSafeInteger(record?.child_pid) || !record?.child_start) return "unknown";
  if (record.owner_host !== hostnameImpl()) return "unknown";
  const currentStart = processStartImpl(record.child_pid);
  if (currentStart === null) return "dead";
  return currentStart === record.child_start ? "alive" : "dead";
}

export function persistDurableSession({ stateDir, attempt_id, target_sha, thread_id, owner_host = null, child_pid = null, child_start = null, cleanupTempImpl = fs.unlinkSync }) {
  if (!stateDir || !THREAD_ID_RE.test(thread_id)) throw new Error("durable Codex session path or thread id unavailable");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const finalPath = sidecarPath(stateDir, attempt_id);
  const existing = readDurableSession({ stateDir, attempt_id, target_sha });
  if (existing) {
    if (existing !== thread_id) throw new Error("attempt is already bound to a different Codex thread");
    return finalPath;
  }
  if (fs.existsSync(finalPath)) throw new Error("existing Codex session sidecar is corrupt or has a different binding");
  const tempPath = path.join(stateDir, `.${attempt_id}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, attempt_id, target_sha, thread_id, owner_host, child_pid, child_start })}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tempPath, finalPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const winner = readDurableSession({ stateDir, attempt_id, target_sha });
      if (winner === thread_id) return finalPath;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // The hard-link above is the durability boundary. Temp cleanup is best
    // effort and must never replace either a successful persist or its cause.
    try { cleanupTempImpl(tempPath); } catch { /* best effort */ }
  }
  return finalPath;
}

// `codex exec` is synchronous: launchBuilder returns the terminal CLI result.
// The coordinator still records an acknowledged run using the durable thread id
// before folding the terminal result through the receipt machine.
export async function launchBuilder({
  issue_id,
  authorization_ref,
  attempt_id,
  target_sha,
  task_context,
  cwd = process.cwd(),
  env = process.env,
  resume = false,
  external_run_id = null, // durable receipt run id (codexrun_<uuid>) — exact resume target
  execFileImpl = nodeExecFile,
  spawnImpl = nodeSpawn,
  readHeadImpl = readHead,
  schemaFile = null,
  io = {},
  timeout_ms = 45 * 60 * 1000,
  timeout_grace_ms = 30_000,
}) {
  if (!ATTEMPT_RE.test(attempt_id ?? "") || !SHA_RE.test(target_sha ?? "")) {
    return { stage: "FAILED", error_code: "INVALID_LAUNCH_BINDING", ok: false };
  }
  const execImpl = io.execFileImpl ?? execFileImpl;
  const durableStateDir = stateDirectory(env, io);
  if (!durableStateDir) {
    return { stage: "HOLD", reason: "Codex durable state directory is unavailable — refusing to launch", pause_adapter: true, ok: false };
  }

  // Resume path: the exact thread id comes from the durable receipt run id
  // (codexrun_<uuid>) — never --last.
  let sessionId = null;
  let durableRecord = null;
  if (resume) {
    sessionId = threadIdFromRunId(external_run_id ?? io.resumeRunId ?? "");
    durableRecord = readDurableSessionRecord({ stateDir: durableStateDir, attempt_id, target_sha });
    if (!sessionId) {
      sessionId = durableRecord?.thread_id ?? null;
      if (sessionId) {
        return {
          stage: "LAUNCH_UNKNOWN",
          external_run_id: externalRunId(sessionId),
          worker_identity: workerIdentity(attempt_id),
          adapter_status: "in_progress",
          reason: "recovered the exact Codex thread id; persist it before resume",
          ok: false,
        };
      }
      return { stage: "HOLD", reason: "cannot resume Codex without a durable exact thread id (--last is forbidden)", pause_adapter: true, ok: false };
    }
    if (!durableRecord || durableRecord.thread_id !== sessionId) {
      return { stage: "HOLD", reason: "receipt thread id has no matching durable Codex sidecar — refusing resume", pause_adapter: true, ok: false };
    }
    const processState = recordedProcessState(durableRecord, {
      hostnameImpl: io.hostname ?? nodeHostname,
      processStartImpl: io.processStartToken ?? processStartToken,
    });
    if (processState === "alive") {
      return {
        stage: "LAUNCH_UNKNOWN",
        external_run_id: externalRunId(sessionId),
        worker_identity: workerIdentity(attempt_id),
        adapter_status: "in_progress",
        reason: "original Codex process is still alive; refusing concurrent resume",
        ok: false,
      };
    }
    if (processState !== "dead") {
      return { stage: "HOLD", reason: "Codex process ownership cannot be verified — refusing concurrent resume", pause_adapter: true, ok: false };
    }

    const binding = { attempt_id, target_sha, thread_id: sessionId };
    const existingClaim = readBoundResumeRecord(resumeClaimPath(durableStateDir, attempt_id), binding);
    const owner = readBoundResumeRecord(resumeOwnerPath(durableStateDir, attempt_id), binding);
    if (existingClaim.status !== "missing" || owner.status !== "missing") {
      const ownerState = owner.status === "valid"
        ? recordedProcessState(owner.record, { hostnameImpl: io.hostname ?? nodeHostname, processStartImpl: io.processStartToken ?? processStartToken })
        : "unknown";
      const reason = ownerState === "alive"
        ? "a resumed Codex process is still alive; refusing concurrent resume"
        : "Codex resume ownership is already claimed or unverifiable — refusing concurrent resume";
      return { stage: "HOLD", reason, pause_adapter: true, ok: false };
    }
  }

  let checkoutHead;
  try {
    checkoutHead = await readHeadImpl({ cwd, execFileImpl: execImpl, env });
  } catch {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_UNREADABLE", ok: false };
  }
  if (checkoutHead !== target_sha) {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_MISMATCH", ok: false };
  }

  const input = { issue_id, authorization_ref, attempt_id, target_sha, task_context };
  const schemaPath = schemaFile ?? path.join(durableStateDir, `.callback-schema-${attempt_id}-${randomUUID()}.json`);
  const ownsSchemaFile = schemaFile === null;
  try {
    if (ownsSchemaFile) fs.mkdirSync(durableStateDir, { recursive: true, mode: 0o700 });
    writeSchemaFile(schemaPath, CALLBACK_SCHEMA);
  } catch {
    return { stage: "FAILED", error_code: "SCHEMA_FILE_UNWRITABLE", ok: false };
  }

  let args;
  try {
    args = buildCodexArgs(input, { resume, sessionId, schemaFile: schemaPath, cwd });
  } catch (error) {
    return { stage: "HOLD", reason: error.message, pause_adapter: true, ok: false };
  }

  let result;
  let streamedThreadId = sessionId;
  let durabilityError = null;
  let launchError = null;
  let ownsResumeClaim = false;
  let resumeChildStarted = false;
  let resumeOwnershipError = null;
  if (resume) {
    const binding = { version: 1, kind: "codex-resume-claim", attempt_id, target_sha, thread_id: sessionId };
    try {
      writeExclusiveRecord({ stateDir: durableStateDir, finalPath: resumeClaimPath(durableStateDir, attempt_id), record: binding });
      ownsResumeClaim = true;
    } catch {
      return { stage: "HOLD", reason: "Codex resume ownership was claimed concurrently — refusing duplicate resume", pause_adapter: true, ok: false };
    }
  }
  try {
    const options = {
      cwd,
      env: buildCodexEnvironment(env),
      timeout: timeout_ms,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const onSpawn = resume ? (child) => {
      resumeChildStarted = true;
      try {
        const childPid = Number.isSafeInteger(child?.pid) ? child.pid : null;
        const childStart = childPid ? (io.processStartToken?.(childPid) ?? processStartToken(childPid)) : null;
        if (!childPid || !childStart) throw new Error("resumed Codex child ownership is unavailable");
        writeExclusiveRecord({
          stateDir: durableStateDir,
          finalPath: resumeOwnerPath(durableStateDir, attempt_id),
          record: {
            version: 1,
            kind: "codex-resume-owner",
            attempt_id,
            target_sha,
            thread_id: sessionId,
            owner_host: io.hostname?.() ?? nodeHostname(),
            child_pid: childPid,
            child_start: childStart,
          },
        });
      } catch (error) {
        resumeOwnershipError = error;
        throw error;
      }
    } : null;
    const onLine = (line, child = null) => {
      const threadId = parseThreadStarted(line);
      if (!threadId || streamedThreadId === threadId) return;
      if (streamedThreadId && streamedThreadId !== threadId) {
        durabilityError = new Error("Codex emitted conflicting thread ids");
        return;
      }
      try {
        const childPid = Number.isSafeInteger(child?.pid) ? child.pid : null;
        const childStart = childPid ? (io.processStartToken?.(childPid) ?? processStartToken(childPid)) : null;
        if (childPid && !childStart) throw new Error("Codex child process start token is unavailable");
        persistDurableSession({
          stateDir: durableStateDir,
          attempt_id,
          target_sha,
          thread_id: threadId,
          owner_host: childPid ? (io.hostname?.() ?? nodeHostname()) : null,
          child_pid: childPid,
          child_start: childStart,
        });
        streamedThreadId = threadId;
      } catch (error) {
        durabilityError = error;
      }
    };
    // execFileImpl remains an explicit compatibility seam for deterministic unit
    // tests. Production uses spawn so thread.started is persisted before exit.
    result = execImpl !== nodeExecFile && !io.spawnImpl
      ? await runExecFile(execImpl, "codex", args, { ...options, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      : await runSpawn(io.spawnImpl ?? spawnImpl, "codex", args, options, onLine, onSpawn, timeout_grace_ms);
    if (!streamedThreadId) {
      const bufferedThreadId = parseThreadStarted(result.stdout);
      if (bufferedThreadId) {
        // A failure HERE must reach the durability rule below, not escape to the
        // outer catch. Escaping turned a session that demonstrably EXISTS
        // (thread.started was on the wire) but was never durably recorded into a
        // terminal FAILED with no pause — releasing the slot, letting a fresh
        // attempt be minted, and starting a SECOND codex exec against work that
        // can never be resumed.
        try {
          persistDurableSession({ stateDir: durableStateDir, attempt_id, target_sha, thread_id: bufferedThreadId });
          streamedThreadId = bufferedThreadId;
        } catch (error) {
          durabilityError ??= error;
        }
      }
    }
  } catch (error) {
    // RECORD, never return. Returning here is how the durability rule below was
    // bypassed. One decision point after this block keeps that rule
    // unbypassable instead of restating it in every catch.
    launchError = error;
  } finally {
    if (ownsSchemaFile) {
      // A leftover schema in the private state directory is not an unrecorded
      // session. Cleanup failure must not erase a valid terminal result.
      try { (io.unlinkSync ?? fs.unlinkSync)(schemaPath); } catch { /* best effort */ }
    }
  }
  // A session that demonstrably exists but was never durably recorded outranks
  // every other outcome: it must HOLD and pause, never terminate. FAILED would
  // release the slot, let a fresh attempt be minted, and start a SECOND codex
  // exec against work that can never be resumed.
  if (durabilityError) {
    return { stage: "HOLD", reason: `Codex session could not be durably recorded: ${durabilityError.message}`, pause_adapter: true, ok: false };
  }
  if (resumeOwnershipError) {
    return { stage: "HOLD", reason: `resumed Codex process could not be durably owned: ${resumeOwnershipError.message}`, pause_adapter: true, ok: false };
  }
  if (launchError) {
    if (ownsResumeClaim && !resumeChildStarted) releaseResumeClaim(durableStateDir, attempt_id);
    return failureFrom(launchError, "", "", { threadId: null });
  }
  // Parse the durable session identity from ANY stdout we have — including a
  // stream that ends in a kill: a thread.started already on the wire means the
  // session exists and exact-id resume is legal.
  const threadId = streamedThreadId ?? parseThreadStarted(result.stdout);
  const runId = threadId ? externalRunId(threadId) : null;
  const identity = workerIdentity(attempt_id);
  if (result.error) {
    const failure = failureFrom(result.error, result.stdout, result.stderr, { threadId });
    return failure.stage === "LAUNCH_UNKNOWN" && runId
      ? { ...failure, external_run_id: runId, worker_identity: identity, adapter_status: "in_progress" }
      : failure;
  }

  if (!threadId) {
    // Exited cleanly but the durable session identity is missing: the work may
    // exist in an unknown session we cannot resume — visible HOLD + pause.
    return { stage: "HOLD", reason: "codex exited without a thread.started event — no durable session id; refusing to re-spawn", pause_adapter: true, ok: false };
  }

  const callback = parseCodexCallback(result.stdout);
  if (!callbackValid(callback, { attempt_id, target_sha })) {
    return { stage: "HOLD", external_run_id: runId, worker_identity: identity, adapter_status: "completed", reason: "completed without a valid attempt/SHA-bound schema callback", ok: false };
  }
  if (!SUCCESS_CALLBACK_STAGES.includes(callback.stage)) {
    return { stage: "HOLD", external_run_id: runId, worker_identity: identity, adapter_status: "completed", callback, evidence_links: callback.links, reason: `builder returned ${callback.stage}`, ok: false };
  }
  // Keep resume ownership after any child actually started. The caller has not
  // durably persisted this terminal outcome yet, so deleting the claim here
  // would let a coordinator holding a stale receipt launch another resume in
  // that commit window. Attempt ids are immutable; the retained record is a
  // safe tombstone once the terminal receipt is stored.
  return { stage: "COMPLETED", external_run_id: runId, worker_identity: identity, adapter_status: "completed", callback, evidence_links: callback.links, ok: true };
}

// A synchronous `codex exec` has no remote polling endpoint. RUNNING/held
// receipts are resolved by the synchronous result or explicit exact-id resume.
export async function monitorRun() {
  return { stage: "UNCHANGED", reason: "Codex print-mode runs have no remote poll endpoint; state held for explicit exact-id recovery" };
}
