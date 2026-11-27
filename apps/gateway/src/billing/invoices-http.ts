import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { creditReason, type CompanyTransferDetail, type CompanyTransferPage, type CompanyTransferStatus, type TransferInvoiceCreditResult, type TransferInvoiceDocument, type TransferInvoiceListEntry, type TransferInvoicePage, type TransferStatement } from "@studenthub/db/billing";
import { TRANSFER_INVOICE_NUMBER } from "../../../../packages/billing/src/transfer-invoice-access.js";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { readBody, sameOrigin } from "../recruit/http-common.js";
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
 * invoices issued, payments received and credit notes issued in a window, and closing balance, per currency with a
 * line per company. `?from=YYYY-MM-DD&to=YYYY-MM-DD` (Kuwait dates); by default the current month
 * to today, so its closing figure is the balance owed now. Same readers and the same not found.
 *
 * GET /organization/<orgId>/transfers lists the company's transfers (O-13; legacy company `TransferController::actionList`),
 * and GET /organization/<orgId>/transfers/<id> is one of them with a line per person (`actionView`): what the
 * company owes, never what the person is paid. Same readers and the same not found as the invoices.
 *
 * POST /organization/invoices/<orgId>/<number>/void voids one invoice with a credit note (F4.7), with
 * a `reason` in a JSON or form body. Only StudentHub's finance users void
 * (`transferInvoiceVoidDecision`, decided again by the store inside the credit's transaction). The list
 * page shows them a void form per standing invoice; one who may void but not read gets that list alone,
 * without PDF links, and no PDF or statement. One who reads some of the invoices and may void more sees
 * both: PDF links only on those they read. An invoice the void list does not show (an unpaid one whose
 * transfer is not locked or paid out) is not found; 409 is for one that stops being creditable between
 * the page and the post. Same-origin posts only. The JSON receipt is the outcome
 * and the credit note number only; voiding twice answers the first credit note's number.
 */
export interface TransferInvoiceReads {
  listForOrganization(principalId: string, orgId: string): Promise<TransferInvoicePage | null>;
  document(principalId: string, orgId: string, invoiceNumber: string): Promise<TransferInvoiceDocument | null>;
  statement(principalId: string, orgId: string, from: string, to: string): Promise<TransferStatement | null>;
  companyTransfers?(principalId: string, orgId: string): Promise<CompanyTransferPage | null>;
  companyTransfer?(principalId: string, orgId: string, transferId: string): Promise<CompanyTransferDetail | null>;
}
export interface InvoicesHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  list(viewer: string, orgId: string): Promise<TransferInvoicePage | null>;
  pdf(viewer: string, orgId: string, invoiceNumber: string): Promise<{ readonly bytes: Buffer; readonly paid: boolean } | null>;
  statement(viewer: string, orgId: string, from: string, to: string): Promise<TransferStatement | null>;
  transfers(viewer: string, orgId: string): Promise<CompanyTransferPage | null>;
  transfer(viewer: string, orgId: string, transferId: string): Promise<CompanyTransferDetail | null>;
  /** Today's date in Kuwait, YYYY-MM-DD. */
  today(): string;
  /** The gateway origin a void post must come from; voids are refused without one. */
  readonly origin: string | undefined;
  /** The company's invoices as one who may void them sees them (`InvoiceVoidEntry` only); null when the viewer may not void. */
  voidList(viewer: string, orgId: string): Promise<InvoiceVoidPage | null>;
  void(viewer: string, orgId: string, invoiceNumber: string, reason: unknown): Promise<InvoiceVoidResult>;
}
/**
 * What one who may void sees of an invoice: enough to pick it and void it. Anything else a reader
 * sees (line count, payment and credit dates, the PDF) stays behind the read decision. A field
 * added to the reads is not shown here until it is added to this list.
 */
