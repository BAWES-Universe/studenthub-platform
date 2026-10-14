// SHU-86, first slice: one command runs one bounded card run on the host.
//
// Until now every card run was a long hand-written operator prompt: check the
// host is idle, write the activation record, write the two dispatch drop-ins,
// restart the supervisor, start the evidence broker, tick the coordinator one
// unit start at a time, decide when the episode ended, then revert all of it.
// This module does exactly those steps, in that order, from the committed
// configuration at the installed revision. It decides nothing the coordinator
// decides: the card is the committed dispatch_scope, the lanes are the
// committed lanes, and the run ends when the coordinator's own tick reports
// the activation spent. Revert always runs, and refuses only while a worker is
// still running.
//
// Before arming, the run itself moves the card to Todo and creates its
// coordinator/<card> branch at main's current tip, which must descend from the
// installed revision (card-prepare.mjs, SHU-312), and
// after the revert it posts its own report on the SHU-71 tracking card. Still
// an operator step: installing the revision with the prerequisite
// provisioner.
//
// The fourth slice adds `auto`, what the card-run timer starts: it runs the
// committed card at most once per installed revision and otherwise does
// nothing. A skip (paused, locked, busy, not installed, a review card, already
// ran) touches neither the host nor Linear. `timer-install` and `timer-remove`
// put the timer on the host and take it off; installing it is the owner's one
// go. Importing the module has no effect.
//
// SHU-312: the committed dispatch_scope may be a queue of up to five card
// lanes. The timer then runs at most one card per start: the first queued card
// that has not landed, and only once every earlier one has landed (MERGED) by a
// timer run, at this revision or an earlier install. Any other outcome of the
// card in front stops the queue (QUEUE_STOPPED) until a new install re-arms it;
// all landed is QUEUE_DONE. A crashed run leaves its lock behind and every
// later start skips LOCKED until the lock is cleared by hand, after checking
// that no card-run process is alive.
//
// SHU-321: a QUEUE_DONE start may then run the standing review-only card
// (committed queue_config_review, SHU-304) on one open, labelled queue config
// pull request at its exact head, with Codex as the reviewer of Claude's
// change: once per head, at most max_heads_per_pr heads per pull request per
// installed revision, lowest number first, one review per start. It reviews
// only; merging and installing stay with people. A stopped, invalid or paused
// queue never reviews, and a GitHub read that fails claims nothing.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateActivationRecord, cardQueue, MAX_ACTIVATION_WINDOW_MS } from "../single-run-activation.mjs";
import { resolveFixtureLane, resolveReviewOnlyLane, resolveQueueConfigReview } from "../workspace-scope.mjs";
import { familyForLane } from "../launch-vocabulary.mjs";
import { prepareRun, postRunReport, readCoordinatorCredentials, COORDINATOR_ENV } from "./card-prepare.mjs";
import { landCard, readLandToken, boundedFetch, CARD_LAND_ENV, LAND_LIMITS } from "./card-land.mjs";

export const CARD_RUN_PATHS = Object.freeze({
  checkout: "/srv/shu/studenthub-platform",
  stateDir: "/srv/shu/state",
  activation: "/srv/shu/state/shu71-activation.json",
  worktrees: "/srv/shu/worktrees",
  receipt: "/etc/shu/shu71-prerequisites.json",
  unitDir: "/etc/systemd/system",
  lock: "/run/lock/shu-card-run.lock",
  tmp: "/tmp",
  coordinatorEnv: COORDINATOR_ENV,
  pause: "/etc/shu/card-run.paused",
  // SHU-306: the landing token, root's alone and read only by this run.
  landEnv: CARD_LAND_ENV,
});
export const UNITS = Object.freeze(["shu-supervisor.service", "shu-coordinator.service"]);
export const RUN_DROP_IN = "95-v1-run.conf";
export const TARGET_DROP_IN = "96-v1-target.conf";
export const RESIDENT_DROP_IN = "90-shu71.conf";
export const runDropIn = () => "[Service]\nEnvironment=ENABLE_DISPATCH=true\n";
export const targetDropIn = (sha) => `[Service]\nEnvironment=DISPATCH_TARGET_SHA=${sha}\n`;
export const CARD_RUN_LIMITS = Object.freeze({
  runMs: 6 * 60 * 60 * 1000,
  tickIntervalMs: 60 * 1000,
  workerGraceMs: 30 * 60 * 1000,
  workerPollMs: 30 * 1000,
  killWaitMs: 10 * 1000,
  reportTimeoutMs: 30 * 1000,
  // SHU-306: landing a passed card. The wait for its checks is bounded so the
  // whole run (window, worker grace, landing, reports) stays inside the unit's
  // TimeoutStartSec.
  landWaitMs: 30 * 60 * 1000,
  landPollMs: 60 * 1000,
  landRequestTimeoutMs: 30 * 1000,
  // SHU-321: each GitHub read of the queue config review's discovery.
  reviewRequestTimeoutMs: 30 * 1000,
});
export const AUTO_TIMEOUT_START_MS = 8 * 60 * 60 * 1000;

