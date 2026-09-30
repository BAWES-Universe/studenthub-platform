// SHU-71 role reversal: Codex CLI as the independent REVIEWER.
//
// The reviewer runs only after the coordinator's confined test phase, under the
// same root-owned reviewer sandbox as the Claude reviewer (model profile), with
// a read-only Codex sandbox, the committed verdict schema and no push broker.
// Its PASS/BLOCKED callback has the Claude reviewer's closed shape, so a Codex
// BLOCK carries findings to the writer exactly as a Claude BLOCK does.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODEX_MODEL,
  REVIEW_CALLBACK_SCHEMA,
  REVIEW_SCHEMA_FILE,
  buildCodexArgs,
  buildCodexReviewPrompt,
  launchBuilder,
  persistDurableSession,
} from "../adapters/codex-cli.mjs";
import { reviewFindingsFromCallback } from "../review-findings.mjs";
import { assertReviewerSandboxContract } from "../service/reviewer-isolation.mjs";

const ATTEMPT = "12345678-9abc-4def-8123-456789abcdef";
const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const WRAPPER = ["/usr/bin/sudo", "-n", "/usr/local/libexec/shu-reviewer-sandbox"];
const ROOT = mkdtempSync(join(tmpdir(), "shu71-codex-reviewer-"));
const WORKSPACE = join(ROOT, ATTEMPT);
const EVIDENCE = join(ROOT, "evidence");
const REPORT = join(EVIDENCE, `${ATTEMPT}.review-test.1.json`);
const STATE = join(ROOT, "state");
mkdirSync(WORKSPACE, { mode: 0o750 });
mkdirSync(join(WORKSPACE, "tools"), { mode: 0o750 });
writeFileSync(join(WORKSPACE, "tools", "scan.mjs"), "export {};\n");
mkdirSync(EVIDENCE, { mode: 0o700 });
writeFileSync(REPORT, "{}", { mode: 0o600 });
mkdirSync(STATE, { mode: 0o700 });
after(() => rmSync(ROOT, { recursive: true, force: true }));

const EVIDENCE_LINK = pathToFileURL(REPORT).href;
const sandboxSource = readFileSync(new URL("../reviewer-sandbox.sh", import.meta.url), "utf8");

function evidence(over = {}) {
  return async () => ({
    executed: true,
    passed: true,
    reason_code: "REVIEW_TESTS_PASSED",
    evidence_link: EVIDENCE_LINK,
    isolation_wrapper: WRAPPER,
    report: { version: "1.0.0", target_sha: SHA, tests: { executed: true, exit_code: 0 } },
    ...over,
  });
}

function codexOutput(callback) {
  return [
    { type: "thread.started", thread_id: THREAD },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: JSON.stringify(callback) } },
    { type: "turn.completed" },
  ].map((line) => JSON.stringify(line)).join("\n");
}

function verdict(stage, over = {}) {
  return { attempt_id: ATTEMPT, target_sha: SHA, stage, links: [EVIDENCE_LINK, `tools/scan.mjs@${SHA}:1`], summary: `${stage} at the bound head`, ...over };
}

function execDouble(stdout) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(null, stdout, ""));
    return { pid: 4321 };
  };
  impl.calls = calls;
  return impl;
}

function reviewInput(over = {}) {
  const { io: ioOver, env: envOver, ...rest } = over;
  return {
    issue_id: "SHU-140",
    authorization_ref: "SHU-140",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "Review the exact bound head.",
    role: "review",
    runtime: "codex-cli",
    workspace_scope: "full",
    scope_phase: "review",
    allowed_paths: [],
    scoped_base_sha: null,
    cwd: WORKSPACE,
    env: { PATH: "/usr/bin", CODEX_HOME: "/srv/codex", SHU_REVIEW_EVIDENCE_DIR: EVIDENCE,
      SHU_WORKER_LAUNCH_WRAPPER: "/usr/local/libexec/shu-worker-launch", ...(envOver ?? {}) },
    readHeadImpl: async () => SHA,
    reviewEvidenceImpl: evidence(),
    ...rest,
    io: { codexStateDir: STATE, pushBrokerImpl: async () => { throw new Error("a reviewer must never reach the push broker"); }, ...(ioOver ?? {}) },
  };
}

