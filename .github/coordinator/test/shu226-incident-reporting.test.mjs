import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReceipt,
  LINEAR_COMMENT_CREATE_MUTATION,
  receiptCommentBody,
  sendLinear,
} from "../reconcile.mjs";
import { MISSING_AUTHORITY, repairPolicyDecision } from "../incident-triage.mjs";
import {
  CARD_SETTLED_STATE,
  FIXTURE_SETTLED_STATE,
  renderStopSummary,
  settleCoordinatorIncident,
  stopSummaryMarker,
  STOP_SUMMARY_ISSUE,
} from "../incident-settlement.mjs";
import { isFixtureIssue } from "../workspace-scope.mjs";
import {
  deriveIncidentEvent,
  incidentIdentity,
  INCIDENT_MAX_BODY_BYTES,
  INCIDENT_REASON,
  INCIDENT_STATE_NAME,
  parseIncidentMarkers,
  renderIncidentDescription,
  renderIncidentMarker,
  reportCoordinatorIncident,
  reportingExceptionAllowsLaunch,
} from "../incident-reporting.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, SHA_REVISED, REVISION } from "./fixture/episode-harness.mjs";

const TARGET = "SHU-140";
const ACTIVATION = "shu226fixture0001";
const NOW = new Date("2026-09-14T12:00:00.000Z");
const CONTRACT = "FIXTURE-OPUS-CONTRACT-20260905";

