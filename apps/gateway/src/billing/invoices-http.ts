import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { TransferInvoiceDocument, TransferInvoicePage } from "@studenthub/db/billing";
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
 */
export interface TransferInvoiceReads {
  listForOrganization(principalId: string, orgId: string): Promise<TransferInvoicePage | null>;
  document(principalId: string, orgId: string, invoiceNumber: string): Promise<TransferInvoiceDocument | null>;
}
export interface InvoicesHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  list(viewer: string, orgId: string): Promise<TransferInvoicePage | null>;
  pdf(viewer: string, orgId: string, invoiceNumber: string): Promise<{ readonly bytes: Buffer; readonly paid: boolean } | null>;
}

export function createInvoicesHttp(ports: { sessions: Pick<SessionStore, "get">; reads: TransferInvoiceReads; bank?: InvoiceBankInfo }): InvoicesHttp {
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    list: (viewer, orgId) => ports.reads.listForOrganization(viewer, orgId),
    async pdf(viewer, orgId, invoiceNumber) {
      const invoice = await ports.reads.document(viewer, orgId, invoiceNumber);
      return invoice ? { bytes: invoicePdf(invoice, ports.bank), paid: invoice.status === "paid" } : null;
    },
  };
}

export const INVOICES_PATH = "/organization/invoices";
const LIST = /^\/organization\/invoices\/([^/]+)$/, PDF = /^\/organization\/invoices\/([^/]+)\/([^/]+)\.pdf$/;
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

/** Handles the invoice paths; false for any other path. */
export async function handleInvoices(req: IncomingMessage, res: ServerResponse, service: InvoicesHttp | undefined): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  const list = LIST.exec(path), pdf = PDF.exec(path);
  if (!list && !pdf) return false;
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now.");
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(cookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see your company's invoices.");
    let orgId: string;
    try { orgId = decodeURIComponent((list ?? pdf)![1]!); } catch { return notFound(req, res); }
    if (!ORG_ID.test(orgId)) return notFound(req, res);
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
