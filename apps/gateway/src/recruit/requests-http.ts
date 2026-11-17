import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  REQUEST_PAGE_SIZE, REQUEST_STATUSES, decodeRequestCursor, encodeRequestCursor, isRecruitId, parseRequestFields, parseRequestTransition,
  requestEventView, requestSummaryView, requestView,
  type CloseReason, type RequestCursor, type RequestEventRow, type RequestFields, type RequestRow, type RequestStatus,
  type RequestEventView, type RequestSummaryView, type RequestView,
} from "../../../../packages/recruit/src/index.js";

// Recruit R1: HTTP surface and pages for requests.
//   GET  /recruit/requests?org=<orgId>[&status=][&cursor=]   company list (JSON, or HTML for a browser)
//   GET  /recruit/staff/requests[?status=][&cursor=]          staff queue (JSON or HTML)
//   GET  /recruit/requests/new?org=<orgId>                    create form (HTML)
//   POST /recruit/requests/create                             JSON {orgId, request} or the form
//   GET  /recruit/requests/<id>                               one request with its activity (JSON or HTML)
//   POST /recruit/requests/<id>/transition                    JSON {to, closeReason?} or the form
// A refused caller, an unknown id and another company's request all answer the same 404.

export interface RecruitRequestsStore {
  stores(principalId: string, orgId: string): Promise<readonly { store_id: string; name: string }[] | null>;
  create(principalId: string, orgId: string, input: RequestFields): Promise<{ kind: "created"; requestId: string } | { kind: "not_found" }>;
  transition(principalId: string, requestId: string, to: RequestStatus, closeReason: CloseReason | null): Promise<{ kind: "transitioned"; status: RequestStatus } | { kind: "not_found" } | { kind: "refused"; status: RequestStatus }>;
  get(principalId: string, requestId: string): Promise<{ request: RequestRow; events: readonly RequestEventRow[]; canTransition: boolean; people?: readonly { person_principal_id: string; person_name: string | null; stage: string }[] } | null>;
  listCompany(principalId: string, orgId: string, query: { status?: RequestStatus; cursor?: RequestCursor; limit: number }): Promise<readonly RequestRow[] | null>;
  listStaff(principalId: string, query: { status?: RequestStatus; cursor?: RequestCursor; limit: number }): Promise<readonly RequestRow[] | null>;
}

export type RecruitPage = { readonly requests: readonly RequestSummaryView[]; readonly nextCursor: string | null; readonly status: RequestStatus | null };
export type RecruitResult<T> = { status: 200; body: T } | { status: 400 | 401 | 404 | 409 | 503; body: { error: string; status?: RequestStatus } };

