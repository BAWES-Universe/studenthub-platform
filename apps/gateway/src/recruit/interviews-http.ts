import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { INTERVIEW_MODES, interviewView, isRecruitId, kuwaitWallClock, parseEvaluation, parseInterview, personInterviewView, type EvaluationFields, type InterviewFields, type InterviewMode, type InterviewOutcome, type InterviewRow, type InterviewStatus, type InterviewView, type PersonInterviewRow } from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, readBody, redirect, sameOrigin, sendJson, sessionCookie, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R6: interviews and evaluations.
//   GET  /recruit/requests/<id>/interviews        a request's interviews (company, pipeline authority, operator staff)
//   POST /recruit/requests/<id>/interviews        {cardId, scheduledAt, durationMinutes, mode, location}
//   POST /recruit/interviews/<id>/cancel          {requestId?}
//   POST /recruit/interviews/<id>/evaluate        {outcome, rating, sharedNote, internalNote, requestId?}
//   GET  /recruit/my-interviews                   the person's own interviews (time, place, outcome only)

export interface RecruitInterviewsStore {
  schedule(principalId: string, requestId: string, input: InterviewFields): Promise<{ kind: "scheduled"; interviewId: string } | { kind: "not_found" } | { kind: "stage_refused"; stage: string }>;
  cancel(principalId: string, interviewId: string): Promise<{ kind: "cancelled" } | { kind: "not_found" } | { kind: "refused"; status: InterviewStatus }>;
  evaluate(principalId: string, interviewId: string, input: EvaluationFields): Promise<{ kind: "evaluated"; version: number } | { kind: "not_found" } | { kind: "refused"; status: InterviewStatus } | { kind: "internal_note_refused" } | { kind: "stale"; version: number }>;
  forRequest(principalId: string, requestId: string): Promise<{
    request: { id: string; position_title: string; store_name: string; org_name: string };
    interviews: readonly InterviewRow[]; cards: readonly { id: string; person_name: string | null; stage: string }[]; canWrite: boolean; seesInternal: boolean;
  } | null>;
  mine(personId: string): Promise<readonly PersonInterviewRow[]>;
  /** A company's interviews (O-10), a page at a time; null when the caller may not read the company. */
  forOrganization?(principalId: string, orgId: string, page: number): Promise<{
    org_name: string; page: number; more: boolean;
    interviews: readonly { id: string; request_id: string; position_title: string; store_name: string; person_name: string | null; scheduled_at: string | Date; duration_minutes: number; mode: InterviewMode; status: InterviewStatus; outcome: InterviewOutcome | null }[];
  } | null>;
}
/** One row of a company's interviews page: never a rating, a note or a location. */
export interface OrganizationInterviewView {
  readonly interviewId: string; readonly requestId: string; readonly positionTitle: string; readonly store: string; readonly personName: string | null;
  readonly kuwaitTime: string; readonly durationMinutes: number; readonly mode: InterviewMode; readonly status: InterviewStatus; readonly outcome: InterviewOutcome | null;
}
export interface OrganizationInterviewsBody { readonly company: string; readonly page: number; readonly more: boolean; readonly interviews: readonly OrganizationInterviewView[] }
export interface RequestInterviewsBody {
  readonly requestId: string; readonly positionTitle: string; readonly company: string; readonly store: string;
  readonly interviews: readonly InterviewView[]; readonly cards: readonly { cardId: string; personName: string | null; stage: string }[]; readonly canWrite: boolean; readonly seesInternal: boolean;
}
export type PersonInterviewView = ReturnType<typeof personInterviewView>;
export interface RecruitInterviews {
  forRequest(session: string | undefined, requestId: string): Promise<RecruitResult<RequestInterviewsBody>>;
  schedule(session: string | undefined, requestId: string, body: unknown): Promise<RecruitResult<{ interviewId: string }>>;
  cancel(session: string | undefined, interviewId: string): Promise<RecruitResult<{ interviewId: string; status: "cancelled" }>>;
  evaluate(session: string | undefined, interviewId: string, body: unknown): Promise<RecruitResult<{ interviewId: string; version: number }>>;
  mine(session: string | undefined): Promise<RecruitResult<{ interviews: readonly PersonInterviewView[] }>>;
  one(session: string | undefined, interviewId: string): Promise<RecruitResult<{ interview: PersonInterviewView }>>;
  organization?(session: string | undefined, orgId: string, page: number): Promise<RecruitResult<OrganizationInterviewsBody>>;
}

