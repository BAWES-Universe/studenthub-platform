import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReceipt, receiptCommentBody } from "../reconcile.mjs";
import { createEpisodeHarness, REVISION, SHA_WRITE } from "./fixture/episode-harness.mjs";
import {
  LINEAR_REPAIR_CREATE_MUTATION,
  LINEAR_REPAIR_RELATION_MUTATION,
  LINEAR_REPAIR_UPDATE_MUTATION,
  LINEAR_TRIAGE_QUERY,
  MISSING_AUTHORITY,
  REPAIR_POLICIES,
  TRIAGE_EFFECTS,
  TRIAGE_RESUME_AUTHORITY,
  parseTriageMarkers,
  repairIdentity,
  repairPolicyDecision,
  renderRepairDescription,
  triageCoordinatorIncident,
} from "../incident-triage.mjs";

const COMMENT_MUTATION = "mutation CoordinatorTriageComment { commentCreate }";
const EVENT_ID = "inc_0123456789abcdef0123456789abcdef";
const INCIDENT_UUID = "11111111-aaaa-4bbb-8ccc-000000000900";
const INCIDENT_IDENTIFIER = "SHU-900";
const ORIGINAL = "SHU-140";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const BRANCH = "coordinator/SHU-901";
const TRUSTED_RECEIPT_ACTOR = "linear-coordinator-test";
const NOW = new Date("2026-09-15T00:00:00.000Z");
const TRIAGE_SOURCE = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../incident-triage.mjs"), "utf8");

function event(reason_code = "ambiguous_hold", overrides = {}) {
  return {
    event_id: EVENT_ID,
    issue_uuid: INCIDENT_UUID,
    issue_id: ORIGINAL,
    reason_code,
    raw_text: "SHU260_RAW_SENTINEL",
    ...overrides,
  };
}

function receipt({ n, worker, stage = "COMPLETED", verdict = null, target = HEAD, result = null, identity }) {
  const value = {
    receipt_version: "1.0.0",
    attempt_id: `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`,
    requested_worker: worker,
    stage,
    issue_id: "SHU-901",
    repo: "BAWES-Universe/studenthub-platform",
    branch: BRANCH,
    target_sha: target,
    worker_identity: identity,
  };
  if (verdict) value.verdict_stage = verdict;
  if (result) value.result_sha = result;
  return value;
}

function receiptComment(value, actor = TRUSTED_RECEIPT_ACTOR) {
  return { body: ["<!-- coordinator-receipt v1 (dry-run pilot) -->", "```json", JSON.stringify(value), "```"].join("\n"), createdAt: NOW.toISOString(), user: { id: actor } };
}

