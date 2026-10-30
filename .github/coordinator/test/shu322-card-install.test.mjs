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
  CONFIG_PATH, CONTRACTS_PATH, CONTRACTS_SOURCE_PATH, INVENTORY_PATH, PROVISIONER, CARD_RUN,
  readApproval, ownerOnlyPath, codeInstallPolicy, OWNER_ONLY_PATHS, ROOT_INSTALL_TOOLS, contractChangeRefusal, RUNTIME_TEST_MODULES,
} from "../service/card-install.mjs";
import { autoRun, autoClaim, busyReasons, queueConfigPath, reviewClaim } from "../service/card-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_TEXT = fs.readFileSync(path.join(HERE, "..", "config.json"), "utf8");
const CONTRACTS_TEXT = fs.readFileSync(path.join(HERE, "..", "card-contracts.json"), "utf8");
const COMMITTED = JSON.parse(COMMITTED_TEXT);
// M16: the committed config turns code self-install on. The Card B tests read
// an installed revision with it off, as they always did; the M11 and M16 tests
// turn a policy on themselves.
const { code_self_install: _committedPolicy, ...QUEUE_ONLY } = COMMITTED;
const QUEUE_ONLY_TEXT = JSON.stringify(QUEUE_ONLY);
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
// with its own card added to the contracts data.
const lane = (id) => ({ ...structuredClone(COMMITTED.card_lanes.at(-1)), id, authorization_ref: id, note: `queued card ${id}` });
function nextConfig(edit = (config) => config) {
  const config = structuredClone(QUEUE_ONLY);
  config.card_lanes = [...config.card_lanes, ...NEW_IDS.map(lane)];
  config.dispatch_scope = { issue_ids: [...NEW_IDS] };
  return edit(config);
}
const newContract = (id) => ({ initial_build_paths: ["src/a.ts"], revision_paths: ["src/a.ts"], acceptance: `${id} holds`, brief: `Card ${id}.`, workspace_mode: "repo" });
// The contracts data, edited as an object and written as the generator does.
function contractsWith(edit, text = CONTRACTS_TEXT) {
  const data = JSON.parse(text);
  return `${JSON.stringify(edit(data) ?? data, null, 2)}\n`;
}
function nextContracts(ids = NEW_IDS) {
  return contractsWith((data) => { for (const id of ids) data.cards[id] = newContract(id); });
}
const CHANGES = Object.freeze([
  { status: "M", path: CONFIG_PATH }, { status: "M", path: CONTRACTS_PATH }, { status: "A", path: TEST_PATH },
]);

// Facts as readMainFacts returns them for an admissible main.
function facts(edit = (value) => value) {
  return edit({
    revision: R, main: N, descends: true, changes: structuredClone(CHANGES),
    blobs: { ...BLOBS }, configs: { installed: QUEUE_ONLY_TEXT, main: JSON.stringify(nextConfig()) },
    contractTexts: { installed: CONTRACTS_TEXT, main: nextContracts() },
    passes: [{ pr: 300, head: PR_HEAD, files: Object.fromEntries(Object.entries(BLOBS).map(([file, sha]) => [file, { sha }])) }],
    landed: [], checks: { green: true },
  });
}
const refused = (gate) => gate.ok === false && gate.transient === false && gate.quiet === false;

