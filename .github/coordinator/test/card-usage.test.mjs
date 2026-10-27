// M15 step 1: the cost and capacity lines on every card-run report.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCodexUsage, parseClaudeUsage, withUsage } from "../adapters/usage.mjs";
import { readRunUsage, usageLine, hostSnapshot, hostLine } from "../service/card-usage.mjs";
import { busyShare, busyLine, readVelocity, velocityLine } from "../service/card-velocity.mjs";
import { renderRunReport } from "../service/card-prepare.mjs";

test("Usage U1: the Codex and Claude CLI outputs give token counts, and anything else gives none", () => {
  const codex = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
    "not json turn.completed",
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: -1, output_tokens: 70 } }),
    JSON.stringify({ type: "item.completed", usage: { input_tokens: 9999 } }),
  ].join("\n");
  assert.deepEqual(parseCodexUsage(codex), { family: "codex", input_tokens: 3000, cached_input_tokens: 400, output_tokens: 120, cost_usd: null, turns: 2 });
  assert.equal(parseCodexUsage("{\"type\":\"thread.started\"}"), null, "no completed turn, no usage");
  assert.equal(parseCodexUsage(undefined), null);
  const claude = JSON.stringify({ type: "result", num_turns: 7, total_cost_usd: 1.25,
    usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 5000, output_tokens: 300 } });
  assert.deepEqual(parseClaudeUsage(claude), { family: "claude", input_tokens: 5100, cached_input_tokens: 5000, output_tokens: 300, cost_usd: 1.25, turns: 7 });
  assert.equal(parseClaudeUsage(JSON.stringify({ usage: { input_tokens: 1 }, total_cost_usd: "x" })).cost_usd, null);
  assert.equal(parseClaudeUsage("{not json"), null);
  assert.equal(parseClaudeUsage(JSON.stringify({ type: "result" })), null);
  const result = { stage: "COMPLETED", ok: true };
  assert.equal(withUsage(result, null), result, "no usage leaves the result as it was");
  assert.deepEqual(withUsage(result, { family: "codex" }), { stage: "COMPLETED", ok: true, usage: { family: "codex" } });
});

