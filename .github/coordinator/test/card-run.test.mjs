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
import { adapterLaunchEnvironment, applyAdapterLaunchEnvironment, supervisorAdapterKeys } from "../service/units.mjs";
import { supervisorChildEnvironment } from "../service/credential-delivery.mjs";
import { CARD_LAND_ENV, LAND_TOKEN_KEY, readLandToken, isReadRequest, settlePolicy, botSeverity, classifyThread, settleMarker } from "../service/card-land.mjs";
import { handoffReceipt, validHandoff } from "../durable-handoff.mjs";
import { createReceipt, validateReceipt, receiptCommentBody, parseReceiptsFromComments } from "../reconcile.mjs";
import { brokerGitEnv } from "../push-broker.mjs";

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
        return host.fetchFails ? { status: 128, stdout: "", stderr: "fatal: could not read" } : ok();
      }
      if (verb === "rev-parse") {
        assert.deepEqual(command.slice(-3), ["rev-parse", "--verify", "refs/heads/card-base^{commit}"]);
        return ok(`${host.fetchedMain}\n`);
      }
      if (verb === "merge-base") {
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
      if (host.branchHead) {
        if (args.includes(`--force-with-lease=${ref}:`)) return { status: 1, stdout: "", stderr: "! [rejected] (stale info)" };
        if (!dry) host.branchHead = sha;
        return ok();
      }
      if (host.pushFails) return { status: host.pushFails === "timeout" ? 124 : 128, stdout: "", stderr: `ERROR: read-only key for ${PUSH_REMOTE}` };
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
      // Self-watch 0b: the run's own receipt reads, kept out of host.api so
      // every older call sequence reads as it did.
      if (query.includes("CardRunWatchReceipts")) {
        host.watchReads = (host.watchReads ?? 0) + 1;
        if (host.watchFails) throw new TypeError("fetch failed");
        return respond(200, { data: { issue: { comments: { nodes: structuredClone(host.watchComments?.(host) ?? []) } } } });
      }
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
// commentOnResolve, editOnMergeIntent.
function landingHost(options = {}) {
  const config = options.settle !== undefined
    ? configFor("SHU-301", (c) => ({ ...c, landing_thread_settle: { ...c.landing_thread_settle, enabled: options.settle !== false, ...(options.settle || {}) } }))
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
    merge_commit_sha: land.merged ? MERGE_SHA : null, draft: false, mergeable: true, mergeable_state: "clean", labels: [],
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
      return respond(200, { total_count: runs.length, check_runs: runs });
    }
    if (route === `/commits/${PASSED}/status?per_page=100`) return respond(200, { state: "success", statuses: [] });
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
// two ticks and then freezes.
function watchedHost({ config, frozenAfter = 2, episode = null, receipts = true } = {}) {
  let launch = null;
  let heartbeat = null;
  const host = fakeHost({
    ...(config ? { config } : {}),
    onTick: (h) => {
      if (h.ticks <= frozenAfter) {
        launch ??= new Date(h.clock).toISOString();
        heartbeat = new Date(h.clock).toISOString();
      }
      if (h.ticks < 5) return tickText(armed(armedId(h)));
      if (h.ticks === 5) return tickText(spent("SHU-301", "review PASS — the episode is complete"), 0);
      return tickText("activation=absent (committed gates only)", 0);
    },
  });
  host.watchComments = (h) => (receipts && launch ? [watchReceipt(episode ?? armedId(h), { launch, heartbeat })] : []);
  host.watched = () => ({ launch, heartbeat });
  return host;
}

test("SHU-86 0b: the observe-only watch records first dispatch, last progress and the longest stretch without progress, and changes nothing else", async () => {
  const host = watchedHost();
  const { code, output } = await main(["run"], host.io, PATHS);
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(output.outcome, "PASS");
  assert.equal(output.ticks.length, 5);
  assert.equal(host.watchReads, 5, "one receipt read after every tick");
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

test("SHU-86 0b: a failed receipt read is no progress and never ends the run", async () => {
  const host = watchedHost();
  host.watchFails = true;
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "PASS");
  assert.equal(output.watch.receipt_read_failures, 5);
  assert.equal(output.watch.receipt_reads, 0);
  assert.equal(output.watch.first_dispatch_at, null);
  assert.match(host.reports[0], /5 receipt read\(s\) failed/);
  reverted(host);
});

test("SHU-86 0b: another run's receipts on the same card never count as this run's progress", async () => {
  const host = watchedHost({ episode: "shu-301-run-20261001T000000Z" });
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.watch.first_dispatch_at, null);
  assert.equal(output.watch.last_progress_at, null);
});

test("SHU-86 0b: with observe off nothing is read and the claim's watch fields are null", async () => {
  const host = watchedHost({ config: configFor("SHU-301", (c) => { const { watch, ...rest } = c; return rest; }) });
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "PASS");
  assert.equal(host.watchReads ?? 0, 0);
  assert.equal(output.watch, undefined);
  assert.doesNotMatch(host.reports[0], /^Watch /m);
});

