import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { TransferInvoiceDocument, TransferInvoicePage, TransferStatement } from "@studenthub/db/billing";
import { TRANSFER_INVOICE_NUMBER } from "../../../../packages/billing/src/transfer-invoice-access.js";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";
import { invoicePdf, type InvoiceBankInfo } from "./invoice-pdf.js";

/**
 * I3 company invoices (legacy company `TransferController::actionPdf`, admin invoice views).
 *
 * GET /organization/invoices/<orgId> lists the live invoices of the company and its
 * sub-companies, as a page or JSON. GET /organization/invoices/<orgId>/<number>.pdf is one of
 * them: an "Invoice" while unpaid, a "Receipt" once paid. Readers are the company's owners and
 * finance users and StudentHub staff and admins (`transferInvoiceReadDecision`). A reader who may
 * not see the company, a missing company and an invoice outside it all get the same not found.
 *
 * GET /organization/<orgId>/statements is the company's account statement (F4.8): opening balance,
 * invoices issued and payments received in a window, and closing balance, per currency with a
 * line per company. `?from=YYYY-MM-DD&to=YYYY-MM-DD` (Kuwait dates); by default the current month
 * to today, so its closing figure is the balance owed now. Same readers and the same not found.
 */
export interface TransferInvoiceReads {
  listForOrganization(principalId: string, orgId: string): Promise<TransferInvoicePage | null>;
  document(principalId: string, orgId: string, invoiceNumber: string): Promise<TransferInvoiceDocument | null>;
  statement(principalId: string, orgId: string, from: string, to: string): Promise<TransferStatement | null>;
}
export interface InvoicesHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  list(viewer: string, orgId: string): Promise<TransferInvoicePage | null>;
  pdf(viewer: string, orgId: string, invoiceNumber: string): Promise<{ readonly bytes: Buffer; readonly paid: boolean } | null>;
  statement(viewer: string, orgId: string, from: string, to: string): Promise<TransferStatement | null>;
  /** Today's date in Kuwait, YYYY-MM-DD. */
  today(): string;
}

export function createInvoicesHttp(ports: { sessions: Pick<SessionStore, "get">; reads: TransferInvoiceReads; bank?: InvoiceBankInfo; now?: () => Date }): InvoicesHttp {
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    list: (viewer, orgId) => ports.reads.listForOrganization(viewer, orgId),
    async pdf(viewer, orgId, invoiceNumber) {
      const invoice = await ports.reads.document(viewer, orgId, invoiceNumber);
      return invoice ? { bytes: invoicePdf(invoice, ports.bank), paid: invoice.status === "paid" } : null;
    },
    statement: (viewer, orgId, from, to) => ports.reads.statement(viewer, orgId, from, to),
    today: () => new Date((ports.now?.() ?? new Date()).getTime() + 3 * 3600_000).toISOString().slice(0, 10),
  };
}

export const INVOICES_PATH = "/organization/invoices";
const LIST = /^\/organization\/invoices\/([^/]+)$/, PDF = /^\/organization\/invoices\/([^/]+)\/([^/]+)\.pdf$/;
const STATEMENT = /^\/organization\/([^/]+)\/statements$/;
/** Longest statement window, in days; a year and a leap day of slack. */
const STATEMENT_DAYS = 366;
const ORG_ID = /^[A-Za-z0-9._:-]{1,256}$/;
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

function listHtml(page: TransferInvoicePage): string {
  const base = `${INVOICES_PATH}/${encodeURIComponent(page.orgId)}`;
  const rows = page.invoices.map(i => `<tr><td>${esc(i.invoiceNumber)}</td><td>${esc(i.companyName)}</td><td>${esc(i.transferId)}</td><td>${esc(longDate(i.invoiceDate))}</td>`
    + `<td>${esc(i.currencyCode)} ${esc(i.total)}</td><td>${i.status === "paid" ? `Paid${i.paidOn ? ` on ${esc(longDate(i.paidOn))}` : ""}` : "Unpaid"}</td>`
    + `<td><a href="${esc(`${base}/${i.invoiceNumber}.pdf`)}">${i.status === "paid" ? "Receipt" : "Invoice"} (PDF)</a></td></tr>`).join("");
  return `<main><h1>Invoices</h1><p>${esc(page.name)}: invoices for its transfers and its sub-companies' transfers, newest first.</p>${page.invoices.length
    ? `<table><thead><tr><th>Invoice number</th><th>Billed to</th><th>Transfer</th><th>Issue date</th><th>Amount</th><th>Status</th><th>Document</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>There are no invoices yet. An invoice is issued when a transfer is locked.</p>"}</main>`;
}