test("SHU-71 Codex review schema: the committed file is the exported closed verdict schema", () => {
  assert.deepEqual(JSON.parse(readFileSync(REVIEW_SCHEMA_FILE, "utf8")), REVIEW_CALLBACK_SCHEMA);
  assert.deepEqual(REVIEW_CALLBACK_SCHEMA.properties.stage.enum, ["PASS", "BLOCKED", "FAILED"]);
  assert.deepEqual(REVIEW_CALLBACK_SCHEMA.required, Object.keys(REVIEW_CALLBACK_SCHEMA.properties),
    "strict structured output requires every property");
  assert.equal(REVIEW_CALLBACK_SCHEMA.additionalProperties, false);
  assert.equal("result_sha" in REVIEW_CALLBACK_SCHEMA.properties, false, "a reviewer names no result head");
});

test("SHU-71 Codex review argv: read-only sandbox, committed schema, reviewer prompt", () => {
  const args = buildCodexArgs({ issue_id: "SHU-140", authorization_ref: "SHU-140", attempt_id: ATTEMPT, target_sha: SHA, task_context: "ctx", role: "review" },
    { schemaFile: REVIEW_SCHEMA_FILE, cwd: WORKSPACE });
  assert.deepEqual(args.slice(0, 11), ["exec", "--json", "--model", CODEX_MODEL, "--sandbox", "read-only", "--skip-git-repo-check", "-C", WORKSPACE, "--output-schema", REVIEW_SCHEMA_FILE]);
  assert.equal(args.includes("workspace-write"), false);
  assert.equal(args.includes("danger-full-access"), false);
  const prompt = args.at(-1);
  assert.match(prompt, /^You are the independent verifier/);
  assert.match(prompt, /Do not run the tests, node, npm or any builder-authored code/);
  assert.match(prompt, /Declared scope of SHU-140: /, "the fixture scope reaches the Codex reviewer too");
  assert.doesNotMatch(prompt, /BUILDER|BUILD_READY|REVISION_READY/, "the reviewer never receives the writer contract");
  const resumed = buildCodexArgs({ issue_id: "SHU-140", authorization_ref: "SHU-140", attempt_id: ATTEMPT, target_sha: SHA, task_context: "ctx", role: "review" },
    { resume: true, sessionId: THREAD, schemaFile: REVIEW_SCHEMA_FILE, cwd: WORKSPACE });
  assert.deepEqual(resumed.slice(-3, -1), ["resume", THREAD], "an interrupted review resumes its exact thread");
  assert.equal(buildCodexReviewPrompt({ issue_id: "SHU-9", authorization_ref: "SHU-9", attempt_id: ATTEMPT, target_sha: SHA, task_context: "" }).includes("Declared scope"), false);
});

test("SHU-71 Codex review PASS: launched as shu-reviewer through the model profile, never the writer wrapper or broker", async () => {
  const execFileImpl = execDouble(codexOutput(verdict("PASS")));
  const out = await launchBuilder(reviewInput({ execFileImpl }));
  assert.equal(out.stage, "COMPLETED", out.reason);
  assert.equal(out.ok, true);
  assert.equal(out.callback.stage, "PASS");
  assert.equal(out.external_run_id, `codexrun_${THREAD}`);
  assert.deepEqual(out.audit_evidence_links, [EVIDENCE_LINK]);
  assert.deepEqual(out.audit_notes, ["review execution proof: REVIEW_TESTS_PASSED"]);
  assert.equal(execFileImpl.calls.length, 1);
  const call = execFileImpl.calls[0];
  assert.equal(call.file, WRAPPER[0]);
  assert.deepEqual(call.args.slice(0, 10), [...WRAPPER.slice(1), "--profile", "model", "--workspace-root", dirname(WORKSPACE), "--workspace", WORKSPACE, "--", "codex"]);
  assert.deepEqual(call.args.slice(10, 16), ["exec", "--json", "--model", CODEX_MODEL, "--sandbox", "read-only"]);
  assert.equal(call.args.includes("/usr/local/libexec/shu-worker-launch"), false, "the writer's identity wrapper is never used for review");
  const prompt = call.args.at(-1);
  assert.ok(prompt.includes(`Confined exact-head test evidence URI (machine provenance only; not readable): ${EVIDENCE_LINK}`));
  assert.ok(prompt.includes("Confined test result: PASS"));
  assert.ok(prompt.includes('Trusted confined evidence payload (inline): {"version":"1.0.0"'));
  assert.equal("OPENAI_API_KEY" in call.options.env, false);
});

