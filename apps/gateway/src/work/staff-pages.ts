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
import { docLanguage, esc, FORM_LIMITS, kuwaitInstant, notice, plain, readForm, redirect, sessionCookie, tooLarge, write } from "./pages.js";
import { WORK_COPY, workCopyFor, type WorkCopy } from "./copy.js";
import { teamCopy } from "./team-copy.js";

const ORG_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPEAL_POST = /^\/work\/appeals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(reply|status|missing-time)$/;
const ASSIGNMENT_POST = /^\/work\/assignments\/(place|end|request)$/;

/** The appeal list for staff, kept to one company when the staff member covers only that company. */
const appealList = (org?: string) => `/work/appeals?as=staff${org ? `&amp;org=${encodeURIComponent(org)}` : ""}`;

function staffShell(title: string, current: "assignments" | "logs" | "appeals", body: string, c: WorkCopy, org?: string): string {
  const t = teamCopy(c).staff;
  const tab = (path: string, key: string, label: string) => `<a href="${path}"${key === current ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const nav = `<nav class="p-card" aria-label="${esc(t.nav)}">${tab("/work/assignments", "assignments", t.placementsTab)} · ${tab("/work/logs", "logs", t.logsTab)} · ${tab(appealList(org), "appeals", t.appealsTab)}</nav>`;
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${nav}${body}</div></div></main>`, docLanguage(c));
}
const message = (m: { kind: "success" | "error"; text: string } | null) => m ? notice(m.kind, m.text) : "";
const refusal = (code: string, c: WorkCopy) => {
  const refusals = teamCopy(c).staff.refusals;
  return { kind: "error" as const, text: refusals[code] ?? refusals.invalid_input! };
};
const sessionTime = (s: WorkSession, c: WorkCopy) =>
  teamCopy(c).common.timeRange(c.longDate(s.workDate), c.clock(s.startedAt), s.endedAt ? c.clock(s.endedAt) : null, s.endedAt ? c.duration(s.durationSeconds ?? 0) : null);
const shortDate = (iso: string, c: WorkCopy) => c.longDate(kuwaitDate(new Date(iso)));
/** A Kuwait wall time for a `datetime-local` field. */
/** Keeps seconds and milliseconds (when present), so an untouched time is submitted unchanged. */
const localValue = (iso: string) => {
  const local = new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString();
  return local.endsWith(".000Z") ? local.slice(0, 19) : local.slice(0, 23);
};

async function names(services: WorkHttpServices, ids: Iterable<string>): Promise<ReadonlyMap<string, string>> {
  const list = [...new Set(ids)];
  return list.length && services.personNames ? services.personNames(list) : new Map();
}

/** Success messages for the staff appeal screen, which pages.ts renders when the actor isn't the appellant. */
export function staffDone(done: string | null, c: WorkCopy = WORK_COPY.en): { kind: "success"; text: string } | null {
  const words = teamCopy(c).staff.done;
  return done && words[done] ? { kind: "success", text: words[done]! } : null;
}