// The timer and the one-shot service it starts. The service may run far longer
// than any run can take, so systemd never kills a run before its revert. The
// pause file is checked by `auto` itself, not by a unit condition, and the
// timer is on the calendar rather than relative to the service's last run: a
// start skipped by a condition never makes the service inactive again, so a
// timer counting from that would never fire again.
// Declared before the CLI entry at the bottom runs main, so a default that
// reads it is never in its temporal dead zone.
export const CARD_RUN_MODULE = fileURLToPath(import.meta.url);
export const AUTO_SERVICE = "shu-card-run.service";
export const AUTO_TIMER = "shu-card-run.timer";
export const AUTO_SCHEDULE = "*:00/30";
export function autoServiceUnit({ node, module }) {
  return [
    "[Unit]",
    "Description=StudentHub card run: the committed card, at most once per installed revision",
    "[Service]",
    "Type=oneshot",
    "User=root",
    `ExecStart=${node} ${module} auto`,
    "TimeoutStartSec=8h",
    "",
  ].join("\n");
}
export function autoTimerUnit() {
  return [
    "[Unit]",
    "Description=Every half hour, run the installed revision's card if it has not run yet",
    "[Timer]",
    `OnCalendar=${AUTO_SCHEDULE}`,
    `Unit=${AUTO_SERVICE}`,
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
const SHA_RE = /^[0-9a-f]{40}$/;

export function refuse(code, detail = "") {
  throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}

// 2026-10-09T15:30:07.123Z -> 20261009T153007Z
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

// The record this run arms, built only from the committed configuration at the
// installed revision. A review-only run takes its pull request, head, base and
// author family from the operator, exactly as the activation keys require.
// Under a committed queue (SHU-312) the caller names which queued card; the
// selection is made once, by nextCard, and never again inside the run.
export function planRun({ config, revision, now, review = null, limits = CARD_RUN_LIMITS, cardId = null }) {
  if (!SHA_RE.test(revision ?? "")) refuse("CARD_RUN_REVISION", "the installed revision is not a full SHA");
  const queue = cardQueue(config);
  let id;
  if (queue.queue) {
    if (!queue.ok) refuse("CARD_RUN_SCOPE", queue.reason);
    // SHU-321: the one review a queue admits is the committed
    // queue_config_review lane, which the timer arms once the queue is done.
    if (review && (cardId === null || cardId !== queueConfigReview(config)?.lane)) {
      refuse("CARD_RUN_REVIEW_INPUT", "a review run under a card queue is only the committed queue_config_review lane");
    }
    if (!review && !queue.ids.includes(cardId)) refuse("CARD_RUN_SCOPE", "a card queue runs only a named queued card");
    id = cardId;
  } else {
    const ids = config?.dispatch_scope?.issue_ids;
    if (!Array.isArray(ids) || ids.length !== 1) refuse("CARD_RUN_SCOPE", "the committed dispatch_scope must name exactly one card or a card queue");
    [id] = ids;
    if (cardId !== null && cardId !== id) refuse("CARD_RUN_SCOPE", `${cardId} is not the committed card`);
  }
  let reviewLane;
  let cardLane;
  try {
    reviewLane = resolveReviewOnlyLane(config, id);
    cardLane = reviewLane ? null : resolveFixtureLane(config, id);
  } catch (error) {
    refuse("CARD_RUN_CONFIG", error.message);
  }
  const base = {
    activation_id: `${id.toLowerCase()}-run-${stamp(now)}`,
    target_issue_id: id,
    coordinator_revision: revision,
    slots: 1,
    expires_at: new Date(now.getTime() + Math.min(limits.runMs, MAX_ACTIVATION_WINDOW_MS)).toISOString(),
  };
  let record;
  let kind;
  if (reviewLane) {
    if (!review) refuse("CARD_RUN_REVIEW_INPUT", `${id} is the review card: name the pull request, its head, its base and its author family`);
    const reviewer = reviewLane.reviewer_lanes.find((lane) => familyForLane(lane) !== review.authorFamily);
    if (!reviewer) refuse("CARD_RUN_REVIEW_INPUT", `no listed reviewer lane is outside the author family ${review.authorFamily}`);
    record = { ...base, authorization_ref: reviewLane.authorization_ref, reviewer_lane: reviewer,
      initial_target_sha: review.head, review_pr: review.pr, review_base_sha: review.base, pr_author_family: review.authorFamily };
    kind = "review";
  } else {
    if (review) refuse("CARD_RUN_REVIEW_INPUT", `${id} is not the review card; a pull request applies only to a review run`);
    if (!(config.card_lanes ?? []).some((lane) => lane?.id === id) || !cardLane) {
      refuse("CARD_RUN_NOT_A_CARD", `${id} is not a committed card lane; fixtures keep their own runs`);
    }
    record = { ...base, authorization_ref: cardLane.authorization_ref, writer_lane: cardLane.writer_lane,
      reviewer_lane: cardLane.reviewer_lane, initial_target_sha: revision };
    kind = "card";
  }
  const shape = validateActivationRecord(record);
  if (!shape.ok) refuse("CARD_RUN_RECORD", shape.reason);
  return { id, kind, record, branch: kind === "card" ? `coordinator/${id}` : null };
}

// SHU-312: a card builds on the main tip its branch was made at, so the
// activation's approved input is that tip; the record is checked again.
export function onBase(plan, base) {
  if (plan.kind !== "card") return plan;
  if (!SHA_RE.test(base ?? "")) refuse("CARD_RUN_BASE", "the card branch has no base commit");
  const record = { ...plan.record, initial_target_sha: base };
  const shape = validateActivationRecord(record);
  if (!shape.ok) refuse("CARD_RUN_RECORD", shape.reason);
  return { ...plan, record };
}

// The landing outcome a timer run recorded for this card at any installed
// revision. Claims live in the root-owned state directory. A claim proves a
// landing only when its content names this card, the revision in its own file
// name, and a passed run that merged: a swapped or partial claim proves nothing.
function landedByTimer(io, paths, id) {
  const name = new RegExp(`^card-run-auto-([0-9a-f]{40})-${id}\\.json$`);
  for (const file of io.fs.readdirSync(paths.stateDir)) {
    const match = name.exec(file);
    if (!match) continue;
    try {
      const claim = JSON.parse(io.fs.readFileSync(path.join(paths.stateDir, file), "utf8"));
      if (claim?.card === id && claim.revision === match[1] && claim.outcome === "PASS" && claim.ok === true
        && claim.land === "MERGED") return true;
    } catch { /* an unreadable claim proves nothing */ }
  }
  return false;
}

// Which card this start runs, decided once. A single committed card is itself
// (its once-per-revision claim is checked by the caller). A queue gives the
// first card a timer run has not landed, unless that card already ran at this
// revision: it did not land, so the queue stops there until a new install.
export function nextCard(io, paths, config, revision) {
  const queue = cardQueue(config);
  if (!queue.queue) return { id: null };
  if (!queue.ok) return { id: null, skipped: "NOT_READY", reason: `CARD_RUN_SCOPE: ${queue.reason}` };
  for (const id of queue.ids) {
    if (landedByTimer(io, paths, id)) continue;
    const claim = autoClaim(paths, revision, id);
    if (!io.fs.existsSync(claim)) return { id };
    let ran = null;
    try { ran = JSON.parse(io.fs.readFileSync(claim, "utf8")); } catch { /* reported as unreadable */ }
    const how = ran ? `${ran.outcome ?? "no outcome"}${ran.land ? `, landing ${ran.land}` : ""}` : "an unreadable claim";
    return { id: null, skipped: "QUEUE_STOPPED", reason: `${id} ran at ${revision} and did not land (${how}): ${claim}` };
  }
  return { id: null, skipped: "QUEUE_DONE", reason: `every queued card landed: ${queue.ids.join(", ")}` };
}

// What one coordinator tick said about this run. The coordinator is the only
// judge of the episode: the run ends when its tick reports the activation
// spent, and a refusal that is not "spent" stops the run by its own words.
// A tick with no activation line, an absent record, or another run's record
// also ends the run: the runner never ticks past what it cannot read.
export function tickOutcome(text, activationId = null) {
  const lines = String(text ?? "").split("\n");
  const activation = lines.find((line) => line.startsWith("activation=")) ?? null;
  const eligibleMatch = /^eligible=(\d+)/m.exec(text ?? "");
  const eligible = eligibleMatch ? Number(eligibleMatch[1]) : null;
  const excluded = lines.filter((line) => line.startsWith("  EXCLUDED ")).map((line) => line.trim());
  const spent = activation && /^activation=REFUSED \(activation is spent: the episode for \S+ ended — (.*)\)$/.exec(activation);
  if (spent) {
    const reason = spent[1];
    const outcome = /^review PASS\b/.test(reason) ? "PASS"
      : /^review-only verdict (PASS|BLOCKED) at /.test(reason) ? `REVIEW_${/^review-only verdict (\w+)/.exec(reason)[1]}`
        : "STOPPED";
    return { ended: true, outcome, reason, activation, eligible, excluded };
  }
  const refusedMatch = activation && /^activation=REFUSED \((.*)\)$/.exec(activation);
  if (refusedMatch) return { ended: true, outcome: "REFUSED", reason: refusedMatch[1], activation, eligible, excluded };
  const armedId = /^activation=ARMED id=(\S+) /.exec(activation)?.[1] ?? null;
  if (!armedId) return { ended: true, outcome: "REFUSED", reason: `the tick did not report this run armed: ${activation}`, activation, eligible, excluded };
  if (activationId && armedId !== activationId) {
    return { ended: true, outcome: "REFUSED", reason: `the tick reports activation ${armedId}, not ${activationId}`, activation, eligible, excluded };
  }
  return { ended: false, outcome: null, reason: null, activation, eligible, excluded };
}

// The outcomes where the card got its answer: a passed build, or a review-only
// verdict either way. A stop, refusal or expiry is a failed run.
export const ANSWERED = Object.freeze(new Set(["PASS", "REVIEW_PASS", "REVIEW_BLOCKED"]));

// Every reason the host is not idle. A run starts only when this is empty.
export function busyReasons(io, paths = CARD_RUN_PATHS) {
  const reasons = [];
  if (io.fs.existsSync(paths.activation)) reasons.push(`activation record present at ${paths.activation}`);
  for (const unit of UNITS) {
    for (const dropIn of [RUN_DROP_IN, TARGET_DROP_IN]) {
      const file = path.join(paths.unitDir, `${unit}.d`, dropIn);
      if (io.fs.existsSync(file)) reasons.push(`dispatch drop-in present: ${file}`);
    }
  }
  const workers = workerCount(io);
  if (workers !== 0) reasons.push(`${workers} shu-worker process(es) running`);
  const trees = io.fs.existsSync(paths.worktrees) ? io.fs.readdirSync(paths.worktrees) : [];
  for (const name of trees) if (/^(build-|review-pr)/.test(name)) reasons.push(`worktree present: ${path.join(paths.worktrees, name)}`);
  return reasons;
}

function workerCount(io) {
  const result = io.exec("pgrep", ["-u", "shu-worker"]);
  if (result.status === 1) return 0;
  if (result.status !== 0) refuse("CARD_RUN_COMMAND", `pgrep exited ${result.status}`);
  return result.stdout.split("\n").filter((line) => line.trim()).length;
}

function run(io, file, args) {
  const result = io.exec(file, args);
  if (result.status !== 0) refuse("CARD_RUN_COMMAND", `${file} ${args.slice(0, 3).join(" ")} exited ${result.status}`);
  return result.stdout;
}

function git(io, paths, args) {
  return run(io, "git", ["-C", paths.checkout, ...args]).trim();
}

// The installed revision: the clean checkout's HEAD, which must also be main
// and the revision the prerequisite receipt verified.
export function installedRevision(io, paths = CARD_RUN_PATHS) {
  const head = git(io, paths, ["rev-parse", "HEAD"]);
  const main = git(io, paths, ["rev-parse", "refs/heads/main"]);
  const dirty = git(io, paths, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!SHA_RE.test(head) || head !== main || dirty) refuse("CARD_RUN_CHECKOUT", "the checkout must be clean with HEAD equal to main");
  let receipt;
  try { receipt = JSON.parse(io.fs.readFileSync(paths.receipt, "utf8")); } catch { refuse("CARD_RUN_NOT_INSTALLED", "the prerequisite receipt cannot be read"); }
  if (receipt?.state !== "VERIFIED" || receipt?.revision !== head) {
    refuse("CARD_RUN_NOT_INSTALLED", `the prerequisite receipt is not VERIFIED at ${head}`);
  }
  return head;
}

function supervisorEnvironment(io) {
  const pid = run(io, "systemctl", ["show", "-p", "MainPID", "--value", "shu-supervisor.service"]).trim();
  if (!/^[1-9]\d*$/.test(pid)) refuse("CARD_RUN_SUPERVISOR", "shu-supervisor has no main process");
  return io.fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
}

function writeExclusive(io, file, text, mode, gid = 0) {
  const temp = `${file}.card-run-${process.pid}`;
  io.fs.writeFileSync(temp, text, { mode, flag: "wx" });
  io.fs.chownSync(temp, 0, gid);
  io.fs.chmodSync(temp, mode);
  io.fs.renameSync(temp, file);
}

export function arm(io, plan, revision, paths = CARD_RUN_PATHS) {
  run(io, "systemctl", ["start", "shu71-evidence.service"]);
  const gid = Number(run(io, "id", ["-g", "shu-coordinator"]).trim());
  if (!Number.isInteger(gid) || gid <= 0) refuse("CARD_RUN_GROUP", "the shu-coordinator group cannot be resolved");
  writeExclusive(io, paths.activation, JSON.stringify(plan.record), 0o640, gid);
  const target = plan.record.initial_target_sha;
  for (const unit of UNITS) {
    const dir = path.join(paths.unitDir, `${unit}.d`);
    if (!io.fs.existsSync(path.join(dir, RESIDENT_DROP_IN))) refuse("CARD_RUN_RESIDENT_DROP_IN", `${unit} has no ${RESIDENT_DROP_IN}`);
    writeExclusive(io, path.join(dir, RUN_DROP_IN), runDropIn(), 0o644);
    writeExclusive(io, path.join(dir, TARGET_DROP_IN), targetDropIn(target), 0o644);
  }
  run(io, "systemctl", ["daemon-reload"]);
  run(io, "systemctl", ["restart", "shu-supervisor.service"]);
  const environ = supervisorEnvironment(io);
  if (!environ.includes("ENABLE_DISPATCH=true") || !environ.includes(`DISPATCH_TARGET_SHA=${target}`)) {
    refuse("CARD_RUN_ARM_READBACK", "the supervisor did not come up with dispatch on at the target");
  }
  return { activation_id: plan.record.activation_id, target, revision };
}

// One coordinator tick and its output. The coordinator is a oneshot, and
// systemd unloads a finished unit that nothing references, so its InvocationID
// is already gone when `systemctl start` returns: the first timer run read it
// empty and failed. The output is read from the journal instead: the unit's own
// lines since just before the start, flushed first, in full (json would
// otherwise null a field over 4096 bytes), and of those only the last
// invocation's, which is this tick's. No line at all is a refusal, never an
// earlier tick's output read as this one's.
export function tick(io) {
  const since = io.now().getTime();
  run(io, "systemctl", ["start", "shu-coordinator.service"]);
  run(io, "journalctl", ["--sync"]);
  const raw = run(io, "journalctl", ["_SYSTEMD_UNIT=shu-coordinator.service", `--since=@${(since / 1000).toFixed(3)}`, "-o", "json", "--all", "--no-pager"]);
  const entries = [];
  for (const line of raw.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const invocation = entry?._SYSTEMD_INVOCATION_ID;
    if (typeof invocation !== "string" || !/^[0-9a-f]{32}$/.test(invocation)) continue;
    const message = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString("utf8") : entry.MESSAGE;
    if (typeof message === "string") entries.push({ invocation, message });
  }
  if (!entries.length) refuse("CARD_RUN_TICK", "the tick left no output in the journal");
  const last = entries.at(-1).invocation;
  return entries.filter((entry) => entry.invocation === last).map((entry) => entry.message).join("\n");
}

// Returns the run back to dispatch off. It waits a bounded time for workers to
// finish; while one is still running it leaves everything armed and says so,
// because restarting the supervisor under a live worker loses its result.
export function revert(io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS) {
  const waitUntil = io.now().getTime() + limits.workerGraceMs;
  while (workerCount(io) !== 0) {
    if (io.now().getTime() >= waitUntil) return { reverted: false, code: "CARD_RUN_WORKER_STILL_RUNNING" };
    io.sleep(limits.workerPollMs);
  }
  for (const unit of UNITS) {
    for (const dropIn of [RUN_DROP_IN, TARGET_DROP_IN]) {
      const file = path.join(paths.unitDir, `${unit}.d`, dropIn);
      if (io.fs.existsSync(file)) io.fs.unlinkSync(file);
    }
  }
  run(io, "systemctl", ["daemon-reload"]);
  run(io, "systemctl", ["restart", "shu-supervisor.service"]);
  if (supervisorEnvironment(io).includes("ENABLE_DISPATCH=true")) refuse("CARD_RUN_REVERT_READBACK", "dispatch is still on after revert");
  // Dispatch is already off here, so a failed dispatch-off tick is reported
  // and the rest of the cleanup still runs.
  let offTick;
  try { offTick = tickOutcome(tick(io)).activation; }
  catch (error) { offTick = `tick failed: ${error.message}`; }
  run(io, "systemctl", ["stop", "shu71-evidence.service"]);
  const killed = workerCount(io);
  if (killed) {
    io.exec("pkill", ["-TERM", "-u", "shu-worker"]);
    io.sleep(limits.killWaitMs);
    io.exec("pkill", ["-KILL", "-u", "shu-worker"]);
  }
  if (workerCount(io) !== 0) refuse("CARD_RUN_REVERT_READBACK", "shu-worker processes survived cleanup");
  // The record is retired last: until every step above succeeded it stays,
  // so the host reads busy and the next run refuses.
  let retired = null;
  if (io.fs.existsSync(paths.activation)) {
    retired = path.join(paths.stateDir, `spent-${stamp(io.now())}-shu71-activation.json`);
    io.fs.renameSync(paths.activation, retired);
  }
  for (const name of io.fs.readdirSync(paths.tmp)) {
    if (/^shu-npm-cache-/.test(name)) io.fs.rmSync(path.join(paths.tmp, name), { recursive: true, force: true });
  }
  return { reverted: true, code: null, dispatch_off_tick: offTick, retired, killed };
}

// One bounded card run: refuse unless idle and installed, arm, tick until the
// coordinator ends the episode or the window closes, then revert.
export async function runCard({ io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS, review = null, trigger = "operator", cardId = null }) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  try { io.fs.writeFileSync(paths.lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { refuse("CARD_RUN_LOCKED", `${paths.lock} exists: another card run is in progress or crashed`); }
  let summary;
  let credentials;
  try {
    const busy = busyReasons(io, paths);
    if (busy.length) refuse("CARD_RUN_HOST_BUSY", busy.join("; "));
    const revision = installedRevision(io, paths);
    const config = readConfig(io, paths);
    const planned = planRun({ config, revision, now: io.now(), review, limits, cardId });
    credentials = readCoordinatorCredentials(io, paths.coordinatorEnv);
    const prepared = await prepareRun({ io, plan: planned, revision, repo: config.pilot_repo, checkout: paths.checkout, credentials });
    const plan = prepared.branch ? onBase(planned, prepared.branch.head) : planned;
    const ticks = [];
    let result;
    try {
      const armed = arm(io, plan, revision, paths);
      const deadline = Date.parse(plan.record.expires_at);
      for (;;) {
        // Never start a tick once the window has closed, including the first:
        // arming itself can outlast it.
        if (io.now().getTime() >= deadline) {
          result = { ok: false, outcome: "EXPIRED", reason: `the run window closed at ${plan.record.expires_at}` };
          break;
        }
        const startedAt = io.now().toISOString();
        const outcome = tickOutcome(tick(io), plan.record.activation_id);
        ticks.push({ at: startedAt, activation: outcome.activation, eligible: outcome.eligible });
        if (outcome.ended) {
          result = { ok: ANSWERED.has(outcome.outcome), outcome: outcome.outcome, reason: outcome.reason };
          break;
        }
        if (ticks.length === 1 && outcome.eligible === 0) {
          result = { ok: false, outcome: "NOT_ELIGIBLE", reason: outcome.excluded.join("; ") || "no eligible work" };
          break;
        }
        io.sleep(limits.tickIntervalMs);
      }
      result = { ...result, ...armed };
    } catch (error) {
      result = { ok: false, outcome: "ERROR", reason: error.message, code: error.code ?? "CARD_RUN_ERROR" };
    }
    let reverted;
    try { reverted = revert(io, paths, limits); }
    catch (error) { reverted = { reverted: false, code: error.code ?? "CARD_RUN_ERROR", reason: error.message }; }
    // SHU-306: a passed card lands its own work, still under the lock, and only
    // once the revert has put the host back to dispatch off.
    let land = null;
    if (plan.kind === "card" && result.outcome === "PASS" && reverted.reverted === true) {
      land = await landRun({ io, paths, limits, plan, config, credentials });
    }
    summary = { card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, trigger, revision, prepared, ...result, ticks, revert: reverted,
      ...(land ? { land } : {}), ...(plan.kind === "review" ? { review: { pr: review.pr, head: review.head, base: review.base } } : {}) };
  } finally {
    try { io.fs.unlinkSync(paths.lock); } catch { /* the lock is gone already */ }
  }
  // Reported last, once the host is as the revert left it and the lock is
  // released, so a slow Linear never holds the host. The report is bounded
  // and best effort: it never changes the result.
  return { ...summary, report: await postRunReport({ io, credentials, result: summary, timeoutMs: limits.reportTimeoutMs }) };
}

// The landing token is read here, by root, from its own file; a run without
// one is exactly the run it was before, reported as LAND_SKIPPED_NO_TOKEN.
async function landRun({ io, paths, limits, plan, config, credentials }) {
  let custody;
  try { custody = readLandToken(io, paths.landEnv); } catch { custody = { token: null, refused: "the landing token file cannot be read" }; }
  if (custody.refused) return { outcome: "LAND_ERROR", reason: custody.refused };
  if (!custody.token) return { outcome: "LAND_SKIPPED_NO_TOKEN", reason: custody.reason };
  return landCard({ io, plan, config, credentials, landToken: custody.token, pausePath: paths.pause,
    limits: { ...LAND_LIMITS, waitMs: limits.landWaitMs ?? LAND_LIMITS.waitMs, pollMs: limits.landPollMs ?? LAND_LIMITS.pollMs,
      requestTimeoutMs: limits.landRequestTimeoutMs ?? LAND_LIMITS.requestTimeoutMs } });
}

function readConfig(io, paths) {
  return JSON.parse(io.fs.readFileSync(path.join(paths.checkout, ".github/coordinator/config.json"), "utf8"));
}

// Refusals that mean "not now" rather than "this run went wrong": a later
// timer start may find the host free.
const NOT_NOW = Object.freeze(new Set(["CARD_RUN_LOCKED", "CARD_RUN_HOST_BUSY"]));

export const autoClaim = (paths, revision, id) => path.join(paths.stateDir, `card-run-auto-${revision}-${id}.json`);

// What the timer starts. It runs the committed card at most once per installed
// revision: the claim is written before the run starts, so a crash or a
// refusal still counts as that revision's run and nothing loops. Every reason
// not to run is a skip that touches neither the host nor Linear.
export async function autoRun({ io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS }) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  const skip = (skipped, reason) => ({ ok: true, trigger: "timer", skipped, reason });
  if (io.fs.existsSync(paths.pause)) return skip("PAUSED", `${paths.pause} exists`);
  if (io.fs.existsSync(paths.lock)) return skip("LOCKED", `${paths.lock} exists`);
  const busy = busyReasons(io, paths);
  if (busy.length) return skip("HOST_BUSY", busy.join("; "));
  let revision;
  let plan;
  let config;
  let done = null;
  try {
    revision = installedRevision(io, paths);
    config = readConfig(io, paths);
    const next = nextCard(io, paths, config, revision);
    // SHU-321: only a done queue may go on to review a queue config pull
    // request; a stopped, invalid or paused one never does.
    if (next.skipped === "QUEUE_DONE") done = next;
    else if (next.skipped) return skip(next.skipped, next.reason);
    else plan = planRun({ config, revision, now: io.now(), limits, cardId: next.id });
  } catch (error) {
    // A review card needs its pull request from an operator, so the timer never
    // runs one; any other planning refusal waits for the next install.
    return skip("NOT_READY", error.message);
  }
  if (done) return autoReview({ io, paths, limits, config, revision, done, skip });
  const claim = autoClaim(paths, revision, plan.id);
  try {
    io.fs.writeFileSync(claim, `${JSON.stringify({ card: plan.id, revision, claimed_at: io.now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") return skip("ALREADY_RAN", `${plan.id} already ran at ${revision}: ${claim}`);
    throw error;
  }
  let result;
  try {
    result = await runCard({ io, paths, limits, trigger: "timer", cardId: plan.id });
  } catch (error) {
    if (NOT_NOW.has(error.code)) {
      io.fs.unlinkSync(claim);
      return skip(error.code === "CARD_RUN_LOCKED" ? "LOCKED" : "HOST_BUSY", error.message);
    }
    // Refused before arming: nothing was armed, and the claim stands, so the
    // owner hears about it once instead of on every timer start.
    result = { ok: false, card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, trigger: "timer", revision,
      outcome: "NOT_STARTED", reason: error.message, code: error.code ?? "CARD_RUN_ERROR", ticks: [], revert: null };
    let credentials = null;
    try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch { /* the report records the missing credentials */ }
    result.report = await postRunReport({ io, credentials, result, timeoutMs: limits.reportTimeoutMs });
  }
  // The claim written before the run already stops a second run at this
  // revision. If this write fails, a queue never sees the card as landed and
  // stops there (a later install refuses it again: its branch and card have
  // moved), so the failure is named in the output rather than lost.
  let claimError = null;
  try {
    io.fs.writeFileSync(claim, `${JSON.stringify({ card: plan.id, revision, activation_id: result.activation_id, outcome: result.outcome, ok: result.ok,
      land: result.land?.outcome ?? null })}\n`, { mode: 0o600 });
  } catch (error) { claimError = error.code ?? "CLAIM_WRITE_FAILED"; }
  return { ...result, claim, ...(claimError ? { claim_error: claimError } : {}) };
}

// SHU-321: once the committed queue is done, the timer may run the standing
// review-only card on one open queue config pull request, so a queue Claude
// wrote gets a Codex verdict at its exact head without a person running Codex.
// It reviews only; it never merges, installs or writes a branch. A candidate
// is open, not a draft, on main, a branch of the pilot repository, labelled,
// touches only queue config paths, only adds to the card contracts, and every
// commit carries a Claude-Session: trailer. Anything else is not a candidate:
// no claim and no report.
export const QUEUE_CONFIG_REVIEWER = "codex-verifier";
export const QUEUE_CONFIG_AUTHOR_FAMILY = "claude";
export const QUEUE_CONFIG_PATHS = Object.freeze([
  ".github/coordinator/config.json",
  ".github/coordinator/card-contracts.mjs",
  ".github/coordinator/service/suite-inventory.json",
]);
const CONTRACTS_PATH = ".github/coordinator/card-contracts.mjs";
const SESSION_TRAILER_RE = /^Claude-Session: \S+$/m;
// One page of each list; a list that fills it may hide a file or a commit.
const GITHUB_PAGE = 100;

function queueConfigReview(config) {
  try { return resolveQueueConfigReview(config); } catch (error) { refuse("CARD_RUN_CONFIG", error.message); }
}

// One of the exact files, or any file under a test/ directory of the coordinator.
export function queueConfigPath(file) {
  if (typeof file !== "string" || !file.startsWith(".github/coordinator/")) return false;
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return QUEUE_CONFIG_PATHS.includes(file) || parts.slice(2, -1).includes("test");
}

// What the open-pull-request list itself says: a labelled branch of the pilot
// repository, open and ready, against main.
function listedCandidate(pull, repo, label) {
  return Number.isInteger(pull?.number) && pull.number > 0 && pull.state === "open" && pull.base?.ref === "main"
    && pull.base?.repo?.full_name === repo && pull.draft === false && pull.head?.repo?.full_name === repo && SHA_RE.test(pull.head?.sha ?? "")
    && Array.isArray(pull.labels) && pull.labels.some((entry) => entry?.name === label);
}

// The pull request's files and commits, judged whole. A renamed file counts
// under both names, so nothing leaves the allowlist by a rename, and the
// contracts may only gain lines: a deleted line could loosen a pinned card.
export function queueConfigChange(files, head, commits) {
  if (!Array.isArray(files) || files.length === 0 || files.length >= GITHUB_PAGE) return { ok: false, reason: "its changed files are not one readable page" };
  if (!Array.isArray(commits) || commits.length === 0 || commits.length >= GITHUB_PAGE) return { ok: false, reason: "its commits are not one readable page" };
  if (commits.at(-1)?.sha !== head) return { ok: false, reason: "its head moved while it was read" };
  const blobs = {};
  for (const file of files) {
    const names = [file?.filename, ...(file?.previous_filename === undefined ? [] : [file.previous_filename])];
    if (!names.every(queueConfigPath)) return { ok: false, reason: `${String(file?.filename)} is not a queue config path` };
    if (names.includes(CONTRACTS_PATH) && (file.status !== "modified" || file.deletions !== 0)) {
      return { ok: false, reason: `${CONTRACTS_PATH} may only gain lines` };
    }
    if (!SHA_RE.test(file.sha ?? "") || !Number.isInteger(file.additions) || !Number.isInteger(file.deletions) || Object.hasOwn(blobs, file.filename)) {
      return { ok: false, reason: `${file.filename} cannot be read` };
    }
    blobs[file.filename] = { sha: file.sha, additions: file.additions, deletions: file.deletions };
  }
  if (!commits.every((entry) => SESSION_TRAILER_RE.test(String(entry?.commit?.message ?? "")))) {
    return { ok: false, reason: "a commit carries no Claude-Session: trailer" };
  }
  return { ok: true, files: blobs };
}

// A Claude-written change is judged by Codex, never by Claude.
export function assertQueueConfigReviewer(plan) {
  if (plan?.kind !== "review" || plan.record?.reviewer_lane !== QUEUE_CONFIG_REVIEWER) {
    refuse("CARD_RUN_REVIEWER", `a queue config review is judged by ${QUEUE_CONFIG_REVIEWER}, not ${plan?.record?.reviewer_lane ?? "no reviewer"}`);
  }
  return plan;
}

// One claim per head, ever. The name never matches landedByTimer's, so a
// review can never read as a landed card.
export const reviewClaim = (paths, pr, head) => path.join(paths.stateDir, `card-review-auto-pr${pr}-${head}.json`);
const REVIEW_CLAIM_RE = /^card-review-auto-pr([1-9]\d*)-([0-9a-f]{40})\.json$/;

// The heads of this pull request already claimed, and how many claims count
// against this revision's cap. A claim that does not clearly name another
// revision counts: it may be this one's.
function reviewClaims(io, paths, pr, revision) {
  const heads = new Set();
  let atRevision = 0;
  for (const file of io.fs.readdirSync(paths.stateDir)) {
    const match = REVIEW_CLAIM_RE.exec(file);
    if (!match || Number(match[1]) !== pr) continue;
    heads.add(match[2]);
    let claim = null;
    try { claim = JSON.parse(io.fs.readFileSync(path.join(paths.stateDir, file), "utf8")); } catch { /* counted below */ }
    if (!(SHA_RE.test(claim?.revision ?? "") && claim.revision !== revision)) atRevision += 1;
  }
  return { heads, atRevision };
}

// GitHub as the coordinator's read-only token sees it, each read bounded. Any
// answer but a readable 200 throws, and the caller skips.
function githubReader(io, credentials, timeoutMs) {
  const fetchBounded = boundedFetch(io, timeoutMs);
  return async (url) => {
    const response = await fetchBounded(url, { method: "GET", headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${credentials.GITHUB_TOKEN}`,
      "User-Agent": "shu-card-run", "X-GitHub-Api-Version": "2022-11-28" } });
    const json = await response.json();
    if (response.status !== 200 || json === null) refuse("CARD_RUN_REVIEW_UNREADABLE", `${url.replace("https://api.github.com", "")} cannot be read (HTTP ${response.status})`);
    return json;
  };
}

