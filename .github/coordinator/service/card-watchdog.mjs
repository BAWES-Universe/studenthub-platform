// Self-watch 0d (SHU-86): the outside watch. A run cannot watch itself for a
// hang: systemd never starts a second instance of an active oneshot, so a step
// inside shu-card-run.service would never run while that run is stuck. This is
// its own timer and its own oneshot, every ten minutes, as root. It reads the
// status file each card run keeps (card-status.mjs, 0e) and the card-run
// unit's state, and does exactly two things:
//
// - It keeps one SHU-71 status comment current, edited in place only when what
//   it shows has changed. The run itself posts nothing for its status, so a
//   run never spends the Linear budget its next tick needs.
// - When a timer run looks stuck, it raises one alert for that run: the unit is
//   still running but the run's status has not been written for longer than
//   any healthy run goes without writing it, or the unit stopped while the
//   status never reached "finished". It then writes the card-run pause file,
//   so no new run starts, and posts one alert comment on SHU-71.
//
// - Self-heal: when a running card has shown no progress for STALL_ALERT_MS
//   (the run's own watch measure, written to its status), it posts one stall
//   comment on SHU-71 for that run. Observe only: it writes no pause file.
//
// It never stops, kills or reverts a run, never removes the pause file or the
// lock, and alerts at most once per run, recorded in its own state file. Every
// line it posts is built from validated status fields only, never from logs,
// reasons or the environment.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sendLinear } from "../reconcile.mjs";
import { readCoordinatorCredentials, postRunReport, plainReason, reportMarker, REPORT_ISSUE, REPORT_ISSUE_QUERY, RUN_OUTCOME_TEXT } from "./card-prepare.mjs";
import { CARD_RUN_PATHS, CARD_RUN_LIMITS, AUTO_SERVICE } from "./card-run.mjs";
import { statusPath, ownerMention, nextStart } from "./card-status.mjs";

export const WATCH_MODULE = fileURLToPath(import.meta.url);
export const WATCH_SERVICE = "shu-card-watch.service";
export const WATCH_TIMER = "shu-card-watch.timer";
// Five minutes past each card-run start, then every ten minutes.
export const WATCH_SCHEDULE = "*:05/10";
export const WATCH_STATE = "card-watch.json";
export const watchStatePath = (paths) => path.join(paths.stateDir, WATCH_STATE);

// Self-heal: a run armed this long with no new progress gets one stall comment.
export const STALL_ALERT_MS = 30 * 60 * 1000;

// The longest a healthy run goes without writing its status is one revert
// (waiting out its workers) or one landing (waiting for checks); each starts
// right after a status write. Half an hour more covers the report and the
// steps around them, so a run silent for longer is stuck.
export const WATCH_LIMITS = Object.freeze({
  stallMs: STALL_ALERT_MS,
  staleMs: Math.max(CARD_RUN_LIMITS.workerGraceMs, CARD_RUN_LIMITS.landWaitMs) + 30 * 60 * 1000,
  // A unit that is no longer running with a status that never reached
  // "finished" is a run that died; this long a wait keeps a run that is just
  // starting out of that reading.
  endedMs: 10 * 60 * 1000,
  requestTimeoutMs: 30 * 1000,
  // Alerts remembered, newest kept, so the state file stays small.
  keepAlerts: 50,
});

export const RUNNING_STATES = Object.freeze(new Set(["active", "activating", "deactivating", "reloading"]));
export const STATUS_STEPS = Object.freeze(new Set(["armed", "ticking", "reverting", "landing", "finished"]));
export const STATUS_MARKER = "<!-- card-run-status -->";