/** A-12 placements for one company; `undefined` when the actor isn't staff or the company there. */
export async function renderAssignments(services: WorkHttpServices, actor: string, orgId: string | null, m: { kind: "success" | "error"; text: string } | null, c: WorkCopy = WORK_COPY.en): Promise<string | undefined> {
  const t = teamCopy(c).staff;
  const pick = `<form method="get" action="/work/assignments" class="p-card" aria-label="${esc(t.companyLabel)}"><label>${esc(t.companyId)}<input name="org" value="${esc(orgId ?? "")}" required maxlength="256"></label><button type="submit">${esc(t.open)}</button></form>`;
  if (orgId === null) return staffShell(t.placementsTab, "assignments", `${message(m)}${pick}<section class="p-card"><div class="p-empty"><p>${esc(t.openCompany)}</p></div></section>`, c);
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
  const store = (id: string) => esc(stores.get(id) ?? t.aStore);
  const placementItem = (a: Assignment) => {
    const warnings = a.warnings.map((w) => t.warnings[w] ?? w);
    const state = a.endDate !== null && a.endDate < today ? t.stateEnded : a.startDate > today ? t.stateLater : t.stateCurrent;
    return `<li class="p-card"><h3>${person(a.personId)}</h3><p>${store(a.storeId)} · ${esc(t.period(c.longDate(a.startDate), a.endDate ? c.longDate(a.endDate) : null))} · <strong>${esc(state)}</strong> · ${esc(t.placedBy[a.source] ?? a.source)}</p>${warnings.length ? `<p>${esc(t.check(warnings.join(t.checkJoin)))}</p>` : ""}
<form method="post" action="/work/assignments/end">${hidden}<input type="hidden" name="assignmentId" value="${a.id}"><label>${esc(t.endDate)}<input type="date" name="endDate" value="${a.endDate ?? ""}"></label><button type="submit">${esc(t.saveEnd)}</button></form></li>`;
  };
  const requestItem = (r: AssignmentRequest) => `<li class="p-card"><h3>${person(r.personId)}</h3><p>${store(r.storeId)} · ${esc(t.asked(shortDate(r.requestedAt, c)))} · ${esc(t.requestStatus[r.status] ?? r.status)}</p>${r.note ? `<p>${esc(t.theirNote(r.note))}</p>` : ""}
<form method="post" action="/work/assignments/request">${hidden}<input type="hidden" name="requestId" value="${r.id}"><label>${esc(t.startOptional)}<input type="date" name="startDate"></label><label>${esc(t.contractId)}<input name="payContractId" maxlength="36"></label><label>${esc(t.reasonOptional)}<input name="reason" maxlength="500"></label><button type="submit" name="decision" value="accept">${esc(t.accept)}</button> <button type="submit" name="decision" value="reject">${esc(t.decline)}</button></form></li>`;
  const storeField = storeList ? `<label>${esc(t.store)}<select name="storeId" required>${storeList.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label>` : `<label>${esc(t.storeId)}<input name="storeId" required maxlength="36"></label>`;
  const place = `<section class="p-card" aria-labelledby="place-heading"><h2 id="place-heading">${esc(t.placeHeading)}</h2><form method="post" action="/work/assignments/place">${hidden}<label>${esc(t.theirId)}<input name="personId" required maxlength="256"></label>${storeField}
<label>${esc(t.startDate)}<input type="date" name="startDate" required></label><label>${esc(t.endOptional)}<input type="date" name="endDate"></label><label>${esc(t.contractId)}<input name="payContractId" maxlength="36"></label><button type="submit">${esc(t.place)}</button></form></section>`;
  const list = (title: string, id: string, items: string[], empty: string) => `<section class="p-card" aria-labelledby="${id}"><h2 id="${id}">${esc(title)}</h2>${items.length ? `<ul class="p-stack">${items.join("")}</ul>` : `<div class="p-empty"><p>${esc(empty)}</p></div>`}</section>`;
  return staffShell(t.placementsTab, "assignments", `${message(m)}${pick}${list(t.requestsWaiting, "requests-heading", requests.map(requestItem), t.noRequests)}${place}${list(t.placements, "placements-heading", placements.map(placementItem), t.nobody)}`, c, orgId);
}