test("SHU-71 Codex review BLOCKED: HOLD carries the callback, so findings route to the writer", async () => {
  const blocked = verdict("BLOCKED", { summary: "Line 48 of the oracle expects the wrong value." });
  const out = await launchBuilder(reviewInput({ execFileImpl: execDouble(codexOutput(blocked)) }));
  assert.equal(out.stage, "HOLD");
  assert.equal(out.adapter_status, "completed");
  assert.equal(out.reason, "verifier returned BLOCKED");
  assert.deepEqual(out.callback, blocked);
  const findings = reviewFindingsFromCallback(out.callback);
  assert.equal(findings?.summary, "Line 48 of the oracle expects the wrong value.");
  assert.deepEqual(findings?.links, blocked.links);
});

test("SHU-71 Codex review refuses to launch without confined test evidence or its model wrapper", async () => {
  for (const over of [{ executed: false }, { evidence_link: null }, { report: null }, { isolation_wrapper: [] }]) {
    const execFileImpl = execDouble(codexOutput(verdict("PASS")));
    const out = await launchBuilder(reviewInput({ execFileImpl, reviewEvidenceImpl: evidence(over) }));
    assert.equal(out.stage, "HOLD", JSON.stringify(over));
    assert.equal(out.reason_code, "REVIEW_EXECUTION_UNAVAILABLE");
    assert.equal(out.pause_adapter, true);
    assert.equal(execFileImpl.calls.length, 0, "no reviewer model runs without proven confined tests");
  }
});

test("SHU-71 Codex role authority: scope, role and runtime mismatches fail closed before any launch", async () => {
  const cases = [
    [{ workspace_scope: "scoped" }, /complete and unscoped/],
    [{ scope_phase: "initial" }, /complete and unscoped/],
    [{ allowed_paths: ["tools/scan.mjs"] }, /complete and unscoped/],
    [{ scoped_base_sha: OTHER }, /complete and unscoped/],
    [{ role: "judge" }, /invalid Codex role\/runtime authority/],
    [{ runtime: "claude-code" }, /invalid Codex role\/runtime authority/],
    [{ role: "build" }, /writer cannot use review scope/],
  ];
  for (const [over, reason] of cases) {
    const execFileImpl = execDouble(codexOutput(verdict("PASS")));
    let evidenceRuns = 0;
    const out = await launchBuilder(reviewInput({ ...over, execFileImpl, reviewEvidenceImpl: async () => { evidenceRuns += 1; return evidence()(); } }));
    assert.equal(out.stage, "HOLD", JSON.stringify(over));
    assert.match(out.reason, reason);
    assert.equal(execFileImpl.calls.length, 0);
    assert.equal(evidenceRuns, 0, "no builder-authored test runs for a refused order");
  }
});

test("SHU-71 Codex review callback binding: another head, unsafe or missing evidence is never a verdict", async () => {
  for (const callback of [
    verdict("PASS", { target_sha: OTHER }),
    verdict("PASS", { attempt_id: "87654321-9abc-4def-8123-456789abcdef" }),
    verdict("PASS", { links: [`tools/scan.mjs@${SHA}:1`] }),
    verdict("PASS", { links: [EVIDENCE_LINK, `tools/scan.mjs@${OTHER}:1`] }),
    verdict("PASS", { links: [EVIDENCE_LINK, "javascript:alert(1)"] }),
    verdict("PASS", { result_sha: null }),
    verdict("BUILD_READY"),
  ]) {
    const out = await launchBuilder(reviewInput({ execFileImpl: execDouble(codexOutput(callback)) }));
    assert.equal(out.stage, "HOLD", JSON.stringify(callback));
    assert.equal(out.reason_code, "CALLBACK_BINDING_INVALID");
    assert.equal(out.callback, undefined, "an unbound callback carries no findings");
  }
});

