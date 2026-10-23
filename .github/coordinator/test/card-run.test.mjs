// SHU-86 — the card-run command: one bounded run, armed from the committed
// configuration, ended by the coordinator's own tick, always reverted. Every
// host effect goes through an injected io, so these tests run a whole run on a
// fake host and read back exactly what it touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planRun, onBase, nextCard, tickOutcome, tick, busyReasons, runCard, revert, parseArgs, main,
  CARD_RUN_LIMITS, RUN_DROP_IN, TARGET_DROP_IN, RESIDENT_DROP_IN,
  autoRun, autoClaim, installTimer, removeTimer, autoServiceUnit, autoTimerUnit, AUTO_SERVICE, AUTO_TIMER, AUTO_TIMEOUT_START_MS,
  reviewClaim, queueConfigPath, assertQueueConfigReviewer,
} from "../service/card-run.mjs";
import { renderRunReport, reportMarker, plainReason, PUSH_SSH_COMMAND, REPORT_ATTEMPTS, REPORT_RETRY_WAIT_MS,
  readCoordinatorCredentials, COORDINATOR_ENV } from "../service/card-prepare.mjs";
import { cardAction, prepareRun, CARD_TODO_MUTATION, BRANCH_READBACK_ATTEMPTS, BRANCH_READBACK_WAIT_MS } from "../service/card-prepare.mjs";
import { adapterLaunchEnvironment, applyAdapterLaunchEnvironment, supervisorAdapterKeys } from "../service/units.mjs";
import { supervisorChildEnvironment } from "../service/credential-delivery.mjs";
import { CARD_LAND_ENV, LAND_TOKEN_KEY, readLandToken, isReadRequest, settlePolicy, botSeverity, classifyThread, settleMarker } from "../service/card-land.mjs";
import { handoffReceipt, validHandoff } from "../durable-handoff.mjs";
import { createReceipt, validateReceipt, receiptCommentBody, parseReceiptsFromComments } from "../reconcile.mjs";
import { renderWatchLine, parseWatchLine } from "../watch-progress.mjs";
import { statusPath, needsOwner, alertLine, ownerMention, nextStart } from "../service/card-status.mjs";
import { watchOnce, stuckRun, readStatus, readUnit, renderStatus, installWatch, removeWatch, WATCH_LIMITS, STATUS_MARKER } from "../service/card-watchdog.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";
import { cardLanded, handLandRecord, HAND_LAND_OUTCOMES } from "../service/card-landed.mjs";
import { brokerGitEnv } from "../push-broker.mjs";
import { evidenceLine, secretIndicator, createLineTail, readLogTail, evidenceText, readRepairEvidence, testWeakening, isTestPath, isTestConfigPath,
  repairRecordPath, repairAlertPath, advanceRound, REPAIR_LIMITS, REPAIR_SKIPS } from "../service/card-repair.mjs";
import { repairEvidenceDigest, validateActivationRecord } from "../single-run-activation.mjs";
import { judgeChecks } from "../service/card-land.mjs";
import { ADDED_WEAKENING_LINES } from "./fixture/test-weakening-lines.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.json"), "utf8"));
const REV = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const START = new Date("2026-10-09T15:30:07.000Z");
const PUSH_REMOTE = "git@github.com:BAWES-Universe/studenthub-platform.git";
const PATHS = Object.freeze({
  checkout: "/srv/shu/studenthub-platform",
  stateDir: "/srv/shu/state",
  activation: "/srv/shu/state/shu71-activation.json",
  worktrees: "/srv/shu/worktrees",
  receipt: "/etc/shu/shu71-prerequisites.json",
  unitDir: "/etc/systemd/system",
  lock: "/run/lock/shu-card-run.lock",
  tmp: "/tmp",
  coordinatorEnv: "/srv/shu/coordinator.env",
  pause: "/etc/shu/card-run.paused",
});
const TODO_ID = "todo-state-id";
const UNITS = ["shu-supervisor.service", "shu-coordinator.service"];
const dropIn = (unit, name) => `${PATHS.unitDir}/${unit}.d/${name}`;

const configFor = (id, edit = (config) => config) => edit({ ...structuredClone(COMMITTED), dispatch_scope: { issue_ids: [id] } });
const REVIEW = Object.freeze({ pr: 239, head: HEAD, base: BASE, authorFamily: "claude" });

const armed = (id, target = "SHU-301") => `activation=ARMED id=${id} target=${target} ref=${target} revision=${REV} slots=1 expires=x writer=codex-builder reviewer=claude-verifier`;
const spent = (target, reason) => `activation=REFUSED (activation is spent: the episode for ${target} ended — ${reason})`;
const tickText = (activation, eligible = 1, excluded = []) => [
  activation,
  `eligible=${eligible}  excluded=${excluded.length}`,
  ...excluded.map((line) => `  EXCLUDED ${line}`),
].join("\n");

// A fake orchestrator host: files, a supervisor whose environment follows the
// drop-ins at its last restart, shu-worker processes, a clock, and a scripted
// coordinator whose tick output the test decides.
function fakeHost({ id = "SHU-301", config = configFor(id), onTick, workers = () => 0, branchHead = REV, edit = () => {},
  card = { state: { id: "todo-state-id", name: "Todo", type: "unstarted" }, assignee: null, delegate: null } } = {}) {
  const files = new Map();
  const dirs = new Set();
  const calls = [];
  const host = { files, calls, clock: START.getTime(), ticks: 0, environ: [], lastTick: "", workers, branchHead, card: structuredClone(card), api: [], reports: [], history: [], linearClock: Date.parse("2026-10-09T15:00:00.000Z"),
    head: REV, main: REV, mainTip: REV, fetchedMain: null, dirty: "", supervisorPid: "4242", invocation: "f".repeat(32), pushDir: null, pushDirs: new Set(),
    journal: [], pending: [], syncs: 0, journalReads: 0 };
  const put = (file, text, extra = {}) => files.set(file, { text, mode: 0o644, uid: 0, gid: 0, ...extra });
  put(`${PATHS.checkout}/.github/coordinator/config.json`, JSON.stringify(config));
  put(PATHS.receipt, JSON.stringify({ version: 1, revision: REV, state: "VERIFIED", effects: [] }));
  for (const unit of UNITS) put(dropIn(unit, RESIDENT_DROP_IN), "[Service]\n");
  for (const dir of [PATHS.stateDir, PATHS.worktrees, PATHS.tmp, "/run/lock"]) dirs.add(dir);
  put(`${PATHS.tmp}/shu-npm-cache-1/x`, "cache");
  put(`${PATHS.tmp}/keep-me`, "other");
  put(PATHS.coordinatorEnv, `GITHUB_TOKEN=gh-secret-value\nLINEAR_API_TOKEN=lin-secret-value\nSHU_PUSH_REMOTE_URL=${PUSH_REMOTE}\n`, { uid: 997, mode: 0o600 });
  const children = (dir) => {
    const names = new Set();
    for (const file of files.keys()) if (file.startsWith(`${dir}/`)) names.add(file.slice(dir.length + 1).split("/")[0]);
    for (const sub of dirs) if (sub.startsWith(`${dir}/`)) names.add(sub.slice(dir.length + 1).split("/")[0]);
    return [...names];
  };
  host.fs = {
    existsSync: (file) => files.has(file) || dirs.has(file) || children(file).length > 0,
    lstatSync: (file) => {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      const entry = files.get(file);
      return { isFile: () => true, isSymbolicLink: () => false, uid: entry.uid, mode: 0o100000 | entry.mode };
    },
    readFileSync: (file) => {
      if (file === `/proc/${host.supervisorPid}/environ`) return host.environ.join("\0");
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      return files.get(file).text;
    },
    writeFileSync: (file, text, options = {}) => {
      if (options.flag === "wx" && files.has(file)) throw Object.assign(new Error(`EEXIST ${file}`), { code: "EEXIST" });
      put(file, String(text), { mode: options.mode ?? 0o644 });
    },
    chownSync: (file, uid, gid) => Object.assign(files.get(file), { uid, gid }),
    chmodSync: (file, mode) => Object.assign(files.get(file), { mode }),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync: (file) => { if (!files.delete(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" }); },
    readdirSync: (dir) => children(dir),
    rmSync: (target) => { for (const file of [...files.keys()]) if (file === target || file.startsWith(`${target}/`)) files.delete(file); },
  };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  host.exec = (file, args) => {
    calls.push([file, ...args].join(" "));
    const line = args.join(" ");
    if (file === "pgrep") {
      const count = host.workers(host);
      return count ? ok(`${Array.from({ length: count }, (_, i) => 5000 + i).join("\n")}\n`) : { status: 1, stdout: "", stderr: "" };
    }
    if (file === "pkill") return ok();
    if (file === "id") return ok(args[0] === "-u" ? "997\n" : "998\n");
    if (file === "getent" && line === "passwd shu-coordinator") return host.noHome ? { status: 2, stdout: "", stderr: "" } : ok("shu-coordinator:x:997:998::/var/lib/shu-coordinator:/usr/sbin/nologin\n");
    // The branch push, as the deploy-key remote sees it: only the coordinator
    // user, with the hardened git, from a fresh bare repository that borrows
    // the checkout's objects, bounded in time, with an exact
    // revision-to-branch refspec.
    if (file === "runuser") {
      assert.deepEqual(args.slice(0, 5), ["-u", "shu-coordinator", "--", "env", "-i"]);
      assert.ok(args.includes("HOME=/var/lib/shu-coordinator") && args.includes("GIT_TERMINAL_PROMPT=0"));
      assert.ok(args.includes("GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"));
      const command = args.slice(args.findIndex((arg) => !arg.includes("=") && !["-u", "shu-coordinator", "--", "env", "-i"].includes(arg)));
      if (command[0] === "mktemp") {
        assert.deepEqual(command, ["mktemp", "-d", "/tmp/shu-card-push-XXXXXXXX"]);
        host.pushDir = "/tmp/shu-card-push-Ab12Cd34";
        host.pushDirs.add(host.pushDir);
        return ok(`${host.pushDir}\n`);
      }
      if (command[0] === "rm") {
        assert.deepEqual(command, ["rm", "-rf", "--", host.pushDir]);
        host.pushDirs.delete(host.pushDir);
        return ok();
      }
      assert.ok(["git", "timeout"].includes(command[0]) && command.includes("credential.helper=") && host.pushDirs.has(host.pushDir));
      if (command[0] === "git") {
        assert.deepEqual(command.slice(-4), ["init", "--bare", "-q", host.pushDir]);
        return ok();
      }
      assert.deepEqual(args.slice(args.indexOf("timeout"), args.indexOf("timeout") + 4), ["timeout", "--kill-after=10", "300", "git"]);
      assert.ok(args.includes(`GIT_ALTERNATE_OBJECT_DIRECTORIES=${PATHS.checkout}/.git/objects`));
      assert.ok(command.includes(`--git-dir=${host.pushDir}`));
      assert.equal(command.includes("-C") || command.includes(PATHS.checkout), false);
      // SHU-312: main as the deploy-key remote has it, fetched into the fresh
      // repository, and its ancestry checked there.
      const verb = command[command.indexOf(`--git-dir=${host.pushDir}`) + 1];
      if (verb === "fetch") {
        assert.deepEqual(command.slice(-5), ["fetch", "--no-tags", "--no-recurse-submodules", PUSH_REMOTE, "refs/heads/main:refs/heads/card-base"]);
        host.api.push("git fetch main");
        host.fetchedMain = host.mainTip;
        host.ancestryChecked = false;
        return host.fetchFails ? { status: 128, stdout: "", stderr: "fatal: could not read" } : ok();
      }
      if (verb === "rev-parse") {
        assert.deepEqual(command.slice(-3), ["rev-parse", "--verify", "refs/heads/card-base^{commit}"]);
        return ok(`${host.fetchedMain}\n`);
      }
      if (verb === "merge-base") {
        // SHU-327: an existing branch main already contains moves forward.
        // main's ancestry is checked first after each fetch; a second check is
        // the existing branch's containment.
        if (host.ancestryChecked) {
          assert.deepEqual(command.slice(-4), ["merge-base", "--is-ancestor", host.branchHead, host.fetchedMain]);
          host.api.push(`git contains ${host.branchHead}`);
          return { status: host.branchContained === true ? 0 : 1, stdout: "", stderr: "" };
        }
        host.ancestryChecked = true;
        assert.deepEqual(command.slice(-4), ["merge-base", "--is-ancestor", host.head, host.fetchedMain]);
        return { status: host.mainDescends === false ? 1 : 0, stdout: "", stderr: "" };
      }
      assert.equal(verb, "push");
      assert.ok(command.includes("--no-verify"));
      const refspec = args.at(-1);
      const [sha, ref] = refspec.split(":");
      assert.equal(args.at(-2), PUSH_REMOTE);
      assert.equal(args.includes("--force") || args.includes("-f") || refspec.startsWith("+"), false);
      const dry = args.includes("--dry-run");
      host.api.push(`git push${dry ? " dry-run" : ""} ${ref} ${sha}`);
      // Someone creates the branch between the API read and the push. A
      // create-only lease is refused; a plain push would fast-forward it.
      if (host.raceBranchHead) host.branchHead = host.raceBranchHead;
      const lease = args.find((arg) => arg.startsWith(`--force-with-lease=${ref}:`));
      assert.ok(lease, "every branch push carries a lease");
      if (host.branchHead) {
        if (lease !== `--force-with-lease=${ref}:${host.branchHead}`) return { status: 1, stdout: "", stderr: "! [rejected] (stale info)" };
        if (!dry) host.branchHead = sha;
        return ok();
      }
      if (lease !== `--force-with-lease=${ref}:`) return { status: 1, stdout: "", stderr: "! [rejected] (stale info)" };
      if (host.pushFails) return { status: host.pushFails === "timeout" ? 124 : 128, stdout: "", stderr: `ERROR: read-only key for ${PUSH_REMOTE}` };
      // GitHub's ref API lagging an accepted push: the next reads still answer 404.
      if (!dry && host.staleReads) { host.lagLeft = host.staleReads; host.lagHead = sha; return ok(); }
      if (!dry) host.branchHead = sha;
      return ok();
    }
    if (file === "git") {
      if (line.endsWith("rev-parse HEAD")) return ok(`${host.head}\n`);
      if (line.endsWith("rev-parse refs/heads/main")) return ok(`${host.main}\n`);
      if (line.includes("status --porcelain")) return ok(host.dirty);
    }
    if (file === "systemctl") {
      if (line === "restart shu-supervisor.service") {
        host.environ = ["PATH=/usr/bin"];
        for (const name of [RUN_DROP_IN, TARGET_DROP_IN]) {
          const entry = files.get(dropIn("shu-supervisor.service", name));
          if (entry) host.environ.push(/Environment=(.*)\n/.exec(entry.text)[1]);
        }
        edit(host, "restart");
        return ok();
      }
      if (line === "stop shu71-evidence.service" && host.failStop) return { status: 1, stdout: "", stderr: "failed" };
      if (line === "show -p MainPID --value shu-supervisor.service") return ok(`${host.supervisorPid}\n`);
      if (line === "start shu-coordinator.service") {
        host.ticks += 1;
        if (host.failTicks?.has(host.ticks)) return { status: 1, stdout: "", stderr: "failed" };
        host.lastTick = onTick ? onTick(host) : tickText(armed(JSON.parse(files.get(PATHS.activation)?.text ?? "{}").activation_id));
        // The tick's lines reach the journal under this start's own
        // invocation id; journald has not flushed them until a sync.
        const invocation = (host.ticks.toString(16) + host.invocation).slice(0, 32);
        if (!host.dropJournal) host.pending.push(...host.lastTick.split("\n").map((message) => ({ at: host.clock, invocation, message })));
        return ok();
      }
      // As on the host: a finished oneshot is unloaded, so its InvocationID reads empty.
      if (line === "show -p InvocationID --value shu-coordinator.service") return ok("\n");
      return ok();
    }
    if (file === "journalctl") {
      if (line === "--sync") {
        host.syncs += 1;
        host.journal.push(...host.pending.splice(0));
        return ok();
      }
      assert.equal(args[0], "_SYSTEMD_UNIT=shu-coordinator.service");
      assert.deepEqual(args.slice(2), ["-o", "json", "--all", "--no-pager"]);
      const since = Number(/^--since=@(\d+\.\d{3})$/.exec(args[1])?.[1]) * 1000;
      assert.ok(Number.isFinite(since), args[1]);
      host.journalReads += 1;
      const lines = host.journal.filter((entry) => entry.at >= since).map((entry) => JSON.stringify({
        _SYSTEMD_UNIT: "shu-coordinator.service", _SYSTEMD_INVOCATION_ID: entry.invocation,
        MESSAGE: entry.bytes ? [...Buffer.from(entry.message)] : entry.message,
      }));
      return ok(lines.length ? `${lines.join("\n")}\n` : "");
    }
    return { status: 127, stdout: "", stderr: `unexpected ${file}` };
  };
  // Linear and GitHub, as the coordinator's tokens see them.
  const respond = (status, json) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => json });
  host.fetch = async (url, options = {}) => {
    const auth = options.headers?.Authorization;
    if (url === "https://api.linear.app/graphql") {
      assert.equal(auth, "lin-secret-value");
      const { query, variables } = JSON.parse(options.body);
      // Linear's side of the card: every state change lands in its history.
      const moveCard = (state) => {
        host.linearClock += 1000;
        host.history.push({ createdAt: new Date(host.linearClock).toISOString(), fromState: { id: host.card.state.id }, toState: { id: state.id } });
        host.card.state = state;
      };
      // Every request the run makes of Linear, whatever it is for.
      host.linearCalls = (host.linearCalls ?? 0) + 1;
      if (query.includes("CardRunHistory")) {
        host.api.push("linear history");
        // Oldest first, two to a page, so the newest change is only on the last
        // page and the reader must follow every page.
        const nodes = [...host.history];
        const start = variables.after ? Number(variables.after) : 0;
        return respond(200, { data: { issue: { history: { nodes: nodes.slice(start, start + 2),
          pageInfo: { hasNextPage: start + 2 < nodes.length, endCursor: String(start + 2) } } } } });
      }
      if (query.includes("CardRunReportIssue")) {
        host.api.push(`linear report read ${variables.id}`);
        // A request that never reaches Linear: fetch itself throws.
        if (host.networkFailures > 0) { host.networkFailures -= 1; throw new TypeError("fetch failed"); }
        host.lockAtReport = host.files.has(PATHS.lock);
        // A stall that would outlast any sane deadline, yet ends, so a run
        // without a deadline fails this test by assertion rather than hanging.
        if (host.failReport === "stall") return new Promise((_, reject) => setTimeout(() => reject(new Error("the fake stall ended")), 1500));
        if (host.failReport === "read") return respond(500, null);
        const nodes = host.reports.filter((body) => body.includes(variables.marker)).slice(0, 1).map((_, i) => ({ id: `report-comment-${i}` }));
        return respond(200, { data: { issue: { id: "report-uuid", identifier: variables.id, comments: { nodes } } } });
      }
      if (query.includes("CardRunReportComment")) {
        host.api.push(`linear report ${variables.issueId}`);
        if (host.failReport === "post") return respond(200, { data: { commentCreate: { success: false } } });
        // A request that does not reach Linear, or one Linear commits whose
        // answer is lost on the way back: both throw fetch's own TypeError.
        if (host.postFailures > 0) { host.postFailures -= 1; throw new TypeError("fetch failed"); }
        host.reports.push(variables.body);
        if (host.lostAnswers > 0) { host.lostAnswers -= 1; throw new TypeError("fetch failed"); }
        return respond(200, { data: { commentCreate: { success: true } } });
      }
      host.api.push(query.includes("CardRunTodo") ? `linear todo ${variables.stateId}` : "linear read");
      if (query.includes("CardRunTodo")) {
        if (host.beforeTodo) { const hook = host.beforeTodo; host.beforeTodo = null; hook(host, moveCard); }
        if (host.failTodo) return respond(200, { data: { issueUpdate: { success: true } } });
        const states = { [TODO_ID]: { id: TODO_ID, name: "Todo", type: "unstarted" }, ...host.knownStates };
        moveCard(states[variables.stateId] ?? { id: variables.stateId, name: "?", type: "unstarted" });
        if (host.afterTodo) { const hook = host.afterTodo; host.afterTodo = null; hook(host, moveCard); }
        return respond(200, { data: { issueUpdate: { success: true } } });
      }
      if (host.onCardRead) host.onCardRead(host, moveCard);
      return respond(200, { data: { issue: { id: "issue-uuid", identifier: variables.id, updatedAt: new Date(host.linearClock).toISOString(),
        labels: { nodes: [{ name: "repo:platform" }] }, ...host.card,
        team: { id: "team", states: { nodes: [{ id: TODO_ID, name: "Todo", type: "unstarted" }] } } } } });
    }
    assert.equal(auth, "Bearer gh-secret-value");
    // Any card's branch: a queue's cards each read their own (SHU-312).
    const branch = /\/git\/ref\/heads\/(coordinator\/SHU-\d+)$/.exec(url)?.[1] ?? `coordinator/${id}`;
    if (url === `https://api.github.com/repos/${config.pilot_repo}/git/ref/heads/${branch}`) {
      host.api.push("github read");
      if (host.lagLeft > 0) {
        host.lagLeft -= 1;
        if (host.lagLeft === 0) host.branchHead = host.lagMovedTo ?? host.lagHead;
        return respond(404, { message: "Not Found" });
      }
      return host.branchHead ? respond(200, { ref: `refs/heads/${branch}`, object: { sha: host.branchHead } }) : respond(404, { message: "Not Found" });
    }
    // The coordinator's token is read-only: GitHub refuses any write with it.
    if (options.method && options.method !== "GET") return respond(403, { message: "Resource not accessible by integration" });
    // SHU-321: the open pull requests a done queue's review reads; none by
    // default, so a done queue is the plain skip it always was.
    const api = `https://api.github.com/repos/${config.pilot_repo}`;
    const pullRead = new RegExp(`^${api}/(?:pulls\\?state=open&base=main&per_page=100|pulls/(\\d+)/(files|commits)\\?per_page=100|compare/main\\.\\.\\.([0-9a-f]{40}))$`).exec(url);
    if (pullRead) {
      host.api.push(`github ${url.slice(api.length + 1)}`);
      if (host.githubFails?.(url)) return respond(502, { message: "Bad Gateway" });
      if (pullRead[1]) return respond(200, structuredClone(host.pullDetails?.[pullRead[1]]?.[pullRead[2]] ?? []));
      if (pullRead[3]) {
        const detail = Object.values(host.pullDetails ?? {}).find((entry) => entry.head === pullRead[3]);
        return detail ? respond(200, { merge_base_commit: { sha: detail.base } }) : respond(404, { message: "Not Found" });
      }
      return respond(200, structuredClone(host.pulls ?? []));
    }
    return respond(500, null);
  };
  host.io = { fs: host.fs, exec: host.exec, fetch: host.fetch, uid: () => 0, now: () => new Date(host.clock), sleep: (ms) => { host.clock += ms; }, delay: async (ms) => { host.clock += ms; host.delays = (host.delays ?? 0) + 1; } };
  return host;
}

// A thrown refusal becomes a value, so a guard that throws where it should not
// fails its test by assertion rather than by crash.
const attempt = async (fn) => { try { return await fn(); } catch (error) { return { thrown: error.code ?? error.message }; } };
const activationOf = (host) => JSON.parse(host.files.get(PATHS.activation).text);
const armedId = (host) => activationOf(host).activation_id;
const noArming = (host) => {
  assert.equal(host.files.has(PATHS.activation), false, "no activation record was written");
  for (const unit of UNITS) for (const name of [RUN_DROP_IN, TARGET_DROP_IN]) assert.equal(host.files.has(dropIn(unit, name)), false);
  assert.equal(host.calls.some((call) => call.startsWith("systemctl")), false, "no unit was touched");
};
const reverted = (host) => {
  for (const unit of UNITS) {
    for (const name of [RUN_DROP_IN, TARGET_DROP_IN]) assert.equal(host.files.has(dropIn(unit, name)), false, `${name} removed from ${unit}`);
    assert.equal(host.files.has(dropIn(unit, RESIDENT_DROP_IN)), true, "the resident drop-in stays");
  }
  assert.equal(host.files.has(PATHS.activation), false, "the activation record is retired");
  assert.equal(host.environ.includes("ENABLE_DISPATCH=true"), false, "dispatch is off");
  assert.equal(host.files.has(PATHS.lock), false, "the lock is released");
};

test("SHU-86 C1: a card run arms the committed card with its committed lanes at the installed revision", async () => {
  const plan = planRun({ config: configFor("SHU-301"), revision: REV, now: START });
  assert.equal(plan.kind, "card");
  assert.equal(plan.branch, "coordinator/SHU-301");
  assert.deepEqual(plan.record, {
    activation_id: "shu-301-run-20261009T153007Z",
    target_issue_id: "SHU-301",
    coordinator_revision: REV,
    slots: 1,
    expires_at: new Date(START.getTime() + CARD_RUN_LIMITS.runMs).toISOString(),
    authorization_ref: "SHU-301",
    writer_lane: "codex-builder",
    reviewer_lane: "claude-verifier",
    initial_target_sha: REV,
  });
});

test("SHU-86 C2: planning refuses anything but one committed card", async () => {
  const code = (fn) => { try { fn(); } catch (error) { return error.code; } return "NO_REFUSAL"; };
  assert.equal(code(() => planRun({ config: configFor("SHU-301", (c) => ({ ...c, dispatch_scope: { issue_ids: ["SHU-301", "SHU-300"] } })), revision: REV, now: START })), "CARD_RUN_SCOPE");
  assert.equal(code(() => planRun({ config: configFor("SHU-301"), revision: "main", now: START })), "CARD_RUN_REVISION");
  const fixture = COMMITTED.fixture_lane?.id ?? COMMITTED.fixture_lanes?.[0]?.id;
  assert.ok(fixture, "the committed configuration keeps a fixture lane");
  assert.equal(code(() => planRun({ config: configFor(fixture), revision: REV, now: START })), "CARD_RUN_NOT_A_CARD");
  assert.equal(code(() => planRun({ config: configFor("SHU-999"), revision: REV, now: START })), "CARD_RUN_NOT_A_CARD");
  assert.equal(code(() => planRun({ config: configFor("SHU-301"), revision: REV, now: START, review: REVIEW })), "CARD_RUN_REVIEW_INPUT");
  assert.equal(code(() => planRun({ config: configFor("SHU-301", (c) => ({ ...c, review_lanes: "x" })), revision: REV, now: START })), "CARD_RUN_CONFIG");
});

test("SHU-86 C3: a review run takes a listed reviewer outside the author's family and names no writer", async () => {
  assert.throws(() => planRun({ config: configFor("SHU-304"), revision: REV, now: START }), { code: "CARD_RUN_REVIEW_INPUT" });
  const claudeAuthored = planRun({ config: configFor("SHU-304"), revision: REV, now: START, review: REVIEW });
  assert.equal(claudeAuthored.kind, "review");
  assert.equal(claudeAuthored.branch, null);
  assert.equal(claudeAuthored.record.reviewer_lane, "codex-verifier");
  assert.equal("writer_lane" in claudeAuthored.record, false);
  assert.equal(claudeAuthored.record.initial_target_sha, HEAD);
  assert.equal(claudeAuthored.record.review_base_sha, BASE);
  assert.equal(claudeAuthored.record.review_pr, 239);
  const codexAuthored = await attempt(() => planRun({ config: configFor("SHU-304"), revision: REV, now: START, review: { ...REVIEW, authorFamily: "codex" } }));
  assert.equal(codexAuthored.record?.reviewer_lane, "claude-verifier");
  const onlyCodex = configFor("SHU-304", (c) => { c.review_lanes[0].reviewer_lanes = ["codex-verifier"]; return c; });
  assert.throws(() => planRun({ config: onlyCodex, revision: REV, now: START, review: { ...REVIEW, authorFamily: "codex" } }), { code: "CARD_RUN_REVIEW_INPUT" });
});

test("SHU-86 C4: only the coordinator's own tick ends a run, and an unreadable tick ends it too", async () => {
  const id = "shu-301-run-20261009T153007Z";
  assert.equal(tickOutcome(tickText(armed(id)), id).ended, false);
  assert.deepEqual(
    (({ ended, outcome }) => ({ ended, outcome }))(tickOutcome(tickText(spent("SHU-301", "review PASS — the episode is complete")), id)),
    { ended: true, outcome: "PASS" });
  assert.equal(tickOutcome(tickText(spent("SHU-304", `review-only verdict BLOCKED at ${HEAD} — the episode is complete`)), id).outcome, "REVIEW_BLOCKED");
  assert.equal(tickOutcome(tickText(spent("SHU-301", "stop: two failed attempts")), id).outcome, "STOPPED");
  assert.equal(tickOutcome(tickText("activation=REFUSED (activation expired)"), id).outcome, "REFUSED");
  assert.equal(tickOutcome(tickText("activation=absent (committed gates only)"), id).outcome, "REFUSED");
  assert.equal(tickOutcome(tickText("activation=absent (committed gates only)")).outcome, "REFUSED");
  assert.equal(tickOutcome("eligible=1  excluded=0").outcome, "REFUSED");
  assert.equal(tickOutcome("eligible=1  excluded=0", id).outcome, "REFUSED");
  assert.equal(tickOutcome(tickText(armed("someone-else-run")), id).outcome, "REFUSED");
  const parsed = tickOutcome(tickText(armed(id), 0, ["SHU-301            not in Todo"]), id);
  assert.equal(parsed.eligible, 0);
  assert.deepEqual(parsed.excluded, ["EXCLUDED SHU-301            not in Todo"]);
});

test("SHU-86 C5: the host is busy while any run, drop-in, worker or worktree is left", async () => {
  const host = fakeHost();
  assert.deepEqual(busyReasons(host.io, PATHS), []);
  host.files.set(PATHS.activation, { text: "{}" });
  host.files.set(dropIn("shu-coordinator.service", TARGET_DROP_IN), { text: "" });
  host.files.set(`${PATHS.worktrees}/build-shu-301/x`, { text: "" });
  host.files.set(`${PATHS.worktrees}/review-pr239/x`, { text: "" });
  host.files.set(`${PATHS.worktrees}/other/x`, { text: "" });
  host.workers = () => 2;
  const reasons = busyReasons(host.io, PATHS);
  assert.equal(reasons.length, 5, reasons.join("\n"));
  assert.ok(reasons.some((r) => r.includes("activation record")));
  assert.ok(reasons.some((r) => r.includes(TARGET_DROP_IN)));
  assert.ok(reasons.some((r) => r.includes("2 shu-worker")));
  assert.ok(reasons.some((r) => r.includes("build-shu-301")));
  assert.ok(reasons.some((r) => r.includes("review-pr239")));
});

test("SHU-86 C6: a busy host is refused before anything is armed", async () => {
  const host = fakeHost({ workers: () => 1 });
  await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code: "CARD_RUN_HOST_BUSY" });
  noArming(host);
  assert.equal(host.files.has(PATHS.lock), false);
});

test("SHU-86 C7: only a clean, installed main is armed", async () => {
  for (const [label, change, code] of [
    ["dirty checkout", (h) => { h.dirty = " M config.json\n"; }, "CARD_RUN_CHECKOUT"],
    ["HEAD off main", (h) => { h.main = HEAD; }, "CARD_RUN_CHECKOUT"],
    ["receipt at another revision", (h) => { h.files.get(PATHS.receipt).text = JSON.stringify({ revision: HEAD, state: "VERIFIED" }); }, "CARD_RUN_NOT_INSTALLED"],
    ["receipt not verified", (h) => { h.files.get(PATHS.receipt).text = JSON.stringify({ revision: REV, state: "PENDING" }); }, "CARD_RUN_NOT_INSTALLED"],
    ["no receipt", (h) => { h.files.delete(PATHS.receipt); }, "CARD_RUN_NOT_INSTALLED"],
  ]) {
    const host = fakeHost();
    change(host);
    await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code }, label);
    noArming(host);
  }
});

test("SHU-86 C8: a missing coordinator branch is created at the installed revision; a moved one is refused", async () => {
  const missing = fakeHost({ branchHead: "", onTick: () => tickText(spent("SHU-301", "review PASS — the episode is complete")) });
  const result = await runCard({ io: missing.io, paths: PATHS }).catch((error) => assert.fail(`the run refused: ${error.message}`));
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.prepared.branch, { branch: "coordinator/SHU-301", head: REV, base: REV, action: "create" });
  assert.equal(missing.branchHead, REV);
  assert.ok(missing.api.includes(`git push refs/heads/coordinator/SHU-301 ${REV}`));
  assert.equal(missing.api.filter((call) => call.startsWith("git push")).length, 1, "one push, no dry run, during a run");
  const moved = fakeHost({ branchHead: HEAD });
  await assert.rejects(runCard({ io: moved.io, paths: PATHS }), { code: "CARD_RUN_BRANCH_NOT_AT_TARGET" });
  noArming(moved);
  assert.equal(moved.branchHead, HEAD, "an existing branch is never moved");
  assert.equal(moved.api.some((call) => call.startsWith("git push") || call.startsWith("linear todo")), false);
});

test("SHU-86 C38: the branch is pushed with the coordinator's deploy key, never written with its read-only token", async () => {
  // A push the remote refuses stops the run before the card moves or anything
  // is armed, and the refusal names neither the remote nor git's output.
  const refused = fakeHost({ branchHead: "" });
  refused.pushFails = true;
  const error = await runCard({ io: refused.io, paths: PATHS }).then(() => null, (e) => e);
  assert.equal(error?.code, "CARD_RUN_BRANCH_CREATE");
  assert.doesNotMatch(error.message, /github\.com|read-only key/);
  noArming(refused);
  assert.equal(refused.api.some((call) => call.startsWith("linear todo")), false);
  assert.equal(refused.pushDirs.size, 0, "the push repository is removed after a refused push");
  // A push that outlives its time limit is a refusal too, and says so.
  const stalled = fakeHost({ branchHead: "" });
  stalled.pushFails = "timeout";
  const timedOut = await runCard({ io: stalled.io, paths: PATHS }).then(() => null, (e) => e);
  assert.equal(timedOut?.code, "CARD_RUN_BRANCH_CREATE");
  assert.match(timedOut.message, /timed out after 300s/);
  assert.equal(stalled.pushDirs.size, 0);
  noArming(stalled);
  // No push remote, a remote for another repository, or no home for the
  // coordinator user: refused before any push is tried.
  for (const [label, change] of [
    ["no remote", (h) => { h.files.get(PATHS.coordinatorEnv).text = "GITHUB_TOKEN=gh-secret-value\nLINEAR_API_TOKEN=lin-secret-value\n"; }],
    ["other repository", (h) => { h.files.get(PATHS.coordinatorEnv).text = h.files.get(PATHS.coordinatorEnv).text.replace("studenthub-platform.git", "elsewhere.git"); }],
    ["no home", (h) => { h.noHome = true; }],
  ]) {
    const host = fakeHost({ branchHead: "" });
    change(host);
    await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code: "CARD_RUN_BRANCH_CREATE" }, label);
    assert.equal(host.api.some((call) => call.startsWith("git push")), false, label);
    noArming(host);
  }
  // plan proves the push route with a dry run, which moves nothing.
  const planned = fakeHost({ branchHead: "" });
  const { output } = await main(["plan"], planned.io, PATHS);
  assert.equal(output.prepare.branch.action, "create");
  assert.deepEqual(planned.api.filter((call) => call.startsWith("git push")), [`git push dry-run refs/heads/coordinator/SHU-301 ${REV}`]);
  assert.equal(planned.branchHead, "");
  assert.equal(planned.pushDirs.size, 0, "the push repository is removed after a dry run");
  const blocked = fakeHost({ branchHead: "" });
  blocked.pushFails = true;
  assert.equal((await main(["plan"], blocked.io, PATHS)).output.prepare.refused, "CARD_RUN_BRANCH_CREATE");
});

