// Host-side push broker adversarial tests (Option A, ratified 2026-09-07).
//
// The sandboxed worker never pushes; the host broker pushes ONLY the validated
// exact result SHA using the repo-scoped deploy key. Every ambiguity HOLDs and
// pauses the adapter — a guess is never a push.
//
// Coverage: malicious remotes, branch traversal / protected refs, worktree
// confinement (realpath escape), dirty trees, unrelated SHAs, failed ancestry,
// hooks + credential-helper stripping, force prohibition, explicit refspec,
// crash-before (pre-push record remainder), crash-after-push-before-record,
// remote divergence, idempotency (already-pushed), concurrency, and post-push
// remote confirmation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pushExactSha,
  persistPrePush,
  readPrePushRecord,
} from "../push-broker.mjs";

const ATTEMPT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TARGET = "1111111111111111111111111111111111111111";
const RESULT = "2222222222222222222222222222222222222222";
const OTHER = "3333333333333333333333333333333333333333";
const ROOT = mkdtempSync(join(tmpdir(), "shu-broker-root-"));
const WT = join(ROOT, "worktrees", "coordinator-SHU-63");
mkdirSync(WT, { recursive: true });
const REPO = "BAWES-Universe/studenthub-platform";
const REMOTE = `git@github.com:${REPO}.git`;
const LANE = "coordinator/SHU-63";

function freshState() {
  return mkdtempSync(join(tmpdir(), "shu-broker-state-"));
}

// A scriptable git(1) executor. `fn(binary, args, opts, cb)` matches the
// execFile contract. Entries are keyed by the joined argv; `default` catches
// anything unscripted (fail loudly so a missing case is obvious).
function makeGit(script = {}) {
  const calls = [];
  const fn = (binary, args, opts, cb) => {
    calls.push([...args]);
    // Every broker call now carries BROKER_GIT_CONFIG_ARGS. Strip the leading
    // `-c key=value` pairs so scripts key off the subcommand, and keep the raw
    // argv in `calls` so tests can still assert the hardening is present.
    const bare = [...args];
    while (bare.length >= 2 && bare[0] === "-c") bare.splice(0, 2);
    const a = bare.join(" ");
    // Match by exact key first, then by prefix (argv carries remote URL / SHAs).
    let hit = script[a];
    if (!hit) {
      for (const k of Object.keys(script)) {
        if (k === "default") continue;
        // prefix match OR the key appears as a standalone token (handles
        // `-c ... push ...` where the subcommand is not argv[0]).
        if (a.startsWith(k) || a.split(" ").includes(k)) { hit = script[k]; break; }
      }
    }
    if (!hit) hit = script.default;
    if (!hit) return cb(new Error(`unexpected git: ${a}`), "fatal: unknown", "");
    if (hit.run) {
      const r = hit.run({ args, calls });
      return cb(r.error ?? null, r.stdout ?? "", r.stderr ?? "");
    }
    if (hit.error) return cb(hit.error, hit.stdout ?? "", hit.stderr ?? "");
    return cb(null, hit.stdout ?? "", hit.stderr ?? "");
  };
  return { fn, calls };
}

// A remote whose branch head can be read and set, so tests simulate divergence
// and already-pushed without real network.
function remoteSim() {
  const refs = {};
  return {
    ls: (branch) => (refs[branch] ? `${refs[branch]}\trefs/heads/${branch}\n` : ""),
    set: (branch, head) => { refs[branch] = head; },
  };
}

function baseOpts(over = {}) {
  return {
    stateDir: freshState(),
    attempt_id: ATTEMPT,
    result_sha: RESULT,
    target_sha: TARGET,
    branch: LANE,
    repo: REPO,
    worktree: WT,
    allowedRoot: ROOT,
    branchPrefix: "coordinator/",
    remoteUrl: REMOTE,
    // The broker-owned repository is exercised for real in
    // push-broker-gitconfig.test.mjs; here it is stubbed so these tests stay
    // about broker decision logic.
    createBrokerRepoImpl: async () => ({ ok: true, dir: mkdtempSync(join(tmpdir(), "shu-broker-stub-")), objectsDir: "/dev/null" }),
    hasCommitImpl: async () => true,
    ...over,
  };
}

