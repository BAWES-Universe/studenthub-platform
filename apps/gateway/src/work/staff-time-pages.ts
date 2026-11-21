// Internal staff time screens (legacy staff_work_session):
// - /me/work: a staff member starts and ends their day and answers the
//   stand-up (standup-pages.ts) while it is in progress (the session and
//   stand-up parts of A-14; leave and expenses wait on the pay lane);
// - /work/staff-time: operator admins see every staff member's days over a
//   range and who has not started on a date (legacy admin list and
//   list-inactive).
// Same pattern as the other work screens: server-rendered, same-origin form
// posts, the actor from the session cookie, every rule in StaffTimeService.

import type { IncomingMessage, ServerResponse } from "node:http";
import { kuwaitDate, type StaffDay, type StaffDayCursor, type StaffSession } from "../../../../packages/work/src/index.js";
import type { WorkHttpServices } from "./http.js";
import { docLanguage, esc, notice, plain, readForm, redirect, sessionCookie, tooLarge, write } from "./pages.js";
import { pageDocument } from "../web-ui.js";
import { standupCard, standupRefused, STANDUP_FORM_LIMIT, STANDUP_PAGE } from "./standup-pages.js";
import { WORK_COPY, workCopyFor, type WorkCopy } from "./copy.js";
import { teamCopy } from "./team-copy.js";

const MINE = /^\/me\/work(?:\/(start|end|standup))?$/;
const ADMIN = "/work/staff-time";

/** Legacy showed minutes and hours to three places; "2h 05m" reads better and keeps the minutes. */
export function minutesText(minutes: number, c: WorkCopy = WORK_COPY.en): string {
  return teamCopy(c).staffTime.minutes(minutes);
}

function shell(title: string, body: string, c: WorkCopy): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${body}</div></div></main>`, docLanguage(c));
}

const sessionLine = (s: StaffSession, c: WorkCopy) =>
  `<li>${esc(teamCopy(c).staffTime.session(c.clock(s.startedAt), s.endedAt ? c.clock(s.endedAt) : null, s.endedAt ? minutesText(s.minutes ?? 0, c) : null))}</li>`;

export async function renderMine(services: WorkHttpServices, actor: string, message: { kind: "success" | "error"; text: string } | null, c: WorkCopy = WORK_COPY.en): Promise<string | undefined> {
  const t = teamCopy(c).staffTime;
  const today = await services.staffTime!.today(actor);
  if (today.kind === "refused") return undefined;
  const open = today.sessions.find((s) => s.endedAt === null);
  const closed = today.sessions.filter((s) => s.endedAt !== null).reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  const from = new Date(Date.parse(`${today.workDate}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  // Their own days only: an admin's unfiltered list would be everyone's.
  const recent = await services.staffTime!.days(actor, from, today.workDate, { staffId: actor });
  const action = open
    ? `<form method="post" action="/me/work/end"><p>${esc(t.startedAt(c.clock(open.startedAt)))}</p><button class="p-button" type="submit">${esc(t.endDay)}</button></form>`
    : `<form method="post" action="/me/work/start"><button class="p-button" type="submit">${esc(t.startDay)}</button></form>`;
  const list = today.sessions.length ? `<ul>${today.sessions.map((s) => sessionLine(s, c)).join("")}</ul><p>${esc(t.soFar(minutesText(closed, c), open !== undefined))}</p>` : `<p>${esc(t.notStarted)}</p>`;
  const days = recent.kind === "days" && recent.days.length
    ? `<ul>${recent.days.map((d) => `<li>${esc(t.dayLine(c.longDate(d.workDate), d.open && d.sessions === 1 ? null : minutesText(d.minutes, c), d.open && d.sessions > 1))}</li>`).join("")}</ul>`
    : `<p>${esc(t.noDays)}</p>`;
  const standup = await standupCard(services, actor, open !== undefined, c);
  return shell(t.mineTitle, `${message ? notice(message.kind, message.text) : ""}<section class="p-card" aria-labelledby="today-heading"><h2 id="today-heading">${esc(c.longDate(today.workDate))}</h2>${list}${action}</section>
${standup}<section class="p-card" aria-labelledby="recent-heading"><h2 id="recent-heading">${esc(t.recent)}</h2>${days}</section>`, c);
}

