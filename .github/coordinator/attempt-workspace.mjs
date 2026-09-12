// Host-side checkout preparation. Each attempt gets an independent repository:
// a linked git worktree would expose the coordinator's common .git to a writer.
// Remote operations run only in a fresh coordinator-owned bare repository; the
// worker receives a local object copy, no remote or coordinator credentials.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BROKER_GIT_CONFIG_ARGS, brokerGitEnv, validateRepoUrl } from "./push-broker.mjs";
import { validateWorkspaceScope } from "./workspace-scope.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const BINDINGS = ["attempt_id", "issue_id", "authorization_ref", "requested_worker", "repo", "branch", "target_sha", "workspace_scope", "scope_phase", "scoped_base_sha"];
const SCOPED_IDENTITY_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "StudentHub coordinator",
  GIT_AUTHOR_EMAIL: "coordinator@users.noreply.github.com",
  GIT_COMMITTER_NAME: "StudentHub coordinator",
  GIT_COMMITTER_EMAIL: "coordinator@users.noreply.github.com",
  GIT_AUTHOR_DATE: "2005-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2005-01-01T00:00:00Z",
});
export const BUNDLE_CLONE_ARGS = Object.freeze(["clone", "--no-local", "--no-checkout", "--template="]);
export const REMOTE_RETIRE_ARGS = Object.freeze(["config", "--remove-section", "remote.origin"]);

function directory(p) {
  if (!path.isAbsolute(p ?? "")) throw new Error("workspace directory must be absolute");
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p) !== path.resolve(p)) {
    throw new Error("workspace directory must be a real directory without symlink components");
  }
  return path.resolve(p);
}

