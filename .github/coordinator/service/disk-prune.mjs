// Disk upkeep after every card run (Khalid, 2026-11-03: the box hit 87% disk;
// /srv/shu/worktrees held 38 GB in 509 run clones nothing ever removed, and
// the journal had grown to 1.9 GB).
//
// Every worker attempt gets a full checkout at <worktree root>/<attempt id>
// (attempt-workspace.mjs prepareAttemptWorkspace) and its record at
// <workspace state dir>/<attempt id>.workspace.json. The attempt is over once
// its run is: the next run makes new attempts, and a run never resumes an
// attempt of an earlier run. So after its own revert, a card run removes the
// run clones that are old enough that no run can still be using them:
//
// - only directories named exactly like an attempt id (a uuid); every other
//   name (the hand-made build-* and review-pr* worktrees busyReasons counts,
//   anything a person made) is left alone;
// - never one whose preparation lock is held, in any worker's state directory;
// - never one changed within CLONE_AGE_MS (two days; a run, worker grace and
//   landing together are bounded to well under seven hours), measured as the
//   newest change time of the directory, its git directory, index, HEAD and
//   HEAD log, and its workspace record;
// - an attempt whose preparation never finished (its record is not "ready")
//   is kept as evidence for PREPARING_AGE_MS (seven days) instead;
// - never a link or a directory on another file system, and removal never
//   leaves the worktree root's file system (rm --one-file-system);
// - at most MAX_REMOVALS per run, and no new removal starts after
//   PRUNE_BUDGET_MS, so a backlog never holds the host for long.
//
// Workspace records and the diag folder are never touched: they are small and
// they are evidence.
//
// Two limits go with it: the journal is vacuumed to JOURNAL_MAX (journalctl
// --vacuum-size; a run reads only its own recent ticks), and root's npm cache
// is dropped once it is over NPM_CACHE_MAX_BYTES (npm rebuilds it).
//
// Everything here is best effort: a failure is counted for the report and
// never changes the run's result.
import path from "node:path";
import { MAX_CARD_WORKERS } from "./credential-delivery.mjs";
import { workerWorkspaceStateDir } from "./units.mjs";

export const DISK_LIMITS = Object.freeze({
  cloneAgeMs: 2 * 24 * 60 * 60 * 1000,
  preparingAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxRemovals: 100,
  pruneBudgetMs: 10 * 60 * 1000,
  commandTimeoutMs: 2 * 60 * 1000,
  journalMax: "1G",
  npmCache: "/root/.npm/_cacache",
  npmCacheMaxBytes: 1024 ** 3,
});

export const ATTEMPT_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const workspaceStateDirs = () => Array.from({ length: MAX_CARD_WORKERS }, (_, i) => workerWorkspaceStateDir(i + 1));

function lstat(io, file) {
  try { return io.fs.lstatSync(file); } catch { return null; }
}

