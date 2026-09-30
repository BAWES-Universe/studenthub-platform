// SHU-71: the reversed roles carry the same gates as the originals. A Claude
// writer runs the writer's activation contract and GitHub target probe, and an
// activation may name only a reviewer the supervisor can start.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as activation from "../single-run-activation.mjs";
import { activationGated, activationPreflightFor, verifyActivationTarget } from "../reconcile.mjs";
import { ACTIVATION_REVIEWER_LANES, LAUNCHABLE_RUNTIMES, REVIEW_LANES, runtimeForLane } from "../launch-vocabulary.mjs";
import { createEpisodeHarness, REVISION } from "./fixture/episode-harness.mjs";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const base = {
  activation_id: "shu71reversedgates",
  target_issue_id: "SHU-140",
  authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
  coordinator_revision: REVISION,
  slots: 1,
  expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
};

test("SHU71_REVIEWER_LAUNCHABLE: an activation names only a reviewer lane the supervisor can start", () => {
  assert.deepEqual(REVIEW_LANES.filter((lane) => !ACTIVATION_REVIEWER_LANES.includes(lane)), ["hermes-box", "hermes-verifier"]);
  for (const lane of ACTIVATION_REVIEWER_LANES) assert.ok(LAUNCHABLE_RUNTIMES.includes(runtimeForLane(lane)), lane);
  for (const lane of ["claude-verifier", "codex-verifier"]) {
    assert.equal(activation.validateActivationRecord({ ...base, reviewer_lane: lane }).ok, true, lane);
  }
  for (const lane of ["hermes-verifier", "hermes-box"]) {
    const verdict = activation.validateActivationRecord({ ...base, reviewer_lane: lane });
    assert.equal(verdict.ok, false, `${lane} can only hold, so it must refuse`);
    assert.match(verdict.reason, /reviewer_lane must be one of/);
    assert.doesNotMatch(verdict.reason, /one of [^(]*hermes/, "the refusal lists only launchable lanes");
  }
});

test("SHU71_CLAUDE_WRITER_GATED: a Claude writer carries the writer contract; the Claude reviewer does not", async () => {
  for (const role of ["build", "revise"]) {
    assert.equal(activationGated("claude-code", role), true, role);
    const preflight = activationPreflightFor("claude-code", { env: {}, io: {}, role });
    assert.equal(preflight?.ok, false, `an unwired Claude ${role} fails closed`);
    assert.ok(preflight.unmet.some((u) => u.requirement === "worker_identity_split"), "the distinct worker is required");
    const probe = await verifyActivationTarget("claude-code", { repo: "BAWES-Universe/studenthub-platform", target_sha: "d".repeat(40), githubToken: "", fetchImpl: async () => { throw new Error("unreachable"); }, role });
    assert.equal(probe.ok, false, "the GitHub target probe runs for a Claude writer");
  }
  assert.equal(activationGated("claude-code", "review"), false);
  assert.equal(activationPreflightFor("claude-code", { env: {}, io: {}, role: "review" }), null, "the reviewer is unchanged");
  assert.deepEqual(await verifyActivationTarget("claude-code", { role: "review" }), { ok: true });
  assert.equal(activationGated("codex-cli", "review"), true, "the Codex lane is gated as before");
  assert.equal(activationGated("hermes-pool", "build"), false);
});

test("SHU71_CLAUDE_WRITER_GATED_DISPATCH: an unwired host refuses the Claude build before reservation", async () => {
  const committed = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).fixture_lane;
  const fixture_lane = { id: "SHU-140", authorization_ref: committed.authorization_ref, initial_build_paths: committed.initial_build_paths,
    revision_paths: committed.revision_paths, seeded_defect_path: committed.seeded_defect_path };
  const h = createEpisodeHarness({ githubToken: "ghtok", writerLane: "claude-builder", reviewerLane: "codex-verifier", configOverrides: { fixture_lane } });
  try {
    // The real contract runs, so the open-PR claim lookup runs too: none is open.
    const fetchImpl = async (url, opts) => /\/pulls\?/.test(String(url)) ? { status: 200, ok: true, json: async () => [] } : h.fetchImpl(url, opts);
    const t = await h.runTick({ io: { skipActivationPreflight: false, fetchImpl, deriveScopedBaseSha: async () => "d".repeat(40) } });
    assert.equal(t.code, 2, t.text);
    assert.match(t.text, /dispatch: ABORTED before reservation — SHU-63 activation contract unmet for claude-code/);
    assert.deepEqual(h.triggers, { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 });
    assert.equal(h.receipts().length, 0, "no reservation is written");
  } finally {
    h.cleanup();
  }
});