export interface RecruitRequests {
  stores(session: string | undefined, orgId: string): Promise<RecruitResult<{ stores: readonly { storeId: string; name: string }[] }>>;
  create(session: string | undefined, body: unknown): Promise<RecruitResult<{ requestId: string }>>;
  transition(session: string | undefined, requestId: string, body: unknown): Promise<RecruitResult<{ requestId: string; status: RequestStatus }>>;
  get(session: string | undefined, requestId: string): Promise<RecruitResult<{ request: RequestView; activity: readonly RequestEventView[]; people: readonly { personId: string; name: string | null; stage: string }[] }>>;
  listCompany(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<RecruitPage & { orgId: string }>>;
  listStaff(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<RecruitPage>>;
}

const ORG = /^[A-Za-z0-9._:-]{1,256}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BAD = { status: 400 as const, body: { error: "invalid_request" } };
const UNAUTHORIZED = { status: 401 as const, body: { error: "unauthorized" } };
const NOT_FOUND = { status: 404 as const, body: { error: "not_found" } };

function pageQuery(params: URLSearchParams, allowed: readonly string[]): { status?: RequestStatus; cursor?: RequestCursor } | undefined {
  for (const key of new Set(params.keys())) if (!allowed.includes(key) || params.getAll(key).length !== 1) return undefined;
  const result: { status?: RequestStatus; cursor?: RequestCursor } = {};
  const status = params.get("status");
  if (status) {
    if (!(REQUEST_STATUSES as readonly string[]).includes(status)) return undefined;
    result.status = status as RequestStatus;
  }
  const cursor = params.get("cursor");
  if (cursor) {
    const decoded = decodeRequestCursor(cursor);
    if (!decoded) return undefined;
    result.cursor = decoded;
  }
  return result;
}

function page(rows: readonly RequestRow[], status: RequestStatus | undefined): RecruitPage {
  const shown = rows.slice(0, REQUEST_PAGE_SIZE), last = shown[shown.length - 1];
  return {
    requests: shown.map(requestSummaryView),
    nextCursor: rows.length > REQUEST_PAGE_SIZE && last ? encodeRequestCursor({ createdAt: last.cursor_at, id: last.id }) : null,
    status: status ?? null,
  };
}

export function createRecruitRequests(p: { sessions: Pick<SessionStore, "get">; store: RecruitRequestsStore }): RecruitRequests {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async stores(s, orgId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!ORG.test(orgId)) return BAD;
      const rows = await p.store.stores(id, orgId);
      return rows ? { status: 200, body: { stores: rows.map((row) => ({ storeId: row.store_id, name: row.name })) } } : NOT_FOUND;
    },
    async create(s, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!object(body) || Object.keys(body).sort().join() !== "orgId,request" || typeof body.orgId !== "string" || !ORG.test(body.orgId)) return BAD;
      const fields = parseRequestFields(body.request);
      if (!fields) return BAD;
      const r = await p.store.create(id, body.orgId, fields);
      return r.kind === "created" ? { status: 200, body: { requestId: r.requestId } } : NOT_FOUND;
    },
    async transition(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const input = parseRequestTransition(body);
      if (!input) return BAD;
      const r = await p.store.transition(id, requestId.toLowerCase(), input.to, input.closeReason);
      if (r.kind === "transitioned") return { status: 200, body: { requestId: requestId.toLowerCase(), status: r.status } };
      return r.kind === "refused" ? { status: 409, body: { error: "transition_not_allowed", status: r.status } } : NOT_FOUND;
    },
    async get(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const r = await p.store.get(id, requestId.toLowerCase());
      return r ? { status: 200, body: { request: requestView(r.request, r.canTransition), activity: r.events.map(requestEventView), people: (r.people ?? []).map((x) => ({ personId: x.person_principal_id, name: x.person_name, stage: x.stage })) } } : NOT_FOUND;
    },
    async listCompany(s, params) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const orgId = params.get("org");
      const query = pageQuery(params, ["org", "status", "cursor"]);
      if (!orgId || !ORG.test(orgId) || !query) return BAD;
      const rows = await p.store.listCompany(id, orgId, { ...query, limit: REQUEST_PAGE_SIZE + 1 });
      return rows ? { status: 200, body: { orgId, ...page(rows, query.status) } } : NOT_FOUND;
    },
    async listStaff(s, params) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const query = pageQuery(params, ["status", "cursor"]);
      if (!query) return BAD;
      const rows = await p.store.listStaff(id, { ...query, limit: REQUEST_PAGE_SIZE + 1 });
      return rows ? { status: 200, body: page(rows, query.status) } : NOT_FOUND;
    },
  };
}

// ---- Pages --------------------------------------------------------------

export type RecruitPageWriter = (status: number, title: string, body: string) => void;
export const html = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS_LABEL: Readonly<Record<RequestStatus, string>> = { draft: "Draft", open: "Open", filling: "Filling", filled: "Filled", closed: "Closed" };
const CLOSE_LABEL: Readonly<Record<CloseReason, string>> = { fulfilled: "fulfilled", cancelled: "cancelled" };
const statusText = (status: RequestStatus, reason: CloseReason | null) => reason ? `${STATUS_LABEL[status]} (${CLOSE_LABEL[reason]})` : STATUS_LABEL[status];
const when = (value: string) => new Date(value).toISOString().slice(0, 16).replace("T", " ");

