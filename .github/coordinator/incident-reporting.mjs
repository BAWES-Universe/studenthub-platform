import { createHash } from "node:crypto";
import { adapterNameForLane, LANE_NAMES } from "./launch-vocabulary.mjs";

export const INCIDENT_VERSION = "1.0.0";
export const INCIDENT_TEAM_KEY = "SHU";
export const INCIDENT_STATE_NAME = "Triage";
export const INCIDENT_LABEL_NAME = "repo:platform";
export const INCIDENT_MAX_ATTEMPTS = 3;
export const INCIDENT_MAX_EPISODE_ATTEMPTS = 8;
export const INCIDENT_MAX_BODY_BYTES = 12_000;
export const INCIDENT_CALL_TIMEOUT_MS = 1_500;
export const INCIDENT_BACKOFF_MS = Object.freeze([0, 1_000, 5_000]);

const ISSUE_ID_RE = /^SHU-[0-9]+$/;
const ACTIVATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const INCIDENT_ID_RE = /^inc_[0-9a-f]{32}$/;
const STAGES = new Set(["RESERVED", "LAUNCH_UNKNOWN", "RUNNING", "COMPLETED", "FAILED", "HOLD"]);
const VERDICTS = new Set(["BUILD_READY", "REVISION_READY", "PASS", "BLOCKED", "FAILED"]);
const REPORTING_EXCEPTIONS = new Set(["expired", "spent", "stale_head", "unreadable_head"]);

export const INCIDENT_REASON = Object.freeze({
  AMBIGUOUS_HOLD: "ambiguous_hold",
  REVISION_EXHAUSTED: "revision_budget_exhausted",
  FAILURE_EXHAUSTED: "failure_budget_exhausted",
  STALE_HEAD: "stale_head",
  UNREADABLE_HEAD: "unreadable_head",
  ADAPTER_PAUSED: "adapter_paused",
  EXPIRED: "activation_expired",
  UNKNOWN: "unknown_breaker",
});

const REASON_EXPLANATIONS = Object.freeze({
  [INCIDENT_REASON.AMBIGUOUS_HOLD]: "The episode ended on HOLD without a coherent, bound verdict.",
  [INCIDENT_REASON.REVISION_EXHAUSTED]: "The bounded revision-attempt budget was exhausted.",
  [INCIDENT_REASON.FAILURE_EXHAUSTED]: "The bounded retryable-failure budget was exhausted.",
  [INCIDENT_REASON.STALE_HEAD]: "The bound branch head no longer matched the verified authoritative head.",
  [INCIDENT_REASON.UNREADABLE_HEAD]: "The authoritative branch head could not be verified.",
  [INCIDENT_REASON.ADAPTER_PAUSED]: "The episode's worker adapter entered its durable paused state.",
  [INCIDENT_REASON.EXPIRED]: "A previously accepted episode expired while it was still in progress.",
  [INCIDENT_REASON.UNKNOWN]: "The episode ended on an unclassified fail-closed breaker; inspect the bound attempt.",
});

export const LINEAR_INCIDENT_COMMENTS_QUERY = `
  query CoordinatorIncidentComments($issueId: String!) {
    issue(id: $issueId) {
      comments(last: 250, orderBy: createdAt) {
        nodes { body createdAt }
      }
    }
  }`;

export const LINEAR_INCIDENT_LOOKUP_QUERY = `
  query CoordinatorIncidentLookup($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      title
      description
      team { id key }
      state { id name type }
      labels { nodes { id name } }
      assignee { id }
      relations { nodes { type relatedIssue { id identifier } } }
    }
  }`;

export const LINEAR_INCIDENT_METADATA_QUERY = `
  query CoordinatorIncidentMetadata($teamKey: String!, $stateName: String!, $labelName: String!) {
    teams(filter: { key: { eq: $teamKey } }, first: 2) {
      nodes {
        id
        key
        states(filter: { name: { eq: $stateName } }, first: 2) { nodes { id name type } }
        labels(filter: { name: { eq: $labelName } }, first: 2) { nodes { id name } }
      }
    }
  }`;

export const LINEAR_INCIDENT_CREATE_MUTATION = `
  mutation CoordinatorIncidentCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier }
    }
  }`;

export const LINEAR_INCIDENT_RELATION_MUTATION = `
  mutation CoordinatorIncidentRelate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id }
    }
  }`;