test("SHU-86 C39: the branch push takes the same SSH route as the push broker on the host", () => {
  // The broker runs in the supervisor, whose environment is supervisor.env
  // (the transport secret only) plus the adapter keys copied from
  // coordinator.env. SHU_PUSH_SSH_COMMAND is not an adapter key, so even when
  // coordinator.env carries one it never reaches the broker, and the broker's
  // route is plain ssh as the coordinator user with that user's own ~/.ssh.
  // The branch push uses that same program, only made non-interactive and
  // bounded; if the broker's route ever changes, this test fails first.
  assert.equal(supervisorAdapterKeys.includes("SHU_PUSH_SSH_COMMAND"), false);
  const source = [...supervisorAdapterKeys.map((key) => `${key}=placeholder-${key.toLowerCase()}`),
    "GITHUB_TOKEN=gh-placeholder", "LINEAR_API_TOKEN=lin-placeholder", "SHU_PUSH_SSH_COMMAND=\"ssh -i /elsewhere/key\""].join("\n");
  const supervisorEnv = applyAdapterLaunchEnvironment({ PATH: "/usr/bin", SHU_SUPERVISOR_SECRET: "s".repeat(40) }, adapterLaunchEnvironment(source));
  assert.equal(Object.hasOwn(supervisorEnv, "SHU_PUSH_SSH_COMMAND"), false);
  assert.equal(brokerGitEnv(supervisorEnv).GIT_SSH_COMMAND, "ssh");
  assert.equal(PUSH_SSH_COMMAND.split(" ")[0], "ssh");
  assert.deepEqual(PUSH_SSH_COMMAND.split(" ").slice(1), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]);
});

test("SHU-86 C40: the branch push only creates; a branch made after the read is refused, never moved", async () => {
  const ANCESTOR = "1".repeat(40);
  for (const command of ["run", "plan"]) {
    const host = fakeHost({ branchHead: "" });
    host.raceBranchHead = ANCESTOR;
    if (command === "run") {
      const error = await runCard({ io: host.io, paths: PATHS }).then(() => null, (e) => e);
      assert.equal(error?.code, "CARD_RUN_BRANCH_CREATE");
      noArming(host);
      assert.equal(host.api.some((call) => call.startsWith("linear todo")), false);
    } else {
      assert.equal((await main(["plan"], host.io, PATHS)).output.prepare.refused, "CARD_RUN_BRANCH_CREATE");
    }
    assert.equal(host.branchHead, ANCESTOR, `${command}: the branch someone else made stays where it is`);
    assert.equal(host.pushDirs.size, 0);
  }
});

test("SHU-86 C41: a tick is read from the journal, flushed first, and only its own invocation counts", () => {
  // The host unloads the finished oneshot, so its InvocationID reads empty;
  // the tick still reads its own lines, never an earlier run's logged at the
  // same instant, and only after journald has flushed them.
  const host = fakeHost({ onTick: () => "first line\nactivation=absent (committed gates only)" });
  host.journal.push({ at: host.clock, invocation: "e".repeat(32), message: "activation=STALE from an earlier run" });
  assert.equal(tick(host.io), "first line\nactivation=absent (committed gates only)");
  const sync = host.calls.indexOf("journalctl --sync");
  const read = host.calls.findIndex((call) => call.startsWith("journalctl _SYSTEMD_UNIT="));
  assert.ok(sync > host.calls.indexOf("systemctl start shu-coordinator.service") && read > sync, "started, then flushed, then read");
  // A tick that left nothing in the journal is a refusal, never the output
  // of the tick before it.
  const silent = fakeHost();
  silent.journal.push({ at: silent.clock - 1, invocation: "e".repeat(32), message: "activation=STALE from an earlier run" });
  silent.dropJournal = true;
  assert.throws(() => tick(silent.io), { code: "CARD_RUN_TICK" });
});

test("SHU-86 C42: a report that never reached Linear is tried again, a bounded number of times, and never posted twice", async () => {
  const flaky = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
  flaky.networkFailures = REPORT_ATTEMPTS - 1;
  const before = flaky.clock;
  const { output } = await main(["run"], flaky.io, PATHS);
  assert.deepEqual(output.report, { posted: true, issue: "SHU-71" });
  assert.equal(flaky.reports.length, 1);
  assert.ok(flaky.clock - before >= (REPORT_ATTEMPTS - 1) * REPORT_RETRY_WAIT_MS, "it waits between tries");
  const down = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
  down.networkFailures = REPORT_ATTEMPTS + 5;
  const result = await main(["run"], down.io, PATHS);
  assert.equal(result.output.ok, true, "a lost report never changes the result");
  assert.equal(result.output.report.posted, false);
  assert.match(result.output.report.reason, /fetch failed/);
  assert.equal(down.api.filter((call) => call === "linear report read SHU-71").length, REPORT_ATTEMPTS);
  assert.equal(down.networkFailures, 5);
  // An answer from Linear, even a refusal, is never asked again.
  const refused = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
  refused.failReport = "read";
  assert.equal((await main(["run"], refused.io, PATHS)).output.report.posted, false);
  assert.equal(refused.api.filter((call) => call === "linear report read SHU-71").length, 1);
  // A comment send that failed is tried again only after the card is read
  // for this run's marker: a send that never arrived is posted on the next
  // try, and one Linear committed before its answer was lost is never posted
  // twice.
  const unsent = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
  unsent.postFailures = 1;
  assert.deepEqual((await main(["run"], unsent.io, PATHS)).output.report, { posted: true, issue: "SHU-71" });
  assert.equal(unsent.reports.length, 1);
  assert.equal(unsent.api.filter((call) => call === "linear report report-uuid").length, 2);
  const lost = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
  lost.lostAnswers = REPORT_ATTEMPTS;
  assert.deepEqual((await main(["run"], lost.io, PATHS)).output.report, { posted: true, issue: "SHU-71" });
  assert.equal(lost.reports.length, 1, "a committed report is never posted twice");
  assert.equal(lost.api.filter((call) => call === "linear report report-uuid").length, 1);
  assert.equal(lost.api.filter((call) => call === "linear report read SHU-71").length, 2);
});

test("SHU-86 C43: a branch main already contains moves forward to main under a lease on its head; one with its own commit never moves", async () => {
  // SHU-327, 2026-10-20: the first run stopped without landing and left its
  // branch at the main it started from; the next install re-armed the queue,
  // and every start refused that branch.
  const left = fakeHost({ branchHead: REV, onTick: passFor("SHU-301") });
  left.mainTip = HEAD;
  left.branchContained = true;
  const result = await runCard({ io: left.io, paths: PATHS }).catch((error) => assert.fail(`the run refused: ${error.message}`));
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.prepared.branch, { branch: "coordinator/SHU-301", head: HEAD, base: HEAD, action: "advance", from: REV });
  assert.equal(left.branchHead, HEAD);
  assert.ok(left.api.includes(`git contains ${REV}`));
  assert.equal(left.api.filter((call) => call.startsWith("git push")).length, 1, "one push, no dry run, during a run");
  assert.ok(left.calls.some((call) => call.includes("--force-with-lease=refs/heads/coordinator/SHU-301:" + REV)), "the lease names the head read");
  assert.equal(left.reports.length, 1);
  assert.match(left.reports[0], new RegExp(`^Before arming: .*moved coordinator/SHU-301 forward from ${REV} to main at ${HEAD}\\.$`, "m"));
  // Plan only dry-runs the same move.
  const planned = fakeHost({ branchHead: REV });
  planned.mainTip = HEAD;
  planned.branchContained = true;
  const out = (await main(["plan"], planned.io, PATHS)).output;
  assert.deepEqual(out.prepare.branch, { branch: "coordinator/SHU-301", head: REV, base: HEAD, action: "advance", from: REV });
  assert.equal(planned.branchHead, REV);
  assert.deepEqual(planned.api.filter((call) => call.startsWith("git push")), [`git push dry-run refs/heads/coordinator/SHU-301 ${HEAD}`]);
  // A branch with a commit main lacks is refused before anything is pushed.
  const own = fakeHost({ branchHead: BASE });
  own.mainTip = HEAD;
  own.branchContained = false;
  await assert.rejects(runCard({ io: own.io, paths: PATHS }), { code: "CARD_RUN_BRANCH_NOT_AT_TARGET" });
  assert.equal(own.branchHead, BASE);
  assert.ok(own.api.includes(`git contains ${BASE}`));
  assert.equal(own.api.some((call) => call.startsWith("git push") || call.startsWith("linear todo")), false);
  noArming(own);
  // A branch someone moves after the read is refused by the lease, never moved.
  const raced = fakeHost({ branchHead: REV });
  raced.mainTip = HEAD;
  raced.branchContained = true;
  raced.raceBranchHead = BASE;
  const error = await runCard({ io: raced.io, paths: PATHS }).then(() => null, (e) => e);
  assert.equal(error?.code, "CARD_RUN_BRANCH_CREATE");
  assert.equal(raced.branchHead, BASE);
  noArming(raced);
  assert.equal(raced.pushDirs.size, 0);
});

test("SHU-86 C45: a branch GitHub still reads at its old head after the push is read again, briefly; any other head refuses", async () => {
  const pass = () => tickText(spent("SHU-301", "review PASS — the episode is complete"));
  const githubReads = (host) => host.api.filter((call) => call === "github read").length;

  // The lag seen on SHU-332: the push landed, the next reads still answer 404.
  const lagging = fakeHost({ branchHead: "", onTick: pass });
  lagging.staleReads = 3;
  const start = lagging.clock;
  const result = await runCard({ io: lagging.io, paths: PATHS }).catch((error) => assert.fail(`the run refused: ${error.message}`));
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.prepared.branch, { branch: "coordinator/SHU-301", head: REV, base: REV, action: "create" });
  assert.equal(lagging.api.filter((call) => call.startsWith("git push")).length, 1, "the branch is pushed once, never again");
  assert.ok(lagging.clock - start >= 3 * BRANCH_READBACK_WAIT_MS, "each read again waits first");

  // A lag that outlasts the bound still refuses, before anything is armed.
  const stuck = fakeHost({ branchHead: "" });
  stuck.staleReads = BRANCH_READBACK_ATTEMPTS + 2;
  assert.equal((await attempt(() => runCard({ io: stuck.io, paths: PATHS }))).thrown, "CARD_RUN_BRANCH_READBACK");
  noArming(stuck);
  assert.equal(githubReads(stuck), 1 + BRANCH_READBACK_ATTEMPTS, "one read before the push, then the bounded read-backs");

  // A head that is neither the old one nor the pushed one is refused at once.
  const moved = fakeHost({ branchHead: "" });
  moved.staleReads = 1;
  moved.lagMovedTo = HEAD;
  assert.equal((await attempt(() => runCard({ io: moved.io, paths: PATHS }))).thrown, "CARD_RUN_BRANCH_READBACK");
  noArming(moved);
  assert.equal(githubReads(moved), 3, "the pre-push read, the lagging read, and the one that saw another head");
});

test("SHU-86 C9: a whole run arms, ticks until the coordinator ends the episode, and reverts", async () => {
  let armedState = null;
  const host = fakeHost({
    onTick: (h) => {
      if (h.ticks === 1) {
        armedState = {
          activation: { ...h.files.get(PATHS.activation), record: activationOf(h) },
          drops: UNITS.map((unit) => [h.files.get(dropIn(unit, RUN_DROP_IN))?.text, h.files.get(dropIn(unit, TARGET_DROP_IN))?.text]),
          environ: [...h.environ],
        };
      }
      if (h.ticks < 3) return tickText(armed(armedId(h)));
      if (h.ticks === 3) return tickText(spent("SHU-301", "review PASS — the episode is complete"), 0);
      return tickText("activation=absent (committed gates only)", 0);
    },
  });
  const { code, output } = await main(["run"], host.io, PATHS);
  assert.equal(code, 0, JSON.stringify(output, null, 2));
  assert.equal(output.ok, true);
  assert.equal(output.outcome, "PASS");
  assert.equal(output.card, "SHU-301");
  assert.equal(output.ticks.length, 3);
  assert.equal(output.revert.reverted, true);
  assert.equal(armedState.activation.mode, 0o640);
  assert.equal(armedState.activation.gid, 998);
  assert.equal(armedState.activation.record.target_issue_id, "SHU-301");
  for (const [run, target] of armedState.drops) {
    assert.equal(run, "[Service]\nEnvironment=ENABLE_DISPATCH=true\n");
    assert.equal(target, `[Service]\nEnvironment=DISPATCH_TARGET_SHA=${REV}\n`);
  }
  assert.ok(armedState.environ.includes("ENABLE_DISPATCH=true"));
  assert.ok(armedState.environ.includes(`DISPATCH_TARGET_SHA=${REV}`));
  reverted(host);
  assert.ok(host.files.has(`${PATHS.stateDir}/spent-${output.revert.retired.split("spent-")[1]}`));
  assert.equal(host.files.has(`${PATHS.tmp}/shu-npm-cache-1/x`), false, "npm caches are cleared");
  assert.equal(host.files.has(`${PATHS.tmp}/keep-me`), true, "other temp files stay");
  assert.ok(host.calls.includes("systemctl start shu71-evidence.service"));
  assert.ok(host.calls.includes("systemctl stop shu71-evidence.service"));
  assert.equal(host.ticks, 4, "three armed ticks and one dispatch-off tick");
});

test("SHU-86 C10: a failed arm still reverts everything it wrote", async () => {
  const host = fakeHost({ edit: (h, when) => { if (when === "restart") h.environ = ["PATH=/usr/bin"]; } });
  const result = await attempt(() => runCard({ io: host.io, paths: PATHS }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "ERROR");
  assert.equal(result.code, "CARD_RUN_ARM_READBACK");
  assert.equal(result.revert.reverted, true);
  reverted(host);
});

test("SHU-86 C11: a run whose card is not eligible on the first tick stops and reverts", async () => {
  const host = fakeHost({ onTick: (h) => tickText(armed(armedId(h)), 0, ["SHU-301            not in Todo"]) });
  const result = await runCard({ io: host.io, paths: PATHS });
  assert.equal(result.outcome, "NOT_ELIGIBLE");
  assert.match(result.reason, /not in Todo/);
  assert.equal(result.ticks.length, 1);
  reverted(host);
});

test("SHU-86 C11b: a run whose card is excluded on the first tick stops even while other cards are eligible", async () => {
  const host = fakeHost({ onTick: (h) => tickText(armed(armedId(h)), 4, [
    "SHU-301 — repository ownership HOLD — missing repo:<name> ownership label",
    "SHU-399 — outside trusted dispatch_scope",
  ]) });
  const result = await runCard({ io: host.io, paths: PATHS });
  assert.equal(result.outcome, "NOT_ELIGIBLE");
  assert.match(result.reason, /missing repo:<name> ownership label/);
  assert.doesNotMatch(result.reason, /SHU-399/);
  assert.equal(result.ticks.length, 1);
  reverted(host);
});

test("SHU-86 C11c: a card excluded only after the first tick does not stop the run early", async () => {
  const host = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(armed(armedId(h))) : tickText(armed(armedId(h)), 0, ["SHU-301 — linked to an open PR"])) });
  const result = await runCard({ io: host.io, paths: PATHS });
  assert.notEqual(result.outcome, "NOT_ELIGIBLE");
  assert.ok(result.ticks.length > 1);
});

test("SHU-86 C11d: a card without exactly one known repo label is refused before any write", async () => {
  for (const [label, labels, pattern] of [
    ["no repo label", [], /missing repo:<name> ownership label/],
    ["two repo labels", [{ name: "repo:platform" }, { name: "repo:legacy" }], /multiple repository ownership labels/],
    ["unknown repo label", [{ name: "repo:elsewhere" }], /unknown repository ownership label/],
  ]) {
    const host = fakeHost({ card: { state: { id: TODO_ID, name: "Todo", type: "unstarted" }, assignee: null, delegate: null, labels: { nodes: labels } }, branchHead: "" });
    await assert.rejects(runCard({ io: host.io, paths: PATHS }), (error) => error.code === "CARD_RUN_CARD_LABELS" && pattern.test(error.message), label);
    noArming(host);
    assert.deepEqual(host.api, ["linear read"], `${label}: nothing is written`);
    assert.equal(host.ticks, 0, `${label}: no tick runs`);
  }
});

test("SHU-86 C12: a run that outlives its window stops at the window and reverts", async () => {
  const host = fakeHost({ onTick: (h) => (h.files.has(PATHS.activation) ? tickText(armed(armedId(h))) : tickText("activation=absent (committed gates only)")) });
  const result = await runCard({ io: host.io, paths: PATHS });
  assert.equal(result.outcome, "EXPIRED");
  assert.ok(result.ticks.length > 1);
  assert.ok(host.clock - START.getTime() >= CARD_RUN_LIMITS.runMs);
  assert.ok(host.clock - START.getTime() <= CARD_RUN_LIMITS.runMs + CARD_RUN_LIMITS.tickIntervalMs, "and not later");
  const deadline = START.getTime() + CARD_RUN_LIMITS.runMs;
  for (const entry of result.ticks) assert.ok(Date.parse(entry.at) < deadline, `no tick starts at or after the window: ${entry.at}`);
  reverted(host);
});

test("SHU-86 C13: revert waits for a running worker and leaves the run armed while one is still running", async () => {
  const busy = fakeHost({ workers: () => 1 });
  busy.files.set(PATHS.activation, { text: "{}" });
  busy.files.set(dropIn("shu-supervisor.service", RUN_DROP_IN), { text: "x" });
  const held = await attempt(() => revert(busy.io, PATHS));
  assert.deepEqual(held, { reverted: false, code: "CARD_RUN_WORKER_STILL_RUNNING" });
  assert.equal(busy.files.has(PATHS.activation), true);
  assert.equal(busy.files.has(dropIn("shu-supervisor.service", RUN_DROP_IN)), true);
  assert.equal(busy.calls.some((call) => call.startsWith("systemctl")), false, "nothing restarts under a live worker");
  const finishing = fakeHost({ workers: (h) => (h.clock - START.getTime() < 5 * 60 * 1000 ? 1 : 0) });
  finishing.files.set(PATHS.activation, { text: "{}" });
  const done = revert(finishing.io, PATHS);
  assert.equal(done.reverted, true);
  assert.ok(finishing.clock - START.getTime() >= 5 * 60 * 1000);
});

test("SHU-86 C14: one run at a time, as root only", async () => {
  const locked = fakeHost();
  locked.files.set(PATHS.lock, { text: "1" });
  await assert.rejects(runCard({ io: locked.io, paths: PATHS }), { code: "CARD_RUN_LOCKED" });
  assert.equal(locked.files.has(PATHS.lock), true, "another run's lock is left alone");
  noArming(locked);
  const user = fakeHost();
  user.io.uid = () => 1000;
  await assert.rejects(runCard({ io: user.io, paths: PATHS }), { code: "CARD_RUN_NOT_ROOT" });
  noArming(user);
});

test("SHU-86 C15: plan changes nothing, and review flags come all together", async () => {
  const host = fakeHost();
  const { code, output } = await main(["plan"], host.io, PATHS);
  assert.equal(code, 0);
  assert.equal(output.record.target_issue_id, "SHU-301");
  assert.deepEqual(output.busy, []);
  assert.deepEqual(output.prepare, { branch: { branch: "coordinator/SHU-301", head: REV, base: REV, action: "none" }, card: { card: "SHU-301", state: "Todo", action: "none" } });
  noArming(host);
  const fresh = fakeHost({ branchHead: "", card: { state: { id: "b", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  const freshPlan = (await main(["plan"], fresh.io, PATHS)).output.prepare;
  assert.equal(freshPlan.branch.action, "create");
  assert.equal(freshPlan.card.action, "move-to-todo");
  assert.deepEqual(fresh.api, ["linear read", "github read", "git fetch main", `git push dry-run refs/heads/coordinator/SHU-301 ${REV}`, "linear read"], "plan only reads, and dry-runs the push");
  assert.equal(fresh.branchHead, "");
  assert.equal(host.files.has(PATHS.lock), false);
  assert.throws(() => parseArgs(["run", "--review-pr", "239"]), { code: "CARD_RUN_USAGE" });
  assert.throws(() => parseArgs(["arm"]), { code: "CARD_RUN_USAGE" });
  assert.deepEqual(parseArgs(["run", "--review-pr", "239", "--review-head", HEAD, "--review-base", BASE, "--author-family", "claude"]).review, REVIEW);
});

test("SHU-86 C16: a unit without its resident drop-in is not armed", async () => {
  const host = fakeHost();
  host.files.delete(dropIn("shu-coordinator.service", RESIDENT_DROP_IN));
  const result = await runCard({ io: host.io, paths: PATHS });
  assert.equal(result.code, "CARD_RUN_RESIDENT_DROP_IN");
  assert.equal(host.ticks, 1, "only the dispatch-off tick ran");
  host.files.set(dropIn("shu-coordinator.service", RESIDENT_DROP_IN), { text: "[Service]\n" });
  reverted(host);
});

test("SHU-86 C17: only an answered card is a successful run; a stop exits non-zero", async () => {
  for (const [reason, outcome, ok, code] of [
    ["stop: retryable failures exhausted", "STOPPED", false, 1],
    [`review-only verdict BLOCKED at ${HEAD} — the episode is complete`, "REVIEW_BLOCKED", true, 0],
    ["review PASS — the episode is complete", "PASS", true, 0],
  ]) {
    const host = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", reason)) : tickText("activation=absent (committed gates only)")) });
    const result = await main(["run"], host.io, PATHS);
    assert.equal(result.output.outcome, outcome);
    assert.equal(result.output.ok, ok, reason);
    assert.equal(result.code, code, reason);
    reverted(host);
  }
});

test("SHU-86 C18: a failed dispatch-off tick still finishes the revert", async () => {
  const host = fakeHost({ onTick: (h) => tickText(spent("SHU-301", "review PASS — the episode is complete")) });
  host.failTicks = new Set([2]);
  const result = await attempt(() => runCard({ io: host.io, paths: PATHS }));
  assert.equal(result.outcome, "PASS");
  assert.equal(result.revert?.reverted, true);
  assert.match(result.revert.dispatch_off_tick, /^tick failed: /);
  reverted(host);
  assert.ok(host.calls.includes("systemctl stop shu71-evidence.service"));
});

test("SHU-86 C19: a failed teardown keeps the activation record, so the host stays busy", async () => {
  const host = fakeHost({ onTick: () => tickText(spent("SHU-301", "review PASS — the episode is complete")) });
  host.failStop = true;
  const result = await attempt(() => runCard({ io: host.io, paths: PATHS }));
  assert.equal(result.revert?.reverted, false);
  assert.equal(result.revert.code, "CARD_RUN_COMMAND");
  assert.equal(host.files.has(PATHS.activation), true, "the record stays until teardown succeeds");
  assert.equal(host.environ.includes("ENABLE_DISPATCH=true"), false, "dispatch is off all the same");
  assert.ok(busyReasons(host.io, PATHS).some((reason) => reason.includes("activation record")));
  assert.equal(host.files.has(PATHS.lock), false);
});

test("SHU-86 C20: no tick starts when arming itself outlasted the window", async () => {
  let restarts = 0;
  const host = fakeHost({
    edit: (h, when) => { if (when === "restart" && ++restarts === 1) h.clock += CARD_RUN_LIMITS.runMs + 1; },
    onTick: (h) => tickText(spent("SHU-301", "review PASS — the episode is complete")),
  });
  const result = await attempt(() => runCard({ io: host.io, paths: PATHS }));
  assert.equal(result.outcome, "EXPIRED");
  assert.equal(result.ok, false);
  assert.deepEqual(result.ticks, []);
  assert.equal(host.ticks, 1, "only the dispatch-off tick ran");
  reverted(host);
});

test("SHU-86 C21: a backlog card nobody owns moves to Todo before arming, and reads back", async () => {
  const host = fakeHost({
    card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null },
    onTick: () => tickText(spent("SHU-301", "review PASS — the episode is complete")),
  });
  const result = await runCard({ io: host.io, paths: PATHS });
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.prepared.card, { card: "SHU-301", state: "Todo", action: "move-to-todo", from: "Backlog" });
  assert.deepEqual(host.api, ["linear read", "github read", "git fetch main", "linear read", `linear todo ${TODO_ID}`, "linear history", "linear read", "linear report read SHU-71", "linear report report-uuid"]);
  reverted(host);
});

test("SHU-86 C22: a card someone owns, or one already started or finished, is refused before any write", async () => {
  for (const [label, card, code] of [
    ["assigned", { state: { id: "b", name: "Backlog", type: "backlog" }, assignee: { id: "person" }, delegate: null }, "CARD_RUN_CARD_OWNED"],
    ["delegated", { state: { id: "t", name: "Todo", type: "unstarted" }, assignee: null, delegate: { id: "agent" } }, "CARD_RUN_CARD_OWNED"],
    ["in progress", { state: { id: "p", name: "In Progress", type: "started" }, assignee: null, delegate: null }, "CARD_RUN_CARD_STATE"],
    ["done", { state: { id: "d", name: "Done", type: "completed" }, assignee: null, delegate: null }, "CARD_RUN_CARD_STATE"],
    ["triage", { state: { id: "r", name: "Triage", type: "triage" }, assignee: null, delegate: null }, "CARD_RUN_CARD_STATE"],
  ]) {
    const host = fakeHost({ card, branchHead: "" });
    await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code }, label);
    noArming(host);
    assert.deepEqual(host.api, ["linear read"], `${label}: nothing is written`);
    assert.equal(host.files.has(PATHS.lock), false);
  }
});

test("SHU-86 C23: a Todo move that does not read back stops the run before arming", async () => {
  const host = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  host.failTodo = true;
  await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code: "CARD_RUN_CARD_READBACK" });
  noArming(host);
  // The move took, but someone claimed the card meanwhile.
  const claimed = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  const BACKLOG = { id: "backlog", name: "Backlog", type: "backlog" };
  claimed.knownStates = { backlog: BACKLOG };
  claimed.beforeTodo = (h) => { h.card.assignee = { id: "person" }; };
  const result = await attempt(() => runCard({ io: claimed.io, paths: PATHS }));
  assert.equal(result.thrown, "CARD_RUN_CARD_READBACK");
  assert.deepEqual(claimed.card.state, BACKLOG, "the run's move is undone, so the owner finds the card where it was");
  assert.deepEqual(claimed.api.filter((call) => call.startsWith("linear todo")), [`linear todo ${TODO_ID}`, "linear todo backlog"]);
  noArming(claimed);
  // Claimed and then moved on by its owner: the owner's move stands.
  const moved = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  moved.knownStates = { backlog: BACKLOG };
  moved.beforeTodo = (h) => { h.card.assignee = { id: "person" }; };
  let reads = 0;
  moved.onCardRead = (h, move) => { if (++reads === 3) move({ id: "progress", name: "In Progress", type: "started" }); };
  assert.equal((await attempt(() => runCard({ io: moved.io, paths: PATHS }))).thrown, "CARD_RUN_CARD_READBACK");
  assert.equal(moved.card.state.id, "progress");
  assert.deepEqual(moved.api.filter((call) => call.startsWith("linear todo")), [`linear todo ${TODO_ID}`]);
  noArming(moved);
});

test("SHU-86 C24: only the coordinator's own private credentials are used, and never shown", async () => {
  for (const [label, change] of [
    ["wrong owner", (h) => { h.files.get(PATHS.coordinatorEnv).uid = 0; }],
    ["group readable", (h) => { h.files.get(PATHS.coordinatorEnv).mode = 0o640; }],
    ["missing token", (h) => { h.files.get(PATHS.coordinatorEnv).text = "GITHUB_TOKEN=gh-secret-value\n"; }],
    ["missing file", (h) => { h.files.delete(PATHS.coordinatorEnv); }],
  ]) {
    const host = fakeHost();
    change(host);
    const result = await attempt(() => runCard({ io: host.io, paths: PATHS }));
    assert.equal(result.thrown, "CARD_RUN_CREDENTIALS", label);
    assert.deepEqual(host.api, [], `${label}: no API call`);
    noArming(host);
  }
  const host = fakeHost({ onTick: () => tickText(spent("SHU-301", "review PASS — the episode is complete")) });
  const { output } = await main(["run"], host.io, PATHS);
  assert.doesNotMatch(JSON.stringify(output), /secret-value/);
  const refused = fakeHost();
  refused.files.get(PATHS.coordinatorEnv).mode = 0o644;
  assert.doesNotMatch(JSON.stringify((await main(["run"], refused.io, PATHS)).output), /secret-value/);
});

test("SHU-86 C25: the card is read again after the branch step, and one started or claimed meanwhile is never moved or armed", async () => {
  const PROGRESS = { id: "progress", name: "In Progress", type: "started" };
  for (const [label, start, change, code] of [
    ["Todo, then started", { id: TODO_ID, name: "Todo", type: "unstarted" }, (h, move) => move(PROGRESS), "CARD_RUN_CARD_STATE"],
    ["Backlog, then started", { id: "backlog", name: "Backlog", type: "backlog" }, (h, move) => move(PROGRESS), "CARD_RUN_CARD_STATE"],
    ["Backlog, then assigned", { id: "backlog", name: "Backlog", type: "backlog" }, (h) => { h.card.assignee = { id: "person" }; }, "CARD_RUN_CARD_OWNED"],
  ]) {
    const host = fakeHost({ card: { state: start, assignee: null, delegate: null }, branchHead: "" });
    let reads = 0;
    host.onCardRead = (h, move) => { if (++reads === 2) change(h, move); };
    await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code }, label);
    assert.equal(host.api.some((call) => call.startsWith("linear todo")), false, `${label}: the card is not moved`);
    assert.deepEqual(host.api.slice(-1), ["linear read"], `${label}: the refusal comes from the second read`);
    noArming(host);
  }
});

test("SHU-86 C26: a card someone starts while the run moves it is put back where they left it, and the run stops", async () => {
  const PROGRESS = { id: "progress", name: "In Progress", type: "started" };
  const host = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  host.knownStates = { progress: PROGRESS };
  host.beforeTodo = (h, move) => move(PROGRESS);
  await assert.rejects(runCard({ io: host.io, paths: PATHS }), { code: "CARD_RUN_CARD_RACE" });
  assert.deepEqual(host.card.state, PROGRESS, "the other move stands");
  assert.deepEqual(host.api.filter((call) => call.startsWith("linear todo")), [`linear todo ${TODO_ID}`, "linear todo progress"]);
  noArming(host);
  // A card that changed again after the run's move is not put back: the later change wins.
  const DONE = { id: "done", name: "Done", type: "completed" };
  const again = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  again.beforeTodo = (h, move) => move(PROGRESS);
  again.afterTodo = (h, move) => move(DONE);
  const refused = await attempt(() => runCard({ io: again.io, paths: PATHS }));
  assert.equal(refused.thrown, "CARD_RUN_CARD_RACE");
  assert.deepEqual(again.card.state, DONE, "the latest change stands");
  assert.deepEqual(again.api.filter((call) => call.startsWith("linear todo")), [`linear todo ${TODO_ID}`], "no stale put-back");
  noArming(again);
  // Without a concurrent move, the run's own move is its only change.
  const calm = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  calm.history.push({ createdAt: "2026-10-09T14:00:00.000Z", fromState: { id: "triage" }, toState: { id: "backlog" } });
  calm.history.push({ createdAt: "2026-10-09T14:30:00.000Z", fromState: null, toState: null });
  const result = await attempt(() => runCard({ io: calm.io, paths: PATHS }));
  assert.equal(result.prepared?.card.action, "move-to-todo", JSON.stringify(result.thrown));
});

test("SHU-86 C27: after the revert, the run posts one plain report on the SHU-71 tracking card", async () => {
  let revertedAtPost = null;
  const host = fakeHost({
    card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: null, delegate: null },
    branchHead: "",
    onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")),
  });
  const fetch = host.io.fetch;
  host.io.fetch = async (url, options) => {
    if (String(options?.body ?? "").includes("CardRunReportComment")) revertedAtPost = !host.files.has(PATHS.activation) && !host.environ.includes("ENABLE_DISPATCH=true");
    return fetch(url, options);
  };
  const { code, output } = await main(["run"], host.io, PATHS);
  assert.equal(code, 0);
  assert.deepEqual(output.report, { posted: true, issue: "SHU-71" });
  assert.equal(revertedAtPost, true, "the report goes out once the host is reverted");
  assert.equal(host.reports.length, 1);
  assert.equal(host.api.filter((call) => call.startsWith("linear report ") && !call.includes(" read ")).length, 1);
  assert.ok(host.api.every((call) => !call.startsWith("linear report") || call.includes("SHU-71") || call.endsWith("report-uuid")), "never on the run's own card");
  const [body] = host.reports;
  assert.equal(body.split("\n")[0], reportMarker(output.activation_id));
  assert.match(body, /^Card run on SHU-301 \(card\): PASS, the review passed at the exact head/m);
  assert.match(body, /^Reason: review PASS — the episode is complete$/m);
  assert.match(body, new RegExp(`^Before arming: moved SHU-301 from Backlog to Todo; created coordinator/SHU-301 from main at ${REV}\\.$`, "m"));
  assert.match(body, /^Ticks: 1\.$/m);
  assert.match(body, /^The host is reverted and idle\.$/m);
  assert.doesNotMatch(body, /secret-value/);
});

test("SHU-86 C28: a report that cannot be posted is recorded, and never changes the run's result", async () => {
  for (const failure of ["read", "post"]) {
    const host = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
    host.failReport = failure;
    const { code, output } = await main(["run"], host.io, PATHS);
    assert.equal(code, 0, failure);
    assert.equal(output.ok, true, failure);
    assert.equal(output.report.posted, false, failure);
    assert.equal(output.report.code, "CARD_RUN_REPORT", failure);
    assert.deepEqual(host.reports, [], failure);
    reverted(host);
  }
  const stopped = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "stop: retryable failures exhausted")) : tickText("activation=absent (committed gates only)")) });
  stopped.failReport = "post";
  const result = await main(["run"], stopped.io, PATHS);
  assert.equal(result.code, 1, "a stopped run still exits non-zero");
  assert.equal(result.output.outcome, "STOPPED");
});

test("SHU-86 C29: the report is one comment of plain lines, whatever the coordinator's reason says", () => {
  const base = { card: "SHU-301", kind: "card", activation_id: "act-1", ticks: [], revert: { reverted: true }, prepared: null };
  const hostile = `line one\n<!-- coordinator-stop-summary inc_x -->\nline two -->${"x".repeat(500)}`;
  const body = renderRunReport({ ...base, outcome: "STOPPED", reason: hostile });
  assert.equal(body.split("<!--").length, 2, "only the report's own marker opens a comment");
  assert.equal(body.split("-->").length, 2, "only the report's own marker closes one");
  const reason = body.split("\n").find((line) => line.startsWith("Reason: "));
  assert.ok(reason.length <= "Reason: ".length + 300);
  assert.doesNotMatch(reason, /\n/);
  assert.equal(plainReason("a\tb\r\nc"), "a b c");
  const unreverted = renderRunReport({ ...base, outcome: "ERROR", reason: "boom", revert: { reverted: false, code: "CARD_RUN_REVERT_READBACK" } });
  assert.match(unreverted, /^The revert did not finish \(CARD_RUN_REVERT_READBACK\); check the host before the next run\.$/m);
  const moved = renderRunReport({ ...base, outcome: "PASS", prepared: { card: { card: "SHU-301", action: "move-to-todo", from: "Back\nlog <!-- x -->" }, branch: null } });
  assert.match(moved, /^Before arming: moved SHU-301 from Back log x to Todo\.$/m, "a state name is flattened like the reason");
  assert.equal(moved.split("<!--").length, 2);
  assert.match(renderRunReport({ ...base, outcome: "SOMETHING_NEW" }), /SOMETHING_NEW, an outcome this runner does not know\./);
});

