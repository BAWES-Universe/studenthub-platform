// Staff work screens, per the screen navigation contract:
// - A-12 Work, /work/assignments: a company's placements and placement
//   requests; place a person, end or extend a placement, accept or reject a
//   request (staff CandidateController assign/unassign and the request
//   screens). The hours side of A-12, /work/logs, is in review-pages.ts.
// - A-13 Appeals and corrections: /work/appeals?as=staff lists appeals,
//   /work/appeals/:id shows staff the reply, status, correction and added-time
//   forms when the actor isn't the appellant, and /work/corrections corrects
//   one session (D-WK3: a reason is required and the original stays on record).
// The work services decide who is staff for which company on every request;
// these screens only render and post forms.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPEAL_STATUSES, kuwaitDate, parseAppealCursor, parsePlacementInput, parseRange,
  type AppealDetail, type Assignment, type AssignmentRequest, type WorkAppeal, type WorkSession,
} from "../../../../packages/work/src/index.js";
import { pageDocument } from "../web-ui.js";
import type { WorkHttpServices } from "./http.js";
import { clock, duration, esc, kuwaitInstant, longDate, notice, plain, readForm, redirect, sessionCookie, STATUS_LABEL, write } from "./pages.js";

const ORG_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPEAL_POST = /^\/work\/appeals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(reply|status|missing-time)$/;
const ASSIGNMENT_POST = /^\/work\/assignments\/(place|end|request)$/;

const APPEAL_STATUS: Readonly<Record<string, string>> = { submitted: "New", awaiting_review: "Waiting for review", in_progress: "In progress", resolved: "Resolved" };
const REQUEST_STATUS: Readonly<Record<string, string>> = { pending: "Waiting", accepted: "Placed", rejected: "Declined", cancelled: "Cancelled" };
const PLACED_BY: Readonly<Record<string, string>> = { staff: "placed by staff", request: "from a company request", recruit: "from recruitment", import: "from the old system" };
const WARNINGS: Readonly<Record<string, string>> = {
  civil_id_missing: "No civil ID on file", civil_id_expires_before_start: "Civil ID expires before the start date", no_pay_contract: "No pay contract matched",
};
const REFUSALS: Readonly<Record<string, string>> = {
  invalid_input: "Check the form and try again.",
  forbidden: "You can't do that for this company.",
  store_not_found: "That store doesn't exist.",
  store_removed: "That store has been removed.",
  person_not_found: "We couldn't find that person.",
  overlaps_assignment: "The person is already placed somewhere for part of those dates.",
  ambiguous_contract: "More than one pay contract matches. Choose the contract.",
  contract_not_applicable: "That pay contract doesn't apply to this placement.",
  end_before_start: "The end must be after the start.",
  open_session: "The person is clocked in there. They need to clock out before the placement ends.",
  assignment_not_found: "That placement no longer exists.",
  request_not_found: "That request no longer exists.",
  request_not_pending: "That request was already answered.",
  session_not_found: "Those hours no longer exist, or aren't in a company you look after.",
  session_open: "Hours still in progress can't be corrected.",
  session_replaced: "Those hours were already corrected. Correct the newer entry instead.",
  appeal_not_found: "That appeal doesn't match these hours.",
  outside_assignment: "The person wasn't placed there on that date.",
  overlaps_session: "Those times overlap other hours of the person.",
  in_future: "Hours can't be in the future.",
};
const DONE: Readonly<Record<string, string>> = {
  placed: "The person was placed.", ended: "The placement end date was saved.", extended: "The placement end date was saved.", unchanged: "Nothing changed.",
  accepted: "The request was accepted and the person placed.", rejected: "The request was declined.",
  posted: "Your reply was sent.", updated: "The appeal status was saved.", entered: "The hours were saved and approved.",
};

