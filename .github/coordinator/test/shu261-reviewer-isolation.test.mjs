import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { launchBuilder, validateCallback } from "../adapters/claude-code.mjs";
import { environmentValueDenied, inheritedDescriptorDenied, processInspectionDenied, protectedProbes } from "../review-execution-child.mjs";
import { PROTECTED_CLASSES, REVIEWER_IDENTITIES, REVIEWER_LAYOUT, assertIsolationEvidence, assertReviewerSandboxContract } from "../service/reviewer-isolation.mjs";

const ATTEMPT = "26126126-1261-4261-8261-261261261261";
const SHA = "6".repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu261-"));
  const workspace = path.join(root, ATTEMPT);
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(workspace, { mode: 0o750 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  const reportPath = path.join(evidence, "report.json");
  fs.writeFileSync(reportPath, "{}", { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, evidence, reportPath };
}

function report(over = {}) {
  return {
    actual_uid: 994,
    workspace_uid: 999,
    protected_class_probes: Object.fromEntries(PROTECTED_CLASSES.map((name) => [name, "DENIED"])),
    sibling_workspace_probe: "DENIED",
    symlink_probe: "DENIED",
    traversal_probe: "DENIED",
    inherited_descriptor_probe: "DENIED",
    environment_value_probe: "DENIED",
    process_inspection_probe: "DENIED",
    forbidden_env_keys: [],
    workspace_write_probe: "DENIED",
    tests: { executed: true, exit_code: 0 },
    ...over,
  };
}

test("SHU261 deployed identities and layout are exact, singular service-plane constants", () => {
  assert.deepEqual(REVIEWER_IDENTITIES, {
    coordinator: "shu-coordinator", reviewer: "shu-reviewer", writer: "shu-worker", workspace_group: "shu-workspace",
  }, "SHU261_IDENTITY: actual planned service identities must stay pinned");
  assert.equal(REVIEWER_LAYOUT.checkout, "/srv/shu/studenthub-platform", "SHU261_LAYOUT: deployed checkout must stay pinned");
  assert.equal(REVIEWER_LAYOUT.worktree_root, "/srv/shu/worktrees", "SHU261_LAYOUT: deployed attempt root must stay pinned");
  assert.equal(REVIEWER_LAYOUT.workspace_authority, "/srv/shu/state/workspaces", "SHU261_LAYOUT: workspace authority must stay outside attempts");
  assert.equal(REVIEWER_LAYOUT.coordinator_environment, "/srv/shu/coordinator.env", "SHU261_LAYOUT: coordinator environment path must stay pinned");
  assert.equal(REVIEWER_LAYOUT.deployed_supervisor_environment, "/srv/shu/service.env",
    "SHU261_LAYOUT: deployed SHU-251 supervisor environment must stay pinned alongside the configured default");
  assert.deepEqual(PROTECTED_CLASSES, ["activation_records", "workspace_authority", "supervisor_secrets", "coordinator_environment",
    "ssh_credentials", "codex_session_sidecars", "claude_session_sidecars", "coordinator_logs", "sibling_attempts"],
  "SHU261_CLASSES: every protected class must remain mandatory");
});

test("SHU261 wrapper contract isolates both reviewer phases and every protected class", () => {
  const source = fs.readFileSync(new URL("../reviewer-sandbox.sh", import.meta.url), "utf8");
  assert.equal(assertReviewerSandboxContract(source), true);
  const hostHarness = fs.readFileSync(new URL("../service/reviewer-host-validation.mjs", import.meta.url), "utf8");
  assert.match(hostHarness, /SHU261_HOST_MUTATION_APPROVED/, "SHU261_HOST_GATE: host mutation requires an explicit approval gate");
  assert.match(hostHarness, /--approved-host-mutation/, "SHU261_HOST_GATE: host mutation must bind an exact revision");
  assert.match(hostHarness, /byte-identical to the approved revision/,
    "SHU261_HOST_INSTALL: host validation must bind installed wrapper and sudoers bytes to the approved head");
  assert.match(hostHarness, /visudo.*-cf/s, "SHU261_HOST_INSTALL: installed sudoers syntax must be checked before mutation");
  assert.doesNotMatch(hostHarness, /systemctl\s+(?:start|enable)|ENABLE_DISPATCH\s*=\s*true/,
    "SHU261_HOST_GATE: isolation proof must not activate or start the coordinator");
  const sudoers = fs.readFileSync(new URL("../service/shu-reviewer.sudoers", import.meta.url), "utf8");
  assert.match(sudoers, /^Defaults!\/usr\/local\/libexec\/shu-reviewer-sandbox env_keep \+= "CLAUDE_CODE_OAUTH_TOKEN"$/m,
    "SHU261_SUDO: only reviewer OAuth may be preserved for the wrapper");
  assert.match(sudoers, /^shu-coordinator ALL=\(root\) NOPASSWD:NOSETENV: \/usr\/local\/libexec\/shu-reviewer-sandbox \*$/m,
    "SHU261_SUDO: coordinator may invoke only the reviewed wrapper");
  assert.doesNotMatch(sudoers, /NOPASSWD:\s*(?:ALL|\/bin\/(?:ba)?sh)/,
    "SHU261_SUDO: reviewer isolation must not grant a shell or general root command");
});

test("SHU261 model review crosses the validated reviewer wrapper with a clean environment", async (t) => {
  const f = fixture(t);
  const callback = { attempt_id: ATTEMPT, target_sha: SHA, stage: "PASS", links: [pathToFileURL(f.reportPath).href] };
  const calls = [];
  const result = await launchBuilder({
    issue_id: "SHU-261", authorization_ref: "SHU-261", attempt_id: ATTEMPT, target_sha: SHA,
    task_context: "Review the exact head.", oauth_token: "review-oauth-canary", cwd: f.workspace,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/shu-coordinator", GITHUB_TOKEN: "github-canary", LINEAR_API_TOKEN: "linear-canary",
      SHU_SUPERVISOR_SECRET: "supervisor-canary", SHU_PUSH_SSH_COMMAND: "ssh-canary", SHU_REVIEW_EVIDENCE_DIR: f.evidence },
    readHeadImpl: async () => SHA,
    reviewEvidenceImpl: async () => ({ executed: true, passed: true, reason_code: "REVIEW_TESTS_PASSED",
      evidence_link: pathToFileURL(f.reportPath).href, report: report(), isolation_wrapper: ["/usr/bin/sudo", "-n", "/usr/local/libexec/shu-reviewer-sandbox"] }),
    persistEnvelopeImpl: () => ({ link: pathToFileURL(path.join(f.evidence, "envelope.stdout")).href }),
    execFileImpl: (file, args, options, done) => { calls.push({ file, args, options }); queueMicrotask(() => done(null, JSON.stringify({ type: "result", session_id: ATTEMPT, structured_output: callback }), "")); },
  });
  assert.equal(result.stage, "COMPLETED", result.reason);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/sudo", "SHU261_MODEL_UID: Claude cannot run directly as the coordinator");
  assert.deepEqual(calls[0].args.slice(0, 10), ["-n", "/usr/local/libexec/shu-reviewer-sandbox",
    "--profile", "model", "--workspace-root", f.root, "--workspace", f.workspace, "--", "claude"],
  "SHU261_MODEL_BINDING: model profile must bind the exact assigned checkout");
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"],
    "SHU261_ENVIRONMENT: only path, inert home and the reviewer's own OAuth credential may cross the wrapper");
  assert.equal(calls[0].options.env.HOME, "/nonexistent", "SHU261_SIDECAR: coordinator home must not reach Claude");
  assert.equal(calls[0].args.some((part) => part.includes("review-oauth-canary")), false,
    "SHU261_ENVIRONMENT: reviewer OAuth must remain in the environment, never argv");
  for (const key of ["GITHUB_TOKEN", "LINEAR_API_TOKEN", "SHU_SUPERVISOR_SECRET", "SHU_PUSH_SSH_COMMAND"]) {
    assert.equal(Object.hasOwn(calls[0].options.env, key), false, `SHU261_WRITER_BROKER: ${key} cannot reach the reviewer`);
  }
  assert.equal(calls[0].args.includes("Read,Glob,Grep"), true, "SHU261_WRITER_BROKER: reviewer retains only read/search tools");
  assert.equal(calls[0].args.includes("Bash"), false, "SHU261_WRITER_BROKER: reviewer cannot run Git or host commands");
  const forged = validateCallback({ ...callback, result_sha: SHA }, { attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace, evidence_dir: f.evidence });
  assert.equal(forged.valid, false, "SHU261_RESULT_SHA: reviewer cannot manufacture writer result_sha");
  assert.equal(forged.field, "result_sha");
});