export function watchServiceUnit({ node, module }) {
  return [
    "[Unit]",
    "Description=StudentHub card-run watch: keep the SHU-71 status current and flag a stuck card run",
    "[Service]",
    "Type=oneshot",
    "User=root",
    `ExecStart=${node} ${module} check`,
    "TimeoutStartSec=5min",
    "",
  ].join("\n");
}
export function watchTimerUnit() {
  return [
    "[Unit]",
    "Description=Every ten minutes, read the card run's status and flag a stuck run",
    "[Timer]",
    `OnCalendar=${WATCH_SCHEDULE}`,
    `Unit=${WATCH_SERVICE}`,
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

function refuse(code, detail) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code });
}

const CARD_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const RUN_ID_RE = /^[a-z0-9][A-Za-z0-9-]{0,80}$/;
// systemd's id for one start of a unit (InvocationID, $INVOCATION_ID).
const INVOCATION_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const iso = (value) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// The status file, reduced to the fields the watch shows, each validated. A
// file that is missing or not a version 1 status reads as null.
export function readStatus(io, paths) {
  let raw;
  try { raw = JSON.parse(io.fs.readFileSync(statusPath(paths), "utf8")); } catch { return null; }
  if (raw?.version !== 1 || !RUN_ID_RE.test(raw.run_id ?? "") || !iso(raw.updated_at)) return null;
  const known = (value) => (typeof value === "string" && Object.hasOwn(RUN_OUTCOME_TEXT, value) ? value : null);
  return {
    run_id: raw.run_id,
    invocation: INVOCATION_RE.test(raw.invocation ?? "") ? raw.invocation : null,
    card: CARD_RE.test(raw.card ?? "") ? raw.card : null,
    kind: raw.kind === "card" || raw.kind === "review" || raw.kind === "install" ? raw.kind : null,
    trigger: raw.trigger === "timer" || raw.trigger === "operator" ? raw.trigger : null,
    revision: SHA_RE.test(raw.revision ?? "") ? raw.revision : null,
    queue: Array.isArray(raw.queue) ? raw.queue.filter((id) => CARD_RE.test(id ?? "")).slice(0, 10) : [],
    step: STATUS_STEPS.has(raw.step) ? raw.step : null,
    ticks: count(raw.ticks),
    last_tick_at: iso(raw.last_tick_at),
    armed_at: iso(raw.armed_at),
    watching: raw.watching === true,
    first_dispatch_at: iso(raw.first_dispatch_at),
    last_progress_at: iso(raw.last_progress_at),
    outcome: known(raw.outcome),
    land: known(raw.land),
    needs_owner: raw.needs_owner === true,
    updated_at: iso(raw.updated_at),
  };
}

// The card-run unit: whether it is running and since when. The start is read
// as systemd's monotonic microseconds, which every systemd prints the same
// way, and turned into wall time against this process's monotonic clock (the
// same CLOCK_MONOTONIC). The raw value names the start, so it never moves
// between passes. A failed unit keeps the start of the run that failed, so a
// run that died before its first status write is still named; an idle one
// has none. A read that fails is null, and the watch then raises no alert.
export function readUnit(io, now) {
  const result = io.exec("systemctl", ["show", "-p", "ActiveState", "-p", "InactiveExitTimestampMonotonic", "-p", "InvocationID", AUTO_SERVICE]);
  if (result.status !== 0) return null;
  const fields = Object.fromEntries(String(result.stdout).split("\n").map((line) => line.split("=")).filter((pair) => pair.length >= 2)
    .map(([key, ...rest]) => [key.trim(), rest.join("=").trim()]));
  if (!fields.ActiveState) return null;
  const running = RUNNING_STATES.has(fields.ActiveState);
  if (!running && fields.ActiveState !== "failed") return { state: fields.ActiveState, running, since: null, start: null, invocation: null };
  const exit = /^[1-9]\d{0,18}$/.test(fields.InactiveExitTimestampMonotonic ?? "") ? Number(fields.InactiveExitTimestampMonotonic) : null;
  const uptime = io.monotonicMs();
  if (exit === null || !Number.isFinite(uptime) || exit / 1000 > uptime) return null;
  return { state: fields.ActiveState, running, since: Math.floor((now - (uptime - exit / 1000)) / 1000) * 1000, start: String(exit),
    invocation: INVOCATION_RE.test(fields.InvocationID ?? "") ? fields.InvocationID : null };
}

