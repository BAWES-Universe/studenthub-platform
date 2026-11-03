// Disk upkeep after every card run: old run clones go, live and recent ones stay.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneRunClones, capJournal, capNpmCache, diskUpkeep, diskLine, DISK_LIMITS, ATTEMPT_DIR, workspaceStateDirs } from "../service/disk-prune.mjs";
import { renderRunReport } from "../service/card-prepare.mjs";

const NOW = Date.parse("2026-11-03T16:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function realExec(calls) {
  return (file, args, options = {}) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    if (file !== "rm") return { status: 0, stdout: "", stderr: "" };
    // rm -rf --one-file-system, doubled in memory: rmSync never follows a link.
    assert.deepEqual(args.slice(0, 3), ["-rf", "--one-file-system", "--"]);
    fs.rmSync(args[3], { recursive: true, force: true });
    return { status: 0, stdout: "", stderr: "" };
  };
}

// A worktree root and a workspace state folder in a temporary directory.
function box() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "disk-prune-"));
  const root = path.join(base, "worktrees");
  const state = path.join(base, "workspaces");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const calls = [];
  const io = { fs, now: () => new Date(NOW), exec: realExec(calls) };
  const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
  // A clone as an attempt leaves it: a checkout with a git directory, last
  // changed `age` ago, and its record when `status` is given.
  const clone = (name, age, { status = "ready", gitAge = age } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, ".git/logs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "x".repeat(1000));
    for (const file of [".git/index", ".git/HEAD", ".git/logs/HEAD"]) { fs.writeFileSync(path.join(dir, file), "x"); touch(path.join(dir, file), NOW - gitAge); }
    touch(path.join(dir, ".git/logs"), NOW - gitAge);
    touch(path.join(dir, ".git"), NOW - gitAge);
    touch(dir, NOW - age);
    if (status) {
      const record = path.join(state, `${name}.workspace.json`);
      fs.writeFileSync(record, JSON.stringify({ status }));
      touch(record, NOW - age);
    }
    return dir;
  };
  return { base, root, state, io, calls, clone, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("Disk D1: a finished run clone older than two days goes; a recent one stays", () => {
  const b = box();
  try {
    const old = b.clone(id(1), 3 * DAY);
    const recent = b.clone(id(2), 6 * HOUR);
    const result = pruneRunClones(b.io, { root: b.root, stateDirs: [b.state] });
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(result.removed, 1);
    assert.equal(result.kept, 1);
    assert.equal(result.failed, 0);
    assert.ok(Number.isFinite(result.freed_bytes));
    assert.ok(fs.existsSync(path.join(b.state, `${id(1)}.workspace.json`)), "the workspace record is never touched");
    const rm = b.calls.find((call) => call.file === "rm");
    assert.deepEqual(rm.args, ["-rf", "--one-file-system", "--", old], "removal never leaves the root's file system");
    assert.ok(rm.timeoutMs <= DISK_LIMITS.pruneBudgetMs, "a removal is bounded by what is left of the budget");
  } finally { b.done(); }
});

test("Disk D2: a clone whose git directory changed recently stays, however old the directory itself", () => {
  const b = box();
  try {
    const live = b.clone(id(1), 10 * DAY, { gitAge: HOUR });
    assert.equal(pruneRunClones(b.io, { root: b.root, stateDirs: [b.state] }).removed, 0);
    assert.equal(fs.existsSync(live), true);
  } finally { b.done(); }
});

test("Disk D3: a clone whose preparation lock is held stays, in any worker's state folder", () => {
  const b = box();
  const w2 = path.join(b.base, "w2");
  fs.mkdirSync(w2);
  try {
    const locked = b.clone(id(1), 10 * DAY);
    fs.writeFileSync(path.join(w2, `${id(1)}.workspace.lock`), "");
    assert.equal(pruneRunClones(b.io, { root: b.root, stateDirs: [b.state, w2] }).removed, 0);
    assert.equal(fs.existsSync(locked), true);
  } finally { b.done(); }
});

test("Disk D3b: a clone whose launch the supervisor ordered but never completed stays", () => {
  const b = box();
  try {
    const pending = b.clone(id(1), 10 * DAY);
    const done = b.clone(id(2), 10 * DAY);
    for (const sub of ["orders", "completions"]) fs.mkdirSync(path.join(b.state, "supervisor", sub), { recursive: true });
    fs.writeFileSync(path.join(b.state, "supervisor/orders", `${id(1)}.json`), "{}");
    fs.writeFileSync(path.join(b.state, "supervisor/orders", `${id(2)}.json`), "{}");
    fs.writeFileSync(path.join(b.state, "supervisor/completions", `${id(2)}.json`), "{}");
    const result = pruneRunClones(b.io, { root: b.root, stateDirs: [b.state] });
    assert.equal(fs.existsSync(pending), true, "a pending launch keeps its clone");
    assert.equal(fs.existsSync(done), false, "a completed launch's clone goes");
    assert.deepEqual([result.removed, result.kept], [1, 1]);
  } finally { b.done(); }
});

test("Disk D4: an attempt whose preparation never finished is kept as evidence for seven days", () => {
  const b = box();
  try {
    const young = b.clone(id(1), 3 * DAY, { status: "preparing" });
    const old = b.clone(id(2), 8 * DAY, { status: "preparing" });
    const bare = b.clone(id(3), 3 * DAY, { status: null });
    const result = pruneRunClones(b.io, { root: b.root, stateDirs: [b.state] });
    assert.equal(fs.existsSync(young), true);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(bare), false, "a clone with no record at all goes by its own age");
    assert.equal(result.removed, 2);
  } finally { b.done(); }
});

