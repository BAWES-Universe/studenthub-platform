import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { PayHistoryDetail, PayHistoryPage } from "@studenthub/db/billing";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * F4.9 own pay history (legacy candidate `AccountController::actionSalary` and `actionSalaryDetail`).
 *
 * GET /pay lists the signed-in person's paid pay lines, newest first, ten to a page (`?page=n`).
 * GET /pay/<lineId> is one of them. Each person reads only their own lines; anyone else's line,
 * an unpaid one and a missing one are the same not found. Only the candidate's side is shown.
 */
export interface PayHistoryReads {
  list(personId: string, page: number): Promise<PayHistoryPage>;
  detail(personId: string, lineId: string): Promise<PayHistoryDetail | null>;
}
export interface PayHistoryHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  list(viewer: string, page: number): Promise<PayHistoryPage>;
  detail(viewer: string, lineId: string): Promise<PayHistoryDetail | null>;
}

export function createPayHistoryHttp(ports: { sessions: Pick<SessionStore, "get">; reads: PayHistoryReads }): PayHistoryHttp {
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    list: (viewer, page) => ports.reads.list(viewer, page),
    detail: (viewer, lineId) => ports.reads.detail(viewer, lineId),
  };
}

export const PAY_HISTORY_PATH = "/pay";
const LIST = /^\/pay\/?$/, DETAIL = /^\/pay\/([^/]+)$/;
const LINE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PAGE = /^[1-9][0-9]{0,5}$/;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function cookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("="); const value = parts.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body)); return true;
}
function reply(req: IncomingMessage, res: ServerResponse, status: number, error: string, title: string, message: string): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p></main>`), { "cache-control": "no-store" }); return true; }
  return json(res, status, { error });
}
const notFound = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 404, "not_found", "Not found", "The page could not be found.");
const period = (e: { periodStart: string; periodEnd: string }) => `${longDate(e.periodStart)} to ${longDate(e.periodEnd)}`;

function listHtml(page: PayHistoryPage): string {
  const rows = page.entries.map(e => `<tr><td>${esc(period(e))}</td><td>${esc(e.companyName)}</td><td>${esc(e.storeName)}</td>`
    + `<td>${esc(e.currencyCode)} ${esc(e.total)}</td><td>Paid</td><td><a href="${esc(`${PAY_HISTORY_PATH}/${encodeURIComponent(e.lineId)}`)}">Details</a></td></tr>`).join("");
  const nav = [page.page > 1 ? `<a href="${PAY_HISTORY_PATH}?page=${page.page - 1}">Newer</a>` : "", page.page < page.pageCount ? `<a href="${PAY_HISTORY_PATH}?page=${page.page + 1}">Older</a>` : ""]
    .filter(Boolean).join(" ");
  return `<main><h1>My pay</h1><p>Pay you have received, newest first.</p>${page.entries.length
    ? `<table><thead><tr><th>Period</th><th>Company</th><th>Store</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      + `<p>Page ${page.page} of ${page.pageCount}</p>${nav ? `<nav>${nav}</nav>` : ""}`
    : "<p>No pay has been received yet.</p>"}</main>`;
}
function detailHtml(d: PayHistoryDetail): string {
  const worked = d.worked ? `<dt>Hours worked</dt><dd>${esc(d.worked.hours)} h ${d.worked.minutes} min</dd><dt>Hourly rate</dt><dd>${esc(d.currencyCode)} ${esc(d.worked.hourlyRate)}</dd>` : "";
  return `<main><h1>Pay details</h1><dl><dt>Period</dt><dd>${esc(period(d))}</dd><dt>Company</dt><dd>${esc(d.companyName)}</dd><dt>Store</dt><dd>${esc(d.storeName)}</dd>`
    + `${worked}<dt>Amount</dt><dd>${esc(d.currencyCode)} ${esc(d.total)}</dd><dt>Status</dt><dd>Paid</dd></dl><p><a href="${PAY_HISTORY_PATH}">Back to my pay</a></p></main>`;
}

/** Handles the pay history paths; false for any other path. */
export async function handlePayHistory(req: IncomingMessage, res: ServerResponse, service: PayHistoryHttp | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  const list = LIST.test(url.pathname), detail = DETAIL.exec(url.pathname);
  if (!list && !detail) return false;
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "pay_history_unavailable", "Pay unavailable", "Your pay history is not available right now.");
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(cookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see your pay.");
    if (detail) {
      let lineId: string;
      try { lineId = decodeURIComponent(detail[1]!); } catch { return notFound(req, res); }
      if (!LINE_ID.test(lineId)) return notFound(req, res);
      const line = await service.detail(viewer, lineId);
      if (!line) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, line);
      writeHtml(res, 200, pageDocument("Pay details", detailHtml(line)), { "cache-control": "no-store" });
      return true;
    }
    const raw = url.searchParams.get("page");
    if (raw !== null && !PAGE.test(raw)) return notFound(req, res);
    const page = await service.list(viewer, raw === null ? 1 : Number(raw));
    if (!wantsHtml(req.headers.accept)) return json(res, 200, page);
    writeHtml(res, 200, pageDocument("My pay", listHtml(page)), { "cache-control": "no-store" });
    return true;
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "pay_history_unavailable", "Pay unavailable", "Your pay history is not available right now.");
    res.destroy(); return true;
  }
}
