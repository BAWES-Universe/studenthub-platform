// Codex CLI adapter contract tests (SHU-63 pivot).
//
// Pins the documented wire shapes from the official CLI reference:
//   codex exec --json --sandbox workspace-write -C <dir> [PROMPT]
//   codex exec resume <EXACT-THREAD-ID> [PROMPT]   (never --last)
//   stdout JSONL: first event {"type":"thread.started","thread_id":"<uuid>"}
// plus the fail-closed rules GPT mandated: uncertain launch without a durable
// thread id -> visible HOLD + pause (never another spawn); auth expiry -> HOLD.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
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
  persistDurableSession,
  readDurableSession,
  CALLBACK_SCHEMA,
  SUCCESS_CALLBACK_STAGES,
} from "../adapters/codex-cli.mjs";
import { adapterNameFor, adapterLaunchOptions } from "../reconcile.mjs";

const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53"; // real time-ordered codex thread id shape
const SHA = "5".repeat(40);
const CWD = "/repo";
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "codex-state-"));

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
    io: { codexStateDir: TEST_STATE_DIR },
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

test("launch args match the documented CLI contract: exec --json --sandbox workspace-write, never danger-full-access", async () => {
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
  assert.ok(!args.includes("--approve-for-me"), "never pass an undocumented approval flag");
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
  assert.equal(outAfter.worker_identity, `codex:${ATTEMPT}`);
  assert.equal(outAfter.adapter_status, "in_progress");
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
  const resumeIdx = args.indexOf("resume");
  assert.ok(resumeIdx > 1, "exec options precede the resume subcommand");
  assert.equal(args[resumeIdx + 1], THREAD, "resume uses the exact durably recorded thread id");
  assert.ok(!args.includes("--last"), "--last is forbidden for recovery");
  assert.ok(args.some((a) => a.includes("--sandbox")), "resume keeps the sandbox");
  assert.ok(args.some((a) => a.includes("--output-schema")), "resume keeps schema-constrained output");

  // No durable id -> visible HOLD, and the execFile must never run.
  const calls2 = [];
  const outNoId = await launchBuilder({ ...launchInput(), resume: true, external_run_id: null, execFileImpl: recordingExec(calls2), schemaFile: join(schemaDir, "schema.json"), io: { codexStateDir: mkdtempSync(join(tmpdir(), "codex-empty-")) } });
  assert.equal(outNoId.stage, "HOLD");
  assert.equal(outNoId.pause_adapter, true);
  assert.equal(calls2.length, 0);
});

test("buildCodexArgs refuses every non-exact resume identity, including --last and traversal", () => {
  const opts = { resume: true, schemaFile: "/tmp/schema.json", cwd: CWD };
  for (const sessionId of [null, "", "--last", "../session", THREAD.toUpperCase(), `${THREAD}/child`]) {
    assert.throws(() => buildCodexArgs(launchInput(), { ...opts, sessionId }), /exact thread id/);
  }
  const args = buildCodexArgs(launchInput(), { ...opts, sessionId: THREAD });
  assert.equal(args[args.indexOf("resume") + 1], THREAD);
  assert.equal(args.includes("--last"), false);
});

test("model stdout cannot manufacture quota, authentication, or access failures", async () => {
  const modelText = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "quota exhausted; authentication expired; 403 forbidden" } });
  const error = Object.assign(new Error("process exited"), { code: 7 });
  const out = await launchBuilder({
    ...launchInput(),
    execFileImpl: execResult({ error, stdout: `${modelText}\n`, stderr: "ordinary worker failure" }),
    schemaFile: join(mkdtempSync(join(tmpdir(), "codex-stdout-")), "schema.json"),
  });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "CODEX_7");
  assert.equal(out.error_kind, undefined);
  assert.equal(out.pause_adapter, undefined);
});

test("missing durable state directory HOLDs before checkout or spawn", async () => {
  let starts = 0;
  const out = await launchBuilder({
    ...launchInput(),
    env: { PATH: "/usr/bin" },
    io: {},
    readHeadImpl: async () => { starts += 1; return SHA; },
    execFileImpl: (...args) => { starts += 1; args.at(-1)(null, "", ""); },
  });
  assert.equal(out.stage, "HOLD");
  assert.equal(out.pause_adapter, true);
  assert.match(out.reason, /durable state directory is unavailable/);
  assert.equal(starts, 0);
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
  const overlapping = await run("authentication rate limit exceeded");
  assert.equal(overlapping.error_kind, "quota", "quota takes precedence over broad authentication wording");
});