/** Handles /me/work and /me/work/{start,end}; false for any other path. */
export async function handleMyWorkPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const match = MINE.exec(url.pathname);
  if (!match) return false;
  // The browser's language until the actor is known, then theirs.
  let c = await workCopyFor(undefined, undefined, req);
  let t = teamCopy(c);
  try {
    if (!services?.staffTime || !origin) { req.resume(); write(res, ...plain(503, t.common.unavailable[0], t.staffTime.off, c)); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, t.common.signIn, t.staffTime.signInMine, c)); return true; }
    c = await workCopyFor(services.language, actor, req);
    t = teamCopy(c);
    const forbidden = () => write(res, ...plain(403, ...t.staffTime.staffOnly, c));
    const action = match[1];
    if (req.method === "GET" && action === undefined) {
      const done = url.searchParams.get("done");
      const html = await renderMine(services, actor, done && t.staffTime.done[done] ? { kind: "success", text: t.staffTime.done[done]! } : null, c);
      if (html) write(res, 200, html); else forbidden();
      return true;
    }
    if (req.method !== "POST" || action === undefined) { req.resume(); write(res, ...plain(405, ...t.common.notAllowed, c)); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, ...t.common.refused, c)); return true; }
    if (action === "standup") {
      if (!services.standup) { req.resume(); write(res, ...plain(503, t.common.unavailable[0], t.standup.off, c)); return true; }
      const form = await readForm(req, ["question", "answer"], STANDUP_FORM_LIMIT);
      if (!form) { write(res, ...plain(400, ...t.staffTime.badForm, c)); return true; }
      const answered = await services.standup.answer(actor, form.question, form.answer);
      if (answered.kind === "answered") { redirect(res, "/me/work?done=answered"); return true; }
      if (answered.code === "forbidden") { forbidden(); return true; }
      const html = await renderMine(services, actor, { kind: "error", text: standupRefused(answered.code, c) ?? t.staffTime.answerNotSaved }, c);
      if (html) write(res, answered.code === "invalid_input" ? 400 : 409, html); else forbidden();
      return true;
    }
    if (!(await readForm(req, [], 1024))) { write(res, ...plain(400, ...t.staffTime.emptyForm, c)); return true; }
    const result = action === "start" ? await services.staffTime.start(actor) : await services.staffTime.end(actor);
    if (result.kind === "started" || result.kind === "ended") { redirect(res, `/me/work?done=${result.kind}`); return true; }
    if (result.code === "forbidden") { forbidden(); return true; }
    const html = await renderMine(services, actor, { kind: "error", text: t.staffTime.noSession }, c);
    if (html) write(res, 409, html); else forbidden();
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error, c) ?? plain(503, ...t.common.unavailable, c))); else res.destroy();
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

