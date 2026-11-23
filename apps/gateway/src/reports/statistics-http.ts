import type { IncomingMessage, ServerResponse } from "node:http";
import type { StatisticsPage } from "../../../../packages/reports/src/statistics.js";
import type { FiringHitMap } from "../../../../packages/reports/src/firing-hit-map.js";
import { RECRUITER_ACTIVITY_COLUMNS, RECRUITER_ACTIVITY_MAX_DAYS, type RecruiterActivityPage, type RecruiterActivityRange, type rangeProblem } from "../../../../packages/reports/src/recruiter-activity.js";
import type { OperationsPage } from "../../../../packages/reports/src/operations.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * GET /workspace/statistics: the staff statistics page (contract P-3, slice 1), for StudentHub
 * staff only. Everyone else gets the same not found, whatever the method. A counter whose
 * source has not landed shows "Not available" and what it waits on, never 0.
 * GET /workspace/statistics/firings: the firing hit map (slice 3), same rules. POST there with
 * `email=on|off` (same origin only) turns the spike email (slice 4) on or off for the viewer.
 */
export interface StatisticsHttpService {
  page(viewer: string): Promise<StatisticsPage | undefined>;
  firingHitMap?(viewer: string): Promise<(FiringHitMap & { readonly spikeEmail?: boolean | null }) | undefined>;
  /** False when the viewer may not, or the email is not wired. */
  firingSpikeEmail?(viewer: string, on: boolean): Promise<boolean>;
  /** Slice 6: what each staff member recorded over a range of Kuwait days. */
  /** A-24: today's operations, the entry to every operational report. */
  operations?(viewer: string): Promise<OperationsPage | undefined>;
  recruiters?(viewer: string, range: RecruiterActivityRange): Promise<RecruiterActivityPage | { readonly refused: ReturnType<typeof rangeProblem> } | undefined>;
}

export const STATISTICS_PATH = "/workspace/statistics";
export const FIRING_HIT_MAP_PATH = "/workspace/statistics/firings";
export const RECRUITERS_PATH = "/workspace/statistics/recruiters";
export const OPERATIONS_PATH = "/reports/operations";
// Pages this one links to, served by their own handlers.
const MORNING_SUMMARY_PATH = "/workspace/morning-summary", ID_CARDS_PATH = "/workspace/id-cards", STANDUP_PATH = "/work/standup", STAFF_TIME_PATH = "/work/staff-time";
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function notFound(req: IncomingMessage, res: ServerResponse): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, 404, pageDocument("Not found", `<main><h1>Not found</h1><p>The page could not be found.</p></main>`), { "cache-control": "no-store" }); return true; }
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ status: "not_found" })); return true;
}
const ratio = (n: number | null) => n === null ? "Not available (nothing to divide by)" : `${n}%`;

