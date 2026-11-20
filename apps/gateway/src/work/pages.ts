// Work screens for the person (C-10 Placement, C-11 Track, C-12 History, C-13 Appeals), per the screen
// navigation contract. Server-rendered forms on the shared page shell, like
// /profile/area: the actor is the signed-in person from the session cookie,
// writes are same-origin form posts, and the only script is the nonce'd
// location step that Start and Stop need (D-WK1). The JSON API under
// /api/work stays the programmatic surface; both call the same services.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mediaType } from "./media-type.js";
import {
  APPEAL_PAGE_SIZE, formatCursor, parseAppealCursor, parseCursor, parseLocation, parseRange, kuwaitDate,
  type AppealDetail, type HoursCursor, type Assignment, type HoursPage, type PersonDecisionView, type SessionOutcome, type WorkAppeal, type WorkSession,
} from "../../../../packages/work/src/index.js";
import { pageDocument } from "../web-ui.js";
import type { WorkHttpServices } from "./http.js";
import { renderStaffAppeal, staffDone } from "./staff-pages.js";
import { WORK_COPY, workCopyFor, type WorkCopy } from "./copy.js";

/** Store names for display; optional so a deployment without it shows a generic label. */
export type StoreNames = (storeIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

const FORM_LIMIT = 8 * 1024;
/**
 * Byte limits for forms that carry long text: a character can take up to 12
 * bytes once UTF-8 and form encoded (%XX per byte), so each limit covers its
 * fields' character limits plus the short fields.
 */
export const FORM_LIMITS = { appeal: 2000 * 12 + 2048, reply: (255 + 5000) * 12 + 1024, entry: (255 + 1000) * 12 + 2048 } as const;

/** A form body over its route's byte limit; the page answers 413. */
export class FormTooLarge extends Error {
  constructor() { super("form body too large"); }
}

/** The 413 page, or undefined when the error is not a size refusal. */
export function tooLarge(error: unknown, c: WorkCopy = WORK_COPY.en): readonly [number, string] | undefined {
  return error instanceof FormTooLarge ? plain(413, ...c.errors.tooLong!, c) : undefined;
}
const HISTORY_PAGE_CAP = 20;

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The English words and formats, for the screens not yet in Arabic (staff, company and store).
export const STATUS_LABEL: Readonly<Record<string, string>> = WORK_COPY.en.status;
export const clock = (iso: string): string => WORK_COPY.en.clock(iso);
export const longDate = (date: string): string => WORK_COPY.en.longDate(date);
export const duration = (seconds: number): string => WORK_COPY.en.duration(seconds);
/** A `datetime-local` value is Kuwait wall time (seconds and milliseconds optional); Kuwait has no daylight saving. */
export function kuwaitInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return `${value}:00+03:00`;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(value) ? `${value}+03:00` : undefined;
}

export function sessionCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const value = parts.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}
export async function readForm(req: IncomingMessage, allowed: readonly string[], limit: number = FORM_LIMIT): Promise<Record<string, string> | undefined> {
  if (mediaType(req) !== "application/x-www-form-urlencoded") { req.resume(); return undefined; }
  if (Number(req.headers["content-length"]) > limit) { req.resume(); throw new FormTooLarge(); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) { req.resume(); throw new FormTooLarge(); }
    chunks.push(bytes);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (!allowed.includes(key) || Object.hasOwn(out, key)) return undefined;
    out[key] = value;
  }
  return out;
}

export function write(res: ServerResponse, status: number, html: string, nonce?: string): void {
  const script = nonce ? `; script-src 'nonce-${nonce}'` : "";
  res.writeHead(status, {
    "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "referrer-policy": "same-origin", "x-content-type-options": "nosniff",
    "x-frame-options": "DENY", "vary": "Accept",
    "content-security-policy": `default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'${script}`,
  });
  res.end(html);
}
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

