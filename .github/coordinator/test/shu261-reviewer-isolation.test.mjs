import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { launchBuilder, validateCallback } from "../adapters/claude-code.mjs";
import { runReviewEvidence, runtimeIsolationEvidenceValid } from "../review-execution.mjs";
import { environmentValueDenied, inheritedDescriptorDenied, processInspectionDenied, protectedProbes } from "../review-execution-child.mjs";
import { PROTECTED_CLASSES, REVIEWER_IDENTITIES, REVIEWER_LAYOUT, assertIsolationEvidence, assertReviewerSandboxContract } from "../service/reviewer-isolation.mjs";
import { finalizeHostValidation } from "../service/reviewer-host-validation.mjs";

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
    "ssh_credentials", "codex_session_sidecars", "service_home_claude_sidecars", "claude_session_sidecars", "coordinator_logs", "sibling_attempts"],
  "SHU261_CLASSES: every protected class must remain mandatory");
});

test("SHU261 wrapper contract isolates both reviewer phases and every protected class", () => {
  const source = fs.readFileSync(new URL("../reviewer-sandbox.sh", import.meta.url), "utf8");
  assert.equal(assertReviewerSandboxContract(source), true);
  assert.match(source, /^#!\/bin\/bash -p$/m,
    "SHU261_ROOT_STARTUP: the root wrapper must use a fixed privileged-mode interpreter");
  assert.doesNotMatch(source, /^#!\/usr\/bin\/env\s+/m,
    "SHU261_ROOT_STARTUP: root wrapper startup must not resolve its interpreter through caller PATH");
  assert.match(source, /done < <\(compgen -e\)/,
    "SHU261_ROOT_ENVIRONMENT: every inherited environment name must be considered for removal");
  assert.ok(source.indexOf("compgen -e") < source.indexOf("set -euo pipefail"),
    "SHU261_ROOT_ENVIRONMENT: ambient variables must be removed before root-side command processing");
  assert.match(source, /export PATH="\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/,
    "SHU261_ROOT_ENVIRONMENT: root-side command search must use a fixed path");
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
    "SHU261_NO_SETENV: coordinator may invoke only the reviewed wrapper without controlling its root environment");
  assert.doesNotMatch(sudoers, /NOPASSWD:\s*(?:ALL|\/bin\/(?:ba)?sh)/,
    "SHU261_SUDO: reviewer isolation must not grant a shell or general root command");
});