// A fake orchestrator host for the whole timer start: files, the installed
// checkout, the coordinator's bare repository and its view of main, the
// provisioner, N's plan, GitHub and Linear.
function fakeHost({ config = QUEUE_ONLY, main = N, mainConfig = nextConfig(), changes = CHANGES,
  blobs = BLOBS, mainContracts = nextContracts(), landedQueue = true, installedConfigText = QUEUE_ONLY_TEXT } = {}) {
  const files = new Map();
  const host = {
    files, calls: [], reports: [], github: [], steps: [], clock: START.getTime(), head: R, branch: R, main, descends: true,
    changes, blobs, failGit: new Set(), provisionFails: {}, checks: { runs: [{ name: "ci", status: "completed", conclusion: "success" }], statuses: [] },
    plan: null, planStatus: 0, pushDir: null, merged: false, onStep: null,
    // M11: the pull requests GitHub serves, by number: { user, reviews }.
    pulls: {}, restoreFails: false,
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
    [`${R}:${CONFIG_PATH}`, installedConfigText], [`${main}:${CONFIG_PATH}`, JSON.stringify(mainConfig)],
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
      // M11: putting R back after a failed code install.
      if (verb === "checkout") {
        step(`checkout ${rest.at(-1)}`);
        assert.deepEqual(rest, ["-q", "-B", "main", R]);
        if (host.restoreFails) return fail(1);
        host.head = R; host.branch = R;
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
    const pull = /^pulls\/(\d+)(\/reviews\?per_page=100)?$/.exec(url.slice(api.length + 1));
    if (pull && host.pulls[pull[1]]) {
      const served = host.pulls[pull[1]];
      return pull[2] ? respond(200, served.reviews) : respond(200, { number: Number(pull[1]), user: served.user });
    }
    return respond(404, null);
  };
  host.io = { fs: host.fs, exec: host.exec, fetch: host.fetch, uid: () => 0, now: () => new Date(host.clock), sleep: () => {}, delay: async () => {}, nodePath: () => NODE };
  return host;
}

const deps = { busyReasons, cardLanded: async (io, paths, id) => io.fs.existsSync(autoClaim(paths, R, id)) };
const install = (host, config = QUEUE_ONLY) => selfInstall({ io: host.io, paths: PATHS, config, revision: R, deps });
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

test("SHU-322 B3: card-contracts.json may only gain cards", () => {
  const withContracts = (main) => facts((f) => ({ ...f, contractTexts: { ...f.contractTexts, main } }));
  const created = selfInstallGate(facts((f) => ({ ...f, changes: f.changes.map((c) => (c.path === CONTRACTS_PATH ? { ...c, status: "A" } : c)) })));
  assert.ok(refused(created));
  assert.match(created.reason, /card-contracts\.json may only gain cards: it is not an edit/);
  const [installedId] = Object.keys(JSON.parse(CONTRACTS_TEXT).cards);
  const edited = selfInstallGate(withContracts(contractsWith((data) => { data.cards[installedId].brief += " and more"; }, nextContracts())));
  assert.ok(refused(edited));
  assert.match(edited.reason, new RegExp(`may only gain cards: it changes ${installedId}$`));
  const removed = selfInstallGate(withContracts(contractsWith((data) => { delete data.cards[installedId]; }, nextContracts())));
  assert.ok(refused(removed));
  assert.match(removed.reason, new RegExp(`it removes ${installedId}$`));
  assert.equal(contractEntries(CONTRACTS_TEXT).has("SHU-304"), false, "a review-only card is not a contract entry");
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
    "an unknown card": (c) => ({ ...c, dispatch_scope: { issue_ids: ["SHU-401", "SHU-999"] } }),
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
  assert.match(laneless.reason, /SHU-403 in the new dispatch_scope is neither a newly appended nor an installed card lane/);
  const landed = selfInstallGate(facts((f) => ({ ...f, landed: ["SHU-402"] })));
  assert.ok(refused(landed));
  assert.match(landed.reason, /already landed/);
  const uncontracted = selfInstallGate(facts((f) => ({ ...f, contractTexts: { ...f.contractTexts, main: nextContracts(["SHU-401"]) } })));
  assert.ok(refused(uncontracted));
  assert.match(uncontracted.reason, /SHU-402 has no CARD_CONTRACTS entry/);
  assert.deepEqual([...contractEntries(nextContracts())].slice(-2), NEW_IDS);
  // A main whose queue is the installed one is nothing to install.
  const same = selfInstallGate(facts((f) => ({ ...f, configs: { ...f.configs, main: QUEUE_ONLY_TEXT } })));
  assert.equal(same.quiet, true);
});

test("SHU-322 B5: every changed coordinator blob must be one a root-owned REVIEW_PASS claim recorded at an exact head", async () => {
  const unbound = selfInstallGate(facts((f) => ({ ...f, blobs: { ...f.blobs, [TEST_PATH]: "5".repeat(40) } })));
  assert.ok(refused(unbound));
  assert.match(unbound.reason, /are not the blobs one REVIEW_PASS claim recorded/);
  assert.ok(refused(selfInstallGate(facts((f) => ({ ...f, passes: [] })))));
  // Each blob passed, but in two different pull requests: not one review.
  const split = selfInstallGate(facts((f) => {
    const [first, ...rest] = Object.keys(f.passes[0].files);
    const pick = (keys) => Object.fromEntries(keys.map((key) => [key, f.passes[0].files[key]]));
    return { ...f, passes: [{ pr: 300, head: PR_HEAD, files: pick([first]) }, { pr: 301, head: "e".repeat(40), files: pick(rest) }] };
  }));
  assert.ok(refused(split), "blobs passed in separate pull requests are not one review");
  const read = (edit) => {
    const host = fakeHost();
    edit(host);
    return reviewPasses(host.io, PATHS);
  };
  assert.equal(read(() => {}).length, 1);
  const claimFile = reviewClaim(PATHS, 300, PR_HEAD);
  const rewrite = (host, change, extra = {}) => host.put(claimFile, JSON.stringify({ ...JSON.parse(host.files.get(claimFile).text), ...change }), { mode: 0o600, ...extra });
  assert.deepEqual(read((host) => rewrite(host, { outcome: "REVIEW_BLOCKED" })), [], "a blocked review binds nothing");
  // The supervisor ends a passed review-only episode as "review PASS", which card-run records as PASS.
  assert.equal(read((host) => rewrite(host, { outcome: "PASS" })).length, 1, "a review recorded as PASS binds");
  assert.deepEqual(read((host) => rewrite(host, { outcome: "STOPPED" })), [], "a stopped review binds nothing");
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
  const unchanged = fakeHost({ mainConfig: QUEUE_ONLY, changes: [{ status: "A", path: TEST_PATH }] });
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

test("SHU-322 B16: a done or stopped queue's timer start runs Card B first, then the review", async () => {
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
  // M16: a stopped queue reaches Card B too, and installs main's queue.
  const last = COMMITTED.dispatch_scope.issue_ids.at(-1);
  const stopAt = (host) => host.put(autoClaim(PATHS, R, last), JSON.stringify({ card: last, revision: R, outcome: "STOPPED", ok: false, land: null }));
  const stopped = fakeHost();
  stopAt(stopped);
  const restarted = await autoRun(io(stopped));
  assert.equal(restarted.kind, "install", JSON.stringify(restarted));
  assert.equal(restarted.outcome, "INSTALLED");
  assert.equal(stopped.github.some((entry) => entry.startsWith("pulls")), false, "no review after an install");
  // With nothing to install it reviews, and with nothing to review it is the
  // stopped skip with its reason.
  const halted = fakeHost({ main: R });
  stopAt(halted);
  const held = await autoRun(io(halted));
  assert.equal(held.skipped, "QUEUE_STOPPED");
  assert.match(held.reason, new RegExp(`^${last} ran at ${R} and did not land \\(STOPPED\\)`));
  assert.ok(halted.github.some((entry) => entry.startsWith("pulls")), "the review reads the open pull requests");
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

test("SHU-322 B18: a failed install whose pause cannot be put in place keeps the card-run lock, so later starts skip", async () => {
  const io = (host) => ({ io: host.io, paths: PATHS });
  const failures = [
    ["merge", (h) => h.failGit.add("merge")],
    ["rollback of R", (h) => { h.provisionFails[`rollback ${R}`] = true; }],
    ["install of N", (h) => { h.provisionFails[`install ${N}`] = true; }],
    ["verify of N", (h) => { h.provisionFails[`verify ${N}`] = true; }],
    ["precondition of N", (h) => { h.provisionFails[`precondition ${N}`] = true; }],
    ["plan check", (h) => { h.plan = null; h.planStatus = 2; }],
  ];
  for (const [what, edit] of failures) {
    const host = fakeHost();
    edit(host);
    const write = host.fs.writeFileSync;
    host.fs.writeFileSync = (file, text, options) => {
      if (file === PATHS.pause) throw Object.assign(new Error(`EIO ${file}`), { code: "EIO" });
      return write(file, text, options);
    };
    const out = await install(host);
    assert.equal(out.result?.outcome, "INSTALL_FAILED", what);
    assert.deepEqual(out.result?.pause, { written: false, held: false, code: "EIO" }, what);
    assert.equal(out.result?.lock_kept, true, what);
    assert.equal(host.files.has(PATHS.pause), false, what);
    assert.equal(host.files.has(PATHS.lock), true, `${what}: the card-run lock is kept`);
    assert.match(renderInstallReport(out.result), /the card-run lock is kept/, what);
    const next = await autoRun(io(host));
    assert.equal(next.skipped, "LOCKED", `${what}: the next timer start cannot proceed`);
  }
  // Something other than a plain file at the pause path is not a pause.
  const odd = fakeHost();
  odd.provisionFails[`install ${N}`] = true;
  odd.onStep = (h, name) => { if (name === `install ${N}`) h.put(PATHS.pause, "link\n"); };
  const lstat = odd.fs.lstatSync;
  odd.fs.lstatSync = (file) => (file === PATHS.pause ? { ...lstat(file), isSymbolicLink: () => true } : lstat(file));
  const out = await install(odd);
  assert.equal(out.result?.pause.held, false);
  assert.equal(odd.files.has(PATHS.lock), true, "a symlink at the pause path keeps the lock");
  // A plain pause file already in place releases the lock as before.
  const plain = fakeHost();
  plain.provisionFails[`install ${N}`] = true;
  plain.onStep = (h, name) => { if (name === `install ${N}`) h.put(PATHS.pause, "earlier\n"); };
  const held = await install(plain);
  assert.deepEqual(held.result?.pause, { written: false, held: true, code: "EEXIST" });
  assert.equal(held.result?.lock_kept, undefined);
  assert.equal(plain.files.has(PATHS.lock), false);
});

test("SHU-322 B19: a refused install writes a finished status, so the watch never reads its start as a run that died", async () => {
  // 2026-10-21: the 13:30 start refused to install 34f603f8 and wrote no status;
  // the watch paused the timer on the failed unit, holding the queue installed by hand.
  const { readStatus, stuckRun } = await import("../service/card-watchdog.mjs");
  const host = fakeHost({ changes: [...CHANGES, { status: "M", path: ".github/coordinator/service/card-run.mjs" }] });
  const started = host.io.now().getTime();
  const out = await autoRun({ io: host.io, paths: PATHS });
  assert.equal(out.outcome, "NEEDS_OWNER");
  untouched(host);
  const status = readStatus(host.io, PATHS);
  assert.ok(status, "the status file is written and valid");
  assert.equal(status.step, "finished");
  assert.equal(status.run_id, out.activation_id);
  assert.equal(status.kind, "install");
  assert.equal(status.outcome, "NEEDS_OWNER");
  assert.equal(status.queue.length > 0, true);
  assert.equal(status.trigger, "timer");
  assert.equal(status.card, null);
  assert.equal(status.revision, R);
  assert.equal(status.needs_owner, true);
  const unit = { state: "failed", running: false, since: Math.floor(started / 1000) * 1000, start: "42" };
  assert.equal(stuckRun({ unit, status, now: started + 30 * 60 * 1000 }), null, "a refused install is not a run that died");
  assert.equal(stuckRun({ unit, status: null, now: started + 30 * 60 * 1000 })?.kind, "failed", "without the status it would be");
  assert.equal(host.files.has(PATHS.pause), false);
  // An install that went through, or nothing to install, writes no such status.
  const installs = fakeHost();
  assert.equal((await autoRun({ io: installs.io, paths: PATHS })).outcome, "INSTALLED");
  assert.equal(readStatus(installs.io, PATHS)?.outcome ?? null, null);
});

test("SHU-322 B20: every card in the committed queue has a contract entry Card B can read", () => {
  const config = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.json"), "utf8"));
  const entries = contractEntries(CONTRACTS_TEXT);
  for (const id of config.dispatch_scope.issue_ids) assert.ok(entries.has(id), `${id} has a contract entry on its own line`);
});

// M11: the box installs reviewed coordinator code itself once the installed
// config turns code_self_install on, with the policy's approval, and puts the
// installed revision back when the code install fails after the merge.
const CODE_PATH = ".github/coordinator/service/card-watch.mjs";
const CODE_BLOB = "6".repeat(40);
const CODE_PR = 310;
const CODE_HEAD = "c".repeat(40);
const APPROVER = "khalid-approves";
const withPolicy = (policy) => ({ ...structuredClone(COMMITTED), code_self_install: policy });
const REVIEW_POLICY = { approval: "github_review", approvers: [APPROVER] };
function codeFacts(policy = REVIEW_POLICY, edit = (value) => value) {
  const installed = JSON.stringify(withPolicy(policy));
  return edit({
    revision: R, main: N, descends: true, changes: [{ status: "M", path: CODE_PATH }],
    blobs: { [CODE_PATH]: CODE_BLOB }, configs: { installed, main: installed },
    contractTexts: { installed: CONTRACTS_TEXT, main: CONTRACTS_TEXT },
    passes: [{ pr: CODE_PR, head: CODE_HEAD, files: { [CODE_PATH]: { sha: CODE_BLOB } } }],
    landed: [], checks: { green: true }, approval: { pr: CODE_PR, head: CODE_HEAD, approved: true, by: APPROVER },
  });
}
// A host whose installed revision has the policy on and whose main adds one
// reviewed, approved code change and the same queue.
function codeHost(policy = REVIEW_POLICY, { approved = true } = {}) {
  const config = withPolicy(policy);
  const host = fakeHost({ config, installedConfigText: JSON.stringify(config), mainConfig: config,
    changes: [{ status: "M", path: CODE_PATH }], blobs: { [CODE_PATH]: CODE_BLOB }, mainContracts: CONTRACTS_TEXT });
  host.put(reviewClaim(PATHS, CODE_PR, CODE_HEAD), JSON.stringify({ pr: CODE_PR, head: CODE_HEAD, base: R, revision: R, outcome: "REVIEW_PASS",
    files: { [CODE_PATH]: { sha: CODE_BLOB, additions: 3, deletions: 1 } } }), { mode: 0o600 });
  host.pulls[CODE_PR] = { user: { login: "BAWES" },
    reviews: approved ? [{ user: { login: APPROVER }, state: "APPROVED", commit_id: CODE_HEAD }] : [] };
  // N's plan at a done queue: no next card, every queued card landed.
  const queue = config.dispatch_scope.issue_ids;
  host.plan = { queue, next: { id: null, skipped: "QUEUE_DONE" }, busy: [], queued: queue.map((id) => ({ id, prepare: { skipped: "LANDED" } })) };
  return host;
}
const RESTORE_ORDER = [`rollback ${N}`, `checkout ${R}`, `install ${R}`, `verify ${R}`, `precondition ${R}`];

test("M11 C1: reviewed coordinator code installs only with the installed policy on, its approval at the passed head, and green checks", () => {
  const admitted = selfInstallGate(codeFacts());
  assert.deepEqual(admitted, { ok: true, queue: null, lanes: [], code: [CODE_PATH], approval: { pr: CODE_PR, head: CODE_HEAD, by: APPROVER } });
  const unread = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, approval: undefined })));
  assert.equal(unread.transient, true, "an approval not read yet is read, never refused");
  assert.deepEqual(unread.needs, { approval: { pr: CODE_PR, head: CODE_HEAD, approvers: [APPROVER] } });
  for (const approval of [{ pr: CODE_PR, head: CODE_HEAD, approved: false, note: "none" }, { pr: CODE_PR, head: "f".repeat(40), approved: true, by: APPROVER },
    { pr: 999, head: CODE_HEAD, approved: true, by: APPROVER }]) {
    const gate = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, approval })));
    assert.equal(gate.ok, false);
    assert.equal(gate.transient, true, `${JSON.stringify(approval)} waits for a tap`);
  }
  assert.deepEqual(selfInstallGate(codeFacts({ approval: "none" }, (f) => ({ ...f, approval: undefined }))),
    { ok: true, queue: null, lanes: [], code: [CODE_PATH], approval: { pr: CODE_PR, head: CODE_HEAD, by: null } }, "approval none needs only the review");
  // With the policy off or malformed, code stays a person's install as before.
  for (const policy of [null, { approval: "github_review", approvers: [] }, { approval: "github_review" }, { approval: "always" },
    { approval: "none", approvers: [APPROVER] }, { approval: "github_review", approvers: ["not a login!"] }]) {
    const gate = selfInstallGate(codeFacts(policy));
    assert.equal(gate.quiet, true, `${JSON.stringify(policy)}: code with the installed queue is nothing to install`);
    assert.equal(codeInstallPolicy({ code_self_install: policy }), null);
  }
  const offWithQueue = selfInstallGate(facts((f) => ({ ...f, changes: [...f.changes, { status: "M", path: CODE_PATH }], blobs: { ...f.blobs, [CODE_PATH]: CODE_BLOB } })));
  assert.ok(refused(offWithQueue));
  assert.match(offWithQueue.reason, /is not a queue config path/);
  // The policy is read from the installed revision: main turning it on installs nothing.
  const selfEnabled = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, configs: { installed: QUEUE_ONLY_TEXT, main: f.configs.main } })));
  assert.equal(selfEnabled.quiet, true, "main's own policy never lets main in");
  const red = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, checks: { red: ["ci"] } })));
  assert.ok(refused(red));
  const unreviewed = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, blobs: { [CODE_PATH]: "7".repeat(40) } })));
  assert.ok(refused(unreviewed));
  assert.match(unreviewed.reason, /REVIEW_PASS/);
});

