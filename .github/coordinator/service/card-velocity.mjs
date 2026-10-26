// Velocity, as the box's own state records it: how many cards landed with no
// person involved, how many a person had to land, and how long a landed card
// took from its timer claim to its merge. Every card-run report carries it, so
// the owner reads the trend without a side system (Khalid, 2026-10-25: measure
// unattended work completed per day).
//
// Read only, from the root-owned state directory:
// - card-run-auto-<rev>-<id>.json: a timer run's final claim. land "MERGED"
//   is an unattended landing; landed_at (written since this change) times it.
//   An older claim without landed_at is timed by finished_at, the run's end,
//   which comes before its merge by at most the landing bound; it gives no
//   cycle time.
// - card-repair-<rev>-<id>.json: a landing repair round that merged is also an
//   unattended landing, at its finished_at.
// - card-hand-landed-<id>.json: a landing a person did, at its recorded_at.
// A card counts once: by hand wins over unattended for the same card, since
// the hand landing came after the box stopped. A card landed more than once
// (the same card under two revisions) counts by its newest landing, with that
// landing's own cycle. Only regular files are read: a symbolic link or
// anything else under a matching name is skipped, as an unreadable file is,
// so nothing outside the state directory is counted. A velocity that cannot be
// read never changes a run's result.
import path from "node:path";

const AUTO_RE = /^card-run-auto-[0-9a-f]{40}-(SHU-[1-9]\d*)\.json$/;
const REPAIR_RE = /^card-repair-[0-9a-f]{40}-(SHU-[1-9]\d*)\.json$/;
const HAND_RE = /^card-hand-landed-(SHU-[1-9]\d*)\.json$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const time = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// `current` is the run being reported, whose final claim is not written yet:
// { card, landed: true, claimed_at } counts it as landed now.
export function readVelocity(io, stateDir, { now = io.now(), current = null } = {}) {
  const nowMs = now.getTime();
  // Each card's newest unattended landing, { at, cycle }, the cycle null when
  // that landing gives none.
  const unattended = new Map();
  const hand = new Map();
  const land = (id, at, cycle) => {
    const seen = unattended.get(id);
    // A tie keeps the landing with a cycle, the shorter if both have one, so
    // the answer never depends on the order readdir lists the files in.
    const better = !seen || at > seen.at
      || (at === seen.at && cycle !== null && (seen.cycle === null || cycle < seen.cycle));
    if (better) unattended.set(id, { at, cycle });
  };
  for (const file of io.fs.readdirSync(stateDir)) {
    const match = AUTO_RE.exec(file) ?? REPAIR_RE.exec(file) ?? HAND_RE.exec(file);
    if (!match) continue;
    const full = path.join(stateDir, file);
    let record;
    try {
      const stat = io.fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      record = JSON.parse(io.fs.readFileSync(full, "utf8"));
    } catch { continue; }
    if (record?.card !== undefined && record.card !== match[1]) continue;
    const id = match[1];
    if (HAND_RE.test(file)) {
      const at = time(record?.recorded_at);
      if (at !== null) hand.set(id, at);
    } else if (AUTO_RE.test(file)) {
      if (record?.land !== "MERGED") continue;
      const claimed = time(record.claimed_at);
      const landed = time(record.landed_at);
      const at = landed ?? time(record.finished_at);
      if (at === null) continue;
      land(id, at, claimed !== null && landed !== null && landed >= claimed ? landed - claimed : null);
    } else if (record?.land === "MERGED") {
      const at = time(record.finished_at);
      if (at !== null) land(id, at, null);
    }
  }
  if (current?.landed === true && /^SHU-[1-9]\d*$/.test(current.card ?? "")) {
    const claimed = time(current.claimed_at);
    unattended.set(current.card, { at: nowMs, cycle: claimed !== null && claimed <= nowMs ? nowMs - claimed : null });
  }
  for (const id of hand.keys()) unattended.delete(id);
  const inWindow = (at, ms) => at <= nowMs && nowMs - at < ms;
  const within = (times, ms) => times.filter((at) => inWindow(at, ms)).length;
  const landings = [...unattended.values()];
  const unattendedAt = landings.map((entry) => entry.at);
  const handAt = [...hand.values()];
  const week = { unattended: within(unattendedAt, 7 * DAY_MS), hand: within(handAt, 7 * DAY_MS) };
  const weekCycles = landings.filter((entry) => entry.cycle !== null && inWindow(entry.at, 7 * DAY_MS)).map((entry) => entry.cycle);
  return {
    day: { unattended: within(unattendedAt, DAY_MS), hand: within(handAt, DAY_MS) },
    week,
    median_cycle_ms: weekCycles.length ? median(weekCycles) : null,
    cycles: weekCycles.length,
  };
}

export function velocityLine(velocity) {
  const { day, week } = velocity;
  const total = week.unattended + week.hand;
  const share = total ? `, ${Math.round((100 * week.unattended) / total)}% unattended` : "";
  const cycle = velocity.median_cycle_ms === null ? ""
    : ` Median ${Math.round(velocity.median_cycle_ms / 60000)} min from claim to merge (${velocity.cycles} card${velocity.cycles === 1 ? "" : "s"}).`;
  return `Velocity: ${day.unattended} card(s) landed unattended and ${day.hand} by hand in the last 24 hours; `
    + `${week.unattended} and ${week.hand} in the last 7 days${share}.${cycle}`;
}
