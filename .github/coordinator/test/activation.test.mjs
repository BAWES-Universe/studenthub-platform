// SHU-63 activation contract (Opus, exact-head work on 391b255d).
//
// "Only two login steps" describes the AUTH surface. These tests pin the rest of
// the ACTIVATION surface: a Codex builder that authenticates perfectly still
// cannot do the job unless it can reach the network, its COMPLETED can be
// head-checked, its work can be pushed, its session identity survives a reboot,
// and the coordinator writing that host-local identity is the brick box itself.
//
// Every requirement fails CLOSED and independently, so a half-wired activation
// refuses to start a worker instead of discovering the gap mid-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightActivation,
  describeUnmetActivation,
  ACTIVATION_REQUIREMENTS,
} from "../activation.mjs";
import { activationPreflightFor, ACTIVATION_GATED_ADAPTERS } from "../reconcile.mjs";

const HOST = "brick-box";

// A directory that is NOT on ephemeral storage, so state durability is the only
// requirement under test in each case rather than an incidental failure.
function durableDir() {
  const root = mkdtempSync(join(tmpdir(), "activation-"));
  const dir = join(root, "state");
  mkdirSync(dir, { recursive: true });
  return { dir, io: { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, hostname: () => HOST } };
}

function activatedEnv(over = {}) {
  return {
    CODEX_SANDBOX_NETWORK: "enabled",
    GITHUB_TOKEN: "gh-token",
    CODEX_GIT_PUSH_READY: "true",
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
  ["github_head_credentials", { GITHUB_TOKEN: "" }],
  ["git_push_authentication", { CODEX_GIT_PUSH_READY: undefined }],
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
    io: { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, hostname: () => "ephemeral-ci-runner" },
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
      io: { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, hostname: () => HOST },
    });
    assert.equal(out.ok, false);
    const entry = out.unmet.find((u) => u.requirement === "durable_state_persistence");
    assert.ok(entry, "ephemeral state must be refused");
    assert.match(entry.detail, /ephemeral storage/);
  });
}

test("activation fails closed when the state directory is unwritable or absent", () => {
  for (const [label, io] of [
    ["absent", { statImpl: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); }, accessImpl: () => {}, hostname: () => HOST }],
    ["not a directory", { statImpl: () => ({ isDirectory: () => false }), accessImpl: () => {}, hostname: () => HOST }],
    ["unwritable", { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => { throw new Error("EACCES"); }, hostname: () => HOST }],
  ]) {
    const out = preflightActivation({ env: activatedEnv(), stateDir: "/srv/codex/state", cwd: "/repo", io });
    assert.equal(out.ok, false, label);
    assert.ok(out.unmet.some((u) => u.requirement === "durable_state_persistence"), label);
  }
});

test("a real push remote satisfies git push authentication without the declaration", () => {
  const io = { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, hostname: () => HOST, gitPushRemote: () => "git@github.com:BAWES-Universe/studenthub-platform.git" };
  const out = preflightActivation({ env: activatedEnv({ CODEX_GIT_PUSH_READY: undefined }), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, true, describeUnmetActivation(out.unmet));
});

test("a worktree with no push remote fails closed even when the declaration is set", () => {
  const io = { statImpl: () => ({ isDirectory: () => true }), accessImpl: () => {}, hostname: () => HOST, gitPushRemote: () => "" };
  const out = preflightActivation({ env: activatedEnv(), stateDir: "/srv/codex/state", cwd: "/repo", io });
  assert.equal(out.ok, false, "a declaration must never outrank an observed missing remote");
  assert.ok(out.unmet.some((u) => u.requirement === "git_push_authentication"));
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
});
