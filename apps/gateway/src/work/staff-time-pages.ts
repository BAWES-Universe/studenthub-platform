// Internal staff time screens (legacy staff_work_session):
// - /me/work: a staff member starts and ends their day (the session part of
//   A-14; the stand-up, leave and expenses there are other lanes');
// - /work/staff-time: operator admins see every staff member's days over a
//   range and who has not started on a date (legacy admin list and
//   list-inactive).
// Same pattern as the other work screens: server-rendered, same-origin form
// posts, the actor from the session cookie, every rule in StaffTimeService.

import type { IncomingMessage, ServerResponse } from "node:http";
import { kuwaitDate, type StaffDay, type StaffDayCursor, type StaffSession } from "../../../../packages/work/src/index.js";
import type { WorkHttpServices } from "./http.js";
import { clock, esc, longDate, notice, plain, readForm, redirect, sessionCookie, tooLarge, write } from "./pages.js";
import { pageDocument } from "../web-ui.js";

const MINE = /^\/me\/work(?:\/(start|end))?$/;
const ADMIN = "/work/staff-time";

/** Legacy showed minutes and hours to three places; "2h 05m" reads better and keeps the minutes. */
export function minutesText(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function shell(title: string, body: string): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${body}</div></div></main>`);
}

const sessionLine = (s: StaffSession) => `<li>${esc(clock(s.startedAt))} to ${s.endedAt ? `${esc(clock(s.endedAt))} (${minutesText(s.minutes ?? 0)})` : "now"}</li>`;

export async function renderMine(services: WorkHttpServices, actor: string, message: { kind: "success" | "error"; text: string } | null): Promise<string | undefined> {
  const today = await services.staffTime!.today(actor);
  if (today.kind === "refused") return undefined;
  const open = today.sessions.find((s) => s.endedAt === null);
  const closed = today.sessions.filter((s) => s.endedAt !== null).reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  const from = new Date(Date.parse(`${today.workDate}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  // Their own days only: an admin's unfiltered list would be everyone's.
  const recent = await services.staffTime!.days(actor, from, today.workDate, { staffId: actor });
  const action = open
    ? `<form method="post" action="/me/work/end"><p>You started at ${esc(clock(open.startedAt))}.</p><button class="p-button" type="submit">End my day</button></form>`
    : `<form method="post" action="/me/work/start"><button class="p-button" type="submit">Start my day</button></form>`;
  const list = today.sessions.length ? `<ul>${today.sessions.map(sessionLine).join("")}</ul><p>Today so far: ${minutesText(closed)}${open ? ", plus the session in progress" : ""}.</p>` : `<p>You haven't started today.</p>`;
  const days = recent.kind === "days" && recent.days.length
    ? `<ul>${recent.days.map((d) => `<li>${esc(longDate(d.workDate))}: ${d.open && d.sessions === 1 ? "not ended" : minutesText(d.minutes)}${d.open && d.sessions > 1 ? ", one session not ended" : ""}</li>`).join("")}</ul>`
    : `<p>No days in the last 30 days.</p>`;
  return shell("My work day", `${message ? notice(message.kind, message.text) : ""}<section class="p-card" aria-labelledby="today-heading"><h2 id="today-heading">${esc(longDate(today.workDate))}</h2>${list}${action}</section>
<section class="p-card" aria-labelledby="recent-heading"><h2 id="recent-heading">Last 30 days</h2>${days}</section>`);
}

const DONE: Readonly<Record<string, string>> = { started: "Your day has started.", ended: "Your day has ended." };

/** Handles /me/work and /me/work/{start,end}; false for any other path. */
export async function handleMyWorkPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const match = MINE.exec(url.pathname);
  if (!match) return false;
  try {
    if (!services?.staffTime || !origin) { req.resume(); write(res, ...plain(503, "Work is unavailable", "Staff time isn't switched on here yet.")); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, "Sign in", "Sign in to time your day.")); return true; }
    const forbidden = () => write(res, ...plain(403, "Staff only", "Only StudentHub staff time their day here."));
    const action = match[1];
    if (req.method === "GET" && action === undefined) {
      const done = url.searchParams.get("done");
      const html = await renderMine(services, actor, done && DONE[done] ? { kind: "success", text: DONE[done]! } : null);
      if (html) write(res, 200, html); else forbidden();
      return true;
    }
    if (req.method !== "POST" || action === undefined) { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, "Request refused", "We could not verify this request.")); return true; }
    if (!(await readForm(req, [], 1024))) { write(res, ...plain(400, "Request not valid", "This form sends nothing.")); return true; }
    const result = action === "start" ? await services.staffTime.start(actor) : await services.staffTime.end(actor);
    if (result.kind === "started" || result.kind === "ended") { redirect(res, `/me/work?done=${result.kind}`); return true; }
    if (result.code === "forbidden") { forbidden(); return true; }
    const html = await renderMine(services, actor, { kind: "error", text: "There is no session in progress today. Start your day first." });
    if (html) write(res, 409, html); else forbidden();
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error) ?? plain(503, "Work is unavailable", "Something went wrong. Try again in a moment."))); else res.destroy();
  }
  return true;
}

