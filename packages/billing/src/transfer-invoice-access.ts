/**
 * Who may read a company's transfer invoices (I3, legacy company `TransferController::actionPdf`
 * and the admin invoice views).
 *
 * StudentHub staff and admins, and the company's own owners and finance users, read the
 * invoices of a company and of its sub-companies, as legacy `InvoiceQuery::filterCurrentCompany`
 * does. A grant counts on the company itself, or on an ancestor through a subtree grant.
 * Recruiters and candidates read nothing, and operator organizations are never billed.
 */
export interface TransferInvoiceGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }

export const TRANSFER_INVOICE_READ_ROLES: readonly string[] = Object.freeze(["staff", "admin", "org-owner", "finance"]);

export function transferInvoiceReadDecision(rows: readonly TransferInvoiceGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  if (operators.includes(orgId)) return false;
  return rows.some(row => TRANSFER_INVOICE_READ_ROLES.includes(row.role)
    && (row.org_id === orgId || (row.scope === "subtree" && ancestors.includes(row.org_id))));
}

/** `SH-2026-11-000001` as issued by the transfer series; anything else is not an invoice number of this page. */
export const TRANSFER_INVOICE_NUMBER = /^SH-[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{6,12}$/;
