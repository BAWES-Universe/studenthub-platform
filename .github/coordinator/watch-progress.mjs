// Self-watch 0b (SHU-86): the progress an armed card run has made, as the
// coordinator tick already sees it. The tick reads every card's receipts for
// its own decisions; it prints this one line from that same read, and the card
// run takes its progress from the tick's output. Watching therefore makes no
// request of its own and never spends the Linear budget a tick needs.
//
// The run's progress is the card's own dispatch receipts for this activation:
// a worker's receipt moves its heartbeat about once a minute while it works,
// so a long but healthy build keeps moving, and a run that sits armed with
// nothing dispatched (as SHU-323 did for six hours) does not.

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

const iso = (ms) => (ms === null ? "none" : new Date(ms).toISOString());

// The tick's watch line for an armed activation, or null when nothing is
// armed. A card whose thread the tick could not read says so: that is no
// progress, never an empty one.
export function renderWatchLine(activation, receipts, { unread = false } = {}) {
  if (activation?.state !== "armed" || !activation.target_issue_id || !activation.activation_id) return null;
  const head = `watch=${activation.target_issue_id} episode=${activation.activation_id}`;
  if (unread) return `${head} unread`;
  const progress = receiptProgress(receipts, { card: activation.target_issue_id, activationId: activation.activation_id });
  return `${head} first_dispatch=${iso(progress.firstDispatch)} latest=${iso(progress.latest)}`;
}

const WATCH_LINE = /^watch=(\S+) episode=(\S+) first_dispatch=(\S+) latest=(\S+)$/;

// The progress a tick's output reports for this run, or null when it reports
// none for this card and activation (no line, an unread thread, another
// activation's line, or anything malformed).
export function parseWatchLine(text, { card, activationId }) {
  for (const line of String(text ?? "").split("\n")) {
    const match = WATCH_LINE.exec(line);
    if (!match || match[1] !== card || match[2] !== activationId) continue;
    const read = (value) => (value === "none" ? null : time(value));
    const firstDispatch = read(match[3]);
    const latest = read(match[4]);
    if ((match[3] !== "none" && firstDispatch === null) || (match[4] !== "none" && latest === null)) return null;
    return { firstDispatch, latest };
  }
  return null;
}