export function renderRequestList(title: string, body: RecruitPage, base: string, extra: Record<string, string>, createHref?: string): string {
  const filters = ["", ...REQUEST_STATUSES].map((status) => {
    const href = `${base}?${new URLSearchParams({ ...extra, ...(status ? { status } : {}) })}`;
    const current = (body.status ?? "") === status;
    return `<a class="text-link"${current ? ' aria-current="page"' : ""} href="${html(href)}">${status ? STATUS_LABEL[status as RequestStatus] : "All"}</a>`;
  }).join(" · ");
  const rows = body.requests.map((r) => `<tr><td><a class="text-link" href="/recruit/requests/${html(r.requestId)}">${html(r.positionTitle)}</a></td><td>${html(r.organizationName)}</td><td>${html(r.storeName)}</td><td>${r.headcount}</td><td>${html(statusText(r.status, r.closeReason))}</td><td><time datetime="${html(r.lastChange)}">${html(when(r.lastChange))}</time></td></tr>`).join("");
  const next = body.nextCursor ? `<p><a class="text-link" href="${html(`${base}?${new URLSearchParams({ ...extra, ...(body.status ? { status: body.status } : {}), cursor: body.nextCursor })}`)}">Next page</a></p>` : "";
  return `<main id="main" class="profile-main"><h1>${html(title)}<span class="accent">.</span></h1>${createHref ? `<p><a class="button primary" href="${html(createHref)}">New request</a></p>` : ""}<nav aria-label="Filter by status"><p>${filters}</p></nav>${body.requests.length ? `<table><thead><tr><th scope="col">Role</th><th scope="col">Company</th><th scope="col">Store</th><th scope="col">People</th><th scope="col">Status</th><th scope="col">Last change</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No requests yet.</p>"}${next}</main>`;
}

const POSITION_LABEL = { full_time: "Full time", part_time: "Part time" } as const;
const PAY_LABEL = { hourly: "Hourly", fixed_price: "Fixed price", monthly_salary: "Monthly salary" } as const;
const GENDER_LABEL = { any: "Any", male: "Male", female: "Female", other: "Other" } as const;

const STAGE_LABEL: Readonly<Record<string, string>> = { suggested: "Suggested", contacted: "Contacted", interviewing: "Interviewing", offered: "Offered", placed: "Placed" };
export function renderRequestPage(body: { request: RequestView; activity: readonly RequestEventView[]; people?: readonly { personId: string; name: string | null; stage: string }[] }): string {
  const r = body.request;
  const row = (label: string, value: string) => `<div><dt>${html(label)}</dt><dd>${value}</dd></div>`;
  const facts = [
    row("Company", html(r.organizationName)), row("Store", html(r.storeName)), row("Status", html(statusText(r.status, r.closeReason))),
    row("People needed", String(r.headcount)), row("Position type", POSITION_LABEL[r.positionType]),
    row("Period", r.periodStart && r.periodEnd ? `${html(r.periodStart)} to ${html(r.periodEnd)}` : "Not set"),
    row("Pay model", r.payModel ? PAY_LABEL[r.payModel] : "Not set"), row("Compensation", html(r.compensationText)),
    row("Gender", GENDER_LABEL[r.gender]), row("Location", r.location ? html(r.location) : "Not set"), row("Priority", String(r.priority)),
    row("Recruiter assigned", r.assigned ? "Yes" : "No"), row("Description", `<span style="white-space:pre-wrap">${html(r.description)}</span>`),
  ].join("");
  const actions = r.allowedTransitions.map((to) => to === "closed"
    ? ["fulfilled", "cancelled"].map((reason) => `<form method="post" action="/recruit/requests/${html(r.requestId)}/transition"><input type="hidden" name="to" value="closed"><input type="hidden" name="closeReason" value="${reason}"><button class="button" type="submit">Close as ${reason}</button></form>`).join("")
    : `<form method="post" action="/recruit/requests/${html(r.requestId)}/transition"><input type="hidden" name="to" value="${to}"><button class="button" type="submit">Move to ${STATUS_LABEL[to]}</button></form>`).join("");
  const activity = body.activity.map((e) => `<li><time datetime="${html(e.at)}">${html(when(e.at))}</time>: ${e.from ? `${html(STATUS_LABEL[e.from])} → ` : "Created as "}${html(statusText(e.to, e.closeReason))}${e.actor ? ` by ${html(e.actor)}` : ""}</li>`).join("");
  return `<main id="main" class="profile-main"><h1>${html(r.positionTitle)}<span class="accent">.</span></h1><dl>${facts}</dl>${actions ? `<section aria-label="Change status">${actions}</section>` : ""}<section><h2>People</h2>${body.people?.length ? `<ul>${body.people.map((x) => `<li><a class="text-link" href="/recruit/requests/${html(r.requestId)}/people/${html(encodeURIComponent(x.personId))}">${html(x.name ?? "Unnamed person")}</a> · ${html(STAGE_LABEL[x.stage] ?? x.stage)}</li>`).join("")}</ul>` : "<p>No one has been suggested yet.</p>"}<p><a class="text-link" href="/recruit/requests/${html(r.requestId)}/interviews">Interviews</a></p></section><section><h2>Activity</h2><ol>${activity}</ol></section><p><a class="text-link" href="/recruit/requests?${html(new URLSearchParams({ org: r.orgId }).toString())}">All requests of this company</a></p></main>`;
}

