import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deriveScopedBaseCommit, deriveScopedBaseShaFromRemote, prepareAttemptWorkspace, REMOTE_RETIRE_ARGS, workspaceBindingConflicts } from "../attempt-workspace.mjs";
import { pushExactSha } from "../push-broker.mjs";
import { validateScopedResultDiff } from "../workspace-result.mjs";
import { baseBundlePath, BaseBundleUnavailableError } from "../base-bundle.mjs";
import { callbackBindingValid, createReceipt, foldLaunchOutcome, nextReceiptState, preparedLaunchOptions, receiptCommentBody, validateReceipt } from "../reconcile.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";
import * as claude from "../adapters/claude-code.mjs";
import { parseWorkOrderDirective, renderWorkOrderDirective, routeSuccessorFromReceipts } from "../review-routing.mjs";
import {
  SHU140_INITIAL_BUILD_PATHS,
  SHU140_REVISION_PATHS,
  SHU140_TRAP_PATH,
  validateAllowedPaths,
  validateFixtureScopePolicy,
} from "../workspace-scope.mjs";

const REPO = "BAWES-Universe/studenthub-platform";
const BRANCH = "coordinator/SHU-140";
const wrapper = `setpriv --reuid=65534 --regid=65534 --groups=0`;
const worker = (cwd, ...args) => spawnSync(wrapper.split(" ")[0], [...wrapper.split(" ").slice(1), ...args], {
  cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent", LANG: "C.UTF-8" },
});
const canSwitch = worker("/", "id", "-u").status === 0;
const git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "shu241-")); fs.chmodSync(dir, 0o755);
  const remote = path.join(dir, "BAWES-Universe", "studenthub-platform.git"); fs.mkdirSync(path.dirname(remote)); git(dir, "init", "--bare", remote);
  const seed = path.join(dir, "seed"); git(dir, "init", seed); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  for (const [name, body] of [
    [SHU140_INITIAL_BUILD_PATHS[0], "export const value = 1;\n"],
    [SHU140_INITIAL_BUILD_PATHS[1], "// allowed test\n"],
    [SHU140_TRAP_PATH, "SHU241_HIDDEN_SENTINEL\n"],
    ["README.md", "hidden base content\n"],
  ]) { fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true }); fs.writeFileSync(path.join(seed, name), body); }
  git(seed, "add", "."); git(seed, "commit", "-m", "fixture"); const sha = git(seed, "rev-parse", "HEAD"); const hiddenBlob = git(seed, "rev-parse", `${sha}:${SHU140_TRAP_PATH}`);
  git(seed, "push", remote, `HEAD:refs/heads/${BRANCH}`);
  const root = path.join(dir, "workspaces"), state = path.join(dir, "state"); fs.mkdirSync(root); fs.chmodSync(root, 0o3770); fs.mkdirSync(state, { mode: 0o700 });
  const env = { ...process.env, SHU_WORKTREE_ROOT: root, SHU_WORKSPACE_STATE_DIR: state, SHU_PUSH_REMOTE_URL: `file://${remote}`,
    SHU_WORKER_UID: "65534", SHU_WORKER_LAUNCH_WRAPPER: wrapper, PATH: process.env.PATH, HOME: dir };
  const scopedBase = deriveScopedBaseShaFromRemote({ target_sha: sha, allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], remoteUrl: `file://${remote}`, allowedHost: "file", env });
  const receipt = (over = {}) => ({ attempt_id: randomUUID(), issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "codex-builder", repo: REPO, branch: BRANCH, target_sha: sha,
    workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: scopedBase, ...over });
  return { dir, remote, seed, sha, hiddenBlob, scopedBase, root, state, env, receipt,
    prepare(r = receipt()) { return prepareAttemptWorkspace({ receipt: r, env, allowedHost: "file" }); },
    cleanup() { try { execFileSync("chmod", ["-R", "u+w", dir]); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

function scopedWorkspace(f, attemptId = randomUUID()) {
  const source = path.join(f.dir, `source-${randomUUID()}`); git(f.dir, "init", "--bare", source);
  git(source, "fetch", "--no-tags", `file://${f.remote}`, f.sha); git(source, "update-ref", "refs/heads/bound", f.sha); git(source, "symbolic-ref", "HEAD", "refs/heads/bound");
  git(source, "bundle", "create", path.join(f.state, `${attemptId}.base.bundle`), "refs/heads/bound"); fs.chmodSync(path.join(f.state, `${attemptId}.base.bundle`), 0o600);
  const scoped_base_sha = deriveScopedBaseCommit({ source, target_sha: f.sha, allowed_paths: [...SHU140_INITIAL_BUILD_PATHS] });
  git(source, "update-ref", "refs/heads/scoped", scoped_base_sha); git(source, "symbolic-ref", "HEAD", "refs/heads/scoped");
  const bundle = path.join(source, "scoped.bundle"); git(source, "bundle", "create", bundle, "refs/heads/scoped");
  const cwd = path.join(f.root, attemptId); git(f.root, "clone", "--no-local", "--no-checkout", "--template=", "--", bundle, cwd);
  git(cwd, "checkout", "--detach", scoped_base_sha, "--"); git(cwd, "config", "--remove-section", "remote.origin");
  fs.rmSync(source, { recursive: true, force: true }); fs.chmodSync(cwd, 0o750); return { cwd, scoped_base_sha };
}

test("SHU-241 A1: fixture scope is exact, literal, and keeps the seeded trap outside the initial allowance", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
  const policy = validateFixtureScopePolicy(config.fixture_lane);
  assert.equal(policy.ok, true, policy.reason);
  assert.deepEqual(policy.initial_build_paths, [...SHU140_INITIAL_BUILD_PATHS]);
  assert.deepEqual(policy.revision_paths, [...SHU140_REVISION_PATHS]);
  assert.equal(policy.initial_build_paths.includes(SHU140_TRAP_PATH), false, "BLOCK is reachable because the trap is hidden initially");
  for (const bad of [[], [""], ["/abs"], ["../escape"], ["a/../b"], [".git/config"], ["dir/"], ["**"], ["a\\b"], ["a", "a"]]) {
    assert.equal(validateAllowedPaths(bad).ok, false, JSON.stringify(bad));
  }
});

test("SHU-241 A2: R1 parentless scoped base contains neither hidden objects nor hidden path names", () => {
  const f = fixture(); try {
    assert.deepEqual(REMOTE_RETIRE_ARGS, ["config", "--remove-section", "remote.origin"], "production retires the bundle origin before the worker receives the repository");
    const { cwd, scoped_base_sha } = scopedWorkspace(f);
    assert.equal(scoped_base_sha, f.scopedBase, "scoped_base_sha is deterministic from the full target and exact path manifest");
    const reversed = deriveScopedBaseCommit({ source: f.seed, target_sha: f.sha, allowed_paths: [...SHU140_INITIAL_BUILD_PATHS].reverse() });
    assert.notEqual(reversed, scoped_base_sha, "the exact ordered path manifest participates in the deterministic binding");
    fs.writeFileSync(path.join(f.seed, "README.md"), "different hidden base content\n");
    git(f.seed, "add", "README.md"); git(f.seed, "commit", "-m", "hidden-only target change");
    const changedTarget = git(f.seed, "rev-parse", "HEAD");
    const changedScoped = deriveScopedBaseCommit({ source: f.seed, target_sha: changedTarget, allowed_paths: [...SHU140_INITIAL_BUILD_PATHS] });
    assert.notEqual(changedScoped, scoped_base_sha, "the authoritative full target participates even when allowed blobs are unchanged");
    assert.equal(git(cwd, "rev-list", "--parents", "-n", "1", "HEAD"), scoped_base_sha, "scoped base is parentless");
    assert.equal(fs.existsSync(path.join(cwd, SHU140_INITIAL_BUILD_PATHS[0])), true);
    assert.equal(fs.existsSync(path.join(cwd, SHU140_TRAP_PATH)), false, "hidden trap is absent from the checkout");
    assert.equal(git(cwd, "remote"), "", "scoped bundle checkout retains no remote");
    const read = spawnSync("git", ["-C", cwd, "cat-file", "-p", f.hiddenBlob], { encoding: "utf8" });
    assert.notEqual(read.status, 0, `hidden blob became readable: ${read.stdout}`);
    assert.notEqual(spawnSync("git", ["-C", cwd, "cat-file", "-e", `${f.sha}^{commit}`]).status, 0, "full target commit must not reach the worker object store");
    const names = git(cwd, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
    assert.deepEqual(names, [...SHU140_INITIAL_BUILD_PATHS].sort(), "no hidden path name is present in the scoped tree");
    const grep = spawnSync("grep", ["-r", "-l", "SHU241_HIDDEN_SENTINEL", path.join(cwd, ".git")], { encoding: "utf8" });
    assert.equal(grep.status, 1, `sentinel bytes reached worker metadata: ${grep.stdout}`);
    assert.equal(fs.existsSync(path.join(cwd, ".git/info/sparse-checkout")), false);
    assert.doesNotMatch(fs.readFileSync(path.join(cwd, ".git/config"), "utf8"), /partialclone|promisor|safe\.directory/i);
    assert.doesNotThrow(() => git(cwd, "fsck", "--full", "--no-dangling"));
    for (const args of [["status", "--porcelain"], ["diff", "--", SHU140_INITIAL_BUILD_PATHS[0]]]) {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
    }
    fs.writeFileSync(path.join(cwd, SHU140_INITIAL_BUILD_PATHS[0]), "export const value = 2;\n");
    const stage = spawnSync("git", ["-C", cwd, "add", "--", SHU140_INITIAL_BUILD_PATHS[0]], { encoding: "utf8" });
    assert.equal(stage.status, 0, `ordinary builder staging must work in the complete scoped repository: ${stage.stderr}`);
  } finally { f.cleanup(); }
});

test("SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity", { skip: !canSwitch && "host cannot switch to the fixture worker uid" }, () => {
  const f = fixture(); try {
    const r = f.receipt(); const { cwd } = f.prepare(r);
    assert.equal(fs.existsSync(path.join(cwd, SHU140_TRAP_PATH)), false);
    assert.equal(worker(cwd, "git", "-C", cwd, "cat-file", "-p", f.hiddenBlob).status === 0, false, "worker cannot recover a hidden blob");
    assert.equal(worker(cwd, "git", "-C", cwd, "cat-file", "-e", `${f.sha}^{commit}`).status === 0, false, "worker cannot recover the full target commit");
    assert.equal(worker(cwd, "git", "-C", cwd, "status", "--porcelain").status, 0, "ordinary scoped bundle repository remains usable");
  } finally { f.cleanup(); }
});

test("SHU-241 A3: base-preserving scoped snapshot changes only an allowed path and never deletes hidden base entries", async () => {
  const f = fixture(); try {
    const r = f.receipt(); const { cwd } = scopedWorkspace(f, r.attempt_id);
    fs.writeFileSync(path.join(cwd, SHU140_INITIAL_BUILD_PATHS[0]), "export const value = 3;\n");
    const result = await pushExactSha({ env: f.env, stateDir: f.state, attempt_id: r.attempt_id, result_sha: null, target_sha: f.sha, branch: BRANCH, repo: REPO,
      worktree: cwd, allowedRoot: f.root, remoteUrl: `file://${f.remote}`, allowedHost: "file", workspaceReady: true,
      workspace_scope: r.workspace_scope, scope_phase: r.scope_phase, allowed_paths: r.allowed_paths, scoped_base_sha: r.scoped_base_sha });
    assert.equal(result.ok, true, result.reason);
    const names = git(f.remote, "diff", "--name-status", f.sha, result.remote_head);
    assert.equal(names, `M\t${SHU140_INITIAL_BUILD_PATHS[0]}`, "scoped result differs from its full base at exactly one allowed path");
    assert.equal(git(f.remote, "show", `${result.remote_head}:${SHU140_TRAP_PATH}`), "SHU241_HIDDEN_SENTINEL", "hidden base entry is preserved, not deleted");
    assert.equal(git(f.remote, "rev-parse", `${result.remote_head}^`), f.sha, "scoped and full flows retain the exact bound parent");
  } finally { f.cleanup(); }
});

for (const realWorkspace of [false, true]) test(`SHU-244 A10: distinct-root scoped handoff ${realWorkspace ? "production workspace" : "bundle regression"}`, { skip: realWorkspace && !canSwitch && "host cannot switch worker uid" }, async () => {
  const f = fixture(); try {
    const adapterState = path.join(f.dir, "coordinator-runs"); fs.mkdirSync(adapterState, { mode: 0o700 });
    const r = f.receipt();
    const { cwd } = realWorkspace ? f.prepare(r) : scopedWorkspace(f, r.attempt_id);
    assert.equal(fs.existsSync(path.join(cwd, SHU140_TRAP_PATH)), false);
    fs.writeFileSync(path.join(cwd, SHU140_INITIAL_BUILD_PATHS[0]), "export const value = 244;\n");
    const result = await pushExactSha({ env: f.env, stateDir: adapterState, attempt_id: r.attempt_id, result_sha: null, target_sha: f.sha, branch: BRANCH, repo: REPO,
      worktree: cwd, allowedRoot: f.root, remoteUrl: `file://${f.remote}`, allowedHost: "file", workspaceReady: true,
      workspace_scope: r.workspace_scope, scope_phase: r.scope_phase, allowed_paths: r.allowed_paths, scoped_base_sha: r.scoped_base_sha });
    assert.equal(result.ok, true, result.reason);
    assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), result.remote_head);
    assert.equal(git(f.remote, "rev-parse", `${result.remote_head}^`), f.sha);
    assert.equal(git(f.remote, "show", `${result.remote_head}:${SHU140_TRAP_PATH}`), "SHU241_HIDDEN_SENTINEL");
    assert.equal(git(f.remote, "diff", "--name-only", f.sha, result.remote_head), SHU140_INITIAL_BUILD_PATHS[0]);
    const binding = JSON.parse(fs.readFileSync(path.join(adapterState, `workspace-result-${r.attempt_id}.json`)));
    assert.equal(binding.result_sha, result.remote_head);
    assert.equal(fs.existsSync(path.join(adapterState, `${r.attempt_id}.base.bundle`)), false);
  } finally { f.cleanup(); }
});

test("SHU-244 A11: unavailable or divergent bundle authority refuses before binding and push with actionable code", async () => {
  const f = fixture(); try {
    const adapterState = path.join(f.dir, "coordinator-runs"); fs.mkdirSync(adapterState, { mode: 0o700 });
    const r = f.receipt(); const { cwd } = scopedWorkspace(f, r.attempt_id);
    fs.writeFileSync(path.join(cwd, SHU140_INITIAL_BUILD_PATHS[0]), "export const value = 244;\n");
    const correct = path.join(f.state, `${r.attempt_id}.base.bundle`);
    assert.equal(baseBundlePath(f.env, r.attempt_id, { mustExist: true }), correct);
    for (const root of [undefined, "relative", adapterState]) {
      const env = { ...f.env, SHU_WORKSPACE_STATE_DIR: root };
      assert.throws(() => baseBundlePath(env, r.attempt_id, { mustExist: true }), (error) => {
        assert.ok(error instanceof BaseBundleUnavailableError);
        assert.equal(error.code, "BASE_BUNDLE_UNAVAILABLE");
        assert.ok(error.message.includes(JSON.stringify(root ?? null)));
        return true;
      });
      const result = await pushExactSha({ env, stateDir: adapterState, attempt_id: r.attempt_id, result_sha: null, target_sha: f.sha, branch: BRANCH, repo: REPO,
        worktree: cwd, allowedRoot: f.root, remoteUrl: `file://${f.remote}`, allowedHost: "file", workspaceReady: true,
        workspace_scope: r.workspace_scope, scope_phase: r.scope_phase, allowed_paths: r.allowed_paths, scoped_base_sha: r.scoped_base_sha });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, "BASE_BUNDLE_UNAVAILABLE");
      assert.match(result.reason, /SHU_WORKSPACE_STATE_DIR=.*bundle=/);
      assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), f.sha);
      assert.equal(fs.existsSync(path.join(adapterState, `workspace-result-${r.attempt_id}.json`)), false);
      assert.equal(fs.existsSync(path.join(adapterState, `push-${r.attempt_id}.json`)), false);
    }
    const saved = `${correct}.saved`; fs.renameSync(correct, saved);
    assert.throws(() => baseBundlePath(f.env, r.attempt_id, { mustExist: true }), BaseBundleUnavailableError);
    fs.symlinkSync(saved, correct);
    assert.throws(() => baseBundlePath(f.env, r.attempt_id, { mustExist: true }), BaseBundleUnavailableError);
    fs.unlinkSync(correct); fs.renameSync(saved, correct); fs.chmodSync(correct, 0o644);
    assert.throws(() => baseBundlePath(f.env, r.attempt_id, { mustExist: true }), BaseBundleUnavailableError);
  } finally { f.cleanup(); }
});