/** A-13 list; `undefined` when the actor isn't staff. */
export async function renderStaffAppeals(services: WorkHttpServices, actor: string, query: URLSearchParams, c: WorkCopy = WORK_COPY.en): Promise<string | undefined> {
  const tc = teamCopy(c), t = tc.staff;
  const status = query.get("status") ?? "", after = parseAppealCursor(query.get("after")), org = query.get("org")?.trim() || "";
  if (after === undefined || (org !== "" && !ORG_ID.test(org))) return undefined;
  // Staff of one company list that company's appeals; operator staff may leave the company out.
  const list = await services.appeals.list(actor, { status, after, ...(org ? { orgId: org } : {}) });
  if (!Array.isArray(list)) return undefined;
  const appeals = list as readonly WorkAppeal[];
  const people = await names(services, appeals.map((a) => a.personId));
  const option = (value: string, label: string) => `<option value="${value}"${status === value ? " selected" : ""}>${esc(label)}</option>`;
  const filter = `<form method="get" action="/work/appeals" class="p-card" aria-label="${esc(tc.common.filter)}"><input type="hidden" name="as" value="staff"><label>${esc(t.companyOptional)}<input name="org" value="${esc(org)}" maxlength="256"></label><label>${esc(tc.common.status)}<select name="status">${option("", tc.common.all)}${APPEAL_STATUSES.map((s) => option(s, t.appealStatus[s]!)).join("")}</select></label><button type="submit">${esc(tc.common.show)}</button></form>`;
  const items = appeals.length === 0 ? `<div class="p-empty"><p>${esc(t.noAppeals)}</p></div>`
    : `<ul>${appeals.map((a) => `<li><a href="/work/appeals/${a.id}">${esc(people.get(a.personId) ?? a.personId)}</a>${esc(t.appealLine(shortDate(a.createdAt, c)))}<strong>${esc(t.appealStatus[a.status] ?? a.status)}</strong>. ${esc(a.reason.length > 120 ? `${a.reason.slice(0, 119)}…` : a.reason)}</li>`).join("")}</ul>`;
  const last = appeals[appeals.length - 1];
  const older = appeals.length === 50 && last ? `<p><a href="/work/appeals?as=staff&amp;status=${encodeURIComponent(status)}${org ? `&amp;org=${encodeURIComponent(org)}` : ""}&amp;after=${encodeURIComponent(`${last.createdAt}~${last.id}`)}">${esc(t.olderAppeals)}</a></p>` : "";
  return staffShell(t.appealsTitle, "appeals", `${filter}<section class="p-card">${items}${older}</section>`, c, org || undefined);
}

