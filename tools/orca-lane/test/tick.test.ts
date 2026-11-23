import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireRun, claimKey, releaseRun } from "../src/lane.js";
import { BOOTSTRAP, cleanupRun, main, readAtRemoteMain, redact, runDir, setupRun, TickError } from "../src/tick.js";

const BOT = "studenthub-universe";
const NOW = new Date("2026-11-23T21:00:00Z");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../..");
const TICK_SOURCE = path.join(ROOT, "tools/orca-lane/src/tick.ts");
const TICK_BUILT = path.join(ROOT, "dist/tools/orca-lane/src/tick.js");
const run = promisify(execFile);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A synthetic origin whose `main` carries a register and the real tick.ts, a shared clone of it, and a ticks directory. */
function world() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orca-tick-"));
  const origin = path.join(root, "origin.git"), seed = path.join(root, "seed"), clone = path.join(root, "clone"), ticks = path.join(root, "ticks");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  git(seed, "config", "user.email", "fixture@example.invalid");
  git(seed, "config", "user.name", "fixture");
  git(seed, "remote", "add", "origin", origin);
  mkdirSync(path.join(seed, "tools/orca-lane/src"), { recursive: true });
  mkdirSync(path.join(seed, "docs"), { recursive: true });
  copyFileSync(TICK_SOURCE, path.join(seed, "tools/orca-lane/src/tick.ts"));
  const commit = (label: string): string => {
    writeFileSync(path.join(seed, "docs/register.md"), `register ${label}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", label);
    git(seed, "push", "--quiet", "origin", "HEAD:main");
    return git(seed, "rev-parse", "HEAD");
  };
  const first = commit("c1");
  execFileSync("git", ["clone", "--quiet", origin, clone]);
  return { root, origin, clone, ticks, commit, first };
}

/** Everything a tick must never change in the shared clone. */
function shared(clone: string) {
  const fetchHead = path.join(clone, ".git", "FETCH_HEAD");
  return {
    head: git(clone, "rev-parse", "HEAD"),
    refs: git(clone, "for-each-ref", "--format=%(refname) %(objectname)"),
    status: git(clone, "status", "--porcelain"),
    fetchHead: existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null,
  };
}

test("two wakes get separate trees, each pinned to the main it resolved; the shared clone is untouched", () => {
  const w = world();
  const before = shared(w.clone);
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "20261123T210012Z-a1" });
  const second = w.commit("c2");
  const b = setupRun({ clone: w.clone, ticks: w.ticks, run: "20261123T211503Z-b2" });
  assert.equal(a.sha, w.first);
  assert.equal(b.sha, second);
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.owner, b.owner);
  assert.equal(readFileSync(path.join(a.dir, "docs/register.md"), "utf8"), "register c1\n");
  assert.equal(readFileSync(path.join(b.dir, "docs/register.md"), "utf8"), "register c2\n");
  assert.deepEqual(shared(w.clone), before);
});

test("origin moving between resolve and fetch does not move the run's tree", () => {
  const w = world();
  let moved = "";
  const r = setupRun({ clone: w.clone, ticks: w.ticks, run: "race", afterResolve: () => { moved = w.commit("c3-during-fetch"); } });
  assert.notEqual(moved, "");
  assert.equal(r.sha, w.first);
  assert.equal(git(r.dir, "rev-parse", "HEAD"), w.first);
});

test("simultaneous setups with the same run id: exactly one wins, the loser touches nothing", async () => {
  const w = world();
  const args = ["setup", "--clone", w.clone, "--ticks", w.ticks, "--run", "20261123T2100Z"];
  const attempt = () => run(process.execPath, [TICK_BUILT, ...args]).then((r) => JSON.parse(r.stdout), (e: { stdout: string }) => JSON.parse(e.stdout));
  const results = await Promise.all([attempt(), attempt(), attempt()]);
  const winners = results.filter((r) => r.status === "ready");
  assert.equal(winners.length, 1);
  for (const loser of results.filter((r) => r.status !== "ready")) assert.equal(loser.step, "reserve");
  assert.equal(git(winners[0].dir, "rev-parse", "HEAD"), w.first);
  assert.equal(git(winners[0].dir, "status", "--porcelain"), "");
});

test("a failed wake leaves other runs' trees alone and leaves nothing of its own", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
  git(w.clone, "remote", "add", "broken", "https://user:s3cret-token@example.invalid/nothing.git");
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "b", remote: "broken" }),
    (e: unknown) => e instanceof TickError && e.step === "resolve" && !e.message.includes("s3cret-token"));
  assert.equal(existsSync(path.join(w.ticks, "b")), false);
  assert.equal(existsSync(path.join(w.ticks, ".runs", "b")), false);
  assert.throws(() => runDir(w.ticks, "../escape"), (e: unknown) => e instanceof TickError && e.step === "input");
  // A directory that exists without a reservation is never adopted or removed.
  mkdirSync(path.join(w.ticks, "orphan"), { recursive: true });
  writeFileSync(path.join(w.ticks, "orphan", "keep.txt"), "keep\n");
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "orphan" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
  assert.equal(readFileSync(path.join(w.ticks, "orphan", "keep.txt"), "utf8"), "keep\n");
  assert.equal(git(a.dir, "rev-parse", "HEAD"), w.first);
  assert.equal(git(a.dir, "status", "--porcelain"), "");
});

test("cleanup removes a tree only for the holder of its owner nonce, and never another run's", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  const b = setupRun({ clone: w.clone, ticks: w.ticks, run: "b" });
  assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: b.owner }), (e: unknown) => e instanceof TickError && e.step === "cleanup");
  assert.equal(existsSync(a.dir), true);
  assert.deepEqual(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner }), { status: "removed", run: "a", dir: a.dir });
  assert.equal(existsSync(a.dir), false);
  assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner }), (e: unknown) => e instanceof TickError && e.step === "cleanup");
  assert.equal(git(b.dir, "rev-parse", "HEAD"), w.first);
});

test("the Part C bootstrap, run verbatim, pins by SHA and writes no shared ref or FETCH_HEAD", () => {
  const w = world();
  const handover = readFileSync(path.join(ROOT, "docs/lanes/orca/HANDOVER.md"), "utf8");
  for (const step of BOOTSTRAP) assert.ok(handover.includes(`\`${step}\``), `HANDOVER Part C must carry: ${step}`);
  const before = shared(w.clone);
  mkdirSync(w.ticks, { recursive: true });
  const ls = execFileSync("sh", ["-c", BOOTSTRAP[0]], { cwd: w.clone, encoding: "utf8" });
  const sha = ls.split(/\s+/)[0]!;
  w.commit("c2-after-resolve");
  const fill = (step: string) => step.replaceAll("<sha>", sha).replaceAll("<ticks-dir>", w.ticks).replaceAll("<run-id>", "boot").replaceAll("<clone>", w.clone);
  execFileSync("sh", ["-c", fill(BOOTSTRAP[1])], { cwd: w.clone });
  execFileSync("sh", ["-c", fill(BOOTSTRAP[2])], { cwd: w.clone });
  const out = JSON.parse(execFileSync("sh", ["-c", fill(BOOTSTRAP[3])], { cwd: w.clone, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  assert.equal(out.status, "ready");
  assert.equal(out.sha, sha);
  assert.equal(sha, w.first);
  assert.equal(git(out.dir, "rev-parse", "HEAD"), w.first);
  assert.deepEqual(shared(w.clone), before);
});

test("the poll's register read inside a run's tree is fresh, by SHA, and touches no shared ref or FETCH_HEAD", () => {
  const w = world();
  const t = setupRun({ clone: w.clone, ticks: w.ticks, run: "poll" });
  const before = shared(w.clone);
  const treeFetchHead = path.join(git(t.dir, "rev-parse", "--absolute-git-dir"), "FETCH_HEAD");
  const latest = w.commit("c2-register-update");
  const read = readAtRemoteMain(t.dir, "docs/register.md");
  assert.equal(read.sha, latest);
  assert.equal(read.content, "register c2-register-update\n");
  assert.equal(git(t.dir, "rev-parse", "HEAD"), w.first);
  assert.equal(existsSync(treeFetchHead), false);
  assert.deepEqual(shared(w.clone), before);
});

test("lock flow across trees: an overlapping wake finds the B3 lock busy and removes only its own tree; a later wake proceeds once the lock is released", () => {
  // This exercises the repo side only; whether the installed Orca scheduler skips on a stale run record is outside the repo.
  const w = world();
  const claims = mkdtempSync(path.join(os.tmpdir(), "orca-claims-"));
  const keyA = claimKey(BOT, 655, 1);
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "wake-a" });
  assert.equal(acquireRun(claims, BOT, keyA, NOW, "token-a"), "acquired");
  writeFileSync(path.join(a.dir, "worker-output.txt"), "in progress\n");
  const b = setupRun({ clone: w.clone, ticks: w.ticks, run: "wake-b" });
  assert.equal(acquireRun(claims, BOT, claimKey(BOT, 656, 1), NOW, "token-b"), "busy");
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "wake-b", owner: b.owner }).status, "removed");
  assert.equal(readFileSync(path.join(a.dir, "worker-output.txt"), "utf8"), "in progress\n");
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
  let ok: number, bad: number, usage: number, noOwner: number;
  try {
    ok = main(["setup", "--clone", w.clone, "--ticks", w.ticks, "--run", "cli"]);
    git(w.clone, "remote", "set-url", "origin", "https://x-access-token:ghs_SECRET@example.invalid/r.git");
    bad = main(["setup", "--clone", w.clone, "--ticks", w.ticks, "--run", "cli2"]);
    usage = main(["setup"]);
    noOwner = main(["cleanup", "--clone", w.clone, "--ticks", w.ticks, "--run", "cli"]);
  } finally { process.stdout.write = write; }
  assert.equal(ok, 0);
  assert.equal(JSON.parse(lines[0]!).status, "ready");
  assert.equal(bad, 2);
  assert.equal(JSON.parse(lines[1]!).step, "resolve");
  assert.equal(lines.join("").includes("ghs_SECRET"), false);
  assert.equal(usage, 2);
  assert.equal(noOwner, 2);
  assert.equal(JSON.parse(lines[3]!).step, "input");
  assert.equal(redact("fatal: https://u:p@h/x"), "fatal: https://***@h/x");
});
