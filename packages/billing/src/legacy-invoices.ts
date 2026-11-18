import { parseDecimalString, type DecimalString } from "./decimal-string.js";

/**
 * Legacy invoice import (F4.6). Legacy keeps one `invoice` row per main or child
 * transfer; its number is the autoincrement `invoice_id`, already printed on
 * documents, so it is kept verbatim in the reserved LEGACY namespace. The total is
 * not stored on the invoice: legacy computes it as `transfer.company_total`.
 *
 * Nothing here reads names, emails or any personal field: a source row carries ids,
 * a date, a status, an amount and a currency only, so reports are safe to publish.
 */
export const LEGACY_INVOICE_SCALE = 3;

/** Legacy `transfer.transfer_status` values (docs/parity/finance-contracts-and-payroll.md §5). */
export const LEGACY_TRANSFER_STATUS = Object.freeze({
  cancel: 0, paymentSent: 1, distributing: 3, complete: 4, lock: 5, initiated: 10,
});

export interface LegacyInvoiceSourceRow {
  readonly invoiceId: string;
  readonly transferId: string;
  readonly parentTransferId: string | null;
  readonly companyId: string;
  /** `invoice.invoice_date`, YYYY-MM-DD. */
  readonly invoiceDate: string;
  /** `invoice.invoice_status`: a free string in legacy; only 'unpaid' and 'paid' are written by code. */
  readonly invoiceStatus: string;
  readonly invoiceDeleted: boolean;
  readonly transferStatus: number;
  readonly transferDeleted: boolean;
  /** `transfer.company_total` as exact decimal text. */
  readonly companyTotal: string;
  readonly currencyCode: string;
}

export type LegacyInvoiceStatus = "unpaid" | "paid";

export interface LegacyInvoiceRecord {
  readonly invoiceNumber: string;
  readonly legacyInvoiceId: string;
  readonly transferId: string;
  readonly parentTransferId: string | null;
  readonly companyId: string;
  readonly invoiceDate: string;
  readonly status: LegacyInvoiceStatus;
  readonly total: DecimalString;
  readonly currencyCode: string;
  /** Legacy soft delete (invoice or its transfer). Kept, because the number may have been printed. */
  readonly deleted: boolean;
}

export type LegacyInvoiceAnomalyKind =
  | "invalid_id" | "invalid_date" | "invalid_total" | "invalid_currency" | "unknown_status"
  | "duplicate_invoice_id" | "invoice_on_cancelled_transfer" | "invoice_on_draft_transfer";

export interface LegacyInvoiceAnomaly { readonly invoiceId: string; readonly kind: LegacyInvoiceAnomalyKind }

export interface LegacyInvoiceMapping {
  readonly records: readonly LegacyInvoiceRecord[];
  /** Rows that cannot be imported. Each one is an unexplained difference until a person dispositions it. */
  readonly rejected: readonly LegacyInvoiceAnomaly[];
  /** Imported, but worth a person's look (legacy normally has no invoice on these transfers). */
  readonly flagged: readonly LegacyInvoiceAnomaly[];
}

const ID = /^[1-9][0-9]{0,18}$/;
const BIGINT_MAX = 9223372036854775807n;
/** A positive id that fits PostgreSQL BIGINT, checked exactly. */
function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && BigInt(value) <= BIGINT_MAX;
}
/** NUMERIC(18, 3) holds at most 15 integer digits. */
const MAX_TOTAL_INTEGER_DIGITS = 15;

export function legacyInvoiceNumber(invoiceId: string): string {
  if (!validId(invoiceId)) throw new TypeError("invalid legacy invoice id");
  return `LEGACY-${invoiceId}`;
}

