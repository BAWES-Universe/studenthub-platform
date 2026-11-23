import type { IncomingMessage, ServerResponse } from "node:http";
import type { RevenuePage } from "../../../../packages/reports/src/revenue.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * GET /reports/revenue: revenue per currency (contract P-4, screen A-31), for operator admins only.
 * Everyone else, staff included, gets the same not found whatever the method. Read only.
 */
export interface RevenueHttpService { isOperatorAdmin(viewer: string): Promise<boolean>; page(viewer: string): Promise<RevenuePage | undefined> }

export const REVENUE_PATH = "/reports/revenue";
const OPERATIONS_PATH = "/reports/operations";
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => { const [y, n] = m.split("-"); return `${MONTH_NAMES[Number(n) - 1] ?? m} ${y}`; };
const STATUS_LABEL: Record<string, string> = { draft: "Draft", locked: "Locked", payment_sent: "Payment sent", distributing: "Payment received, paying candidates", complete: "Complete", cancelled: "Cancelled" };

function notFound(req: IncomingMessage, res: ServerResponse): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, 404, pageDocument("Not found", `<main><h1>Not found</h1><p>The page could not be found.</p></main>`), { "cache-control": "no-store" }); return true; }
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ status: "not_found" })); return true;
}

function revenueHtml(page: RevenuePage): string {
  const received = page.received.length ? `<table><thead><tr><th scope="col">Currency</th><th scope="col">Paid by companies</th><th scope="col">Belonging to candidates</th><th scope="col">Gross profit</th><th scope="col">Transfers</th><th scope="col">Candidate lines</th></tr></thead><tbody>`
    + page.received.map(r => `<tr><th scope="row">${esc(r.currency)}</th><td>${esc(r.companyTotal)}</td><td>${esc(r.candidateTotal)}</td><td>${esc(r.grossProfit)}</td><td>${r.transfers}</td><td>${r.lines}</td></tr>`).join("")
    + `</tbody></table>` : `<p>No payments received yet.</p>`;
  const currencies = [...new Set(page.monthly.map(r => r.currency))];
  const monthly = currencies.map(c => `<h3>${esc(c)}</h3><table><thead><tr><th scope="col">Month</th><th scope="col">Transfers</th><th scope="col">Billed to companies</th><th scope="col">Belonging to candidates</th><th scope="col">Gross profit</th><th scope="col">Payment received</th></tr></thead><tbody>`
    + page.monthly.filter(r => r.currency === c).map(r => `<tr><th scope="row">${esc(monthName(r.month))}</th><td>${r.transfers}</td><td>${esc(r.companyTotal)}</td><td>${esc(r.candidateTotal)}</td><td>${esc(r.grossProfit)}</td><td>${esc(r.received)}</td></tr>`).join("")
    + `</tbody></table>`).join("");
  const recon = page.reconciliation.length ? `<table><thead><tr><th scope="col">Currency</th><th scope="col">Status</th><th scope="col">Transfers</th><th scope="col">Candidate lines</th><th scope="col">Company total</th><th scope="col">Candidate total</th><th scope="col">Difference</th></tr></thead><tbody>`
    + page.reconciliation.map(r => `<tr><td>${esc(r.currency)}</td><td>${esc(STATUS_LABEL[r.status] ?? r.status)}</td><td>${r.transfers}</td><td>${r.lines}</td><td>${esc(r.companyTotal)}</td><td>${esc(r.candidateTotal)}</td><td>${esc(r.grossProfit)}</td></tr>`).join("")
    + `</tbody></table>` : `<p>No transfers yet.</p>`;
  return `<main><h1>Revenue</h1><p>Counted live from the transfer lines as of ${esc(page.day)} (Kuwait time). Every amount is per currency; currencies are never added together. Deleted transfers are left out.</p>`
    + `<h2>Payment received</h2><p>Transfers whose payment was sent or received, or that are complete.</p>${received}`
    + `<p>Not available yet:</p><ul>${page.missing.map(m => `<li>${esc(m.label)}: Not available <small>(waits on ${esc(m.waitsOn)})</small></li>`).join("")}</ul>`
    + `<h2>By month</h2><p>The last 12 whole months, by the month each transfer's pay period ends, oldest first. Drafts and cancelled transfers are left out.</p>${monthly || "<p>No transfers yet.</p>"}`
    + `<h2>Reconciliation</h2><p>Every transfer by status, with the sums of its candidate lines. The payment received figures above are the payment sent, payment received and complete rows.</p>${recon}`
    + `<p><a href="${OPERATIONS_PATH}">Back to operations</a></p></main>`;
}

/** Handles the revenue path; false for any other path. `viewer` is the signed-in person, if any. */
export async function handleRevenue(req: IncomingMessage, res: ServerResponse, service: RevenueHttpService | undefined, path: string, viewer: () => Promise<string | undefined>): Promise<boolean> {
  if (path !== REVENUE_PATH) return false;
  req.resume();
  const person = service ? await viewer() : undefined;
  // Authorization first: everyone who is not an operator admin gets the same not found, whatever the method.
  let allowed = false; if (service && person) try { allowed = await service.isOperatorAdmin(person); } catch { /* treated as not an admin */ }
  if (!service || !person || !allowed) return notFound(req, res);
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  const page = await service.page(person);
  if (!page) return notFound(req, res);
  if (!wantsHtml(req.headers.accept)) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ status: "ok", ...page })); return true;
  }
  writeHtml(res, 200, pageDocument("Revenue", revenueHtml(page)), { "cache-control": "no-store" });
  return true;
}