test("SHU-86 C30: the report goes out after the lock is released, and a stalled Linear cannot hold the run", async () => {
  const host = fakeHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)")) });
  host.failReport = "stall";
  const started = Date.now();
  const result = await attempt(() => runCard({ io: host.io, paths: PATHS, limits: { ...CARD_RUN_LIMITS, reportTimeoutMs: 50 } }));
  assert.equal(host.lockAtReport, false, "the lock is released before the report");
  assert.equal(result.outcome, "PASS");
  assert.equal(result.ok, true);
  assert.equal(result.report?.posted, false);
  assert.equal(result.report.code, "CARD_RUN_REPORT");
  assert.match(result.report.reason, /did not answer within 50 ms/);
  assert.ok(Date.now() - started < 5000, "the run returned at the report deadline");
  reverted(host);
});

// The timer's view of a run: what `auto` did to the host and to Linear.
const passOnFirstTick = (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "review PASS — the episode is complete")) : tickText("activation=absent (committed gates only)"));
const CLAIM = autoClaim(PATHS, REV, "SHU-301");
const untouched = (host) => {
  noArming(host);
  assert.deepEqual(host.api, [], "Linear and GitHub were not called");
  assert.deepEqual(host.reports, []);
};

test("SHU-86 C31: the timer runs the committed card once per installed revision, and never again at that revision", async () => {
  const host = fakeHost({ onTick: passOnFirstTick });
  const first = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(first.skipped, undefined);
  assert.equal(first.outcome, "PASS");
  assert.equal(first.trigger, "timer");
  assert.equal(first.claim, CLAIM);
  reverted(host);
  assert.equal(host.reports.length, 1);
  assert.match(host.reports[0], new RegExp(`^Started by the card-run timer, once for revision ${REV}\\.$`, "m"));
  const recorded = JSON.parse(host.files.get(CLAIM).text);
  assert.equal(recorded.outcome, "PASS");
  assert.equal(recorded.revision, REV);
  assert.equal(host.files.get(CLAIM).mode, 0o600);
  const ticks = host.ticks;
  const calls = host.calls.length;
  const api = host.api.length;
  const second = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(second.skipped, "ALREADY_RAN");
  assert.equal(host.ticks, ticks, "no second run");
  assert.equal(host.api.length, api, "no second Linear call");
  assert.equal(host.reports.length, 1, "no second report");
  assert.ok(host.calls.slice(calls).every((call) => !call.startsWith("systemctl")), "no unit touched");
  host.head = HEAD;
  host.main = HEAD;
  host.files.set(PATHS.receipt, { text: JSON.stringify({ version: 1, revision: HEAD, state: "VERIFIED", effects: [] }), mode: 0o644, uid: 0, gid: 0 });
  host.branchHead = HEAD;
  host.mainTip = HEAD;
  const next = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(next.skipped, undefined, "a new install gets its own run");
  assert.equal(next.claim, autoClaim(PATHS, HEAD, "SHU-301"));
});

test("SHU-86 C32: a paused, locked, busy or not-ready host is skipped without touching the host or Linear", async () => {
  const cases = {
    PAUSED: (h) => h.files.set(PATHS.pause, { text: "" }),
    LOCKED: (h) => h.files.set(PATHS.lock, { text: "1" }),
    HOST_BUSY: (h) => { h.workers = () => 1; },
    NOT_READY: (h) => { h.dirty = " M x\n"; },
  };
  for (const [code, edit] of Object.entries(cases)) {
    const host = fakeHost({ onTick: passOnFirstTick });
    edit(host);
    const { code: exit, output } = await main(["auto"], host.io, PATHS);
    assert.equal(output.skipped, code, code);
    assert.equal(exit, 0, `${code} is a quiet skip`);
    assert.equal(host.files.has(CLAIM), false, `${code} claims nothing`);
    untouched(host);
  }
  const review = fakeHost({ id: "SHU-304" });
  const skipped = await attempt(() => autoRun({ io: review.io, paths: PATHS }));
  assert.equal(skipped.skipped, "NOT_READY", "the timer never runs a review card");
  assert.match(skipped.reason, /CARD_RUN_REVIEW_INPUT/);
  untouched(review);
  const user = fakeHost();
  user.io = { ...user.io, uid: () => 1000 };
  assert.equal((await attempt(() => autoRun({ io: user.io, paths: PATHS }))).thrown, "CARD_RUN_NOT_ROOT");
});

test("SHU-86 C33: a refusal before arming spends the revision's run and is reported once", async () => {
  const host = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: { id: "someone" }, delegate: null } });
  const { code, output } = await main(["auto"], host.io, PATHS);
  assert.equal(code, 1);
  assert.equal(output.outcome, "NOT_STARTED");
  assert.equal(output.ok, false);
  noArming(host);
  assert.equal(host.reports.length, 1);
  assert.match(host.reports[0], /^Card run on SHU-301 \(card\): NOT_STARTED, the run refused before arming\.$/m);
  assert.match(host.reports[0], /^Nothing was armed, so there was nothing to revert\.$/m);
  assert.doesNotMatch(host.reports[0], /revert did not finish/);
  assert.equal(JSON.parse(host.files.get(CLAIM).text).outcome, "NOT_STARTED");
  const again = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(again.skipped, "ALREADY_RAN");
  assert.equal(host.reports.length, 1, "reported once, not on every timer start");
});

test("SHU-86 C44: a refusal before arming writes a finished status, so the watch never reads it as a run that died", async () => {
  // SHU-327, 2026-10-20: the 12:30 start refused before arming and wrote no
  // status; the watch read the failed unit as a run that died before its first
  // write and paused the timer, which then held the next install's starts.
  const host = fakeHost({ card: { state: { id: "backlog", name: "Backlog", type: "backlog" }, assignee: { id: "someone" }, delegate: null } });
  const started = host.io.now().getTime();
  const { code, output } = await main(["auto"], host.io, PATHS);
  assert.equal(code, 1);
  assert.equal(output.outcome, "NOT_STARTED");
  noArming(host);
  const status = readStatus(host.io, PATHS);
  assert.ok(status, "the status file is written and valid");
  assert.equal(status.step, "finished");
  assert.equal(status.outcome, "NOT_STARTED");
  assert.equal(status.card, "SHU-301");
  assert.equal(status.trigger, "timer");
  assert.equal(status.run_id, output.activation_id);
  assert.equal(status.needs_owner, false);
  assert.equal(status.ticks, 0);
  const unit = { state: "failed", running: false, since: Math.floor(started / 1000) * 1000, start: "42" };
  assert.equal(stuckRun({ unit, status, now: started + 30 * 60 * 1000 }), null, "a refused run is not a run that died");
  assert.equal(stuckRun({ unit, status: null, now: started + 30 * 60 * 1000 })?.kind, "failed", "without the status it would be");
});

test("SHU-86 C34: a run that finds the host taken after the claim gives the claim back", async () => {
  const host = fakeHost({ onTick: passOnFirstTick });
  const write = host.fs.writeFileSync;
  host.io = { ...host.io, fs: { ...host.fs, writeFileSync: (file, text, options) => {
    if (file === PATHS.lock) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    return write(file, text, options);
  } } };
  const result = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(result.skipped, "LOCKED");
  assert.equal(host.files.has(CLAIM), false, "the next timer start may still run this revision");
  untouched(host);
});

// systemd as the timer commands see it: unit files on disk, and the states
// the test sets.
function withSystemd(host, { serviceState = "inactive", timerState = "active", enabled = "enabled", disable = "ok" } = {}) {
  const exec = host.exec;
  host.io = { ...host.io, nodePath: () => "/usr/bin/node", exec: (file, args) => {
    const line = args.join(" ");
    if (file === "systemctl" && line === `disable --now ${AUTO_TIMER}`) {
      host.calls.push(`systemctl ${line}`);
      if (disable === "fails") return { status: 1, stdout: "", stderr: "failed" };
      if (disable === "ok") { timerState = "inactive"; enabled = "disabled"; }
      if (disable === "no-readback") { timerState = ""; enabled = ""; }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (file === "systemctl" && line === `is-active ${AUTO_SERVICE}`) { host.calls.push(`systemctl ${line}`); return { status: serviceState === "active" ? 0 : 3, stdout: `${serviceState}\n`, stderr: "" }; }
    if (file === "systemctl" && line === `is-active ${AUTO_TIMER}`) { host.calls.push(`systemctl ${line}`); return { status: 0, stdout: `${timerState}\n`, stderr: "" }; }
    if (file === "systemctl" && line === `is-enabled ${AUTO_TIMER}`) { host.calls.push(`systemctl ${line}`); return { status: 0, stdout: `${enabled}\n`, stderr: "" }; }
    return exec(file, args);
  } };
  return host;
}

test("SHU-86 C35: the timer installs exact units, never replaces different ones, and is removed only between runs", async () => {
  const MODULE = "/srv/shu/studenthub-platform/.github/coordinator/service/card-run.mjs";
  const service = `${PATHS.unitDir}/${AUTO_SERVICE}`;
  const timer = `${PATHS.unitDir}/${AUTO_TIMER}`;
  const host = withSystemd(fakeHost());
  const installed = await attempt(() => installTimer(host.io, PATHS, { node: "/usr/bin/node", module: MODULE }));
  assert.equal(installed.installed, true);
  assert.equal(host.files.get(service).text, autoServiceUnit({ node: "/usr/bin/node", module: MODULE }));
  assert.equal(host.files.get(timer).text, autoTimerUnit());
  assert.match(host.files.get(service).text, /^ExecStart=\/usr\/bin\/node \S+card-run\.mjs auto$/m);
  assert.doesNotMatch(host.files.get(service).text, /^Condition/m, "a skipped start would leave a relative timer stuck; auto checks the pause file");
  assert.match(host.files.get(service).text, /^TimeoutStartSec=8h$/m);
  assert.match(host.files.get(timer).text, /^OnCalendar=\*:00\/30$/m);
  assert.doesNotMatch(host.files.get(timer).text, /^On(Unit|Boot|Startup|Active)/m, "the timer never counts from the service's last state");
  for (const file of [service, timer]) assert.equal(host.files.get(file).mode, 0o644);
  assert.ok(host.calls.includes(`systemctl enable --now ${AUTO_TIMER}`));
  assert.equal((await attempt(() => installTimer(host.io, PATHS, { node: "/usr/bin/node", module: MODULE }))).installed, true, "installing the same units again is a no-op");
  const other = await attempt(() => installTimer(host.io, PATHS, { node: "/usr/local/bin/node", module: MODULE }));
  assert.equal(other.thrown, "CARD_RUN_TIMER", "different units are never replaced");
  assert.equal(host.files.get(service).text, autoServiceUnit({ node: "/usr/bin/node", module: MODULE }));
  const relative = await attempt(() => installTimer(withSystemd(fakeHost()).io, PATHS, { node: "node", module: MODULE }));
  assert.equal(relative.thrown, "CARD_RUN_TIMER");
  const dead = withSystemd(fakeHost(), { timerState: "failed" });
  assert.equal((await attempt(() => installTimer(dead.io, PATHS, { node: "/usr/bin/node", module: MODULE }))).thrown, "CARD_RUN_TIMER", "a timer that does not come up is refused");
  const running = withSystemd(host, { serviceState: "activating" });
  const busy = await attempt(() => removeTimer(running.io, PATHS));
  assert.equal(busy.thrown, "CARD_RUN_TIMER_BUSY", "never stop a run before its revert");
  assert.equal(host.files.has(service), true);
  assert.ok(!host.calls.includes(`systemctl disable --now ${AUTO_TIMER}`));
  for (const [label, options, code] of [
    ["a timer that stays on after disable", { disable: "stays" }, "CARD_RUN_TIMER"],
    ["a failed disable, even with the timer already inactive", { disable: "fails", timerState: "inactive" }, "CARD_RUN_COMMAND"],
    ["a disable whose readback fails", { disable: "no-readback" }, "CARD_RUN_TIMER"],
  ]) {
    assert.equal((await attempt(() => removeTimer(withSystemd(host, options).io, PATHS))).thrown, code, `${label} is refused`);
    assert.equal(host.files.has(timer) && host.files.has(service), true, `after ${label} both unit files stay for a retry`);
  }
  const idle = withSystemd(host);
  assert.deepEqual(await attempt(() => removeTimer(idle.io, PATHS)), { removed: true });
  assert.equal(host.files.has(service), false);
  assert.equal(host.files.has(timer), false);
  assert.ok(host.calls.includes(`systemctl disable --now ${AUTO_TIMER}`));
  const { code, output } = await main(["timer-install"], withSystemd(fakeHost()).io, PATHS);
  assert.equal(code, 0);
  assert.equal(output.installed, true);
});

test("SHU-86 C36: the timer commands take no flags", () => {
  for (const command of ["auto", "timer-install", "timer-remove"]) {
    assert.equal(parseArgs([command]).command, command);
    assert.throws(() => parseArgs([command, "--review-pr", "1"]), { code: "CARD_RUN_USAGE" });
  }
});

test("SHU-86 C37: the commands run from argv the way an operator or the unit starts them", () => {
  // In-process calls to main never reach the CLI entry, which runs while the
  // module is still being evaluated. The child is told it is not root before
  // the module loads, so it refuses before touching the host even when the
  // test runs as root, and without needing the right to switch users. It gets
  // a bare environment, so the test runner's own variables (NODE_TEST_CONTEXT,
  // NODE_OPTIONS) never enrol it in this file's test protocol.
  const module = path.join(HERE, "..", "service", "card-run.mjs");
  const notRoot = "data:text/javascript,process.getuid=()=>65534";
  const cases = [["timer-install", "CARD_RUN_NOT_ROOT"], ["timer-remove", "CARD_RUN_NOT_ROOT"], ["auto", "CARD_RUN_NOT_ROOT"], ["bogus", "CARD_RUN_USAGE"]];
  for (const [command, code] of cases) {
    const child = spawnSync(process.execPath, ["--import", notRoot, module, command], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "" } });
    assert.equal(child.error, undefined, `${command}: ${child.error?.message}`);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /before initialization|ReferenceError/, command);
    assert.equal(child.status, 2, `${command}: ${child.stdout}${child.stderr}`);
    assert.equal(JSON.parse(child.stdout).code, code, command);
  }
});

// SHU-306 — a passed card lands its own work. The fake host gains a landing
// token file, the card's Linear thread (a writer and a reviewer of this run's
// episode, written by the trusted coordinator actor) and the GitHub the landing
// token sees. Everything the landing does is logged in order.
const LAND_PATHS = Object.freeze({ ...PATHS, landEnv: "/srv/shu/card-land.env" });
const PASSED = "1".repeat(40);
const TREE = "2".repeat(40);
const MERGE_SHA = "3".repeat(40);
const ACTOR = COMMITTED.linear_receipt_actor_ids[0];
const REPO = COMMITTED.pilot_repo;
const EPISODE = "shu-301-run-20261009T153007Z";

function cardLineage() {
  const common = { issue_id: "SHU-301", authorization_ref: "SHU-301", repo: REPO, branch: "coordinator/SHU-301", episode_id: EPISODE };
  const writerMade = createReceipt({ ...common, requested_worker: "codex-builder", target_sha: REV, attempt_id: "00000000-0000-4000-8000-000000000301" });
  assert.ok(writerMade.ok, JSON.stringify(writerMade.errors));
  const writer = { ...writerMade.receipt, stage: "COMPLETED", verdict_stage: "BUILD_READY", result_sha: PASSED,
    external_run_id: "codexrun_writer", worker_identity: "codex-author", adapter_status: "completed",
    evidence_links: ["https://example.test/build"], last_activity: "2026-10-09T16:01:00.000Z",
    timestamps: { ...writerMade.receipt.timestamps, launch: "2026-10-09T16:00:10.000Z", terminal: "2026-10-09T16:01:00.000Z" } };
  const reviewMade = createReceipt({ ...common, requested_worker: "claude-verifier", target_sha: PASSED, attempt_id: "00000000-0000-4000-8000-000000000302" });
  assert.ok(reviewMade.ok, JSON.stringify(reviewMade.errors));
  const review = { ...reviewMade.receipt, stage: "COMPLETED", verdict_stage: "PASS", result_sha: null,
    external_run_id: "clauderun_review", worker_identity: "claude-reviewer", adapter_status: "completed",
    evidence_links: ["https://example.test/verdict"], last_activity: "2026-10-09T16:02:00.000Z",
    timestamps: { ...reviewMade.receipt.timestamps, launch: "2026-10-09T16:01:10.000Z", terminal: "2026-10-09T16:02:00.000Z" } };
  assert.equal(validateReceipt(review).valid, true);
  return [writer, review];
}

