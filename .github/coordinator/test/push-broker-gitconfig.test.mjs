// Real-git adversarial regressions for the broker's trusted configuration
// boundary (Codex R3 BLOCK #2, 2026-09-07).
//
// The worker owns its worktree, so it owns `<worktree>/.git/config`. Codex
// reproduced two attacks against the unhardened broker with real git:
//
//   1. `url.<foreign>.insteadOf <allowlisted-url>` REDIRECTED the push. The
//      broker returned PUSHED and post-push confirmation "confirmed" the
//      attacker's repository, because both remote checks followed the rewrite.
//   2. `core.sshCommand` EXECUTED as the broker process user during the very
//      first `ls-remote` — before any validation or HOLD could matter.
//
// These tests run REAL git against REAL local repositories. They assert the
// attacker's observable outcome (a foreign repo receiving the commit, a marker
// file appearing), not merely the broker's return value: a HOLD returned AFTER
// a command has already executed is not protection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pushExactSha, brokerGitEnv, BROKER_GIT_CONFIG_ARGS } from "../push-broker.mjs";

const execFileAsync = promisify(execFile);

// A pristine environment for FIXTURE setup, so the harness itself is never
// influenced by the developer's own git configuration.
const CLEAN_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd, env: CLEAN_ENV });
}

const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/**
 * A real worker worktree with two commits, plus a real bare repo standing in
 * for the legitimate remote and another for the attacker's destination.
 */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shu-gitcfg-"));
  const worktrees = join(root, "worktrees");
  mkdirSync(worktrees, { recursive: true });
  const wt = join(worktrees, "coordinator-SHU-63");
  mkdirSync(wt, { recursive: true });

  await git(["init", "-q", "-b", "main", "."], wt);
  writeFileSync(join(wt, "a.txt"), "base\n");
  await git(["add", "a.txt"], wt);
  await git(["commit", "-qm", "base"], wt);
  const target_sha = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
  writeFileSync(join(wt, "a.txt"), "worker result\n");
  await git(["add", "a.txt"], wt);
  await git(["commit", "-qm", "worker result"], wt);
  const result_sha = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();

  // The legitimate destination, shaped so validateRepoUrl's owner/repo parse
  // matches the configured pilot repo.
  const legitParent = join(root, "remotes", "BAWES-Universe");
  mkdirSync(legitParent, { recursive: true });
  const legit = join(legitParent, "studenthub-platform.git");
  await git(["init", "-q", "--bare", legit], root);

  // The attacker's destination.
  const foreignParent = join(root, "foreign", "BAWES-Universe");
  mkdirSync(foreignParent, { recursive: true });
  const foreign = join(foreignParent, "studenthub-platform.git");
  await git(["init", "-q", "--bare", foreign], root);

  const stateDir = mkdtempSync(join(tmpdir(), "shu-gitcfg-state-"));
  return { root, wt, worktrees, target_sha, result_sha, legit, foreign, stateDir };
}

function opts(f, over = {}) {
  return {
    stateDir: f.stateDir,
    attempt_id: ATTEMPT,
    result_sha: f.result_sha,
    target_sha: f.target_sha,
    branch: "coordinator/SHU-63",
    repo: "BAWES-Universe/studenthub-platform",
    worktree: f.wt,
    allowedRoot: f.worktrees,
    branchPrefix: "coordinator/",
    remoteUrl: `file://${f.legit}`,
    allowedHost: "file", // local transport, explicitly allowlisted for this test
    env: CLEAN_ENV,
    ...over,
  };
}

async function bareHasCommit(bare, sha) {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`], bare);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. url.*.insteadOf must not redirect either remote check or the push.
// ---------------------------------------------------------------------------

test("real git: a worker url.*.insteadOf rewrite cannot redirect the push or the remote checks", async () => {
  const f = await fixture();
  // The worker rewrites the allowlisted destination to its own bare repo.
  await git(["config", `url.file://${f.foreign}.insteadOf`, `file://${f.legit}`], f.wt);
  // The worktree is still clean, exactly as Codex observed — the attack leaves
  // no trace the cleanliness check could notice.
  assert.equal((await git(["status", "--porcelain"], f.wt)).stdout.trim(), "");

  const res = await pushExactSha(opts(f));

  assert.equal(
    await bareHasCommit(f.foreign, f.result_sha),
    false,
    "the foreign repository must never receive the commit",
  );
  // And the legitimate destination is where the work actually landed.
  assert.equal(res.ok, true, `expected a successful push, got: ${JSON.stringify(res)}`);
  assert.equal(res.stage, "PUSHED");
  assert.equal(res.remote_head, f.result_sha);
  assert.equal(await bareHasCommit(f.legit, f.result_sha), true);
  const ref = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
  assert.equal(ref, f.result_sha, "the exact validated SHA reached the lane branch");
});