test("SHU261 restart and replay reuse the same reviewer identity boundary", async (t) => {
  const f = fixture(t);
  const wrappers = [];
  for (const resume of [false, true]) {
    const callback = { attempt_id: ATTEMPT, target_sha: SHA, stage: "PASS", links: [pathToFileURL(f.reportPath).href] };
    const result = await launchBuilder({
      issue_id: "SHU-261", authorization_ref: "SHU-261", attempt_id: ATTEMPT, target_sha: SHA, task_context: "Review.",
      oauth_token: "oauth", cwd: f.workspace, env: { PATH: "/usr/bin", SHU_REVIEW_EVIDENCE_DIR: f.evidence }, resume,
      readHeadImpl: async () => SHA,
      reviewEvidenceImpl: async () => ({ executed: true, passed: true, reason_code: "REVIEW_TESTS_PASSED", evidence_link: pathToFileURL(f.reportPath).href,
        report: report(), isolation_wrapper: ["/test/reviewer-model-wrapper"] }),
      persistEnvelopeImpl: () => ({ link: pathToFileURL(path.join(f.evidence, `envelope-${resume}.stdout`)).href }),
      execFileImpl: (file, args, options, done) => { wrappers.push({ file, args, env: options.env }); queueMicrotask(() => done(null,
        JSON.stringify({ type: "result", session_id: ATTEMPT, structured_output: callback }), "")); },
    });
    assert.equal(result.stage, "COMPLETED", result.reason);
  }
  assert.equal(wrappers.length, 2);
  assert.equal(wrappers.every((call) => call.file === "/test/reviewer-model-wrapper"), true,
    "SHU261_REPLAY: restart cannot fall back to coordinator-identity Claude");
  assert.deepEqual(wrappers.map((call) => call.args.slice(0, 7)), [wrappers[0].args.slice(0, 7), wrappers[0].args.slice(0, 7)],
    "SHU261_REPLAY: restart must retain the exact workspace/profile binding");
  assert.equal(wrappers[1].args.includes("--resume"), true, "SHU261_REPLAY: resume semantics survive confinement");
});

