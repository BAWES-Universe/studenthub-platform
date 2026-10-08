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
// can land between a read and a write of ours; the card's history then shows a
// change of ours after the person's latest move, and settling puts the
// person's state back, on every tick, wherever the card sits.
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
// The incident card's whole history is read in one page; a card with more
// entries than this cannot be checked and stays UNVERIFIED.
export const HISTORY_PAGE_SIZE = 250;
// Put-backs per tick before the rest is left for the next tick.
export const RESTORE_ROUNDS = 3;

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
    viewer { id }
    issue(id: $id) {
      state { id name }
      history(first: 250) {
        nodes { createdAt actor { id } fromState { id name } toState { id name } }
        pageInfo { hasNextPage hasPreviousPage }
      }
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

// Linear has no conditional update, so any write of ours (the settle move, or a
// put-back) can land just after a person's move and overwrite it. The card's
// whole state history, with who made each change, decides it: the person's
// latest move wins. When a change of ours came after it and the card is not
// where they put it, it goes back there, and the history is read again, so a
// person's move that lands during the put-back is caught too. This runs on
// every tick the incident is confirmed, wherever the card now sits, so nothing
// depends on a check finishing within one tick.
// Returns the state's name when the card was put back, null when no move of a
// person's is overwritten, or false when the history could not be read in full
// or a put-back did not apply (UNVERIFIED, checked again on the next tick).
async function readStateHistory(issueId, call) {
  for (let tries = 0; tries < 2; tries += 1) {
    let data = null;
    try { data = await call(LINEAR_SETTLE_HISTORY_QUERY, { id: issueId }); } catch { continue; }
    const viewerId = data?.viewer?.id;
    const history = data?.issue?.history;
    const current = data?.issue?.state;
    if (typeof viewerId !== "string" || !viewerId || !Array.isArray(history?.nodes) || typeof current?.id !== "string") continue;
    if (history.pageInfo?.hasNextPage !== false || history.pageInfo?.hasPreviousPage !== false) return null;
    const changes = history.nodes.filter((entry) => entry?.toState?.id && entry.fromState?.id !== entry.toState.id);
    if (changes.some((entry) => Number.isNaN(Date.parse(entry.createdAt)))) return null;
    changes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return { viewerId, current, changes };
  }
  return null;
}

function overwrittenChoice({ viewerId, current, changes }) {
  const ours = (entry) => entry.actor?.id === viewerId;
  const person = changes.length - 1 - [...changes].reverse().findIndex((entry) => !ours(entry));
  if (person >= changes.length) return null;
  const wanted = changes[person].toState;
  if (wanted.name === INCIDENT_STATE_NAME || current.id === wanted.id) return null;
  return changes.slice(person + 1).some(ours) ? wanted : null;
}

async function keepPersonsChoice(issueId, call) {
  let restored = null;
  for (let round = 0; round <= RESTORE_ROUNDS; round += 1) {
    const view = await readStateHistory(issueId, call);
    if (!view) return false;
    const wanted = overwrittenChoice(view);
    if (!wanted) return restored;
    if (round === RESTORE_ROUNDS) return false;
    let applied = false;
    for (let tries = 0; tries < 2 && !applied; tries += 1) {
      try {
        const result = await call(LINEAR_SETTLE_UPDATE_MUTATION, { id: issueId, input: { stateId: wanted.id } });
        applied = result?.issueUpdate?.success === true;
      } catch { /* retried once, then left for the next tick */ }
    }
    if (!applied) return false;
    restored = wanted.name ?? "unknown";
  }
  return false;
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
    }
  }
  const check = await keepPersonsChoice(event.issue_uuid, call);
  if (check === false) verified = false;
  else if (check !== null) { restored = check; moved = false; }

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
