import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_SCHEMA,
  buildClaudeArgs,
  buildClaudeEnvironment,
  externalRunId,
  launchBuilder,
  monitorRun,
} from "../adapters/claude-code.mjs";
import {
  adapterLaunchOptions,
  adapterNameFor,
  createReceipt,
  foldLaunchOutcome,
  validateReceipt,
} from "../reconcile.mjs";

const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const SHA = "d".repeat(40);
const TOKEN = "oauth-test-fixture";

function execResult({ stdout = "", stderr = "", error = null } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(error, stdout, stderr));
    return { pid: 1234 };
  };
  impl.calls = calls;
  return impl;
}

function successOutput(stage = "PASS", overrides = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: ATTEMPT,
    structured_output: {
      attempt_id: ATTEMPT,
      target_sha: SHA,
      stage,
      links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/99"],
      ...overrides,
    },
  });
}

const launchInput = {
  issue_id: "SHU-61",
  authorization_ref: "SHU-61",
  attempt_id: ATTEMPT,
  target_sha: SHA,
  task_context: "Verify the exact-head change.",
  oauth_token: TOKEN,
  cwd: "/tmp/repo",
  readHeadImpl: async () => SHA,
};

test("official headless contract: execFile claude -p with JSON schema and bound UUID/SHA", async () => {
  const execFileImpl = execResult({ stdout: successOutput() });
  const out = await launchBuilder({ ...launchInput, execFileImpl, env: { PATH: "/bin", ANTHROPIC_API_KEY: "must-not-leak" } });
  assert.equal(out.stage, "COMPLETED");
  assert.equal(out.external_run_id, externalRunId(ATTEMPT));
  assert.equal(execFileImpl.calls.length, 1);
  const call = execFileImpl.calls[0];
  assert.equal(call.file, "claude");
  assert.equal(call.options.shell, undefined, "execFile arg arrays must not opt into a shell");
  assert.deepEqual(call.args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.equal(call.args[3], "--json-schema");
  assert.deepEqual(JSON.parse(call.args[4]), CALLBACK_SCHEMA);
  assert.ok(call.args.includes("--session-id"));
  assert.ok(call.args.includes(ATTEMPT));
  assert.match(call.args.at(-1), new RegExp(`Bound head: ${SHA}`));
  assert.match(call.args.at(-1), new RegExp(`Attempt: ${ATTEMPT}`));
});

test("subscription OAuth is the only Claude credential passed to the child", async () => {
  const execFileImpl = execResult({ stdout: successOutput() });
  await launchBuilder({
    ...launchInput,
    execFileImpl,
    env: {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "metered-key",
      ANTHROPIC_AUTH_TOKEN: "alternate-token",
      ANTHROPIC_BASE_URL: "https://metered.example",
      GITHUB_TOKEN: "must-not-leak",
      LINEAR_API_TOKEN: "must-not-leak",
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
    },
  });
  const childEnv = execFileImpl.calls[0].options.env;
  assert.equal(childEnv.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(childEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.LINEAR_API_TOKEN, undefined);
});

test("checkout must resolve to the receipt target SHA before Claude starts", async () => {
  const execFileImpl = execResult({ stdout: successOutput() });
  const mismatch = await launchBuilder({ ...launchInput, execFileImpl, readHeadImpl: async () => "e".repeat(40) });
  assert.equal(mismatch.stage, "FAILED");
  assert.equal(mismatch.error_code, "CHECKOUT_HEAD_MISMATCH");
  assert.equal(execFileImpl.calls.length, 0);

  const unreadable = await launchBuilder({ ...launchInput, execFileImpl, readHeadImpl: async () => { throw new Error("not a repo"); } });
  assert.equal(unreadable.error_code, "CHECKOUT_HEAD_UNREADABLE");
  assert.equal(execFileImpl.calls.length, 0);
});

test("default checkout verifier calls git rev-parse HEAD before claude", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (file === "git") queueMicrotask(() => callback(null, `${SHA}\n`, ""));
    else queueMicrotask(() => callback(null, successOutput(), ""));
    return { pid: 1234 };
  };
  const { readHeadImpl: _ignored, ...withoutInjectedHead } = launchInput;
  const out = await launchBuilder({ ...withoutInjectedHead, execFileImpl });
  assert.equal(out.stage, "COMPLETED");
  assert.deepEqual(calls.map(({ file }) => file), ["git", "claude"]);
  assert.deepEqual(calls[0].args, ["rev-parse", "HEAD"]);
  assert.equal(calls[0].options.cwd, launchInput.cwd);
});

test("an API key cannot substitute for missing subscription OAuth", async () => {
  const execFileImpl = execResult({ stdout: successOutput() });
  const out = await launchBuilder({ ...launchInput, oauth_token: "", env: { ANTHROPIC_API_KEY: "metered-key" }, execFileImpl });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "API_KEY_REJECTED");
  assert.equal(out.pause_adapter, true);
  assert.equal(execFileImpl.calls.length, 0);
});

