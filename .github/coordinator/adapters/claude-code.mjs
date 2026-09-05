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

export const ADAPTER_NAME = "claude-code";
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["PASS"]);
export const CALLBACK_STAGES = Object.freeze(["PASS", "BLOCKED", "FAILED"]);
const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

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
const ACCESS_RE = /unauthori[sz]ed|forbidden|authentication|invalid (?:oauth )?token|login required/i;

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
    "If you find an in-scope defect and have authority, add a failing regression test, implement the fix on this PR branch, push it, and return BLOCKED with the new-head evidence link so verification rotates. Use comments-only BLOCKED only for a decision, authority, access, scope, protected-boundary, or verifier constraint.",
    "If you change code, you are no longer eligible to PASS that head.",
    "Return the required structured callback. PASS is allowed only with evidence links at this exact head; otherwise return BLOCKED or FAILED.",
  ].filter(Boolean).join("\n");
}

export function buildClaudeArgs(input, { resume = false } = {}) {
  const sessionFlag = resume ? "--resume" : "--session-id";
  return [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(CALLBACK_SCHEMA),
    "--permission-mode", "dontAsk",
    sessionFlag, input.attempt_id,
    buildClaudePrompt(input),
  ];
}

function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function readHead({ cwd, execFileImpl, env }) {
  const result = await runExecFile(execFileImpl, "git", ["rev-parse", "HEAD"], {
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
  if (!envelope || typeof envelope !== "object") return null;
  if (envelope.structured_output && typeof envelope.structured_output === "object") {
    return { envelope, callback: envelope.structured_output };
  }
  if (typeof envelope.result === "string") {
    const callback = parseJson(envelope.result.trim());
    if (callback) return { envelope, callback };
  }
  return { envelope, callback: null };
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

  const input = { issue_id, authorization_ref, attempt_id, target_sha, task_context };
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
  if (result.error) return failureFrom(result.error, result.stdout, result.stderr);

  const parsed = parseClaudeCallback(result.stdout);
  const identity = workerIdentity(attempt_id);
  const runId = externalRunId(attempt_id);
  if (!parsed || parsed.envelope?.is_error === true) {
    return {
      stage: "FAILED",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "failed",
      error_code: "CLAUDE_INVALID_RESULT",
      ok: false,
    };
  }
  if (parsed.envelope.session_id && parsed.envelope.session_id !== attempt_id) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      reason: "Claude returned a different session id than the bound attempt",
      ok: false,
    };
  }
  if (!callbackValid(parsed.callback, { attempt_id, target_sha })) {
    return {
      stage: "HOLD",
      external_run_id: runId,
      worker_identity: identity,
      adapter_status: "completed",
      reason: "completed without a valid attempt/SHA-bound callback",
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