function attemptId(n) {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function receipt({ n = 1, worker = "codex-builder", stage = "HOLD", verdict = null, target = SHA_INPUT, result = null, at = NOW.toISOString(), stop = null } = {}) {
  const made = createReceipt({
    issue_id: TARGET,
    authorization_ref: CONTRACT,
    requested_worker: worker,
    repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${TARGET}`,
    target_sha: target,
    attempt_id: attemptId(n),
    episode_id: ACTIVATION,
    reserved_at: at,
  });
  assert.equal(made.ok, true, made.errors?.join("; "));
  const value = {
    ...made.receipt,
    stage,
    worker_identity: `${worker}:session-${n}`,
    external_run_id: `run_${n}`,
    adapter_status: stage === "FAILED" ? "failed" : "completed",
    timestamps: { reserved: at, launch: at, heartbeat: null, terminal: at },
    last_activity: at,
    notes: [],
  };
  if (verdict) value.verdict_stage = verdict;
  if (result) value.result_sha = result;
  if (stop) value.stop_reason_code = stop;
  return value;
}

function activation(overrides = {}) {
  return {
    requested: true,
    state: "armed",
    valid: true,
    activation_id: ACTIVATION,
    target_issue_id: TARGET,
    coordinator_revision: REVISION,
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

function eventFor(receipts, reason, activationOverrides = {}, config = {}) {
  const event = deriveIncidentEvent({
    activation: activation(activationOverrides),
    receipts,
    config,
    episodeDecision: reason,
  });
  assert.ok(event, "a proven breaker derives an incident event");
  return event;
}

async function fileWithHarness(h, event, overrides = {}) {
  return reportCoordinatorIncident({
    event,
    authorized: true,
    targetLinearId: h.nodeId,
    config: h.config,
    token: "tok",
    fetchImpl: h.fetchImpl,
    sendLinear,
    commentMutation: LINEAR_COMMENT_CREATE_MUTATION,
    now: overrides.now ?? NOW,
    stdout: overrides.stdout ?? (() => {}),
    timeoutMs: overrides.timeoutMs ?? 25,
  });
}

function pushReceipts(h, receipts) {
  for (const item of receipts) h.comments.push({ body: receiptCommentBody(item), createdAt: item.last_activity });
}

test("SHU-226 A1: ambiguous review HOLD ends the episode and files one allowlisted Triage card", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, githubToken: "ghtok", now: NOW });
  try {
    const held = receipt({ n: 1, worker: "claude-verifier", stage: "HOLD", target: SHA_WRITE });
    pushReceipts(h, [held]);
    const before = { ...h.triggers };
    const tick = await h.runTick();
    assert.equal(tick.code, 2, "the breaker still stops the episode");
    assert.deepEqual(h.triggers, before, "incident reporting never launches");
    assert.equal(h.incidentIssues.size, 1, "one incident card is delivered");
    const incident = [...h.incidentIssues.values()][0];
    assert.equal(incident.title, `coordinator stop: ${TARGET} — ambiguous_hold`);
    assert.equal(incident.state.name, "Triage", "an incident card is filed in Triage, never pickable");
    assert.equal(incident.assignee, null);
    assert.match(incident.description, new RegExp(held.attempt_id));
    assert.match(incident.description, /lane `claude-verifier`/);
    assert.match(incident.description, new RegExp(SHA_WRITE));
    assert.equal(h.incidentRelations.size, 1, "the card is related to the fixture");
  } finally { h.cleanup(); }
});

test("SHU-226 A1: a synchronous breaker is reported in the tick that persists it", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  try {
    h.adapters["codex-cli"].launchBuilder = async () => ({
      stage: "FAILED",
      error_kind: "quota",
      error_code: "HTTP_429",
      pause_adapter: true,
      worker_identity: "codex-cli:session-held",
    });
    const tick = await h.runTick();
    assert.equal(tick.code, 2, "the synchronous pause remains a breaker");
    assert.equal(h.incidentIssues.size, 1, "the persisted breaker is reported without waiting for another wakeup");
    assert.match([...h.incidentIssues.values()][0].title, /adapter_paused$/);
  } finally { h.cleanup(); }
});

test("SHU-226 A2/A3: revision and retryable-failure exhaustion each file all bounded attempts", async () => {
  const revisionReceipts = [
    receipt({ n: 1, stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE }),
    receipt({ n: 2, worker: "claude-verifier", stage: "HOLD", verdict: "BLOCKED", target: SHA_WRITE, at: "2026-09-14T12:01:00.000Z" }),
    receipt({ n: 3, stage: "COMPLETED", verdict: "REVISION_READY", target: SHA_WRITE, result: SHA_REVISED, at: "2026-09-14T12:02:00.000Z" }),
    receipt({ n: 4, worker: "claude-verifier", stage: "HOLD", verdict: "BLOCKED", target: SHA_REVISED, at: "2026-09-14T12:03:00.000Z" }),
  ];
  const failures = [1, 2, 3].map((n) => receipt({ n, stage: "FAILED", at: `2026-09-14T12:0${n}:00.000Z` }));
  for (const [name, receipts, decision, expected] of [
    ["revision", revisionReceipts, { ended: true, reason: "revision attempts exhausted — the episode is over" }, INCIDENT_REASON.REVISION_EXHAUSTED],
    ["failure", failures, { ended: true, reason: "retryable failures exhausted (3/3)" }, INCIDENT_REASON.FAILURE_EXHAUSTED],
  ]) {
    const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW, configOverrides: { max_revise: 1 } });
    try {
      const event = eventFor(receipts, decision, {}, { ...h.config, max_revise: 1 });
      assert.equal(event.reason_code, expected, `${name} gets its canonical reason`);
      const result = await fileWithHarness(h, event);
      assert.equal(result.status, "confirmed");
      const body = [...h.incidentIssues.values()][0].description;
      for (const item of receipts) assert.match(body, new RegExp(item.attempt_id), `${name}: every attempt is retained`);
      assert.match(body, /max_revise=1/);
      assert.match(body, /max_failed_attempts=3/);
    } finally { h.cleanup(); }
  }
});

test("SHU-226 A4 (M1): replay does not duplicate", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  try {
    const event = eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" });
    assert.equal((await fileWithHarness(h, event)).status, "confirmed");
    const withoutConfirmation = h.comments.filter((comment) => !parseIncidentMarkers([comment]).some((marker) => marker.status === "confirmed"));
    h.comments.splice(0, h.comments.length, ...withoutConfirmation);
    h.incidentRelations.clear(); // crash after issue creation, before the related-to edge was confirmed
    assert.equal((await fileWithHarness(h, event, { now: new Date(NOW.getTime() + 1000) })).status, "confirmed", "a delivered deterministic identity is recovered even without the confirmation marker");
    for (let n = 2; n < 4; n += 1) assert.equal((await fileWithHarness(h, event, { now: new Date(NOW.getTime() + n * 1000) })).status, "confirmed");
    assert.equal(h.incidentIssues.size, 1, "replay does not duplicate");
    assert.equal(h.incidentRelations.size, 1);
  } finally { h.cleanup(); }
});

test("SHU-226 A4 (M2/M3/M10): refused, default, dry-run, and unproven ticks write zero", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  try {
    const event = eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" });
    const calls = [];
    const send = async (...args) => { calls.push(args); throw new Error("must not run"); };
    for (const [name, authorized] of [["refused activation", false], ["disabled default", false], ["dry run", false], ["unproven episode", false]]) {
      const result = await reportCoordinatorIncident({ event, authorized, targetLinearId: h.nodeId, token: "tok", sendLinear: send, commentMutation: LINEAR_COMMENT_CREATE_MUTATION });
      assert.equal(result.status, "not_authorized", `${name} is inert`);
    }
    assert.equal(calls.length, 0, "a refused activation still writes zero");
    assert.equal(calls.length, 0, "disabled means disabled: zero writes");
    assert.equal(calls.length, 0, "an unproven episode never writes");
    assert.equal(deriveIncidentEvent({ activation: activation(), receipts: [], episodeDecision: { ended: true, reason: "unknown" } }), null, "durable launch proof is mandatory");
    assert.equal(deriveIncidentEvent({ activation: activation({ state: "refused", reporting_exception: null }), receipts: [receipt()], episodeDecision: { ended: true, reason: "unknown" } }), null, "a refused activation still writes zero");
  } finally { h.cleanup(); }
});

test("SHU-226 A5: a failed card write never prevents the stop; reporting is bounded", async () => {
  for (const failure of ["503", "429", "never"]) {
    const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
    try {
      const event = eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" });
      h.planIncidentCreates(failure);
      const started = Date.now();
      const result = await fileWithHarness(h, event, { timeoutMs: 10 });
      assert.equal(result.status, "pending", "a failed card write never prevents the stop");
      assert.ok(Date.now() - started < 500, "reporting is bounded");
      assert.equal(h.incidentIssues.size, 0);
      const markers = parseIncidentMarkers(h.comments);
      assert.ok(markers.some((marker) => marker.status === "pending"), "a visible pending state remains");
    } finally { h.cleanup(); }
  }
});

test("SHU-226 A5: three bounded failed attempts end in a visible exhausted state", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  try {
    const event = eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" });
    h.planIncidentCreates("503", "503", "503");
    const outcomes = [];
    for (const offset of [0, 2_000, 10_000]) outcomes.push((await fileWithHarness(h, event, { now: new Date(NOW.getTime() + offset) })).status);
    assert.deepEqual(outcomes, ["pending", "pending", "exhausted"]);
    assert.ok(parseIncidentMarkers(h.comments).some((marker) => marker.status === "exhausted"), "reporting exhaustion is durable and visible");
    assert.equal(h.incidentIssues.size, 0);
    assert.equal(h.triggers["codex-cli"], 0, "reporting outage cannot launch");
  } finally { h.cleanup(); }
});

test("SHU-226 A6: every breaker maps to a card; PASS and availability gaps map to none", async () => {
  const base = [receipt()];
  const cases = [
    [INCIDENT_REASON.AMBIGUOUS_HOLD, base, { ended: true, reason: "attempt x ended HOLD without a coherent verdict" }, {}, {}],
    [INCIDENT_REASON.REVISION_EXHAUSTED, base, { ended: true, reason: "revision attempts exhausted — the episode is over" }, {}, {}],
    [INCIDENT_REASON.FAILURE_EXHAUSTED, base, { ended: true, reason: "retryable failures exhausted (3/3)" }, {}, {}],
    [INCIDENT_REASON.STALE_HEAD, [receipt({ stop: INCIDENT_REASON.STALE_HEAD })], { ended: true, reason: "unknown" }, {}, {}],
    [INCIDENT_REASON.UNREADABLE_HEAD, [receipt({ stop: INCIDENT_REASON.UNREADABLE_HEAD })], { ended: true, reason: "unknown" }, {}, {}],
    [INCIDENT_REASON.ADAPTER_PAUSED, base, { ended: false, reason: "mid-episode" }, {}, { adapter_pause_map: { "codex-cli": true } }],
    [INCIDENT_REASON.EXPIRED, base, { ended: false, reason: "mid-episode" }, { state: "refused", reporting_exception: "expired" }, {}],
  ];
  for (const [expected, receipts, decision, activationOverrides, config] of cases) {
    const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
    try {
      const event = eventFor(receipts, decision, activationOverrides, config);
      assert.equal(event.reason_code, expected);
      assert.equal((await fileWithHarness(h, event)).status, "confirmed", `${expected} files`);
    } finally { h.cleanup(); }
  }
  assert.equal(deriveIncidentEvent({ activation: activation(), receipts: base, episodeDecision: { ended: true, reason: "review PASS — the episode is complete" } }), null, "PASS files nothing");
  for (const hold of ["no_eligible_reviewer", "no_active_writer"]) {
    assert.equal(deriveIncidentEvent({ activation: activation(), receipts: base, episodeDecision: { ended: false, reason: `mid-episode: routing holds (${hold})` } }), null, `${hold} files nothing`);
  }
});

test("SHU-226 A7/A8: an unconfirmed report is never treated as delivered", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  try {
    const event = eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" });
    const before = incidentIdentity(ACTIVATION, event.reason_code);
    const afterRestart = incidentIdentity(ACTIVATION, event.reason_code);
    assert.deepEqual(afterRestart, before, "restart keeps the same event identity");
    h.planIncidentCreates("lost");
    assert.equal((await fileWithHarness(h, event)).status, "pending", "a lost response remains unconfirmed");
    assert.equal(h.incidentIssues.size, 1, "the remote commit happened before the response was lost");
    assert.equal((await fileWithHarness(h, event, { now: new Date(NOW.getTime() + 2_000) })).status, "confirmed");
    assert.equal(h.incidentIssues.size, 1, "restart finds and completes the same deterministic card");

    const h2 = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
    try {
      const pending = {
        version: "1.0.0", event_id: event.event_id, activation_id: ACTIVATION, reason_code: event.reason_code,
        status: "pending", attempt: 1, retry_not_before: NOW.toISOString(), incident_id: null, recorded_at: NOW.toISOString(),
      };
      h2.comments.push({ body: renderIncidentMarker(pending), createdAt: NOW.toISOString() });
      assert.equal((await fileWithHarness(h2, event, { now: new Date(NOW.getTime() + 1) })).status, "confirmed", "an unconfirmed report is never treated as delivered");
      assert.equal(h2.incidentIssues.size, 1, "crash after reporting started does not lose the incident");
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

test("SHU-226 A9: two reporters converge on one deterministic card and launch nothing", async () => {
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  try {
    const event = eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" });
    await Promise.all([fileWithHarness(h, event), fileWithHarness(h, event)]);
    assert.equal(h.incidentIssues.size, 1, "concurrent reporting converges on the client-chosen Linear issue UUID");
    assert.equal(h.triggers["codex-cli"], 0);
    assert.equal(h.triggers["claude-code"], 0);
  } finally { h.cleanup(); }
});

test("SHU-226 A10 (M9): reporting a spent or expired proven episode can never launch", async () => {
  for (const [label, now, expected] of [
    ["spent", NOW, INCIDENT_REASON.AMBIGUOUS_HOLD],
    ["expired", new Date(NOW.getTime() + 120_000), INCIDENT_REASON.EXPIRED],
  ]) {
    const h = createEpisodeHarness({ activationId: ACTIVATION, githubToken: "ghtok", now: NOW, expiresInMs: 60_000 });
    try {
      const receipts = label === "spent" ? [receipt()] : [receipt({ stage: "RUNNING" })];
      pushReceipts(h, receipts);
      const before = { ...h.triggers };
      const result = await h.runTick({ now });
      assert.equal(result.code, 2, `${label} activation is refused after reporting`);
      assert.deepEqual(h.triggers, before, "reporting a spent episode can never launch");
      assert.equal(reportingExceptionAllowsLaunch(activation({ state: "refused", reporting_exception: label })), false, "reporting a spent episode can never launch");
      const incident = [...h.incidentIssues.values()][0];
      assert.ok(incident, `${label} incident exists`);
      assert.match(incident.title, new RegExp(`${expected}$`));
    } finally { h.cleanup(); }
  }
});

test("SHU-226 A11: the card carries no secrets; no raw evidence in reporting output", async () => {
  const sentinel = "SHU226_SENTINEL_SECRET";
  const previous = process.env.SHU226_MUTATION_SECRET;
  process.env.SHU226_MUTATION_SECRET = sentinel;
  const raw = receipt({ stop: INCIDENT_REASON.UNREADABLE_HEAD });
  Object.assign(raw, {
    notes: [sentinel, `callback=${sentinel}`],
    evidence_links: [`https://github.com/BAWES-Universe/studenthub-platform/actions/runs/1?token=${sentinel}#fragment`],
    exception: sentinel,
    callback_text: sentinel,
    env: { LINEAR_API_TOKEN: sentinel },
  });
  const event = eventFor([raw], { ended: true, reason: sentinel }, { extra_activation_field: sentinel });
  const h = createEpisodeHarness({ activationId: ACTIVATION, now: NOW });
  const logs = [];
  try {
    assert.equal((await fileWithHarness(h, event, { stdout: (line) => logs.push(line) })).status, "confirmed");
    const serialized = JSON.stringify({ incident: [...h.incidentIssues.values()][0], comments: h.comments, logs });
    assert.doesNotMatch(serialized, new RegExp(sentinel), "the card carries no secrets");
    assert.doesNotMatch(serialized, /\?token=|#fragment/, "no raw evidence in reporting output");
    assert.match(serialized, new RegExp(raw.attempt_id), "allowed identifiers remain useful");
  } finally {
    if (previous === undefined) delete process.env.SHU226_MUTATION_SECRET;
    else process.env.SHU226_MUTATION_SECRET = previous;
    h.cleanup();
  }
});

test("SHU-226 M2: a refused activation still writes zero", () => {
  assert.equal(deriveIncidentEvent({
    activation: activation({ state: "refused", reporting_exception: null }),
    receipts: [receipt()],
    episodeDecision: { ended: true, reason: "unknown" },
  }), null, "a refused activation still writes zero");
});

test("SHU-226 M3: disabled means disabled: zero writes", async () => {
  let calls = 0;
  const result = await reportCoordinatorIncident({
    event: eventFor([receipt()], { ended: true, reason: "attempt x ended HOLD without a coherent verdict" }),
    authorized: false,
    targetLinearId: "11111111-aaaa-4bbb-8ccc-000000000777",
    token: "tok",
    sendLinear: async () => { calls += 1; },
    commentMutation: LINEAR_COMMENT_CREATE_MUTATION,
  });
  assert.equal(result.status, "not_authorized");
  assert.equal(calls, 0, "disabled means disabled: zero writes");
});

test("SHU-226 M6: an incident card is filed in Triage, never pickable", () => {
  assert.equal(INCIDENT_STATE_NAME, "Triage", "an incident card is filed in Triage, never pickable");
});

test("SHU-226 M8: restart keeps the same event identity", () => {
  assert.deepEqual(
    incidentIdentity(ACTIVATION, INCIDENT_REASON.AMBIGUOUS_HOLD),
    incidentIdentity(ACTIVATION, INCIDENT_REASON.AMBIGUOUS_HOLD),
    "restart keeps the same event identity",
  );
});

test("SHU-226 M10: an unproven episode never writes", () => {
  assert.equal(deriveIncidentEvent({
    activation: activation(),
    receipts: [],
    episodeDecision: { ended: true, reason: "unknown" },
  }), null, "an unproven episode never writes");
});

test("SHU-226 A11/A12: the eight-attempt payload is complete and explicitly below the Linear bound", () => {
  const attempts = Array.from({ length: 8 }, (_, index) => receipt({
    n: index + 1,
    worker: index % 2 ? "claude-verifier" : "codex-builder",
    stage: index % 2 ? "HOLD" : "COMPLETED",
    verdict: index % 2 ? "BLOCKED" : "REVISION_READY",
    at: new Date(NOW.getTime() + index * 1000).toISOString(),
  }));
  const event = eventFor(attempts, { ended: true, reason: "revision attempts exhausted — the episode is over" });
  const body = renderIncidentDescription(event, { max_revise: 3, max_failed_attempts: 3 });
  assert.ok(body);
  assert.ok(Buffer.byteLength(body, "utf8") <= INCIDENT_MAX_BODY_BYTES);
  for (const attempt of attempts) assert.match(body, new RegExp(attempt.attempt_id), "largest episode silently omits nothing");
});

// SHU-298: the coordinator triages its own stop cards.
const S_NOW = new Date("2026-10-07T12:00:00.000Z");
const S_ACTIVATION = "shu298settle0001";
const S_CARD = "SHU-197";
const S_FIXTURE = "SHU-140";

function sAttemptId(n) {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function sReceipt({ issue = S_CARD, n = 1, worker = "codex-builder", stage = "HOLD", verdict = null, target = SHA_INPUT, result = null, at = S_NOW.toISOString() } = {}) {
  const made = createReceipt({
    issue_id: issue,
    authorization_ref: issue,
    requested_worker: worker,
    repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${issue}`,
    target_sha: target,
    attempt_id: sAttemptId(n),
    episode_id: S_ACTIVATION,
    reserved_at: at,
  });
  assert.equal(made.ok, true, made.errors?.join("; "));
  const value = {
    ...made.receipt,
    stage,
    worker_identity: `${worker}:session-${n}`,
    external_run_id: `run_${n}`,
    adapter_status: "completed",
    timestamps: { reserved: at, launch: at, heartbeat: null, terminal: at },
    last_activity: at,
    notes: [],
  };
  if (verdict) value.verdict_stage = verdict;
  if (result) value.result_sha = result;
  return value;
}

function sDeriveFor(issue, receipts, reason = "no routable successor (no order)") {
  return deriveIncidentEvent({
    activation: { requested: true, state: "armed", valid: true, activation_id: S_ACTIVATION, target_issue_id: issue, coordinator_revision: REVISION },
    receipts,
    config: {},
    episodeDecision: { ended: true, reason },
  });
}

test("SHU-298 S1: a writer that reported FAILED is builder_failed, not an unknown breaker", () => {
  const failedBuild = sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })]);
  assert.equal(failedBuild.reason_code, INCIDENT_REASON.BUILDER_FAILED);
  assert.match(failedBuild.explanation, /writer reported FAILED/);

  // The SHU-160 run-2 shape: two blocked reviews, then the revising writer gave up.
  const failedRevise = sDeriveFor(S_CARD, [
    sReceipt({ n: 1, stage: "COMPLETED", verdict: "BUILD_READY", result: SHA_WRITE, at: "2026-10-07T11:00:00.000Z" }),
    sReceipt({ n: 2, worker: "claude-verifier", verdict: "BLOCKED", target: SHA_WRITE, at: "2026-10-07T11:10:00.000Z" }),
    sReceipt({ n: 3, verdict: "FAILED", target: SHA_WRITE, result: SHA_WRITE, at: "2026-10-07T11:20:00.000Z" }),
  ]);
  assert.equal(failedRevise.reason_code, INCIDENT_REASON.BUILDER_FAILED);

  // Only the latest attempt decides: a reviewer FAILED, or a stop after an
  // older writer FAILED, stays an unknown breaker.
  assert.equal(sDeriveFor(S_CARD, [sReceipt({ worker: "claude-verifier", verdict: "FAILED", target: SHA_WRITE })]).reason_code, INCIDENT_REASON.UNKNOWN);
  assert.equal(sDeriveFor(S_CARD, [
    sReceipt({ n: 1, verdict: "FAILED", result: SHA_INPUT, at: "2026-10-07T11:00:00.000Z" }),
    sReceipt({ n: 2, worker: "claude-verifier", target: SHA_WRITE, at: "2026-10-07T11:10:00.000Z" }),
  ]).reason_code, INCIDENT_REASON.UNKNOWN);
  // Known breakers keep their own code.
  assert.equal(sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })], "revision attempts exhausted — the episode is over").reason_code, INCIDENT_REASON.REVISION_EXHAUSTED);
});

test("SHU-298 S2: builder_failed needs a fresh activation and never self-repairs", () => {
  const decision = repairPolicyDecision({ reason_code: INCIDENT_REASON.BUILDER_FAILED });
  assert.equal(decision.action, "MISSING_AUTHORITY");
  assert.deepEqual(decision.requirements, [MISSING_AUTHORITY.ACTIVATION]);
});

test("SHU-298 S3: a fixture stop is marked as a fixture; a card stop names the card", () => {
  assert.equal(isFixtureIssue(S_FIXTURE), true);
  assert.equal(isFixtureIssue("SHU-254"), true);
  assert.equal(isFixtureIssue(S_CARD), false);
  assert.equal(isFixtureIssue(undefined), false);
  const fixture = sDeriveFor(S_FIXTURE, [sReceipt({ issue: S_FIXTURE, worker: "claude-verifier", target: SHA_WRITE })]);
  const card = sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })]);
  assert.equal(fixture.fixture, true);
  assert.equal(card.fixture, false);
  const fixtureBody = renderIncidentDescription(fixture);
  const cardBody = renderIncidentDescription(card);
  assert.match(fixtureBody, /- Fixture: \[SHU-140\]/);
  assert.match(fixtureBody, /rehearsal fixture's stop, so the coordinator closes it itself/);
  assert.match(cardBody, /- Card: \[SHU-197\]/);
  assert.doesNotMatch(cardBody, /closes it itself/);
});

// A fake Linear for the sSettle step: one incident, the SHU-71 summary card,
// and the team's states.
function sSettleStore(event, { state = "Triage", summaryComments = [], failUpdate = false, title = null } = {}) {
  const calls = [];
  const store = {
    incident: {
      id: event.issue_uuid,
      identifier: "SHU-905",
      title: title ?? `coordinator stop: ${event.issue_id} — ${event.reason_code}`,
      description: `<!-- coordinator-incident-event ${event.event_id} -->\nbody`,
      state: { id: "s-current", name: state, type: "triage" },
    },
    summaryComments: [...summaryComments],
    failUpdate,
  };
  const states = [
    { id: "33333333-3333-4333-8333-333333333301", name: "Triage", type: "triage" },
    { id: "33333333-3333-4333-8333-333333333302", name: CARD_SETTLED_STATE.name, type: CARD_SETTLED_STATE.type },
    { id: "33333333-3333-4333-8333-333333333303", name: FIXTURE_SETTLED_STATE.name, type: FIXTURE_SETTLED_STATE.type },
  ];
  const sendLinear = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("CoordinatorIncidentSettleState")) {
      if (store.failUpdate) throw new Error("lost response");
      const next = states.find((entry) => entry.id === variables.input.stateId);
      store.incident.state = { ...next };
      return { issueUpdate: { success: true } };
    }
    if (query.includes("CoordinatorIncidentSettle")) {
      return {
        incident: { ...store.incident },
        summary: { id: "44444444-4444-4444-8444-444444440071", identifier: STOP_SUMMARY_ISSUE, comments: { nodes: store.summaryComments.map((body) => ({ body })) } },
        teams: { nodes: [{ id: "t", key: "SHU", states: { nodes: states } }] },
      };
    }
    if (query.includes("commentCreate")) {
      store.summaryComments.push(variables.body);
      store.commentIssue = variables.issueId;
      return { commentCreate: { success: true } };
    }
    throw new Error(`unexpected query ${query}`);
  };
  return { store, calls, sendLinear };
}

const sSettle = (event, fake, triageStatus = "MISSING_AUTHORITY") => settleCoordinatorIncident({
  event,
  triageStatus,
  token: "tok",
  fetchImpl: null,
  sendLinear: fake.sendLinear,
  commentMutation: "mutation CoordinatorSummary { commentCreate }",
});

test("SHU-298 S4: a real card's stop leaves Triage for Backlog and puts one line on SHU-71", async () => {
  const event = sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })]);
  const fake = sSettleStore(event);
  const first = await sSettle(event, fake);
  assert.equal(first.status, "SETTLED");
  assert.equal(fake.store.incident.state.name, "Backlog", "a real stop leaves Triage");
  assert.equal(fake.store.summaryComments.length, 1);
  assert.equal(fake.store.commentIssue, "44444444-4444-4444-8444-444444440071", "the line goes on SHU-71 by its UUID");
  const [line] = fake.store.summaryComments;
  assert.ok(line.includes(stopSummaryMarker(event.event_id)));
  assert.match(line, /Coordinator stop on SHU-197 \(`builder_failed`, SHU-905\): The writer reported FAILED/);
  assert.equal(line.split("\n").length, 2, "one marker line and one plain line");

  const writesBefore = fake.calls.filter((call) => !call.query.includes("query CoordinatorIncidentSettle(")).length;
  const again = await sSettle(event, fake);
  assert.equal(again.status, "SETTLED");
  assert.equal(fake.store.summaryComments.length, 1, "replay never posts the line twice");
  assert.equal(fake.calls.filter((call) => !call.query.includes("query CoordinatorIncidentSettle(")).length, writesBefore, "replay writes nothing");
});

test("SHU-298 S5: a fixture's stop is closed and posts nothing on SHU-71", async () => {
  const event = sDeriveFor(S_FIXTURE, [sReceipt({ issue: S_FIXTURE, worker: "claude-verifier", target: SHA_WRITE })]);
  const fake = sSettleStore(event);
  const result = await sSettle(event, fake, "REPAIR_READY");
  assert.equal(result.status, "SETTLED");
  assert.equal(fake.store.incident.state.name, "Done");
  assert.equal(fake.store.summaryComments.length, 0);
});

test("SHU-298 S6: settling waits for triage, leaves a person's choice alone, and never touches another card", async () => {
  const event = sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })]);
  for (const status of ["STATE_UNREADABLE", "WAITING_CONFIRMATION", "NOT_AUTHORIZED", null]) {
    const fake = sSettleStore(event);
    assert.equal((await sSettle(event, fake, status)).status, "WAITING_FOR_TRIAGE");
    assert.equal(fake.calls.length, 0, `${status}: zero calls before triage has decided`);
  }

  const moved = sSettleStore(event, { state: "In Progress" });
  await sSettle(event, moved);
  assert.equal(moved.store.incident.state.name, "In Progress", "a card a person moved stays put");
  assert.equal(moved.calls.filter((call) => call.query.includes("SettleState")).length, 0);
  assert.equal(moved.store.summaryComments.length, 1, "the line for Khalid is still posted once");

  const other = sSettleStore(event, { title: "some other card" });
  const result = await sSettle(event, other);
  assert.equal(result.status, "INCIDENT_UNCONFIRMED");
  assert.equal(other.calls.length, 1, "only the read; no writes");
});

test("SHU-298 S7: a lost state update is retried on the next tick", async () => {
  const event = sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })]);
  const fake = sSettleStore(event, { failUpdate: true });
  assert.equal((await sSettle(event, fake)).status, "PARTIAL");
  assert.equal(fake.store.incident.state.name, "Triage");
  fake.store.failUpdate = false;
  assert.equal((await sSettle(event, fake)).status, "SETTLED");
  assert.equal(fake.store.incident.state.name, "Backlog");
  assert.equal(fake.store.summaryComments.length, 1);
});

test("SHU-298 S8: the summary line carries only closed vocabulary", () => {
  const event = sDeriveFor(S_CARD, [sReceipt({ verdict: "FAILED", result: SHA_INPUT })]);
  assert.equal(renderStopSummary(event, "not-an-identifier"), null);
  assert.equal(renderStopSummary({ ...event, issue_id: "SHU-1\nnope" }, "SHU-905"), null);
  assert.ok(renderStopSummary(event, "SHU-905"));
});

test("SHU-298 S9: end to end, a fixture stop is filed, triaged, closed, and still triaged on the next tick", async () => {
  const h = createEpisodeHarness({ activationId: S_ACTIVATION, githubToken: "ghtok", now: S_NOW, settleSupport: true });
  try {
    const held = sReceipt({ issue: S_FIXTURE, worker: "claude-verifier", target: SHA_WRITE });
    held.authorization_ref = "FIXTURE-OPUS-CONTRACT-20260905";
    h.comments.push({ body: receiptCommentBody(held), createdAt: held.last_activity });
    const first = await h.runTick();
    assert.equal(first.code, 2, "the breaker still stops the episode");
    assert.equal(h.incidentIssues.size, 1);
    const incident = [...h.incidentIssues.values()][0];
    assert.equal(incident.state.name, "Done", "a fixture stop never waits in Triage");
    assert.match(first.text, /incident-settlement: inc_[0-9a-f]{32} SETTLED Done/);
    assert.equal(h.entityComments.get(h.summaryIssueId) ?? undefined, undefined, "a fixture posts nothing on SHU-71");
    const repairs = h.repairIssues.size;

    const second = await h.runTick();
    assert.match(second.text, /incident-triage: inc_[0-9a-f]{32} REPAIR_READY/, "triage still recognizes the closed card");
    assert.equal(h.repairIssues.size, repairs, "no second repair card");
    assert.equal(incident.state.name, "Done");
  } finally { h.cleanup(); }
});