test("SHU261 missing validated model wrapper HOLDs before Claude", async (t) => {
  const f = fixture(t);
  const out = await launchBuilder({
    issue_id: "SHU-261", authorization_ref: "SHU-261", attempt_id: ATTEMPT, target_sha: SHA,
    task_context: "Review.", oauth_token: "oauth", cwd: f.workspace, env: { SHU_REVIEW_EVIDENCE_DIR: f.evidence },
    readHeadImpl: async () => SHA,
    reviewEvidenceImpl: async () => ({ executed: true, passed: true, reason_code: "REVIEW_TESTS_PASSED", evidence_link: pathToFileURL(f.reportPath).href, report: report() }),
    execFileImpl: () => assert.fail("SHU261_MODEL_UID: direct Claude launch is forbidden"),
  });
  assert.equal(out.stage, "HOLD");
  assert.equal(out.reason_code, "REVIEW_EXECUTION_UNAVAILABLE");
  assert.equal(out.pause_adapter, true);
});

test("SHU261 active attack probes are non-vacuous before confinement", async (t) => {
  const f = fixture(t);
  const sentinel = path.join(f.root, "sentinel");
  const symlink = path.join(f.workspace, "symlink");
  fs.writeFileSync(sentinel, "SHU261_FD_0123456789abcdef0123456789abcdef", { mode: 0o600 });
  fs.symlinkSync(sentinel, symlink);
  const traversal = path.relative(f.workspace, sentinel);
  const probes = protectedProbes(JSON.stringify([{ class: "activation_records", path: sentinel, symlink_path: symlink, traversal_path: traversal }]));
  assert.equal(probes.classes.activation_records, "REACHABLE", "SHU261_POSITIVE_PATH: direct sentinel is genuinely readable without confinement");
  assert.equal(probes.symlink, "REACHABLE", "SHU261_POSITIVE_SYMLINK: symlink attack is genuinely live without confinement");
  assert.equal(probes.traversal, "REACHABLE", "SHU261_POSITIVE_TRAVERSAL: traversal attack is genuinely live without confinement");

  const envCanary = "SHU261_ENV_0123456789abcdef0123456789abcdef";
  assert.equal(environmentValueDenied(envCanary, { ORDINARY_NAME: envCanary }), false,
    "SHU261_POSITIVE_ENVIRONMENT: value-based leakage is detected even under an innocent key");
  const fd = fs.openSync(sentinel, "r");
  try { assert.equal(inheritedDescriptorDenied("SHU261_FD_0123456789abcdef0123456789abcdef"), false, "SHU261_POSITIVE_FD: an open sentinel descriptor is detected"); }
  finally { fs.closeSync(fd); }

  const processCanary = `SHU261_PROCESS_${process.pid.toString(16).padStart(32, "0")}`;
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", processCanary], { stdio: "ignore" });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processInspectionDenied(processCanary), false, "SHU261_POSITIVE_PROCESS: visible sibling process canary is detected without confinement");
});