export const INVOICE_VOID_FIELDS = Object.freeze(["invoiceNumber", "transferId", "orgId", "companyName", "currencyCode", "invoiceDate", "total", "status", "creditNumber"] as const);
export type InvoiceVoidEntry = Pick<TransferInvoiceListEntry, typeof INVOICE_VOID_FIELDS[number]>;
export interface InvoiceVoidPage { readonly orgId: string; readonly name: string; readonly invoices: readonly InvoiceVoidEntry[] }
function voidEntry(entry: TransferInvoiceListEntry): InvoiceVoidEntry {
  return Object.fromEntries(INVOICE_VOID_FIELDS.map(key => [key, entry[key]])) as unknown as InvoiceVoidEntry;
}
export type InvoiceVoidResult = TransferInvoiceCreditResult | { readonly kind: "invalid_reason" };
/** The invoices one who may void sees (the read side with the void decision), and the credit note store. */
export interface InvoiceVoidPorts {
  readonly reads: Pick<TransferInvoiceReads, "listForOrganization" | "document">;
  credit(input: { actorId: string; invoiceNumber: string; reason: string }): Promise<TransferInvoiceCreditResult>;
  readonly origin: string;
}

export function createInvoicesHttp(ports: { sessions: Pick<SessionStore, "get">; reads: TransferInvoiceReads; bank?: InvoiceBankInfo; now?: () => Date; voids?: InvoiceVoidPorts }): InvoicesHttp {
  const voids = ports.voids;
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    list: (viewer, orgId) => ports.reads.listForOrganization(viewer, orgId),
    async pdf(viewer, orgId, invoiceNumber) {
      const invoice = await ports.reads.document(viewer, orgId, invoiceNumber);
      return invoice ? { bytes: invoicePdf(invoice, ports.bank), paid: invoice.status === "paid" } : null;
    },
    statement: (viewer, orgId, from, to) => ports.reads.statement(viewer, orgId, from, to),
    transfers: async (viewer, orgId) => await ports.reads.companyTransfers?.(viewer, orgId) ?? null,
    transfer: async (viewer, orgId, transferId) => await ports.reads.companyTransfer?.(viewer, orgId, transferId) ?? null,
    today: () => new Date((ports.now?.() ?? new Date()).getTime() + 3 * 3600_000).toISOString().slice(0, 10),
    origin: voids?.origin || undefined,
    async voidList(viewer, orgId) {
      const page = voids ? await voids.reads.listForOrganization(viewer, orgId) : null;
      return page ? { orgId: page.orgId, name: page.name, invoices: page.invoices.map(voidEntry) } : null;
    },
    async void(viewer, orgId, invoiceNumber, raw) {
      let reason: string;
      try { reason = creditReason(raw); } catch { return { kind: "invalid_reason" }; }
      // The page's view first: an invoice outside what the viewer may void is not found. The store then
      // decides again on the invoice's own company, under the credit's locks.
      if (!voids || !await voids.reads.document(viewer, orgId, invoiceNumber)) return { kind: "not_found" };
      return await voids.credit({ actorId: viewer, invoiceNumber, reason });
    },
  };
}

export const INVOICES_PATH = "/organization/invoices";
const LIST = /^\/organization\/invoices\/([^/]+)$/, PDF = /^\/organization\/invoices\/([^/]+)\/([^/]+)\.pdf$/;
const STATEMENT = /^\/organization\/([^/]+)\/statements$/;
const TRANSFERS = /^\/organization\/([^/]+)\/transfers$/, TRANSFER = /^\/organization\/([^/]+)\/transfers\/([^/]+)$/;
const TRANSFER_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const VOID = /^\/organization\/invoices\/([^/]+)\/([^/]+)\/void$/;
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

/**
 * The invoice list; `documents` false for one who may only void (no PDF links). `voidable` (the numbers
 * the viewer may void) adds the void column, with a form on those rows alone. The reason's length is
 * left to the server, which counts characters; a browser's maxlength counts UTF-16 units.
 */
