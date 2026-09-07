// SHU-63 activation contract (Opus, exact-head work on 391b255d).
//
// "Only two login steps" describes the AUTH surface. These tests pin the rest of
// the ACTIVATION surface: a Codex builder that authenticates perfectly still
// cannot do the job unless its COMPLETED can be head-checked, its work can be
// pushed by the host broker, its session identity survives a reboot, and the
// coordinator writing that host-local identity is the brick box itself.
//
// Two gates are INVERTED under Option A (codex_sandbox_network and
// git_push_authentication): the worker performs no remote operation, so
// declaring it networked or push-ready contradicts the prompt it is sent in the
// same run. A gate an operator can satisfy only by lying is worse than no gate.
//
// Every requirement fails CLOSED and independently, so a half-wired activation
// refuses to start a worker instead of discovering the gap mid-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightActivation,
  describeUnmetActivation,
  ACTIVATION_REQUIREMENTS,
} from "../activation.mjs";
import { activationPreflightFor, ACTIVATION_GATED_ADAPTERS, verifyActivationTarget } from "../reconcile.mjs";

const HOST = "brick-box";

// A directory that is NOT on ephemeral storage, so state durability is the only
// requirement under test in each case rather than an incidental failure.
function durableDir() {
  const root = mkdtempSync(join(tmpdir(), "activation-"));
  const dir = join(root, "state");
  mkdirSync(dir, { recursive: true });
  return { dir, io: { statImpl: () => ({ isDirectory: () => true, mode: 0o40700 }), accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST } };
}

function activatedEnv(over = {}) {
  return {
    // Option A: the worker performs no remote operation, and its prompt says
    // so. A truthful activation therefore declares the sandbox isolated.
    CODEX_SANDBOX_NETWORK: "disabled",
    GITHUB_TOKEN: "gh-token",
    // Deliberately NO CODEX_GIT_PUSH_READY. Under Option A the worker never
    // pushes and holds no push credentials, so a truthful activation cannot
    // declare push-readiness — see gate 3 in activation.mjs.
    SHU_PUSH_BROKER_ENABLED: "true",
    SHU_WORKTREE_ROOT: "/srv/shu/worktrees",
    SHU_PUSH_REMOTE_URL: "git@github.com:BAWES-Universe/studenthub-platform.git",
    // The broker's isolation is void while the worker shares the coordinator's
    // OS identity, so a truthful activation states the split AND the mechanism
    // that enforces it.
    SHU_WORKER_UID: "2001",
    SHU_WORKER_LAUNCH_WRAPPER: "setpriv --reuid=shu-worker --regid=shu-worker --clear-groups",
    COORDINATOR_HOST: HOST,
    ...over,
  };
}