test("SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu261-root-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "startup-ran");
  const fakeBash = path.join(root, "bash");
  const bashEnv = path.join(root, "bash-env");
  fs.writeFileSync(fakeBash, `#!/bin/sh\nprintf PATH > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  fs.writeFileSync(bashEnv, `printf BASH_ENV > ${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const script = new URL("../reviewer-sandbox.sh", import.meta.url);
  const run = spawnSync(script.pathname, ["invalid"], {
    encoding: "utf8",
    env: { PATH: root, BASH_ENV: bashEnv, SUDO_UID: "1000" },
  });
  assert.equal(run.status, 64, "SHU261_ROOT_STARTUP: malformed invocation is rejected by the reviewed wrapper");
  assert.equal(fs.existsSync(marker), false,
    "SHU261_ROOT_STARTUP: neither a PATH interpreter nor BASH_ENV code may execute during root wrapper startup");
  assert.match(run.stderr, /exact workspace binding/, "SHU261_ROOT_STARTUP: parsing, not hostile startup code, controls the result");
});

test("SHU261 canaries are mandatory, propagated, and validated before assigned tests", async (t) => {
  assert.equal(protectedProbes(undefined).ok, false,
    "SHU261_CANARY_MISSING_MUST_FAIL: protected-path canary absence cannot pass");
  assert.equal(protectedProbes(JSON.stringify([{ class: "coordinator_evidence", path: "/tmp/x" }])).ok, false,
    "SHU261_CANARY_MISSING_MUST_FAIL: symlink and traversal controls are mandatory");
  const unknownProtected = protectedProbes(JSON.stringify([
    { class: "unknown", path: "/tmp/x", symlink_path: "/tmp/y", traversal_path: "../x" },
  ]));
  assert.deepEqual(unknownProtected.classes, {},
    "SHU261_CANARY_MISSING_MUST_FAIL: unknown protected classes cannot substitute for reviewed canaries");
  assert.equal(unknownProtected.symlink, "INVALID",
    "SHU261_CANARY_MISSING_MUST_FAIL: an unknown class must be rejected before attack probes run");
  assert.equal(inheritedDescriptorDenied(undefined), false,
    "SHU261_CANARY_MISSING_MUST_FAIL: inherited-descriptor canary absence cannot pass");
  assert.equal(environmentValueDenied(undefined), false,
    "SHU261_CANARY_MISSING_MUST_FAIL: environment canary absence cannot pass");
  assert.equal(processInspectionDenied(undefined), false,
    "SHU261_CANARY_MISSING_MUST_FAIL: process canary absence cannot pass");
  for (const malformed of ["", "unknown", "SHU261_FD_wrong", "SHU261_ENV_wrong", "SHU261_PROCESS_wrong"]) {
    assert.equal(inheritedDescriptorDenied(malformed), false, "SHU261_CANARY_MISSING_MUST_FAIL: malformed FD canary cannot pass");
    assert.equal(environmentValueDenied(malformed), false, "SHU261_CANARY_MISSING_MUST_FAIL: malformed environment canary cannot pass");
    assert.equal(processInspectionDenied(malformed), false, "SHU261_CANARY_MISSING_MUST_FAIL: malformed process canary cannot pass");
  }

  const runtimeReport = {
    protected_class_probes: { coordinator_evidence: "DENIED" }, symlink_probe: "DENIED", traversal_probe: "DENIED",
    inherited_descriptor_probe: "DENIED", environment_value_probe: "DENIED", process_inspection_probe: "DENIED",
  };
  assert.equal(runtimeIsolationEvidenceValid(runtimeReport), true,
    "SHU261_CANARY_MISSING_MUST_FAIL: complete runtime isolation evidence is accepted");
  for (const field of ["protected_class_probes", "symlink_probe", "traversal_probe", "inherited_descriptor_probe",
    "environment_value_probe", "process_inspection_probe"]) {
    assert.equal(runtimeIsolationEvidenceValid({ ...runtimeReport, [field]: undefined }), false,
      `SHU261_CANARY_MISSING_MUST_FAIL: ${field} is individually load-bearing`);
  }

  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "assigned.test.mjs"), "");
  const expectedUid = (process.getuid?.() ?? 0) + 1000;
  let childArgs = [];
  const result = await runReviewEvidence({
    attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace,
    env: {
      SHU_REVIEW_EXEC_UID: String(expectedUid),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify(["/test/wrapper"]),
      SHU_REVIEW_MODEL_WRAPPER_JSON: JSON.stringify(["/test/wrapper"]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["assigned.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: f.evidence,
    },
    validateWrapperImpl: (wrapper) => wrapper,
    startProcessCanaryImpl: async () => ({ kill: () => true }),
    listenProbeImpl: async () => ({ address: () => ({ port: 26123 }), close: (done) => done() }),
    execFileImpl: (_file, args, _options, callback) => {
      childArgs = args;
      queueMicrotask(() => callback(null, JSON.stringify({
        target_sha: SHA, test_files: ["assigned.test.mjs"], actual_uid: expectedUid, expected_uid: expectedUid,
        filesystem_probe: "DENIED", sibling_workspace_probe: "DENIED", workspace_write_probe: "DENIED",
        network_probe: "DENIED", forbidden_env_keys: [], ...runtimeReport,
        tests: { executed: true, exit_code: 0 },
      }), ""));
    },
  });
  assert.equal(result.executed, true, result.detail);
  for (const option of ["--protected-paths-json", "--fd-canary", "--env-canary", "--process-canary"]) {
    assert.ok(childArgs.includes(option), `SHU261_CANARY_PROPAGATION: ${option} must reach the confined child`);
  }
});

test("SHU261 cleanup attempts every callback and inventory check before aggregate failure", async () => {
  const calls = [];
  await assert.rejects(
    finalizeHostValidation({
      cleanupCallbacks: [
        () => { calls.push("first"); },
        () => { calls.push("failing"); throw new Error("simulated cleanup failure"); },
        async () => { calls.push("last"); },
      ],
      verifyInventory: () => { calls.push("inventory"); throw new Error("simulated inventory mismatch"); },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true, "SHU261_CLEANUP_RUNS_ALL_CALLBACKS: cleanup failures are aggregated");
      assert.equal(error.errors.length, 2, "SHU261_CLEANUP_RUNS_ALL_CALLBACKS: callback and inventory failures are both reported");
      return true;
    },
  );
  assert.deepEqual(calls, ["last", "failing", "first", "inventory"],
    "SHU261_CLEANUP_RUNS_ALL_CALLBACKS: one failure cannot skip any cleanup or final inventory validation");

  const primaryError = new Error("simulated isolation failure");
  await assert.rejects(
    finalizeHostValidation({
      primaryError,
      cleanupCallbacks: [() => { throw new Error("simulated cleanup failure"); }],
      verifyInventory: () => {},
    }),
    (error) => {
      assert.equal(error.cause, primaryError,
        "SHU261_CLEANUP_PRIMARY_CAUSE: cleanup aggregation must retain the primary isolation failure as its cause");
      assert.equal(error.errors[0], primaryError,
        "SHU261_CLEANUP_PRIMARY_CAUSE: aggregate details must retain the primary isolation failure");
      return true;
    },
  );
  await assert.rejects(
    finalizeHostValidation({ primaryError, verifyInventory: () => {} }),
    (error) => error === primaryError,
    "SHU261_CLEANUP_PRIMARY_CAUSE: successful cleanup must rethrow the original validation error unchanged",
  );
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
