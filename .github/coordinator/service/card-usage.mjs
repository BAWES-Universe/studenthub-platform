// M15 step 1 (Khalid, 2026-10-27: "i dont see velocity or box usage metrics"):
// what a card run spent and how full the box is, printed on every card-run
// report so the owner can scale up against measured headroom.
//
// - AI usage: the token counts (and, where the CLI prints one, the cost) each
//   worker run of this card recorded on its terminal result (adapters/usage.mjs),
//   read back from the supervisor's own completion records. Read only.
// - Box: CPUs, load, free memory and free disk where the state lives, read
//   from the kernel at report time.
// Both are best effort: anything that cannot be read is left out of the
// report and never changes a run's result.
import fs from "node:fs";
import os from "node:os";

const ATTEMPT_FILE = /^[0-9a-f-]{36}\.json$/i;
const time = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

// Nothing here follows a link. Each records directory is opened with no-follow
// and kept open, and every name in it is opened through that descriptor
// (/proc/self/fd), never by path again. A records directory or a record that is
// a link is never read, even if it is swapped for one after it is first seen.
const C = fs.constants;
const through = (dirFd, name) => `/proc/self/fd/${dirFd}${name ? `/${name}` : ""}`;

function openRecords(f, dir) {
  return f.openSync(dir, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
}

function readRecord(f, dirFd, name) {
  const fd = f.openSync(through(dirFd, name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    if (!f.fstatSync(fd).isFile()) return null;
    return JSON.parse(f.readFileSync(fd, "utf8"));
  } finally { f.closeSync(fd); }
}

// Every worker run of `issue` that finished inside [from, to], summed by its
// role (review, or a writer role) and model family.
export function readRunUsage(io, supervisorStateDir, { issue, from, to }) {
  const fromMs = time(from);
  const toMs = time(to);
  if (fromMs === null || toMs === null || !/^SHU-[1-9]\d*$/.test(issue ?? "")) return null;
  if (typeof supervisorStateDir !== "string" || !supervisorStateDir.startsWith("/")) return null;
  const f = io.fs;
  let completions = null;
  let orders = null;
  try {
    completions = openRecords(f, `${supervisorStateDir}/completions`);
    orders = openRecords(f, `${supervisorStateDir}/orders`);
    return sumUsage(f, completions, orders, { issue, fromMs, toMs });
  } catch {
    return null;
  } finally {
    if (completions !== null) f.closeSync(completions);
    if (orders !== null) f.closeSync(orders);
  }
}

function sumUsage(f, completions, orders, { issue, fromMs, toMs }) {
  const sums = new Map();
  for (const file of f.readdirSync(through(completions))) {
    if (!ATTEMPT_FILE.test(file)) continue;
    let completion;
    let order;
    try {
      completion = readRecord(f, completions, file);
      // The supervisor keeps each work order in its durable envelope,
      // { protocol, order, digest } (supervisor.mjs accept).
      order = readRecord(f, orders, file)?.order;
    } catch { continue; }
    if (!completion || !order || order.issue_id !== issue) continue;
    const finished = time(completion.finished_at);
    if (finished === null || finished < fromMs || finished > toMs) continue;
    const usage = completion.result?.usage;
    if (typeof usage !== "object" || usage === null || typeof usage.family !== "string") continue;
    const role = order.role === "review" ? "review" : "build";
    const key = `${role}:${usage.family}`;
    const sum = sums.get(key) ?? { role, family: usage.family, runs: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: null };
    sum.runs += 1;
    sum.input_tokens += count(usage.input_tokens);
    sum.cached_input_tokens += count(usage.cached_input_tokens);
    sum.output_tokens += count(usage.output_tokens);
    if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) sum.cost_usd = (sum.cost_usd ?? 0) + usage.cost_usd;
    sums.set(key, sum);
  }
  return [...sums.values()].sort((a, b) => (a.role === b.role ? a.family.localeCompare(b.family) : a.role === "build" ? -1 : 1));
}

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function usageLine(usage) {
  if (!Array.isArray(usage) || usage.length === 0) return null;
  const parts = usage.map((u) => {
    const what = `${u.runs} ${u.role === "review" ? "review" : "build"} run${u.runs === 1 ? "" : "s"} (${u.family})`;
    const cached = u.cached_input_tokens ? ` (${tokens(u.cached_input_tokens)} cached)` : "";
    const cost = u.cost_usd === null ? "" : `, $${u.cost_usd.toFixed(2)}`;
    return `${what}: ${tokens(u.input_tokens)} input${cached}, ${tokens(u.output_tokens)} output${cost}`;
  });
  return `AI usage: ${parts.join("; ")}.`;
}

export function hostSnapshot(io, stateDir) {
  const system = io.os ?? os;
  const disk = io.fs.statfsSync(stateDir);
  return {
    cpus: system.cpus().length,
    load_15m: system.loadavg()[2],
    memory_total_bytes: system.totalmem(),
    memory_free_bytes: system.freemem(),
    disk_total_bytes: disk.blocks * disk.bsize,
    disk_free_bytes: disk.bavail * disk.bsize,
  };
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(0)} GB`;

export function hostLine(host) {
  if (!host) return null;
  return `Box: ${host.cpus} CPUs, load ${host.load_15m.toFixed(1)} over 15 min; memory ${gb(host.memory_free_bytes)} of ${gb(host.memory_total_bytes)} free; `
    + `disk ${gb(host.disk_free_bytes)} of ${gb(host.disk_total_bytes)} free.`;
}