test("a fully wired activation passes and names no unmet requirement", () => {
  const { dir, io } = durableDir();
  const out = preflightActivation({ env: activatedEnv(), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, true, describeUnmetActivation(out.unmet));
  assert.deepEqual(out.unmet, []);
  assert.ok(dir);
});

// Each requirement, removed on its own, must fail closed by itself. Testing them
// only in combination would let one silently stop being enforced.
for (const [requirement, override] of [
  ["codex_sandbox_network", { CODEX_SANDBOX_NETWORK: undefined }],
  // Inverted under the broker, like git_push_authentication: declaring the
  // worker networked contradicts the prompt it is sent in the same run.
  ["codex_sandbox_network", { CODEX_SANDBOX_NETWORK: "enabled" }],
  ["github_head_credentials", { GITHUB_TOKEN: "" }],
  // Under Option A the gate is inverted: DECLARING worker push-readiness is the
  // violation, because the worker must hold no push credentials at all.
  ["git_push_authentication", { CODEX_GIT_PUSH_READY: "true" }],
  ["host_push_broker", { SHU_PUSH_BROKER_ENABLED: undefined }],
  ["worker_identity_split", { SHU_WORKER_UID: undefined }],
  ["worker_identity_split", { SHU_WORKER_LAUNCH_WRAPPER: undefined }],
  ["coordinator_on_brick_box", { COORDINATOR_HOST: undefined }],
]) {
  test(`activation fails closed when ${requirement} is missing`, () => {
    const { io } = durableDir();
    const out = preflightActivation({ env: activatedEnv(override), stateDir: "/srv/codex/state", cwd: "/repo", io });
    assert.equal(out.ok, false);
    assert.ok(out.unmet.some((u) => u.requirement === requirement), `${requirement} must be reported`);
    // A refusal that does not say what to do is a dead end for the operator.
    const entry = out.unmet.find((u) => u.requirement === requirement);
    assert.ok(entry.detail.length > 0, "must report what was observed");
    assert.ok(entry.remedy.length > 0, "must report the operator action that fixes it");
  });
}

test("activation fails closed when the coordinator is not the brick box", () => {
  const out = preflightActivation({
    env: activatedEnv(),
    stateDir: "/srv/codex/state",
    cwd: "/repo",
    io: { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => "ephemeral-ci-runner" },
  });
  assert.equal(out.ok, false);
  const entry = out.unmet.find((u) => u.requirement === "coordinator_on_brick_box");
  assert.ok(entry, "a coordinator running off the brick box must be refused");
  assert.match(entry.detail, /ephemeral-ci-runner/);
});

// Host-local sidecars on ephemeral storage are the specific failure this
// requirement exists for: the thread id is lost exactly when it is needed.
for (const ephemeral of ["/tmp/codex", "/var/tmp/codex", "/dev/shm/codex", "/run/codex"]) {
  test(`activation fails closed when durable state lives on ${ephemeral}`, () => {
    const out = preflightActivation({
      env: activatedEnv(),
      stateDir: ephemeral,
      cwd: "/repo",
      io: { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST },
    });
    assert.equal(out.ok, false);
    const entry = out.unmet.find((u) => u.requirement === "durable_state_persistence");
    assert.ok(entry, "ephemeral state must be refused");
    assert.match(entry.detail, /ephemeral storage/);
  });
}

test("activation fails closed when the state directory is unwritable or absent", () => {
  for (const [label, io] of [
    ["uncreatable", {
      statImpl: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      mkdirImpl: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST,
    }],
    ["not a directory", { statImpl: () => ({ isDirectory: () => false }), accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST }],
    ["unwritable", { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => { throw new Error("EACCES"); }, realpathImpl: (p) => p, hostname: () => HOST }],
  ]) {
    const out = preflightActivation({ env: activatedEnv(), stateDir: "/srv/codex/state", cwd: "/repo", io });
    assert.equal(out.ok, false, label);
    assert.ok(out.unmet.some((u) => u.requirement === "durable_state_persistence"), label);
  }
});

test("activation rejects shared durable state that another local account could forge", () => {
  const out = preflightActivation({
    env: activatedEnv(),
    stateDir: "/srv/codex/state",
    cwd: "/repo",
    io: {
      statImpl: () => ({ isDirectory: () => true, mode: 0o40777 }),
      accessImpl: () => {},
      realpathImpl: (p) => p,
      hostname: () => HOST,
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.unmet.find((u) => u.requirement === "durable_state_persistence")?.detail ?? "", /permissions are too broad/);
});

test("whitespace is not a GitHub credential", () => {
  const { io } = durableDir();
  const out = preflightActivation({ env: activatedEnv({ GITHUB_TOKEN: "   " }), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, false);
  assert.ok(out.unmet.some((u) => u.requirement === "github_head_credentials"));
});

// LEGACY worker-push mode (broker disabled). 3b refuses this mode outright, so
// these can never be part of a passing preflight — they exist so the legacy
// requirement cannot silently stop being enforced if 3b is ever relaxed.
const LEGACY = { SHU_PUSH_BROKER_ENABLED: undefined };

test("legacy mode: a push remote does not prove authentication without the operator declaration", () => {
  const io = { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST, gitPushRemote: () => "git@github.com:BAWES-Universe/studenthub-platform.git" };
  const out = preflightActivation({ env: activatedEnv({ ...LEGACY, CODEX_GIT_PUSH_READY: undefined }), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, false, "a remote URL says nothing about whether credentials can use it");
  assert.ok(out.unmet.some((u) => u.requirement === "git_push_authentication"));
});

test("legacy mode: a worktree with no push remote fails closed even when the declaration is set", () => {
  const io = { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST, gitPushRemote: () => "" };
  const out = preflightActivation({ env: activatedEnv({ ...LEGACY, CODEX_GIT_PUSH_READY: "true" }), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, false, "a declaration must never outrank an observed missing remote");
  const entry = out.unmet.find((u) => u.requirement === "git_push_authentication");
  // Pin WHICH check fired: the Option A inversion also reports this requirement
  // for the same env, so matching the name alone would pass on the wrong one.
  assert.match(entry?.detail ?? "", /no push remote/, "the observed missing remote must be what fails");
});

// The contradiction Codex found: gate 3b (this PR) says the worker never
// pushes, while gate 3 demanded the worker prove it can. A correctly isolated
// Option A deployment could not activate honestly, and the only way through was
// to declare credentials the design forbids.
test("Option A: a truthfully isolated worker activates without declaring push credentials", () => {
  const { io } = durableDir();
  const out = preflightActivation({ env: activatedEnv(), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, true, describeUnmetActivation(out.unmet));
  assert.ok(
    !out.unmet.some((u) => u.requirement === "git_push_authentication"),
    "a worker with no push credentials is the CORRECT Option A state, not an unmet requirement",
  );
});

test("Option A: declaring worker push-readiness is itself an unmet requirement", () => {
  const { io } = durableDir();
  const out = preflightActivation({ env: activatedEnv({ CODEX_GIT_PUSH_READY: "true" }), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, false, "the worker must hold no push credentials while the broker is the pusher");
  const entry = out.unmet.find((u) => u.requirement === "git_push_authentication");
  assert.ok(entry, "the contradiction must be named, not silently tolerated");
  assert.match(entry.remedy, /unset CODEX_GIT_PUSH_READY/, "the remedy must tell the operator to remove it, never to keep it");
});

test("activation creates its private state directory before checking it", () => {
  const stateDir = "/srv/codex/coordinator-runs";
  let created = false;
  const out = preflightActivation({
    env: activatedEnv(),
    stateDir,
    cwd: "/repo",
    io: {
      hostname: () => HOST,
      gitPushRemote: () => "git@github.com:BAWES-Universe/studenthub-platform.git",
      mkdirImpl: (dir) => { assert.equal(dir, stateDir); created = true; },
      realpathImpl: (dir) => dir,
      statImpl: () => {
        if (!created) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isDirectory: () => true };
      },
      accessImpl: () => {},
    },
  });
  assert.equal(out.ok, true, describeUnmetActivation(out.unmet));
  assert.equal(created, true, "a clean CODEX_HOME must be activatable without an undocumented mkdir step");
});

test("an apparently durable path resolving onto ephemeral storage fails closed", (t) => {
  const root = mkdtempSync(join(process.cwd(), ".activation-symlink-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = mkdtempSync(join(tmpdir(), "activation-ephemeral-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const link = join(root, "state");
  symlinkSync(target, link, "dir");
  const out = preflightActivation({
    env: activatedEnv(),
    stateDir: link,
    cwd: "/repo",
    io: { hostname: () => HOST, gitPushRemote: () => "git@github.com:BAWES-Universe/studenthub-platform.git", realpathImpl: realpathSync },
  });
  assert.equal(out.ok, false, "a symlink must not disguise /tmp as persistent state");
  assert.ok(out.unmet.some((u) => u.requirement === "durable_state_persistence"));
});

// The flag being PRESENT but the broker unconfigured is a distinct failure from
// the flag being absent, and only the absent case was covered — deleting this
// arm of the gate left the whole suite green (Opus R3).
test("host_push_broker: enabled but unconfigured is unmet, not silently accepted", () => {
  for (const missing of [
    { SHU_WORKTREE_ROOT: undefined },
    { SHU_PUSH_REMOTE_URL: undefined },
    { SHU_WORKTREE_ROOT: undefined, SHU_PUSH_REMOTE_URL: undefined },
  ]) {
    const { io } = durableDir();
    const out = preflightActivation({
      env: activatedEnv({ SHU_PUSH_BROKER_ENABLED: "true", ...missing }),
      stateDir: "/srv/codex/state",
      cwd: "/repo",
      io,
    });
    assert.equal(out.ok, false, JSON.stringify(missing));
    const entry = out.unmet.find((u) => u.requirement === "host_push_broker");
    assert.ok(entry, `enabled-but-unconfigured must be reported: ${JSON.stringify(missing)}`);
    assert.match(entry.detail, /SHU_WORKTREE_ROOT|SHU_PUSH_REMOTE_URL/);
  }
});

test("every declared requirement is actually enforced by the preflight", () => {
  // Guards against a requirement being listed in the contract but never checked.
  const out = preflightActivation({ env: {}, stateDir: null, cwd: null, io: { hostname: () => HOST } });
  assert.equal(out.ok, false);
  const reported = new Set(out.unmet.map((u) => u.requirement));
  for (const requirement of ACTIVATION_REQUIREMENTS) {
    assert.ok(reported.has(requirement), `${requirement} is declared in the contract but never enforced`);
  }
});

test("only the local-CLI builder lane carries the contract", () => {
  assert.deepEqual([...ACTIVATION_GATED_ADAPTERS], ["codex-cli"]);
  assert.equal(activationPreflightFor("claude-code", { env: {}, io: {} }), null, "a hosted verifier lane has no brick box");
  assert.equal(activationPreflightFor("hermes-pool", { env: {}, io: {} }), null);
  const gated = activationPreflightFor("codex-cli", { env: {}, io: { hostname: () => HOST } });
  assert.ok(gated && gated.ok === false, "the codex lane is gated and unwired fails closed");
});

test("activation GitHub probe validates the exact bound commit with the configured token", async () => {
  const calls = [];
  const ok = await verifyActivationTarget("codex-cli", {
    repo: "BAWES-Universe/studenthub-platform",
    target_sha: "d".repeat(40),
    githubToken: "gh-token",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ sha: "d".repeat(40) }) };
    },
  });
  assert.equal(ok.ok, true);
  assert.match(calls[0].url, /\/commits\/d{40}$/);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer gh-token");

  for (const response of [
    { ok: false, status: 401, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ sha: "e".repeat(40) }) },
  ]) {
    const failed = await verifyActivationTarget("codex-cli", {
      repo: "BAWES-Universe/studenthub-platform", target_sha: "d".repeat(40), githubToken: "bad-token",
      fetchImpl: async () => response,
    });
    assert.equal(failed.ok, false, "invalid credentials or an unexpected target must fail closed");
  }
});

// End to end through main(): an unwired activation must ABORT before the adapter
// boundary, pause the lane, and start no worker. This is the property that
// matters — the preflight unit tests above only prove the verdict, not that the
// coordinator acts on it.
test("main(): an unwired activation aborts dispatch, pauses the lane, and spawns nothing", async () => {
  const { main, parseReceiptsFromComments } = await import("../reconcile.mjs");
  const { mkdtempSync: mkd, writeFileSync } = await import("node:fs");
  const node = {
    id: "11111111-aaaa-4bbb-8ccc-000000000001",
    identifier: "SHU-FIXTURE-001",
    title: "Fixture",
    state: { name: "Todo" },
    priorityLabel: "High",
    labels: { nodes: [{ name: "fixture-safe" }] },
    assignee: null, delegate: null, parent: null, relations: { nodes: [] },
  };
  const cfgDir = mkd(join(tmpdir(), "activation-cfg-"));
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    pilot_repo: "BAWES-Universe/studenthub-platform", team: "SHU", max_dispatch: 1,
    enable_dispatch: true, adapter_pause_map: {}, wake_actor_allowlist: ["BAWES"], max_failed_attempts: 3,
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
  }));

  const comments = [];
  let spawns = 0;
  const out = [];
  const code = await main([], {
    ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "tok", GITHUB_TOKEN: "", DISPATCH_TARGET_SHA: "d".repeat(40),
  }, {
    configPath: cfgPath,
    stdout: (s) => out.push(s),
    fetchDurable: true,
    pollRuns: false,
    hostname: () => "ephemeral-ci-runner",
    adapterModules: { "codex-cli": { launchBuilder: async () => { spawns += 1; return { stage: "RUNNING" }; }, monitorRun: async () => ({ stage: "UNCHANGED" }) } },
    fetchImpl: async (url, opts) => {
      const { query } = JSON.parse(opts.body);
      const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
      if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes: [node] } });
      if (query.includes("CoordinatorIssueComments")) return respond({ issue: { comments: { nodes: [...comments] } } });
      if (query.includes("commentCreate")) {
        comments.push({ body: JSON.parse(opts.body).variables.body, createdAt: new Date().toISOString() });
        return respond({ commentCreate: { success: true, comment: { id: `c${comments.length}` } } });
      }
      return respond({});
    },
  });

  assert.equal(spawns, 0, "an unwired lane must never start a worker");
  assert.equal(code, 2, "dispatch must abort, not report success");
  assert.match(out.join("\n"), /activation contract unmet/, "and must say what is missing");
  assert.ok(comments.some((c) => c.body.includes("coordinator-pause: codex-cli")), "the lane must be paused durably");
  assert.equal(parseReceiptsFromComments(comments).length, 0, "a refused preflight must not strand an unrecoverable RESERVED receipt");
});