test("real git: an insteadOf rewrite cannot make post-push confirmation accept a foreign destination", async () => {
  // Codex's sharpest point: confirmation followed the SAME rewrite, so the
  // broker confirmed the attacker's repo and reported success. Here the
  // rewrite exists but confirmation must still read the legitimate remote.
  const f = await fixture();
  await git(["config", `url.file://${f.foreign}.insteadOf`, `file://${f.legit}`], f.wt);
  // Pre-seed the foreign repo with the commit so a confirmation that followed
  // the rewrite would find it and wrongly succeed.
  await git(["push", `file://${f.foreign}`, `${f.result_sha}:refs/heads/coordinator/SHU-63`], f.wt);

  const res = await pushExactSha(opts(f));
  assert.equal(res.ok, true, JSON.stringify(res));
  const legitRef = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
  assert.equal(legitRef, f.result_sha, "confirmation must read the legitimate remote, not the rewritten one");
});

// ---------------------------------------------------------------------------
// 2. Worker config must not execute commands as the broker.
// ---------------------------------------------------------------------------

function markerScript(dir, name) {
  const marker = join(dir, name);
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return { marker, script };
}

test("real git: worker core.sshCommand never executes as the broker, not even on the first remote check", async () => {
  const f = await fixture();
  const { marker, script } = markerScript(f.root, "ssh-marker");
  await git(["config", "core.sshCommand", script], f.wt);

  // The remote MUST be ssh-shaped, otherwise git never invokes ssh at all and
  // this test would pass without exercising anything — a file:// remote made an
  // earlier version of it vacuous. The ls-remote is expected to fail (no
  // network, no key); what matters is that the worker's script did not run.
  const res = await pushExactSha(
    opts(f, { remoteUrl: "git@github.com:BAWES-Universe/studenthub-platform.git", allowedHost: undefined }),
  );

  assert.equal(existsSync(marker), false, "core.sshCommand must never run under the broker identity");
  assert.equal(res.ok, false, "an unreachable remote is a HOLD, never a claimed push");
});

test("real git: worker core.gitProxy and core.fsmonitor never execute as the broker", async () => {
  for (const key of ["core.gitProxy", "core.fsmonitor"]) {
    const f = await fixture();
    const { marker, script } = markerScript(f.root, `${key.replace(".", "-")}-marker`);
    await git(["config", key, script], f.wt);

    await pushExactSha(opts(f));

    assert.equal(existsSync(marker), false, `${key} must never run under the broker identity`);
  }
});

test("real git: an included worker config cannot smuggle in an executing key or a rewrite", async () => {
  const f = await fixture();
  const { marker, script } = markerScript(f.root, "include-marker");
  const included = join(f.root, "evil.gitconfig");
  writeFileSync(
    included,
    `[core]\n\tsshCommand = ${script}\n[url "file://${f.foreign}"]\n\tinsteadOf = file://${f.legit}\n`,
  );
  await git(["config", "include.path", included], f.wt);

  const res = await pushExactSha(opts(f));

  assert.equal(existsSync(marker), false, "an included core.sshCommand must not execute");
  assert.equal(await bareHasCommit(f.foreign, f.result_sha), false, "an included rewrite must not redirect the push");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await bareHasCommit(f.legit, f.result_sha), true);
});

// An ssh-shaped destination is REQUIRED for every one of these: with a file://
// remote git never invokes ssh, so `GIT_SSH_COMMAND` assertions pass without
// exercising anything. The ls-remote is expected to fail (no network, no key);
// what matters is which program git chose to run first.
function sshOpts(f, over = {}) {
  return opts(f, {
    remoteUrl: "git@github.com:BAWES-Universe/studenthub-platform.git",
    allowedHost: undefined,
    ...over,
  });
}

test("real git: environment-provided git configuration cannot reach a broker call", async () => {
  const f = await fixture();
  const { marker, script } = markerScript(f.root, "env-marker");
  // Every one of these is a documented injection route.
  const hostile = {
    ...CLEAN_ENV,
    GIT_SSH_COMMAND: script,
    GIT_SSH: script,
    GIT_PROXY_COMMAND: script,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: script,
  };

  const res = await pushExactSha(sshOpts(f, { env: hostile }));

  assert.equal(existsSync(marker), false, "no environment-provided command may run under the broker identity");
  assert.equal(res.ok, false, "an unreachable remote is a HOLD, never a claimed push");
});

test("real git: an inherited GIT_SSH_COMMAND never selects the broker's ssh program", async () => {
  const f = await fixture();
  const { marker, script } = markerScript(f.root, "inherited-ssh-marker");

  // GIT_SSH_COMMAND alone, arriving from outside the coordinator's own
  // configuration. It outranks core.sshCommand in git's precedence order, so
  // if the broker were to pass it through, this is the program that would run.
  const res = await pushExactSha(sshOpts(f, { env: { ...CLEAN_ENV, GIT_SSH_COMMAND: script } }));

  assert.equal(
    existsSync(marker),
    false,
    "only SHU_PUSH_SSH_COMMAND may select the ssh program; an inherited GIT_SSH_COMMAND must be ignored",
  );
  assert.equal(res.ok, false, "an unreachable remote is a HOLD, never a claimed push");
});

