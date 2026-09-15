#!/usr/bin/env node
// SHU-261 separately gated host mutation. PREPARED, NEVER run by CI or local
// verification. It creates harmless temporary sentinels, performs one bounded
// reviewer-sandbox invocation, removes every sentinel/workspace, and prints only
// sanitized uid/gid/mode/result evidence. It never reads or prints credential
// contents, enables dispatch, starts the coordinator, or changes persistent ACLs.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { environmentValueDenied, protectedFileDenied } from "../review-execution-child.mjs";
import { PROTECTED_CLASSES, REVIEWER_IDENTITIES, REVIEWER_LAYOUT, assertIsolationEvidence, readOnlyHostPreflight } from "./reviewer-isolation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const CHILD = path.join(REPO, ".github/coordinator/review-execution-child.mjs");
const REVIEWED_WRAPPER = path.join(REPO, ".github/coordinator/reviewer-sandbox.sh");
const REVIEWED_SUDOERS = path.join(REPO, ".github/coordinator/service/shu-reviewer.sudoers");
const WRAPPER = "/usr/local/libexec/shu-reviewer-sandbox";
const INSTALLED_SUDOERS = "/etc/sudoers.d/shu-reviewer";
const GETENT = "/usr/bin/getent";
const GIT = "/usr/bin/git";
const SETPRIV = "/usr/bin/setpriv";
const SUDO = "/usr/bin/sudo";
const VISUDO = "/usr/sbin/visudo";
const SHA = /^[0-9a-f]{40}$/;

function lookup(database, name) {
  const result = spawnSync(GETENT, [database, name], { encoding: "utf8" });
  assert.equal(result.status, 0, `SHU261_HOST_IDENTITY: ${database} ${name} must exist`);
  const parts = result.stdout.trim().split(":");
  return database === "passwd" ? { uid: Number(parts[2]), gid: Number(parts[3]) } : { gid: Number(parts[2]) };
}

function writeSentinel(directory, className, nonce) {
  const file = path.join(directory, `.shu261-${className}-${nonce}`);
  fs.writeFileSync(file, `SHU261_${className}_${nonce}`, { flag: "wx", mode: 0o600 });
  return file;
}

function installedReviewedFile(installed, reviewed, expectedMode) {
  const stat = fs.lstatSync(installed);
  assert.equal(stat.isFile(), true, `SHU261_HOST_INSTALL: ${installed} must be a regular file`);
  assert.equal(stat.isSymbolicLink(), false, `SHU261_HOST_INSTALL: ${installed} must not be a symlink`);
  assert.equal(stat.uid, 0, `SHU261_HOST_INSTALL: ${installed} must be root-owned`);
  assert.equal(stat.mode & 0o777, expectedMode, `SHU261_HOST_INSTALL: ${installed} mode must be ${expectedMode.toString(8)}`);
  assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(reviewed),
    `SHU261_HOST_INSTALL: ${installed} must be byte-identical to the approved revision`);
  return { path: installed, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

function runChild(file, args, options) {
  return new Promise((resolve) => {
    const child = spawn(file, args, options);
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", (error) => resolve({ error, status: null, stdout, stderr }));
    child.once("exit", (status, signal) => resolve({ error: null, status, signal, stdout, stderr }));
  });
}

export async function finalizeHostValidation({ cleanupCallbacks = [], verifyInventory, primaryError = null } = {}) {
  const cleanupErrors = [];
  for (const callback of [...cleanupCallbacks].reverse()) {
    try { await callback(); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await verifyInventory?.(); }
  catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      `SHU261_CLEANUP_AGGREGATE: ${cleanupErrors.length} cleanup or inventory operation(s) failed`,
    );
  }
  if (primaryError) throw primaryError;
}