export function workspaceFailureCode(error) {
  const known = ["GIT_OWNERSHIP_REFUSED", "FILESYSTEM_OR_AUTH_DENIED", "SOURCE_REVISION_UNAVAILABLE", "SOURCE_UNREACHABLE", "STORAGE_FULL", "COMMAND_TIMEOUT", "COMMAND_FAILED"];
  if (known.includes(error?.workspaceCode)) return error.workspaceCode;
  const stderr = String(error?.stderr ?? "");
  if (/detected dubious ownership/.test(stderr)) return "GIT_OWNERSHIP_REFUSED";
  if (/Permission denied|permission denied/.test(stderr)) return "FILESYSTEM_OR_AUTH_DENIED";
  if (/not our ref|couldn't find remote ref|not a valid object/.test(stderr)) return "SOURCE_REVISION_UNAVAILABLE";
  if (/Could not resolve|Could not read from remote|Connection refused/.test(stderr)) return "SOURCE_UNREACHABLE";
  if (/No space left on device/.test(stderr)) return "STORAGE_FULL";
  if (error?.code === "ETIMEDOUT") return "COMMAND_TIMEOUT";
  return "COMMAND_FAILED";
}

function run(file, args, env, cwd) {
  try {
    return execFileSync(file, args, { cwd, env, encoding: "utf8", timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // Fixed allowlisted diagnoses, never worker-controlled stderr, paths or URLs.
    const code = workspaceFailureCode(error);
    throw Object.assign(new Error(`workspace command failed: ${code} (exit ${Number.isInteger(error.status) ? error.status : "unknown"})`), { workspaceCode: code });
  }
}

function scopedCommitMessage(target_sha, allowed_paths) {
  return `StudentHub scoped base\n\ntarget_sha ${target_sha}\nallowed_paths ${JSON.stringify(allowed_paths)}`;
}

export function deriveScopedBaseCommit({ source, target_sha, allowed_paths, env = process.env } = {}) {
  const scope = validateWorkspaceScope({ workspace_scope: "scoped", scope_phase: "initial", allowed_paths, scoped_base_sha: null });
  if (!scope.ok || !SHA.test(target_sha ?? "")) throw new Error(`cannot derive scoped base: ${scope.reason ?? "invalid target_sha"}`);
  const indexFile = path.join(source, `scoped-index-${process.pid}-${Date.now()}`);
  const fixedEnv = { ...brokerGitEnv(env, { indexFile }), ...SCOPED_IDENTITY_ENV };
  const git = (args) => run("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${source}`, ...args], fixedEnv, source);
  try {
    git(["cat-file", "-e", `${target_sha}^{commit}`]);
    git(["read-tree", "--empty"]);
    for (const allowedPath of scope.paths) {
      const entry = git(["ls-tree", "-z", target_sha, "--", allowedPath]);
      if (!entry) continue; // an authorized path may be newly created by the worker
      const match = entry.match(/^([0-9]{6}) ([^ ]+) ([0-9a-f]{40})\t([^\0]+)\0$/);
      if (!match || match[2] !== "blob" || match[4] !== allowedPath || !["100644", "100755"].includes(match[1])) {
        throw new Error(`allowed path is not one exact ordinary file: ${allowedPath}`);
      }
      git(["update-index", "--add", "--cacheinfo", `${match[1]},${match[3]},${allowedPath}`]);
    }
    const tree = git(["write-tree"]);
    const scopedBase = git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", scopedCommitMessage(target_sha, scope.paths)]);
    if (git(["rev-list", "--parents", "-n", "1", scopedBase]) !== scopedBase) throw new Error("scoped base must be parentless");
    return scopedBase;
  } finally { try { fs.unlinkSync(indexFile); } catch {} }
}

export function deriveScopedBaseShaFromRemote({ target_sha, allowed_paths, remoteUrl, allowedRepo = "BAWES-Universe/studenthub-platform", allowedHost = "github.com", env = process.env } = {}) {
  if (!validateRepoUrl(remoteUrl, { allowedRepo, allowedHost }).ok) throw new Error("scoped-base source is not the approved repository URL");
  const source = fs.mkdtempSync("/tmp/shu-scoped-derive-");
  const hostEnv = brokerGitEnv(env);
  const git = (args) => run("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${source}`, ...args], hostEnv, source);
  try {
    git(["init", "--bare", "--template=", source]);
    git(["fetch", "--no-tags", "--no-recurse-submodules", remoteUrl, target_sha]);
    if (git(["rev-parse", "FETCH_HEAD^{commit}"]) !== target_sha) throw new Error("scoped-base source returned the wrong commit");
    return deriveScopedBaseCommit({ source, target_sha, allowed_paths, env });
  } finally { fs.rmSync(source, { recursive: true, force: true }); }
}

function privateAttemptDirectory(cwd) {
  const stat = fs.lstatSync(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attempt workspace must remain a real directory");
  if ((stat.mode & 0o777) !== 0o750) throw new Error("attempt workspace must remain mode 0750");
}

export function workspaceBindingConflicts(record, binding) {
  return BINDINGS.some((key) => record?.[key] !== binding?.[key]) ||
    JSON.stringify(record?.allowed_paths) !== JSON.stringify(binding?.allowed_paths);
}

function publicReadOnlyTree(dir) {
  // This temporary repository contains only public-to-the-worker source objects,
  // never credentials. The different worker uid may read it but cannot edit it.
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink()) throw new Error("unexpected symlink in source repository");
    if (s.isDirectory()) publicReadOnlyTree(p);
    else fs.chmodSync(p, 0o644);
  }
  fs.chmodSync(dir, 0o755);
}

export function prepareAttemptWorkspace({ receipt, env = process.env, resume = false,
  allowedRepo = "BAWES-Universe/studenthub-platform", allowedHost = "github.com" } = {}) {
  if (!UUID.test(receipt?.attempt_id ?? "") || !SHA.test(receipt?.target_sha ?? "") ||
      receipt?.repo !== allowedRepo || !["codex-builder", "claude-verifier"].includes(receipt?.requested_worker)) {
    throw new Error("invalid attempt workspace binding");
  }
  const normalizedReceipt = Object.hasOwn(receipt, "workspace_scope") ? receipt : {
    ...receipt,
    workspace_scope: "full",
    scope_phase: receipt.requested_worker === "claude-verifier" ? "review" : "initial",
    allowed_paths: [],
    scoped_base_sha: null,
  };
  const scope = validateWorkspaceScope(normalizedReceipt, { requireScopedBase: true });
  if (!scope.ok) throw new Error(`invalid attempt workspace scope: ${scope.reason}`);
  if (receipt.requested_worker === "claude-verifier" && (normalizedReceipt.workspace_scope !== "full" || normalizedReceipt.scope_phase !== "review")) {
    throw new Error("reviewer checkout must be complete and unscoped");
  }
  const root = directory(env.SHU_WORKTREE_ROOT);
  const rootStat = fs.statSync(root);
  if ((rootStat.mode & 0o7777) !== 0o3770) {
    throw new Error("workspace root must be shared-group sticky/setgid 3770 with no world access");
  }
  const stateRoot = directory(env.SHU_WORKSPACE_STATE_DIR);
  const stateStat = fs.statSync(stateRoot);
  if ((stateStat.mode & 0o077) !== 0 || stateStat.uid !== process.getuid()) {
    throw new Error("workspace state must be coordinator-owned and private (0700)");
  }
  if (stateRoot === root || stateRoot.startsWith(root + path.sep) || root.startsWith(stateRoot + path.sep)) {
    throw new Error("workspace authority must be outside worker checkouts");
  }
  const cwd = path.join(root, receipt.attempt_id);
  // Namespaced even if the operator uses the same private directory for Codex
  // session sidecars. That adapter already owns <attempt_id>.json.
  const recordPath = path.join(stateRoot, receipt.attempt_id + ".workspace.json");
  const lockPath = path.join(stateRoot, receipt.attempt_id + ".workspace.lock");
  const binding = { ...Object.fromEntries(BINDINGS.map(k => [k, normalizedReceipt[k]])), allowed_paths: [...normalizedReceipt.allowed_paths] };
  const hostEnv = brokerGitEnv(env);
  const workerEnv = brokerGitEnv({ PATH: env.PATH ?? process.env.PATH, HOME: "/nonexistent", LANG: "C.UTF-8" });
  const writer = receipt.requested_worker === "codex-builder";
  const wrapper = writer ? (env.SHU_WORKER_LAUNCH_WRAPPER ?? "").trim().split(/\s+/).filter(Boolean) : [];
  if (writer && (wrapper.length === 0 || !/^\d+$/.test(env.SHU_WORKER_UID ?? "") ||
      Number(env.SHU_WORKER_UID) === 0 || Number(env.SHU_WORKER_UID) === process.getuid())) {
    throw new Error("writer checkout requires the configured distinct worker identity");
  }
  const git = (args, at = cwd) => run("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${at}`, ...args], hostEnv, at);
  const workerRun = (file, args, at = root) => wrapper.length
    ? run(wrapper[0], [...wrapper.slice(1), file, ...args], workerEnv, at)
    : run(file, args, workerEnv, at);
  const workerGit = (args, at = root) => workerRun("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${cwd}`, ...args], at);
  let lock;
  try { lock = fs.openSync(lockPath, "wx", 0o600); }
  catch { throw new Error("attempt workspace is locked; no concurrent preparation or automatic takeover"); }
  let source;
  try {
    let record = null;
    try {
      const st = fs.lstatSync(recordPath);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("invalid workspace authority file");
      record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (record && !Object.hasOwn(record, "workspace_scope")) {
      record = { ...record, workspace_scope: normalizedReceipt.workspace_scope,
        scope_phase: normalizedReceipt.scope_phase, allowed_paths: normalizedReceipt.allowed_paths,
        scoped_base_sha: normalizedReceipt.scoped_base_sha };
    }
    if (record && workspaceBindingConflicts(record, binding)) throw new Error("workspace immutable path binding conflict");
    if (record && record.status !== "ready") throw new Error("workspace preparation interrupted; preserve evidence for inspection");
    if (!record) {
      if (resume) throw new Error("resume workspace is missing; never recreate a running attempt");
      if (fs.existsSync(cwd) || (() => { try { fs.lstatSync(cwd); return true; } catch { return false; } })()) {
        throw new Error("unowned attempt path already exists; refusing overwrite");
      }
      if (!validateRepoUrl(env.SHU_PUSH_REMOTE_URL, { allowedRepo, allowedHost }).ok) {
        throw new Error("workspace source is not the approved repository URL");
      }
      fs.writeFileSync(recordPath, JSON.stringify({ ...binding, status: "preparing" }), { flag: "wx", mode: 0o600 });
      // Linux host contract: /tmp is shared/traversable by both identities.
      // The coordinator's TMPDIR may instead be private (0700).
      source = fs.mkdtempSync("/tmp/shu-attempt-source-");
      git(["init", "--bare", "--template=", source], source);
      git(["fetch", "--no-tags", "--no-recurse-submodules", env.SHU_PUSH_REMOTE_URL, receipt.target_sha], source);
      const fetched = git(["rev-parse", "FETCH_HEAD^{commit}"], source);
      if (fetched !== receipt.target_sha) throw new Error("workspace source returned the wrong commit");
      git(["update-ref", "refs/heads/bound", fetched], source);
      git(["symbolic-ref", "HEAD", "refs/heads/bound"], source);
      const scoped = normalizedReceipt.workspace_scope === "scoped";
      let bundle = null;
      if (scoped) {
        // R1: create a parentless commit containing only the exact allowance,
        // then deliver it through the existing cross-UID-safe bundle transport.
        // Preserve the complete authoritative base before deriving the worker's
        // parentless scoped base. The broker later reconstructs against this
        // full target; the scoped SHA is never publication or review authority.
        const baseBundle = path.join(stateRoot, `${receipt.attempt_id}.base.bundle`);
        if (fs.existsSync(baseBundle)) throw new Error("unowned scoped base bundle already exists; refusing overwrite");
        git(["bundle", "create", baseBundle, "refs/heads/bound"], source);
        fs.chmodSync(baseBundle, 0o600);
        const derived = deriveScopedBaseCommit({ source, target_sha: receipt.target_sha, allowed_paths: scope.paths, env: hostEnv });
        if (derived !== normalizedReceipt.scoped_base_sha) throw new Error("deterministic scoped_base_sha does not match the immutable receipt");
        git(["update-ref", "refs/heads/scoped", derived], source);
        git(["symbolic-ref", "HEAD", "refs/heads/scoped"], source);
        bundle = path.join(source, "scoped.bundle");
        git(["bundle", "create", bundle, "refs/heads/scoped"], source);
      } else {
        // Full reviewer checkouts retain the proven bundle path and contain no
        // partial-clone/promisor state.
        bundle = path.join(source, "bound.bundle");
        git(["bundle", "create", bundle, "refs/heads/bound"], source);
      }
      publicReadOnlyTree(source);
      workerGit([...BUNDLE_CLONE_ARGS, "--", bundle, cwd], root);
      directory(cwd);
      workerGit(["config", "user.name", writer ? "Codex worker" : "Independent reviewer"], cwd);
      workerGit(["config", "user.email", "coordinator-worker@users.noreply.github.com"], cwd);
      const checkoutHead = scoped ? normalizedReceipt.scoped_base_sha : receipt.target_sha;
      workerGit(["checkout", "--detach", checkoutHead, "--"], cwd);
      workerGit(REMOTE_RETIRE_ARGS, cwd);
      // The root remains traversable only to the reviewed shared identities.
      // Each attempt is its own non-world-readable gate; the sandbox grants its
      // reviewer UID temporary access to only the bound review attempt.
      if (writer) workerRun("chmod", ["0750", "--", cwd], root);
      else fs.chmodSync(cwd, 0o750);
    }
    directory(cwd);
    privateAttemptDirectory(cwd);
    directory(path.join(cwd, ".git"));
    const expectedUid = writer ? Number(env.SHU_WORKER_UID) : process.getuid();
    if (fs.statSync(cwd).uid !== expectedUid || fs.statSync(path.join(cwd, ".git")).uid !== expectedUid) {
      throw new Error("workspace owner does not match its lane identity");
    }
    if (fs.existsSync(path.join(cwd, ".git/objects/info/alternates"))) throw new Error("workspace must own its objects");
    const localConfig = fs.readFileSync(path.join(cwd, ".git/config"), "utf8");
    if (fs.existsSync(path.join(cwd, ".git/info/sparse-checkout")) || /partialclone|promisor\s*=\s*true|safe\.directory/i.test(localConfig)) {
      throw new Error("attempt workspace must be complete for its bound tree without sparse, promisor, or trust escapes");
    }
    if (git(["remote"])) throw new Error("attempt workspace must not retain a remote");
    git(["fsck", "--full", "--no-dangling"]);
    const head = git(["rev-parse", "HEAD"]);
    const expectedHead = normalizedReceipt.workspace_scope === "scoped" ? normalizedReceipt.scoped_base_sha : receipt.target_sha;
    if (head !== expectedHead) {
      if (!resume || !writer) throw new Error("workspace HEAD does not match the bound commit");
      git(["merge-base", "--is-ancestor", expectedHead, head]);
    }
    // Never reset an existing worker checkout. The adapter owns resume semantics,
    // including uncommitted work; the broker independently validates final output.
    if (!record) {
      if (git(["status", "--porcelain"])) throw new Error("new workspace is not clean");
      fs.writeFileSync(recordPath, JSON.stringify({ ...binding, status: "ready" }), { mode: 0o600 });
    }
    return { cwd };
  } finally {
    // A crash leaves the lock/preparing record in place, intentionally HOLDing
    // instead of deleting or reconstructing an attempt whose launch is uncertain.
    try { if (source) fs.rmSync(source, { recursive: true, force: true }); }
    finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
}