type Tab = "assignment" | "track" | "history" | "appeals";
const TABS: readonly Tab[] = ["assignment", "track", "history", "appeals"];
const nav = (current: Tab, c: WorkCopy) =>
  `<nav class="p-card" aria-label="${esc(c.navLabel)}">${TABS.map((tab) => `<a href="/work/${tab}"${tab === current ? ' aria-current="page"' : ""}>${esc(c.tabs[tab])}</a>`).join(" · ")}</nav>`;
/** English pages keep the shell's default document language; Arabic ones are marked lang="ar" dir="rtl". */
export const docLanguage = (c: WorkCopy) => c.lang === "ar" ? "ar" as const : undefined;
function shell(title: string, current: Tab, body: string, c: WorkCopy): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${nav(current, c)}${body}</div></div></main>`, docLanguage(c));
}
export const notice = (kind: "success" | "error", message: string) =>
  `<section class="p-notice p-notice-${kind}" role="${kind === "error" ? "alert" : "status"}"><p>${esc(message)}</p></section>`;
export const plain = (status: number, title: string, message: string, c: WorkCopy = WORK_COPY.en) => [status, pageDocument(title, `<main id="main" class="error-page"><h1>${esc(title)}</h1><p>${esc(message)}</p></main>`, docLanguage(c))] as const;

// The only script: fill the location fields of a form marked data-location, then submit it.
// The messages go in as JSON strings, escaped for a script element.
const js = (text: string) => JSON.stringify(text).replace(/</g, "\\u003c");
const locationJs = (c: WorkCopy) => `document.querySelectorAll("form[data-location]").forEach(function(f){f.addEventListener("submit",function(e){if(f.dataset.located)return;e.preventDefault();var s=document.getElementById("location-status");if(!navigator.geolocation){s.textContent=${js(c.location.unsupported)};return}s.textContent=${js(c.location.getting)};navigator.geolocation.getCurrentPosition(function(p){f.elements.latitude.value=String(p.coords.latitude);f.elements.longitude.value=String(p.coords.longitude);f.dataset.located="1";f.submit()},function(){s.textContent=${js(c.location.failed)}},{enableHighAccuracy:true,timeout:20000,maximumAge:0})})})`;

const locationForm = (action: string, label: string, sessionId?: string) =>
  `<form method="post" action="${action}" data-location>${sessionId ? `<input type="hidden" name="sessionId" value="${sessionId}">` : ""}<input type="hidden" name="latitude"><input type="hidden" name="longitude"><button type="submit">${esc(label)}</button></form>`;

const manualForm = (c: WorkCopy) => `<section class="p-card" aria-labelledby="manual-heading"><h2 id="manual-heading">${esc(c.manual.heading)}</h2><p>${esc(c.manual.intro)}</p>
<form method="post" action="/work/track/manual"><label>${esc(c.manual.started)}<input type="datetime-local" name="startedAt" required></label><label>${esc(c.manual.ended)}<input type="datetime-local" name="endedAt" required></label><label>${esc(c.manual.note)}<textarea name="note" maxlength="1000"></textarea></label><button type="submit">${esc(c.manual.submit)}</button></form></section>`;

async function storeName(names: StoreNames | undefined, storeId: string, c: WorkCopy): Promise<string> {
  return (await names?.([storeId]))?.get(storeId) ?? c.yourStore;
}

export async function renderTrack(services: WorkHttpServices, names: StoreNames | undefined, person: string, message: { kind: "success" | "error"; text: string } | null, now: Date, c: WorkCopy = WORK_COPY.en): Promise<{ html: string; nonce: string }> {
  const { open, assignment } = await services.sessions.today(person);
  const nonce = randomBytes(18).toString("base64url");
  let main: string;
  if (open) {
    const where = await storeName(names, open.storeId, c);
    const elapsed = c.duration((now.getTime() - new Date(open.startedAt).getTime()) / 1000);
    main = `<section class="p-card" aria-labelledby="now-heading"><h2 id="now-heading">${esc(c.track.clockedIn)}</h2><p>${esc(c.track.since(c.clock(open.startedAt), where, elapsed))}</p>${locationForm("/work/track/stop", c.track.clockOut, open.id)}
