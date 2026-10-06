// repo-scope.test.mjs
//
// SHU-296: a third workspace scope, "repo". The writer holds the whole tree at
// target_sha with dependencies installed by the host, yet its result is held to
// its literal paths exactly like a scoped writer's: from the preserved full
// base, by full-tree diff. Gitignored output (node_modules/, dist/) is never
// published, and repo-mode paths never reach what the dependency install owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  COMMAND_TIMEOUT_MS,
  DEPENDENCY_INSTALL_ARGS,
  DEPENDENCY_INSTALL_TIMEOUT_MS,
  deriveScopedBaseShaFromRemote,
  prepareAttemptWorkspace,
  run,
  workspaceFailureCode,
} from "../attempt-workspace.mjs";
import { pushExactSha } from "../push-broker.mjs";
import {
  REPO_MODE_REFUSED_PATHS,
  WORKSPACE_SCOPES,
  initialWorkspaceScope,
  normalizeReceiptWorkspaceScope,
  successorWorkspaceScope,
  validateCardContractMode,
  validateFixtureAttemptScope,
  validateFixtureScopePolicy,
  validateWorkspaceScope,
} from "../workspace-scope.mjs";
import { SHU197_PATHS } from "../card-contracts.mjs";
import { buildCodexPrompt } from "../adapters/codex-cli.mjs";
import { writerEditRules } from "../adapters/claude-code.mjs";

const REPO = "BAWES-Universe/studenthub-platform";
const BRANCH = "coordinator/SHU-901";
const ALLOWED = Object.freeze(["src/app.mjs", "src/test/app.test.mjs"]);
const WRAPPER = "shu-test-wrapper";
const git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

function fixture({ lockfile = true } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "shu296-")); fs.chmodSync(dir, 0o755);
  const remote = path.join(dir, "BAWES-Universe", "studenthub-platform.git"); fs.mkdirSync(path.dirname(remote)); git(dir, "init", "--bare", remote);
  const seed = path.join(dir, "seed"); git(dir, "init", seed); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  for (const [name, body] of [
    [".gitignore", "node_modules/\ndist/\n"],
    ["package.json", "{\"name\":\"fixture\",\"version\":\"1.0.0\"}\n"],
    ...(lockfile ? [["package-lock.json", "{\"name\":\"fixture\",\"lockfileVersion\":3,\"packages\":{}}\n"]] : []),
    [ALLOWED[0], "export const value = 1;\n"],
    [ALLOWED[1], "// allowed test\n"],
    ["src/other.mjs", "export const other = 1;\n"],
    ["README.md", "base\n"],
  ]) { fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true }); fs.writeFileSync(path.join(seed, name), body); }
  git(seed, "add", "."); git(seed, "commit", "-m", "fixture"); const sha = git(seed, "rev-parse", "HEAD");
  git(seed, "push", remote, `HEAD:refs/heads/${BRANCH}`);
  const root = path.join(dir, "workspaces"), state = path.join(dir, "state"); fs.mkdirSync(root); fs.chmodSync(root, 0o3770); fs.mkdirSync(state, { mode: 0o700 });
  const env = { ...process.env, SHU_WORKTREE_ROOT: root, SHU_WORKSPACE_STATE_DIR: state, SHU_PUSH_REMOTE_URL: `file://${remote}`,
    SHU_WORKER_UID: "65534", SHU_WORKER_LAUNCH_WRAPPER: WRAPPER, PATH: process.env.PATH, HOME: dir,
    GITHUB_TOKEN: "coordinator-secret-token", SHU_COORDINATOR_SECRET: "coordinator-secret" };
  const receipt = (over = {}) => ({ attempt_id: randomUUID(), issue_id: "SHU-901", authorization_ref: "SHU-901",
    requested_worker: "codex-builder", repo: REPO, branch: BRANCH, target_sha: sha,
    workspace_scope: "repo", scope_phase: "initial", allowed_paths: [...ALLOWED], scoped_base_sha: null, ...over });
  return { dir, remote, seed, sha, root, state, env, receipt,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

// The checkout a repo writer is given, built as this test's own uid: the full
// base bundle the broker reconstructs against, then the bound bundle at
// target_sha with its remote retired.
function repoWorkspace(f, attemptId = randomUUID()) {
  const source = path.join(f.dir, `source-${randomUUID()}`); git(f.dir, "init", "--bare", source);
  git(source, "fetch", "--no-tags", `file://${f.remote}`, f.sha); git(source, "update-ref", "refs/heads/bound", f.sha); git(source, "symbolic-ref", "HEAD", "refs/heads/bound");
  git(source, "bundle", "create", path.join(f.state, `${attemptId}.base.bundle`), "refs/heads/bound"); fs.chmodSync(path.join(f.state, `${attemptId}.base.bundle`), 0o600);
  const bundle = path.join(source, "bound.bundle"); git(source, "bundle", "create", bundle, "refs/heads/bound");
  const cwd = path.join(f.root, attemptId); git(f.root, "clone", "--no-local", "--no-checkout", "--template=", "--", bundle, cwd);
  git(cwd, "checkout", "--detach", f.sha, "--"); git(cwd, "config", "--remove-section", "remote.origin");
  fs.rmSync(source, { recursive: true, force: true }); fs.chmodSync(cwd, 0o750); return { cwd };
}

function publish(f, r, cwd) {
  return pushExactSha({ env: f.env, stateDir: f.state, attempt_id: r.attempt_id, result_sha: null, target_sha: f.sha, branch: BRANCH, repo: REPO,
    worktree: cwd, allowedRoot: f.root, remoteUrl: `file://${f.remote}`, allowedHost: "file", workspaceReady: true,
    workspace_scope: r.workspace_scope, scope_phase: r.scope_phase, allowed_paths: r.allowed_paths, scoped_base_sha: r.scoped_base_sha });
}

function write(cwd, name, body) {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), body);
}