// options: existingPr, prHead, losePost, checks (per-read conclusions: "green",
// "pending", "red"), strict (false holds the merge), onChecks(land, read),
// token ("none" | "custody"), unprotectedOwner, threads (a human thread per
// isResolved flag), botThreads (SHU-310: [[login, body, typename?]...] per
// thread), settle (landing_thread_settle overrides), editOnReply, loseReply,
// commentOnResolve, editOnMergeIntent, statuses (commit statuses on the head),
// mergeableState, extraRuns ([{ after, run }]: a check run served once more than
// `after` check reads were made), external (external_checks override;
// the settle cases name both review bots, so their threads hold).
function landingHost(options = {}) {
  const external = options.external ?? (options.settle !== undefined ? { required: ["coderabbitai", "sentry"] } : undefined);
  const config = options.settle !== undefined || external !== undefined
    ? configFor("SHU-301", (c) => ({ ...c,
      ...(options.settle !== undefined ? { landing_thread_settle: { ...c.landing_thread_settle, enabled: options.settle !== false, ...(options.settle || {}) } } : {}),
      ...(external !== undefined ? { external_checks: external } : {}) }))
    : undefined;
  const host = fakeHost({ onTick: options.onTick ?? passOnFirstTick, workers: options.workers, ...(config ? { config } : {}) });
  if (options.token !== "none") {
    host.files.set(LAND_PATHS.landEnv, { text: "SHU_LAND_GITHUB_TOKEN=land-secret-value\n", mode: options.token === "custody" ? 0o640 : 0o600, uid: 0, gid: 0 });
  }
  const land = { log: [], comments: [], posts: 0, merges: 0, checkReads: 0, pr: null, merged: false, linearClock: Date.parse("2026-10-09T17:00:00.000Z") };
  host.land = land;
  const comment = (body) => {
    land.linearClock += 1000;
    land.comments.push({ body, createdAt: new Date(land.linearClock).toISOString(), user: { id: ACTOR, displayName: "Coordinator" } });
  };
  for (const receipt of cardLineage()) comment(receiptCommentBody(receipt));
  if (options.existingPr) land.pr = { number: 77, head: options.prHead ?? PASSED };
  let commentSeq = 100;
  const reviewComment = ([login, body, typename = "Bot"]) => {
    commentSeq += 1;
    return { id: `rc${commentSeq}`, url: `https://github.com/${REPO}/pull/77#discussion_r${commentSeq}`, body,
      updatedAt: "2026-10-09T17:30:00Z", author: { __typename: typename, login } };
  };
  land.threads = [
    ...(options.threads ?? []).map((isResolved) => ({ isResolved, comments: [reviewComment(["khalid", "Please rename this.", "User"])] })),
    ...(options.botThreads ?? []).map((comments) => ({ isResolved: false, comments: comments.map(reviewComment) })),
  ].map((thread, index) => ({ id: `PRRT_${index}`, ...thread }));
  land.replies = 0;
  land.resolves = 0;
  const respond = (status, json) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => structuredClone(json) });
  const pullDetail = () => ({ number: 77, state: land.merged ? "closed" : "open", merged: land.merged, merged_at: land.merged ? "2026-10-09T18:00:00Z" : null,
    merge_commit_sha: land.merged ? MERGE_SHA : null, draft: false, mergeable: true, mergeable_state: options.mergeableState ?? "clean", labels: [],
    head: { ref: "coordinator/SHU-301", sha: land.pr.head, repo: { full_name: REPO } }, base: { ref: "main", sha: REV, repo: { full_name: REPO } } });
  const delegate = host.io.fetch;
  host.io.fetch = async (url, request = {}) => {
    if (url === "https://api.linear.app/graphql") {
      const { query, variables } = JSON.parse(request.body);
      if (query.includes("issueUpdate") && !query.includes("CardRunTodo")) { land.log.push("linear state move"); return respond(200, { data: { issueUpdate: { success: true } } }); }
      if (query.includes("CardLandIssue") && (land.droppedReads ?? 0) < (options.dropLandRead ?? 0)) {
        land.droppedReads = (land.droppedReads ?? 0) + 1;
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      if (query.includes("CardLandIssue")) return respond(200, { data: { issue: { id: "issue-uuid", identifier: variables.id, title: "Make the thing" } } });
      if (query.includes("CoordinatorIssueComments")) return respond(200, { data: { issue: { comments: { nodes: land.comments, pageInfo: { hasNextPage: false, endCursor: null } } } } });
      if (query.includes("CoordinatorMergeIssue")) {
        return respond(200, { data: { issue: { id: "issue-uuid", identifier: "SHU-301", title: "Make the thing", state: { name: "Todo", type: "unstarted" },
          labels: { nodes: [] }, relations: { nodes: [] }, comments: { nodes: land.comments } } } });
      }
      if (query.includes("CoordinatorReserve")) {
        assert.equal(variables.issueId, "issue-uuid", "landing writes go on the card");
        const body = variables.body;
        const kind = body.includes("coordinator-merge-attempt") ? `merge-attempt ${/"state": "(\w+)"/.exec(body)[1]}`
          : body.includes("card-land-merged") ? "merge comment" : body.includes("card-land-settle") ? "settle note" : /"handoff"/.test(body) ? "handoff" : "receipt";
        land.log.push(`linear ${kind}`);
        if (options.editOnMergeIntent && kind === "merge-attempt PREPARED") {
          land.threads[0].comments[0] = { ...land.threads[0].comments[0], updatedAt: "2026-10-09T19:00:00Z" };
        }
        comment(body);
        return respond(200, { data: { commentCreate: { success: true, comment: { id: `c${land.comments.length}` } } } });
      }
      return delegate(url, request);
    }
    if (request.headers?.Authorization !== "Bearer land-secret-value") return delegate(url, request);
    if (url === "https://api.github.com/graphql") {
      const { query, variables } = JSON.parse(request.body);
      const resolved = options.resolveThreadsAfter !== undefined && land.checkReads > options.resolveThreadsAfter;
      const view = (thread) => ({ id: thread.id, isResolved: resolved || thread.isResolved,
        comments: { nodes: thread.comments.map((c) => ({ ...c, isMinimized: false })), pageInfo: { hasNextPage: false } } });
      const find = () => land.threads.find((thread) => thread.id === variables.id);
      if (query.includes("CardLandThreadReply")) {
        land.replies += 1;
        land.log.push("github thread reply");
        const thread = find();
        thread.comments.push({ ...reviewComment(["shu-lander", variables.body, "User"]) });
        if (options.editOnReply) thread.comments[0] = { ...thread.comments[0], body: `${thread.comments[0].body}\nEdited.`, updatedAt: "2026-10-09T17:45:00Z" };
        if (options.loseReply) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        return respond(200, { data: { addPullRequestReviewThreadReply: { comment: { id: "reply" } } } });
      }
      if (query.includes("CardLandThreadResolve")) {
        land.resolves += 1;
        land.log.push("github thread resolve");
        find().isResolved = true;
        // A comment that lands between the landing's last read and its resolve.
        if (options.commentOnResolve) find().comments.push(reviewComment(["khalid", "Wait, this one matters.", "User"]));
        return respond(200, { data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } } });
      }
      if (query.includes("CardLandThreadReopen")) {
        land.log.push("github thread reopen");
        find().isResolved = false;
        return respond(200, { data: { unresolveReviewThread: { thread: { id: variables.id, isResolved: false } } } });
      }
      if (/query CardLandThread\(/.test(query)) return respond(200, { data: { viewer: { login: "shu-lander" }, node: view(find()) } });
      const page = respond(200, { data: { viewer: { login: "shu-lander" },
        repository: { pullRequest: { reviewThreads: { nodes: land.threads.map(view), pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      // Changes a settled thread just after a read has seen it unchanged.
      if (query.includes("CardLandThreads") && land.resolves && land.checkReads === options.editAfterThreadsRead) {
        land.threads[0].comments[0] = { ...land.threads[0].comments[0], updatedAt: "2026-10-09T18:45:00Z" };
      }
      return page;
    }
    const prefix = `https://api.github.com/repos/${REPO}`;
    assert.ok(String(url).startsWith(prefix), url);
    const route = String(url).slice(prefix.length);
    const head = encodeURIComponent(`${REPO.split("/")[0]}:coordinator/SHU-301`);
    if (request.method === "POST" && route === "/pulls") {
      land.posts += 1;
      land.log.push("github open pull request");
      const body = JSON.parse(request.body);
      land.opened = body;
      land.pr = { number: 77, head: options.prHead ?? PASSED };
      if (options.losePost) throw new TypeError("fetch failed");
      return respond(201, pullDetail());
    }
    if (request.method === "PUT" && route === "/pulls/77/merge") {
      land.merges += 1;
      land.log.push("github merge");
      land.lockAtMerge = host.files.has(PATHS.lock);
      land.revertedAtMerge = !host.files.has(PATHS.activation) && !host.environ.includes("ENABLE_DISPATCH=true");
      assert.deepEqual(JSON.parse(request.body), { sha: PASSED, merge_method: "squash" });
      land.merged = true;
      return respond(200, { merged: true, sha: MERGE_SHA });
    }
    assert.ok(!request.method || request.method === "GET", `${request.method} ${route}`);
    if (route === `/pulls?state=open&head=${head}&per_page=100`) { land.log.push("github list"); return respond(200, land.pr && !land.merged ? [pullDetail()] : []); }
    if (route === `/pulls?state=all&head=${head}&per_page=100`) return respond(200, land.pr ? [pullDetail()] : []);
    if (route === "/pulls/77") return respond(200, pullDetail());
    if (route === `/commits/${PASSED}/check-runs?filter=latest&per_page=100`) {
      if ((land.droppedChecks ?? 0) < (options.dropChecks ?? 0)) {
        land.droppedChecks = (land.droppedChecks ?? 0) + 1;
        throw new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
      }
      land.checkReads += 1;
      options.onChecks?.(host, land.checkReads);
      const plan = options.checks ?? ["green"];
      const state = plan[Math.min(land.checkReads, plan.length) - 1];
      if (!land.log.includes("github checks")) land.log.push("github checks");
      const runs = [{ name: "fast-checks", app: { id: 15368 },
        status: state === "pending" ? "in_progress" : "completed", conclusion: state === "pending" ? null : state === "red" ? "failure" : "success" }];
      // An optional (not required) check that turns red after landing's green streak.
      if (options.optionalRedAfter !== undefined && land.checkReads > options.optionalRedAfter) {
        runs.push({ name: "optional-lint", app: { id: 15368 }, status: "completed", conclusion: "failure" });
      }
      for (const { after = 0, run } of options.extraRuns ?? []) if (land.checkReads > after) runs.push(run);
      return respond(200, { total_count: runs.length, check_runs: runs });
    }
    if (route === `/commits/${PASSED}/status?per_page=100`) return respond(200, { state: "success", statuses: options.statuses ?? [] });
    if (route === `/commits/${PASSED}`) return respond(200, { commit: { tree: { sha: TREE } } });
    if (route === `/commits/${MERGE_SHA}`) return respond(200, { commit: { tree: { sha: TREE } } });
    if (route === "/branches/main") return respond(200, { protected: true, commit: { sha: REV } });
    if (route === "/branches/main/protection") return respond(200, { required_status_checks: { strict: options.strict !== false, contexts: [], checks: [{ context: "fast-checks", app_id: 15368 }] } });
    if (route === `/compare/${REV}...${PASSED}`) return respond(200, { status: "ahead", base_commit: { sha: REV } });
    throw new Error(`unexpected GitHub route ${route}`);
  };
  return host;
}
const landRun = (host, limits = CARD_RUN_LIMITS) => runCard({ io: host.io, paths: LAND_PATHS, limits });
const handoffs = (host) => parseReceiptsFromComments(host.land.comments, [ACTOR]).filter((r) => r.handoff);
const noLandingWrites = (host) => {
  assert.equal(host.land.merges, 0, "nothing was merged");
  assert.equal(handoffs(host).length, 0, "no handoff was written");
  assert.ok(!host.land.log.some((entry) => entry.startsWith("linear merge")), "no merge record or merge comment");
};
const neverDone = (host) => assert.ok(!host.land.log.includes("linear state move"), "a landing never moves the card");

test("SHU-306 L1: a passed card opens its pull request, waits for green, hands off, merges, and says so on the card", async () => {
  const host = landingHost();
  const result = await landRun(host);
  assert.equal(result.outcome, "PASS");
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  assert.equal(result.land.pr, 77);
  assert.equal(result.land.merge_commit, MERGE_SHA);
  assert.equal(host.land.posts, 1);
  assert.equal(host.land.merges, 1);
  assert.equal(host.land.opened.title, "[SHU-301] Make the thing");
  assert.equal(host.land.opened.base, "main");
  assert.equal(host.land.opened.head, "coordinator/SHU-301");
  assert.match(host.land.opened.body, /^Refs SHU-301$/m);
  assert.match(host.land.opened.body, /SHU-71/);
  assert.doesNotMatch(host.land.opened.body, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i, "never a closing verb");
  assert.deepEqual(host.land.log.filter((e) => e !== "github list"), ["github open pull request", "github checks", "linear handoff",
    "linear merge-attempt PREPARED", "github merge", "linear merge-attempt COMPLETED", "linear merge comment"]);
  const [handoff] = handoffs(host);
  assert.deepEqual(handoff.handoff, { source_attempt_id: "00000000-0000-4000-8000-000000000302", target_sha: PASSED, verdict_stage: "PASS",
    action: "merge-readiness", hold_code: "MISSING_AUTHORITY" });
  const comment = host.land.comments.find((c) => c.body.includes("card-land-merged")).body;
  assert.match(comment, /pull request #77/);
  assert.ok(comment.includes(MERGE_SHA));
  neverDone(host);
  assert.equal(COMMITTED.routine_merge_authority.enabled, false, "the committed gate stays off");
  assert.equal(process.env.ENABLE_ROUTINE_MERGE, undefined, "the runtime gate never enters the environment");
  assert.equal(host.land.lockAtMerge, true, "the run lands under its own lock");
  assert.equal(host.land.revertedAtMerge, true, "and only once the host is back to dispatch off");
  assert.equal(host.files.has(PATHS.lock), false, "the lock is released after landing");
  assert.match(host.reports[0], /^Landing: MERGED, its pull request went green and the SHU-259 consumer merged it\.$/m);
  assert.match(host.reports[0], new RegExp(`^Landed: pull request #77 \\(opened by this run\\); merge commit ${MERGE_SHA}\\.$`, "m"));
  assert.doesNotMatch(JSON.stringify(result) + host.reports.join("\n"), /land-secret-value|gh-secret-value|lin-secret-value/);
  reverted(host);
});

test("SHU-86 0a: a timer run's final claim keeps claimed_at and records its timing, pull request and reviewed head", async () => {
  const host = landingHost();
  const result = await autoRun({ io: host.io, paths: LAND_PATHS });
  assert.equal(result.land?.outcome, "MERGED", JSON.stringify(result.land));
  const claim = JSON.parse(host.files.get(autoClaim(LAND_PATHS, REV, "SHU-301")).text);
  assert.deepEqual(Object.keys(claim), ["card", "revision", "claimed_at", "activation_id", "outcome", "ok", "land", "armed_at", "first_tick_at",
    "last_tick_at", "finished_at", "repo", "pr", "reviewed_head", "reverted", "first_dispatch_at", "last_progress_at", "max_progress_gap_ms", "would_stall"]);
  assert.equal(typeof claim.max_progress_gap_ms, "number", "SHU-86 0b: the committed config watches every run");
  assert.equal(claim.would_stall, null, "SHU-86 0b: no limit is configured, so nothing would have stopped it");
  assert.equal(claim.outcome, "PASS");
  assert.equal(claim.land, "MERGED");
  assert.equal(claim.pr, 77);
  assert.equal(claim.reviewed_head, PASSED);
  assert.equal(claim.repo, COMMITTED.pilot_repo);
  assert.equal(claim.reverted, true);
  for (const field of ["claimed_at", "armed_at", "first_tick_at", "last_tick_at", "finished_at"]) {
    assert.match(claim[field], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, `SHU-86 0a: ${field} is a timestamp`);
  }
  assert.ok(claim.claimed_at <= claim.armed_at && claim.armed_at <= claim.first_tick_at && claim.first_tick_at <= claim.last_tick_at
    && claim.last_tick_at <= claim.finished_at, "SHU-86 0a: the timestamps are in run order");
});

test("SHU-86 0a: a claim for a run refused before arming keeps claimed_at and records no timing, pull request or head", async () => {
  const host = fakeHost({ branchHead: REV });
  host.mainTip = HEAD;
  const result = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(result.outcome, "NOT_STARTED", JSON.stringify(result));
  const claim = JSON.parse(host.files.get(autoClaim(PATHS, REV, "SHU-301")).text);
  assert.match(claim.claimed_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(claim.armed_at, null);
  assert.equal(claim.first_tick_at, null);
  assert.equal(claim.pr, null);
  assert.equal(claim.reviewed_head, null);
  assert.equal(claim.reverted, null);
  assert.equal(claim.finished_at, null, "SHU-86 0a: a run that never armed never finished");
});

test("SHU-86 0a: a timer run whose pull request is not at the passed head records the pull request but no reviewed head", async () => {
  const host = landingHost({ existingPr: true, prHead: "9".repeat(40) });
  const result = await autoRun({ io: host.io, paths: LAND_PATHS });
  assert.equal(result.land?.outcome, "LAND_HEAD_MISMATCH", JSON.stringify(result.land));
  const claim = JSON.parse(host.files.get(autoClaim(LAND_PATHS, REV, "SHU-301")).text);
  assert.equal(claim.land, "LAND_HEAD_MISMATCH");
  assert.equal(claim.pr, 77);
  assert.equal(claim.reviewed_head, null, "SHU-86 0a: a head mismatch never records a reviewed head");
});

test("SHU-86 0a: a timer run stopped on red checks records the pull request at its reviewed head", async () => {
  const host = landingHost({ checks: ["pending", "red"] });
  const result = await autoRun({ io: host.io, paths: LAND_PATHS });
  assert.equal(result.land?.outcome, "PR_OPENED_CI_RED", JSON.stringify(result.land));
  const claim = JSON.parse(host.files.get(autoClaim(LAND_PATHS, REV, "SHU-301")).text);
  assert.equal(claim.pr, 77);
  assert.equal(claim.reviewed_head, PASSED, "SHU-86 0a: a matched pull request records the head the review passed");
});

// Self-watch 0b: a receipt comment for this run's activation, as the
// coordinator posts it.
const watchReceipt = (episode, timestamps, extra = {}) => ({
  body: receiptCommentBody({ receipt_version: "1.1.0", attempt_id: "00000000-0000-4000-8000-0000000000b0", issue_id: "SHU-301", episode_id: episode,
    stage: "RUNNING", timestamps: { reserved: null, launch: null, heartbeat: null, terminal: null, ...timestamps }, last_activity: timestamps.heartbeat ?? null, ...extra }),
  createdAt: timestamps.heartbeat ?? timestamps.launch, user: { id: COMMITTED.linear_receipt_actor_ids[0], displayName: "Coordinator" },
});
// Ticks 1 to 4 armed, tick 5 passes; the worker's heartbeat moves on the first
// two ticks and then freezes. Each armed tick prints the watch line the real
// tick renders from the receipts it read; `watchLine` replaces it.
function watchedHost({ config, frozenAfter = 2, episode = null, receipts = true, watchLine = null } = {}) {
  let launch = null;
  let heartbeat = null;
  const host = fakeHost({
    ...(config ? { config } : {}),
    onTick: (h) => {
      if (h.ticks <= frozenAfter) {
        launch ??= new Date(h.clock).toISOString();
        heartbeat = new Date(h.clock).toISOString();
      }
      if (h.ticks < 5) {
        const id = armedId(h);
        const comments = receipts && launch ? [watchReceipt(episode ?? id, { launch, heartbeat })] : [];
        const line = watchLine ? watchLine(h, id) : renderWatchLine({ state: "armed", target_issue_id: "SHU-301", activation_id: id },
          parseReceiptsFromComments(comments, COMMITTED.linear_receipt_actor_ids));
        return [tickText(armed(id)), ...(line ? [line] : [])].join("\n");
      }
      if (h.ticks === 5) return tickText(spent("SHU-301", "review PASS — the episode is complete"), 0);
      return tickText("activation=absent (committed gates only)", 0);
    },
  });
  host.watched = () => ({ launch, heartbeat });
  return host;
}
const unwatched = () => configFor("SHU-301", (c) => { const { watch, ...rest } = c; return rest; });

test("SHU-86 0b: the observe-only watch records first dispatch, last progress and the longest stretch without progress, and changes nothing else", async () => {
  const host = watchedHost();
  const { code, output } = await main(["run"], host.io, PATHS);
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(output.outcome, "PASS");
  assert.equal(output.ticks.length, 5);
  assert.equal(output.watch.receipt_reads, 4, "each armed tick's report is read; the ending tick is not");
  const { launch, heartbeat } = host.watched();
  assert.equal(output.watch.mode, "observe");
  assert.equal(output.watch.first_dispatch_at, launch);
  assert.equal(output.watch.last_progress_at, heartbeat);
  assert.ok(output.watch.max_progress_gap_ms >= 3 * CARD_RUN_LIMITS.tickIntervalMs, "the frozen stretch to the end of the run counts");
  assert.equal(output.watch.would_stall, null);
  assert.equal(output.watch.receipt_read_failures, 0);
  assert.match(host.reports[0], /^Watch \(observe only\): first dispatch .*; longest stretch without progress \d+ min; no limit set\.$/m);
  reverted(host);
});

test("SHU-86 0b: a configured limit only records would_stall; the run ends exactly as it would have", async () => {
  const stalled = watchedHost({ config: configFor("SHU-301", (c) => ({ ...c, watch: { observe: true, stall_minutes: 1 } })) });
  const one = await main(["run"], stalled.io, PATHS);
  assert.equal(one.output.outcome, "PASS", "observe mode never stops a run");
  assert.equal(one.output.watch.would_stall?.kind, "no_progress");
  assert.equal(one.output.watch.would_stall?.minutes, 1);
  assert.match(stalled.reports[0], /a 1-minute no_progress limit would have stopped it at /);
  const silent = watchedHost({ receipts: false, config: configFor("SHU-301", (c) => ({ ...c, watch: { observe: true, first_dispatch_minutes: 1 } })) });
  const two = await main(["run"], silent.io, PATHS);
  assert.equal(two.output.outcome, "PASS");
  assert.equal(two.output.watch.would_stall?.kind, "no_first_dispatch");
  assert.equal(two.output.watch.first_dispatch_at, null);
  const healthy = watchedHost({ frozenAfter: 5, config: configFor("SHU-301", (c) => ({ ...c, watch: { observe: true, stall_minutes: 2, first_dispatch_minutes: 2 } })) });
  const three = await main(["run"], healthy.io, PATHS);
  assert.equal(three.output.watch.would_stall, null, "a heartbeat that keeps moving never would have stalled");
});

test("SHU-86 0b: a tick that reports the thread unread, no line, or a malformed one is no progress and never ends the run", async () => {
  for (const [name, line] of [["unread", (h, id) => `watch=SHU-301 episode=${id} unread`], ["absent", () => null],
    ["malformed", (h, id) => `watch=SHU-301 episode=${id} first_dispatch=yesterday latest=none`]]) {
    const host = watchedHost({ watchLine: line });
    const { output } = await main(["run"], host.io, PATHS);
    assert.equal(output.outcome, "PASS", name);
    assert.equal(output.watch.receipt_read_failures, 4, name);
    assert.equal(output.watch.receipt_reads, 0, name);
    assert.equal(output.watch.first_dispatch_at, null, name);
    assert.match(host.reports[0], /4 receipt read\(s\) failed/, name);
    reverted(host);
  }
});

test("SHU-86 0b: observing makes no request of its own, so it cannot spend the budget the next tick needs", async () => {
  const plain = watchedHost({ config: unwatched() });
  const off = await main(["run"], plain.io, PATHS);
  const host = watchedHost();
  const on = await main(["run"], host.io, PATHS);
  assert.equal(on.output.watch.receipt_reads, 4);
  assert.equal(host.linearCalls, plain.linearCalls, "the same Linear requests with observe on and off");
  assert.deepEqual(host.api, plain.api);
  assert.equal(on.output.outcome, off.output.outcome);
  assert.deepEqual(on.output.ticks, off.output.ticks, "every tick starts when it would have and reads as it would have");
  assert.equal(on.output.timing.finished_at, off.output.timing.finished_at, "the run ends when it would have");
  // A Linear budget with exactly the requests the observe-off run needed:
  // the observed run fits inside it too.
  let left = plain.linearCalls;
  const budget = watchedHost();
  const fetch = budget.io.fetch;
  budget.io.fetch = async (url, options) => {
    if (url === "https://api.linear.app/graphql" && left-- <= 0) throw new Error("the Linear budget is spent");
    return fetch(url, options);
  };
  const tight = await main(["run"], budget.io, PATHS);
  assert.equal(tight.output.outcome, off.output.outcome);
  assert.deepEqual(tight.output.land, off.output.land);
  assert.equal(left, 0);
});

test("SHU-86 0b: another run's receipts or another card's line never count as this run's progress", async () => {
  const host = watchedHost({ episode: "shu-301-run-20261001T000000Z" });
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.watch.first_dispatch_at, null);
  assert.equal(output.watch.last_progress_at, null);
  const at = "2026-10-09T15:31:00.000Z";
  for (const line of [(h, id) => `watch=SHU-301 episode=shu-301-run-20261001T000000Z first_dispatch=${at} latest=${at}`,
    (h, id) => `watch=SHU-302 episode=${id} first_dispatch=${at} latest=${at}`]) {
    const other = watchedHost({ watchLine: line });
    const run = await main(["run"], other.io, PATHS);
    assert.equal(run.output.watch.first_dispatch_at, null);
    assert.equal(run.output.watch.receipt_read_failures, 4);
  }
});

test("SHU-86 0b: the tick's watch line round-trips, and only an armed activation prints one", () => {
  const activation = { state: "armed", target_issue_id: "SHU-301", activation_id: "shu-301-run-1" };
  const comments = [watchReceipt("shu-301-run-1", { launch: "2026-10-09T15:31:00.000Z", heartbeat: "2026-10-09T15:40:00.000Z" }),
    { ...watchReceipt("shu-301-run-1", { launch: "2026-10-09T15:00:00.000Z", heartbeat: "2026-10-09T16:00:00.000Z" }), user: { id: "someone-else", displayName: "X" } }];
  const line = renderWatchLine(activation, parseReceiptsFromComments(comments, COMMITTED.linear_receipt_actor_ids));
  assert.equal(line, "watch=SHU-301 episode=shu-301-run-1 first_dispatch=2026-10-09T15:31:00.000Z latest=2026-10-09T15:40:00.000Z");
  assert.deepEqual(parseWatchLine(`x\n${line}\ny`, { card: "SHU-301", activationId: "shu-301-run-1" }),
    { firstDispatch: Date.parse("2026-10-09T15:31:00.000Z"), latest: Date.parse("2026-10-09T15:40:00.000Z") });
  assert.equal(renderWatchLine(activation, [], { unread: true }), "watch=SHU-301 episode=shu-301-run-1 unread");
  assert.equal(renderWatchLine(activation, []), "watch=SHU-301 episode=shu-301-run-1 first_dispatch=none latest=none");
  for (const state of ["absent", "refused", "spent"]) assert.equal(renderWatchLine({ ...activation, state }, []), null);
});

test("SHU-86 0b: an armed tick prints its card's watch line from the receipts it already read", async () => {
  const h = createEpisodeHarness();
  try {
    const first = await h.runTick();
    assert.equal(first.code, 0, first.text);
    const id = h.record.activation_id;
    assert.match(first.text, new RegExp(`^watch=${h.issueId} episode=${id} first_dispatch=none latest=none$`, "m"),
      "the first tick read the card before anything dispatched");
    const build = h.receipts().find((r) => r.issue_id === h.issueId && r.episode_id === id);
    assert.ok(build?.timestamps?.launch, first.text);
    // On the host the coordinator's own Linear user writes every receipt; a
    // receipt anyone else wrote, however early, never counts.
    for (const comment of h.comments) comment.user ??= { id: h.config.linear_receipt_actor_ids[0], displayName: "Coordinator" };
    const forged = { ...build, attempt_id: "00000000-0000-4000-8000-0000000000f0",
      timestamps: { ...build.timestamps, reserved: "2026-09-10T11:00:00.000Z", launch: "2026-09-10T11:00:00.000Z" } };
    h.comments.push({ body: receiptCommentBody(forged), createdAt: "2026-09-10T11:00:00.000Z", user: { id: "someone-else", displayName: "X" } });
    const second = await h.runTick();
    const progress = parseWatchLine(second.text, { card: h.issueId, activationId: id });
    assert.equal(progress?.firstDispatch, Date.parse(build.timestamps.launch), second.text);
    assert.ok(progress.latest >= progress.firstDispatch);
    const lines = second.text.split("\n");
    assert.equal(lines.indexOf(lines.find((l) => l.startsWith("watch="))), lines.indexOf(lines.find((l) => l.startsWith("activation="))) + 1,
      "the line sits right under the activation line");
    fs.unlinkSync(h.activationPath);
    const absent = await h.runTick();
    assert.doesNotMatch(absent.text, /^watch=/m, "nothing armed, no line");
  } finally { h.cleanup(); }
});

test("SHU-86 0b: with observe off nothing is read and the claim's watch fields are null", async () => {
  const host = watchedHost({ config: unwatched() });
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "PASS");
  assert.equal(output.watch, undefined);
  assert.doesNotMatch(host.reports[0], /^Watch /m);
});

test("SHU-86 0b: a journal read that times out ends the run as an ERROR; the coordinator start is never cut short", async () => {
  const host = watchedHost();
  const exec = host.io.exec;
  const starts = [];
  const reads = [];
  host.io.exec = (file, args, options) => {
    if (file === "systemctl" && args[0] === "start" && args[1] === "shu-coordinator.service") starts.push(options?.timeoutMs);
    if (file === "journalctl") {
      reads.push(options?.timeoutMs);
      if (args[0] === "--sync" && starts.length === 2) return { status: 1, stdout: "", stderr: "", timedOut: true };
    }
    return exec(file, args, options);
  };
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "ERROR");
  assert.match(output.reason, /journalctl --sync timed out after 600000 ms/);
  assert.ok(reads.length >= 3 && reads.every((ms) => ms === CARD_RUN_LIMITS.tickCallTimeoutMs), "every journal read is bounded");
  assert.ok(starts.length >= 2 && starts.every((ms) => ms === undefined), "the coordinator start runs to its own end");
  reverted(host);
});

test("SHU-86 0c: the unit's time limit stays above the run window, a hung tick, worker grace, landing and its reports", () => {
  const need = CARD_RUN_LIMITS.runMs + CARD_RUN_LIMITS.tickCallTimeoutMs + CARD_RUN_LIMITS.workerGraceMs + CARD_RUN_LIMITS.landWaitMs
    + 4 * CARD_RUN_LIMITS.reportTimeoutMs;
  assert.ok(AUTO_TIMEOUT_START_MS > need, `${AUTO_TIMEOUT_START_MS} must exceed ${need}`);
  assert.equal(AUTO_TIMEOUT_START_MS, 8 * 60 * 60 * 1000, "SHU-86 0c: the unit limit stays 8h");
});

// Every status the run wrote, in order, read back as the file held it.
function statusLog(host) {
  const log = [];
  const rename = host.io.fs.renameSync;
  host.io.fs.renameSync = (from, to) => {
    rename(from, to);
    if (to === statusPath(PATHS)) log.push(JSON.parse(host.files.get(to).text));
  };
  return log;
}

test("SHU-86 0e: the run keeps its status file at every step, with no request of its own", async () => {
  const host = watchedHost();
  host.io.invocation = () => "0123456789abcdef0123456789abcdef";
  const log = statusLog(host);
  let linearAt = [];
  const fetch = host.io.fetch;
  host.io.fetch = async (url, options) => {
    if (url === "https://api.linear.app/graphql") linearAt.push(log.length);
    return fetch(url, options);
  };
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "PASS");
  assert.deepEqual(log.map((s) => s.step), ["armed", "ticking", "ticking", "ticking", "ticking", "ticking", "reverting", "landing", "finished"]);
  assert.ok(linearAt.every((n) => n === 0 || n === log.length), "no Linear request between arming and the end of the run");
  const last = log.at(-1);
  const { launch, heartbeat } = host.watched();
  assert.equal(last.version, 1);
  assert.equal(last.run_id, output.activation_id);
  assert.ok(log.every((s) => s.invocation === "0123456789abcdef0123456789abcdef"), "every status names the unit's invocation");
  assert.equal(last.card, "SHU-301");
  assert.deepEqual(last.queue, ["SHU-301"]);
  assert.equal(last.ticks, 5);
  assert.equal(last.outcome, "PASS");
  assert.equal(last.reverted, true);
  assert.equal(last.first_dispatch_at, launch);
  assert.equal(last.last_progress_at, heartbeat);
  assert.equal(last.paused, false);
  assert.match(last.next_start, /^\d{4}-\d\d-\d\dT\d\d:(00|30):00\.000Z$/);
  assert.ok(Date.parse(last.next_start) > Date.parse(last.updated_at));
  assert.equal(log[1].ticks, 1);
  assert.equal(log[1].outcome, undefined, "no outcome while the run is ticking");
  assert.equal(host.files.get(statusPath(PATHS)).mode, 0o600);
  assert.ok(!host.files.has(`${statusPath(PATHS)}.tmp`), "written by rename");
  for (const status of log) assert.doesNotMatch(JSON.stringify(status), /secret-value/);
  assert.equal(output.status_write_failures, 0);
  reverted(host);
});

test("SHU-86 0e: the tick that ends the run is recorded too, with any progress it reports", async () => {
  const launch = new Date(START.getTime() + 90 * 1000).toISOString();
  const host = fakeHost({
    onTick: (h) => {
      const id = armedId(h);
      if (h.ticks === 1) return [tickText(armed(id)), `watch=SHU-301 episode=${id} first_dispatch=none latest=none`].join("\n");
      // A tick that ends the run while still printing this run's line: its progress counts.
      return [tickText(spent("SHU-301", "review PASS — the episode is complete"), 0),
        `watch=SHU-301 episode=${id} first_dispatch=${launch} latest=${launch}`].join("\n");
    },
  });
  const log = statusLog(host);
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "PASS");
  assert.deepEqual(log.filter((s) => s.step === "ticking").map((s) => s.ticks), [1, 2], "one ticking write per tick, the last one included");
  assert.equal(log.find((s) => s.step === "ticking" && s.ticks === 2).first_dispatch_at, launch);
  assert.equal(log.at(-1).first_dispatch_at, launch);
  assert.equal(output.watch.first_dispatch_at, launch);
  assert.equal(output.watch.receipt_reads, 2);
  assert.equal(output.watch.receipt_read_failures, 0);
  // A first tick that finds the card not eligible is recorded and observed as well.
  const excluded = fakeHost({ onTick: (h) => [tickText(armed(armedId(h)), 0), `watch=SHU-301 episode=${armedId(h)} first_dispatch=none latest=none`].join("\n") });
  const elog = statusLog(excluded);
  const two = await main(["run"], excluded.io, PATHS);
  assert.equal(two.output.outcome, "NOT_ELIGIBLE");
  assert.deepEqual(elog.map((s) => s.step), ["armed", "ticking", "reverting", "finished"]);
  assert.equal(two.output.watch.receipt_reads, 1);
  reverted(host);
});

test("SHU-86 0e: a status file that cannot be written never changes the run", async () => {
  const plain = watchedHost();
  const ok = await main(["run"], plain.io, PATHS);
  const host = watchedHost();
  const rename = host.io.fs.renameSync;
  host.io.fs.renameSync = (from, to) => {
    if (to === statusPath(PATHS)) throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    return rename(from, to);
  };
  const { code, output } = await main(["run"], host.io, PATHS);
  assert.equal(code, ok.code);
  assert.equal(output.outcome, ok.output.outcome);
  assert.deepEqual(output.ticks, ok.output.ticks);
  assert.equal(output.status_write_failures, 9, "every write failed, and each was only counted");
  assert.deepEqual(host.api, plain.api, "the same requests either way");
  reverted(host);
});

test("SHU-86 0e: a run that needs the owner opens its report with one alert line", async () => {
  const base = { card: "SHU-301", kind: "card", activation_id: "act-1", ticks: [], revert: { reverted: true }, prepared: null };
  const profile = "https://linear.app/bawes/profiles/owner";
  for (const outcome of ["ERROR", "STALLED", "QUOTA_EXHAUSTED"]) {
    assert.equal(needsOwner({ outcome }), true, outcome);
    assert.equal(renderRunReport({ ...base, outcome }).split("\n")[2], "Alert: this run needs the owner.", outcome);
  }
  for (const land of ["PR_OPENED_CI_RED", "CI_TIMEOUT", "MERGE_HOLD", "LAND_SKIPPED_NO_TOKEN", "LAND_ERROR", "THREADS_HELD"]) {
    assert.equal(needsOwner({ outcome: "PASS", land: { outcome: land } }), true, land);
  }
  for (const outcome of ["EXPIRED", "STOPPED", "PASS", "NOT_ELIGIBLE"]) {
    const unreverted = { ...base, outcome, revert: { reverted: false, code: "CARD_RUN_REVERT_READBACK" } };
    assert.equal(needsOwner(unreverted), true, `an unfinished revert after ${outcome}`);
    assert.equal(renderRunReport(unreverted).split("\n")[2], "Alert: this run needs the owner.", outcome);
  }
  assert.equal(needsOwner({ outcome: "NOT_STARTED", revert: null }), false, "nothing was armed, so nothing was left to revert");
  for (const quiet of [{ outcome: "PASS", land: { outcome: "MERGED" } }, { outcome: "REVIEW_PASS" }, { outcome: "STOPPED" }, { outcome: "NOT_ELIGIBLE" }]) {
    assert.equal(needsOwner(quiet), false, JSON.stringify(quiet));
    assert.doesNotMatch(renderRunReport({ ...base, ...quiet }), /^Alert:/m);
  }
  assert.equal(alertLine({ outcome: "ERROR", owner_mention: profile }), `Alert: this run needs the owner (${profile}).`);
  for (const bad of ["@khalid", "https://evil.example/profiles/x", `${profile})\n<!-- x -->`, "javascript:alert(1)", 7]) {
    assert.equal(ownerMention(bad), null, String(bad));
    assert.equal(alertLine({ outcome: "ERROR", owner_mention: bad }), "Alert: this run needs the owner.");
  }
  assert.equal(nextStart(new Date("2026-10-17T19:05:12.000Z")), "2026-10-17T19:30:00.000Z");
  assert.equal(nextStart(new Date("2026-10-17T19:45:00.000Z")), "2026-10-17T20:00:00.000Z");
  assert.equal(nextStart(new Date("2026-10-17T23:59:59.000Z")), "2026-10-18T00:00:00.000Z");
});

test("SHU-86 0e: a landed card raises no alert, a held landing does, and the status says which", async () => {
  const merged = landingHost();
  const one = await landRun(merged);
  assert.equal(one.land.outcome, "MERGED");
  assert.equal(one.needs_owner, false);
  assert.doesNotMatch(merged.reports[0], /^Alert:/m);
  const finished = JSON.parse(merged.files.get(statusPath(LAND_PATHS)).text);
  assert.equal(finished.land, "MERGED");
  assert.equal(finished.needs_owner, false);
  const red = landingHost({ checks: ["pending", "red"] });
  const two = await landRun(red);
  assert.equal(two.land.outcome, "PR_OPENED_CI_RED");
  assert.equal(two.needs_owner, true);
  assert.match(red.reports[0], /^Alert: this run needs the owner\.$/m);
  assert.equal(JSON.parse(red.files.get(statusPath(LAND_PATHS)).text).needs_owner, true);
});

test("SHU-306 L2: an open pull request is reused, never opened twice", async () => {
  const host = landingHost({ existingPr: true });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  assert.equal(host.land.posts, 0, "no second pull request");
  assert.equal(result.land.opened, false);
  neverDone(host);
});

test("SHU-306 L3: a lost answer to the open is read back, never sent again", async () => {
  const host = landingHost({ losePost: true });
  const result = await landRun(host);
  assert.equal(host.land.posts, 1, "one POST only");
  assert.equal(host.land.log.filter((e) => e === "github list").length >= 2, true, "the list is read again");
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  assert.equal(result.land.opened, false, "a pull request found after a lost answer is not reported as this run's");
});

test("SHU-306 L4: a pull request whose head is not the passed head stops before any check is read", async () => {
  const host = landingHost({ existingPr: true, prHead: "9".repeat(40) });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "LAND_HEAD_MISMATCH", JSON.stringify(result.land));
  assert.equal(host.land.checkReads, 0, "no wait on a head the review never passed");
  assert.equal(result.land.head, PASSED, "SHU-86 0a: a stopped landing still names the head the review passed");
  assert.equal(result.land.reviewed_head, undefined, "SHU-86 0a: but never as the reviewed head of a pull request it did not match");
  noLandingWrites(host);
  assert.match(host.reports[0], /^Landing: LAND_HEAD_MISMATCH, /m);
});

test("SHU-306 L5: red checks stop the landing with no handoff and no merge", async () => {
  const host = landingHost({ checks: ["pending", "red"] });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "PR_OPENED_CI_RED", JSON.stringify(result.land));
  assert.equal(result.land.pr, 77);
  noLandingWrites(host);
  neverDone(host);
  assert.match(host.reports[0], /^Landing: PR_OPENED_CI_RED, /m);
});

test("SHU-306 L6: checks that never go green stop at the bound with no handoff and no merge", async () => {
  const host = landingHost({ checks: ["pending"] });
  const before = host.clock;
  const result = await landRun(host);
  assert.equal(result.land.outcome, "CI_TIMEOUT", JSON.stringify(result.land));
  noLandingWrites(host);
  const waited = host.clock - before;
  assert.ok(waited >= CARD_RUN_LIMITS.landWaitMs && waited <= CARD_RUN_LIMITS.landWaitMs + 2 * CARD_RUN_LIMITS.landPollMs, `waited ${waited}`);
  // The whole run stays inside the unit's start timeout.
  const worst = CARD_RUN_LIMITS.runMs + CARD_RUN_LIMITS.workerGraceMs + CARD_RUN_LIMITS.landWaitMs + CARD_RUN_LIMITS.landPollMs
    + 40 * CARD_RUN_LIMITS.landRequestTimeoutMs + REPORT_ATTEMPTS * (CARD_RUN_LIMITS.reportTimeoutMs * 2 + REPORT_RETRY_WAIT_MS);
  assert.ok(worst < AUTO_TIMEOUT_START_MS, "landing keeps the run inside TimeoutStartSec");
  assert.match(autoServiceUnit({ node: "/usr/bin/node", module: "/m" }), new RegExp(`^TimeoutStartSec=${AUTO_TIMEOUT_START_MS / 3600000}h$`, "m"));
  assert.match(host.reports[0], /^Landing: CI_TIMEOUT, /m);
});

test("SHU-306 L7: a held merge posts no merge comment and names its recovery", async () => {
  const host = landingHost({ strict: false });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGE_HOLD", JSON.stringify(result.land));
  assert.equal(result.land.hold_code, "BRANCH_PROTECTION_UNSATISFIED");
  assert.equal(host.land.merges, 0);
  assert.equal(handoffs(host).length, 1, "the handoff was written on green");
  assert.ok(host.land.log.includes("linear merge-attempt HOLD"));
  assert.ok(!host.land.log.includes("linear merge comment"), "no merge comment without COMPLETED");
  neverDone(host);
  assert.match(host.reports[0], /^Landing: MERGE_HOLD BRANCH_PROTECTION_UNSATISFIED, the SHU-259 consumer held the merge\.$/m);
  assert.match(host.reports[0], /HOLD is terminal for its attempt: a new installed revision re-arms the card, and a stale \/run\/lock\/shu-card-run\.lock is cleared by hand\./);
});

test("SHU-306 L8: without the landing token the run is today's run, reported as LAND_SKIPPED_NO_TOKEN", async () => {
  for (const [label, paths] of [["no file", LAND_PATHS], ["no path", PATHS]]) {
    const host = landingHost({ token: "none" });
    const result = await runCard({ io: host.io, paths });
    assert.equal(result.outcome, "PASS", label);
    assert.equal(result.ok, true, label);
    assert.equal(result.land.outcome, "LAND_SKIPPED_NO_TOKEN", label);
    assert.deepEqual(host.land.log, [], `${label}: no landing call at all`);
    assert.match(host.reports[0], /^Landing: LAND_SKIPPED_NO_TOKEN, /m, label);
    reverted(host);
  }
  const keyless = landingHost();
  keyless.files.get(LAND_PATHS.landEnv).text = "OTHER=1\n";
  assert.equal((await landRun(keyless)).land.outcome, "LAND_SKIPPED_NO_TOKEN");
  assert.deepEqual(keyless.land.log, []);
  // A token file anyone else could read is refused, never used.
  const loose = landingHost({ token: "custody" });
  const refused = await landRun(loose);
  assert.equal(refused.land.outcome, "LAND_ERROR");
  assert.match(refused.land.reason, /owned by root with no group or other access/);
  assert.deepEqual(loose.land.log, []);
  const foreign = landingHost();
  foreign.files.get(LAND_PATHS.landEnv).uid = 997;
  assert.equal((await landRun(foreign)).land.outcome, "LAND_ERROR");
  assert.deepEqual(foreign.land.log, []);
});

test("SHU-306 L9: the pause file stops landing before the pull request and again before the merge", async () => {
  const early = landingHost();
  early.files.set(PATHS.pause, { text: "", mode: 0o644, uid: 0, gid: 0 });
  const first = await landRun(early);
  assert.equal(first.land.outcome, "LAND_PAUSED", JSON.stringify(first.land));
  assert.deepEqual(early.land.log, [], "nothing was opened");
  const late = landingHost({ onChecks: (h) => h.files.set(PATHS.pause, { text: "", mode: 0o644, uid: 0, gid: 0 }) });
  const second = await landRun(late);
  assert.equal(second.land.outcome, "LAND_PAUSED", JSON.stringify(second.land));
  assert.equal(second.land.pr, 77);
  noLandingWrites(late);
  assert.match(late.reports[0], /^Landing: LAND_PAUSED, /m);
});

test("SHU-306 L10: nothing lands unless the revert finished, or the run passed", async () => {
  // The worker outlives the grace: the host stays armed, so nothing lands.
  const armedHost = landingHost({ workers: (h) => (h.ticks >= 1 ? 1 : 0) });
  const result = await landRun(armedHost, { ...CARD_RUN_LIMITS, workerGraceMs: 60 * 1000 });
  assert.equal(result.outcome, "PASS");
  assert.equal(result.revert.reverted, false);
  assert.equal(result.land, undefined);
  assert.deepEqual(armedHost.land.log, [], "no landing call on an unreverted host");
  const stopped = landingHost({ onTick: (h) => (h.ticks === 1 ? tickText(spent("SHU-301", "stop: retryable failures exhausted")) : tickText("activation=absent (committed gates only)")) });
  const stop = await landRun(stopped);
  assert.equal(stop.outcome, "STOPPED");
  assert.equal(stop.land, undefined);
  assert.deepEqual(stopped.land.log, []);
});

test("SHU-306 L11: the landing token never reaches the coordinator, the supervisor or any worker", () => {
  assert.notEqual(LAND_PATHS.landEnv, PATHS.coordinatorEnv);
  assert.equal(CARD_LAND_ENV, "/srv/shu/card-land.env");
  assert.notEqual(CARD_LAND_ENV, COORDINATOR_ENV);
  assert.equal(supervisorAdapterKeys.includes(LAND_TOKEN_KEY), false);
  const source = [...supervisorAdapterKeys.map((key) => `${key}=placeholder-${key.toLowerCase()}`),
    "GITHUB_TOKEN=gh", "LINEAR_API_TOKEN=lin", `${LAND_TOKEN_KEY}=land-secret-value`].join("\n");
  const adapter = adapterLaunchEnvironment(source);
  assert.equal(Object.hasOwn(adapter, LAND_TOKEN_KEY), false);
  const supervisorEnv = applyAdapterLaunchEnvironment({ PATH: "/usr/bin", [LAND_TOKEN_KEY]: "x" }, adapter);
  assert.equal(Object.hasOwn(supervisorChildEnvironment(supervisorEnv), LAND_TOKEN_KEY), false);
  assert.equal(Object.hasOwn(supervisorChildEnvironment({ ...process.env, [LAND_TOKEN_KEY]: "x" }), LAND_TOKEN_KEY), false);
  for (const unit of ["shu-coordinator.service.in", "shu-supervisor.service.in"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(HERE, "..", "service", unit), "utf8"), /card-land|SHU_LAND_/, unit);
  }
  assert.doesNotMatch(autoServiceUnit({ node: "/usr/bin/node", module: "/m" }), /EnvironmentFile|card-land|SHU_LAND_/);
  const host = fakeHost();
  host.files.set(PATHS.coordinatorEnv, { ...host.files.get(PATHS.coordinatorEnv), text: `${host.files.get(PATHS.coordinatorEnv).text}${LAND_TOKEN_KEY}=land-secret-value\n` });
  assert.equal(Object.hasOwn(readCoordinatorCredentials(host.io, PATHS.coordinatorEnv), LAND_TOKEN_KEY), false);
  assert.deepEqual(readLandToken(landingHost().io, LAND_PATHS.landEnv), { token: "land-secret-value" });
});

test("SHU-306 L12: the extracted handoff writer builds exactly the record the coordinator's consumer wrote", () => {
  const [, review] = cardLineage();
  const decision = { action: "merge-readiness", hold_code: "MISSING_AUTHORITY" };
  const next = handoffReceipt(review, PASSED, decision);
  assert.deepEqual(next, { ...review, handoff: { source_attempt_id: review.attempt_id, target_sha: PASSED, verdict_stage: "PASS", ...decision } });
  assert.equal(validHandoff(next), true);
});

test("SHU-306 L13: an unresolved review thread keeps the run waiting before the handoff; once resolved it lands", async () => {
  const held = landingHost({ threads: [false] });
  const stuck = await landRun(held);
  assert.equal(stuck.land.outcome, "CI_TIMEOUT", JSON.stringify(stuck.land));
  assert.match(stuck.land.reason, /1 review thread\(s\) are unresolved/);
  noLandingWrites(held);
  neverDone(held);
  const later = landingHost({ threads: [false, true], resolveThreadsAfter: 1 });
  const landed = await landRun(later);
  assert.equal(landed.land.outcome, "MERGED", JSON.stringify(landed.land));
  assert.ok(later.land.checkReads >= 3, "it waited for the thread to resolve");
});

test("SHU-306 L14: an optional check that turns red after the green wait stops the merge at the consumer's re-fetch", async () => {
  const host = landingHost({ optionalRedAfter: 2 });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGE_HOLD", JSON.stringify(result.land));
  assert.equal(result.land.hold_code, "REQUIRED_CHECKS_NOT_GREEN");
  assert.equal(host.land.merges, 0, "nothing merged on a red optional check");
  assert.ok(!host.land.log.includes("linear merge comment"));
  neverDone(host);
});
test("SHU-308 L15: a read that never reached its server is tried again, and the landing still merges", async () => {
  const host = landingHost({ dropLandRead: 2, dropChecks: 1 });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  assert.equal(host.land.droppedReads, 2, "the first read failed twice before it answered");
  assert.equal(host.land.droppedChecks, 1, "a dropped check read is read again");
  assert.equal(host.delays, 3, "each retry waits without blocking the event loop");
  assert.equal(host.land.merges, 1);
  neverDone(host);
});

test("SHU-308 L16: a read that keeps failing stops the landing with its cause, and a lost write is never resent", async () => {
  const host = landingHost({ dropLandRead: 9 });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "LAND_ERROR", JSON.stringify(result.land));
  assert.equal(host.land.droppedReads, 3, "three tries in all, then it stops");
  assert.match(result.land.reason, /fetch failed \(ECONNRESET\)/, "the report names the real network error");
  assert.equal(host.land.posts, 0, "nothing was opened");
  noLandingWrites(host);
  const lost = landingHost({ losePost: true });
  await landRun(lost);
  assert.equal(lost.land.posts, 1, "the open is never sent twice");
  const graphql = (query) => ({ method: "post", body: JSON.stringify({ query }) });
  assert.equal(isReadRequest("https://api.linear.app/graphql", graphql("\n  query CardLandIssue { x }")), true);
  for (const write of ["mutation M { x }", "# note\nmutation M { x }", "subscription S { x }"]) {
    assert.equal(isReadRequest("https://api.linear.app/graphql", graphql(write)), false, write);
  }
  assert.equal(isReadRequest(`https://api.github.com/repos/${REPO}/pulls`, { method: "POST", body: "{}" }), false);
  assert.equal(isReadRequest(`https://api.github.com/repos/${REPO}/pulls/77/merge`, { method: "put", body: "{}" }), false);
});


// SHU-310: settling a review bot's low-severity threads.
const CR_MINOR = "_🩺 Stability & Availability_ | _🟡 Minor_ | _⚡ Quick win_\n\n**The retry wait is not bounded.**";
const CR_MAJOR = "_🩺 Stability & Availability_ | _🟠 Major_ | _⚡ Quick win_\n\n**The retry wait is not bounded.**";
const SENTRY_LOW = "**Bug:** the cache key ignores case. <sub>Severity: LOW</sub>\n\nDetails follow.";
const settleWrites = (host) => host.land.log.filter((e) => e === "github thread reply" || e === "github thread resolve" || e === "linear settle note");

