// SHU-63 push broker — Option A (ratified decision, 2026-09-07).
//
// The sandboxed worker edits, tests and commits, then returns an exact result
// SHA through its schema callback. It never receives a write token or the
// deploy key and never performs the authoritative push. THIS host-side broker
// pushes ONLY the validated exact SHA to the isolated lane branch using the
// repo-scoped deploy key.
//
// Security posture (per the ratified Option A contract):
//   * the worker identity is separate from the coordinator identity (run under
//     distinct non-root users); the deploy key is owned by the coordinator and
//     never readable by the worker.
//   * the broker validates, in order, before touching the remote:
//       1. reservation/attempt identity binds the receipt to the attempt
//       2. target SHA ancestry (result_sha must descend from target_sha)
//       3. exact worktree HEAD === result_sha
//       4. clean worktree (no uncommitted/untracked changes)
//       5. confined worktree path (resolves under an approved root)
//       6. fixed repository URL (must match the configured pilot repo host)
//       7. isolated branch prefix (never main/master/protected)
//   * the push itself: hooks disabled, credential helpers disabled, force
//     prohibited, an explicit SHA->branch refspec (never a wildcard, never a
//     dynamic ref), and the remote SHA confirmed afterward.
//   * any ambiguity -> HOLD + pause (never a partial or guessed push).
//   * a durable pre-push record is persisted BEFORE the push, so crash
//     recovery can tell "did we push?" from "did we start?" rather than guess.
//   * recovery checks the remote before considering another push
//     (idempotent: if the remote already carries result_sha at the branch, the
//     push is already done and must not run again).

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

export const SHA_RE = /^[0-9a-f]{40}$/i;
export const PUSH_STAGES = Object.freeze(["PENDING", "PUSHED", "FAILED"]);

// Protected refs that a builder may never target.
export const PROTECTED_BRANCHES = Object.freeze(["main", "master", "develop"]);

function runGit(gitImpl, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    gitImpl("git", args, { cwd, env }, (error, stdout = "", stderr = "") => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// resolveRealRoot — resolve a worktree path under an approved root.
// Returns { ok:true, path } or { ok:false, reason }.
export function resolveRealRoot(worktree, allowedRoot, realpathImpl = realpathSync) {
  if (typeof worktree !== "string" || !worktree.length) {
    return { ok: false, reason: "worktree path is empty" };
  }
  if (typeof allowedRoot !== "string" || !allowedRoot.length) {
    return { ok: false, reason: "no approved worktree root configured" };
  }
  let wt;
  try {
    wt = realpathImpl(worktree);
  } catch (e) {
    return { ok: false, reason: `worktree path does not resolve: ${e?.message ?? "unknown"}` };
  }
  let root;
  try {
    root = realpathImpl(allowedRoot);
  } catch (e) {
    return { ok: false, reason: `approved root does not resolve: ${e?.message ?? "unknown"}` };
  }
  if (wt !== root && !(wt.startsWith(`${root}/`) || wt.startsWith(`${root}${pathSep()}`))) {
    return { ok: false, reason: `worktree ${wt} is outside approved root ${root}` };
  }
  return { ok: true, path: wt };
}

function pathSep() {
  return "/";
}

// validateBranchPrefix — the lane branch must be isolated and never protected.
export function validateBranchPrefix(branch, { prefix = "coordinator/", protectedBranches = PROTECTED_BRANCHES } = {}) {
  if (typeof branch !== "string" || !branch.length) {
    return { ok: false, reason: "branch is empty" };
  }
  if (branch.startsWith("refs/")) {
    return { ok: false, reason: `branch must be a bare ref name, got ${branch}` };
  }
  if (protectedBranches.includes(branch)) {
    return { ok: false, reason: `branch ${branch} is a protected target` };
  }
  if (typeof prefix === "string" && prefix.length && !branch.startsWith(prefix)) {
    return { ok: false, reason: `branch ${branch} does not start with required lane prefix ${prefix}` };
  }
  return { ok: true, branch };
}

// validateRepoUrl — the remote the broker will push to must be the configured
// pilot repo; reject any remote that points elsewhere (supply-chain / malicious
// remote defense).
export function validateRepoUrl(remoteUrl, { allowedRepo = "BAWES-Universe/studenthub-platform", allowedHost = "github.com" } = {}) {
  if (typeof remoteUrl !== "string" || !remoteUrl.length) {
    return { ok: false, reason: "no remote URL" };
  }
  // Normalize: accept https://host/owner/repo[.git] and git@host:owner/repo[.git]
  let m = remoteUrl.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) m = remoteUrl.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    return { ok: false, reason: `unrecognized remote URL ${remoteUrl}` };
  }
  const [host, owner, repo] = [m[1], m[2], m[3].replace(/\.git$/, "")];
  // Enforce the fixed repository host too — a wrong host is a malicious/supply-chain
  // remote even when owner/repo match (the builder must never push anywhere else).
  if (host !== allowedHost) {
    return { ok: false, reason: `remote host ${host} is not the allowed host ${allowedHost}` };
  }
  const [wantOwner, wantRepo] = allowedRepo.split("/");
  if (owner !== wantOwner || repo !== wantRepo) {
    return { ok: false, reason: `remote ${owner}/${repo} is not the allowed repo ${allowedRepo}` };
  }
  return { ok: true, owner, repo };
}

