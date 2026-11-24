import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireRun, claimKey, releaseRun } from "../src/lane.js";
import { BOOTSTRAP, cleanupRun, TEARDOWN, main, readAtRemoteMain, redact, runDir, setupRun, TickError } from "../src/tick.js";

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
  assert.deepEqual(readdirSync(path.join(w.ticks, ".runs", "b")).sort(), ["abandoned", "owner"]);
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

test("while a cleanup holds its run id, a second cleanup and a same-id setup cannot touch the tree, and the id is never reused", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  const reserved = path.join(w.ticks, ".runs", "a");
  const during: { second?: unknown; setup?: unknown } = {};
  const result = cleanupRun({
    clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner,
    afterClaim: () => {
      try { cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner }); } catch (error) { during.second = error; }
      try { setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }); } catch (error) { during.setup = error; }
      assert.equal(existsSync(a.dir), true);
      assert.equal(git(a.dir, "rev-parse", "HEAD"), w.first);
    },
  });
  assert.equal(result.status, "removed");
  assert.ok(during.second instanceof TickError && during.second.step === "cleanup");
  assert.ok(during.setup instanceof TickError && during.setup.step === "reserve");
  assert.equal(existsSync(a.dir), false);
  assert.deepEqual(readdirSync(reserved).sort(), ["owner", "removed", "tree"]);
  assert.equal(readFileSync(path.join(reserved, "owner"), "utf8"), a.owner);
  // The id stays spent: a later setup is refused, and a late cleanup by the same owner is refused too.
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
  assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner }), (e: unknown) => e instanceof TickError && /already removed/.test(e.message));
  assert.deepEqual(readdirSync(reserved).sort(), ["owner", "removed", "tree"]);
});

test("an abandoned setup never frees its id; a cleanup held during abandonment keeps exclusive ownership of its claim", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  const orphan = path.join(w.ticks, "x");
  mkdirSync(orphan, { recursive: true });
  const reservedA = path.join(w.ticks, ".runs", "a");
  const reservedX = path.join(w.ticks, ".runs", "x");
  // While a's cleanup holds its claim, a wrong-owner cleanup is refused and leaves the claim alone, and a
  // setup for x abandons (stray directory); abandonment deletes no reservation, its own or a's.
  assert.equal(cleanupRun({
    clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner,
    afterClaim: () => {
      assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: "0".repeat(32) }), (e: unknown) => e instanceof TickError && /not the owner/.test(e.message));
      assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "x" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
      assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
      assert.deepEqual(readdirSync(reservedA).sort(), ["cleaning", "owner", "tree"]);
      assert.deepEqual(readdirSync(reservedX).sort(), ["abandoned", "owner"]);
    },
  }).status, "removed");
  assert.deepEqual(readdirSync(reservedA).sort(), ["owner", "removed", "tree"]);
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "x" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
  assert.equal(existsSync(orphan), true);
});

test("a cleanup that fails after the tree is gone but before its marker can be retried by the same owner", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  const reserved = path.join(w.ticks, ".runs", "a");
  assert.throws(
    () => cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner, afterRemoval: () => { throw new Error("marker write failed"); } }),
    (e: unknown) => e instanceof TickError && e.step === "cleanup" && /marker write failed/.test(e.message) && /retry/.test(e.message),
  );
  assert.equal(existsSync(a.dir), false);
  assert.deepEqual(readdirSync(reserved).sort(), ["owner", "tree"]);
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner }).status, "removed");
  assert.deepEqual(readdirSync(reserved).sort(), ["owner", "removed", "tree"]);
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
});

test("a failed cleanup keeps the reservation in place, even with a same-id setup overlapping it, so the same owner can retry", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "a" });
  const overlap: unknown[] = [];
  assert.throws(
    () => cleanupRun({
      clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner,
      afterClaim: () => {
        try { setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }); } catch (error) { overlap.push(error); }
        throw new Error("disk busy");
      },
    }),
    (e: unknown) => e instanceof TickError && e.step === "cleanup" && /disk busy/.test(e.message) && /retry/.test(e.message),
  );
  assert.equal(overlap.length, 1);
  assert.ok(overlap[0] instanceof TickError && overlap[0].step === "reserve");
  // After the failure, another same-id setup is still refused, and the original owner value is where the retry reads it.
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run: "a" }), (e: unknown) => e instanceof TickError && e.step === "reserve");
  assert.equal(existsSync(a.dir), true);
  assert.equal(git(a.dir, "rev-parse", "HEAD"), w.first);
  assert.equal(readFileSync(path.join(w.ticks, ".runs", "a", "owner"), "utf8"), a.owner);
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: "a", owner: a.owner }).status, "removed");
  assert.equal(existsSync(a.dir), false);
  assert.deepEqual(readdirSync(path.join(w.ticks, ".runs", "a")).sort(), ["owner", "removed", "tree"]);
});