test("SHU-241 A4: new, mode-only, and renamed out-of-scope content is refused before binding or publication", async () => {
  for (const raw of ["A\0outside.txt\0", "D\0outside.txt\0", "M\0outside.txt\0", "R100\0outside.txt\0tools/fixture/scan-vacuous.mjs\0", "R100\0tools/fixture/scan-vacuous.mjs\0outside.txt\0"]) {
    assert.equal(validateScopedResultDiff(raw, [...SHU140_INITIAL_BUILD_PATHS]).ok, false, `full-tree diff must refuse every outside source or destination: ${JSON.stringify(raw)}`);
  }
  assert.equal(validateScopedResultDiff(`M\0${SHU140_INITIAL_BUILD_PATHS[0]}\0`, [...SHU140_INITIAL_BUILD_PATHS]).ok, true,
    "the full-tree diff permits an in-scope modification");
  const attacks = [
    ["untracked", (f, cwd) => fs.writeFileSync(path.join(cwd, "outside.txt"), "attack\n")],
    ["mode-only hidden base path", (f, cwd) => { fs.mkdirSync(path.dirname(path.join(cwd, "README.md")), { recursive: true }); fs.copyFileSync(path.join(f.seed, "README.md"), path.join(cwd, "README.md")); fs.chmodSync(path.join(cwd, "README.md"), 0o755); }],
    ["rename destination", (_f, cwd) => fs.renameSync(path.join(cwd, SHU140_INITIAL_BUILD_PATHS[0]), path.join(cwd, "renamed-outside.mjs"))],
  ];
  for (const [name, attack] of attacks) {
    const f = fixture(); try {
    const r = f.receipt(); const { cwd } = scopedWorkspace(f, r.attempt_id); attack(f, cwd);
    const before = git(f.remote, "rev-parse", `refs/heads/${BRANCH}`);
    const result = await pushExactSha({ env: f.env, stateDir: f.state, attempt_id: r.attempt_id, result_sha: null, target_sha: f.sha, branch: BRANCH, repo: REPO,
      worktree: cwd, allowedRoot: f.root, remoteUrl: `file://${f.remote}`, allowedHost: "file", workspaceReady: true,
      workspace_scope: r.workspace_scope, scope_phase: r.scope_phase, allowed_paths: r.allowed_paths, scoped_base_sha: r.scoped_base_sha });
    assert.equal(result.ok, false, `${name} unexpectedly published`); assert.match(result.reason, /RESULT_SCOPE_REFUSED/);
    assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), before, `${name}: scope refusal cannot advance the remote`);
    assert.equal(fs.existsSync(path.join(f.state, `workspace-result-${r.attempt_id}.json`)), false, `${name}: refusal precedes result binding`);
    assert.equal(fs.existsSync(path.join(f.state, `push-${r.attempt_id}.json`)), false, `${name}: refusal precedes pre-push state`);
    } finally { f.cleanup(); }
  }
  const attempt_id = randomUUID(), target_sha = "a".repeat(40);
  const receipt = createReceipt({ issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", requested_worker: "codex-builder",
    repo: REPO, branch: BRANCH, target_sha, attempt_id, workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: "d".repeat(40) }).receipt;
  const launched = nextReceiptState(receipt, { type: "launch" });
  const callback = { attempt_id, target_sha, result_sha: null, stage: "BUILD_READY", links: ["focused scope probe"] };
  const stdout = [JSON.stringify({ type: "thread.started", thread_id: randomUUID() }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(callback) } })].join("\n");
  const state = fs.mkdtempSync(path.join(tmpdir(), "shu241-adapter-"));
  for (const expectedCode of ["RESULT_SCOPE_REFUSED", "BASE_BUNDLE_UNAVAILABLE"]) {
  const held = await (await import("../adapters/codex-cli.mjs")).launchBuilder({ issue_id: "SHU-140", authorization_ref: receipt.authorization_ref,
    attempt_id, target_sha, task_context: "scope refusal", branch: BRANCH, repo: REPO, cwd: "/repo", schemaFile: path.join(state, "schema.json"),
    workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: "d".repeat(40), readHeadImpl: async () => "d".repeat(40),
    env: { PATH: "/usr/bin", HOME: "/root", CODEX_HOME: "/root/.codex", SHU_WORKER_LAUNCH_WRAPPER: "setpriv --reuid=worker", SHU_WORKTREE_ROOT: "/repo", SHU_PUSH_REMOTE_URL: "git@github.com:BAWES-Universe/studenthub-platform.git" },
    execFileImpl: (_f, _a, _o, cb) => queueMicrotask(() => cb(null, stdout, "")),
    io: { codexStateDir: state, pushBrokerImpl: async () => ({ ok: false, stage: "HOLD", reason: `workspace result refused: ${expectedCode}`, reason_code: expectedCode === "BASE_BUNDLE_UNAVAILABLE" ? expectedCode : undefined }) } });
  assert.equal(held.reason_code, expectedCode, "adapter exposes the stable refusal code");
  const folded = foldLaunchOutcome(launched.receipt, held);
  assert.equal(folded.receipt.stage, "HOLD");
  assert.ok(folded.receipt.notes.includes(`adapter reason code: ${expectedCode}`), "append-only receipt records the refusal code");
  fs.rmSync(state, { recursive: true, force: true }); fs.mkdirSync(state, { mode: 0o700 });
  }
  fs.rmSync(state, { recursive: true, force: true });
});

