import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireRun, claimKey, releaseRun } from "../src/lane.js";
import { cleanupRun, main, redact, runDir, setupRun, TickError } from "../src/tick.js";

const BOT = "studenthub-universe";
const NOW = new Date("2026-11-23T21:00:00Z");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A synthetic origin with `main`, a shared clone of it, and a ticks directory. */
function world() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orca-tick-"));
  const origin = path.join(root, "origin.git"), seed = path.join(root, "seed"), clone = path.join(root, "clone"), ticks = path.join(root, "ticks");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  git(seed, "config", "user.email", "fixture@example.invalid");
  git(seed, "config", "user.name", "fixture");
  git(seed, "remote", "add", "origin", origin);
  const commit = (label: string): string => {
    writeFileSync(path.join(seed, "state.txt"), `${label}\n`);
    git(seed, "add", "state.txt");
    git(seed, "commit", "--quiet", "-m", label);
    git(seed, "push", "--quiet", "origin", "HEAD:main");
    return git(seed, "rev-parse", "HEAD");
  };
  const first = commit("c1");
  execFileSync("git", ["clone", "--quiet", origin, clone]);
  return { root, origin, clone, ticks, commit, first };
}

function snapshot(clone: string) {
  return {
    head: git(clone, "rev-parse", "HEAD"),
    tracking: git(clone, "rev-parse", "refs/remotes/origin/main"),
    status: git(clone, "status", "--porcelain"),
    fetchHead: existsSync(path.join(clone, ".git", "FETCH_HEAD")) ? readFileSync(path.join(clone, ".git", "FETCH_HEAD"), "utf8") : null,
  };
}

test("two wakes get separate trees, each pinned to the main it resolved; the shared clone is untouched", () => {
  const w = world();
  const before = snapshot(w.clone);
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "20261123T2100Z" });
  const second = w.commit("c2");
  const b = setupRun({ clone: w.clone, ticks: w.ticks, run: "20261123T2115Z" });
  assert.equal(a.sha, w.first);
  assert.equal(b.sha, second);
  assert.notEqual(a.dir, b.dir);
  assert.equal(git(a.dir, "rev-parse", "HEAD"), w.first);
  assert.equal(git(b.dir, "rev-parse", "HEAD"), second);
  assert.equal(readFileSync(path.join(a.dir, "state.txt"), "utf8"), "c1\n");
  assert.equal(readFileSync(path.join(b.dir, "state.txt"), "utf8"), "c2\n");
  // No checkout, no remote-tracking update and no FETCH_HEAD write in the shared clone.
  assert.deepEqual(snapshot(w.clone), before);
});

test("origin moving between resolve and fetch does not move the run's tree", () => {
  const w = world();
  let moved = "";
  const r = setupRun({ clone: w.clone, ticks: w.ticks, run: "race", afterResolve: () => { moved = w.commit("c3-during-fetch"); } });
  assert.notEqual(moved, "");
  assert.equal(r.sha, w.first);
  assert.equal(git(r.dir, "rev-parse", "HEAD"), w.first);
});

test("a failed wake leaves other runs' trees alone and leaves no tree of its own", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  // Reused run id: refused before any git write.
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), (e: unknown) => e instanceof TickError && e.step === "input");
  // Unreachable remote: resolve fails, nothing is created.
  git(w.clone, "remote", "add", "broken", "https://user:s3cret-token@example.invalid/nothing.git");
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "b", remote: "broken" }),
    (e: unknown) => e instanceof TickError && e.step === "resolve" && !e.message.includes("s3cret-token"));
  assert.equal(existsSync(path.join(w.ticks, "b")), false);
  // Path climbing is refused.
  assert.throws(() => runDir(w.ticks, "../escape"), (e: unknown) => e instanceof TickError && e.step === "input");
  assert.equal(git(a.dir, "rev-parse", "HEAD"), w.first);
  assert.equal(git(a.dir, "status", "--porcelain"), "");
});

test("cleanup removes exactly its own tree, never another run's, and refuses a stray directory", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  const b = setupRun({ clone: w.clone, ticks: w.ticks, run: "b" });
  assert.deepEqual(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), { status: "removed", run: "a", dir: a.dir });
  assert.equal(existsSync(a.dir), false);
  assert.equal(git(b.dir, "rev-parse", "HEAD"), w.first);
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a" }).status, "absent");
  mkdirSync(path.join(w.ticks, "stray"), { recursive: true });
  assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run: "stray" }), (e: unknown) => e instanceof TickError && e.step === "cleanup");
  assert.equal(existsSync(path.join(w.ticks, "stray")), true);
});

test("full flow: an overlapping wake builds in its own tree, finds the B3 lock busy, and a later wake proceeds despite a stale earlier run", () => {
  const w = world();
  const claims = mkdtempSync(path.join(os.tmpdir(), "orca-claims-"));
  const keyA = claimKey(BOT, 655, 1);
  // Wake A: its own tree, takes the run lock and works.
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "wake-a" });
  assert.equal(acquireRun(claims, BOT, keyA, NOW, "token-a"), "acquired");
  writeFileSync(path.join(a.dir, "worker-output.txt"), "in progress\n");
  // Wake B overlaps (the scheduler still lists A as running): separate tree, lock busy, quiet skip, removes only its tree.
  const b = setupRun({ clone: w.clone, ticks: w.ticks, run: "wake-b" });
  assert.equal(acquireRun(claims, BOT, claimKey(BOT, 656, 1), NOW, "token-b"), "busy");
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "wake-b" }).status, "removed");
  assert.equal(readFileSync(path.join(a.dir, "worker-output.txt"), "utf8"), "in progress\n");
  // A releases the lock but its tree is left behind (a stale, never-cleaned run): the next wake still progresses.
  assert.equal(releaseRun(claims, BOT, keyA, "token-a"), "released");
  const next = w.commit("c2");
  const c = setupRun({ clone: w.clone, ticks: w.ticks, run: "wake-c" });
  assert.equal(c.sha, next);
  assert.equal(acquireRun(claims, BOT, claimKey(BOT, 656, 1), NOW, "token-c"), "acquired");
  assert.equal(existsSync(a.dir), true);
});

test("the CLI prints one JSON line, exits 2 on failure, and never prints credentials", () => {
  const w = world();
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { lines.push(chunk); return true; }) as typeof process.stdout.write;
  let ok: number, bad: number, usage: number;
  try {
    ok = main(["setup", "--clone", w.clone, "--ticks", w.ticks, "--run", "cli"]);
    git(w.clone, "remote", "set-url", "origin", "https://x-access-token:ghs_SECRET@example.invalid/r.git");
    bad = main(["setup", "--clone", w.clone, "--ticks", w.ticks, "--run", "cli2"]);
    usage = main(["setup"]);
  } finally { process.stdout.write = write; }
  assert.equal(ok, 0);
  assert.equal(JSON.parse(lines[0]!).status, "ready");
  assert.equal(bad, 2);
  const failed = JSON.parse(lines[1]!);
  assert.equal(failed.status, "failed");
  assert.equal(failed.step, "resolve");
  assert.equal(lines.join("").includes("ghs_SECRET"), false);
  assert.equal(usage, 2);
  assert.equal(JSON.parse(lines[2]!).step, "input");
  assert.equal(redact("fatal: https://u:p@h/x"), "fatal: https://***@h/x");
});