function cursorText(c: StaffDayCursor): string { return `${c.workDate}~${encodeURIComponent(c.staffId)}`; }
function parseCursorText(value: string | null): StaffDayCursor | null | undefined {
  if (value === null || value === "") return null;
  const at = value.indexOf("~");
  if (at !== 10) return undefined;
  try { return { workDate: value.slice(0, 10), staffId: decodeURIComponent(value.slice(11)) }; } catch { return undefined; }
}

export async function renderStaffTime(services: WorkHttpServices, actor: string, query: URLSearchParams, now: Date): Promise<{ status: number; html: string }> {
  const today = kuwaitDate(now);
  const from = query.get("from") || `${today.slice(0, 7)}-01`, to = query.get("to") || today;
  const staffId = query.get("staff") || undefined;
  const after = parseCursorText(query.get("after"));
  const inactiveDate = query.get("inactive") || today;
  if (after === undefined) return { status: 400, ...{ html: plain(400, "Filters not valid", "That page link is broken. Start again from the first page.")[1] } };
  const [page, inactive] = await Promise.all([
    services.staffTime!.days(actor, from, to, { ...(staffId ? { staffId } : {}), after }),
    services.staffTime!.inactive(actor, inactiveDate),
  ]);
  if (page.kind === "refused" && page.code === "forbidden" || inactive.kind === "refused" && inactive.code === "forbidden") return { status: 403, html: plain(403, "Admins only", "Only StudentHub admins see staff time.")[1] };
  if (page.kind === "refused" || inactive.kind === "refused") return { status: 400, html: plain(400, "Filters not valid", "Choose a date range of at most a year and a real date.")[1] };
  const ids = new Set([...page.days.map((d) => d.staffId), ...inactive.staffIds]);
  const names = ids.size && services.personNames ? await services.personNames([...ids]) : new Map<string, string>();
  const who = (id: string) => esc(names.get(id) ?? id);
  const row = (d: StaffDay) => `<tr><td>${who(d.staffId)}</td><td>${esc(d.workDate)}</td><td>${esc(clock(d.firstStart))}</td><td>${d.lastEnd ? esc(clock(d.lastEnd)) : ""}</td><td>${minutesText(d.minutes)}</td><td>${d.open ? "Not ended" : "Ended"}</td></tr>`;
  const filter = `<form method="get" action="${ADMIN}" class="p-card" aria-label="Filter"><label>From<input type="date" name="from" value="${esc(from)}" required></label><label>To<input type="date" name="to" value="${esc(to)}" required></label><label>Staff member's StudentHub ID (optional)<input name="staff" value="${esc(staffId ?? "")}" maxlength="200"></label><input type="hidden" name="inactive" value="${esc(inactiveDate)}"><button type="submit">Show</button></form>`;
  const table = page.days.length === 0 ? `<div class="p-empty"><p>No staff time in this range.</p></div>`
    : `<table><caption>Staff days</caption><thead><tr><th scope="col">Staff member</th><th scope="col">Date</th><th scope="col">Started</th><th scope="col">Ended</th><th scope="col">Time</th><th scope="col">Day</th></tr></thead><tbody>${page.days.map(row).join("")}</tbody></table>`;
  const more = page.next ? `<nav class="p-card"><a href="${ADMIN}?${esc(new URLSearchParams({ from, to, ...(staffId ? { staff: staffId } : {}), inactive: inactiveDate, after: cursorText(page.next) }).toString())}">More days</a></nav>` : "";
  const absent = `<section class="p-card" aria-labelledby="inactive-heading"><h2 id="inactive-heading">Not started on ${esc(longDate(inactive.workDate))}</h2>
<form method="get" action="${ADMIN}" aria-label="Date"><input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="to" value="${esc(to)}"><label>Date<input type="date" name="inactive" value="${esc(inactive.workDate)}" required></label><button type="submit">Show</button></form>
${inactive.staffIds.length ? `<ul>${inactive.staffIds.map((id) => `<li>${who(id)}</li>`).join("")}</ul>` : "<p>Every staff member started that day.</p>"}</section>`;
  return { status: 200, html: shell("Staff time", `${filter}<section class="p-card">${table}</section>${more}${absent}`) };
}

/** Handles /work/staff-time; false for any other path. */
export async function handleStaffTimePages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  if (url.pathname !== ADMIN) return false;
  try {
    if (!services?.staffTime) { req.resume(); write(res, ...plain(503, "Work is unavailable", "Staff time isn't switched on here yet.")); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, "Sign in", "Sign in to see staff time.")); return true; }
    if (req.method !== "GET") { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
    const { status, html } = await renderStaffTime(services, actor, url.searchParams, now());
    write(res, status, html);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error) ?? plain(503, "Work is unavailable", "Something went wrong. Try again in a moment."))); else res.destroy();
  }
  return true;
}