test("SHU71_CLAUDE_WRITER_GATED_RECOVERY: recovering an unacknowledged Claude build reruns the writer contract", async () => {
  const committed = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).fixture_lane;
  const fixture_lane = { id: "SHU-140", authorization_ref: committed.authorization_ref, initial_build_paths: committed.initial_build_paths,
    revision_paths: committed.revision_paths, seeded_defect_path: committed.seeded_defect_path };
  const h = createEpisodeHarness({ githubToken: "ghtok", writerLane: "claude-builder", reviewerLane: "codex-verifier", configOverrides: { fixture_lane } });
  try {
    const launch = h.adapters["claude-code"].launchBuilder;
    let unacknowledged = true;
    h.adapters["claude-code"].launchBuilder = async (o) => unacknowledged ? { stage: "LAUNCH_UNKNOWN", reason: "response lost" } : launch(o);
    let t = await h.runTick({ io: { deriveScopedBaseSha: async () => "d".repeat(40) } });
    assert.equal(h.latestFor("claude-builder")?.stage, "LAUNCH_UNKNOWN", t.text);
    unacknowledged = false;
    const fetchImpl = async (url, opts) => /\/pulls\?/.test(String(url)) ? { status: 200, ok: true, json: async () => [] } : h.fetchImpl(url, opts);
    t = await h.runTick({ io: { skipActivationPreflight: false, fetchImpl, deriveScopedBaseSha: async () => "d".repeat(40) } });
    assert.match(t.text, /lifecycle: launch reconciliation for SHU-140 SKIPPED — activation contract unmet for claude-code/);
    assert.equal(h.latestFor("claude-builder").stage, "LAUNCH_UNKNOWN", "nothing is relaunched around the contract");
  } finally {
    h.cleanup();
  }
});

test("SHU71_CLAUDE_WRITER_TARGET_PROBE: a wired host still refuses a Claude build whose bound commit GitHub cannot show", async () => {
  const committed = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).fixture_lane;
  const fixture_lane = { id: "SHU-140", authorization_ref: committed.authorization_ref, initial_build_paths: committed.initial_build_paths,
    revision_paths: committed.revision_paths, seeded_defect_path: committed.seeded_defect_path };
  const h = createEpisodeHarness({ githubToken: "ghtok", writerLane: "claude-builder", reviewerLane: "codex-verifier", configOverrides: { fixture_lane } });
  try {
    const env = { CODEX_SANDBOX_NETWORK: "disabled", SHU_PUSH_BROKER_ENABLED: "true", SHU_WORKTREE_ROOT: "/srv/shu/worktrees",
      SHU_PUSH_REMOTE_URL: "git@github.com:BAWES-Universe/studenthub-platform.git", SHU_WORKER_UID: String(process.getuid() + 1),
      SHU_WORKER_LAUNCH_WRAPPER: "setpriv --reuid=shu-worker", COORDINATOR_HOST: "brick-box" };
    const io = { skipActivationPreflight: false, codexStateDir: "/srv/codex/coordinator-runs", statImpl: () => ({ isDirectory: () => true, mode: 0o40700 }),
      accessImpl: () => {}, realpathImpl: (p) => p, hostname: () => "brick-box", deriveScopedBaseSha: async () => "d".repeat(40),
      fetchImpl: async (url, opts) => {
        if (/\/pulls\?/.test(String(url))) return { status: 200, ok: true, json: async () => [] };
        if (/\/commits\/[0-9a-f]{40}$/.test(String(url))) return { status: 404, ok: false, json: async () => ({}) };
        return h.fetchImpl(url, opts);
      } };
    const t = await h.runTick({ env, io });
    assert.equal(t.code, 2, t.text);
    assert.match(t.text, /dispatch: ABORTED before reservation — activation GitHub probe failed for claude-code: GitHub target probe returned HTTP 404/);
    assert.deepEqual(h.triggers, { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 });
  } finally {
    h.cleanup();
  }
});
