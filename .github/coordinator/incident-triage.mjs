import { createHash } from "node:crypto";
import { familyForLane, isWriterRole, roleForReceipt } from "./launch-vocabulary.mjs";

export const TRIAGE_VERSION = "1.0.0";
export const TRIAGE_RESUME_AUTHORITY = false;
export const TRIAGE_EFFECTS = Object.freeze(["linear-read", "linear-write", "github-read"]);
export const REPAIR_TEAM_KEY = "SHU";
export const REPAIR_STATE_NAME = "Todo";
export const REPAIR_CALL_TIMEOUT_MS = 1_500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ISSUE_RE = /^SHU-[0-9]+$/;
const INCIDENT_EVENT_RE = /^inc_[0-9a-f]{32}$/;
const REPAIR_EVENT_RE = /^repair_[0-9a-f]{32}$/;
const SAFE_REPO = "BAWES-Universe/studenthub-platform";
const SAFE_PATHS = Object.freeze([".github/coordinator"]);
const SAFE_DEPENDENCIES = Object.freeze(["SHU-226", "SHU-260"]);

export const MISSING_AUTHORITY = Object.freeze({
  UNKNOWN_REASON: "UNKNOWN_REASON",
  PRODUCT_DECISION: "PRODUCT_DECISION",
  GRANT_OR_AUTHORIZATION: "GRANT_OR_AUTHORIZATION",
  CREDENTIALS: "CREDENTIALS",
  SPENDING: "SPENDING",
  DEPLOYMENT: "DEPLOYMENT",
  ACTIVATION: "ACTIVATION",
  DESTRUCTIVE_WORK: "DESTRUCTIVE_WORK",
  PRODUCTION_CONTACT: "PRODUCTION_CONTACT",
  INCIDENT_EVIDENCE_INVALID: "INCIDENT_EVIDENCE_INVALID",
  POLICY_INVALID: "POLICY_INVALID",
  DEPENDENCY_NOT_DONE: "DEPENDENCY_NOT_DONE",
});

const FORBIDDEN_AUTHORITIES = new Set([
  MISSING_AUTHORITY.PRODUCT_DECISION,
  MISSING_AUTHORITY.GRANT_OR_AUTHORIZATION,
  MISSING_AUTHORITY.CREDENTIALS,
  MISSING_AUTHORITY.SPENDING,
  MISSING_AUTHORITY.DEPLOYMENT,
  MISSING_AUTHORITY.ACTIVATION,
  MISSING_AUTHORITY.DESTRUCTIVE_WORK,
  MISSING_AUTHORITY.PRODUCTION_CONTACT,
]);

const PROTECTED_REASONS = Object.freeze({
  revision_budget_exhausted: Object.freeze([MISSING_AUTHORITY.PRODUCT_DECISION]),
  failure_budget_exhausted: Object.freeze([MISSING_AUTHORITY.CREDENTIALS, MISSING_AUTHORITY.SPENDING]),
  stale_head: Object.freeze([MISSING_AUTHORITY.DESTRUCTIVE_WORK]),
  unreadable_head: Object.freeze([MISSING_AUTHORITY.PRODUCTION_CONTACT]),
  adapter_paused: Object.freeze([MISSING_AUTHORITY.CREDENTIALS]),
  activation_expired: Object.freeze([MISSING_AUTHORITY.GRANT_OR_AUTHORIZATION, MISSING_AUTHORITY.ACTIVATION]),
  unknown_breaker: Object.freeze([MISSING_AUTHORITY.UNKNOWN_REASON]),
});

