import { createHash } from "node:crypto";
import { adapterNameForLane, isWriterRole, LANE_NAMES, roleForReceipt } from "./launch-vocabulary.mjs";
import { isFixtureIssue } from "./workspace-scope.mjs";
import { cardContract, reviewOnlyCard } from "./card-contracts-reader.mjs";

export const INCIDENT_VERSION = "1.0.0";
export const INCIDENT_TEAM_KEY = "SHU";
// SHU-298: an incident card is filed where it ends up, never in a pickable
// state: a rehearsal fixture's stop is expected, so it is filed closed (Done),
// and a real card's stop is filed in Backlog. The coordinator never changes an
// existing card's state, so it can never overwrite a person's move.
export const INCIDENT_FILED_STATES = Object.freeze({
  card: Object.freeze({ name: "Backlog", type: "backlog" }),
  fixture: Object.freeze({ name: "Done", type: "completed" }),
});
// Cards filed before SHU-298 sit in Triage; they are still the coordinator's.
export const INCIDENT_STATE_NAME = "Triage";
export const INCIDENT_OWNED_STATE_NAMES = Object.freeze([INCIDENT_STATE_NAME, INCIDENT_FILED_STATES.card.name, INCIDENT_FILED_STATES.fixture.name]);
export const incidentFiledState = (event) => (event?.fixture === true ? INCIDENT_FILED_STATES.fixture : INCIDENT_FILED_STATES.card);
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
  BUILDER_FAILED: "builder_failed",
  UNKNOWN: "unknown_breaker",
});

const REASON_ROUTE = Object.freeze({
  [INCIDENT_REASON.REVISION_EXHAUSTED]: "stop:card-fix",
  [INCIDENT_REASON.BUILDER_FAILED]: "stop:card-fix",
  [INCIDENT_REASON.STALE_HEAD]: "stop:box-retry",
  [INCIDENT_REASON.UNREADABLE_HEAD]: "stop:box-retry",
  [INCIDENT_REASON.FAILURE_EXHAUSTED]: "stop:box-retry",
  [INCIDENT_REASON.EXPIRED]: "stop:box-retry",
  [INCIDENT_REASON.ADAPTER_PAUSED]: "stop:needs-person",
  [INCIDENT_REASON.UNKNOWN]: "stop:needs-person",
});

const REASON_EXPLANATIONS = Object.freeze({
  [INCIDENT_REASON.AMBIGUOUS_HOLD]: "The episode ended on HOLD without a coherent, bound verdict.",
  [INCIDENT_REASON.REVISION_EXHAUSTED]: "The bounded revision-attempt budget was exhausted.",
  [INCIDENT_REASON.FAILURE_EXHAUSTED]: "The bounded retryable-failure budget was exhausted.",
  [INCIDENT_REASON.STALE_HEAD]: "The bound branch head no longer matched the verified authoritative head.",
  [INCIDENT_REASON.UNREADABLE_HEAD]: "The authoritative branch head could not be verified.",
  [INCIDENT_REASON.ADAPTER_PAUSED]: "The episode's worker adapter entered its durable paused state.",
  [INCIDENT_REASON.EXPIRED]: "A previously accepted episode expired while it was still in progress.",
  [INCIDENT_REASON.BUILDER_FAILED]: "The writer reported FAILED: it could not finish the card's brief. A retry is a fresh activation.",
  [INCIDENT_REASON.UNKNOWN]: "The episode ended on an unclassified fail-closed breaker; inspect the bound attempt.",
});

