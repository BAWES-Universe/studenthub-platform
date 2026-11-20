import type { IncomingMessage, ServerResponse } from "node:http";
import type { StatisticsPage } from "../../../../packages/reports/src/statistics.js";
import type { FiringHitMap } from "../../../../packages/reports/src/firing-hit-map.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * GET /workspace/statistics: the staff statistics page (contract P-3, slice 1), for StudentHub
 * staff only. Everyone else gets the same not found, whatever the method. A counter whose
 * source has not landed shows "Not available" and what it waits on, never 0.
 * GET /workspace/statistics/firings: the firing hit map (slice 3), same rules.
 */
export interface StatisticsHttpService {
  page(viewer: string): Promise<StatisticsPage | undefined>;
  firingHitMap?(viewer: string): Promise<FiringHitMap | undefined>;
}

export const STATISTICS_PATH = "/workspace/statistics";
export const FIRING_HIT_MAP_PATH = "/workspace/statistics/firings";
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
    + `<p><a href="${FIRING_HIT_MAP_PATH}">Placements ended per company, last 12 months</a></p></main>`;
}

const LEVEL = { danger: "more than twice the average", warning: "more than the average" } as const;
function firingsHtml(map: FiringHitMap): string {
  const head = map.months.map(m => `<th scope="col">${esc(m)}</th>`).join("");
  const rows = map.companies.map(c => `<tr><th scope="row">${esc(c.name)}</th>${c.cells.map(cell => cell.level
    ? `<td class="${cell.level}"><strong>${cell.total}</strong> <small>(${LEVEL[cell.level]})</small></td>` : `<td>${cell.total}</td>`).join("")}<td>${c.total}</td><td>${c.average}</td></tr>`).join("");
  return `<main><h1>Placements ended per company</h1><p>Placements that ended in each of the last 12 months, newest first, counted from the records as of ${esc(map.day)} (Kuwait time). `
    + `Sub-companies count under their company. A month is marked when it has more than the company's 12-month average, or more than twice it.</p>`
    + (map.companies.length ? `<table><thead><tr><th scope="col">Company</th>${head}<th scope="col">12 months</th><th scope="col">Average a month</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No companies yet.</p>`)
    + `<p><a href="${STATISTICS_PATH}">Back to statistics</a></p></main>`;
}

/** Handles the statistics path; false for any other path. `viewer` is the signed-in person, if any. */
export async function handleStatistics(req: IncomingMessage, res: ServerResponse, service: StatisticsHttpService | undefined, path: string, viewer: () => Promise<string | undefined>,
  isStaff: (viewer: string) => Promise<boolean>): Promise<boolean> {
  if (path !== STATISTICS_PATH && path !== FIRING_HIT_MAP_PATH) return false;
  req.resume();
  const person = service ? await viewer() : undefined;
  // Authorization first: everyone who is not staff gets the same not found, whatever the method.
  let allowed = false; if (person) try { allowed = await isStaff(person); } catch { /* treated as not staff */ }
  if (!service || !person || !allowed) return notFound(req, res);
  if (path === FIRING_HIT_MAP_PATH && !service.firingHitMap) return notFound(req, res);
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  const page = path === STATISTICS_PATH ? await service.page(person) : await service.firingHitMap!(person);
  if (!page) return notFound(req, res);
  if (!wantsHtml(req.headers.accept)) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ status: "ok", ...page })); return true;
  }
  if (path === STATISTICS_PATH) writeHtml(res, 200, pageDocument("Statistics", html(page as StatisticsPage)), { "cache-control": "no-store" });
  else writeHtml(res, 200, pageDocument("Placements ended per company", firingsHtml(page as FiringHitMap)), { "cache-control": "no-store" });
  return true;
}