function html(page: StatisticsPage): string {
  const table = (rows: StatisticsPage["counters"], head: string) => `<table><thead><tr><th>What</th><th>${head}</th></tr></thead><tbody>${rows.map(c => `<tr><td>${esc(c.label)}</td><td>${c.value === null ? `Not available <small>(waits on ${esc(c.waitsOn ?? "")})</small>` : esc(String(c.value))}</td></tr>`).join("")}</tbody></table>`;
  const h = page.hiring;
  const hiring: [string, string][] = [["Hired (store assignments)", String(h.hired)], ["Retained more than a year", String(h.retained)], ["Retention ratio", ratio(h.retentionRatio)],
    ["Invitations sent", String(h.invitations)], ["Recruitment yield (hires per 100 invitations)", ratio(h.recruitmentYield)]];
  return `<main><h1>Statistics</h1><p>Counted from the records as of ${esc(page.day)} (Kuwait time).</p>`
    + `<h2>Needs attention</h2>${table(page.counters, "Count")}`
    + `<h2>Hiring</h2><dl>${hiring.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`
    + `<p>An assignment counts as retained once it has lasted more than 365 days, including one that is still running.</p>`
    + `<h2>Overview</h2>${table(page.overview, "Total")}`
    + invitationsHtml(page.invitationsByMonth)
    + emailsHtml(page.emailsByDay, page.emailThreshold)
    + `<p><a href="${FIRING_HIT_MAP_PATH}">Placements ended per company, last 12 months</a></p>`
    + `<p><a href="${RECRUITERS_PATH}">What each staff member did today</a></p></main>`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => { const [y, n] = m.split("-"); return `${MONTH_NAMES[Number(n) - 1] ?? m} ${y}`; };
const rate = (n: number | null) => n === null ? "–" : `${n}%`;
function invitationsHtml(months: StatisticsPage["invitationsByMonth"]): string {
  const most = Math.max(1, ...months.map(m => m.total));
  const rows = months.map(m => `<tr><th scope="row">${esc(monthName(m.month))}</th><td><meter min="0" max="${most}" value="${m.total}"></meter> ${m.total}</td>`
    + `<td>${m.noAnswer}</td><td>${m.accepted}</td><td>${m.declined}</td><td>${m.withdrawn}</td><td>${rate(m.acceptanceRate)}</td><td>${rate(m.declineRate)}</td></tr>`).join("");
  return `<h2>Invitations by month</h2><p>Invitations sent in each of the last 12 whole months (Kuwait time), oldest first, and how each one stands now.</p>`
    + `<table><thead><tr><th scope="col">Month</th><th scope="col">Sent</th><th scope="col">No answer yet</th><th scope="col">Accepted</th><th scope="col">Declined</th>`
    + `<th scope="col">Withdrawn</th><th scope="col">Acceptance rate</th><th scope="col">Decline rate</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function emailsHtml(days: StatisticsPage["emailsByDay"], threshold: number): string {
  const most = Math.max(1, ...days.map(d => d.sent));
  const rows = days.map(d => `<tr><th scope="row">${esc(d.day)}</th><td><meter min="0" max="${most}" high="${threshold}" value="${d.sent}"></meter> ${d.sent}${d.overThreshold ? ` <strong>(over ${threshold})</strong>` : ""}</td><td>${d.failed}</td></tr>`).join("");
  return `<h2>Emails sent per day</h2><p>Emails sent in each of the last ${days.length} days (Kuwait time), oldest first. Past ${threshold} in a day, the daily volume alert goes out.</p>`
    + `<table><thead><tr><th scope="col">Day</th><th scope="col">Sent</th><th scope="col">Failed attempts</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const LEVEL = { danger: "more than twice the average", warning: "more than the average" } as const;
function firingsHtml(map: FiringHitMap & { readonly spikeEmail?: boolean | null }): string {
  const toggle = typeof map.spikeEmail === "boolean" ? `<form method="post" action="${FIRING_HIT_MAP_PATH}"><input type="hidden" name="email" value="${map.spikeEmail ? "off" : "on"}"><p>${map.spikeEmail
    ? "You get an email when a company's month is marked, once per company and month (checked every morning at 8:00)." : "You do not get an email when a company's month is marked."}</p><button type="submit">${map.spikeEmail ? "Stop the spike emails" : "Email me when a company spikes"}</button></form>` : "";
  const head = map.months.map(m => `<th scope="col">${esc(m)}</th>`).join("");
  const rows = map.companies.map(c => `<tr><th scope="row">${esc(c.name)}</th>${c.cells.map(cell => cell.level
    ? `<td class="${cell.level}"><strong>${cell.total}</strong> <small>(${LEVEL[cell.level]})</small></td>` : `<td>${cell.total}</td>`).join("")}<td>${c.total}</td><td>${c.average}</td></tr>`).join("");
  return `<main><h1>Placements ended per company</h1><p>Placements that ended in each of the last 12 months, newest first, counted from the records as of ${esc(map.day)} (Kuwait time). `
    + `Sub-companies count under their company. A month is marked when it has more than the company's 12-month average, or more than twice it.</p>`
    + (map.companies.length ? `<table><thead><tr><th scope="col">Company</th>${head}<th scope="col">12 months</th><th scope="col">Average a month</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No companies yet.</p>`)
    + toggle + `<p><a href="${STATISTICS_PATH}">Back to statistics</a></p></main>`;
}

const REFUSED = { from: "The start is not a real day.", to: "The end is not a real day, or is after today.", order: "The start is after the end.",
  too_long: `The range is longer than ${RECRUITER_ACTIVITY_MAX_DAYS} days.` } as const;
function recruitersForm(from: string, to: string, today: string): string {
  return `<form method="get" action="${RECRUITERS_PATH}"><label>From <input type="date" name="from" value="${esc(from)}" max="${esc(today)}" required></label> `
    + `<label>To <input type="date" name="to" value="${esc(to)}" max="${esc(today)}" required></label> <button type="submit">Show</button></form>`;
}
function recruitersHtml(page: RecruiterActivityPage): string {
  const head = RECRUITER_ACTIVITY_COLUMNS.map(c => `<th scope="col">${esc(c.label)}</th>`).join("");
  const rows = page.staff.map(r => `<tr><th scope="row">${esc(r.name)}</th>${RECRUITER_ACTIVITY_COLUMNS.map(c => `<td>${r[c.key]}</td>`).join("")}</tr>`).join("");
  const range = page.from === page.to ? (page.to === page.today ? `today, ${esc(page.to)}` : esc(page.to)) : `${esc(page.from)} to ${esc(page.to)}`;
  return `<main><h1>What each staff member did</h1><p>Counted from the records for ${range} (Kuwait days), busiest first. Each count goes to the person who recorded it, `
    + `on the day it was recorded. Accepted and declined are the invitations sent in the range, as they stand now.</p>${recruitersForm(page.from, page.to, page.today)}`
    + (page.staff.length ? `<table><thead><tr><th scope="col">Staff</th>${head}</tr></thead><tbody>${rows}</tbody>`
      + `<tfoot><tr><th scope="row">All staff</th>${RECRUITER_ACTIVITY_COLUMNS.map(c => `<td>${page.totals[c.key]}</td>`).join("")}</tr></tfoot></table>` : `<p>No staff yet.</p>`)
    + `<p><a href="${STATISTICS_PATH}">Back to statistics</a></p></main>`;
}
/** The range asked for: each of from and to at most once, nothing else. Null when the query has anything else. */
function rangeOf(req: IncomingMessage): RecruiterActivityRange | null {
  const params = new URL(req.url ?? "/", "http://gateway.invalid").searchParams, keys = [...params.keys()];
  if (keys.some(k => k !== "from" && k !== "to") || new Set(keys).size !== keys.length) return null;
  return { from: params.get("from"), to: params.get("to") };
}

function operationsHtml(page: OperationsPage): string {
  const attention = page.attention.map(r => `<tr><td>${esc(r.label)}</td><td>${r.value === null ? `Not available <small>(waits on ${esc(r.waitsOn ?? "")})</small>` : esc(String(r.value))}</td></tr>`).join("");
  const team = RECRUITER_ACTIVITY_COLUMNS.map(c => `<tr><td>${esc(c.label)}</td><td>${page.team.totals[c.key]}</td></tr>`).join("");
  // Standup and staff time admit operator admins only, so only they get those links.
  const admin: [string, string, string][] = page.operatorAdmin ? [
    [STANDUP_PATH, "Standup", "today's answers, and the questions"],
    [STAFF_TIME_PATH, "Staff time", "every staff member's work sessions and hours, and who has not started"],
  ] : [];
  const links: [string, string, string][] = [
    [MORNING_SUMMARY_PATH, "Morning summary", "the counters above, and the 8:00 email"],
    [RECRUITERS_PATH, "What each staff member did", "productivity per person, today or any range"],
    ...admin,
    [`${ID_CARDS_PATH}?view=needs`, "Assigned without an ID card", "people placed at a store who have no card"],
    [`${ID_CARDS_PATH}?view=expired`, "Assigned with an expired ID card", "cards to renew"],
    [STATISTICS_PATH, "Statistics", "dashboard counters, hiring, invitations and emails"],
    [FIRING_HIT_MAP_PATH, "Placements ended per company", "the firing hit map"],
  ];
  return `<main><h1>Operations</h1><p>Today, ${esc(page.day)} (Kuwait time).</p>`
    + `<h2>Needs attention</h2><table><thead><tr><th>What</th><th>Count</th></tr></thead><tbody>${attention}</tbody></table>`
    + `<h2>The team today</h2><p>${page.team.staff} staff.</p><table><thead><tr><th>What</th><th>Today</th></tr></thead><tbody>${team}</tbody></table>`
    + `<h2>Reports</h2><ul>${links.map(([href, label, what]) => `<li><a href="${esc(href)}">${esc(label)}</a>: ${esc(what)}</li>`).join("")}</ul></main>`;
}

const LIMIT = 1024;
async function emailChoice(req: IncomingMessage): Promise<"on" | "off" | null> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return null; }
  req.setEncoding("utf8"); let raw = "";
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > LIMIT) return null; }
  const params = new URLSearchParams(raw), keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== "email") return null;
  const email = params.get("email");
  return email === "on" || email === "off" ? email : null;
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body)); return true;
}

