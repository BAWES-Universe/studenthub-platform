// Host-side checkout preparation. Each attempt gets an independent repository:
// a linked git worktree would expose the coordinator's common .git to a writer.
// Remote operations run only in a fresh coordinator-owned bare repository; the
// worker receives a local object copy, no remote or coordinator credentials.
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BROKER_GIT_CONFIG_ARGS, brokerGitEnv, validateRepoUrl } from "./push-broker.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const BINDINGS = ["attempt_id", "issue_id", "authorization_ref", "requested_worker", "repo", "branch", "target_sha"];

function directory(p) {
  if (!path.isAbsolute(p ?? "")) throw new Error("workspace directory must be absolute");
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p) !== path.resolve(p)) {
    throw new Error("workspace directory must be a real directory without symlink components");
  }
  return path.resolve(p);
}

function run(file, args, env, cwd) {
  try {
    return execFileSync(file, args, { cwd, env, encoding: "utf8", timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // Never expose captured Git/SSH output or a command containing credentials.
    throw new Error(`workspace command failed (exit ${Number.isInteger(error.status) ? error.status : "unknown"}); inspect host configuration`);
  }
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
  const root = directory(env.SHU_WORKTREE_ROOT);
  const stateRoot = directory(env.SHU_WORKSPACE_STATE_DIR);
  const stateStat = fs.statSync(stateRoot);
  if ((stateStat.mode & 0o077) !== 0 || stateStat.uid !== process.getuid()) {
    throw new Error("workspace state must be coordinator-owned and private (0700)");
  }
  if (stateRoot === root || stateRoot.startsWith(root + path.sep)) {
    throw new Error("workspace authority must be outside worker checkouts");
  }
  const cwd = path.join(root, receipt.attempt_id);
  // Namespaced even if the operator uses the same private directory for Codex
  // session sidecars. That adapter already owns <attempt_id>.json.
  const recordPath = path.join(stateRoot, receipt.attempt_id + ".workspace.json");
  const lockPath = path.join(stateRoot, receipt.attempt_id + ".workspace.lock");
  const binding = Object.fromEntries(BINDINGS.map(k => [k, receipt[k]]));
  const hostEnv = brokerGitEnv(env);
  const workerEnv = brokerGitEnv({ PATH: env.PATH ?? process.env.PATH, HOME: "/nonexistent", LANG: "C.UTF-8" });
  const writer = receipt.requested_worker === "codex-builder";
  const wrapper = writer ? (env.SHU_WORKER_LAUNCH_WRAPPER ?? "").trim().split(/\s+/).filter(Boolean) : [];
  if (writer && (wrapper.length === 0 || !/^\d+$/.test(env.SHU_WORKER_UID ?? "") ||
      Number(env.SHU_WORKER_UID) === 0 || Number(env.SHU_WORKER_UID) === process.getuid())) {
    throw new Error("writer checkout requires the configured distinct worker identity");
  }
  const git = (args, at = cwd) => run("git", [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${at}`, ...args], hostEnv, at);
  const workerGit = (args, at = root, trustedSource = null) => {
    const argv = [...BROKER_GIT_CONFIG_ARGS, "-c", `safe.directory=${cwd}`,
      ...(trustedSource ? ["-c", `safe.directory=${trustedSource}`] : []), ...args];
    return wrapper.length ? run(wrapper[0], [...wrapper.slice(1), "git", ...argv], workerEnv, at)
      : run("git", argv, workerEnv, at);
  };
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
    if (record && BINDINGS.some(k => record[k] !== binding[k])) throw new Error("workspace immutable binding conflict");
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
      source = fs.mkdtempSync(path.join(tmpdir(), "shu-attempt-source-"));
      git(["init", "--bare", "--template=", source], source);
      git(["fetch", "--no-tags", "--no-recurse-submodules", env.SHU_PUSH_REMOTE_URL, receipt.target_sha], source);
      const fetched = git(["rev-parse", "FETCH_HEAD^{commit}"], source);
      if (fetched !== receipt.target_sha) throw new Error("workspace source returned the wrong commit");
      git(["update-ref", "refs/heads/bound", fetched], source);
      git(["symbolic-ref", "HEAD", "refs/heads/bound"], source);
      publicReadOnlyTree(source);
      workerGit(["clone", "--no-local", "--no-checkout", "--template=", "--", source, cwd], root, source);
      directory(cwd);
      workerGit(["config", "--remove-section", "remote.origin"], cwd);
      workerGit(["config", "user.name", writer ? "Codex worker" : "Independent reviewer"], cwd);
      workerGit(["config", "user.email", "coordinator-worker@users.noreply.github.com"], cwd);
      workerGit(["checkout", "--detach", receipt.target_sha, "--"], cwd);
    }
    directory(cwd);
    directory(path.join(cwd, ".git"));
    const expectedUid = writer ? Number(env.SHU_WORKER_UID) : process.getuid();
    if (fs.statSync(cwd).uid !== expectedUid || fs.statSync(path.join(cwd, ".git")).uid !== expectedUid) {
      throw new Error("workspace owner does not match its lane identity");
    }
    if (fs.existsSync(path.join(cwd, ".git/objects/info/alternates"))) throw new Error("workspace must own its objects");
    const head = git(["rev-parse", "HEAD"]);
    if (head !== receipt.target_sha) {
      if (!resume || !writer) throw new Error("workspace HEAD does not match the bound commit");
      git(["merge-base", "--is-ancestor", receipt.target_sha, head]);
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