test("M11 C2: the paths that install or check everything else as root, and the policy itself, stay a person's install", () => {
  const extras = [...OWNER_ONLY_PATHS, ".github/coordinator/service/userns-profile/profile", ".github/coordinator/host-tick.sh",
    ".github/coordinator/service/shu-supervisor.service.in", ".github/coordinator/service/shu-coordinator.timer.in"];
  for (const file of extras) {
    assert.equal(ownerOnlyPath(file), true, file);
    const gate = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, changes: [...f.changes, { status: "M", path: file }],
      blobs: { ...f.blobs, [file]: "8".repeat(40) }, passes: [{ ...f.passes[0], files: { ...f.passes[0].files, [file]: { sha: "8".repeat(40) } } }] })));
    assert.ok(refused(gate), file);
    assert.match(gate.reason, /is installed only by a person/, file);
  }
  assert.equal(ownerOnlyPath(".github/coordinator/test/card-install.test.mjs"), false, "a test file is never owner-only");
  assert.equal(ownerOnlyPath(CODE_PATH), false);
  const outside = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, changes: [...f.changes, { status: "M", path: ".github/workflows/ci.yml" }] })));
  assert.ok(refused(outside));
  const policyEdit = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f,
    configs: { ...f.configs, main: JSON.stringify(withPolicy({ approval: "none" })) }, changes: [...f.changes, { status: "M", path: CONFIG_PATH }],
    blobs: { ...f.blobs, [CONFIG_PATH]: "9".repeat(40) }, passes: [{ ...f.passes[0], files: { ...f.passes[0].files, [CONFIG_PATH]: { sha: "9".repeat(40) } } }] })));
  assert.ok(refused(policyEdit));
  assert.match(policyEdit.reason, /config\.json changes code_self_install/);
  const deleted = selfInstallGate(codeFacts(REVIEW_POLICY, (f) => ({ ...f, changes: [{ status: "D", path: CODE_PATH }] })));
  assert.ok(refused(deleted));
  assert.match(deleted.reason, /deleted/);
});

