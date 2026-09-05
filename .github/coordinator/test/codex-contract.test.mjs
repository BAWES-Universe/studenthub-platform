// Codex CLI adapter contract tests (SHU-63 pivot).
//
// Pins the REAL wire shapes verified against the installed CLI + official docs:
//   codex exec --json --sandbox workspace-write --approve-for-me -C <dir> [PROMPT]
//   codex exec resume <EXACT-THREAD-ID> [PROMPT]   (never --last)
//   stdout JSONL: first event {"type":"thread.started","thread_id":"<uuid>"}
// plus the fail-closed rules GPT mandated: uncertain launch without a durable
// thread id -> visible HOLD + pause (never another spawn); auth expiry -> HOLD.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchBuilder,
  monitorRun,
  externalRunId,
  threadIdFromRunId,
  workerIdentity,
  buildCodexArgs,
  buildCodexEnvironment,
  buildCodexPrompt,
  parseThreadStarted,
  parseFinalMessage,
  parseCodexCallback,
  callbackValid,
  CALLBACK_SCHEMA,
  SUCCESS_CALLBACK_STAGES,
} from "../adapters/codex-cli.mjs";
import { adapterNameFor, adapterLaunchOptions } from "../reconcile.mjs";

const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53"; // real time-ordered codex thread id shape
const SHA = "5".repeat(40);
const CWD = "/repo";

function launchInput(over = {}) {
  return {
    issue_id: "SHU-63",
    authorization_ref: "SHU-63",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "Implement the seeded fixture defect fix on the fixture branch.",
    cwd: CWD,
    env: { PATH: "/usr/bin", HOME: "/root", CODEX_HOME: "/root/.codex", OPENAI_API_KEY: "should-never-leak" },
    readHeadImpl: async () => SHA, // tests never hit real git; checkout is at the bound head
    ...over,
  };
}