const FORM_ONLY = ["requestId"];
/** Form posts carry the page's requestId for the redirect; it is not part of the fields. */
function fields(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([k]) => !FORM_ONLY.includes(k)));
}

export function createRecruitInterviews(p: { sessions: Pick<SessionStore, "get">; store: RecruitInterviewsStore; now?: () => Date }): RecruitInterviews {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async forRequest(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const r = await p.store.forRequest(id, requestId.toLowerCase());
      if (!r) return NOT_FOUND;
      return { status: 200, body: {
        requestId: r.request.id, positionTitle: r.request.position_title, company: r.request.org_name, store: r.request.store_name,
        interviews: r.interviews.map((row) => interviewView(row, r.seesInternal)), cards: r.cards.map((c) => ({ cardId: c.id, personName: c.person_name, stage: c.stage })),
        canWrite: r.canWrite, seesInternal: r.seesInternal,
      } };
    },
    async schedule(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const input = parseInterview(fields(body), (p.now ?? (() => new Date()))());
      if (!input) return BAD;
      const r = await p.store.schedule(id, requestId.toLowerCase(), input);
      if (r.kind === "scheduled") return { status: 200, body: { interviewId: r.interviewId } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: "stage_refused", stage: r.stage } };
    },
    async cancel(s, interviewId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(interviewId)) return NOT_FOUND;
      const r = await p.store.cancel(id, interviewId.toLowerCase());
      if (r.kind === "cancelled") return { status: 200, body: { interviewId: interviewId.toLowerCase(), status: "cancelled" } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: "interview_closed", status: r.status } };
    },
    async evaluate(s, interviewId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(interviewId)) return NOT_FOUND;
      const input = parseEvaluation(fields(body));
      if (!input) return BAD;
      const r = await p.store.evaluate(id, interviewId.toLowerCase(), input);
      if (r.kind === "evaluated") return { status: 200, body: { interviewId: interviewId.toLowerCase(), version: r.version } };
      if (r.kind === "not_found") return NOT_FOUND;
      if (r.kind === "stale") return { status: 409, body: { error: "evaluation_changed", version: r.version } };
      return r.kind === "internal_note_refused" ? { status: 409, body: { error: "internal_note_refused" } } : { status: 409, body: { error: "interview_closed", status: r.status } };
    },
    async mine(s) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      return { status: 200, body: { interviews: (await p.store.mine(id)).map(personInterviewView) } };
    },
    async one(s, interviewId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(interviewId)) return NOT_FOUND;
      const row = (await p.store.mine(id)).find((candidate) => candidate.id === interviewId.toLowerCase());
      return row ? { status: 200, body: { interview: personInterviewView(row) } } : NOT_FOUND;
    },
    ...(p.store.forOrganization ? { async organization(s: string | undefined, orgId: string, page: number): Promise<RecruitResult<OrganizationInterviewsBody>> {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const r = await p.store.forOrganization!(id, orgId, page);
      if (!r) return NOT_FOUND;
      return { status: 200, body: { company: r.org_name, page: r.page, more: r.more, interviews: r.interviews.map((row) => ({
        interviewId: row.id, requestId: row.request_id, positionTitle: row.position_title, store: row.store_name, personName: row.person_name,
        kuwaitTime: kuwaitWallClock(row.scheduled_at), durationMinutes: row.duration_minutes, mode: row.mode, status: row.status, outcome: row.outcome,
      })) } };
    } } : {}),
  };
}