/** Handles the statistics paths; false for any other path. `viewer` is the signed-in person, if any; `origin` is this gateway's, for the email form. */
export async function handleStatistics(req: IncomingMessage, res: ServerResponse, service: StatisticsHttpService | undefined, path: string, viewer: () => Promise<string | undefined>,
  isStaff: (viewer: string) => Promise<boolean>, origin?: string): Promise<boolean> {
  if (path !== STATISTICS_PATH && path !== FIRING_HIT_MAP_PATH && path !== RECRUITERS_PATH && path !== OPERATIONS_PATH) return false;
  const posting = req.method === "POST" && path === FIRING_HIT_MAP_PATH;
  if (!posting) req.resume();
  const person = service ? await viewer() : undefined;
  // Authorization first: everyone who is not staff gets the same not found, whatever the method.
  let allowed = false; if (person) try { allowed = await isStaff(person); } catch { /* treated as not staff */ }
  if (!service || !person || !allowed || (path === FIRING_HIT_MAP_PATH && !service.firingHitMap) || (path === RECRUITERS_PATH && !service.recruiters) || (path === OPERATIONS_PATH && !service.operations)) { if (posting) req.resume(); return notFound(req, res); }
  if (posting) {
    if (!service.firingSpikeEmail) { req.resume(); res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    if (!req.headers.origin || !origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); return json(res, 403, { status: "forbidden" }); }
    const email = await emailChoice(req);
    if (!email) return json(res, 400, { status: "invalid", field: "email" });
    if (!(await service.firingSpikeEmail(person, email === "on"))) return notFound(req, res);
    if (wantsHtml(req.headers.accept)) { res.writeHead(303, { location: FIRING_HIT_MAP_PATH, "cache-control": "no-store" }); res.end(); return true; }
    return json(res, 200, { status: "ok", spikeEmail: email === "on" });
  }
  if (req.method !== "GET") { res.writeHead(405, { allow: path === FIRING_HIT_MAP_PATH && service.firingSpikeEmail ? "GET, POST" : "GET" }); res.end(); return true; }
  if (path === OPERATIONS_PATH) {
    const page = await service.operations!(person);
    if (!page) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", ...page });
    writeHtml(res, 200, pageDocument("Operations", operationsHtml(page)), { "cache-control": "no-store" });
    return true;
  }
  if (path === RECRUITERS_PATH) {
    const range = rangeOf(req);
    const page = range && await service.recruiters!(person, range);
    if (range && !page) return notFound(req, res);
    if (!page || "refused" in page) {
      const field = page && "refused" in page ? page.refused : null;
      if (!wantsHtml(req.headers.accept)) return json(res, 400, { status: "invalid", field: field ?? "query" });
      writeHtml(res, 400, pageDocument("What each staff member did", `<main><h1>What each staff member did</h1><p role="alert">${field ? REFUSED[field] : "Only a start and an end day can be given."}</p>`
        + `<p><a href="${RECRUITERS_PATH}">Show today</a></p></main>`), { "cache-control": "no-store" });
      return true;
    }
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", ...page });
    writeHtml(res, 200, pageDocument("What each staff member did", recruitersHtml(page)), { "cache-control": "no-store" });
    return true;
  }
  const page = path === STATISTICS_PATH ? await service.page(person) : await service.firingHitMap!(person);
  if (!page) return notFound(req, res);
  if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", ...page });
  if (path === STATISTICS_PATH) writeHtml(res, 200, pageDocument("Statistics", html(page as StatisticsPage)), { "cache-control": "no-store" });
  else writeHtml(res, 200, pageDocument("Placements ended per company", firingsHtml(page as FiringHitMap)), { "cache-control": "no-store" });
  return true;
}