test("real git: an explicitly configured SHU_PUSH_SSH_COMMAND is preserved", async () => {
  const f = await fixture();
  const { marker, script } = markerScript(f.root, "configured-ssh-marker");
  const { marker: inherited, script: inheritedScript } = markerScript(f.root, "losing-ssh-marker");

  // The coordinator's own setting, alongside an inherited value it must beat.
  await pushExactSha(sshOpts(f, {
    env: { ...CLEAN_ENV, SHU_PUSH_SSH_COMMAND: script, GIT_SSH_COMMAND: inheritedScript },
  }));

  assert.equal(existsSync(marker), true, "the operator's configured deploy-key route must still be used");
  assert.equal(existsSync(inherited), false, "the inherited value must lose to the configured one");
});

test("brokerGitEnv selects ssh only from the coordinator's own configuration", () => {
  const hostile = { GIT_SSH_COMMAND: "/evil.sh" };
  assert.equal(brokerGitEnv(hostile).GIT_SSH_COMMAND, "ssh", "an inherited value is discarded, not honoured");
  assert.equal(
    brokerGitEnv({ ...hostile, SHU_PUSH_SSH_COMMAND: "/opt/deploy-ssh" }).GIT_SSH_COMMAND,
    "/opt/deploy-ssh",
    "the coordinator's own setting selects the program",
  );
  assert.equal(
    brokerGitEnv(hostile, { sshCommand: "/explicit-ssh" }).GIT_SSH_COMMAND,
    "/explicit-ssh",
    "an explicit argument selects the program",
  );
});

test("brokerGitEnv strips every config-injection variable and pins ssh by precedence", () => {
  const out = brokerGitEnv({
    PATH: "/usr/bin",
    GIT_CONFIG: "/evil",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "/evil.sh",
    GIT_SSH: "/evil.sh",
    GIT_PROXY_COMMAND: "/evil.sh",
    GIT_DIR: "/evil/.git",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/evil/objects",
  });
  for (const k of [
    "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "GIT_SSH", "GIT_PROXY_COMMAND", "GIT_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    assert.equal(out[k], undefined, `${k} must be stripped`);
  }
  assert.equal(out.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(out.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(out.GIT_CONFIG_NOSYSTEM, "1");
  // Always set: the env var outranks core.sshCommand, so a worker-authored
  // core.sshCommand loses by precedence rather than by enumeration.
  assert.equal(out.GIT_SSH_COMMAND, "ssh");
  assert.equal(out.PATH, "/usr/bin", "unrelated environment survives");
});

test("the hardening flags are applied to EVERY broker call, not just the push", () => {
  const joined = BROKER_GIT_CONFIG_ARGS.join(" ");
  for (const key of [
    "core.hooksPath=/dev/null",
    "credential.helper=",
    "core.fsmonitor=false",
    "core.gitProxy=",
    "uploadpack.packObjectsHook=",
    "protocol.ext.allow=never",
  ]) {
    assert.ok(joined.includes(key), `${key} must be in the boundary's -c overrides`);
  }
});

// ---------------------------------------------------------------------------
// 3. The legitimate route still works, and the default policy still refuses
//    local transport.
// ---------------------------------------------------------------------------

test("real git: a clean worktree pushes the exact validated SHA to the lane branch", async () => {
  const f = await fixture();
  const res = await pushExactSha(opts(f));
  assert.equal(res.stage, "PUSHED", JSON.stringify(res));
  assert.equal(res.remote_head, f.result_sha);
  const ref = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
  assert.equal(ref, f.result_sha);
  // Nothing else was created on the remote.
  const refs = (await git(["for-each-ref", "--format=%(refname)"], f.legit)).stdout.trim().split("\n");
  assert.deepEqual(refs, ["refs/heads/coordinator/SHU-63"]);
});

test("real git: a second identical call is idempotent and does not push again", async () => {
  const f = await fixture();
  assert.equal((await pushExactSha(opts(f))).stage, "PUSHED");
  const again = await pushExactSha(opts(f, { stateDir: mkdtempSync(join(tmpdir(), "shu-gitcfg-state2-")) }));
  assert.equal(again.stage, "ALREADY_PUSHED");
  assert.equal(again.ok, true);
});

test("file: transport is refused under the DEFAULT github.com policy", async () => {
  const f = await fixture();
  // Same fixture, but without the explicit local-transport allowlist.
  const res = await pushExactSha(opts(f, { allowedHost: undefined }));
  assert.equal(res.ok, false);
  assert.equal(res.pause_adapter, true);
  assert.match(String(res.reason), /unrecognized remote URL/);
  assert.equal(await bareHasCommit(f.legit, f.result_sha), false, "nothing may be pushed under a refused policy");
});