function jsonl({ threadId = THREAD, finalText = null } = {}) {
  const lines = [{ type: "thread.started", thread_id: threadId }];
  if (finalText !== null) {
    lines.push(
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: finalText } },
      { type: "turn.completed" },
    );
  }
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function callbackJson(stage, over = {}) {
  return JSON.stringify({ attempt_id: ATTEMPT, target_sha: SHA, stage, links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/99"], ...over });
}

function execResult({ stdout = "", stderr = "", error = null }) {
  return (_file, _args, _opts, callback) => {
    queueMicrotask(() => callback(error, stdout, stderr));
  };
}

function recordingExec(calls) {
  return (file, args, opts, callback) => {
    calls.push({ file, args, opts });
    queueMicrotask(() => callback(null, jsonl({ finalText: callbackJson("BUILD_READY") }), ""));
  };
}

test("launch args match the installed CLI contract: exec --json --sandbox workspace-write, never danger-full-access", async () => {
  const calls = [];
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const out = await launchBuilder({ ...launchInput(), execFileImpl: recordingExec(calls), schemaFile: join(schemaDir, "schema.json") });
  assert.equal(out.stage, "COMPLETED");
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"), "--json required for the JSONL event stream");
  const sandboxIdx = args.indexOf("--sandbox");
  assert.ok(sandboxIdx !== -1 && args[sandboxIdx + 1] === "workspace-write", "sandbox is workspace-write");
  assert.ok(!args.includes("danger-full-access") && !args.includes("dangerous-full-access"), "never unrestricted host access");
  assert.ok(!args.includes("--full-auto"), "--full-auto is deprecated and forbidden");
  assert.ok(args.includes("--approve-for-me"), "approvals route through the automatic workspace-write review");
  assert.equal(args[args.indexOf("-C") + 1], CWD);
  assert.ok(args.some((a) => a.includes("--output-schema")), "schema-constrained output");
  assert.ok(calls[0].file === "codex", "execFile codex, never a shell");
});

test("thread.started binds the durable run id: codexrun_<thread-uuid> + codex identity", async () => {
  const calls = [];
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const out = await launchBuilder({ ...launchInput(), execFileImpl: recordingExec(calls), schemaFile: join(schemaDir, "schema.json") });
  assert.equal(out.external_run_id, `codexrun_${THREAD}`);
  assert.equal(threadIdFromRunId(out.external_run_id), THREAD);
  assert.equal(workerIdentity(ATTEMPT), `codex:${ATTEMPT}`);
  assert.equal(out.worker_identity, `codex:${ATTEMPT}`);
  assert.ok(SUCCESS_CALLBACK_STAGES.includes("BUILD_READY"));
  assert.equal(out.callback.stage, "BUILD_READY");
  assert.equal(out.evidence_links.length, 1);
});

test("parse helpers: thread.started from JSONL; final agent_message only", () => {
  const stream = jsonl({ finalText: callbackJson("BUILD_READY") });
  assert.equal(parseThreadStarted(stream), THREAD);
  assert.equal(parseThreadStarted("not json\n{broken"), null);
  assert.equal(parseThreadStarted(jsonl({ threadId: "not-a-uuid" })), null);
  assert.equal(parseFinalMessage(stream), callbackJson("BUILD_READY"));
  assert.equal(parseFinalMessage(jsonl({ finalText: null })), null);
  const cb = parseCodexCallback(stream);
  assert.equal(cb.stage, "BUILD_READY");
  assert.equal(parseCodexCallback(jsonl({ finalText: "plain text not json" })), null);
});

test("callback validation: wrong attempt, wrong sha, missing stage, missing links, bad url all fail closed", () => {
  const valid = JSON.parse(callbackJson("BUILD_READY"));
  assert.ok(callbackValid(valid, { attempt_id: ATTEMPT, target_sha: SHA }));
  assert.ok(!callbackValid({ ...valid, attempt_id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, { attempt_id: ATTEMPT, target_sha: SHA }));
  assert.ok(!callbackValid({ ...valid, target_sha: "6".repeat(40) }, { attempt_id: ATTEMPT, target_sha: SHA }));
  assert.ok(!callbackValid({ ...valid, stage: "COMPLETED" }, { attempt_id: ATTEMPT, target_sha: SHA }), "stage enum enforced");
  assert.ok(!callbackValid({ ...valid, links: [] }, { attempt_id: ATTEMPT, target_sha: SHA }), "links min 1");
  assert.ok(!callbackValid({ ...valid, links: ["file:///etc/passwd"] }, { attempt_id: ATTEMPT, target_sha: SHA }), "http(s) links only");
});

test("BLOCKED/FAILED callbacks never complete; they surface HOLD with the builder evidence", async () => {
  for (const stage of ["BLOCKED", "FAILED"]) {
    const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
    const exec = (_f, _a, _o, cb) => queueMicrotask(() => cb(null, jsonl({ finalText: callbackJson(stage) }), ""));
    const out = await launchBuilder({ ...launchInput(), execFileImpl: exec, schemaFile: join(schemaDir, "schema.json") });
    assert.equal(out.stage, "HOLD", `${stage} -> HOLD`);
    assert.equal(out.external_run_id, `codexrun_${THREAD}`);
    assert.equal(out.callback.stage, stage);
    assert.equal(out.evidence_links.length, 1);
  }
});

test("completed without a valid schema callback -> HOLD (never COMPLETED)", async () => {
  const cases = [
    jsonl({ finalText: "I did the work!" }), // not JSON
    jsonl({ finalText: JSON.stringify({ attempt_id: ATTEMPT }) }), // schema-incomplete
    jsonl(), // no final agent message at all
  ];
  for (const stdout of cases) {
    const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
    const exec = (_f, _a, _o, cb) => queueMicrotask(() => cb(null, stdout, ""));
    const out = await launchBuilder({ ...launchInput(), execFileImpl: exec, schemaFile: join(schemaDir, "schema.json") });
    assert.equal(out.stage, "HOLD", "completed without valid callback -> HOLD");
    assert.ok(out.reason.includes("callback"), out.reason);
  }
});

test("stale-head guard: checkout mismatch refuses the launch before codex starts", async () => {
  const calls = [];
  const readHeadImpl = async () => "6".repeat(40); // NOT target_sha
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const out = await launchBuilder({ ...launchInput(), execFileImpl: recordingExec(calls), readHeadImpl, schemaFile: join(schemaDir, "schema.json") });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "CHECKOUT_HEAD_MISMATCH");
  assert.equal(calls.length, 0, "codex never started off the bound head");
});

test("uncertain launch WITHOUT a durable thread id -> visible HOLD + pause, never another spawn", async () => {
  // Clean exit but no thread.started event anywhere in the stream.
  const exec = (_f, _a, _o, cb) => queueMicrotask(() => cb(null, '{"type":"turn.started"}\n', ""));
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const out = await launchBuilder({ ...launchInput(), execFileImpl: exec, schemaFile: join(schemaDir, "schema.json") });
  assert.equal(out.stage, "HOLD");
  assert.equal(out.pause_adapter, true, "pause the lane: no durable session id to resume");
  assert.notEqual(out.stage, "LAUNCH_UNKNOWN", "must not look retryable-spawnable");
});

test("killed BEFORE thread.started -> HOLD + pause; killed AFTER thread.started -> LAUNCH_UNKNOWN (exact-id resume)", async () => {
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const killed = Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
  const execNoThread = (_f, _a, _o, cb) => queueMicrotask(() => cb(killed, "", ""));
  const outBefore = await launchBuilder({ ...launchInput(), execFileImpl: execNoThread, schemaFile: join(schemaDir, "schema.json") });
  assert.equal(outBefore.stage, "HOLD");
  assert.equal(outBefore.pause_adapter, true);

  const execWithThread = (_f, _a, _o, cb) => queueMicrotask(() => cb(killed, jsonl({ finalText: null }), ""));
  const outAfter = await launchBuilder({ ...launchInput(), execFileImpl: execWithThread, schemaFile: join(schemaDir, "schema.json") });
  assert.equal(outAfter.stage, "LAUNCH_UNKNOWN", "thread id was durable; exact-id resume is legal");
  assert.equal(outAfter.external_run_id, `codexrun_${THREAD}`);
});

test("resume binds the EXACT thread id from the receipt; --last never appears; missing id -> HOLD", async () => {
  const calls = [];
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const out = await launchBuilder({
    ...launchInput(),
    resume: true,
    external_run_id: `codexrun_${THREAD}`,
    execFileImpl: recordingExec(calls),
    schemaFile: join(schemaDir, "schema.json"),
  });
  assert.equal(out.stage, "COMPLETED");
  const args = calls[0].args;
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume");
  assert.equal(args[2], THREAD, "resume uses the exact durably recorded thread id");
  assert.ok(!args.includes("--last"), "--last is forbidden for recovery");
  assert.ok(args.some((a) => a.includes("--sandbox")), "resume keeps the sandbox");
  assert.ok(args.some((a) => a.includes("--output-schema")), "resume keeps schema-constrained output");

  // No durable id -> visible HOLD, and the execFile must never run.
  const calls2 = [];
  const outNoId = await launchBuilder({ ...launchInput(), resume: true, external_run_id: null, execFileImpl: recordingExec(calls2), schemaFile: join(schemaDir, "schema.json") });
  assert.equal(outNoId.stage, "HOLD");
  assert.equal(outNoId.pause_adapter, true);
  assert.equal(calls2.length, 0);
});

test("credential isolation: child env is an allowlist; OPENAI_API_KEY/BASE_URL never leak", async () => {
  const env = buildCodexEnvironment({
    PATH: "/usr/bin",
    HOME: "/root",
    CODEX_HOME: "/root/.codex",
    OPENAI_API_KEY: "sk-secret",
    OPENAI_BASE_URL: "https://evil.example.com",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    RANDOM_SECRET: "zzz",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/root");
  assert.equal(env.CODEX_HOME, "/root/.codex");
  assert.equal(env.OPENAI_API_KEY, undefined, "metered key stripped — subscription auth only");
  assert.equal(env.OPENAI_BASE_URL, undefined, "alternate endpoints stripped");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "other lanes' secrets stripped");
  assert.equal(env.RANDOM_SECRET, undefined);
});

test("authentication expiry -> visible re-auth HOLD + pause; quota stays FAILED; 403 stays access", async () => {
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const mkErr = (msg) => Object.assign(new Error(msg), { code: 1 });
  const run = async (stderr) => {
    const out = await launchBuilder({ ...launchInput(), execFileImpl: execResult({ error: mkErr(stderr), stderr }), schemaFile: join(schemaDir, "s.json") });
    return out;
  };
  const expired = await run("Your access token has expired; please run codex login");
  assert.equal(expired.stage, "HOLD");
  assert.match(expired.reason, /codex login/i);
  assert.equal(expired.pause_adapter, true);
  const quota = await run("usage limit reached for ChatGPT");
  assert.equal(quota.stage, "FAILED");
  assert.equal(quota.error_kind, "quota");
  assert.equal(quota.pause_adapter, true);
  const forbidden = await run("403 forbidden");
  assert.equal(forbidden.stage, "FAILED");
  assert.equal(forbidden.error_kind, "access");
});

test("schema file written before launch; CALLBACK_SCHEMA is closed (additionalProperties false)", async () => {
  assert.equal(CALLBACK_SCHEMA.additionalProperties, false);
  assert.deepEqual([...CALLBACK_SCHEMA.required].sort(), ["attempt_id", "links", "stage", "target_sha"]);
  const schemaDir = mkdtempSync(join(tmpdir(), "codex-"));
  const schemaFile = join(schemaDir, "cb.json");
  const calls = [];
  await launchBuilder({ ...launchInput(), execFileImpl: recordingExec(calls), schemaFile });
  const { readFileSync } = await import("node:fs");
  const written = JSON.parse(readFileSync(schemaFile, "utf8"));
  assert.equal(written.type, "object");
  assert.equal(written.additionalProperties, false);
});

test("routing: codex-builder -> codex-cli; launch options carry cwd/env/resume, zero credentials", () => {
  assert.equal(adapterNameFor("codex-builder"), "codex-cli");
  const opts = adapterLaunchOptions("codex-cli", { CODEX_WORKTREE_PATH: "/wt" }, { resume: true });
  assert.equal(opts.cwd, "/wt");
  assert.equal(opts.resume, true);
  assert.deepEqual(Object.keys(opts).sort(), ["cwd", "env", "resume"]);
  assert.ok(!("token" in opts) && !("oauth_token" in opts), "codex auth lives in ~/.codex/auth.json — no credential through options");
});

test("monitor fails closed: no remote poll endpoint for synchronous exec", async () => {
  assert.equal((await monitorRun({ run_id: externalRunId(THREAD) })).stage, "UNCHANGED");
});

test("prompt carries the bound head, the attempt echo, and the schema contract; no secrets", () => {
  const prompt = buildCodexPrompt(launchInput());
  assert.ok(prompt.includes(`Bound head: ${SHA}`));
  assert.ok(prompt.includes(`Attempt: ${ATTEMPT}`));
  assert.ok(prompt.includes("coordinator-callback") === false && prompt.includes("BUILD_READY|REVISION_READY|BLOCKED|FAILED"));
  assert.ok(!prompt.includes("sk-") && !prompt.includes("token"));
});
