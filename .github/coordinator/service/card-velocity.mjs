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
// the hand landing came after the box stopped. Unreadable files are skipped,
// and a velocity that cannot be read never changes a run's result.
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
  const unattended = new Map();
  const hand = new Map();
  const cycles = new Map();
  for (const file of io.fs.readdirSync(stateDir)) {
    const match = AUTO_RE.exec(file) ?? REPAIR_RE.exec(file) ?? HAND_RE.exec(file);
    if (!match) continue;
    let record;
    try { record = JSON.parse(io.fs.readFileSync(path.join(stateDir, file), "utf8")); } catch { continue; }
    if (record?.card !== undefined && record.card !== match[1]) continue;
    const id = match[1];
    if (HAND_RE.test(file)) {
      const at = time(record?.recorded_at);
      if (at !== null) hand.set(id, at);
    } else if (AUTO_RE.test(file)) {
      if (record?.land !== "MERGED") continue;
      const claimed = time(record.claimed_at);
      const at = time(record.landed_at) ?? time(record.finished_at);
      if (at === null) continue;
      unattended.set(id, Math.max(at, unattended.get(id) ?? at));
      const landed = time(record.landed_at);
      if (claimed !== null && landed !== null && landed >= claimed) cycles.set(id, landed - claimed);
    } else if (record?.land === "MERGED") {
      const at = time(record.finished_at);
      if (at !== null) unattended.set(id, Math.max(at, unattended.get(id) ?? at));
    }
  }
  if (current?.landed === true && /^SHU-[1-9]\d*$/.test(current.card ?? "")) {
    unattended.set(current.card, nowMs);
    const claimed = time(current.claimed_at);
    if (claimed !== null && claimed <= nowMs) cycles.set(current.card, nowMs - claimed);
  }
  for (const id of hand.keys()) { unattended.delete(id); cycles.delete(id); }
  const within = (map, ms) => [...map.values()].filter((at) => at <= nowMs && nowMs - at < ms).length;
  const week = { unattended: within(unattended, 7 * DAY_MS), hand: within(hand, 7 * DAY_MS) };
  const weekCycles = [...cycles.entries()].filter(([id]) => nowMs - unattended.get(id) < 7 * DAY_MS).map(([, ms]) => ms);
  return {
    day: { unattended: within(unattended, DAY_MS), hand: within(hand, DAY_MS) },
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