function staffShell(title: string, current: "assignments" | "logs" | "appeals", body: string): string {
  const tab = (path: string, key: string, label: string) => `<a href="${path}"${key === current ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = `<nav class="p-card" aria-label="Staff work">${tab("/work/assignments", "assignments", "Placements")} · ${tab("/work/logs", "logs", "Work logs")} · ${tab("/work/appeals?as=staff", "appeals", "Appeals")}</nav>`;
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${nav}${body}</div></div></main>`);
}
const message = (m: { kind: "success" | "error"; text: string } | null) => m ? notice(m.kind, m.text) : "";
const refusal = (code: string) => ({ kind: "error" as const, text: REFUSALS[code] ?? REFUSALS.invalid_input! });
const sessionTime = (s: WorkSession) => `${longDate(s.workDate)}, ${clock(s.startedAt)} to ${s.endedAt ? `${clock(s.endedAt)} (${duration(s.durationSeconds ?? 0)})` : "now"}`;
const shortDate = (iso: string) => longDate(kuwaitDate(new Date(iso)));
/** A Kuwait wall time for a `datetime-local` field. */
/** Keeps the seconds, so an untouched time is submitted unchanged. */
const localValue = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 19);

async function names(services: WorkHttpServices, ids: Iterable<string>): Promise<ReadonlyMap<string, string>> {
  const list = [...new Set(ids)];
  return list.length && services.personNames ? services.personNames(list) : new Map();
}

/** Success messages for the staff appeal screen, which pages.ts renders when the actor isn't the appellant. */
export function staffDone(done: string | null): { kind: "success"; text: string } | null {
  return done && DONE[done] ? { kind: "success", text: DONE[done]! } : null;
}

/** A-12 placements for one company; `undefined` when the actor isn't staff or the company there. */
export async function renderAssignments(services: WorkHttpServices, actor: string, orgId: string | null, m: { kind: "success" | "error"; text: string } | null): Promise<string | undefined> {
  const pick = `<form method="get" action="/work/assignments" class="p-card" aria-label="Company"><label>Company ID<input name="org" value="${esc(orgId ?? "")}" required maxlength="256"></label><button type="submit">Open</button></form>`;
  if (orgId === null) return staffShell("Placements", "assignments", `${message(m)}${pick}<section class="p-card"><div class="p-empty"><p>Open a company to see its placements and requests.</p></div></section>`);
  const [placements, requests] = await Promise.all([services.placements.forOrganization(actor, orgId), services.placements.requestsFor(actor, orgId, { status: "pending" })]);
  if (!placements || !requests) return undefined;
  const [people, stores, storeList] = await Promise.all([
    names(services, [...placements.map((a) => a.personId), ...requests.map((r) => r.personId)]),
    services.storeNames ? services.storeNames([...new Set([...placements.map((a) => a.storeId), ...requests.map((r) => r.storeId)])]) : new Map<string, string>(),
    services.storesOf ? services.storesOf(orgId) : Promise.resolve(null),
  ]);
  const today = kuwaitDate(new Date());
  const hidden = `<input type="hidden" name="org" value="${esc(orgId)}">`;
  const person = (id: string) => esc(people.get(id) ?? id);
  const store = (id: string) => esc(stores.get(id) ?? "A store");
  const placementItem = (a: Assignment) => {
    const warnings = a.warnings.map((w) => WARNINGS[w] ?? w);
    const state = a.endDate !== null && a.endDate < today ? "Ended" : a.startDate > today ? "Starts later" : "Current";
    return `<li class="p-card"><h3>${person(a.personId)}</h3><p>${store(a.storeId)} · ${esc(longDate(a.startDate))} to ${a.endDate ? esc(longDate(a.endDate)) : "no end date"} · <strong>${state}</strong> · ${esc(PLACED_BY[a.source] ?? a.source)}</p>${warnings.length ? `<p>Check: ${esc(warnings.join("; "))}</p>` : ""}
<form method="post" action="/work/assignments/end">${hidden}<input type="hidden" name="assignmentId" value="${a.id}"><label>End date<input type="date" name="endDate" value="${a.endDate ?? ""}"></label><button type="submit">Save end date</button></form></li>`;
  };
  const requestItem = (r: AssignmentRequest) => `<li class="p-card"><h3>${person(r.personId)}</h3><p>${store(r.storeId)} · asked ${esc(shortDate(r.requestedAt))} · ${esc(REQUEST_STATUS[r.status] ?? r.status)}</p>${r.note ? `<p>Their note: ${esc(r.note)}</p>` : ""}
<form method="post" action="/work/assignments/request">${hidden}<input type="hidden" name="requestId" value="${r.id}"><label>Start date (optional)<input type="date" name="startDate"></label><label>Pay contract ID (only when more than one matches)<input name="payContractId" maxlength="36"></label><label>Reason (optional)<input name="reason" maxlength="500"></label><button type="submit" name="decision" value="accept">Accept and place</button> <button type="submit" name="decision" value="reject">Decline</button></form></li>`;
  const storeField = storeList ? `<label>Store<select name="storeId" required>${storeList.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label>` : `<label>Store ID<input name="storeId" required maxlength="36"></label>`;
  const place = `<section class="p-card" aria-labelledby="place-heading"><h2 id="place-heading">Place a person</h2><form method="post" action="/work/assignments/place">${hidden}<label>Their StudentHub ID<input name="personId" required maxlength="256"></label>${storeField}
<label>Start date<input type="date" name="startDate" required></label><label>End date (optional)<input type="date" name="endDate"></label><label>Pay contract ID (only when more than one matches)<input name="payContractId" maxlength="36"></label><button type="submit">Place</button></form></section>`;
  const list = (title: string, id: string, items: string[], empty: string) => `<section class="p-card" aria-labelledby="${id}"><h2 id="${id}">${title}</h2>${items.length ? `<ul class="p-stack">${items.join("")}</ul>` : `<div class="p-empty"><p>${empty}</p></div>`}</section>`;
  return staffShell("Placements", "assignments", `${message(m)}${pick}${list("Requests waiting", "requests-heading", requests.map(requestItem), "No requests are waiting.")}${place}${list("Placements", "placements-heading", placements.map(placementItem), "Nobody is placed at this company.")}`);
}

