// Employer work screens, per the screen navigation contract:
// - O-11 Work review, /organization/:orgId/work: the company's hours with
//   filters, approve or reject selected sessions, undo a decision;
// - M-03 Time approvals, /store/:storeId/time-approvals: the same queue for one
//   store, waiting hours first;
// - M-04 Assignment changes, /store/:storeId/assignment-changes: ask for a
//   person at the store, follow and cancel those requests;
// - A-12 Work logs, /work/logs: staff see every company's hours (a person
//   filter, the same decisions) and open a correction from each closed entry.
// Same pattern as the person's screens (pages.ts): server-rendered forms, the
// actor from the session cookie, same-origin form posts, no script. Every read
// and write goes through the work services, which re-check the actor's grants
// (company, staff, or the store's manager) on each request.

import type { IncomingMessage, ServerResponse } from "node:http";
import { mediaType } from "./media-type.js";
import {
  formatCursor, kuwaitDate, parseCursor, parseRange,
  type AssignmentRequest, type EmployerDecisionView, type HoursCursor, type HoursRange, type SessionStatus, type WorkSession,
} from "../../../../packages/work/src/index.js";
import { exportQuery, WORK_EXPORT_KINDS } from "./exports.js";
import type { WorkHttpServices } from "./http.js";
import { clock, duration, esc, FormTooLarge, longDate, notice, plain, redirect, sessionCookie, STATUS_LABEL, tooLarge, write } from "./pages.js";
import { pageDocument } from "../web-ui.js";

// A decision note (2,000 characters) and reason (255) at up to 12 encoded bytes each, plus up to 200 session ids.
const FORM_LIMIT = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOGS = /^\/work\/logs(\/decide)?$/;
const ORG = /^\/organization\/([A-Za-z0-9._:-]{1,256})\/work(\/decide)?$/;
const STORE = /^\/store\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(time-approvals|assignment-changes)(?:\/(decide|request|cancel))?$/;
const STATUSES: readonly SessionStatus[] = ["pending", "approved", "rejected"];

const DECIDE_REFUSALS: Readonly<Record<string, string>> = {
  invalid_input: "Choose at least one entry, and check the rating and the text.",
  forbidden: "You can't decide these hours.",
  session_not_found: "Some of those hours aren't yours to decide, or no longer exist.",
  session_open: "Hours still in progress can't be decided yet.",
  session_replaced: "Those hours were corrected by StudentHub. Decide the corrected entry instead.",
  not_decided: "Those hours are already waiting for a decision.",
  too_many: "Choose at most 200 entries at once.",
};
const REQUEST_REFUSALS: Readonly<Record<string, string>> = {
  invalid_input: "Check the person's StudentHub ID and the note.",
  forbidden: "You can't ask for people at this store.",
  person_not_found: "We couldn't find that person.",
  duplicate_request: "There is already a waiting request for this person here.",
  store_removed: "This store has been removed.",
  request_not_found: "That request no longer exists.",
  request_not_pending: "That request was already answered.",
};
const DONE: Readonly<Record<string, string>> = {
  decided: "Your decision was saved.", undone: "The decision was undone. Those hours are waiting again.",
  requested: "Your request was sent to StudentHub.", cancelled: "The request was cancelled.",
};
const REQUEST_STATUS: Readonly<Record<string, string>> = { pending: "Waiting for StudentHub", accepted: "Placed", rejected: "Declined", cancelled: "Cancelled" };

/** Reads a same-origin form; only `repeated` keys may appear more than once. */
async function readFields(req: IncomingMessage, allowed: readonly string[], repeated: readonly string[] = []): Promise<Map<string, string[]> | undefined> {
  if (mediaType(req) !== "application/x-www-form-urlencoded") { req.resume(); return undefined; }
  if (Number(req.headers["content-length"]) > FORM_LIMIT) { req.resume(); throw new FormTooLarge(); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > FORM_LIMIT) { req.resume(); throw new FormTooLarge(); }
    chunks.push(bytes);
  }
  const out = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (!allowed.includes(key)) return undefined;
    const list = out.get(key) ?? [];
    if (list.length > 0 && !repeated.includes(key)) return undefined;
    list.push(value);
    out.set(key, list);
  }
  return out;
}
const one = (fields: Map<string, string[]>, key: string) => fields.get(key)?.[0];

/** A company, one of its stores, or (staff) every company. */
interface Place { readonly orgId: string; readonly storeId?: string; readonly staff?: boolean; readonly base: string; readonly title: string }
interface Filters { readonly range: HoursRange; readonly status: SessionStatus | null; readonly storeId?: string; readonly personId?: string; readonly after: HoursCursor | null }

