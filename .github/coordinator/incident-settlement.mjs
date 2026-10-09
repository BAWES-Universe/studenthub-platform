// SHU-298: the coordinator settles its own stop cards.
//
// An incident card is filed where it ends up (incident-reporting.mjs): a
// rehearsal fixture's stop closed (Done), a real card's stop in Backlog. Once
// triage has decided, settling puts one plain line on the SHU-71 tracking card
// for a real card's stop.
//
// Settling only posts that line. It never changes a card's state (Linear has no
// conditional update, so a state write could overwrite a person's move), and it
// never repairs, re-arms, relaunches, clears a pause or edits an activation: a
// retry is still a fresh activation.

export const SETTLE_CALL_TIMEOUT_MS = 1_500;
export const STOP_SUMMARY_ISSUE = "SHU-71";
// Triage outcomes that are a decision. Unreadable or still-confirming triage
// posts nothing until a later tick.
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
  query CoordinatorIncidentSettle($incidentId: String!, $summaryId: String!) {
    incident: issue(id: $incidentId) {
      id identifier title description
    }
    summary: issue(id: $summaryId) {
      id identifier
      comments(last: 250, orderBy: createdAt) { nodes { body } pageInfo { hasPreviousPage startCursor } }
    }
  }`;

export const LINEAR_STOP_SUMMARY_PAGE_QUERY = `
  query CoordinatorStopSummaryPage($summaryId: String!, $before: String!) {
    issue(id: $summaryId) {
      comments(last: 250, before: $before, orderBy: createdAt) { nodes { body } pageInfo { hasPreviousPage startCursor } }
    }
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
    state = await call(LINEAR_SETTLE_QUERY, { incidentId: event.issue_uuid, summaryId: STOP_SUMMARY_ISSUE });
  } catch {
    return { status: "STATE_UNREADABLE" };
  }
  const incident = state?.incident ?? null;
  if (!incidentIsThisEvent(incident, event)) return { status: "INCIDENT_UNCONFIRMED" };
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

  const status = summarized !== false ? "SETTLED" : "PARTIAL";
  stdout(`incident-settlement: ${event.event_id} ${status}${summarized === null ? "" : summarized ? " summary" : " no-summary"}`);
  return { status, summarized };
}