function validDate(value: unknown): value is string {
  // PostgreSQL has no year zero; JavaScript's proleptic calendar does.
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Normalizes a legacy decimal to exactly three places without passing through Number. */
export function normalizeLegacyAmount(value: unknown): DecimalString {
  if (typeof value !== "string") throw new TypeError("invalid legacy amount");
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?$/.exec(value.trim() === value ? value : "");
  if (!match) throw new TypeError("invalid legacy amount");
  const [, sign, whole, fraction = ""] = match;
  const text = `${whole}.${fraction.padEnd(LEGACY_INVOICE_SCALE, "0")}`;
  return parseDecimalString(sign && /[1-9]/.test(text) ? `-${text}` : text, LEGACY_INVOICE_SCALE);
}

export function mapLegacyInvoices(rows: readonly LegacyInvoiceSourceRow[]): LegacyInvoiceMapping {
  const records: LegacyInvoiceRecord[] = [];
  const rejected: LegacyInvoiceAnomaly[] = [];
  const flagged: LegacyInvoiceAnomaly[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const invoiceId = String(row.invoiceId);
    const reject = (kind: LegacyInvoiceAnomalyKind) => { rejected.push({ invoiceId, kind }); };
    if (!validId(invoiceId) || !validId(String(row.transferId)) || !validId(String(row.companyId))
      || !(row.parentTransferId === null || validId(String(row.parentTransferId)))) { reject("invalid_id"); continue; }
    if (seen.has(invoiceId)) { reject("duplicate_invoice_id"); continue; }
    seen.add(invoiceId);
    if (!validDate(row.invoiceDate)) { reject("invalid_date"); continue; }
    if (row.invoiceStatus !== "unpaid" && row.invoiceStatus !== "paid") { reject("unknown_status"); continue; }
    if (typeof row.currencyCode !== "string" || !/^[A-Z]{3}$/.test(row.currencyCode)) { reject("invalid_currency"); continue; }
    let total: DecimalString;
    try { total = normalizeLegacyAmount(row.companyTotal); } catch { reject("invalid_total"); continue; }
    // Per-row storage range only; aggregate sums stay unbounded.
    if (total.replace("-", "").split(".")[0]!.length > MAX_TOTAL_INTEGER_DIGITS) { reject("invalid_total"); continue; }
    const deleted = row.invoiceDeleted === true || row.transferDeleted === true;
    if (!deleted && row.transferStatus === LEGACY_TRANSFER_STATUS.cancel) flagged.push({ invoiceId, kind: "invoice_on_cancelled_transfer" });
    if (!deleted && row.transferStatus === LEGACY_TRANSFER_STATUS.initiated) flagged.push({ invoiceId, kind: "invoice_on_draft_transfer" });
    records.push(Object.freeze({
      invoiceNumber: legacyInvoiceNumber(invoiceId), legacyInvoiceId: invoiceId,
      transferId: String(row.transferId), parentTransferId: row.parentTransferId === null ? null : String(row.parentTransferId),
      companyId: String(row.companyId), invoiceDate: row.invoiceDate, status: row.invoiceStatus,
      total, currencyCode: row.currencyCode, deleted,
    }));
  }
  return Object.freeze({ records: Object.freeze(records), rejected: Object.freeze(rejected), flagged: Object.freeze(flagged) });
}

/** Exact sum of three-place decimal strings using integer fils. */
export function sumLegacyAmounts(values: readonly DecimalString[]): DecimalString {
  let fils = 0n;
  for (const value of values) {
    const negative = value.startsWith("-");
    const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
    const amount = BigInt(whole) * 1000n + BigInt(fraction);
    fils += negative ? -amount : amount;
  }
  const negative = fils < 0n;
  const abs = negative ? -fils : fils;
  const text = `${abs / 1000n}.${(abs % 1000n).toString().padStart(3, "0")}`;
  return parseDecimalString(negative ? `-${text}` : text, LEGACY_INVOICE_SCALE);
}

export interface LegacyInvoiceTotals { readonly count: number; readonly sum: DecimalString }

export interface LegacyInvoiceReconciliation {
  /** Keyed `companyId|currency|status`, live (not deleted) invoices only, as finance reads them. */
  readonly totals: Readonly<Record<string, { readonly source: LegacyInvoiceTotals; readonly target: LegacyInvoiceTotals }>>;
  readonly missingInTarget: readonly string[];
  readonly extraInTarget: readonly string[];
  readonly changed: readonly string[];
  readonly rejected: readonly LegacyInvoiceAnomaly[];
  readonly flagged: readonly LegacyInvoiceAnomaly[];
  /** Zero unexplained difference: every source row imported unchanged, no extras, no rejects, equal totals. */
  readonly clean: boolean;
}

const key = (record: LegacyInvoiceRecord) => `${record.companyId}|${record.currencyCode}|${record.status}`;
const sameRecord = (left: LegacyInvoiceRecord, right: LegacyInvoiceRecord) =>
  (Object.keys(left) as (keyof LegacyInvoiceRecord)[]).every(field => left[field] === right[field])
  && Object.keys(left).length === Object.keys(right).length;

function totalsOf(records: readonly LegacyInvoiceRecord[]): Map<string, DecimalString[]> {
  const totals = new Map<string, DecimalString[]>();
  for (const record of records) {
    if (record.deleted) continue;
    const list = totals.get(key(record)) ?? [];
    list.push(record.total);
    totals.set(key(record), list);
  }
  return totals;
}

/**
 * Compares the legacy source with what the rebuild holds. The report carries ids,
 * counts and sums only, so it can go on the desk and in CI logs.
 */
export function reconcileLegacyInvoices(source: readonly LegacyInvoiceSourceRow[], target: readonly LegacyInvoiceRecord[]): LegacyInvoiceReconciliation {
  const mapping = mapLegacyInvoices(source);
  const expected = new Map(mapping.records.map(record => [record.invoiceNumber, record]));
  const actual = new Map(target.map(record => [record.invoiceNumber, record]));
  const missingInTarget = [...expected.keys()].filter(number => !actual.has(number)).sort();
  const extraInTarget = [...actual.keys()].filter(number => !expected.has(number)).sort();
  const changed = [...expected.entries()]
    .filter(([number, record]) => actual.has(number) && !sameRecord(record, actual.get(number)!))
    .map(([number]) => number).sort();
  const sourceTotals = totalsOf(mapping.records);
  const targetTotals = totalsOf(target);
  const totals: Record<string, { source: LegacyInvoiceTotals; target: LegacyInvoiceTotals }> = {};
  let totalsMatch = true;
  for (const group of [...new Set([...sourceTotals.keys(), ...targetTotals.keys()])].sort()) {
    const sourceList = sourceTotals.get(group) ?? [];
    const targetList = targetTotals.get(group) ?? [];
    const entry = {
      source: { count: sourceList.length, sum: sumLegacyAmounts(sourceList) },
      target: { count: targetList.length, sum: sumLegacyAmounts(targetList) },
    };
    if (entry.source.count !== entry.target.count || entry.source.sum !== entry.target.sum) totalsMatch = false;
    totals[group] = entry;
  }
  const clean = missingInTarget.length === 0 && extraInTarget.length === 0 && changed.length === 0
    && mapping.rejected.length === 0 && totalsMatch;
  return Object.freeze({ totals, missingInTarget, extraInTarget, changed, rejected: mapping.rejected, flagged: mapping.flagged, clean });
}