test("M11 C7: every module the root install tools import, at any depth, is owner-only or installable", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const relative = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  const seen = new Set();
  const stack = [...ROOT_INSTALL_TOOLS];
  while (stack.length) {
    const file = stack.pop();
    // Import-like text inside a quoted brief or fixture names no real module.
    if (seen.has(file) || !fs.existsSync(path.join(repo, file))) continue;
    seen.add(file);
    const text = fs.readFileSync(path.join(repo, file), "utf8");
    for (const [, spec] of text.matchAll(relative)) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  }
  assert.ok(seen.size > ROOT_INSTALL_TOOLS.length, "the closure follows imports");
  for (const file of seen) {
    assert.ok(installablePath(file) || ownerOnlyPath(file), `${file} runs inside a root install tool, so it is owner-only or installable`);
  }
  // M16: no installable module runs inside them: the card contracts reach
  // them as data, through card-contracts-reader.mjs (M16 Q3).
  assert.deepEqual([...seen].filter((file) => installablePath(file)), []);
  assert.ok(seen.has(".github/coordinator/card-contracts-reader.mjs"), "the closure reads the contracts through the reader");
  // card-run.mjs runs as root too (its unit and the install's plan step). It
  // is code, a person's install while code_self_install is off, and nothing
  // it imports is a queue's to change.
  const closure = (start) => {
    const found = new Set();
    const pending = [start];
    while (pending.length) {
      const file = pending.pop();
      if (found.has(file) || !fs.existsSync(path.join(repo, file))) continue;
      found.add(file);
      for (const [, spec] of fs.readFileSync(path.join(repo, file), "utf8").matchAll(relative)) pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
    }
    return found;
  };
  const cardRun = closure(CARD_RUN);
  assert.ok(cardRun.has(".github/coordinator/card-contracts-reader.mjs"));
  assert.deepEqual([...cardRun].filter((file) => installablePath(file)), [], "card-run.mjs imports nothing a queue installs");
  for (const tool of ROOT_INSTALL_TOOLS) assert.equal(ownerOnlyPath(tool), true, tool);
});

test("M11 C3: an approval counts only from a listed approver who is not the author, by their latest decision, at the exact head", async () => {
  const served = (user, reviews, status = 200) => async (method, url) => {
    assert.equal(method, "GET");
    const body = url.endsWith("/reviews?per_page=100") ? reviews : { user: { login: user } };
    return { ok: status < 300, status, json: async () => body };
  };
  const ask = (gh, approvers = [APPROVER]) => readApproval(gh, REPO, { pr: CODE_PR, head: CODE_HEAD, approvers });
  const approve = (login, commit = CODE_HEAD, state = "APPROVED") => ({ user: { login }, state, commit_id: commit });
  assert.deepEqual(await ask(served("BAWES", [approve(APPROVER)])), { pr: CODE_PR, head: CODE_HEAD, approved: true, by: APPROVER });
  assert.equal((await ask(served("BAWES", [approve("Khalid-Approves")]))).approved, true, "logins compare without case");
  assert.equal((await ask(served(APPROVER, [approve(APPROVER)]))).approved, false, "the author's own approval does not count");
  assert.equal((await ask(served("BAWES", [approve("someone-else")]))).approved, false, "only a listed approver counts");
  assert.equal((await ask(served("BAWES", [approve(APPROVER, "f".repeat(40))]))).approved, false, "an approval of another head does not count");
  assert.equal((await ask(served("BAWES", [approve(APPROVER), approve(APPROVER, CODE_HEAD, "CHANGES_REQUESTED")]))).approved, false, "a later change request wins");
  assert.equal((await ask(served("BAWES", [approve(APPROVER), approve(APPROVER, CODE_HEAD, "DISMISSED")]))).approved, false, "a dismissed approval does not count");
  assert.equal((await ask(served("BAWES", [approve(APPROVER), approve(APPROVER, CODE_HEAD, "COMMENTED")]))).approved, true, "a comment changes nothing");
  assert.equal((await ask(served("BAWES", [approve(APPROVER)], 502))).approved, false);
  assert.equal((await ask(served("BAWES", Array.from({ length: 100 }, () => approve(APPROVER))))).approved, false, "a full page is not read as complete");
});

