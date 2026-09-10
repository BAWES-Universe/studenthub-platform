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
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ---------------------------------------------------------------------------
// TRUSTED GIT BOUNDARY (Codex R3 BLOCK, 2026-09-07)
//
// The worker owns its worktree, therefore it owns `<worktree>/.git/config`.
// Git configuration is executable and destination-bearing, so a worker-authored
// config subverted the broker in two demonstrated ways:
//
//   * `url.<foreign>.insteadOf <allowlisted-url>` silently REDIRECTED the push.
//     validateRepoUrl still passed — it validates the string we pass, not the
//     destination git resolves — and both remote checks followed the rewrite, so
//     post-push confirmation happily confirmed the attacker's repository.
//   * `core.sshCommand` EXECUTED as the broker process user during the very
//     first `ls-remote`, i.e. before any HOLD could help. A HOLD after arbitrary
//     execution has already lost.
//
// Two rules close this, and both are structural rather than a denylist:
//
//   1. Every broker git call runs with a sanitized environment and explicit
//      `-c` overrides for the config keys that can execute a command. `-c`
//      outranks every config FILE, so a worker key cannot win.
//   2. Every REMOTE-facing call (both `ls-remote`s and the push) runs inside a
//      BROKER-OWNED repository whose config the broker created, never inside
//      the worker's. There is no `url.*.insteadOf` there to follow. Worker
//      objects reach it through `objects/info/alternates`, which is a plain
//      path read — no config, no hooks, no `upload-pack` in the worker's repo.
//
// A denylist of dangerous keys would be the wrong shape: `url.<anything>.insteadOf`
// is unbounded in key space, so it cannot be enumerated and overridden.
// ---------------------------------------------------------------------------

// Config keys that can run a command. `-c` beats system/global/local/included
// config, so naming them here is sufficient for the non-remote worktree reads.
export const BROKER_GIT_CONFIG_ARGS = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "core.fsmonitor=false",      // runs a command during `status`
  "-c", "core.gitProxy=",
  "-c", "uploadpack.packObjectsHook=",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "core.askPass=",
  "-c", "protocol.ext.allow=never",  // ext:: URLs execute a shell command
  "-c", "protocol.file.allow=always",// alternates/local paths stay usable
  // `git replace --graft` gives a commit a FAKE parent, and every history
  // question git answers — ancestry included — honours it by default. A worker
  // owns refs/replace/* in its own repository, so it could manufacture descent
  // from target_sha for a commit that descends from nothing.
  "-c", "core.useReplaceRefs=false",
]);

// Environment variables that inject config or name a command to execute.
const GIT_EXEC_ENV_KEYS = Object.freeze([
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS",
  "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_COMMON_DIR",
]);

// brokerGitEnv — the only environment any broker git call may see.
//
// `GIT_SSH_COMMAND` is ALWAYS set, deliberately: the environment variable
// outranks `core.sshCommand`, so setting it here neutralizes a worker-authored
// `core.sshCommand` by precedence while preserving the operator's real
// deploy-key route when one is configured.
//
// Which program it names comes ONLY from the coordinator's own configuration —
// the explicit `sshCommand` argument, or `SHU_PUSH_SSH_COMMAND`. An inherited
// `GIT_SSH_COMMAND` is discarded like every other key in GIT_EXEC_ENV_KEYS: it
// names a program to execute, and a value that reached the coordinator's
// environment from outside its approved configuration must not choose it.
// Honouring it would have re-opened, through the environment, exactly the
// execution route the `core.sshCommand` override closes.
//
// Scope, stated plainly: both names live in the same process environment, so
// this does not make `SHU_PUSH_SSH_COMMAND` unforgeable to something that can
// already write the coordinator's environment. What it removes is the far
// wider surface of a GENERIC git variable — one a CI image, a wrapper script,
// a parent process or a worker-shaped context may set for reasons that have
// nothing to do with this broker — silently choosing the program the broker
// executes. Selection now requires a name that only this coordinator's
// configuration has any reason to set.
// `indexFile`, like `sshCommand`, is a COORDINATOR-supplied argument and is
// never read from the environment — GIT_INDEX_FILE is stripped above with the
// other variables that redirect git at worker-controlled state.
export function brokerGitEnv(env = {}, { sshCommand = null, indexFile = null } = {}) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/^GIT_CONFIG(_|$)/.test(key)) delete out[key]; // GIT_CONFIG, _GLOBAL, _SYSTEM, _COUNT, _KEY_n, _VALUE_n
  }
  for (const key of GIT_EXEC_ENV_KEYS) delete out[key];
  if (indexFile) out.GIT_INDEX_FILE = indexFile;
  const ssh = sshCommand ?? env.SHU_PUSH_SSH_COMMAND ?? "ssh";
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_SYSTEM = "/dev/null";
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_ATTR_NOSYSTEM = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_SSH_COMMAND = ssh;
  return out;
}