test("SHU-71 Codex review stays at the exact head, even on resume", async () => {
  const out = await launchBuilder(reviewInput({ readHeadImpl: async () => OTHER, execFileImpl: execDouble(codexOutput(verdict("PASS"))) }));
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "CHECKOUT_HEAD_MISMATCH");
  // A durably recorded thread whose process is gone is the one state that
  // reaches the checkout check on resume.
  const stateDir = mkdtempSync(join(ROOT, "resume-state-"));
  persistDurableSession({ stateDir, attempt_id: ATTEMPT, target_sha: SHA, thread_id: THREAD, owner_host: "reviewer-host", child_pid: 99, child_start: "123" });
  let descendantChecks = 0;
  const resumed = await launchBuilder(reviewInput({ resume: true, external_run_id: `codexrun_${THREAD}`,
    readHeadImpl: async () => OTHER, verifyDescendantImpl: async () => { descendantChecks += 1; return true; },
    execFileImpl: execDouble(codexOutput(verdict("PASS"))),
    io: { codexStateDir: stateDir, hostname: () => "reviewer-host", processStartToken: () => null } }));
  assert.equal(resumed.stage, "FAILED");
  assert.equal(resumed.error_code, "CHECKOUT_HEAD_MISMATCH");
  assert.equal(descendantChecks, 0, "a reviewer never accepts a descendant checkout");
});

test("SHU-71 Codex writer contract is unchanged when no role is given", async () => {
  const args = buildCodexArgs({ issue_id: "SHU-140", authorization_ref: "SHU-140", attempt_id: ATTEMPT, target_sha: SHA, task_context: "ctx" },
    { schemaFile: "/tmp/schema.json", cwd: WORKSPACE });
  assert.deepEqual(args.slice(0, 10), ["exec", "--json", "--model", CODEX_MODEL, "--config", "sandbox_workspace_write.network_access=false", "--sandbox", "workspace-write", "-C", WORKSPACE]);
  assert.match(args.at(-1), /^You are the authorized BUILDER/);
});

