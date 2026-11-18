import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { OPEN_REQUEST_PAGE_SIZE, isRecruitId, openRequestView, parseOpenRequestQuery, type OpenRequestRow, type OpenRequestView, type RequestApplicationStatus } from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, isObject, readBody, redirect, sameOrigin, sendJson, sessionCookie, when, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R7b: applications to open requests (legacy RequestApplication).
//   GET  /recruit/open-requests                      open requests, ?q=, ?type=, ?applied=1 for "My applications", ?page=
//   GET  /recruit/open-requests/<id>                 one request
//   POST /recruit/open-requests/<id>/apply           {}
//   GET  /recruit/requests/<id>/applications         the request's applicants (company, recruiter, staff)
//   POST /recruit/request-applications/<id>/(accept|reject)

type DecideResult = { kind: "decided"; status: RequestApplicationStatus; cardId: string | null } | { kind: "not_found" } | { kind: "refused"; status: RequestApplicationStatus } | { kind: "request_not_open" } | { kind: "card_withdrawn" } | { kind: "person_unavailable" };
export interface RecruitRequestApplicationsStore {
  board(personId: string, query: { q: string | null; positionType: "full_time" | "part_time" | null; applied: boolean; page: number }): Promise<{ requests: readonly OpenRequestRow[]; total: number } | null>;
  openRequest(personId: string, requestId: string): Promise<OpenRequestRow | null>;
  apply(personId: string, requestId: string): Promise<{ kind: "applied"; applicationId: string } | { kind: "not_found" } | { kind: "request_not_open" } | { kind: "duplicate"; applicationId: string }>;
  forRequest(principalId: string, requestId: string): Promise<{ applications: readonly { id: string; person_principal_id: string; person_name: string | null; status: RequestApplicationStatus; created_at: string | Date; decided_at: string | Date | null; card_id: string | null }[]; canDecide: boolean } | null>;
  decide(principalId: string, applicationId: string, to: "accepted" | "rejected"): Promise<DecideResult>;
}
export interface RequestApplicantView { readonly applicationId: string; readonly personId: string; readonly personName: string | null; readonly status: RequestApplicationStatus; readonly appliedAt: string; readonly decidedAt: string | null; readonly cardId: string | null }
export interface RecruitRequestApplications {
  board(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<{ requests: readonly OpenRequestView[]; total: number; page: number; pageSize: number; q: string | null; type: string | null; applied: boolean }>>;
  request(session: string | undefined, requestId: string): Promise<RecruitResult<{ request: OpenRequestView }>>;
  apply(session: string | undefined, requestId: string, body: unknown): Promise<RecruitResult<{ applicationId: string; created: boolean }>>;
  forRequest(session: string | undefined, requestId: string): Promise<RecruitResult<{ requestId: string; applications: readonly RequestApplicantView[]; canDecide: boolean }>>;
  decide(session: string | undefined, applicationId: string, to: "accepted" | "rejected"): Promise<RecruitResult<{ applicationId: string; status: RequestApplicationStatus; cardId: string | null }>>;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

export function createRecruitRequestApplications(p: { sessions: Pick<SessionStore, "get">; store: RecruitRequestApplicationsStore }): RecruitRequestApplications {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async board(s, params) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const raw: Record<string, string | string[]> = {};
      for (const [k, v] of params) raw[k] = k in raw ? [raw[k] as string, v].flat() : v;
      const query = parseOpenRequestQuery(raw);
      if (!query) return BAD;
      const r = await p.store.board(id, query);
      if (!r) return NOT_FOUND; // the open-request board is for candidates, as the job board is
      return { status: 200, body: { requests: r.requests.map(openRequestView), total: r.total, page: query.page, pageSize: OPEN_REQUEST_PAGE_SIZE, q: query.q, type: query.positionType, applied: query.applied } };
    },
    async request(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const row = await p.store.openRequest(id, requestId.toLowerCase());
      return row ? { status: 200, body: { request: openRequestView(row) } } : NOT_FOUND;
    },
    async apply(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      if (!isObject(body) || Object.keys(body).length > 0) return BAD;
      const r = await p.store.apply(id, requestId.toLowerCase());
      if (r.kind === "applied") return { status: 200, body: { applicationId: r.applicationId, created: true } };
      if (r.kind === "duplicate") return { status: 200, body: { applicationId: r.applicationId, created: false } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: "request_not_open" } };
    },
    async forRequest(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const r = await p.store.forRequest(id, requestId.toLowerCase());
      if (!r) return NOT_FOUND;
      return { status: 200, body: { requestId: requestId.toLowerCase(), canDecide: r.canDecide, applications: r.applications.map((a) => ({ applicationId: a.id, personId: a.person_principal_id, personName: a.person_name, status: a.status, appliedAt: iso(a.created_at), decidedAt: a.decided_at ? iso(a.decided_at) : null, cardId: a.card_id })) } };
    },
    async decide(s, applicationId, to) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(applicationId)) return NOT_FOUND;
      const r = await p.store.decide(id, applicationId.toLowerCase(), to);
      if (r.kind === "decided") return { status: 200, body: { applicationId: applicationId.toLowerCase(), status: r.status, cardId: r.cardId } };
      if (r.kind === "not_found") return NOT_FOUND;
      return r.kind === "refused" ? { status: 409, body: { error: "application_decided", status: r.status } } : { status: 409, body: { error: r.kind } };
    },
  };
}

