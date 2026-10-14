// SHU-322 — Card B: the card-run timer installs the next card queue itself,
// only inside the autopilot boundary, under the card-run lock, rechecking the
// pause file before every step. Every host effect goes through an injected io:
// git, the provisioner, the plan check, GitHub and Linear are all doubles here,
// and each test reads back exactly what the run touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  selfInstallGate, selfInstall, installablePath, contractEntries, reviewPasses, installClaim, renderInstallReport,
  CONFIG_PATH, CONTRACTS_PATH, INVENTORY_PATH, PROVISIONER, CARD_RUN,
} from "../service/card-install.mjs";
import { autoRun, autoClaim, busyReasons, queueConfigPath, reviewClaim } from "../service/card-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_TEXT = fs.readFileSync(path.join(HERE, "..", "config.json"), "utf8");
const CONTRACTS_TEXT = fs.readFileSync(path.join(HERE, "..", "card-contracts.mjs"), "utf8");
const COMMITTED = JSON.parse(COMMITTED_TEXT);
const R = "a".repeat(40);
const N = "d".repeat(40);
const PR_HEAD = "e".repeat(40);
const NODE = "/usr/bin/node";
const START = new Date("2026-10-14T06:00:00.000Z");
const PUSH_REMOTE = "git@github.com:BAWES-Universe/studenthub-platform.git";
const REPO = COMMITTED.pilot_repo;
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
  landEnv: "/srv/shu/card-land.env",
});
const NEW_IDS = ["SHU-401", "SHU-402"];
const TEST_PATH = ".github/coordinator/test/shu401-queue.test.mjs";
const BLOBS = Object.freeze({ [CONFIG_PATH]: "1".repeat(40), [CONTRACTS_PATH]: "2".repeat(40), [TEST_PATH]: "3".repeat(40) });

// Main's next queue: R's lanes with two appended, scoped to the new two, each
// with its own contract entry added at the end of CARD_CONTRACTS.
const lane = (id) => ({ ...structuredClone(COMMITTED.card_lanes.at(-1)), id, authorization_ref: id, note: `queued card ${id}` });
function nextConfig(edit = (config) => config) {
  const config = structuredClone(COMMITTED);
  config.card_lanes = [...config.card_lanes, ...NEW_IDS.map(lane)];
  config.dispatch_scope = { issue_ids: [...NEW_IDS] };
  return edit(config);
}
function nextContracts(ids = NEW_IDS) {
  const start = CONTRACTS_TEXT.indexOf("export const CARD_CONTRACTS = Object.freeze({\n");
  const end = CONTRACTS_TEXT.indexOf("\n});", start);
  const entries = ids.map((id) => `\n  "${id}": Object.freeze({\n    workspace_mode: "repo",\n  }),`).join("");
  return CONTRACTS_TEXT.slice(0, end) + entries + CONTRACTS_TEXT.slice(end);
}
const CHANGES = Object.freeze([
  { status: "M", path: CONFIG_PATH }, { status: "M", path: CONTRACTS_PATH }, { status: "A", path: TEST_PATH },
]);

// Facts as readMainFacts returns them for an admissible main.
function facts(edit = (value) => value) {
  return edit({
    revision: R, main: N, descends: true, changes: structuredClone(CHANGES), contractLines: { added: 6, deleted: 0 },
    blobs: { ...BLOBS }, configs: { installed: COMMITTED_TEXT, main: JSON.stringify(nextConfig()) },
    contractTexts: { installed: CONTRACTS_TEXT, main: nextContracts() },
    passes: [{ pr: 300, head: PR_HEAD, files: Object.fromEntries(Object.entries(BLOBS).map(([file, sha]) => [file, { sha }])) }],
    landed: [], checks: { green: true },
  });
}
const refused = (gate) => gate.ok === false && gate.transient === false && gate.quiet === false;