function routeFixture({ stage = "BLOCKED", writer = "codex-builder", branch = BRANCH, reviewedHead = "b".repeat(40), writerHead = "b".repeat(40) } = {}) {
  const build = { issue_id: "SHU-140", attempt_id: "11111111-1111-4111-8111-111111111111", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: writer, worker_identity: "codex-session", repo: REPO, branch, target_sha: "a".repeat(40), result_sha: writerHead,
    verdict_stage: "BUILD_READY", workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: "d".repeat(40) };
  const review = { issue_id: "SHU-140", attempt_id: "22222222-2222-4222-8222-222222222222", authorization_ref: build.authorization_ref,
    requested_worker: "claude-verifier", worker_identity: "claude-session", repo: REPO, branch: BRANCH, target_sha: reviewedHead,
    verdict_stage: stage, stage: "HOLD", workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };
  const fixtureLane = { id: "SHU-140", initial_build_paths: [...SHU140_INITIAL_BUILD_PATHS], revision_paths: [...SHU140_REVISION_PATHS], seeded_defect_path: SHU140_TRAP_PATH };
  return routeSuccessorFromReceipts({ issueReceipts: [build, review], terminal: review, evidenceStage: stage, authoritativeHead: reviewedHead, fixtureLane });
}

test("SHU-241 A5: only a validated exact-head BLOCK unlocks the predeclared revision scope for the same Codex writer and branch", () => {
  const good = routeFixture(); assert.equal(good.ok, true, good.reason); assert.equal(good.order.role, "revise");
  assert.equal(good.order.requested_worker, "codex-builder"); assert.equal(good.order.workspace_scope, "scoped"); assert.equal(good.order.scope_phase, "revision");
  assert.deepEqual(good.order.allowed_paths, [...SHU140_REVISION_PATHS], "revision authority comes only from trusted config, never reviewer prose");
  const pass = routeFixture({ stage: "PASS" }); assert.equal(pass.ok, true); assert.equal(pass.order, undefined, "PASS cannot unlock revision authority");
  const wrongAttempt = callbackBindingValid({ attempt_id: "11111111-1111-4111-8111-111111111111", target_sha: "b".repeat(40) },
    { attempt_id: "33333333-3333-4333-8333-333333333333", target_sha: "b".repeat(40), stage: "BLOCKED", links: ["x"] });
  assert.equal(wrongAttempt, false, "a foreign or forged callback attempt cannot become the validated BLOCK input");
  for (const bad of [routeFixture({ stage: "FAILED" }), routeFixture({ writer: "hermes-box" }), routeFixture({ branch: "coordinator/foreign" }), routeFixture({ writerHead: "c".repeat(40) })]) {
    assert.equal(bad.ok, false, `invalid BLOCK chain routed: ${JSON.stringify(bad.order)}`);
  }
});

