// Self-watch 0e, first part (SHU-86): a card run says where it is and flags
// the runs that need the owner, without one request of its own.
//
// The status file: the run rewrites /srv/shu/state/card-run-status.json at
// arming, after every tick, before the revert, before landing and when it
// finishes. It holds the queue, the card, the step, the tick count, the
// watch's first dispatch and newest progress, the outcome once there is one,
// whether the pause file is present and when the timer next starts. It is
// written by rename, so a reader never sees half of it, and a failed write
// never changes the run. The outside watch (0d) reads it, and posts the SHU-71
// status comment from it, outside the run: a run itself never spends the
// Linear budget its next tick needs on telling anyone how it is doing.
//
// The alert: a run that ended in ERROR, STALLED or QUOTA_EXHAUSTED, whose
// revert did not finish, or whose landing was anything but MERGED, needs the
// owner. Its report, already posted
// once after the revert, opens with one "Alert:" line, and names the owner
// when config.owner_mention holds a Linear profile link. That link must belong
// to someone other than the coordinator's own Linear user: Linear does not
// notify a user of a mention they wrote themselves.
import path from "node:path";

export const STATUS_FILE = "card-run-status.json";
export const statusPath = (paths) => path.join(paths.stateDir, STATUS_FILE);

export const ALERT_OUTCOMES = Object.freeze(new Set(["ERROR", "STALLED", "QUOTA_EXHAUSTED"]));
// Self-repair B2: a landing repair that never finished is a stop for the owner.
export const REPAIR_ALERT_OUTCOMES = Object.freeze(new Set(["REPAIR_INTERRUPTED"]));

// Whether a finished run needs the owner.
export function needsOwner(result) {
  if (ALERT_OUTCOMES.has(result?.outcome)) return true;
  if (REPAIR_ALERT_OUTCOMES.has(result?.outcome)) return true;
  // A revert that did not finish may leave the host armed, whatever the outcome.
  if (result?.revert?.reverted === false) return true;
  return result?.land != null && result.land.outcome !== "MERGED";
}

// A Linear profile link, the form Linear renders as a mention; anything else
// is no mention at all.
export function ownerMention(value) {
  return typeof value === "string" && /^https:\/\/linear\.app\/[a-z0-9-]+\/profiles\/[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

export function alertLine(result) {
  if (!needsOwner(result)) return null;
  const mention = ownerMention(result.owner_mention);
  return `Alert: this run needs the owner${mention ? ` (${mention})` : ""}.`;
}

// The card-run timer starts every five minutes on the clock (AUTO_SCHEDULE),
// so the next card begins within minutes of the last one ending.
export function nextStart(now) {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.floor(next.getUTCMinutes() / 5) * 5 + 5);
  return next.toISOString();
}

// One status writer per run. Every write is the whole status, so the file is
// always one consistent moment of the run.
export function createStatus({ io, paths, run }) {
  const file = statusPath(paths);
  let failures = 0;
  return {
    write(fields) {
      const temporary = `${file}.tmp`;
      try {
        const now = io.now();
        const status = {
          version: 1, ...run, ...fields,
          paused: io.fs.existsSync(paths.pause),
          next_start: nextStart(now),
          updated_at: now.toISOString(),
        };
        io.fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
        io.fs.renameSync(temporary, file);
        return true;
      } catch {
        failures += 1;
        return false;
      }
    },
    failures: () => failures,
  };
}