export async function validateReviewerHost({ approvedRevision, env = process.env } = {}) {
  assert.equal(process.getuid?.(), 0, "SHU261_HOST_GATE: approved validation must run as root without escalating inside the script");
  assert.equal(env.SHU261_HOST_MUTATION_APPROVED, "true", "SHU261_HOST_GATE: explicit host-mutation approval environment is required");
  assert.match(approvedRevision ?? "", SHA, "SHU261_HOST_GATE: exact approved revision is required");
  assert.equal(REPO, REVIEWER_LAYOUT.checkout, "SHU261_HOST_REVISION: run only from the canonical deployed checkout");
  assert.equal(spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim(), approvedRevision,
    "SHU261_HOST_REVISION: checkout must equal the approved exact head");
  assert.equal(spawnSync(GIT, ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout, "",
    "SHU261_HOST_REVISION: deployed checkout must be clean");

  const installation = {
    wrapper: installedReviewedFile(WRAPPER, REVIEWED_WRAPPER, 0o755),
    sudoers: installedReviewedFile(INSTALLED_SUDOERS, REVIEWED_SUDOERS, 0o440),
  };
  const sudoersCheck = spawnSync(VISUDO, ["-cf", INSTALLED_SUDOERS], { encoding: "utf8" });
  assert.equal(sudoersCheck.status, 0, `SHU261_HOST_INSTALL: installed sudoers policy must parse: ${sudoersCheck.stderr}`);

  const preflight = readOnlyHostPreflight({
    lookupIdentity: (name) => lookup("passwd", name),
    lookupGroup: (name) => lookup("group", name),
  });
  const worktreesBefore = spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  assert.equal(worktreesBefore.status, 0, `SHU261_HOST_WORKTREE: initial inventory must succeed: ${worktreesBefore.stderr}`);
  const reviewerUid = preflight.identities.reviewer.uid;
  const nonce = randomUUID().replaceAll("-", "");
  const cleanup = [];
  let markerProcess;
  let server;
  let evidence;
  let primaryError;
  try {
    if (!fs.existsSync(REVIEWER_LAYOUT.coordinator_logs)) {
      fs.mkdirSync(REVIEWER_LAYOUT.coordinator_logs, { mode: 0o700 });
      cleanup.push(() => fs.rmdirSync(REVIEWER_LAYOUT.coordinator_logs));
      fs.chownSync(REVIEWER_LAYOUT.coordinator_logs, preflight.identities.coordinator.uid, preflight.identities.coordinator.gid);
    }
    const classDirectories = {
      activation_records: REVIEWER_LAYOUT.activation_records,
      workspace_authority: REVIEWER_LAYOUT.workspace_authority,
      supervisor_secrets: REVIEWER_LAYOUT.supervisor_secrets,
      ssh_credentials: REVIEWER_LAYOUT.ssh_credentials,
      codex_session_sidecars: REVIEWER_LAYOUT.codex_session_sidecars,
      service_home_claude_sidecars: REVIEWER_LAYOUT.service_home_claude_sidecars,
      claude_session_sidecars: REVIEWER_LAYOUT.claude_session_sidecars,
      coordinator_logs: REVIEWER_LAYOUT.coordinator_logs,
    };
    const sentinels = {};
    for (const [className, directory] of Object.entries(classDirectories)) {
      sentinels[className] = writeSentinel(directory, className, nonce);
      cleanup.push(() => fs.rmSync(sentinels[className], { force: true }));
    }
    // The coordinator environment is a protected file, not a directory. Probe
    // its exact deployed path by open/close only; never read its contents and
    // never mutate it.
    sentinels.coordinator_environment = REVIEWER_LAYOUT.coordinator_environment;

    const attempt = randomUUID();
    const sibling = randomUUID();
    const workspace = path.join(REVIEWER_LAYOUT.worktree_root, attempt);
    const siblingWorkspace = path.join(REVIEWER_LAYOUT.worktree_root, sibling);
    for (const candidate of [workspace, siblingWorkspace]) {
      const added = spawnSync(GIT, ["worktree", "add", "--detach", candidate, approvedRevision], { cwd: REPO, encoding: "utf8" });
      assert.equal(added.status, 0, `SHU261_HOST_WORKTREE: detached exact-head worktree must be created: ${added.stderr}`);
      cleanup.push(() => {
        const removed = spawnSync(GIT, ["worktree", "remove", "--force", candidate], { cwd: REPO, encoding: "utf8" });
        assert.equal(removed.status, 0, `SHU261_HOST_WORKTREE: temporary worktree cleanup must succeed: ${removed.stderr}`);
      });
      fs.chmodSync(candidate, 0o750);
      assert.equal(spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: candidate, encoding: "utf8" }).stdout.trim(), approvedRevision,
        "SHU261_HOST_WORKTREE: each temporary checkout must bind the approved exact head");
    }
    sentinels.sibling_attempts = writeSentinel(siblingWorkspace, "sibling_attempts", nonce);
    const testFile = ".github/coordinator/test/shu261-reviewer-isolation.test.mjs";

    const probes = [];
    for (const className of PROTECTED_CLASSES) {
      const target = sentinels[className];
      const symlink = path.join(workspace, `.shu261-link-${className}`);
      fs.symlinkSync(target, symlink);
      probes.push({ class: className, path: target, symlink_path: symlink, traversal_path: path.relative(workspace, target) });
      assert.equal(protectedFileDenied(target), false,
        `SHU261_POSITIVE_${className}: protected target must be openable before confinement`);
      assert.equal(protectedFileDenied(symlink), false,
        `SHU261_POSITIVE_${className}: symlink control must reach the target before confinement`);
      assert.equal(protectedFileDenied(path.resolve(workspace, path.relative(workspace, target))), false,
        `SHU261_POSITIVE_${className}: traversal control must reach the target before confinement`);
    }
    const deployedSupervisorLink = path.join(workspace, ".shu261-link-deployed-supervisor-environment");
    fs.symlinkSync(REVIEWER_LAYOUT.deployed_supervisor_environment, deployedSupervisorLink);
    probes.push({
      class: "deployed_supervisor_environment",
      path: REVIEWER_LAYOUT.deployed_supervisor_environment,
      symlink_path: deployedSupervisorLink,
      traversal_path: path.relative(workspace, REVIEWER_LAYOUT.deployed_supervisor_environment),
    });
    assert.equal(protectedFileDenied(REVIEWER_LAYOUT.deployed_supervisor_environment), false,
      "SHU261_POSITIVE_SUPERVISOR_ENVIRONMENT: deployed supervisor environment must be openable before confinement");

    const hardlink = path.join(workspace, ".shu261-hardlink");
    fs.linkSync(sentinels.sibling_attempts, hardlink);
    const hardlinkRefusal = spawnSync(SUDO, ["-n", WRAPPER, "--profile", "test", "--workspace-root", REVIEWER_LAYOUT.worktree_root,
      "--workspace", workspace, "--", process.execPath, CHILD], { encoding: "utf8" });
    assert.equal(hardlinkRefusal.status, 64, "SHU261_HARDLINK: hardlinked checkout must be refused before execution");
    assert.match(hardlinkRefusal.stderr, /refuses hardlinked files/, "SHU261_HARDLINK: refusal must name the hardlink boundary");
    fs.unlinkSync(hardlink);

    const fdCanary = `SHU261_FD_${nonce}`;
    const fdFile = writeSentinel(REVIEWER_LAYOUT.activation_records, "fd", nonce);
    cleanup.push(() => fs.rmSync(fdFile, { force: true }));
    fs.writeFileSync(fdFile, fdCanary, { mode: 0o600 });
    assert.equal(fs.readFileSync(fdFile, "utf8"), fdCanary, "SHU261_POSITIVE_FD: descriptor source canary must be live before confinement");
    const fd = fs.openSync(fdFile, "r");
    cleanup.push(() => { try { fs.closeSync(fd); } catch {} });

    const processCanary = `SHU261_PROCESS_${nonce}`;
    markerProcess = spawn(SETPRIV, [
      `--reuid=${REVIEWER_IDENTITIES.coordinator}`, `--regid=${REVIEWER_IDENTITIES.coordinator}`, "--clear-groups",
      process.execPath, "-e", "setInterval(()=>{},1000)", processCanary,
    ], { stdio: "ignore" });
    cleanup.push(() => {
      if (markerProcess.exitCode === null && !markerProcess.kill("SIGTERM")) {
        throw new Error("SHU261_CLEANUP_PROCESS: coordinator process canary could not be stopped");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(fs.readFileSync(`/proc/${markerProcess.pid}/cmdline`, "utf8"), new RegExp(processCanary),
      "SHU261_POSITIVE_PROCESS: coordinator process canary must be inspectable before confinement");

    server = net.createServer((socket) => socket.end());
    cleanup.push(() => new Promise((resolve, reject) => {
      try { server.close((error) => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    }));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const environmentCanary = `SHU261_ENV_${nonce}`;
    const args = ["-n", WRAPPER, "--profile", "test", "--workspace-root", REVIEWER_LAYOUT.worktree_root, "--workspace", workspace, "--",
      process.execPath, CHILD, "--cwd", workspace, "--expected-uid", String(reviewerUid), "--protected-path", sentinels.activation_records,
      "--sibling-probe-path", sentinels.sibling_attempts, "--probe-port", String(server.address().port), "--target-sha", approvedRevision,
      "--protected-paths-json", JSON.stringify(probes), "--fd-canary", fdCanary, "--env-canary", environmentCanary,
      "--process-canary", processCanary, "--", testFile];
    const childEnvironment = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", SHU261_ENV_CANARY: environmentCanary };
    assert.equal(environmentValueDenied(environmentCanary, childEnvironment), false,
      "SHU261_POSITIVE_ENVIRONMENT: innocent-key canary must be live before confinement");
    const run = await runChild(SUDO, args, {
      cwd: REPO,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    assert.equal(run.status, 0, `SHU261_HOST_EXECUTION: confined validation must pass: ${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assertIsolationEvidence(report, { expectedUid: reviewerUid });
    assert.equal(report.protected_class_probes.deployed_supervisor_environment, "DENIED",
      "SHU261_CLASS_SUPERVISOR_SECRETS: deployed /srv/shu/service.env must be inaccessible");

    evidence = {
      version: "shu261-host-validation-v1",
      revision: approvedRevision,
      installation,
      identities: preflight.identities,
      paths: preflight.paths,
      protected_classes: Object.fromEntries(PROTECTED_CLASSES.map((name) => [name, report.protected_class_probes[name]])),
      attacks: {
        symlink: report.symlink_probe, hardlink: "DENIED", traversal: report.traversal_probe,
        inherited_descriptor: report.inherited_descriptor_probe, environment: report.environment_value_probe,
        process_inspection: report.process_inspection_probe, sibling_worktree: report.sibling_workspace_probe,
      },
      positive: { uid: report.actual_uid, workspace_uid: report.workspace_uid, tests_executed: report.tests.executed, tests_exit_code: report.tests.exit_code },
    };
  } catch (error) {
    primaryError = error;
  }
  await finalizeHostValidation({
    cleanupCallbacks: cleanup,
    primaryError,
    verifyInventory: () => {
      const worktreesAfter = spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: REPO, encoding: "utf8" });
      assert.equal(worktreesAfter.status, 0, `SHU261_HOST_WORKTREE: final inventory must succeed: ${worktreesAfter.stderr}`);
      assert.equal(worktreesAfter.stdout, worktreesBefore.stdout,
        "SHU261_HOST_WORKTREE: bounded validation must restore the exact worktree inventory");
    },
  });
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, revision] = process.argv.slice(2);
  assert.equal(flag, "--approved-host-mutation", "SHU261_HOST_GATE: use --approved-host-mutation <exact-sha>");
  console.log(JSON.stringify(await validateReviewerHost({ approvedRevision: revision }), null, 2));
}