<form method="post" action="/work/track/discard"><input type="hidden" name="sessionId" value="${open.id}"><p>${esc(c.track.mistake)}</p><button type="submit">${esc(c.track.discard)}</button></form></section>`;
  } else if (assignment) {
    const where = await storeName(names, assignment.storeId, c);
    main = `<section class="p-card" aria-labelledby="now-heading"><h2 id="now-heading">${esc(c.track.notIn)}</h2><p>${esc(c.track.placedAt(where))}</p>${locationForm("/work/track/start", c.track.clockIn)}</section>`;
  } else {
    main = `<section class="p-card"><div class="p-empty"><p>${esc(c.track.notPlaced)}</p></div></section>`;
  }
  const body = `${message ? notice(message.kind, message.text) : ""}${main}<p id="location-status" role="status" aria-live="polite"></p>${manualForm(c)}<script nonce="${nonce}">${locationJs(c)}</script>`;
  return { html: shell(c.track.title, "track", body, c), nonce };
}

interface DayTotals { approved: number; pending: number; rejected: number; open: number; count: number }

async function monthPages(services: WorkHttpServices, person: string, from: string, to: string): Promise<{ rows: HoursPage<PersonDecisionView>["rows"]; totals: HoursPage<PersonDecisionView>["totals"]; truncated: boolean }> {
  const range = parseRange(from, to)!;
  let page = await services.views.mine(person, range, null);
  const rows = [...page.rows];
  let pages = 1;
  while (page.next && pages < HISTORY_PAGE_CAP) { page = await services.views.mine(person, range, page.next); rows.push(...page.rows); pages++; }
  return { rows, totals: page.totals, truncated: page.next !== null };
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function lastDay(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export async function renderHistory(services: WorkHttpServices, person: string, month: string, current: string, c: WorkCopy = WORK_COPY.en): Promise<string> {
  const { rows, totals, truncated } = await monthPages(services, person, `${month}-01`, lastDay(month));
  const days = new Map<string, DayTotals>();
  for (const { session } of rows) {
    const day = days.get(session.workDate) ?? { approved: 0, pending: 0, rejected: 0, open: 0, count: 0 };
    day.count++;
    if (session.endedAt === null) day.open++;
    else day[session.status] += session.durationSeconds ?? 0;
    days.set(session.workDate, day);
  }
  const h = c.history;
  const summary = `<section class="p-card" aria-labelledby="month-heading"><h2 id="month-heading">${esc(c.monthLabel(month))}</h2><dl class="p-fields">