function listHtml(page: TransferInvoicePage | InvoiceVoidPage, voidable: ReadonlySet<string> | null, documents: boolean): string {
  const base = `${INVOICES_PATH}/${encodeURIComponent(page.orgId)}`;
  // A void-only entry carries no payment or credit dates; a reader's entry does.
  const dated = (i: TransferInvoiceListEntry | InvoiceVoidEntry) => "paidOn" in i ? i : { ...i, paidOn: null, creditedOn: null };
  // A reader's entry carries its payment date (null or not); only those get a PDF link.
  const rows = page.invoices.map(entry => ({ i: dated(entry), pdf: documents && "paidOn" in entry })).map(({ i, pdf }) => `<tr><td>${esc(i.invoiceNumber)}</td><td>${esc(i.companyName)}</td><td>${esc(i.transferId)}</td><td>${esc(longDate(i.invoiceDate))}</td>`
    + `<td>${esc(i.currencyCode)} ${esc(i.total)}</td><td>${i.status === "paid" ? `Paid${i.paidOn ? ` on ${esc(longDate(i.paidOn))}` : ""}` : "Unpaid"}`
    + `${i.creditNumber ? `, voided by credit note ${esc(i.creditNumber)}${i.creditedOn ? ` on ${esc(longDate(i.creditedOn))}` : ""}` : ""}</td>`
    + (documents ? `<td>${pdf ? `<a href="${esc(`${base}/${i.invoiceNumber}.pdf`)}">${i.status === "paid" ? "Receipt" : "Invoice"} (PDF)</a>` : ""}</td>` : "")
    + (voidable ? `<td>${i.creditNumber || !voidable.has(i.invoiceNumber) ? "" : `<form method="post" action="${esc(`${base}/${i.invoiceNumber}/void`)}"><label>Reason <input name="reason" required></label> <button>Void with a credit note</button></form>`}</td>` : "")
    + "</tr>").join("");
  return `<main><h1>Invoices</h1><p>${esc(page.name)}: invoices for its transfers and its sub-companies' transfers, newest first.</p>${page.invoices.length
    ? `<table><thead><tr><th>Invoice number</th><th>Billed to</th><th>Transfer</th><th>Issue date</th><th>Amount</th><th>Status</th>${documents ? "<th>Document</th>" : ""}${voidable ? "<th>Void</th>" : ""}</tr></thead><tbody>${rows}</tbody></table>`
    : "<p>There are no invoices yet. An invoice is issued when a transfer is locked.</p>"}</main>`;
}

/** The read page plus the void entries it lacks, newest first; the read page as it is when nothing is added. */
function withVoidable(read: TransferInvoicePage, voidable: InvoiceVoidPage): TransferInvoicePage | InvoiceVoidPage {
  const seen = new Set(read.invoices.map(i => i.invoiceNumber));
  const extra = voidable.invoices.filter(i => !seen.has(i.invoiceNumber));
  if (!extra.length) return read;
  const invoices = [...read.invoices, ...extra].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || b.invoiceNumber.localeCompare(a.invoiceNumber));
  return { orgId: read.orgId, name: read.name, invoices };
}

/** Legacy `Transfer::statusList` wording. */
export const TRANSFER_STATUS_NAME: Readonly<Record<CompanyTransferStatus, string>> = { draft: "Draft", locked: "Locked", payment_sent: "Payment sent",
  distributing: "Received, paying salaries", complete: "Transfer completed", cancelled: "Cancelled" };
export const transferStatus = (s: CompanyTransferStatus, received: string | null) => `${TRANSFER_STATUS_NAME[s]}${received ? ` (payment received ${longDate(received)})` : ""}`;