/** A-13 list; `undefined` when the actor isn't staff. */
export async function renderStaffAppeals(services: WorkHttpServices, actor: string, query: URLSearchParams): Promise<string | undefined> {
  const status = query.get("status") ?? "", after = parseAppealCursor(query.get("after")), org = query.get("org")?.trim() || "";
  if (after === undefined || (org !== "" && !ORG_ID.test(org))) return undefined;
  // Staff of one company list that company's appeals; operator staff may leave the company out.
  const list = await services.appeals.list(actor, { status, after, ...(org ? { orgId: org } : {}) });
  if (!Array.isArray(list)) return undefined;
  const appeals = list as readonly WorkAppeal[];
  const people = await names(services, appeals.map((a) => a.personId));
  const option = (value: string, label: string) => `<option value="${value}"${status === value ? " selected" : ""}>${label}</option>`;
  const filter = `<form method="get" action="/work/appeals" class="p-card" aria-label="Filter"><input type="hidden" name="as" value="staff"><label>Company ID (optional)<input name="org" value="${esc(org)}" maxlength="256"></label><label>Status<select name="status">${option("", "All")}${APPEAL_STATUSES.map((s) => option(s, APPEAL_STATUS[s]!)).join("")}</select></label><button type="submit">Show</button></form>`;
  const items = appeals.length === 0 ? `<div class="p-empty"><p>No appeals match.</p></div>`
    : `<ul>${appeals.map((a) => `<li><a href="/work/appeals/${a.id}">${esc(people.get(a.personId) ?? a.personId)}</a>, raised ${esc(shortDate(a.createdAt))}: <strong>${esc(APPEAL_STATUS[a.status] ?? a.status)}</strong>. ${esc(a.reason.length > 120 ? `${a.reason.slice(0, 119)}…` : a.reason)}</li>`).join("")}</ul>`;
  const last = appeals[appeals.length - 1];
  const older = appeals.length === 50 && last ? `<p><a href="/work/appeals?as=staff&amp;status=${encodeURIComponent(status)}${org ? `&amp;org=${encodeURIComponent(org)}` : ""}&amp;after=${encodeURIComponent(`${last.createdAt}~${last.id}`)}">Older appeals</a></p>` : "";
  return staffShell("Appeals", "appeals", `${filter}<section class="p-card">${items}${older}</section>`);
}

