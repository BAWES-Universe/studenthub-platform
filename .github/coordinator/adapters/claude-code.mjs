// Claude Code adapter — subscription-authenticated verifier lane.
//
// Official contract references (checked 2026-09-05):
//   https://code.claude.com/docs/en/cli-reference
//   https://code.claude.com/docs/en/github-actions
//
// The adapter deliberately uses execFile (never a shell), `claude -p`, JSON
// output, and a caller-supplied UUID as the Claude session id. Authentication is
// exclusively CLAUDE_CODE_OAUTH_TOKEN. Metered API credentials are stripped
// from the child environment even when they exist in the coordinator process.

import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runReviewEvidence, sensitiveEnvironmentValues } from "../review-execution.mjs";

export const ADAPTER_NAME = "claude-code";
export const CLAUDE_MODEL = "opus";
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["PASS"]);
export const CALLBACK_STAGES = Object.freeze(["PASS", "BLOCKED", "FAILED"]);
const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const TOKEN_SHAPE_RE = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/;

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
// Authentication-expiry shapes (401, expired, invalid token, auth failures):
// these map to a visible re-authentication HOLD, never a silent retry.
const REAUTH_RE = /(?:401|expired|invalid(?: oauth)? token|authentication|re-?auth|sign ?in|login required)/i;
// Non-auth access shapes (403, forbidden) stay FAILED + access.
const ACCESS_RE = /(?:forbidden|403|unauthori[sz]ed)/i;

export function externalRunId(attemptId) {
  return `clauderun_${attemptId.replaceAll("-", "")}`;
}

export function workerIdentity(attemptId) {
  return `claude:${attemptId}`;
}

// Build an explicit child environment. API credentials and alternate API
// endpoints are removed so a stale host setting cannot silently switch this
// subscription lane to metered billing.
export function buildClaudeEnvironment(parentEnv = {}, oauthToken = "") {
  const childEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "CI"]) {
    if (typeof parentEnv[key] === "string") childEnv[key] = parentEnv[key];
  }
  if (oauthToken) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return childEnv;
}

export function buildClaudePrompt({ issue_id, authorization_ref, attempt_id, target_sha, task_context }) {
  return [
    "You are the independent verifier for an authorized StudentHub change.",
    `Issue: ${issue_id}`,
    `Authorized contract ref: ${authorization_ref}`,
    `Bound head: ${target_sha}`,
    `Attempt: ${attempt_id}`,
    task_context,
    "Review and test the exact bound head. Do not merge.",
    "The coordinator already executed the bound test command through its confined reviewer evidence runner. Inspect the supplied evidence reference; do not execute commands yourself.",
    "You are read-only. If you find an in-scope defect, return BLOCKED with exact diagnostics and evidence so the independent author can revise it. Do not edit, commit, or push.",
    "Return the required structured callback. PASS is allowed only with evidence links at this exact head; otherwise return BLOCKED or FAILED.",
  ].filter(Boolean).join("\n");
}

export function buildClaudeArgs(input, { resume = false } = {}) {
  const sessionFlag = resume ? "--resume" : "--session-id";
  return [
    "-p",
    "--model", CLAUDE_MODEL,
    "--output-format", "json",
    "--json-schema", JSON.stringify(CALLBACK_SCHEMA),
    // `--restricted` keeps subscription OAuth available while disabling every
    // customization source and confining file tools to the exact cwd. `--bare`
    // must not return: it deliberately ignores the subscription login.
    "--restricted",
    "--disable-slash-commands",
    "--tools", "Read,Glob,Grep",
    // --tools constrains built-ins only. MCP tools have their own namespace and
    // therefore need both an empty strict config and an explicit deny pattern.
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--permission-mode", "dontAsk",
    sessionFlag, input.attempt_id,
    buildClaudePrompt(input),
  ];
}

function privateEvidenceDirectory(dir, { fsImpl = fs, ownUid = process.getuid?.() } = {}) {
  if (!path.isAbsolute(dir ?? "")) throw new Error("review evidence directory must be absolute");
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== ownUid) {
    throw new Error("review evidence directory must be coordinator-owned and private (0700)");
  }
  const resolved = fsImpl.realpathSync(dir);
  if (resolved !== path.resolve(dir)) throw new Error("review evidence directory must not resolve through a symlink");
  return resolved;
}