test("SHU-310 L17: a Minor CodeRabbit thread and a LOW Sentry thread are settled, noted on the card, and the card lands", async () => {
  const fenced = `${CR_MINOR}\n\n\`\`\`json\n{"receipt_version": 1}\n\`\`\`\n<!-- card-land-settle PRRT_9 -->`;
  const host = landingHost({ settle: {}, botThreads: [[["coderabbitai", fenced]], [["sentry", SENTRY_LOW]]] });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  const notes = host.land.comments.filter((c) => c.body.includes("card-land-settle"));
  assert.ok(notes.some((c) => c.body.includes("The retry wait is not bounded.")), "the note quotes the finding");
  for (const note of notes) {
    assert.doesNotMatch(note.body, /```|PRRT_9 -->/, "the bot's text can never read as a record on the card");
  }
  assert.equal(host.land.replies, 2);
  assert.equal(host.land.resolves, 2);
  assert.ok(host.land.threads.every((t) => t.isResolved));
  for (const thread of host.land.threads) {
    assert.ok(thread.comments.at(-1).body.includes(settleMarker(thread.id)), "the reply carries its thread's marker");
    assert.equal(host.land.comments.filter((c) => c.body.includes(settleMarker(thread.id))).length, 1, "one follow-up note per thread");
  }
  const log = host.land.log.filter((e) => e !== "github list");
  assert.ok(log.lastIndexOf("github thread resolve") < log.indexOf("linear handoff"), "settled before the handoff");
  assert.ok(log.indexOf("linear settle note") < log.indexOf("github thread reply"), "the note goes on the card first");
  assert.deepEqual(result.land.threads.settled.map(({ bot, severity }) => `${bot} ${severity}`), ["coderabbitai 🟡 Minor", "sentry LOW"]);
  assert.deepEqual(result.land.threads.blocking, []);
  assert.match(host.reports[0], /^Settled review thread: coderabbitai 🟡 Minor https:\/\/github\.com\/.+#discussion_r\d+$/m);
  assert.match(host.reports[0], /^Settled review thread: sentry LOW /m);
  assert.equal(COMMITTED.routine_merge_authority.enabled, false, "the committed merge gate stays off");
  neverDone(host);
});

test("External checks: an advisory review bot never holds a card; its status and threads are only reported", async () => {
  // The committed config names Sentry alone.
  assert.deepEqual(COMMITTED.external_checks, { required: ["sentry"] });
  for (const coderabbit of ["pending", "failure"]) {
    const host = landingHost({ statuses: [{ context: "CodeRabbit", state: coderabbit }], mergeableState: "unstable",
      botThreads: [[["coderabbitai", CR_MAJOR]]] });
    const result = await landRun(host);
    assert.equal(result.land.outcome, "MERGED", `${coderabbit}: ${JSON.stringify(result.land)}`);
    assert.equal(result.land.advisory, `advisory, not waited on: CodeRabbit: ${coderabbit}, 1 unresolved advisory review thread(s)`);
    const merged = host.land.comments.find((c) => c.body.includes("card-land-merged")).body;
    assert.match(merged, /\nAdvisory, not waited on: CodeRabbit: (pending|failure), 1 unresolved advisory review thread\(s\)\.$/);
    assert.equal(host.land.merges, 1);
  }
});

test("External checks: own CI, a named service, a person's thread and a malformed policy still hold", async () => {
  const cases = [
    ["own CI red", { checks: ["red"] }, "PR_OPENED_CI_RED"],
    ["a Sentry thread", { botThreads: [[["sentry", "Bug: this breaks.\nSeverity: HIGH"]]] }, "CI_TIMEOUT"],
    ["a person's thread opened before a bot reply", { threads: [false] }, "CI_TIMEOUT"],
    ["a named status pending", { statuses: [{ context: "sentry", state: "pending" }], mergeableState: "unstable" }, "CI_TIMEOUT"],
    ["unstable from a named status", { statuses: [{ context: "Sentry", state: "failure" }], mergeableState: "unstable" }, "PR_OPENED_CI_RED"],
    ["blocked by branch protection", { mergeableState: "blocked" }, "CI_TIMEOUT"],
    ["a malformed policy", { external: { required: ["Bad Name"] } }, "LAND_ERROR"],
    ["an unknown key", { external: { required: [], optional: ["x"] } }, "LAND_ERROR"],
  ];
  for (const [name, options, outcome] of cases) {
    const host = landingHost(options);
    const result = await landRun(host);
    assert.equal(result.land.outcome, outcome, `${name}: ${JSON.stringify(result.land)}`);
    assert.equal(host.land.merges, 0, name);
  }
});

test("External checks: a named service's check run holds whether GitHub names its app by slug or by name", async () => {
  // Sentry reports a "Seer Code Review" run; its app may carry a slug other than the name the config uses.
  const seer = (conclusion, app) => ({ name: "Seer Code Review", app, status: conclusion ? "completed" : "in_progress", conclusion });
  for (const app of [{ id: 1, slug: "sentry", name: "Sentry" }, { id: 1, slug: "sentry-io", name: "Sentry" }]) {
    const cases = [
      ["failing in the wait", [{ run: seer("failure", app) }], "PR_OPENED_CI_RED"],
      ["pending in the wait", [{ run: seer(null, app) }], "CI_TIMEOUT"],
      ["failing at the merge consumer's re-fetch", [{ after: 2, run: seer("failure", app) }], "MERGE_HOLD"],
    ];
    for (const [name, extraRuns, outcome] of cases) {
      const host = landingHost({ extraRuns, mergeableState: "unstable" });
      const result = await landRun(host);
      assert.equal(result.land.outcome, outcome, `${app.slug} ${name}: ${JSON.stringify(result.land)}`);
      if (outcome === "MERGE_HOLD") assert.equal(result.land.hold_code, "REQUIRED_CHECKS_NOT_GREEN");
      assert.equal(host.land.merges, 0, `${app.slug} ${name}`);
    }
  }
  // An app the config does not name stays advisory, by slug and by name.
  const other = { name: "Review", app: { id: 2, slug: "coderabbitai", name: "CodeRabbit" }, status: "completed", conclusion: "failure" };
  const host = landingHost({ extraRuns: [{ run: other }], mergeableState: "unstable" });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  assert.equal(result.land.advisory, "advisory, not waited on: coderabbitai Review: failure");
  // A long advisory list is cut with an ellipsis on the merge comment, never mid-entry without one.
  const many = Array.from({ length: 12 }, (_, i) => ({ run: { ...other, name: `advisory-check-${i}-${"x".repeat(20)}` } }));
  const long = landingHost({ extraRuns: many, mergeableState: "unstable" });
  assert.equal((await landRun(long)).land.outcome, "MERGED");
  const line = long.land.comments.find((c) => c.body.includes("card-land-merged")).body.split("\n").at(-1);
  assert.match(line, /^Advisory, not waited on: .{250,}…\.$/);
  assert.equal(line.length, 301);
});

test("SHU-310 L18: any thread that is not a low-labelled review bot's holds everything, and nothing is written", async () => {
  const cases = [
    ["a human reply", [[["coderabbitai", CR_MINOR], ["khalid", "I disagree.", "User"]]]],
    ["Major", [[["coderabbitai", CR_MAJOR]]]],
    ["no label", [[["coderabbitai", "Consider renaming this."]]]],
    ["a bot off the allowlist", [[["copilot", CR_MINOR]]]],
    ["a user named like the bot", [[["coderabbitai", CR_MINOR, "User"]]]],
    ["a later Major on a Minor thread", [[["coderabbitai", CR_MINOR], ["coderabbitai", CR_MAJOR]]]],
    ["one blocking beside one settleable", [[["coderabbitai", CR_MINOR]], [["coderabbitai", CR_MAJOR]]]],
  ];
  for (const [name, botThreads] of cases) {
    // copilot is named, so its thread holds; off the settle allowlist, it is never settled.
    const host = landingHost({ settle: {}, botThreads, external: { required: ["coderabbitai", "copilot", "sentry"] } });
    const result = await landRun(host);
    assert.equal(result.land.outcome, "CI_TIMEOUT", `${name}: ${JSON.stringify(result.land)}`);
    assert.match(result.land.reason, /not settleable: https:\/\/github\.com\//, name);
    assert.deepEqual(settleWrites(host), [], `${name}: nothing settled`);
    assert.equal(result.land.threads.settled.length, 0, name);
    assert.ok(result.land.threads.blocking.length >= 1, name);
    assert.match(host.reports[0], /^Blocking review thread: https:\/\/github\.com\//m, name);
    noLandingWrites(host);
  }
});

test("SHU-310 L19: a thread edited after it was classified stops the landing before it is resolved", async () => {
  const host = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR]]], editOnReply: true });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "LAND_ERROR", JSON.stringify(result.land));
  assert.match(result.land.reason, /changed after the landing classified it/);
  assert.equal(host.land.resolves, 0, "never resolved");
  noLandingWrites(host);
});

test("SHU-310 L20: a settled thread that changes before the handoff stops the landing", async () => {
  const host = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR]]],
    onChecks: (h, read) => { if (h.land.resolves && !h.land.editRead) { h.land.editRead = read; h.land.threads[0].comments[0].updatedAt = "2026-10-09T18:30:00Z"; } } });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "LAND_ERROR", JSON.stringify(result.land));
  assert.match(result.land.reason, /changed before the handoff/);
  assert.equal(host.land.checkReads, host.land.editRead, "caught on the very read that saw the change");
  assert.equal(result.land.threads.settled.length, 1, "the audit survives the stop");
  noLandingWrites(host);
  // A change after the last read is caught by the re-read just before the handoff.
  const late = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR]]], editAfterThreadsRead: 3 });
  const stopped = await landRun(late);
  assert.equal(stopped.land.outcome, "LAND_ERROR", JSON.stringify(stopped.land));
  assert.match(stopped.land.reason, /changed before the handoff/);
  assert.equal(late.land.checkReads, 3);
  noLandingWrites(late);
});

test("SHU-310 L21: a reply whose answer is lost is never sent again and stops the landing", async () => {
  const host = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR]]], loseReply: true });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "LAND_ERROR", JSON.stringify(result.land));
  assert.equal(host.land.replies, 1, "one reply only");
  assert.equal(host.land.resolves, 0);
  noLandingWrites(host);
  // A later run finds the reply by its marker and does not write it again.
  const thread = host.land.threads[0];
  const node = { id: thread.id, isResolved: false, comments: { nodes: thread.comments, pageInfo: { hasNextPage: false } } };
  const entry = classifyThread(node, "shu-lander", settlePolicy({ landing_thread_settle: { ...COMMITTED.landing_thread_settle, enabled: true } }));
  assert.equal(entry.settle, true, JSON.stringify(entry));
  assert.equal(entry.replied, true);
  // A run that finds its note and its reply already written finishes the
  // settle without writing either again.
  const marker = settleMarker("PRRT_0");
  const again = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR], ["shu-lander", `${marker}\nNot blocking this landing.`, "User"]]] });
  again.land.comments.push({ body: `${marker}\nFollow-up.`, createdAt: "2026-10-09T17:10:00.000Z", user: { id: ACTOR, displayName: "Coordinator" } });
  const landed = await landRun(again);
  assert.equal(landed.land.outcome, "MERGED", JSON.stringify(landed.land));
  assert.equal(again.land.replies, 0, "the reply is not written twice");
  assert.ok(!again.land.log.includes("linear settle note"), "the note is not written twice");
  assert.equal(again.land.resolves, 1);
});

test("SHU-310 L22: more settleable threads than one run may settle are held, with nothing written", async () => {
  const host = landingHost({ settle: { max_per_run: 1 }, botThreads: [[["coderabbitai", CR_MINOR]], [["sentry", SENTRY_LOW]]] });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "THREADS_HELD", JSON.stringify(result.land));
  assert.deepEqual(settleWrites(host), []);
  assert.match(host.reports[0], /^Landing: THREADS_HELD, more review bot threads were settleable than one run may settle/m);
  noLandingWrites(host);
});

test("SHU-310 L23: with settling off, a Minor bot thread waits exactly as before", async () => {
  const host = landingHost({ settle: false, botThreads: [[["coderabbitai", CR_MINOR]]] });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "CI_TIMEOUT", JSON.stringify(result.land));
  assert.match(result.land.reason, /1 review thread\(s\) are unresolved$/);
  assert.equal(result.land.threads, undefined);
  assert.deepEqual(settleWrites(host), []);
  noLandingWrites(host);
});

test("SHU-310 L24: labels are read from their fixed place, and a malformed policy is refused", () => {
  assert.deepEqual(botSeverity("coderabbit", CR_MINOR), { level: "low", label: "🟡 Minor" });
  assert.equal(botSeverity("coderabbit", "**🧹 Nitpick** | **🔵 Trivial**").level, "high", "two labels");
  assert.equal(botSeverity("coderabbit", "Looks fine.\n\nNot a 🟡 Minor issue.").level, "high", "a label quoted in prose");
  assert.equal(botSeverity("coderabbit", "Consider this.").level, "none");
  assert.equal(botSeverity("coderabbit", `${CR_MINOR}\n\nEscalated: 🟠 Major`).level, "high", "a higher label anywhere");
  assert.deepEqual(botSeverity("sentry", SENTRY_LOW), { level: "low", label: "LOW" });
  assert.equal(botSeverity("sentry", "**Bug** <sub>Severity: MEDIUM</sub>").level, "high");
  assert.equal(botSeverity("sentry", `${SENTRY_LOW}\n<sub>Severity: LOW</sub>`).level, "high", "two labels");
  assert.equal(botSeverity("sentry", "**Bug**\n<sub>Severity: LOW</sub>").level, "high", "not on the first line");
  assert.equal(settlePolicy({}), null);
  assert.equal(settlePolicy({ landing_thread_settle: { ...COMMITTED.landing_thread_settle, enabled: false } }), null, "off");
  assert.equal(settlePolicy({ landing_thread_settle: { ...COMMITTED.landing_thread_settle, enabled: true } }).maxPerRun, 5, "the committed policy reads when on");
  const on = { ...COMMITTED.landing_thread_settle, enabled: true };
  assert.equal(settlePolicy({ landing_thread_settle: on }).maxPerRun, 5);
  for (const bad of [{ ...on, enabled: "yes" }, { ...on, max_per_run: 0 }, { ...on, max_per_run: 11 }, { ...on, bots: [] },
    { ...on, bots: [{ login: "coderabbitai", labels: "coderabbit" }, { login: "coderabbitai", labels: "sentry" }] },
    { ...on, bots: [{ login: "CodeRabbit", labels: "coderabbit" }] }, { ...on, bots: [{ login: "x", labels: "other" }] },
    { ...on, bots: [{ login: "x", labels: "sentry", extra: 1 }] }]) {
    assert.throws(() => settlePolicy({ landing_thread_settle: bad }), (error) => error.landOutcome === "LAND_ERROR", JSON.stringify(bad));
  }
});

test("SHU-310 L25: a comment that lands between the last read and the resolve reopens the thread and stops the landing", async () => {
  const host = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR]]], commentOnResolve: true });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "LAND_ERROR", JSON.stringify(result.land));
  assert.match(result.land.reason, /it was reopened/);
  assert.equal(host.land.threads[0].isResolved, false, "the thread blocks again");
  assert.equal(host.land.log.filter((e) => e === "github thread reopen").length, 1);
  noLandingWrites(host);
});

test("SHU-310 L26: a settled thread that changes after the handoff holds the merge at the consumer's last check", async () => {
  const host = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR]]], editOnMergeIntent: true });
  const result = await landRun(host);
  assert.equal(result.land.outcome, "MERGE_HOLD", JSON.stringify(result.land));
  assert.equal(result.land.hold_code, "BLOCKING_REVIEW_THREAD");
  assert.equal(host.land.merges, 0, "nothing merged");
  assert.ok(!host.land.log.includes("linear merge comment"));
  neverDone(host);
});

test("SHU-310 L27: a thread an earlier landing settled is checked again by every run, and the audit is carried on every outcome", async () => {
  const marker = settleMarker("PRRT_0");
  const reply = ["shu-lander", `${marker}\nNot blocking this landing.`, "User"];
  const reopened = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR], reply, ["khalid", "This needs a fix.", "User"]]] });
  reopened.land.threads[0].isResolved = true;
  const stopped = await landRun(reopened);
  assert.equal(stopped.land.outcome, "LAND_ERROR", JSON.stringify(stopped.land));
  assert.match(stopped.land.reason, /settled by a landing but no longer reads as a low review bot thread/);
  assert.equal(reopened.land.checkReads, 1, "caught on the first read");
  noLandingWrites(reopened);
  const intact = landingHost({ settle: {}, botThreads: [[["coderabbitai", CR_MINOR], reply]] });
  intact.land.threads[0].isResolved = true;
  const landed = await landRun(intact);
  assert.equal(landed.land.outcome, "MERGED", JSON.stringify(landed.land));
  const malformed = await landRun(landingHost({ settle: { max_per_run: 0 } }));
  assert.equal(malformed.land.outcome, "LAND_ERROR");
  assert.deepEqual(malformed.land.threads, { settled: [], blocking: [] }, "the audit is carried when the policy is refused");
  const pausedHost = landingHost({ settle: {} });
  pausedHost.files.set(PATHS.pause, { text: "", mode: 0o644, uid: 0, gid: 0 });
  const paused = await landRun(pausedHost);
  assert.equal(paused.land.outcome, "LAND_PAUSED");
  assert.deepEqual(paused.land.threads, { settled: [], blocking: [] }, "and when the run stops before it reads the policy");
});

// SHU-312: one install runs a short committed queue of cards, one per timer
// start, each from main as it is when its run starts.
const QUEUE = Object.freeze(["SHU-301", "SHU-305"]);
const queueConfig = (ids = QUEUE) => ({ ...structuredClone(COMMITTED), dispatch_scope: { issue_ids: [...ids] } });
const passFor = (id) => (h) => tickText(spent(id, "review PASS — the episode is complete"));
const claimFor = (host, revision, id, fields) => host.files.set(autoClaim(PATHS, revision, id),
  { text: `${JSON.stringify({ card: id, revision, ...fields })}\n`, mode: 0o600, uid: 0, gid: 0 });

test("SHU-312 Q1: a card queue is two to five distinct committed card lanes; anything else scopes nothing", async () => {
  const { cardQueue, MAX_CARD_QUEUE } = await import("../single-run-activation.mjs");
  assert.equal(MAX_CARD_QUEUE, 5);
  assert.deepEqual(cardQueue(queueConfig()), { queue: true, ok: true, ids: [...QUEUE], reason: null });
  assert.equal(cardQueue(queueConfig(["SHU-301"])).queue, false, "one card is not a queue");
  assert.equal(cardQueue(queueConfig(["SHU-140", "SHU-254"])).queue, false, "the fixture pair keeps its own handling");
  for (const [label, ids] of [
    ["six cards", ["SHU-197", "SHU-294", "SHU-295", "SHU-300", "SHU-301", "SHU-305"]],
    ["a repeated card", ["SHU-301", "SHU-301"]],
    ["a review-only lane", ["SHU-301", "SHU-304"]],
    ["no lane", ["SHU-301", "SHU-999"]],
    ["a fixture", ["SHU-301", "SHU-140"]],
    ["not an id", ["SHU-301", "shu-305"]],
  ]) {
    const queue = cardQueue(queueConfig(ids));
    assert.equal(queue.queue && queue.ok === false, true, label);
    assert.throws(() => planRun({ config: queueConfig(ids), revision: REV, now: START, cardId: ids[0] }), { code: "CARD_RUN_SCOPE" }, label);
  }
  // planRun takes the card it is given, only from the queue, never a review.
  assert.equal(planRun({ config: queueConfig(), revision: REV, now: START, cardId: "SHU-305" }).id, "SHU-305");
  assert.throws(() => planRun({ config: queueConfig(), revision: REV, now: START }), { code: "CARD_RUN_SCOPE" });
  assert.throws(() => planRun({ config: queueConfig(), revision: REV, now: START, cardId: "SHU-308" }), { code: "CARD_RUN_SCOPE" });
  assert.throws(() => planRun({ config: queueConfig(), revision: REV, now: START, cardId: "SHU-301", review: REVIEW }), { code: "CARD_RUN_REVIEW_INPUT" });
  assert.throws(() => planRun({ config: configFor("SHU-301"), revision: REV, now: START, cardId: "SHU-305" }), { code: "CARD_RUN_SCOPE" });
});

test("SHU-312 Q2: a queue narrows each tick to the armed card alone, and without one scopes nothing", async () => {
  const { narrowQueueScope } = await import("../single-run-activation.mjs");
  const { resolveDispatchScope } = await import("../reconcile.mjs");
  const record = planRun({ config: queueConfig(), revision: REV, now: START, cardId: "SHU-305" }).record;
  const file = (text) => ({ lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }), readFile: () => text });
  const narrowed = narrowQueueScope(queueConfig(), "/isolated/activation", file(JSON.stringify(record)));
  assert.deepEqual(narrowed.dispatch_scope, { issue_ids: ["SHU-305"] });
  assert.deepEqual([...resolveDispatchScope(narrowed).issueIds], ["SHU-305"]);
  for (const [label, path, io] of [
    ["no activation", null, file(JSON.stringify(record))],
    ["a card outside the queue", "/a", file(JSON.stringify({ ...record, target_issue_id: "SHU-308", authorization_ref: "SHU-308" }))],
    ["a malformed record", "/a", file("{")],
    ["a record of the wrong shape", "/a", file(JSON.stringify({ ...record, coordinator_revision: "not-a-sha" }))],
    ["a group-writable file", "/a", { ...file(JSON.stringify(record)), lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o620 }) }],
  ]) {
    const kept = narrowQueueScope(queueConfig(), path, io);
    assert.deepEqual(kept.dispatch_scope.issue_ids, [...QUEUE], label);
    assert.equal(resolveDispatchScope(kept).valid, false, `${label}: the queue as committed scopes nothing`);
  }
  // A single card is never narrowed, whatever the record says.
  const single = configFor("SHU-301");
  assert.equal(narrowQueueScope(single, "/a", file(JSON.stringify(record))), single);
});

test("SHU-312 Q3: the host gate admits only the armed card's order under a queue", async () => {
  const { workOrderAuthorization } = await import("../supervisor-authorization.mjs");
  const now = new Date(START.getTime() + 60_000);
  const record = planRun({ config: queueConfig(), revision: REV, now: START, cardId: "SHU-305" }).record;
  const order = (id) => ({ issue_id: id, runtime: "codex-cli", authorization_ref: id, workspace_scope: "scoped", scope_phase: "initial",
    allowed_paths: [...COMMITTED.card_lanes.find((lane) => lane.id === id).initial_build_paths ?? []], scoped_base_sha: "e".repeat(40) });
  const check = (id, text = JSON.stringify(record)) => workOrderAuthorization(order(id), {
    config: { ...queueConfig(), max_dispatch: 1 }, wait: () => {},
    env: { ENABLE_DISPATCH: "true", SHU_SUPERVISOR_ACTIVATION_FILE: "/isolated/activation", DISPATCH_TARGET_SHA: REV },
    activation: { now, gitHead: REV, io: { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }), readFile: () => text } },
  });
  assert.equal(check("SHU-301").code, "HOST_AUTH_DISPATCH_SCOPE", "another queued card is outside this run's scope");
  assert.notEqual(check("SHU-305").code, "HOST_AUTH_DISPATCH_SCOPE", "the armed card is in scope");
  assert.equal(check("SHU-305", "{").code, "HOST_AUTH_DISPATCH_SCOPE", "no readable activation, no scope");
});

test("SHU-312 Q4: a card branch starts from main as it is now, only when main descends from the install", async () => {
  // Main moved past the install (an earlier card merged): the branch and the
  // activation's approved input are main's tip, not the installed revision.
  const ahead = fakeHost({ branchHead: "", onTick: passFor("SHU-301") });
  ahead.mainTip = HEAD;
  const result = await runCard({ io: ahead.io, paths: PATHS }).catch((error) => assert.fail(`the run refused: ${error.message}`));
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.prepared.branch, { branch: "coordinator/SHU-301", head: HEAD, base: HEAD, action: "create" });
  assert.equal(result.target, HEAD);
  assert.equal(result.revision, REV, "the coordinator still runs the installed revision");
  assert.ok(ahead.api.includes(`git push refs/heads/coordinator/SHU-301 ${HEAD}`));
  assert.ok(ahead.calls.some((call) => call.includes(`--is-ancestor ${REV} ${HEAD}`)));
  // A main that does not contain the install, or that cannot be fetched, is
  // refused before anything is pushed, moved or armed.
  for (const [label, change] of [
    ["rewritten main", (h) => { h.mainTip = BASE; h.mainDescends = false; }],
    ["unfetchable main", (h) => { h.fetchFails = true; }],
  ]) {
    const host = fakeHost({ branchHead: "" });
    change(host);
    const error = await runCard({ io: host.io, paths: PATHS }).then(() => null, (e) => e);
    assert.equal(error?.code, "CARD_RUN_BASE", label);
    assert.doesNotMatch(error.message, /github\.com|could not read/, label);
    assert.equal(host.api.some((call) => call.startsWith("git push") || call.startsWith("linear todo")), false, label);
    assert.equal(host.pushDirs.size, 0, `${label}: the push repository is removed`);
    noArming(host);
  }
  // A branch left at the old install that main does not contain is never
  // moved to the new main (SHU-327: one main contains moves, see C43).
  const stale = fakeHost({ branchHead: REV });
  stale.mainTip = HEAD;
  await assert.rejects(runCard({ io: stale.io, paths: PATHS }), { code: "CARD_RUN_BRANCH_NOT_AT_TARGET" });
  assert.equal(stale.branchHead, REV);
  noArming(stale);
  assert.throws(() => onBase(planRun({ config: configFor("SHU-301"), revision: REV, now: START }), "not-a-sha"), { code: "CARD_RUN_BASE" });
});

test("SHU-312 Q5: the timer runs the queue in order, one card per start, and stops at a card that did not land", async () => {
  const host = fakeHost({ config: queueConfig(), branchHead: "", onTick: (h) => (h.ticks === 1 ? passFor("SHU-301")(h) : tickText("activation=absent (committed gates only)")) });
  assert.deepEqual(await nextCard(host.io, PATHS, queueConfig(), REV), { id: "SHU-301" });
  // Selected once: the run is the card the timer picked, although the claim it
  // wrote first records no landing yet (GPT, SHU-312 design review).
  const first = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(first.skipped, undefined, JSON.stringify(first));
  assert.equal(first.card, "SHU-301");
  assert.equal(first.outcome, "PASS");
  const recorded = JSON.parse(host.files.get(autoClaim(PATHS, REV, "SHU-301")).text);
  assert.equal(recorded.outcome, "PASS");
  assert.ok("land" in recorded, "the claim records the landing outcome");
  assert.notEqual(recorded.land, "MERGED");
  // The first card did not land, so the queue stops there for this install.
  const ticks = host.ticks;
  const stopped = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(stopped.skipped, "QUEUE_STOPPED");
  assert.match(stopped.reason, /^SHU-301 ran at a{40} and did not land/);
  assert.equal(host.ticks, ticks, "no second run");
  // The first card landed: the next start runs the second.
  const landed = fakeHost({ config: queueConfig(), branchHead: "", onTick: (h) => (h.ticks === 1 ? passFor("SHU-305")(h) : tickText("activation=absent (committed gates only)")) });
  landed.mainTip = HEAD;
  claimFor(landed, REV, "SHU-301", { outcome: "PASS", ok: true, land: "MERGED" });
  const second = await attempt(() => autoRun({ io: landed.io, paths: PATHS }));
  assert.equal(second.card, "SHU-305", JSON.stringify(second));
  assert.equal(second.outcome, "PASS", JSON.stringify(second));
  assert.equal(second.target, HEAD, "the second card starts after the first card's merge");
  assert.ok(landed.files.has(autoClaim(PATHS, REV, "SHU-305")));
  assert.equal(second.claim_error, undefined);
  // A claim that cannot be rewritten after the run is named, not lost, and
  // the claim written first still stops the queue at that card.
  const full = fakeHost({ config: queueConfig(), branchHead: "", onTick: (h) => (h.ticks === 1 ? passFor("SHU-301")(h) : tickText("activation=absent (committed gates only)")) });
  const write = full.fs.writeFileSync;
  full.fs.writeFileSync = (file, text, options = {}) => {
    if (file === autoClaim(PATHS, REV, "SHU-301") && options.flag !== "wx") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return write(file, text, options);
  };
  const unrecorded = await attempt(() => autoRun({ io: full.io, paths: PATHS }));
  assert.equal(unrecorded.claim_error, "ENOSPC");
  assert.equal((await attempt(() => autoRun({ io: full.io, paths: PATHS }))).skipped, "QUEUE_STOPPED");
  // Every card landed.
  claimFor(landed, REV, "SHU-305", { outcome: "PASS", ok: true, land: "MERGED" });
  assert.equal((await attempt(() => autoRun({ io: landed.io, paths: PATHS }))).skipped, "QUEUE_DONE");
});

test("SHU-312 Q6: a new install resumes the queue after the cards that already landed", async () => {
  const host = fakeHost({ config: queueConfig(), branchHead: "", onTick: (h) => (h.ticks === 1 ? passFor("SHU-305")(h) : tickText("activation=absent (committed gates only)")) });
  host.head = HEAD;
  host.main = HEAD;
  host.mainTip = HEAD;
  host.files.set(PATHS.receipt, { text: JSON.stringify({ version: 1, revision: HEAD, state: "VERIFIED", effects: [] }), mode: 0o644, uid: 0, gid: 0 });
  // SHU-301 landed under the previous install; SHU-305 ran there and did not.
  claimFor(host, REV, "SHU-301", { outcome: "PASS", ok: true, land: "MERGED" });
  claimFor(host, REV, "SHU-305", { outcome: "PASS", ok: true, land: "CI_TIMEOUT" });
  assert.deepEqual(await nextCard(host.io, PATHS, queueConfig(), HEAD), { id: "SHU-305" }, "a new install re-arms the card that did not land, after the one that did");
  const run = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(run.card, "SHU-305", JSON.stringify(run));
  // A landing outcome is read only from a well-formed claim file.
  const odd = fakeHost({ config: queueConfig() });
  odd.files.set(`${PATHS.stateDir}/card-run-auto-x-SHU-301.json`, { text: JSON.stringify({ land: "MERGED" }), mode: 0o600, uid: 0, gid: 0 });
  odd.files.set(`${PATHS.stateDir}/card-run-auto-${REV}-SHU-3010.json`, { text: JSON.stringify({ land: "MERGED" }), mode: 0o600, uid: 0, gid: 0 });
  assert.deepEqual(await nextCard(odd.io, PATHS, queueConfig(), REV), { id: "SHU-301" });
  // A landing is read only from a claim whose content matches its name and
  // records a passed run that merged: a swapped or partial claim proves nothing.
  const OTHER = "c".repeat(40);
  for (const [label, file, fields] of [
    ["another card's claim", autoClaim(PATHS, REV, "SHU-301"), { card: "SHU-305", revision: REV, outcome: "PASS", ok: true, land: "MERGED" }],
    ["another revision's claim", autoClaim(PATHS, REV, "SHU-301"), { card: "SHU-301", revision: OTHER, outcome: "PASS", ok: true, land: "MERGED" }],
    ["a claim with no passed run", autoClaim(PATHS, REV, "SHU-301"), { card: "SHU-301", revision: REV, outcome: "REFUSED", ok: true, land: "MERGED" }],
    ["a claim not ok", autoClaim(PATHS, REV, "SHU-301"), { card: "SHU-301", revision: REV, outcome: "PASS", ok: false, land: "MERGED" }],
    ["a bare landing", autoClaim(PATHS, REV, "SHU-301"), { land: "MERGED" }],
  ]) {
    const swapped = fakeHost({ config: queueConfig() });
    swapped.files.set(file, { text: JSON.stringify(fields), mode: 0o600, uid: 0, gid: 0 });
    assert.deepEqual(await nextCard(swapped.io, PATHS, queueConfig(), OTHER), { id: "SHU-301" }, label);
  }
  // An invalid queue never runs.
  const bad = fakeHost({ config: queueConfig(["SHU-301", "SHU-304"]) });
  const skipped = await attempt(() => autoRun({ io: bad.io, paths: PATHS }));
  assert.equal(skipped.skipped, "NOT_READY");
  untouched(bad);
});

test("SHU-312 Q7: a queue is never run by hand, and plan shows the next card and every queued card's dry run", async () => {
  const manual = fakeHost({ config: queueConfig(), branchHead: "" });
  const refused = await main(["run"], manual.io, PATHS);
  assert.equal(refused.code, 2);
  assert.equal(refused.output.code, "CARD_RUN_SCOPE");
  assert.match(refused.output.reason, /is run by the card-run timer, never by hand/);
  noArming(manual);
  const planned = fakeHost({ config: queueConfig(), branchHead: "" });
  planned.mainTip = HEAD;
  const { code, output } = await main(["plan"], planned.io, PATHS);
  assert.equal(code, 0);
  assert.deepEqual(output.queue, [...QUEUE]);
  assert.deepEqual(output.next, { id: "SHU-301" });
  assert.equal(output.id, "SHU-301");
  assert.deepEqual(output.queued.map((entry) => [entry.id, entry.prepare.branch?.base, entry.prepare.branch?.action]),
    [["SHU-301", HEAD, "create"], ["SHU-305", HEAD, "create"]]);
  assert.deepEqual(output.prepare, output.queued[0].prepare);
  assert.equal(planned.branchHead, "", "plan pushes nothing");
  assert.equal(planned.api.some((call) => call.startsWith("linear todo") || /^git push (?!dry-run)/.test(call)), false);
  noArming(planned);
});

// SHU-321: once the queue is done, the timer reviews one queue config pull
// request at its exact head with Codex, and touches nothing else.
const PR_HEAD = "d".repeat(40);
const PR_BASE = "e".repeat(40);
const SESSION = "Claude-Session: https://claude.ai/code/session_01QXHrfWMbw74J3H6tsVHXqY";
const LABEL = COMMITTED.queue_config_review.label;
const queueFiles = () => [
  { filename: ".github/coordinator/config.json", status: "modified", sha: "1".repeat(40), additions: 4, deletions: 2 },
  { filename: ".github/coordinator/card-contracts.mjs", status: "modified", sha: "2".repeat(40), additions: 60, deletions: 0 },
  { filename: ".github/coordinator/service/suite-inventory.json", status: "modified", sha: "3".repeat(40), additions: 8, deletions: 0 },
  { filename: ".github/coordinator/test/card-lanes.test.mjs", status: "modified", sha: "4".repeat(40), additions: 5, deletions: 1 },
];
function queuePull(number, { head = PR_HEAD, base = PR_BASE, draft = false, fork = false, baseRef = "main", labels = [LABEL], files = queueFiles(),
  messages = [`feat: commit the next card queue\n\n${SESSION}`, `test: pin the queue\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${SESSION}`] } = {}) {
  const repo = COMMITTED.pilot_repo;
  const commits = messages.map((message, i) => ({ sha: i === messages.length - 1 ? head : `${i + 5}`.repeat(40), commit: { message } }));
  return {
    pull: { number, state: "open", draft, labels: labels.map((name) => ({ name })),
      base: { ref: baseRef, repo: { full_name: repo } }, head: { sha: head, ref: `chore/queue-${number}`, repo: { full_name: fork ? "someone/studenthub-platform" : repo } } },
    detail: { head, base, files, commits },
  };
}
const reviewPass = (h) => {
  if (h.files.has(PATHS.activation)) h.armedRecords = [...(h.armedRecords ?? []), JSON.parse(h.files.get(PATHS.activation).text)];
  const head = h.armedRecords?.at(-1)?.initial_target_sha ?? PR_HEAD;
  return tickText(spent("SHU-304", `review-only verdict PASS at ${head} — the episode is complete`));
};
// A host whose committed queue has landed, with the given open pull requests.
function reviewHost(pulls = [queuePull(240)], { config = queueConfig() } = {}) {
  const host = fakeHost({ id: "SHU-304", config, onTick: reviewPass });
  for (const id of QUEUE) claimFor(host, REV, id, { outcome: "PASS", ok: true, land: "MERGED" });
  setPulls(host, pulls);
  return host;
}
const setPulls = (host, pulls) => {
  host.pulls = pulls.map((entry) => entry.pull);
  host.pullDetails = Object.fromEntries(pulls.map((entry) => [String(entry.pull.number), entry.detail]));
};
const reviewClaims = (host) => [...host.files.keys()].filter((file) => file.startsWith(`${PATHS.stateDir}/card-review-auto-`));
const notReviewed = (host, label) => {
  assert.deepEqual(reviewClaims(host), [], `${label}: nothing is claimed`);
  assert.equal(host.ticks, 0, `${label}: nothing is ticked`);
  noArming(host);
  assert.deepEqual(host.reports, [], `${label}: nothing is reported`);
  assert.equal(host.api.some((call) => call.startsWith("linear")), false, `${label}: Linear is not called`);
};

test("SHU-321 R1: only a labelled, allowlisted, Claude-trailered queue config pull request is reviewed, lowest first, one per start", async () => {
  const host = reviewHost([queuePull(245, { head: "9".repeat(40) }), queuePull(241)]);
  const run = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(run.skipped, undefined, JSON.stringify(run));
  assert.equal(run.card, "SHU-304");
  assert.equal(run.kind, "review");
  assert.equal(run.outcome, "REVIEW_PASS");
  assert.equal(run.trigger, "timer");
  assert.deepEqual(run.review, { pr: 241, head: PR_HEAD, base: PR_BASE });
  assert.equal(run.claim, reviewClaim(PATHS, 241, PR_HEAD));
  const [record] = host.armedRecords;
  assert.equal(record.target_issue_id, "SHU-304");
  assert.equal(record.review_pr, 241);
  assert.equal(record.initial_target_sha, PR_HEAD, "the exact head");
  assert.equal(record.review_base_sha, PR_BASE);
  assert.equal(record.pr_author_family, "claude");
  assert.equal("writer_lane" in record, false, "a review writes no branch");
  reverted(host);
  assert.equal(host.reports.length, 1);
  assert.match(host.reports[0], /^Card run on SHU-304 \(review\): REVIEW_PASS/m);
  assert.match(host.reports[0], new RegExp(`^Reviewed pull request #241 at ${PR_HEAD}, from base ${PR_BASE}\\.$`, "m"));
  assert.equal(host.api.some((call) => call.startsWith("git push") || call.startsWith("github pulls/245")), false, "one review per start, nothing pushed");
  // The next start takes the next pull request.
  const next = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.deepEqual(next.review, { pr: 245, head: "9".repeat(40), base: PR_BASE }, JSON.stringify(next));
  // No label, or a commit without the Claude-Session: trailer: never reviewed.
  for (const [label, pull] of [
    ["no label", queuePull(240, { labels: ["coordinator"] })],
    ["another label", queuePull(240, { labels: ["coordinator:queue-config-x"] })],
    ["a commit without the trailer", queuePull(240, { messages: [`feat: a\n\n${SESSION}`, "fix: b\n\nCo-Authored-By: Claude <noreply@anthropic.com>"] })],
    ["the trailer only in prose", queuePull(240, { messages: [`feat: mentions Claude-Session: in a sentence ${SESSION.slice(16)}`] })],
  ]) {
    const quiet = reviewHost([pull]);
    const skipped = await attempt(() => autoRun({ io: quiet.io, paths: PATHS }));
    assert.equal(skipped.skipped, "QUEUE_DONE", `${label}: ${JSON.stringify(skipped)}`);
    notReviewed(quiet, label);
  }
});

test("SHU-321 R2: a fork, a draft, a non-main base, a deleted contract line or an extra path is never reviewed", async () => {
  const files = (edit) => { const list = queueFiles(); edit(list); return list; };
  for (const [label, pull] of [
    ["a fork", queuePull(240, { fork: true })],
    ["a draft", queuePull(240, { draft: true })],
    ["a non-main base", queuePull(240, { baseRef: "release" })],
    ["a deleted contract line", queuePull(240, { files: files((list) => { list[1].deletions = 1; }) })],
    ["a removed contracts file", queuePull(240, { files: files((list) => { list[1].status = "removed"; list[1].additions = 0; }) })],
    ["contracts renamed away", queuePull(240, { files: files((list) => { list[1] = { ...list[1], status: "renamed", filename: ".github/coordinator/test/x.mjs", previous_filename: ".github/coordinator/card-contracts.mjs" }; }) })],
    ["an extra path", queuePull(240, { files: files((list) => list.push({ filename: "src/app/page.tsx", status: "modified", sha: "6".repeat(40), additions: 1, deletions: 0 })) })],
    ["coordinator code", queuePull(240, { files: files((list) => list.push({ filename: ".github/coordinator/service/card-run.mjs", status: "modified", sha: "6".repeat(40), additions: 1, deletions: 0 })) })],
    ["a rename from outside", queuePull(240, { files: files((list) => list.push({ filename: ".github/coordinator/test/y.test.mjs", previous_filename: ".github/coordinator/reconcile.mjs", status: "renamed", sha: "6".repeat(40), additions: 0, deletions: 0 })) })],
    ["a full page of files", queuePull(240, { files: Array.from({ length: 100 }, (_, i) => ({ filename: `.github/coordinator/test/f${i}.test.mjs`, status: "added", sha: "6".repeat(40), additions: 1, deletions: 0 })) })],
  ]) {
    const host = reviewHost([pull]);
    const skipped = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
    assert.equal(skipped.skipped, "QUEUE_DONE", `${label}: ${JSON.stringify(skipped)}`);
    notReviewed(host, label);
  }
  for (const file of [".github/coordinator/config.json", ".github/coordinator/card-contracts.mjs", ".github/coordinator/service/suite-inventory.json",
    ".github/coordinator/test/a.test.mjs", ".github/coordinator/service/test/fixtures/b.json"]) assert.equal(queueConfigPath(file), true, file);
  for (const file of [".github/coordinator/service/card-run.mjs", ".github/coordinator/test", ".github/coordinator/test/../reconcile.mjs",
    ".github/workflows/ci.yml", "test/a.test.mjs", ".github/coordinator/config.json.bak", ".github/coordinator/testdata/a.mjs"]) assert.equal(queueConfigPath(file), false, file);
});

test("SHU-321 R3: the reviewer of a Claude-written queue config is codex-verifier, and anything else is refused", async () => {
  const host = reviewHost();
  await autoRun({ io: host.io, paths: PATHS });
  assert.equal(host.armedRecords[0].reviewer_lane, "codex-verifier");
  assert.equal(assertQueueConfigReviewer({ kind: "review", record: { reviewer_lane: "codex-verifier" } }).kind, "review");
  assert.throws(() => assertQueueConfigReviewer({ kind: "review", record: { reviewer_lane: "claude-verifier" } }), { code: "CARD_RUN_REVIEWER" });
  assert.throws(() => assertQueueConfigReviewer({ kind: "card", record: { reviewer_lane: "codex-verifier" } }), { code: "CARD_RUN_REVIEWER" });
  // A lane that lists another non-Claude reviewer first is never armed.
  const hermesFirst = queueConfig();
  hermesFirst.review_lanes[0].reviewer_lanes = ["hermes-verifier", "codex-verifier"];
  const other = reviewHost([queuePull(240)], { config: hermesFirst });
  const skipped = await attempt(() => autoRun({ io: other.io, paths: PATHS }));
  assert.equal(skipped.skipped, "NOT_READY", JSON.stringify(skipped));
  notReviewed(other, "hermes first");
});

test("SHU-321 R4: a head is reviewed once, a pull request at most max_heads_per_pr heads per revision, and a busy host gives the head back", async () => {
  const host = reviewHost();
  assert.equal((await autoRun({ io: host.io, paths: PATHS })).outcome, "REVIEW_PASS");
  const ticks = host.ticks;
  const again = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(again.skipped, "QUEUE_DONE", "the reviewed head is not reviewed again");
  assert.equal(host.ticks, ticks);
  // A new head gets its own review, up to the cap of three.
  for (const head of ["7".repeat(40), "8".repeat(40)]) {
    setPulls(host, [queuePull(240, { head })]);
    const run = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
    assert.equal(run.review?.head, head, JSON.stringify(run));
  }
  setPulls(host, [queuePull(240, { head: "9".repeat(40) })]);
  const capped = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(capped.skipped, "REVIEW_CAP", JSON.stringify(capped));
  assert.equal(host.files.has(reviewClaim(PATHS, 240, "9".repeat(40))), false, "a capped head claims nothing");
  assert.equal(reviewClaims(host).length, 3);
  // Claims of another revision do not count against this one's cap.
  const fresh = reviewHost([queuePull(240, { head: "9".repeat(40) })]);
  for (const head of [PR_HEAD, "7".repeat(40), "8".repeat(40)]) {
    fresh.files.set(reviewClaim(PATHS, 240, head), { text: JSON.stringify({ pr: 240, head, revision: "f".repeat(40) }), mode: 0o600, uid: 0, gid: 0 });
  }
  assert.equal((await attempt(() => autoRun({ io: fresh.io, paths: PATHS }))).outcome, "REVIEW_PASS");
  // Another start that claimed the head after this one listed the claims wins.
  const raced = reviewHost();
  const readdir = raced.fs.readdirSync;
  raced.io = { ...raced.io, fs: { ...raced.fs, readdirSync: (dir) => readdir(dir).filter((name) => !name.startsWith("card-review-auto-")) } };
  raced.files.set(reviewClaim(PATHS, 240, PR_HEAD), { text: "{}", mode: 0o600, uid: 0, gid: 0 });
  const lost = await attempt(() => autoRun({ io: raced.io, paths: PATHS }));
  assert.equal(lost.skipped, "ALREADY_REVIEWED", JSON.stringify(lost));
  assert.equal(raced.files.get(reviewClaim(PATHS, 240, PR_HEAD)).text, "{}", "the other start's claim stands");
  assert.equal(raced.ticks, 0);
  noArming(raced);
  // A lock taken after the claim gives the head back.
  const locked = reviewHost();
  const write = locked.fs.writeFileSync;
  locked.io = { ...locked.io, fs: { ...locked.fs, writeFileSync: (file, text, options) => {
    if (file === PATHS.lock) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    return write(file, text, options);
  } } };
  assert.equal((await attempt(() => autoRun({ io: locked.io, paths: PATHS }))).skipped, "LOCKED");
  assert.deepEqual(reviewClaims(locked), [], "the next start may still review this head");
  // A refusal before arming keeps the claim and reports once.
  const owned = reviewHost();
  owned.card.assignee = { id: "someone" };
  const refused = await attempt(() => autoRun({ io: owned.io, paths: PATHS }));
  assert.equal(refused.outcome, "NOT_STARTED", JSON.stringify(refused));
  assert.equal(JSON.parse(owned.files.get(reviewClaim(PATHS, 240, PR_HEAD)).text).outcome, "NOT_STARTED");
  assert.equal(owned.reports.length, 1);
  assert.match(owned.reports[0], /^Card run on SHU-304 \(review\): NOT_STARTED/m);
  assert.equal((await attempt(() => autoRun({ io: owned.io, paths: PATHS }))).skipped, "QUEUE_DONE");
  assert.equal(owned.reports.length, 1, "reported once");
});

test("SHU-321 R5: a stopped, invalid or paused queue never reviews, and a pause during discovery wins", async () => {
  const stopped = reviewHost();
  claimFor(stopped, REV, "SHU-305", { outcome: "PASS", ok: true, land: "CI_TIMEOUT" });
  const stop = await attempt(() => autoRun({ io: stopped.io, paths: PATHS }));
  assert.equal(stop.skipped, "QUEUE_STOPPED");
  assert.equal(stopped.api.some((call) => call.startsWith("github")), false, "GitHub is not read");
  notReviewed(stopped, "stopped");
  const paused = reviewHost();
  paused.files.set(PATHS.pause, { text: "" });
  assert.equal((await attempt(() => autoRun({ io: paused.io, paths: PATHS }))).skipped, "PAUSED");
  assert.deepEqual(paused.api, []);
  notReviewed(paused, "paused");
  const invalid = reviewHost([queuePull(240)], { config: queueConfig(["SHU-301", "SHU-304"]) });
  assert.equal((await attempt(() => autoRun({ io: invalid.io, paths: PATHS }))).skipped, "NOT_READY");
  assert.deepEqual(invalid.api, []);
  notReviewed(invalid, "invalid queue");
  // The owner pauses while GitHub is read: nothing is claimed or armed.
  const late = reviewHost();
  const fetch = late.io.fetch;
  late.io = { ...late.io, fetch: async (url, options) => {
    if (String(url).includes("/compare/")) late.files.set(PATHS.pause, { text: "" });
    return fetch(url, options);
  } };
  const lateRun = await attempt(() => autoRun({ io: late.io, paths: PATHS }));
  assert.equal(lateRun.skipped, "PAUSED", JSON.stringify(lateRun));
  notReviewed(late, "paused during discovery");
});

// Self-repair A: a card a person merged at the run's reviewed head.
const HAND_PR = 77;
const HAND_MERGE = "3".repeat(40);
const handClaim = (fields = {}) => ({ outcome: "PASS", ok: false, land: "CI_TIMEOUT", repo: COMMITTED.pilot_repo, pr: HAND_PR, reviewed_head: PASSED, ...fields });
// GitHub as a person left it: #77 merged at `head` into `base`, its merge
// commit `onMain` as main's first parent (or only reachable as a second parent).
function handGitHub(host, { merged = true, head = PASSED, base = "main", baseRepo = COMMITTED.pilot_repo, onMain = "first", fail = null } = {}) {
  const api = `https://api.github.com/repos/${COMMITTED.pilot_repo}`;
  const side = "4".repeat(40);
  const commits = onMain === "first"
    ? [{ sha: "5".repeat(40), parents: [{ sha: HAND_MERGE }] }, { sha: HAND_MERGE, parents: [{ sha: REV }] }, { sha: REV, parents: [] }]
    : [{ sha: "5".repeat(40), parents: [{ sha: REV }, { sha: HAND_MERGE }] }, { sha: HAND_MERGE, parents: [{ sha: side }] }, { sha: REV, parents: [] }];
  host.githubCalls = [];
  const delegate = host.io.fetch;
  host.io.fetch = async (url, options = {}) => {
    const respond = (status, json) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => structuredClone(json) });
    if (url === `${api}/pulls/${HAND_PR}` || url.startsWith(`${api}/commits?sha=main`)) {
      host.githubCalls.push(`${options.method ?? "GET"} ${url}`);
      if (fail && fail(url)) { if (fail(url) === "throw") throw new TypeError("fetch failed"); return respond(500, null); }
      if (url.endsWith(`/pulls/${HAND_PR}`)) {
        return respond(200, { number: HAND_PR, merged, merge_commit_sha: HAND_MERGE,
          base: { ref: base, repo: { full_name: baseRepo } }, head: { ref: "coordinator/SHU-301", sha: head } });
      }
      return respond(200, url.endsWith("page=1") ? commits : []);
    }
    return delegate(url, options);
  };
  return host;
}