test("SHU-241 A6: receipts and directives carry immutable scope; reviewer launch refuses any scoped checkout", async () => {
  const created = createReceipt({ issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", requested_worker: "codex-builder", repo: REPO,
    branch: BRANCH, target_sha: "a".repeat(40), workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: "d".repeat(40) });
  assert.equal(created.ok, true, created.errors); assert.equal(validateReceipt(created.receipt).valid, true);
  assert.deepEqual(created.receipt.allowed_paths, [...SHU140_INITIAL_BUILD_PATHS]);
  assert.equal(created.receipt.scoped_base_sha, "d".repeat(40), "receipt binds the recomputable parentless input SHA alongside full target_sha");
  assert.equal(workspaceBindingConflicts(created.receipt, { ...created.receipt, scoped_base_sha: "e".repeat(40) }), true,
    "an existing attempt cannot substitute another scoped base under the same full target");
  const routed = routeFixture().order;
  const parsedDirective = parseWorkOrderDirective(renderWorkOrderDirective(routed));
  assert.equal(parsedDirective.ok, true, "scope-bearing directive must remain parseable");
  assert.ok(parsedDirective.order, "scope-bearing directive must retain its work order");
  assert.deepEqual(parsedDirective.order.allowed_paths, [...SHU140_REVISION_PATHS]);
  assert.equal(parsedDirective.order.scoped_base_sha, null, "revision directive carries paths but host derives its scoped SHA before reservation");
  const f = fixture(); try {
    assert.throws(() => f.prepare(f.receipt({ requested_worker: "claude-verifier", scope_phase: "review" })), /review workspace must be full|reviewer checkout must be complete/);
    const full = f.receipt({ requested_worker: "claude-verifier", workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null });
    f.prepare(full);
    const authority = path.join(f.state, `${full.attempt_id}.workspace.json`);
    const forged = JSON.parse(fs.readFileSync(authority, "utf8")); forged.allowed_paths = ["README.md"]; fs.writeFileSync(authority, JSON.stringify(forged));
    assert.throws(() => f.prepare(full), /workspace authority scope invalid|immutable path binding/, "attempt authority cannot be widened after reservation");
  } finally { f.cleanup(); }
  let reads = 0;
  const refused = await claude.launchBuilder({ issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    attempt_id: randomUUID(), target_sha: "a".repeat(40), task_context: "review", oauth_token: "oauth",
    workspace_scope: "scoped", scope_phase: "review", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: "d".repeat(40),
    readHeadImpl: async () => { reads += 1; return "a".repeat(40); } });
  assert.equal(refused.reason_code, "REVIEW_EXECUTION_UNAVAILABLE"); assert.equal(reads, 0, "scoped reviewer is refused before launch preparation");
});

