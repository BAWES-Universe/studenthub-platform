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
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRole, isWriterRole } from "../launch-vocabulary.mjs";
import { validateWorkspaceScope } from "../workspace-scope.mjs";
import { pushExactSha } from "../push-broker.mjs";
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
export function buildClaudeEnvironment(parentEnv = {}, oauthToken = "", { reviewer = false } = {}) {
  const childEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "CI"]) {
    if (typeof parentEnv[key] === "string") childEnv[key] = parentEnv[key];
  }
  if (reviewer) {
    childEnv.HOME = "/nonexistent";
    delete childEnv.TMPDIR;
    delete childEnv.TMP;
    delete childEnv.TEMP;
    delete childEnv.USER;
    delete childEnv.LOGNAME;
    delete childEnv.SHELL;
  }
  if (oauthToken) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return childEnv;
}

export function isolatedReviewerModelCommand({ isolationWrapper, cwd, args }) {
  if (!Array.isArray(isolationWrapper) || isolationWrapper.length === 0
    || isolationWrapper.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("reviewer model launch requires the wrapper validated by the confined test phase");
  }
  const root = path.dirname(cwd);
  return {
    file: isolationWrapper[0],
    args: [
      ...isolationWrapper.slice(1),
      "--profile", "model",
      "--workspace-root", root,
      "--workspace", cwd,
      "--",
      "claude",
      ...args,
    ],
  };
}

export function buildClaudePrompt({ issue_id, authorization_ref, attempt_id, target_sha, task_context, role = "review", allowed_paths = [], scoped_base_sha = null }) {
  if (isWriterRole(role)) return [
    `You are the authorized ${role} worker for ${issue_id}; contract ${authorization_ref}.`,
    `Attempt: ${attempt_id}. Bound target: ${target_sha}. Local head: ${scoped_base_sha ?? target_sha}.`,
    task_context,
    `Implement only the authorized paths: ${allowed_paths.length ? allowed_paths.join(", ") : "the bound full workspace"}.`,
    "Leave changes in the workspace. Do not commit, push, merge, access the network, or alter .git. The host broker validates and publishes the result.",
    `Return the structured callback with stage ${role === "revise" ? "REVISION_READY" : "BUILD_READY"}, result_sha:null, the exact supplied attempt_id and target_sha, and nonempty evidence links. Use BLOCKED or FAILED if unable to finish.`,
  ].filter(Boolean).join("\n");
  return [
    "You are the independent verifier for an authorized StudentHub change.",
    `Issue: ${issue_id}`,
    `Authorized contract ref: ${authorization_ref}`,
    `Bound head: ${target_sha}`,
    `Attempt: ${attempt_id}`,
    task_context,
    "Review and test the exact bound head. Do not merge.",
    "The coordinator already executed the bound test command through its confined reviewer evidence runner. Inspect the trusted evidence payload included in this prompt; the private file URI is machine provenance only and is not readable under restricted mode. Do not execute commands yourself.",
    "You are read-only. If you find an in-scope defect, return BLOCKED with exact diagnostics and evidence so the independent author can revise it. Do not edit, commit, or push.",
    "Include the supplied file: evidence URI in links. Source citations may use repo-relative path@bound-head-sha; never cite another head or an unsafe path.",
    "Return the required structured callback. PASS is allowed only with evidence links at this exact head; otherwise return BLOCKED or FAILED.",
  ].filter(Boolean).join("\n");
}