// The lowest-numbered candidate whose head is not claimed yet, or none. The
// list is read whole first, so a later pull request is never reviewed while
// an earlier one could not be read.
async function findQueueConfigPull({ io, credentials, repo, policy, paths, revision, timeoutMs }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) refuse("CARD_RUN_CONFIG", "pilot_repo must name one GitHub repository");
  const get = githubReader(io, credentials, timeoutMs);
  const api = `https://api.github.com/repos/${repo}`;
  const open = await get(`${api}/pulls?state=open&base=main&per_page=${GITHUB_PAGE}`);
  if (!Array.isArray(open) || open.length >= GITHUB_PAGE) refuse("CARD_RUN_REVIEW_UNREADABLE", "the open pull requests are not one readable page");
  const capped = [];
  const listed = open.filter((pull) => listedCandidate(pull, repo, policy.label)).sort((a, b) => a.number - b.number);
  for (const pull of listed) {
    const pr = pull.number;
    const head = pull.head.sha;
    const claims = reviewClaims(io, paths, pr, revision);
    if (claims.heads.has(head)) continue;
    if (claims.atRevision >= policy.maxHeadsPerPr) {
      capped.push(pr);
      continue;
    }
    const files = await get(`${api}/pulls/${pr}/files?per_page=${GITHUB_PAGE}`);
    const commits = await get(`${api}/pulls/${pr}/commits?per_page=${GITHUB_PAGE}`);
    const change = queueConfigChange(files, head, commits);
    if (!change.ok) continue;
    // The approved base is the merge base with main, as the coordinator's
    // own check of a review-only pull request reads it.
    const compare = await get(`${api}/compare/main...${head}`);
    const base = compare?.merge_base_commit?.sha;
    if (!SHA_RE.test(base ?? "") || base === head) continue;
    return { pull: { pr, head, base, files: change.files }, capped };
  }
  return { pull: null, capped };
}