test("Disk D5: only attempt-named directories are looked at; links and hand-made worktrees stay", () => {
  const b = box();
  try {
    for (const name of ["build-SHU-5", "review-pr-12", "w2-build-SHU-6", "notes"]) {
      fs.mkdirSync(path.join(b.root, name));
      fs.utimesSync(path.join(b.root, name), new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
    }
    const target = b.clone(id(9), 30 * DAY);
    const outside = path.join(b.base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "x");
    fs.symlinkSync(outside, path.join(b.root, id(1)));
    fs.writeFileSync(path.join(b.root, id(2)), "a file, not a clone");
    const result = pruneRunClones(b.io, { root: b.root, stateDirs: [b.state] });
    assert.equal(fs.existsSync(target), false);
    for (const name of ["build-SHU-5", "review-pr-12", "w2-build-SHU-6", "notes", id(2)]) assert.ok(fs.existsSync(path.join(b.root, name)), name);
    assert.ok(fs.lstatSync(path.join(b.root, id(1))).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(outside, "keep")), "a link is never followed");
    assert.equal(result.other, 4);
    assert.equal(result.removed, 1);
    assert.equal(result.kept, 2);
    assert.equal(ATTEMPT_DIR.test("../x"), false);
  } finally { b.done(); }
});

test("Disk D6: a run removes at most its bound, and the rest wait for the next run", () => {
  const b = box();
  try {
    for (let n = 1; n <= 5; n += 1) b.clone(id(n), 5 * DAY);
    const limits = { ...DISK_LIMITS, maxRemovals: 2 };
    const first = pruneRunClones(b.io, { root: b.root, stateDirs: [b.state], limits });
    assert.deepEqual([first.removed, first.left], [2, 3]);
    const second = pruneRunClones(b.io, { root: b.root, stateDirs: [b.state], limits });
    assert.deepEqual([second.removed, second.left], [2, 1]);
    // Past the time budget, no new removal starts.
    let t = NOW;
    const slow = { ...b.io, now: () => new Date((t += DISK_LIMITS.pruneBudgetMs)) };
    const third = pruneRunClones(slow, { root: b.root, stateDirs: [b.state] });
    assert.equal(third.removed, 0);
    assert.equal(third.left, 1);
  } finally { b.done(); }
});

test("Disk D7: a removal that fails is counted, and a missing root is reported, never thrown", () => {
  const b = box();
  try {
    const dir = b.clone(id(1), 5 * DAY);
    const failing = { ...b.io, exec: () => ({ status: 1, stdout: "", stderr: "busy" }) };
    const result = pruneRunClones(failing, { root: b.root, stateDirs: [b.state] });
    assert.deepEqual([result.removed, result.failed], [0, 1]);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(pruneRunClones(b.io, { root: path.join(b.base, "missing"), stateDirs: [b.state] }).skipped, "no worktree root");
    const throwing = { ...b.io, exec: () => { throw new Error("spawn failed"); } };
    assert.equal(pruneRunClones(throwing, { root: b.root, stateDirs: [b.state] }).failed, 1);
  } finally { b.done(); }
});