<div><dt>${esc(h.approved)}</dt><dd>${esc(c.duration(totals.approvedSeconds))}</dd></div><div><dt>${esc(h.waiting)}</dt><dd>${esc(c.duration(totals.pendingSeconds))}</dd></div><div><dt>${esc(h.rejected)}</dt><dd>${esc(c.duration(totals.rejectedSeconds))}</dd></div></dl></section>`;
  const list = days.size === 0 ? `<section class="p-card"><div class="p-empty"><p>${esc(h.none(c.monthLabel(month)))}</p></div></section>`
    : `<section class="p-card" aria-labelledby="days-heading"><h2 id="days-heading">${esc(h.days)}</h2><ul>${[...days.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, d]) =>
      `<li><a href="/work/history/${date}">${esc(c.longDate(date))}</a>: ${esc(h.sessions(d.count))}${d.approved ? esc(h.approvedPart(c.duration(d.approved))) : ""}${d.pending ? esc(h.waitingPart(c.duration(d.pending))) : ""}${d.rejected ? esc(h.rejectedPart(c.duration(d.rejected))) : ""}${d.open ? esc(h.inProgressPart) : ""}</li>`).join("")}</ul>${truncated ? `<p>${esc(h.truncated)}</p>` : ""}</section>`;
  const next = month < current ? ` · <a href="/work/history?month=${shiftMonth(month, 1)}">${esc(h.next)}</a>` : "";
  const pager = `<nav class="p-card" aria-label="${esc(h.months)}"><a href="/work/history?month=${shiftMonth(month, -1)}">${esc(h.previous)}</a>${next}</nav>`;
  return shell(h.title, "history", summary + list + pager, c);
}

function sessionItem(session: WorkSession, decision: PersonDecisionView | null, where: string, c: WorkCopy): string {
  const s = c.session;
  const time = session.endedAt === null ? s.toNow(c.clock(session.startedAt)) : s.range(c.clock(session.startedAt), c.clock(session.endedAt), c.duration(session.durationSeconds ?? 0));
  const status = session.endedAt === null ? s.inProgress : c.status[session.status] ?? session.status;
  const marks = [session.source === "manual" ? s.enteredLate : null, session.source === "correction" ? s.corrected : null,
    session.flags.includes("location_missing") ? s.noLocation : null].filter(Boolean);
  const reason = decision?.reason ? `<p>${esc(s.reason)} ${esc(decision.reason)}</p>` : "";
  const note = decision?.note ? `<p>${esc(s.note)} ${esc(decision.note)}</p>` : "";
  const own = session.note ? `<p>${esc(s.yourNote)} ${esc(session.note)}</p>` : "";
  // Legacy offered an appeal on rejected hours only; missing time is added by staff from an appeal.
  const appeal = session.endedAt === null || session.status !== "rejected" ? "" : `<p><a href="/work/appeals/new?session=${session.id}&amp;date=${session.workDate}">${esc(s.appeal)}</a></p>`;
  return `<li class="p-card"><h3>${esc(time)}</h3><p>${esc(where)} · <strong>${esc(status)}</strong>${marks.length ? ` · ${esc(marks.join(s.list))}` : ""}</p>${reason}${note}${own}${appeal}</li>`;
}

const sessionTime = (s: WorkSession, c: WorkCopy) => c.sessionTime(c.longDate(s.workDate), c.clock(s.startedAt), s.endedAt ? c.clock(s.endedAt) : null);
const raisedOn = (iso: string, c: WorkCopy) => c.longDate(kuwaitDate(new Date(iso)));

export async function renderAppeals(services: WorkHttpServices, person: string, after: { createdAt: string; id: string } | null, c: WorkCopy = WORK_COPY.en): Promise<string> {
  const appeals = await services.appeals.mine(person, after);
  const last: WorkAppeal | undefined = appeals[appeals.length - 1];
  const empty = esc(c.appeals.empty("\u0000")).replace("\u0000", `<a href="/work/history">${esc(c.appeals.historyLinkText)}</a>`);
  const items = appeals.length === 0 ? `<div class="p-empty"><p>${empty}</p></div>`
    : `<ul>${appeals.map((a) => `<li><a href="/work/appeals/${a.id}">${esc(c.appeals.raised(raisedOn(a.createdAt, c)))}</a>: <strong>${esc(c.appealStatus[a.status] ?? a.status)}</strong>. ${esc(a.reason.length > 120 ? `${a.reason.slice(0, 119)}…` : a.reason)}</li>`).join("")}</ul>`;
  const older = appeals.length === APPEAL_PAGE_SIZE && last ? `<p><a href="/work/appeals?after=${encodeURIComponent(`${last.createdAt}~${last.id}`)}">${esc(c.appeals.older)}</a></p>` : "";
  return shell(c.appeals.title, "appeals", `<section class="p-card">${items}${older}</section>`, c);
}

/**
 * Sessions of one day from `after`, up to `cap` pages (a day rarely needs a
 * second page). `next` is where the following screen continues, so none is dropped.
 */
async function dayPages(services: WorkHttpServices, person: string, date: string, after: HoursCursor | null, cap: number):
  Promise<{ rows: HoursPage<PersonDecisionView>["rows"]; totals: HoursPage<PersonDecisionView>["totals"]; next: HoursCursor | null }> {
  const range = parseRange(date, date)!;
  let page = await services.views.mine(person, range, after);
  const rows = [...page.rows];
  for (let pages = 1; page.next && pages < cap; pages++) { page = await services.views.mine(person, range, page.next); rows.push(...page.rows); }
  return { rows, totals: page.totals, next: page.next };
}

export async function renderNewAppeal(services: WorkHttpServices, names: StoreNames | undefined, person: string, sessionId: string, date: string, error: string | null, c: WorkCopy = WORK_COPY.en): Promise<string | undefined> {
  // One indexed lookup of the person's own session on that day, wherever it falls in the day's pages.
  const row = await services.views.mineSession(person, date, sessionId);
  const found = row && row.session.endedAt !== null && row.session.status === "rejected" ? row : undefined;
  if (!found) return undefined;
  const where = await storeName(names, found.session.storeId, c);
  return shell(c.appeals.newTitle, "appeals", `${error ? notice("error", error) : ""}<section class="p-card"><h2>${esc(sessionTime(found.session, c))}</h2><p>${esc(where)} · ${esc(c.status[found.session.status] ?? found.session.status)}</p>