test("SHU-241 A7: reviewer preparation is always a complete exact-head repository", () => {
  const f = fixture(); try {
    const r = f.receipt({ requested_worker: "claude-verifier", workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null });
    const { cwd } = f.prepare(r);
    assert.equal(fs.readFileSync(path.join(cwd, SHU140_TRAP_PATH), "utf8"), "SHU241_HIDDEN_SENTINEL\n");
    assert.equal(fs.existsSync(path.join(cwd, ".git/info/sparse-checkout")), false);
    assert.doesNotMatch(fs.readFileSync(path.join(cwd, ".git/config"), "utf8"), /partialclone|promisor\s*=\s*true/i);
    assert.doesNotThrow(() => git(cwd, "fsck", "--full", "--no-dangling"));
    assert.equal(git(cwd, "rev-parse", "HEAD"), f.sha);
    const pack = fs.readdirSync(path.join(cwd, ".git/objects/pack")).find((name) => name.endsWith(".pack"));
    assert.ok(pack, "full reviewer fixture must contain a reachable object pack before the corruption probe");
    fs.unlinkSync(path.join(cwd, ".git/objects/pack", pack));
    assert.throws(() => f.prepare(r), /workspace command failed/, "reviewer preparation refuses missing reachable objects before launch");
  } finally { f.cleanup(); }
});