/** Filters from a query string; the default is this Kuwait month so far, and waiting hours only for a store queue. */
function readFilters(query: URLSearchParams, place: Place, now: Date): Filters | undefined {
  const today = kuwaitDate(now);
  const range = parseRange(query.get("from") || `${today.slice(0, 7)}-01`, query.get("to") || today);
  const raw = query.get("status");
  const status = raw === null ? (place.storeId ? "pending" : null) : raw === "" ? null : STATUSES.includes(raw as SessionStatus) ? raw as SessionStatus : undefined;
  const after = parseCursor(query.get("after"));
  const storeId = place.staff ? undefined : place.storeId ?? (query.get("store") || undefined);
  const personId = place.staff ? query.get("person")?.trim() || undefined : undefined;
  if (!range || status === undefined || after === undefined || (storeId !== undefined && !UUID.test(storeId)) || (personId !== undefined && !/^[A-Za-z0-9._:@-]{1,256}$/.test(personId))) return undefined;
  return { range, status, after, ...(storeId ? { storeId } : {}), ...(personId ? { personId } : {}) };
}
function filterQuery(f: Filters, place: Place, after: HoursCursor | null = null): string {
  const q = new URLSearchParams({ from: f.range.from, to: f.range.to, status: f.status ?? "" });
  if (f.storeId && !place.storeId) q.set("store", f.storeId);
  if (f.personId) q.set("person", f.personId);
  if (after) q.set("after", formatCursor(after));
  return q.toString();
}
/** A post's way back: the screen's own path with its filters, never anywhere else. */
function backTo(place: Place, value: string | undefined): string {
  return value !== undefined && (value === place.base || value.startsWith(`${place.base}?`)) && !/[\r\n]/.test(value) ? value : place.base;
}
const withDone = (back: string, done: string) => {
  const url = new URL(back, "http://invalid");
  url.searchParams.delete("done");
  url.searchParams.set("done", done);
  return `${url.pathname}?${url.searchParams.toString()}`;
};

function reviewShell(title: string, body: string): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${body}</div></div></main>`);
}
function storeNav(place: Place, current: "time-approvals" | "assignment-changes"): string {
  if (!place.storeId) return "";
  const tab = (path: string, label: string) => `<a href="/store/${place.storeId}/${path}"${path === current ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<nav class="p-card" aria-label="Store">${tab("time-approvals", "Time approvals")} · ${tab("assignment-changes", "Assignment changes")}</nav>`;
}

function decisionText(d: EmployerDecisionView | null, by: ReadonlyMap<string, string>): string {
  if (!d) return "";
  const parts = [d.reason ? `<p>Reason: ${esc(d.reason)}</p>` : "", d.note ? `<p>Note${d.notePublic ? " (the person can see it)" : " (only your company can see it)"}: ${esc(d.note)}</p>` : "",
    d.rating !== null ? `<p>Rating: ${d.rating} of 5</p>` : "",
    `<p>Decided ${esc(longDate(kuwaitDate(new Date(d.decidedAt))))}${d.decidedBy ? ` by ${esc(by.get(d.decidedBy) ?? "a colleague")}` : ""}</p>`];
  return parts.join("");
}

/** D-WK1: the approver sees where the person clocked in and out (no geofence; the places are shown, not judged). */
function placeText(label: string, at: { readonly latitude: number; readonly longitude: number } | null): string {
  if (!at) return "";
  const lat = at.latitude.toFixed(5), lon = at.longitude.toFixed(5);
  return `${label} <a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=17/${lat}/${lon}" rel="noopener noreferrer" target="_blank">${lat}, ${lon}</a>`;
}
function placesText(s: WorkSession): string {
  const parts = [placeText("Started at", s.startLocation), placeText("stopped at", s.endLocation)].filter(Boolean);
  return parts.length ? `<p>${parts.join(", ")}</p>` : "";
}