test("SHU261 sanitized evidence requires every denial and still requires assigned tests", () => {
  assert.equal(assertIsolationEvidence(report(), { expectedUid: 994 }), true);
  for (const name of PROTECTED_CLASSES) {
    const changed = report({ protected_class_probes: { ...report().protected_class_probes, [name]: "REACHABLE" } });
    assert.throws(() => assertIsolationEvidence(changed, { expectedUid: 994 }), new RegExp(`SHU261_CLASS_${name.toUpperCase()}`));
  }
  for (const [field, message] of [
    ["symlink_probe", "SHU261_SYMLINK"], ["traversal_probe", "SHU261_TRAVERSAL"],
    ["inherited_descriptor_probe", "SHU261_FD"], ["environment_value_probe", "SHU261_ENVIRONMENT"],
    ["process_inspection_probe", "SHU261_PROCESS"], ["workspace_write_probe", "SHU261_WRITE"],
  ]) assert.throws(() => assertIsolationEvidence(report({ [field]: "REACHABLE" }), { expectedUid: 994 }), new RegExp(message));
  assert.throws(() => assertIsolationEvidence(report({ sibling_workspace_probe: "REACHABLE" }), { expectedUid: 994 }), /SHU261_SIBLING/);
  assert.throws(() => assertIsolationEvidence(report({ forbidden_env_keys: ["GITHUB_TOKEN"] }), { expectedUid: 994 }), /SHU261_ENVIRONMENT/);
  assert.throws(() => assertIsolationEvidence(report({ tests: { executed: false, exit_code: null } }), { expectedUid: 994 }), /SHU261_POSITIVE_TEST/);
});