// Runs every command as this uid, dropping the configured wrapper, and records
// it. npm never runs: `npm` resolves to the supplied fake, so no registry,
// cache or real install is involved.
function recordingExec(calls, fakeNpm = () => "") {
  return (file, args, options) => {
    const [command, commandArgs] = file === WRAPPER ? [args[0], args.slice(1)] : [file, args];
    calls.push({ wrapped: file === WRAPPER, command, args: commandArgs, options });
    if (command === "npm") return fakeNpm(commandArgs, options);
    return execFileSync(command, commandArgs, options);
  };
}

const npmCalls = (calls) => calls.filter((call) => call.command === "npm");

test("SHU-296 R1: repo is a third scope with a non-empty literal path set, no scoped base and no review phase", () => {
  assert.deepEqual(WORKSPACE_SCOPES, ["scoped", "full", "repo"]);
  const scope = { workspace_scope: "repo", scope_phase: "initial", allowed_paths: [...ALLOWED], scoped_base_sha: null };
  assert.equal(validateWorkspaceScope(scope, { requireScopedBase: true }).ok, true);
  assert.equal(validateWorkspaceScope({ ...scope, scope_phase: "revision" }, { requireScopedBase: true }).ok, true);
  assert.match(validateWorkspaceScope({ ...scope, scope_phase: "review" }).reason, /review workspace must be full/);
  assert.match(validateWorkspaceScope({ ...scope, scope_phase: "review", allowed_paths: [] }).reason, /review workspace must be full/);
  assert.match(validateWorkspaceScope({ ...scope, scoped_base_sha: "d".repeat(40) }).reason, /repo workspace must not carry a scoped_base_sha/);
  assert.match(validateWorkspaceScope({ ...scope, allowed_paths: [] }).reason, /non-empty array of exact paths/);
  assert.match(validateWorkspaceScope({ ...scope, allowed_paths: ["src/*.mjs"] }).reason, /non-literal/);
  const normalized = normalizeReceiptWorkspaceScope({ requested_worker: "codex-builder", issue_id: "SHU-901", ...scope });
  assert.equal(normalized.ok, true, normalized.reason);
  assert.equal(normalized.scope.workspace_scope, "repo");
  assert.equal(normalizeReceiptWorkspaceScope({ requested_worker: "claude-verifier", issue_id: "SHU-901", ...scope, scope_phase: "review" }).ok, false,
    "a reviewer never receives a repo scope");
});