// Deliberately one-entry allowlist. The other SHU-226 reason codes can be
// caused by product ambiguity, authorization expiry, credentials, quota/spend,
// live-head access, or destructive branch recovery and therefore cannot safely
// imply a repair. This entry repairs only the closed coordinator verdict seam.
const AMBIGUOUS_HOLD_POLICY = Object.freeze({
  policy_version: TRIAGE_VERSION,
  repository: SAFE_REPO,
  repository_label: "repo:platform",
  scope_id: "coordinator-ambiguous-verdict-repair-v1",
  scope_template: "Correct the deterministic coordinator handling that produced an incoherent HOLD for this incident. Change only .github/coordinator, add a focused regression and named mutation, and preserve all activation, dispatch, production and credential gates.",
  allowed_paths: SAFE_PATHS,
  risk_label: "risk:R3",
  type_label: "type:implementation",
  worker_lane: "codex-builder",
  verifier_name: "opus",
  dependencies: SAFE_DEPENDENCIES,
  authorities: Object.freeze([]),
});

export const REPAIR_POLICIES = Object.freeze({
  ambiguous_hold: AMBIGUOUS_HOLD_POLICY,
});

const VERIFIER_FAMILY = Object.freeze({
  codex: "codex", gpt: "codex", "gpt-6": "codex",
  claude: "claude", opus: "claude", sonnet: "claude", haiku: "claude", fable: "claude",
  hermes: "hermes",
});

export const LINEAR_TRIAGE_QUERY = `
  query CoordinatorIncidentTriage($incidentId: String!, $repairId: String!) {
    incident: issue(id: $incidentId) {
      id identifier title description
      team { id key }
      state { id name type }
      labels { nodes { id name } }
      assignee { id }
      delegate { id }
      relations { nodes { type relatedIssue { id identifier state { name } } } }
      comments(last: 250, orderBy: createdAt) { nodes { body createdAt } }
    }
    repair: issue(id: $repairId) {
      id identifier title description
      team { id key }
      state { id name type }
      labels { nodes { id name } }
      assignee { id }
      delegate { id }
      relations { nodes { type relatedIssue { id identifier state { name } } } }
      attachments { nodes { url title } }
      comments(last: 250, orderBy: createdAt) { nodes { body createdAt } }
    }
    teams(filter: { key: { eq: "SHU" } }, first: 2) {
      nodes {
        id key
        states(first: 100) { nodes { id name type } }
        labels(first: 100) { nodes { id name } }
      }
    }
    dependency226: issue(id: "SHU-226") { id identifier state { name } }
    dependency260: issue(id: "SHU-260") { id identifier state { name } }
  }`;

export const LINEAR_REPAIR_CREATE_MUTATION = `
  mutation CoordinatorRepairCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier } }
  }`;

export const LINEAR_REPAIR_UPDATE_MUTATION = `
  mutation CoordinatorRepairUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id identifier } }
  }`;

export const LINEAR_REPAIR_RELATION_MUTATION = `
  mutation CoordinatorRepairRelate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success issueRelation { id } }
  }`;