// Execute the shipped mask block: only the Codex model launch may see the
// Codex reviewer home; builder tests and the Claude reviewer run as the same uid.
function maskArgs(profile, command) {
  const start = sandboxSource.indexOf("reviewer_codex_home=/var/lib/shu-reviewer-codex");
  const end = sandboxSource.indexOf('if [[ "$profile" == "test" ]]; then');
  assert.ok(start >= 0 && end > start, "SHU71_MASK_HARNESS: the shipped mask block must be extracted");
  const run = spawnSync("/bin/bash", ["-p", "-c", `
set -euo pipefail
profile=${profile}
systemd_args=()
set -- ${command}
${sandboxSource.slice(start, end)}
printf '%s\\n' "\${systemd_args[@]}"
`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split("\n").filter(Boolean);
}

test("SHU-71 sandbox masks the Codex reviewer home from tests and from the Claude reviewer", () => {
  const mask = "--property=InaccessiblePaths=-/var/lib/shu-reviewer-codex";
  assert.deepEqual(maskArgs("test", "/usr/bin/node /srv/shu/studenthub-platform/.github/coordinator/review-execution-child.mjs"), [mask]);
  assert.deepEqual(maskArgs("model", "claude -p"), [mask]);
  assert.deepEqual(maskArgs("model", "codex exec"), [], "only the Codex model launch sees its own login");
});

// Execute the shipped model branch for Codex with privileged tools doubled.
function codexModelBranch({ home, mode = "700", owner = null, parentOwner = "0" }) {
  const start = sandboxSource.indexOf('if [[ "$profile" == "test" ]]; then');
  assert.ok(start >= 0, "SHU71_MODEL_HARNESS: execute the shipped profile branches and launch argv");
  return spawnSync("/bin/bash", ["-p", "-c", `
set -euo pipefail
profile=model
reviewer_uid=12345
reviewer_gid=12345
canonical_workspace=/fixture/attempt
reviewer_codex_home=${home}
systemd_args=()
CLAUDE_CODE_OAUTH_TOKEN=must-not-reach-codex
trusted_executable() { printf '%s\\n' "$1"; }
command() { printf '/fixture/bin/codex\\n'; }
function /usr/bin/stat {
  case "$2" in
    '%u:%a') printf '%s:%s\\n' "${owner ?? "12345"}" "${mode}" ;;
    '%u') printf '%s\\n' "${parentOwner}" ;;
    *) printf 'regular file:644\\n' ;;
  esac
}
function /usr/bin/systemd-run { printf '%s\\n' "$@"; }
set -- codex exec --json
${sandboxSource.slice(start)}
`], { encoding: "utf8" });
}

test("SHU-71 sandbox Codex model launch: fixed reviewer home is its only writable path and credential", () => {
  const home = mkdtempSync(join(tmpdir(), "shu71-codex-home-"));
  try {
    const run = codexModelBranch({ home });
    assert.equal(run.status, 0, run.stderr);
    const argv = run.stdout.split("\n");
    assert.deepEqual(argv.filter((arg) => /ReadWritePaths|CODEX_HOME|CLAUDE_CODE_OAUTH_TOKEN/.test(arg)),
      [`--property=ReadWritePaths=${home}`, `--setenv=CODEX_HOME=${home}`]);
    assert.deepEqual(argv.filter((arg) => /RestrictAddressFamilies|PrivateNetwork/.test(arg)), ["--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"]);
    assert.ok(argv.includes("--uid=12345"));
    assert.deepEqual(argv.slice(argv.indexOf("--") + 1).filter(Boolean), ["/fixture/bin/codex", "exec", "--json"]);
    for (const [label, over] of [["group/world access", { mode: "755" }], ["another owner", { owner: "0" }], ["a writable parent", { parentOwner: "1000" }]]) {
      const refused = codexModelBranch({ home, ...over });
      assert.equal(refused.status, 64, label);
      assert.match(refused.stderr, /requires the reviewer-owned 0700 Codex home/, label);
      assert.equal(refused.stdout, "", `${label}: nothing launches`);
    }
    const missing = codexModelBranch({ home: join(home, "absent") });
    assert.equal(missing.status, 64);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("SHU-71 sandbox contract: removing the Codex home mask or widening writes dies by a named assertion", () => {
  assert.equal(assertReviewerSandboxContract(sandboxSource), true);
  const mutate = (from, to) => {
    assert.equal(sandboxSource.split(from).length, 2, "SHU71_MUTATION_ANCHOR: mutation must change exactly one anchor");
    return sandboxSource.replace(from, to);
  };
  for (const [name, source] of [
    ["SHU71_CODEX_HOME_MASKED", mutate('if [[ "$profile" != "model" || "$1" != "codex" ]]; then', 'if false; then')],
    ["SHU71_CODEX_WRITE", mutate('runtime_args+=("--property=ReadWritePaths=$reviewer_codex_home")', 'runtime_args+=("--property=ReadWritePaths=$reviewer_codex_home" "--property=ReadWritePaths=/srv/shu")')],
    ["SHU71_CODEX_HOME_OWNER", mutate(`"\${reviewer_uid}:700"`, `"\${reviewer_uid}:755"`)],
    ["SHU71_CODEX_ENVIRONMENT", mutate('environment_args=("--setenv=CODEX_HOME=$reviewer_codex_home")', 'environment_args=("--setenv=CODEX_HOME=/srv/codex")')],
  ]) {
    assert.throws(() => assertReviewerSandboxContract(source), (error) => error.code === "ERR_ASSERTION" && error.message.includes(name), name);
  }
});
