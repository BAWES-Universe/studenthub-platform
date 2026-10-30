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
// only; merging and installing stay with people. An invalid or paused queue
// never reviews (a stopped one did not either, until M16 below), and a GitHub
// read that fails claims nothing.
//
// SHU-322: before that review, a QUEUE_DONE start installs the next card
// queue itself when main commits one inside the autopilot boundary
// (service/card-install.mjs): reviewed queue data only, never coordinator
// code. It reports and exits; the next start runs the new queue's first card.
//
// M16: a QUEUE_STOPPED start does the same as a QUEUE_DONE one: Card B
// installs a reviewed queue (or, with code_self_install on, reviewed
// coordinator code) that main commits, else Card A reviews one labelled pull
// request, under the same once-per-head claims and caps. A stopped queue then
// waits for no person: the re-cut queue that replaces its stopped card is
// reviewed, merged and installed by the box. With nothing to install or
// review it is the plain QUEUE_STOPPED skip, with its reason. An invalid or
// paused queue still never reviews. And the revert no longer waits forever on
// leftover worker processes: after the grace it stops them (see revert).
//
// Self-repair B2: with the committed `landing_repair` switch on (absent or
// false is today's behaviour), a card whose run passed and stopped on red
// checks (PR_OPENED_CI_RED) is not a stopped queue on the next start: that
// start runs one landing repair of its pull request (card-repair.mjs), once
// per revision, recorded in card-repair-<rev>-<id>.json before arming. A
// repair that merged lands the card (card-landed.mjs); any other ending stops
// the queue as before, and a round that never finished is REPAIR_INTERRUPTED.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateActivationRecord, cardQueue, MAX_ACTIVATION_WINDOW_MS, MAX_CARD_QUEUE, REPAIR_MAX_ROUNDS } from "../single-run-activation.mjs";
import { MAX_CARD_WORKERS, cardWorkers, workerActivationFile, supervisorUnitName, coordinatorUnitName } from "./credential-delivery.mjs";
import { resolveFixtureLane, resolveReviewOnlyLane, resolveQueueConfigReview } from "../workspace-scope.mjs";
import { familyForLane } from "../launch-vocabulary.mjs";
import { prepareRun, postRunReport, readCoordinatorCredentials, retryableRefusal, COORDINATOR_ENV } from "./card-prepare.mjs";
import { landCard, readLandToken, boundedFetch, github, updatedHeadHolds, clearStaleLock, CARD_LAND_ENV, LAND_LIMITS, LAND_LOCK } from "./card-land.mjs";
import { cardLanded } from "./card-landed.mjs";
import { threadReviewer } from "./card-threads.mjs";
import { selfInstall, RUNTIME_TEST_MODULES, INSTALL_LOCK } from "./card-install.mjs";
import { WORKSPACE_STATE_DIR, workerWorkspaceStateDir, SUPERVISOR_STORE_DIRNAME, workerUnitsFromInstalled } from "./units.mjs";
import { createWatch, parseWatchLine } from "./card-watch.mjs";
import { createStatus, needsOwner, ownerMention } from "./card-status.mjs";
import { readVelocity } from "./card-velocity.mjs";
import { readRunUsage, hostSnapshot } from "./card-usage.mjs";
import { landingRepairOn, repairCandidate, repairRecordPath, repairAlertPath, repairActivationId, readRound, claimRound, advanceRound,
  repairSkip, readRepairPull, priorPass, readRepairEvidence, REPAIR_LIMITS } from "./card-repair.mjs";

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
  // M15 W4: the one landing lock every worker merges under.
  landLock: LAND_LOCK,
  // M15 W5: the one install lock; no card run starts while it is held.
  installLock: INSTALL_LOCK,
});
// M15: card workers. Worker 1 is today's single card run and keeps its paths
// exactly. Worker N > 1 has its own lock and activation; the state folder,
// where every card's once-per-revision claim lives, stays shared, so a claim
// written by one worker is the claim every worker sees. Only the count in
// config.json (workers.max, default 1) turns more workers on. The count and the
// activation paths live in credential-delivery.mjs, which the coordinator tick
// and the units read too.
export { MAX_CARD_WORKERS, cardWorkers };
// M15 W5: `base` is worker 1's paths, CARD_RUN_PATHS on the host.
export function cardRunPaths(worker = 1, base = CARD_RUN_PATHS) {
  if (!Number.isInteger(worker) || worker < 1 || worker > MAX_CARD_WORKERS) refuse("CARD_RUN_WORKER", `worker must be 1 to ${MAX_CARD_WORKERS}`);
  if (worker === 1) return base;
  return Object.freeze({ ...base, worker, activation: workerActivationFile(worker),
    lock: `/run/lock/shu-card-run-w${worker}.lock` });
}
export const workerOf = (paths) => paths.worker ?? 1;
// Another worker's run of this card is still going: its claim has no outcome
// yet, it names that worker, and that worker's run lock is held or the process
// that wrote the claim is still alive (the lock is released before the run
// report is posted and the outcome written, and taken after the claim).
function claimLive(io, paths, ran) {
  if (!ran || ran.outcome !== undefined || !Number.isInteger(ran.worker) || ran.worker === workerOf(paths)) return false;
  try {
    if (io.fs.existsSync(cardRunPaths(ran.worker).lock)) return true;
    return Number.isInteger(ran.pid) && ran.pid > 0 && io.fs.existsSync(`/proc/${ran.pid}`);
  } catch { return false; }
}
export const UNITS = Object.freeze(["shu-supervisor.service", "shu-coordinator.service"]);
// M15 W2: the supervisor and coordinator a worker arms, ticks and reverts.
// Worker 1's are UNITS.
export function workerUnits(worker = 1) {
  return worker === 1 ? UNITS : Object.freeze([supervisorUnitName(worker), coordinatorUnitName(worker)]);
}
export const RUN_DROP_IN = "95-v1-run.conf";
export const TARGET_DROP_IN = "96-v1-target.conf";
export const RESIDENT_DROP_IN = "90-shu71.conf";
export const runDropIn = () => "[Service]\nEnvironment=ENABLE_DISPATCH=true\n";
export const targetDropIn = (sha) => `[Service]\nEnvironment=DISPATCH_TARGET_SHA=${sha}\n`;
export const CARD_RUN_LIMITS = Object.freeze({
  runMs: 5 * 60 * 60 * 1000,
  tickIntervalMs: 60 * 1000,
  workerGraceMs: 30 * 60 * 1000,
  workerPollMs: 30 * 1000,
  killWaitMs: 10 * 1000,
  // M15 W3: with more than one worker, a revert removes only dependency caches
  // older than this: twice the install's own bound (attempt-workspace.mjs
  // DEPENDENCY_INSTALL_TIMEOUT_MS, 15 minutes), so another worker's install is
  // never left without its cache.
  npmCacheAgeMs: 30 * 60 * 1000,
  reportTimeoutMs: 30 * 1000,
  // SHU-306: landing a passed card. The wait for its checks is bounded so the
  // whole run (window, worker grace, landing, reports) stays inside the unit's
  // TimeoutStartSec. CI on a card pull request takes about 55 minutes
  // (SHU-353, SHU-354), so the wait allows 75.
  landWaitMs: 75 * 60 * 1000,
  landPollMs: 60 * 1000,
  landRequestTimeoutMs: 30 * 1000,
  // SHU-321: each GitHub read of the queue config review's discovery.
  reviewRequestTimeoutMs: 30 * 1000,
  // Self-watch 0b: each journalctl read a tick runs is bounded, so a hung
  // journal ends the run as an ERROR instead of holding it forever. The
  // `systemctl start` itself is not: the coordinator unit runs with
  // TimeoutStartSec=infinity so a tick is never cut midway, and killing only
  // the client would leave that tick running while the run reverts.
  tickCallTimeoutMs: 10 * 60 * 1000,
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
// M15 W5: card worker N > 1 has its own service and timer, on the same
// schedule, starting `auto --worker N`; each start takes the next card no
// other worker holds (nextCard). Worker 1's units are as they were.
export const autoServiceName = (worker = 1) => (worker === 1 ? AUTO_SERVICE : `shu-card-run-w${worker}.service`);
export const autoTimerName = (worker = 1) => (worker === 1 ? AUTO_TIMER : `shu-card-run-w${worker}.timer`);
export function autoServiceUnit({ node, module, worker = 1 }) {
  return [
    "[Unit]",
    `Description=StudentHub card run${worker === 1 ? "" : `, card worker ${worker}`}: the committed card, at most once per installed revision`,
    "[Service]",
    "Type=oneshot",
    "User=root",
    `ExecStart=${node} ${module} auto${worker === 1 ? "" : ` --worker ${worker}`}`,
    "TimeoutStartSec=8h",
    "",
  ].join("\n");
}
export function autoTimerUnit(worker = 1) {
  return [
    "[Unit]",
    `Description=Every half hour, run the installed revision's card if it has not run yet${worker === 1 ? "" : `, as card worker ${worker}`}`,
    "[Timer]",
    `OnCalendar=${AUTO_SCHEDULE}`,
    `Unit=${autoServiceName(worker)}`,
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

// Self-repair B2: the record a landing repair arms. It is the card's own
// record at this revision (the card lane's writer and reviewer, the run
// window), with a deterministic id, the failed head as its approved input,
// and the B1 repair keys: the pull request, the episode that passed, the
// filtered CI findings and their digest, and one round.
//
// M15: a claim whose landing updated the pull request from main before it
// stopped (updated_head) is repaired at that head: the PASS stays the
// reviewed head's (initial_target_sha), the record names the updated head as
// repair_head, and the failing checks and the one revise are at it.
export function planRepair({ config, revision, now, limits = CARD_RUN_LIMITS, id, claim, evidence }) {
  const base = planRun({ config, revision, now, limits, cardId: id });
  if (base.kind !== "card") refuse("CARD_RUN_NOT_A_CARD", `${id} is not a card lane; only a card's landing is repaired`);
  const failed = failedHead(claim);
  const record = { ...base.record, activation_id: repairActivationId(id, revision), initial_target_sha: claim.reviewed_head,
    repair_pr: claim.pr, repair_of: claim.activation_id, repair_findings: evidence.findings,
    repair_evidence_digest: evidence.digest, max_rounds: REPAIR_MAX_ROUNDS, ...(failed !== claim.reviewed_head ? { repair_head: failed } : {}) };
  const shape = validateActivationRecord(record);
  if (!shape.ok) refuse("CARD_RUN_RECORD", shape.reason);
  return { ...base, record, repair: { pr: claim.pr, failed_head: failed, repair_of: claim.activation_id,
    check_runs: evidence.check_runs } };
}

// M15: the head a stopped landing left its pull request at: the head a
// landing updated it to from main, else the reviewed head.
const failedHead = (claim) => (SHA_RE.test(claim?.updated_head ?? "") && claim.updated_head !== claim.reviewed_head ? claim.updated_head : claim.reviewed_head);

// Self-repair B2: everything a repair does before its round record exists,
// then the record. Each step that fails is a named skip that writes nothing:
// the claim must still be this card's passed, red-stopped run; its pull
// request must be the claimed one, open, at the head the review passed; the
// PASS on the card must be that claim's episode at that head (prior-PASS
// provenance); the failing checks' evidence must be readable and non-empty;
// and the pause file is read again last. Only then is the record written,
// exclusively, so a second round can never start at this revision.
export async function claimRepair({ io, paths, limits = CARD_RUN_LIMITS, config, revision, id, claim, holder = null }) {
  if (!landingRepairOn(config)) repairSkip("REPAIR_NOT_ELIGIBLE", "landing_repair is not on in the committed config");
  const repo = config.pilot_repo ?? null;
  if (!repairCandidate(claim, { id, revision, repo })) {
    repairSkip("REPAIR_NOT_ELIGIBLE", `${id}'s claim at ${revision} is not a passed run of ${repo ?? "the pilot repository"} stopped on red checks`);
  }
  let credentials;
  try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch (error) {
    repairSkip("REPAIR_UNREADABLE", `the coordinator's credentials cannot be read (${error.message})`);
  }
  const timeoutMs = limits.landRequestTimeoutMs ?? REPAIR_LIMITS.requestTimeoutMs;
  const branch = `coordinator/${id}`;
  // M15: an updated head is repaired only while it still holds exactly the
  // reviewed change, the rule the landing took it by.
  const failed = failedHead(claim);
  if (failed !== claim.reviewed_head) {
    const wrong = await updatedHeadHolds(github(boundedFetch(io, timeoutMs), credentials.GITHUB_TOKEN), { repo, passed: claim.reviewed_head, head: failed });
    if (wrong) repairSkip("REPAIR_NOT_ELIGIBLE", `${id}'s updated head ${failed} cannot be repaired: ${wrong}`);
  }
  await readRepairPull({ io, token: credentials.GITHUB_TOKEN, repo, number: claim.pr, branch, head: failed, timeoutMs });
  const pass = await priorPass({ fetchImpl: boundedFetch(io, timeoutMs), linearToken: credentials.LINEAR_API_TOKEN,
    actorIds: config.linear_receipt_actor_ids, card: id, repo, claim });
  const evidence = await readRepairEvidence({ io, token: credentials.GITHUB_TOKEN, repo, head: failed,
    limits: { ...REPAIR_LIMITS, requestTimeoutMs: timeoutMs } });
  let plan;
  try { plan = planRepair({ config, revision, now: io.now(), limits, id, claim, evidence }); } catch (error) {
    repairSkip("REPAIR_NOT_ELIGIBLE", error.message);
  }
  // The owner may have paused while GitHub and Linear were read; the pause wins.
  if (io.fs.existsSync(paths.pause)) repairSkip("PAUSED", `${paths.pause} exists`);
  const round = claimRound(io, repairRecordPath(paths, revision, id), {
    card: id, revision, activation_id: plan.record.activation_id, repair_of: claim.activation_id, repo, pr: claim.pr,
    reviewed_head: claim.reviewed_head, ...(failed !== claim.reviewed_head ? { failed_head: failed } : {}), pass_attempt_id: pass.attempt_id, check_runs: evidence.check_runs,
    evidence_digest: evidence.digest, evidence_truncated: evidence.truncated, claimed_at: io.now().toISOString(),
    // M15: which worker runs the round, so another worker passes it over while it runs.
    ...(cardWorkers(config) > 1 ? { worker: workerOf(paths), pid: process.pid } : {}) });
  if (holder) holder.round = round;
  return plan;
}

// Self-repair B2: card-prepare's repair input. A repair's card is checked by
// the coordinator's own repair predicate, never moved, and its branch is left
// at the pull request's head.
function repairPrepare(plan, config) {
  if (!plan.repair) return {};
  // The head repair eligibility binds: the pull request's own (M15: a
  // landing's update, when it made one).
  return { repair: { repair_pr: plan.record.repair_pr, initial_target_sha: plan.record.repair_head ?? plan.record.initial_target_sha,
    owners: Array.isArray(config.linear_callback_actor_ids) ? config.linear_callback_actor_ids : [] } };
}

// Whether a queued card landed: by a timer run's merge, or by a person's
// merge of the run's own pull request at its reviewed head (self-repair A,
// card-landed.mjs). GitHub is read with the coordinator's token, reads only;
// without it only a timer landing or a recorded hand landing counts.
export function landingReader(io, paths, config, limits = CARD_RUN_LIMITS) {
  let credentials = null;
  try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch { /* no GitHub reads */ }
  const gh = credentials?.GITHUB_TOKEN
    ? github(boundedFetch(io, limits.landRequestTimeoutMs ?? LAND_LIMITS.requestTimeoutMs), credentials.GITHUB_TOKEN) : null;
  return { repo: config.pilot_repo ?? null, gh, now: () => io.now() };
}

// Which card this start runs, decided once. A single committed card is itself
// (its once-per-revision claim is checked by the caller). A queue gives the
// first card a timer run has not landed, unless that card already ran at this
// revision: it did not land, so the queue stops there until a new install.
// A hand landing is proven from GitHub and, with `record`, written down.
export async function nextCard(io, paths, config, revision, { landing = null, record = false } = {}) {
  const queue = cardQueue(config);
  if (!queue.queue) return { id: null };
  if (!queue.ok) return { id: null, skipped: "NOT_READY", reason: `CARD_RUN_SCOPE: ${queue.reason}` };
  // M15: with more than one worker, a card another worker is running, or one
  // waiting on a queued card it builds on (after), is passed over rather than
  // stopping the queue. One worker walks the queue exactly as before.
  const parallel = cardWorkers(config) > 1;
  const landedIds = new Set();
  let waiting = 0;
  for (const id of queue.ids) {
    const landed = await cardLanded(io, paths, id, { ...(landing ?? {}), record });
    if (landed.landed) { landedIds.add(id); continue; }
    if (parallel && (queue.after?.[id] ?? []).some((need) => !landedIds.has(need))) { waiting += 1; continue; }
    const claim = autoClaim(paths, revision, id);
    if (!io.fs.existsSync(claim)) return { id };
    let ran = null;
    try { ran = JSON.parse(io.fs.readFileSync(claim, "utf8")); } catch { /* reported as unreadable */ }
    if (parallel && claimLive(io, paths, ran)) { waiting += 1; continue; }
    // Self-repair B2: only with landing_repair on, and only for a passed run
    // that stopped on red checks; otherwise nothing below differs from today.
    const repair = landingRepairOn(config) && repairCandidate(ran, { id, revision, repo: config.pilot_repo ?? null })
      ? repairStep(io, paths, revision, id, ran, parallel) : null;
    // M15: another worker's repair of this card that is still going.
    if (repair?.live) { waiting += 1; continue; }
    if (repair?.next) return repair.next;
    const how = ran ? `${ran.outcome ?? "no outcome"}${ran.land ? `, landing ${ran.land}` : ""}` : "an unreadable claim";
    const why = landed.reason ? `; hand landing not proven: ${landed.reason}` : "";
    return { id: null, skipped: "QUEUE_STOPPED", reason: `${id} ran at ${revision} and did not land (${how}): ${claim}${why}${repair?.note ?? ""}` };
  }
  if (waiting) return { id: null, skipped: "QUEUE_BUSY", reason: `every queued card that has not landed is running on another worker or waits on one` };
  return { id: null, skipped: "QUEUE_DONE", reason: `every queued card landed: ${queue.ids.join(", ")}` };
}

// Self-repair B2: what a repairable claim means for this start. No round
// record yet: run the repair. A round that finished: no second one, the queue
// stops as before. A round that never finished (a crash or a kill between its
// claim and its end): REPAIR_INTERRUPTED, a terminal stop for the owner.
function repairStep(io, paths, revision, id, claim, parallel = false) {
  const file = repairRecordPath(paths, revision, id);
  if (!io.fs.existsSync(file)) return { next: { id, repair: claim } };
  const round = readRound(io, file);
  // M15: with more than one worker, a round another worker is still running
  // (its run lock held, or the process that claimed it alive) is not an
  // interrupted one: the card is passed over like any card running elsewhere.
  if (parallel && round?.state !== "finished" && claimLive(io, paths, round)) return { live: true };
  if (round?.state !== "finished") {
    return { next: { id: null, card: id, skipped: "REPAIR_INTERRUPTED", repair_record: file,
      reason: `${id}'s landing repair at ${revision} never finished (${round ? `state ${round.state}` : "an unreadable record"}); it is never run again: ${file}` } };
  }
  return { note: `; its one landing repair finished (${round.outcome ?? "no outcome"}${round.land ? `, landing ${round.land}` : ""}): ${file}` };
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
// M15 W3: the worker's own. Its activation record and drop-ins are its own by
// name, and its shu-worker processes are those of its own cgroups (see
// processScope). Its hand-made build and review worktrees are its own by name
// too (workerWorktree): a run's own attempt worktrees under SHU_WORKTREE_ROOT
// are per attempt (a uuid each) and were never counted here.
export function busyReasons(io, paths = CARD_RUN_PATHS) {
  const reasons = [];
  if (io.fs.existsSync(paths.activation)) reasons.push(`activation record present at ${paths.activation}`);
  for (const unit of workerUnits(workerOf(paths))) {
    for (const dropIn of [RUN_DROP_IN, TARGET_DROP_IN]) {
      const file = path.join(paths.unitDir, `${unit}.d`, dropIn);
      if (io.fs.existsSync(file)) reasons.push(`dispatch drop-in present: ${file}`);
    }
  }
  const workers = workerCount(io, processScope(io, paths));
  if (workers !== 0) reasons.push(`${workers} shu-worker process(es) running`);
  const trees = io.fs.existsSync(paths.worktrees) ? io.fs.readdirSync(paths.worktrees) : [];
  const own = workerWorktree(workerOf(paths));
  for (const name of trees) if (own.test(name)) reasons.push(`worktree present: ${path.join(paths.worktrees, name)}`);
  return reasons;
}

// M15: which hand-made build and review worktrees under the worktree root are
// a worker's. Worker 1's are named as they always were (build-*, review-pr*),
// worker N's carry its number first (wN-build-*, wN-review-pr*), so worker 1's
// leave worker 2 idle and the other way round. hostBusyReasons, before an
// install, reads every worker's.
export function workerWorktree(worker = 1) {
  return worker === 1 ? /^(build-|review-pr)/ : new RegExp(`^w${worker}-(build-|review-pr)`);
}

// M15 W5: a held install lock, as a busy reason. One whose holder died is
// taken over and gone (card-land.mjs clearStaleLock); one kept on purpose,
// or held by a live install, stands.
function installing(io, paths) {
  const lock = paths.installLock ?? INSTALL_LOCK;
  if (!io.fs.existsSync(lock)) return [];
  return clearStaleLock(io, lock) === null ? [`install lock held: ${lock}`] : [];
}

// M15 W3: what keeps a self-install off the host. The install moves the
// checkout every worker runs from, so it waits for every configured worker:
// each one's busy reasons, and another worker's held run lock (a run that is
// still preparing has armed nothing yet). One worker: busyReasons, as before.
// This is a check, not a lock: a worker can still start just after it.
export function hostBusyReasons(io, paths = CARD_RUN_PATHS) {
  let workers = 1;
  try { workers = cardWorkers(readConfig(io, paths)); } catch { /* one worker */ }
  const self = workerOf(paths);
  if (self === 1 && workers === 1) return busyReasons(io, paths);
  const reasons = [];
  for (let worker = 1; worker <= Math.max(workers, self); worker += 1) {
    if (worker === self) { reasons.push(...busyReasons(io, paths)); continue; }
    const { activation, lock } = cardRunPaths(worker);
    const other = { ...paths, worker, activation, lock };
    if (io.fs.existsSync(lock)) reasons.push(`card run lock held: ${lock}`);
    reasons.push(...busyReasons(io, other));
  }
  return [...new Set(reasons)];
}

// M15 W3: which shu-worker processes are this worker's. With one worker
// (workers.max unset or 1) every one is, as before: null, and the count and
// kill go by uid. Otherwise only those in the cgroups of the worker's own
// supervisor and coordinator: a builder is the supervisor's child, its
// dependency install the coordinator tick's, and a process stays in its
// cgroup when it is reparented to PID 1 (the SHU-376 orphans). A config that
// cannot be read counts as one worker, so worker 1 then behaves as today.
export const CGROUP_ROOT = "/sys/fs/cgroup";
export function processScope(io, paths = CARD_RUN_PATHS) {
  let workers = 1;
  try { workers = cardWorkers(readConfig(io, paths)); } catch { /* one worker */ }
  if (workerOf(paths) === 1 && workers === 1) return null;
  return { units: workerUnits(workerOf(paths)) };
}

// The pids in the scope's cgroups. The cgroup is the one systemd reports for
// the unit, or its default place when the unit is not running (KillMode=process
// leaves a stopped supervisor's children there). Only the unified hierarchy
// is read: without it the worker's processes cannot be told apart, and the
// run refuses rather than count none.
function cgroupPids(io, scope) {
  if (!io.fs.existsSync(`${CGROUP_ROOT}/cgroup.controllers`)) refuse("CARD_RUN_CGROUP", `${CGROUP_ROOT} is not the unified cgroup hierarchy`);
  const pids = new Set();
  for (const unit of scope.units) {
    const reported = run(io, "systemctl", ["show", "-p", "ControlGroup", "--value", unit]).trim();
    const group = reported || `/system.slice/${unit}`;
    if (!/^(\/[A-Za-z0-9_.@:\\-]+)+$/.test(group) || group.split("/").includes("..")) refuse("CARD_RUN_CGROUP", `${unit} reports an unexpected cgroup`);
    let text;
    try { text = io.fs.readFileSync(`${CGROUP_ROOT}${group}/cgroup.procs`, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      refuse("CARD_RUN_CGROUP", `the cgroup of ${unit} cannot be read`);
    }
    for (const pid of String(text).split("\n").map((line) => line.trim())) if (/^[1-9]\d*$/.test(pid)) pids.add(pid);
  }
  return pids;
}

// The shu-worker pids of the scope: every one with no scope.
function workerPids(io, scope = null) {
  const result = io.exec("pgrep", ["-u", "shu-worker"]);
  if (result.status === 1) return [];
  if (result.status !== 0) refuse("CARD_RUN_COMMAND", `pgrep exited ${result.status}`);
  const pids = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!scope) return pids;
  const own = cgroupPids(io, scope);
  return pids.filter((pid) => own.has(pid));
}

function workerCount(io, scope = null) {
  return workerPids(io, scope).length;
}

// TERM or KILL to the scope's shu-worker processes: by uid with no scope, as
// before; otherwise each pid read from the worker's own cgroups just now.
function signalWorkers(io, scope, signal) {
  if (!scope) {
    io.exec("pkill", [`-${signal}`, "-u", "shu-worker"]);
    return;
  }
  const pids = workerPids(io, scope);
  if (pids.length) io.exec("kill", [`-${signal}`, "--", ...pids]);
}

function run(io, file, args, options = undefined) {
  const result = options ? io.exec(file, args, options) : io.exec(file, args);
  if (result.timedOut) refuse("CARD_RUN_COMMAND", `${file} ${args.slice(0, 3).join(" ")} timed out after ${options.timeoutMs} ms`);
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

function supervisorEnvironment(io, supervisor = UNITS[0]) {
  const pid = run(io, "systemctl", ["show", "-p", "MainPID", "--value", supervisor]).trim();
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
  // M15: with more than one worker the evidence broker is shared, and another
  // worker's revert may have stopped it after the start above; it is started
  // again once this worker's record is in place (see stopEvidence).
  if (processScope(io, paths)) run(io, "systemctl", ["start", "shu71-evidence.service"]);
  const target = plan.record.initial_target_sha;
  const units = workerUnits(workerOf(paths));
  for (const unit of units) {
    const dir = path.join(paths.unitDir, `${unit}.d`);
    if (!io.fs.existsSync(path.join(dir, RESIDENT_DROP_IN))) refuse("CARD_RUN_RESIDENT_DROP_IN", `${unit} has no ${RESIDENT_DROP_IN}`);
    writeExclusive(io, path.join(dir, RUN_DROP_IN), runDropIn(), 0o644);
    writeExclusive(io, path.join(dir, TARGET_DROP_IN), targetDropIn(target), 0o644);
  }
  run(io, "systemctl", ["daemon-reload"]);
  run(io, "systemctl", ["restart", units[0]]);
  const environ = supervisorEnvironment(io, units[0]);
  if (!environ.includes("ENABLE_DISPATCH=true") || !environ.includes(`DISPATCH_TARGET_SHA=${target}`)) {
    refuse("CARD_RUN_ARM_READBACK", "the supervisor did not come up with dispatch on at the target");
  }
  // M15 step 1: where the supervisor keeps its completion records, so the
  // report can sum what this run's workers spent. Not part of the result.
  const stateDir = environ.find((entry) => entry.startsWith("SHU_SUPERVISOR_STATE_DIR="))?.slice("SHU_SUPERVISOR_STATE_DIR=".length) ?? null;
  return { activation_id: plan.record.activation_id, target, revision, supervisor_state_dir: stateDir };
}

// One coordinator tick and its output. The coordinator is a oneshot, and
// systemd unloads a finished unit that nothing references, so its InvocationID
// is already gone when `systemctl start` returns: the first timer run read it
// empty and failed. The output is read from the journal instead: the unit's own
// lines since just before the start, flushed first, in full (json would
// otherwise null a field over 4096 bytes), and of those only the last
// invocation's, which is this tick's. No line at all is a refusal, never an
// earlier tick's output read as this one's. A worker ticks its own coordinator.
export function tick(io, limits = CARD_RUN_LIMITS, paths = CARD_RUN_PATHS) {
  const since = io.now().getTime();
  const bounded = { timeoutMs: limits.tickCallTimeoutMs ?? CARD_RUN_LIMITS.tickCallTimeoutMs };
  const coordinator = workerUnits(workerOf(paths))[1];
  run(io, "systemctl", ["start", coordinator]);
  run(io, "journalctl", ["--sync"], bounded);
  const raw = run(io, "journalctl", [`_SYSTEMD_UNIT=${coordinator}`, `--since=@${(since / 1000).toFixed(3)}`, "-o", "json", "--all", "--no-pager"], bounded);
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

// M15: the evidence broker every worker's run starts is one service. With one
// worker the revert stops it, as before. With more, a revert leaves it running
// while another worker's activation record is in place, and reads the records
// again after a stop, so a worker that armed meanwhile (it writes its record
// before it starts the broker) gets its broker back.
function otherArmed(io, paths) {
  return Array.from({ length: MAX_CARD_WORKERS }, (_, i) => i + 1)
    .some((worker) => worker !== workerOf(paths) && io.fs.existsSync(workerActivationFile(worker)));
}
function stopEvidence(io, paths, scope) {
  if (scope && otherArmed(io, paths)) return;
  run(io, "systemctl", ["stop", "shu71-evidence.service"]);
  if (scope && otherArmed(io, paths)) run(io, "systemctl", ["start", "shu71-evidence.service"]);
}

// Returns the run back to dispatch off. It waits a bounded time for workers to
// finish, because restarting the supervisor under a live worker loses its
// result.
//
// M16 (SHU-376): on 10-27 orphaned `npm test` trees, reparented to PID 1
// inside the worker's sandbox, outlived their run by three hours; every revert
// stopped at the grace with the host left armed, and so did the queue. The
// shu-worker user runs nothing but card work, and by the end of the grace the
// run's window and its episode are over, so what is still running is left
// over: the revert stops it (TERM, then KILL), records what it stopped and
// goes on. Only a process that survives KILL leaves the run armed, as before.
//
// M15 W2: the drop-ins, the supervisor restarted and the dispatch-off tick are
// the worker's own. W3: so are the shu-worker processes it waits for, counts
// and stops (processScope), and with more than one worker it removes only the
// dependency caches no install can still be using.
export function revert(io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS) {
  const units = workerUnits(workerOf(paths));
  const scope = processScope(io, paths);
  const waitUntil = io.now().getTime() + limits.workerGraceMs;
  let reaped = null;
  while (workerCount(io, scope) !== 0) {
    if (io.now().getTime() >= waitUntil) {
      reaped = reapWorkers(io, limits, scope);
      if (!reaped.cleared) return { reverted: false, code: "CARD_RUN_WORKER_STILL_RUNNING", reaped };
      break;
    }
    io.sleep(limits.workerPollMs);
  }
  for (const unit of units) {
    for (const dropIn of [RUN_DROP_IN, TARGET_DROP_IN]) {
      const file = path.join(paths.unitDir, `${unit}.d`, dropIn);
      if (io.fs.existsSync(file)) io.fs.unlinkSync(file);
    }
  }
  run(io, "systemctl", ["daemon-reload"]);
  run(io, "systemctl", ["restart", units[0]]);
  if (supervisorEnvironment(io, units[0]).includes("ENABLE_DISPATCH=true")) refuse("CARD_RUN_REVERT_READBACK", "dispatch is still on after revert");
  // Dispatch is already off here, so a failed dispatch-off tick is reported
  // and the rest of the cleanup still runs.
  let offTick;
  try { offTick = tickOutcome(tick(io, CARD_RUN_LIMITS, paths)).activation; }
  catch (error) { offTick = `tick failed: ${error.message}`; }
  stopEvidence(io, paths, scope);
  const killed = workerCount(io, scope);
  if (killed) {
    signalWorkers(io, scope, "TERM");
    io.sleep(limits.killWaitMs);
    signalWorkers(io, scope, "KILL");
  }
  if (workerCount(io, scope) !== 0) refuse("CARD_RUN_REVERT_READBACK", "shu-worker processes survived cleanup");
  // The record is retired last: until every step above succeeded it stays,
  // so the host reads busy and the next run refuses.
  let retired = null;
  if (io.fs.existsSync(paths.activation)) {
    retired = path.join(paths.stateDir, `spent-${stamp(io.now())}-shu71-activation${workerOf(paths) === 1 ? "" : `-w${workerOf(paths)}`}.json`);
    io.fs.renameSync(paths.activation, retired);
  }
  const cacheBefore = io.now().getTime() - (limits.npmCacheAgeMs ?? CARD_RUN_LIMITS.npmCacheAgeMs);
  for (const name of io.fs.readdirSync(paths.tmp)) {
    if (!/^shu-npm-cache-/.test(name)) continue;
    // Every worker's install makes its cache here under one name pattern, so
    // with more than one worker only a cache too old to be in use goes.
    const changed = scope ? cacheMtime(io, path.join(paths.tmp, name)) : null;
    if (scope && !(Number.isFinite(changed) && changed < cacheBefore)) continue;
    io.fs.rmSync(path.join(paths.tmp, name), { recursive: true, force: true });
  }
  return { reverted: true, code: null, dispatch_off_tick: offTick, retired, killed, ...(reaped ? { reaped } : {}) };
}

// M16: the shu-worker processes still running after the grace, named for the
// report (pid and process name only: a command line may carry a secret, and
// the report is posted on Linear), then stopped: TERM, a short wait, KILL for
// whatever is left. `pkill -u shu-worker` would also stop a box review or a
// suite run as that user; the revert only runs on the host its own run armed,
// which no other run shares (busyReasons keeps every other start off it), so
// they never overlap. `cleared` says none is left. A listing pgrep could not
// give (an exit other than 0 or 1) is `listed: false`, and the count is the
// one read just before, so the report never says a false zero.
// M15 W3: with more than one worker, only the worker's own (scope): the
// listing keeps the pids of its cgroups, and the signals go to those alone.
export const REAPED_LIST_MAX = 20;
function reapWorkers(io, limits, scope = null) {
  const running = workerCount(io, scope);
  const listing = io.exec("pgrep", ["-l", "-u", "shu-worker"]);
  const listed = listing.status === 0 || listing.status === 1;
  const own = scope && listing.status === 0 ? cgroupPids(io, scope) : null;
  const lines = listing.status === 0 ? String(listing.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !own || own.has(line.split(/\s+/)[0])) : [];
  const processes = lines.slice(0, REAPED_LIST_MAX).map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
  const signals = ["TERM"];
  signalWorkers(io, scope, "TERM");
  io.sleep(limits.killWaitMs);
  if (workerCount(io, scope) !== 0) {
    signals.push("KILL");
    signalWorkers(io, scope, "KILL");
    io.sleep(limits.killWaitMs);
  }
  const left = workerCount(io, scope);
  return { cleared: left === 0, listed, count: listed ? lines.length : running, processes, signals, left };
}

// One bounded card run: refuse unless idle and installed, arm, tick until the
// coordinator ends the episode or the window closes, then revert.
//
// Self-repair B2: `repair` (the claim being repaired) makes this the landing
// repair of that claim's pull request; `repairRound` receives its round record
// as soon as it is written, so the caller can finish it whatever happens.
export async function runCard({ io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS, review = null, trigger = "operator", cardId = null,
  repair = null, repairRound = null, claimedAt = null }) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  try { io.fs.writeFileSync(paths.lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { refuse("CARD_RUN_LOCKED", `${paths.lock} exists: another card run is in progress or crashed`); }
  let summary;
  let credentials;
  try {
    // M15 W5: looked for only once this run's own lock is held; see INSTALL_LOCK.
    const busy = [...installing(io, paths), ...busyReasons(io, paths)];
    if (busy.length) refuse("CARD_RUN_HOST_BUSY", busy.join("; "));
    const revision = installedRevision(io, paths);
    const config = readConfig(io, paths);
    const planned = repair ? await claimRepair({ io, paths, limits, config, revision, id: cardId, claim: repair, holder: repairRound })
      : planRun({ config, revision, now: io.now(), review, limits, cardId });
    credentials = readCoordinatorCredentials(io, paths.coordinatorEnv);
    const prepared = await prepareRun({ io, plan: planned, revision, repo: config.pilot_repo, checkout: paths.checkout, credentials,
      ...repairPrepare(planned, config) });
    const plan = prepared.branch ? onBase(planned, prepared.branch.head) : planned;
    const ticks = [];
    let result;
    let armedAt = null;
    let supervisorStateDir = null;
    let watch = null;
    // Self-watch 0e: where the run is, in a local file only; see card-status.mjs.
    // The invocation id ties the status to the unit start the outside watch
    // reads, so a run it alerted before this run wrote a status is matched.
    const invocation = typeof io.invocation === "function" ? io.invocation() : null;
    const status = createStatus({ io, paths, run: { run_id: plan.record.activation_id,
      invocation: /^[0-9a-f]{32}$/.test(invocation ?? "") ? invocation : null, card: plan.id, kind: plan.kind, trigger, revision,
      queue: (config.dispatch_scope?.issue_ids ?? []).filter((id) => typeof id === "string") } });
    const progress = () => {
      const seen = watch ? watch.summary(io.now().getTime()) : null;
      return { ticks: ticks.length, last_tick_at: ticks.at(-1)?.at ?? null, armed_at: armedAt, watching: watch !== null,
        first_dispatch_at: seen?.first_dispatch_at ?? null, last_progress_at: seen?.last_progress_at ?? null };
    };
    try {
      // Self-repair B2: the round says it may be armed before anything is.
      if (repairRound?.round) advanceRound(io, repairRound.round, "armed", { arming_at: io.now().toISOString() });
      const { supervisor_state_dir: armedStateDir, ...armed } = arm(io, plan, revision, paths);
      supervisorStateDir = armedStateDir;
      armedAt = io.now().toISOString();
      // Self-watch 0b, observe only: the committed config turns it on; it
      // records progress and never changes how the run ends.
      if (config.watch?.observe === true) watch = createWatch({ armedAt: Date.parse(armedAt), limits: config.watch });
      status.write({ step: "armed", ...progress() });
      const deadline = Date.parse(plan.record.expires_at);
      for (;;) {
        // Never start a tick once the window has closed, including the first:
        // arming itself can outlast it.
        if (io.now().getTime() >= deadline) {
          result = { ok: false, outcome: "EXPIRED", reason: `the run window closed at ${plan.record.expires_at}` };
          break;
        }
        const startedAt = io.now().toISOString();
        const output = tick(io, limits, paths);
        const outcome = tickOutcome(output, plan.record.activation_id);
        ticks.push({ at: startedAt, activation: outcome.activation, eligible: outcome.eligible });
        // Observing reads only the tick's own output: no request and no wait,
        // so it never moves a tick, the window's end, revert or landing. Every
        // tick is observed and recorded before the run decides whether it
        // ends. A tick that ends the run no longer reports the activation
        // armed and so prints no watch line; that is no failed read.
        const seen = watch ? parseWatchLine(output, { card: plan.id, activationId: plan.record.activation_id }) : null;
        if (watch && (seen !== null || !outcome.ended)) watch.observe(io.now().getTime(), seen);
        status.write({ step: "ticking", ...progress() });
        if (outcome.ended) {
          result = { ok: ANSWERED.has(outcome.outcome), outcome: outcome.outcome, reason: outcome.reason };
          break;
        }
        // On the first tick nothing has started yet, so the card being
        // excluded is real and no later tick changes it: stop now rather than
        // sit armed until the window closes, even while other cards are
        // eligible but outside the run's scope.
        const targetExcluded = outcome.excluded.filter((line) => line.startsWith(`EXCLUDED ${plan.id} `));
        if (ticks.length === 1 && (outcome.eligible === 0 || targetExcluded.length > 0)) {
          result = { ok: false, outcome: "NOT_ELIGIBLE", reason: (targetExcluded.length > 0 ? targetExcluded : outcome.excluded).join("; ") || "no eligible work" };
          break;
        }
        // Awaited, so a host io whose wait is asynchronous lets other work go
        // on meanwhile; the host's own wait blocks as before.
        await io.sleep(limits.tickIntervalMs);
      }
      result = { ...result, ...armed };
    } catch (error) {
      result = { ok: false, outcome: "ERROR", reason: error.message, code: error.code ?? "CARD_RUN_ERROR" };
    }
    // The run itself ends here; revert and landing are timed by their own steps.
    const finishedAt = armedAt === null ? null : io.now().toISOString();
    status.write({ step: "reverting", ...progress(), outcome: result.outcome });
    let reverted;
    try { reverted = revert(io, paths, limits); }
    catch (error) { reverted = { reverted: false, code: error.code ?? "CARD_RUN_ERROR", reason: error.message }; }
    // SHU-306: a passed card lands its own work, still under the lock, and only
    // once the revert has put the host back to dispatch off.
    let land = null;
    if (plan.kind === "card" && result.outcome === "PASS" && reverted.reverted === true) {
      status.write({ step: "landing", ...progress(), outcome: result.outcome });
      land = await landRun({ io, paths, limits, plan, config, credentials });
    }
    // Velocity: the merge time, taken as the landing returns, before the report.
    const landedAt = land?.outcome === "MERGED" ? io.now().toISOString() : null;
    // Self-watch 0a: when the run armed, ticked and finished, so real run
    // lengths can be read back from the claims.
    const timing = { armed_at: armedAt, first_tick_at: ticks[0]?.at ?? null, last_tick_at: ticks.at(-1)?.at ?? null,
      finished_at: finishedAt, landed_at: landedAt };
    summary = { card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, trigger, revision, prepared, ...result, ticks, revert: reverted,
      timing, ...(watch ? { watch: watch.summary(finishedAt === null ? null : Date.parse(finishedAt)) } : {}), ...(land ? { land } : {}),
      ...(plan.repair ? { repair: plan.repair } : {}), ...(plan.kind === "review" ? { review: { pr: review.pr, head: review.head, base: review.base } } : {}),
      owner_mention: ownerMention(config.owner_mention) };
    summary.needs_owner = needsOwner(summary);
    // Velocity: what the box has landed lately, this run included when the
    // timer started it (an operator run is a person's, and leaves no claim to
    // count later). Best effort: a state directory that cannot be read leaves it out.
    try {
      summary.velocity = readVelocity(io, paths.stateDir, { current: plan.kind === "card" && trigger === "timer"
        ? { card: plan.id, landed: land?.outcome === "MERGED", claimed_at: claimedAt } : null });
    } catch { /* the report goes out without it */ }
    // M15 step 1: what this card's worker runs spent, and how full the box is.
    // Best effort, like velocity: anything unreadable is left out.
    try {
      if (plan.kind === "card" && supervisorStateDir?.startsWith("/")) {
        const usage = readRunUsage(io, supervisorStateDir, { issue: plan.id, from: claimedAt ?? armedAt, to: io.now().toISOString() });
        if (usage?.length) summary.usage = usage;
      }
    } catch { /* the report goes out without it */ }
    try { summary.host = hostSnapshot(io, paths.stateDir); } catch { /* the report goes out without it */ }
    status.write({ step: "finished", ...progress(), outcome: summary.outcome, land: land?.outcome ?? null,
      reverted: reverted.reverted === true, needs_owner: summary.needs_owner });
    summary.status_write_failures = status.failures();
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
  // M10: the card's review lane, run through the reviewer sandbox, judges
  // review bot threads when the committed config turns that on.
  const adjudicate = config?.landing_thread_review?.enabled === true ? threadReviewer({ io, paths, plan }) : null;
  // M15 W4: with more than one worker the landing updates its pull request
  // from main and merges under the host-wide landing lock.
  return landCard({ io, plan, config, credentials, landToken: custody.token, pausePath: paths.pause, adjudicate,
    parallel: cardWorkers(config) > 1, landLock: paths.landLock ?? LAND_LOCK,
    limits: { ...LAND_LIMITS, waitMs: limits.landWaitMs ?? LAND_LIMITS.waitMs, pollMs: limits.landPollMs ?? LAND_LIMITS.pollMs,
      requestTimeoutMs: limits.landRequestTimeoutMs ?? LAND_LIMITS.requestTimeoutMs } });
}

function readConfig(io, paths) {
  return JSON.parse(io.fs.readFileSync(path.join(paths.checkout, ".github/coordinator/config.json"), "utf8"));
}

// When a dependency cache last changed, or null when it cannot be read (it is
// then kept: /tmp is reaped).
function cacheMtime(io, dir) {
  try { return io.fs.statSync(dir).mtimeMs; } catch { return null; }
}

// Refusals that mean "not now" rather than "this run went wrong": a later
// timer start may find the host free.
const NOT_NOW = Object.freeze(new Set(["CARD_RUN_LOCKED", "CARD_RUN_HOST_BUSY"]));

export const autoClaim = (paths, revision, id) => path.join(paths.stateDir, `card-run-auto-${revision}-${id}.json`);

// Self-heal: a timer start refused before arming on a read that may pass a
// moment later (card-prepare's retryableRefusal) does not spend the card's run
// at this revision: its claim is given back, so the next start tries again,
// instead of the queue stopping until a person installs a new revision
// (SHU-332, 2026-10-23: a GitHub ref-read lag held the queue 3.5 hours). Each
// give-back is one file, written exclusively like the claim, and at most
// REFUSED_START_RETRIES are ever written per card per revision; after that a
// refusal spends the run as it always did. A give-back that cannot be written,
// or a claim that cannot be removed, leaves the run spent.
export const REFUSED_START_RETRIES = 3;
export const refusedStartRecord = (paths, revision, id, n) => path.join(paths.stateDir, `card-run-retry-${revision}-${id}-${n}.json`);

function giveBackRun(io, paths, revision, id, claim, error) {
  if (!retryableRefusal(error)) return null;
  for (let n = 1; n <= REFUSED_START_RETRIES; n += 1) {
    try {
      io.fs.writeFileSync(refusedStartRecord(paths, revision, id, n), `${JSON.stringify({ card: id, revision, attempt: n,
        code: error.code ?? "CARD_RUN_ERROR", refused_at: io.now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (writeError.code === "EEXIST") continue;
      return null;
    }
    try { io.fs.unlinkSync(claim); } catch { return null; }
    return { attempt: n, of: REFUSED_START_RETRIES };
  }
  return null;
}

// What the timer starts. It runs the committed card at most once per installed
// revision: the claim is written before the run starts, so a crash or a
// refusal still counts as that revision's run and nothing loops (Self-heal:
// except a retryable refusal before arming, given back a bounded number of
// times; see giveBackRun). Every reason
// not to run is a skip that touches neither the host nor Linear.
export async function autoRun({ io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS }) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  const skip = (skipped, reason) => ({ ok: true, trigger: "timer", skipped, reason });
  if (io.fs.existsSync(paths.pause)) return skip("PAUSED", `${paths.pause} exists`);
  if (io.fs.existsSync(paths.lock)) return skip("LOCKED", `${paths.lock} exists`);
  // M15 W5: a worker's timer outlives a config that turns it off again.
  let workers = 1;
  try { workers = cardWorkers(readConfig(io, paths)); } catch { /* read again below */ }
  if (workerOf(paths) > workers) return skip("NOT_READY", `card worker ${workerOf(paths)} is off: workers.max is ${workers}`);
  const busy = [...installing(io, paths), ...busyReasons(io, paths)];
  if (busy.length) return skip("HOST_BUSY", busy.join("; "));
  let revision;
  let plan;
  let config;
  let done = null;
  let interrupted = null;
  let repairNext = null;
  let claim;
  let claimedAt;
  // M15: with more than one worker, selecting a card and claiming it are two
  // steps, so two workers starting together can pick the same card; the one
  // that loses the exclusive claim selects again (the winner's live claim is
  // then passed over) instead of giving up its start. One worker never loops.
  for (let selection = 1; ; selection += 1) {
    plan = undefined;
    try {
      revision = installedRevision(io, paths);
      config = readConfig(io, paths);
      const next = await nextCard(io, paths, config, revision, { landing: landingReader(io, paths, config, limits), record: true });
      // SHU-321: only a done queue may go on to review a queue config pull
      // request; an invalid or paused one never does. M16: a stopped queue
      // does what a done one does (Card B, then Card A).
      if (next.skipped === "QUEUE_DONE" || next.skipped === "QUEUE_STOPPED") done = next;
      // Self-repair B2: an interrupted repair is reported once; a repairable
      // card runs its one repair. Neither can come up with landing_repair off.
      else if (next.skipped === "REPAIR_INTERRUPTED") interrupted = next;
      else if (next.skipped) return skip(next.skipped, next.reason);
      else if (next.repair) repairNext = next;
      else plan = planRun({ config, revision, now: io.now(), limits, cardId: next.id });
    } catch (error) {
      // A review card needs its pull request from an operator, so the timer never
      // runs one; any other planning refusal waits for the next install.
      return skip("NOT_READY", error.message);
    }
    if (done) return afterQueueDone({ io, paths, limits, config, revision, done, skip });
    if (interrupted) return repairInterrupted({ io, paths, limits, config, revision, next: interrupted, skip });
    if (repairNext) return autoRepair({ io, paths, limits, config, revision, next: repairNext, skip });
    claim = autoClaim(paths, revision, plan.id);
    claimedAt = io.now().toISOString();
    try {
      io.fs.writeFileSync(claim, `${JSON.stringify({ card: plan.id, revision, claimed_at: claimedAt, worker: workerOf(paths), pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (cardWorkers(config) > 1 && selection < MAX_CARD_QUEUE) continue;
      return skip("ALREADY_RAN", `${plan.id} already ran at ${revision}: ${claim}`);
    }
  }
  let result;
  try {
    result = await runCard({ io, paths, limits, trigger: "timer", cardId: plan.id, claimedAt });
  } catch (error) {
    if (NOT_NOW.has(error.code)) {
      io.fs.unlinkSync(claim);
      return skip(error.code === "CARD_RUN_LOCKED" ? "LOCKED" : "HOST_BUSY", error.message);
    }
    // Refused before arming: nothing was armed, and the claim stands, so the
    // owner hears about it once instead of on every timer start. Self-heal: a
    // retryable refusal gives the run back instead, a bounded number of times.
    const retry = giveBackRun(io, paths, revision, plan.id, claim, error);
    result = await notStarted({ io, paths, limits, error, config,
      result: { card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, revision, ...(retry ? { retry } : {}) } });
    if (retry) return { ...result, claim: null };
  }
  // The claim written before the run already stops a second run at this
  // revision. If this write fails, a queue never sees the card as landed and
  // stops there (a later install refuses it again: its branch and card have
  // moved), so the failure is named in the output rather than lost.
  let claimError = null;
  try {
    // Self-watch 0a: the final claim keeps its claimed_at, adds the run's
    // timing, and records which pull request and which reviewed head a
    // landing worked on. Nothing reads these fields to decide anything yet.
    io.fs.writeFileSync(claim, `${JSON.stringify({ card: plan.id, revision, claimed_at: claimedAt, activation_id: result.activation_id,
      outcome: result.outcome, ok: result.ok, land: result.land?.outcome ?? null,
      armed_at: result.timing?.armed_at ?? null, first_tick_at: result.timing?.first_tick_at ?? null,
      last_tick_at: result.timing?.last_tick_at ?? null, finished_at: result.timing?.finished_at ?? null,
      // Velocity: when a merged landing was written down, for claim-to-merge times.
      landed_at: result.timing?.landed_at ?? null,
      repo: config.pilot_repo ?? null, pr: result.land?.pr ?? null, reviewed_head: result.land?.reviewed_head ?? null,
      // M15: the head a landing with more than one worker updated the pull
      // request to from main, when it did; a hand landing or a repair may
      // then go on from it (card-landed.mjs, updatedHeadHolds).
      ...(result.land?.updated_head ? { updated_head: result.land.updated_head } : {}),
      reverted: result.revert?.reverted ?? null,
      // Self-watch 0b: what the observe-only watch saw; null when it was off.
      first_dispatch_at: result.watch?.first_dispatch_at ?? null, last_progress_at: result.watch?.last_progress_at ?? null,
      max_progress_gap_ms: result.watch?.max_progress_gap_ms ?? null, would_stall: result.watch?.would_stall ?? null })}\n`, { mode: 0o600 });
  } catch (error) { claimError = error.code ?? "CLAIM_WRITE_FAILED"; }
  return { ...result, claim, ...(claimError ? { claim_error: claimError } : {}) };
}

// Self-repair B2: the one landing repair of a card, on the timer. Before its
// round record exists every stop is a skip that writes nothing, so the next
// start reads again. Once the record exists the round is this revision's one
// round, whatever happens: a refusal before arming is reported once, and the
// record is finished with the outcome. A record left unfinished (the process
// died) is REPAIR_INTERRUPTED on every later start.
async function autoRepair({ io, paths, limits, config, revision, next, skip }) {
  const id = next.id;
  const holder = { round: null };
  let result;
  try {
    result = await runCard({ io, paths, limits, trigger: "timer", cardId: id, repair: next.repair, repairRound: holder });
  } catch (error) {
    if (!holder.round) {
      if (NOT_NOW.has(error.code)) return skip(error.code === "CARD_RUN_LOCKED" ? "LOCKED" : "HOST_BUSY", error.message);
      if (error.repairSkip) return skip(error.code, error.message);
      return skip("NOT_READY", error.message);
    }
    const record = holder.round.record;
    result = await notStarted({ io, paths, limits, error, config,
      result: { card: id, kind: "card", activation_id: record.activation_id, revision,
        repair: { pr: record.pr, failed_head: record.failed_head ?? record.reviewed_head, repair_of: record.repair_of, check_runs: record.check_runs } } });
  }
  let roundError = null;
  try {
    advanceRound(io, holder.round, "finished", { finished_at: io.now().toISOString(), outcome: result.outcome ?? null, ok: result.ok === true,
      land: result.land?.outcome ?? null, repaired_head: result.land?.reviewed_head ?? null,
      ...(result.land?.updated_head ? { updated_head: result.land.updated_head } : {}), merge_commit: result.land?.merge_commit ?? null,
      armed_at: result.timing?.armed_at ?? null, reverted: result.revert?.reverted ?? null });
  } catch (error) { roundError = error.code ?? "ROUND_WRITE_FAILED"; }
  return { ...result, round: holder.round.file, ...(roundError ? { round_error: roundError } : {}) };
}

// Self-repair B2: a repair round that never finished. It is never run again;
// the owner hears about it once, through the run report and the status file
// the outside watch shows. The alert is recorded only once it is posted, so a
// report that could not be posted is tried again on a later start.
async function repairInterrupted({ io, paths, limits, config, revision, next, skip }) {
  const alerted = repairAlertPath(paths, revision, next.card);
  if (io.fs.existsSync(alerted)) return skip("REPAIR_INTERRUPTED", next.reason);
  const summary = { ok: false, card: next.card, kind: "card", activation_id: `${repairActivationId(next.card, revision)}-interrupted`,
    trigger: "timer", revision, outcome: "REPAIR_INTERRUPTED", reason: next.reason, ticks: [], revert: null,
    owner_mention: ownerMention(config.owner_mention) };
  summary.needs_owner = needsOwner(summary);
  const invocation = typeof io.invocation === "function" ? io.invocation() : null;
  createStatus({ io, paths, run: { run_id: summary.activation_id,
    invocation: /^[0-9a-f]{32}$/.test(invocation ?? "") ? invocation : null, card: next.card, kind: "card", trigger: "timer",
    revision, queue: (config?.dispatch_scope?.issue_ids ?? []).filter((id) => typeof id === "string") } })
    .write({ step: "finished", ticks: 0, last_tick_at: null, armed_at: null, outcome: "REPAIR_INTERRUPTED", land: null,
      reverted: false, needs_owner: summary.needs_owner });
  let credentials = null;
  try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch { /* the report records the missing credentials */ }
  const report = await postRunReport({ io, credentials, result: summary, timeoutMs: limits.reportTimeoutMs });
  let alertError = null;
  if (report.posted) {
    try {
      io.fs.writeFileSync(alerted, `${JSON.stringify({ card: next.card, revision, record: next.repair_record, alerted_at: io.now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) { alertError = error.code ?? "ALERT_WRITE_FAILED"; }
  }
  return { ...skip("REPAIR_INTERRUPTED", next.reason), needs_owner: summary.needs_owner, report, ...(alertError ? { alert_error: alertError } : {}) };
}

// SHU-321: once the committed queue is done, the timer may run the standing
// review-only card on one open queue config pull request, so a queue Claude
// wrote gets a Codex verdict at its exact head without a person running Codex.
// It reviews only; it never merges, installs or writes a branch. A candidate
// is open, not a draft, on main, a branch of the pilot repository, labelled,
// touches only queue config paths, edits the card contracts in place, and every
// commit carries a Claude-Session: trailer. Anything else is not a candidate:
// no claim and no report. Under the policy's code_label the same review covers
// a Claude-written change to the coordinator's own code: any path under
// .github/coordinator, with the same contracts and trailer rules. It still
// reviews only; Card B never installs coordinator code.
export const QUEUE_CONFIG_REVIEWER = "codex-verifier";
export const QUEUE_CONFIG_AUTHOR_FAMILY = "claude";
export const QUEUE_CONFIG_PATHS = Object.freeze([
  ".github/coordinator/config.json",
  ".github/coordinator/card-contracts.json",
  ".github/coordinator/card-contracts.mjs",
  ".github/coordinator/service/suite-inventory.json",
]);
// M16: the contracts data and its source. Card B admits only new cards in the
// data (card-install.mjs); here each is only ever edited in place.
const CONTRACTS_PATHS = Object.freeze([".github/coordinator/card-contracts.json", ".github/coordinator/card-contracts.mjs"]);
const SESSION_TRAILER_RE = /^Claude-Session: \S+$/m;
// One page of each list; a list that fills it may hide a file or a commit.
const GITHUB_PAGE = 100;

function queueConfigReview(config) {
  try { return resolveQueueConfigReview(config); } catch (error) { refuse("CARD_RUN_CONFIG", error.message); }
}

// One of the exact files, or any file under a test/ directory of the coordinator
// that no runtime module imports (card-install.mjs).
export function queueConfigPath(file) {
  if (typeof file !== "string" || !file.startsWith(".github/coordinator/") || RUNTIME_TEST_MODULES.includes(file)) return false;
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return QUEUE_CONFIG_PATHS.includes(file) || parts.slice(2, -1).includes("test");
}

// Any file of the coordinator's own tree.
export function coordinatorCodePath(file) {
  if (typeof file !== "string" || !file.startsWith(".github/coordinator/")) return false;
  return !file.split("/").some((part) => !part || part === "." || part === "..");
}

// What the open-pull-request list itself says: a branch of the pilot
// repository, open and ready, against main, with one of the given labels.
const hasLabel = (pull, label) => label !== null && Array.isArray(pull.labels) && pull.labels.some((entry) => entry?.name === label);
function listedCandidate(pull, repo, labels) {
  return Number.isInteger(pull?.number) && pull.number > 0 && pull.state === "open" && pull.base?.ref === "main"
    && pull.base?.repo?.full_name === repo && pull.draft === false && pull.head?.repo?.full_name === repo && SHA_RE.test(pull.head?.sha ?? "")
    && labels.some((label) => hasLabel(pull, label));
}

// The pull request's files and commits, judged whole. A renamed file counts
// under both names, so nothing leaves the allowlist by a rename, and the
// contracts are never added, removed or renamed.
export function queueConfigChange(files, head, commits, allowed = queueConfigPath) {
  if (!Array.isArray(files) || files.length === 0 || files.length >= GITHUB_PAGE) return { ok: false, reason: "its changed files are not one readable page" };
  if (!Array.isArray(commits) || commits.length === 0 || commits.length >= GITHUB_PAGE) return { ok: false, reason: "its commits are not one readable page" };
  if (commits.at(-1)?.sha !== head) return { ok: false, reason: "its head moved while it was read" };
  const blobs = {};
  for (const file of files) {
    const names = [file?.filename, ...(file?.previous_filename === undefined ? [] : [file.previous_filename])];
    if (!names.every(allowed)) return { ok: false, reason: `${String(file?.filename)} is not a ${allowed === queueConfigPath ? "queue config" : "coordinator"} path` };
    const contracts = CONTRACTS_PATHS.find((entry) => names.includes(entry));
    if (contracts && file.status !== "modified") return { ok: false, reason: `${contracts} may only be edited` };
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

// One claim per head, ever. The name never matches a card's claim, so a
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
  const labels = [policy.label, ...(policy.codeLabel ? [policy.codeLabel] : [])];
  const listed = open.filter((pull) => listedCandidate(pull, repo, labels)).sort((a, b) => a.number - b.number);
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
    let change = hasLabel(pull, policy.label) ? queueConfigChange(files, head, commits) : { ok: false };
    if (!change.ok && hasLabel(pull, policy.codeLabel)) change = queueConfigChange(files, head, commits, coordinatorCodePath);
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

// SHU-322: what a done (M16: or stopped) queue's timer start does. Card B
// first: when main commits a new, reviewed card queue, the start installs it,
// reports and exits, and the next start runs its first card. A refusal is
// claimed and reported once. With nothing to install, or a read that failed,
// the start goes on to the queue config review; a pause seen during the
// install never does.
async function afterQueueDone({ io, paths, limits, config, revision, done, skip }) {
  let install;
  try {
    install = await selfInstall({ io, paths, limits, config, revision, deps: { busyReasons: hostBusyReasons,
      cardLanded: async (hostIo, hostPaths, id) => (await cardLanded(hostIo, hostPaths, id, { ...landingReader(hostIo, hostPaths, config, limits), record: true })).landed } });
  } catch (error) {
    install = { skipped: "INSTALL_UNREADABLE", reason: error.message };
  }
  // 2026-10-21: the 13:30 start refused to install 34f603f8 (NEEDS_OWNER),
  // changed nothing and exited 1 with no status of its own, so the watch read
  // the failed unit as a run that died before its first write and paused the
  // timer, which then held the queue the owner had just installed by hand.
  // The status says this start finished, as a refused run's does (C44).
  // M11: a code install that put the installed revision back ends the same
  // way: nothing new runs, and the owner was told once by its report.
  if (["NEEDS_OWNER", "INSTALL_RESTORED"].includes(install.result?.outcome)) installRefusedStatus({ io, paths, config, result: install.result });
  if (install.result) return install.result;
  if (install.paused) return skip("PAUSED", install.reason);
  const review = await autoReview({ io, paths, limits, config, revision, done, skip });
  return install.skipped ? { ...review, install: { skipped: install.skipped, reason: install.reason } } : review;
}

// A refused self-install's finished status: no card, nothing armed, and the
// owner already told once by its report.
function installRefusedStatus({ io, paths, config, result }) {
  const invocation = typeof io.invocation === "function" ? io.invocation() : null;
  createStatus({ io, paths, run: { run_id: result.activation_id,
    invocation: /^[0-9a-f]{32}$/.test(invocation ?? "") ? invocation : null, card: null, kind: "install", trigger: "timer",
    revision: result.revision, queue: (config?.dispatch_scope?.issue_ids ?? []).filter((id) => typeof id === "string") } })
    .write({ step: "finished", ticks: 0, last_tick_at: null, armed_at: null, outcome: result.outcome, land: null,
      reverted: false, needs_owner: true });
}

// What a done or stopped queue's timer start does after Card B. One review at
// most per start; with no candidate it is the plain QUEUE_DONE or
// QUEUE_STOPPED skip it always was.
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
    // Nothing was claimed, so the next timer start reads again. M16: a
    // stopped queue stays the QUEUE_STOPPED skip, its reason first, and says
    // why nothing was reviewed.
    if (done.skipped === "QUEUE_STOPPED") return { ...skip(done.skipped, done.reason), review: { skipped: "REVIEW_UNREADABLE", reason: error.message } };
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
    result = await notStarted({ io, paths, limits, error, config,
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
async function notStarted({ io, paths, limits, error, config, result }) {
  const summary = { ok: false, ...result, trigger: "timer", outcome: "NOT_STARTED", reason: error.message,
    code: error.code ?? "CARD_RUN_ERROR", ticks: [], revert: null };
  // SHU-327, 2026-10-20: a refusal comes before the run's first status write,
  // and the watch reads a failed unit with no status since its start as a run
  // that died early, and pauses the timer; that pause then held the starts of
  // the install that fixed the refusal. The status says the run finished.
  const invocation = typeof io.invocation === "function" ? io.invocation() : null;
  createStatus({ io, paths, run: { run_id: summary.activation_id,
    invocation: /^[0-9a-f]{32}$/.test(invocation ?? "") ? invocation : null, card: summary.card, kind: summary.kind, trigger: "timer",
    revision: summary.revision, queue: (config?.dispatch_scope?.issue_ids ?? []).filter((id) => typeof id === "string") } })
    .write({ step: "finished", ticks: 0, last_tick_at: null, armed_at: null, outcome: "NOT_STARTED", land: null,
      reverted: false, needs_owner: needsOwner(summary) });
  let credentials = null;
  try { credentials = readCoordinatorCredentials(io, paths.coordinatorEnv); } catch { /* the report records the missing credentials */ }
  const report = await postRunReport({ io, credentials, result: summary, timeoutMs: limits.reportTimeoutMs });
  return { ...summary, report };
}

// Puts the timer on the host: the owner's one go. It never replaces units with
// other content; take the old ones off first.
//
// M15 W5: with workers.max above one in the installed config, it also puts
// each card worker N on the host before N's timer: N's supervisor and
// coordinator units, rendered from worker 1's installed pair (units.mjs
// workerUnitsFromInstalled: N's own workspace state directory, supervisor
// store, socket, writer lock and --activation path), N's workspace, store and
// activation directories (mode 0700, owned as worker 1's), and the resident
// drop-in of each of N's units (worker 1's bytes). Nothing is typed in by a
// person, and a code self-install, which never touches units, leaves them as
// they are. Worker 1's units are as before.
export function installTimer(io, paths = CARD_RUN_PATHS, { node, module = CARD_RUN_MODULE } = {}) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  if (!path.isAbsolute(node ?? "") || !path.isAbsolute(module ?? "")) refuse("CARD_RUN_TIMER", "the node binary and the module need absolute paths");
  const workers = cardWorkers(readConfig(io, paths));
  const all = Array.from({ length: workers }, (_, i) => i + 1);
  const units = all.flatMap((worker) => [[autoServiceName(worker), autoServiceUnit({ node, module, worker })], [autoTimerName(worker), autoTimerUnit(worker)]]);
  for (const [name, text] of units) {
    const file = path.join(paths.unitDir, name);
    if (io.fs.existsSync(file) && io.fs.readFileSync(file, "utf8") !== text) refuse("CARD_RUN_TIMER", `${file} exists with other content; run timer-remove first`);
  }
  const prepared = all.length > 1 ? prepareWorkers(io, paths, all.slice(1)) : [];
  for (const [name, text] of units) {
    const file = path.join(paths.unitDir, name);
    if (!io.fs.existsSync(file)) writeExclusive(io, file, text, 0o644);
  }
  run(io, "systemctl", ["daemon-reload"]);
  const states = [];
  for (const worker of all) {
    const timer = autoTimerName(worker);
    run(io, "systemctl", ["enable", "--now", timer]);
    const enabled = io.exec("systemctl", ["is-enabled", timer]).stdout.trim();
    const active = io.exec("systemctl", ["is-active", timer]).stdout.trim();
    if (enabled !== "enabled" || active !== "active") refuse("CARD_RUN_TIMER", `the timer ${timer} reads ${enabled || "unknown"}/${active || "unknown"} after install`);
    states.push({ enabled, active });
  }
  const [{ enabled, active }] = states;
  return { installed: true, units: units.map(([name]) => path.join(paths.unitDir, name)), enabled, active,
    ...(all.length > 1 ? { workers, prepared } : {}) };
}

// M15: the directories card worker N needs: its workspace state directory and
// supervisor store (its units name them), and the directory of its activation
// record (credential-delivery.mjs workerActivationFile).
export function workerDirectories(worker) {
  const workspace = workerWorkspaceStateDir(worker);
  return [path.dirname(workerActivationFile(worker)), workspace, path.join(workspace, SUPERVISOR_STORE_DIRNAME)];
}

// M15 W5: what card worker N needs on the host before its timer: its
// supervisor and coordinator units, its directories, and the resident drop-in
// of each of its units. Everything is checked before anything is made, and
// nothing that exists is changed: a unit, directory or drop-in that is not as
// it should be refuses. When making something fails part way, what this call
// made is taken off again, so a later timer-install starts clean. Returns what
// was made.
function prepareWorkers(io, paths, workers) {
  const stat = (file) => { try { return io.fs.lstatSync(file); } catch { return null; } };
  const owner = stat(WORKSPACE_STATE_DIR);
  if (!owner?.isDirectory() || owner.isSymbolicLink() || (owner.mode & 0o7777) !== 0o700) {
    refuse("CARD_RUN_TIMER", `${WORKSPACE_STATE_DIR}, worker 1's workspace state directory, is not a private directory`);
  }
  const resident = path.join(paths.unitDir, `${UNITS[0]}.d`, RESIDENT_DROP_IN);
  let gate;
  try { gate = io.fs.readFileSync(resident, "utf8"); } catch { refuse("CARD_RUN_TIMER", `${resident} cannot be read`); }
  const installed = {};
  for (const unit of UNITS) {
    try { installed[unit] = io.fs.readFileSync(path.join(paths.unitDir, unit), "utf8"); } catch { refuse("CARD_RUN_TIMER", `worker 1's ${unit} cannot be read`); }
  }
  const unitFiles = [];
  const dirs = [];
  const dropIns = [];
  for (const worker of workers) {
    let rendered;
    try { rendered = workerUnitsFromInstalled(worker, installed, io.fs); }
    catch (error) { refuse("CARD_RUN_TIMER", `card worker ${worker}'s units cannot be rendered from worker 1's: ${error.message}`); }
    for (const unit of workerUnits(worker)) {
      const file = path.join(paths.unitDir, unit);
      if (io.fs.existsSync(file) && io.fs.readFileSync(file, "utf8") !== rendered[unit]) {
        refuse("CARD_RUN_TIMER", `${file} exists with other content than card worker ${worker}'s rendered unit`);
      }
      unitFiles.push([file, rendered[unit]]);
      dropIns.push(path.join(paths.unitDir, `${unit}.d`, RESIDENT_DROP_IN));
    }
    dirs.push(...workerDirectories(worker));
  }
  for (const dir of dirs) {
    const found = stat(dir);
    if (found && (!found.isDirectory() || found.isSymbolicLink() || found.uid !== owner.uid || found.gid !== owner.gid || (found.mode & 0o7777) !== 0o700)) {
      refuse("CARD_RUN_TIMER", `${dir} exists but is not a private directory owned as ${WORKSPACE_STATE_DIR}`);
    }
  }
  for (const file of dropIns) {
    if (io.fs.existsSync(file) && io.fs.readFileSync(file, "utf8") !== gate) refuse("CARD_RUN_TIMER", `${file} exists with other content than ${resident}`);
  }
  const made = [];
  const madeDir = (dir, mode) => { io.fs.mkdirSync(dir, { mode }); made.push({ dir }); };
  const madeFile = (file, text) => { writeExclusive(io, file, text, 0o644); made.push({ file }); };
  try {
    for (const [file, text] of unitFiles) if (!io.fs.existsSync(file)) madeFile(file, text);
    for (const dir of dirs) {
      if (stat(dir)) continue;
      madeDir(dir, 0o700);
      io.fs.chownSync(dir, owner.uid, owner.gid);
      io.fs.chmodSync(dir, 0o700);
    }
    for (const file of dropIns) {
      if (io.fs.existsSync(file)) continue;
      if (!io.fs.existsSync(path.dirname(file))) madeDir(path.dirname(file), 0o755);
      madeFile(file, gate);
    }
  } catch (error) {
    for (const item of [...made].reverse()) {
      try { if (item.dir) io.fs.rmdirSync(item.dir); else io.fs.unlinkSync(item.file); } catch { /* named in the refusal below */ }
    }
    refuse("CARD_RUN_TIMER", `card worker preparation failed (${error.code ?? error.message}); what it made was taken off again`);
  }
  return made.map((item) => item.dir ?? item.file);
}

// Takes the timer off. It refuses while a run the timer started is still going:
// stopping that service would kill the run before its revert.
// M15 W5: every card worker's timer and service on the host go with worker
// 1's, whatever the config now says; none goes while any one's run is going.
export function removeTimer(io, paths = CARD_RUN_PATHS) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  const workers = Array.from({ length: MAX_CARD_WORKERS }, (_, i) => i + 1)
    .filter((worker) => worker === 1 || [autoServiceName(worker), autoTimerName(worker)].some((name) => io.fs.existsSync(path.join(paths.unitDir, name))));
  for (const worker of workers) {
    const service = autoServiceName(worker);
    const state = io.exec("systemctl", ["is-active", service]).stdout.trim();
    if (["active", "activating", "deactivating", "reloading"].includes(state)) {
      refuse("CARD_RUN_TIMER_BUSY", `${service} is ${state}: wait for the run to finish; ${paths.pause} stops new ones`);
    }
  }
  // The unit files stay until the timer reads back disabled and inactive, so a
  // failed disable or readback can be retried rather than leave an enabled
  // timer with no files. A retry after the timer file is gone skips the
  // disable, which would fail on a missing unit.
  for (const worker of workers) {
    const timer = autoTimerName(worker);
    const timerFile = path.join(paths.unitDir, timer);
    if (io.fs.existsSync(timerFile)) run(io, "systemctl", ["disable", "--now", timer]);
    const timerEnabled = io.exec("systemctl", ["is-enabled", timer]).stdout.trim();
    const timerActive = io.exec("systemctl", ["is-active", timer]).stdout.trim();
    if (!["disabled", "not-found"].includes(timerEnabled) || timerActive !== "inactive") {
      refuse("CARD_RUN_TIMER", `${timer} reads ${timerEnabled || "unknown"}/${timerActive || "unknown"} after disable; its unit files stay`);
    }
  }
  const names = workers.flatMap((worker) => [autoTimerName(worker), autoServiceName(worker)]);
  const failed = [];
  for (const name of names) {
    const file = path.join(paths.unitDir, name);
    if (!io.fs.existsSync(file)) continue;
    try {
      io.fs.unlinkSync(file);
    } catch (error) {
      failed.push(`${file} (${error.code ?? error.message})`);
    }
  }
  run(io, "systemctl", ["daemon-reload"]);
  const left = names.map((name) => path.join(paths.unitDir, name)).filter((file) => io.fs.existsSync(file));
  if (failed.length || left.length) refuse("CARD_RUN_TIMER", `still present: ${[...new Set([...failed, ...left])].join(", ")}`);
  return { removed: true };
}

export const defaultIO = Object.freeze({
  fs,
  uid: () => process.getuid(),
  now: () => new Date(),
  // systemd's id for this start of the unit; null outside a unit.
  invocation: () => process.env.INVOCATION_ID ?? null,
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  // env and cwd, when given, replace the child's (M10: the thread reviewer's
  // login travels in its environment, never in argv).
  exec: (file, args, { timeoutMs, env, cwd } = {}) => {
    const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
      ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) });
    const timedOut = result.error?.code === "ETIMEDOUT";
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(timedOut ? { timedOut } : {}) };
  },
});

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "run", "auto", "timer-install", "timer-remove"].includes(command)) {
    refuse("CARD_RUN_USAGE", "usage: card-run.mjs plan|run [--review-pr N --review-head SHA --review-base SHA --author-family codex|claude|hermes] | auto [--worker N] | timer-install | timer-remove");
  }
  // M15 W5: a card worker's timer starts `auto --worker N`, N from 2.
  if (command === "auto" && rest.length) {
    const worker = Number(rest[1]);
    if (rest.length !== 2 || rest[0] !== "--worker" || !/^[1-9][0-9]*$/.test(rest[1] ?? "") || worker < 2 || worker > MAX_CARD_WORKERS) {
      refuse("CARD_RUN_USAGE", `auto takes only --worker N, N from 2 to ${MAX_CARD_WORKERS}`);
    }
    return { command, review: null, worker };
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
    const { command, review, worker = 1 } = parseArgs(argv);
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
      // Read only: a hand landing is proven here, never recorded.
      const landing = landingReader(io, paths, config);
      const next = await nextCard(io, paths, config, revision, { landing });
      const queued = [];
      for (const id of queue.ok ? queue.ids : []) {
        // A landed card is never prepared again: its card is owned and done.
        if ((await cardLanded(io, paths, id, landing)).landed) { queued.push({ id, prepare: { skipped: "LANDED" } }); continue; }
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
      const result = await autoRun({ io, paths: cardRunPaths(worker, paths) });
      return { code: result.skipped || (result.ok && (result.revert?.reverted || result.kind === "install")) ? 0 : 1, output: result };
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