function fakeStore({ missingIncidentEvidence = false, lostCreate = false, dependencyState = "Done" } = {}) {
  const identity = repairIdentity(EVENT_ID);
  const incidentComments = [];
  const repairComments = [];
  const repairRelations = new Map();
  let repair = null;
  let createCount = 0;
  let updateCount = 0;
  let relationCount = 0;
  let commentCount = 0;
  let loseNextCreate = lostCreate;

  const labels = ["repo:platform", "type:implementation", "risk:R3", "worker:codex-builder", "verifier:opus"]
    .map((name, index) => ({ id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, name }));
  const dependency226 = { id: "22222222-2222-4222-8222-222222222226", identifier: "SHU-226", state: { name: dependencyState } };
  const dependency260 = { id: "22222222-2222-4222-8222-222222222260", identifier: "SHU-260", state: { name: dependencyState } };
  const incident = {
    id: INCIDENT_UUID,
    identifier: INCIDENT_IDENTIFIER,
    title: `coordinator stop: ${ORIGINAL} — ambiguous_hold`,
    description: missingIncidentEvidence ? "missing confirmed event marker" : `<!-- coordinator-incident-event ${EVENT_ID} -->`,
    team: { id: "33333333-3333-4333-8333-333333333333", key: "SHU" },
    state: { id: "44444444-4444-4444-8444-444444444444", name: "Triage", type: "triage" },
    labels: { nodes: [labels[0]] },
    assignee: null,
    delegate: null,
    relations: { nodes: [{ type: "related", relatedIssue: { id: "55555555-5555-4555-8555-555555555555", identifier: ORIGINAL, state: { name: "Todo" } } }] },
    comments: { nodes: incidentComments },
  };

  function relatedIssueFor(input) {
    if (input.relatedIssueId === INCIDENT_UUID) return { id: INCIDENT_UUID, identifier: INCIDENT_IDENTIFIER, state: { name: "Triage" } };
    if (input.relatedIssueId === dependency226.id) return dependency226;
    if (input.relatedIssueId === dependency260.id) return dependency260;
    return null;
  }

  function repairSnapshot() {
    if (!repair) return null;
    return {
      ...repair,
      relations: { nodes: [...repairRelations.values()].map((input) => input.relatedIssueId === repair.id
        ? ({ type: input.type === "blocks" ? "blockedBy" : input.type, relatedIssue: input.issueId === dependency226.id ? dependency226 : dependency260 })
        : ({ type: input.type, relatedIssue: relatedIssueFor(input) })) },
      comments: { nodes: repairComments },
    };
  }

  const sendLinear = async (query, variables) => {
    if (query === LINEAR_TRIAGE_QUERY) {
      return {
        incident,
        repair: repairSnapshot(),
        teams: { nodes: [{
          id: incident.team.id,
          key: "SHU",
          states: { nodes: [{ id: "66666666-6666-4666-8666-666666666666", name: "Todo", type: "unstarted" }] },
          labels: { nodes: labels },
        }] },
        dependency226,
        dependency260,
      };
    }
    if (query === LINEAR_REPAIR_CREATE_MUTATION) {
      createCount += 1;
      const input = variables.input;
      repair = {
        id: input.id,
        identifier: "SHU-901",
        title: input.title,
        description: input.description,
        team: { id: input.teamId, key: "SHU" },
        state: { id: input.stateId, name: "Todo", type: "unstarted" },
        labels: { nodes: labels.filter((label) => input.labelIds.includes(label.id)) },
        assignee: null,
        delegate: null,
        attachments: { nodes: [] },
      };
      if (loseNextCreate) {
        loseNextCreate = false;
        throw new Error("lost response with raw sentinel");
      }
      return { issueCreate: { success: true, issue: { id: repair.id, identifier: repair.identifier } } };
    }
    if (query === LINEAR_REPAIR_UPDATE_MUTATION) {
      updateCount += 1;
      Object.assign(repair, {
        title: variables.input.title,
        description: variables.input.description,
        labels: { nodes: labels.filter((label) => variables.input.labelIds.includes(label.id)) },
      });
      return { issueUpdate: { success: true, issue: { id: repair.id, identifier: repair.identifier } } };
    }
    if (query === LINEAR_REPAIR_RELATION_MUTATION) {
      relationCount += 1;
      repairRelations.set(variables.input.id, variables.input);
      return { issueRelationCreate: { success: true, issueRelation: { id: variables.input.id } } };
    }
    if (query === COMMENT_MUTATION) {
      commentCount += 1;
      assert.equal(variables.issueId, INCIDENT_UUID, "triage comments stay on the confirmed incident");
      incidentComments.push({ body: variables.body, createdAt: NOW.toISOString() });
      return { commentCreate: { success: true, comment: { id: `comment-${commentCount}` } } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };

  const fetchImpl = async (url) => {
    assert.equal(String(url), "https://api.github.com/repos/BAWES-Universe/studenthub-platform/pulls/123");
    return {
      ok: true,
      json: async () => ({
        html_url: "https://github.com/BAWES-Universe/studenthub-platform/pull/123",
        merged_at: "2026-09-15T01:00:00.000Z",
        merge_commit_sha: MERGE,
        head: { sha: HEAD, ref: BRANCH, repo: { full_name: "BAWES-Universe/studenthub-platform" } },
      }),
    };
  };

  const run = (overrides = {}) => triageCoordinatorIncident({
    event: event(),
    confirmed: true,
    token: "linear-token",
    githubToken: "github-token",
    fetchImpl,
    sendLinear,
    commentMutation: COMMENT_MUTATION,
    receiptActorIds: [TRUSTED_RECEIPT_ACTOR],
    now: NOW,
    timeoutMs: 25,
    ...overrides,
  });

  return {
    identity,
    incident,
    incidentComments,
    repairComments,
    repairRelations,
    run,
    get repair() { return repair; },
    get counts() { return { create: createCount, update: updateCount, relation: relationCount, comment: commentCount }; },
    markDone({ attachments = [], comments = [] } = {}) {
      repair.state = { ...repair.state, name: "Done", type: "completed" };
      repair.attachments = { nodes: attachments };
      repairComments.splice(0, repairComments.length, ...comments);
    },
  };
}

test("SHU-260 positive control: a confirmed allowlisted incident creates one eligible bounded repair", async () => {
  const store = fakeStore();
  const result = await store.run();
  assert.equal(result.status, "REPAIR_READY");
  assert.equal(result.resume, false, "no premature resume");
  assert.equal(TRIAGE_RESUME_AUTHORITY, false);
  assert.deepEqual(store.counts, { create: 1, update: 0, relation: 3, comment: 1 });
  assert.equal(store.repair.id, store.identity.issue_uuid);
  assert.equal(store.repair.state.name, "Todo");
  assert.equal(store.repair.assignee, null);
  assert.deepEqual([...store.repair.labels.nodes.map((label) => label.name)].sort(), [
    "repo:platform", "risk:R3", "type:implementation", "verifier:opus", "worker:codex-builder",
  ].sort());
  assert.deepEqual([...store.repairRelations.values()].map((relation) => relation.type).sort(), ["blocks", "blocks", "related"]);
  for (const relation of [...store.repairRelations.values()].filter((entry) => entry.type === "blocks")) {
    assert.equal(relation.relatedIssueId, store.identity.issue_uuid, "fixed dependencies block the repair in Linear's canonical direction");
    assert.match(relation.issueId, /(?:2226|2260)$/, "only fixed dependencies are linked");
  }
  assert.match(store.repair.description, /Allowed paths: `\.github\/coordinator`/);
});

test("SHU-260 positive control: the real stopped tick triages the SHU-226 confirmation without launching", async () => {
  const activationId = "shu260integration01";
  const h = createEpisodeHarness({ activationId, githubToken: "github-token", now: NOW });
  try {
    const made = createReceipt({
      issue_id: ORIGINAL,
      authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
      requested_worker: "claude-verifier",
      repo: "BAWES-Universe/studenthub-platform",
      branch: `coordinator/${ORIGINAL}`,
      target_sha: SHA_WRITE,
      attempt_id: "99999999-0000-4000-8000-000000000001",
      episode_id: activationId,
      reserved_at: NOW.toISOString(),
    });
    assert.equal(made.ok, true);
    const held = {
      ...made.receipt,
      stage: "HOLD",
      worker_identity: "claude:integration-reviewer",
      external_run_id: "run_integration",
      adapter_status: "completed",
      timestamps: { reserved: NOW.toISOString(), launch: NOW.toISOString(), heartbeat: null, terminal: NOW.toISOString() },
      last_activity: NOW.toISOString(),
      notes: [],
    };
    h.comments.push({ body: receiptCommentBody(held), createdAt: NOW.toISOString() });
    const before = { ...h.triggers };
    const tick = await h.runTick();
    assert.equal(tick.code, 2, "the original breaker remains stopped");
    assert.deepEqual(h.triggers, before, "bounded triage never launches or resumes");
    assert.equal(h.incidentIssues.size, 1);
    assert.equal(h.repairIssues.size, 1, "the confirmed incident is triaged in the same stopped tick");
    const repair = [...h.repairIssues.values()][0];
    assert.equal(repair.state.name, "Todo");
    assert.match(repair.description, /coordinator-ambiguous-verdict-repair-v1/);
    assert.equal(REVISION.length, 40);
  } finally { h.cleanup(); }
});

test("SHU-260 unknown-reason auto-routing is forbidden and all authority-bearing reasons stay MISSING_AUTHORITY", async () => {
  const expected = new Map([
    ["not_allowlisted", MISSING_AUTHORITY.UNKNOWN_REASON],
    ["revision_budget_exhausted", MISSING_AUTHORITY.PRODUCT_DECISION],
    ["failure_budget_exhausted", MISSING_AUTHORITY.CREDENTIALS],
    ["stale_head", MISSING_AUTHORITY.DESTRUCTIVE_WORK],
    ["unreadable_head", MISSING_AUTHORITY.PRODUCTION_CONTACT],
    ["adapter_paused", MISSING_AUTHORITY.CREDENTIALS],
    ["activation_expired", MISSING_AUTHORITY.GRANT_OR_AUTHORIZATION],
  ]);
  for (const [reason, requirement] of expected) {
    const store = fakeStore();
    store.incident.title = `coordinator stop: ${ORIGINAL} — ${reason}`;
    const result = await store.run({ event: event(reason) });
    assert.equal(result.status, "MISSING_AUTHORITY", `${reason} remains Triage`);
    assert.ok(result.requirements.includes(requirement));
    assert.equal(store.repair, null, "unknown-reason auto-routing never creates a repair");
    assert.equal(store.incident.state.name, "Triage");
    assert.equal(store.incident.assignee, null);
  }
});

test("SHU-260 product-decision leakage and every forbidden authority invalidate policy", () => {
  for (const authority of [
    "PRODUCT_DECISION", "GRANT_OR_AUTHORIZATION", "CREDENTIALS", "SPENDING", "DEPLOYMENT", "ACTIVATION", "DESTRUCTIVE_WORK", "PRODUCTION_CONTACT",
  ]) {
    const policy = { ...REPAIR_POLICIES.ambiguous_hold, authorities: [authority] };
    const decision = repairPolicyDecision(event(), { ambiguous_hold: policy });
    assert.deepEqual(decision.requirements, [MISSING_AUTHORITY.POLICY_INVALID], `product-decision leakage: ${authority}`);
  }
});

test("SHU-260 same-family verifier is never eligible", () => {
  const policy = { ...REPAIR_POLICIES.ambiguous_hold, verifier_name: "gpt" };
  const decision = repairPolicyDecision(event(), { ambiguous_hold: policy });
  assert.deepEqual(decision.requirements, [MISSING_AUTHORITY.POLICY_INVALID], "same-family verifier must be refused");
});

test("SHU-260 duplicate card: retries and restart converge on one deterministic repair", async () => {
  const store = fakeStore();
  const before = repairIdentity(EVENT_ID);
  assert.deepEqual(before, repairIdentity(EVENT_ID));
  assert.equal((await store.run()).status, "REPAIR_READY");
  store.repair.title = "drifted but identity-bound title";
  assert.equal((await store.run()).status, "REPAIR_READY");
  assert.equal(store.counts.create, 1, "duplicate card creation is impossible");
  assert.equal(store.counts.update, 1, "an identity-bound Todo repair is deterministically updated in place");
  assert.equal(store.repair.title, `coordinator repair: ${ORIGINAL} — ambiguous_hold`);
  assert.equal(store.repair.id, before.issue_uuid);
  assert.equal(store.incidentComments.filter((comment) => parseTriageMarkers([comment]).some((marker) => marker.status === "REPAIR_READY")).length, 1);
});

test("SHU-260 lost response: committed create is recovered by deterministic lookup", async () => {
  const store = fakeStore({ lostCreate: true });
  const result = await store.run();
  assert.equal(result.status, "REPAIR_READY", "lost response cannot lose the repair");
  assert.equal(store.counts.create, 1);
  assert.equal(store.repair.id, store.identity.issue_uuid);
});

test("SHU-260 raw-text leakage is impossible", async () => {
  const store = fakeStore();
  const logs = [];
  const result = await store.run({ event: event("ambiguous_hold", { raw_text: "SHU260_RAW_SENTINEL", env: { TOKEN: "SHU260_RAW_SENTINEL" } }), stdout: (line) => logs.push(line) });
  assert.equal(result.status, "REPAIR_READY");
  assert.doesNotMatch(JSON.stringify({ repair: store.repair, comments: store.incidentComments, logs }), /SHU260_RAW_SENTINEL/, "raw-text leakage");
  assert.ok(renderRepairDescription(event(), store.identity, REPAIR_POLICIES.ambiguous_hold));
});

test("SHU-260 missing evidence cannot create or update a repair", async () => {
  const store = fakeStore({ missingIncidentEvidence: true });
  const result = await store.run();
  assert.equal(result.status, "MISSING_AUTHORITY");
  assert.deepEqual(result.requirements, [MISSING_AUTHORITY.INCIDENT_EVIDENCE_INVALID]);
  assert.equal(store.counts.create, 0, "missing evidence writes no repair");
  assert.equal(store.counts.update, 0);
  assert.equal(store.counts.comment, 0, "unconfirmed input is not trusted even for a marker");
});

test("SHU-260 durable incident→repair→PR→verdict→merge lineage and no premature resume", async () => {
  const store = fakeStore();
  assert.equal((await store.run()).status, "REPAIR_READY");
  store.markDone();
  assert.equal((await store.run()).status, "WAITING_FOR_LANDED_LINEAGE", "Done without a PR cannot clear the breaker");
  const attachment = { url: "https://github.com/BAWES-Universe/studenthub-platform/pull/123", title: "repair PR" };
  const author = receipt({ n: 1, worker: "codex-builder", result: HEAD, identity: "codex:author" });
  const staleReview = receipt({ n: 2, worker: "claude-verifier", verdict: "PASS", target: "c".repeat(40), identity: "claude:reviewer" });
  store.markDone({ attachments: [attachment], comments: [receiptComment(author), receiptComment(staleReview)] });
  assert.equal((await store.run()).status, "WAITING_FOR_LANDED_LINEAGE", "a stale verdict cannot clear the breaker");
  const exactReview = receipt({ n: 3, worker: "claude-verifier", verdict: "PASS", identity: "claude:reviewer" });
  const sameIdentityReview = receipt({ n: 3, worker: "claude-verifier", verdict: "PASS", identity: "codex:author" });
  store.markDone({ attachments: [attachment], comments: [receiptComment(author), receiptComment(sameIdentityReview)] });
  assert.equal((await store.run()).status, "WAITING_FOR_LANDED_LINEAGE", "author and verifier identities must be distinct");
  store.markDone({ attachments: [attachment], comments: [receiptComment(author), receiptComment(exactReview, "untrusted-linear-user")] });
  assert.equal((await store.run()).status, "WAITING_FOR_LANDED_LINEAGE", "untrusted comment authors cannot forge a verdict receipt");
  store.markDone({ attachments: [attachment], comments: [receiptComment(author), receiptComment(exactReview)] });
  const landed = await store.run();
  assert.equal(landed.status, "LANDED");
  assert.equal(landed.precondition_cleared, true);
  assert.equal(landed.resume, false, "no premature resume even after evidence is complete; a new authority is still required");
  assert.deepEqual(landed.lineage, {
    repair_id: store.identity.issue_uuid,
    repair_identifier: "SHU-901",
    pr_url: attachment.url,
    pr_number: 123,
    verdict: "PASS",
    verdict_head: HEAD,
    landed_revision: MERGE,
  });
  const marker = parseTriageMarkers(store.incidentComments).find((entry) => entry.status === "LANDED");
  assert.equal(marker.verdict_head, HEAD);
  assert.equal(marker.landed_revision, MERGE);
  assert.equal(store.incident.state.name, "Triage", "the retained incident is never closed or reassigned by triage");
});

test("SHU-260 self-edit: triage has no filesystem or execution-plane capability", () => {
  assert.deepEqual(TRIAGE_EFFECTS, ["linear-read", "linear-write", "github-read"], "self-edit capability is forbidden");
  assert.equal(TRIAGE_EFFECTS.some((effect) => /filesystem|process|exec|workspace|activation/.test(effect)), false, "self-edit capability is forbidden");
  assert.doesNotMatch(TRIAGE_SOURCE, /from "node:(?:fs|child_process)"|\b(?:writeFile|rename|unlink|chmod|spawn|execFile|process\.kill)\b/, "self-edit implementation is forbidden");
});