test("M11 C4: an approved code change installs in order, reports as a code install and leaves the queue as it was", async () => {
  const host = codeHost();
  const out = await install(host, withPolicy(REVIEW_POLICY));
  const result = out.result ?? {};
  assert.equal(result.outcome, "INSTALLED", JSON.stringify(result));
  assert.equal(result.queue, null);
  assert.deepEqual(result.code, [CODE_PATH]);
  assert.deepEqual(result.approval, { pr: CODE_PR, head: CODE_HEAD, by: APPROVER });
  assert.deepEqual(host.steps, INSTALL_ORDER);
  assert.ok(host.github.includes(`pulls/${CODE_PR}/reviews?per_page=100`), "the approval was read from GitHub");
  assert.equal(host.reports.length, 1);
  assert.match(host.reports[0], new RegExp(`Code install of main at ${N} over installed revision ${R}: INSTALLED`));
  assert.match(host.reports[0], new RegExp(`Code: 1 coordinator file\\(s\\) from pull request #${CODE_PR} at ${CODE_HEAD}, approved by ${APPROVER}\\.`));
  assert.deepEqual(claimOf(host).code, [CODE_PATH]);
  assert.equal(JSON.parse(host.files.get(PATHS.receipt).text).revision, N);
  assert.equal(host.files.has(PATHS.pause), false);
  assert.equal(host.files.has(PATHS.lock), false);
  // With the approval missing, nothing is claimed or touched, and a later start reads it again.
  const waiting = codeHost(REVIEW_POLICY, { approved: false });
  const skipped = await install(waiting, withPolicy(REVIEW_POLICY));
  assert.equal(skipped.skipped, "INSTALL_NOT_READY");
  assert.match(skipped.reason, /waits on an Approve/);
  assert.equal([...waiting.files.keys()].some((file) => file.includes("card-install-auto-")), false);
  untouched(waiting);
  // Approval none reads no reviews.
  const reviewOnly = codeHost({ approval: "none" }, { approved: false });
  assert.equal((await install(reviewOnly, withPolicy({ approval: "none" }))).result?.outcome, "INSTALLED");
  assert.equal(reviewOnly.github.some((entry) => entry.startsWith("pulls/")), false);
});

test("M11 C5: a code install that fails after the merge puts the installed revision back and does not pause", async () => {
  const planFails = codeHost();
  planFails.planStatus = 1;
  const out = (await install(planFails, withPolicy(REVIEW_POLICY))).result ?? {};
  assert.equal(out.outcome, "INSTALL_RESTORED", JSON.stringify(out));
  assert.equal(out.failed_step, "plan");
  assert.deepEqual(planFails.steps, [...INSTALL_ORDER, ...RESTORE_ORDER]);
  assert.deepEqual(out.restored, { ok: true, steps: ["rollback", "checkout", "install", "verify", "precondition"] });
  assert.equal(JSON.parse(planFails.files.get(PATHS.receipt).text).revision, R, "R's prerequisites are installed again");
  assert.equal(planFails.head, R);
  assert.equal(planFails.files.has(PATHS.pause), false, "the box keeps running R");
  assert.equal(planFails.files.has(PATHS.lock), false);
  assert.match(planFails.reports[0], new RegExp(`INSTALL_RESTORED.*\\n[\\s\\S]*Put ${R} back: rollback, checkout, install, verify, precondition\\.`));
  assert.equal(claimOf(planFails).outcome, "INSTALL_RESTORED", "N is never tried again at this claim");
  // A verify failure already rolled N back, so R goes straight back on.
  const verifyFails = codeHost();
  verifyFails.provisionFails[`verify ${N}`] = true;
  const verified = (await install(verifyFails, withPolicy(REVIEW_POLICY))).result ?? {};
  assert.equal(verified.outcome, "INSTALL_RESTORED");
  assert.deepEqual(verifyFails.steps.slice(-5), [`rollback ${N}`, `checkout ${R}`, `install ${R}`, `verify ${R}`, `precondition ${R}`]);
  assert.equal(verifyFails.steps.filter((entry) => entry === `rollback ${N}`).length, 1, "N is rolled back once");
});

test("M11 C6: when the installed revision cannot be put back, the host pauses as before", async () => {
  for (const [name, edit] of [["checkout", (h) => { h.restoreFails = true; }], ["install", (h) => { h.provisionFails[`install ${R}`] = true; }]]) {
    const host = codeHost();
    host.planStatus = 1;
    edit(host);
    const out = (await install(host, withPolicy(REVIEW_POLICY))).result ?? {};
    assert.equal(out.outcome, "INSTALL_FAILED", name);
    assert.equal(out.restored?.ok, false, name);
    assert.equal(out.pause?.written, true, name);
    assert.ok(host.files.has(PATHS.pause), name);
    assert.match(host.reports[0], new RegExp(`Putting ${R} back failed after`), name);
  }
  // A queue-only install keeps its old rule: R is never reinstalled by the box.
  const queue = fakeHost();
  queue.planStatus = 1;
  const out = (await install(queue)).result ?? {};
  assert.equal(out.outcome, "INSTALL_FAILED");
  assert.equal(out.restored, undefined);
  assert.equal(queue.steps.includes(`install ${R}`), false);
});

// M16: no relay. A stopped queue is replaced by a re-cut queue: one new lane
// (the stopped card's, under a new id) first, the later installed lanes kept,
// the stopped card dropped. The shape of #342 over main at e584bb9.
const INSTALLED_SCOPE = QUEUE_ONLY.dispatch_scope.issue_ids;
const RECUT_ID = "SHU-401";
const RECUT_SCOPE = [RECUT_ID, ...INSTALLED_SCOPE.slice(1)];
function recutConfig(edit = (config) => config) {
  const config = structuredClone(QUEUE_ONLY);
  const stopped = config.card_lanes.find((entry) => entry.id === INSTALLED_SCOPE[0]);
  config.card_lanes = [...config.card_lanes, { ...structuredClone(stopped), id: RECUT_ID, authorization_ref: RECUT_ID, note: "the stopped card, re-cut" }];
  config.dispatch_scope = { issue_ids: [...RECUT_SCOPE] };
  return edit(config);
}
const recutFacts = (edit = (value) => value) => facts((f) => edit({ ...f, configs: { ...f.configs, main: JSON.stringify(recutConfig()) },
  contractTexts: { ...f.contractTexts, main: nextContracts([RECUT_ID]) } }));

