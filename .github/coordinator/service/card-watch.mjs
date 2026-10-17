// Self-watch 0b, observe mode (SHU-86). A card run watches its own progress
// and records what it saw; it never stops a run. The progress comes from the
// watch line each coordinator tick prints from the receipts it already read
// (../watch-progress.mjs), so watching makes no Linear request of its own and
// cannot spend the budget the next tick needs.
//
// What it records, for setting the limits later from real runs:
// - first_dispatch_at: the first launch (or reservation) of this activation;
// - last_progress_at: the newest heartbeat, activity or terminal time seen;
// - max_progress_gap_ms: the longest stretch with no new progress, counting
//   from arming and including the stretch still open when the run ends;
// - would_stall: the first moment a configured limit would have stopped the
//   run (null while no limit is configured, which is how this ships).
// A tick that reports no progress for this run is a failed read and never
// ends the run.
export { receiptProgress, parseWatchLine } from "../watch-progress.mjs";

// The configured limits, in minutes. Absent or invalid means not configured.
function limitMs(value) {
  return Number.isInteger(value) && value > 0 ? value * 60 * 1000 : null;
}

export function createWatch({ armedAt, limits = {} }) {
  const firstDispatchLimit = limitMs(limits?.first_dispatch_minutes);
  const stallLimit = limitMs(limits?.stall_minutes);
  let firstDispatchAt = null;
  let point = armedAt;
  let lastProgressAt = null;
  let maxGap = 0;
  let wouldStall = null;
  let reads = 0;
  let failures = 0;
  return {
    observe(now, progress) {
      if (progress === null) failures += 1;
      else reads += 1;
      if (progress?.firstDispatch != null && firstDispatchAt === null) firstDispatchAt = progress.firstDispatch;
      if (progress?.latest != null && progress.latest > point) {
        maxGap = Math.max(maxGap, progress.latest - point);
        point = progress.latest;
        lastProgressAt = progress.latest;
      }
      if (wouldStall === null) {
        if (firstDispatchAt === null && firstDispatchLimit !== null && now - armedAt > firstDispatchLimit) {
          wouldStall = { kind: "no_first_dispatch", at: new Date(now).toISOString(), minutes: limits.first_dispatch_minutes };
        } else if (firstDispatchAt !== null && stallLimit !== null && now - point > stallLimit) {
          wouldStall = { kind: "no_progress", at: new Date(now).toISOString(), minutes: limits.stall_minutes };
        }
      }
    },
    summary(finishedAt) {
      const open = finishedAt === null ? 0 : Math.max(0, finishedAt - point);
      return {
        mode: "observe",
        first_dispatch_at: firstDispatchAt === null ? null : new Date(firstDispatchAt).toISOString(),
        last_progress_at: lastProgressAt === null ? null : new Date(lastProgressAt).toISOString(),
        max_progress_gap_ms: Math.max(maxGap, open),
        would_stall: wouldStall,
        receipt_reads: reads,
        receipt_read_failures: failures,
      };
    },
  };
}

// The report's one line about the watch.
export function watchLine(watch) {
  const minutes = (ms) => `${Math.round(ms / 60000)} min`;
  const parts = [
    watch.first_dispatch_at ? `first dispatch ${watch.first_dispatch_at}` : "no dispatch seen",
    `longest stretch without progress ${minutes(watch.max_progress_gap_ms)}`,
    watch.would_stall ? `a ${watch.would_stall.minutes}-minute ${watch.would_stall.kind} limit would have stopped it at ${watch.would_stall.at}` : "no limit set",
  ];
  if (watch.receipt_read_failures) parts.push(`${watch.receipt_read_failures} receipt read(s) failed`);
  return `Watch (observe only): ${parts.join("; ")}.`;
}