test("SHU-241 A8: LAUNCH_UNKNOWN recovery retains the exact scoped input without widening to the full target", async () => {
  const h = createEpisodeHarness({ configOverrides: { fixture_lane: {
    id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    initial_build_paths: [...SHU140_INITIAL_BUILD_PATHS], revision_paths: [...SHU140_REVISION_PATHS], seeded_defect_path: SHU140_TRAP_PATH,
  } } });
  try {
    const target_sha = "a".repeat(40), scoped_base_sha = "d".repeat(40);
    const made = createReceipt({ issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", requested_worker: "codex-builder",
      repo: REPO, branch: BRANCH, target_sha, episode_id: h.record.activation_id,
      workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha });
    assert.equal(made.ok, true, made.errors);
    const unknown = nextReceiptState(made.receipt, { type: "launch" }).receipt;
    h.comments.push({ body: receiptCommentBody(unknown), createdAt: unknown.last_activity });
    const prepared = [];
    const tick = await h.runTick({ io: { prepareWorkspace: async ({ receipt, resume }) => {
      prepared.push({ receipt, resume }); return { cwd: "/scoped-recovery" };
    } } });
    assert.equal(tick.code, 0, tick.text);
    assert.equal(prepared.length, 1, "the retained LAUNCH_UNKNOWN attempt is prepared exactly once for resume");
    assert.equal(prepared[0].resume, true);
    assert.equal(h.launched.length, 1, "recovery crosses the adapter boundary exactly once");
    assert.deepEqual(h.launched[0], {
      lane: "codex-cli", attempt_id: unknown.attempt_id, target_sha, run_id: `codexrun_${unknown.attempt_id.slice(0, 8)}_1`,
      cwd: "/scoped-recovery", workspace_scope: "scoped", scope_phase: "initial",
      allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha,
    });
    assert.notEqual(h.launched[0].scoped_base_sha, h.launched[0].target_sha, "recovery must not silently relaunch from the full target");
  } finally { h.cleanup(); }
});

