// SHU-86 — the card-run command: one bounded run, armed from the committed
// configuration, ended by the coordinator's own tick, always reverted. Every
// host effect goes through an injected io, so these tests run a whole run on a
// fake host and read back exactly what it touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planRun, tickOutcome, busyReasons, runCard, revert, parseArgs, main,
  CARD_RUN_LIMITS, RUN_DROP_IN, TARGET_DROP_IN, RESIDENT_DROP_IN,
} from "../service/card-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.json"), "utf8"));
const REV = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const START = new Date("2026-10-09T15:30:07.000Z");
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
  const host = { files, calls, clock: START.getTime(), ticks: 0, environ: [], lastTick: "", workers, branchHead, card: structuredClone(card), api: [],
    head: REV, main: REV, dirty: "", supervisorPid: "4242", invocation: "f".repeat(32) };
  const put = (file, text, extra = {}) => files.set(file, { text, mode: 0o644, uid: 0, gid: 0, ...extra });
  put(`${PATHS.checkout}/.github/coordinator/config.json`, JSON.stringify(config));
  put(PATHS.receipt, JSON.stringify({ version: 1, revision: REV, state: "VERIFIED", effects: [] }));
  for (const unit of UNITS) put(dropIn(unit, RESIDENT_DROP_IN), "[Service]\n");
  for (const dir of [PATHS.stateDir, PATHS.worktrees, PATHS.tmp, "/run/lock"]) dirs.add(dir);
  put(`${PATHS.tmp}/shu-npm-cache-1/x`, "cache");
  put(`${PATHS.tmp}/keep-me`, "other");
  put(PATHS.coordinatorEnv, "GITHUB_TOKEN=gh-secret-value\nLINEAR_API_TOKEN=lin-secret-value\n", { uid: 997, mode: 0o600 });
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
        return ok();
      }
      if (line === "show -p InvocationID --value shu-coordinator.service") return ok(`${host.invocation}\n`);
      return ok();
    }
    if (file === "journalctl") return ok(host.lastTick);
    return { status: 127, stdout: "", stderr: `unexpected ${file}` };
  };
  // Linear and GitHub, as the coordinator's tokens see them.
  const respond = (status, json) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => json });
  host.fetch = async (url, options = {}) => {
    const auth = options.headers?.Authorization;
    if (url === "https://api.linear.app/graphql") {
      assert.equal(auth, "lin-secret-value");
      const { query, variables } = JSON.parse(options.body);
      host.api.push(query.includes("CardRunTodo") ? `linear todo ${variables.stateId}` : "linear read");
      if (query.includes("CardRunTodo")) {
        if (host.failTodo) return respond(200, { data: { issueUpdate: { success: true } } });
        host.card.state = { id: variables.stateId, name: "Todo", type: "unstarted" };
        return respond(200, { data: { issueUpdate: { success: true } } });
      }
      return respond(200, { data: { issue: { id: "issue-uuid", identifier: variables.id, ...host.card,
        team: { id: "team", states: { nodes: [{ id: TODO_ID, name: "Todo", type: "unstarted" }] } } } } });
    }
    assert.equal(auth, "Bearer gh-secret-value");
    const branch = `coordinator/${id}`;
    if (url === `https://api.github.com/repos/${config.pilot_repo}/git/ref/heads/${branch}`) {
      host.api.push("github read");
      return host.branchHead ? respond(200, { ref: `refs/heads/${branch}`, object: { sha: host.branchHead } }) : respond(404, { message: "Not Found" });
    }
    if (url === `https://api.github.com/repos/${config.pilot_repo}/git/refs` && options.method === "POST") {
      const body = JSON.parse(options.body);
      host.api.push(`github create ${body.ref} ${body.sha}`);
      host.branchHead = body.sha;
      return respond(201, { ref: body.ref, object: { sha: body.sha } });
    }
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
  const result = await runCard({ io: missing.io, paths: PATHS });
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.prepared.branch, { branch: "coordinator/SHU-301", head: REV, action: "create" });
  assert.equal(missing.branchHead, REV);
  assert.ok(missing.api.includes(`github create refs/heads/coordinator/SHU-301 ${REV}`));
  const moved = fakeHost({ branchHead: HEAD });
  await assert.rejects(runCard({ io: moved.io, paths: PATHS }), { code: "CARD_RUN_BRANCH_NOT_AT_TARGET" });
  noArming(moved);
  assert.equal(moved.branchHead, HEAD, "an existing branch is never moved");
  assert.equal(moved.api.some((call) => call.startsWith("github create") || call.startsWith("linear todo")), false);
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
  assert.deepEqual(fresh.api, ["linear read", "github read"], "plan only reads");
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
  assert.deepEqual(host.api, ["linear read", "github read", `linear todo ${TODO_ID}`, "linear read"]);
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