test("Self-repair A: a card a person merged at the reviewed head counts as landed, is recorded once, and the queue moves on", async () => {
  const host = handGitHub(fakeHost({ config: queueConfig(), branchHead: "", onTick: (h) => (h.ticks === 1 ? passFor("SHU-305")(h) : tickText("activation=absent (committed gates only)")) }));
  host.mainTip = HEAD;
  claimFor(host, REV, "SHU-301", handClaim());
  assert.deepEqual([...HAND_LAND_OUTCOMES].sort(), ["CI_TIMEOUT", "MERGE_HOLD", "PR_OPENED_CI_RED", "THREADS_HELD"]);
  // Without GitHub, the claim alone stops the queue as before.
  assert.equal((await nextCard(host.io, PATHS, queueConfig(), REV)).skipped, "QUEUE_STOPPED");
  // The read-only plan proves it, prepares SHU-301 no more, and records nothing.
  const { output } = await main(["plan"], host.io, PATHS);
  assert.deepEqual(output.next, { id: "SHU-305" }, JSON.stringify(output));
  assert.deepEqual(output.queued[0], { id: "SHU-301", prepare: { skipped: "LANDED" } });
  assert.equal(host.files.has(handLandRecord(PATHS, "SHU-301")), false, "the plan records nothing");
  // The timer proves it, records it, and runs the next card.
  const run = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(run.card, "SHU-305", JSON.stringify(run));
  assert.ok(host.files.has(handLandRecord(PATHS, "SHU-301")), "the proven hand landing is recorded");
  const record = JSON.parse(host.files.get(handLandRecord(PATHS, "SHU-301")).text);
  assert.deepEqual({ ...record, recorded_at: null }, { card: "SHU-301", revision: REV, pr: HAND_PR, reviewed_head: PASSED, merge_commit: HAND_MERGE, recorded_at: null });
  assert.equal(host.files.get(handLandRecord(PATHS, "SHU-301")).mode, 0o600);
  assert.ok(host.githubCalls.length > 0 && host.githubCalls.every((call) => call.startsWith("GET ")), "GitHub is only read");
  // Recorded, it stays landed when GitHub can no longer be read.
  assert.deepEqual(await cardLanded(host.io, PATHS, "SHU-301"), { landed: true, by: "hand" });
  // Every outcome that stopped at landing after a passed review qualifies.
  for (const land of HAND_LAND_OUTCOMES) {
    const other = handGitHub(fakeHost({ config: queueConfig() }));
    claimFor(other, REV, "SHU-301", handClaim({ land }));
    const landing = { repo: COMMITTED.pilot_repo, gh: (method, url) => other.io.fetch(url, { method }) };
    assert.equal((await cardLanded(other.io, PATHS, "SHU-301", landing)).landed, true, land);
  }
});

test("Self-repair A: no other merge, claim or read counts a card as landed", async () => {
  const cases = [
    ["a different head", {}, { head: "6".repeat(40) }],
    ["closed, not merged", {}, { merged: false }],
    ["merged into another branch", {}, { base: "release" }],
    ["merged into another repository's main", {}, { baseRepo: "someone/fork" }],
    ["a merge commit off main's first parents", {}, { onMain: "second" }],
    ["a pull request that cannot be read", {}, { fail: (url) => url.includes("/pulls/") }],
    ["a lost answer", {}, { fail: (url) => (url.includes("/pulls/") ? "throw" : null) }],
    ["main's history that cannot be read", {}, { fail: (url) => url.includes("/commits?") }],
    ["a legacy claim with no pull request", { pr: undefined, reviewed_head: undefined, repo: undefined }, {}],
    ["a claim with no reviewed head", { reviewed_head: null }, {}],
    ["a claim for another repository", { repo: "someone/fork" }, {}],
    ["a run that did not pass", { outcome: "STOPPED" }, {}],
    ["a landing that errored", { land: "LAND_ERROR" }, {}],
    ["a head mismatch at landing", { land: "LAND_HEAD_MISMATCH" }, {}],
  ];
  for (const [label, claim, github] of cases) {
    const host = handGitHub(fakeHost({ config: queueConfig() }), github);
    claimFor(host, REV, "SHU-301", handClaim(claim));
    const landing = { repo: COMMITTED.pilot_repo, gh: (method, url) => host.io.fetch(url, { method }) };
    const result = await cardLanded(host.io, PATHS, "SHU-301", { ...landing, record: true });
    assert.equal(result.landed, false, `${label}: ${JSON.stringify(result)}`);
    const stopped = await nextCard(host.io, PATHS, queueConfig(), REV, { landing, record: true });
    assert.equal(stopped.skipped, "QUEUE_STOPPED", label);
    // The stop says why a hand merge was not proven, whenever GitHub was asked.
    if (result.reason) assert.ok(stopped.reason.endsWith(`; hand landing not proven: ${result.reason}`), `${label}: ${stopped.reason}`);
    assert.equal(host.files.has(handLandRecord(PATHS, "SHU-301")), false, `${label}: nothing recorded`);
  }
  // A recorded hand landing must name its card and its proof.
  const forged = fakeHost({ config: queueConfig() });
  forged.files.set(handLandRecord(PATHS, "SHU-301"), { text: JSON.stringify({ card: "SHU-305", pr: HAND_PR, reviewed_head: PASSED, merge_commit: HAND_MERGE }), mode: 0o600, uid: 0, gid: 0 });
  assert.equal((await cardLanded(forged.io, PATHS, "SHU-301")).landed, false);
});

test("SHU-321 R6: under a queue the scope narrows to the committed review lane only, and planning admits only that review", async () => {
  const { narrowQueueScope } = await import("../single-run-activation.mjs");
  const { resolveDispatchScope } = await import("../reconcile.mjs");
  const { resolveQueueConfigReview } = await import("../workspace-scope.mjs");
  assert.deepEqual({ ...resolveQueueConfigReview(COMMITTED) }, { lane: "SHU-304", label: "coordinator:queue-config", maxHeadsPerPr: 3 });
  const review = { pr: 240, head: PR_HEAD, base: PR_BASE, authorFamily: "claude" };
  const record = planRun({ config: queueConfig(), revision: REV, now: START, review, cardId: "SHU-304" }).record;
  const file = (text) => ({ lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }), readFile: () => text });
  const narrowed = narrowQueueScope(queueConfig(), "/isolated/activation", file(JSON.stringify(record)));
  assert.deepEqual([...resolveDispatchScope(narrowed).issueIds], ["SHU-304"]);
  const withoutPolicy = queueConfig();
  delete withoutPolicy.queue_config_review;
  for (const [label, config] of [
    ["no queue_config_review", withoutPolicy],
    ["a malformed queue_config_review", { ...queueConfig(), queue_config_review: { ...COMMITTED.queue_config_review, lane: "SHU-301" } }],
  ]) {
    const kept = narrowQueueScope(config, "/isolated/activation", file(JSON.stringify(record)));
    assert.deepEqual(kept.dispatch_scope.issue_ids, [...QUEUE], label);
    assert.equal(resolveDispatchScope(kept).valid, false, `${label}: the queue as committed scopes nothing`);
    assert.throws(() => planRun({ config, revision: REV, now: START, review, cardId: "SHU-304" }), { code: /^CARD_RUN_(REVIEW_INPUT|CONFIG)$/ }, label);
  }
  // Only the committed lane, and only as a review.
  assert.throws(() => planRun({ config: queueConfig(), revision: REV, now: START, review, cardId: "SHU-301" }), { code: "CARD_RUN_REVIEW_INPUT" });
  assert.throws(() => planRun({ config: queueConfig(), revision: REV, now: START, review }), { code: "CARD_RUN_REVIEW_INPUT" });
  assert.throws(() => planRun({ config: queueConfig(), revision: REV, now: START, cardId: "SHU-304" }), { code: "CARD_RUN_SCOPE" });
  for (const policy of [{ lane: "SHU-304" }, { ...COMMITTED.queue_config_review, max_heads_per_pr: 0 }, { ...COMMITTED.queue_config_review, label: "a b" },
    { ...COMMITTED.queue_config_review, lane: "SHU-301" }, { ...COMMITTED.queue_config_review, note: "x" }, []]) {
    assert.throws(() => resolveQueueConfigReview({ ...COMMITTED, queue_config_review: policy }), /queue_config_review/, JSON.stringify(policy));
  }
});

test("SHU-321 R7: the claim records the pull request, its head and base, the run and every file's blob, and never reads as a landing", async () => {
  const host = reviewHost();
  const run = await autoRun({ io: host.io, paths: PATHS });
  const claim = JSON.parse(host.files.get(reviewClaim(PATHS, 240, PR_HEAD)).text);
  assert.deepEqual(claim, {
    pr: 240, head: PR_HEAD, base: PR_BASE, revision: REV, activation_id: run.activation_id, outcome: "REVIEW_PASS",
    files: Object.fromEntries(queueFiles().map((file) => [file.filename, { sha: file.sha, additions: file.additions, deletions: file.deletions }])),
  });
  assert.equal(host.files.get(reviewClaim(PATHS, 240, PR_HEAD)).mode, 0o600);
  assert.doesNotMatch(path.basename(reviewClaim(PATHS, 240, PR_HEAD)), /^card-run-auto-/);
  assert.equal((await nextCard(host.io, PATHS, queueConfig(), REV)).skipped, "QUEUE_DONE", "a review claim is never a card's landing");
});

test("SHU-321 R8: a GitHub read that fails is a skip that claims nothing", async () => {
  for (const [label, fails] of [
    ["the open list", (url) => url.includes("/pulls?")],
    ["the files", (url) => url.includes("/files?")],
    ["the commits", (url) => url.includes("/commits?")],
    ["the merge base", (url) => url.includes("/compare/")],
  ]) {
    const host = reviewHost();
    host.githubFails = fails;
    const skipped = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
    assert.equal(skipped.skipped, "REVIEW_UNREADABLE", `${label}: ${JSON.stringify(skipped)}`);
    assert.match(skipped.reason, /HTTP 502/, label);
    notReviewed(host, label);
  }
  const noCredentials = reviewHost();
  noCredentials.files.delete(PATHS.coordinatorEnv);
  assert.equal((await attempt(() => autoRun({ io: noCredentials.io, paths: PATHS }))).skipped, "REVIEW_UNREADABLE");
  notReviewed(noCredentials, "no credentials");
});