/** A-13 detail for staff; the service has already checked the actor may see this appeal. */
export async function renderStaffAppeal(services: WorkHttpServices, detail: AppealDetail, m: { kind: "success" | "error"; text: string } | null): Promise<string> {
  const { appeal, session, updates, entries } = detail;
  const people = await names(services, [appeal.personId, ...updates.map((u) => u.authorId).filter((id): id is string => id !== null)]);
  const where = services.storeNames ? (await services.storeNames([session.storeId])).get(session.storeId) ?? "A store" : "A store";
  const base = `/work/appeals/${appeal.id}`;
  const head = `<section class="p-card"><h2>${esc(people.get(appeal.personId) ?? appeal.personId)}: ${esc(APPEAL_STATUS[appeal.status] ?? appeal.status)}</h2><p>Raised ${esc(shortDate(appeal.createdAt))} about ${esc(sessionTime(session))} at ${esc(where)} (${esc(STATUS_LABEL[session.status] ?? session.status)}).</p><p>Their reason: ${esc(appeal.reason)}</p></section>`;
  const done = entries.length ? `<section class="p-card"><h2>Changes made</h2><ul>${entries.map((e) => `<li>${e.source === "correction" ? "Corrected to" : "Added"} ${esc(sessionTime(e))}</li>`).join("")}</ul></section>` : "";
  const replies = updates.length === 0 ? `<div class="p-empty"><p>No replies yet.</p></div>`
    : `<ul class="p-stack">${updates.map((u) => `<li class="p-card">${u.title ? `<h3>${esc(u.title)}</h3>` : ""}<p>${esc(u.detail)}</p><p>${esc(shortDate(u.createdAt))}${u.authorId ? ` · ${esc(people.get(u.authorId) ?? "Staff")}` : ""}${u.readAt ? " · Read" : ""}</p></li>`).join("")}</ul>`;
  const reply = `<form method="post" action="${base}/reply"><label>Title (optional)<input name="title" maxlength="255"></label><label>Reply to the person<textarea name="detail" required maxlength="5000"></textarea></label><button type="submit">Send reply</button></form>`;
  const status = `<form method="post" action="${base}/status"><label>Status<select name="status">${APPEAL_STATUSES.map((s) => `<option value="${s}"${s === appeal.status ? " selected" : ""}>${APPEAL_STATUS[s]}</option>`).join("")}</select></label><button type="submit">Save status</button></form>`;
  const times = (start: string, end: string) => `<label>Started<input type="datetime-local" step="1" name="startedAt" value="${start}" required></label><label>Ended<input type="datetime-local" step="1" name="endedAt" value="${end}" required></label><label>Reason (required)<input name="reason" required maxlength="255"></label><label>Note (optional)<textarea name="note" maxlength="1000"></textarea></label>`;
  const fixes = session.endedAt === null ? "" : `<section class="p-card" aria-labelledby="fix-heading"><h2 id="fix-heading">Fix the hours</h2><p>Times are Kuwait time. A correction replaces the appealed entry in every total and in pay; the original stays on record. Both are approved by you.</p>
<form method="post" action="/work/corrections"><input type="hidden" name="sessionId" value="${session.id}"><input type="hidden" name="appealId" value="${appeal.id}">${times(localValue(session.startedAt), localValue(session.endedAt))}<button type="submit">Correct these hours</button></form>
<form method="post" action="${base}/missing-time">${times("", "")}<button type="submit">Add missing time</button></form></section>`;
  return staffShell("Appeal", "appeals", `${message(m)}${head}${done}<section class="p-card" aria-labelledby="replies-heading"><h2 id="replies-heading">Replies</h2>${replies}${reply}${status}</section>${fixes}<nav class="p-card"><a href="/work/appeals?as=staff">All appeals</a></nav>`);
}

/** A-13 correction form for one session; `undefined` when the actor can't see it or it can't be corrected. */
export async function renderCorrection(services: WorkHttpServices, actor: string, sessionId: string, date: string, m: { kind: "success" | "error"; text: string } | null): Promise<string | undefined> {
  const range = parseRange(date, date);
  if (!range || !UUID.test(sessionId)) return undefined;
  let after = null;
  for (let pages = 0; pages < 20; pages++) {
    const page = await services.views.all(actor, range, { after });
    if ("kind" in page) return undefined;
    const row = page.rows.find((r) => r.session.id === sessionId);
    if (row) {
      const s = row.session;
      if (s.endedAt === null) return undefined;
      const who = (await names(services, [s.personId])).get(s.personId) ?? s.personId;
      return staffShell("Correct hours", "logs", `${message(m)}<section class="p-card"><h2>${esc(who)}</h2><p>${esc(sessionTime(s))} · ${esc(STATUS_LABEL[s.status] ?? s.status)}</p><p>Times are Kuwait time. The correction replaces this entry in every total and in pay, approved by you; the original stays on record.</p>
<form method="post" action="/work/corrections"><input type="hidden" name="sessionId" value="${s.id}"><input type="hidden" name="date" value="${date}"><label>Started<input type="datetime-local" step="1" name="startedAt" value="${localValue(s.startedAt)}" required></label><label>Ended<input type="datetime-local" step="1" name="endedAt" value="${localValue(s.endedAt)}" required></label>
<label>Reason (required)<input name="reason" required maxlength="255"></label><label>Note (optional)<textarea name="note" maxlength="1000"></textarea></label><button type="submit">Save correction</button></form></section>`);
    }
    if (!page.next) return undefined;
    after = page.next;
  }
  return undefined;
}