// What a done queue's timer start does. One review at most per start; with no
// candidate it is the plain QUEUE_DONE skip it always was.
async function autoReview({ io, paths, limits, config, revision, done, skip }) {
  let policy;
  try { policy = resolveQueueConfigReview(config); } catch (error) { return skip("NOT_READY", `CARD_RUN_CONFIG: ${error.message}`); }
  if (!policy) return skip(done.skipped, done.reason);
  let found;
  try {
    const credentials = readCoordinatorCredentials(io, paths.coordinatorEnv);
    found = await findQueueConfigPull({ io, credentials, repo: config.pilot_repo, policy, paths, revision,
      timeoutMs: limits.reviewRequestTimeoutMs ?? CARD_RUN_LIMITS.reviewRequestTimeoutMs });
  } catch (error) {
    // Nothing was claimed, so the next timer start reads again.
    return skip("REVIEW_UNREADABLE", error.message);
  }
  if (!found.pull) {
    if (found.capped.length) return skip("REVIEW_CAP", `${done.reason}; pull request(s) #${found.capped.join(", #")} reached ${policy.maxHeadsPerPr} reviewed heads at ${revision}`);
    return skip(done.skipped, done.reason);
  }
  const { pr, head, base, files } = found.pull;
  const review = { pr, head, base, authorFamily: QUEUE_CONFIG_AUTHOR_FAMILY };
  let plan;
  try {
    plan = assertQueueConfigReviewer(planRun({ config, revision, now: io.now(), limits, review, cardId: policy.lane }));
  } catch (error) {
    return skip("NOT_READY", error.message);
  }
  // The owner may have paused while GitHub was read; the pause wins.
  const pausedNow = io.fs.existsSync(paths.pause);
  if (pausedNow) return skip("PAUSED", `${paths.pause} exists`);
  const claim = reviewClaim(paths, pr, head);
  const claimText = (fields) => `${JSON.stringify({ pr, head, base, revision, ...fields, files })}\n`;
  try {
    io.fs.writeFileSync(claim, claimText({ claimed_at: io.now().toISOString() }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return skip("ALREADY_REVIEWED", `pull request #${pr} at ${head} was already claimed: ${claim}`);
    throw error;
  }
  let result;
  try {
    result = await runCard({ io, paths, limits, review, trigger: "timer", cardId: policy.lane });
  } catch (error) {
    if (NOT_NOW.has(error.code)) {
      // Not now, so the head is given back for a later start.
      io.fs.unlinkSync(claim);
      const code = error.code === "CARD_RUN_LOCKED" ? "LOCKED" : "HOST_BUSY";
      return skip(code, error.message);
    }
    result = await notStarted({ io, paths, limits, error,
      result: { card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, review: { pr, head, base }, revision } });
  }
  let claimError = null;
  try {
    io.fs.writeFileSync(claim, claimText({ activation_id: result.activation_id, outcome: result.outcome }), { mode: 0o600 });
  } catch (error) {
    // The claim written before the run already stops a second review of this head.
    claimError = error.code ?? "CLAIM_WRITE_FAILED";
  }
  return { ...result, claim, ...(claimError ? { claim_error: claimError } : {}) };
}

// A run refused before arming: the claim stands and the owner hears it once.
async function notStarted({ io, paths, limits, error, result }) {
  const summary = { ok: false, ...result, trigger: "timer", outcome: "NOT_STARTED", reason: error.message,
    code: error.code ?? "CARD_RUN_ERROR", ticks: [], revert: null };
  let credentials = null;
  try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch { /* the report records the missing credentials */ }
  const report = await postRunReport({ io, credentials, result: summary, timeoutMs: limits.reportTimeoutMs });
  return { ...summary, report };
}

// Puts the timer on the host: the owner's one go. It never replaces units with
// other content; take the old ones off first.
export function installTimer(io, paths = CARD_RUN_PATHS, { node, module = CARD_RUN_MODULE } = {}) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  if (!path.isAbsolute(node ?? "") || !path.isAbsolute(module ?? "")) refuse("CARD_RUN_TIMER", "the node binary and the module need absolute paths");
  const units = [[AUTO_SERVICE, autoServiceUnit({ node, module })], [AUTO_TIMER, autoTimerUnit()]];
  for (const [name, text] of units) {
    const file = path.join(paths.unitDir, name);
    if (!io.fs.existsSync(file)) writeExclusive(io, file, text, 0o644);
    else if (io.fs.readFileSync(file, "utf8") !== text) refuse("CARD_RUN_TIMER", `${file} exists with other content; run timer-remove first`);
  }
  run(io, "systemctl", ["daemon-reload"]);
  run(io, "systemctl", ["enable", "--now", AUTO_TIMER]);
  const enabled = io.exec("systemctl", ["is-enabled", AUTO_TIMER]).stdout.trim();
  const active = io.exec("systemctl", ["is-active", AUTO_TIMER]).stdout.trim();
  if (enabled !== "enabled" || active !== "active") refuse("CARD_RUN_TIMER", `the timer reads ${enabled || "unknown"}/${active || "unknown"} after install`);
  return { installed: true, units: units.map(([name]) => path.join(paths.unitDir, name)), enabled, active };
}

// Takes the timer off. It refuses while a run the timer started is still going:
// stopping that service would kill the run before its revert.
export function removeTimer(io, paths = CARD_RUN_PATHS) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  const state = io.exec("systemctl", ["is-active", AUTO_SERVICE]).stdout.trim();
  if (["active", "activating", "deactivating", "reloading"].includes(state)) {
    refuse("CARD_RUN_TIMER_BUSY", `${AUTO_SERVICE} is ${state}: wait for the run to finish; ${paths.pause} stops new ones`);
  }
  // The unit files stay until the timer reads back disabled and inactive, so a
  // failed disable or readback can be retried rather than leave an enabled
  // timer with no files. A retry after the timer file is gone skips the
  // disable, which would fail on a missing unit.
  const timerFile = path.join(paths.unitDir, AUTO_TIMER);
  if (io.fs.existsSync(timerFile)) run(io, "systemctl", ["disable", "--now", AUTO_TIMER]);
  const timerEnabled = io.exec("systemctl", ["is-enabled", AUTO_TIMER]).stdout.trim();
  const timerActive = io.exec("systemctl", ["is-active", AUTO_TIMER]).stdout.trim();
  if (!["disabled", "not-found"].includes(timerEnabled) || timerActive !== "inactive") {
    refuse("CARD_RUN_TIMER", `${AUTO_TIMER} reads ${timerEnabled || "unknown"}/${timerActive || "unknown"} after disable; its unit files stay`);
  }
  const failed = [];
  for (const name of [AUTO_TIMER, AUTO_SERVICE]) {
    const file = path.join(paths.unitDir, name);
    if (!io.fs.existsSync(file)) continue;
    try {
      io.fs.unlinkSync(file);
    } catch (error) {
      failed.push(`${file} (${error.code ?? error.message})`);
    }
  }
  run(io, "systemctl", ["daemon-reload"]);
  const left = [AUTO_TIMER, AUTO_SERVICE].map((name) => path.join(paths.unitDir, name)).filter((file) => io.fs.existsSync(file));
  if (failed.length || left.length) refuse("CARD_RUN_TIMER", `still present: ${[...new Set([...failed, ...left])].join(", ")}`);
  return { removed: true };
}