// A fake orchestrator host for the whole timer start: files, the installed
// checkout, the coordinator's bare repository and its view of main, the
// provisioner, N's plan, GitHub and Linear.
function fakeHost({ config = COMMITTED, main = N, mainConfig = nextConfig(), changes = CHANGES, contractLines = { added: 6, deleted: 0 },
  blobs = BLOBS, mainContracts = nextContracts(), landedQueue = true } = {}) {
  const files = new Map();
  const host = {
    files, calls: [], reports: [], github: [], steps: [], clock: START.getTime(), head: R, branch: R, main, descends: true,
    changes, contractLines, blobs, failGit: new Set(), provisionFails: {}, checks: { runs: [{ name: "ci", status: "completed", conclusion: "success" }], statuses: [] },
    plan: null, planStatus: 0, pushDir: null, merged: false, onStep: null,
  };
  const put = (file, text, extra = {}) => files.set(file, { text, mode: 0o644, uid: 0, ...extra });
  host.put = put;
  put(`${PATHS.checkout}/.github/coordinator/config.json`, JSON.stringify(config));
  put(PATHS.receipt, JSON.stringify({ version: 1, revision: R, state: "VERIFIED", effects: [] }));
  put(PATHS.coordinatorEnv, `GITHUB_TOKEN=gh-secret-value\nLINEAR_API_TOKEN=lin-secret-value\nSHU_PUSH_REMOTE_URL=${PUSH_REMOTE}\n`, { uid: 997, mode: 0o600 });
  // The installed queue already landed, so the timer reads QUEUE_DONE.
  if (landedQueue) {
    for (const id of config.dispatch_scope.issue_ids) {
      put(autoClaim(PATHS, R, id), JSON.stringify({ card: id, revision: R, outcome: "PASS", ok: true, land: "MERGED" }), { mode: 0o600 });
    }
  }
  // Card A's REVIEW_PASS claim of the queue config pull request.
  put(reviewClaim(PATHS, 300, PR_HEAD), JSON.stringify({ pr: 300, head: PR_HEAD, base: R, revision: R, outcome: "REVIEW_PASS",
    files: Object.fromEntries(Object.entries(BLOBS).map(([file, sha]) => [file, { sha, additions: 1, deletions: 0 }])) }), { mode: 0o600 });
  const texts = new Map([
    [`${R}:${CONFIG_PATH}`, COMMITTED_TEXT], [`${main}:${CONFIG_PATH}`, JSON.stringify(mainConfig)],
    [`${R}:${CONTRACTS_PATH}`, CONTRACTS_TEXT], [`${main}:${CONTRACTS_PATH}`, mainContracts],
  ]);
  const children = (dir) => {
    const names = new Set();
    for (const file of files.keys()) if (file.startsWith(`${dir}/`)) names.add(file.slice(dir.length + 1).split("/")[0]);
    return [...names];
  };
  host.fs = {
    existsSync: (file) => files.has(file) || children(file).length > 0,
    lstatSync: (file) => {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      const entry = files.get(file);
      return { isFile: () => true, isSymbolicLink: () => false, uid: entry.uid, mode: 0o100000 | entry.mode };
    },
    readFileSync: (file) => {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      return files.get(file).text;
    },
    writeFileSync: (file, text, options = {}) => {
      if (options.flag === "wx" && files.has(file)) throw Object.assign(new Error(`EEXIST ${file}`), { code: "EEXIST" });
      put(file, String(text), { mode: options.mode ?? 0o644 });
    },
    unlinkSync: (file) => { if (!files.delete(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" }); },
    readdirSync: (dir) => children(dir),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    rmSync: () => {},
    chownSync: () => {},
    chmodSync: () => {},
  };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fail = (status = 128) => ({ status, stdout: "", stderr: "fatal" });
  // Each named step the run takes, so a test can drop the pause file in
  // just before one.
  const step = (name) => { host.steps.push(name); host.onStep?.(host, name); };
  host.exec = (file, args) => {
    host.calls.push([file, ...args].join(" "));
    if (file === "id") return ok(args[0] === "-u" ? "997\n" : "998\n");
    if (file === "getent") return ok("shu-coordinator:x:997:998::/var/lib/shu-coordinator:/usr/sbin/nologin\n");
    if (file === "pgrep") return host.workers ? ok("5000\n") : { status: 1, stdout: "", stderr: "" };
    if (file === "git") {
      const line = args.join(" ");
      if (line.endsWith("rev-parse HEAD")) return ok(`${host.head}\n`);
      if (line.endsWith("rev-parse refs/heads/main")) return ok(`${host.branch}\n`);
      if (line.includes("status --porcelain")) return ok("");
    }
    if (file === "runuser") {
      assert.deepEqual(args.slice(0, 5), ["-u", "shu-coordinator", "--", "env", "-i"]);
      assert.ok(args.includes("GIT_CONFIG_GLOBAL=/dev/null") && args.includes("GIT_TERMINAL_PROMPT=0"));
      const command = args.slice(5 + args.slice(5).findIndex((arg) => !arg.includes("=")));
      if (command[0] === "mktemp") { host.pushDir = "/tmp/shu-card-push-Ab12Cd34"; return ok(`${host.pushDir}\n`); }
      if (command[0] === "rm") { host.pushDir = null; return ok(); }
      if (command[0] === "git") return ok();
      assert.deepEqual(command.slice(0, 4), ["timeout", "--kill-after=10", "300", "git"]);
      assert.ok(command.includes("core.hooksPath=/dev/null"), "every coordinator git call runs with hooks off");
      const bare = command.indexOf(`--git-dir=${host.pushDir}`);
      if (bare >= 0) {
        const [verb, ...rest] = command.slice(bare + 1);
        if (host.failGit.has(verb)) return fail();
        if (verb === "fetch") { host.github.push("git fetch main (bare)"); return ok(); }
        if (verb === "rev-parse") return ok(`${host.main}\n`);
        if (verb === "merge-base") return { status: host.descends ? 0 : 1, stdout: "", stderr: "" };
        if (verb === "diff" && rest.includes("--name-status")) return ok(host.changes.map((c) => `${c.status}\0${c.path}\0`).join(""));
        if (verb === "diff" && rest.includes("--numstat")) return ok(`${host.contractLines.added}\t${host.contractLines.deleted}\t${CONTRACTS_PATH}\n`);
        if (verb === "cat-file") {
          const text = texts.get(rest.at(-1));
          return text === undefined ? fail() : ok(text);
        }
        if (verb === "ls-tree") return ok(Object.entries(host.blobs).map(([file, sha]) => `100644 blob ${sha}\t${file}\0`).join(""));
        return fail();
      }
      // The merge, in the installed checkout, as the coordinator user.
      const at = command.indexOf("-C");
      assert.equal(command[at + 1], PATHS.checkout);
      const [verb, ...rest] = command.slice(at + 2);
      if (verb === "fetch") {
        step("merge");
        assert.deepEqual(rest, ["--no-tags", "--no-recurse-submodules", PUSH_REMOTE, "refs/heads/main"]);
        return host.failGit.has("checkout-fetch") ? fail() : ok();
      }
      if (verb === "merge") {
        assert.deepEqual(rest, ["--ff-only", host.main]);
        if (host.failGit.has("merge")) return fail(1);
        host.head = host.main; host.branch = host.main; host.merged = true;
        return ok();
      }
      if (verb === "rev-parse") return ok(`${rest[0] === "HEAD" ? host.head : host.branch}\n`);
      if (verb === "status") return ok("");
      return fail();
    }
    if (file === NODE && args[0] === path.join(PATHS.checkout, PROVISIONER)) {
      const [, action, revision] = args;
      step(`${action} ${revision}`);
      if (host.provisionFails[`${action} ${revision}`]) return { status: 2, stdout: `${JSON.stringify({ ok: false, code: "ACT_TEST_FAILURE" })}\n`, stderr: "" };
      if (action === "install") files.set(PATHS.receipt, { text: JSON.stringify({ version: 1, revision, state: "VERIFIED", effects: [] }), uid: 0, mode: 0o600 });
      if (action === "rollback") files.delete(PATHS.receipt);
      return ok(`${JSON.stringify({ ok: true, state: action === "install" ? "VERIFIED" : action, revision })}\n`);
    }
    if (file === NODE && args[0] === path.join(PATHS.checkout, CARD_RUN)) {
      step(`plan ${args[1]}`);
      const queue = JSON.parse(texts.get(`${host.main}:${CONFIG_PATH}`)).dispatch_scope.issue_ids;
      const prepare = { branch: { action: "create" }, card: { action: "move-to-todo" } };
      const plan = host.plan ?? { id: queue[0], queue, next: { id: queue[0] }, busy: [], prepare, queued: queue.map((id) => ({ id, prepare })) };
      return { status: host.planStatus, stdout: JSON.stringify(plan, null, 2), stderr: "" };
    }
    return { status: 127, stdout: "", stderr: `unexpected ${file}` };
  };
  const respond = (status, json) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => json });
  host.fetch = async (url, options = {}) => {
    if (url === "https://api.linear.app/graphql") {
      const { query, variables } = JSON.parse(options.body);
      if (query.includes("CardRunReportIssue")) {
        const nodes = host.reports.filter((body) => body.includes(variables.marker)).map((_, i) => ({ id: `c${i}` }));
        return respond(200, { data: { issue: { id: "shu-71", identifier: variables.id, comments: { nodes } } } });
      }
      if (query.includes("CardRunReportComment")) { host.reports.push(variables.body); return respond(200, { data: { commentCreate: { success: true } } }); }
      return respond(500, null);
    }
    assert.equal(options.headers?.Authorization, "Bearer gh-secret-value");
    assert.equal(options.method ?? "GET", "GET", "the coordinator's token only reads");
    const api = `https://api.github.com/repos/${REPO}`;
    host.github.push(url.slice(api.length + 1));
    if (host.githubFails) return respond(502, null);
    if (url === `${api}/commits/${host.main}/check-runs?filter=latest&per_page=100`) return respond(200, { total_count: host.checks.runs.length, check_runs: host.checks.runs });
    if (url === `${api}/commits/${host.main}/status?per_page=100`) return respond(200, { statuses: host.checks.statuses });
    if (url === `${api}/pulls?state=open&base=main&per_page=100`) return respond(200, []);
    return respond(404, null);
  };
  host.io = { fs: host.fs, exec: host.exec, fetch: host.fetch, uid: () => 0, now: () => new Date(host.clock), sleep: () => {}, delay: async () => {}, nodePath: () => NODE };
  return host;
}

const deps = { busyReasons, landedByTimer: (io, paths, id) => io.fs.existsSync(autoClaim(paths, R, id)) };
const install = (host, config = COMMITTED) => selfInstall({ io: host.io, paths: PATHS, config, revision: R, deps });
const claimOf = (host) => JSON.parse(host.files.get(installClaim(PATHS, N))?.text ?? "{}");
// Another start writes the claim just after this one looked for it.
const raceClaim = (host) => {
  const claim = installClaim(PATHS, N);
  const exists = host.fs.existsSync;
  host.put(claim, JSON.stringify({ main: N, revision: R, claimed_at: "another start" }), { mode: 0o600 });
  let first = true;
  host.fs.existsSync = (file) => {
    if (file === claim && first) { first = false; return false; }
    return exists(file);
  };
};
const INSTALL_ORDER = ["merge", `rollback ${R}`, `install ${N}`, `verify ${N}`, `precondition ${N}`, "plan plan"];
const untouched = (host) => {
  assert.equal(host.merged, false, "the checkout was not merged");
  assert.deepEqual(host.steps, [], "no install step ran");
  assert.equal(host.files.has(PATHS.lock), false, "the lock is released");
};

test("SHU-322 B1: a reviewed card queue on main installs in order, reports once and exits for the next start", async () => {
  const host = fakeHost();
  const out = await install(host);
  const result = out.result ?? {};
  assert.equal(result.outcome, "INSTALLED");
  assert.equal(result.ok, true);
  assert.deepEqual(result.queue, NEW_IDS);
  assert.deepEqual(host.steps, INSTALL_ORDER);
  assert.deepEqual(result.steps, ["claim", "idle", "merge", "rollback", "install", "verify", "precondition", "plan"]);
  assert.equal(host.reports.length, 1);
  assert.match(host.reports[0], /^<!-- card-run-report card-install-d{40} -->/);
  assert.match(host.reports[0], /INSTALLED/);
  assert.match(host.reports[0], /Queue: SHU-401, SHU-402\./);
  assert.equal(claimOf(host).outcome, "INSTALLED");
  assert.equal(host.files.has(PATHS.lock), false);
  assert.equal(host.files.has(PATHS.pause), false);
  // It never runs a card in this process: nothing is armed and no unit moves.
  assert.equal(host.files.has(PATHS.activation), false);
  assert.equal(host.calls.some((call) => call.startsWith("systemctl")), false);
  assert.equal(JSON.parse(host.files.get(PATHS.receipt).text).revision, N);
  const admitted = selfInstallGate(facts());
  assert.deepEqual(admitted, { ok: true, queue: NEW_IDS, lanes: NEW_IDS });
});

test("SHU-322 B2: a coordinator change outside the queue config paths, or a deletion, is a refusal for the owner", () => {
  for (const extra of [".github/coordinator/service/card-run.mjs", ".github/coordinator/adapters/codex.mjs",
    ".github/coordinator/reviewer-sandbox.sh", ".github/coordinator/service/shu-reviewer.sudoers", ".github/coordinator/reconcile.mjs"]) {
    const gate = selfInstallGate(facts((f) => ({ ...f, changes: [...f.changes, { status: "M", path: extra }], blobs: { ...f.blobs, [extra]: "4".repeat(40) } })));
    assert.ok(refused(gate), extra);
    assert.match(gate.reason, /is not a queue config path/);
  }
  const deleted = selfInstallGate(facts((f) => ({ ...f, changes: [...f.changes, { status: "D", path: ".github/coordinator/test/old.test.mjs" }] })));
  assert.ok(refused(deleted));
  assert.match(deleted.reason, /deleted/);
  assert.equal(installablePath(TEST_PATH), true);
  assert.equal(installablePath(INVENTORY_PATH), true);
  assert.equal(installablePath(".github/coordinator/service/card-install.mjs"), false);
  for (const file of [TEST_PATH, CONFIG_PATH, ".github/coordinator/service/test/x.test.mjs", ".github/coordinator/x/../config.json", "README.md"]) {
    assert.equal(installablePath(file), queueConfigPath(file), `Card A and Card B agree on ${file}`);
  }
});

test("SHU-322 B3: card-contracts.mjs may only gain lines", () => {
  const deletion = selfInstallGate(facts((f) => ({ ...f, contractLines: { added: 6, deleted: 1 } })));
  assert.ok(refused(deletion));
  assert.match(deletion.reason, /may only gain lines/);
  const created = selfInstallGate(facts((f) => ({ ...f, changes: f.changes.map((c) => (c.path === CONTRACTS_PATH ? { ...c, status: "A" } : c)) })));
  assert.ok(refused(created));
});

test("SHU-322 B4: config.json may only replace dispatch_scope with a new queue of appended, unlanded, contracted lanes", () => {
  const withConfig = (edit) => facts((f) => ({ ...f, configs: { ...f.configs, main: JSON.stringify(nextConfig(edit)) } }));
  const cases = {
    "another key": (c) => ({ ...c, max_dispatch: 2 }),
    "a removed key": (c) => { const { landing_thread_settle: _gone, ...rest } = c; return rest; },
    "an added key": (c) => ({ ...c, enable_dispatch: true, extra: 1 }),
    "the review policy": (c) => ({ ...c, queue_config_review: { ...c.queue_config_review, max_heads_per_pr: 9 } }),
    "an edited existing lane": (c) => ({ ...c, card_lanes: c.card_lanes.map((l, i) => (i === 0 ? { ...l, writer_lane: "claude-builder" } : l)) }),
    "a dropped existing lane": (c) => ({ ...c, card_lanes: c.card_lanes.slice(1) }),
    "one card": (c) => ({ ...c, dispatch_scope: { issue_ids: ["SHU-401"] } }),
    "six cards": (c) => ({ ...c, card_lanes: [...c.card_lanes, ...["SHU-403", "SHU-404", "SHU-405", "SHU-406"].map(lane)],
      dispatch_scope: { issue_ids: ["SHU-401", "SHU-402", "SHU-403", "SHU-404", "SHU-405", "SHU-406"] } }),
    "an old lane": (c) => ({ ...c, dispatch_scope: { issue_ids: ["SHU-401", "SHU-197"] } }),
    "a repeated card": (c) => ({ ...c, dispatch_scope: { issue_ids: ["SHU-401", "SHU-401"] } }),
    "a scope with another key": (c) => ({ ...c, dispatch_scope: { issue_ids: NEW_IDS, extra: true } }),
  };
  for (const [name, edit] of Object.entries(cases)) {
    const gate = selfInstallGate(withConfig(edit));
    assert.ok(refused(gate), `${name}: ${JSON.stringify(gate)}`);
  }
  const laneless = selfInstallGate(facts((f) => ({ ...f, configs: { ...f.configs, main: JSON.stringify(nextConfig((c) => ({ ...c, dispatch_scope: { issue_ids: ["SHU-401", "SHU-403"] } }))) },
    contractTexts: { ...f.contractTexts, main: nextContracts(["SHU-401", "SHU-402", "SHU-403"]) } })));
  assert.ok(refused(laneless), "a contracted card with no appended lane");
  assert.match(laneless.reason, /SHU-403 in the new dispatch_scope is not a newly appended card lane/);
  const landed = selfInstallGate(facts((f) => ({ ...f, landed: ["SHU-402"] })));
  assert.ok(refused(landed));
  assert.match(landed.reason, /already landed/);
  const uncontracted = selfInstallGate(facts((f) => ({ ...f, contractTexts: { ...f.contractTexts, main: nextContracts(["SHU-401"]) } })));
  assert.ok(refused(uncontracted));
  assert.match(uncontracted.reason, /SHU-402 has no CARD_CONTRACTS entry/);
  assert.deepEqual([...contractEntries(nextContracts())].slice(-2), NEW_IDS);
  assert.equal(contractEntries(CONTRACTS_TEXT).has("SHU-304"), false, "a review-only card is not a contract entry");
  // A main whose queue is the installed one is nothing to install.
  const same = selfInstallGate(facts((f) => ({ ...f, configs: { ...f.configs, main: COMMITTED_TEXT } })));
  assert.equal(same.quiet, true);
});

test("SHU-322 B5: every changed coordinator blob must be one a root-owned REVIEW_PASS claim recorded at an exact head", async () => {
  const unbound = selfInstallGate(facts((f) => ({ ...f, blobs: { ...f.blobs, [TEST_PATH]: "5".repeat(40) } })));
  assert.ok(refused(unbound));
  assert.match(unbound.reason, /is not the blob a REVIEW_PASS claim recorded/);
  assert.ok(refused(selfInstallGate(facts((f) => ({ ...f, passes: [] })))));
  const read = (edit) => {
    const host = fakeHost();
    edit(host);
    return reviewPasses(host.io, PATHS);
  };
  assert.equal(read(() => {}).length, 1);
  const claimFile = reviewClaim(PATHS, 300, PR_HEAD);
  const rewrite = (host, change, extra = {}) => host.put(claimFile, JSON.stringify({ ...JSON.parse(host.files.get(claimFile).text), ...change }), { mode: 0o600, ...extra });
  assert.deepEqual(read((host) => rewrite(host, { outcome: "REVIEW_BLOCKED" })), [], "a blocked review binds nothing");
  assert.deepEqual(read((host) => rewrite(host, { outcome: undefined })), [], "a claim still running binds nothing");
  assert.deepEqual(read((host) => rewrite(host, { head: "f".repeat(40) })), [], "a claim naming another head binds nothing");
  assert.deepEqual(read((host) => rewrite(host, {}, { uid: 997 })), [], "a claim root did not write binds nothing");
  // End to end: without the claim the host is never touched.
  const host = fakeHost();
  host.files.delete(claimFile);
  const out = await install(host);
  assert.equal(out.result?.outcome, "NEEDS_OWNER");
  untouched(host);
});

test("SHU-322 B6: a main that does not descend from the installed revision is refused for the owner", async () => {
  const host = fakeHost();
  host.descends = false;
  const out = await install(host);
  assert.equal(out.result?.outcome, "NEEDS_OWNER");
  assert.match(out.result?.reason, /does not descend/);
  assert.equal(claimOf(host).outcome, "NEEDS_OWNER");
  untouched(host);
  assert.ok(refused(selfInstallGate(facts((f) => ({ ...f, descends: false })))));
});

test("SHU-322 B7: main at the installed revision, or with the installed queue, is a silent skip", async () => {
  const same = fakeHost({ main: R });
  assert.deepEqual(await install(same), { silent: true });
  const unchanged = fakeHost({ mainConfig: COMMITTED, changes: [{ status: "A", path: TEST_PATH }] });
  assert.deepEqual(await install(unchanged), { silent: true });
  for (const host of [same, unchanged]) {
    assert.equal(host.reports.length, 0);
    assert.equal([...host.files.keys()].some((file) => file.includes("card-install-auto-")), false);
    assert.equal(host.github.filter((entry) => entry.startsWith("commits/")).length, 0, "no checks were read");
    untouched(host);
  }
});

test("SHU-322 B8: a read that fails or checks not yet green skip with no claim; red checks are refused", async () => {
  const fetchFails = fakeHost();
  fetchFails.failGit.add("fetch");
  assert.equal((await install(fetchFails)).skipped, "INSTALL_UNREADABLE");
  const diffFails = fakeHost();
  diffFails.failGit.add("diff");
  assert.equal((await install(diffFails)).skipped, "INSTALL_UNREADABLE");
  const pending = fakeHost();
  pending.checks.runs = [{ name: "ci", status: "in_progress", conclusion: null }];
  assert.equal((await install(pending)).skipped, "INSTALL_NOT_READY");
  const none = fakeHost();
  none.checks.runs = [];
  assert.equal((await install(none)).skipped, "INSTALL_NOT_READY");
  const unreadable = fakeHost();
  unreadable.githubFails = true;
  assert.equal((await install(unreadable)).skipped, "INSTALL_NOT_READY");
  for (const host of [fetchFails, diffFails, pending, none, unreadable]) {
    assert.equal([...host.files.keys()].some((file) => file.includes("card-install-auto-")), false);
    assert.equal(host.reports.length, 0);
    untouched(host);
  }
  const red = fakeHost();
  red.checks.runs = [{ name: "ci", status: "completed", conclusion: "failure" }];
  const out = await install(red);
  assert.equal(out.result?.outcome, "NEEDS_OWNER");
  assert.match(out.result?.reason, /red: ci: failure/);
  untouched(red);
});

test("SHU-322 B9: a refusal is claimed exclusively, reported once on SHU-71 and never repeated", async () => {
  const host = fakeHost({ changes: [...CHANGES, { status: "M", path: ".github/coordinator/service/card-run.mjs" }] });
  const first = await install(host);
  assert.equal(first.result?.outcome, "NEEDS_OWNER");
  assert.equal(first.result?.report.posted, true);
  assert.equal(host.reports.length, 1);
  assert.match(host.reports[0], /NEEDS_OWNER/);
  assert.match(host.reports[0], /Nothing on the host changed\./);
  untouched(host);
  const claim = claimOf(host);
  assert.equal(claim.outcome, "NEEDS_OWNER");
  assert.equal(host.files.get(installClaim(PATHS, N)).mode, 0o600);
  assert.deepEqual(await install(host), { silent: true });
  assert.equal(host.reports.length, 1, "the owner hears about a main once");
  // Two starts racing: the claim is exclusive, so only one reports.
  const raced = fakeHost({ changes: [...CHANGES, { status: "M", path: ".github/coordinator/service/card-run.mjs" }] });
  raceClaim(raced);
  assert.deepEqual(await install(raced), { silent: true });
  assert.equal(raced.reports.length, 0);
  assert.equal(claimOf(raced).claimed_at, "another start");
  // The claim never reads as a landing or a review.
  assert.equal(/^card-run-auto-/.test(path.basename(installClaim(PATHS, N))), false);
  assert.equal(/^card-review-auto-/.test(path.basename(installClaim(PATHS, N))), false);
});

test("SHU-322 B10: a held lock or a busy host skips and gives the claim back", async () => {
  const locked = fakeHost();
  locked.put(PATHS.lock, "123");
  assert.equal((await install(locked)).skipped, "INSTALL_LOCKED");
  assert.equal(locked.files.has(installClaim(PATHS, N)), false);
  assert.equal(locked.files.get(PATHS.lock).text, "123", "another run's lock is left alone");
  const busy = fakeHost();
  busy.workers = true;
  const out = await install(busy);
  assert.equal(out.skipped, "INSTALL_HOST_BUSY");
  assert.equal(busy.files.has(installClaim(PATHS, N)), false);
  untouched(busy);
  // Two starts racing for the same main: the claim is exclusive, so only one installs.
  const raced = fakeHost();
  raceClaim(raced);
  assert.deepEqual(await install(raced), { silent: true });
  untouched(raced);
  assert.equal(claimOf(raced).claimed_at, "another start");
  // The run holds the lock while it installs.
  const held = fakeHost();
  held.onStep = (h, name) => { if (name === "merge") assert.equal(h.files.has(PATHS.lock), true, "the merge runs under the card-run lock"); };
  assert.equal((await install(held)).result?.outcome, "INSTALLED");
});

test("SHU-322 B11: the pause file is read again before every step and stops the install there", async () => {
  // Before anything on the host changes, a pause gives the main back.
  const early = fakeHost();
  early.put(PATHS.pause, "owner pause\n");
  assert.equal((await install(early)).paused, true);
  assert.equal(early.files.has(installClaim(PATHS, N)), false);
  untouched(early);
  const steps = INSTALL_ORDER.slice(1);
  for (const [i, before] of steps.entries()) {
    const host = fakeHost();
    host.onStep = (h, name) => { if (name === INSTALL_ORDER[i]) h.put(PATHS.pause, "owner pause\n"); };
    const out = await install(host);
    assert.equal(out.result?.outcome, "INSTALL_PAUSED", before);
    assert.deepEqual(host.steps, INSTALL_ORDER.slice(0, i + 1), `nothing runs after the pause appears before ${before}`);
    assert.equal(host.files.get(PATHS.pause).text, "owner pause\n", "the owner's pause file is left as it is");
    assert.equal(host.reports.length, 1);
    assert.equal(host.files.has(PATHS.lock), false);
  }
});

test("SHU-322 B12: any failed step writes the pause file with its reason and reports; R is never reinstalled", async () => {
  for (const [what, edit, done] of [
    ["merge", (h) => h.failGit.add("merge"), ["merge"]],
    ["fetch into the checkout", (h) => h.failGit.add("checkout-fetch"), ["merge"]],
    ["rollback of R", (h) => { h.provisionFails[`rollback ${R}`] = true; }, ["merge", `rollback ${R}`]],
    ["install of N", (h) => { h.provisionFails[`install ${N}`] = true; }, ["merge", `rollback ${R}`, `install ${N}`]],
  ]) {
    const host = fakeHost();
    edit(host);
    const out = await install(host);
    assert.equal(out.result?.outcome, "INSTALL_FAILED", what);
    assert.deepEqual(host.steps, done, what);
    assert.match(host.files.get(PATHS.pause)?.text ?? "", /^card-install: /, `${what}: the pause file names the reason`);
    assert.equal(out.result?.pause.written, true);
    assert.equal(out.result?.rollback, undefined, `${what}: nothing installed is rolled back`);
    assert.equal(host.calls.some((call) => call.includes(`${PROVISIONER} install ${R}`)), false, `${what}: R is never reinstalled`);
    assert.equal(host.reports.length, 1);
    assert.match(host.reports[0], /INSTALL_FAILED/);
    assert.equal(claimOf(host).outcome, "INSTALL_FAILED");
  }
});

test("SHU-322 B13: a verify or precondition failure rolls N back and pauses, and never reinstalls R", async () => {
  for (const action of ["verify", "precondition"]) {
    const host = fakeHost();
    host.provisionFails[`${action} ${N}`] = true;
    const out = await install(host);
    assert.equal(out.result?.outcome, "INSTALL_FAILED");
    assert.equal(out.result?.failed_step, action);
    assert.deepEqual(out.result?.rollback, { ok: true });
    assert.equal(host.steps.at(-1), `rollback ${N}`, `${action}: N's prerequisites come off`);
    assert.equal(host.calls.some((call) => call.includes(`${PROVISIONER} install ${R}`)), false);
    assert.equal(host.files.has(PATHS.pause), true);
    assert.match(host.reports[0], new RegExp(`Rolled back the prerequisites of ${N}; ${R} was not reinstalled\\.`));
  }
});

test("SHU-322 B14: the child plan check must show the new queue, its first card next and no refused preparation", async () => {
  const prepare = { branch: { action: "create" }, card: { action: "move-to-todo" } };
  for (const [what, plan, status] of [
    ["a nonzero exit", null, 2],
    ["another queue", { queue: ["SHU-401", "SHU-403"], next: { id: "SHU-401" }, prepare, queued: [{ id: "SHU-401", prepare }, { id: "SHU-403", prepare }] }, 0],
    ["another next card", { queue: NEW_IDS, next: { id: "SHU-402" }, prepare, queued: NEW_IDS.map((id) => ({ id, prepare })) }, 0],
    ["no next card", { queue: NEW_IDS, next: { id: null, skipped: "QUEUE_STOPPED" }, prepare, queued: NEW_IDS.map((id) => ({ id, prepare })) }, 0],
    ["a refused preparation", { queue: NEW_IDS, next: { id: "SHU-401" }, prepare, queued: [{ id: "SHU-401", prepare }, { id: "SHU-402", prepare: { refused: "CARD_RUN_CARD_STATE", reason: "SHU-402 is Done" } }] }, 0],
    ["a refused next preparation", { queue: NEW_IDS, next: { id: "SHU-401" }, prepare: { refused: "CARD_RUN_CARD_OWNED" }, queued: NEW_IDS.map((id) => ({ id, prepare })) }, 0],
  ]) {
    const host = fakeHost();
    host.plan = plan;
    host.planStatus = status;
    const out = await install(host);
    assert.equal(out.result?.outcome, "INSTALL_FAILED", what);
    assert.equal(out.result?.failed_step, "plan", what);
    assert.equal(host.files.has(PATHS.pause), true, what);
    assert.equal(out.result?.rollback, undefined, `${what}: a plan failure does not roll back`);
  }
});

test("SHU-322 B15: the timer only ever creates the pause file", async () => {
  const source = fs.readFileSync(path.join(HERE, "..", "service", "card-install.mjs"), "utf8");
  assert.doesNotMatch(source, /unlinkSync\(paths\.pause|rmSync\(paths\.pause|renameSync\(paths\.pause/);
  assert.match(source, /writeFileSync\(paths\.pause, [^\n]*flag: "wx"/);
  const host = fakeHost();
  host.provisionFails[`install ${N}`] = true;
  host.onStep = (h, name) => { if (name === `install ${N}`) h.put(PATHS.pause, "earlier\n"); };
  const out = await install(host);
  assert.equal(out.result?.outcome, "INSTALL_FAILED");
  assert.equal(host.files.get(PATHS.pause).text, "earlier\n");
  assert.equal(out.result?.pause.written, false);
});

test("SHU-322 B16: a done queue's timer start runs Card B first, then the review, and a stopped queue never installs", async () => {
  const io = (host) => ({ io: host.io, paths: PATHS });
  // Installed: the start ends there; the review never runs.
  const installs = fakeHost();
  const result = await autoRun(io(installs));
  assert.equal(result.kind, "install");
  assert.equal(result.outcome, "INSTALLED");
  assert.equal(installs.github.some((entry) => entry.startsWith("pulls")), false, "no review after an install");
  // Nothing to install: the review runs as before and is the plain skip.
  const nothing = fakeHost({ main: R });
  const skipped = await autoRun(io(nothing));
  assert.equal(skipped.skipped, "QUEUE_DONE");
  assert.equal(skipped.install, undefined);
  assert.ok(nothing.github.some((entry) => entry.startsWith("pulls")), "the review reads the open pull requests");
  // A failed read: the review still runs, and the skip says why nothing installed.
  const unread = fakeHost();
  unread.failGit.add("fetch");
  const review = await autoRun(io(unread));
  assert.equal(review.skipped, "QUEUE_DONE");
  assert.equal(review.install.skipped, "INSTALL_UNREADABLE");
  // A pause seen by Card B stops the start: no review either.
  const paused = fakeHost();
  const realExists = paused.fs.existsSync;
  let reads = 0;
  paused.fs.existsSync = (file) => (file === PATHS.pause ? (reads += 1) > 1 : realExists(file));
  const stop = await autoRun(io(paused));
  assert.equal(stop.skipped, "PAUSED");
  assert.equal(paused.github.some((entry) => entry.startsWith("pulls")), false);
  // A stopped queue never reaches Card B.
  const stopped = fakeHost();
  stopped.put(autoClaim(PATHS, R, "SHU-316"), JSON.stringify({ card: "SHU-316", revision: R, outcome: "STOPPED", ok: false, land: null }));
  const halted = await autoRun(io(stopped));
  assert.equal(halted.skipped, "QUEUE_STOPPED");
  assert.equal(stopped.calls.some((call) => call.startsWith("runuser")), false, "main is never read");
});

test("SHU-322 B17: the report and claim name main, the installed revision, the queue and every step", async () => {
  const host = fakeHost();
  const out = await install(host);
  const claim = claimOf(host);
  assert.deepEqual({ main: claim.main, revision: claim.revision, queue: claim.queue, outcome: claim.outcome, ok: claim.ok },
    { main: N, revision: R, queue: NEW_IDS, outcome: "INSTALLED", ok: true });
  assert.deepEqual(claim.steps, out.result?.steps);
  const text = renderInstallReport(out.result);
  assert.match(text, new RegExp(`main at ${N} over installed revision ${R}`));
  assert.match(text, /Steps done: claim, idle, merge, rollback, install, verify, precondition, plan\./);
  assert.match(text, /the next timer start runs SHU-401/);
});