test("main(): an unreadable GitHub target aborts before reservation and adapter launch", async () => {
  const { main, parseReceiptsFromComments } = await import("../reconcile.mjs");
  const { mkdtempSync: mkd, writeFileSync } = await import("node:fs");
  const linearId = "11111111-aaaa-4bbb-8ccc-000000000001";
  const node = {
    id: linearId, identifier: "SHU-FIXTURE-001", title: "Fixture", state: { name: "Todo" },
    priorityLabel: "High", labels: { nodes: [{ name: "fixture-safe" }] },
    assignee: null, delegate: null, parent: null, relations: { nodes: [] },
  };
  const cfgPath = join(mkd(join(tmpdir(), "activation-github-cfg-")), "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    pilot_repo: "BAWES-Universe/studenthub-platform", team: "SHU", max_dispatch: 1,
    enable_dispatch: true, adapter_pause_map: {}, wake_actor_allowlist: ["BAWES"], max_failed_attempts: 3,
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
  }));
  const comments = [];
  let launches = 0;
  const output = [];
  const code = await main([], {
    ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "tok", DISPATCH_TARGET_SHA: "d".repeat(40),
    ...activatedEnv(),
  }, {
    configPath: cfgPath, stdout: (s) => output.push(s), fetchDurable: true, pollRuns: false,
    codexStateDir: "/srv/codex/state",
    statImpl: () => ({ isDirectory: () => true, mode: 0o40700 }),
    accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => HOST,
    adapterModules: { "codex-cli": { launchBuilder: async () => { launches += 1; return { stage: "RUNNING" }; } } },
    fetchImpl: async (url, opts) => {
      if (url.startsWith("https://api.github.com/")) return { ok: false, status: 401, json: async () => ({}) };
      const { query, variables } = JSON.parse(opts.body);
      const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
      if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes: [node] } });
      if (query.includes("CoordinatorIssueComments")) return respond({ issue: { comments: { nodes: [...comments] } } });
      if (query.includes("commentCreate")) {
        comments.push({ body: variables.body, createdAt: new Date().toISOString() });
        return respond({ commentCreate: { success: true, comment: { id: `c${comments.length}` } } });
      }
      return respond({});
    },
  });
  assert.equal(code, 2);
  assert.equal(launches, 0);
  assert.match(output.join("\n"), /activation GitHub probe failed/);
  assert.equal(parseReceiptsFromComments(comments).length, 0);
  assert.ok(comments.some((c) => c.body.includes("coordinator-pause: codex-cli")));
});