function safeIso(value) {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function deterministicUuid(namespace) {
  const bytes = Buffer.from(createHash("sha256").update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function incidentIdentity(activationId, reasonCode) {
  if (!ACTIVATION_ID_RE.test(activationId ?? "") || !REASON_EXPLANATIONS[reasonCode]) return null;
  const digest = createHash("sha256").update(`${activationId}\0${reasonCode}`).digest("hex").slice(0, 32);
  return {
    event_id: `inc_${digest}`,
    issue_uuid: deterministicUuid(`coordinator-incident:${activationId}:${reasonCode}`),
    relation_uuid: deterministicUuid(`coordinator-incident-relation:${activationId}:${reasonCode}`),
  };
}

function markerPayload(marker) {
  const keys = ["version", "event_id", "activation_id", "reason_code", "status", "attempt", "retry_not_before", "incident_id", "recorded_at"];
  return Object.fromEntries(keys.map((key) => [key, marker[key] ?? null]));
}

export function renderIncidentMarker(marker) {
  return [
    "<!-- coordinator-incident v1 -->",
    "coordinator-incident v1",
    "```json",
    JSON.stringify(markerPayload(marker)),
    "```",
  ].join("\n");
}

export function parseIncidentMarkers(comments = []) {
  const out = [];
  for (const comment of comments ?? []) {
    const body = typeof comment?.body === "string" ? comment.body : "";
    if (!body.includes("<!-- coordinator-incident v1 -->")) continue;
    const match = /```json\s*([\s\S]*?)\s*```/.exec(body);
    if (!match) continue;
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    if (!value || Object.keys(value).sort().join(",") !== ["activation_id", "attempt", "event_id", "incident_id", "reason_code", "recorded_at", "retry_not_before", "status", "version"].sort().join(",")) continue;
    if (value.version !== INCIDENT_VERSION || !INCIDENT_ID_RE.test(value.event_id ?? "") || !ACTIVATION_ID_RE.test(value.activation_id ?? "")) continue;
    if (!REASON_EXPLANATIONS[value.reason_code] || !["pending", "confirmed", "exhausted"].includes(value.status)) continue;
    if (!Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt > INCIDENT_MAX_ATTEMPTS) continue;
    if (value.retry_not_before !== null && !safeIso(value.retry_not_before)) continue;
    if (value.incident_id !== null && !UUID_RE.test(value.incident_id)) continue;
    if (!safeIso(value.recorded_at)) continue;
    out.push({ ...value, createdAt: safeIso(comment.createdAt) ?? safeIso(value.recorded_at) });
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function classifyEndedReason(reason) {
  if (/review PASS/.test(reason ?? "")) return null;
  if (/retryable failures exhausted/.test(reason ?? "")) return INCIDENT_REASON.FAILURE_EXHAUSTED;
  if (/revision attempts exhausted/.test(reason ?? "")) return INCIDENT_REASON.REVISION_EXHAUSTED;
  if (/ended HOLD without a coherent verdict|role authority or author exclusion HOLD/.test(reason ?? "")) return INCIDENT_REASON.AMBIGUOUS_HOLD;
  if (/contradictory facts|stale/i.test(reason ?? "")) return INCIDENT_REASON.STALE_HEAD;
  return INCIDENT_REASON.UNKNOWN;
}

function latestAttempt(receipts) {
  return receipts.slice().sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? ""))).pop() ?? null;
}

export function deriveIncidentEvent({ activation, receipts = [], config = {}, episodeDecision = null } = {}) {
  if (!activation?.requested || !ACTIVATION_ID_RE.test(activation.activation_id ?? "") || !ISSUE_ID_RE.test(activation.target_issue_id ?? "")) return null;
  if (activation.state === "refused" && !REPORTING_EXCEPTIONS.has(activation.reporting_exception)) return null;
  const episodeReceipts = receipts.filter((receipt) => receipt?.issue_id === activation.target_issue_id && receipt?.episode_id === activation.activation_id);
  const launched = episodeReceipts.some((receipt) => receipt?.timestamps?.launch || !["RESERVED"].includes(receipt?.stage));
  if (!launched) return null;
  const latest = latestAttempt(episodeReceipts);
  const stopCode = episodeReceipts.slice().reverse().find((receipt) => [INCIDENT_REASON.STALE_HEAD, INCIDENT_REASON.UNREADABLE_HEAD].includes(receipt?.stop_reason_code))?.stop_reason_code;
  let reasonCode = stopCode ?? null;
  if (!reasonCode && episodeDecision?.ended) reasonCode = classifyEndedReason(episodeDecision.reason);
  if (reasonCode === null && episodeDecision?.ended) return null; // PASS is a completion, never an incident.
  if (!reasonCode && /live branch head could not be verified/i.test(activation.reason ?? "")) reasonCode = INCIDENT_REASON.UNREADABLE_HEAD;
  if (!reasonCode && /contradictory facts|stale/i.test(activation.reason ?? "")) reasonCode = INCIDENT_REASON.STALE_HEAD;
  if (!reasonCode) {
    const paused = episodeReceipts.some((receipt) => config.adapter_pause_map?.[adapterNameForLane(receipt.requested_worker)] === true);
    if (paused) reasonCode = INCIDENT_REASON.ADAPTER_PAUSED;
  }
  if (!reasonCode && activation.reporting_exception === "expired") reasonCode = INCIDENT_REASON.EXPIRED;
  if (!reasonCode) return null;
  const identity = incidentIdentity(activation.activation_id, reasonCode);
  return identity ? {
    ...identity,
    activation_id: activation.activation_id,
    issue_id: activation.target_issue_id,
    coordinator_revision: SHA_RE.test(activation.coordinator_revision ?? "") ? activation.coordinator_revision : null,
    reason_code: reasonCode,
    explanation: REASON_EXPLANATIONS[reasonCode],
    latest_attempt_id: UUID_RE.test(latest?.attempt_id ?? "") ? latest.attempt_id : null,
    attempts: episodeReceipts,
  } : null;
}

// The spent/expired exception is write authority for one incident only. Keeping
// this decision explicit gives the launch boundary a closed, testable answer.
export function reportingExceptionAllowsLaunch(_activation) {
  return false;
}

function sanitizedAttempt(receipt) {
  if (!UUID_RE.test(receipt?.attempt_id ?? "") || !LANE_NAMES.includes(receipt?.requested_worker) || !STAGES.has(receipt?.stage)) return null;
  const target = SHA_RE.test(receipt.target_sha ?? "") ? receipt.target_sha : null;
  if (!target) return null;
  const result = SHA_RE.test(receipt.result_sha ?? "") ? receipt.result_sha : null;
  const verdict = VERDICTS.has(receipt.verdict_stage) ? receipt.verdict_stage : null;
  const at = safeIso(receipt.last_activity);
  if (!at) return null;
  return { attempt_id: receipt.attempt_id, lane: receipt.requested_worker, target_sha: target, result_sha: result, stage: receipt.stage, verdict, at };
}

export function renderIncidentDescription(event, config = {}) {
  const attempts = event.attempts.map(sanitizedAttempt);
  if (attempts.some((attempt) => attempt === null) || attempts.length === 0 || attempts.length > INCIDENT_MAX_EPISODE_ATTEMPTS) return null;
  const maxRevise = Number.isInteger(config.max_revise) && config.max_revise >= 0 && config.max_revise <= INCIDENT_MAX_EPISODE_ATTEMPTS ? config.max_revise : 3;
  const maxFailed = Number.isInteger(config.max_failed_attempts) && config.max_failed_attempts >= 0 && config.max_failed_attempts <= INCIDENT_MAX_EPISODE_ATTEMPTS ? config.max_failed_attempts : 3;
  const fixtureUrl = new URL(`https://linear.app/bawes/issue/${event.issue_id}`);
  fixtureUrl.search = "";
  fixtureUrl.hash = "";
  const lines = [
    `<!-- coordinator-incident-event ${event.event_id} -->`,
    "## Coordinator circuit-breaker stop",
    "",
    event.explanation,
    "",
    `- Event: \`${event.event_id}\``,
    `- Activation: \`${event.activation_id}\``,
    `- Coordinator revision: \`${event.coordinator_revision ?? "unavailable"}\``,
    `- Reason code: \`${event.reason_code}\``,
    `- Fixture: [${event.issue_id}](${fixtureUrl.toString()})`,
    `- Budgets: \`max_revise=${maxRevise}\`, \`max_failed_attempts=${maxFailed}\``,
    "",
    "### Episode attempts",
    "",
    ...attempts.map((attempt) => `- \`${attempt.attempt_id}\` — lane \`${attempt.lane}\`, head \`${attempt.target_sha}\`${attempt.result_sha ? ` → \`${attempt.result_sha}\`` : ""}, stage \`${attempt.stage}\`, verdict \`${attempt.verdict ?? "none"}\`, at \`${attempt.at}\``),
    "",
    "Reporting only. The coordinator did not repair, re-arm, launch, clear a pause, or edit its activation.",
  ];
  const body = lines.join("\n");
  return Buffer.byteLength(body, "utf8") <= INCIDENT_MAX_BODY_BYTES ? body : null;
}

function markerFor(event, { status, attempt, retryNotBefore = null, incidentId = null, now }) {
  return {
    version: INCIDENT_VERSION,
    event_id: event.event_id,
    activation_id: event.activation_id,
    reason_code: event.reason_code,
    status,
    attempt,
    retry_not_before: retryNotBefore ? safeIso(retryNotBefore) : null,
    incident_id: incidentId,
    recorded_at: safeIso(now),
  };
}

async function boundedCall(call, { timeoutMs = INCIDENT_CALL_TIMEOUT_MS, timeoutImpl = null } = {}) {
  if (timeoutImpl) return timeoutImpl(call, timeoutMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("bounded timeout"), { code: "INCIDENT_TIMEOUT" })), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function incidentDelivered(issue, event) {
  if (!issue || issue.id !== event.issue_uuid || issue.title !== `coordinator stop: ${event.issue_id} — ${event.reason_code}`) return false;
  if (!String(issue.description ?? "").includes(`<!-- coordinator-incident-event ${event.event_id} -->`)) return false;
  if (issue.team?.key !== INCIDENT_TEAM_KEY || issue.state?.name !== INCIDENT_STATE_NAME || issue.assignee !== null) return false;
  if (!(issue.labels?.nodes ?? []).some((label) => label?.name === INCIDENT_LABEL_NAME)) return false;
  return (issue.relations?.nodes ?? []).some((relation) => relation?.type === "related" && relation?.relatedIssue?.identifier === event.issue_id);
}

async function safeMarkerWrite({ sendLinear, issueId, marker, token, fetchImpl, options }) {
  try {
    await boundedCall(() => sendLinear(options.commentMutation, { issueId, body: renderIncidentMarker(marker) }, token, fetchImpl), options);
    return true;
  } catch { return false; }
}

export async function reportCoordinatorIncident({
  event,
  authorized,
  targetLinearId,
  config = {},
  token,
  fetchImpl,
  sendLinear,
  commentMutation,
  now = new Date(),
  stdout = () => {},
  timeoutMs = INCIDENT_CALL_TIMEOUT_MS,
  timeoutImpl = null,
} = {}) {
  if (!authorized || !event || !UUID_RE.test(targetLinearId ?? "") || !token || typeof sendLinear !== "function") return { status: "not_authorized" };
  const options = { timeoutMs, timeoutImpl, commentMutation };
  const log = (status) => stdout(`incident-reporting: ${event.event_id} ${status}`);
  let comments;
  try {
    const data = await boundedCall(() => sendLinear(LINEAR_INCIDENT_COMMENTS_QUERY, { issueId: targetLinearId }, token, fetchImpl), options);
    comments = data?.issue?.comments?.nodes ?? [];
  } catch {
    log("state-unreadable; episode remains stopped");
    return { status: "state_unreadable" };
  }
  const allMarkers = parseIncidentMarkers(comments).filter((marker) => marker.activation_id === event.activation_id);
  const frozen = allMarkers[0] ?? null;
  if (frozen && frozen.reason_code !== event.reason_code) {
    const frozenIdentity = incidentIdentity(event.activation_id, frozen.reason_code);
    event = { ...event, ...frozenIdentity, reason_code: frozen.reason_code, explanation: REASON_EXPLANATIONS[frozen.reason_code] };
  }
  const markers = allMarkers.filter((marker) => marker.event_id === event.event_id);
  if (markers.some((marker) => marker.status === "confirmed")) return { status: "confirmed", event_id: event.event_id };
  if (markers.some((marker) => marker.status === "exhausted")) return { status: "exhausted", event_id: event.event_id };
  const latest = markers.at(-1) ?? null;
  const latestAttempt = Math.max(0, ...markers.map((marker) => marker.attempt));
  if (latest?.retry_not_before && Date.parse(latest.retry_not_before) > new Date(now).getTime()) return { status: "pending", event_id: event.event_id };

  let existing = null;
  try {
    existing = (await boundedCall(() => sendLinear(LINEAR_INCIDENT_LOOKUP_QUERY, { issueId: event.issue_uuid }, token, fetchImpl), options))?.issue ?? null;
  } catch { /* absent and transport failures are handled by the bounded attempt below */ }
  if (incidentDelivered(existing, event)) {
    const confirmed = markerFor(event, { status: "confirmed", attempt: latestAttempt, incidentId: event.issue_uuid, now });
    await safeMarkerWrite({ sendLinear, issueId: targetLinearId, marker: confirmed, token, fetchImpl, options });
    log("confirmed");
    return { status: "confirmed", event_id: event.event_id, incident_id: event.issue_uuid };
  }

  const attempt = Math.min(latestAttempt + 1, INCIDENT_MAX_ATTEMPTS);
  if (latestAttempt >= INCIDENT_MAX_ATTEMPTS) {
    const exhausted = markerFor(event, { status: "exhausted", attempt: INCIDENT_MAX_ATTEMPTS, now });
    await safeMarkerWrite({ sendLinear, issueId: targetLinearId, marker: exhausted, token, fetchImpl, options });
    log("exhausted; episode remains stopped");
    return { status: "exhausted", event_id: event.event_id };
  }
  const started = markerFor(event, { status: "pending", attempt, retryNotBefore: now, now });
  await safeMarkerWrite({ sendLinear, issueId: targetLinearId, marker: started, token, fetchImpl, options });

  try {
    const description = renderIncidentDescription(event, config);
    if (!description) throw new Error("unsafe incident evidence");
    let metadata;
    try {
      metadata = await boundedCall(() => sendLinear(LINEAR_INCIDENT_METADATA_QUERY, {
        teamKey: INCIDENT_TEAM_KEY,
        stateName: INCIDENT_STATE_NAME,
        labelName: INCIDENT_LABEL_NAME,
      }, token, fetchImpl), options);
    } catch { metadata = null; }
    const teams = metadata?.teams?.nodes ?? [];
    const team = teams.length === 1 && teams[0]?.key === INCIDENT_TEAM_KEY ? teams[0] : null;
    const states = team?.states?.nodes?.filter((state) => state?.name === INCIDENT_STATE_NAME && state?.type === "triage") ?? [];
    const labels = team?.labels?.nodes?.filter((label) => label?.name === INCIDENT_LABEL_NAME) ?? [];
    if (!team || states.length !== 1 || labels.length !== 1) throw new Error("incident metadata unavailable");

    if (!existing) {
      await boundedCall(() => sendLinear(LINEAR_INCIDENT_CREATE_MUTATION, { input: {
        id: event.issue_uuid,
        teamId: team.id,
        stateId: states[0].id,
        labelIds: [labels[0].id],
        assigneeId: null,
        title: `coordinator stop: ${event.issue_id} — ${event.reason_code}`,
        description,
      } }, token, fetchImpl), options);
    }
    await boundedCall(() => sendLinear(LINEAR_INCIDENT_RELATION_MUTATION, { input: {
      id: event.relation_uuid,
      issueId: event.issue_uuid,
      relatedIssueId: targetLinearId,
      type: "related",
    } }, token, fetchImpl), options);
    const delivered = (await boundedCall(() => sendLinear(LINEAR_INCIDENT_LOOKUP_QUERY, { issueId: event.issue_uuid }, token, fetchImpl), options))?.issue ?? null;
    if (!incidentDelivered(delivered, event)) throw new Error("delivery not confirmed");
    const confirmed = markerFor(event, { status: "confirmed", attempt, incidentId: event.issue_uuid, now });
    await safeMarkerWrite({ sendLinear, issueId: targetLinearId, marker: confirmed, token, fetchImpl, options });
    log("confirmed");
    return { status: "confirmed", event_id: event.event_id, incident_id: event.issue_uuid };
  } catch {
    const exhausted = attempt >= INCIDENT_MAX_ATTEMPTS;
    const retryAt = new Date(new Date(now).getTime() + INCIDENT_BACKOFF_MS[Math.min(attempt, INCIDENT_BACKOFF_MS.length - 1)]);
    const marker = markerFor(event, { status: exhausted ? "exhausted" : "pending", attempt, retryNotBefore: exhausted ? null : retryAt, now });
    await safeMarkerWrite({ sendLinear, issueId: targetLinearId, marker, token, fetchImpl, options });
    log(exhausted ? "exhausted; episode remains stopped" : "pending; episode remains stopped");
    return { status: exhausted ? "exhausted" : "pending", event_id: event.event_id };
  }
}