test("SHU-241 A9: partial scope metadata fails closed while a wholly legacy receipt alone receives full scope", async () => {
  const base = { attempt_id: randomUUID(), issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "codex-builder", repo: REPO, branch: BRANCH, target_sha: "a".repeat(40) };
  const fields = { workspace_scope: "scoped", scope_phase: "initial", allowed_paths: [...SHU140_INITIAL_BUILD_PATHS], scoped_base_sha: "d".repeat(40) };
  const names = Object.keys(fields);
  for (let mask = 1; mask < (1 << names.length) - 1; mask++) {
    const partial = { ...base };
    names.forEach((name, index) => { if (mask & (1 << index)) partial[name] = fields[name]; });
    await assert.rejects(preparedLaunchOptions("codex-cli", partial, {}, { adapterModules: { "codex-cli": {} } }, { resume: true }),
      /scope metadata is partially present/, `partial mask ${mask.toString(2)} must not gain legacy full-workspace authority`);
    assert.throws(() => prepareAttemptWorkspace({ receipt: partial, env: {} }), /scope metadata is partially present/,
      `workspace preparation must reject partial mask ${mask.toString(2)}`);
  }
  const legacy = await preparedLaunchOptions("codex-cli", base, {}, { adapterModules: { "codex-cli": {} } }, { resume: true });
  assert.deepEqual({ workspace_scope: legacy.workspace_scope, scope_phase: legacy.scope_phase, allowed_paths: legacy.allowed_paths, scoped_base_sha: legacy.scoped_base_sha },
    { workspace_scope: "full", scope_phase: "initial", allowed_paths: [], scoped_base_sha: null }, "only a receipt with none of the four fields gets legacy fallback");
  const complete = await preparedLaunchOptions("codex-cli", { ...base, ...fields }, {}, { adapterModules: { "codex-cli": {} } }, { resume: true });
  assert.deepEqual(complete.allowed_paths, fields.allowed_paths, "complete scoped authority remains exact rather than widening");
});