/** A real calendar date from 2000 on, or undefined. */
function isoDate(v: string | null): string | undefined {
  if (v === null || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < "2000-01-01") return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
}
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

function statementHtml(s: TransferStatement): string {
  const money = (c: string, v: string) => `${esc(c)} ${esc(v)}`;
  const totals = s.currencies.map(c => `<h2>${esc(c.currencyCode)}</h2><table><thead><tr><th>Company</th><th>Opening balance</th><th>Invoiced</th><th>Paid</th><th>Closing balance</th></tr></thead><tbody>`
    + c.members.map(m => `<tr><td>${esc(m.companyName)}</td><td>${money(c.currencyCode, m.opening)}</td><td>${money(c.currencyCode, m.invoiced)}</td><td>${money(c.currencyCode, m.paid)}</td><td>${money(c.currencyCode, m.closing)}</td></tr>`).join("")
    + `</tbody><tfoot><tr><th>Total</th><th>${money(c.currencyCode, c.opening)}</th><th>${money(c.currencyCode, c.invoiced)}</th><th>${money(c.currencyCode, c.paid)}</th><th>${money(c.currencyCode, c.closing)}</th></tr></tfoot></table>`).join("");
  const rows = s.entries.map(e => `<tr><td>${esc(longDate(e.date))}</td><td>${e.kind === "invoice" ? "Invoice issued" : "Payment received"}</td><td>${esc(e.invoiceNumber)}</td>`
    + `<td>${esc(e.companyName)}</td><td>${e.kind === "invoice" ? "" : "−"}${money(e.currencyCode, e.amount)}</td></tr>`).join("");
  return `<main><h1>Statement</h1><p>${esc(s.name)}, ${esc(longDate(s.from))} to ${esc(longDate(s.to))}. Amounts owed for transfers of the company and its sub-companies.</p>`
    + `<form method="get"><label>From <input type="date" name="from" value="${esc(s.from)}"></label> <label>To <input type="date" name="to" value="${esc(s.to)}"></label> <button>Show</button></form>`
    + (s.currencies.length ? totals : "<p>Nothing was owed or invoiced in this period.</p>")
    + (s.entries.length ? `<h2>Movements</h2><table><thead><tr><th>Date</th><th>Movement</th><th>Invoice number</th><th>Company</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>` : "")
    + `<p><a href="${esc(`${INVOICES_PATH}/${encodeURIComponent(s.orgId)}`)}">Invoices</a></p></main>`;
}

/** Handles the invoice paths; false for any other path. */
export async function handleInvoices(req: IncomingMessage, res: ServerResponse, service: InvoicesHttp | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid"), path = url.pathname;
  // Exactly one route per path. `/organization/invoices/<x>` is always the invoice list of <x>, never the
  // statement of an organization called "invoices", so the statement only matches when the others do not.
  const list = LIST.exec(path), pdf = list ? null : PDF.exec(path), statement = list || pdf ? null : STATEMENT.exec(path);
  const matched = list ?? pdf ?? statement;
  if (!matched) return false;
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now.");
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(cookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see your company's invoices.");
    let orgId: string;
    try { orgId = decodeURIComponent(matched[1]!); } catch { return notFound(req, res); }
    if (!ORG_ID.test(orgId)) return notFound(req, res);
    if (statement) {
      const today = service.today(), rawFrom = url.searchParams.get("from"), rawTo = url.searchParams.get("to");
      const from = rawFrom === null ? `${today.slice(0, 8)}01` : isoDate(rawFrom), to = rawTo === null ? today : isoDate(rawTo);
      if (!from || !to || from > to || days(from, to) > STATEMENT_DAYS) return reply(req, res, 400, "invalid_period", "Invalid period", `Choose a start date on or before the end date, at most ${STATEMENT_DAYS} days apart.`);
      const result = await service.statement(viewer, orgId, from, to);
      if (!result) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
      writeHtml(res, 200, pageDocument("Statement", statementHtml(result)), { "cache-control": "no-store" });
      return true;
    }
    if (pdf) {
      if (!TRANSFER_INVOICE_NUMBER.test(pdf[2]!)) return notFound(req, res);
      const document = await service.pdf(viewer, orgId, pdf[2]!);
      if (!document) return notFound(req, res);
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="studenthub-${document.paid ? "receipt" : "invoice"}-${pdf[2]}.pdf"`,
        "content-length": String(document.bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(document.bytes); return true;
    }
    const page = await service.list(viewer, orgId);
    if (!page) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { orgId: page.orgId, name: page.name, invoices: page.invoices });
    writeHtml(res, 200, pageDocument("Invoices", listHtml(page)), { "cache-control": "no-store" });
    return true;
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now.");
    res.destroy(); return true;
  }
}