test("cleanup finishes a tree that Git already unregistered but could not delete (the Windows \"Directory not empty\" case)", () => {
  const w = world();
  const before = shared(w.clone);
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "20261124T060012Z-9c1d" });
  // Reproduce what Git for Windows left behind: the worktree's admin entry is gone, its files are not.
  mkdirSync(path.join(a.dir, "node_modules", "deep", "nested"), { recursive: true });
  writeFileSync(path.join(a.dir, "node_modules", "deep", "nested", "file.js"), "x");
  rmSync(git(a.dir, "rev-parse", "--absolute-git-dir"), { recursive: true, force: true });
  assert.equal(git(w.clone, "worktree", "list", "--porcelain").includes(a.dir), false);
  assert.equal(existsSync(a.dir), true);
  // A wrong owner still removes nothing.
  assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run: a.run, owner: "0".repeat(32) }), (e: unknown) => e instanceof TickError && /not the owner/.test(e.message));
  assert.equal(existsSync(a.dir), true);
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: a.run, owner: a.owner }).status, "removed");
  assert.equal(existsSync(a.dir), false);
  assert.deepEqual(readdirSync(path.join(w.ticks, ".runs", a.run)).sort(), ["owner", "removed", "tree"]);
  assert.deepEqual(shared(w.clone), before);
});

test("a path the run did not create is never deleted by cleanup, even by the reservation's owner", () => {
  const w = world();
  const run = "20261124T061512Z-7e2a";
  const foreign = runDir(w.ticks, run);
  mkdirSync(path.join(foreign, "keep"), { recursive: true });
  writeFileSync(path.join(foreign, "keep", "data.txt"), "not the run's");
  assert.throws(() => setupRun({ clone: w.clone, ticks: w.ticks, run }), (e: unknown) => e instanceof TickError && e.step === "reserve" && /left in place/.test(e.message));
  const reserved = path.join(w.ticks, ".runs", run);
  assert.deepEqual(readdirSync(reserved).sort(), ["abandoned", "owner"]);
  const owner = readFileSync(path.join(reserved, "owner"), "utf8");
  assert.throws(() => cleanupRun({ clone: w.clone, ticks: w.ticks, run, owner }), (e: unknown) => e instanceof TickError && e.step === "cleanup" && /still present/.test(e.message));
  assert.equal(readFileSync(path.join(foreign, "keep", "data.txt"), "utf8"), "not the run's");
  assert.deepEqual(readdirSync(reserved).sort(), ["abandoned", "owner"]);
});