function reviewRow(s: WorkSession, d: EmployerDecisionView | null, people: ReadonlyMap<string, string>, stores: ReadonlyMap<string, string>, staff: boolean): string {
  const open = s.endedAt === null;
  const time = `${longDate(s.workDate)}, ${clock(s.startedAt)} to ${open ? "now" : `${clock(s.endedAt!)} (${duration(s.durationSeconds ?? 0)})`}`;
  const status = open ? "In progress" : STATUS_LABEL[s.status] ?? s.status;
  const marks = [s.source === "manual" ? "entered late" : null, s.source === "correction" ? "corrected by StudentHub" : null, s.source === "import" ? "from the old system" : null,
    s.flags.includes("location_missing") ? "no location recorded" : null].filter(Boolean);
  const who = people.get(s.personId) ?? "A person";
  const box = open ? "" : `<input type="checkbox" name="sessionId" value="${s.id}" aria-label="Select ${esc(who)}, ${esc(time)}">`;
  const undo = !open && s.status !== "pending" ? `<button type="submit" name="undo" value="${s.id}">Undo this decision</button>` : "";
  // Staff correct closed hours (D-WK3); the correction replaces this entry in every total.
  const correct = staff && !open ? `<p><a href="/work/corrections/new?session=${s.id}&amp;date=${s.workDate}">Correct these hours</a></p>` : "";
  return `<li class="p-card" id="s-${s.id}"><h3>${box} ${esc(who)}</h3><p>${esc(time)} · ${esc(stores.get(s.storeId) ?? "Store")}</p><p><strong>${esc(status)}</strong>${marks.length ? ` · ${esc(marks.join(", "))}` : ""}</p>${placesText(s)}${s.note ? `<p>Their note: ${esc(s.note)}</p>` : ""}${decisionText(d, people)}${undo}${correct}</li>`;
}

/**
 * The export buttons (P-1): on the company screen, these hours in detail or per
 * person (legacy work-log-detailed-excel and work-log-excel); on the staff work
 * logs, who worked where over the range (legacy export-assigned-history). Each
 * posts to the shared export route with the screen's filters in its query; the
 * export service checks who may export. Store screens have none, as in legacy.
 */
function exportForm(place: Place, f: Filters): string {
  if (place.storeId) return "";
  const button = (kind: string, query: Record<string, string | undefined>, label: string) =>
    `<form method="post" action="/exports/${kind}?${esc(exportQuery(query))}"><button type="submit">${label}</button></form>`;
  const range = { from: f.range.from, to: f.range.to };
  if (place.staff) return `<section class="p-card" aria-label="Export">${button(WORK_EXPORT_KINDS.history, range, "Export who worked where (CSV)")}</section>`;
  const company = { orgId: place.orgId, ...range, status: f.status ?? undefined, store: f.storeId ?? undefined };
  return `<section class="p-card" aria-label="Export"><p>Export these hours as a CSV file.</p>${button(WORK_EXPORT_KINDS.detailed, company, "Export each entry")}${button(WORK_EXPORT_KINDS.summary, company, "Export totals per person")}</section>`;
}

