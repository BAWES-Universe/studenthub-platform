import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { FINANCE_TRANSFER_STATUSES, type CompanyTransferStatus, type FinanceTransferDetail, type FinanceTransferPage } from "@studenthub/db/billing";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { sessionCookie } from "../recruit/http-common.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";
import { BANK_RESULTS_PATH, transferIdOf } from "./bank-results-http.js";
import { TRANSFER_STATUS_NAME, transferStatus } from "./invoices-http.js";

/**
 * Finance transfers (matrix A-18; legacy admin `TransferController::actionList` and `actionView`). Read only.
 *
 * GET /finance/transfers lists the salary transfers of every company StudentHub Finance settles, newest period
 * first, 100 a page (`?page=N`), optionally of one status (`?status=locked`), each linking to its detail.
 * GET /finance/transfers/<id> shows the transfer and each line: person, store, what the person is paid, what
 * the company is billed, and whether the line is paid, with a link to the transfer's bank result record.
 *
 * Only StudentHub's own finance users reach these pages (the same central gate as the bank result files, and
 * the same per-company rule as settling a transfer). Everyone else, a company's own finance users included,
 * gets not found, and a transfer outside the reader's companies reads exactly like a missing one.
 */
export const FINANCE_TRANSFERS_PATH = "/finance/transfers";
export interface FinanceTransferReads {
  list(principalId: string, filter: { status?: CompanyTransferStatus; page?: number }): Promise<FinanceTransferPage | null>;
  transfer(principalId: string, transferId: string): Promise<FinanceTransferDetail | null>;
}
export interface FinanceTransfersHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  list(viewer: string, filter: { status?: CompanyTransferStatus; page: number }): Promise<FinanceTransferPage | null>;
  transfer(viewer: string, transferId: string): Promise<FinanceTransferDetail | null>;
}

export function createFinanceTransfersHttp(ports: { sessions: Pick<SessionStore, "get">; reads: FinanceTransferReads }): FinanceTransfersHttp {
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    list: (viewer, filter) => ports.reads.list(viewer, filter),
    transfer: (viewer, id) => ports.reads.transfer(viewer, id),
  };
}

/** `page` absent is 1 and `status` absent is every status; any other parameter, or a value outside these, is undefined. */
export function filterOf(query: URLSearchParams): { status?: CompanyTransferStatus; page: number } | undefined {
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length || keys.some((k) => k !== "page" && k !== "status")) return undefined;
  const rawPage = query.get("page"), rawStatus = query.get("status");
  if (rawPage !== null && !/^[1-9][0-9]{0,5}$/.test(rawPage)) return undefined;
  if (rawStatus !== null && !FINANCE_TRANSFER_STATUSES.includes(rawStatus as CompanyTransferStatus)) return undefined;
  return { page: rawPage === null ? 1 : Number(rawPage), ...(rawStatus === null ? {} : { status: rawStatus as CompanyTransferStatus }) };
}

const DETAIL = /^\/finance\/transfers\/([^/]+)$/;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const detailHref = (id: string) => `${FINANCE_TRANSFERS_PATH}/${encodeURIComponent(id)}`;
const listHref = (filter: { status?: CompanyTransferStatus; page: number }) => {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.page > 1) q.set("page", String(filter.page));
  const s = q.toString();
  return s ? `${FINANCE_TRANSFERS_PATH}?${s}` : FINANCE_TRANSFERS_PATH;
};

