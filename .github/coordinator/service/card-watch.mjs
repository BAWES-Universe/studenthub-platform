// Self-watch 0b, observe mode (SHU-86). A card run watches its own progress
// and records what it saw; it never stops a run. The run's progress is the
// card's own dispatch receipts for this activation: a worker's receipt moves
// its heartbeat about once a minute while it works, so a long but healthy
// build keeps moving, and a run that sits armed with nothing dispatched (as
// SHU-323 did for six hours) does not.
//
// What it records, for setting the limits later from real runs:
// - first_dispatch_at: the first launch (or reservation) of this activation;
// - last_progress_at: the newest heartbeat, activity or terminal time seen;
// - max_progress_gap_ms: the longest stretch with no new progress, counting
//   from arming and including the stretch still open when the run ends;
// - would_stall: the first moment a configured limit would have stopped the
//   run (null while no limit is configured, which is how this ships).
// A read that fails or times out is no progress and never ends the run.
import { sendLinear, parseReceiptsFromComments } from "../reconcile.mjs";
import { boundedFetch } from "./card-land.mjs";

// Linear answers newest first and a receipt comment is edited in place, so a
// run's first dispatch can sit on an older page: every page is read (as
// fetchIssueComments does), up to a cap that keeps the read bounded.
export const CARD_WATCH_RECEIPTS_QUERY = `
  query CardRunWatchReceipts($issueId: String!, $after: String) {
    issue(id: $issueId) {
      comments(first: 100, orderBy: createdAt, after: $after) {
        nodes { body createdAt user { id displayName } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
export const CARD_WATCH_MAX_PAGES = 20;

const time = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// The progress this activation's receipts show: when it first dispatched and
// the newest moment any of its receipts moved. Other runs' receipts on the
// same card never count.
export function receiptProgress(receipts, { card, activationId }) {
  let firstDispatch = null;
  let latest = null;
  for (const receipt of receipts ?? []) {
    if (receipt?.issue_id !== card || receipt?.episode_id !== activationId) continue;
    const stamps = receipt.timestamps ?? {};
    const start = time(stamps.launch) ?? time(stamps.reserved);
    if (start !== null && (firstDispatch === null || start < firstDispatch)) firstDispatch = start;
    for (const value of [stamps.reserved, stamps.launch, stamps.heartbeat, stamps.terminal, receipt.last_activity]) {
      const at = time(value);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
  }
  return { firstDispatch, latest };
}

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

// One bounded read of the card's receipts, every page of them. Any failure,
// a bad cursor, more than CARD_WATCH_MAX_PAGES pages or a read still paging
// after timeoutMs answers null.
export async function readProgress({ io, credentials, config, card, activationId, timeoutMs }) {
  const token = credentials?.LINEAR_API_TOKEN;
  const actors = config?.linear_receipt_actor_ids;
  if (!token || !Array.isArray(actors) || actors.length === 0) return null;
  try {
    const fetchImpl = boundedFetch(io, timeoutMs, { attempts: 1, waitMs: 0 });
    const nodes = [];
    const seen = new Set();
    const started = io.now().getTime();
    let after = null;
    for (let pages = 0; ; pages += 1) {
      if (pages === CARD_WATCH_MAX_PAGES) return null;
      // The whole read, not just each page, stays inside one request's limit.
      if (pages > 0 && io.now().getTime() - started >= timeoutMs) return null;
      const data = await sendLinear(CARD_WATCH_RECEIPTS_QUERY, { issueId: card, after }, token, fetchImpl);
      const page = data?.issue?.comments;
      if (!Array.isArray(page?.nodes)) return null;
      nodes.push(...page.nodes);
      if (page.pageInfo?.hasNextPage !== true) break;
      after = page.pageInfo.endCursor;
      if (typeof after !== "string" || after.length === 0 || seen.has(after)) return null;
      seen.add(after);
    }
    return receiptProgress(parseReceiptsFromComments(nodes, actors), { card, activationId });
  } catch {
    return null;
  }
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
