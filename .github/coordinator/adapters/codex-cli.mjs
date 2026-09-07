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
import { hostname as nodeHostname, platform as nodePlatform } from "node:os";
import * as nodePath from "node:path";
import { pushExactSha } from "../push-broker.mjs";
const path = nodePath;

export const ADAPTER_NAME = "codex-cli";
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY"]);
export const CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY", "BLOCKED", "FAILED"]);
const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CALLBACK_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["attempt_id", "target_sha", "result_sha", "stage", "links", "summary"],
  properties: {
    attempt_id: { type: "string" },
    target_sha: { type: "string" },
    result_sha: { type: "string" },
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
    "Implement the change and commit it locally (git add + git commit) so the worktree HEAD holds your exact result. Run the relevant tests. Do NOT push, do NOT open a PR, do NOT touch the network — a separate host-side broker pushes your exact result commit after validation.",
    "When finished, your FINAL message must be EXACTLY ONE JSON object matching the provided schema:",
    `{"attempt_id":"${attempt_id}","target_sha":"${target_sha}","result_sha":"<git rev-parse HEAD after your commit>","stage":"BUILD_READY|REVISION_READY|BLOCKED|FAILED","links":["<evidence: test names or file paths you touched; you have no network, so a URL is not expected>"],"summary":"<short note>"}`,
    "Use BUILD_READY for first-time work, REVISION_READY when addressing review findings on the same branch, BLOCKED only for an in-scope blocker you cannot resolve, FAILED for an upstream/run failure. result_sha must be the exact commit you created — a host broker pushes precisely that SHA, never your branch tip or any uncommitted state.",
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

function runSpawn(spawnImpl, file, args, options, onStdoutLine, onSpawn = null, killGraceMs = 30_000, maxOutputBytes = 32 * 1024 * 1024) {
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
    let outputBytes = 0;
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
    const accountOutput = (chunk) => {
      if (spawnError?.code === "CODEX_OUTPUT_LIMIT") return false;
      outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
      if (outputBytes <= maxOutputBytes) return true;
      spawnError = Object.assign(new Error(`codex output exceeded ${maxOutputBytes} bytes`), {
        code: "CODEX_OUTPUT_LIMIT",
        killed: true,
        signal: "SIGTERM",
      });
      child.kill?.("SIGTERM");
      hardTimer ??= setTimeout(() => {
        child.kill?.("SIGKILL");
        finish(spawnError);
      }, killGraceMs);
      return false;
    };
    child.stdout?.on("data", (chunk) => {
      if (!accountOutput(chunk)) return;
      const text = String(chunk);
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onStdoutLine(line, child);
    });
    child.stderr?.on("data", (chunk) => {
      if (accountOutput(chunk)) stderr += String(chunk);
    });
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

async function headDescendsFromTarget({ cwd, execFileImpl, env, target_sha }) {
  const result = await runExecFile(execFileImpl, "git", ["merge-base", "--is-ancestor", target_sha, "HEAD"], {
    cwd,
    env: buildCodexEnvironment(env),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return !result.error;
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

// The broker is the ONLY authorized pusher, so it runs unless a caller
// EXPLICITLY opts out. Deriving "enabled" from a flag that had to be PRESENT
// meant an omission produced a COMPLETED with nothing pushed. One definition,
// because two copies drift and the launch-time check and the push-time check
// must never disagree about whether the broker is in play.
export function brokerOptedOut(io = {}, env = {}) {
  return io.pushBrokerEnabled === false || env.SHU_PUSH_BROKER_ENABLED === "false";
}

export function callbackValid(callback, { attempt_id, target_sha }) {
  if (!callback || typeof callback !== "object") return false;
  if (callback.attempt_id !== attempt_id || callback.target_sha !== target_sha) return false;
  if (!SHA_RE.test(callback.result_sha ?? "")) return false;
  if (!CALLBACK_STAGES.includes(callback.stage)) return false;
  if (!Array.isArray(callback.links) || callback.links.length === 0) return false;
  // Option A removed the worker's ability to produce an http(s) URL: it never
  // pushes, never opens a PR, and has no network. Requiring one made the
  // callback unsatisfiable for a COMPLIANT worker, so validation always failed
  // and the broker could never run (Sentry 16535525/1 — real, and it would have
  // surfaced on the first live fixture rather than in any mocked test).
  //
  // Evidence is still required, and anything that IS a URL must still be
  // http(s): these strings are rendered into Linear and GitHub comments, so a
  // file:, data: or javascript: link must never be accepted.
  return callback.links.every((link) => {
    if (typeof link !== "string") return false;
    const trimmed = link.trim();
    if (trimmed.length === 0 || trimmed.length > 512) return false;
    try {
      return ["http:", "https:"].includes(new URL(trimmed).protocol);
    } catch {
      return true; // a plain evidence reference, e.g. a test name or path
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
  if (error?.code === "CODEX_OUTPUT_LIMIT") {
    if (threadId) {
      return { stage: "LAUNCH_UNKNOWN", external_run_id: externalRunId(threadId), reason: "Codex output exceeded the bounded capture limit after thread.started — session held for exact-id recovery", pause_adapter: true, ok: false };
    }
    return { stage: "HOLD", reason: "Codex output exceeded the bounded capture limit — worker stopped to protect the coordinator", pause_adapter: true, ok: false };
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

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusiveRecord({ stateDir, finalPath, record, fsyncDirectoryImpl = fsyncDirectory }) {
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
    // fsyncing the file does not make its new directory entry reboot-durable.
    // The claim is authoritative only after the parent directory is synced.
    fsyncDirectoryImpl(stateDir);
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
  if (record?.version !== 1 || record?.attempt_id !== attempt_id || record?.target_sha !== target_sha || !THREAD_ID_RE.test(String(record?.thread_id ?? ""))) {
    return null;
  }
  return { ...record, thread_id: String(record.thread_id) };
}

function parseProcessStatToken(stat, expectedPid = null) {
  if (typeof stat !== "string") throw new Error("process metadata is not text");
  if (expectedPid === null) {
    if (!/^[1-9]\d* \(/.test(stat)) throw new Error("malformed process metadata PID");
  } else if (!stat.startsWith(`${expectedPid} (`)) {
    throw new Error("process metadata PID mismatch");
  }
  const openPrefixLength = expectedPid === null ? stat.indexOf("(") + 1 : `${expectedPid} (`.length;
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < openPrefixLength || stat.slice(closeParen, closeParen + 2) !== ") ") {
    throw new Error("malformed process metadata header");
  }
  const afterName = stat.slice(closeParen + 2).trim().split(/\s+/);
  if (afterName.length < 20 || !/^[RSDZTtXxKWPI]$/.test(afterName[0])) {
    throw new Error("malformed process metadata fields");
  }
  if (!afterName.slice(1, 19).every((value) => /^-?\d+$/.test(value))) {
    throw new Error("malformed process metadata fields");
  }
  const token = afterName[19];
  if (!validProcessStartToken(token)) throw new Error("malformed process start token");
  return token;
}

function processStartToken(pid, readFileImpl = fs.readFileSync, platformImpl = nodePlatform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process id");
  // /proc/<pid>/stat is a Linux identity primitive. On an unsupported host,
  // ENOENT means “there is no procfs path,” not “this PID definitely exited.”
  if (platformImpl() !== "linux") throw new Error("process identity is unavailable on this platform");
  let stat;
  try {
    stat = readFileImpl(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    // ENOENT on a per-PID path proves that PID is gone ONLY when procfs itself
    // is present and readable. With no /proc mounted, a restricted mount
    // namespace, or a chroot, EVERY per-pid read returns ENOENT — so without
    // this probe every recorded child reads as dead and a LIVE Codex child can
    // be resumed concurrently. The platform gate does not cover it: the
    // platform IS linux. /proc/self/stat is the right probe because it must
    // exist on any working procfs and stays readable under hidepid, which
    // hides other processes but never your own.
    if (error?.code !== "ENOENT") throw error;
    let selfStat;
    try {
      selfStat = readFileImpl("/proc/self/stat", "utf8");
    } catch (probeError) {
      throw new Error(`procfs is unavailable, so a missing /proc/${pid} is not proof of death: ${probeError?.code ?? probeError?.message ?? "unknown"}`);
    }
    try { parseProcessStatToken(selfStat); }
    catch { throw new Error("procfs did not return a usable record, so a missing PID path is not proof of death"); }
    return null;
  }
  return parseProcessStatToken(stat, pid);
}

function validProcessStartToken(value) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function recordedProcessState(record, { hostnameImpl = nodeHostname, processStartImpl = processStartToken } = {}) {
  if (
    typeof record?.owner_host !== "string" || record.owner_host.length === 0
    || !Number.isSafeInteger(record?.child_pid) || record.child_pid <= 0
    || !validProcessStartToken(record?.child_start)
  ) return "unknown";
  let currentHost;
  let currentStart;
  try {
    currentHost = hostnameImpl();
    if (record.owner_host !== currentHost) return "unknown";
    currentStart = processStartImpl(record.child_pid);
  } catch {
    return "unknown";
  }
  if (currentStart === null) return "dead";
  if (!validProcessStartToken(currentStart)) return "unknown";
  return currentStart === record.child_start ? "alive" : "dead";
}

export function persistDurableSession({ stateDir, attempt_id, target_sha, thread_id, owner_host = null, child_pid = null, child_start = null, cleanupTempImpl = fs.unlinkSync, fsyncDirectoryImpl = fsyncDirectory }) {
  if (!stateDir || !THREAD_ID_RE.test(thread_id)) throw new Error("durable Codex session path or thread id unavailable");
  const hasOwnership = owner_host !== null || child_pid !== null || child_start !== null;
  if (hasOwnership && (
    typeof owner_host !== "string" || owner_host.length === 0
    || !Number.isSafeInteger(child_pid) || child_pid <= 0
    || !validProcessStartToken(child_start)
  )) throw new Error("durable Codex process ownership is malformed");
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
    // The hard link is atomic but not durable across power loss until the
    // containing directory is synced. Without this, the thread can exist
    // upstream while its only exact-id recovery binding disappears on reboot.
    fsyncDirectoryImpl(stateDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const winner = readDurableSession({ stateDir, attempt_id, target_sha });
      if (winner === thread_id) return finalPath;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // The hard-link plus directory fsync above is the durability boundary. Temp cleanup is best
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
  verifyDescendantImpl = headDescendsFromTarget,
  schemaFile = null,
  io = {},
  branch = null,
  repo = null,
  pushBrokerImpl = null,
  timeout_ms = 45 * 60 * 1000,
  timeout_grace_ms = 30_000,
  max_output_bytes = 32 * 1024 * 1024,
}) {
  if (!ATTEMPT_RE.test(attempt_id ?? "") || !SHA_RE.test(target_sha ?? "")) {
    return { stage: "FAILED", error_code: "INVALID_LAUNCH_BINDING", ok: false };
  }
  const execImpl = io.execFileImpl ?? execFileImpl;
  const durableStateDir = stateDirectory(env, io);
  const processStartImpl = io.processStartToken
    ?? ((pid) => processStartToken(pid, io.readProcessStat ?? fs.readFileSync, io.platform ?? nodePlatform));
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
      processStartImpl,
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
        ? recordedProcessState(owner.record, { hostnameImpl: io.hostname ?? nodeHostname, processStartImpl })
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
  let checkoutIsBound = checkoutHead === target_sha;
  if (!checkoutIsBound && resume) {
    try {
      checkoutIsBound = await verifyDescendantImpl({ cwd, execFileImpl: execImpl, env, target_sha });
    } catch {
      checkoutIsBound = false;
    }
  }
  if (!checkoutIsBound) {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_MISMATCH", ok: false };
  }

  const input = { issue_id, authorization_ref, attempt_id, target_sha, task_context, branch, repo };
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
      writeExclusiveRecord({ stateDir: durableStateDir, finalPath: resumeClaimPath(durableStateDir, attempt_id), record: binding, fsyncDirectoryImpl: io.fsyncDirectory });
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
        const childStart = childPid ? processStartImpl(childPid) : null;
        if (!childPid || !validProcessStartToken(childStart)) throw new Error("resumed Codex child ownership is unavailable");
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
          fsyncDirectoryImpl: io.fsyncDirectory,
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
        const childStart = childPid ? processStartImpl(childPid) : null;
        if (childPid && !validProcessStartToken(childStart)) throw new Error("Codex child process start token is unavailable");
        persistDurableSession({
          stateDir: durableStateDir,
          attempt_id,
          target_sha,
          thread_id: threadId,
          owner_host: childPid ? (io.hostname?.() ?? nodeHostname()) : null,
          child_pid: childPid,
          child_start: childStart,
          fsyncDirectoryImpl: io.fsyncDirectory,
        });
        streamedThreadId = threadId;
      } catch (error) {
        durabilityError = error;
      }
    };
    // execFileImpl remains an explicit compatibility seam for deterministic unit
    // tests. Production uses spawn so thread.started is persisted before exit.
    // The builder runs through the privilege-drop wrapper when one is
    // configured, so it does NOT inherit the coordinator's OS identity. That is
    // the boundary the push broker's isolation depends on: a same-uid worker can
    // write the broker's own repository after createBrokerRepo() returns and
    // redirect the push, which an independent verifier reproduced at `abe816a`.
    // activation.mjs refuses dispatch when the wrapper or SHU_WORKER_UID is
    // missing — but activation runs in main(), and launchBuilder is exported.
    // This comment used to end "so reaching here unwrapped means the broker is
    // disabled", which was an ASSUMPTION where a check belonged: a direct caller
    // with broker config and no wrapper would run codex as the coordinator and
    // then hand the credentialed broker its result (CodeRabbit). That is the
    // same fail-closed gap this adapter already fixed once for the broker
    // opt-out, and the mechanism must refuse on its own rather than trusting a
    // gate somewhere upstream.
    const wrapper = (env.SHU_WORKER_LAUNCH_WRAPPER ?? "").trim();
    if (!brokerOptedOut(io, env) && !wrapper) {
      return { stage: "HOLD", pause_adapter: true, ok: false,
        reason: "push broker enabled but SHU_WORKER_LAUNCH_WRAPPER is unset — refusing to run the builder under the coordinator's OS identity" };
    }
    const [launchBin, launchArgs] = wrapper
      ? [wrapper.split(/\s+/)[0], [...wrapper.split(/\s+/).slice(1), "codex", ...args]]
      : ["codex", args];
    result = execImpl !== nodeExecFile && !io.spawnImpl
      ? await runExecFile(execImpl, launchBin, launchArgs, { ...options, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      : await runSpawn(io.spawnImpl ?? spawnImpl, launchBin, launchArgs, options, onLine, onSpawn, timeout_grace_ms, max_output_bytes);
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
          persistDurableSession({ stateDir: durableStateDir, attempt_id, target_sha, thread_id: bufferedThreadId, fsyncDirectoryImpl: io.fsyncDirectory });
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

  // OPTION A (ratified 2026-09-07): the sandboxed worker never pushes. The
  // host-side broker pushes ONLY the validated exact callback SHA. The adapter
  // process runs on the host under the coordinator identity (deploy-key owner),
  // so this is the correct seam.
  //
  // Broker is opt-in: it is enabled ONLY when dispatch is being exercised
  // (io.pushBrokerEnabled or SHU_PUSH_BROKER_ENABLED). In deterministic /
  // contract-test / dry-run mode (dispatch off) the adapter returns COMPLETED
  // unchanged — nothing launched, so there is nothing to push. In REAL dispatch
  // the broker is MANDATORY and fails closed: a builder result that was never
  // pushed is not a usable COMPLETED, and the sandbox cannot push by itself.
  if (callback.result_sha && SHA_RE.test(String(callback.result_sha))) {
    // FAIL CLOSED (Opus R3). The broker is the ONLY authorized pusher, so it
    // runs unless a caller EXPLICITLY opts out. Deriving "enabled" from a flag
    // that had to be PRESENT meant an omission produced a COMPLETED with nothing
    // pushed — the exact outcome this broker exists to prevent — and no test
    // bound it: forcing the flag off left 288/288 green. An opt-out cannot be
    // reached by forgetting something.
    if (!brokerOptedOut(io, env)) {
      const runBroker = pushBrokerImpl ?? io.pushBrokerImpl ?? pushExactSha;
      const allowedRoot = io.worktreeRoot ?? env.SHU_WORKTREE_ROOT ?? null;
      const remoteUrl = io.pushRemoteUrl ?? env.SHU_PUSH_REMOTE_URL ?? null;
      const branchPrefix = io.laneBranchPrefix ?? env.SHU_LANE_BRANCH_PREFIX ?? "coordinator/";
      if (!allowedRoot || !remoteUrl) {
        return { stage: "HOLD", external_run_id: runId, worker_identity: identity, adapter_status: "completed",
          callback, evidence_links: callback.links,
          reason: "push broker enabled but not configured (SHU_WORKTREE_ROOT, SHU_PUSH_REMOTE_URL) — HOLD + pause; no PUSH from the sandbox",
          pause_adapter: true, ok: false };
      }
      const push = await runBroker({
        stateDir: durableStateDir,
        attempt_id,
        result_sha: callback.result_sha,
        target_sha,
        branch: input.branch ?? env.DISPATCH_BRANCH ?? `coordinator/${issue_id}`,
        repo: input.repo ?? "BAWES-Universe/studenthub-platform",
        worktree: cwd,
        allowedRoot,
        branchPrefix,
        remoteUrl,
        // `gitImpl` was undefined here: a ReferenceError crashed the configured
        // success path instead of returning a controlled result (Codex R3).
        // It must be the REAL git executor — NOT execFileImpl, which tests
        // substitute with the codex CLI double, and which would hand the broker
        // codex JSONL where it expects git output.
        gitImpl: io.brokerGitImpl ?? nodeExecFile,
        env,
        io,
      });
      if (push.ok !== true) {
        return { stage: "HOLD", external_run_id: runId, worker_identity: identity, adapter_status: "completed",
          callback, evidence_links: callback.links,
          reason: `push broker did not confirm result commit: ${push.reason ?? "unknown"}`, pause_adapter: true, ok: false };
      }
      if (!callback.links) callback.links = [];
      callback.links = [...callback.links, `pushed:${push.remote_head ?? callback.result_sha}@${push.stage ?? "PUSHED"}`];
    }
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