/** O-11 and M-03; `undefined` when the actor may not see this company or store. */
export async function renderReview(services: WorkHttpServices, actor: string, place: Place, f: Filters, message: { kind: "success" | "error"; text: string } | null): Promise<string | undefined> {
  const page = place.staff
    ? await services.views.all(actor, f.range, { ...(f.personId ? { personId: f.personId } : {}), ...(f.status ? { status: f.status } : {}), after: f.after })
    : await services.views.company(actor, place.orgId, f.range, { ...(f.storeId ? { storeId: f.storeId } : {}), ...(f.status ? { status: f.status } : {}), after: f.after });
  if ("kind" in page) return undefined;
  const ids = new Set<string>();
  for (const { session, decision } of page.rows) { ids.add(session.personId); if (decision?.decidedBy) ids.add(decision.decidedBy); }
  const storeIds = [...new Set(page.rows.map((r) => r.session.storeId))];
  const [people, stores] = await Promise.all([
    ids.size && services.personNames ? services.personNames([...ids]) : new Map<string, string>(),
    storeIds.length && services.storeNames ? services.storeNames(storeIds) : new Map<string, string>(),
  ]);
  const option = (value: string, label: string) => `<option value="${value}"${(f.status ?? "") === value ? " selected" : ""}>${label}</option>`;
  const filterForm = `<form method="get" action="${place.base}" class="p-card" aria-label="Filter"><label>From<input type="date" name="from" value="${f.range.from}" required></label><label>To<input type="date" name="to" value="${f.range.to}" required></label>
<label>Status<select name="status">${option("", "All")}${option("pending", "Waiting for approval")}${option("approved", "Approved")}${option("rejected", "Rejected")}</select></label>${f.storeId && !place.storeId ? `<input type="hidden" name="store" value="${f.storeId}">` : ""}${place.staff ? `<label>Person's StudentHub ID<input name="person" value="${esc(f.personId ?? "")}" maxlength="256"></label>` : ""}<button type="submit">Show</button></form>`;
  const totals = `<p>Approved ${duration(page.totals.approvedSeconds)} · Waiting ${duration(page.totals.pendingSeconds)} · Rejected ${duration(page.totals.rejectedSeconds)}${page.totals.open ? ` · ${page.totals.open} in progress` : ""}</p>`;
  const back = `${place.base}?${filterQuery(f, place, f.after)}`;
  const list = page.rows.length === 0 ? `<div class="p-empty"><p>No hours match these filters.</p></div>`
    : `<ul class="p-stack">${page.rows.map((r) => reviewRow(r.session, r.decision, people, stores, place.staff === true)).join("")}</ul>`;
  const fields = page.rows.length === 0 ? "" : `<fieldset><legend>Decide the selected hours</legend><label>Reason (shown to the person)<input name="reason" maxlength="255"></label>
<label>Note<textarea name="note" maxlength="2000"></textarea></label><label><input type="checkbox" name="notePublic" value="on"> Let the person see the note</label>
<label>Rating<select name="rating"><option value="">No rating</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} of 5</option>`).join("")}</select></label>
<button type="submit" name="action" value="approve">Approve selected</button> <button type="submit" name="action" value="reject">Reject selected</button></fieldset>`;
  // The form's default button comes first and is disabled, so Enter in the reason field submits nothing (not a row's undo, not an approval).
  const decide = `<form method="post" action="${place.base}/decide" class="p-card"><button type="submit" disabled hidden aria-hidden="true" tabindex="-1"></button><input type="hidden" name="back" value="${esc(back)}">${totals}${list}${fields}</form>`;
  const more = page.next ? `<nav class="p-card"><a href="${place.base}?${esc(filterQuery(f, place, page.next))}">More hours</a></nav>` : "";
  return reviewShell(place.title, `${message ? notice(message.kind, message.text) : ""}${storeNav(place, "time-approvals")}${filterForm}${exportForm(place, f)}${decide}${more}`);
}

/** M-04; `undefined` when the actor may not see this store's requests. */
export async function renderChanges(services: WorkHttpServices, actor: string, place: Place & { readonly storeId: string }, message: { kind: "success" | "error"; text: string } | null): Promise<string | undefined> {
  const requests = await services.placements.requestsFor(actor, place.orgId, { storeId: place.storeId });
  if (!requests) return undefined;
  const ids = [...new Set(requests.map((r) => r.personId))];
  const people = ids.length && services.personNames ? await services.personNames(ids) : new Map<string, string>();
  const item = (r: AssignmentRequest) => `<li class="p-card"><h3>${esc(people.get(r.personId) ?? r.personId)}</h3><p><strong>${esc(REQUEST_STATUS[r.status] ?? r.status)}</strong> · asked ${esc(longDate(kuwaitDate(new Date(r.requestedAt))))}</p>${r.note ? `<p>Your note: ${esc(r.note)}</p>` : ""}${r.decisionReason ? `<p>Answer: ${esc(r.decisionReason)}</p>` : ""}${r.status === "pending" ? `<form method="post" action="${place.base}/cancel"><input type="hidden" name="requestId" value="${r.id}"><button type="submit">Cancel this request</button></form>` : ""}</li>`;
  const list = requests.length === 0 ? `<div class="p-empty"><p>No requests for this store yet.</p></div>` : `<ul class="p-stack">${requests.map(item).join("")}</ul>`;
  const ask = `<section class="p-card" aria-labelledby="ask-heading"><h2 id="ask-heading">Ask for a person</h2><p>StudentHub reviews the request and places the person at this store.</p>
