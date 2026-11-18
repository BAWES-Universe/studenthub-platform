import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { PIPELINE_STAGES, isRecruitId, parsePipelineStage, pipelineView, type PipelineCardRow, type PipelineCardView, type PipelineEventRow, type PipelineStage, type RequestStatus } from "../../../../packages/recruit/src/index.js";
import { html, type RecruitPageWriter } from "./requests-http.js";

// Recruit R2: the staff pipeline.
//   GET  /recruit/staff/requests/<id>          pipeline page (JSON or HTML)
//   POST /recruit/staff/requests/<id>/assign   {recruiterId}
//   POST /recruit/staff/requests/<id>/cards    {personId} or {fulltimerId}
//   POST /recruit/staff/cards/<id>/move        {to}
// Forms post the same fields urlencoded and are redirected back to the page.

export interface RecruitPipelineStore {
  assign(principalId: string, requestId: string, recruiterId: string): Promise<{ kind: "assigned" | "not_found" | "recruiter_ineligible" | "request_closed" }>;
  addCard(principalId: string, requestId: string, personId: string): Promise<{ kind: "added"; cardId: string } | { kind: "duplicate"; cardId: string } | { kind: "not_found" | "request_not_open" }>;
  addFulltimerCard(principalId: string, requestId: string, fulltimerId: string): Promise<{ kind: "added"; cardId: string } | { kind: "duplicate"; cardId: string } | { kind: "not_found" | "request_not_open" }>;
  move(principalId: string, cardId: string, to: PipelineStage): Promise<{ kind: "moved"; stage: PipelineStage } | { kind: "refused"; stage: PipelineStage } | { kind: "placement_refused"; code: string } | { kind: "subject_unavailable" } | { kind: "not_found" }>;
  view(principalId: string, requestId: string): Promise<{
    request: { id: string; org_name: string; store_name: string; position_title: string; headcount: number; status: RequestStatus; assigned_recruiter_principal_id: string | null; recruiter_name: string | null; assigned_at: string | Date | null };
    cards: readonly PipelineCardRow[]; events: readonly PipelineEventRow[]; canAssign: boolean; canMove: boolean; canPlacePeople: boolean; recruiters: readonly { principal_id: string; name: string | null }[];
  } | null>;
}

export interface PipelinePageBody {
  readonly request: { requestId: string; organizationName: string; storeName: string; positionTitle: string; headcount: number; status: RequestStatus; recruiter: { personId: string; name: string | null } | null; assignedAt: string | null };
  readonly stages: Readonly<Record<PipelineStage, readonly PipelineCardView[]>>;
  readonly canAssign: boolean;
  readonly canMove: boolean;
  readonly recruiters: readonly { personId: string; name: string | null }[];
}
type Err = { status: 400 | 401 | 404 | 409 | 503; body: { error: string; stage?: PipelineStage; code?: string } };
type Result<T> = { status: 200; body: T } | Err;

export interface RecruitPipeline {
  view(session: string | undefined, requestId: string): Promise<Result<PipelinePageBody>>;
  assign(session: string | undefined, requestId: string, body: unknown): Promise<Result<{ requestId: string; recruiterId: string }>>;
  addCard(session: string | undefined, requestId: string, body: unknown): Promise<Result<{ cardId: string; created: boolean }>>;
  move(session: string | undefined, cardId: string, body: unknown): Promise<Result<{ cardId: string; stage: PipelineStage }>>;
}

const PRINCIPAL = /^[A-Za-z0-9._:@-]{1,256}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, key: string) => Object.keys(v).length === 1 && typeof v[key] === "string";
const BAD: Err = { status: 400, body: { error: "invalid_request" } };
const UNAUTHORIZED: Err = { status: 401, body: { error: "unauthorized" } };
const NOT_FOUND: Err = { status: 404, body: { error: "not_found" } };
const iso = (v: string | Date | null) => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());