// Self-watch 0d: the outside watch, on its own small fake host. It reads the
// card-run unit and the status file, keeps one SHU-71 status comment and
// raises one alert per stuck run; it never touches the run itself.
function watchHost({ state = "inactive", since = null, status = null, now = Date.parse("2026-10-18T08:00:00.000Z") } = {}) {
  const files = new Map();
  const host = { files, calls: [], comments: [], requests: [], unit: { state, since }, now, linearDown: false, showFails: false };
  const put = (file, text, extra = {}) => files.set(file, { text, mode: 0o644, ...extra });
  put(PATHS.coordinatorEnv, "GITHUB_TOKEN=gh-secret-value\nLINEAR_API_TOKEN=lin-secret-value\n", { uid: 997, mode: 0o600 });
  put(`${PATHS.checkout}/.github/coordinator/config.json`, JSON.stringify({ owner_mention: "https://linear.app/bawes/profiles/owner" }));
  if (status) put(statusPath(PATHS), `${JSON.stringify(status)}\n`, { mode: 0o600 });
  host.put = put;
  host.fs = {
    existsSync: (file) => files.has(file),
    lstatSync: (file) => {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      return { isFile: () => true, isSymbolicLink: () => false, uid: files.get(file).uid ?? 0, mode: 0o100000 | files.get(file).mode };
    },
    readFileSync: (file) => {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      return files.get(file).text;
    },
    writeFileSync: (file, text, options = {}) => {
      if (options.flag === "wx" && files.has(file)) throw Object.assign(new Error(`EEXIST ${file}`), { code: "EEXIST" });
      put(file, String(text), { mode: options.mode ?? 0o644 });
    },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync: (file) => { if (!files.delete(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" }); },
  };
  host.exec = (file, args) => {
    host.calls.push([file, ...args].join(" "));
    if (file === "id") return { status: 0, stdout: "997\n", stderr: "" };
    if (file === "systemctl" && args[0] === "show") {
      if (host.showFails) return { status: 1, stdout: "", stderr: "Failed to connect to bus" };
      const exit = host.unit.since === null ? 0 : (host.unit.since - BOOT) * 1000;
      return { status: 0, stdout: `ActiveState=${host.unit.state}\nInactiveExitTimestampMonotonic=${exit}\nInvocationID=${host.unit.invocation ?? ""}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  host.fetch = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    host.requests.push({ query, variables });
    if (host.linearDown) return { ok: false, status: 500, headers: new Map(), json: async () => ({ errors: [{ message: "Linear is down" }] }) };
    const answer = (data) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ data }) });
    if (query.includes("CardRunReportIssue")) {
      return answer({ issue: { id: "shu-71-id", identifier: "SHU-71", comments: { nodes: host.comments.filter((comment) => comment.body.includes(variables.marker)).slice(0, 1).map(({ id }) => ({ id })) } } });
    }
    if (query.includes("commentCreate")) {
      const comment = { id: `comment-${host.comments.length + 1}`, body: variables.body };
      host.comments.push(comment);
      return answer({ commentCreate: { success: true, comment: { id: comment.id } } });
    }
    if (query.includes("commentUpdate")) {
      const comment = host.comments.find(({ id }) => id === variables.id);
      if (!comment) return { ok: false, status: 400, headers: new Map(), json: async () => ({ errors: [{ message: "Entity not found" }] }) };
      comment.body = variables.body;
      return answer({ commentUpdate: { success: true } });
    }
    throw new Error(`unexpected Linear request ${query}`);
  };
  host.io = { fs: host.fs, exec: host.exec, fetch: host.fetch, uid: () => 0, now: () => new Date(host.now), monotonicMs: () => host.now - BOOT, sleep: () => {} };
  return host;
}

const MIN = 60 * 1000;
// The host booted here; systemd's monotonic stamps count from it.
const BOOT = Date.parse("2026-10-17T00:00:00.000Z");
const startKey = (since) => `start-${(since - BOOT) * 1000}`;
const watchStatus = (fields = {}) => ({ version: 1, run_id: "shu-301-run-20261018T070000Z", card: "SHU-301", kind: "card", trigger: "timer",
  revision: REV, queue: ["SHU-301", "SHU-302"], step: "ticking", ticks: 4, last_tick_at: "2026-10-18T07:04:00.000Z", armed_at: "2026-10-18T07:00:30.000Z",
  first_dispatch_at: "2026-10-18T07:02:00.000Z", last_progress_at: "2026-10-18T07:03:00.000Z", paused: false,
  next_start: "2026-10-18T07:30:00.000Z", updated_at: "2026-10-18T07:04:00.000Z", ...fields });
const alertsOf = (host) => host.comments.filter((comment) => comment.body.includes("card-run-report card-watch-"));
const statusComments = (host) => host.comments.filter((comment) => comment.body.includes(STATUS_MARKER));
const sideEffects = (host) => host.calls.filter((call) => !/^(id -u shu-coordinator|systemctl show -p ActiveState -p InactiveExitTimestampMonotonic -p InvocationID shu-card-run\.service)$/.test(call));

test("SHU-86 0d: the watch keeps one SHU-71 status comment, edited only when it changes", async () => {
  const host = watchHost({ status: watchStatus({ step: "finished", outcome: "PASS", land: "MERGED", needs_owner: false, updated_at: "2026-10-18T07:40:00.000Z" }) });
  const first = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.status_comment, { changed: true, posted: true });
  assert.equal(statusComments(host).length, 1);
  const body = statusComments(host)[0].body;
  assert.ok(body.startsWith(`${STATUS_MARKER}\n`));
  for (const line of ["shu-card-run.service: idle.", "Timer: next start 2026-10-18T08:30:00.000Z.", "Queue: SHU-301, SHU-302.",
    "Latest run: SHU-301 (card, timer), step finished, 4 tick(s), last tick 2026-10-18T07:04:00.000Z.",
    "Progress: first dispatch 2026-10-18T07:02:00.000Z, last progress 2026-10-18T07:03:00.000Z.", "Outcome: PASS, landing MERGED."]) {
    assert.ok(body.split("\n").includes(line), `${line}\n${body}`);
  }
  assert.doesNotMatch(body, /secret|Alert/);
  // Nothing changed: no request at all.
  const before = host.requests.length;
  host.now += 10 * MIN;
  assert.deepEqual((await watchOnce({ io: host.io, paths: PATHS })).status_comment, { changed: false });
  assert.equal(host.requests.length, before);
  // A new status edits the same comment in place.
  host.put(statusPath(PATHS), JSON.stringify(watchStatus({ step: "ticking", run_id: "shu-302-run-20261018T080000Z", card: "SHU-302", updated_at: "2026-10-18T08:09:00.000Z" })));
  host.unit = { state: "activating", since: Date.parse("2026-10-18T08:00:00.000Z") };
  assert.deepEqual((await watchOnce({ io: host.io, paths: PATHS })).status_comment, { changed: true, posted: true });
  assert.equal(statusComments(host).length, 1);
  assert.match(statusComments(host)[0].body, /shu-card-run\.service: running since 2026-10-18T08:00:00\.000Z\.\nTimer: next start/);
  assert.match(statusComments(host)[0].body, /Latest run: SHU-302 \(card, timer\), step ticking/);
  // A lost state file finds the comment by its marker instead of posting again.
  host.files.delete(path.join(PATHS.stateDir, "card-watch.json"));
  host.put(PATHS.pause, "paused by hand\n");
  assert.deepEqual((await watchOnce({ io: host.io, paths: PATHS })).status_comment, { changed: true, posted: true });
  assert.equal(statusComments(host).length, 1);
  assert.match(statusComments(host)[0].body, /Timer: paused \(the pause file is present\)\./);
  assert.equal(host.files.get(PATHS.pause).text, "paused by hand\n", "the watch never touches a pause file it did not write");
  assert.deepEqual(sideEffects(host), []);
  assert.equal(host.files.get(path.join(PATHS.stateDir, "card-watch.json")).mode, 0o600);
});

test("SHU-86 0d: a stale status with the unit running pauses the timer and alerts once", async () => {
  const since = Date.parse("2026-10-18T07:00:00.000Z");
  const host = watchHost({ state: "activating", since, status: watchStatus(), now: Date.parse("2026-10-18T08:04:00.000Z") });
  // Exactly the limit since the last status write: not yet stale.
  const fresh = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(fresh.alert, null);
  assert.equal(host.files.has(PATHS.pause), false);
  host.now += MIN;
  const stale = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.deepEqual(stale.alert, { key: startKey(since), kind: "stale", pause: { written: true }, posted: true });
  assert.match(host.files.get(PATHS.pause)?.text ?? "", /^card-watch: stale run start-\d+\n$/);
  assert.equal(alertsOf(host).length, 1);
  const alert = alertsOf(host)[0].body.split("\n");
  assert.equal(alert[1], "Alert: the card run on SHU-301 needs the owner (https://linear.app/bawes/profiles/owner).");
  assert.match(alert[2], /running since 2026-10-18T07:00:00\.000Z, and the run's status was last written at 2026-10-18T07:04:00\.000Z \(step ticking\): nothing for more than 60 minutes\./);
  assert.match(alert[3], /^Wrote \/etc\/shu\/card-run\.paused/);
  assert.doesNotMatch(alertsOf(host)[0].body, /secret/);
  // Later passes, stale or ended, never alert this run again.
  for (const [state, extra] of [["activating", 10], ["failed", 30]]) {
    host.unit = { state, since };
    host.now += extra * MIN;
    const again = await watchOnce({ io: host.io, paths: PATHS });
    assert.equal(again.alert.already, true, JSON.stringify(again));
  }
  assert.equal(alertsOf(host).length, 1);
  assert.deepEqual(sideEffects(host), [], "the watch never stops, kills or reverts a run");
});

test("SHU-86 0d: a run that hangs before it writes a status is still caught", async () => {
  const since = Date.parse("2026-10-18T07:00:00.000Z");
  // The status is the previous run's, written before this start.
  const host = watchHost({ state: "activating", since, now: since + 61 * MIN,
    status: watchStatus({ step: "finished", outcome: "PASS", land: "MERGED", updated_at: "2026-10-18T06:50:00.000Z" }) });
  const result = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(result.alert.kind, "stale");
  assert.equal(result.alert.posted, true);
  assert.match(alertsOf(host)[0].body, /Alert: the card run needs the owner/);
  assert.match(alertsOf(host)[0].body, /no status was written since it started: nothing for more than 60 minutes\./);
  assert.ok(host.files.has(PATHS.pause));
  assert.equal(stuckRun({ unit: { running: true, since, start: "42" }, status: null, now: since + 60 * MIN }), null);
  assert.equal(stuckRun({ unit: { running: true, since, start: "42" }, status: null, now: since + 61 * MIN }).key, "start-42");
});

test("SHU-86 0d: a run alerted stale before its first status write, that later writes one and ends unfinished, is alerted once", async () => {
  const since = Date.parse("2026-10-18T07:00:00.000Z");
  const invocation = "fedcba9876543210fedcba9876543210";
  const ended = (fields = {}) => watchStatus({ invocation, step: "reverting", outcome: "ERROR", updated_at: "2026-10-18T08:20:00.000Z", ...fields });
  // Both cases: the run resumes, writes and ends between two passes, or a
  // pass sees it running with its own status first.
  for (const seenRunning of [false, true]) {
    const host = watchHost({ state: "activating", since, now: since + 61 * MIN,
      status: watchStatus({ step: "finished", outcome: "PASS", land: "MERGED", updated_at: "2026-10-18T06:50:00.000Z" }) });
    host.unit.invocation = invocation;
    const stale = await watchOnce({ io: host.io, paths: PATHS });
    assert.deepEqual(stale.alert, { key: startKey(since), kind: "stale", pause: { written: true }, posted: true });
    if (seenRunning) {
      host.put(statusPath(PATHS), JSON.stringify(ended({ step: "ticking", outcome: undefined, updated_at: "2026-10-18T08:05:00.000Z" })));
      host.now = Date.parse("2026-10-18T08:10:00.000Z");
      assert.equal((await watchOnce({ io: host.io, paths: PATHS })).alert, null, "a resumed run is not stale");
    }
    host.put(statusPath(PATHS), JSON.stringify(ended()));
    host.unit = { state: "failed", since };
    host.now = Date.parse("2026-10-18T08:31:00.000Z");
    const again = await watchOnce({ io: host.io, paths: PATHS });
    assert.equal(again.alert?.already, true, JSON.stringify(again));
    assert.equal(alertsOf(host).length, 1, "one run, one alert");
  }
  // A different run that ends unfinished is still alerted.
  const other = watchHost({ state: "failed", since: Date.parse("2026-10-18T08:00:00.000Z"), now: Date.parse("2026-10-18T08:31:00.000Z"),
    status: ended({ run_id: "shu-302-run-20261018T080000Z", invocation: "00000000000000000000000000000001" }) });
  other.put(path.join(PATHS.stateDir, "card-watch.json"), JSON.stringify({ alerts: [{ key: startKey(since), run_id: null, invocation, kind: "stale", posted: true, pause: { written: true } }] }));
  assert.equal((await watchOnce({ io: other.io, paths: PATHS })).alert.posted, true);
});

test("SHU-86 0d: a timer run that ended without finishing alerts once; a finished, operator or recent one never does", async () => {
  const at = Date.parse("2026-10-18T07:04:00.000Z");
  const unit = { state: "failed", running: false, since: null, start: null };
  const read = (fields) => ({ ...watchStatus(fields), ...fields });
  assert.equal(stuckRun({ unit, status: read({}), now: at + 10 * MIN }), null, "ten minutes is not yet ended");
  assert.equal(stuckRun({ unit, status: read({}), now: at + 11 * MIN }).kind, "ended");
  assert.equal(stuckRun({ unit, status: read({ step: "finished" }), now: at + 11 * MIN }), null);
  assert.equal(stuckRun({ unit, status: read({ trigger: "operator" }), now: at + 11 * MIN }), null);
  assert.equal(stuckRun({ unit: null, status: read({}), now: at + 11 * MIN }), null, "an unreadable unit raises nothing");
  const host = watchHost({ state: "failed", since: Date.parse("2026-10-18T07:00:00.000Z"), status: watchStatus({ step: "reverting", outcome: "ERROR" }), now: at + 11 * MIN });
  const ended = await watchOnce({ io: host.io, paths: PATHS });
  assert.deepEqual(ended.alert, { key: "shu-301-run-20261018T070000Z", kind: "ended", pause: { written: true }, posted: true });
  assert.match(alertsOf(host)[0].body, /is not running, but the run's status stopped at step reverting at 2026-10-18T07:04:00\.000Z and never reached finished/);
  host.now += 10 * MIN;
  assert.equal((await watchOnce({ io: host.io, paths: PATHS })).alert.already, true);
  assert.equal(alertsOf(host).length, 1);
});

test("SHU-86 0d: a timer run whose unit failed before its first status write alerts once; an idle unit never does", async () => {
  const since = Date.parse("2026-10-18T08:00:00.000Z");
  const previous = watchStatus({ step: "finished", outcome: "PASS", land: "MERGED", updated_at: "2026-10-18T07:40:00.000Z" });
  const host = watchHost({ state: "failed", since, now: since + 2 * MIN, status: previous });
  const failed = await watchOnce({ io: host.io, paths: PATHS });
  assert.deepEqual(failed.alert, { key: startKey(since), kind: "failed", pause: { written: true }, posted: true });
  assert.match(alertsOf(host)[0].body, /shu-card-run\.service failed after starting at 2026-10-18T08:00:00\.000Z, before its run wrote any status/);
  assert.match(statusComments(host)[0].body, /shu-card-run\.service: failed \(last started 2026-10-18T08:00:00\.000Z\)\./);
  host.now += 10 * MIN;
  assert.equal((await watchOnce({ io: host.io, paths: PATHS })).alert.already, true);
  assert.equal(alertsOf(host).length, 1);
  // The same unit idle, or failed after its run wrote a finished status: nothing.
  for (const [state, status] of [["inactive", previous], ["failed", watchStatus({ step: "finished", outcome: "ERROR", updated_at: "2026-10-18T08:01:00.000Z" })]]) {
    const quiet = watchHost({ state, since, now: since + 2 * MIN, status });
    assert.equal((await watchOnce({ io: quiet.io, paths: PATHS })).alert, null, state);
  }
});

test("SHU-86 0d: an alert that cannot be posted is tried again on the next pass, never posted twice, and a pause file in place is kept", async () => {
  const since = Date.parse("2026-10-18T07:00:00.000Z");
  const host = watchHost({ state: "activating", since, status: watchStatus(), now: since + 70 * MIN });
  host.put(PATHS.pause, "card-install: held\n");
  host.linearDown = true;
  const failed = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(failed.ok, false);
  assert.equal(failed.alert.posted, false);
  assert.deepEqual(failed.alert.pause, { written: false, held: true });
  assert.equal(failed.status_comment.posted, false);
  assert.equal(host.files.get(PATHS.pause).text, "card-install: held\n");
  host.linearDown = false;
  host.now += 10 * MIN;
  const retried = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.alert.posted, true);
  assert.match(alertsOf(host)[0].body, /\/etc\/shu\/card-run\.paused was already in place\./);
  host.now += 10 * MIN;
  assert.equal((await watchOnce({ io: host.io, paths: PATHS })).alert.already, true);
  assert.equal(alertsOf(host).length, 1);
  // A comment posted but not recorded (a crash after the post) is found by its
  // marker and never posted again.
  host.files.delete(path.join(PATHS.stateDir, "card-watch.json"));
  host.now += 10 * MIN;
  assert.equal((await watchOnce({ io: host.io, paths: PATHS })).alert.posted, true);
  assert.equal(alertsOf(host).length, 1);
});

test("SHU-86 0d: a pause file that could not be written is tried again on every pass, and the alert is still posted once", async () => {
  const since = Date.parse("2026-10-18T07:00:00.000Z");
  const host = watchHost({ state: "activating", since, status: watchStatus(), now: since + 70 * MIN });
  const write = host.fs.writeFileSync;
  host.pauseFails = 2;
  host.fs.writeFileSync = (file, text, options) => {
    if (file === PATHS.pause && host.pauseFails > 0) {
      host.pauseFails -= 1;
      throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    }
    return write(file, text, options);
  };
  const first = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(first.ok, false, "a stuck run left unpaused fails the pass");
  assert.deepEqual(first.alert.pause, { written: false, held: false, code: "EROFS" });
  assert.equal(first.alert.posted, true);
  assert.match(alertsOf(host)[0].body, /\/etc\/shu\/card-run\.paused could not be written \(EROFS\)\./);
  host.now += 10 * MIN;
  const second = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(second.alert.already, true);
  assert.equal(second.alert.pause.written, false);
  assert.equal(host.files.has(PATHS.pause), false);
  host.now += 10 * MIN;
  const third = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.deepEqual(third.alert.pause, { written: true });
  assert.ok(host.files.has(PATHS.pause), "the retry paused the timer");
  host.now += 10 * MIN;
  assert.deepEqual((await watchOnce({ io: host.io, paths: PATHS })).alert.pause, { written: true }, "a written pause is kept, never written again");
  assert.equal(alertsOf(host).length, 1);
});

test("SHU-86 0d: the status the watch shows is built from validated fields only", () => {
  const host = watchHost({ status: watchStatus({ card: "SHU-301 <script>", queue: ["SHU-1", "x\n-->", 7], step: "hacked", outcome: "lin-secret-value",
    land: "MERGED\nAlert", revision: "nope", ticks: -1, last_tick_at: "soon", reason: "token lin-secret-value", needs_owner: "yes" }) });
  const status = readStatus(host.io, PATHS);
  assert.deepEqual({ card: status.card, queue: status.queue, step: status.step, outcome: status.outcome, land: status.land, revision: status.revision,
    ticks: status.ticks, last_tick_at: status.last_tick_at, needs_owner: status.needs_owner },
  { card: null, queue: ["SHU-1"], step: null, outcome: null, land: null, revision: null, ticks: null, last_tick_at: null, needs_owner: false });
  assert.equal(Object.hasOwn(status, "reason"), false);
  const body = renderStatus({ status, unit: { state: "inactive", running: false, since: null, start: null }, paused: false, now: new Date(host.now) });
  assert.doesNotMatch(body, /secret|script|hacked|-->[\s\S]*-->/);
  host.put(statusPath(PATHS), JSON.stringify(watchStatus({ version: 2 })));
  assert.equal(readStatus(host.io, PATHS), null);
  host.put(statusPath(PATHS), "{not json");
  assert.equal(readStatus(host.io, PATHS), null);
});

test("SHU-86 0d: an unreadable card-run unit raises no alert and fails the pass", async () => {
  const host = watchHost({ status: watchStatus(), now: Date.parse("2026-10-18T09:30:00.000Z") });
  host.showFails = true;
  const result = await watchOnce({ io: host.io, paths: PATHS });
  assert.equal(result.ok, false);
  assert.equal(result.alert, null);
  assert.equal(host.files.has(PATHS.pause), false);
  assert.match(statusComments(host)[0].body, /shu-card-run\.service: state unknown\./);
  const unitIO = (stdout, uptime = 3600 * 1000) => ({ exec: () => ({ status: 0, stdout, stderr: "" }), monotonicMs: () => uptime });
  const at = Date.parse("2026-10-18T08:00:00.000Z");
  // A running unit whose start cannot be placed reads as unknown, never as idle.
  for (const stdout of ["ActiveState=activating\nInactiveExitTimestampMonotonic=0\n", "ActiveState=activating\nInactiveExitTimestampMonotonic=Sat 2026-10-18 07:00:00 UTC\n",
    "ActiveState=activating\nInactiveExitTimestampMonotonic=7200000000\n", "\n"]) {
    assert.equal(readUnit(unitIO(stdout), at), null, stdout);
  }
  assert.deepEqual(readUnit(unitIO("ActiveState=inactive\nInactiveExitTimestampMonotonic=0\n"), at), { state: "inactive", running: false, since: null, start: null, invocation: null });
  // Started 1800 s after boot, read 3600 s after boot: half an hour ago, and
  // the same start on every later pass.
  assert.deepEqual(readUnit(unitIO("ActiveState=activating\nInactiveExitTimestampMonotonic=1800000000\n"), at),
    { state: "activating", running: true, since: at - 30 * MIN, start: "1800000000", invocation: null });
  // The invocation id is kept only in systemd's form.
  for (const [id, want] of [["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"], ["0123", null], ["../x", null]]) {
    assert.equal(readUnit(unitIO(`ActiveState=activating\nInactiveExitTimestampMonotonic=1800000000\nInvocationID=${id}\n`), at).invocation, want, id);
  }
  assert.equal(readUnit(unitIO("ActiveState=active\nInactiveExitTimestampMonotonic=1800000000\n", 4200 * 1000), at + 10 * MIN).start, "1800000000");
});

test("SHU-86 0d: the watch timer goes on beside the card-run timer and comes off cleanly", () => {
  const host = watchHost();
  const enabled = { value: "disabled", active: "inactive" };
  host.io.exec = (file, args) => {
    host.calls.push([file, ...args].join(" "));
    if (args[0] === "enable") Object.assign(enabled, { value: "enabled", active: "active" });
    if (args[0] === "disable") Object.assign(enabled, { value: "disabled", active: "inactive" });
    if (args[0] === "is-enabled") return { status: 0, stdout: `${enabled.value}\n`, stderr: "" };
    if (args[0] === "is-active") return { status: 0, stdout: `${enabled.active}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const installed = installWatch(host.io, PATHS, { node: "/usr/bin/node", module: "/srv/shu/studenthub-platform/.github/coordinator/service/card-watchdog.mjs" });
  assert.deepEqual(installed.units, ["/etc/systemd/system/shu-card-watch.service", "/etc/systemd/system/shu-card-watch.timer"]);
  const service = host.files.get("/etc/systemd/system/shu-card-watch.service").text;
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/srv\/shu\/studenthub-platform\/\.github\/coordinator\/service\/card-watchdog\.mjs check$/m);
  assert.match(host.files.get("/etc/systemd/system/shu-card-watch.timer").text, /^OnCalendar=\*:05\/10$/m);
  assert.deepEqual(host.calls, ["systemctl daemon-reload", "systemctl enable --now shu-card-watch.timer", "systemctl is-enabled shu-card-watch.timer", "systemctl is-active shu-card-watch.timer"]);
  assert.equal(host.calls.some((call) => call.includes("shu-card-run")), false, "installing the watch never touches the card-run units");
  // Installing again is a no-op; other content is refused.
  installWatch(host.io, PATHS, { node: "/usr/bin/node", module: "/srv/shu/studenthub-platform/.github/coordinator/service/card-watchdog.mjs" });
  host.put("/etc/systemd/system/shu-card-watch.timer", "[Timer]\nOnCalendar=minutely\n");
  assert.throws(() => installWatch(host.io, PATHS, { node: "/usr/bin/node", module: "/x.mjs" }), /CARD_WATCH_TIMER/);
  assert.deepEqual(removeWatch(host.io, PATHS), { removed: true });
  assert.equal(host.files.has("/etc/systemd/system/shu-card-watch.service") || host.files.has("/etc/systemd/system/shu-card-watch.timer"), false);
  assert.ok(WATCH_LIMITS.staleMs > Math.max(CARD_RUN_LIMITS.workerGraceMs, CARD_RUN_LIMITS.landWaitMs), "a healthy revert or landing never reads as stale");
});

// ---------------------------------------------------------------------------
// Self-repair B1: card-prepare's repair branch (B2 passes `repair`)
// ---------------------------------------------------------------------------

const B1_OWNER = "48918d3d-f843-483f-bb23-2ba6c7ace499";
const B1_HEAD = "a".repeat(40);
const B1_PREP_REPO = "BAWES-Universe/studenthub-platform";

function b1Card(over = {}) {
  return { id: "lin-327", identifier: "SHU-327", updatedAt: "2026-10-20T16:29:43.000Z",
    state: { id: "ip", name: "In Progress", type: "started" }, assignee: { id: B1_OWNER }, delegate: null,
    labels: { nodes: [{ name: "repo:platform" }] },
    team: { id: "team", states: { nodes: [{ id: "todo", name: "Todo", type: "unstarted" }] } }, ...over };
}

function b1PrepPull(over = {}) {
  return { number: 293, state: "open", title: "[SHU-327] organization writes refuse a deleted organization",
    base: { ref: "main", repo: { full_name: B1_PREP_REPO } },
    head: { ref: "coordinator/SHU-327", sha: B1_HEAD, repo: { full_name: B1_PREP_REPO } }, ...over };
}

function b1RepairInput(over = {}) {
  return { repair: { repair_pr: 293, initial_target_sha: B1_HEAD }, owners: [B1_OWNER], repo: B1_PREP_REPO,
    pulls: { complete: true, items: [b1PrepPull()] }, ...over };
}

test("Self-repair B1: C1 a repair plan answers with the repair predicate and never a move", () => {
  assert.deepEqual(cardAction(b1Card(), b1RepairInput()), { action: "none" });
  assert.deepEqual(cardAction(b1Card({ state: { id: "todo", name: "Todo", type: "unstarted" }, assignee: null }), b1RepairInput()), { action: "none" });
  // A Backlog card that today's rule would move stays where it is under a repair.
  const backlog = cardAction(b1Card({ state: { id: "b", name: "Backlog", type: "backlog" }, assignee: null }), b1RepairInput());
  assert.equal(backlog.code, "CARD_RUN_REPAIR_INELIGIBLE");
  for (const [label, card, input, why] of [
    ["someone else", b1Card({ assignee: { id: "person" } }), b1RepairInput(), /assigned to someone other than the configured owner/],
    ["delegated", b1Card({ delegate: { id: "agent" } }), b1RepairInput(), /delegated/],
    ["incomplete read", b1Card(), b1RepairInput({ pulls: { complete: false, items: [] } }), /could not be read completely/],
    ["other PR", b1Card(), b1RepairInput({ pulls: { complete: true, items: [b1PrepPull({ number: 300 })] } }), /not repair_pr #293/],
    ["moved head", b1Card(), b1RepairInput({ pulls: { complete: true, items: [b1PrepPull({ head: { ...b1PrepPull().head, sha: "b".repeat(40) } })] } }), /not the bound head/],
    ["Done", b1Card({ state: { id: "d", name: "Done", type: "completed" } }), b1RepairInput(), /not one of Todo, In Progress/],
  ]) {
    const decision = cardAction(card, input);
    assert.equal(decision.action, "refuse", label);
    assert.equal(decision.code, "CARD_RUN_REPAIR_INELIGIBLE", label);
    assert.match(decision.detail, why, label);
  }
  const labels = cardAction(b1Card({ labels: { nodes: [] } }), b1RepairInput());
  assert.equal(labels.code, "CARD_RUN_CARD_LABELS", "the repo label rule still applies");
  // Without a repair, today's rule is unchanged: the owned card refuses.
  assert.equal(cardAction(b1Card()).code, "CARD_RUN_CARD_OWNED");
  assert.equal(cardAction(b1Card({ state: { id: "b", name: "Backlog", type: "backlog" }, assignee: null })).action, "move-to-todo");
});

test("Self-repair B1: C2 prepareRun with a repair reads every PR page, leaves branch and card alone", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ?? null });
    if (url === "https://api.linear.app/graphql") return { ok: true, status: 200, json: async () => ({ data: { issue: b1Card() } }) };
    if (url.startsWith(`https://api.github.com/repos/${B1_PREP_REPO}/pulls?`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, title: "other", head: { ref: `feature/${i}` } })) : [b1PrepPull()];
      return { ok: true, status: 200, json: async () => items };
    }
    throw new Error(`unexpected request ${url}`);
  };
  const io = { fetch: fetchImpl, exec: () => assert.fail("a repair runs no git and no command") };
  const credentials = { GITHUB_TOKEN: "gh", LINEAR_API_TOKEN: "lin" };
  const prepared = await prepareRun({ io, plan: { id: "SHU-327", branch: "coordinator/SHU-327" }, revision: "f".repeat(40),
    repo: B1_PREP_REPO, checkout: "/srv/shu/checkout", credentials, repair: { repair_pr: 293, initial_target_sha: B1_HEAD, owners: [B1_OWNER] } });
  assert.deepEqual(prepared, { branch: null, card: { card: "SHU-327", state: "In Progress", action: "none" } });
  assert.equal(calls.some((c) => String(c.body).includes(CARD_TODO_MUTATION.trim().slice(0, 30))), false, "the card is never moved");
  assert.equal(calls.filter((c) => c.url.includes("/pulls?")).length, 4, "both reads walk every page");

  const short = async (url, init) => url.includes("/pulls?") ? { ok: false, status: 502, json: async () => null } : fetchImpl(url, init);
  await assert.rejects(prepareRun({ io: { ...io, fetch: short }, plan: { id: "SHU-327", branch: "coordinator/SHU-327" }, revision: "f".repeat(40),
    repo: B1_PREP_REPO, checkout: "/srv/shu/checkout", credentials, repair: { repair_pr: 293, initial_target_sha: B1_HEAD, owners: [B1_OWNER] } }),
  (error) => error.code === "CARD_RUN_REPAIR_INELIGIBLE" && /could not be read completely/.test(error.message));
});

// Self-repair B2: the runner's half of one landing repair. A queue whose first
// card passed and stopped on red checks (PR_OPENED_CI_RED) at FAILED; with
// landing_repair on, the next start reads the failing checks' evidence,
// records its one round, arms the repair (B1 keys), and the coordinator's
// re-review passes PASSED, which the repair lands on the very same pull
// request.
const FAILED = "4".repeat(40);
const B2_REPAIR_ID = `shu-301-repair-${REV}`;
const B2_API = `https://api.github.com/repos/${REPO}`;
const B2_CONFIG_FILE = `${PATHS.checkout}/.github/coordinator/config.json`;
const B2_LOG = [
  "2026-10-09T16:10:00.1000000Z \u001b[36m> @studenthub/db test\u001b[39m",
  "2026-10-09T16:10:01.1000000Z \u001b[31m✖ organization writes refuse a deleted organization (12.5ms)\u001b[39m",
  "2026-10-09T16:10:01.2000000Z   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "2026-10-09T16:10:01.3000000Z       at TestContext.<anonymous> (/home/runner/work/studenthub-platform/studenthub-platform/packages/db/test/org.test.mjs:41:12)",
  "2026-10-09T16:10:01.4000000Z       at async Test.run (node:internal/test_runner/test:935:25)",
  "2026-10-09T16:10:01.5000000Z       at helper (/home/runner/work/studenthub-platform/studenthub-platform/node_modules/pg/lib/client.js:1:1)",
  "2026-10-09T16:10:01.6000000Z   expected: 'refused'",
  "2026-10-09T16:10:01.7000000Z   actual: 'written'",
  "2026-10-09T16:10:01.8000000Z Error: connect failed for postgres://app:hunter2@localhost:5432/db",
  "2026-10-09T16:10:01.9000000Z not ok 3 - organization writes refuse a deleted organization",
  "2026-10-09T16:10:02.0000000Z ##[error]Process completed with exit code 1.",
].join("\n");
const B2_KEPT = [
  "check run 9001:",
  "✖ organization writes refuse a deleted organization (12.5ms)",
  "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "at TestContext.<anonymous> (packages/db/test/org.test.mjs:41:12)",
  "expected: 'refused'",
  "actual: 'written'",
  "not ok 3 - organization writes refuse a deleted organization",
  "##[error]Process completed with exit code 1.",
].join("\n");

function b2Receipt({ worker, target, attempt, episode, verdict, result = null, at }) {
  const made = createReceipt({ issue_id: "SHU-301", authorization_ref: "SHU-301", repo: REPO, branch: "coordinator/SHU-301", episode_id: episode,
    requested_worker: worker, target_sha: target, attempt_id: attempt });
  assert.ok(made.ok, JSON.stringify(made.errors));
  const receipt = { ...made.receipt, stage: "COMPLETED", verdict_stage: verdict, result_sha: result, external_run_id: `${worker.startsWith("codex") ? "codexrun" : "clauderun"}_${attempt.slice(-4)}`,
    worker_identity: worker.startsWith("codex") ? "codex-author" : "claude-reviewer", adapter_status: "completed",
    evidence_links: ["https://example.test/evidence"], last_activity: at, timestamps: { ...made.receipt.timestamps, launch: at, terminal: at } };
  assert.equal(validateReceipt(receipt).valid, true, JSON.stringify(validateReceipt(receipt).errors));
  return receipt;
}
const b2Original = () => [
  b2Receipt({ worker: "codex-builder", target: REV, attempt: "00000000-0000-4000-8000-000000000401", episode: EPISODE, verdict: "BUILD_READY", result: FAILED, at: "2026-10-09T16:01:00.000Z" }),
  b2Receipt({ worker: "claude-verifier", target: FAILED, attempt: "00000000-0000-4000-8000-000000000402", episode: EPISODE, verdict: "PASS", at: "2026-10-09T16:02:00.000Z" }),
];
const b2Repaired = () => [
  b2Receipt({ worker: "codex-builder", target: FAILED, attempt: "00000000-0000-4000-8000-000000000403", episode: B2_REPAIR_ID, verdict: "BUILD_READY", result: PASSED, at: "2026-10-10T08:01:00.000Z" }),
  b2Receipt({ worker: "claude-verifier", target: PASSED, attempt: "00000000-0000-4000-8000-000000000404", episode: B2_REPAIR_ID, verdict: "PASS", at: "2026-10-10T08:02:00.000Z" }),
];
const b2Claim = (fields = {}) => ({ card: "SHU-301", revision: REV, claimed_at: "2026-10-09T15:30:07.000Z", activation_id: EPISODE, outcome: "PASS", ok: true,
  land: "PR_OPENED_CI_RED", repo: REPO, pr: 77, reviewed_head: FAILED, reverted: true, ...fields });
const b2Round = (host) => host.files.has(b2RoundFile()) ? JSON.parse(host.files.get(b2RoundFile()).text) : null;
const b2RoundFile = () => repairRecordPath(LAND_PATHS, REV, "SHU-301");
const b2Ticks = (h) => {
  if (h.ticks === 1) {
    // The repair's one revise pushes PASSED, and its re-review passes it.
    h.land.pr.head = PASSED;
    for (const receipt of b2Repaired()) h.b2.comment(receiptCommentBody(receipt));
    return tickText(armed(B2_REPAIR_ID));
  }
  if (h.ticks === 2) return tickText(spent("SHU-301", "review PASS — the episode is complete"));
  return tickText("activation=absent (committed gates only)");
};
const b2Chunks = (text, size) => { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
// The repair's own reads: check runs, jobs and logs (Self-repair A's read of
// #77 and main's history is a hand-landing check, not the repair's).
const b2EvidenceReads = (host) => host.b2.gets.filter((get) => get.includes("/check-runs") || get.includes("/actions/"));
const b2Respond = (status, json) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => structuredClone(json) });

// options: on (landing_repair: true, false or undefined for absent), runs,
// jobs (id -> job or status), logs (id -> text), logStatus, chunk (log chunk
// size), compare, contents ({ "path@ref": text }), pullEdit (coordinator view
// of #77), staleRuns (the landing's check runs name another head),
// movePullAt (the land-token read of #77 from which its head is MOVED), plus
// any landingHost option.
function b2Host(options = {}) {
  const host = landingHost({ existingPr: true, prHead: FAILED, onTick: options.onTick ?? b2Ticks, ...options });
  // `on` undefined means the key is absent, whatever the committed config says.
  const { landing_repair: _committed, ...base } = queueConfig();
  const config = { ...base, ...(options.on === undefined ? {} : { landing_repair: options.on }) };
  host.files.set(B2_CONFIG_FILE, { text: JSON.stringify(config), mode: 0o644, uid: 0, gid: 0 });
  // Linear's GitHub integration moved and assigned the card when #77 opened.
  host.card = { state: { id: "ip", name: "In Progress", type: "started" }, assignee: { id: ACTOR }, delegate: null };
  host.files.set(autoClaim(LAND_PATHS, REV, "SHU-301"), { text: `${JSON.stringify(b2Claim(options.claim))}\n`, mode: 0o600, uid: 0, gid: 0 });
  // Earlier than any comment the landing writes, so the order stays the real one.
  let clock = Date.parse("2026-10-09T16:30:00.000Z");
  host.land.comments = [];
  const b2 = { gets: [], landGets: [], pullReads: 0, comment: (body) => {
    clock += 1000;
    host.land.comments.push({ body, createdAt: new Date(clock).toISOString(), user: { id: ACTOR, displayName: "Coordinator" } });
  } };
  host.b2 = b2;
  for (const receipt of b2Original()) b2.comment(receiptCommentBody(receipt));
  const runs = options.runs ?? [
    { id: 9001, name: "test", status: "completed", conclusion: "failure", head_sha: FAILED, app: { slug: "github-actions" } },
    { id: 9002, name: "lint", status: "completed", conclusion: "success", head_sha: FAILED, app: { slug: "github-actions" } },
    { id: 9003, name: "sentry", status: "completed", conclusion: "failure", head_sha: FAILED, app: { slug: "sentry" } },
  ];
  const logs = options.logs ?? { 9001: B2_LOG };
  const pullNow = () => ({ number: 77, state: "open", merged: false, title: "[SHU-301] Make the thing",
    head: { ref: "coordinator/SHU-301", sha: host.land.pr.head, repo: { full_name: REPO } },
    base: { ref: "main", sha: REV, repo: { full_name: REPO } }, ...(options.pullEdit ?? {}) });
  const delegate = host.io.fetch;
  host.io.fetch = async (url, request = {}) => {
    const auth = request.headers?.Authorization;
    if (auth === "Bearer gh-secret-value" && String(url).startsWith(B2_API)) {
      const route = String(url).slice(B2_API.length);
      b2.gets.push(`${request.method ?? "GET"} ${route}`);
      assert.equal(request.method ?? "GET", "GET", "the repair only reads GitHub with the coordinator's token");
      if (route === "/pulls/77") return b2Respond(200, pullNow());
      if (route === "/pulls?state=open&per_page=100&page=1") return b2Respond(200, [pullNow()]);
      if (route === `/commits/${FAILED}/check-runs?filter=latest&per_page=100`) return b2Respond(200, { total_count: runs.length, check_runs: runs });
      const job = /^\/actions\/jobs\/(\d+)$/.exec(route);
      if (job) {
        const given = options.jobs?.[job[1]];
        if (typeof given === "number") return b2Respond(given, { message: "Resource not accessible by integration" });
        return b2Respond(200, given ?? { id: Number(job[1]), head_sha: FAILED, conclusion: "failure" });
      }
      const log = /^\/actions\/jobs\/(\d+)\/logs$/.exec(route);
      if (log) {
        if (options.logStatus) return { status: options.logStatus, ok: false, body: null, json: async () => null };
        const chunks = b2Chunks(logs[log[1]] ?? "", options.chunk ?? 7).map((part) => new TextEncoder().encode(part));
        return { status: 200, ok: true, body: (async function* () { yield* chunks; })(), json: async () => null };
      }
      return b2Respond(404, { message: "Not Found" });
    }
    if (auth === "Bearer land-secret-value" && String(url).startsWith(B2_API)) {
      const route = String(url).slice(B2_API.length);
      b2.landGets.push(`${request.method ?? "GET"} ${route}`);
      if (route === `/compare/${FAILED}...${PASSED}?per_page=100`) {
        return b2Respond(200, options.compare ?? { status: "ahead", behind_by: 0, merge_base_commit: { sha: FAILED },
          files: [{ filename: "packages/db/src/org.ts", status: "modified", patch: "@@ -1,2 +1,2 @@\n-  return write(org);\n+  return org.deleted ? refuse() : write(org);\n context" }] });
      }
      const contents = /^\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(route);
      if (contents) {
        const text = options.contents?.[`${decodeURIComponent(contents[1])}@${contents[2]}`];
        return text === undefined ? b2Respond(404, { message: "Not Found" }) : b2Respond(200, { encoding: "base64", content: Buffer.from(text).toString("base64") });
      }
      if (route === "/pulls/77" && (request.method ?? "GET") === "GET") {
        b2.pullReads += 1;
        if (options.movePullAt !== undefined && b2.pullReads >= options.movePullAt) host.land.pr.head = "9".repeat(40);
      }
      if (route === `/commits/${PASSED}/check-runs?filter=latest&per_page=100`) {
        const answer = await delegate(url, request);
        const body = await answer.json();
        body.check_runs = body.check_runs.map((run) => ({ ...run, head_sha: options.staleRuns ? FAILED : PASSED }));
        return b2Respond(answer.status, body);
      }
    }
    return delegate(url, request);
  };
  return host;
}

test("Self-repair B2: E1 evidence keeps only test-failure lines, cleaned of ANSI codes and timestamps", () => {
  assert.equal(evidenceLine("2026-10-09T16:10:01.1000000Z \u001b[31m✖ a failing case\u001b[39m"), "✖ a failing case");
  assert.equal(evidenceLine("  not ok 3 - a failing case"), "not ok 3 - a failing case");
  assert.equal(evidenceLine("AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"), "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:");
  assert.equal(evidenceLine("TypeError: cannot read properties of undefined"), "TypeError: cannot read properties of undefined");
  assert.equal(evidenceLine("    expected: 3"), "expected: 3");
  assert.equal(evidenceLine("    actual: 4"), "actual: 4");
  assert.equal(evidenceLine("at f (/home/runner/work/studenthub-platform/studenthub-platform/apps/web/src/a.ts:3:9)"), "at f (apps/web/src/a.ts:3:9)");
  assert.equal(evidenceLine("at packages/db/test/org.test.mjs:41:12"), "at packages/db/test/org.test.mjs:41:12");
  for (const line of ["at async Test.run (node:internal/test_runner/test:935:25)", "at x (/home/runner/work/a/a/node_modules/pg/lib/client.js:1:1)",
    "at x (/usr/lib/node/x.js:1:1)", "at x (../../outside.js:1:1)", "> @studenthub/db test", "Run npm ci", "added 1200 packages in 30s",
    "console.log: hello", "ok 2 - a passing case", "", "   "]) {
    assert.equal(evidenceLine(line), null, line);
  }
});

test("Self-repair B2: E2 a kept line carrying anything secret-shaped is dropped whole", () => {
  for (const line of [
    "AssertionError: TOKEN=abcdef123456",
    "Error: password is wrong",
    "Error: missing API key",
    "Error: Bearer abc",
    "Error: Authorization header refused",
    "Error: \"SHU_SUPERVISOR_SECRET\": \"s3cr3t-value\"",
    "Error: value is \\\"x\\\"=\\\"y\\\"",
    "Error: DATABASE_URL=postgres://localhost/db",
    "Error: a\\x3db",
    "Error: a\\u003db",
    "Error: a%3Db",
    "Error: a&#61;b",
    "Error: connect https://user:pw@example.com/x",
    "Error: connect https://deploy@example.com/x",
    "Error: connect //user:pw@example.com",
    `Error: unexpected ${"a".repeat(40)}`,
    "Error: blob QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=",
    "Error: ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Error: lin_api_abcdefghijklmnopqrstuvwxyz",
    "expected: 'sk-ant-abcdefghijklmnopqrstuvwxyz'",
  ]) {
    assert.equal(evidenceLine(line), null, line);
    assert.equal(secretIndicator(line), true, line);
  }
  // Comparisons and arrows are not assignments.
  assert.equal(evidenceLine("AssertionError: 1 !== 2"), "AssertionError: 1 !== 2");
  assert.equal(evidenceLine("Error: a => b and a >= b"), "Error: a => b and a >= b");
});

test("Self-repair B2: E3 log lines are assembled across chunks before they are judged, and only a rolling tail is kept", async () => {
  const secret = "AssertionError: leaked ghp_abcdefghijklmnopqrstuvwxyz0123 here";
  const text = `not ok 1 - before\n${secret}\nnot ok 2 - after\n`;
  for (const size of [1, 3, 7, 16]) {
    const io = { fetch: async () => ({ status: 200, body: (async function* () { yield* b2Chunks(text, size).map((c) => new TextEncoder().encode(c)); })() }) };
    const read = await readLogTail(io, "https://api.github.com/x/logs", "t");
    assert.deepEqual(read.lines.map(evidenceLine).filter(Boolean), ["not ok 1 - before", "not ok 2 - after"], `chunk ${size}`);
    // No fragment of the split secret survives on its own either.
    assert.ok(read.lines.every((line) => !line.includes("ghp_") || line === secret), `chunk ${size}`);
  }
  // A multi-byte character split across chunks decodes whole.
  const bytes = new TextEncoder().encode("✖ broken\n");
  const split = { fetch: async () => ({ status: 200, body: (async function* () { yield bytes.slice(0, 1); yield bytes.slice(1); })() }) };
  assert.deepEqual((await readLogTail(split, "u", "t")).lines, ["✖ broken"]);
  // The tail rolls: only the last bytes of whole lines are held, and a line
  // longer than the tail is dropped up to its end.
  const tail = createLineTail(24);
  tail.push("first line\nsecond line\nthird ");
  tail.push("line\n");
  assert.deepEqual(tail.end(), ["second line", "third line"]);
  const long = createLineTail(12);
  long.push("short\n0123456789abcdef");
  long.push("ghijk\nafter\n");
  assert.deepEqual(long.end(), ["short", "after"]);
  assert.equal(REPAIR_LIMITS.logTailBytes, 2 * 1024 * 1024);
});