test("SHU-296 R2: repo-mode paths may not reach the lockfile, npm config, node_modules/ or .github/, and package.json stays writable", () => {
  assert.deepEqual(REPO_MODE_REFUSED_PATHS, ["package-lock.json", ".npmrc", "node_modules", ".github"]);
  const scope = { workspace_scope: "repo", scope_phase: "initial", scoped_base_sha: null };
  for (const owned of ["package-lock.json", ".npmrc", "node_modules/x", ".github/x", ".github/coordinator/config.json", "node_modules"]) {
    const refused = validateWorkspaceScope({ ...scope, allowed_paths: [ALLOWED[0], owned] });
    assert.equal(refused.ok, false, `repo mode must refuse ${owned}`);
    assert.match(refused.reason, new RegExp(`repo-mode allowed_paths may not include ${owned.replace(/[.]/g, "\\.")}`));
    assert.equal(validateWorkspaceScope({ ...scope, workspace_scope: "scoped", allowed_paths: [ALLOWED[0], owned] }).ok, true,
      `scoped mode is unchanged for ${owned}`);
  }
  for (const near of ["package.json", "apps/web/package.json", "package-lock.json.bak", "github/x", "src/node_modules.mjs"]) {
    assert.equal(validateWorkspaceScope({ ...scope, allowed_paths: [near] }).ok, true, `${near} is not install-owned`);
  }
});

const REPO_CONTRACT = Object.freeze({ initial_build_paths: ALLOWED, revision_paths: [...ALLOWED, "docs/app.md"], acceptance: "x", brief: "y", workspace_mode: "repo" });
const REPO_LANE = Object.freeze({ id: "SHU-901", initial_build_paths: [...ALLOWED], revision_paths: [...ALLOWED, "docs/app.md"] });

test("SHU-296 R3: a contract opts in with workspace_mode repo, and its install-owned paths are refused", () => {
  assert.deepEqual(validateCardContractMode({ initial_build_paths: ALLOWED, revision_paths: ALLOWED }), { ok: true, workspace_scope: "scoped" });
  assert.deepEqual(validateCardContractMode(REPO_CONTRACT), { ok: true, workspace_scope: "repo" });
  assert.match(validateCardContractMode({ ...REPO_CONTRACT, workspace_mode: "full" }).reason, /workspace_mode must be "repo"/);
  for (const owned of ["package-lock.json", ".npmrc", "node_modules/x", ".github/x"]) {
    for (const key of ["initial_build_paths", "revision_paths"]) {
      const contract = { ...REPO_CONTRACT, [key]: [...REPO_CONTRACT[key], owned] };
      assert.match(validateCardContractMode(contract).reason, /repo-mode .* may not include/, `${key} with ${owned}`);
      const lane = { ...REPO_LANE, [key]: [...REPO_LANE[key], owned] };
      assert.equal(validateFixtureScopePolicy(lane, contract).ok, false, `policy refuses ${key} with ${owned}`);
    }
  }
  const policy = validateFixtureScopePolicy(REPO_LANE, REPO_CONTRACT);
  assert.equal(policy.ok, true, policy.reason);
  assert.equal(policy.workspace_scope, "repo");
  assert.match(validateFixtureScopePolicy({ ...REPO_LANE, workspace_mode: "scoped" }, REPO_CONTRACT).reason, /workspace_mode differs/);
});

test("SHU-296 R4: writer scopes follow the contract's mode, reviewers stay full, and receipts are checked against its paths", () => {
  const initial = initialWorkspaceScope({ issueId: "SHU-901", requestedWorker: "codex-builder", fixtureLane: REPO_LANE, contract: REPO_CONTRACT });
  assert.deepEqual(initial, { workspace_scope: "repo", scope_phase: "initial", allowed_paths: [...ALLOWED], scoped_base_sha: null });
  assert.deepEqual(successorWorkspaceScope("revise", REPO_LANE, REPO_CONTRACT),
    { workspace_scope: "repo", scope_phase: "revision", allowed_paths: [...ALLOWED, "docs/app.md"], scoped_base_sha: null });
  assert.deepEqual(successorWorkspaceScope("review", REPO_LANE, REPO_CONTRACT), { workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null });
  assert.deepEqual(initialWorkspaceScope({ issueId: "SHU-901", requestedWorker: "claude-verifier", fixtureLane: REPO_LANE, contract: REPO_CONTRACT }).workspace_scope, "full");
  assert.equal(validateFixtureAttemptScope({ issue_id: "SHU-901", ...initial }, REPO_CONTRACT).ok, true);
  assert.match(validateFixtureAttemptScope({ issue_id: "SHU-901", ...initial, allowed_paths: [...ALLOWED, "src/other.mjs"] }, REPO_CONTRACT).reason, /^LANE_MISMATCH:/);
  assert.match(validateFixtureAttemptScope({ issue_id: "SHU-901", ...initial, workspace_scope: "scoped" }, REPO_CONTRACT).reason, /^LANE_MISMATCH:/,
    "a repo contract's writer is never given a scoped receipt");
  // The committed cards keep the scoped writer: a repo receipt for one is refused.
  assert.deepEqual(initialWorkspaceScope({ issueId: "SHU-197", requestedWorker: "codex-builder", fixtureLane: { id: "SHU-197", initial_build_paths: [...SHU197_PATHS], revision_paths: [...SHU197_PATHS] } }).workspace_scope, "scoped");
  const widened = { issue_id: "SHU-197", workspace_scope: "repo", scope_phase: "initial", allowed_paths: [...SHU197_PATHS], scoped_base_sha: null };
  assert.match(validateFixtureAttemptScope(widened).reason, /^LANE_MISMATCH:/);
  assert.equal(normalizeReceiptWorkspaceScope({ requested_worker: "codex-builder", ...widened }).ok, false);
});