test("main(): LAUNCH_UNKNOWN recovery rechecks activation before calling the adapter", async () => {
  const { main, createReceipt, nextReceiptState, receiptCommentBody } = await import("../reconcile.mjs");
  const { mkdtempSync: mkd, writeFileSync } = await import("node:fs");
  const linearId = "11111111-aaaa-4bbb-8ccc-000000000001";
  const node = {
    id: linearId, identifier: "SHU-FIXTURE-001", title: "Fixture", state: { name: "Todo" },
    priorityLabel: "High", labels: { nodes: [{ name: "fixture-safe" }] },
    assignee: null, delegate: null, parent: null, relations: { nodes: [] },
  };
  const cfgDir = mkd(join(tmpdir(), "activation-recovery-cfg-"));
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    pilot_repo: "BAWES-Universe/studenthub-platform", team: "SHU", max_dispatch: 1,
    enable_dispatch: true, adapter_pause_map: {}, wake_actor_allowlist: ["BAWES"], max_failed_attempts: 3,
    fixture_lane: { id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
  }));
  const made = createReceipt({
    issue_id: "SHU-FIXTURE-001", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "codex-builder", repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-FIXTURE-001", target_sha: "d".repeat(40),
  });
  assert.equal(made.ok, true);
  const launched = nextReceiptState(made.receipt, { type: "launch" }).receipt;
  const comments = [{ body: receiptCommentBody(launched), createdAt: "2026-09-06T00:00:00.000Z" }];
  let launches = 0;
  const output = [];
  const code = await main([], {
    ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "tok", GITHUB_TOKEN: "", DISPATCH_TARGET_SHA: "d".repeat(40),
  }, {
    configPath: cfgPath, stdout: (s) => output.push(s), fetchDurable: true, pollRuns: true,
    hostname: () => "wrong-host",
    adapterModules: { "codex-cli": {
      launchBuilder: async () => { launches += 1; return { stage: "HOLD", pause_adapter: true }; },
      monitorRun: async () => ({ stage: "UNCHANGED" }),
    } },
    fetchImpl: async (_url, opts) => {
      const { query, variables } = JSON.parse(opts.body);
      const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
      if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes: [node] } });
      if (query.includes("CoordinatorIssueComments")) return respond({ issue: { comments: { nodes: [...comments] } } });
      if (query.includes("commentCreate")) {
        comments.push({ body: variables.body, createdAt: new Date().toISOString() });
        return respond({ commentCreate: { success: true, comment: { id: `c${comments.length}` } } });
      }
      return respond({});
    },
  });
  assert.equal(launches, 0, "recovery must not bypass the same activation bar as first launch");
  assert.equal(code, 0, "the existing active receipt remains held; no new dispatch is attempted");
  assert.match(output.join("\n"), /activation contract unmet/);
  assert.ok(comments.some((c) => c.body.includes("coordinator-pause: codex-cli")));
});