function deterministicUuid(namespace) {
  const bytes = Buffer.from(createHash("sha256").update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function repairIdentity(eventId) {
  if (!INCIDENT_EVENT_RE.test(eventId ?? "")) return null;
  const digest = createHash("sha256").update(`coordinator-repair\0${eventId}`).digest("hex").slice(0, 32);
  const repairId = `repair_${digest}`;
  return {
    repair_event_id: repairId,
    issue_uuid: deterministicUuid(`coordinator-repair:${eventId}`),
    incident_relation_uuid: deterministicUuid(`coordinator-repair-incident:${eventId}`),
    dependency_relation_uuids: Object.fromEntries(SAFE_DEPENDENCIES.map((id) => [id, deterministicUuid(`coordinator-repair-dependency:${eventId}:${id}`)])),
  };
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

export function repairPolicyValid(policy) {
  if (!policy || policy.policy_version !== TRIAGE_VERSION || policy.repository !== SAFE_REPO) return false;
  if (policy.repository_label !== "repo:platform" || policy.risk_label !== "risk:R3" || policy.type_label !== "type:implementation") return false;
  if (policy.scope_id !== "coordinator-ambiguous-verdict-repair-v1" || policy.scope_template !== AMBIGUOUS_HOLD_POLICY.scope_template) return false;
  if (!sameArray(policy.allowed_paths, SAFE_PATHS) || !sameArray(policy.dependencies, SAFE_DEPENDENCIES)) return false;
  if (!Array.isArray(policy.authorities) || policy.authorities.some((authority) => FORBIDDEN_AUTHORITIES.has(authority))) return false;
  if (policy.authorities.some((authority) => !FORBIDDEN_AUTHORITIES.has(authority)) || policy.worker_lane !== "codex-builder") return false;
  const writerFamily = familyForLane(policy.worker_lane);
  const verifierFamily = VERIFIER_FAMILY[policy.verifier_name];
  if (!writerFamily || !verifierFamily) return false;
  if (writerFamily === verifierFamily) return false;
  return true;
}

export function repairPolicyDecision(event, policies = REPAIR_POLICIES) {
  const protectedRequirements = PROTECTED_REASONS[event?.reason_code];
  if (protectedRequirements) return { action: "MISSING_AUTHORITY", requirements: [...protectedRequirements], policy: null };
  const policy = policies[event?.reason_code] ?? null;
  if (!policy) return { action: "MISSING_AUTHORITY", requirements: [MISSING_AUTHORITY.UNKNOWN_REASON], policy: null };
  if (!repairPolicyValid(policy)) return { action: "MISSING_AUTHORITY", requirements: [MISSING_AUTHORITY.POLICY_INVALID], policy: null };
  return { action: "AUTO_REPAIR", requirements: [], policy };
}

function safeIso(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function exactKeys(value, keys) {
  return value && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function markerPayload(marker) {
  const keys = ["version", "event_id", "incident_id", "repair_event_id", "repair_id", "repair_identifier", "status", "requirements", "pr_url", "pr_number", "verdict", "verdict_head", "landed_revision", "recorded_at"];
  return Object.fromEntries(keys.map((key) => [key, marker[key] ?? null]));
}

export function renderTriageMarker(marker) {
  return ["<!-- coordinator-triage v1 -->", "coordinator-triage v1", "```json", JSON.stringify(markerPayload(marker)), "```"].join("\n");
}

export function parseTriageMarkers(comments = []) {
  const keys = ["version", "event_id", "incident_id", "repair_event_id", "repair_id", "repair_identifier", "status", "requirements", "pr_url", "pr_number", "verdict", "verdict_head", "landed_revision", "recorded_at"];
  const markers = [];
  for (const comment of comments ?? []) {
    const body = typeof comment?.body === "string" ? comment.body : "";
    if (!body.includes("<!-- coordinator-triage v1 -->")) continue;
    const match = /```json\s*([\s\S]*?)\s*```/.exec(body);
    if (!match) continue;
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    if (!exactKeys(value, keys) || value.version !== TRIAGE_VERSION || !INCIDENT_EVENT_RE.test(value.event_id ?? "")) continue;
    if (!UUID_RE.test(value.incident_id ?? "") || !REPAIR_EVENT_RE.test(value.repair_event_id ?? "")) continue;
    if (!["MISSING_AUTHORITY", "REPAIR_READY", "LANDED"].includes(value.status) || !safeIso(value.recorded_at)) continue;
    if (!Array.isArray(value.requirements) || value.requirements.some((entry) => !Object.values(MISSING_AUTHORITY).includes(entry))) continue;
    markers.push(value);
  }
  return markers;
}

function repairLabels(policy) {
  return [policy.repository_label, policy.type_label, policy.risk_label, `worker:${policy.worker_lane}`, `verifier:${policy.verifier_name}`];
}

export function renderRepairDescription(event, identity, policy) {
  if (!repairPolicyValid(policy) || !ISSUE_RE.test(event?.issue_id ?? "") || !INCIDENT_EVENT_RE.test(event?.event_id ?? "")) return null;
  const lines = [
    `<!-- coordinator-repair-event ${identity.repair_event_id} -->`,
    "## Bounded coordinator repair",
    "",
    policy.scope_template,
    "",
    `- Incident event: \`${event.event_id}\``,
    `- Incident reason: \`${event.reason_code}\``,
    `- Original issue: \`${event.issue_id}\``,
    `- Policy: \`${policy.policy_version}/${policy.scope_id}\``,
    `- Repository: \`${policy.repository}\``,
    `- Allowed paths: \`${policy.allowed_paths.join(",")}\``,
    `- Owner lane: \`${policy.worker_lane}\``,
    `- Independent verifier: \`${policy.verifier_name}\``,
    `- Dependencies: \`${policy.dependencies.join(",")}\``,
    "",
    "This card grants no product decision, authorization, credential, spend, deployment, activation, destructive operation, production contact, or mutation of the running coordinator checkout.",
  ];
  return lines.join("\n");
}

function hasLabels(issue, expected) {
  const actual = new Set((issue?.labels?.nodes ?? []).map((label) => label?.name));
  return expected.every((label) => actual.has(label));
}

function hasRelation(issue, type, identifier) {
  return (issue?.relations?.nodes ?? []).some((relation) => relation?.type === type && relation?.relatedIssue?.identifier === identifier);
}

function incidentConfirmed(issue, event) {
  if (!issue || issue.id !== event.issue_uuid || issue.title !== `coordinator stop: ${event.issue_id} — ${event.reason_code}`) return false;
  if (!String(issue.description ?? "").includes(`<!-- coordinator-incident-event ${event.event_id} -->`)) return false;
  if (issue.team?.key !== REPAIR_TEAM_KEY || issue.state?.name !== "Triage" || issue.assignee !== null || issue.delegate !== null) return false;
  if (!hasLabels(issue, ["repo:platform"]) || !hasRelation(issue, "related", event.issue_id)) return false;
  return true;
}

function repairBound(issue, event, identity, policy) {
  if (!issue || issue.id !== identity.issue_uuid) return false;
  if (issue.title !== `coordinator repair: ${event.issue_id} — ${event.reason_code}`) return false;
  if (!String(issue.description ?? "").includes(`<!-- coordinator-repair-event ${identity.repair_event_id} -->`)) return false;
  if (issue.team?.key !== REPAIR_TEAM_KEY || !hasLabels(issue, repairLabels(policy))) return false;
  if (!hasRelation(issue, "related", event.incident_identifier ?? "")) return false;
  return policy.dependencies.every((dependency) => hasRelation(issue, "blockedBy", dependency));
}

function repairEligible(issue, event, identity, policy) {
  return repairBound(issue, event, identity, policy) && issue.state?.name === REPAIR_STATE_NAME && issue.assignee === null && issue.delegate === null;
}

function parseReceiptComments(comments = []) {
  const receipts = [];
  for (const comment of comments ?? []) {
    const body = typeof comment?.body === "string" ? comment.body : "";
    if (!body.includes("<!-- coordinator-receipt v1")) continue;
    const match = /```json\s*([\s\S]*?)\s*```/.exec(body);
    if (!match) continue;
    let receipt;
    try { receipt = JSON.parse(match[1]); } catch { continue; }
    if (!UUID_RE.test(receipt?.attempt_id ?? "") || !SHA_RE.test(receipt?.target_sha ?? "")) continue;
    receipts.push(receipt);
  }
  return receipts;
}

function exactPrAttachment(repair, policy) {
  const prefix = `https://github.com/${policy.repository}/pull/`;
  const matches = [];
  for (const attachment of repair?.attachments?.nodes ?? []) {
    let url;
    try { url = new URL(attachment?.url); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) continue;
    if (!url.toString().startsWith(prefix)) continue;
    const match = new RegExp(`^https://github\\.com/${policy.repository.replace("/", "\\/")}/pull/([1-9][0-9]*)$`).exec(url.toString().replace(/\/$/, ""));
    if (match) matches.push({ url: url.toString().replace(/\/$/, ""), number: Number(match[1]) });
  }
  return matches.length === 1 ? matches[0] : null;
}

function receiptFamily(receipt) {
  try { return familyForLane(receipt.requested_worker); } catch { return null; }
}

function lineageVerdict(repair, pr, policy) {
  const receipts = parseReceiptComments(repair?.comments?.nodes ?? []);
  const writerFamily = familyForLane(policy.worker_lane);
  const verifierFamily = VERIFIER_FAMILY[policy.verifier_name];
  const author = receipts.find((receipt) => isWriterRole(roleForReceipt(receipt)) && receipt.stage === "COMPLETED" && receipt.result_sha === pr.head.sha && receiptFamily(receipt) === writerFamily);
  const verdict = receipts.find((receipt) => roleForReceipt(receipt) === "review" && receipt.stage === "COMPLETED" && receipt.verdict_stage === "PASS" && receipt.target_sha === pr.head.sha && receiptFamily(receipt) === verifierFamily);
  if (!author || !verdict || !author.worker_identity || !verdict.worker_identity || author.worker_identity === verdict.worker_identity) return null;
  if (writerFamily === verifierFamily) return null;
  return { author, verdict };
}

async function boundedCall(call, timeoutMs = REPAIR_CALL_TIMEOUT_MS, timeoutImpl = null) {
  if (timeoutImpl) return timeoutImpl(call, timeoutMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded triage timeout")), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function writeMarker({ sendLinear, commentMutation, incidentId, marker, token, fetchImpl, timeoutMs, timeoutImpl }) {
  try {
    await boundedCall(() => sendLinear(commentMutation, { issueId: incidentId, body: renderTriageMarker(marker) }, token, fetchImpl), timeoutMs, timeoutImpl);
    return true;
  } catch { return false; }
}

function marker(event, identity, status, now, values = {}) {
  return {
    version: TRIAGE_VERSION,
    event_id: event.event_id,
    incident_id: event.issue_uuid,
    repair_event_id: identity.repair_event_id,
    repair_id: values.repair_id ?? null,
    repair_identifier: values.repair_identifier ?? null,
    status,
    requirements: values.requirements ?? [],
    pr_url: values.pr_url ?? null,
    pr_number: values.pr_number ?? null,
    verdict: values.verdict ?? null,
    verdict_head: values.verdict_head ?? null,
    landed_revision: values.landed_revision ?? null,
    recorded_at: safeIso(now),
  };
}

function metadataFor(data, policy) {
  const teams = data?.teams?.nodes ?? [];
  const team = teams.length === 1 && teams[0]?.key === REPAIR_TEAM_KEY ? teams[0] : null;
  const states = team?.states?.nodes?.filter((state) => state?.name === REPAIR_STATE_NAME && state?.type === "unstarted") ?? [];
  const labelByName = new Map((team?.labels?.nodes ?? []).map((label) => [label?.name, label]));
  const labels = repairLabels(policy).map((name) => labelByName.get(name)).filter(Boolean);
  const dependencies = [data?.dependency226, data?.dependency260];
  if (!team || states.length !== 1 || labels.length !== repairLabels(policy).length) return null;
  if (dependencies.some((dependency, index) => dependency?.identifier !== policy.dependencies[index] || dependency?.state?.name !== "Done" || !UUID_RE.test(dependency?.id ?? ""))) return null;
  return { team, state: states[0], labels, dependencies };
}

async function fetchTriageState(args, identity) {
  return boundedCall(() => args.sendLinear(LINEAR_TRIAGE_QUERY, { incidentId: args.event.issue_uuid, repairId: identity.issue_uuid }, args.token, args.fetchImpl), args.timeoutMs, args.timeoutImpl);
}

async function completedLineage({ state, event, identity, policy, githubToken, fetchImpl, timeoutMs, timeoutImpl }) {
  const repair = state?.repair;
  if (!repairBound(repair, event, identity, policy) || repair.state?.name !== "Done") return null;
  const attachment = exactPrAttachment(repair, policy);
  if (!attachment || !githubToken) return null;
  const response = await boundedCall(() => fetchImpl(`https://api.github.com/repos/${policy.repository}/pulls/${attachment.number}`, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  }), timeoutMs, timeoutImpl);
  if (!response?.ok) return null;
  const pr = await response.json().catch(() => null);
  if (!pr || pr.html_url !== attachment.url || !pr.merged_at || !SHA_RE.test(pr.merge_commit_sha ?? "") || !SHA_RE.test(pr.head?.sha ?? "")) return null;
  if (pr.head?.repo?.full_name !== policy.repository) return null;
  const proof = lineageVerdict(repair, pr, policy);
  return proof ? { attachment, pr, proof } : null;
}

export async function triageCoordinatorIncident({
  event,
  confirmed,
  token,
  githubToken = "",
  fetchImpl,
  sendLinear,
  commentMutation,
  now = new Date(),
  stdout = () => {},
  timeoutMs = REPAIR_CALL_TIMEOUT_MS,
  timeoutImpl = null,
  policies = REPAIR_POLICIES,
} = {}) {
  const identity = repairIdentity(event?.event_id);
  const inert = { status: "NOT_AUTHORIZED", resume: TRIAGE_RESUME_AUTHORITY };
  if (!confirmed || !identity || !UUID_RE.test(event?.issue_uuid ?? "") || typeof sendLinear !== "function" || !token) return inert;
  const args = { event, token, fetchImpl, sendLinear, commentMutation, timeoutMs, timeoutImpl };
  let state;
  try { state = await fetchTriageState(args, identity); } catch { return { status: "STATE_UNREADABLE", resume: TRIAGE_RESUME_AUTHORITY }; }
  if (!incidentConfirmed(state?.incident, event)) return { status: "MISSING_AUTHORITY", requirements: [MISSING_AUTHORITY.INCIDENT_EVIDENCE_INVALID], resume: TRIAGE_RESUME_AUTHORITY };
  event = { ...event, incident_identifier: state.incident.identifier };
  const existingMarkers = parseTriageMarkers(state.incident.comments?.nodes ?? []).filter((entry) => entry.event_id === event.event_id);
  const decision = repairPolicyDecision(event, policies);
  if (decision.action !== "AUTO_REPAIR") {
    if (!existingMarkers.some((entry) => entry.status === "MISSING_AUTHORITY" && JSON.stringify(entry.requirements) === JSON.stringify(decision.requirements))) {
      await writeMarker({ ...args, incidentId: event.issue_uuid, marker: marker(event, identity, "MISSING_AUTHORITY", now, { requirements: decision.requirements }) });
    }
    stdout(`incident-triage: ${event.event_id} MISSING_AUTHORITY ${decision.requirements.join(",")}`);
    return { status: "MISSING_AUTHORITY", requirements: decision.requirements, resume: TRIAGE_RESUME_AUTHORITY };
  }
  const policy = decision.policy;
  const metadata = metadataFor(state, policy);
  if (!metadata) {
    const requirements = [MISSING_AUTHORITY.DEPENDENCY_NOT_DONE];
    if (!existingMarkers.some((entry) => entry.status === "MISSING_AUTHORITY" && entry.requirements.includes(requirements[0]))) {
      await writeMarker({ ...args, incidentId: event.issue_uuid, marker: marker(event, identity, "MISSING_AUTHORITY", now, { requirements }) });
    }
    return { status: "MISSING_AUTHORITY", requirements, resume: TRIAGE_RESUME_AUTHORITY };
  }

  const relations = [
    { id: identity.incident_relation_uuid, issueId: identity.issue_uuid, relatedIssueId: event.issue_uuid, type: "related" },
    ...metadata.dependencies.map((dependency) => ({ id: identity.dependency_relation_uuids[dependency.identifier], issueId: dependency.id, relatedIssueId: identity.issue_uuid, type: "blocks" })),
  ];
  const ensureRelations = async () => {
    for (const relation of relations) {
      try { await boundedCall(() => sendLinear(LINEAR_REPAIR_RELATION_MUTATION, { input: relation }, token, fetchImpl), timeoutMs, timeoutImpl); } catch { /* deterministic relation may already exist */ }
    }
  };

  // A create may have committed while one or more relation responses were lost.
  // Reconcile deterministic edges before evaluating a completed repair, so a
  // transient relation failure cannot strand otherwise valid landed evidence.
  if (state.repair) {
    await ensureRelations();
    try { state = await fetchTriageState(args, identity); } catch { return { status: "WAITING_CONFIRMATION", resume: TRIAGE_RESUME_AUTHORITY }; }
    event = { ...event, incident_identifier: state?.incident?.identifier ?? event.incident_identifier };
  }

  if (state.repair?.state?.name === "Done") {
    let landed = null;
    try { landed = await completedLineage({ state, event, identity, policy, githubToken, fetchImpl, timeoutMs, timeoutImpl }); } catch { landed = null; }
    if (!landed) return { status: "WAITING_FOR_LANDED_LINEAGE", resume: TRIAGE_RESUME_AUTHORITY };
    const values = {
      repair_id: state.repair.id,
      repair_identifier: state.repair.identifier,
      pr_url: landed.attachment.url,
      pr_number: landed.attachment.number,
      verdict: "PASS",
      verdict_head: landed.pr.head.sha,
      landed_revision: landed.pr.merge_commit_sha,
    };
    if (!existingMarkers.some((entry) => entry.status === "LANDED" && entry.verdict_head === values.verdict_head && entry.landed_revision === values.landed_revision)) {
      await writeMarker({ ...args, incidentId: event.issue_uuid, marker: marker(event, identity, "LANDED", now, values) });
    }
    stdout(`incident-triage: ${event.event_id} LANDED ${values.repair_identifier} PR#${values.pr_number}`);
    return { status: "LANDED", precondition_cleared: true, lineage: values, resume: TRIAGE_RESUME_AUTHORITY };
  }

  const description = renderRepairDescription(event, identity, policy);
  const title = `coordinator repair: ${event.issue_id} — ${event.reason_code}`;
  const updateInput = { title, description, teamId: metadata.team.id, stateId: metadata.state.id, labelIds: metadata.labels.map((label) => label.id), assigneeId: null };
  if (state.repair && !String(state.repair.description ?? "").includes(`<!-- coordinator-repair-event ${identity.repair_event_id} -->`)) {
    return { status: "MISSING_AUTHORITY", requirements: [MISSING_AUTHORITY.INCIDENT_EVIDENCE_INVALID], resume: TRIAGE_RESUME_AUTHORITY };
  }
  try {
    if (!state.repair) {
      await boundedCall(() => sendLinear(LINEAR_REPAIR_CREATE_MUTATION, { input: { id: identity.issue_uuid, ...updateInput } }, token, fetchImpl), timeoutMs, timeoutImpl);
    } else if (state.repair.state?.name === REPAIR_STATE_NAME && state.repair.assignee === null && state.repair.delegate === null) {
      await boundedCall(() => sendLinear(LINEAR_REPAIR_UPDATE_MUTATION, { id: identity.issue_uuid, input: updateInput }, token, fetchImpl), timeoutMs, timeoutImpl);
    }
  } catch { /* a committed create/update may have lost its response; verify below */ }

  await ensureRelations();

  try { state = await fetchTriageState(args, identity); } catch { return { status: "WAITING_CONFIRMATION", resume: TRIAGE_RESUME_AUTHORITY }; }
  event = { ...event, incident_identifier: state?.incident?.identifier ?? event.incident_identifier };
  if (!repairEligible(state?.repair, event, identity, policy)) return { status: "WAITING_CONFIRMATION", resume: TRIAGE_RESUME_AUTHORITY };
  const values = { repair_id: state.repair.id, repair_identifier: state.repair.identifier };
  const refreshedMarkers = parseTriageMarkers(state.incident.comments?.nodes ?? []).filter((entry) => entry.event_id === event.event_id);
  if (!refreshedMarkers.some((entry) => entry.status === "REPAIR_READY" && entry.repair_id === values.repair_id)) {
    await writeMarker({ ...args, incidentId: event.issue_uuid, marker: marker(event, identity, "REPAIR_READY", now, values) });
  }
  stdout(`incident-triage: ${event.event_id} REPAIR_READY ${values.repair_identifier}`);
  return { status: "REPAIR_READY", repair: values, resume: TRIAGE_RESUME_AUTHORITY };
}