function transfersHtml(page: CompanyTransferPage): string {
  const base = `/organization/${encodeURIComponent(page.orgId)}/transfers`;
  const rows = page.transfers.map(t => `<tr><td><a href="${esc(`${base}/${encodeURIComponent(t.transferId)}`)}">${esc(longDate(t.periodStart))} to ${esc(longDate(t.periodEnd))}</a></td>`
    + `<td>${esc(t.companyName)}</td><td>${t.personCount}</td><td>${esc(t.currencyCode)} ${esc(t.companyTotal)}</td><td>${esc(transferStatus(t.status, t.paymentReceivedOn))}</td></tr>`).join("");
  return `<main><h1>Transfers</h1><p>${esc(page.name)}: salary transfers for the company and its sub-companies, newest period first.</p>${page.transfers.length
    ? `<table><thead><tr><th>Period</th><th>Company</th><th>People</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>There are no transfers yet.</p>"}<p><a href="${esc(`${INVOICES_PATH}/${encodeURIComponent(page.orgId)}`)}">Invoices</a></p></main>`;
}

function transferHtml(orgId: string, t: CompanyTransferDetail): string {
  const rows = t.lines.map(l => `<tr><td>${esc(l.personName)}</td><td>${esc(l.storeName)}</td><td>${l.worked ? `${esc(l.worked.hours)} h ${l.worked.minutes} min` : ""}</td>`
    + `<td>${esc(t.currencyCode)} ${esc(l.companyTotal)}</td><td>${l.paid ? "Paid" : "Not paid yet"}</td></tr>`).join("");
  return `<main><h1>Transfer</h1><p>${esc(t.companyName)}, ${esc(longDate(t.periodStart))} to ${esc(longDate(t.periodEnd))}. ${esc(transferStatus(t.status, t.paymentReceivedOn))}.</p>`
    + `<p>Amount: ${esc(t.currencyCode)} ${esc(t.companyTotal)} for ${t.personCount} ${t.personCount === 1 ? "person" : "people"}.</p>`
    + (t.lines.length ? `<table><thead><tr><th>Person</th><th>Store</th><th>Worked</th><th>Amount</th><th>Salary</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>This transfer has no lines yet.</p>")
    + `<p><a href="${esc(`/organization/${encodeURIComponent(orgId)}/transfers`)}">All transfers</a></p></main>`;
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
  const totals = s.currencies.map(c => `<h2>${esc(c.currencyCode)}</h2><table><thead><tr><th>Company</th><th>Opening balance</th><th>Invoiced</th><th>Paid</th><th>Credited</th><th>Closing balance</th></tr></thead><tbody>`
    + c.members.map(m => `<tr><td>${esc(m.companyName)}</td><td>${money(c.currencyCode, m.opening)}</td><td>${money(c.currencyCode, m.invoiced)}</td><td>${money(c.currencyCode, m.paid)}</td><td>${money(c.currencyCode, m.credited)}</td><td>${money(c.currencyCode, m.closing)}</td></tr>`).join("")
    + `</tbody><tfoot><tr><th>Total</th><th>${money(c.currencyCode, c.opening)}</th><th>${money(c.currencyCode, c.invoiced)}</th><th>${money(c.currencyCode, c.paid)}</th><th>${money(c.currencyCode, c.credited)}</th><th>${money(c.currencyCode, c.closing)}</th></tr></tfoot></table>`).join("");
  const rows = s.entries.map(e => `<tr><td>${esc(longDate(e.date))}</td><td>${e.kind === "invoice" ? "Invoice issued" : e.kind === "payment" ? "Payment received" : `Credit note ${esc(e.creditNumber ?? "")}`}</td><td>${esc(e.invoiceNumber)}</td>`
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
  const list = LIST.exec(path), pdf = list ? null : PDF.exec(path), voiding = list || pdf ? null : VOID.exec(path);
  const statement = list || pdf || voiding ? null : STATEMENT.exec(path);
  const transfers = list || pdf || voiding || statement ? null : TRANSFERS.exec(path);
  const transfer = list || pdf || voiding || statement || transfers ? null : TRANSFER.exec(path);
  const matched = list ?? pdf ?? voiding ?? statement ?? transfers ?? transfer;
  if (!matched) return false;
  if (voiding) return await handleVoid(req, res, service, voiding);
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now.");
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(cookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see your company's invoices.");
    let orgId: string;
    try { orgId = decodeURIComponent(matched[1]!); } catch { return notFound(req, res); }
    if (!ORG_ID.test(orgId)) return notFound(req, res);
    if (transfers) {
      const result = await service.transfers(viewer, orgId);
      if (!result) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
      writeHtml(res, 200, pageDocument("Transfers", transfersHtml(result)), { "cache-control": "no-store" });
      return true;
    }
    if (transfer) {
      let id: string;
      try { id = decodeURIComponent(transfer[2]!); } catch { return notFound(req, res); }
      if (!TRANSFER_ID.test(id)) return notFound(req, res);
      const result = await service.transfer(viewer, orgId, id);
      if (!result) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
      writeHtml(res, 200, pageDocument("Transfer", transferHtml(orgId, result)), { "cache-control": "no-store" });
      return true;
    }
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
    // A reader gets the list with documents; one who may only void gets the void list alone; one who
    // may do both sees what they read in full and any further invoice they may void in the void view.
    const read = await service.list(viewer, orgId), voidable = await service.voidList(viewer, orgId);
    const page = read && voidable ? withVoidable(read, voidable) : read ?? voidable;
    if (!page) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { orgId: page.orgId, name: page.name, invoices: page.invoices });
    writeHtml(res, 200, pageDocument("Invoices", listHtml(page, voidable && new Set(voidable.invoices.map(i => i.invoiceNumber)), read !== null)), { "cache-control": "no-store" });
    return true;
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now.");
    res.destroy(); return true;
  }
}

/** POST .../<number>/void: the origin is checked before the body is read; a form post goes back to the list. */
async function handleVoid(req: IncomingMessage, res: ServerResponse, service: InvoicesHttp | undefined, match: RegExpExecArray): Promise<true> {
  try {
    if (!service) { req.resume(); return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now."); }
    if (req.method !== "POST") { req.resume(); res.writeHead(405, { allow: "POST" }); res.end(); return true; }
    if (!service.origin || !sameOrigin(req, service.origin)) { req.resume(); return reply(req, res, 403, "forbidden", "Not allowed", "This request was not sent from StudentHub."); }
    const viewer = await service.viewer(cookie(req.headers.cookie));
    if (!viewer) { req.resume(); return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to void an invoice."); }
    let orgId: string;
    try { orgId = decodeURIComponent(match[1]!); } catch { req.resume(); return notFound(req, res); }
    const number = match[2]!;
    if (!ORG_ID.test(orgId) || !TRANSFER_INVOICE_NUMBER.test(number)) { req.resume(); return notFound(req, res); }
    // 500 characters of up to four UTF-8 bytes, percent-encoded in a form (12 bytes each), fit with room to spare.
    const body = await readBody(req, 8192);
    if (!body || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return reply(req, res, 400, "invalid_request", "Invalid request", "Give a reason for the void.");
    const result = await service.void(viewer, orgId, number, (body.value as Record<string, unknown>).reason);
    if (result.kind === "invalid_reason") return reply(req, res, 400, "invalid_reason", "Reason needed", "Give a reason of 1 to 500 characters, on one line.");
    if (result.kind === "not_found") return notFound(req, res);
    if (result.kind === "not_creditable") return reply(req, res, 409, "not_creditable", "Not voided", "Only an issued invoice that is due or paid can be voided.");
    if (body.form) { res.writeHead(303, { location: `${INVOICES_PATH}/${encodeURIComponent(orgId)}`, "cache-control": "no-store" }); res.end(); return true; }
    // The receipt says what happened and names the credit note; the actor and reason stay in the record.
    return json(res, result.kind === "credited" ? 201 : 200, { kind: result.kind, creditNumber: result.credit.creditNumber });
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "invoices_unavailable", "Invoices unavailable", "Invoices are not available right now.");
    res.destroy(); return true;
  }
}
