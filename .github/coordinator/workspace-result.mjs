// SHU-228: uncommitted worker files -> host-owned deterministic Git objects.
// No Git command reads worker config/index, and no content filter is invoked.
// Linux dirfds plus O_NOFOLLOW keep every file read inside its pinned directory.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { brokerGit } from "./push-broker.mjs";
import { validateWorkspaceScope } from "./workspace-scope.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const noFollow = fs.constants.O_NOFOLLOW;

function readWorkspaceFile(root, name) {
  const parts = name.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") || path.isAbsolute(name)) {
    throw new Error("unsafe workspace path");
  }
  const fds = [];
  try {
    let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
    fds.push(fd);
    for (const component of parts.slice(0, -1)) {
      fd = fs.openSync(`/proc/self/fd/${fd}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
      fds.push(fd);
    }
    fd = fs.openSync(`/proc/self/fd/${fd}/${parts.at(-1)}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
    fds.push(fd);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE) || before.nlink !== 1n) throw new Error("workspace file is not a bounded ordinary file");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0, read;
    while (count < buffer.length && (read = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += read;
    if (count !== Number(before.size)) throw new Error("workspace file changed size while reading");
    const data = buffer.subarray(0, count);
    const after = fs.fstatSync(fd, { bigint: true });
    if (["ino", "dev", "size", "mtimeNs", "ctimeNs", "mode"].some(k => before[k] !== after[k])) throw new Error("workspace file changed while reading");
    return { data, mode: (before.mode & 0o111n) ? "100755" : "100644" };
  } catch (error) {
    if (error.code === "ENOENT") return null; // a tracked deletion
    throw error;
  } finally { for (const fd of fds.reverse()) fs.closeSync(fd); }
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function listWorkspaceFiles(root, relative = "") {
  const out = [];
  const here = relative ? path.join(root, relative) : root;
  for (const name of fs.readdirSync(here)) {
    if (!relative && name === ".git") continue;
    const rel = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, rel));
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`RESULT_SCOPE_REFUSED: symlink ${rel}`), { workspaceCode: "RESULT_SCOPE_REFUSED" });
    if (stat.isDirectory()) out.push(...listWorkspaceFiles(root, rel));
    else if (stat.isFile()) out.push(rel);
    else throw Object.assign(new Error(`RESULT_SCOPE_REFUSED: non-regular path ${rel}`), { workspaceCode: "RESULT_SCOPE_REFUSED" });
  }
  return out.sort();
}

