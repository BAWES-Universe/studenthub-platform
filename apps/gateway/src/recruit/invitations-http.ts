import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { invitationView, isRecruitId, parseInvitationCreate, type InvitationRow, type InvitationStatus, type InvitationView } from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, readBody, redirect, sameOrigin, sendJson, sessionCookie, when, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R4: invitations.
//   GET  /recruit/invitations                          the person's invitations (JSON or HTML)
//   POST /recruit/invitations/<id>/(seen|accept|decline)
//   GET  /recruit/staff/requests/<id>/invitations      a request's invitations for staff
//   POST /recruit/staff/requests/<id>/invitations      {personId}
//   POST /recruit/staff/invitations/<id>/withdraw

type AnswerResult = { kind: "done"; status: InvitationStatus; cardId: string | null } | { kind: "not_found" } | { kind: "refused"; status: InvitationStatus } | { kind: "request_not_open" } | { kind: "card_withdrawn" };
export interface RecruitInvitationsStore {
  invite(principalId: string, requestId: string, personId: string): Promise<{ kind: "invited"; invitationId: string } | { kind: "not_found" } | { kind: "request_not_open" } | { kind: "duplicate"; invitationId: string }>;
  answer(principalId: string, invitationId: string, to: "seen" | "accepted" | "declined"): Promise<AnswerResult>;
  withdraw(principalId: string, invitationId: string): Promise<AnswerResult>;
  mine(principalId: string): Promise<readonly InvitationRow[]>;
  forRequest(principalId: string, requestId: string): Promise<readonly { id: string; person_principal_id: string; person_name: string | null; status: InvitationStatus; created_at: string | Date; answered_at: string | Date | null }[] | null>;
}
export interface RequestInvitationView { readonly invitationId: string; readonly personId: string; readonly personName: string | null; readonly status: InvitationStatus; readonly invitedAt: string; readonly answeredAt: string | null }
export interface RecruitInvitations {
  mine(session: string | undefined): Promise<RecruitResult<{ invitations: readonly InvitationView[] }>>;
  one(session: string | undefined, invitationId: string): Promise<RecruitResult<{ invitation: InvitationView }>>;
  answer(session: string | undefined, invitationId: string, to: "seen" | "accepted" | "declined"): Promise<RecruitResult<{ invitationId: string; status: InvitationStatus; cardId: string | null }>>;
  forRequest(session: string | undefined, requestId: string): Promise<RecruitResult<{ requestId: string; invitations: readonly RequestInvitationView[] }>>;
  invite(session: string | undefined, requestId: string, body: unknown): Promise<RecruitResult<{ invitationId: string; created: boolean }>>;
  withdraw(session: string | undefined, invitationId: string): Promise<RecruitResult<{ invitationId: string; status: InvitationStatus }>>;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();
function answered(r: AnswerResult, invitationId: string): RecruitResult<{ invitationId: string; status: InvitationStatus; cardId: string | null }> {
  if (r.kind === "done") return { status: 200, body: { invitationId, status: r.status, cardId: r.cardId } };
  if (r.kind === "not_found") return NOT_FOUND;
  if (r.kind === "refused") return { status: 409, body: { error: "invitation_closed", status: r.status } };
  return { status: 409, body: { error: r.kind } };
}

export function createRecruitInvitations(p: { sessions: Pick<SessionStore, "get">; store: RecruitInvitationsStore }): RecruitInvitations {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async mine(s) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      return { status: 200, body: { invitations: (await p.store.mine(id)).map(invitationView) } };
    },
    async one(s, invitationId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(invitationId)) return NOT_FOUND;
      const wanted = invitationId.toLowerCase();
      const row = (await p.store.mine(id)).find((candidate) => candidate.id.toLowerCase() === wanted);
      return row ? { status: 200, body: { invitation: invitationView(row) } } : NOT_FOUND;
    },
    async answer(s, invitationId, to) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(invitationId)) return NOT_FOUND;
      return answered(await p.store.answer(id, invitationId.toLowerCase(), to), invitationId.toLowerCase());
    },
    async forRequest(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const rows = await p.store.forRequest(id, requestId.toLowerCase());
      if (!rows) return NOT_FOUND;
      return { status: 200, body: { requestId: requestId.toLowerCase(), invitations: rows.map((r) => ({ invitationId: r.id, personId: r.person_principal_id, personName: r.person_name, status: r.status, invitedAt: iso(r.created_at), answeredAt: r.answered_at ? iso(r.answered_at) : null })) } };
    },
    async invite(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const fields = parseInvitationCreate(body);
      if (!fields) return BAD;
      const r = await p.store.invite(id, requestId.toLowerCase(), fields.personId);
      if (r.kind === "invited") return { status: 200, body: { invitationId: r.invitationId, created: true } };
      if (r.kind === "duplicate") return { status: 200, body: { invitationId: r.invitationId, created: false } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: r.kind } };
    },
    async withdraw(s, invitationId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(invitationId)) return NOT_FOUND;
      const r = answered(await p.store.withdraw(id, invitationId.toLowerCase()), invitationId.toLowerCase());
      return r.status === 200 ? { status: 200, body: { invitationId: r.body.invitationId, status: r.body.status } } : r;
    },
  };
}