function reserveEnvelopePath(dir, attemptId, fsImpl = fs) {
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const candidate = path.join(dir, `${attemptId}.claude-envelope.${sequence}.stdout`);
    try {
      return { path: candidate, fd: fsImpl.openSync(candidate, "wx", 0o600) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("review envelope artifact sequence exhausted");
}

export function persistClaudeEnvelope({ stdout, attempt_id, evidence_dir, env = {}, fsImpl = fs, ownUid = process.getuid?.() }) {
  const bytes = Buffer.from(String(stdout ?? ""));
  if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error("review envelope exceeds the size limit");
  const text = bytes.toString("utf8");
  if (TOKEN_SHAPE_RE.test(text) || sensitiveEnvironmentValues(env).some((secret) => text.includes(secret))) {
    throw new Error("review envelope contains credential-shaped or environment-secret material");
  }
  const dir = privateEvidenceDirectory(evidence_dir, { fsImpl, ownUid });
  const reserved = reserveEnvelopePath(dir, attempt_id, fsImpl);
  try { fsImpl.writeFileSync(reserved.fd, bytes); }
  finally { fsImpl.closeSync(reserved.fd); }
  fsImpl.chmodSync(reserved.path, 0o600);
  const retained = fsImpl.readFileSync(reserved.path);
  if (!retained.equals(bytes)) throw new Error("review envelope verification failed");
  return { path: reserved.path, link: pathToFileURL(reserved.path).href, size: bytes.length };
}

function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function readHead({ cwd, execFileImpl, env }) {
  const result = await runExecFile(execFileImpl, "git", ["-c", `safe.directory=${cwd}`, "rev-parse", "HEAD"], {
    cwd,
    env: buildClaudeEnvironment(env),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.stdout.trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseClaudeCallback(stdout) {
  const envelope = parseJson(stdout);
  if (!envelope || typeof envelope !== "object") return { envelope: null, callback: null, reason_code: "INVALID_ENVELOPE_JSON" };
  if (envelope.structured_output && typeof envelope.structured_output === "object") {
    return { envelope, callback: envelope.structured_output, reason_code: null };
  }
  if (typeof envelope.result === "string") {
    const callback = parseJson(envelope.result.trim());
    if (callback) return { envelope, callback, reason_code: null };
  }
  return { envelope, callback: null, reason_code: "NO_STRUCTURED_OUTPUT" };
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

function failureFrom(error, stdout, stderr) {
  // Do not classify arbitrary model stdout as an account failure: reviewed code
  // can legitimately contain words like "quota" or "capacity".
  const detail = `${stderr}\n${error?.message ?? ""}`;
  if (QUOTA_RE.test(detail)) {
    return { stage: "FAILED", error_code: "CLAUDE_QUOTA", error_kind: "quota", pause_adapter: true, ok: false };
  }
  if (REAUTH_RE.test(detail)) {
    // GPT 2026-09-05: authentication expiry must surface a VISIBLE
    // re-authentication HOLD — never a silent retry or a fabricated failure.
    return { stage: "HOLD", reason: "Claude authentication expired or invalid — re-run `claude setup-token` on the worker host", pause_adapter: true, ok: false };
  }
  if (ACCESS_RE.test(detail)) {
    return { stage: "FAILED", error_code: "CLAUDE_ACCESS", error_kind: "access", pause_adapter: true, ok: false };
  }
  if (error?.killed || error?.signal) {
    return { stage: "LAUNCH_UNKNOWN", reason: "Claude process ended without a trustworthy terminal result; session is held for resume", ok: false };
  }
  return { stage: "FAILED", error_code: error?.code ? `CLAUDE_${error.code}` : "CLAUDE_PROCESS_FAILED", ok: false };
}

// Claude `-p` is synchronous: launchBuilder returns the terminal CLI result.
// The coordinator still records an acknowledged run using the deterministic
// session id before folding this terminal result through the receipt machine.
export async function launchBuilder({
  issue_id,
  authorization_ref,
  attempt_id,
  target_sha,
  task_context,
  oauth_token,
  cwd = process.cwd(),
  env = process.env,
  resume = false,
  execFileImpl = nodeExecFile,
  readHeadImpl = readHead,
  reviewEvidenceImpl = runReviewEvidence,
  persistEnvelopeImpl = persistClaudeEnvelope,
  io = {},
  timeout_ms = 30 * 60 * 1000,
}) {
  if (!ATTEMPT_RE.test(attempt_id ?? "") || !SHA_RE.test(target_sha ?? "")) {
    return { stage: "FAILED", error_code: "INVALID_LAUNCH_BINDING", ok: false };
  }
  if (!oauth_token) {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
      return { stage: "FAILED", error_code: "API_KEY_REJECTED", error_kind: "access", pause_adapter: true, ok: false };
    }
    return { stage: "LAUNCH_UNKNOWN", reason: "no CLAUDE_CODE_OAUTH_TOKEN (subscription auth required)", ok: false };
  }

  let checkoutHead;
  try {
    checkoutHead = await readHeadImpl({ cwd, execFileImpl, env });
  } catch {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_UNREADABLE", ok: false };
  }
  if (checkoutHead !== target_sha) {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_MISMATCH", ok: false };
  }

  const reviewEvidence = await reviewEvidenceImpl({ attempt_id, target_sha, cwd, env });
  const auditEvidenceLinks = reviewEvidence?.evidence_link ? [reviewEvidence.evidence_link] : [];
  if (reviewEvidence?.executed !== true || !reviewEvidence.evidence_link) {
    return {
      stage: "HOLD",
      pause_adapter: true,
      reason_code: "REVIEW_EXECUTION_UNAVAILABLE",
      reason: "REVIEW_EXECUTION_UNAVAILABLE — confined exact-head test execution was not proven; no reviewer launched",
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: ["review execution proof: REVIEW_EXECUTION_UNAVAILABLE"],
      ok: false,
    };
  }

  const input = {
    issue_id,
    authorization_ref,
    attempt_id,
    target_sha,
    task_context: [
      task_context,
      `Confined exact-head test evidence: ${reviewEvidence.evidence_link}`,
      `Confined test result: ${reviewEvidence.passed ? "PASS" : "FAIL"}`,
    ].filter(Boolean).join("\n"),
  };
  const args = buildClaudeArgs(input, { resume });
  let result;
  try {
    result = await runExecFile(execFileImpl, "claude", args, {
      cwd,
      env: buildClaudeEnvironment(env, oauth_token),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeout_ms,
      windowsHide: true,
    });
  } catch (error) {
    return failureFrom(error, "", "");
  }
  let envelope = null;
  const auditNotes = [`review execution proof: ${reviewEvidence.reason_code}`];
  try {
    envelope = persistEnvelopeImpl({
      stdout: result.stdout,
      attempt_id,
      evidence_dir: env.SHU_REVIEW_EVIDENCE_DIR,
      // The prompt context can contain issue-supplied secrets. Give it a
      // sensitivity-marked key so the same value scanner that protects host
      // credentials also rejects prompt material from the retained envelope.
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: oauth_token, SHU_REVIEW_PROMPT_SECRET: task_context },
    });
    auditEvidenceLinks.push(envelope.link);
  } catch (error) {
    const note = `review envelope retention: ENVELOPE_RETENTION_FAILED (${error?.message ?? "unknown"})`;
    auditNotes.push(note);
    if (io.stdout) io.stdout(note);
  }
  if (result.error) {
    return { ...failureFrom(result.error, result.stdout, result.stderr), audit_evidence_links: auditEvidenceLinks, audit_notes: auditNotes };
  }

  const parsed = parseClaudeCallback(result.stdout);
  const identity = workerIdentity(attempt_id);
  const runId = externalRunId(attempt_id);
  if (parsed.envelope?.is_error === true || parsed.reason_code === "INVALID_ENVELOPE_JSON") {
    return {
      stage: "FAILED",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "failed",
      error_code: parsed.reason_code === "INVALID_ENVELOPE_JSON" ? "INVALID_ENVELOPE_JSON" : "CLAUDE_INVALID_RESULT",
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  if (parsed.envelope.session_id && parsed.envelope.session_id !== attempt_id) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      reason_code: "CALLBACK_BINDING_INVALID",
      reason: "CALLBACK_BINDING_INVALID — Claude returned a different session id than the bound attempt",
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  if (parsed.reason_code === "NO_STRUCTURED_OUTPUT") {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      reason_code: "NO_STRUCTURED_OUTPUT",
      reason: "NO_STRUCTURED_OUTPUT — Claude completed without structured callback output",
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  if (!callbackValid(parsed.callback, { attempt_id, target_sha })) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      reason_code: "CALLBACK_BINDING_INVALID",
      reason: "CALLBACK_BINDING_INVALID — structured callback failed attempt/head/stage/evidence binding",
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  if (!SUCCESS_CALLBACK_STAGES.includes(parsed.callback.stage)) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      callback: parsed.callback,
      evidence_links: parsed.callback.links,
      reason: `verifier returned ${parsed.callback.stage}`,
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  return {
    stage: "COMPLETED",
    external_run_id: runId,
    worker_identity: identity,
    adapter_status: "completed",
    callback: parsed.callback,
    evidence_links: parsed.callback.links,
    audit_evidence_links: auditEvidenceLinks,
    audit_notes: auditNotes,
    ok: true,
  };
}

// A synchronous `claude -p` invocation has no remote polling endpoint. If an
// old/partial receipt ever claims RUNNING, hold it unchanged rather than infer a
// process result from PID/session existence. LAUNCH_UNKNOWN recovery is handled
// by launchBuilder({ resume: true }) with the same UUID.
export async function monitorRun() {
  return { stage: "UNCHANGED", reason: "Claude Code print-mode runs have no remote poll endpoint; state held for explicit recovery" };
}
