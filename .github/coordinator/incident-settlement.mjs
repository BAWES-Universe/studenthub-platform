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
// left where they put it.
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
      comments(last: 250, orderBy: createdAt) { nodes { body } }
    }
    teams(filter: { key: { eq: $teamKey } }, first: 2) {
      nodes { id key states(first: 100) { nodes { id name type } } }
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
  if (!moved && incident.state?.name === INCIDENT_STATE_NAME) {
    const teams = state?.teams?.nodes ?? [];
    const team = teams.length === 1 && teams[0]?.key === INCIDENT_TEAM_KEY ? teams[0] : null;
    const states = team?.states?.nodes?.filter((entry) => entry?.name === target.name && entry?.type === target.type) ?? [];
    if (states.length === 1) {
      try {
        await call(LINEAR_SETTLE_UPDATE_MUTATION, { id: event.issue_uuid, input: { stateId: states[0].id } });
        moved = true;
      } catch { /* a lost response is re-checked on the next tick */ }
    }
  }

  let summarized = event.fixture === true ? null : false;
  if (event.fixture !== true) {
    const summary = state?.summary ?? null;
    const already = (summary?.comments?.nodes ?? []).some((comment) => String(comment?.body ?? "").includes(stopSummaryMarker(event.event_id)));
    const body = renderStopSummary(event, incident.identifier);
    if (already) summarized = true;
    else if (UUID_RE.test(summary?.id ?? "") && summary.identifier === STOP_SUMMARY_ISSUE && body) {
      try {
        await call(commentMutation, { issueId: summary.id, body });
        summarized = true;
      } catch { /* retried on the next tick; the marker keeps it to one line */ }
    }
  }

  const status = moved && summarized !== false ? "SETTLED" : "PARTIAL";
  stdout(`incident-settlement: ${event.event_id} ${status} ${moved ? target.name : "unmoved"}${summarized === null ? "" : summarized ? " summary" : " no-summary"}`);
  return { status, state: moved ? target.name : incident.state?.name ?? null, summarized };
}
