import { buildPdf, encodable, fitText, PdfPage, type Rgb } from "../../../../packages/reports/src/pdf.js";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";

/**
 * The invoice or receipt of one transfer invoice, as legacy prints it (admin views
 * `transfer/invoice.php` and `transfer/receipt.php`): an unpaid invoice is an "Invoice" with
 * payment terms and bank details; a paid one is a "Receipt" saying no payment is required.
 * Only frozen invoice fields are printed, plus the transfer's period and the company's name.
 *
 * Deliberate differences from legacy: the receipt's payment date is the day payment was
 * received (legacy repeated the invoice date), and the per-rate hours breakdown is not printed
 * yet; the total, which legacy also prints, is the invoice's frozen total.
 */
export interface InvoicePdfInput {
  readonly invoiceNumber: string;
  readonly transferId: string;
  readonly companyName: string;
  readonly currencyCode: string;
  readonly invoiceDate: string;
  readonly total: string;
  readonly lineCount: number;
  readonly status: "unpaid" | "paid";
  readonly paidOn: string | null;
  /** The credit note that voided this invoice (F4.7), and its date. */
  readonly creditNumber?: string | null;
  readonly creditedOn?: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
}
/** Legacy `params['bankInfo']`; printed on unpaid invoices when configured. */
export interface InvoiceBankInfo {
  readonly accountName: string;
  readonly bankName: string;
  readonly iban: string;
  readonly accountNumber: string;
  readonly swiftCode: string;
}

export const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
const NAVY: Rgb = [0x1f, 0x2a, 0x6b], INK: Rgb = [0x25, 0x25, 0x25], GREY: Rgb = [0x66, 0x66, 0x66], RULE: Rgb = [0xdd, 0xdd, 0xdd], WHITE: Rgb = [255, 255, 255];
const latin = (text: string) => encodable(text) ? text : [...text.normalize("NFC")].filter(ch => encodable(ch)).join("").replace(/\s+/g, " ").trim();

/** Parses `BILLING_BANK_INFO` (JSON with the five fields); unset means no bank block. Anything malformed stops startup. */
export function invoiceBankInfo(value: string | undefined): InvoiceBankInfo | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("BILLING_BANK_INFO must be JSON"); }
  const keys = ["accountName", "bankName", "iban", "accountNumber", "swiftCode"];
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).sort().join() !== [...keys].sort().join()
    || keys.some(k => { const v = (parsed as Record<string, unknown>)[k]; return typeof v !== "string" || !v.trim() || v.length > 120 || !encodable(v); })) {
    throw new Error("BILLING_BANK_INFO must hold accountName, bankName, iban, accountNumber and swiftCode as Latin text");
  }
  return Object.freeze(parsed as InvoiceBankInfo);
}

export function invoicePdf(invoice: InvoicePdfInput, bank?: InvoiceBankInfo): Buffer {
  const { width: w, height: h } = A4_PORTRAIT, left = 56, right = w - 56, inner = right - left;
  const paid = invoice.status === "paid";
  const credit = invoice.creditNumber ? `Voided by credit note ${invoice.creditNumber}${invoice.creditedOn ? ` on ${longDate(invoice.creditedOn)}` : ""}` : undefined;
  const page = new PdfPage(w, h);
  page.rect(0, 0, w, h, WHITE);
  page.text(left, h - 72, "StudentHub", 26, NAVY, "bold");
  page.text(right, h - 72, paid ? "Receipt" : "Invoice", 26, INK, "bold", "right");
  page.rect(left, h - 90, inner, 1, RULE);

  let y = h - 124;
  page.text(left, y, "Bill to", 12, INK, "bold");
  const name = fitText(latin(invoice.companyName) || "Company", inner / 2 - 12, 11, 8);
  page.text(left, y - 18, name.text, name.size, GREY);

  const col = left + inner / 2;
  page.text(col, y, "Details", 12, INK, "bold");
  const details = [
    `Invoice number: ${invoice.invoiceNumber}`,
    `Transfer number: ${invoice.transferId}`,
    paid ? `Payment date: ${longDate(invoice.paidOn ?? invoice.invoiceDate)}` : `Issue date: ${longDate(invoice.invoiceDate)}`,
    ...(credit ? [credit] : paid ? [] : ["Payment terms: Due immediately"]),
    `${paid ? "Amount paid" : "Amount due"} in ${invoice.currencyCode}: ${invoice.total}`,
  ];
  details.forEach((line, i) => { const fit = fitText(line, inner / 2, 10, 7); page.text(col, y - 18 - i * 16, fit.text, fit.size, GREY); });

  y -= 18 + details.length * 16 + 28;
  page.rect(left, y + 14, inner, 1, RULE);
  page.text(left, y, `For time period: ${longDate(invoice.periodStart)} to ${longDate(invoice.periodEnd)}`, 10, GREY);
  y -= 28;
  const interns = `${invoice.lineCount} ${invoice.lineCount === 1 ? "intern" : "interns"}`;
  page.text(left, y, `${paid ? "Amount paid" : "Amount Due"} for ${interns}`, 12, INK, "bold");
  page.text(right, y, `${invoice.currencyCode} ${invoice.total}`, 12, INK, "bold", "right");
  page.rect(left, y - 12, inner, 1, RULE);

  y -= 48;
  page.text(left, y, credit ? `${credit}. No payment is required.` : paid ? "No payment is required. This is a confirmation that we have received the requested amount."
    : "Thank you for your business. It’s a pleasure working with you.", 10, GREY);
  page.text(left, y - 28, "Sincerely yours,", 10, GREY);
  page.text(left, y - 48, "Khalid Al-Mutawa", 11, INK, "bold");

  if (!paid && !credit && bank) {
    let b = y - 100;
    page.text(left, b, "Bank Info", 12, INK, "bold");
    for (const line of [bank.accountName, bank.bankName, `IBAN: ${bank.iban}`, `Account #: ${bank.accountNumber}`, `Swift: ${bank.swiftCode}`]) {
      b -= 16; const fit = fitText(line, inner, 10, 7); page.text(left, b, fit.text, fit.size, GREY);
    }
  }
  return buildPdf([page], `StudentHub ${paid ? "receipt" : "invoice"} ${invoice.invoiceNumber}`);
}
