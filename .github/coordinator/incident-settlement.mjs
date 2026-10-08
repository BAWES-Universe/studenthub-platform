// SHU-298: the coordinator triages its own stop cards.
//
// After an incident card is confirmed and triage has decided, the card leaves
// Triage. A rehearsal fixture's stop is expected, so its card is closed (Done).
// A real card's stop moves to Backlog, linked to the card it stopped (SHU-226
// files that relation), and one plain line goes on the SHU-71 tracking card.
//
// Settling only moves the card out of Triage and posts that line. It never
// repairs, re-arms, relaunches, clears a pause or edits an activation: a retry
// is still a fresh activation. A card a person already moved out of Triage is
// left where they put it. Linear has no conditional update, so a person's move
// can land between the read and the write; the card's history then shows the
// write did not start from Triage, and settling puts the person's state back.
import { INCIDENT_STATE_NAME, INCIDENT_TEAM_KEY } from "./incident-reporting.mjs";

export const SETTLE_CALL_TIMEOUT_MS = 1_500;
export const STOP_SUMMARY_ISSUE = "SHU-71";
export const FIXTURE_SETTLED_STATE = Object.freeze({ name: "Done", type: "completed" });
export const CARD_SETTLED_STATE = Object.freeze({ name: "Backlog", type: "backlog" });
// Every state a confirmed incident card can be in while the coordinator still
// owns it: where it is filed, and where settling moves it.
export const INCIDENT_OWNED_STATE_NAMES = Object.freeze([INCIDENT_STATE_NAME, CARD_SETTLED_STATE.name, FIXTURE_SETTLED_STATE.name]);
// Triage outcomes that are a decision. Unreadable or still-confirming triage
// leaves the card in Triage for the next tick.
export const SETTLE_AFTER_TRIAGE = Object.freeze(["MISSING_AUTHORITY", "REPAIR_READY", "LANDED"]);
// SHU-71's history is read newest first, a page at a time, until the marker is
// found or the history ends. Past this many pages the line is not posted: an
// unread history could already hold it.
export const SUMMARY_PAGE_SIZE = 250;
export const SUMMARY_MAX_PAGES = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUE_RE = /^SHU-[0-9]+$/;
const INCIDENT_EVENT_RE = /^inc_[0-9a-f]{32}$/;

export const LINEAR_SETTLE_QUERY = `
  query CoordinatorIncidentSettle($incidentId: String!, $summaryId: String!, $teamKey: String!) {
    incident: issue(id: $incidentId) {
      id identifier title description
      state { id name type }
    }
    summary: issue(id: $summaryId) {
      id identifier
      comments(last: 250, orderBy: createdAt) { nodes { body } pageInfo { hasPreviousPage startCursor } }
    }
    teams(filter: { key: { eq: $teamKey } }, first: 2) {
      nodes { id key states(first: 100) { nodes { id name type } } }
    }
  }`;

export const LINEAR_STOP_SUMMARY_PAGE_QUERY = `
  query CoordinatorStopSummaryPage($summaryId: String!, $before: String!) {
    issue(id: $summaryId) {
      comments(last: 250, before: $before, orderBy: createdAt) { nodes { body } pageInfo { hasPreviousPage startCursor } }
    }
  }`;

export const LINEAR_SETTLE_HISTORY_QUERY = `
  query CoordinatorStopHistory($id: String!) {
    issue(id: $id) {
      history(last: 10, orderBy: createdAt) { nodes { fromState { id name } toState { id name } } }
    }
  }`;

export const LINEAR_SETTLE_UPDATE_MUTATION = `
  mutation CoordinatorIncidentSettleState($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id identifier } }
  }`;

export function stopSummaryMarker(eventId) {
  return `<!-- coordinator-stop-summary ${eventId} -->`;
}

// One plain line for Khalid. Everything in it comes from closed vocabularies:
// the card id, the reason code and its fixed explanation, and the incident id.
export function renderStopSummary(event, incidentIdentifier) {
  if (!INCIDENT_EVENT_RE.test(event?.event_id ?? "") || !ISSUE_RE.test(event?.issue_id ?? "") || !ISSUE_RE.test(incidentIdentifier ?? "")) return null;
  if (typeof event.reason_code !== "string" || typeof event.explanation !== "string") return null;
  return [
    stopSummaryMarker(event.event_id),
    `Coordinator stop on ${event.issue_id} (\`${event.reason_code}\`, ${incidentIdentifier}): ${event.explanation} Nothing was repaired or relaunched.`,
  ].join("\n");
}

const hasMarker = (comments, marker) => (comments?.nodes ?? []).some((comment) => String(comment?.body ?? "").includes(marker));

// true: the marker is on SHU-71. false: the whole history was read and it is
// not. null: the history could not be read to its start, so nothing is posted.
async function summaryAlreadyPosted(comments, marker, call) {
  let page = comments;
  for (let pages = 1; ; pages += 1) {
    if (hasMarker(page, marker)) return true;
    const info = page?.pageInfo;
    if (info?.hasPreviousPage !== true) return false;
    if (pages >= SUMMARY_MAX_PAGES || typeof info.startCursor !== "string" || !info.startCursor) return null;
    try {
      page = (await call(LINEAR_STOP_SUMMARY_PAGE_QUERY, { summaryId: STOP_SUMMARY_ISSUE, before: info.startCursor }))?.issue?.comments ?? null;
    } catch { return null; }
    if (!page) return null;
  }
}