test("thread.started is persisted atomically before process exit, and crash recovery never spawns before receipt persistence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-stream-"));
  const worktree = mkdtempSync(join(tmpdir(), "codex-worktree-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "codex-bin-"));
  const fakeCodex = join(fakeBin, "codex");
  const aliveMarker = join(worktree, "codex-child-alive");
  writeFileSync(fakeCodex, `#!/usr/bin/env node\nconst fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(aliveMarker)}, "alive"); process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`)}); setTimeout(() => { fs.unlinkSync(${JSON.stringify(aliveMarker)}); process.exit(0); }, 1000);\n`);
  chmodSync(fakeCodex, 0o755);
  const adapterUrl = new URL("../adapters/codex-cli.mjs", import.meta.url).href;
  const runner = join(worktree, "runner.mjs");
  writeFileSync(runner, `import { launchBuilder } from ${JSON.stringify(adapterUrl)}; await launchBuilder({ ...${JSON.stringify({
    issue_id: "SHU-63",
    authorization_ref: "SHU-63",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "fixture",
    cwd: worktree,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: process.env.HOME, CODEX_HOME: join(worktree, ".codex") },
  })}, io: { codexStateDir: ${JSON.stringify(stateDir)}, hostname: () => "fixture-host", processStartToken: () => "fixture-start" }, readHeadImpl: async () => ${JSON.stringify(SHA)} });\n`);
  const coordinator = spawn(process.execPath, [runner], { stdio: "ignore" });
  const sidecar = join(stateDir, `${ATTEMPT}.json`);
  const deadline = Date.now() + 5000;
  while (!existsSync(sidecar) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(sidecar), "thread identity is durable while the Codex child is still running");
  assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).thread_id, THREAD);
  coordinator.kill("SIGKILL");
  coordinator.unref();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let spawns = 0;
  const recovered = await launchBuilder({
    ...launchInput(),
    resume: true,
    external_run_id: null,
    io: { codexStateDir: stateDir, hostname: () => "fixture-host", processStartToken: () => existsSync(aliveMarker) ? "fixture-start" : null },
    execFileImpl: (...args) => { spawns += 1; args.at(-1)(null, "", ""); },
  });
  assert.equal(recovered.stage, "LAUNCH_UNKNOWN");
  assert.equal(recovered.external_run_id, `codexrun_${THREAD}`);
  assert.equal(spawns, 0, "recovery returns the identity for receipt persistence before exact-id resume");

  const stillRunning = await launchBuilder({
    ...launchInput(),
    resume: true,
    external_run_id: recovered.external_run_id,
    io: { codexStateDir: stateDir, hostname: () => "fixture-host", processStartToken: () => existsSync(aliveMarker) ? "fixture-start" : null },
    execFileImpl: (...args) => { spawns += 1; args.at(-1)(null, "", ""); },
  });
  assert.equal(stillRunning.stage, "LAUNCH_UNKNOWN");
  assert.match(stillRunning.reason, /still alive/);
  assert.equal(spawns, 0, "the exact session is not resumed concurrently with its orphaned process");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const afterExit = await launchBuilder({
    ...launchInput(),
    resume: true,
    external_run_id: recovered.external_run_id,
    io: { codexStateDir: stateDir, hostname: () => "fixture-host", processStartToken: () => existsSync(aliveMarker) ? "fixture-start" : null },
    execFileImpl: execResult({ stdout: jsonl({ finalText: callbackJson("REVISION_READY") }) }),
  });
  assert.equal(afterExit.stage, "COMPLETED", "only a definitely exited original process permits exact-id resume");
});

test("internally generated callback schema is removed; caller-owned schema is preserved", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-schema-cleanup-"));
  const generated = join(cwd, `.codex-callback-schema-${ATTEMPT}.json`);
  const stateDir = mkdtempSync(join(tmpdir(), "codex-state-"));
  await launchBuilder({ ...launchInput(), cwd, execFileImpl: execResult({ stdout: jsonl({ finalText: callbackJson("BUILD_READY") }) }), io: { codexStateDir: stateDir } });
  assert.equal(existsSync(generated), false);
  assert.equal(readdirSync(stateDir).some((name) => name.startsWith(".callback-schema-")), false, "generated schema is removed from durable state too");

  const owned = join(cwd, "caller-schema.json");
  await launchBuilder({ ...launchInput(), cwd, schemaFile: owned, execFileImpl: execResult({ stdout: jsonl({ finalText: callbackJson("BUILD_READY") }) }), io: { codexStateDir: mkdtempSync(join(tmpdir(), "codex-state-")) } });
  assert.equal(existsSync(owned), true);
});

test("durable session sidecar is immutable and bound to one attempt plus target SHA", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-binding-"));
  persistDurableSession({ stateDir, attempt_id: ATTEMPT, target_sha: SHA, thread_id: THREAD });
  assert.equal(readDurableSession({ stateDir, attempt_id: ATTEMPT, target_sha: SHA }), THREAD);
  assert.throws(
    () => persistDurableSession({ stateDir, attempt_id: ATTEMPT, target_sha: SHA, thread_id: "1199a213-81c0-7800-8aa1-bbab2a035a53" }),
    /different Codex thread/,
  );
  assert.equal(readDurableSession({ stateDir, attempt_id: ATTEMPT, target_sha: "6".repeat(40) }), null, "a sidecar cannot cross a target-SHA boundary");
});

test("durable session reader rejects symlinks and non-files", () => {
  const target = mkdtempSync(join(tmpdir(), "codex-sidecar-target-"));
  const record = JSON.stringify({ version: 1, attempt_id: ATTEMPT, target_sha: SHA, thread_id: THREAD });
  const targetFile = join(target, "record.json");
  writeFileSync(targetFile, record);

  const linkedState = mkdtempSync(join(tmpdir(), "codex-sidecar-link-"));
  symlinkSync(targetFile, join(linkedState, `${ATTEMPT}.json`));
  assert.equal(readDurableSession({ stateDir: linkedState, attempt_id: ATTEMPT, target_sha: SHA }), null);

  const directoryState = mkdtempSync(join(tmpdir(), "codex-sidecar-dir-"));
  mkdirSync(join(directoryState, `${ATTEMPT}.json`));
  assert.equal(readDurableSession({ stateDir: directoryState, attempt_id: ATTEMPT, target_sha: SHA }), null);
});

test("temp cleanup failure cannot override a successfully linked durable session", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-temp-cleanup-"));
  assert.doesNotThrow(() => persistDurableSession({
    stateDir,
    attempt_id: ATTEMPT,
    target_sha: SHA,
    thread_id: THREAD,
    cleanupTempImpl: () => { throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); },
  }));
  assert.equal(readDurableSession({ stateDir, attempt_id: ATTEMPT, target_sha: SHA }), THREAD);
});

test("timeout escalates to SIGKILL and settles even when the child never closes", async () => {
  const signals = [];
  const neverClosingSpawn = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => { signals.push(signal); return true; };
    return child;
  };
  const out = await launchBuilder({
    ...launchInput(),
    spawnImpl: neverClosingSpawn,
    io: { codexStateDir: mkdtempSync(join(tmpdir(), "codex-timeout-")), processStartToken: () => "fixture-start", hostname: () => "fixture-host" },
    timeout_ms: 5,
    timeout_grace_ms: 5,
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(out.stage, "HOLD");
  assert.equal(out.pause_adapter, true);
});

test("generated-schema cleanup failure cannot replace a valid completion", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-schema-cleanup-error-"));
  const out = await launchBuilder({
    ...launchInput(),
    execFileImpl: execResult({ stdout: jsonl({ finalText: callbackJson("BUILD_READY") }) }),
    io: { codexStateDir: stateDir, unlinkSync: () => { throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); } },
  });
  assert.equal(out.stage, "COMPLETED");
  assert.equal(out.pause_adapter, undefined);
});

test("resume requires a definitely exited bound process; live, foreign-host, and ambiguous owners never authorize it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-owner-"));
  persistDurableSession({
    stateDir,
    attempt_id: ATTEMPT,
    target_sha: SHA,
    thread_id: THREAD,
    owner_host: "host-a",
    child_pid: 4242,
    child_start: "start-1",
  });
  let spawns = 0;
  const base = {
    ...launchInput(),
    resume: true,
    external_run_id: `codexrun_${THREAD}`,
    execFileImpl: (...args) => { spawns += 1; args.at(-1)(null, jsonl({ finalText: callbackJson("REVISION_READY") }), ""); },
  };
  const live = await launchBuilder({ ...base, io: { codexStateDir: stateDir, hostname: () => "host-a", processStartToken: () => "start-1" } });
  assert.equal(live.stage, "LAUNCH_UNKNOWN");
  const foreign = await launchBuilder({ ...base, io: { codexStateDir: stateDir, hostname: () => "host-b", processStartToken: () => null } });
  assert.equal(foreign.stage, "HOLD");
  assert.equal(foreign.pause_adapter, true);
  assert.equal(spawns, 0);
  const reusedPid = await launchBuilder({ ...base, io: { codexStateDir: stateDir, hostname: () => "host-a", processStartToken: () => "start-2" } });
  assert.equal(reusedPid.stage, "COMPLETED", "a mismatched process start token proves the recorded child exited despite PID reuse");
  assert.equal(spawns, 1);
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

// ---------------------------------------------------------------------------
// Opus, exact-head verification of 2510f6d.
//
// Stated contract: "An uncertain launch WITHOUT a durably recorded thread id
// produces a visible HOLD + adapter pause — never another spawn." The
// durabilityError -> HOLD branch implements it, and mutation-testing showed that
// branch breaking ZERO tests. It was UNREACHABLE whenever a persist threw after
// thread.started: the throw escaped to launchBuilder's outer catch, which
// returned failureFrom(..., { threadId: null }) — a terminal FAILED, no pause,
// no run id — before the durability check ran.
//
// FAILED is terminal: the slot is released, a fresh attempt can be minted, and a
// SECOND codex exec starts while the first session exists upstream and can never
// be resumed. Reachable without an exotic setup: a corrupt or foreign sidecar
// left by an earlier crash makes persistDurableSession throw while the schema
// file writes fine.
// ---------------------------------------------------------------------------
function streamingSpawn(lines, { exitCode = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      for (const line of lines) child.stdout.emit("data", `${line}\n`);
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

function unrecordableStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "codex-durability-"));
  const stateDir = join(dir, "runs");
  mkdirSync(stateDir, { recursive: true });
  // A sidecar for this attempt bound to a DIFFERENT sha — what an earlier crash
  // or a hand-edit leaves behind. persistDurableSession refuses it, while the
  // schema file still writes fine.
  writeFileSync(join(stateDir, `${ATTEMPT}.json`), JSON.stringify({ version: 1, attempt_id: ATTEMPT, target_sha: "9".repeat(40), thread_id: THREAD }));
  return { dir, stateDir };
}

for (const [label, exitCode] of [["clean exit", 0], ["killed after thread.started", 137]]) {
  test(`durable session failure after thread.started HOLDs and pauses (${label})`, async () => {
    const { dir, stateDir } = unrecordableStateDir();
    const out = await launchBuilder({
      ...launchInput(),
      schemaFile: join(dir, "schema.json"),
      io: {
        codexStateDir: stateDir,
        spawnImpl: streamingSpawn([JSON.stringify({ type: "thread.started", thread_id: THREAD })], { exitCode }),
        processStartToken: () => "fixture-start",
        hostname: () => "fixture-host",
      },
    });
    assert.equal(out.stage, "HOLD", `${label}: a session that exists but was not durably recorded must HOLD, never terminate`);
    assert.equal(out.pause_adapter, true, `${label}: and must pause so no further attempt spawns`);
  });
}

// The BUFFERED path reaches the same rule. Injecting execFileImpl selects the
// non-streaming branch, so nothing sets durabilityError while the process runs
// and the only persist attempt is the buffered one after exit.
test("durable session failure on the BUFFERED path also HOLDs and pauses", async () => {
  const { dir, stateDir } = unrecordableStateDir();
  const out = await launchBuilder({
    ...launchInput(),
    schemaFile: join(dir, "schema.json"),
    execFileImpl: execResult({ stdout: jsonl({ finalText: callbackJson("BUILD_READY") }) }),
    io: { codexStateDir: stateDir },
  });
  assert.equal(out.stage, "HOLD", "an unrecordable session must never terminate the attempt");
  assert.equal(out.pause_adapter, true);
  assert.match(out.reason, /could not be durably recorded/);
});