test("M16 Q1: a re-cut queue of one new lane and later installed lanes that have not landed installs itself", () => {
  assert.ok(INSTALLED_SCOPE.length >= 2, "the committed queue has a later card to keep");
  assert.deepEqual(selfInstallGate(recutFacts()), { ok: true, queue: RECUT_SCOPE, lanes: [RECUT_ID] });
  // Each kept card must not have landed.
  const landed = selfInstallGate(recutFacts((f) => ({ ...f, landed: [INSTALLED_SCOPE[1]] })));
  assert.ok(refused(landed));
  assert.match(landed.reason, new RegExp(`${INSTALLED_SCOPE[1]} already landed`));
  // The first card of the new queue is a new lane: nextCard runs the first
  // card that has not landed, so the stopped card first would stop it again.
  const scoped = (ids) => selfInstallGate(recutFacts((f) => ({ ...f,
    configs: { ...f.configs, main: JSON.stringify(recutConfig((c) => ({ ...c, dispatch_scope: { issue_ids: ids } }))) } })));
  for (const ids of [[...INSTALLED_SCOPE.slice(1), INSTALLED_SCOPE[0]], [INSTALLED_SCOPE[0], RECUT_ID, ...INSTALLED_SCOPE.slice(1, 3)], [INSTALLED_SCOPE[1], RECUT_ID]]) {
    const gate = scoped(ids);
    assert.ok(refused(gate), JSON.stringify(ids));
    assert.match(gate.reason, new RegExp(`^${ids[0]}, first in the new dispatch_scope, is not a newly appended card lane`), JSON.stringify(ids));
  }
  assert.equal(scoped([RECUT_ID, INSTALLED_SCOPE[1]]).ok, true, "later installed lanes stay allowed");
  // A kept card still needs its contract entry at main.
  const kept = INSTALLED_SCOPE[1];
  const unkept = (text) => contractsWith((data) => { data.cards["SHU-9999"] = data.cards[kept]; delete data.cards[kept]; }, text);
  const uncontracted = selfInstallGate(recutFacts((f) => ({ ...f,
    contractTexts: { installed: unkept(f.contractTexts.installed), main: unkept(f.contractTexts.main) } })));
  assert.ok(refused(uncontracted));
  assert.match(uncontracted.reason, new RegExp(`${kept} has no CARD_CONTRACTS entry at main`));
  // The new lane still needs its own entry added at main, and lanes are only appended.
  const bare = selfInstallGate(recutFacts((f) => ({ ...f, contractTexts: { ...f.contractTexts, main: CONTRACTS_TEXT } })));
  assert.ok(refused(bare));
  assert.match(bare.reason, new RegExp(`${RECUT_ID} has no CARD_CONTRACTS entry added at main`));
  const edited = selfInstallGate(recutFacts((f) => ({ ...f, configs: { ...f.configs,
    main: JSON.stringify(recutConfig((c) => ({ ...c, card_lanes: c.card_lanes.filter((entry) => entry.id !== INSTALLED_SCOPE[0]) }))) } })));
  assert.ok(refused(edited), "the stopped card's lane stays in card_lanes");
});

test("M16 Q2: a stopped queue's timer start installs the re-cut queue, whose new lane runs next", async () => {
  const host = fakeHost({ landedQueue: false, mainConfig: recutConfig(), mainContracts: nextContracts([RECUT_ID]) });
  host.put(autoClaim(PATHS, R, INSTALLED_SCOPE[0]), JSON.stringify({ card: INSTALLED_SCOPE[0], revision: R, outcome: "BLOCKED", ok: false, land: null }), { mode: 0o600 });
  const result = await autoRun({ io: host.io, paths: PATHS });
  assert.equal(result.kind, "install", JSON.stringify(result));
  assert.equal(result.outcome, "INSTALLED");
  assert.deepEqual(result.queue, RECUT_SCOPE);
  assert.deepEqual(host.steps, INSTALL_ORDER);
  assert.match(host.reports[0], new RegExp(`Queue: ${RECUT_SCOPE.join(", ")}\\.`));
  assert.equal(JSON.parse(host.files.get(PATHS.receipt).text).revision, N);
});

// M16: the card contracts the coordinator reads are data. Their source,
// card-contracts.mjs, is code nothing the box runs imports, and an install,
// queue or code, may only add cards to card-contracts.json.
const NONE = { approval: "none" };
const codeWithContracts = (text, policy = NONE, status = "M") => codeFacts(policy, (f) => ({ ...f,
  changes: [...f.changes, { status, path: CONTRACTS_PATH }],
  blobs: { ...f.blobs, [CONTRACTS_PATH]: "2".repeat(40) }, contractTexts: { installed: CONTRACTS_TEXT, main: text },
  passes: [{ ...f.passes[0], files: { ...f.passes[0].files, [CONTRACTS_PATH]: { sha: "2".repeat(40) } } }] }));

test("M16 Q3: nothing the coordinator runs imports the contracts source, and the data is the source's output", async () => {
  const coordinator = path.join(HERE, "..");
  const modules = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== "test" && entry.name !== "node_modules") walk(path.join(dir, entry.name)); continue; }
      if (/\.(?:mjs|js|cjs)$/.test(entry.name)) modules.push(path.join(dir, entry.name));
    }
  };
  walk(coordinator);
  assert.ok(modules.length > 50, "the walk finds the coordinator's modules");
  const importsSource = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'][^"']*card-contracts\.mjs["']/;
  const importers = modules.filter((file) => importsSource.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(coordinator, file));
  assert.deepEqual(importers, ["build-card-contracts.mjs"], "only the generator reads the source");
  const { renderContracts } = await import("../build-card-contracts.mjs");
  assert.equal(CONTRACTS_TEXT, renderContracts(), "card-contracts.json is out of date: run node .github/coordinator/build-card-contracts.mjs");
  const source = await import("../card-contracts.mjs");
  const reader = await import("../card-contracts-reader.mjs");
  assert.deepEqual(reader.CARD_CONTRACTS, source.CARD_CONTRACTS);
  assert.deepEqual(reader.REVIEW_ONLY_CARDS, source.REVIEW_ONLY_CARDS);
  assert.equal(reader.WRITER_FINISH_RULE, source.WRITER_FINISH_RULE);
  assert.ok(Object.isFrozen(reader.CARD_CONTRACTS) && Object.isFrozen(reader.cardContract(INSTALLED_SCOPE[0]).initial_build_paths), "the data is frozen");
  assert.equal(installablePath(CONTRACTS_SOURCE_PATH), true, "a queue pull request still commits the source with its data");
  assert.equal(ownerOnlyPath(".github/coordinator/card-contracts-reader.mjs"), true, "the reader is a person's install");
});