export async function renderStaffTime(services: WorkHttpServices, actor: string, query: URLSearchParams, now: Date, c: WorkCopy = WORK_COPY.en): Promise<{ status: number; html: string }> {
  const tc = teamCopy(c), t = tc.staffTime;
  const today = kuwaitDate(now);
  const from = query.get("from") || `${today.slice(0, 7)}-01`, to = query.get("to") || today;
  const staffId = query.get("staff") || undefined;
  const after = parseCursorText(query.get("after"));
  const inactiveDate = query.get("inactive") || today;
  if (after === undefined) return { status: 400, ...{ html: plain(400, ...t.brokenLink, c)[1] } };
  const [page, inactive] = await Promise.all([
    services.staffTime!.days(actor, from, to, { ...(staffId ? { staffId } : {}), after }),
    services.staffTime!.inactive(actor, inactiveDate),
  ]);
  if (page.kind === "refused" && page.code === "forbidden" || inactive.kind === "refused" && inactive.code === "forbidden") return { status: 403, html: plain(403, ...t.adminsOnly, c)[1] };
  if (page.kind === "refused" || inactive.kind === "refused") return { status: 400, html: plain(400, ...t.badFilters, c)[1] };
  const ids = new Set([...page.days.map((d) => d.staffId), ...inactive.staffIds]);
  const names = ids.size && services.personNames ? await services.personNames([...ids]) : new Map<string, string>();
  const who = (id: string) => esc(names.get(id) ?? id);
  const row = (d: StaffDay) => `<tr><td>${who(d.staffId)}</td><td>${esc(d.workDate)}</td><td>${esc(c.clock(d.firstStart))}</td><td>${d.lastEnd ? esc(c.clock(d.lastEnd)) : ""}</td><td>${esc(minutesText(d.minutes, c))}</td><td>${esc(d.open ? t.notEnded : t.ended)}</td></tr>`;
  const filter = `<form method="get" action="${ADMIN}" class="p-card" aria-label="${esc(tc.common.filter)}"><label>${esc(tc.common.from)}<input type="date" name="from" value="${esc(from)}" required></label><label>${esc(tc.common.to)}<input type="date" name="to" value="${esc(to)}" required></label><label>${esc(t.staffIdOptional)}<input name="staff" value="${esc(staffId ?? "")}" maxlength="200"></label><input type="hidden" name="inactive" value="${esc(inactiveDate)}"><button type="submit">${esc(tc.common.show)}</button></form>`;
  const table = page.days.length === 0 ? `<div class="p-empty"><p>${esc(t.none)}</p></div>`
    : `<table><caption>${esc(t.caption)}</caption><thead><tr>${t.columns.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${page.days.map(row).join("")}</tbody></table>`;
  const more = page.next ? `<nav class="p-card"><a href="${ADMIN}?${esc(new URLSearchParams({ from, to, ...(staffId ? { staff: staffId } : {}), inactive: inactiveDate, after: cursorText(page.next) }).toString())}">${esc(t.more)}</a></nav>` : "";
  const absent = `<section class="p-card" aria-labelledby="inactive-heading"><h2 id="inactive-heading">${esc(t.notStartedOn(c.longDate(inactive.workDate)))}</h2>
<form method="get" action="${ADMIN}" aria-label="${esc(t.date)}"><input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="to" value="${esc(to)}"><label>${esc(t.date)}<input type="date" name="inactive" value="${esc(inactive.workDate)}" required></label><button type="submit">${esc(tc.common.show)}</button></form>
${inactive.staffIds.length ? `<ul>${inactive.staffIds.map((id) => `<li>${who(id)}</li>`).join("")}</ul>` : `<p>${esc(t.everyoneStarted)}</p>`}</section>`;
  // The export (legacy download-list-excel) posts to the shared export route with these filters.
  const exportQuery = new URLSearchParams({ from, to, ...(staffId ? { staff: staffId } : {}) }).toString();
  const exportForm = `<form method="post" action="/exports/work-staff-sessions?${esc(exportQuery)}" class="p-card" aria-label="${esc(t.exportLabel)}"><button type="submit">${esc(t.exportButton)}</button></form>`;
  const standup = services.standup ? `<nav class="p-card"><a href="${STANDUP_PAGE}?date=${esc(inactive.workDate)}">${esc(t.standupLink)}</a></nav>` : "";
  return { status: 200, html: shell(t.adminTitle, `${filter}${exportForm}<section class="p-card">${table}</section>${more}${absent}${standup}`, c) };
}

/** Handles /work/staff-time; false for any other path. */
export async function handleStaffTimePages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  if (url.pathname !== ADMIN) return false;
  let c = await workCopyFor(undefined, undefined, req);
  let t = teamCopy(c);
  try {
    if (!services?.staffTime) { req.resume(); write(res, ...plain(503, t.common.unavailable[0], t.staffTime.off, c)); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, t.common.signIn, t.staffTime.signInAdmin, c)); return true; }
    c = await workCopyFor(services.language, actor, req);
    t = teamCopy(c);
    if (req.method !== "GET") { req.resume(); write(res, ...plain(405, ...t.common.notAllowed, c)); return true; }
    const { status, html } = await renderStaffTime(services, actor, url.searchParams, now(), c);
    write(res, status, html);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error, c) ?? plain(503, ...t.common.unavailable, c))); else res.destroy();
  }
  return true;
}