const STATUS_LABEL: Readonly<Record<InvitationStatus, string>> = { sent: "New", seen: "Seen", accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn" };
const TYPE_LABEL: Readonly<Record<string, string>> = { full_time: "Full time", part_time: "Part time" };
const PAY_LABEL: Readonly<Record<string, string>> = { hourly: "Hourly", fixed_price: "Fixed price", monthly_salary: "Monthly salary" };

export function renderInvitations(invitations: readonly InvitationView[]): string {
  return `<main id="main" class="profile-main"><h1>Invitations<span class="accent">.</span></h1>${invitations.length ? `<ol class="plain">${invitations.map(renderInvitationItem).join("")}</ol>` : "<p>You have no invitations yet.</p>"}<p><a class="text-link" href="/recruit/my-interviews">Your interviews</a> · <a class="text-link" href="/recruit/open-requests">Open positions</a></p></main>`;
}

function renderInvitationItem(v: InvitationView): string {
  const answer = v.canAnswer ? `<form method="post" action="/recruit/invitations/${html(v.invitationId)}/accept"><button class="button primary" type="submit">Accept</button></form> <form method="post" action="/recruit/invitations/${html(v.invitationId)}/decline"><button class="button" type="submit">Decline</button></form>${v.status === "sent" ? ` <form method="post" action="/recruit/invitations/${html(v.invitationId)}/seen"><button class="button" type="submit">Mark as seen</button></form>` : ""}` : "";
  const facts = [TYPE_LABEL[v.positionType] ?? v.positionType, v.period ? `${v.period.start} to ${v.period.end}` : null, v.location].filter((x): x is string => Boolean(x));
  return `<li><h2>${html(v.positionTitle)}</h2><p>${html(v.company)} · ${html(v.store)} · <span class="badge">${STATUS_LABEL[v.status]}</span></p><p>${facts.map(html).join(" · ")}</p><p>Pay: ${html(v.pay)}${v.payModel ? ` (${html(PAY_LABEL[v.payModel] ?? v.payModel)})` : ""}</p><p class="muted">Invited <time datetime="${html(v.invitedAt)}">${html(when(v.invitedAt))}</time></p>${answer}</li>`;
}

export function renderInvitation(invitation: InvitationView): string {
  return `<main id="main" class="profile-main"><h1>Invitation<span class="accent">.</span></h1><ol class="plain">${renderInvitationItem(invitation)}</ol><p><a class="text-link" href="/recruit/invitations">Back to your invitations</a></p></main>`;
}

export function renderRequestInvitations(requestId: string, invitations: readonly RequestInvitationView[]): string {
  const rows = invitations.map((v) => `<li>${html(v.personName ?? "Unnamed person")} · ${STATUS_LABEL[v.status]} · <time datetime="${html(v.invitedAt)}">${html(when(v.invitedAt))}</time>${v.status === "sent" || v.status === "seen" ? ` <form method="post" action="/recruit/staff/invitations/${html(v.invitationId)}/withdraw"><input type="hidden" name="requestId" value="${html(requestId)}"><button class="button" type="submit">Withdraw</button></form>` : ""}</li>`).join("");
  return `<main id="main" class="profile-main"><h1>Invitations<span class="accent">.</span></h1>${rows ? `<ol>${rows}</ol>` : "<p>No one has been invited yet.</p>"}<h2>Invite someone</h2><form method="post" action="/recruit/staff/requests/${html(requestId)}/invitations"><p><label for="personId">Person</label> <input id="personId" name="personId" required maxlength="255"></p><button class="button primary" type="submit">Invite</button></form><p><a class="text-link" href="/recruit/staff/people">Find people</a> · <a class="text-link" href="/recruit/staff/requests/${html(requestId)}">Back to the pipeline</a></p></main>`;
}

const MINE = "/recruit/invitations";
const DETAIL = /^\/recruit\/invitations\/([^/]+)$/;
const ANSWER = /^\/recruit\/invitations\/([^/]+)\/(seen|accept|decline)$/, REQUEST = /^\/recruit\/staff\/requests\/([^/]+)\/invitations$/, WITHDRAW = /^\/recruit\/staff\/invitations\/([^/]+)\/withdraw$/;
const TO = { seen: "seen", accept: "accepted", decline: "declined" } as const;

export async function handleRecruitInvitations(req: IncomingMessage, res: ServerResponse, s: RecruitInvitations | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const detail = DETAIL.exec(path), answer = ANSWER.exec(path), request = REQUEST.exec(path), withdraw = WITHDRAW.exec(path);
  if (detail && req.method !== "GET" && req.method !== "HEAD") return false;
  if (path !== MINE && !detail && !answer && !request && !withdraw) return false;
  const back = request ? { href: `/recruit/staff/requests/${encodeURIComponent(decodeSegment(request))}`, label: "Back to the pipeline" } : { href: MINE, label: "Back to your invitations" };
  try {
    if (!s || !origin) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = sessionCookie(req.headers.cookie);
    if ((req.method === "GET" || req.method === "HEAD") && detail) {
      const r = await s.one(session, decodeSegment(detail));
      if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Invitation", renderInvitation(r.body.invitation)); else errorPage(write, r.status, back);
      return true;
    }
    if (req.method === "GET" && (path === MINE || request)) {
      if (path === MINE) {
        const r = await s.mine(session);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Invitations", renderInvitations(r.body.invitations)); else errorPage(write, r.status, back);
      } else {
        const r = await s.forRequest(session, decodeSegment(request!));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Invitations", renderRequestInvitations(r.body.requestId, r.body.invitations)); else errorPage(write, r.status, back);
      }
      return true;
    }
    if (req.method !== "POST" || path === MINE) { sendJson(res, NOT_FOUND); return true; }
    if (!sameOrigin(req, origin)) { req.resume(); sendJson(res, { status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req, 4096);
    if (!body) { sendJson(res, BAD); return true; }
    let r: RecruitResult<unknown>, location = MINE;
    if (answer) r = await s.answer(session, decodeSegment(answer), TO[answer[2] as keyof typeof TO]);
    else if (request) {
      const requestId = decodeSegment(request);
      r = await s.invite(session, requestId, body.value);
      location = `/recruit/staff/requests/${encodeURIComponent(requestId)}/invitations`;
    } else {
      const requestId = body.form ? (body.value as Record<string, string>).requestId : undefined;
      r = await s.withdraw(session, decodeSegment(withdraw!));
      location = isRecruitId(requestId) ? `/recruit/staff/requests/${requestId.toLowerCase()}/invitations` : "/recruit/staff/requests";
    }
    if (body.form) { if (r.status === 200) redirect(res, location); else errorPage(write, r.status, back); }
    else sendJson(res, r);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