// ---------------------------------------------------------------------------
// worker_identity_split — the boundary activation previously ASSERTED without
// establishing. An independent verifier reproduced the consequence at
// `abe816a`: a same-uid process wrote url.*.insteadOf into the broker's own
// repository after creation, and the remote check followed the rewrite.
// ---------------------------------------------------------------------------

test("a worker sharing the coordinator's uid is refused, not merely noted", () => {
  const { io } = durableDir();
  const out = preflightActivation({
    env: activatedEnv({ SHU_WORKER_UID: "4242" }),
    stateDir: "/srv/codex/state", cwd: "/repo",
    io: { ...io, getuid: () => 4242 },
  });
  assert.equal(out.ok, false, "same-uid worker defeats the broker repository's 0700 isolation");
  const entry = out.unmet.find((u) => u.requirement === "worker_identity_split");
  assert.match(entry?.detail ?? "", /coordinator's own uid/);
});

test("a distinct worker uid with the enforcing wrapper satisfies the split", () => {
  const { io } = durableDir();
  const out = preflightActivation({
    env: activatedEnv(), stateDir: "/srv/codex/state", cwd: "/repo",
    io: { ...io, getuid: () => 1000 },
  });
  assert.equal(out.ok, true, describeUnmetActivation(out.unmet));
});

test("root is never an acceptable builder identity", () => {
  const { io } = durableDir();
  const out = preflightActivation({
    env: activatedEnv({ SHU_WORKER_UID: "0" }),
    stateDir: "/srv/codex/state", cwd: "/repo",
    io: { ...io, getuid: () => 1000 },
  });
  assert.equal(out.ok, false);
  assert.match(out.unmet.find((u) => u.requirement === "worker_identity_split")?.detail ?? "", /root/);
});

test("a non-numeric worker uid is not accepted as a declaration", () => {
  const { io } = durableDir();
  const out = preflightActivation({
    env: activatedEnv({ SHU_WORKER_UID: "shu-worker" }),
    stateDir: "/srv/codex/state", cwd: "/repo",
    io: { ...io, getuid: () => 1000 },
  });
  assert.equal(out.ok, false, "a name is not a uid the coordinator can compare against its own");
});

test("the split is required even with the broker flag absent", () => {
  // Scoping this to broker mode left a hole the contract meta-test caught: a
  // requirement that can be skipped is not enforced. This is the requirement
  // least able to afford that, and legacy mode is refused by 3b regardless.
  const { io } = durableDir();
  const out = preflightActivation({
    env: activatedEnv({ SHU_PUSH_BROKER_ENABLED: undefined, SHU_WORKER_UID: undefined, SHU_WORKER_LAUNCH_WRAPPER: undefined }),
    stateDir: "/srv/codex/state", cwd: "/repo", io,
  });
  assert.ok(
    out.unmet.some((u) => u.requirement === "worker_identity_split"),
    "no configuration may reach dispatch with the worker sharing the coordinator's identity",
  );
});