export function buildClaudeArgs(input, { resume = false } = {}) {
  const sessionFlag = resume ? "--resume" : "--session-id";
  return [
    "-p",
    "--model", CLAUDE_MODEL,
    "--output-format", "json",
    "--json-schema", JSON.stringify(isWriterRole(input.role) ? { ...CALLBACK_SCHEMA, required: [...CALLBACK_SCHEMA.required, "result_sha"], properties: { ...CALLBACK_SCHEMA.properties, stage: { type: "string", enum: [input.role === "revise" ? "REVISION_READY" : "BUILD_READY", "BLOCKED", "FAILED"] }, result_sha: { type: "null" } } } : CALLBACK_SCHEMA),
    // `--restricted` keeps subscription OAuth available while disabling every
    // customization source and confining file tools to the exact cwd. `--bare`
    // must not return: it deliberately ignores the subscription login.
    "--restricted",
    "--disable-slash-commands",
    ...(isWriterRole(input.role) ? ["--tools", "Read,Glob,Grep,Write,Edit"] : [
    "--tools", "Read,Glob,Grep",
    ]),
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
  const candidates = [];
  const unavailable = [];
  if (envelope.structured_output && typeof envelope.structured_output === "object") {
    candidates.push({ field: "structured_output", callback: envelope.structured_output });
  } else {
    unavailable.push("structured_output is missing or is not an object");
  }
  if (typeof envelope.result === "string") {
    const callback = parseJson(envelope.result.trim());
    if (callback && typeof callback === "object") candidates.push({ field: "result", callback });
    else unavailable.push("result is not callback JSON");
  } else {
    unavailable.push("result is missing or is not a string");
  }
  if (candidates.length === 0) {
    return { envelope, callback: null, candidates: [], unavailable, reason_code: "NO_STRUCTURED_OUTPUT" };
  }
  return { envelope, callback: candidates[0].callback, candidates, unavailable, reason_code: null };
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function canonicalRoot(root, fsImpl) {
  if (!path.isAbsolute(root ?? "")) return null;
  try {
    const stat = fsImpl.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const resolved = fsImpl.realpathSync(root);
    return resolved === path.resolve(root) ? resolved : null;
  } catch {
    return null;
  }
}

function allowedFileLink(url, rawLink, { cwd, evidence_dir, fsImpl = fs }) {
  if (url.protocol !== "file:" || url.host || url.username || url.password || url.port || url.search) return false;
  if (/\/(?:\.\.|%2e%2e)(?:\/|%2f)/i.test(rawLink)) return false;
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { return false; }
  if (decodedPath.split("/").includes("..")) return false;
  try {
    const candidate = fileURLToPath(url);
    if (!path.isAbsolute(candidate)) return false;
    const stat = fsImpl.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const declared = path.resolve(candidate);
    const resolved = fsImpl.realpathSync(candidate);
    if (declared !== resolved) return false;
    const roots = [canonicalRoot(cwd, fsImpl), canonicalRoot(evidence_dir, fsImpl)].filter(Boolean);
    return roots.some((root) => inside(root, resolved));
  } catch {
    return false;
  }
}

function allowedSourceCitation(rawLink, { target_sha, cwd, fsImpl = fs }) {
  const separator = rawLink.lastIndexOf("@");
  if (separator <= 0) return false;
  const sourcePath = rawLink.slice(0, separator);
  const citedSha = rawLink.slice(separator + 1);
  if (!SHA_RE.test(citedSha) || citedSha !== target_sha) return false;
  if (
    path.posix.isAbsolute(sourcePath)
    || sourcePath.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(sourcePath)
    || /%(?:2e|2f|5c)/i.test(sourcePath)
  ) return false;
  const parts = sourcePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return false;
  if (path.posix.normalize(sourcePath) !== sourcePath) return false;
  const root = canonicalRoot(cwd, fsImpl);
  if (!root) return false;
  try {
    const candidate = path.resolve(root, ...parts);
    const stat = fsImpl.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const resolved = fsImpl.realpathSync(candidate);
    return candidate === resolved && inside(root, resolved);
  } catch {
    return false;
  }
}

export function validateCallback(callback, { attempt_id, target_sha, cwd, evidence_dir, fsImpl = fs, role = "review" } = {}) {
  if (!callback || typeof callback !== "object" || Array.isArray(callback)) return { valid: false, field: "callback", detail: "must be an object" };
  if (callback.attempt_id !== attempt_id) return { valid: false, field: "attempt_id", detail: "does not match the bound attempt" };
  if (callback.target_sha !== target_sha) return { valid: false, field: "target_sha", detail: "does not match the bound head" };
  if (isWriterRole(role)) {
    if (![role === "revise" ? "REVISION_READY" : "BUILD_READY", "BLOCKED", "FAILED"].includes(callback.stage) || callback.result_sha !== null) return { valid: false, field: "stage", detail: "writer callback does not match its role or host-owned result" };
    return { valid: Array.isArray(callback.links) && callback.links.length > 0 && callback.links.every((link) => typeof link === "string" && link.length > 0), field: "links", detail: "writer requires evidence" };
  }
  const reviewerKeys = new Set(["attempt_id", "target_sha", "stage", "links", "summary"]);
  const extraReviewerKey = Object.keys(callback).find((key) => !reviewerKeys.has(key));
  if (extraReviewerKey) return { valid: false, field: extraReviewerKey, detail: "is outside the closed reviewer callback schema" };
  if (!CALLBACK_STAGES.includes(callback.stage)) return { valid: false, field: "stage", detail: "is not an allowed reviewer stage" };
  if (!Array.isArray(callback.links) || callback.links.length === 0) return { valid: false, field: "links", detail: "must be a non-empty array" };
  let hasFileEvidence = false;
  for (const [index, link] of callback.links.entries()) {
    const field = `links[${index}]`;
    if (typeof link !== "string") return { valid: false, field, detail: "must be a string" };
    if (allowedSourceCitation(link, { target_sha, cwd, fsImpl })) continue;
    let url;
    try { url = new URL(link); } catch {
      return { valid: false, field, detail: "is not an allowlisted URL or exact-head source citation" };
    }
    if (["http:", "https:"].includes(url.protocol)) continue;
    if (url.protocol === "file:" && allowedFileLink(url, link, { cwd, evidence_dir, fsImpl })) {
      hasFileEvidence = true;
      continue;
    }
    return { valid: false, field, detail: "is not an allowlisted HTTPS or canonical local evidence file" };
  }
  if (!hasFileEvidence) return { valid: false, field: "links", detail: "must include canonical local machine evidence" };
  return { valid: true, field: null, detail: null };
}

export function callbackValid(callback, context) {
  return validateCallback(callback, context).valid;
}

function selectCallback(parsed, context) {
  const valid = [];
  const failures = [];
  for (const candidate of parsed.candidates ?? []) {
    const checked = validateCallback(candidate.callback, context);
    if (checked.valid) valid.push(candidate);
    else failures.push(`${candidate.field}.${checked.field}: ${checked.detail}`);
  }
  if (valid.length === 0) {
    const detail = [...failures, ...(parsed.unavailable ?? [])].join("; ");
    return { callback: null, detail: detail || "no callback candidate" };
  }
  if (valid.length > 1 && !isDeepStrictEqual(valid[0].callback, valid[1].callback)) {
    return { callback: null, detail: "structured_output and result contain conflicting valid callbacks" };
  }
  return { callback: valid[0].callback, detail: null };
}

function inlineEvidencePayload(reviewEvidence) {
  if (!reviewEvidence?.report || typeof reviewEvidence.report !== "object" || Array.isArray(reviewEvidence.report)) {
    throw new Error("confined review evidence report is missing");
  }
  const payload = JSON.stringify(reviewEvidence.report);
  if (Buffer.byteLength(payload) > MAX_ENVELOPE_BYTES) throw new Error("confined review evidence report exceeds the prompt limit");
  return payload;
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
  role = "review",
  runtime = "claude-code",
  repo,
  branch,
  workspace_scope = "full",
  scope_phase = "review",
  allowed_paths = [],
  scoped_base_sha = null,
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
  if (!isRole(role) || runtime !== "claude-code") return { stage: "HOLD", reason: "invalid Claude role/runtime authority", ok: false };
  if (role === "review") {
  if (workspace_scope !== "full" || scope_phase !== "review" || !Array.isArray(allowed_paths) || allowed_paths.length !== 0 || scoped_base_sha !== null) {
    return { stage: "HOLD", reason_code: "REVIEW_EXECUTION_UNAVAILABLE", reason: "reviewer checkout must be complete and unscoped", pause_adapter: true, ok: false };
  }
  } else {
    const scope = validateWorkspaceScope({ workspace_scope, scope_phase, allowed_paths, scoped_base_sha }, { requireScopedBase: true });
    if (!scope.ok || scope_phase === "review") return { stage: "HOLD", reason_code: "REVIEW_EXECUTION_UNAVAILABLE", reason: scope.reason ?? "writer cannot use review scope", ok: false };
    if (!env.SHU_WORKER_LAUNCH_WRAPPER || !/^\d+$/.test(env.SHU_WORKER_UID ?? "") || Number(env.SHU_WORKER_UID) === 0 || Number(env.SHU_WORKER_UID) === process.getuid()) return { stage: "HOLD", reason: "Claude writer requires the configured distinct worker identity", ok: false };
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
  if (role === "review") {
  if (checkoutHead !== target_sha) {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_MISMATCH", ok: false };
  }
  } else if (checkoutHead !== (workspace_scope === "scoped" ? scoped_base_sha : target_sha)) {
    return { stage: "FAILED", error_code: "CHECKOUT_HEAD_MISMATCH", ok: false };
  }

  const reviewEvidence = role === "review" ? await reviewEvidenceImpl({ attempt_id, target_sha, cwd, env }) : null;
  const auditEvidenceLinks = reviewEvidence?.evidence_link ? [reviewEvidence.evidence_link] : [];
  let inlineEvidence;
  try { inlineEvidence = inlineEvidencePayload(reviewEvidence); } catch { inlineEvidence = null; }
  if (role === "review") {
  if (reviewEvidence?.executed !== true || !reviewEvidence.evidence_link || !inlineEvidence) {
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
  if (!Array.isArray(reviewEvidence.isolation_wrapper) || reviewEvidence.isolation_wrapper.length === 0) {
    return {
      stage: "HOLD",
      pause_adapter: true,
      reason_code: "REVIEW_EXECUTION_UNAVAILABLE",
      reason: "REVIEW_EXECUTION_UNAVAILABLE — the validated reviewer model wrapper is unavailable; no reviewer launched",
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: ["review model isolation: REVIEW_EXECUTION_UNAVAILABLE"],
      ok: false,
    };
  }

  }

  const input = {
    role, allowed_paths, scoped_base_sha,
    issue_id,
    authorization_ref,
    attempt_id,
    target_sha,
    task_context: [
      task_context,
      ...(role === "review" ? [
      `Confined exact-head test evidence URI (machine provenance only; do not Read): ${reviewEvidence.evidence_link}`,
      `Confined test result: ${reviewEvidence.passed ? "PASS" : "FAIL"}`,
      `Trusted confined evidence payload (inline): ${inlineEvidence}`,
      ] : []),
    ].filter(Boolean).join("\n"),
  };
  const args = buildClaudeArgs(input, { resume });
  let result;
  try {
    const writerWrapper = isWriterRole(role) ? env.SHU_WORKER_LAUNCH_WRAPPER.trim().split(/\s+/) : [];
    const command = role === "review"
      ? isolatedReviewerModelCommand({ isolationWrapper: reviewEvidence.isolation_wrapper, cwd, args })
      : { file: writerWrapper[0] ?? "claude", args: writerWrapper.length ? [...writerWrapper.slice(1), "claude", ...args] : args };
    result = await runExecFile(execFileImpl, command.file, command.args, {
      cwd,
      env: buildClaudeEnvironment(env, oauth_token, { reviewer: role === "review" }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeout_ms,
      windowsHide: true,
    });
  } catch (error) {
    return failureFrom(error, "", "");
  }
  let envelope = null;
  const auditNotes = role === "review" ? [`review execution proof: ${reviewEvidence.reason_code}`] : [];
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
      reason: `NO_STRUCTURED_OUTPUT — ${parsed.unavailable?.join("; ") || "Claude completed without structured callback output"}`,
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  const selected = selectCallback(parsed, { attempt_id, target_sha, cwd, role, evidence_dir: env.SHU_REVIEW_EVIDENCE_DIR });
  if (!selected.callback) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      reason_code: "CALLBACK_BINDING_INVALID",
      reason: `CALLBACK_BINDING_INVALID — ${selected.detail}`,
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  const successStages = role === "review" ? SUCCESS_CALLBACK_STAGES : [role === "revise" ? "REVISION_READY" : "BUILD_READY"];
  if (!successStages.includes(selected.callback.stage)) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      callback: selected.callback,
      evidence_links: selected.callback.links,
      reason: `verifier returned ${selected.callback.stage}`,
      audit_evidence_links: auditEvidenceLinks,
      audit_notes: auditNotes,
      ok: false,
    };
  }
  if (isWriterRole(role)) {
    const push = await (io.pushBrokerImpl ?? pushExactSha)({
      stateDir: env.SHU_WORKSPACE_STATE_DIR, attempt_id, target_sha, result_sha: null,
      workspaceReady: true, beforePublish: io.resultStillAuthorized, repo, branch,
      worktree: cwd, allowedRoot: env.SHU_WORKTREE_ROOT, remoteUrl: env.SHU_PUSH_REMOTE_URL,
      branchPrefix: env.SHU_LANE_BRANCH_PREFIX ?? "coordinator/",
      workspace_scope, scope_phase, allowed_paths, scoped_base_sha, env,
    });
    if (!push.ok || !SHA_RE.test(push.remote_head ?? "")) return {
      stage: "HOLD", external_run_id: runId, worker_identity: identity, adapter_status: "completed",
      reason: `writer result broker refused: ${push.reason ?? "missing exact result head"}`,
      reason_code: push.reason_code, audit_evidence_links: auditEvidenceLinks, audit_notes: auditNotes, ok: false,
    };
    selected.callback.result_sha = push.remote_head;
  }
  return {
    stage: "COMPLETED",
    external_run_id: runId,
    worker_identity: identity,
    adapter_status: "completed",
    callback: selected.callback,
    evidence_links: selected.callback.links,
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