/** A-13 detail for staff; the service has already checked the actor may see this appeal. */
export async function renderStaffAppeal(services: WorkHttpServices, detail: AppealDetail, m: { kind: "success" | "error"; text: string } | null,
  refill: { readonly form: "correct" | "missing"; readonly values: EntryValues } | null = null, c: WorkCopy = WORK_COPY.en): Promise<string> {
  const tc = teamCopy(c), t = tc.staff;
  const { appeal, session, updates, entries } = detail;
  const people = await names(services, [appeal.personId, ...updates.map((u) => u.authorId).filter((id): id is string => id !== null)]);
  const where = services.storeNames ? (await services.storeNames([session.storeId])).get(session.storeId) ?? t.aStore : t.aStore;
  const base = `/work/appeals/${appeal.id}`;
  const head = `<section class="p-card"><h2>${esc(people.get(appeal.personId) ?? appeal.personId)}: ${esc(t.appealStatus[appeal.status] ?? appeal.status)}</h2><p>${esc(t.raisedAbout(shortDate(appeal.createdAt, c), sessionTime(session, c), where, c.status[session.status] ?? session.status))}</p><p>${esc(t.theirReason(appeal.reason))}</p></section>`;
  const done = entries.length ? `<section class="p-card"><h2>${esc(t.changesMade)}</h2><ul>${entries.map((e) => `<li>${esc(e.source === "correction" ? t.correctedTo : t.added)} ${esc(sessionTime(e, c))}</li>`).join("")}</ul></section>` : "";
  const replies = updates.length === 0 ? `<div class="p-empty"><p>${esc(t.noReplies)}</p></div>`
    : `<ul class="p-stack">${updates.map((u) => `<li class="p-card">${u.title ? `<h3>${esc(u.title)}</h3>` : ""}<p>${esc(u.detail)}</p><p>${esc(shortDate(u.createdAt, c))}${u.authorId ? ` · ${esc(people.get(u.authorId) ?? t.staffName)}` : ""}${u.readAt ? esc(t.read) : ""}</p></li>`).join("")}</ul>`;
  const reply = `<form method="post" action="${base}/reply"><label>${esc(t.titleOptional)}<input name="title" maxlength="255"></label><label>${esc(t.replyField)}<textarea name="detail" required maxlength="5000"></textarea></label><button type="submit">${esc(t.sendReply)}</button></form>`;
  const status = `<form method="post" action="${base}/status"><label>${esc(tc.common.status)}<select name="status">${APPEAL_STATUSES.map((s) => `<option value="${s}"${s === appeal.status ? " selected" : ""}>${esc(t.appealStatus[s]!)}</option>`).join("")}</select></label><button type="submit">${esc(t.saveStatus)}</button></form>`;
  const fixValues = refill?.form === "correct" ? refill.values : {}, missingValues = refill?.form === "missing" ? refill.values : {};
  const fixes = session.endedAt === null ? "" : `<section class="p-card" aria-labelledby="fix-heading"><h2 id="fix-heading">${esc(t.fixHeading)}</h2><p>${esc(t.fixIntro)}</p>
<form method="post" action="/work/corrections"><input type="hidden" name="sessionId" value="${session.id}"><input type="hidden" name="appealId" value="${appeal.id}">${entryFields(fixValues.startedAt ?? localValue(session.startedAt), fixValues.endedAt ?? localValue(session.endedAt), fixValues, c)}<button type="submit">${esc(t.correct)}</button></form>
<form method="post" action="${base}/missing-time">${entryFields(missingValues.startedAt ?? "", missingValues.endedAt ?? "", missingValues, c)}<button type="submit">${esc(t.addMissing)}</button></form></section>`;
  return staffShell(t.appealTitle, "appeals", `${message(m)}${head}${done}<section class="p-card" aria-labelledby="replies-heading"><h2 id="replies-heading">${esc(t.replies)}</h2>${replies}${reply}${status}</section>${fixes}<nav class="p-card"><a href="${appealList(appeal.orgId)}">${esc(t.allAppeals)}</a></nav>`, c, appeal.orgId);
}

/** Values a refused form sends back, so staff fix one field instead of retyping the rest. */
export interface EntryValues { readonly startedAt?: string; readonly endedAt?: string; readonly reason?: string; readonly note?: string }

/** A-13 correction form for one session; `undefined` when the actor can't see it or it can't be corrected. */
export async function renderCorrection(services: WorkHttpServices, actor: string, sessionId: string, date: string, m: { kind: "success" | "error"; text: string } | null,
  values: EntryValues = {}, c: WorkCopy = WORK_COPY.en): Promise<string | undefined> {
  if (!parseRange(date, date) || !UUID.test(sessionId)) return undefined;
  const t = teamCopy(c).staff;
  // One indexed lookup by id, wherever the session falls in the day's pages.
  const row = await services.views.staffSession(actor, date, sessionId);
  const s = row?.session;
  if (!s || s.endedAt === null) return undefined;
  const who = (await names(services, [s.personId])).get(s.personId) ?? s.personId;
  return staffShell(t.correctTitle, "logs", `${message(m)}<section class="p-card"><h2>${esc(who)}</h2><p>${esc(sessionTime(s, c))} · ${esc(c.status[s.status] ?? s.status)}</p><p>${esc(t.correctIntro)}</p>
<form method="post" action="/work/corrections"><input type="hidden" name="sessionId" value="${s.id}"><input type="hidden" name="date" value="${date}">${entryFields(values.startedAt ?? localValue(s.startedAt), values.endedAt ?? localValue(s.endedAt), values, c)}<button type="submit">${esc(t.saveCorrection)}</button></form></section>`, c);
}

