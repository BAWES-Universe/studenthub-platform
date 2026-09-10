// test/fixture/episode-harness.mjs — SHU-225 end-to-end episode harness.
//
// One persistent fake Linear store + one fake adapter per lane, driven through the
// REAL main() so every assertion is about the coordinator's own behaviour rather
// than a simulation of it. The configuration under test is the FIXTURE's real one:
// committed `enable_dispatch: false` (so dispatch needs the armed activation) with
// the single-issue dispatch scope and the fixture lane binding.
//
// Nothing here launches anything real: the adapter modules are injected through
// io.adapterModules, GitHub head resolution short-circuits with no token, and the
// clock is frozen.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseReceiptsFromComments } from "../../reconcile.mjs";

// The head the WRITE binds to, and the head a revision moves the branch to.
export const SHA_INPUT = "a".repeat(40);
export const SHA_WRITE = "b".repeat(40);
export const SHA_REVISED = "c".repeat(40);
export const REVISION = "d".repeat(40);

export function createEpisodeHarness({
  issueId = "SHU-140",
  nodeId = "11111111-aaaa-4bbb-8ccc-000000000777",
  authorizationRef = "FIXTURE-OPUS-CONTRACT-20260905",
  revision = REVISION,
  now = new Date("2026-09-10T12:00:00.000Z"),
  expiresInMs = 60 * 60 * 1000,
  reviewerLane = "claude-verifier",
  withReviewerLane = true,
  callbackActor = "linear-worker-test",
  configOverrides = {},
  extraNodes = [],
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shu225-harness-"));
  const node = {
    id: nodeId,
    identifier: issueId,
    title: "SHU-140 fixture (one-slot seeded-defect loop)",
    state: { name: "Todo" },
    priorityLabel: "High",
    labels: { nodes: [{ name: "repo:platform" }] },
    assignee: null,
    delegate: null,
    parent: null,
    relations: { nodes: [] },
  };
  const nodes = [node, ...extraNodes];
  const comments = [];
  const pauses = [];
  const triggers = { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 };
  const polls = new Map();
  const launched = [];

  const linearFetch = async (url, opts) => {
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes } });
    if (query.includes("CoordinatorIssueComments")) {
      const known = nodes.some((n) => n.id === variables.issueId || n.identifier === variables.issueId);
      return respond({ issue: { comments: { nodes: known ? [...comments] : [] } } });
    }
    if (query.includes("commentCreate")) {
      if (!nodes.some((n) => n.id === variables.issueId)) throw new Error(`non-UUID comment write (${variables.issueId})`);
      const body = String(variables.body ?? "");
      if (body.startsWith("coordinator-pause:")) pauses.push(body);
      else comments.push({ body, createdAt: new Date().toISOString() });
      return respond({ commentCreate: { success: true, comment: { id: `c${comments.length + pauses.length}` } } });
    }
    return respond({});
  };

  const makeAdapter = (name) => ({
    async launchBuilder(o) {
      triggers[name] += 1;
      const runId = `${name === "claude-code" ? "clauderun" : "codexrun"}_${String(o.attempt_id).slice(0, 8)}_${triggers[name]}`;
      polls.set(runId, "running");
      launched.push({ lane: name, attempt_id: o.attempt_id, target_sha: o.target_sha, run_id: runId });
      return { stage: "RUNNING", external_run_id: runId, worker_identity: `${name}:session-${triggers[name]}`, conversation_url: `https://example.invalid/${runId}` };
    },
    async monitorRun(o) {
      const status = polls.get(o.run_id) ?? "running";
      if (status === "completed") {
        return { stage: "COMPLETED", worker_identity: `${name}:session-${String(o.attempt_id).slice(0, 4)}`, evidence_links: ["https://example.invalid/callback"] };
      }
      if (status === "failed") return { stage: "FAILED", error_code: "quota", error_kind: "quota", worker_identity: `${name}:session-x` };
      return { stage: "RUNNING", adapter_status: "in_progress", worker_identity: `${name}:session-${String(o.attempt_id).slice(0, 4)}` };
    },
  });

  const adapters = { "codex-cli": makeAdapter("codex-cli"), "claude-code": makeAdapter("claude-code") };

  const config = {
    pilot_repo: "BAWES-Universe/studenthub-platform",
    team: "SHU",
    max_dispatch: 1,
    // The fixture's real committed state: dispatch stays OFF in code, so the armed
    // activation is what authorizes the run.
    enable_dispatch: false,
    adapter_pause_map: {},
    wake_actor_allowlist: ["BAWES"],
    linear_callback_actor_ids: [callbackActor],
    max_failed_attempts: 3,
    dispatch_scope: { issue_ids: [issueId] },
    fixture_lane: { id: issueId, authorization_ref: authorizationRef },
    ...configOverrides,
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 1));

  const record = {
    activation_id: "shu225fixtureactivation",
    target_issue_id: issueId,
    authorization_ref: authorizationRef,
    coordinator_revision: revision,
    slots: 1,
    expires_at: new Date(now.getTime() + expiresInMs).toISOString(),
  };
  if (withReviewerLane) record.reviewer_lane = reviewerLane;
  const activationPath = join(dir, "activation.json");
  writeFileSync(activationPath, JSON.stringify(record, null, 1));
  chmodSync(activationPath, 0o600);

  const env = {
    ENABLE_DISPATCH: "true",
    LINEAR_API_TOKEN: "tok",
    // No GitHub token: head verification short-circuits to the bound target_sha,
    // which is the tri-state rule the coordinator defines for that case.
    GITHUB_TOKEN: "",
    DISPATCH_TARGET_SHA: SHA_INPUT,
  };

  const runTick = async (options = {}) => {
    const out = [];
    const code = await main(["--activation", activationPath], { ...env, ...(options.env ?? {}) }, {
      configPath,
      skipActivationPreflight: true,
      now: () => options.now ?? now,
      gitHead: revision,
      stdout: (s) => out.push(s),
      fetchDurable: true,
      pollRuns: true,
      adapterModules: adapters,
      fetchImpl: linearFetch,
    });
    return { code, text: out.join("\n") };
  };

  const receipts = () => parseReceiptsFromComments(comments);
  const receiptFor = (attemptId) => receipts().find((r) => r.attempt_id === attemptId);
  const latestFor = (worker) => receipts().filter((r) => r.requested_worker === worker).pop() ?? null;
  const postCallback = ({ attemptId, stage, targetSha, resultSha = null }) => {
    comments.push({
      user: { id: callbackActor, displayName: "Worker" },
      createdAt: new Date().toISOString(),
      body: [
        "coordinator-callback v1",
        "```json",
        JSON.stringify({ attempt_id: attemptId, target_sha: targetSha, stage, result_sha: resultSha, links: ["https://example.invalid/evidence"] }),
        "```",
      ].join("\n"),
    });
  };
  const completeRun = (runId) => polls.set(runId, "completed");
  const failRun = (runId) => polls.set(runId, "failed");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  return {
    dir,
    issueId,
    nodeId,
    nodes,
    comments,
    pauses,
    triggers,
    launched,
    adapters,
    config,
    configPath,
    activationPath,
    record,
    runTick,
    fetchImpl: linearFetch,
    receipts,
    receiptFor,
    latestFor,
    postCallback,
    completeRun,
    failRun,
    cleanup,
  };
}