test("SHU-86 0b: a tick command that times out ends the run as an ERROR and the host is reverted", async () => {
  const host = watchedHost();
  const exec = host.io.exec;
  const bounds = [];
  let starts = 0;
  host.io.exec = (file, args, options) => {
    if (file === "systemctl" && args[0] === "start" && args[1] === "shu-coordinator.service") {
      bounds.push(options?.timeoutMs);
      starts += 1;
      if (starts === 2) return { status: 1, stdout: "", stderr: "", timedOut: true };
    }
    if (file === "journalctl") bounds.push(options?.timeoutMs);
    return exec(file, args, options);
  };
  const { output } = await main(["run"], host.io, PATHS);
  assert.equal(output.outcome, "ERROR");
  assert.match(output.reason, /systemctl start shu-coordinator\.service timed out after 600000 ms/);
  assert.ok(bounds.length >= 4 && bounds.every((ms) => ms === CARD_RUN_LIMITS.tickCallTimeoutMs), "every tick command is bounded");
  reverted(host);
});

test("SHU-86 0c: the unit's time limit stays above the run window, a hung tick, worker grace, landing and its reports", () => {
  const need = CARD_RUN_LIMITS.runMs + CARD_RUN_LIMITS.tickCallTimeoutMs + CARD_RUN_LIMITS.workerGraceMs + CARD_RUN_LIMITS.landWaitMs
    + 4 * CARD_RUN_LIMITS.reportTimeoutMs;
  assert.ok(AUTO_TIMEOUT_START_MS > need, `${AUTO_TIMEOUT_START_MS} must exceed ${need}`);
  assert.equal(AUTO_TIMEOUT_START_MS, 8 * 60 * 60 * 1000, "SHU-86 0c: the unit limit stays 8h");
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
    const host = landingHost({ settle: {}, botThreads });
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
  // A branch left at the old install is never moved to the new main.
  const stale = fakeHost({ branchHead: REV });
  stale.mainTip = HEAD;
  await assert.rejects(runCard({ io: stale.io, paths: PATHS }), { code: "CARD_RUN_BRANCH_NOT_AT_TARGET" });
  assert.equal(stale.branchHead, REV);
  noArming(stale);
  assert.throws(() => onBase(planRun({ config: configFor("SHU-301"), revision: REV, now: START }), "not-a-sha"), { code: "CARD_RUN_BASE" });
});

test("SHU-312 Q5: the timer runs the queue in order, one card per start, and stops at a card that did not land", async () => {
  const host = fakeHost({ config: queueConfig(), branchHead: "", onTick: (h) => (h.ticks === 1 ? passFor("SHU-301")(h) : tickText("activation=absent (committed gates only)")) });
  assert.deepEqual(nextCard(host.io, PATHS, queueConfig(), REV), { id: "SHU-301" });
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
  assert.deepEqual(nextCard(host.io, PATHS, queueConfig(), HEAD), { id: "SHU-305" }, "a new install re-arms the card that did not land, after the one that did");
  const run = await attempt(() => autoRun({ io: host.io, paths: PATHS }));
  assert.equal(run.card, "SHU-305", JSON.stringify(run));
  // A landing outcome is read only from a well-formed claim file.
  const odd = fakeHost({ config: queueConfig() });
  odd.files.set(`${PATHS.stateDir}/card-run-auto-x-SHU-301.json`, { text: JSON.stringify({ land: "MERGED" }), mode: 0o600, uid: 0, gid: 0 });
  odd.files.set(`${PATHS.stateDir}/card-run-auto-${REV}-SHU-3010.json`, { text: JSON.stringify({ land: "MERGED" }), mode: 0o600, uid: 0, gid: 0 });
  assert.deepEqual(nextCard(odd.io, PATHS, queueConfig(), REV), { id: "SHU-301" });
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
    assert.deepEqual(nextCard(swapped.io, PATHS, queueConfig(), OTHER), { id: "SHU-301" }, label);
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
  assert.equal(nextCard(host.io, PATHS, queueConfig(), REV).skipped, "QUEUE_DONE", "a review claim is never a card's landing");
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