// Our write is the latest change to the target state. If it did not start from
// Triage, a person moved the card after it was read: put their state back.
// Returns the restored state's name, null when nothing was overwritten, or
// false when the history could not be read (reported as UNVERIFIED).
async function restorePersonsMove(issueId, targetStateId, call) {
  let nodes;
  try {
    nodes = (await call(LINEAR_SETTLE_HISTORY_QUERY, { id: issueId }))?.issue?.history?.nodes;
  } catch { return false; }
  if (!Array.isArray(nodes)) return false;
  const ours = [...nodes].reverse().find((entry) => entry?.toState?.id === targetStateId);
  if (!ours) return false;
  const before = ours.fromState;
  if (!before || before.name === INCIDENT_STATE_NAME || typeof before.id !== "string" || !before.id) return null;
  try {
    await call(LINEAR_SETTLE_UPDATE_MUTATION, { id: issueId, input: { stateId: before.id } });
  } catch { /* the history still shows it; the card is out of Triage, so settling never touches it again */ }
  return before.name ?? "unknown";
}

async function boundedCall(call, timeoutMs, timeoutImpl) {
  if (timeoutImpl) return timeoutImpl(call, timeoutMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded settle timeout")), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function incidentIsThisEvent(issue, event) {
  return issue?.id === event.issue_uuid
    && issue.title === `coordinator stop: ${event.issue_id} — ${event.reason_code}`
    && String(issue.description ?? "").includes(`<!-- coordinator-incident-event ${event.event_id} -->`);
}

export async function settleCoordinatorIncident({
  event,
  triageStatus,
  token,
  fetchImpl,
  sendLinear,
  commentMutation,
  stdout = () => {},
  timeoutMs = SETTLE_CALL_TIMEOUT_MS,
  timeoutImpl = null,
} = {}) {
  if (!event || !UUID_RE.test(event.issue_uuid ?? "") || !INCIDENT_EVENT_RE.test(event.event_id ?? "") || !token || typeof sendLinear !== "function") {
    return { status: "NOT_AUTHORIZED" };
  }
  if (!SETTLE_AFTER_TRIAGE.includes(triageStatus)) return { status: "WAITING_FOR_TRIAGE" };
  const call = (query, variables) => boundedCall(() => sendLinear(query, variables, token, fetchImpl), timeoutMs, timeoutImpl);
  let state;
  try {
    state = await call(LINEAR_SETTLE_QUERY, { incidentId: event.issue_uuid, summaryId: STOP_SUMMARY_ISSUE, teamKey: INCIDENT_TEAM_KEY });
  } catch {
    return { status: "STATE_UNREADABLE" };
  }
  const incident = state?.incident ?? null;
  if (!incidentIsThisEvent(incident, event)) return { status: "INCIDENT_UNCONFIRMED" };
  const target = event.fixture === true ? FIXTURE_SETTLED_STATE : CARD_SETTLED_STATE;

  let moved = incident.state?.name === target.name;
  let restored = null;
  let verified = true;
  if (!moved && incident.state?.name === INCIDENT_STATE_NAME) {
    const teams = state?.teams?.nodes ?? [];
    const team = teams.length === 1 && teams[0]?.key === INCIDENT_TEAM_KEY ? teams[0] : null;
    const states = team?.states?.nodes?.filter((entry) => entry?.name === target.name && entry?.type === target.type) ?? [];
    if (states.length === 1) {
      try {
        const result = await call(LINEAR_SETTLE_UPDATE_MUTATION, { id: event.issue_uuid, input: { stateId: states[0].id } });
        moved = result?.issueUpdate?.success === true;
      } catch { /* a lost response is re-checked on the next tick */ }
      if (moved) {
        const check = await restorePersonsMove(event.issue_uuid, states[0].id, call);
        if (check === false) verified = false;
        else if (check !== null) { restored = check; moved = false; }
      }
    }
  }

  let summarized = event.fixture === true ? null : false;
  if (event.fixture !== true) {
    const summary = state?.summary ?? null;
    const body = renderStopSummary(event, incident.identifier);
    const already = UUID_RE.test(summary?.id ?? "") && summary.identifier === STOP_SUMMARY_ISSUE
      ? await summaryAlreadyPosted(summary.comments, stopSummaryMarker(event.event_id), call)
      : null;
    if (already === true) summarized = true;
    else if (already === false && body) {
      try {
        const result = await call(commentMutation, { issueId: summary.id, body });
        summarized = result?.commentCreate?.success === true;
      } catch { /* retried on the next tick; the marker keeps it to one line */ }
    }
  }

  const status = restored !== null ? "RESTORED" : !verified ? "UNVERIFIED" : moved && summarized !== false ? "SETTLED" : "PARTIAL";
  const where = restored !== null ? `restored ${restored}` : moved ? target.name : "unmoved";
  stdout(`incident-settlement: ${event.event_id} ${status} ${where}${summarized === null ? "" : summarized ? " summary" : " no-summary"}`);
  return { status, state: restored ?? (moved ? target.name : incident.state?.name ?? null), summarized };
}