test("missing all credentials holds launch unknown and never starts a child", async () => {
  const execFileImpl = execResult({ stdout: successOutput() });
  const out = await launchBuilder({ ...launchInput, oauth_token: "", env: {}, execFileImpl });
  assert.equal(out.stage, "LAUNCH_UNKNOWN");
  assert.equal(execFileImpl.calls.length, 0);
});

test("PASS requires a callback bound to the same attempt and target SHA", async () => {
  for (const callback of [
    { attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { target_sha: "e".repeat(40) },
    { links: [] },
  ]) {
    const execFileImpl = execResult({ stdout: successOutput("PASS", callback) });
    const out = await launchBuilder({ ...launchInput, execFileImpl });
    assert.equal(out.stage, "HOLD");
  }
});

test("completed without structured callback -> HOLD, never COMPLETED", async () => {
  const execFileImpl = execResult({ stdout: JSON.stringify({ type: "result", is_error: false, session_id: ATTEMPT, result: "looks good" }) });
  const out = await launchBuilder({ ...launchInput, execFileImpl });
  assert.equal(out.stage, "HOLD");
  assert.match(out.reason, /without a valid/);
});

test("BLOCKED and FAILED verifier callbacks park on HOLD with evidence", async () => {
  for (const stage of ["BLOCKED", "FAILED"]) {
    const out = await launchBuilder({ ...launchInput, execFileImpl: execResult({ stdout: successOutput(stage) }) });
    assert.equal(out.stage, "HOLD");
    assert.equal(out.callback.stage, stage);
    assert.equal(out.evidence_links.length, 1);
  }
});

test("quota/plan-cap and access failures -> FAILED + durable adapter pause signal", async () => {
  for (const [message, kind] of [["Usage limit reached for your plan", "quota"], ["Invalid OAuth token", "access"]]) {
    const error = Object.assign(new Error(message), { code: 1 });
    const out = await launchBuilder({ ...launchInput, execFileImpl: execResult({ error, stderr: message }) });
    assert.equal(out.stage, "FAILED");
    assert.equal(out.error_kind, kind);
    assert.equal(out.pause_adapter, true);
  }
});

test("LAUNCH_UNKNOWN recovery resumes the same Claude session UUID", async () => {
  const args = buildClaudeArgs(launchInput, { resume: true });
  assert.ok(args.includes("--resume"));
  assert.ok(!args.includes("--session-id"));
  assert.equal(args[args.indexOf("--resume") + 1], ATTEMPT);
});

test("monitor fails closed because print-mode has no remote polling endpoint", async () => {
  assert.equal((await monitorRun({ run_id: externalRunId(ATTEMPT) })).stage, "UNCHANGED");
});

test("claude-verifier routes to claude-code while other worker families keep their adapter", () => {
  assert.equal(adapterNameFor("claude-verifier"), "claude-code");
  assert.equal(adapterNameFor("codex-builder"), "workspace-agents");
  assert.equal(adapterNameFor("hermes-box"), "workspace-agents");
  const options = adapterLaunchOptions("claude-code", { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_WORKTREE_PATH: "/repo" });
  assert.equal(options.oauth_token, TOKEN);
  assert.equal(options.cwd, "/repo");
  assert.equal(options.token, undefined, "Workspace/API bearer token is not part of the Claude lane");
});

test("synchronous PASS folds through acknowledged RUNNING into a valid COMPLETED receipt", () => {
  const { receipt } = createReceipt({
    issue_id: "SHU-61",
    authorization_ref: "SHU-61",
    requested_worker: "claude-verifier",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "feature/shu-61",
    target_sha: SHA,
    attempt_id: ATTEMPT,
  });
  const callback = {
    attempt_id: ATTEMPT,
    target_sha: SHA,
    stage: "PASS",
    links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/99"],
  };
  const transition = foldLaunchOutcome(receipt, {
    stage: "COMPLETED",
    external_run_id: externalRunId(ATTEMPT),
    worker_identity: `claude:${ATTEMPT}`,
    adapter_status: "completed",
    callback,
  });
  assert.equal(transition.accepted, true);
  assert.equal(transition.receipt.stage, "COMPLETED");
  assert.equal(transition.receipt.worker_identity, `claude:${ATTEMPT}`);
  assert.equal(validateReceipt(transition.receipt).valid, true);
});

test("environment builder removes every metered/alternate API route", () => {
  const env = buildClaudeEnvironment({ ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "y", ANTHROPIC_BASE_URL: "z" }, TOKEN);
  assert.deepEqual(
    { api: env.ANTHROPIC_API_KEY, auth: env.ANTHROPIC_AUTH_TOKEN, base: env.ANTHROPIC_BASE_URL, oauth: env.CLAUDE_CODE_OAUTH_TOKEN },
    { api: undefined, auth: undefined, base: undefined, oauth: TOKEN },
  );
});