<form method="post" action="/work/appeals"><input type="hidden" name="sessionId" value="${found.session.id}"><input type="hidden" name="date" value="${date}"><label>${esc(c.appeals.whatIsWrong)}<textarea name="reason" required maxlength="2000"></textarea></label><button type="submit">${esc(c.appeals.send)}</button></form></section>`, c);
}

function entryItem(s: WorkSession, c: WorkCopy): string {
  const kind = s.source === "correction" ? c.appeals.correctedTo : c.appeals.added;
  return `<li>${esc(kind)} ${esc(sessionTime(s, c))} (${esc(c.duration(s.durationSeconds ?? 0))})</li>`;
}

export async function renderAppeal(services: WorkHttpServices, names: StoreNames | undefined, person: string, detail: AppealDetail, message: string | null, c: WorkCopy = WORK_COPY.en): Promise<string> {
  const { appeal, session, updates, entries } = detail;
  const a = c.appeals;
  const where = await storeName(names, session.storeId, c);
  const head = `<section class="p-card"><h2>${esc(c.appealStatus[appeal.status] ?? appeal.status)}</h2><p>${esc(a.raisedAbout(raisedOn(appeal.createdAt, c), sessionTime(session, c), where))}</p><p>${esc(a.yourReason)} ${esc(appeal.reason)}</p></section>`;
  const fixes = entries.length ? `<section class="p-card"><h2>${esc(a.changes)}</h2><ul>${entries.map((e) => entryItem(e, c)).join("")}</ul></section>` : "";
  const replies = updates.length === 0 ? `<div class="p-empty"><p>${esc(a.noReply)}</p></div>`
    : `<ul class="p-stack">${updates.map((u) => `<li class="p-card">${u.title ? `<h3>${esc(u.title)}</h3>` : ""}<p>${esc(u.detail)}</p><p>${esc(raisedOn(u.createdAt, c))}${u.readAt === null && u.authorId !== person ? esc(a.newMark) : ""}</p></li>`).join("")}</ul>`;
  return shell(a.detailTitle, "appeals", `${message ? notice("success", message) : ""}${head}${fixes}<section class="p-card" aria-labelledby="replies-heading"><h2 id="replies-heading">${esc(a.replies)}</h2>${replies}</section><nav class="p-card"><a href="/work/appeals">${esc(a.all)}</a></nav>`, c);
}

export async function renderDay(services: WorkHttpServices, names: StoreNames | undefined, person: string, date: string, after: HoursCursor | null = null, c: WorkCopy = WORK_COPY.en): Promise<string> {
  const page = await dayPages(services, person, date, after, HISTORY_PAGE_CAP);
  const storeIds = [...new Set(page.rows.map((r) => r.session.storeId))];
  const known = storeIds.length && names ? await names(storeIds) : new Map<string, string>();
  const items = page.rows.length === 0 ? `<div class="p-empty"><p>${esc(c.day.none)}</p></div>`
    : `<ul class="p-stack">${page.rows.map((r) => sessionItem(r.session, r.decision, known.get(r.session.storeId) ?? c.YourStore, c)).join("")}</ul>`;
  const totals = `<p>${esc(c.day.totals(c.duration(page.totals.approvedSeconds), c.duration(page.totals.pendingSeconds), c.duration(page.totals.rejectedSeconds)))}</p>`;
  const later = page.next ? `<p><a href="/work/history/${date}?after=${encodeURIComponent(formatCursor(page.next))}">${esc(c.day.later)}</a></p>` : "";
  return shell(c.longDate(date), "history", `<section class="p-card">${totals}${items}${later}</section><nav class="p-card"><a href="/work/history?month=${date.slice(0, 7)}">${esc(c.day.back(c.monthLabel(date.slice(0, 7))))}</a></nav>`, c);
}

const period = (a: Assignment, c: WorkCopy) => a.endDate ? c.placement.period(c.longDate(a.startDate), c.longDate(a.endDate)) : c.placement.openPeriod(c.longDate(a.startDate));

/** C-10: where the person is placed now, next and before (legacy assignment detail). */
export async function renderPlacements(services: WorkHttpServices, names: StoreNames | undefined, person: string, today: string, c: WorkCopy = WORK_COPY.en): Promise<string> {
  const all = await services.placements.mine(person);
  const known = all.length && names ? await names([...new Set(all.map((a) => a.storeId))]) : new Map<string, string>();
  const where = (a: Assignment) => known.get(a.storeId) ?? c.aStore;
  const p = c.placement;
  const current = all.filter((a) => a.startDate <= today && (a.endDate === null || a.endDate >= today));
  const next = all.filter((a) => a.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = all.filter((a) => a.endDate !== null && a.endDate < today).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const item = (a: Assignment) => `<li><a href="/work/assignment/${a.id}">${esc(where(a))}</a>: ${esc(period(a, c))}</li>`;
  const now = current.length === 0 ? `<div class="p-empty"><p>${esc(p.notNow)}</p></div>`
    : current.map((a) => `<p><strong>${esc(where(a))}</strong></p><p>${esc(period(a, c))}</p><p><a href="/work/assignment/${a.id}">${esc(p.details)}</a> · <a href="/work/track">${esc(p.clock)}</a></p>`).join("");
  const section = (id: string, title: string, list: readonly Assignment[]) => list.length ? `<section class="p-card" aria-labelledby="${id}"><h2 id="${id}">${esc(title)}</h2><ul>${list.map(item).join("")}</ul></section>` : "";
  return shell(p.title, "assignment", `<section class="p-card" aria-labelledby="current-heading"><h2 id="current-heading">${esc(p.nowHeading)}</h2>${now}</section>${section("next-heading", p.next, next)}${section("past-heading", p.past, past)}`, c);
}

export async function renderPlacement(services: WorkHttpServices, names: StoreNames | undefined, person: string, id: string, c: WorkCopy = WORK_COPY.en): Promise<string | undefined> {
  const a = (await services.placements.mine(person)).find((x) => x.id === id);
  if (!a) return undefined;
  const where = await storeName(names, a.storeId, c);
  const p = c.placement;
  return shell(where, "assignment", `<section class="p-card"><dl class="p-fields"><div><dt>${esc(p.store)}</dt><dd>${esc(where)}</dd></div><div><dt>${esc(p.periodLabel)}</dt><dd>${esc(period(a, c))}</dd></div>
