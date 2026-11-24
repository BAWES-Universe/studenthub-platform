/**
 * Who may read a company's transfer invoices (I3, legacy company `TransferController::actionPdf`
 * and the admin invoice views).
 *
 * StudentHub staff and admins, and the company's own owners and finance users, read the
 * invoices of a company and of its sub-companies, as legacy `InvoiceQuery::filterCurrentCompany`
 * does. A grant counts on the company itself, or on an ancestor through a subtree grant.
 * A finance or owner grant on an operator organization is not a company grant and reads nothing
 * here (StudentHub finance sees only the void list, `transferInvoiceVoidDecision`). Recruiters and
 * candidates read nothing, and operator organizations are never billed.
 */
export interface TransferInvoiceGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }

/** StudentHub's own staff and admins, through their grant on an operator organization or on the company. */
export const TRANSFER_INVOICE_OPERATOR_ROLES: readonly string[] = Object.freeze(["staff", "admin"]);
/** The company's own people. These count only on a company grant: an operator-level finance grant is not company finance. */
export const TRANSFER_INVOICE_COMPANY_ROLES: readonly string[] = Object.freeze(["org-owner", "finance"]);
/**
 * Who may void an issued invoice with a credit note (F4.7). Khalid, 24 Nov 2026: "anyone with finance
 * abilities role", rules refined after cutover. That is StudentHub's own finance users: the finance role
 * on an operator organization that covers the company. A company's own people never void their own
 * invoices, and no other role voids. This grant opens only the invoice list needed to void (number,
 * company, date, amount, status), not the invoice PDFs or statements.
 */
export const TRANSFER_INVOICE_VOID_ROLE = "finance";

export function transferInvoiceReadDecision(rows: readonly TransferInvoiceGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  if (operators.includes(orgId)) return false;
  const covers = (row: TransferInvoiceGrantRow) => row.org_id === orgId || (row.scope === "subtree" && ancestors.includes(row.org_id));
  return rows.some(row => covers(row) && (TRANSFER_INVOICE_OPERATOR_ROLES.includes(row.role)
    || (TRANSFER_INVOICE_COMPANY_ROLES.includes(row.role) && !operators.includes(row.org_id))));
}

/** Whether the person may void the company's invoices; same coverage rule as reading, operator finance grants only. */
export function transferInvoiceVoidDecision(rows: readonly TransferInvoiceGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  if (operators.includes(orgId)) return false;
  return rows.some(row => row.role === TRANSFER_INVOICE_VOID_ROLE && operators.includes(row.org_id)
    && (row.org_id === orgId || (row.scope === "subtree" && ancestors.includes(row.org_id))));
}

/** `SH-2026-11-000001` as issued by the transfer series; anything else is not an invoice number of this page. */
export const TRANSFER_INVOICE_NUMBER = /^SH-[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{6,12}$/;