export const defaultIO = Object.freeze({
  fs,
  uid: () => process.getuid(),
  now: () => new Date(),
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  exec: (file, args) => {
    const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
});

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "run", "auto", "timer-install", "timer-remove"].includes(command)) {
    refuse("CARD_RUN_USAGE", "usage: card-run.mjs plan|run [--review-pr N --review-head SHA --review-base SHA --author-family codex|claude|hermes] | auto | timer-install | timer-remove");
  }
  if (!["plan", "run"].includes(command) && rest.length) refuse("CARD_RUN_USAGE", `${command} takes no flags`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--(review-pr|review-head|review-base|author-family)$/.test(rest[i] ?? "") || rest[i + 1] === undefined) refuse("CARD_RUN_USAGE", `unknown or empty flag ${rest[i]}`);
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  const keys = Object.keys(flags);
  if (keys.length && keys.length !== 4) refuse("CARD_RUN_USAGE", "a review run needs all four review flags");
  const review = keys.length ? { pr: Number(flags["review-pr"]), head: flags["review-head"], base: flags["review-base"], authorFamily: flags["author-family"] } : null;
  return { command, review };
}

export async function main(argv, io = defaultIO, paths = CARD_RUN_PATHS) {
  try {
    const { command, review } = parseArgs(argv);
    if (command === "plan") {
      const revision = installedRevision(io, paths);
      const config = readConfig(io, paths);
      // What the run would do to the card and its branch, read only.
      const dryPrepare = async (plan) => {
        try {
          const credentials = readCoordinatorCredentials(io, paths.coordinatorEnv);
          return await prepareRun({ io, plan, revision, repo: config.pilot_repo, checkout: paths.checkout, credentials, apply: false });
        } catch (error) {
          return { refused: error.code ?? "CARD_RUN_ERROR", reason: error.message };
        }
      };
      const queue = cardQueue(config);
      if (!queue.queue) {
        const plan = planRun({ config, revision, now: io.now(), review });
        return { code: 0, output: { ...plan, busy: busyReasons(io, paths), prepare: await dryPrepare(plan) } };
      }
      // SHU-312: the card the next timer start would run, and a dry run of
      // every queued card's preparation from main as it is now.
      if (review) refuse("CARD_RUN_REVIEW_INPUT", "a review run never comes from a card queue");
      const next = nextCard(io, paths, config, revision);
      const queued = [];
      for (const id of queue.ok ? queue.ids : []) {
        const plan = planRun({ config, revision, now: io.now(), cardId: id });
        queued.push({ id, prepare: await dryPrepare(plan) });
      }
      const nextPlan = next.id ? planRun({ config, revision, now: io.now(), cardId: next.id }) : {};
      return { code: 0, output: { ...nextPlan, queue: queue.ids, next, busy: busyReasons(io, paths),
        ...(next.id ? { prepare: queued.find((entry) => entry.id === next.id).prepare } : {}), queued } };
    }
    if (command === "timer-install") return { code: 0, output: installTimer(io, paths, { node: io.nodePath?.() ?? process.execPath }) };
    if (command === "timer-remove") return { code: 0, output: removeTimer(io, paths) };
    if (command === "auto") {
      const result = await autoRun({ io, paths });
      return { code: result.skipped || (result.ok && result.revert?.reverted) ? 0 : 1, output: result };
    }
    // A queue keeps its order only through the timer's claims, so it is run by
    // the timer alone.
    if (cardQueue(readConfig(io, paths)).queue) refuse("CARD_RUN_SCOPE", "a card queue is run by the card-run timer, never by hand");
    const result = await runCard({ io, paths, review });
    return { code: result.ok && result.revert.reverted ? 0 : 1, output: result };
  } catch (error) {
    return { code: 2, output: { ok: false, code: error.code ?? "CARD_RUN_ERROR", reason: error.message } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, output } = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = code;
}