test("Self-repair B2: E4 evidence is capped at 4000 characters with the truncation marked", () => {
  assert.equal(REPAIR_LIMITS.evidenceChars, 4000);
  const lines = Array.from({ length: 200 }, (_, i) => `not ok ${i} - a failing case number ${i}`);
  const { text, truncated } = evidenceText([{ id: 9001, lines }]);
  assert.equal(truncated, true);
  assert.ok(text.length <= 4000, String(text.length));
  assert.match(text, /\n\[evidence truncated: \d+ characters cut to 4000\]$/);
  assert.ok(text.startsWith("check run 9001:\nnot ok 0 - "), "the first failures are kept");
  assert.ok(text.split("\n").slice(0, -1).every((line) => line === "check run 9001:" || lines.includes(line)), "whole lines only");
  const short = evidenceText([{ id: 9001, lines: lines.slice(0, 2) }]);
  assert.deepEqual(short, { text: `check run 9001:\n${lines[0]}\n${lines[1]}`, truncated: false });
});

test("Self-repair B2: E5 evidence binds failing Actions runs of the failed head by id and head_sha; a stale run never counts", async () => {
  const read = (host) => readRepairEvidence({ io: host.io, token: "gh-secret-value", repo: REPO, head: FAILED });
  const fresh = await read(b2Host({ on: true }));
  assert.deepEqual(fresh.check_runs, [{ id: 9001, head_sha: FAILED }], "the green run and the outside app's run are not evidence");
  assert.equal(fresh.findings.summary, B2_KEPT);
  assert.deepEqual(fresh.findings, { verdict_stage: "BLOCKED", source: "ci", target_sha: FAILED, summary: B2_KEPT, links: [`check-run/9001@${FAILED}`] });
  assert.equal(fresh.digest, repairEvidenceDigest(fresh.findings));
  assert.doesNotMatch(JSON.stringify(fresh), /hunter2|postgres:|node_modules|node:internal|2026-10-09T|\u001b/);
  // A failing run listed for another head, or a job that reads back at
  // another head or as another run, is stale and never evidence.
  const staleRun = b2Host({ on: true, runs: [{ id: 9001, status: "completed", conclusion: "failure", head_sha: PASSED, app: { slug: "github-actions" } }] });
  await assert.rejects(read(staleRun), { code: "REPAIR_NO_EVIDENCE" });
  assert.ok(!staleRun.b2.gets.some((get) => get.includes("/actions/jobs/")), "a stale run's job is never read");
  await assert.rejects(read(b2Host({ on: true, jobs: { 9001: { id: 9001, head_sha: PASSED } } })), { code: "REPAIR_NO_EVIDENCE" });
  await assert.rejects(read(b2Host({ on: true, jobs: { 9001: { id: 9009, head_sha: FAILED } } })), { code: "REPAIR_NO_EVIDENCE" });
  const greenOnly = b2Host({ on: true, runs: [{ id: 9002, status: "completed", conclusion: "success", head_sha: FAILED, app: { slug: "github-actions" } }] });
  await assert.rejects(read(greenOnly), { code: "REPAIR_NO_EVIDENCE" });
  // Every read is a GET with the coordinator's token.
  assert.ok(staleRun.b2.gets.every((get) => get.startsWith("GET ")));
});

test("Self-repair B2: E6 no Actions read permission, an unreadable log, or nothing surviving the filter is a named skip", async () => {
  const read = (host) => readRepairEvidence({ io: host.io, token: "gh-secret-value", repo: REPO, head: FAILED });
  await assert.rejects(read(b2Host({ on: true, jobs: { 9001: 403 } })), (error) => error.code === "REPAIR_NO_ACTIONS_READ" && /Actions: read/.test(error.message));
  await assert.rejects(read(b2Host({ on: true, logStatus: 403 })), { code: "REPAIR_NO_ACTIONS_READ" });
  await assert.rejects(read(b2Host({ on: true, logStatus: 410 })), { code: "REPAIR_UNREADABLE" });
  await assert.rejects(read(b2Host({ on: true, logs: { 9001: "Run npm test\nPASSWORD=hunter2 not ok\nok 1 - fine\n" } })), { code: "REPAIR_NO_EVIDENCE" });
  await assert.rejects(readRepairEvidence({ io: b2Host({ on: true }).io, token: null, repo: REPO, head: FAILED }), { code: "REPAIR_UNREADABLE" });
  for (const code of ["REPAIR_NO_EVIDENCE", "REPAIR_NO_ACTIONS_READ", "REPAIR_UNREADABLE"]) assert.ok(REPAIR_SKIPS.has(code), code);
});

test("Self-repair B2: G1 the weakening guard refuses every skipped, focused, removed or loosened test and any change to how tests run", async () => {
  // A file reads at each head as its patch's two sides, unless the case gives it whole.
  const side = (files, name, ref) => {
    const lines = files.find((file) => file?.filename === name)?.patch?.split("\n").filter((line) => !line.startsWith("@@"));
    const keep = ref === FAILED ? "-" : "+";
    return lines ? lines.filter((line) => line.startsWith(" ") || line.startsWith(keep)).map((line) => line.slice(1)).join("\n") : null;
  };
  const judge = (files, extra = {}) => testWeakening({ compare: { status: "ahead", behind_by: 0, merge_base_commit: { sha: FAILED }, files, ...extra },
    base: FAILED, head: PASSED, readFile: async (file, ref) => (extra.contents && `${file}@${ref}` in extra.contents ? extra.contents[`${file}@${ref}`] : side(files, file, ref)) ?? null });
  const patch = (...lines) => `@@ -1,3 +1,3 @@\n${lines.join("\n")}`;
  const ok = await judge([{ filename: "packages/db/src/org.ts", status: "modified", patch: patch("-a", "+b", " c") },
    { filename: "packages/db/test/org.test.mjs", status: "modified", patch: patch("-  assert.equal(x, 1);", "+  assert.equal(x, 2);") }]);
  assert.deepEqual(ok, { ok: true }, "fixing code and an assertion is fine");
  // An assertion may be changed or moved, never dropped: deleting the one the
  // failing output names is the smallest change that turns CI green.
  for (const [label, lines] of [
    ["dropped", ["-  assert.equal(result, \"refused\");", " b"]],
    ["dropped expect", ["-  expect(x).toBe(1);", " b"]],
    ["dropped t.equal", ["-  t.equal(a, b);", " b"]],
    ["dropped should call", ["-  foo.should.equal(1);", " b"]],
    ["dropped should property", ["-  result.should.be.true;", " b"]],
    ["dropped should.exist", ["-  should.exist(row);", " b"]],
    ["should chain swapped for a plain read", ["-  rows.should.have.length(2);", "+  rows.length;"]],
    ["moved into an inline comment", ["-  assert.equal(result, \"refused\");", "+  console.log(result); // assert.equal(result, \"refused\");"]],
    ["moved into a block comment", ["-  assert.ok(row);", "+  void row; /* assert.ok(row); */"]],
    ["moved into a string", ["-  assert.equal(result, 1);", "+  console.log(\"assert.equal(result, 1)\", 'expect(x)', `should.exist(y)`);"]],
    ["moved into a multi-line comment", ["-  assert.ok(x);", "+  void x; /*", "+  assert.ok(x);", "+  */"]],
    ["commented out by added lines only", ["+  /*", "   assert.ok(x);", "+  */"]],
    ["moved into a multi-line template", ["-  assert.ok(x);", "+  console.log(`", "+  assert.ok(x);", "+  `);"]],
    ["moved into a regex literal", ["-  assert.ok(x);", "+  const r = /assert.ok(x)/;"]],
    ["moved into a regex after return", ["-  assert.ok(x);", "+  return /assert.ok(x)/.test(\"assert.ok(x)\");"]],
    ["moved into a regex with a backtick after return", ["-  assert.ok(x);", "+  return /`/.test(s) && x;", "+  // assert.ok(x);"]],
    ["moved into a regex after an if condition", ["-  assert.ok(result);", "+  if (enabled) /assert.ok(result)/.test(source);"]],
    ["moved into a regex after a nested while condition", ["-  assert.ok(result);", "+  while (f(a, (b))) /assert.ok(result)/.test(source);"]],
    ["moved into a regex after a closed block", ["-  assert.ok(result);", "+  { x(); } /assert.ok(result)/.test(source);"]],
    ["two dropped, one added", ["-  assert.ok(a); assert.ok(b);", "+  assert.ok(a);"]],
    ["commented out", ["-  assert.deepEqual(a, b);", "+  // assert . deepEqual(a, b) was here"]],
  ]) {
    const verdict = await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified", patch: patch(...lines) }]);
    assert.equal(verdict.ok, false, label);
    assert.match(verdict.reason, /removes an assertion/, label);
  }
  assert.deepEqual(await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified",
    patch: patch("-  assert.equal(x, 1);", "+  assert.strictEqual(x, 1);", "+  assert.ok(y);") }]), { ok: true }, "more assertions is fine");
  assert.deepEqual(await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified",
    patch: patch("-  foo.should.equal(1);", "+  foo.should.deep.equal(2);") }]), { ok: true }, "a should chain may change");
  assert.deepEqual(await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified",
    patch: patch("-  assert.equal(a, \"x // y\");", "+  assert.equal(a, \"x // z\"); // was y") }]), { ok: true },
    "a string holding // and a trailing comment keep the assertion counted");
  assert.deepEqual(await judge([{ filename: "packages/db/src/org.ts", status: "modified", patch: patch("-  assert(x);", " b") }]), { ok: true },
    "source files may drop their own runtime asserts");
  assert.deepEqual(await judge([{ filename: "packages/db/test/new.test.mjs", status: "added", patch: patch("+  assert.ok(x);") }]), { ok: true },
    "a new test file has nothing to lose");
  assert.deepEqual(await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified",
    patch: patch(" const half = n / 2; const r = /[/]x/;", "-  assert.equal(half, 1);", "+  assert.equal(half, 2);") }]), { ok: true },
    "a division and a regex with a slash in a class still leave the assertion counted");
  assert.deepEqual(await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified",
    patch: patch(" const half = x.return / 2 / 1;", "-  assert.equal(half, 1);", "+  assert.equal(half, 2);") }]), { ok: true },
    "a division after a property named return stays a division");
  assert.deepEqual(await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified",
    patch: patch(" const avg = sum(a) / count(a) / 2; if (f(x) / 2) y();", "-  assert.equal(avg, 1);", "+  assert.equal(avg, 2);") }]), { ok: true },
    "a division after a call's `)`, even inside an if condition, stays a division");
  const unreadable = await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified", patch: patch("-  assert.equal(x, 1);", "+  assert.equal(x, 2);") }],
    { contents: { [`packages/db/test/org.test.mjs@${FAILED}`]: null } });
  assert.equal(unreadable.ok, false, "a test file that cannot be read whole refuses");
  assert.match(unreadable.reason, /cannot be read at both heads/);
  assert.equal(ADDED_WEAKENING_LINES.length, 13, "every refused form is still exercised");
  for (const line of ADDED_WEAKENING_LINES) {
    for (const filename of ["packages/db/test/org.test.mjs", "packages/db/src/helpers.ts"]) {
      const verdict = await judge([{ filename, status: "modified", patch: patch(" a", `+${line}`) }]);
      assert.equal(verdict.ok, false, `${filename}: ${line}`);
      assert.match(verdict.reason, /adds a skipped, focused or postponed test/);
    }
  }
  for (const line of ["test('x', () => {", "  it ('y', async () => {", "describe(\"z\", () => {", "test . each([1])('x', () => {"]) {
    const verdict = await judge([{ filename: "packages/db/test/org.test.mjs", status: "modified", patch: patch(`-${line}`, " b") }]);
    assert.deepEqual(verdict.ok, false, line);
    assert.match(verdict.reason, /removes a line that declares a test case/);
  }
  for (const [label, file, why] of [
    ["deleted", { filename: "packages/db/test/org.test.mjs", status: "removed" }, /was deleted/],
    ["renamed", { filename: "packages/db/test/org2.test.mjs", previous_filename: "packages/db/test/org.test.mjs", status: "renamed", patch: "" }, /renamed or moved/],
    ["moved out", { filename: "packages/db/src/org.mjs", previous_filename: "packages/db/test/org.mjs", status: "renamed", patch: "" }, /renamed or moved/],
    ["vitest config", { filename: "vitest.config.ts", status: "modified", patch: patch("-a", "+b") }, /decides which tests run/],
    ["runner rc", { filename: "packages/db/.mocharc.json", status: "modified", patch: patch("-a", "+b") }, /decides which tests run/],
    ["ignore file", { filename: ".gitignore", status: "modified", patch: patch("+x") }, /decides which tests run/],
    ["tsconfig exclude", { filename: "packages/db/tsconfig.json", status: "modified", patch: patch("+x") }, /decides which tests run/],
    ["workflow", { filename: ".github/workflows/ci.yml", status: "modified", patch: patch("+x") }, /decides which tests run/],
    ["binary or huge", { filename: "packages/db/src/org.ts", status: "modified" }, /no readable diff/],
    ["not a diff", { filename: "packages/db/src/org.ts", status: "modified", patch: "garbage line" }, /no readable diff/],
    ["unknown status", { filename: "packages/db/src/org.ts", status: "copied", patch: patch("+x") }, /cannot read/],
    ["no name", { status: "modified", patch: patch("+x") }, /has no name/],
  ]) {
    const verdict = await judge([file]);
    assert.equal(verdict.ok, false, label);
    assert.match(verdict.reason, why, label);
  }
  // package.json: its test scripts and runner keys must read the same at both heads.
  const pkg = (scripts, extra = {}) => JSON.stringify({ name: "x", scripts, ...extra });
  const pkgFile = { filename: "packages/db/package.json", status: "modified", patch: patch("-a", "+b") };
  const pkgJudge = (before, after) => judge([pkgFile], { contents: { [`packages/db/package.json@${FAILED}`]: before, [`packages/db/package.json@${PASSED}`]: after } });
  assert.deepEqual(await pkgJudge(pkg({ test: "node --test", build: "tsc" }), pkg({ test: "node --test", build: "tsc -b" })), { ok: true });
  for (const [label, before, after] of [
    ["test script", pkg({ test: "node --test" }), pkg({ test: "node --test --test-skip-pattern=org" })],
    ["test:db script", pkg({ "test:db": "a" }), pkg({ "test:db": "true" })],
    ["pretest added", pkg({ test: "a" }), pkg({ test: "a", pretest: "b" })],
    ["jest key", pkg({ test: "jest" }, { jest: { testPathIgnorePatterns: [] } }), pkg({ test: "jest" }, { jest: { testPathIgnorePatterns: ["org"] } })],
    ["unreadable", "{", pkg({ test: "a" })],
    ["missing", null, pkg({ test: "a" })],
  ]) {
    const verdict = await pkgJudge(before ?? undefined, after);
    assert.equal(verdict.ok, false, label);
  }
  // A head that does not build on the failed head, or a compare that cannot be read whole.
  assert.equal((await judge([], { status: "diverged" })).ok, false);
  assert.equal((await judge([], { behind_by: 1 })).ok, false);
  assert.equal((await judge([], { merge_base_commit: { sha: REV } })).ok, false);
  assert.equal((await judge(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: "modified", patch: patch("+x") })))).ok, false);
  assert.equal((await testWeakening({ compare: null, base: FAILED, head: PASSED, readFile: async () => null })).ok, false);
  assert.equal(isTestPath("packages/db/test/helpers.mjs"), true);
  assert.equal(isTestPath("apps/web/src/org.spec.tsx"), true);
  assert.equal(isTestPath("apps/web/src/org.ts"), false);
  assert.equal(isTestConfigPath("apps/web/playwright.config.ts"), true);
  assert.equal(isTestConfigPath("apps/web/src/config.ts"), false);
});

test("Self-repair B2: O1 with landing_repair absent or false a passed run stopped on red checks stops the queue exactly as before", async () => {
  const expected = `SHU-301 ran at ${REV} and did not land (PASS, landing PR_OPENED_CI_RED): ${autoClaim(LAND_PATHS, REV, "SHU-301")}`;
  const proven = `${expected}; hand landing not proven: #77 is not merged`;
  const outputs = [];
  for (const on of [undefined, false, "true", 1]) {
    const host = b2Host({ on });
    const config = JSON.parse(host.files.get(B2_CONFIG_FILE).text);
    assert.deepEqual(await nextCard(host.io, LAND_PATHS, config, REV), { id: null, skipped: "QUEUE_STOPPED", reason: expected }, String(on));
    const result = await autoRun({ io: host.io, paths: LAND_PATHS });
    assert.deepEqual(result, { ok: true, trigger: "timer", skipped: "QUEUE_STOPPED", reason: proven }, String(on));
    outputs.push(JSON.stringify(result));
    assert.equal(host.ticks, 0, "nothing is armed");
    assert.equal(b2EvidenceReads(host).length, 0, "no check run, job or log is read");
    assert.equal(host.files.has(b2RoundFile()), false, "no round record");
    assert.equal(host.reports.length, 0);
  }
  assert.equal(new Set(outputs).size, 1, "absent and false give the same bytes");
  // The committed configuration turns it on (the switch-on config change after B2); only exactly true counts.
  assert.equal(COMMITTED.landing_repair, true);
});

test("Self-repair B2: O2 the committed value itself takes the repair path on a passed run stopped on red checks", async () => {
  const host = b2Host({ on: COMMITTED.landing_repair });
  const config = JSON.parse(host.files.get(B2_CONFIG_FILE).text);
  assert.deepEqual(await nextCard(host.io, LAND_PATHS, config, REV), { id: "SHU-301", repair: b2Claim() });
});

test("Self-repair B2: R1 the next start repairs the red pull request once, re-lands that exact pull request at the repaired head, and the queue moves on", async () => {
  const host = b2Host({ on: true });
  const config = JSON.parse(host.files.get(B2_CONFIG_FILE).text);
  const next = await nextCard(host.io, LAND_PATHS, config, REV);
  assert.deepEqual(next, { id: "SHU-301", repair: b2Claim() });
  let armedRecord = null;
  let roundAtArm = null;
  const write = host.fs.writeFileSync;
  host.fs.writeFileSync = (file, text, options = {}) => {
    if (String(file).startsWith(`${LAND_PATHS.activation}.card-run-`)) { armedRecord = JSON.parse(text); roundAtArm = b2Round(host); }
    return write(file, text, options);
  };
  const result = await autoRun({ io: host.io, paths: LAND_PATHS });
  assert.equal(result.outcome, "PASS", JSON.stringify(result));
  assert.equal(result.land.outcome, "MERGED", JSON.stringify(result.land));
  assert.equal(result.land.pr, 77);
  assert.equal(result.land.opened, false);
  assert.equal(result.land.reviewed_head, PASSED);
  // The armed record: the card's lanes, a deterministic id, the failed head,
  // and the B1 repair keys bound to the claim and the filtered evidence.
  assert.equal(armedRecord.activation_id, B2_REPAIR_ID);
  assert.equal(armedRecord.initial_target_sha, FAILED);
  assert.equal(armedRecord.repair_pr, 77);
  assert.equal(armedRecord.repair_of, EPISODE);
  assert.equal(armedRecord.max_rounds, 1);
  assert.equal(armedRecord.writer_lane, "codex-builder");
  assert.equal(armedRecord.reviewer_lane, "claude-verifier");
  assert.deepEqual(armedRecord.repair_findings, { verdict_stage: "BLOCKED", source: "ci", target_sha: FAILED, summary: B2_KEPT, links: [`check-run/9001@${FAILED}`] });
  assert.equal(armedRecord.repair_evidence_digest, repairEvidenceDigest(armedRecord.repair_findings));
  assert.equal(validateActivationRecord(armedRecord).ok, true);
  // The round was claimed and marked armed before anything was armed.
  assert.equal(roundAtArm.state, "armed");
  // Its round record is finished with the outcome.
  const round = b2Round(host);
  assert.equal(round.state, "finished");
  assert.equal(round.activation_id, B2_REPAIR_ID);
  assert.equal(round.repair_of, EPISODE);
  assert.equal(round.pr, 77);
  assert.equal(round.reviewed_head, FAILED);
  assert.equal(round.repaired_head, PASSED);
  assert.equal(round.land, "MERGED");
  assert.equal(round.merge_commit, MERGE_SHA);
  assert.deepEqual(round.check_runs, [{ id: 9001, head_sha: FAILED }]);
  assert.equal(host.files.get(b2RoundFile()).mode, 0o600);
  // Exact-PR landing: never found or opened, merged with the expected head.
  assert.equal(host.land.posts, 0, "no pull request was opened");
  assert.ok(!host.land.log.includes("github list"), "the branch's pull requests are never searched to find one");
  assert.equal(host.land.merges, 1);
  assert.ok(host.b2.landGets.includes(`GET /compare/${FAILED}...${PASSED}?per_page=100`), "the weakening guard read the change");
  assert.ok(host.b2.gets.every((get) => get.startsWith("GET ")));
  neverDone(host);
  reverted(host);
  // The report names the repair, and no secret or log noise reaches it.
  assert.match(host.reports[0], new RegExp(`^Landing repair of pull request #77: one revise of ${FAILED} after episode ${EPISODE}, from 1 failing check run\\(s\\)\\.$`, "m"));
  assert.doesNotMatch(JSON.stringify(result) + host.reports.join("\n") + host.files.get(b2RoundFile()).text, /hunter2|land-secret-value|gh-secret-value|lin-secret-value/);
  // The merged repair lands the card: the queue moves on, and never repairs again.
  assert.deepEqual(await cardLanded(host.io, LAND_PATHS, "SHU-301"), { landed: true, by: "repair" });
  assert.deepEqual(await nextCard(host.io, LAND_PATHS, config, REV), { id: "SHU-305" });
});

test("Self-repair B2: R2 each stop before the round record is a named skip that writes nothing and arms nothing", async () => {
  const cases = [
    ["no evidence", { logs: { 9001: "Run npm test\nok 1 - fine\n" } }, "REPAIR_NO_EVIDENCE"],
    ["stale check runs", { runs: [{ id: 9001, status: "completed", conclusion: "failure", head_sha: PASSED, app: { slug: "github-actions" } }] }, "REPAIR_NO_EVIDENCE"],
    ["no Actions read", { jobs: { 9001: 403 } }, "REPAIR_NO_ACTIONS_READ"],
    ["the pull request moved", { pullEdit: { head: { ref: "coordinator/SHU-301", sha: "9".repeat(40), repo: { full_name: REPO } } } }, "REPAIR_NOT_ELIGIBLE"],
    ["the pull request closed", { pullEdit: { state: "closed" } }, "REPAIR_NOT_ELIGIBLE"],
    ["another base", { pullEdit: { base: { ref: "release", sha: REV, repo: { full_name: REPO } } } }, "REPAIR_NOT_ELIGIBLE"],
    ["a claim naming another episode", { claim: { activation_id: "shu-301-run-20261009T000000Z" } }, "REPAIR_NOT_ELIGIBLE"],
    ["a claim naming another head", { claim: { reviewed_head: "8".repeat(40) } }, "REPAIR_NOT_ELIGIBLE"],
  ];
  for (const [label, options, skipped] of cases) {
    const host = b2Host({ on: true, ...options });
    const result = await autoRun({ io: host.io, paths: LAND_PATHS });
    assert.equal(result.skipped, skipped, `${label}: ${JSON.stringify(result)}`);
    assert.equal(host.files.has(b2RoundFile()), false, `${label}: no round record`);
    assert.equal(host.ticks, 0, `${label}: nothing armed`);
    noArming(host);
    assert.equal(host.reports.length, 0, `${label}: a skip posts nothing`);
    assert.equal(host.files.has(LAND_PATHS.lock), false, `${label}: the lock is released`);
  }
  // A claim the repair does not read as repairable (another card's, a legacy
  // claim without its pull request) is never repaired at all.
  for (const claim of [{ pr: null }, { reviewed_head: null }, { repo: "someone/fork" }, { ok: false }, { land: "CI_TIMEOUT" }]) {
    const host = b2Host({ on: true, claim });
    assert.equal((await autoRun({ io: host.io, paths: LAND_PATHS })).skipped, "QUEUE_STOPPED", JSON.stringify(claim));
    assert.equal(b2EvidenceReads(host).length, 0);
  }
  // The pause wins when it appears while the evidence is read.
  const paused = b2Host({ on: true });
  const fetch = paused.io.fetch;
  paused.io.fetch = async (url, request) => {
    if (String(url).endsWith("/logs")) paused.files.set(LAND_PATHS.pause, { text: "", mode: 0o644, uid: 0, gid: 0 });
    return fetch(url, request);
  };
  const result = await autoRun({ io: paused.io, paths: LAND_PATHS });
  assert.equal(result.skipped, "PAUSED", JSON.stringify(result));
  assert.equal(paused.files.has(b2RoundFile()), false);
  noArming(paused);
});

test("Self-repair B2: R3 any round record means no second round, and one that never finished is REPAIR_INTERRUPTED, alerted once", async () => {
  const roundText = (fields) => ({ text: `${JSON.stringify({ card: "SHU-301", revision: REV, activation_id: B2_REPAIR_ID, ...fields })}\n`, mode: 0o600, uid: 0, gid: 0 });
  for (const state of ["claimed", "armed", undefined]) {
    const host = b2Host({ on: true });
    host.files.set(b2RoundFile(), state === undefined ? { text: "{", mode: 0o600, uid: 0, gid: 0 } : roundText({ state }));
    const config = JSON.parse(host.files.get(B2_CONFIG_FILE).text);
    const next = await nextCard(host.io, LAND_PATHS, config, REV);
    assert.equal(next.skipped, "REPAIR_INTERRUPTED", String(state));
    assert.equal(next.id, null);
    const first = await autoRun({ io: host.io, paths: LAND_PATHS });
    assert.equal(first.skipped, "REPAIR_INTERRUPTED", JSON.stringify(first));
    assert.equal(first.needs_owner, true);
    assert.equal(host.ticks, 0, "never re-launched");
    assert.equal(b2EvidenceReads(host).length, 0, "no evidence is read");
    assert.equal(host.reports.length, 1, "the owner hears about it");
    assert.match(host.reports[0], /^Card run on SHU-301 \(card\): REPAIR_INTERRUPTED, /m);
    assert.match(host.reports[0], /^Alert: this run needs the owner/m);
    const status = JSON.parse(host.files.get(statusPath(LAND_PATHS)).text);
    assert.equal(status.step, "finished");
    assert.equal(status.outcome, "REPAIR_INTERRUPTED");
    assert.equal(status.needs_owner, true);
    // Alerted once: later starts skip quietly, and still never re-launch.
    const linearCalls = host.linearCalls;
    const second = await autoRun({ io: host.io, paths: LAND_PATHS });
    assert.equal(second.skipped, "REPAIR_INTERRUPTED");
    assert.equal(second.report, undefined, "no second report is attempted");
    assert.equal(host.linearCalls, linearCalls, "Linear is not asked again");
    assert.equal(host.reports.length, 1);
    assert.equal(host.ticks, 0);
  }
  // A finished round: no second round, the queue stops as before and says why.
  const finished = b2Host({ on: true });
  finished.files.set(b2RoundFile(), roundText({ state: "finished", outcome: "PASS", land: "PR_OPENED_CI_RED" }));
  const stopped = await autoRun({ io: finished.io, paths: LAND_PATHS });
  assert.equal(stopped.skipped, "QUEUE_STOPPED");
  assert.ok(stopped.reason.endsWith(`; its one landing repair finished (PASS, landing PR_OPENED_CI_RED): ${b2RoundFile()}`), stopped.reason);
  assert.equal(finished.ticks, 0);
  // A report that could not be posted is tried again on a later start.
  const offline = b2Host({ on: true });
  offline.files.set(b2RoundFile(), roundText({ state: "armed" }));
  offline.failReport = "read";
  await autoRun({ io: offline.io, paths: LAND_PATHS });
  assert.equal(offline.files.has(repairAlertPath(LAND_PATHS, REV, "SHU-301")), false);
  offline.failReport = null;
  await autoRun({ io: offline.io, paths: LAND_PATHS });
  assert.equal(offline.reports.length, 1);
  assert.ok(offline.files.has(repairAlertPath(LAND_PATHS, REV, "SHU-301")));
});

test("Self-repair B2: R4 crash windows: a round claimed then refused, or one whose end is never written, is never run twice", async () => {
  // Refused after its claim (card-prepare finds another pull request claiming
  // the card): the round is this revision's one round, finished NOT_STARTED.
  const refused = b2Host({ on: true });
  const fetch = refused.io.fetch;
  refused.io.fetch = async (url, request = {}) => {
    if (String(url) === `${B2_API}/pulls?state=open&per_page=100&page=1`) {
      return b2Respond(200, [{ number: 78, state: "open", title: "[SHU-301] again", head: { ref: "coordinator/SHU-301", sha: FAILED, repo: { full_name: REPO } }, base: { ref: "main", repo: { full_name: REPO } } }]);
    }
    return fetch(url, request);
  };
  const result = await autoRun({ io: refused.io, paths: LAND_PATHS });
  assert.equal(result.outcome, "NOT_STARTED", JSON.stringify(result));
  assert.equal(result.code, "CARD_RUN_REPAIR_INELIGIBLE");
  assert.equal(b2Round(refused).state, "finished");
  assert.equal(b2Round(refused).outcome, "NOT_STARTED");
  assert.equal(refused.ticks, 0);
  noArming(refused);
  assert.equal(refused.reports.length, 1);
  assert.equal((await autoRun({ io: refused.io, paths: LAND_PATHS })).skipped, "QUEUE_STOPPED", "never a second round");
  // The process dies after arming: the finished write never lands. The next
  // start reads the armed round as REPAIR_INTERRUPTED and launches nothing.
  const crashed = b2Host({ on: true });
  const write = crashed.fs.writeFileSync;
  crashed.fs.writeFileSync = (file, text, options = {}) => {
    if (file === `${b2RoundFile()}.tmp` && JSON.parse(text).state === "finished") throw Object.assign(new Error("killed"), { code: "EIO" });
    return write(file, text, options);
  };
  const lost = await autoRun({ io: crashed.io, paths: LAND_PATHS });
  assert.equal(lost.round_error, "EIO");
  assert.equal(b2Round(crashed).state, "armed");
  crashed.fs.writeFileSync = write;
  const ticks = crashed.ticks;
  const after = await autoRun({ io: crashed.io, paths: LAND_PATHS });
  assert.equal(after.skipped, "REPAIR_INTERRUPTED", JSON.stringify(after));
  assert.equal(crashed.ticks, ticks, "never re-launched");
  // A record written by someone else between the read and the claim: no round.
  const raced = b2Host({ on: true });
  const rwrite = raced.fs.writeFileSync;
  raced.fs.writeFileSync = (file, text, options = {}) => {
    if (file === b2RoundFile() && options.flag === "wx") rwrite(file, "{}", {});
    return rwrite(file, text, options);
  };
  assert.equal((await autoRun({ io: raced.io, paths: LAND_PATHS })).skipped, "REPAIR_CLAIMED");
  assert.equal(raced.ticks, 0);
  // States only move forward.
  const round = { file: "/x", record: { state: "armed" } };
  assert.throws(() => advanceRound({ fs: { writeFileSync() {}, renameSync() {} } }, round, "claimed"), { code: "CARD_RUN_REPAIR_ROUND" });
});

test("Self-repair B2: L1 a repaired head that weakens a test is refused REPAIR_TEST_WEAKENED with nothing handed off or merged", async () => {
  const host = b2Host({ on: true, compare: { status: "ahead", behind_by: 0, merge_base_commit: { sha: FAILED },
    files: [{ filename: "packages/db/test/org.test.mjs", status: "modified", patch: "@@ -1 +1 @@\n-test('refuses a deleted organization', async () => {\n+test.skip('refuses a deleted organization', async () => {" }] } });
  const result = await autoRun({ io: host.io, paths: LAND_PATHS });
  assert.equal(result.land.outcome, "REPAIR_TEST_WEAKENED", JSON.stringify(result.land));
  assert.match(result.land.reason, /org\.test\.mjs/);
  noLandingWrites(host);
  assert.equal(host.land.checkReads, 0, "refused before any wait");
  assert.equal(b2Round(host).land, "REPAIR_TEST_WEAKENED");
  assert.match(host.reports[0], /^Alert: this run needs the owner/m);
  assert.match(host.reports[0], /^Landing: REPAIR_TEST_WEAKENED, /m);
  // Never counted as landed, by the timer or by hand.
  assert.equal((await cardLanded(host.io, LAND_PATHS, "SHU-301")).landed, false);
  // An unreadable change refuses too.
  const unreadable = b2Host({ on: true, compare: { status: "ahead", behind_by: 0, merge_base_commit: { sha: FAILED }, files: [{ filename: "a.bin", status: "modified" }] } });
  assert.equal((await autoRun({ io: unreadable.io, paths: LAND_PATHS })).land.outcome, "REPAIR_TEST_WEAKENED");
  noLandingWrites(unreadable);
});

test("Self-repair B2: L2 the repaired pull request moving before the wait, during it, or right before the merge stops the landing", async () => {
  // Learn where the last read of #77 before the merge falls.
  const probe = b2Host({ on: true });
  const reads = [];
  const fetch = probe.io.fetch;
  probe.io.fetch = async (url, request = {}) => {
    if (String(url) === `${B2_API}/pulls/77` && request.headers?.Authorization === "Bearer land-secret-value") reads.push(probe.land.merges);
    return fetch(url, request);
  };
  assert.equal((await autoRun({ io: probe.io, paths: LAND_PATHS })).land.outcome, "MERGED");
  const lastBeforeMerge = reads.lastIndexOf(0) + 1;
  // Before the wait: the first read of #77 sees another head.
  const before = await autoRun({ io: b2Host({ on: true, movePullAt: 1 }).io, paths: LAND_PATHS });
  assert.equal(before.land.outcome, "LAND_HEAD_MISMATCH", JSON.stringify(before.land));
  // During the wait.
  const duringHost = b2Host({ on: true, movePullAt: 2 });
  const during = await autoRun({ io: duringHost.io, paths: LAND_PATHS });
  assert.equal(during.land.outcome, "LAND_HEAD_MISMATCH", JSON.stringify(during.land));
  assert.match(during.land.reason, /moved to 9{40}/);
  noLandingWrites(duringHost);
  // Right before the merge: the repair's last look stops it; nothing merges.
  const lastHost = b2Host({ on: true, movePullAt: lastBeforeMerge });
  const last = await autoRun({ io: lastHost.io, paths: LAND_PATHS });
  assert.equal(last.land.outcome, "LAND_HEAD_MISMATCH", JSON.stringify(last.land));
  assert.match(last.land.reason, /right before the merge/);
  assert.equal(lastHost.land.merges, 0);
  // The pull request closing during the wait is not this repair's any more.
  const closing = b2Host({ on: true, onChecks: (h, read) => { if (read === 1) h.land.merged = true; } });
  const closed = await autoRun({ io: closing.io, paths: LAND_PATHS });
  assert.equal(closed.land.outcome, "LAND_ERROR", JSON.stringify(closed.land));
  assert.match(closed.land.reason, /changed during the wait/);
  assert.equal(closing.land.merges, 0);
});

test("Self-repair B2: L3 only check runs at the repaired head count toward landing it", async () => {
  const stale = b2Host({ on: true, staleRuns: true });
  const result = await autoRun({ io: stale.io, paths: LAND_PATHS });
  assert.equal(result.land.outcome, "CI_TIMEOUT", JSON.stringify(result.land));
  assert.match(result.land.reason, /no check has reported yet/);
  noLandingWrites(stale);
  // A stale red run is not red either: it does not count at all.
  const runs = { check_runs: [{ name: "test", status: "completed", conclusion: "failure", head_sha: FAILED }, { name: "test", status: "completed", conclusion: "success", head_sha: PASSED }], total_count: 2 };
  const status = { statuses: [] };
  const okResponse = { ok: true };
  assert.deepEqual(judgeChecks(okResponse, runs, okResponse, status, null, { head: PASSED }), { green: true });
  assert.deepEqual(judgeChecks(okResponse, runs, okResponse, status), { red: ["test: failure"] }, "without a repair every run counts, as before");
});
