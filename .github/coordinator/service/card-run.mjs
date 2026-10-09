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
// Not in this slice (still operator steps): installing the revision with the
// prerequisite provisioner, moving the card to Todo and creating its
// coordinator/<card> branch at the installed revision, and posting the report.
// Nothing here starts on its own: there is no timer, and importing the module
// has no effect.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateActivationRecord, MAX_ACTIVATION_WINDOW_MS } from "../single-run-activation.mjs";
import { resolveFixtureLane, resolveReviewOnlyLane } from "../workspace-scope.mjs";
import { familyForLane } from "../launch-vocabulary.mjs";

export const CARD_RUN_PATHS = Object.freeze({
  checkout: "/srv/shu/studenthub-platform",
  stateDir: "/srv/shu/state",
  activation: "/srv/shu/state/shu71-activation.json",
  worktrees: "/srv/shu/worktrees",
  receipt: "/etc/shu/shu71-prerequisites.json",
  unitDir: "/etc/systemd/system",
  lock: "/run/lock/shu-card-run.lock",
  tmp: "/tmp",
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
});
const SHA_RE = /^[0-9a-f]{40}$/;

export function refuse(code, detail = "") {
  throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}

// 2026-10-09T15:30:07.123Z -> 20261009T153007Z
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

// The record this run arms, built only from the committed configuration at the
// installed revision. A review-only run takes its pull request, head, base and
// author family from the operator, exactly as the activation keys require.
export function planRun({ config, revision, now, review = null, limits = CARD_RUN_LIMITS }) {
  if (!SHA_RE.test(revision ?? "")) refuse("CARD_RUN_REVISION", "the installed revision is not a full SHA");
  const ids = config?.dispatch_scope?.issue_ids;
  if (!Array.isArray(ids) || ids.length !== 1) refuse("CARD_RUN_SCOPE", "the committed dispatch_scope must name exactly one card");
  const [id] = ids;
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

export function tick(io) {
  run(io, "systemctl", ["start", "shu-coordinator.service"]);
  const invocation = run(io, "systemctl", ["show", "-p", "InvocationID", "--value", "shu-coordinator.service"]).trim();
  if (!/^[0-9a-f]{32}$/.test(invocation)) refuse("CARD_RUN_TICK", "the tick has no invocation id");
  return run(io, "journalctl", [`_SYSTEMD_INVOCATION_ID=${invocation}`, "-o", "cat", "--no-pager"]);
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
  const offTick = tickOutcome(tick(io));
  let retired = null;
  if (io.fs.existsSync(paths.activation)) {
    retired = path.join(paths.stateDir, `spent-${stamp(io.now())}-shu71-activation.json`);
    io.fs.renameSync(paths.activation, retired);
  }
  run(io, "systemctl", ["stop", "shu71-evidence.service"]);
  const killed = workerCount(io);
  if (killed) {
    io.exec("pkill", ["-TERM", "-u", "shu-worker"]);
    io.sleep(limits.killWaitMs);
    io.exec("pkill", ["-KILL", "-u", "shu-worker"]);
  }
  if (workerCount(io) !== 0) refuse("CARD_RUN_REVERT_READBACK", "shu-worker processes survived cleanup");
  for (const name of io.fs.readdirSync(paths.tmp)) {
    if (/^shu-npm-cache-/.test(name)) io.fs.rmSync(path.join(paths.tmp, name), { recursive: true, force: true });
  }
  return { reverted: true, code: null, dispatch_off_tick: offTick.activation, retired, killed };
}

// One bounded card run: refuse unless idle and installed, arm, tick until the
// coordinator ends the episode or the window closes, then revert.
export function runCard({ io, paths = CARD_RUN_PATHS, limits = CARD_RUN_LIMITS, review = null }) {
  if (io.uid() !== 0) refuse("CARD_RUN_NOT_ROOT", "run as root on the orchestrator host");
  try { io.fs.writeFileSync(paths.lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { refuse("CARD_RUN_LOCKED", `${paths.lock} exists: another card run is in progress or crashed`); }
  try {
    const busy = busyReasons(io, paths);
    if (busy.length) refuse("CARD_RUN_HOST_BUSY", busy.join("; "));
    const revision = installedRevision(io, paths);
    const config = JSON.parse(io.fs.readFileSync(path.join(paths.checkout, ".github/coordinator/config.json"), "utf8"));
    const plan = planRun({ config, revision, now: io.now(), review, limits });
    if (plan.branch) {
      const line = git(io, paths, ["ls-remote", "origin", `refs/heads/${plan.branch}`]);
      const head = line.split(/\s+/)[0];
      if (!line) refuse("CARD_RUN_BRANCH_MISSING", `${plan.branch} does not exist; create it at ${revision}`);
      if (head !== revision) refuse("CARD_RUN_BRANCH_NOT_AT_TARGET", `${plan.branch} is at ${head}, not ${revision}`);
    }
    const ticks = [];
    let result;
    try {
      const armed = arm(io, plan, revision, paths);
      const deadline = Date.parse(plan.record.expires_at);
      for (;;) {
        const outcome = tickOutcome(tick(io), plan.record.activation_id);
        ticks.push({ at: io.now().toISOString(), activation: outcome.activation, eligible: outcome.eligible });
        if (outcome.ended) {
          result = { ok: outcome.outcome !== "REFUSED", outcome: outcome.outcome, reason: outcome.reason };
          break;
        }
        if (ticks.length === 1 && outcome.eligible === 0) {
          result = { ok: false, outcome: "NOT_ELIGIBLE", reason: outcome.excluded.join("; ") || "no eligible work" };
          break;
        }
        if (io.now().getTime() >= deadline) {
          result = { ok: false, outcome: "EXPIRED", reason: `the run window closed at ${plan.record.expires_at}` };
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
    return { card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, ...result, ticks, revert: reverted };
  } finally {
    try { io.fs.unlinkSync(paths.lock); } catch { /* the lock is gone already */ }
  }
}

export const defaultIO = Object.freeze({
  fs,
  uid: () => process.getuid(),
  now: () => new Date(),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  exec: (file, args) => {
    const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
});

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "run"].includes(command)) refuse("CARD_RUN_USAGE", "usage: card-run.mjs plan|run [--review-pr N --review-head SHA --review-base SHA --author-family codex|claude|hermes]");
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

export function main(argv, io = defaultIO, paths = CARD_RUN_PATHS) {
  try {
    const { command, review } = parseArgs(argv);
    if (command === "plan") {
      const revision = installedRevision(io, paths);
      const config = JSON.parse(io.fs.readFileSync(path.join(paths.checkout, ".github/coordinator/config.json"), "utf8"));
      const plan = planRun({ config, revision, now: io.now(), review });
      return { code: 0, output: { ...plan, busy: busyReasons(io, paths) } };
    }
    const result = runCard({ io, paths, review });
    return { code: result.ok && result.revert.reverted ? 0 : 1, output: result };
  } catch (error) {
    return { code: 2, output: { ok: false, code: error.code ?? "CARD_RUN_ERROR", reason: error.message } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, output } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = code;
}

export const CARD_RUN_MODULE = fileURLToPath(import.meta.url);