const A = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000.json`;
// A real supervisor state folder in a temporary directory: entries of
// [name, order, completion, kind], where kind "link" stores both records outside
// the folder and puts links to them in it.
function supervisorDir(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-usage-"));
  const dir = path.join(root, "supervisor");
  const outside = path.join(root, "outside");
  for (const sub of ["completions", "orders"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.mkdirSync(path.join(outside, sub), { recursive: true });
  }
  for (const [name, order, completion, kind = "file"] of entries) {
    for (const [sub, value] of [["orders", { protocol: 2, order, digest: "d" }], ["completions", completion]]) {
      const target = path.join(kind === "link" ? outside : dir, sub, name);
      fs.writeFileSync(target, JSON.stringify(value));
      if (kind === "link") fs.symlinkSync(target, path.join(dir, sub, name));
    }
  }
  fs.writeFileSync(path.join(dir, "completions", "notes.txt"), "not a record");
  return { root, dir, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const at = (minute) => `2026-10-27T10:${String(minute).padStart(2, "0")}:00.000Z`;
const usage = (family, input, output, cost = null) => ({ family, input_tokens: input, cached_input_tokens: 10, output_tokens: output, cost_usd: cost, turns: 1 });

test("Usage U2: a run's usage is summed from the supervisor's records for its own card and window, by role and family", () => {
  const sup = supervisorDir([
    [A(1), { issue_id: "SHU-5", role: "build" }, { finished_at: at(10), result: { usage: usage("codex", 100, 20) } }],
    [A(2), { issue_id: "SHU-5", role: "revise" }, { finished_at: at(20), result: { usage: usage("codex", 300, 40) } }],
    [A(3), { issue_id: "SHU-5", role: "review" }, { finished_at: at(15), result: { usage: usage("claude", 50, 5, 0.5) } }],
    [A(4), { issue_id: "SHU-5", role: "review" }, { finished_at: at(25), result: { usage: usage("claude", 50, 5, 0.25) } }],
    [A(5), { issue_id: "SHU-6", role: "build" }, { finished_at: at(12), result: { usage: usage("codex", 999, 999) } }],
    [A(6), { issue_id: "SHU-5", role: "build" }, { finished_at: "2026-10-27T09:00:00.000Z", result: { usage: usage("codex", 999, 999) } }],
    [A(7), { issue_id: "SHU-5", role: "build" }, { finished_at: at(11), result: { stage: "COMPLETED" } }],
    [A(8), { issue_id: "SHU-5", role: "build" }, { finished_at: at(11), result: { usage: usage("codex", 999, 999) } }, "link"],
  ]);
  const io = { fs };
  try {
    const sums = readRunUsage(io, sup.dir, { issue: "SHU-5", from: at(0), to: at(30) });
    assert.deepEqual(sums, [
      { role: "build", family: "codex", runs: 2, input_tokens: 400, cached_input_tokens: 20, output_tokens: 60, cost_usd: null },
      { role: "review", family: "claude", runs: 2, input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, cost_usd: 0.75 },
    ], "another card, a run before the window, a result with no usage and a linked record are all left out");
    assert.equal(readRunUsage(io, sup.dir, { issue: "not-a-card", from: at(0), to: at(30) }), null);
    assert.equal(readRunUsage(io, sup.dir, { issue: "SHU-5", from: null, to: at(30) }), null);
    assert.equal(readRunUsage(io, "relative/dir", { issue: "SHU-5", from: at(0), to: at(30) }), null);
    assert.equal(usageLine(sums), "AI usage: 2 build runs (codex): 400 input (20 cached), 60 output; 2 review runs (claude): 100 input (20 cached), 10 output, $0.75.",
      "cached tokens are part of the input count, never added to it");
  } finally { sup.done(); }
  assert.equal(usageLine([{ role: "build", family: "codex", runs: 1, input_tokens: 2_400_000, cached_input_tokens: 0, output_tokens: 12_345, cost_usd: null }]),
    "AI usage: 1 build run (codex): 2.4M input, 12k output.");
  assert.equal(usageLine([]), null);
  assert.equal(usageLine(undefined), null);
});

test("Usage U6: a records folder that is a link, or a record swapped for a link after it is listed, is never read", () => {
  const record = [A(1), { issue_id: "SHU-5", role: "build" }, { finished_at: at(10), result: { usage: usage("codex", 1234, 56) } }];
  const window = { issue: "SHU-5", from: at(0), to: at(30) };
  for (const sub of ["completions", "orders"]) {
    const sup = supervisorDir([]);
    try {
      // The real records live outside; the supervisor's own folder is a link to them.
      fs.writeFileSync(path.join(sup.outside, "orders", record[0]), JSON.stringify({ protocol: 2, order: record[1], digest: "d" }));
      fs.writeFileSync(path.join(sup.outside, "completions", record[0]), JSON.stringify(record[2]));
      for (const other of ["completions", "orders"].filter((name) => name !== sub)) {
        fs.copyFileSync(path.join(sup.outside, other, record[0]), path.join(sup.dir, other, record[0]));
      }
      fs.rmSync(path.join(sup.dir, sub), { recursive: true });
      fs.symlinkSync(path.join(sup.outside, sub), path.join(sup.dir, sub));
      assert.equal(readRunUsage({ fs }, sup.dir, window), null, `a linked ${sub} folder is refused`);
    } finally { sup.done(); }
  }
  // A record that is a real file when the folder is listed and a link when it is opened.
  const sup = supervisorDir([record]);
  try {
    const outsideFile = path.join(sup.outside, "completions", record[0]);
    fs.writeFileSync(outsideFile, JSON.stringify(record[2]));
    const swapping = { ...fs, readdirSync(dir, ...rest) {
      const names = fs.readdirSync(dir, ...rest);
      if (names.includes(record[0]) && fs.realpathSync(dir) === fs.realpathSync(path.join(sup.dir, "completions"))) {
        fs.rmSync(path.join(sup.dir, "completions", record[0]));
        fs.symlinkSync(outsideFile, path.join(sup.dir, "completions", record[0]));
      }
      return names;
    } };
    assert.deepEqual(readRunUsage({ fs: swapping }, sup.dir, window), [], "the swapped name is opened without following the link and left out");
  } finally { sup.done(); }
});

test("Usage U3: the box line reads CPUs, load, memory and disk where the state lives", () => {
  const GB = 1024 ** 3;
  const io = {
    os: { cpus: () => [{}, {}, {}, {}], loadavg: () => [3, 2, 1.26], totalmem: () => 16 * GB, freemem: () => 9 * GB },
    fs: { statfsSync: (dir) => { assert.equal(dir, "/srv/shu/state"); return { blocks: 100, bavail: 40, bsize: GB }; } },
  };
  const host = hostSnapshot(io, "/srv/shu/state");
  assert.deepEqual(host, { cpus: 4, load_15m: 1.26, memory_total_bytes: 16 * GB, memory_free_bytes: 9 * GB, disk_total_bytes: 100 * GB, disk_free_bytes: 40 * GB });
  assert.equal(hostLine(host), "Box: 4 CPUs, load 1.3 over 15 min; memory 9 GB of 16 GB free; disk 40 GB of 100 GB free.");
  assert.equal(hostLine(null), null);
});

test("Usage U4: busy share counts overlapping card runs once, clipped to the window", () => {
  const H = 3600 * 1000;
  const now = 100 * H;
  assert.equal(busyShare([], now, 24 * H), 0);
  assert.equal(busyShare([[now - 2 * H, now - H], [now - 1.5 * H, now - 0.5 * H], [now - 30 * H, now - 23 * H]], now, 24 * H), 2.5 / 24,
    "1.5 hours from the overlapping pair, and the hour of the old run inside the window");
  assert.equal(busyShare([[now - 48 * H, now + H]], now, 24 * H), 1, "a run past both ends fills the window");
  assert.equal(busyLine({ busy_share: { day: 0.18, week: 0.123 } }), "Box busy with cards 18% of the last 24 hours and 12% of the last 7 days.");
  assert.equal(busyLine({}), null);
  const date = new Date(now);
  const ago = (hours) => new Date(now - hours * H).toISOString();
  const rev = "a".repeat(40);
  const files = new Map([
    [`card-run-auto-${rev}-SHU-1.json`, { card: "SHU-1", land: "MERGED", claimed_at: ago(6), landed_at: ago(5) }],
    [`card-run-auto-${rev}-SHU-2.json`, { card: "SHU-2", land: "CI_TIMEOUT", claimed_at: ago(4), finished_at: ago(3) }],
    [`card-run-auto-${rev}-SHU-3.json`, { card: "SHU-3", claimed_at: ago(2) }],
  ]);
  const io = { now: () => date, fs: {
    readdirSync: () => [...files.keys()],
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    readFileSync: (file) => JSON.stringify(files.get(path.basename(file))) } };
  const v = readVelocity(io, "/srv/shu/state", { current: { card: "SHU-4", landed: false, claimed_at: ago(1) } });
  assert.equal(v.busy_share.day, 3 / 24, "a landed run, a finished run and the current run; a claim with no end is left out");
  assert.doesNotMatch(velocityLine(v), /Box busy/, "the busy share has its own line");
});

test("Usage U5: a report prints the busy, usage and box lines after velocity, only when the run carries them", () => {
  const base = { card: "SHU-301", kind: "card", activation_id: "a", outcome: "PASS", ticks: [], revert: { reverted: true } };
  const bare = renderRunReport(base);
  assert.doesNotMatch(bare, /^(Box|AI usage)/m);
  const velocity = { day: { unattended: 1, hand: 0 }, week: { unattended: 1, hand: 0 }, median_cycle_ms: null, cycles: 0, busy_share: { day: 0.5, week: 0.25 } };
  const usage = [{ role: "build", family: "codex", runs: 1, input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10, cost_usd: null }];
  const host = { cpus: 2, load_15m: 0.5, memory_total_bytes: 4 * 1024 ** 3, memory_free_bytes: 1024 ** 3, disk_total_bytes: 50 * 1024 ** 3, disk_free_bytes: 10 * 1024 ** 3 };
  const lines = renderRunReport({ ...base, velocity, usage, host }).split("\n");
  const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
  assert.ok(at("Velocity:") >= 0 && at("Velocity:") < at("Box busy") && at("Box busy") < at("AI usage:") && at("AI usage:") < at("Box: 2 CPUs"), lines.join("\n"));
  assert.equal(lines.at(-1), "The host is reverted and idle.");
});