// A stop card names its cause: a closed subcode read from the latest attempt's
// receipt, never free text. The adapter reason code the HOLD receipt carries
// (the "adapter reason code: <CODE>" note appendAdapterAudit writes) decides;
// two causes that carry no adapter code are read from the coordinator's own
// fixed HOLD notes. Anything else is UNCLASSIFIED. The cause never changes
// reason_code or the incident identity, so no stop already filed is filed twice.
export const STOP_CAUSE = Object.freeze({
  SUPERVISOR_WORKER_EXIT: "SUPERVISOR_WORKER_EXIT",
  REVIEW_EXECUTION_UNAVAILABLE: "REVIEW_EXECUTION_UNAVAILABLE",
  RESULT_SCOPE_REFUSED: "RESULT_SCOPE_REFUSED",
  PROVENANCE_UNREADABLE: "PROVENANCE_UNREADABLE",
  VERDICT_NOT_APPLIED: "VERDICT_NOT_APPLIED",
  FILESYSTEM_OR_AUTH_DENIED: "FILESYSTEM_OR_AUTH_DENIED",
  CLAUDE_1: "CLAUDE_1",
  UNCLASSIFIED: "UNCLASSIFIED",
});
const STOP_CAUSES = new Set(Object.values(STOP_CAUSE));
// The adapter codes that name a cause, exactly. Any other code is UNCLASSIFIED.
const ADAPTER_REASON_CAUSES = Object.freeze({
  SUPERVISOR_WORKER_EXIT: STOP_CAUSE.SUPERVISOR_WORKER_EXIT,
  REVIEW_EXECUTION_UNAVAILABLE: STOP_CAUSE.REVIEW_EXECUTION_UNAVAILABLE,
  RESULT_SCOPE_REFUSED: STOP_CAUSE.RESULT_SCOPE_REFUSED,
  FILESYSTEM_OR_AUTH_DENIED: STOP_CAUSE.FILESYSTEM_OR_AUTH_DENIED,
  CLAUDE_1: STOP_CAUSE.CLAUDE_1,
});
const ADAPTER_REASON_NOTE_RE = /^adapter reason code: ([A-Z][A-Z0-9_]{0,63})$/;
// reconcile.mjs writes these two HOLD notes itself, with no adapter code.
const PROVENANCE_HOLD_NOTE_RE = /^run completed but review provenance is not closable — HOLD \(/;
const VERDICT_NOT_APPLIED_NOTE_RE = /^held: review finished on the supervisor \([A-Z_]+\) after its pull request moved or its review activation ended; verdict not applied$/;

// Who acts on a stop. Every filed stop card carries exactly one, beside repo:platform.
export const STOP_ROUTE_LABEL = Object.freeze({
  CARD_FIX: "stop:card-fix",
  BOX_RETRY: "stop:box-retry",
  NEEDS_PERSON: "stop:needs-person",
});
export const STOP_LOOPING_LABEL = "stop:looping";
export const STOP_LOOPING_THRESHOLD = 3;
const CAUSE_ROUTE = Object.freeze({
  [STOP_CAUSE.RESULT_SCOPE_REFUSED]: STOP_ROUTE_LABEL.CARD_FIX,
  [STOP_CAUSE.REVIEW_EXECUTION_UNAVAILABLE]: STOP_ROUTE_LABEL.BOX_RETRY,
  [STOP_CAUSE.SUPERVISOR_WORKER_EXIT]: STOP_ROUTE_LABEL.BOX_RETRY,
  [STOP_CAUSE.FILESYSTEM_OR_AUTH_DENIED]: STOP_ROUTE_LABEL.NEEDS_PERSON,
  [STOP_CAUSE.PROVENANCE_UNREADABLE]: STOP_ROUTE_LABEL.NEEDS_PERSON,
  [STOP_CAUSE.VERDICT_NOT_APPLIED]: STOP_ROUTE_LABEL.NEEDS_PERSON,
  [STOP_CAUSE.CLAUDE_1]: STOP_ROUTE_LABEL.NEEDS_PERSON,
  [STOP_CAUSE.UNCLASSIFIED]: STOP_ROUTE_LABEL.NEEDS_PERSON,
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

// The stop cards already filed for a card are related to it. Their
// descriptions, written by renderIncidentDescription, name each earlier stop's
// activation, cause and card contract: the looping check reads nothing else.
export const LINEAR_INCIDENT_PRIOR_STOPS_QUERY = `
  query CoordinatorIncidentPriorStops($issueId: String!) {
    issue(id: $issueId) {
      relations(first: 100) { nodes { type relatedIssue { id description } } }
      inverseRelations(first: 100) { nodes { type issue { id description } } }
    }
  }`;

export const LINEAR_INCIDENT_METADATA_QUERY = `
  query CoordinatorIncidentMetadata($teamKey: String!, $stateName: String!, $labelNames: [String!]!) {
    teams(filter: { key: { eq: $teamKey } }, first: 2) {
      nodes {
        id
        key
        states(filter: { name: { eq: $stateName } }, first: 2) { nodes { id name type } }
        labels(filter: { name: { in: $labelNames } }, first: 20) { nodes { id name } }
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
  // SHU-303: a review-only run's PASS or BLOCKED is the review it was run for.
  if (/^review-only verdict (?:PASS|BLOCKED) at /.test(reason ?? "")) return null;
  if (/retryable failures exhausted/.test(reason ?? "")) return INCIDENT_REASON.FAILURE_EXHAUSTED;
  if (/revision attempts exhausted/.test(reason ?? "")) return INCIDENT_REASON.REVISION_EXHAUSTED;
  if (/ended HOLD without a coherent verdict|role authority or author exclusion HOLD/.test(reason ?? "")) return INCIDENT_REASON.AMBIGUOUS_HOLD;
  if (/contradictory facts|stale/i.test(reason ?? "")) return INCIDENT_REASON.STALE_HEAD;
  return INCIDENT_REASON.UNKNOWN;
}

export function stopCauseFromReceipt(receipt) {
  const notes = Array.isArray(receipt?.notes) ? receipt.notes.filter((note) => typeof note === "string") : [];
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const match = ADAPTER_REASON_NOTE_RE.exec(notes[index]);
    if (match) return ADAPTER_REASON_CAUSES[match[1]] ?? STOP_CAUSE.UNCLASSIFIED;
  }
  if (notes.some((note) => PROVENANCE_HOLD_NOTE_RE.test(note))) return STOP_CAUSE.PROVENANCE_UNREADABLE;
  if (notes.some((note) => VERDICT_NOT_APPLIED_NOTE_RE.test(note))) return STOP_CAUSE.VERDICT_NOT_APPLIED;
  return STOP_CAUSE.UNCLASSIFIED;
}

// A HOLD routes by its cause; every other stop by its reason code.
export function stopRouteLabel(reasonCode, cause) {
  if (reasonCode === INCIDENT_REASON.AMBIGUOUS_HOLD) return CAUSE_ROUTE[cause] ?? STOP_ROUTE_LABEL.NEEDS_PERSON;
  return REASON_ROUTE[reasonCode] ?? STOP_ROUTE_LABEL.NEEDS_PERSON;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The card contract a stop ran under. The activation is bound to the running
// coordinator revision, so the card's committed contract read here is the one
// the activation was armed from; an unrelated coordinator change leaves it the
// same. A card with no committed contract is keyed by the armed revision.
export function cardContractKey(issueId, coordinatorRevision) {
  const contract = cardContract(issueId) ?? reviewOnlyCard(issueId);
  if (contract) return `card:${createHash("sha256").update(canonicalJson(contract)).digest("hex").slice(0, 16)}`;
  return SHA_RE.test(coordinatorRevision ?? "") ? `revision:${coordinatorRevision}` : null;
}

const baseIncidentTitle = (event) => `coordinator stop: ${event.issue_id} — ${event.reason_code}`;
// A HOLD's title names its cause, since the cause decides who acts; every other
// stop's reason code already does.
export function incidentTitle(event) {
  return event?.reason_code === INCIDENT_REASON.AMBIGUOUS_HOLD && STOP_CAUSES.has(event.cause)
    ? `${baseIncidentTitle(event)} (${event.cause})`
    : baseIncidentTitle(event);
}
// A card filed before causes existed carries the bare title; it is still this event's card.
export function incidentTitleMatches(title, event) {
  if (typeof title !== "string") return false;
  const base = baseIncidentTitle(event);
  if (title === base) return true;
  const match = /^ \(([A-Z0-9_]+)\)$/.exec(title.startsWith(base) ? title.slice(base.length) : "");
  return Boolean(match) && STOP_CAUSES.has(match[1]);
}

// An earlier stop card's facts, from the fixed lines its description carries.
export function parsePriorStop(description) {
  const text = typeof description === "string" ? description : "";
  if (!/^<!-- coordinator-incident-event inc_[0-9a-f]{32} -->\n/.test(text)) return null;
  const line = (label, pattern) => new RegExp(`^- ${label}: \`(${pattern})\`$`, "m").exec(text)?.[1] ?? null;
  const card = /^- (?:Card|Fixture): \[(SHU-[0-9]+)\]\(/m.exec(text)?.[1] ?? null;
  const cause = line("Cause", "[A-Z0-9_]{1,64}");
  return {
    activation_id: line("Activation", "[A-Za-z0-9_-]{8,64}"),
    card,
    cause: STOP_CAUSES.has(cause) ? cause : null,
    contract: line("Card contract", "(?:card:[0-9a-f]{16}|revision:[0-9a-f]{40})"),
    reviewed_head: line("Reviewed head", "[0-9a-f]{40}"),
  };
}

// Earlier stops of the same card, cause and card contract, one per activation.
// The review desk is keyed by the reviewed pull request head as well.
export function priorStopCount(event, descriptions = []) {
  if (!event?.cause || !event.contract_key) return 0;
  const reviewed = reviewOnlyCard(event.issue_id) !== null;
  if (reviewed && !event.reviewed_head) return 0;
  const activations = new Set();
  for (const description of descriptions) {
    const prior = parsePriorStop(description);
    if (!prior?.activation_id || prior.activation_id === event.activation_id) continue;
    if (prior.card !== event.issue_id || prior.cause !== event.cause || prior.contract !== event.contract_key) continue;
    if (reviewed && prior.reviewed_head !== event.reviewed_head) continue;
    activations.add(prior.activation_id);
  }
  return activations.size;
}

export function stopIsLooping(event, descriptions = []) {
  return priorStopCount(event, descriptions) + 1 >= STOP_LOOPING_THRESHOLD;
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
  // SHU-298: a writer that reported FAILED is a known cause, not an unknown
  // breaker. Only the latest attempt decides, so an older FAILED never relabels
  // a later stop.
  if (reasonCode === INCIDENT_REASON.UNKNOWN && latest?.verdict_stage === "FAILED" && isWriterRole(roleForReceipt(latest))) {
    reasonCode = INCIDENT_REASON.BUILDER_FAILED;
  }
  const identity = incidentIdentity(activation.activation_id, reasonCode);
  const cause = stopCauseFromReceipt(latest);
  const coordinatorRevision = SHA_RE.test(activation.coordinator_revision ?? "") ? activation.coordinator_revision : null;
  return identity ? {
    ...identity,
    activation_id: activation.activation_id,
    issue_id: activation.target_issue_id,
    fixture: isFixtureIssue(activation.target_issue_id),
    coordinator_revision: SHA_RE.test(activation.coordinator_revision ?? "") ? activation.coordinator_revision : null,
    reason_code: reasonCode,
    explanation: REASON_EXPLANATIONS[reasonCode],
    latest_attempt_id: UUID_RE.test(latest?.attempt_id ?? "") ? latest.attempt_id : null,
    cause,
    route_label: stopRouteLabel(reasonCode, cause),
    contract_key: cardContractKey(activation.target_issue_id, coordinatorRevision),
    reviewed_head: reviewOnlyCard(activation.target_issue_id) && SHA_RE.test(latest?.target_sha ?? "") ? latest.target_sha : null,
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

export function renderIncidentDescription(event, config = {}, { missingLabels = [] } = {}) {
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
    ...(STOP_CAUSES.has(event.cause) ? [`- Cause: \`${event.cause}\``] : []),
    ...(Object.values(STOP_ROUTE_LABEL).includes(event.route_label) ? [`- Route: \`${event.route_label}\``] : []),
    ...(event.contract_key ? [`- Card contract: \`${event.contract_key}\``] : []),
    ...(SHA_RE.test(event.reviewed_head ?? "") ? [`- Reviewed head: \`${event.reviewed_head}\``] : []),
    ...(event.looping === true && Number.isInteger(event.prior_stops) ? [`- Looping: stop ${event.prior_stops + 1} of this card with this cause and card contract`] : []),
    `- ${event.fixture ? "Fixture" : "Card"}: [${event.issue_id}](${fixtureUrl.toString()})`,
    `- Budgets: \`max_revise=${maxRevise}\`, \`max_failed_attempts=${maxFailed}\``,
    "",
    "### Episode attempts",
    "",
    ...attempts.map((attempt) => `- \`${attempt.attempt_id}\` — lane \`${attempt.lane}\`, head \`${attempt.target_sha}\`${attempt.result_sha ? ` → \`${attempt.result_sha}\`` : ""}, stage \`${attempt.stage}\`, verdict \`${attempt.verdict ?? "none"}\`, at \`${attempt.at}\``),
    "",
    "Reporting only. The coordinator did not repair, re-arm, launch, clear a pause, or edit its activation.",
    ...(missingLabels.length ? ["", `The label${missingLabels.length > 1 ? "s" : ""} ${missingLabels.map((name) => `\`${name}\``).join(", ")} could not be found in Linear, so this card is filed with \`${INCIDENT_LABEL_NAME}\` only.`] : []),
    ...(event.fixture ? ["", "This is a rehearsal fixture's stop, so the coordinator closes it itself once it is filed. Nothing needs a person."] : []),
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
  if (!issue || issue.id !== event.issue_uuid || !incidentTitleMatches(issue.title, event)) return false;
  if (!String(issue.description ?? "").includes(`<!-- coordinator-incident-event ${event.event_id} -->`)) return false;
  if (issue.team?.key !== INCIDENT_TEAM_KEY || !INCIDENT_OWNED_STATE_NAMES.includes(issue.state?.name) || issue.assignee !== null) return false;
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
    event = { ...event, ...frozenIdentity, reason_code: frozen.reason_code, explanation: REASON_EXPLANATIONS[frozen.reason_code], route_label: stopRouteLabel(frozen.reason_code, event.cause) };
  }
  const markers = allMarkers.filter((marker) => marker.event_id === event.event_id);
  const priorStops = async () => {
    // Fail-open: an unreadable read only skips the looping check.
    try {
      const issue = (await boundedCall(() => sendLinear(LINEAR_INCIDENT_PRIOR_STOPS_QUERY, { issueId: targetLinearId }, token, fetchImpl), options))?.issue ?? null;
      return [
        ...(issue?.relations?.nodes ?? []).map((relation) => relation?.relatedIssue),
        ...(issue?.inverseRelations?.nodes ?? []).map((relation) => relation?.issue),
      ].filter((other) => other && other.id !== event.issue_uuid).map((other) => other.description);
    } catch { return []; }
  };
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
    // A card already created keeps its labels; only a new one reads prior stops.
    const descriptions = existing ? [] : await priorStops();
    event = { ...event, prior_stops: priorStopCount(event, descriptions), looping: stopIsLooping(event, descriptions) };
    const wantedLabels = [event.route_label ?? STOP_ROUTE_LABEL.NEEDS_PERSON, ...(event.looping ? [STOP_LOOPING_LABEL] : [])];
    let metadata;
    try {
      metadata = await boundedCall(() => sendLinear(LINEAR_INCIDENT_METADATA_QUERY, {
        teamKey: INCIDENT_TEAM_KEY,
        stateName: incidentFiledState(event).name,
        labelNames: [INCIDENT_LABEL_NAME, ...wantedLabels],
      }, token, fetchImpl), options);
    } catch { metadata = null; }
    const teams = metadata?.teams?.nodes ?? [];
    const team = teams.length === 1 && teams[0]?.key === INCIDENT_TEAM_KEY ? teams[0] : null;
    const filed = incidentFiledState(event);
    const states = team?.states?.nodes?.filter((state) => state?.name === filed.name && state?.type === filed.type) ?? [];
    const labels = team?.labels?.nodes?.filter((label) => label?.name === INCIDENT_LABEL_NAME) ?? [];
    if (!team || states.length !== 1 || labels.length !== 1) throw new Error("incident metadata unavailable");
    // Fail-open on the route and looping labels only: a missing one is named
    // in the body and the card is filed with repo:platform.
    const labelNamed = (name) => {
      const found = team.labels.nodes.filter((label) => label?.name === name && typeof label.id === "string");
      return found.length === 1 ? found[0] : null;
    };
    const missingLabels = wantedLabels.filter((name) => !labelNamed(name));
    const description = renderIncidentDescription(event, config, { missingLabels });
    if (!description) throw new Error("unsafe incident evidence");

    if (!existing) {
      await boundedCall(() => sendLinear(LINEAR_INCIDENT_CREATE_MUTATION, { input: {
        id: event.issue_uuid,
        teamId: team.id,
        stateId: states[0].id,
        labelIds: [labels[0].id, ...wantedLabels.map(labelNamed).filter(Boolean).map((label) => label.id)],
        assigneeId: null,
        title: incidentTitle(event),
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