function listHtml(result: FinanceTransferPage, status: CompanyTransferStatus | undefined): string {
  const filters = [`<a href="${FINANCE_TRANSFERS_PATH}"${status ? "" : ' aria-current="page"'}>All</a>`,
    ...FINANCE_TRANSFER_STATUSES.map((s) => `<a href="${esc(listHref({ status: s, page: 1 }))}"${status === s ? ' aria-current="page"' : ""}>${esc(TRANSFER_STATUS_NAME[s])}</a>`)].join(" · ");
  const rows = result.transfers.map((t) => `<tr><td><a href="${esc(detailHref(t.transferId))}">${esc(longDate(t.periodStart))} to ${esc(longDate(t.periodEnd))}</a></td>`
    + `<td>${esc(t.companyName)}</td><td>${t.lineCount}</td><td>${esc(t.currencyCode)} ${esc(t.companyTotal)}</td><td>${esc(transferStatus(t.status, t.paymentReceivedOn))}</td></tr>`).join("");
  const nav = [result.page > 1 ? `<a href="${esc(listHref({ ...(status ? { status } : {}), page: result.page - 1 }))}">Newer</a>` : "",
    result.more ? `<a href="${esc(listHref({ ...(status ? { status } : {}), page: result.page + 1 }))}">Older</a>` : ""].filter(Boolean).join(" ");
  return `<main><h1>Transfers</h1><p>Salary transfers of every company, newest period first.</p><p>${filters}</p>${result.transfers.length
    ? `<table><thead><tr><th>Period</th><th>Company</th><th>People</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No transfers here.</p>"}${nav ? `<p>${nav}</p>` : ""}<p><a href="${BANK_RESULTS_PATH}">Bank result files</a></p></main>`;
}

function detailHtml(t: FinanceTransferDetail): string {
  const rows = t.lines.map((l) => `<tr id="line-${esc(l.lineId)}"><td>${esc(l.personName)}</td><td>${esc(l.storeName)}</td><td>${esc(t.currencyCode)} ${esc(l.candidateTotal)}</td>`
    + `<td>${esc(t.currencyCode)} ${esc(l.companyTotal)}</td><td>${l.paid ? "Paid" : "Not paid yet"}</td></tr>`).join("");
  return `<main><h1>Transfer</h1><p>${esc(t.companyName)}, ${esc(longDate(t.periodStart))} to ${esc(longDate(t.periodEnd))}. ${esc(transferStatus(t.status, t.paymentReceivedOn))}.</p>`
    + `<p>Billed to the company: ${esc(t.currencyCode)} ${esc(t.companyTotal)}. Salaries for ${t.lineCount} ${t.lineCount === 1 ? "person" : "people"}: ${esc(t.currencyCode)} ${esc(t.candidateTotal)}. `
    + `Paid so far: ${esc(t.currencyCode)} ${esc(t.paidTotal)}, ${t.paidCount} of ${t.lineCount} ${t.lineCount === 1 ? "line" : "lines"}.</p>`
    + (t.lines.length ? `<table><thead><tr><th>Person</th><th>Store</th><th>Salary</th><th>Billed</th><th>Paid</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>This transfer has no lines yet.</p>")
    + `<p><a href="${esc(`${BANK_RESULTS_PATH}/transfers/${encodeURIComponent(t.transferId)}`)}">Bank payments for this transfer</a></p>`
    + `<p><a href="${FINANCE_TRANSFERS_PATH}">All transfers</a></p></main>`;
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

export async function handleFinanceTransfers(req: IncomingMessage, res: ServerResponse, service: FinanceTransfersHttp | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid"), path = url.pathname;
  const list = path === FINANCE_TRANSFERS_PATH, detail = list ? null : DETAIL.exec(path);
  if (!list && !detail && !path.startsWith(`${FINANCE_TRANSFERS_PATH}/`)) return false;
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "transfers_unavailable", "Transfers unavailable", "Transfers are not available right now.");
    if (!list && !detail) return notFound(req, res);
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(sessionCookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see transfers.");
    if (list) {
      const filter = filterOf(url.searchParams);
      if (!filter) return notFound(req, res);
      const result = await service.list(viewer, filter);
      if (!result) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
      writeHtml(res, 200, pageDocument("Transfers", listHtml(result, filter.status)), { "cache-control": "no-store" }); return true;
    }
    const id = transferIdOf(detail![1]!);
    if (id === undefined) return notFound(req, res);
    const result = await service.transfer(viewer, id);
    if (!result) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
    writeHtml(res, 200, pageDocument("Transfer", detailHtml(result)), { "cache-control": "no-store" }); return true;
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "transfers_unavailable", "Transfers unavailable", "Transfers are not available right now.");
    res.destroy(); return true;
  }
}