export function createRecruitPipeline(p: { sessions: Pick<SessionStore, "get">; store: RecruitPipelineStore }): RecruitPipeline {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async view(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const r = await p.store.view(id, requestId.toLowerCase());
      if (!r) return NOT_FOUND;
      return { status: 200, body: {
        request: { requestId: r.request.id, organizationName: r.request.org_name, storeName: r.request.store_name, positionTitle: r.request.position_title, headcount: r.request.headcount,
          status: r.request.status, recruiter: r.request.assigned_recruiter_principal_id ? { personId: r.request.assigned_recruiter_principal_id, name: r.request.recruiter_name } : null, assignedAt: iso(r.request.assigned_at) },
        stages: pipelineView(r.cards, r.events, r.canMove, { requestClosed: r.request.status === "closed", people: r.canPlacePeople }), canAssign: r.canAssign, canMove: r.canMove,
        recruiters: r.recruiters.map((x) => ({ personId: x.principal_id, name: x.name })),
      } };
    },
    async assign(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      if (!object(body) || !only(body, "recruiterId") || !PRINCIPAL.test(body.recruiterId as string)) return BAD;
      const r = await p.store.assign(id, requestId.toLowerCase(), body.recruiterId as string);
      if (r.kind === "assigned") return { status: 200, body: { requestId: requestId.toLowerCase(), recruiterId: body.recruiterId as string } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: r.kind } };
    },
    async addCard(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const fulltimer = object(body) && only(body, "fulltimerId");
      if (fulltimer ? !isRecruitId(body.fulltimerId as string) : !object(body) || !only(body, "personId") || !PRINCIPAL.test(body.personId as string)) return BAD;
      const subject = body as Record<string, string>;
      const r = fulltimer ? await p.store.addFulltimerCard(id, requestId.toLowerCase(), subject.fulltimerId!.toLowerCase()) : await p.store.addCard(id, requestId.toLowerCase(), subject.personId!);
      if (r.kind === "added" || r.kind === "duplicate") return { status: 200, body: { cardId: r.cardId, created: r.kind === "added" } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: r.kind } };
    },
    async move(s, cardId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(cardId)) return NOT_FOUND;
      if (!object(body) || !only(body, "to")) return BAD;
      const to = parsePipelineStage(body.to);
      if (!to) return BAD;
      const r = await p.store.move(id, cardId.toLowerCase(), to);
      if (r.kind === "moved") return { status: 200, body: { cardId: cardId.toLowerCase(), stage: r.stage } };
      if (r.kind === "refused") return { status: 409, body: { error: "move_not_allowed", stage: r.stage } };
      if (r.kind === "placement_refused") return { status: 409, body: { error: "placement_refused", code: r.code } };
      if (r.kind === "subject_unavailable") return { status: 409, body: { error: "subject_unavailable" } };
      return NOT_FOUND;
    },
  };
}

const STAGE_LABEL: Readonly<Record<PipelineStage, string>> = { suggested: "Suggested", contacted: "Contacted", interviewing: "Interviewing", offered: "Offered", placed: "Placed", withdrawn: "Withdrawn" };
const when = (value: string) => new Date(value).toISOString().slice(0, 16).replace("T", " ");

export function renderPipelinePage(body: PipelinePageBody): string {
  const r = body.request;
  const recruiter = r.recruiter ? html(r.recruiter.name ?? "Unnamed recruiter") : "No recruiter yet";
  const assign = body.canAssign && body.recruiters.length ? `<form method="post" action="/recruit/staff/requests/${html(r.requestId)}/assign"><label for="recruiterId">Recruiter</label> <select id="recruiterId" name="recruiterId">${body.recruiters.map((x) => `<option value="${html(x.personId)}"${x.personId === r.recruiter?.personId ? " selected" : ""}>${html(x.name ?? x.personId)}</option>`).join("")}</select> <button class="button" type="submit">Assign</button></form>` : "";
  const add = body.canMove && (r.status === "open" || r.status === "filling") ? `<form method="post" action="/recruit/staff/requests/${html(r.requestId)}/cards"><label for="personId">Add a person by id</label> <input id="personId" name="personId" required maxlength="256"> <button class="button" type="submit">Add</button></form><p><a class="text-link" href="/recruit/staff/fulltimers?request=${html(r.requestId)}">Suggest a full-timer</a></p>` : "";
  const columns = PIPELINE_STAGES.map((stage) => {
    const cards = body.stages[stage].map((card) => {
      const moves = card.allowedMoves.map((to) => `<form method="post" action="/recruit/staff/cards/${html(card.cardId)}/move"><input type="hidden" name="requestId" value="${html(r.requestId)}"><input type="hidden" name="to" value="${to}"><button class="button" type="submit">${html(STAGE_LABEL[to])}</button></form>`).join("");
      const history = card.history.map((h) => `<li><time datetime="${html(h.at)}">${html(when(h.at))}</time>: ${h.from ? `${html(STAGE_LABEL[h.from])} → ` : ""}${html(STAGE_LABEL[h.to])}${h.actor ? ` by ${html(h.actor)}` : ""}</li>`).join("");
      const name = html(card.personName ?? "Unnamed person");
      return `<li><strong>${card.fulltimerId ? `<a class="text-link" href="/recruit/staff/fulltimers/${html(card.fulltimerId)}">${name}</a> (full-timer)` : name}</strong>${moves ? `<div>${moves}</div>` : ""}<details><summary>History</summary><ol>${history}</ol></details></li>`;
    }).join("");
    return `<section><h2>${html(STAGE_LABEL[stage])} (${body.stages[stage].length})</h2>${cards ? `<ul>${cards}</ul>` : "<p>None.</p>"}</section>`;
  }).join("");
  return `<main id="main" class="profile-main"><h1>${html(r.positionTitle)}<span class="accent">.</span></h1><p>${html(r.organizationName)} · ${html(r.storeName)} · ${r.headcount} needed · ${html(r.status)}</p><p>Recruiter: ${recruiter}${r.assignedAt ? ` (first assigned ${html(when(r.assignedAt))})` : ""}</p>${assign}${add}${columns}<p><a class="text-link" href="/recruit/staff/requests/${html(r.requestId)}/notes">Notes and checklist</a> · <a class="text-link" href="/recruit/staff/requests/${html(r.requestId)}/invitations">Invitations</a> · <a class="text-link" href="/recruit/requests/${html(r.requestId)}/applications">Applicants</a> · <a class="text-link" href="/recruit/requests/${html(r.requestId)}/interviews">Interviews</a> · <a class="text-link" href="/recruit/staff/jobs?request=${html(r.requestId)}">Jobs</a> · <a class="text-link" href="/recruit/requests/${html(r.requestId)}">Request details and activity</a> · <a class="text-link" href="/recruit/staff/requests">All requests</a></p></main>`;
}