// Whether a run needs the owner now, and which run. A unit that is still
// running is named by when it started, so a run that hangs before it writes a
// status is still caught; a run that ended without finishing is named by its
// run id. Both carry the unit's invocation id, which the run also writes in
// its status, so a run alerted stale before its first status write and ended
// later is still matched to its alert: one run is never alerted twice.
export function stuckRun({ unit, status, now, limits = WATCH_LIMITS }) {
  if (!unit) return null;
  // A failed unit whose run wrote no status since it started died before its
  // first write: its claim or lock may hold every later start.
  if (unit.state === "failed" && !(status && Date.parse(status.updated_at) >= unit.since)) {
    return { kind: "failed", key: `start-${unit.start}`, run_id: null, invocation: unit.invocation ?? null,
      since: new Date(unit.since).toISOString(), last: null, status: null };
  }
  if (unit.running) {
    const own = status && Date.parse(status.updated_at) >= unit.since;
    const last = own ? Date.parse(status.updated_at) : unit.since;
    if (now - last <= limits.staleMs) return null;
    return { kind: "stale", key: `start-${unit.start}`, run_id: own ? status.run_id : null,
      invocation: unit.invocation ?? null, since: new Date(unit.since).toISOString(),
      last: new Date(last).toISOString(), status: own ? status : null };
  }
  if (!status || status.trigger !== "timer" || status.step === null || status.step === "finished") return null;
  if (now - Date.parse(status.updated_at) <= limits.endedMs) return null;
  return { kind: "ended", key: status.run_id, run_id: status.run_id, invocation: status.invocation ?? null, since: null, last: status.updated_at, status };
}

// Self-heal: whether the running card has shown no progress for the stall
// limit. Progress is the run's own watch measure: the newest progress the
// watch saw, or arming when it saw none, exactly where the watch's longest
// stretch without progress counts from. Only this start's status, only while
// the run is armed and ticking, and only when the watch was on: a run without
// it has no progress to read.
export function stalledRun({ unit, status, now, limits = WATCH_LIMITS }) {
  if (!unit?.running || !status || Date.parse(status.updated_at) < unit.since) return null;
  if (status.watching !== true || (status.step !== "armed" && status.step !== "ticking") || !status.armed_at) return null;
  const point = Math.max(Date.parse(status.armed_at), status.last_progress_at ? Date.parse(status.last_progress_at) : 0);
  const limit = limits.stallMs ?? STALL_ALERT_MS;
  if (now - point < limit) return null;
  return { run_id: status.run_id, status, since: new Date(point).toISOString(), minutes: Math.floor((now - point) / 60000), limit };
}

export function stallMarker(runId) {
  return `<!-- card-run-stall ${runId} -->`;
}

export function renderStall({ stalled, mention }) {
  const status = stalled.status;
  return [
    stallMarker(stalled.run_id),
    `Stall: the card run on ${status.card ?? "an unknown card"} (${stalled.run_id}) has shown no progress for ${stalled.minutes} minutes, since ${stalled.since}${mention ? ` (${mention})` : ""}.`,
    `It is still ${status.step}, ${status.ticks ?? 0} tick(s)${status.last_tick_at ? `, last tick ${status.last_tick_at}` : ""}; ${status.first_dispatch_at ? `first dispatch ${status.first_dispatch_at}` : "no dispatch seen"}.`,
    `Observe only: the watch flags a run with no progress for ${Math.round(stalled.limit / 60000)} minutes once, and stops, reverts or pauses nothing.`,
  ].join("\n");
}

export function alertMarker(key) {
  return `card-watch-${key}`;
}