/** The time, reason and note fields of a correction or missing-time form, refilled from `values`. */
function entryFields(start: string, end: string, values: EntryValues, c: WorkCopy): string {
  const t = teamCopy(c).staff;
  return `<label>${esc(t.started)}<input type="datetime-local" step="0.001" name="startedAt" value="${esc(start)}" required></label><label>${esc(t.ended)}<input type="datetime-local" step="0.001" name="endedAt" value="${esc(end)}" required></label><label>${esc(t.reasonRequired)}<input name="reason" required maxlength="255" value="${esc(values.reason ?? "")}"></label><label>${esc(t.noteOptional)}<textarea name="note" maxlength="1000">${esc(values.note ?? "")}</textarea></label>`;
}

/** The submitted entry fields, kept as typed (escaped when rendered). */
function entryValues(form: Record<string, string> | undefined): EntryValues {
  if (!form) return {};
  return { ...(form.startedAt !== undefined ? { startedAt: form.startedAt } : {}), ...(form.endedAt !== undefined ? { endedAt: form.endedAt } : {}),
    ...(form.reason !== undefined ? { reason: form.reason } : {}), ...(form.note !== undefined ? { note: form.note } : {}) };
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
  // The browser's language until the actor is known, then theirs.
  let c = await workCopyFor(undefined, undefined, req);
  let t = teamCopy(c);
  try {
    if (!services || !origin) { req.resume(); write(res, ...plain(503, t.common.unavailable[0], t.staff.off, c)); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, t.common.signIn, t.staff.signIn, c)); return true; }
    c = await workCopyFor(services.language, actor, req);
    t = teamCopy(c);
    const denied = () => write(res, ...plain(403, ...t.staff.denied, c));
    const done = url.searchParams.get("done");
    const doneMessage = staffDone(done, c);

    if (req.method === "GET") {
      if (path === "/work/assignments") {
        const org = url.searchParams.get("org")?.trim() || null;
        if (org !== null && !ORG_ID.test(org)) { write(res, ...plain(400, ...t.staff.badCompany, c)); return true; }
        const html = await renderAssignments(services, actor, org, doneMessage, c);
        if (html) write(res, 200, html); else denied();
        return true;
      }
      if (appealList) {
        const org = url.searchParams.get("org")?.trim() ?? "";
        if (parseAppealCursor(url.searchParams.get("after")) === undefined || (org !== "" && !ORG_ID.test(org))) { write(res, ...plain(400, ...t.staff.badListPage, c)); return true; }
        const html = await renderStaffAppeals(services, actor, url.searchParams, c);
        if (html) write(res, 200, html); else denied();
        return true;
      }
      if (path === "/work/corrections/new") {
        const html = await renderCorrection(services, actor, url.searchParams.get("session")?.toLowerCase() ?? "", url.searchParams.get("date") ?? "", null, {}, c);
        if (html) write(res, 200, html); else write(res, ...plain(404, ...t.staff.hoursNotFound, c));
        return true;
      }
      if (path === "/work/corrections" && doneMessage) {
        write(res, 200, staffShell(t.staff.correctTitle, "logs", `${notice("success", doneMessage.text)}<nav class="p-card"><a href="/work/logs">${esc(t.staff.backToLogs)}</a></nav>`, c));
        return true;
      }
    }
    if (req.method !== "POST" || appealList || path === "/work/corrections/new" || path === "/work/assignments") { req.resume(); write(res, ...plain(405, ...t.common.notAllowed, c)); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, ...t.common.refused, c)); return true; }

    if (assignments) {
      const action = ASSIGNMENT_POST.exec(path)![1]!;
      const form = await readForm(req, action === "place" ? ["org", "personId", "storeId", "startDate", "endDate", "payContractId"]
        : action === "end" ? ["org", "assignmentId", "endDate"] : ["org", "requestId", "decision", "startDate", "payContractId", "reason"]);
      const org = form?.org?.trim() ?? "";
      if (!form || !ORG_ID.test(org)) { write(res, ...plain(400, t.staff.notSaved, t.staff.reopenCompany, c)); return true; }
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
      const html = await renderAssignments(services, actor, org, refusal(result.code ?? "invalid_input", c), c);
      if (!html) { denied(); return true; }
      write(res, result.code === "forbidden" ? 403 : result.code && /overlaps|ambiguous|open_session|sessions_after_end|not_pending|person_paused/.test(result.code) ? 409 : 400, html);
      return true;
    }

    if (corrections) {
      const form = await readForm(req, ["sessionId", "appealId", "date", "startedAt", "endedAt", "reason", "note"], FORM_LIMITS.entry);
      const sessionId = form?.sessionId?.toLowerCase() ?? "";
      const result = form ? await services.appeals.correct(actor, sessionId, {
        startedAt: kuwaitInstant(form.startedAt), endedAt: kuwaitInstant(form.endedAt), reason: form.reason, ...(form.note ? { note: form.note } : {}),
        ...(form.appealId ? { appealId: form.appealId } : {}),
      }) : { kind: "refused" as const, code: "invalid_input" as const };
      if (result.kind === "entered") {
        redirect(res, form?.appealId && UUID.test(form.appealId.toLowerCase()) ? `/work/appeals/${form.appealId.toLowerCase()}?done=entered` : "/work/corrections?done=entered");
        return true;
      }
      const values = entryValues(form);
      if (form?.appealId && UUID.test(form.appealId.toLowerCase())) {
        const detail = await services.appeals.detail(actor, form.appealId.toLowerCase());
        // The appellant may read their appeal, but only staff get the staff view.
        if ("kind" in detail || detail.appeal.personId === actor) { write(res, ...plain(404, ...t.staff.appealNotFound, c)); return true; }
        write(res, result.code === "session_not_found" ? 404 : 400, await renderStaffAppeal(services, detail, refusal(result.code, c), { form: "correct", values }, c));
        return true;
      }
      const html = form?.date ? await renderCorrection(services, actor, sessionId, form.date, refusal(result.code, c), values, c) : undefined;
      if (html) write(res, 400, html); else write(res, ...plain(result.code === "session_not_found" ? 404 : 400, t.staff.notSaved, refusal(result.code, c).text, c));
      return true;
    }

    const appealId = appealPost![1]!, action = appealPost![2]!;
    const form = await readForm(req, action === "reply" ? ["title", "detail"] : action === "status" ? ["status"] : ["startedAt", "endedAt", "reason", "note"],
      action === "reply" ? FORM_LIMITS.reply : action === "status" ? undefined : FORM_LIMITS.entry);
    let result: { kind: string; code?: string };
    if (!form) result = { kind: "refused", code: "invalid_input" };
    else if (action === "reply") result = await services.appeals.postUpdate(actor, appealId, { ...(form.title ? { title: form.title } : {}), detail: form.detail });
    else if (action === "status") result = await services.appeals.setStatus(actor, appealId, form.status);
    else result = await services.appeals.addMissing(actor, appealId, { startedAt: kuwaitInstant(form.startedAt), endedAt: kuwaitInstant(form.endedAt), reason: form.reason, ...(form.note ? { note: form.note } : {}) });
    if (result.kind !== "refused") { redirect(res, `/work/appeals/${appealId}?done=${result.kind}`); return true; }
    const detail = await services.appeals.detail(actor, appealId);
    if ("kind" in detail || detail.appeal.personId === actor) { write(res, ...plain(404, ...t.staff.appealNotFound, c)); return true; }
    write(res, result.code === "forbidden" ? 403 : result.code === "appeal_open" ? 409 : 400, await renderStaffAppeal(services, detail, refusal(result.code ?? "invalid_input", c),
      action === "missing-time" ? { form: "missing", values: entryValues(form) } : null, c));
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error, c) ?? plain(503, ...t.common.unavailable, c))); else res.destroy();
  }
  return true;
}