test("cleanup removes a registered tree that holds untracked build output, and leaves no worktree entry", () => {
  const w = world();
  const a = setupRun({ clone: w.clone, ticks: w.ticks, run: "build-output" });
  mkdirSync(path.join(a.dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(a.dir, "node_modules", "pkg", "index.js"), "x");
  assert.equal(cleanupRun({ clone: w.clone, ticks: w.ticks, run: a.run, owner: a.owner }).status, "removed");
  assert.equal(existsSync(a.dir), false);
  assert.equal(git(w.clone, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
});

/** Fills the Part C placeholders for one wake. */
function filler(values: { sha?: string; ticks: string; run: string; clone: string; launch?: string; owner?: string }) {
  return (step: string): string => step
    .replaceAll("<sha>", values.sha ?? "<sha>").replaceAll("<ticks-dir>", values.ticks).replaceAll("<run-id>", values.run)
    .replaceAll("<clone>", values.clone).replaceAll("<launch>", values.launch ?? "<launch>").replaceAll("<owner>", values.owner ?? "<owner>");
}

const sh = (cwd: string, line: string) => run("sh", ["-c", line], { cwd, encoding: "utf8" }).then((r) => ({ code: 0, out: r.stdout }), (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }));

/** One wake through the Part C shell lines, verbatim, up to its setup JSON. */
async function wake(w: ReturnType<typeof world>, runId: string, sha: string) {
  let fill = filler({ sha, ticks: w.ticks, run: runId, clone: w.clone });
  assert.equal((await sh(w.clone, fill(BOOTSTRAP[1]))).code, 0);
  const launch = (await sh(w.clone, fill(BOOTSTRAP[2]))).out.trim();
  fill = filler({ sha, ticks: w.ticks, run: runId, clone: w.clone, launch });
  assert.equal((await sh(w.clone, fill(BOOTSTRAP[3]))).code, 0);
  return { launch, fill };
}

test("the Part C bootstrap and teardown, run verbatim, pin by SHA and write no shared ref or FETCH_HEAD", async () => {
  const w = world();
  const handover = readFileSync(path.join(ROOT, "docs/lanes/orca/HANDOVER.md"), "utf8");
  for (const step of [...BOOTSTRAP, ...TEARDOWN]) assert.ok(handover.includes(`\`${step}\``), `HANDOVER Part C must carry: ${step}`);
  const before = shared(w.clone);
  const sha = (await sh(w.clone, BOOTSTRAP[0])).out.split(/\s+/)[0]!;
  w.commit("c2-after-resolve");
  const { launch, fill } = await wake(w, "20261124T061512Z-3fa9", sha);
  const out = JSON.parse((await sh(w.clone, fill(BOOTSTRAP[4]))).out);
  assert.equal(out.status, "ready");
  assert.equal(out.sha, w.first);
  assert.equal(git(out.dir, "rev-parse", "HEAD"), w.first);
  assert.deepEqual(shared(w.clone), before);
  const end = filler({ ticks: w.ticks, run: out.run, clone: w.clone, launch, owner: out.owner });
  assert.equal(JSON.parse((await sh(w.clone, end(TEARDOWN[0]))).out).status, "removed");
  assert.equal((await sh(w.clone, end(TEARDOWN[1]))).code, 0);
  assert.equal(existsSync(out.dir), false);
  assert.deepEqual(readdirSync(path.join(w.ticks, ".launch")), []);
  assert.deepEqual(shared(w.clone), before);
});

test("simultaneous same-id wakes through the shell bootstrap and teardown: each has its own launcher, and only the winner's cleanup removes the tree", async () => {
  const w = world();
  const before = shared(w.clone);
  const runId = "20261124T061512Z-3fa9";
  const sha = (await sh(w.clone, BOOTSTRAP[0])).out.split(/\s+/)[0]!;
  // All three wakes create and write their launchers before any setup runs, then set up at once.
  const wakes = await Promise.all([wake(w, runId, sha), wake(w, runId, sha), wake(w, runId, sha)]);
  assert.equal(new Set(wakes.map((k) => k.launch)).size, 3);
  const tick = readFileSync(TICK_SOURCE, "utf8");
  for (const k of wakes) assert.equal(readFileSync(path.join(k.launch, "tick.ts"), "utf8"), tick);
  const setups = await Promise.all(wakes.map(async (k) => ({ ...k, result: JSON.parse((await sh(w.clone, k.fill(BOOTSTRAP[4]))).out) })));
  const winners = setups.filter((k) => k.result.status === "ready");
  const losers = setups.filter((k) => k.result.status !== "ready");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 2);
  const winner = winners[0]!;
  // Losers end first: they run only the launcher removal, which must leave the winner's launcher and tree alone.
  for (const k of losers) {
    assert.equal(k.result.step, "reserve");
    assert.equal((await sh(w.clone, filler({ ticks: w.ticks, run: runId, clone: w.clone, launch: k.launch })(TEARDOWN[1]))).code, 0);
    assert.equal(existsSync(k.launch), false);
  }
  assert.equal(readFileSync(path.join(winner.launch, "tick.ts"), "utf8"), tick);
  assert.equal(git(winner.result.dir, "rev-parse", "HEAD"), sha);
  // A loser that tried cleanup anyway (it has no owner value) would remove nothing.
  const stray = await sh(w.clone, filler({ ticks: w.ticks, run: runId, clone: w.clone, launch: winner.launch, owner: "0".repeat(32) })(TEARDOWN[0]));
  assert.equal(stray.code, 2);
  assert.equal(existsSync(winner.result.dir), true);
  const end = filler({ ticks: w.ticks, run: runId, clone: w.clone, launch: winner.launch, owner: winner.result.owner });
  assert.equal(JSON.parse((await sh(w.clone, end(TEARDOWN[0]))).out).status, "removed");
  assert.equal((await sh(w.clone, end(TEARDOWN[1]))).code, 0);
  assert.equal(existsSync(winner.result.dir), false);
  assert.deepEqual(readdirSync(path.join(w.ticks, ".launch")), []);
  assert.deepEqual(shared(w.clone), before);
});

test("a ticks directory reached through a symlink, with spaces in its path, runs the verbatim Part C bootstrap and teardown", async () => {
  const base = world();
  const real = path.join(base.root, "real ticks dir");
  mkdirSync(real);
  const link = path.join(base.root, "ticks link");
  symlinkSync(real, link);
  const w = { ...base, ticks: link };
  const before = shared(w.clone);
  const sha = (await sh(w.clone, BOOTSTRAP[0])).out.split(/\s+/)[0]!;
  const { launch, fill } = await wake(w, "20261124T071512Z-5be1", sha);
  // The launcher path runs through the symlink and contains spaces, so the CLI guard and the quoting both matter.
  assert.ok(launch.startsWith(link) && launch.includes(" "));
  const out = JSON.parse((await sh(w.clone, fill(BOOTSTRAP[4]))).out);
  assert.equal(out.status, "ready");
  assert.equal(git(out.dir, "rev-parse", "HEAD"), w.first);
  const end = filler({ ticks: w.ticks, run: out.run, clone: w.clone, launch, owner: out.owner });
  assert.equal(JSON.parse((await sh(w.clone, end(TEARDOWN[0]))).out).status, "removed");
  assert.equal((await sh(w.clone, end(TEARDOWN[1]))).code, 0);
  assert.equal(existsSync(out.dir), false);
  assert.equal(git(w.clone, "worktree", "list", "--porcelain").includes("real ticks dir"), false);
  assert.deepEqual(readdirSync(path.join(real, ".launch")), []);
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