export function renderAlert({ stuck, mention, pause, paths = CARD_RUN_PATHS, limits = WATCH_LIMITS }) {
  const card = stuck.status?.card ?? null;
  const lines = [
    reportMarker(alertMarker(stuck.key)),
    `Alert: the card run${card ? ` on ${card}` : ""} needs the owner${mention ? ` (${mention})` : ""}.`,
    stuck.kind === "failed"
      ? `${AUTO_SERVICE} failed after starting at ${stuck.since}, before its run wrote any status: the run may have left its claim or ${paths.lock} in place, holding every later start.`
      : stuck.kind === "stale"
      ? `${AUTO_SERVICE} has been running since ${stuck.since}, and ${stuck.status ? `the run's status was last written at ${stuck.last} (step ${stuck.status.step ?? "unknown"})` : "no status was written since it started"}: nothing for more than ${Math.round(limits.staleMs / 60000)} minutes.`
      : `${AUTO_SERVICE} is not running, but the run's status stopped at step ${stuck.status.step} at ${stuck.last} and never reached finished: the run ended without finishing, and may have left the host armed and ${paths.lock} in place.`,
    pause.written ? `Wrote ${paths.pause}, so no new card run starts until the owner removes it.`
      : pause.held ? `${paths.pause} was already in place.`
        : `${paths.pause} could not be written (${plainReason(pause.code)}).`,
    "The watch never stops, kills or reverts a run. Check the host before removing the pause file.",
  ];
  return lines.join("\n");
}

// The pause file, written once and never replaced.
function writePause(io, paths, stuck) {
  try {
    io.fs.writeFileSync(paths.pause, `card-watch: ${stuck.kind} run ${stuck.key}\n`, { flag: "wx", mode: 0o644 });
    return { written: true };
  } catch (error) {
    if (error.code === "EEXIST") return { written: false, held: true };
    return { written: false, held: false, code: error.code ?? "PAUSE_WRITE_FAILED" };
  }
}

export function renderStatus({ status, unit, paused, now }) {
  const lines = [STATUS_MARKER, "Card-run status, kept by the card-run watch (every ten minutes, edited only when it changes)."];
  lines.push(unit === null ? `${AUTO_SERVICE}: state unknown.`
    : unit.running ? `${AUTO_SERVICE}: running since ${new Date(unit.since).toISOString()}.`
      : unit.state === "failed" ? `${AUTO_SERVICE}: failed (last started ${new Date(unit.since).toISOString()}).` : `${AUTO_SERVICE}: idle.`);
  lines.push(paused ? "Timer: paused (the pause file is present)." : `Timer: next start ${nextStart(now)}.`);
  if (!status) {
    lines.push("No card run has written a status yet.");
    return lines.join("\n");
  }
  if (status.queue.length) lines.push(`Queue: ${status.queue.join(", ")}.`);
  lines.push(`Latest run: ${status.card ?? "unknown card"} (${status.kind ?? "unknown"}, ${status.trigger ?? "unknown"}), step ${status.step ?? "unknown"}, ${status.ticks ?? 0} tick(s)${status.last_tick_at ? `, last tick ${status.last_tick_at}` : ""}.`);
  lines.push(`Progress: ${status.first_dispatch_at ? `first dispatch ${status.first_dispatch_at}` : "no dispatch seen"}${status.last_progress_at ? `, last progress ${status.last_progress_at}` : ""}.`);
  if (status.outcome) lines.push(`Outcome: ${status.outcome}${status.land ? `, landing ${status.land}` : ""}${status.needs_owner ? "; needs the owner" : ""}.`);
  if (status.revision) lines.push(`Revision: ${status.revision}.`);
  lines.push(`Status written ${status.updated_at}.`);
  return lines.join("\n");
}

export const STATUS_COMMENT_CREATE = `
  mutation CardWatchStatusCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
  }`;
export const STATUS_COMMENT_UPDATE = `
  mutation CardWatchStatusUpdate($id: String!, $body: String!) {
    commentUpdate(id: $id, input: { body: $body }) { success }
  }`;

