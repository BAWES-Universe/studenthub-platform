import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { FINANCE_SETTLED_STATUSES, type FinanceSettledPage, type FinanceSettledStatus } from "@studenthub/db/billing";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { sessionCookie } from "../recruit/http-common.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";
import { BANK_RESULTS_PATH } from "./bank-results-http.js";
import { FINANCE_TRANSFERS_PATH } from "./finance-transfers-http.js";
import { INVOICES_PATH } from "./invoices-http.js";

/**
 * Finance settled (matrix A-20, F4). Read only.
 *
 * GET /finance/settled shows, for every company StudentHub Finance settles, its balance per currency (invoiced,
 * paid, credited and still owed, all time, from the same documents as the company's statement) and then the
 * transfer invoices themselves, newest first, 100 a page (`?page=N`), optionally of one status
 * (`?status=unpaid|paid|credited`). Each company links to its invoices page, which a central Finance user
 * opens as the void view.
 *
 * Only StudentHub's own finance users reach the page: the central gate and per-company settle rule of the
 * bank result files and Finance transfers. Everyone else, a company's own finance users included, gets not found.
 */
export const FINANCE_SETTLED_PATH = "/finance/settled";
export interface FinanceSettledReads {
  settled(principalId: string, filter: { status?: FinanceSettledStatus; page?: number }): Promise<FinanceSettledPage | null>;
}
export interface FinanceSettledHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  settled(viewer: string, filter: { status?: FinanceSettledStatus; page: number }): Promise<FinanceSettledPage | null>;
}

export function createFinanceSettledHttp(ports: { sessions: Pick<SessionStore, "get">; reads: FinanceSettledReads }): FinanceSettledHttp {
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    settled: (viewer, filter) => ports.reads.settled(viewer, filter),
  };
}

/** `page` absent is 1 and `status` absent is every invoice; any other parameter, or a value outside these, is undefined. */
export function settledFilterOf(query: URLSearchParams): { status?: FinanceSettledStatus; page: number } | undefined {
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length || keys.some((k) => k !== "page" && k !== "status")) return undefined;
  const rawPage = query.get("page"), rawStatus = query.get("status");
  if (rawPage !== null && !/^[1-9][0-9]{0,5}$/.test(rawPage)) return undefined;
  if (rawStatus !== null && !FINANCE_SETTLED_STATUSES.includes(rawStatus as FinanceSettledStatus)) return undefined;
  return { page: rawPage === null ? 1 : Number(rawPage), ...(rawStatus === null ? {} : { status: rawStatus as FinanceSettledStatus }) };
}

const STATUS_NAME: Readonly<Record<FinanceSettledStatus, string>> = { unpaid: "Unpaid", paid: "Paid", credited: "Credited" };
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const companyHref = (orgId: string) => `${INVOICES_PATH}/${encodeURIComponent(orgId)}`;
const pageHref = (filter: { status?: FinanceSettledStatus; page: number }) => {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.page > 1) q.set("page", String(filter.page));
  const s = q.toString();
  return s ? `${FINANCE_SETTLED_PATH}?${s}` : FINANCE_SETTLED_PATH;
};

function settledHtml(result: FinanceSettledPage, status: FinanceSettledStatus | undefined): string {
  const balances = result.balances.map((b) => `<tr><td><a href="${esc(companyHref(b.orgId))}">${esc(b.companyName)}</a></td><td>${esc(b.currencyCode)}</td>`
    + `<td>${esc(b.invoiced)}</td><td>${esc(b.paid)}</td><td>${esc(b.credited)}</td><td>${esc(b.outstanding)}</td></tr>`).join("");
  const filters = [`<a href="${FINANCE_SETTLED_PATH}"${status ? "" : ' aria-current="page"'}>All</a>`,
    ...FINANCE_SETTLED_STATUSES.map((s) => `<a href="${esc(pageHref({ status: s, page: 1 }))}"${status === s ? ' aria-current="page"' : ""}>${STATUS_NAME[s]}</a>`)].join(" · ");
  const invoices = result.invoices.map((i) => `<tr><td>${esc(i.invoiceNumber)}</td><td><a href="${esc(companyHref(i.orgId))}">${esc(i.companyName)}</a></td>`
    + `<td>${esc(longDate(i.invoiceDate))}</td><td>${esc(i.currencyCode)} ${esc(i.total)}</td><td>${i.creditNumber
      ? `Credited by credit note ${esc(i.creditNumber)}${i.creditedOn ? ` on ${esc(longDate(i.creditedOn))}` : ""}`
      : i.status === "paid" ? `Paid${i.paidOn ? ` on ${esc(longDate(i.paidOn))}` : ""}` : "Unpaid"}</td></tr>`).join("");
  const nav = [result.page > 1 ? `<a href="${esc(pageHref({ ...(status ? { status } : {}), page: result.page - 1 }))}">Newer</a>` : "",
    result.more ? `<a href="${esc(pageHref({ ...(status ? { status } : {}), page: result.page + 1 }))}">Older</a>` : ""].filter(Boolean).join(" ");
  return `<main><h1>Settled</h1><h2>Balances</h2><p>What each company has been invoiced, has paid and has been credited, and what it still owes, all time.</p>${result.balances.length
    ? `<table><thead><tr><th>Company</th><th>Currency</th><th>Invoiced</th><th>Paid</th><th>Credited</th><th>Still owed</th></tr></thead><tbody>${balances}</tbody></table>`
    : "<p>No company has been invoiced yet.</p>"}`
    + `<h2>Invoices</h2><p>Transfer invoices of every company, newest first.</p><p>${filters}</p>${result.invoices.length
    ? `<table><thead><tr><th>Invoice</th><th>Company</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${invoices}</tbody></table>`
    : "<p>No invoices here.</p>"}${nav ? `<p>${nav}</p>` : ""}`
    + `<p><a href="${FINANCE_TRANSFERS_PATH}">Transfers</a> · <a href="${BANK_RESULTS_PATH}">Bank result files</a></p></main>`;
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body)); return true;
}
function reply(req: IncomingMessage, res: ServerResponse, status: number, error: string, title: string, message: string): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p></main>`), { "cache-control": "no-store" }); return true; }
  return json(res, status, { error });
}
const notFound = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 404, "not_found", "Not found", "This page does not exist.");

export async function handleFinanceSettled(req: IncomingMessage, res: ServerResponse, service: FinanceSettledHttp | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid"), path = url.pathname;
  const page = path === FINANCE_SETTLED_PATH;
  if (!page && !path.startsWith(`${FINANCE_SETTLED_PATH}/`)) return false;
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "settled_unavailable", "Settled unavailable", "The settled view is not available right now.");
    if (!page) return notFound(req, res);
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(sessionCookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see the settled view.");
    const filter = settledFilterOf(url.searchParams);
    if (!filter) return notFound(req, res);
    const result = await service.settled(viewer, filter);
    if (!result) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
    writeHtml(res, 200, pageDocument("Settled", settledHtml(result, filter.status)), { "cache-control": "no-store" }); return true;
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "settled_unavailable", "Settled unavailable", "The settled view is not available right now.");
    res.destroy(); return true;
  }
}