const VIEW = /^\/recruit\/staff\/requests\/([^/]+)$/, ASSIGN = /^\/recruit\/staff\/requests\/([^/]+)\/assign$/, CARDS = /^\/recruit\/staff\/requests\/([^/]+)\/cards$/, MOVE = /^\/recruit\/staff\/cards\/([^/]+)\/move$/, LIMIT = 4096;

function cookie(header: string | undefined) {
  for (const item of header?.split(";") ?? []) {
    const [k, ...v] = item.trim().split("=");
    if (k === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(v.join("="))) return v.join("=");
  }
}

async function readBody(req: IncomingMessage): Promise<{ form: boolean; value: unknown } | undefined> {
  const type = req.headers["content-type"] ?? "";
  const form = type.startsWith("application/x-www-form-urlencoded");
  if ((!form && type !== "application/json") || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const b = Buffer.from(c);
    if ((n += b.length) > LIMIT) { req.resume(); return undefined; }
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!form) { try { return { form, value: JSON.parse(text) as unknown }; } catch { return undefined; } }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) { if (Object.hasOwn(out, key)) return undefined; out[key] = value; }
  return { form, value: out };
}

export async function handleRecruitPipeline(req: IncomingMessage, res: ServerResponse, s: RecruitPipeline | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const view = VIEW.exec(path), assign = ASSIGN.exec(path), cards = CARDS.exec(path), move = MOVE.exec(path);
  if (!view && !assign && !cards && !move) return false;
  const send = (r: { status: number; body: unknown }) => {
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Accept" });
    res.end(JSON.stringify(r.body));
  };
  const pageError = (status: number) => write(status, "Pipeline", status === 401 ? "" : `<main id="main" class="error-page"><h1>${status === 404 ? "This request isn’t available to you." : status === 409 ? "That change isn’t allowed any more." : status === 400 ? "Some details were missing or not valid." : "The pipeline is unavailable. Please try again in a moment."}</h1><p><a class="text-link" href="/recruit/staff/requests">All requests</a></p></main>`);
  const id = (m: RegExpExecArray) => { try { return decodeURIComponent(m[1]!); } catch { return ""; } };
  try {
    if (!s || !origin) { wantsHtml ? pageError(503) : send({ status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = cookie(req.headers.cookie);
    if (view) {
      if (req.method !== "GET") { send(NOT_FOUND); return true; }
      const r = await s.view(session, id(view));
      if (!wantsHtml) send(r);
      else if (r.status === 200) write(200, r.body.request.positionTitle, renderPipelinePage(r.body));
      else pageError(r.status);
      return true;
    }
    if (req.method !== "POST") { send(NOT_FOUND); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); send({ status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req);
    if (!body) { send(BAD); return true; }
    let r: Result<unknown>, back: string | undefined;
    if (assign) { r = await s.assign(session, id(assign), body.value); back = id(assign); }
    else if (cards) { r = await s.addCard(session, id(cards), body.value); back = id(cards); }
    else {
      // The move form names its request so the browser returns to the same page.
      const { requestId, ...rest } = body.form ? body.value as Record<string, string> : { requestId: undefined };
      r = await s.move(session, id(move!), body.form ? rest : body.value);
      back = isRecruitId(requestId) ? requestId : undefined;
    }
    if (body.form && r.status === 200) {
      const location = back && isRecruitId(back) ? `/recruit/staff/requests/${back.toLowerCase()}` : "/recruit/staff/requests";
      res.writeHead(303, { location, "cache-control": "no-store" }); res.end(); return true;
    }
    body.form ? pageError(r.status) : send(r);
  } catch {
    if (!res.headersSent) wantsHtml ? pageError(503) : send({ status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