function bounded(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Linear did not answer within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Edits the one status comment, or finds it by its marker, or creates it.
// Returns the comment id and whether the body is now posted.
async function keepStatusComment({ io, credentials, body, known, timeoutMs }) {
  const send = (query, variables) => bounded(sendLinear(query, variables, credentials.LINEAR_API_TOKEN, io.fetch), timeoutMs);
  let id = known;
  if (!id) {
    const data = await send(REPORT_ISSUE_QUERY, { id: REPORT_ISSUE, marker: STATUS_MARKER });
    const issue = data?.issue;
    if (!issue?.id || issue.identifier !== REPORT_ISSUE || !Array.isArray(issue.comments?.nodes)) refuse("CARD_WATCH_STATUS", `${REPORT_ISSUE} cannot be read from Linear`);
    id = issue.comments.nodes[0]?.id ?? null;
    if (!id) {
      const created = await send(STATUS_COMMENT_CREATE, { issueId: issue.id, body });
      if (created?.commentCreate?.success !== true || !created.commentCreate.comment?.id) refuse("CARD_WATCH_STATUS", "Linear did not accept the status comment");
      return created.commentCreate.comment.id;
    }
  }
  const updated = await send(STATUS_COMMENT_UPDATE, { id, body });
  if (updated?.commentUpdate?.success !== true) refuse("CARD_WATCH_STATUS", "Linear did not accept the status edit");
  return id;
}

function readState(io, paths) {
  try {
    const raw = JSON.parse(io.fs.readFileSync(watchStatePath(paths), "utf8"));
    return { alerts: Array.isArray(raw.alerts) ? raw.alerts.filter((entry) => typeof entry?.key === "string") : [],
      stalls: Array.isArray(raw.stalls) ? raw.stalls.filter((entry) => typeof entry?.run_id === "string") : [],
      status_comment: typeof raw.status_comment === "string" ? raw.status_comment : null,
      status_body: typeof raw.status_body === "string" ? raw.status_body : null };
  } catch {
    return { alerts: [], stalls: [], status_comment: null, status_body: null };
  }
}

function writeState(io, paths, state) {
  const file = watchStatePath(paths);
  try {
    io.fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    io.fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

function readOwnerMention(io, paths) {
  try {
    return ownerMention(JSON.parse(io.fs.readFileSync(path.join(paths.checkout, ".github/coordinator/config.json"), "utf8")).owner_mention);
  } catch {
    return null;
  }
}

// One watch pass. It records an alert before posting it, so a post that fails
// is tried again on the next pass, and the comment marker keeps a retry from
// posting twice.
export async function watchOnce({ io, paths = CARD_RUN_PATHS, limits = WATCH_LIMITS }) {
  if (io.uid() !== 0) refuse("CARD_WATCH_NOT_ROOT", "run as root on the orchestrator host");
  const now = io.now().getTime();
  // The unit is read before the status, so a run that finishes in between is
  // read as running with a fresh status, never as ended without finishing.
  const unit = readUnit(io, now);
  const status = readStatus(io, paths);
  const state = readState(io, paths);
  let credentials = null;
  let credentialError = null;
  try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch (error) { credentialError = error.code ?? "CARD_WATCH_CREDENTIALS"; }
  const result = { ok: true, unit: unit ? unit.state : null, step: status?.step ?? null, alert: null, status_comment: null };
  if (unit === null) result.unit_error = "the card-run unit could not be read";

  const stuck = stuckRun({ unit, status, now, limits });
  if (stuck) {
    const entry = state.alerts.find((alert) => alert.key === stuck.key || (stuck.run_id !== null && alert.run_id === stuck.run_id)
      || (stuck.invocation !== null && alert.invocation === stuck.invocation));
    // A pause file that could not be written is tried again on every pass
    // while the run is stuck, whether or not its alert is already posted.
    const pauseKept = entry?.pause?.written === true || entry?.pause?.held === true;
    const pause = pauseKept ? entry.pause : writePause(io, paths, stuck);
    if (entry?.posted) {
      entry.pause = pause;
      // What a later pass learns about the run is kept, so every later read
      // of it, by key, run id or invocation, still finds this alert.
      entry.run_id = entry.run_id ?? stuck.run_id;
      entry.invocation = entry.invocation ?? stuck.invocation;
      result.alert = { key: entry.key, kind: entry.kind, already: true, pause };
    } else {
      // A retried alert keeps the run id an earlier pass saw.
      const record = { key: entry?.key ?? stuck.key, run_id: stuck.run_id ?? entry?.run_id ?? null,
        invocation: stuck.invocation ?? entry?.invocation ?? null, kind: entry?.kind ?? stuck.kind,
        at: new Date(now).toISOString(), pause, posted: false };
      state.alerts = [...state.alerts.filter((alert) => alert !== entry), record].slice(-limits.keepAlerts);
      writeState(io, paths, state);
      const mention = readOwnerMention(io, paths);
      const report = await postRunReport({ io, credentials, result: { activation_id: alertMarker(record.key) }, timeoutMs: limits.requestTimeoutMs,
        render: () => renderAlert({ stuck: { ...stuck, key: record.key }, mention, pause, paths, limits }) });
      record.posted = report.posted === true;
      result.alert = { key: record.key, kind: record.kind, pause, posted: record.posted, ...(report.posted ? {} : { reason: report.reason }) };
    }
  }

  // Self-heal: one stall comment per run, recorded before it is posted so a
  // post that fails is tried again; the marker keeps a retry from posting twice.
  const stalled = stalledRun({ unit, status, now, limits });
  if (stalled) {
    const done = state.stalls.find((stall) => stall.run_id === stalled.run_id);
    if (done?.posted === true) {
      result.stall = { run_id: done.run_id, already: true };
    } else {
      const stall = { run_id: stalled.run_id, at: new Date(now).toISOString(), posted: false };
      state.stalls = [...state.stalls.filter((kept) => kept !== done), stall].slice(-limits.keepAlerts);
      writeState(io, paths, state);
      const mention = readOwnerMention(io, paths);
      const report = await postRunReport({ io, credentials, result: { activation_id: stalled.run_id }, timeoutMs: limits.requestTimeoutMs,
        marker: stallMarker(stalled.run_id), render: () => renderStall({ stalled, mention }) });
      stall.posted = report.posted === true;
      result.stall = { run_id: stall.run_id, posted: stall.posted, ...(report.posted ? {} : { reason: report.reason }) };
    }
  }

  const body = renderStatus({ status, unit, paused: io.fs.existsSync(paths.pause), now: new Date(now) });
  if (body === state.status_body) {
    result.status_comment = { changed: false };
  } else if (!credentials) {
    result.status_comment = { changed: true, posted: false, reason: credentialError };
  } else {
    try {
      state.status_comment = await keepStatusComment({ io, credentials, body, known: state.status_comment, timeoutMs: limits.requestTimeoutMs });
      state.status_body = body;
      result.status_comment = { changed: true, posted: true };
    } catch (error) {
      // A stored id that no longer edits is forgotten, so the next pass finds
      // the comment by its marker or posts it again.
      state.status_comment = null;
      result.status_comment = { changed: true, posted: false, reason: plainReason(error.message) };
    }
  }
  result.state_written = writeState(io, paths, state);
  const paused = result.alert === null || result.alert.pause.written === true || result.alert.pause.held === true;
  result.ok = result.state_written && result.unit_error === undefined && result.alert?.posted !== false && result.stall?.posted !== false && paused && result.status_comment.posted !== false;
  return result;
}

// Puts the watch timer on the host, as card-run.mjs puts its own: never over
// units with other content.
export function installWatch(io, paths = CARD_RUN_PATHS, { node, module = WATCH_MODULE } = {}) {
  if (io.uid() !== 0) refuse("CARD_WATCH_NOT_ROOT", "run as root on the orchestrator host");
  if (!path.isAbsolute(node ?? "") || !path.isAbsolute(module ?? "")) refuse("CARD_WATCH_TIMER", "the node binary and the module need absolute paths");
  const units = [[WATCH_SERVICE, watchServiceUnit({ node, module })], [WATCH_TIMER, watchTimerUnit()]];
  for (const [name, text] of units) {
    const file = path.join(paths.unitDir, name);
    if (!io.fs.existsSync(file)) io.fs.writeFileSync(file, text, { flag: "wx", mode: 0o644 });
    else if (io.fs.readFileSync(file, "utf8") !== text) refuse("CARD_WATCH_TIMER", `${file} exists with other content; run remove first`);
  }
  for (const args of [["daemon-reload"], ["enable", "--now", WATCH_TIMER]]) {
    const done = io.exec("systemctl", args);
    if (done.status !== 0) refuse("CARD_WATCH_TIMER", `systemctl ${args.join(" ")} failed`);
  }
  const enabled = io.exec("systemctl", ["is-enabled", WATCH_TIMER]).stdout.trim();
  const active = io.exec("systemctl", ["is-active", WATCH_TIMER]).stdout.trim();
  if (enabled !== "enabled" || active !== "active") refuse("CARD_WATCH_TIMER", `the timer reads ${enabled || "unknown"}/${active || "unknown"} after install`);
  return { installed: true, units: units.map(([name]) => path.join(paths.unitDir, name)), enabled, active };
}

export function removeWatch(io, paths = CARD_RUN_PATHS) {
  if (io.uid() !== 0) refuse("CARD_WATCH_NOT_ROOT", "run as root on the orchestrator host");
  if (io.fs.existsSync(path.join(paths.unitDir, WATCH_TIMER))) io.exec("systemctl", ["disable", "--now", WATCH_TIMER]);
  const enabled = io.exec("systemctl", ["is-enabled", WATCH_TIMER]).stdout.trim();
  const active = io.exec("systemctl", ["is-active", WATCH_TIMER]).stdout.trim();
  if (!["disabled", "not-found"].includes(enabled) || active !== "inactive") refuse("CARD_WATCH_TIMER", `${WATCH_TIMER} reads ${enabled || "unknown"}/${active || "unknown"} after disable; its unit files stay`);
  for (const name of [WATCH_TIMER, WATCH_SERVICE]) {
    const file = path.join(paths.unitDir, name);
    if (io.fs.existsSync(file)) io.fs.unlinkSync(file);
  }
  io.exec("systemctl", ["daemon-reload"]);
  return { removed: true };
}

export const defaultIO = Object.freeze({
  fs,
  uid: () => process.getuid(),
  now: () => new Date(),
  // CLOCK_MONOTONIC on Linux, the clock systemd's *Monotonic timestamps use.
  monotonicMs: () => Number(process.hrtime.bigint() / 1000n) / 1000,
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  exec: (file, args) => {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 60 * 1000, killSignal: "SIGKILL" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
});

export async function main(argv, io = defaultIO, paths = CARD_RUN_PATHS) {
  try {
    if (argv.length !== 1 || !["check", "install", "remove"].includes(argv[0])) refuse("CARD_WATCH_USAGE", "usage: card-watchdog.mjs check | install | remove");
    if (argv[0] === "install") return { code: 0, output: installWatch(io, paths, { node: io.nodePath?.() ?? process.execPath }) };
    if (argv[0] === "remove") return { code: 0, output: removeWatch(io, paths) };
    const result = await watchOnce({ io, paths });
    return { code: result.ok ? 0 : 1, output: result };
  } catch (error) {
    return { code: 2, output: { ok: false, code: error.code ?? "CARD_WATCH_ERROR", reason: plainReason(error.message) } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, output } = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = code;
}