const MODE: Readonly<Record<InterviewMode, string>> = { in_person: "In person", phone: "Phone", video: "Video" };
const STATUS: Readonly<Record<InterviewStatus, string>> = { scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled" };
const OUTCOME: Readonly<Record<InterviewOutcome, string>> = { passed: "Passed", not_passed: "Not passed", no_show: "Did not attend" };

export function renderRequestInterviews(b: RequestInterviewsBody): string {
  const hidden = `<input type="hidden" name="requestId" value="${html(b.requestId)}">`;
  const item = (v: InterviewView) => {
    const facts = [`${v.kuwaitTime} (Kuwait)`, `${v.durationMinutes} min`, MODE[v.mode], v.location].filter((x): x is string => Boolean(x)).map(html).join(" · ");
    const evaluation = v.outcome ? `<p>${OUTCOME[v.outcome]}${v.rating ? ` · ${v.rating}/5` : ""}${v.evaluationVersion && v.evaluationVersion > 1 ? ` · corrected (version ${v.evaluationVersion})` : ""}</p>${v.sharedNote ? `<p style="white-space:pre-wrap">${html(v.sharedNote)}</p>` : ""}${v.internalNote ? `<p class="muted" style="white-space:pre-wrap">Internal: ${html(v.internalNote)}</p>` : ""}` : "";
    const actions = !b.canWrite || v.status === "cancelled" ? "" : `<details><summary>${v.status === "scheduled" ? "Record the evaluation" : "Correct the evaluation"}</summary><form method="post" action="/recruit/interviews/${html(v.interviewId)}/evaluate">${hidden}
<input type="hidden" name="version" value="${v.evaluationVersion ?? 0}">
<p><label for="o-${html(v.interviewId)}">Outcome</label> <select id="o-${html(v.interviewId)}" name="outcome" required>${(Object.keys(OUTCOME) as InterviewOutcome[]).map((o) => `<option value="${o}"${o === v.outcome ? " selected" : ""}>${OUTCOME[o]}</option>`).join("")}</select></p>
<p><label for="r-${html(v.interviewId)}">Rating (1 to 5, optional)</label> <input id="r-${html(v.interviewId)}" name="rating" inputmode="numeric" pattern="[1-5]" maxlength="1"${v.rating ? ` value="${v.rating}"` : ""}></p>
<p><label for="n-${html(v.interviewId)}">Note for the company</label><br><textarea id="n-${html(v.interviewId)}" name="sharedNote" maxlength="5000" rows="3">${html(v.sharedNote ?? "")}</textarea></p>
${b.seesInternal ? `<p><label for="i-${html(v.interviewId)}">Internal note (staff only)</label><br><textarea id="i-${html(v.interviewId)}" name="internalNote" maxlength="5000" rows="3">${html(v.internalNote ?? "")}</textarea></p>` : ""}
<button class="button primary" type="submit">Save evaluation</button></form></details>${v.status === "scheduled" ? `<form method="post" action="/recruit/interviews/${html(v.interviewId)}/cancel">${hidden}<button class="button" type="submit">Cancel the interview</button></form>` : ""}`;
    return `<li><h2>${html(v.personName ?? "Unnamed person")} <span class="badge">${STATUS[v.status]}</span></h2><p>${facts}</p>${v.scheduledBy ? `<p class="muted">Scheduled by ${html(v.scheduledBy)}</p>` : ""}${evaluation}${actions}</li>`;
  };
  const schedule = b.canWrite && b.cards.length ? `<h2>Schedule an interview</h2><form method="post" action="/recruit/requests/${html(b.requestId)}/interviews">${hidden}
<p><label for="cardId">Person</label> <select id="cardId" name="cardId" required>${b.cards.map((c) => `<option value="${html(c.cardId)}">${html(c.personName ?? "Unnamed person")}</option>`).join("")}</select></p>
<p><label for="scheduledAt">Date and time (Kuwait)</label> <input id="scheduledAt" name="scheduledAt" type="datetime-local" required></p>
<p><label for="durationMinutes">Minutes</label> <input id="durationMinutes" name="durationMinutes" inputmode="numeric" pattern="[0-9]{1,3}" value="30" maxlength="3"></p>
<p><label for="mode">How</label> <select id="mode" name="mode">${INTERVIEW_MODES.map((m) => `<option value="${m}">${MODE[m]}</option>`).join("")}</select></p>
<p><label for="location">Place or link (optional)</label> <input id="location" name="location" maxlength="500"></p>
<button class="button primary" type="submit">Schedule</button></form>` : b.canWrite ? "<p>People appear here once they are contacted, interviewing or offered.</p>" : "";
  return `<main id="main" class="profile-main"><h1>Interviews<span class="accent">.</span></h1><p>${html(b.positionTitle)} · ${html(b.company)} · ${html(b.store)}</p>${b.interviews.length ? `<ol class="plain">${b.interviews.map(item).join("")}</ol>` : "<p>No interviews yet.</p>"}${schedule}<p><a class="text-link" href="/recruit/requests/${html(b.requestId)}">Back to the request</a></p></main>`;
}

/** The table body of a company's interviews page (O-10). */
export function renderOrganizationInterviews(list: readonly OrganizationInterviewView[]): string {
  if (!list.length) return "";
  const row = (v: OrganizationInterviewView) => `<tr><th scope="row">${html(v.personName ?? "Unnamed person")}</th><td><a class="text-link" href="/recruit/requests/${html(encodeURIComponent(v.requestId))}/interviews">${html(v.positionTitle)}</a></td>`
    + `<td>${html(v.store)}</td><td>${html(`${v.kuwaitTime} (Kuwait)`)} · ${v.durationMinutes} min · ${MODE[v.mode]}</td><td>${STATUS[v.status]}</td><td>${v.outcome ? OUTCOME[v.outcome] : ""}</td></tr>`;
  return `<table><thead><tr><th>Person</th><th>Position</th><th>Store</th><th>When</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`;
}

export function renderMyInterviews(list: readonly PersonInterviewView[]): string {
  const item = (v: PersonInterviewView) => `<li><h2><a class="text-link" href="/recruit/interviews/${html(encodeURIComponent(v.interviewId))}">${html(v.positionTitle)}</a></h2><p>${html(v.company)} · ${html(v.store)} · <span class="badge">${STATUS[v.status]}</span></p><p>${[`${v.kuwaitTime} (Kuwait)`, `${v.durationMinutes} min`, MODE[v.mode], v.location].filter((x): x is string => Boolean(x)).map(html).join(" · ")}</p>${v.outcome ? `<p>${OUTCOME[v.outcome]}</p>` : ""}</li>`;
  return `<main id="main" class="profile-main"><h1>Interviews<span class="accent">.</span></h1>${list.length ? `<ol class="plain">${list.map(item).join("")}</ol>` : "<p>You have no interviews yet.</p>"}</main>`;
}

function renderInterviewDetail(v: PersonInterviewView): string {
  const facts = [`${v.kuwaitTime} (Kuwait)`, `${v.durationMinutes} min`, MODE[v.mode], v.location].filter((x): x is string => Boolean(x)).map(html).join(" · ");
  return `<main id="main" class="profile-main"><h1>${html(v.positionTitle)}</h1><p>${html(v.company)} · ${html(v.store)} · <span class="badge">${STATUS[v.status]}</span></p><p>${facts}</p>${v.outcome ? `<p>${OUTCOME[v.outcome]}</p>` : ""}<p><a class="text-link" href="/recruit/my-interviews">Back to my interviews</a></p></main>`;
}

const REQUEST = /^\/recruit\/requests\/([^/]+)\/interviews$/, ACTION = /^\/recruit\/interviews\/([^/]+)\/(cancel|evaluate)$/, DETAIL = /^\/recruit\/interviews\/([^/]+)$/, MINE = "/recruit/my-interviews";

export async function handleRecruitInterviews(req: IncomingMessage, res: ServerResponse, s: RecruitInterviews | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const request = REQUEST.exec(path), action = ACTION.exec(path), detail = DETAIL.exec(path);
  if (detail && req.method !== "GET" && req.method !== "HEAD") return false;
  if (path !== MINE && !request && !action && !detail) return false;
  const back = detail ? { href: MINE, label: "Back to my interviews" } : request ? { href: `/recruit/requests/${encodeURIComponent(decodeSegment(request))}`, label: "Back to the request" } : path === MINE ? { href: "/", label: "Back home" } : { href: "/recruit/requests", label: "Back to requests" };
  try {
    if (!s || !origin) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = sessionCookie(req.headers.cookie);
    if ((req.method === "GET" || req.method === "HEAD") && detail) {
      const r = await s.one(session, decodeSegment(detail));
      if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Interview", renderInterviewDetail(r.body.interview)); else errorPage(write, r.status, back);
      return true;
    }
    if (req.method === "GET" && (path === MINE || request)) {
      if (path === MINE) {
        const r = await s.mine(session);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Interviews", renderMyInterviews(r.body.interviews)); else errorPage(write, r.status, back);
      } else {
        const r = await s.forRequest(session, decodeSegment(request!));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Interviews", renderRequestInterviews(r.body)); else errorPage(write, r.status, back);
      }
      return true;
    }
    if (req.method !== "POST" || path === MINE) { sendJson(res, NOT_FOUND); return true; }
    if (!sameOrigin(req, origin)) { req.resume(); sendJson(res, { status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req, 16384);
    if (!body) { sendJson(res, BAD); return true; }
    let r: RecruitResult<unknown>, requestId: string | undefined;
    if (request) {
      requestId = decodeSegment(request);
      r = await s.schedule(session, requestId, body.value);
    } else {
      const formRequest = body.form ? (body.value as Record<string, string>).requestId : undefined;
      requestId = isRecruitId(formRequest) ? formRequest : undefined;
      r = action![2] === "cancel" ? await s.cancel(session, decodeSegment(action!)) : await s.evaluate(session, decodeSegment(action!), body.value);
    }
    const location = requestId && isRecruitId(requestId) ? `/recruit/requests/${requestId.toLowerCase()}/interviews` : "/recruit/requests";
    if (body.form) { if (r.status === 200) redirect(res, location); else errorPage(write, r.status, back); }
    else sendJson(res, r);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