<form method="post" action="${place.base}/request"><label>Their StudentHub ID<input name="personId" required maxlength="256"></label><label>Note (optional)<textarea name="note" maxlength="1000"></textarea></label><button type="submit">Send request</button></form></section>`;
  return reviewShell(place.title, `${message ? notice(message.kind, message.text) : ""}${storeNav(place, "assignment-changes")}${ask}<section class="p-card" aria-labelledby="requests-heading"><h2 id="requests-heading">Requests</h2>${list}</section>`);
}

/**
 * Handles /organization/:orgId/work and /store/:storeId/{time-approvals,assignment-changes};
 * returns false for any other path.
 */
export async function handleReviewPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined,
  now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const org = ORG.exec(url.pathname), store = STORE.exec(url.pathname), logs = LOGS.exec(url.pathname);
  if (!org && !store && !logs) return false;
  try {
    if (!services || !origin || (store && !services.storeInfo)) { req.resume(); write(res, ...plain(503, "Work is unavailable", "Hours review isn't switched on here yet.")); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, "Sign in", "Sign in to review hours.")); return true; }

    let place: Place, screen: "review" | "changes", action: string | undefined;
    if (logs) {
      place = { orgId: "", staff: true, base: "/work/logs", title: "Work logs" };
      screen = "review"; action = logs[1] ? "decide" : undefined;
    } else if (org) {
      place = { orgId: org[1]!, base: `/organization/${org[1]!}/work`, title: "Work review" };
      screen = "review"; action = org[2] ? "decide" : undefined;
    } else {
      const info = await services.storeInfo!(store![1]!);
      if (!info) { req.resume(); write(res, ...plain(404, "Store not found", "This store doesn't exist.")); return true; }
      screen = store![2] === "time-approvals" ? "review" : "changes";
      place = { orgId: info.orgId, storeId: store![1]!, base: `/store/${store![1]!}/${store![2]!}`, title: `${screen === "review" ? "Time approvals" : "Assignment changes"}: ${info.name}` };
      action = store![3];
      if ((screen === "review" && action !== undefined && action !== "decide") || (screen === "changes" && action === "decide")) { req.resume(); write(res, ...plain(404, "Page not found", "This page doesn't exist.")); return true; }
    }
    const denied = () => write(res, ...plain(403, "Not yours to review", "You don't have access to this company's or store's hours."));
    const done = url.searchParams.get("done");
    const doneMessage = done && DONE[done] ? { kind: "success" as const, text: DONE[done]! } : null;

    if (req.method === "GET" && action === undefined) {
      if (screen === "changes") {
        const html = await renderChanges(services, actor, place as Place & { storeId: string }, doneMessage);
        if (html) write(res, 200, html); else denied();
        return true;
      }
      const f = readFilters(url.searchParams, place, now());
      if (!f) { write(res, ...plain(400, "Filters not valid", "Choose a date range of at most a year and a status from the list.")); return true; }
      const html = await renderReview(services, actor, place, f, doneMessage);
      if (html) write(res, 200, html); else denied();
      return true;
    }
    if (req.method !== "POST" || action === undefined) { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, "Request refused", "We could not verify this request.")); return true; }

    if (screen === "changes") {
      const fields = await readFields(req, action === "request" ? ["personId", "note"] : ["requestId"]);
      const result = !fields ? { kind: "refused" as const, code: "invalid_input" }
        : action === "request"
          ? await services.placements.request(actor, { personId: one(fields, "personId")?.trim() ?? "", storeId: place.storeId!, ...(one(fields, "note") ? { note: one(fields, "note")! } : {}) })
          : await services.placements.decideRequest(actor, one(fields, "requestId") ?? "", "cancel");
      if (result.kind === "requested" || result.kind === "cancelled") { redirect(res, `${place.base}?done=${result.kind}`); return true; }
      const code = "code" in result ? result.code : "invalid_input";
      const html = await renderChanges(services, actor, place as Place & { storeId: string }, { kind: "error", text: REQUEST_REFUSALS[code] ?? REQUEST_REFUSALS.invalid_input! });
      if (!html) { denied(); return true; }
      write(res, code === "forbidden" ? 403 : code === "duplicate_request" || code === "request_not_pending" ? 409 : 400, html);
      return true;
    }

    const fields = await readFields(req, ["sessionId", "action", "undo", "reason", "note", "notePublic", "rating", "back"], ["sessionId"]);
    const back = backTo(place, fields ? one(fields, "back") : undefined);
    let result;
    if (!fields) result = { kind: "refused" as const, code: "invalid_input" };
    else if (one(fields, "undo") !== undefined) result = await services.decisions.undo(actor, one(fields, "undo"), one(fields, "reason"));
    else {
      const verb = one(fields, "action");
      result = verb === "approve" || verb === "reject"
        ? await services.decisions.decideSessions(actor, fields.get("sessionId") ?? [], {
          decision: verb, reason: one(fields, "reason"), note: one(fields, "note"), rating: one(fields, "rating"), notePublic: one(fields, "notePublic") ?? "",
        })
        : { kind: "refused" as const, code: "invalid_input" };
    }
    if (result.kind === "decided") { redirect(res, withDone(back, fields && one(fields, "undo") !== undefined ? "undone" : "decided")); return true; }
    const f = readFilters(new URL(back, "http://invalid").searchParams, place, now()) ?? readFilters(new URLSearchParams(), place, now())!;
    const html = await renderReview(services, actor, place, f, { kind: "error", text: DECIDE_REFUSALS[result.code] ?? DECIDE_REFUSALS.invalid_input! });
    if (!html) { denied(); return true; }
    write(res, result.code === "forbidden" ? 403 : result.code === "invalid_input" || result.code === "too_many" ? 400 : 409, html);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error) ?? plain(503, "Work is unavailable", "Something went wrong. Try again in a moment."))); else res.destroy();
  }
  return true;
}