export function renderRequestForm(orgId: string, stores: readonly { storeId: string; name: string }[], error?: string): string {
  const options = stores.map((s) => `<option value="${html(s.storeId)}">${html(s.name)}</option>`).join("");
  const select = (name: string, labels: Readonly<Record<string, string>>, blank = false) => `<select id="${name}" name="${name}">${blank ? '<option value="">Not set</option>' : ""}${Object.entries(labels).map(([v, l]) => `<option value="${v}">${html(l)}</option>`).join("")}</select>`;
  const field = (id: string, label: string, control: string) => `<p><label for="${id}">${html(label)}</label><br>${control}</p>`;
  return `<main id="main" class="profile-main"><h1>New request<span class="accent">.</span></h1>${error ? `<p role="alert">${html(error)}</p>` : ""}${stores.length ? `<form method="post" action="/recruit/requests/create"><input type="hidden" name="orgId" value="${html(orgId)}">
${field("storeId", "Store", `<select id="storeId" name="storeId" required>${options}</select>`)}
${field("positionTitle", "Role title", '<input id="positionTitle" name="positionTitle" required maxlength="255">')}
${field("headcount", "People needed", '<input id="headcount" name="headcount" type="number" min="1" max="10000" value="1" required>')}
${field("positionType", "Position type", select("positionType", POSITION_LABEL))}
${field("periodStart", "Start date", '<input id="periodStart" name="periodStart" type="date">')}
${field("periodEnd", "End date", '<input id="periodEnd" name="periodEnd" type="date">')}
${field("payModel", "Pay model", select("payModel", PAY_LABEL, true))}
${field("compensationText", "Compensation", '<textarea id="compensationText" name="compensationText" required maxlength="500"></textarea>')}
${field("gender", "Gender", select("gender", GENDER_LABEL))}
${field("location", "Location", '<input id="location" name="location" maxlength="500">')}
${field("priority", "Priority (0 to 10)", '<input id="priority" name="priority" type="number" min="0" max="10" value="0">')}
${field("description", "Description", '<textarea id="description" name="description" required maxlength="5000"></textarea>')}
<p><label><input type="checkbox" name="draft"> Save as a draft</label></p>
<button class="button primary" type="submit">Create request</button></form>` : "<p>This company has no stores yet. Add a store first.</p>"}<p><a class="text-link" href="/recruit/requests?${html(new URLSearchParams({ org: orgId }).toString())}">Back to requests</a></p></main>`;
}

// ---- Handler ------------------------------------------------------------

const LIST = "/recruit/requests", STAFF = "/recruit/staff/requests", NEW = "/recruit/requests/new", CREATE = "/recruit/requests/create";
const ONE = /^\/recruit\/requests\/([^/]+)$/, TRANSITION = /^\/recruit\/requests\/([^/]+)\/transition$/, LIMIT = 16384;
const FORM_FIELDS = ["orgId", "storeId", "positionTitle", "description", "compensationText", "positionType", "headcount", "periodStart", "periodEnd", "payModel", "gender", "location", "priority", "draft"];

function cookie(header: string | undefined) {
  for (const item of header?.split(";") ?? []) {
    const [k, ...v] = item.trim().split("=");
    if (k === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(v.join("="))) return v.join("=");
  }
}

async function readBody(req: IncomingMessage): Promise<{ kind: "json" | "form"; value: unknown } | undefined> {
  const type = req.headers["content-type"] ?? "";
  const kind = type === "application/json" ? "json" : type.startsWith("application/x-www-form-urlencoded") ? "form" : undefined;
  if (!kind || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const b = Buffer.from(c);
    if ((n += b.length) > LIMIT) { req.resume(); return undefined; }
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (kind === "json") { try { return { kind, value: JSON.parse(text) as unknown }; } catch { return undefined; } }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) { if (Object.hasOwn(out, key)) return undefined; out[key] = value; }
  return { kind, value: out };
}

/** The create form posts flat fields; the JSON API nests them under `request`. */
export function formToCreateBody(form: Record<string, string>): unknown {
  if (Object.keys(form).some((key) => !FORM_FIELDS.includes(key))) return undefined;
  const { orgId, ...rest } = form;
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) if (value !== "") request[key] = value;
  if (request.draft !== undefined) request.draft = request.draft === "on";
  return { orgId, request };
}

