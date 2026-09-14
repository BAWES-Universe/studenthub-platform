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
  // SHU-231: the episode identity is the record's activation_id, and
  // `supersedes_attempt_ids` names the retained evidence this approval retires.
  activationId = "shu225fixtureactivation",
  supersedesAttemptIds = null,
  callbackActor = "linear-worker-test",
  githubToken = "",
  initialBranchHead = SHA_INPUT,
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
  const incidentIssues = new Map();
  const incidentRelations = new Map();
  const repairIssues = new Map();
  const repairRelations = new Map();
  const entityComments = new Map();
  const incidentCreatePlan = [];
  const triggers = { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 };
  const polls = new Map();
  const launched = [];
  const branchHead = { value: initialBranchHead };

  const linearFetch = async (url, opts) => {
    const respond = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes("CoordinatorIssues")) return respond({ issues: { nodes } });
    if (query.includes("CoordinatorIncidentComments")) {
      return respond({ issue: { comments: { nodes: [...comments] } } });
    }
    if (query.includes("CoordinatorIncidentLookup")) {
      const issue = incidentIssues.get(variables.issueId) ?? null;
      if (!issue) return respond({ issue: null });
      const relations = [...incidentRelations.values()]
        .filter((relation) => relation.issueId === issue.id)
        .map(() => ({ type: "related", relatedIssue: { id: nodeId, identifier: issueId } }));
      return respond({ issue: { ...issue, relations: { nodes: relations } } });
    }
    if (query.includes("CoordinatorIncidentTriage")) {
      const incident = incidentIssues.get(variables.incidentId) ?? null;
      const repair = repairIssues.get(variables.repairId) ?? null;
      const incidentRelationNodes = incident
        ? [...incidentRelations.values()].filter((relation) => relation.issueId === incident.id)
          .map(() => ({ type: "related", relatedIssue: { id: nodeId, identifier: issueId, state: { name: node.state.name } } }))
        : [];
      const repairRelationNodes = repair
        ? [...repairRelations.values()].filter((relation) => relation.issueId === repair.id || relation.relatedIssueId === repair.id).map((relation) => {
          if (relation.relatedIssueId === variables.incidentId) return { type: relation.type, relatedIssue: { id: variables.incidentId, identifier: incident?.identifier, state: { name: "Triage" } } };
          const dependency = relation.issueId.endsWith("0226") ? "SHU-226" : "SHU-260";
          return { type: relation.type === "blocks" ? "blockedBy" : relation.type, relatedIssue: { id: relation.issueId, identifier: dependency, state: { name: "Done" } } };
        })
        : [];
      const triageLabels = ["repo:platform", "type:implementation", "risk:R3", "worker:codex-builder", "verifier:opus"]
        .map((name, index) => ({ id: `${String(index + 1).padStart(8, "0")}-7777-4777-8777-777777777777`, name }));
      return respond({
        incident: incident ? { ...incident, delegate: null, relations: { nodes: incidentRelationNodes }, comments: { nodes: entityComments.get(incident.id) ?? [] } } : null,
        repair: repair ? { ...repair, delegate: null, relations: { nodes: repairRelationNodes }, attachments: repair.attachments ?? { nodes: [] }, comments: { nodes: entityComments.get(repair.id) ?? [] } } : null,
        teams: { nodes: [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", key: "SHU",
          states: { nodes: [{ id: "77777777-7777-4777-8777-777777777777", name: "Todo", type: "unstarted" }] },
          labels: { nodes: triageLabels },
        }] },
        dependency226: { id: "22222222-2222-4222-8222-222222220226", identifier: "SHU-226", state: { name: "Done" } },
        dependency260: { id: "22222222-2222-4222-8222-222222220260", identifier: "SHU-260", state: { name: "Done" } },
      });
    }
    if (query.includes("CoordinatorIncidentMetadata")) {
      return respond({ teams: { nodes: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        key: "SHU",
        states: { nodes: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Triage", type: "triage" }] },
        labels: { nodes: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "repo:platform" }] },
      }] } });
    }
    if (query.includes("CoordinatorIncidentCreate")) {
      const input = variables.input;
      const planned = incidentCreatePlan.shift() ?? "success";
      if (planned === "never") return new Promise(() => {});
      if (planned === "503") return { status: 503, ok: false, json: async () => ({ errors: [{ message: "sentinel-http-body" }] }) };
      if (planned === "429") return { status: 429, ok: false, json: async () => ({ errors: [{ message: "sentinel-rate-limit-body" }] }) };
      if (incidentIssues.has(input.id)) return { status: 200, ok: true, json: async () => ({ errors: [{ message: "duplicate id" }] }) };
      const issue = {
        id: input.id,
        identifier: `SHU-${900 + incidentIssues.size}`,
        title: input.title,
        description: input.description,
        team: { id: input.teamId, key: "SHU" },
        state: { id: input.stateId, name: "Triage", type: "triage" },
        labels: { nodes: [{ id: input.labelIds[0], name: "repo:platform" }] },
        assignee: null,
      };
      incidentIssues.set(input.id, issue);
      if (planned === "lost") throw new Error("sentinel-lost-response-body");
      return respond({ issueCreate: { success: true, issue: { id: issue.id, identifier: issue.identifier } } });
    }
    if (query.includes("CoordinatorIncidentRelate")) {
      incidentRelations.set(variables.input.id, variables.input);
      return respond({ issueRelationCreate: { success: true, issueRelation: { id: variables.input.id } } });
    }
    if (query.includes("CoordinatorRepairCreate")) {
      const input = variables.input;
      const labels = ["repo:platform", "type:implementation", "risk:R3", "worker:codex-builder", "verifier:opus"]
        .map((name, index) => ({ id: `${String(index + 1).padStart(8, "0")}-7777-4777-8777-777777777777`, name }))
        .filter((label) => input.labelIds.includes(label.id));
      const issue = {
        id: input.id, identifier: `SHU-${950 + repairIssues.size}`, title: input.title, description: input.description,
        team: { id: input.teamId, key: "SHU" }, state: { id: input.stateId, name: "Todo", type: "unstarted" },
        labels: { nodes: labels }, assignee: null,
      };
      repairIssues.set(input.id, issue);
      return respond({ issueCreate: { success: true, issue: { id: issue.id, identifier: issue.identifier } } });
    }
    if (query.includes("CoordinatorRepairUpdate")) {
      const issue = repairIssues.get(variables.id);
      if (!issue) return respond({ issueUpdate: { success: false, issue: null } });
      Object.assign(issue, { title: variables.input.title, description: variables.input.description });
      return respond({ issueUpdate: { success: true, issue: { id: issue.id, identifier: issue.identifier } } });
    }
    if (query.includes("CoordinatorRepairRelate")) {
      repairRelations.set(variables.input.id, variables.input);
      return respond({ issueRelationCreate: { success: true, issueRelation: { id: variables.input.id } } });
    }
    if (query.includes("CoordinatorIssueComments")) {
      const known = nodes.some((n) => n.id === variables.issueId || n.identifier === variables.issueId);
      return respond({ issue: { comments: { nodes: known ? [...comments] : [] } } });
    }
    if (query.includes("commentCreate")) {
      const isFixture = nodes.some((n) => n.id === variables.issueId);
      const isEntity = incidentIssues.has(variables.issueId) || repairIssues.has(variables.issueId);
      if (!isFixture && !isEntity) throw new Error(`non-UUID comment write (${variables.issueId})`);
      const body = String(variables.body ?? "");
      if (isEntity) {
        const list = entityComments.get(variables.issueId) ?? [];
        list.push({ body, createdAt: new Date().toISOString() });
        entityComments.set(variables.issueId, list);
      } else if (body.startsWith("coordinator-pause:")) pauses.push(body);
      else comments.push({ body, createdAt: new Date().toISOString() });
      return respond({ commentCreate: { success: true, comment: { id: `c${comments.length + pauses.length}` } } });
    }
    return respond({});
  };

  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      if (/\/branches\//.test(u)) {
        return { status: 200, ok: true, json: async () => ({ commit: { sha: branchHead.value } }) };
      }
      const commit = /\/commits\/([0-9a-f]{40})$/.exec(u);
      if (commit) return { status: 200, ok: true, json: async () => ({ sha: commit[1] }) };
      return { status: 404, ok: false, json: async () => ({}) };
    }
    return linearFetch(url, opts);
  };

  const makeAdapter = (name) => ({
    async launchBuilder(o) {
      triggers[name] += 1;
      const runId = `${name === "claude-code" ? "clauderun" : "codexrun"}_${String(o.attempt_id).slice(0, 8)}_${triggers[name]}`;
      polls.set(runId, "running");
      launched.push({ lane: name, attempt_id: o.attempt_id, target_sha: o.target_sha, run_id: runId,
        cwd: o.cwd, workspace_scope: o.workspace_scope, scope_phase: o.scope_phase,
        allowed_paths: o.allowed_paths, scoped_base_sha: o.scoped_base_sha });
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
    linear_receipt_actor_ids: [callbackActor],
    max_failed_attempts: 3,
    dispatch_scope: { issue_ids: [issueId] },
    fixture_lane: { id: issueId, authorization_ref: authorizationRef },
    ...configOverrides,
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 1));

  const record = {
    activation_id: activationId,
    target_issue_id: issueId,
    authorization_ref: authorizationRef,
    coordinator_revision: revision,
    slots: 1,
    expires_at: new Date(now.getTime() + expiresInMs).toISOString(),
  };
  if (withReviewerLane) record.reviewer_lane = reviewerLane;
  if (supersedesAttemptIds) record.supersedes_attempt_ids = supersedesAttemptIds;
  const activationPath = join(dir, "activation.json");
  writeFileSync(activationPath, JSON.stringify(record, null, 1));
  chmodSync(activationPath, 0o600);

  const env = {
    ENABLE_DISPATCH: "true",
    LINEAR_API_TOKEN: "tok",
    GITHUB_TOKEN: githubToken,
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
      fetchImpl,
      ...(options.io ?? {}),
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
  const planIncidentCreates = (...plan) => incidentCreatePlan.push(...plan);

  return {
    dir,
    issueId,
    nodeId,
    nodes,
    comments,
    pauses,
    incidentIssues,
    incidentRelations,
    repairIssues,
    repairRelations,
    entityComments,
    triggers,
    launched,
    adapters,
    config,
    configPath,
    activationPath,
    record,
    branchHead,
    runTick,
    fetchImpl,
    receipts,
    receiptFor,
    latestFor,
    postCallback,
    completeRun,
    failRun,
    planIncidentCreates,
    cleanup,
  };
}