/**
 * Staff screens under /work/assignments, /work/corrections and the staff side
 * of /work/appeals (`?as=staff` and the appeal forms). Returns false for other
 * paths; the person's /work/appeals screens stay in pages.ts.
 */
export async function handleStaffPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const path = url.pathname;
  const assignments = path === "/work/assignments" || ASSIGNMENT_POST.test(path);
  const corrections = path === "/work/corrections" || path === "/work/corrections/new";
  const appealList = path === "/work/appeals" && url.searchParams.get("as") === "staff";
  const appealPost = APPEAL_POST.exec(path);
  if (!assignments && !corrections && !appealList && !appealPost) return false;
  try {
    if (!services || !origin) { req.resume(); write(res, ...plain(503, "Work is unavailable", "Hours tracking isn't switched on here yet.")); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, "Sign in", "Sign in to continue.")); return true; }
    const denied = () => write(res, ...plain(403, "Staff only", "This page is for StudentHub staff who look after this company."));
    const done = url.searchParams.get("done");
    const doneMessage = done && DONE[done] ? { kind: "success" as const, text: DONE[done]! } : null;

    if (req.method === "GET") {
      if (path === "/work/assignments") {
        const org = url.searchParams.get("org")?.trim() || null;
        if (org !== null && !ORG_ID.test(org)) { write(res, ...plain(400, "Company not valid", "Check the company ID.")); return true; }
        const html = await renderAssignments(services, actor, org, doneMessage);
        if (html) write(res, 200, html); else denied();
        return true;
      }
      if (appealList) {
        const org = url.searchParams.get("org")?.trim() ?? "";
        if (parseAppealCursor(url.searchParams.get("after")) === undefined || (org !== "" && !ORG_ID.test(org))) { write(res, ...plain(400, "Page not found", "That list page isn't valid.")); return true; }
        const html = await renderStaffAppeals(services, actor, url.searchParams);
        if (html) write(res, 200, html); else denied();
        return true;
      }
      if (path === "/work/corrections/new") {
        const html = await renderCorrection(services, actor, url.searchParams.get("session")?.toLowerCase() ?? "", url.searchParams.get("date") ?? "", null);
        if (html) write(res, 200, html); else write(res, ...plain(404, "Hours not found", "Open the hours from Work logs and choose \"Correct these hours\"."));
        return true;
      }
      if (path === "/work/corrections" && done && DONE[done]) {
        write(res, 200, staffShell("Correct hours", "logs", `${notice("success", DONE[done]!)}<nav class="p-card"><a href="/work/logs">Back to work logs</a></nav>`));
        return true;
      }
    }
    if (req.method !== "POST" || appealList || path === "/work/corrections/new" || path === "/work/assignments") { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, "Request refused", "We could not verify this request.")); return true; }

    if (assignments) {
      const action = ASSIGNMENT_POST.exec(path)![1]!;
      const form = await readForm(req, action === "place" ? ["org", "personId", "storeId", "startDate", "endDate", "payContractId"]
        : action === "end" ? ["org", "assignmentId", "endDate"] : ["org", "requestId", "decision", "startDate", "payContractId", "reason"]);
      const org = form?.org?.trim() ?? "";
      if (!form || !ORG_ID.test(org)) { write(res, ...plain(400, "Not saved", "Open the company again and retry.")); return true; }
      let result: { kind: string; code?: string };
      if (action === "place") {
        const input = parsePlacementInput({
          personId: form.personId?.trim() ?? "", storeId: (form.storeId ?? "").trim(), startDate: form.startDate ?? "", endDate: form.endDate ? form.endDate : null,
          ...(form.payContractId?.trim() ? { payContractId: form.payContractId.trim() } : {}),
        });
        result = input ? await services.placements.place(actor, input) : { kind: "refused", code: "invalid_input" };
      } else if (action === "end") {
        result = await services.placements.setEndDate(actor, (form.assignmentId ?? "").toLowerCase(), form.endDate ? form.endDate : null);
      } else {
        const decision = form.decision, contract = form.payContractId?.trim().toLowerCase();
        const terms = { ...(form.startDate ? { startDate: form.startDate } : {}), ...(contract ? { payContractId: contract } : {}) };
        // The same checks as a new placement's terms, before the service runs.
        const valid = (!terms.startDate || parseRange(terms.startDate, terms.startDate)) && (!contract || UUID.test(contract));
        result = (decision === "accept" || decision === "reject") && valid
          ? await services.placements.decideRequest(actor, form.requestId ?? "", decision, { ...(form.reason ? { reason: form.reason } : {}), ...(decision === "accept" && Object.keys(terms).length ? { placement: terms } : {}) })
          : { kind: "refused", code: "invalid_input" };
      }
      if (result.kind !== "refused") { redirect(res, `/work/assignments?org=${encodeURIComponent(org)}&done=${result.kind}`); return true; }
      const html = await renderAssignments(services, actor, org, refusal(result.code ?? "invalid_input"));
      if (!html) { denied(); return true; }
      write(res, result.code === "forbidden" ? 403 : result.code && /overlaps|ambiguous|open_session|not_pending/.test(result.code) ? 409 : 400, html);
      return true;
    }

    if (corrections) {
      const form = await readForm(req, ["sessionId", "appealId", "date", "startedAt", "endedAt", "reason", "note"]);
      const sessionId = form?.sessionId?.toLowerCase() ?? "";
      const result = form ? await services.appeals.correct(actor, sessionId, {
        startedAt: kuwaitInstant(form.startedAt), endedAt: kuwaitInstant(form.endedAt), reason: form.reason, ...(form.note ? { note: form.note } : {}),
        ...(form.appealId ? { appealId: form.appealId } : {}),
      }) : { kind: "refused" as const, code: "invalid_input" as const };
      if (result.kind === "entered") {
        redirect(res, form?.appealId && UUID.test(form.appealId.toLowerCase()) ? `/work/appeals/${form.appealId.toLowerCase()}?done=entered` : "/work/corrections?done=entered");
        return true;
      }
      if (form?.appealId && UUID.test(form.appealId.toLowerCase())) {
        const detail = await services.appeals.detail(actor, form.appealId.toLowerCase());
        if (!("kind" in detail)) { write(res, result.code === "session_not_found" ? 404 : 400, await renderStaffAppeal(services, detail, refusal(result.code))); return true; }
      }
      const html = form?.date ? await renderCorrection(services, actor, sessionId, form.date, refusal(result.code)) : undefined;
      if (html) write(res, 400, html); else write(res, ...plain(result.code === "session_not_found" ? 404 : 400, "Not saved", REFUSALS[result.code] ?? REFUSALS.invalid_input!));
      return true;
    }

    const appealId = appealPost![1]!, action = appealPost![2]!;
    const form = await readForm(req, action === "reply" ? ["title", "detail"] : action === "status" ? ["status"] : ["startedAt", "endedAt", "reason", "note"]);
    let result: { kind: string; code?: string };
    if (!form) result = { kind: "refused", code: "invalid_input" };
    else if (action === "reply") result = await services.appeals.postUpdate(actor, appealId, { ...(form.title ? { title: form.title } : {}), detail: form.detail });
    else if (action === "status") result = await services.appeals.setStatus(actor, appealId, form.status);
    else result = await services.appeals.addMissing(actor, appealId, { startedAt: kuwaitInstant(form.startedAt), endedAt: kuwaitInstant(form.endedAt), reason: form.reason, ...(form.note ? { note: form.note } : {}) });
    if (result.kind !== "refused") { redirect(res, `/work/appeals/${appealId}?done=${result.kind}`); return true; }
    const detail = await services.appeals.detail(actor, appealId);
    if ("kind" in detail || detail.appeal.personId === actor) { write(res, ...plain(404, "Appeal not found", "This appeal doesn't exist or isn't in a company you look after.")); return true; }
    write(res, result.code === "forbidden" ? 403 : 400, await renderStaffAppeal(services, detail, refusal(result.code ?? "invalid_input")));
  } catch {
    if (!res.headersSent) write(res, ...plain(503, "Work is unavailable", "Something went wrong. Try again in a moment.")); else res.destroy();
  }
  return true;
}