test("Disk D8: the journal is vacuumed to its cap, bounded, and a failure only shows on the report", () => {
  const calls = [];
  assert.deepEqual(capJournal({ exec: (file, args, options) => (calls.push([file, args, options]), { status: 0 }) }), { capped: true, max: "1G" });
  assert.deepEqual(calls, [["journalctl", ["--vacuum-size=1G"], { timeoutMs: DISK_LIMITS.commandTimeoutMs }]]);
  assert.deepEqual(capJournal({ exec: () => ({ status: 1 }) }), { capped: false, max: "1G" });
  assert.deepEqual(capJournal({ exec: () => { throw new Error("x"); } }), { capped: false, max: "1G" });
});

test("Disk D9: root's npm cache is dropped only once it is over its cap", () => {
  const b = box();
  try {
    const cache = path.join(b.base, "_cacache");
    fs.mkdirSync(cache);
    const limits = { ...DISK_LIMITS, npmCache: cache };
    const sized = (bytes) => ({ ...b.io, exec: (file, args, options) => (file === "du" ? { status: 0, stdout: `${bytes}\t${cache}\n` } : b.io.exec(file, args, options)) });
    assert.deepEqual(capNpmCache(sized(DISK_LIMITS.npmCacheMaxBytes), limits), { dropped: false, bytes: DISK_LIMITS.npmCacheMaxBytes });
    assert.equal(fs.existsSync(cache), true);
    assert.deepEqual(capNpmCache(sized(DISK_LIMITS.npmCacheMaxBytes + 1), limits), { dropped: true, bytes: DISK_LIMITS.npmCacheMaxBytes + 1 });
    assert.equal(fs.existsSync(cache), false);
    assert.deepEqual(capNpmCache(b.io, limits), { dropped: false, bytes: null }, "no cache, nothing to do");
  } finally { b.done(); }
});

test("Disk D10: the run report carries one disk upkeep line", () => {
  const b = box();
  try {
    b.clone(id(1), 5 * DAY);
    b.clone(id(2), HOUR);
    const disk = diskUpkeep(b.io, { root: b.root, stateDirs: [b.state], limits: { ...DISK_LIMITS, npmCache: path.join(b.base, "none") } });
    assert.equal(disk.clones.removed, 1);
    assert.match(diskLine(disk), /^Disk upkeep: removed 1 old run clone(?: \([\d.]+ GB freed\))?; kept 1 recent\.$/);
  } finally { b.done(); }
  assert.equal(diskLine({ clones: { removed: 3, kept: 0, left: 4, failed: 1, freed_bytes: 3 * 1024 ** 3 }, journal: { capped: false, max: "1G" }, npm_cache: { dropped: true, bytes: 2 * 1024 ** 3 } }),
    "Disk upkeep: removed 3 old run clones (3.0 GB freed); kept 0 recent; 4 more wait for the next run; 1 could not be removed; the journal cap of 1G did not apply; dropped root's npm cache (2.0 GB).");
  assert.equal(diskLine({ clones: { error: "EIO" } }), "Disk upkeep: the run clone cleanup failed (EIO).");
  assert.equal(diskLine({ clones: { skipped: "no worktree root" }, journal: { capped: false, max: "1G" } }),
    "Disk upkeep: no run clones were looked at (no worktree root); the journal cap of 1G did not apply.", "the journal result shows whatever the clones did");
  assert.equal(diskLine(undefined), null);
  const report = renderRunReport({ card: "SHU-5", kind: "card", outcome: "PASS", ok: true, ticks: [], revert: { reverted: true },
    disk: { clones: { removed: 2, kept: 1, left: 0, failed: 0, freed_bytes: null }, journal: { capped: true, max: "1G" }, npm_cache: { dropped: false } } });
  assert.match(report, /\nDisk upkeep: removed 2 old run clones; kept 1 recent\.\n/);
});

test("Disk D11: every worker's workspace state folder is read for locks and records", () => {
  const dirs = workspaceStateDirs();
  assert.equal(dirs[0], "/srv/shu/state/workspaces");
  assert.equal(dirs[1], "/srv/shu/state/workspaces/w2");
  assert.ok(dirs.length >= 2);
});