// The newest change of the clone and its record, or null when the clone itself
// cannot be read.
function lastChanged(io, dir, record) {
  const own = lstat(io, dir);
  if (!own) return null;
  let newest = own.mtimeMs;
  for (const file of [".git", ".git/index", ".git/HEAD", ".git/logs/HEAD"]) {
    const st = lstat(io, path.join(dir, file));
    if (st && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  if (record && record.mtimeMs > newest) newest = record.mtimeMs;
  return newest;
}

// The attempt's preparation lock and record, from whichever worker's state
// directory holds them.
function attemptState(io, stateDirs, id) {
  let locked = false;
  let record = null;
  let ready = false;
  for (const dir of stateDirs) {
    if (lstat(io, path.join(dir, `${id}.workspace.lock`))) locked = true;
    const file = path.join(dir, `${id}.workspace.json`);
    const st = lstat(io, file);
    if (!st) continue;
    record = st;
    try { ready = JSON.parse(String(io.fs.readFileSync(file, "utf8"))).status === "ready"; } catch { ready = false; }
  }
  return { locked, record, ready };
}

function freeBytes(io, dir) {
  try { const disk = io.fs.statfsSync(dir); return disk.bavail * disk.bsize; } catch { return null; }
}

export function pruneRunClones(io, { root, stateDirs = workspaceStateDirs(), limits = DISK_LIMITS } = {}) {
  const result = { removed: 0, failed: 0, kept: 0, other: 0, left: 0, freed_bytes: null };
  const rootStat = lstat(io, root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return { ...result, skipped: "no worktree root" };
  const before = freeBytes(io, root);
  const started = io.now().getTime();
  let names;
  try { names = io.fs.readdirSync(root).sort(); } catch { return { ...result, skipped: "worktree root unreadable" }; }
  for (const name of names) {
    if (!ATTEMPT_DIR.test(name)) { result.other += 1; continue; }
    const dir = path.join(root, name);
    const st = lstat(io, dir);
    const keep = () => { result.kept += 1; };
    if (!st?.isDirectory() || st.isSymbolicLink() || st.dev !== rootStat.dev) { keep(); continue; }
    const { locked, record, ready } = attemptState(io, stateDirs, name);
    if (locked) { keep(); continue; }
    const changed = lastChanged(io, dir, record);
    const age = record && !ready ? limits.preparingAgeMs : limits.cloneAgeMs;
    const now = io.now().getTime();
    if (changed === null || now - changed < age) { keep(); continue; }
    if (result.removed + result.failed >= limits.maxRemovals || now - started >= limits.pruneBudgetMs) { result.left += 1; continue; }
    let status;
    try { status = io.exec("rm", ["-rf", "--one-file-system", "--", dir], { timeoutMs: limits.pruneBudgetMs }).status; } catch { status = null; }
    if (status === 0 && !lstat(io, dir)) result.removed += 1;
    else result.failed += 1;
  }
  const after = freeBytes(io, root);
  if (before !== null && after !== null) result.freed_bytes = Math.max(0, after - before);
  return result;
}

// journalctl --vacuum-size keeps the newest entries; a run reads only the
// ticks of its own window.
export function capJournal(io, limits = DISK_LIMITS) {
  try {
    const run = io.exec("journalctl", [`--vacuum-size=${limits.journalMax}`], { timeoutMs: limits.commandTimeoutMs });
    return { capped: run.status === 0, max: limits.journalMax };
  } catch { return { capped: false, max: limits.journalMax }; }
}

// Root's npm cache is a cache: dropped whole once it is over the limit.
export function capNpmCache(io, limits = DISK_LIMITS) {
  const dir = limits.npmCache;
  const st = lstat(io, dir);
  if (!st?.isDirectory() || st.isSymbolicLink()) return { dropped: false, bytes: null };
  let bytes = null;
  try {
    const du = io.exec("du", ["-sb", "--one-file-system", dir], { timeoutMs: limits.commandTimeoutMs });
    if (du.status === 0) bytes = Number(String(du.stdout).split(/\s/)[0]);
  } catch { /* unknown size: kept */ }
  if (!Number.isFinite(bytes) || bytes <= limits.npmCacheMaxBytes) return { dropped: false, bytes: Number.isFinite(bytes) ? bytes : null };
  try {
    const rm = io.exec("rm", ["-rf", "--one-file-system", "--", dir], { timeoutMs: limits.commandTimeoutMs });
    return { dropped: rm.status === 0, bytes };
  } catch { return { dropped: false, bytes }; }
}

export function diskUpkeep(io, { root, stateDirs, limits = DISK_LIMITS } = {}) {
  let clones;
  try { clones = pruneRunClones(io, { root, stateDirs, limits }); } catch (error) { clones = { error: error.code ?? "PRUNE_FAILED" }; }
  return { clones, journal: capJournal(io, limits), npm_cache: capNpmCache(io, limits) };
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

// One line on the run report.
export function diskLine(disk) {
  if (!disk?.clones) return null;
  const c = disk.clones;
  if (c.error) return `Disk upkeep: the run clone cleanup failed (${c.error}).`;
  if (c.skipped) return `Disk upkeep: no run clones were looked at (${c.skipped}).`;
  const parts = [`removed ${c.removed} old run clone${c.removed === 1 ? "" : "s"}${c.freed_bytes ? ` (${gb(c.freed_bytes)} freed)` : ""}`,
    `kept ${c.kept} recent`];
  if (c.left) parts.push(`${c.left} more wait for the next run`);
  if (c.failed) parts.push(`${c.failed} could not be removed`);
  if (disk.journal && !disk.journal.capped) parts.push(`the journal cap of ${disk.journal.max} did not apply`);
  if (disk.npm_cache?.dropped) parts.push(`dropped root's npm cache (${gb(disk.npm_cache.bytes)})`);
  return `Disk upkeep: ${parts.join("; ")}.`;
}
