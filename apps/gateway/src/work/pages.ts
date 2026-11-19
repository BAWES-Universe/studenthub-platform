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

/** Store names for display; optional so a deployment without it shows a generic label. */
export type StoreNames = (storeIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

const TIME_ZONE = "Asia/Kuwait";
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
export function tooLarge(error: unknown): readonly [number, string] | undefined {
  return error instanceof FormTooLarge ? plain(413, "Too long", "What you sent is too long. Shorten it and try again.") : undefined;
}
const HISTORY_PAGE_CAP = 20;

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const REFUSALS: Readonly<Record<string, string>> = {
  location_required: "We need your location to clock in or out. Allow location for this site and try again.",
  not_assigned: "You aren't placed at a store today, so there is nothing to clock in to.",
  already_working: "You are already clocked in.",
  session_changed: "Your hours changed in another tab or device. Here they are now; try again if you still need to.",
  not_working: "You aren't clocked in right now.",
  overlaps_session: "That time overlaps hours you already logged.",
  end_before_start: "The end time must be after the start time.",
  in_future: "You can't log time that hasn't happened yet.",
  outside_assignment: "You weren't placed at a store on that date.",
  invalid_input: "Check the times and try again.",
};
const DONE: Readonly<Record<string, string>> = {
  started: "You're clocked in.",
  stopped: "You're clocked out. Your hours are waiting for approval.",
  discarded: "That session was discarded.",
  added: "Your hours were added and are waiting for approval. They are marked as entered late.",
};
export const STATUS_LABEL: Readonly<Record<string, string>> = { pending: "Waiting for approval", approved: "Approved", rejected: "Rejected" };

export function clock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
export function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));
}
function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}-01T00:00:00Z`));
}
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
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
const TABS: readonly [Tab, string][] = [["assignment", "Placement"], ["track", "Track"], ["history", "History"], ["appeals", "Appeals"]];
const nav = (current: Tab) =>
  `<nav class="p-card" aria-label="Work">${TABS.map(([tab, label]) => `<a href="/work/${tab}"${tab === current ? ' aria-current="page"' : ""}>${label}</a>`).join(" · ")}</nav>`;
function shell(title: string, current: Tab, body: string): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${nav(current)}${body}</div></div></main>`);
}
export const notice = (kind: "success" | "error", message: string) =>
  `<section class="p-notice p-notice-${kind}" role="${kind === "error" ? "alert" : "status"}"><p>${esc(message)}</p></section>`;
export const plain = (status: number, title: string, message: string) => [status, pageDocument(title, `<main id="main" class="error-page"><h1>${esc(title)}</h1><p>${esc(message)}</p></main>`)] as const;

// The only script: fill the location fields of a form marked data-location, then submit it.
const LOCATION_JS = `document.querySelectorAll("form[data-location]").forEach(function(f){f.addEventListener("submit",function(e){if(f.dataset.located)return;e.preventDefault();var s=document.getElementById("location-status");if(!navigator.geolocation){s.textContent="This browser can't share your location.";return}s.textContent="Getting your location...";navigator.geolocation.getCurrentPosition(function(p){f.elements.latitude.value=String(p.coords.latitude);f.elements.longitude.value=String(p.coords.longitude);f.dataset.located="1";f.submit()},function(){s.textContent="We couldn't get your location. Allow location for this site and try again."},{enableHighAccuracy:true,timeout:20000,maximumAge:0})})})`;

const locationForm = (action: string, label: string, sessionId?: string) =>
  `<form method="post" action="${action}" data-location>${sessionId ? `<input type="hidden" name="sessionId" value="${sessionId}">` : ""}<input type="hidden" name="latitude"><input type="hidden" name="longitude"><button type="submit">${esc(label)}</button></form>`;

const manualForm = `<section class="p-card" aria-labelledby="manual-heading"><h2 id="manual-heading">Forgot to clock in?</h2><p>Log the time yourself. It is marked as entered late and still needs approval. Times are Kuwait time.</p>
<form method="post" action="/work/track/manual"><label>Started<input type="datetime-local" name="startedAt" required></label><label>Ended<input type="datetime-local" name="endedAt" required></label><label>Note (optional)<textarea name="note" maxlength="1000"></textarea></label><button type="submit">Add hours</button></form></section>`;