const STATUS: Readonly<Record<RequestApplicationStatus, string>> = { applied: "Applied", accepted: "Accepted", rejected: "Not selected" };
const TYPE: Readonly<Record<string, string>> = { full_time: "Full time", part_time: "Part time" };
const PAY: Readonly<Record<string, string>> = { hourly: "Hourly", fixed_price: "Fixed price", monthly_salary: "Monthly salary" };
const facts = (v: OpenRequestView) => [TYPE[v.positionType] ?? v.positionType, v.period ? `${v.period.start} to ${v.period.end}` : null, v.location].filter((x): x is string => Boolean(x)).map(html).join(" · ");
const pay = (v: OpenRequestView) => `Pay: ${html(v.pay)}${v.payModel ? ` (${html(PAY[v.payModel] ?? v.payModel)})` : ""}`;

export function renderOpenRequests(b: { requests: readonly OpenRequestView[]; total: number; page: number; pageSize: number; q: string | null; type: string | null; applied: boolean }): string {
  const qs = (page: number) => new URLSearchParams({ ...(b.q ? { q: b.q } : {}), ...(b.type ? { type: b.type } : {}), ...(b.applied ? { applied: "1" } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
  const item = (v: OpenRequestView) => `<li><h2><a class="text-link" href="/recruit/open-requests/${html(v.requestId)}">${html(v.positionTitle)}</a>${v.application ? ` <span class="badge">${STATUS[v.application.status]}</span>` : ""}</h2><p>${html(v.company)} · ${html(v.store)}</p><p>${facts(v)}</p></li>`;
  const pages = b.total > b.page * b.pageSize || b.page > 1 ? `<nav aria-label="Pages">${b.page > 1 ? `<a class="text-link" href="/recruit/open-requests?${html(qs(b.page - 1))}">Previous</a> ` : ""}${b.total > b.page * b.pageSize ? `<a class="text-link" href="/recruit/open-requests?${html(qs(b.page + 1))}">Next</a>` : ""}</nav>` : "";
  const types = `<select id="type" name="type"><option value="">Any type</option>${Object.entries(TYPE).map(([k, l]) => `<option value="${k}"${b.type === k ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  return `<main id="main" class="profile-main"><h1>${b.applied ? "My applications" : "Open positions"}<span class="accent">.</span></h1><p>${b.applied ? '<a class="text-link" href="/recruit/open-requests">Browse open positions</a>' : '<a class="text-link" href="/recruit/open-requests?applied=1">My applications</a>'} · <a class="text-link" href="/recruit/invitations">Invitations</a></p><form method="get" action="/recruit/open-requests" role="search">${b.applied ? '<input type="hidden" name="applied" value="1">' : ""}<label for="q">Search</label> <input id="q" name="q" maxlength="100" value="${html(b.q ?? "")}"> <label for="type">Type</label> ${types} <button class="button" type="submit">Search</button></form>${b.requests.length ? `<ol class="plain">${b.requests.map(item).join("")}</ol>` : `<p>${b.applied ? "You have not applied to a position yet." : "No open positions match right now."}</p>`}${pages}</main>`;
}

export function renderOpenRequest(v: OpenRequestView): string {
  const action = v.canApply ? `<form method="post" action="/recruit/open-requests/${html(v.requestId)}/apply"><button class="button primary" type="submit">Apply</button></form>`
    : v.application ? `<p><span class="badge">${STATUS[v.application.status]}</span></p>` : "<p>This position is not taking applications.</p>";
  return `<main id="main" class="profile-main"><h1>${html(v.positionTitle)}<span class="accent">.</span></h1><p>${html(v.company)} · ${html(v.store)}</p><p>${facts(v)}</p><p>${pay(v)}</p><p style="white-space:pre-wrap">${html(v.description)}</p><p class="muted">Posted <time datetime="${html(v.postedAt)}">${html(when(v.postedAt))}</time></p>${action}<p><a class="text-link" href="/recruit/open-requests">All open positions</a></p></main>`;
}

export function renderRequestApplicants(requestId: string, applications: readonly RequestApplicantView[], canDecide: boolean): string {
  const button = (a: RequestApplicantView, to: "accept" | "reject", label: string) => `<form method="post" action="/recruit/request-applications/${html(a.applicationId)}/${to}"><input type="hidden" name="requestId" value="${html(requestId)}"><button class="button${to === "accept" ? " primary" : ""}" type="submit">${label}</button></form>`;
  const rows = applications.map((a) => `<li>${html(a.personName ?? "Unnamed person")} · ${STATUS[a.status]} · <time datetime="${html(a.appliedAt)}">${html(when(a.appliedAt))}</time>${canDecide && a.status === "applied" ? ` ${button(a, "accept", "Accept")} ${button(a, "reject", "Reject")}` : ""}${a.status === "accepted" && a.cardId ? ` · <a class="text-link" href="/recruit/requests/${html(requestId)}/interviews">Interviews</a>` : ""}</li>`).join("");
  return `<main id="main" class="profile-main"><h1>Applicants<span class="accent">.</span></h1><p>Accepting an applicant adds them to this request's pipeline, where you can schedule an interview.</p>${rows ? `<ol>${rows}</ol>` : "<p>No one has applied yet.</p>"}<p><a class="text-link" href="/recruit/requests/${html(requestId)}">Back to the request</a></p></main>`;
}

const BOARD = "/recruit/open-requests", ONE = /^\/recruit\/open-requests\/([^/]+)$/, APPLY = /^\/recruit\/open-requests\/([^/]+)\/apply$/;
const APPLICANTS = /^\/recruit\/requests\/([^/]+)\/applications$/, DECIDE = /^\/recruit\/request-applications\/([^/]+)\/(accept|reject)$/;

export async function handleRecruitRequestApplications(req: IncomingMessage, res: ServerResponse, s: RecruitRequestApplications | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x"), path = url.pathname;
  const one = ONE.exec(path), apply = APPLY.exec(path), applicants = APPLICANTS.exec(path), decide = DECIDE.exec(path);
  if (path !== BOARD && !one && !apply && !applicants && !decide) return false;
  const back = applicants ? { href: `/recruit/requests/${encodeURIComponent(decodeSegment(applicants))}`, label: "Back to the request" } : { href: BOARD, label: "Back to open positions" };
  try {
    if (!s || !origin) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = sessionCookie(req.headers.cookie);
    if (req.method === "GET" && (path === BOARD || one || applicants)) {
      if (path === BOARD) {
        const r = await s.board(session, url.searchParams);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, r.body.applied ? "My applications" : "Open positions", renderOpenRequests(r.body)); else errorPage(write, r.status, back);
      } else if (one) {
        const r = await s.request(session, decodeSegment(one));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, r.body.request.positionTitle, renderOpenRequest(r.body.request)); else errorPage(write, r.status, back);
      } else {
        const r = await s.forRequest(session, decodeSegment(applicants!));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Applicants", renderRequestApplicants(r.body.requestId, r.body.applications, r.body.canDecide)); else errorPage(write, r.status, back);
      }
      return true;
    }
    if (req.method !== "POST" || path === BOARD || one || applicants) { sendJson(res, NOT_FOUND); return true; }
    if (!sameOrigin(req, origin)) { req.resume(); sendJson(res, { status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req, 4096);
    if (!body) { sendJson(res, BAD); return true; }
    let r: RecruitResult<unknown>, location: string;
    if (apply) {
      const requestId = decodeSegment(apply);
      r = await s.apply(session, requestId, body.value);
      location = `/recruit/open-requests/${encodeURIComponent(requestId)}`;
    } else {
      const requestId = body.form ? (body.value as Record<string, string>).requestId : undefined;
      r = await s.decide(session, decodeSegment(decide!), decide![2] === "accept" ? "accepted" : "rejected");
      location = isRecruitId(requestId) ? `/recruit/requests/${requestId.toLowerCase()}/applications` : BOARD;
    }
    if (body.form) { if (r.status === 200) redirect(res, location); else errorPage(write, r.status, back); }
    else sendJson(res, r);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