function bindResult(stateDir, record) {
  const file = path.join(stateDir, `workspace-result-${record.attempt_id}.json`);
  const encoded = JSON.stringify(record) + "\n";
  // Link only a completely written + fsynced file. A crash never exposes a
  // partially written success record; a concurrent different result cannot win.
  const temp = path.join(stateDir, `.result-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, encoded);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temp, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
      try {
        const st = fs.fstatSync(existing);
        if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || fs.readFileSync(existing, "utf8") !== encoded) {
          throw new Error("attempt result binding conflict; never replace an earlier snapshot");
        }
      } finally { fs.closeSync(existing); }
    }
    syncDirectory(stateDir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* final binding remains authoritative */ }
  }
}

export function validateScopedResultDiff(raw, allowed_paths) {
  const allowed = new Set(allowed_paths);
  const fields = String(raw).split("\0");
  if (fields.at(-1) === "") fields.pop();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) return { ok: false, reason: "malformed full-tree diff" };
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (index + count > fields.length) return { ok: false, reason: "truncated full-tree diff" };
    const paths = fields.slice(index, index += count);
    const outside = paths.find((name) => !allowed.has(name));
    if (outside) return { ok: false, reason: `out-of-scope ${status} path ${outside}` };
  }
  return { ok: true };
}

export async function snapshotWorkspaceResult({ dir, worktree, target_sha, attempt_id, stateDir, branch, repo, gitImpl, env = {}, workspace_scope = "full", scope_phase = "initial", allowed_paths = [], scoped_base_sha = null }) {
  if (process.platform !== "linux" || !UUID.test(attempt_id ?? "")) throw new Error("invalid workspace result identity or host");
  const state = fs.lstatSync(stateDir);
  if (!state.isDirectory() || state.isSymbolicLink() || fs.realpathSync(stateDir) !== path.resolve(stateDir) ||
      state.uid !== process.getuid() || (state.mode & 0o077) || path.resolve(stateDir).startsWith(worktree + "/") || path.resolve(stateDir) === worktree) {
    throw new Error("workspace result state must be private and outside the checkout");
  }
  const meta = path.join(worktree, ".git");
  if (!fs.lstatSync(meta).isDirectory() || fs.realpathSync(meta) !== meta ||
      fs.existsSync(path.join(meta, "objects/info/alternates")) || fs.existsSync(path.join(meta, "shallow"))) {
    throw new Error("workspace metadata must be independent, without alternates or shallow ancestry");
  }
  const scope = validateWorkspaceScope({ workspace_scope, scope_phase, allowed_paths, scoped_base_sha }, { requireScopedBase: true });
  if (!scope.ok || (workspace_scope === "scoped" && scope_phase === "review")) {
    throw Object.assign(new Error(`RESULT_SCOPE_REFUSED: ${scope.reason ?? "invalid scoped review"}`), { workspaceCode: "RESULT_SCOPE_REFUSED" });
  }
  const indexFile = path.join(dir, "snapshot-index");
  const fixedEnv = { ...env, GIT_AUTHOR_NAME: "StudentHub coordinator", GIT_AUTHOR_EMAIL: "coordinator@users.noreply.github.com",
    GIT_COMMITTER_NAME: "StudentHub coordinator", GIT_COMMITTER_EMAIL: "coordinator@users.noreply.github.com",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
  const git = async (...args) => {
    const r = await brokerGit(gitImpl, ["-c", "core.bare=false", "--git-dir", dir, "--work-tree", worktree, ...args],
      { cwd: dir, env: fixedEnv, indexFile });
    if (r.error) throw new Error(`workspace snapshot Git operation failed at ${args[0]}`);
    return r.stdout;
  };
  if (workspace_scope === "scoped") {
    const baseBundle = path.join(stateDir, `${attempt_id}.base.bundle`);
    const bundleStat = fs.lstatSync(baseBundle);
    if (!bundleStat.isFile() || bundleStat.isSymbolicLink() || bundleStat.uid !== process.getuid() || (bundleStat.mode & 0o077)) {
      throw Object.assign(new Error("RESULT_SCOPE_REFUSED: private bound-base bundle is unavailable"), { workspaceCode: "RESULT_SCOPE_REFUSED" });
    }
    // Fetch while the worker alternate is temporarily detached. Otherwise Git
    // may treat partial-clone objects reachable through that alternate as
    // already present and omit hidden base blobs from the broker repository.
    const alternate = path.join(dir, "objects", "info", "alternates");
    const parkedAlternate = `${alternate}.worker`;
    fs.renameSync(alternate, parkedAlternate);
    try { await git("fetch", "--no-tags", "--no-recurse-submodules", baseBundle, target_sha); }
    finally { fs.renameSync(parkedAlternate, alternate); }
    if ((await git("rev-parse", "FETCH_HEAD^{commit}")).trim() !== target_sha) {
      throw Object.assign(new Error("RESULT_SCOPE_REFUSED: bound-base bundle returned the wrong head"), { workspaceCode: "RESULT_SCOPE_REFUSED" });
    }
  }
  const base = (await git("ls-tree", "-rz", target_sha)).split("\0").filter(Boolean);
  if (base.some(line => line.startsWith("160000 "))) throw new Error("submodules require a separate result contract");
  await git("read-tree", target_sha);
  const tracked = base.map(line => line.slice(line.indexOf("\t") + 1));
  let names;
  if (workspace_scope === "scoped") {
    const allowed = new Set(scope.paths);
    const outside = listWorkspaceFiles(worktree).filter((name) => !allowed.has(name));
    if (outside.length) {
      throw Object.assign(new Error(`RESULT_SCOPE_REFUSED: path outside immutable allowance (${outside[0]})`), { workspaceCode: "RESULT_SCOPE_REFUSED" });
    }
    names = [...scope.paths].sort();
  } else {
    const others = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
    names = [...new Set([...tracked, ...others])].sort();
  }
  if (names.length > 20000) throw new Error("workspace snapshot exceeds file limit");
  // Scoped snapshots start from the complete bound base tree, then overlay only
  // authorized paths. Hidden sparse paths therefore survive byte-for-byte;
  // absence is never misread as mass deletion.
  await git("read-tree", workspace_scope === "scoped" ? target_sha : "--empty");
  let total = 0;
  for (const name of names) {
    const file = readWorkspaceFile(worktree, name);
    if (!file) {
      if (!tracked.includes(name)) throw new Error("untracked file disappeared during snapshot");
      if (workspace_scope === "scoped") await git("update-index", "--remove", "--", name);
      continue;
    }
    total += file.data.length;
    if (total > MAX_TOTAL) throw new Error("workspace snapshot exceeds byte limit");
    const raw = path.join(dir, "raw-blob");
    fs.writeFileSync(raw, file.data, { mode: 0o600 });
    const sha = (await git("hash-object", "-w", "--no-filters", raw)).trim();
    await git("update-index", "--add", "--cacheinfo", file.mode, sha, name);
  }
  const tree = (await git("write-tree")).trim();
  if (workspace_scope === "scoped") {
    const fullDiff = validateScopedResultDiff(await git("diff", "--name-status", "-z", "-M", target_sha, tree), scope.paths);
    if (!fullDiff.ok) {
      throw Object.assign(new Error(`RESULT_SCOPE_REFUSED: ${fullDiff.reason}`), { workspaceCode: "RESULT_SCOPE_REFUSED" });
    }
  }
  const original = (await git("rev-parse", `${target_sha}^{tree}`)).trim();
  if (tree === original) throw new Error("workspace result contains no changes");
  const result_sha = (await git("-c", "commit.gpgSign=false", "commit-tree", tree, "-p", target_sha,
    "-m", `StudentHub worker result ${attempt_id}`)).trim();
  const parents = (await git("rev-list", "--parents", "-n", "1", result_sha)).trim();
  if (parents !== `${result_sha} ${target_sha}`) throw new Error("workspace result has the wrong parent");
  bindResult(stateDir, { version: 1, attempt_id, target_sha, tree, result_sha, branch, repo, worktree,
    workspace_scope, scope_phase, allowed_paths: [...scope.paths], scoped_base_sha });
  return result_sha;
}