test("SHU-296 R5: an allowed edit publishes with target_sha as parent, and gitignored node_modules/ and dist/ are ignored", async () => {
  const f = fixture(); try {
    const r = f.receipt(); const { cwd } = repoWorkspace(f, r.attempt_id);
    write(cwd, ALLOWED[0], "export const value = 2;\n");
    write(cwd, "node_modules/dep/index.js", "module.exports = 1;\n");
    write(cwd, "dist/app.js", "built\n");
    const result = await publish(f, r, cwd);
    assert.equal(result.ok, true, result.reason);
    assert.equal(git(f.remote, "rev-parse", `${result.remote_head}^`), f.sha, "the result's parent is target_sha");
    assert.equal(git(f.remote, "diff", "--name-status", f.sha, result.remote_head), `M\t${ALLOWED[0]}`, "only the allowed path changed");
    assert.equal(git(f.remote, "ls-tree", "-r", "--name-only", result.remote_head).split("\n").some((name) => /^(node_modules|dist)\//.test(name)), false,
      "gitignored output is never published");
    assert.equal(git(f.remote, "show", `${result.remote_head}:src/other.mjs`), "export const other = 1;", "the rest of the tree is the base's");
    const binding = JSON.parse(fs.readFileSync(path.join(f.state, `workspace-result-${r.attempt_id}.json`), "utf8"));
    assert.equal(binding.workspace_scope, "repo");
    assert.deepEqual(binding.allowed_paths, [...ALLOWED]);
  } finally { f.cleanup(); }
});

test("SHU-296 R6: a tracked edit, a deletion or a non-ignored new file outside the paths is refused RESULT_SCOPE_REFUSED", async () => {
  const attacks = [
    ["tracked edit outside", (cwd) => write(cwd, "src/other.mjs", "export const other = 2;\n")],
    ["tracked deletion outside", (cwd) => fs.rmSync(path.join(cwd, "README.md"))],
    ["untracked file outside", (cwd) => write(cwd, "src/new.mjs", "export {};\n")],
    ["a manifest outside the paths", (cwd) => write(cwd, "package.json", "{\"name\":\"widened\"}\n")],
    ["gitignore widened", (cwd) => write(cwd, ".gitignore", "node_modules/\ndist/\nsrc/\n")],
  ];
  for (const [name, attack] of attacks) {
    const f = fixture(); try {
      const r = f.receipt(); const { cwd } = repoWorkspace(f, r.attempt_id);
      write(cwd, ALLOWED[0], "export const value = 2;\n"); attack(cwd);
      const result = await publish(f, r, cwd);
      assert.equal(result.ok, false, `${name} unexpectedly published`);
      assert.match(result.reason, /RESULT_SCOPE_REFUSED/, name);
      assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), f.sha, `${name}: the remote never advances`);
      assert.equal(fs.existsSync(path.join(f.state, `workspace-result-${r.attempt_id}.json`)), false, `${name}: refusal precedes result binding`);
    } finally { f.cleanup(); }
  }
});