// A HOLD is not enough: it must come from the control under test. Asserting
// only {ok:false, pause_adapter:true} let a neutered validator pass, because
// some LATER check produced a HOLD for an unrelated reason and the assertion
// could not tell the difference. `reasonRe` pins WHICH control fired (Opus R3).
function expectHold(res, reasonRe) {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.pause_adapter, true, "ambiguity must pause the adapter: " + res.reason);
  if (reasonRe) {
    assert.match(
      String(res.reason ?? ""),
      reasonRe,
      `HOLD came from the wrong control — expected ${reasonRe}, got: ${res.reason}`,
    );
  }
}

test("pushes the exact validated result SHA to the lane branch and confirms remote", async () => {
  const remote = remoteSim();
  const git = makeGit({
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    "ls-remote": { run: ({ args }) => ({ stdout: remote.ls(LANE) }) },
    "push": { run: () => { remote.set(LANE, RESULT); return { stdout: "" }; } },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.stage, "PUSHED");
  assert.equal(res.remote_head, RESULT);
  assert.equal(git.calls.some((c) => c.includes("push")), true, "broker must push");
  assert.equal(git.calls.some((c) => c.includes("--force")), false, "force push prohibited");
});

test("malicious / wrong remote URLs -> HOLD + pause, never pushed", async () => {
  // Each case pins the reason so the repo/host allowlist is what rejects it.
  // Without that, deleting the allowlist entirely still passed this test.
  for (const [bad, reasonRe] of [
    ["git@github.com:OtherOrg/somewhere.git", /is not the allowed repo/],
    ["https://github.com/BAWES-Universe/not-our-repo.git", /is not the allowed repo/],
    ["https://evil.co/BAWES-Universe/x.git", /is not the allowed host/],
    ["not-a-url", /unrecognized remote URL/],
    ["git@host.com:BAWES-Universe/studenthub-platform.git", /is not the allowed host/],
    // Plaintext transport to the RIGHT repo on the RIGHT host: the allowlist
    // constrains where the push goes, and must also constrain how it travels.
    ["http://github.com/BAWES-Universe/studenthub-platform.git", /unrecognized remote URL/],
  ]) {
    const res = await pushExactSha(baseOpts({ remoteUrl: bad }));
    expectHold(res, reasonRe);
  }
});

test("branch that is bare-SHA / protected / wrong prefix -> HOLD + pause", async () => {
  // Same pinning: the protected-branch and lane-prefix checks must be what
  // rejects these, not an incidental downstream HOLD.
  for (const [branch, reasonRe] of [
    ["main", /is a protected target/],
    ["master", /is a protected target/],
    ["develop", /is a protected target/],
    [RESULT, /bare SHA as branch name/],
    ["feat/elsewhere", /required lane prefix/],
    ["refs/heads/x", /must be a bare ref name/],
  ]) {
    const res = await pushExactSha(baseOpts({ branch }));
    expectHold(res, reasonRe);
  }
});

test("worktree that escapes the allowed root (realpath) -> HOLD + pause", async () => {
  const res = await pushExactSha(baseOpts({ worktree: "/etc/passwd" }));
  expectHold(res);
  assert.match(res.reason, /outside approved root/);
});

test("worktree HEAD != result_sha -> HOLD + pause", async () => {
  const git = makeGit({
    "ls-remote": { stdout: "" },
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${OTHER}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  expectHold(res);
  assert.match(res.reason, /HEAD/);
});

test("result_sha does not descend from target_sha -> HOLD + pause", async () => {
  const git = makeGit({
    "ls-remote": { stdout: "" },
    "merge-base --is-ancestor": { error: new Error("exit code 1"), stderr: "fatal: not ancestor" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  expectHold(res);
  assert.match(res.reason, /ancestor|descend/i);
});

test("dirty worktree -> HOLD + pause", async () => {
  const git = makeGit({
    "ls-remote": { stdout: "" },
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "index.ts\n" },
    "ls-files": { stdout: "" },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  expectHold(res);
});

test("hooks & credential helpers stripped; explicit SHA->branch refspec; no force", async () => {
  let pushArgs = null;
  const remote = remoteSim();
  const git = makeGit({
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    "ls-remote": { run: () => ({ stdout: remote.ls(LANE) }) },
    "push": { run: ({ args }) => { pushArgs = args; remote.set(LANE, RESULT); return { stdout: "" }; } },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  assert.equal(res.ok, true, res.reason);
  assert.ok(pushArgs && pushArgs.length, "push must run");
  const joined = pushArgs.join(" ");
  assert.ok(!pushArgs.includes("--force"), "force push prohibited");
  assert.match(joined, /core\.hooksPath=\/dev\/null/, "hooks disabled");
  assert.match(joined, /credential\.helper=/, "credential helper disabled");
  assert.match(joined, new RegExp(`${RESULT}:refs/heads/${LANE}`), "explicit SHA->branch refspec");
});

test("crash-before-push: leftover PENDING pre-push record -> HOLD, recovery must decide", async () => {
  const stateDir = freshState();
  persistPrePush({ stateDir, attempt_id: ATTEMPT, result_sha: RESULT, branch: LANE, repo: REPO, worktree: WT });
  const rec = readPrePushRecord(stateDir, ATTEMPT);
  assert.equal(rec.stage, "PENDING");
  const git = makeGit({
    // Locally valid: the validations now run BEFORE the recovery branch, so a
    // bare default would HOLD on worktree HEAD and never reach recovery.
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    default: { stdout: "" },
  });
  const res = await pushExactSha(baseOpts({ stateDir, gitImpl: git.fn }));
  expectHold(res);
  assert.match(res.reason, /pre-push record already exists|recovery required/i);
});

test("crash-after-push-before-record: remote already has result -> idempotent ALREADY_PUSHED, no re-push", async () => {
  const remote = remoteSim();
  remote.set(LANE, RESULT);
  const git = makeGit({
    "ls-remote": { run: () => ({ stdout: remote.ls(LANE) }) },
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    default: { stdout: "" },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  assert.equal(res.ok, true);
  assert.equal(res.stage, "ALREADY_PUSHED");
  assert.equal(git.calls.filter((c) => c.includes("push")).length, 0, "no re-push when remote already has result");
});

test("remote divergence: branch exists at a different sha -> HOLD, never clobber", async () => {
  const remote = remoteSim();
  remote.set(LANE, OTHER);
  const git = makeGit({
    "ls-remote": { run: () => ({ stdout: remote.ls(LANE) }) },
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    default: { stdout: "" },
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  expectHold(res);
  assert.match(res.reason, /already at|refusing to clobber|different/i);
});

test("post-push confirmation fails -> HOLD + pause, never claim success", async () => {
  const remote = remoteSim();
  const git = makeGit({
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    "ls-remote": { run: () => ({ stdout: remote.ls(LANE) }) },
    "push": { run: () => { remote.set(LANE, OTHER); return { stdout: "" }; } }, // push "succeeds" but remote shows OTHER
  });
  const res = await pushExactSha(baseOpts({ gitImpl: git.fn }));
  expectHold(res);
  assert.match(res.reason, /confirm|remote|after/i);
});

test("concurrent broker calls for the same attempt resolve without double-push or corruption", async () => {
  const remote = remoteSim();
  const git = makeGit({
    "merge-base --is-ancestor": { stdout: "" },
    "rev-parse HEAD": { stdout: `${RESULT}\n` },
    "read-tree": { stdout: "" },
    "update-index": { stdout: "" },
    "diff-index": { stdout: "" },
    "ls-files": { stdout: "" },
    "ls-remote": { run: () => ({ stdout: remote.ls(LANE) }) },
    "push": { run: () => { remote.set(LANE, RESULT); return { stdout: "" }; } },
  });
  const stateDir = freshState();
  const opts = baseOpts({ stateDir, gitImpl: git.fn });
  const results = await Promise.allSettled([
    pushExactSha({ ...opts }),
    pushExactSha({ ...opts }),
  ]);
  // Exactly one may push the pristine branch; the other must either report
  // already-pushed or HOLD on the pre-push record — never both silently pushing
  // the same pristine branch with no one observing the conflict.
  const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const pushed = fulfilled.filter((r) => r.ok === true && r.stage === "PUSHED");
  assert.ok(pushed.length <= 1, `at most one broker may push the pristine branch, got ${pushed.length}`);
});