// loadPrePushRecord — durable record distinguishing crash-after-start from
// crash-after-pushed. Written by persistPrePush BEFORE the push.
export function prePushRecordPath(stateDir, attempt_id) {
  return `${stateDir}/push-${attempt_id}.json`;
}

export function persistPrePush({ stateDir, attempt_id, result_sha, branch, repo, worktree, writeImpl = writeFileSync, mkdirImpl = mkdirSync }) {
  const path = prePushRecordPath(stateDir, attempt_id);
  const record = JSON.stringify({
    version: 1,
    stage: PUSH_STAGES[0], // "PENDING"
    attempt_id,
    result_sha,
    branch,
    repo,
    worktree,
    pushed_at: null,
  });
  try {
    mkdirImpl(stateDir, { recursive: true, mode: 0o700 });
    writeImpl(path, `${record}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e?.code === "EEXIST") {
      // A pre-push record already exists — recovery must decide, not overwrite.
      return { ok: false, reason: "pre-push record already exists for this attempt — recovery required", path };
    }
    return { ok: false, reason: `could not persist pre-push record: ${e?.message ?? "unknown"}` };
  }
  return { ok: true, path, record };
}

export function readPrePushRecord(stateDir, attempt_id, readImpl = readFileSync, existsImpl = existsSync) {
  const path = prePushRecordPath(stateDir, attempt_id);
  if (!existsImpl(path)) return null;
  try {
    return JSON.parse(String(readImpl(path, "utf8")));
  } catch {
    return null;
  }
}

// remoteHasResult — check whether the remote branch already carries result_sha.
// Recovery uses this to make the push idempotent.
export async function remoteBranchHead({ repo, branch, gitImpl = execFile, remoteUrl, cwd }) {
  const res = await runGit(gitImpl, ["ls-remote", remoteUrl, `refs/heads/${branch}`], { cwd });
  if (res.error) return { ok: false, reason: res.stderr.trim() || res.error.message };
  const line = res.stdout.trim().split("\n").find((l) => l.endsWith(`refs/heads/${branch}`));
  if (!line) return { ok: null, head: null };
  const head = line.split(/\s+/)[0];
  if (!SHA_RE.test(String(head))) return { ok: false, reason: `remote ref head is not a plausible SHA: ${head}` };
  return { ok: true, head };
}

// pushExactSha — the authoritative, validated push. Returns:
//   { ok:true, stage:"PUSHED", remote_head } on success
//   { ok:true, stage:"ALREADY_PUSHED", remote_head } if the remote already has it (idempotent)
//   { ok:false, stage:"HOLD", reason, pause_adapter:true } on any ambiguity
//   { ok:false, stage:"FAILED", reason } on a hard, unambiguous failure
export async function pushExactSha({
  stateDir,
  attempt_id,
  result_sha,
  target_sha,
  branch,
  repo = "BAWES-Universe/studenthub-platform",
  worktree,
  allowedRoot,
  branchPrefix = "coordinator/",
  remoteUrl,
  gitImpl = execFile,
  readHeadImpl = null,
  isAncestorImpl = null,
  cleanTreeImpl = null,
  env = {},
  persistImpl = persistPrePush,
  readPreImpl = readPrePushRecord,
  remoteHeadImpl = remoteBranchHead,
  fsyncDirImpl = null,
}) {
  // --- identity / shape -----------------------------------------------------
  if (!SHA_RE.test(String(result_sha ?? ""))) {
    return { stage: "HOLD", reason: "result_sha is not a plausible SHA", pause_adapter: true, ok: false };
  }
  if (!SHA_RE.test(String(target_sha ?? ""))) {
    return { stage: "HOLD", reason: "target_sha is not a plausible SHA", pause_adapter: true, ok: false };
  }
  if (typeof attempt_id !== "string" || !attempt_id.length) {
    return { stage: "HOLD", reason: "attempt_id is missing", pause_adapter: true, ok: false };
  }
  if (branch === result_sha) {
    // A builder must move a named lane branch; pushing to a bare SHA ref is not a PR shape.
    return { stage: "HOLD", reason: "refused to push a bare SHA as branch name", pause_adapter: true, ok: false };
  }

  // --- branch prefix / protected target -------------------------------------
  const bp = validateBranchPrefix(branch, { prefix: branchPrefix });
  if (!bp.ok) {
    return { stage: "HOLD", reason: bp.reason, pause_adapter: true, ok: false };
  }

  // --- confined worktree path ------------------------------------------------
  const confined = resolveRealRoot(worktree, allowedRoot);
  if (!confined.ok) {
    return { stage: "HOLD", reason: confined.reason, pause_adapter: true, ok: false };
  }
  const cwd = confined.path;

  // --- fixed repository URL ---------------------------------------------------
  const rv = validateRepoUrl(remoteUrl, { allowedRepo: repo });
  if (!rv.ok) {
    return { stage: "HOLD", reason: rv.reason, pause_adapter: true, ok: false };
  }

  // --- recovery + idempotency FIRST, before any git write --------------------
  // A durable pre-push record distinguishes "crash-before-push" from
  // "crash-after-push-before-record". Recovery checks the REMOTE first and only
  // then decides. Never clobber, never re-push blindly.
  const existingRecord = readPreImpl(stateDir, attempt_id);
  const remote = await remoteHeadImpl({ repo, branch, gitImpl, remoteUrl, cwd, env });
  if (remote.ok === false) {
    return { stage: "HOLD", reason: `remote check failed: ${remote.reason}`, pause_adapter: true, ok: false };
  }

  if (existingRecord) {
    // Recovery path: a pre-push record exists for this attempt. The remote is
    // authoritative for whether the push landed.
    if (remote.ok === true && remote.head === result_sha) {
      // Crash-after-push: the remote already carries the result. Idempotent.
      return { stage: "ALREADY_PUSHED", ok: true, remote_head: result_sha, recovered: true };
    }
    if (remote.ok === true && remote.head && remote.head !== result_sha) {
      return { stage: "HOLD", reason: `recovery: remote branch ${branch} is at ${remote.head} (a different sha than ${result_sha}); never clobber`, pause_adapter: true, ok: false };
    }
    // Record exists but the remote does not show the result — ambiguous
    // (crash-before-push of unknown extent). Recovery must resolve, never guess.
    return { stage: "HOLD", reason: `pre-push record exists (${existingRecord.stage ?? "unknown"}) but remote does not confirm ${result_sha} — recovery required`, pause_adapter: true, ok: false };
  }

  // No record (fresh push): idempotency check against the remote.
  if (remote.ok === true && remote.head === result_sha) {
    return { stage: "ALREADY_PUSHED", ok: true, remote_head: result_sha };
  }
  if (remote.ok === true && remote.head) {
    return { stage: "HOLD", reason: `remote branch ${branch} already at ${remote.head}, not ${result_sha}; refusing to clobber`, pause_adapter: true, ok: false };
  }

  // --- ancestry: result_sha must descend from target_sha ----------------------
  if (isAncestorImpl) {
    const anc = await isAncestorImpl({ cwd, result_sha, target_sha, gitImpl, env });
    if (anc !== true) {
      return { stage: "HOLD", reason: `result_sha ${result_sha} does not descend from target_sha ${target_sha}`, pause_adapter: true, ok: false };
    }
  } else {
    const a = await runGit(gitImpl, ["merge-base", "--is-ancestor", target_sha, result_sha], { cwd, env });
    if (a.error) {
      return { stage: "HOLD", reason: `result_sha ${result_sha} does not descend from target_sha ${target_sha} (${a.stderr.trim() || a.error.message})`, pause_adapter: true, ok: false };
    }
  }

  // --- exact worktree HEAD === result_sha -------------------------------------
  let head = null;
  if (readHeadImpl) {
    head = await readHeadImpl({ cwd, gitImpl, env });
  } else {
    const h = await runGit(gitImpl, ["rev-parse", "HEAD"], { cwd, env });
    if (h.error) {
      return { stage: "HOLD", reason: `could not resolve worktree HEAD: ${h.stderr.trim() || h.error.message}`, pause_adapter: true, ok: false };
    }
    head = h.stdout.trim();
  }
  if (head !== result_sha) {
    return { stage: "HOLD", reason: `worktree HEAD ${head} != result_sha ${result_sha}; worktree moved after build`, pause_adapter: true, ok: false };
  }

  // --- clean tree (no uncommitted / untracked changes) -------------------------
  let cleanOk = true;
  let cleanDetail = "";
  if (cleanTreeImpl) {
    const c = await cleanTreeImpl({ cwd, gitImpl, env });
    cleanOk = c.ok;
    cleanDetail = c.reason ?? "";
  } else {
    const s = await runGit(gitImpl, ["status", "--porcelain"], { cwd, env });
    if (s.error) {
      return { stage: "HOLD", reason: `could not check worktree cleanliness: ${s.stderr.trim() || s.error.message}`, pause_adapter: true, ok: false };
    }
    cleanOk = s.stdout.trim().length === 0;
    cleanDetail = cleanOk ? "" : `worktree is dirty: ${s.stdout.trim().split("\n")[0]}`;
  }
  if (!cleanOk) {
    return { stage: "HOLD", reason: cleanDetail || "worktree is not clean", pause_adapter: true, ok: false };
  }

  // --- durable pre-push record (BEFORE the push, distinguished from after) ----
  const pre = persistImpl({ stateDir, attempt_id, result_sha, branch, repo, worktree: cwd });
  if (!pre.ok) {
    // A concurrent broker won the reservation (EEXIST) — HOLD, the winner pushes.
    return { stage: "HOLD", reason: pre.reason, pause_adapter: true, ok: false };
  }

  // --- the push: hooks off, credential helpers off, force prohibited, explicit refspec ----
  // `-c` config flags must precede the subcommand (git push -c ... is invalid).
  const pushArgs = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "push",
    remoteUrl,
    `${result_sha}:refs/heads/${branch}`,
  ];
  const safeEnv = { ...env };
  delete safeEnv.GIT_ASKPASS;
  delete safeEnv.GIT_TERMINAL_PROMPT;
  const pu = await runGit(gitImpl, pushArgs, { cwd, env: safeEnv });
  if (pu.error) {
    // Ambiguous: the remote outcome is unknown. Never FAILED-terminal; HOLD so
    // recovery re-checks the remote before any re-push.
    return { stage: "HOLD", reason: `push failed (ambiguous) — recovery re-checks remote: ${pu.stderr.trim() || pu.error.message}`, pause_adapter: true, ok: false };
  }

  // --- confirm the remote SHA afterward ----------------------------------------
  const after = await remoteHeadImpl({ repo, branch, gitImpl, remoteUrl, cwd, env });
  const remote_head = after.ok === true ? after.head : null;
  if (after.ok !== true || remote_head !== result_sha) {
    // We attempted; if the remote doesn't now show result_sha, the outcome is
    // ambiguous (crash window, divergence). Never claim success — HOLD + pause
    // so recovery re-checks the remote before any re-push.
    return { stage: "HOLD", reason: `post-push remote confirmation failed (remote=${remote_head}, want=${result_sha})`, pause_adapter: true, ok: false };
  }

  // --- mark pushed in the durable record ----------------------------------------
  try {
    const rec = readPreImpl(stateDir, attempt_id);
    const mark = { ...(rec ?? {}), stage: PUSH_STAGES[1], result_sha, branch, remote_head, pushed_at: new Date().toISOString() };
    writeFileSync(pre.path ?? prePushRecordPath(stateDir, attempt_id), `${JSON.stringify(mark)}\n`, { mode: 0o600 });
  } catch (e) {
    // Best-effort: the push succeeded and remote is confirmed; a mark failure is
    // not ambiguity about whether the push happened (remote is authoritative).
  }

  return { stage: "PUSHED", ok: true, remote_head };
}