test("SHU-296 R7: a repo writer checkout installs dependencies once, as the lane identity, with the long per-call timeout and no coordinator credentials", () => {
  const f = fixture(); try {
    const calls = [];
    const r = f.receipt();
    const exec = recordingExec(calls, (_args, options) => {
      write(options.cwd, "node_modules/dep/index.js", "module.exports = 1;\n");
      write(options.cwd, "node_modules/.package-lock.json", "{}\n");
      return "";
    });
    // This test runs as one uid, so preparation stops at the owner check that
    // follows the install; everything before it has run for real.
    assert.throws(() => prepareAttemptWorkspace({ receipt: r, env: f.env, allowedHost: "file", execImpl: exec }), /workspace owner does not match its lane identity/);
    const cwd = path.join(f.root, r.attempt_id);
    assert.equal(git(cwd, "rev-parse", "HEAD"), f.sha, "HEAD is target_sha, like a full checkout");
    assert.equal(git(cwd, "remote"), "", "no remote survives");
    assert.ok(fs.existsSync(path.join(f.state, `${r.attempt_id}.base.bundle`)), "the full base bundle is preserved for the broker");
    const npm = npmCalls(calls);
    assert.equal(npm.length, 1, "npm ci runs exactly once");
    const [install] = npm;
    assert.equal(install.wrapped, true, "npm runs through the lane identity wrapper");
    assert.equal(install.options.cwd, cwd);
    assert.deepEqual(install.args.slice(0, DEPENDENCY_INSTALL_ARGS.length), ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const cache = install.args[install.args.indexOf("--cache") + 1];
    assert.match(cache, /^\/tmp\/shu-npm-cache-[A-Za-z0-9]{8}$/);
    assert.equal(install.options.timeout, DEPENDENCY_INSTALL_TIMEOUT_MS);
    assert.equal(DEPENDENCY_INSTALL_TIMEOUT_MS, 15 * 60_000);
    assert.equal(install.options.env.npm_config_cache, cache);
    assert.equal(install.options.env.npm_config_userconfig, "/dev/null");
    assert.equal(install.options.env.npm_config_update_notifier, "false");
    assert.equal(install.options.env.HOME, "/nonexistent");
    assert.deepEqual(Object.keys(install.options.env).filter((key) => /TOKEN|SECRET|^SHU_/.test(key)), [], "no coordinator credential reaches npm");
    assert.deepEqual(Object.keys(install.options.env).filter((key) => !/^(PATH|HOME|LANG|GIT_[A-Z_]+|npm_config_(cache|userconfig|update_notifier))$/.test(key)), [],
      "npm's environment is the fixed worker basis plus its three settings");
    assert.ok(calls.some((call) => call.wrapped && call.command === "mktemp"), "the lane identity makes its own cache");
    assert.ok(calls.some((call) => call.wrapped && call.command === "rm" && call.args.at(-1) === cache), "and removes it");
    assert.equal(fs.existsSync(cache), false, "the cache does not outlive preparation");
    assert.ok(calls.findIndex((call) => call.command === "npm") < calls.findIndex((call) => call.command === "chmod"), "the install precedes the permission step");
    for (const call of calls.filter((entry) => entry.command !== "npm")) {
      assert.equal(call.options.timeout, 60_000, `${call.command} keeps the default timeout`);
    }
    assert.equal(fs.existsSync(path.join(cwd, "node_modules/dep/index.js")), true);
    assert.equal(git(cwd, "status", "--porcelain"), "", "installed node_modules/ leaves the checkout clean");
  } finally { f.cleanup(); }
});

test("SHU-296 R8: a failed install refuses the checkout with one fixed code and never repeats npm's output", () => {
  const f = fixture(); try {
    for (const failure of [
      Object.assign(new Error("npm ERR! 401 token=coordinator-secret-token"), { status: 1, stderr: "npm ERR! 401 token=coordinator-secret-token" }),
      Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT", stderr: "" }),
    ]) {
      const calls = [];
      let caught;
      try {
        prepareAttemptWorkspace({ receipt: f.receipt(), env: f.env, allowedHost: "file", execImpl: recordingExec(calls, () => { throw failure; }) });
      } catch (error) { caught = error; }
      assert.ok(caught, "a failed install never yields a checkout");
      assert.equal(caught.workspaceCode, "DEPENDENCY_INSTALL_FAILED");
      assert.equal(workspaceFailureCode(caught), "DEPENDENCY_INSTALL_FAILED", "the code survives the launch mapping");
      assert.doesNotMatch(caught.message, /secret|ETIMEDOUT|npm ERR/);
      assert.equal(npmCalls(calls).length, 1);
      assert.equal(calls.some((call) => call.command === "chmod"), false, "nothing after the install runs");
      const cache = npmCalls(calls)[0].args.at(-1);
      assert.equal(fs.existsSync(cache), false, "a failed install still removes its cache");
    }
  } finally { f.cleanup(); }
});

test("SHU-296 R9: npm runs only for a repo writer whose bound head has a lockfile; scoped writers and reviewers never install", () => {
  const noLock = fixture({ lockfile: false }); try {
    const calls = [];
    assert.throws(() => prepareAttemptWorkspace({ receipt: noLock.receipt(), env: noLock.env, allowedHost: "file", execImpl: recordingExec(calls) }), /workspace owner/);
    assert.equal(npmCalls(calls).length, 0, "no lockfile at target_sha, no install");
  } finally { noLock.cleanup(); }
  const f = fixture(); try {
    const scopedBase = deriveScopedBaseShaFromRemote({ target_sha: f.sha, allowed_paths: [...ALLOWED], remoteUrl: `file://${f.remote}`, allowedHost: "file", env: f.env });
    const scopedCalls = [];
    assert.throws(() => prepareAttemptWorkspace({ receipt: f.receipt({ workspace_scope: "scoped", scoped_base_sha: scopedBase }), env: f.env, allowedHost: "file",
      execImpl: recordingExec(scopedCalls) }), /workspace owner/);
    assert.equal(npmCalls(scopedCalls).length, 0, "a scoped writer never installs");
    assert.ok(scopedCalls.some((call) => call.command === "git" && call.args.includes("checkout") && call.args.includes(scopedBase)), "a scoped writer still starts at its scoped base");
    const reviewCalls = [];
    const { cwd } = prepareAttemptWorkspace({ receipt: f.receipt({ requested_worker: "claude-verifier", workspace_scope: "full", scope_phase: "review", allowed_paths: [] }),
      env: f.env, allowedHost: "file", execImpl: recordingExec(reviewCalls) });
    assert.equal(git(cwd, "rev-parse", "HEAD"), f.sha);
    assert.equal(npmCalls(reviewCalls).length, 0, "a reviewer never installs");
    assert.throws(() => prepareAttemptWorkspace({ receipt: f.receipt({ requested_worker: "claude-verifier" }), env: f.env, allowedHost: "file", execImpl: recordingExec([]) }),
      /reviewer checkout must be complete and unscoped|invalid attempt workspace scope/, "a reviewer is never given a repo checkout");
  } finally { f.cleanup(); }
});

test("SHU-296 R10: run keeps its 60s default and takes a per-call timeout", () => {
  assert.equal(COMMAND_TIMEOUT_MS, 60_000);
  const seen = [];
  const execImpl = (_file, _args, options) => { seen.push(options.timeout); return " ok \n"; };
  assert.equal(run("true", [], {}, "/", { execImpl }), "ok");
  assert.equal(run("true", [], {}, "/", { execImpl, timeout: 1234 }), "ok");
  assert.deepEqual(seen, [60_000, 1234]);
});

test("SHU-296 R11: writer adapters give a repo writer its exact paths", () => {
  const prompt = buildCodexPrompt({ issue_id: "SHU-901", authorization_ref: "SHU-901", attempt_id: randomUUID(), target_sha: "a".repeat(40),
    task_context: "context", workspace_scope: "repo", scope_phase: "initial", allowed_paths: [...ALLOWED], scoped_base_sha: null });
  assert.match(prompt, new RegExp(`only these exact paths: ${ALLOWED.join(", ")}\\.`));
  assert.match(prompt, /refuses any result that changes a file outside this set/);
  assert.doesNotMatch(prompt, /deliberately unavailable/, "a repo writer is not told the rest of the tree is missing");
  assert.deepEqual(writerEditRules({ workspace_scope: "repo", allowed_paths: [...ALLOWED] }), ALLOWED.map((p) => `Edit(./${p})`));
  assert.throws(() => writerEditRules({ workspace_scope: "repo", allowed_paths: [] }), /edit permission rules/);
});