// Every broker git invocation goes through here — no exceptions, so a new call
// site cannot forget the boundary.
function brokerGit(gitImpl, args, { cwd, env, sshCommand = null, indexFile = null } = {}) {
  // The configured worker deliberately owns its checkout under another UID.
  // Trust only this invocation's validated directory, never a global wildcard;
  // retain the hardened config boundary and broker-owned remote repository.
  return runGit(gitImpl, [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${cwd}`, ...args], {
    cwd,
    env: brokerGitEnv(env, { sshCommand, indexFile }),
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
  //
  // HTTPS only, never plaintext `http:`. The host check below would still have
  // matched `http://github.com/...`, so a misconfigured SHU_PUSH_REMOTE_URL
  // could have carried the coordinator's credential and the commit itself in
  // cleartext to an allowlisted host. An allowlist that constrains WHERE the
  // push goes but not HOW it travels is only doing half its job.
  let m = remoteUrl.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) m = remoteUrl.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  let host, owner, repo;
  if (m) {
    [host, owner, repo] = [m[1], m[2], m[3].replace(/\.git$/, "")];
  } else {
    // Local transport. Deliberately only recognized when the deployment has
    // EXPLICITLY allowlisted host "file"; under the default github.com policy a
    // file: URL is an unrecognized remote and is refused, which is what keeps a
    // worker from redirecting the push at a local path.
    const f = remoteUrl.match(/^file:\/\/(\/.*\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!f || allowedHost !== "file") {
      return { ok: false, reason: `unrecognized remote URL ${remoteUrl}` };
    }
    [host, owner, repo] = ["file", f[2], f[3].replace(/\.git$/, "")];
  }
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

// createBrokerRepo — a broker-owned bare repository used for EVERY remote
// operation. Its config is one the broker just created, so no worker-authored
// `url.*.insteadOf` exists to rewrite the destination.
//
// Worker objects are reached through `objects/info/alternates`: a plain path
// read. Nothing runs `upload-pack` inside the worker's repository, so
// `uploadpack.packObjectsHook` is not reachable either.
//
// TRUST BOUNDARY — stated because it was previously implicit, which is how it
// went unexamined. This repository is created under `mkdtemp`, mode 0700, so a
// worker running as a DIFFERENT OS user cannot read or write it and the
// isolation above holds. A worker running as the SAME OS user as the
// coordinator defeats it: it can leave a detached process watching the temp
// root and edit `<dir>/config` after this function returns — restoring a
// `url.*.insteadOf` redirect before the remote calls, exactly the attack the
// broker repo exists to prevent — or read coordinator-owned credentials
// directly. (Codex, PR #32.)
//
// No in-process check closes that. Any verification this code performs can be
// raced by a same-UID process, so adding one would be theatre rather than
// defence. The control is the OS identity split (`shu-worker` must not be
// `shu-coordinator`), which is a host-provisioning property this module cannot
// assert. It is tracked as a hard SHU-69 fixture-readiness gate: the live
// unattended fixture must not run until the split is in place and verified.
export async function createBrokerRepo({
  worktree,
  gitImpl,
  env = {},
  mkdtempImpl = mkdtempSync,
  writeImpl = writeFileSync,
  mkdirImpl = mkdirSync,
  tmpRoot = null,
}) {
  // --git-common-dir resolves a linked worktree to the repository that actually
  // owns the objects. It reads paths only — no command execution — and still
  // goes through the hardened boundary.
  const cd = await brokerGit(gitImpl, ["rev-parse", "--git-common-dir"], { cwd: worktree, env });
  if (cd.error) {
    return { ok: false, reason: `could not resolve the worker git directory: ${cd.stderr.trim() || cd.error.message}` };
  }
  const commonDir = cd.stdout.trim();
  if (!commonDir) return { ok: false, reason: "worker git directory resolved to an empty path" };
  const absCommon = commonDir.startsWith("/") ? commonDir : `${worktree}/${commonDir}`;
  const objectsDir = `${absCommon.replace(/\/+$/, "")}/objects`;

  const dir = mkdtempImpl(`${tmpRoot ?? tmpdir()}/shu-broker-repo-`);
  // The directory exists before init can fail, and `dir` is not returned on a
  // failure — so the caller has nothing to clean up and every failed attempt
  // would leave one behind (CodeRabbit).
  const discard = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  const init = await brokerGit(gitImpl, ["init", "--bare", "-q", dir], { cwd: dir, env });
  if (init.error) {
    discard();
    return { ok: false, reason: `could not create the broker repository: ${init.stderr.trim() || init.error.message}` };
  }
  try {
    mkdirImpl(`${dir}/objects/info`, { recursive: true, mode: 0o700 });
    writeImpl(`${dir}/objects/info/alternates`, `${objectsDir}\n`, { mode: 0o600 });
  } catch (e) {
    discard();
    return { ok: false, reason: `could not link worker objects into the broker repository: ${e?.message ?? "unknown"}` };
  }
  return { ok: true, dir, objectsDir };
}

// brokerCleanTree — is the worker's worktree exactly `sha`, with nothing
// uncommitted and nothing untracked?
//
// This is the ONE broker operation that must read worker CONTENT, and content
// is where worker-authored filters execute: a committed `.gitattributes` naming
// `filter=p` plus `filter.p.clean` in the worker's own config runs that program
// as the broker during an ordinary `git status`. Both writes are legitimate
// worker-side actions and neither makes the worktree dirty, so the check that
// was supposed to notice tampering was itself the execution vector.
//
// `filter.<anything>.clean` is an unbounded key space, exactly like
// `url.*.insteadOf`. No list of `-c` overrides can close it — enumeration is
// the wrong shape of defence. So the check runs against the BROKER's
// repository instead: broker git-dir (whose config defines no filters at all),
// a broker-owned index, the worker's tree read only as data. A committed
// `.gitattributes` may still name `filter=p`, but with no matching driver in
// broker config there is nothing for git to run.
//
// Comparing against `sha` directly rather than HEAD keeps the broker repo's own
// refs out of it: `diff-index` reports worktree drift, `ls-files --others`
// reports untracked files, and neither needs a branch to exist.
export async function brokerCleanTree({ dir, worktree, sha, gitImpl, env = {} }) {
  const indexFile = `${dir}/broker-index`;
  const at = (args) => brokerGit(gitImpl, ["-c", "core.bare=false", "--git-dir", dir, "--work-tree", worktree, ...args],
    { cwd: worktree, env, indexFile });

  const read = await at(["read-tree", sha]);
  if (read.error) {
    return { ok: false, reason: `could not stage ${sha} for the cleanliness check: ${read.stderr.trim() || read.error.message}` };
  }
  // read-tree leaves every entry with zeroed stat info, so diff-index would
  // report a pristine worktree as fully modified. Refreshing re-stats (and
  // re-hashes where stat is inconclusive) against the real files first.
  await at(["update-index", "-q", "--refresh"]);
  const diff = await at(["diff-index", "--name-only", sha, "--"]);
  if (diff.error) {
    return { ok: false, reason: `could not compare the worktree against ${sha}: ${diff.stderr.trim() || diff.error.message}` };
  }
  const modified = diff.stdout.trim();
  if (modified.length) {
    return { ok: false, reason: `worktree is dirty: ${modified.split("\n")[0]}` };
  }
  const others = await at(["ls-files", "--others", "--exclude-standard"]);
  if (others.error) {
    return { ok: false, reason: `could not list untracked files: ${others.stderr.trim() || others.error.message}` };
  }
  const untracked = others.stdout.trim();
  if (untracked.length) {
    return { ok: false, reason: `worktree is dirty: untracked ${untracked.split("\n")[0]}` };
  }
  return { ok: true };
}

// The result commit must be readable from the broker repository before we push
// it — otherwise the push would either fail late or push something unintended.
export async function brokerRepoHasCommit({ dir, sha, gitImpl, env = {} }) {
  const r = await brokerGit(gitImpl, ["cat-file", "-e", `${sha}^{commit}`], { cwd: dir, env });
  return !r.error;
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
export async function remoteBranchHead({ repo, branch, gitImpl = execFile, remoteUrl, cwd, env = {} }) {
  // `cwd` MUST be the broker-owned repository, never the worker's worktree:
  // this is the call Codex showed executing `core.sshCommand` and following
  // `url.*.insteadOf` before any validation could help.
  const res = await brokerGit(gitImpl, ["ls-remote", remoteUrl, `refs/heads/${branch}`], { cwd, env });
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
  allowedHost = "github.com",
  gitImpl = execFile,
  readHeadImpl = null,
  isAncestorImpl = null,
  cleanTreeImpl = null,
  env = {},
  persistImpl = persistPrePush,
  readPreImpl = readPrePushRecord,
  remoteHeadImpl = remoteBranchHead,
  createBrokerRepoImpl = createBrokerRepo,
  hasCommitImpl = brokerRepoHasCommit,
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
  const rv = validateRepoUrl(remoteUrl, { allowedRepo: repo, allowedHost });
  if (!rv.ok) {
    return { stage: "HOLD", reason: rv.reason, pause_adapter: true, ok: false };
  }

  // --- broker-owned repository, created BEFORE any remote call ---------------
  // Every remote operation from here on runs in `brokerRepo.dir`, never in the
  // worker's worktree, so no worker-authored config can rewrite the destination
  // or execute a command during the very first ls-remote.
  const brokerRepo = await createBrokerRepoImpl({ worktree: cwd, gitImpl, env });
  if (!brokerRepo.ok) {
    return { stage: "HOLD", reason: brokerRepo.reason, pause_adapter: true, ok: false };
  }
  const remoteCwd = brokerRepo.dir;
  const cleanupBrokerRepo = () => {
    try { rmSync(remoteCwd, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const held = (reason) => {
    cleanupBrokerRepo();
    return { stage: "HOLD", reason, pause_adapter: true, ok: false };
  };

  // --- ancestry: result_sha must descend from target_sha ----------------------
  //
  // Asked in the BROKER's repository, not the worker's. Ancestry is a question
  // about history, and the worker owns refs/replace/* in its own repo:
  // `git replace --graft <orphan> <target>` gives an orphan a fake parent, and
  // every history question git answers honours that by default. The broker repo
  // reaches the same objects through alternates but carries none of the worker's
  // refs, so there is no replacement to honour. `core.useReplaceRefs=false` in
  // the boundary flags closes the same door a second way, for every call.
  if (isAncestorImpl) {
    const anc = await isAncestorImpl({ cwd, result_sha, target_sha, gitImpl, env });
    if (anc !== true) {
      return held(`result_sha ${result_sha} does not descend from target_sha ${target_sha}`);
    }
  } else {
    const a = await brokerGit(gitImpl, ["merge-base", "--is-ancestor", target_sha, result_sha], { cwd: remoteCwd, env });
    if (a.error) {
      return held(`result_sha ${result_sha} does not descend from target_sha ${target_sha} (${a.stderr.trim() || a.error.message})`);
    }
  }

  // --- exact worktree HEAD === result_sha -------------------------------------
  let head = null;
  if (readHeadImpl) {
    head = await readHeadImpl({ cwd, gitImpl, env });
  } else {
    const h = await brokerGit(gitImpl, ["rev-parse", "HEAD"], { cwd, env });
    if (h.error) {
      return held(`could not resolve worktree HEAD: ${h.stderr.trim() || h.error.message}`);
    }
    head = h.stdout.trim();
  }
  if (head !== result_sha) {
    return held(`worktree HEAD ${head} != result_sha ${result_sha}; worktree moved after build`);
  }

  // --- clean tree (no uncommitted / untracked changes) -------------------------
  let cleanOk = true;
  let cleanDetail = "";
  if (cleanTreeImpl) {
    const c = await cleanTreeImpl({ cwd, gitImpl, env });
    cleanOk = c.ok;
    cleanDetail = c.reason ?? "";
  } else {
    // NOT `git status` in the worker worktree: that reads the worker's config
    // and executes its filters. See brokerCleanTree.
    const c = await brokerCleanTree({ dir: remoteCwd, worktree: cwd, sha: result_sha, gitImpl, env });
    cleanOk = c.ok;
    cleanDetail = c.reason ?? "";
  }
  if (!cleanOk) {
    return held(cleanDetail || "worktree is not clean");
  }

  // --- recovery + idempotency, before any git WRITE --------------------------
  // A durable pre-push record distinguishes "crash-before-push" from
  // "crash-after-push-before-record". Recovery checks the REMOTE first and only
  // then decides. Never clobber, never re-push blindly.
  //
  // These run AFTER the local validations above, deliberately. When the lane ref
  // already equals the worker-supplied result_sha the broker returns
  // ALREADY_PUSHED — a success the adapter reports as COMPLETED. Reaching that
  // return before ancestry, worktree HEAD and cleanliness meant a retry, or a
  // pre-seeded lane, could complete by naming an old remote SHA that never
  // descended from the current target_sha: every control this broker exists to
  // bind, skipped by claiming the work was already done. A SHA is only
  // "already pushed" if it would have been allowed to be pushed.
  //
  // Nothing above writes to the worker repo or the remote — the ancestry and
  // HEAD reads are read-only, and the cleanliness check writes only the broker's
  // own index — so the recovery ordering that matters is unchanged.
  const existingRecord = readPreImpl(stateDir, attempt_id);
  const remote = await remoteHeadImpl({ repo, branch, gitImpl, remoteUrl, cwd: remoteCwd, env });
  if (remote.ok === false) {
    return held(`remote check failed: ${remote.reason}`);
  }

  if (existingRecord) {
    // Recovery path: a pre-push record exists for this attempt. The remote is
    // authoritative for whether the push landed.
    if (remote.ok === true && remote.head === result_sha) {
      // Crash-after-push: the remote already carries the result. Idempotent.
      cleanupBrokerRepo();
      return { stage: "ALREADY_PUSHED", ok: true, remote_head: result_sha, recovered: true };
    }
    if (remote.ok === true && remote.head && remote.head !== result_sha) {
      return held(`recovery: remote branch ${branch} is at ${remote.head} (a different sha than ${result_sha}); never clobber`);
    }
    // Record exists but the remote does not show the result — ambiguous
    // (crash-before-push of unknown extent). Recovery must resolve, never guess.
    return held(`pre-push record exists (${existingRecord.stage ?? "unknown"}) but remote does not confirm ${result_sha} — recovery required`);
  }

  // No record (fresh push): idempotency check against the remote.
  if (remote.ok === true && remote.head === result_sha) {
    cleanupBrokerRepo();
    return { stage: "ALREADY_PUSHED", ok: true, remote_head: result_sha };
  }
  // The lane branch may legitimately already be at the commit this attempt is
  // BOUND to: codex-cli.mjs instructs the builder to return REVISION_READY
  // "when addressing review findings on the same branch", so every follow-up
  // revision arrives with the branch sitting at the previous revision — which
  // is this attempt's target_sha. Refusing that is not clobber protection, it
  // is a deadlock: no revision could ever land.
  //
  // Accepting it is safe on three independent counts: the head equals the exact
  // commit the work was based on, the ancestry check below still requires
  // result_sha to descend from it, and the push is never forced, so git itself
  // rejects anything that is not a fast-forward. Any OTHER head is still a
  // refusal — that is someone else's commit, and this broker does not clobber.
  if (remote.ok === true && remote.head && remote.head !== target_sha) {
    return held(`remote branch ${branch} already at ${remote.head}, not ${result_sha} or the bound ${target_sha}; refusing to clobber`);
  }

  // --- durable pre-push record (BEFORE the push, distinguished from after) ----
  const pre = persistImpl({ stateDir, attempt_id, result_sha, branch, repo, worktree: cwd });
  if (!pre.ok) {
    // A concurrent broker won the reservation (EEXIST) — HOLD, the winner pushes.
    return held(pre.reason);
  }

  // --- the push: hooks off, credential helpers off, force prohibited, explicit refspec ----
  // `-c` config flags must precede the subcommand (git push -c ... is invalid).
  // Hooks, credential helpers and every other executable knob are supplied by
  // BROKER_GIT_CONFIG_ARGS to EVERY call, not just this one — the original
  // per-push flags left the remote checks unprotected.
  const pushArgs = [
    "push",
    remoteUrl,
    `${result_sha}:refs/heads/${branch}`,
  ];
  // The commit must be readable from the BROKER repository (via alternates)
  // before it can be pushed from there.
  const reachable = await hasCommitImpl({ dir: remoteCwd, sha: result_sha, gitImpl, env });
  if (!reachable) {
    return held(`result_sha ${result_sha} is not reachable from the broker repository`);
  }
  const pu = await brokerGit(gitImpl, pushArgs, { cwd: remoteCwd, env });
  if (pu.error) {
    // Ambiguous: the remote outcome is unknown. Never FAILED-terminal; HOLD so
    // recovery re-checks the remote before any re-push.
    return held(`push failed (ambiguous) — recovery re-checks remote: ${pu.stderr.trim() || pu.error.message}`);
  }

  // --- confirm the remote SHA afterward ----------------------------------------
  const after = await remoteHeadImpl({ repo, branch, gitImpl, remoteUrl, cwd: remoteCwd, env });
  const remote_head = after.ok === true ? after.head : null;
  if (after.ok !== true || remote_head !== result_sha) {
    // We attempted; if the remote doesn't now show result_sha, the outcome is
    // ambiguous (crash window, divergence). Never claim success — HOLD + pause
    // so recovery re-checks the remote before any re-push.
    return held(`post-push remote confirmation failed (remote=${remote_head}, want=${result_sha})`);
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

  cleanupBrokerRepo();
  return { stage: "PUSHED", ok: true, remote_head };
}