async function storeName(names: StoreNames | undefined, storeId: string): Promise<string> {
  return (await names?.([storeId]))?.get(storeId) ?? "your store";
}

export async function renderTrack(services: WorkHttpServices, names: StoreNames | undefined, person: string, message: { kind: "success" | "error"; text: string } | null, now: Date): Promise<{ html: string; nonce: string }> {
  const { open, assignment } = await services.sessions.today(person);
  const nonce = randomBytes(18).toString("base64url");
  let main: string;
  if (open) {
    const where = await storeName(names, open.storeId);
    const elapsed = duration((now.getTime() - new Date(open.startedAt).getTime()) / 1000);
    main = `<section class="p-card" aria-labelledby="now-heading"><h2 id="now-heading">You're clocked in</h2><p>Since ${clock(open.startedAt)} at ${esc(where)} (${elapsed} so far).</p>${locationForm("/work/track/stop", "Clock out", open.id)}
<form method="post" action="/work/track/discard"><input type="hidden" name="sessionId" value="${open.id}"><p>Clocked in by mistake? Discarding removes this session; it will not count.</p><button type="submit">Discard this session</button></form></section>`;
  } else if (assignment) {
    const where = await storeName(names, assignment.storeId);
    main = `<section class="p-card" aria-labelledby="now-heading"><h2 id="now-heading">Not clocked in</h2><p>You're placed at ${esc(where)} today.</p>${locationForm("/work/track/start", "Clock in")}</section>`;
  } else {
    main = `<section class="p-card"><div class="p-empty"><p>You aren't placed at a store today, so there is nothing to clock in to.</p></div></section>`;
  }
  const body = `${message ? notice(message.kind, message.text) : ""}${main}<p id="location-status" role="status" aria-live="polite"></p>${manualForm}<script nonce="${nonce}">${LOCATION_JS}</script>`;
  return { html: shell("Track", "track", body), nonce };
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

export async function renderHistory(services: WorkHttpServices, person: string, month: string, current: string): Promise<string> {
  const { rows, totals, truncated } = await monthPages(services, person, `${month}-01`, lastDay(month));
  const days = new Map<string, DayTotals>();
  for (const { session } of rows) {
    const day = days.get(session.workDate) ?? { approved: 0, pending: 0, rejected: 0, open: 0, count: 0 };
    day.count++;
    if (session.endedAt === null) day.open++;
    else day[session.status] += session.durationSeconds ?? 0;
    days.set(session.workDate, day);
  }
  const summary = `<section class="p-card" aria-labelledby="month-heading"><h2 id="month-heading">${esc(monthLabel(month))}</h2><dl class="p-fields">
<div><dt>Approved</dt><dd>${duration(totals.approvedSeconds)}</dd></div><div><dt>Waiting for approval</dt><dd>${duration(totals.pendingSeconds)}</dd></div><div><dt>Rejected</dt><dd>${duration(totals.rejectedSeconds)}</dd></div></dl></section>`;
  const list = days.size === 0 ? `<section class="p-card"><div class="p-empty"><p>No hours logged in ${esc(monthLabel(month))}.</p></div></section>`
    : `<section class="p-card" aria-labelledby="days-heading"><h2 id="days-heading">Days</h2><ul>${[...days.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, d]) =>
      `<li><a href="/work/history/${date}">${esc(longDate(date))}</a>: ${d.count} ${d.count === 1 ? "session" : "sessions"}${d.approved ? `, ${duration(d.approved)} approved` : ""}${d.pending ? `, ${duration(d.pending)} waiting` : ""}${d.rejected ? `, ${duration(d.rejected)} rejected` : ""}${d.open ? ", in progress" : ""}</li>`).join("")}</ul>${truncated ? "<p>Only the first part of this month is shown.</p>" : ""}</section>`;
  const next = month < current ? ` · <a href="/work/history?month=${shiftMonth(month, 1)}">Next month</a>` : "";
  const pager = `<nav class="p-card" aria-label="Months"><a href="/work/history?month=${shiftMonth(month, -1)}">Previous month</a>${next}</nav>`;
  return shell("History", "history", summary + list + pager);
}

function sessionItem(session: WorkSession, decision: PersonDecisionView | null, where: string): string {
  const time = session.endedAt === null ? `${clock(session.startedAt)} to now` : `${clock(session.startedAt)} to ${clock(session.endedAt)} (${duration(session.durationSeconds ?? 0)})`;
  const status = session.endedAt === null ? "In progress" : STATUS_LABEL[session.status] ?? session.status;
  const marks = [session.source === "manual" ? "entered late" : null, session.source === "correction" ? "corrected by StudentHub" : null,
    session.flags.includes("location_missing") ? "no location recorded" : null].filter(Boolean);
  const reason = decision?.reason ? `<p>Reason: ${esc(decision.reason)}</p>` : "";
  const note = decision?.note ? `<p>Note: ${esc(decision.note)}</p>` : "";
  const own = session.note ? `<p>Your note: ${esc(session.note)}</p>` : "";
  // Legacy offered an appeal on rejected hours only; missing time is added by staff from an appeal.
  const appeal = session.endedAt === null || session.status !== "rejected" ? "" : `<p><a href="/work/appeals/new?session=${session.id}&amp;date=${session.workDate}">Appeal these hours</a></p>`;
  return `<li class="p-card"><h3>${esc(time)}</h3><p>${esc(where)} · <strong>${esc(status)}</strong>${marks.length ? ` · ${esc(marks.join(", "))}` : ""}</p>${reason}${note}${own}${appeal}</li>`;
}

const APPEAL_STATUS: Readonly<Record<string, string>> = { submitted: "Sent", awaiting_review: "Waiting for review", in_progress: "Being looked at", resolved: "Resolved" };
const APPEAL_DONE: Readonly<Record<string, string>> = { raised: "Your appeal was sent. StudentHub will look at it and reply here." };
const sessionTime = (s: WorkSession) => `${longDate(s.workDate)}, ${clock(s.startedAt)} to ${s.endedAt ? clock(s.endedAt) : "now"}`;
const raisedOn = (iso: string) => longDate(kuwaitDate(new Date(iso)));

export async function renderAppeals(services: WorkHttpServices, person: string, after: { createdAt: string; id: string } | null): Promise<string> {
  const appeals = await services.appeals.mine(person, after);
  const last: WorkAppeal | undefined = appeals[appeals.length - 1];
  const items = appeals.length === 0 ? `<div class="p-empty"><p>You haven't appealed any hours. To appeal, open a day in <a href="/work/history">History</a> and choose "Appeal these hours".</p></div>`
    : `<ul>${appeals.map((a) => `<li><a href="/work/appeals/${a.id}">Raised ${esc(raisedOn(a.createdAt))}</a>: <strong>${esc(APPEAL_STATUS[a.status] ?? a.status)}</strong>. ${esc(a.reason.length > 120 ? `${a.reason.slice(0, 119)}…` : a.reason)}</li>`).join("")}</ul>`;
  const older = appeals.length === APPEAL_PAGE_SIZE && last ? `<p><a href="/work/appeals?after=${encodeURIComponent(`${last.createdAt}~${last.id}`)}">Older appeals</a></p>` : "";
  return shell("Appeals", "appeals", `<section class="p-card">${items}${older}</section>`);
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

export async function renderNewAppeal(services: WorkHttpServices, names: StoreNames | undefined, person: string, sessionId: string, date: string, error: string | null): Promise<string | undefined> {
  // One indexed lookup of the person's own session on that day, wherever it falls in the day's pages.
  const row = await services.views.mineSession(person, date, sessionId);
  const found = row && row.session.endedAt !== null && row.session.status === "rejected" ? row : undefined;
  if (!found) return undefined;
  const where = await storeName(names, found.session.storeId);
  return shell("Appeal hours", "appeals", `${error ? notice("error", error) : ""}<section class="p-card"><h2>${esc(sessionTime(found.session))}</h2><p>${esc(where)} · ${esc(STATUS_LABEL[found.session.status] ?? found.session.status)}</p>
<form method="post" action="/work/appeals"><input type="hidden" name="sessionId" value="${found.session.id}"><input type="hidden" name="date" value="${date}"><label>What is wrong with these hours?<textarea name="reason" required maxlength="2000"></textarea></label><button type="submit">Send appeal</button></form></section>`);
}

function entryItem(s: WorkSession): string {
  const kind = s.source === "correction" ? "Corrected to" : "Added";
  return `<li>${kind} ${esc(sessionTime(s))} (${duration(s.durationSeconds ?? 0)})</li>`;
}

export async function renderAppeal(services: WorkHttpServices, names: StoreNames | undefined, person: string, detail: AppealDetail, message: string | null): Promise<string> {
  const { appeal, session, updates, entries } = detail;
  const where = await storeName(names, session.storeId);
  const head = `<section class="p-card"><h2>${esc(APPEAL_STATUS[appeal.status] ?? appeal.status)}</h2><p>Raised ${esc(raisedOn(appeal.createdAt))} about ${esc(sessionTime(session))} at ${esc(where)}.</p><p>Your reason: ${esc(appeal.reason)}</p></section>`;
  const fixes = entries.length ? `<section class="p-card"><h2>Changes to your hours</h2><ul>${entries.map(entryItem).join("")}</ul></section>` : "";
  const replies = updates.length === 0 ? `<div class="p-empty"><p>No reply yet.</p></div>`
    : `<ul class="p-stack">${updates.map((u) => `<li class="p-card">${u.title ? `<h3>${esc(u.title)}</h3>` : ""}<p>${esc(u.detail)}</p><p>${esc(raisedOn(u.createdAt))}${u.readAt === null && u.authorId !== person ? " · New" : ""}</p></li>`).join("")}</ul>`;
  return shell("Appeal", "appeals", `${message ? notice("success", message) : ""}${head}${fixes}<section class="p-card" aria-labelledby="replies-heading"><h2 id="replies-heading">Replies from StudentHub</h2>${replies}</section><nav class="p-card"><a href="/work/appeals">All appeals</a></nav>`);
}

export async function renderDay(services: WorkHttpServices, names: StoreNames | undefined, person: string, date: string, after: HoursCursor | null = null): Promise<string> {
  const page = await dayPages(services, person, date, after, HISTORY_PAGE_CAP);
  const storeIds = [...new Set(page.rows.map((r) => r.session.storeId))];
  const known = storeIds.length && names ? await names(storeIds) : new Map<string, string>();
  const items = page.rows.length === 0 ? `<div class="p-empty"><p>No hours logged on this day.</p></div>`
    : `<ul class="p-stack">${page.rows.map((r) => sessionItem(r.session, r.decision, known.get(r.session.storeId) ?? "Your store")).join("")}</ul>`;
  const totals = `<p>Approved ${duration(page.totals.approvedSeconds)} · Waiting ${duration(page.totals.pendingSeconds)} · Rejected ${duration(page.totals.rejectedSeconds)}</p>`;
  const later = page.next ? `<p><a href="/work/history/${date}?after=${encodeURIComponent(formatCursor(page.next))}">Later sessions on this day</a></p>` : "";
  return shell(longDate(date), "history", `<section class="p-card">${totals}${items}${later}</section><nav class="p-card"><a href="/work/history?month=${date.slice(0, 7)}">Back to ${esc(monthLabel(date.slice(0, 7)))}</a></nav>`);
}

const PLACED_BY: Readonly<Record<string, string>> = { staff: "Placed by StudentHub", request: "Placed at the company's request", recruit: "Placed after recruitment", import: "Placed in the old system" };
const period = (a: Assignment) => a.endDate ? `${longDate(a.startDate)} to ${longDate(a.endDate)}` : `From ${longDate(a.startDate)}, no end date`;

/** C-10: where the person is placed now, next and before (legacy assignment detail). */
export async function renderPlacements(services: WorkHttpServices, names: StoreNames | undefined, person: string, today: string): Promise<string> {
  const all = await services.placements.mine(person);
  const known = all.length && names ? await names([...new Set(all.map((a) => a.storeId))]) : new Map<string, string>();
  const where = (a: Assignment) => known.get(a.storeId) ?? "A store";
  const current = all.filter((a) => a.startDate <= today && (a.endDate === null || a.endDate >= today));
  const next = all.filter((a) => a.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = all.filter((a) => a.endDate !== null && a.endDate < today).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const item = (a: Assignment) => `<li><a href="/work/assignment/${a.id}">${esc(where(a))}</a>: ${esc(period(a))}</li>`;
  const now = current.length === 0 ? `<div class="p-empty"><p>You aren't placed at a store right now.</p></div>`
    : current.map((a) => `<p><strong>${esc(where(a))}</strong></p><p>${esc(period(a))}</p><p><a href="/work/assignment/${a.id}">Details</a> · <a href="/work/track">Clock in or out</a></p>`).join("");
  const section = (id: string, title: string, list: readonly Assignment[]) => list.length ? `<section class="p-card" aria-labelledby="${id}"><h2 id="${id}">${title}</h2><ul>${list.map(item).join("")}</ul></section>` : "";
  return shell("Placement", "assignment", `<section class="p-card" aria-labelledby="current-heading"><h2 id="current-heading">Where you work now</h2>${now}</section>${section("next-heading", "Coming up", next)}${section("past-heading", "Before", past)}`);
}

export async function renderPlacement(services: WorkHttpServices, names: StoreNames | undefined, person: string, id: string): Promise<string | undefined> {
  const a = (await services.placements.mine(person)).find((x) => x.id === id);
  if (!a) return undefined;
  const where = await storeName(names, a.storeId);
  return shell(where, "assignment", `<section class="p-card"><dl class="p-fields"><div><dt>Store</dt><dd>${esc(where)}</dd></div><div><dt>Period</dt><dd>${esc(period(a))}</dd></div>
<div><dt>How</dt><dd>${esc(PLACED_BY[a.source] ?? "Placed")}</dd></div></dl></section><nav class="p-card"><a href="/work/history">Your hours</a> · <a href="/work/assignment">All placements</a></nav>`);
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
  try {
    if (!services || !origin) { req.resume(); write(res, ...plain(503, "Work is unavailable", "Hours tracking isn't switched on here yet.")); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const person = sessionId ? await services.personFor(sessionId) : undefined;
    if (!person) { req.resume(); write(res, ...plain(401, "Sign in", "Sign in to see your hours.")); return true; }

    if (req.method === "GET" && path === "/work/track") {
      const done = url.searchParams.get("done");
      const page = await renderTrack(services, names, person, done && DONE[done] ? { kind: "success", text: DONE[done]! } : null, now());
      write(res, 200, page.html, page.nonce);
      return true;
    }
    if (req.method === "GET" && path === "/work/assignment") {
      write(res, 200, await renderPlacements(services, names, person, kuwaitDate(now())));
      return true;
    }
    const placementId = PLACEMENT.exec(path)?.[1];
    if (req.method === "GET" && placementId) {
      const html = await renderPlacement(services, names, person, placementId);
      if (html) write(res, 200, html); else write(res, ...plain(404, "Placement not found", "This placement isn't yours or doesn't exist."));
      return true;
    }
    if (req.method === "GET" && path === "/work/history") {
      const current = kuwaitDate(now()).slice(0, 7);
      const month = url.searchParams.get("month") ?? current;
      if (!MONTH.test(month) || month > current) { write(res, ...plain(400, "Month not found", "Choose a month up to this one.")); return true; }
      write(res, 200, await renderHistory(services, person, month, current));
      return true;
    }
    const day = DAY.exec(path)?.[1];
    if (req.method === "GET" && day) {
      if (!parseRange(day, day)) { write(res, ...plain(404, "Day not found", "That isn't a valid date.")); return true; }
      const after = parseCursor(url.searchParams.get("after"));
      if (after === undefined || (after && after.workDate !== day)) { write(res, ...plain(400, "Page not found", "That page of the day isn't valid.")); return true; }
      write(res, 200, await renderDay(services, names, person, day, after));
      return true;
    }
    if (req.method === "GET" && path === "/work/appeals") {
      const after = parseAppealCursor(url.searchParams.get("after"));
      if (after === undefined) { write(res, ...plain(400, "Page not found", "That list page isn't valid.")); return true; }
      write(res, 200, await renderAppeals(services, person, after));
      return true;
    }
    if (req.method === "GET" && path === "/work/appeals/new") {
      const sessionId = url.searchParams.get("session")?.toLowerCase() ?? "", date = url.searchParams.get("date") ?? "";
      const html = UUID.test(sessionId) && parseRange(date, date) ? await renderNewAppeal(services, names, person, sessionId, date, null) : undefined;
      if (html) write(res, 200, html); else write(res, ...plain(404, "Hours not found", "Open the day in History and choose the hours to appeal."));
      return true;
    }
    const appealId = APPEAL.exec(path)?.[1];
    if (req.method === "GET" && appealId) {
      const detail = await services.appeals.detail(person, appealId);
      if ("kind" in detail) { write(res, ...plain(404, "Appeal not found", "This appeal isn't yours or doesn't exist.")); return true; }
      // The service shows an appeal to its owner and to staff of its company; staff get the A-13 view.
      if (detail.appeal.personId !== person) { write(res, 200, await renderStaffAppeal(services, detail, staffDone(url.searchParams.get("done")))); return true; }
      const done = url.searchParams.get("done");
      // Render first, so replies are only marked read once the page that shows them is ready.
      const html = await renderAppeal(services, names, person, detail, done && APPEAL_DONE[done] ? APPEAL_DONE[done]! : null);
      write(res, 200, html);
      // Opening the appeal reads its replies (legacy marked them read from the app). A failed
      // receipt leaves the reply new for next time; it never replaces the page already sent.
      for (const u of detail.updates) {
        if (u.readAt === null && u.authorId !== person) await services.appeals.markRead(person, u.id).catch(() => undefined);
      }
      return true;
    }
    const writable = (track && path !== "/work/track") || path === "/work/appeals";
    if (req.method !== "POST" || !writable) { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, "Request refused", "We could not verify this request.")); return true; }

    if (path === "/work/appeals") {
      const form = await readForm(req, ["sessionId", "date", "reason"], FORM_LIMITS.appeal);
      const date = form?.date ?? "";
      if (!form || !parseRange(date, date)) { write(res, ...plain(400, "Appeal not sent", "Open the day in History and try again.")); return true; }
      const raised = await services.appeals.raise(person, form.sessionId, form.reason);
      if (raised.kind === "raised") { redirect(res, `/work/appeals/${raised.appeal.id}?done=raised`); return true; }
      const again = UUID.test(form.sessionId ?? "") ? await renderNewAppeal(services, names, person, form.sessionId!.toLowerCase(), date,
        raised.code === "invalid_input" ? "Tell us what is wrong with these hours."
          : raised.code === "appeal_open" ? "You already have an open appeal on these hours. Follow it in Appeals." : "These hours can't be appealed.") : undefined;
      if (again) write(res, 400, again); else write(res, ...plain(404, "Hours not found", "Open the day in History and choose the hours to appeal."));
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
    const page = await renderTrack(services, names, person, { kind: "error", text: REFUSALS[result.code] ?? REFUSALS.invalid_input! }, now());
    write(res, status, page.html, page.nonce);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error) ?? plain(503, "Work is unavailable", "Something went wrong. Try again in a moment."))); else res.destroy();
  }
  return true;
}