<div><dt>${esc(p.how)}</dt><dd>${esc(c.placedBy[a.source] ?? p.placed)}</dd></div></dl></section><nav class="p-card"><a href="/work/history">${esc(p.hours)}</a> · <a href="/work/assignment">${esc(p.all)}</a></nav>`, c);
}

const PLACEMENT = /^\/work\/assignment\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\/work\/history\/(\d{4}-\d{2}-\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPEAL = /^\/work\/appeals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Handles the person's work screens under /work/track, /work/history and /work/appeals; returns
 * false for any other path so later routes (and other /work screens) still run.
 */
export async function handleWorkPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined,
  names?: StoreNames, now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const path = url.pathname;
  const track = path === "/work/track" || /^\/work\/track\/(start|stop|discard|manual)$/.test(path);
  const history = path === "/work/history" || DAY.test(path);
  const appeals = path === "/work/appeals" || path === "/work/appeals/new" || APPEAL.test(path);
  const placement = path === "/work/assignment" || PLACEMENT.test(path);
  if (!track && !history && !appeals && !placement) return false;
  // The browser's language until the person is known, then theirs.
  let c = await workCopyFor(undefined, undefined, req);
  const fail = (status: number, key: string) => write(res, ...plain(status, ...c.errors[key]!, c));
  try {
    if (!services || !origin) { req.resume(); fail(503, "unavailable"); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const person = sessionId ? await services.personFor(sessionId) : undefined;
    if (!person) { req.resume(); fail(401, "signIn"); return true; }
    c = await workCopyFor(services.language, person, req);

    if (req.method === "GET" && path === "/work/track") {
      const done = url.searchParams.get("done");
      const page = await renderTrack(services, names, person, done && c.done[done] ? { kind: "success", text: c.done[done]! } : null, now(), c);
      write(res, 200, page.html, page.nonce);
      return true;
    }
    if (req.method === "GET" && path === "/work/assignment") {
      write(res, 200, await renderPlacements(services, names, person, kuwaitDate(now()), c));
      return true;
    }
    const placementId = PLACEMENT.exec(path)?.[1];
    if (req.method === "GET" && placementId) {
      const html = await renderPlacement(services, names, person, placementId, c);
      if (html) write(res, 200, html); else fail(404, "placementNotFound");
      return true;
    }
    if (req.method === "GET" && path === "/work/history") {
      const current = kuwaitDate(now()).slice(0, 7);
      const month = url.searchParams.get("month") ?? current;
      if (!MONTH.test(month) || month > current) { fail(400, "monthNotFound"); return true; }
      write(res, 200, await renderHistory(services, person, month, current, c));
      return true;
    }
    const day = DAY.exec(path)?.[1];
    if (req.method === "GET" && day) {
      if (!parseRange(day, day)) { fail(404, "dayNotFound"); return true; }
      const after = parseCursor(url.searchParams.get("after"));
      if (after === undefined || (after && after.workDate !== day)) { fail(400, "dayPage"); return true; }
      write(res, 200, await renderDay(services, names, person, day, after, c));
      return true;
    }
    if (req.method === "GET" && path === "/work/appeals") {
      const after = parseAppealCursor(url.searchParams.get("after"));
      if (after === undefined) { fail(400, "listPage"); return true; }
      write(res, 200, await renderAppeals(services, person, after, c));
      return true;
    }
    if (req.method === "GET" && path === "/work/appeals/new") {
      const sessionId = url.searchParams.get("session")?.toLowerCase() ?? "", date = url.searchParams.get("date") ?? "";
      const html = UUID.test(sessionId) && parseRange(date, date) ? await renderNewAppeal(services, names, person, sessionId, date, null, c) : undefined;
      if (html) write(res, 200, html); else fail(404, "hoursNotFound");
      return true;
    }
    const appealId = APPEAL.exec(path)?.[1];
    if (req.method === "GET" && appealId) {
      const detail = await services.appeals.detail(person, appealId);
      if ("kind" in detail) { fail(404, "appealNotFound"); return true; }
      // The service shows an appeal to its owner and to staff of its company; staff get the A-13 view.
      if (detail.appeal.personId !== person) { write(res, 200, await renderStaffAppeal(services, detail, staffDone(url.searchParams.get("done")))); return true; }
      const done = url.searchParams.get("done");
      // Render first, so replies are only marked read once the page that shows them is ready.
      const html = await renderAppeal(services, names, person, detail, done && c.appealDone[done] ? c.appealDone[done]! : null, c);
      write(res, 200, html);
      // Opening the appeal reads its replies (legacy marked them read from the app). A failed
      // receipt leaves the reply new for next time; it never replaces the page already sent.
      for (const u of detail.updates) {
        if (u.readAt === null && u.authorId !== person) await services.appeals.markRead(person, u.id).catch(() => undefined);
      }
      return true;
    }
    const writable = (track && path !== "/work/track") || path === "/work/appeals";
    if (req.method !== "POST" || !writable) { req.resume(); fail(405, "notAllowed"); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); fail(403, "refused"); return true; }

    if (path === "/work/appeals") {
      const form = await readForm(req, ["sessionId", "date", "reason"], FORM_LIMITS.appeal);
      const date = form?.date ?? "";
      if (!form || !parseRange(date, date)) { fail(400, "appealNotSent"); return true; }
      const raised = await services.appeals.raise(person, form.sessionId, form.reason);
      if (raised.kind === "raised") { redirect(res, `/work/appeals/${raised.appeal.id}?done=raised`); return true; }
      const again = UUID.test(form.sessionId ?? "") ? await renderNewAppeal(services, names, person, form.sessionId!.toLowerCase(), date,
        raised.code === "invalid_input" ? c.appeals.invalid : raised.code === "appeal_open" ? c.appeals.open : c.appeals.cannot, c) : undefined;
      if (again) write(res, 400, again); else fail(404, "hoursNotFound");
      return true;
    }

    const action = path.slice("/work/track/".length);
    const form = await readForm(req, action === "manual" ? ["startedAt", "endedAt", "note"] : action === "discard" ? ["sessionId"] : action === "stop" ? ["sessionId", "latitude", "longitude"] : ["latitude", "longitude"],
      action === "manual" ? FORM_LIMITS.entry : undefined);
    let result: SessionOutcome;
    if (!form) result = { kind: "refused", code: "invalid_input" };
    else if (action === "start") result = await services.sessions.start(person, parseLocation(form.latitude, form.longitude));
    else if (action === "stop") result = await services.sessions.stop(person, form.sessionId, parseLocation(form.latitude, form.longitude));
    else if (action === "discard") result = await services.sessions.discard(person, form.sessionId);
    else {
      const startedAt = kuwaitInstant(form.startedAt), endedAt = kuwaitInstant(form.endedAt);
      result = startedAt && endedAt ? await services.sessions.addManual(person, { startedAt, endedAt, ...(form.note ? { note: form.note } : {}) }) : { kind: "refused", code: "invalid_input" };
    }
    if (result.kind !== "refused") { redirect(res, `/work/track?done=${result.kind}`); return true; }
    const status = result.code === "already_working" || result.code === "not_working" || result.code === "overlaps_session" || result.code === "session_changed" ? 409 : 400;
    const page = await renderTrack(services, names, person, { kind: "error", text: c.refusals[result.code] ?? c.refusals.invalid_input! }, now(), c);
    write(res, status, page.html, page.nonce);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error, c) ?? plain(503, ...c.errors.wrong!, c))); else res.destroy();
  }
  return true;
}
