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
  planRun, tickOutcome, tick, busyReasons, runCard, revert, parseArgs, main,
  CARD_RUN_LIMITS, RUN_DROP_IN, TARGET_DROP_IN, RESIDENT_DROP_IN,
  autoRun, autoClaim, installTimer, removeTimer, autoServiceUnit, autoTimerUnit, AUTO_SERVICE, AUTO_TIMER,
} from "../service/card-run.mjs";
import { renderRunReport, reportMarker, plainReason, PUSH_SSH_COMMAND, REPORT_ATTEMPTS, REPORT_RETRY_WAIT_MS } from "../service/card-prepare.mjs";
import { adapterLaunchEnvironment, applyAdapterLaunchEnvironment, supervisorAdapterKeys } from "../service/units.mjs";
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
    head: REV, main: REV, dirty: "", supervisorPid: "4242", invocation: "f".repeat(32), pushDir: null, pushDirs: new Set(),
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
      const refspec = args.at(-1);
      const [sha, ref] = refspec.split(":");
      assert.deepEqual(args.slice(args.indexOf("timeout"), args.indexOf("timeout") + 4), ["timeout", "--kill-after=10", "300", "git"]);
      assert.ok(args.includes(`GIT_ALTERNATE_OBJECT_DIRECTORIES=${PATHS.checkout}/.git/objects`));
      assert.ok(command.includes(`--git-dir=${host.pushDir}`) && command.includes("--no-verify"));
      assert.equal(command.includes("-C") || command.includes(PATHS.checkout), false);
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
      return respond(200, { data: { issue: { id: "issue-uuid", identifier: variables.id, updatedAt: new Date(host.linearClock).toISOString(), ...host.card,
        team: { id: "team", states: { nodes: [{ id: TODO_ID, name: "Todo", type: "unstarted" }] } } } } });
    }
    assert.equal(auth, "Bearer gh-secret-value");
    const branch = `coordinator/${id}`;
    if (url === `https://api.github.com/repos/${config.pilot_repo}/git/ref/heads/${branch}`) {
      host.api.push("github read");
      return host.branchHead ? respond(200, { ref: `refs/heads/${branch}`, object: { sha: host.branchHead } }) : respond(404, { message: "Not Found" });
    }
    // The coordinator's token is read-only: GitHub refuses any write with it.
    if (options.method && options.method !== "GET") return respond(403, { message: "Resource not accessible by integration" });
    return respond(500, null);
  };
  host.io = { fs: host.fs, exec: host.exec, fetch: host.fetch, uid: () => 0, now: () => new Date(host.clock), sleep: (ms) => { host.clock += ms; } };
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
  assert.deepEqual(result.prepared.branch, { branch: "coordinator/SHU-301", head: REV, action: "create" });
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
  assert.deepEqual(output.prepare, { branch: { branch: "coordinator/SHU-301", head: REV, action: "none" }, card: { card: "SHU-301", state: "Todo", action: "none" } });
  noArming(host);
  const fresh = fakeHost({ branchHead: "", card: { state: { id: "b", name: "Backlog", type: "backlog" }, assignee: null, delegate: null } });
  const freshPlan = (await main(["plan"], fresh.io, PATHS)).output.prepare;
  assert.equal(freshPlan.branch.action, "create");
  assert.equal(freshPlan.card.action, "move-to-todo");
  assert.deepEqual(fresh.api, ["linear read", "github read", `git push dry-run refs/heads/coordinator/SHU-301 ${REV}`, "linear read"], "plan only reads, and dry-runs the push");
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
  assert.deepEqual(host.api, ["linear read", "github read", "linear read", `linear todo ${TODO_ID}`, "linear history", "linear read", "linear report read SHU-71", "linear report report-uuid"]);
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
  assert.match(body, /^Before arming: moved SHU-301 from Backlog to Todo; created coordinator\/SHU-301\.$/m);
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