test("M16 Q5: every install, queue or code, may only add cards to the contracts data, whatever their text says", () => {
  const added = (edit) => contractsWith((data) => { data.cards["SHU-401"] = edit(newContract("SHU-401")); });
  const text = added((card) => ({ ...card, brief: "import the module, read process.env and call eval( in the text: https://example.test/x" }));
  assert.deepEqual(selfInstallGate(codeWithContracts(text)),
    { ok: true, queue: null, lanes: [], code: [CODE_PATH], approval: { pr: CODE_PR, head: CODE_HEAD, by: null } });
  assert.equal(contractChangeRefusal(CONTRACTS_TEXT, CONTRACTS_TEXT), null);
  const [installedId] = Object.keys(JSON.parse(CONTRACTS_TEXT).cards);
  const refusals = {
    "an edited card": [contractsWith((data) => { data.cards[installedId].revision_paths = ["src/anything.ts"]; }), `it changes ${installedId}`],
    "a removed card": [contractsWith((data) => { delete data.cards[installedId]; }), `it removes ${installedId}`],
    "a review-only change": [contractsWith((data) => { data.review_only["SHU-304"].acceptance = "anything"; }), "it changes the review-only cards"],
    "a new review-only card": [contractsWith((data) => { data.review_only["SHU-401"] = data.review_only["SHU-304"]; }), "it changes the review-only cards"],
    "a finish rule change": [contractsWith((data) => { data.writer_finish_rule = "Return early."; }), "it changes the writer's finish rule"],
    "a non-canonical id": [contractsWith((data) => { data.cards["SHU-0401"] = newContract("SHU-0401"); }), '"SHU-0401" is not a new canonical card id'],
    "a prototype key": [CONTRACTS_TEXT.replace('"cards": {', '"cards": {\n    "__proto__": {"brief": "x"},'), '"__proto__" is not a new canonical card id'],
    "an extra contract key": [added((card) => ({ ...card, writer_lane: "claude-builder" })), "SHU-401 is not a card contract"],
    "a missing brief": [added(({ brief: _gone, ...card }) => card), "SHU-401 is not a card contract"],
    "an empty path list": [added((card) => ({ ...card, initial_build_paths: [] })), "SHU-401 is not a card contract"],
    "a path that is not a string": [added((card) => ({ ...card, revision_paths: ["src/a.ts", 1] })), "SHU-401 is not a card contract"],
    "an empty acceptance": [added((card) => ({ ...card, acceptance: "" })), "SHU-401 is not a card contract"],
    "another workspace mode": [added((card) => ({ ...card, workspace_mode: "host" })), /^SHU-401 is not a card contract: card workspace_mode must be "repo"/],
    "a fixture lane": [contractsWith((data) => { data.cards["SHU-140"] = newContract("SHU-140"); }), "SHU-140 is a fixture lane"],
    "a path out of the tree": [added((card) => ({ ...card, initial_build_paths: ["../../etc/x"] })), "SHU-401 is not a card contract: initial_build_paths contains an unsafe, non-literal, or non-normalized path"],
    "a git hook path": [added((card) => ({ ...card, revision_paths: ["src/a.ts", ".git/hooks/pre-commit"] })), "SHU-401 is not a card contract: revision_paths contains an unsafe, non-literal, or non-normalized path"],
    "an unsafe scoped path": [added(({ workspace_mode: _mode, ...card }) => ({ ...card, initial_build_paths: ["/etc/x"] })), "SHU-401 is not a card contract: initial_build_paths contains an unsafe, non-literal, or non-normalized path"],
    "a repeated path": [added((card) => ({ ...card, revision_paths: ["src/a.ts", "src/a.ts"] })), "SHU-401 is not a card contract: revision_paths contains a duplicate path"],
    "a coordinator path in repo mode": [added((card) => ({ ...card, initial_build_paths: [".github/coordinator/config.json"] })), /^SHU-401 is not a card contract: .*initial_build_paths/],
    "a card that is not an object": [contractsWith((data) => { data.cards["SHU-401"] = ["brief"]; }), "SHU-401 is not a card contract"],
    "another top-level key": [contractsWith((data) => { data.extra = 1; }), "it is not the contracts data at both revisions"],
    "text that is not JSON": [`export const CARD_CONTRACTS = ${CONTRACTS_TEXT}`, "it is not the contracts data at both revisions"],
  };
  for (const [name, [main, reason]] of Object.entries(refusals)) {
    const expect = (actual, prefix = "") => (reason instanceof RegExp
      ? assert.match(actual ?? "", new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${reason.source.slice(1)}`), name)
      : assert.equal(actual, `${prefix}${reason}`, name));
    expect(contractChangeRefusal(CONTRACTS_TEXT, main));
    for (const gate of [selfInstallGate(codeWithContracts(main)), selfInstallGate(recutFacts((f) => ({ ...f, contractTexts: { installed: CONTRACTS_TEXT, main } })))]) {
      assert.ok(refused(gate), `${name}: ${JSON.stringify(gate)}`);
      expect(gate.reason, `${CONTRACTS_PATH} may only gain cards: `);
    }
  }
  // Without the workspace mode, a card is scoped and its safe paths install.
  assert.equal(contractChangeRefusal(CONTRACTS_TEXT, added(({ workspace_mode: _mode, ...card }) => card)), null);
  const created = selfInstallGate(codeWithContracts(text, NONE, "A"));
  assert.ok(refused(created));
  assert.match(created.reason, /may only gain cards: it is not an edit/);
  // The source alone changes nothing the coordinator reads.
  const source = selfInstallGate(codeFacts(NONE, (f) => ({ ...f, changes: [...f.changes, { status: "M", path: CONTRACTS_SOURCE_PATH }],
    blobs: { ...f.blobs, [CONTRACTS_SOURCE_PATH]: "7".repeat(40) },
    passes: [{ ...f.passes[0], files: { ...f.passes[0].files, [CONTRACTS_SOURCE_PATH]: { sha: "7".repeat(40) } } }] })));
  assert.equal(source.ok, true, JSON.stringify(source));
});

test("M16 Q4: the committed policy is approval none, which installs on the box review and green checks alone", async () => {
  // The committed config turns code self-install on with approval none:
  // reviewed code installs itself, card-run.mjs included.
  assert.deepEqual(COMMITTED.code_self_install, NONE);
  assert.deepEqual(codeInstallPolicy(COMMITTED), { approval: "none", approvers: [] });
  assert.equal(selfInstallGate(codeFacts(null, (f) => ({ ...f, configs: { installed: COMMITTED_TEXT, main: COMMITTED_TEXT } }))).ok, true,
    "with the committed config, reviewed code installs itself");
  assert.equal(selfInstallGate(codeFacts(null, (f) => ({ ...f, configs: { installed: QUEUE_ONLY_TEXT, main: QUEUE_ONLY_TEXT } }))).quiet, true,
    "with the policy off, reviewed code alone is nothing to install");
  // A queue install, the stopped-queue restart, still installs itself.
  assert.deepEqual(selfInstallGate(recutFacts((f) => ({ ...f, configs: { installed: COMMITTED_TEXT,
    main: JSON.stringify(recutConfig((c) => ({ ...c, code_self_install: NONE }))) } }))),
    { ok: true, queue: RECUT_SCOPE, lanes: [RECUT_ID] });
  // A policy-none install passes with no GitHub review read.
  const host = codeHost(NONE, { approved: false });
  const out = (await install(host, withPolicy(NONE))).result ?? {};
  assert.equal(out.outcome, "INSTALLED", JSON.stringify(out));
  assert.deepEqual(out.approval, { pr: CODE_PR, head: CODE_HEAD, by: null });
  assert.equal(host.github.some((entry) => entry.startsWith("pulls")), false, "no approval is read");
  assert.match(host.reports[0], /passed by the box review/);
  // It still needs the passed review at the exact blobs, and green checks.
  assert.ok(refused(selfInstallGate(codeFacts(NONE, (f) => ({ ...f, passes: [] })))));
  assert.equal(selfInstallGate(codeFacts(NONE, (f) => ({ ...f, checks: null }))).transient, true);
  // A malformed policy is off.
  for (const policy of [{ approval: "none", extra: 1 }, { approval: "None" }, { approval: "none", approvers: [] }, "none", [NONE]]) {
    assert.equal(codeInstallPolicy({ code_self_install: policy }), null, JSON.stringify(policy));
    assert.equal(selfInstallGate(codeFacts(policy)).quiet, true, JSON.stringify(policy));
  }
  // Owner-only paths stay a person's install, NEEDS_OWNER on the timer.
  for (const file of [".github/coordinator/service/card-install.mjs", ".github/coordinator/service/units.mjs", ".github/coordinator/reviewer-sandbox.sh"]) {
    const gate = selfInstallGate(codeFacts(NONE, (f) => ({ ...f, changes: [...f.changes, { status: "M", path: file }],
      blobs: { ...f.blobs, [file]: "8".repeat(40) }, passes: [{ ...f.passes[0], files: { ...f.passes[0].files, [file]: { sha: "8".repeat(40) } } }] })));
    assert.ok(refused(gate), file);
    assert.match(gate.reason, /is installed only by a person/, file);
  }
  const owner = codeHost(NONE);
  owner.changes = [...owner.changes, { status: "M", path: ".github/coordinator/service/units.mjs" }];
  const needs = (await install(owner, withPolicy(NONE))).result ?? {};
  assert.equal(needs.outcome, "NEEDS_OWNER");
  assert.equal(owner.steps.length, 0, "nothing on the host changed");
});

test("M16 Q6: a code install changes no config key a queue install could not", () => {
  const withMain = (edit) => codeFacts(NONE, (f) => {
    const config = edit(withPolicy(NONE));
    return { ...f, configs: { ...f.configs, main: JSON.stringify(config) }, changes: [...f.changes, { status: "M", path: CONFIG_PATH }],
      blobs: { ...f.blobs, [CONFIG_PATH]: "9".repeat(40) }, passes: [{ ...f.passes[0], files: { ...f.passes[0].files, [CONFIG_PATH]: { sha: "9".repeat(40) } } }] };
  });
  for (const [name, edit] of [["another key", (c) => ({ ...c, max_dispatch: 9 })], ["a removed key", (c) => { const { landing_repair: _gone, ...rest } = c; return rest; }],
    ["the review policy", (c) => ({ ...c, queue_config_review: { ...c.queue_config_review, max_heads_per_pr: 9 } })],
    ["an edited lane", (c) => ({ ...c, card_lanes: c.card_lanes.map((l, i) => (i === 0 ? { ...l, writer_lane: "claude-builder" } : l)) })],
    ["a dropped lane", (c) => ({ ...c, card_lanes: c.card_lanes.slice(1) })]]) {
    const gate = selfInstallGate(withMain(edit));
    assert.ok(refused(gate), `${name}: ${JSON.stringify(gate)}`);
    assert.match(gate.reason, /config\.json changes|card_lanes at main are not/, name);
  }
  assert.match(selfInstallGate(withMain((c) => ({ ...c, code_self_install: REVIEW_POLICY }))).reason, /code self-install policy is installed only by a person/);
  // Unchanged config, or lanes only appended, still install with the code.
  assert.equal(selfInstallGate(withMain((c) => c)).ok, true);
  assert.equal(selfInstallGate(withMain((c) => ({ ...c, card_lanes: [...c.card_lanes, lane("SHU-401")] }))).ok, true);
});

test("M16 Q7: a test file a runtime module imports is never a queue's to change", () => {
  // The coordinator's own files, named from the repository root, wherever this
  // copy of the coordinator sits.
  const coordinatorDir = path.join(HERE, "..");
  const at = (file) => path.join(coordinatorDir, path.posix.relative(".github/coordinator", file));
  const relative = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  const inTest = (file) => file.split("/").slice(2, -1).includes("test");
  const runtime = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(at(dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(file); continue; }
      if (/\.(?:mjs|js|cjs)$/.test(entry.name) && !inTest(file)) runtime.push(file);
    }
  };
  walk(".github/coordinator");
  assert.ok(runtime.length > 50, "the walk finds the coordinator's modules");
  const seen = new Set();
  const stack = [...runtime];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !file.startsWith(".github/coordinator/") || !fs.existsSync(at(file))) continue;
    seen.add(file);
    const text = fs.readFileSync(at(file), "utf8");
    for (const [, spec] of text.matchAll(relative)) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
  }
  assert.deepEqual([...seen].filter(inTest).sort(), [...RUNTIME_TEST_MODULES].sort(), "every test file a runtime module imports is listed");
  for (const file of RUNTIME_TEST_MODULES) {
    assert.equal(installablePath(file), false, file);
    assert.equal(queueConfigPath(file), false, file);
    assert.equal(ownerOnlyPath(file), true, file);
  }
  const gate = selfInstallGate(facts((f) => ({ ...f, changes: [...f.changes, { status: "M", path: RUNTIME_TEST_MODULES[0] }] })));
  assert.ok(refused(gate));
  assert.match(gate.reason, /is not a queue config path/);
});
