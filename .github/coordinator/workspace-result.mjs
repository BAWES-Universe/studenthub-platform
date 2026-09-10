// SHU-228: uncommitted worker files -> host-owned deterministic Git objects.
// No Git command reads worker config/index, and no content filter is invoked.
// Linux dirfds plus O_NOFOLLOW keep every file read inside its pinned directory.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { brokerGit } from "./push-broker.mjs";

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

export async function snapshotWorkspaceResult({ dir, worktree, target_sha, attempt_id, stateDir, branch, repo, gitImpl, env = {} }) {
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
  const indexFile = path.join(dir, "snapshot-index");
  const fixedEnv = { ...env, GIT_AUTHOR_NAME: "StudentHub coordinator", GIT_AUTHOR_EMAIL: "coordinator@users.noreply.github.com",
    GIT_COMMITTER_NAME: "StudentHub coordinator", GIT_COMMITTER_EMAIL: "coordinator@users.noreply.github.com",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
  const git = async (...args) => {
    const r = await brokerGit(gitImpl, ["-c", "core.bare=false", "--git-dir", dir, "--work-tree", worktree, ...args],
      { cwd: dir, env: fixedEnv, indexFile });
    if (r.error) throw new Error("workspace snapshot Git operation failed");
    return r.stdout;
  };
  const base = (await git("ls-tree", "-rz", target_sha)).split("\0").filter(Boolean);
  if (base.some(line => line.startsWith("160000 "))) throw new Error("submodules require a separate result contract");
  await git("read-tree", target_sha);
  const tracked = base.map(line => line.slice(line.indexOf("\t") + 1));
  const others = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const names = [...new Set([...tracked, ...others])].sort();
  if (names.length > 20000) throw new Error("workspace snapshot exceeds file limit");
  await git("read-tree", "--empty");
  let total = 0;
  for (const name of names) {
    const file = readWorkspaceFile(worktree, name);
    if (!file) {
      if (!tracked.includes(name)) throw new Error("untracked file disappeared during snapshot");
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
  const original = (await git("rev-parse", `${target_sha}^{tree}`)).trim();
  if (tree === original) throw new Error("workspace result contains no changes");
  const result_sha = (await git("-c", "commit.gpgSign=false", "commit-tree", tree, "-p", target_sha,
    "-m", `StudentHub worker result ${attempt_id}`)).trim();
  const parents = (await git("rev-list", "--parents", "-n", "1", result_sha)).trim();
  if (parents !== `${result_sha} ${target_sha}`) throw new Error("workspace result has the wrong parent");
  bindResult(stateDir, { version: 1, attempt_id, target_sha, tree, result_sha, branch, repo, worktree });
  return result_sha;
}