export async function handleRecruitRequests(
  req: IncomingMessage, res: ServerResponse, s: RecruitRequests | undefined, origin: string | undefined,
  write: RecruitPageWriter, wantsHtml: boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x"), path = url.pathname;
  const one = path === NEW || path === CREATE ? null : ONE.exec(path), transition = TRANSITION.exec(path);
  if (path !== LIST && path !== STAFF && path !== NEW && path !== CREATE && !one && !transition) return false;
  const send = (r: { status: number; body: unknown }) => {
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Accept" });
    res.end(JSON.stringify(r.body));
  };
  const pageError = (status: number) => write(status, "Requests", status === 401 ? "" : `<main id="main" class="error-page"><h1>${status === 404 ? "This request isn’t available to you." : status === 409 ? "That status change isn’t allowed any more." : status === 400 ? "Some details were missing or not valid." : "Requests are unavailable. Please try again in a moment."}</h1><p><a class="text-link" href="/workspace">Back to your workspace</a></p></main>`);
  const answer = (r: { status: number; body: unknown }, render: () => string, title: string) => {
    if (!wantsHtml) return send(r);
    if (r.status === 200) return write(200, title, render());
    pageError(r.status);
  };
  try {
    if (!s || !origin) { wantsHtml ? pageError(503) : send({ status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = cookie(req.headers.cookie);
    if (req.method === "GET") {
      if (path === LIST) {
        const r = await s.listCompany(session, url.searchParams);
        answer(r, () => { const b = (r as { body: RecruitPage & { orgId: string } }).body; return renderRequestList("Requests", b, LIST, { org: b.orgId }, `${NEW}?${new URLSearchParams({ org: b.orgId })}`); }, "Requests");
        return true;
      }
      if (path === STAFF) {
        const r = await s.listStaff(session, url.searchParams);
        answer(r, () => renderRequestList("All requests", (r as { body: RecruitPage }).body, STAFF, {}), "All requests");
        return true;
      }
      if (path === NEW) {
        const orgId = url.searchParams.get("org") ?? "";
        const r = await s.stores(session, orgId);
        if (r.status !== 200) { wantsHtml ? pageError(r.status) : send(r); return true; }
        wantsHtml ? write(200, "New request", renderRequestForm(orgId, r.body.stores)) : send(r);
        return true;
      }
      if (one) {
        let id: string;
        try { id = decodeURIComponent(one[1]!); } catch { wantsHtml ? pageError(404) : send({ status: 404, body: { error: "not_found" } }); return true; }
        const r = await s.get(session, id);
        answer(r, () => renderRequestPage((r as { body: { request: RequestView; activity: readonly RequestEventView[]; people: readonly { personId: string; name: string | null; stage: string }[] } }).body), r.status === 200 ? r.body.request.positionTitle : "Request");
        return true;
      }
      send({ status: 404, body: { error: "not_found" } });
      return true;
    }
    if (req.method !== "POST" || (path !== CREATE && !transition)) { send({ status: 404, body: { error: "not_found" } }); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); send({ status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req);
    if (!body) { send(BAD); return true; }
    const isForm = body.kind === "form";
    if (path === CREATE) {
      const payload = isForm ? formToCreateBody(body.value as Record<string, string>) : body.value;
      const r = await s.create(session, payload);
      if (isForm && r.status === 200) { res.writeHead(303, { location: `/recruit/requests/${r.body.requestId}`, "cache-control": "no-store" }); res.end(); return true; }
      if (isForm && r.status === 400 && object(payload) && typeof payload.orgId === "string") {
        const stores = await s.stores(session, payload.orgId);
        if (stores.status === 200) { write(400, "New request", renderRequestForm(payload.orgId, stores.body.stores, "Some details were missing or not valid. Check each field and try again.")); return true; }
      }
      isForm ? pageError(r.status) : send(r);
      return true;
    }
    let id: string;
    try { id = decodeURIComponent(transition![1]!); } catch { send({ status: 404, body: { error: "not_found" } }); return true; }
    const r = await s.transition(session, id, body.value);
    if (isForm && r.status === 200) { res.writeHead(303, { location: `/recruit/requests/${r.body.requestId}`, "cache-control": "no-store" }); res.end(); return true; }
    isForm ? pageError(r.status) : send(r);
  } catch {
    if (!res.headersSent) wantsHtml ? pageError(503) : send({ status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
