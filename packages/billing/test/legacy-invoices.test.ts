import assert from "node:assert/strict";
import { test } from "node:test";
import {
  legacyInvoiceNumber, mapLegacyInvoices, normalizeLegacyAmount, reconcileLegacyInvoices, sumLegacyAmounts,
  LEGACY_TRANSFER_STATUS, type LegacyInvoiceRecord, type LegacyInvoiceSourceRow,
} from "../src/legacy-invoices.js";
import { parseDecimalString } from "../src/decimal-string.js";

// Synthetic legacy rows only: ids, dates, statuses and amounts.
const row = (over: Partial<LegacyInvoiceSourceRow> = {}): LegacyInvoiceSourceRow => ({
  invoiceId: "101", transferId: "501", parentTransferId: null, companyId: "7", invoiceDate: "2026-09-30",
  invoiceStatus: "unpaid", invoiceDeleted: false, transferStatus: LEGACY_TRANSFER_STATUS.lock,
  transferDeleted: false, companyTotal: "125.5", currencyCode: "KWD", ...over,
});
const d = (value: string) => parseDecimalString(value, 3);

test("LEGACY_INVOICE_NUMBER legacy ids are kept verbatim in the LEGACY namespace", () => {
  assert.equal(legacyInvoiceNumber("101"), "LEGACY-101");
  for (const bad of ["0", "01", "-1", "1.5", " 1", "ACME", ""]) assert.throws(() => legacyInvoiceNumber(bad), TypeError);
  const { records } = mapLegacyInvoices([row()]);
  assert.equal(records[0]?.invoiceNumber, "LEGACY-101");
  assert.equal(records[0]?.legacyInvoiceId, "101");
});

test("LEGACY_INVOICE_AMOUNT totals are exact three-place decimals, never floats", () => {
  assert.equal(normalizeLegacyAmount("125.5"), "125.500");
  assert.equal(normalizeLegacyAmount("0.1"), "0.100");
  assert.equal(normalizeLegacyAmount("12"), "12.000");
  assert.equal(normalizeLegacyAmount("-0"), "0.000");
  assert.equal(normalizeLegacyAmount("-3.25"), "-3.250");
  for (const bad of ["1.2345", "1e3", "", " 1", "01.0", "abc"]) assert.throws(() => normalizeLegacyAmount(bad), TypeError);
  assert.throws(() => normalizeLegacyAmount(1.5 as unknown as string), TypeError);
  // 0.1 + 0.2 in floating point is 0.30000000000000004; in fils it is exact.
  assert.equal(sumLegacyAmounts([d("0.100"), d("0.200")]), "0.300");
  assert.equal(sumLegacyAmounts([d("9007199254740.993"), d("0.008")]), "9007199254741.001");
  assert.equal(sumLegacyAmounts([d("1.000"), d("-3.250")]), "-2.250");
  assert.equal(sumLegacyAmounts([]), "0.000");
});

test("LEGACY_INVOICE_REJECTS unimportable rows are rejected by id, never silently dropped", () => {
  const { records, rejected } = mapLegacyInvoices([
    row({ invoiceId: "1" }),
    row({ invoiceId: "2", invoiceStatus: "overdue" }),
    row({ invoiceId: "3", invoiceDate: "2026-02-30" }),
    row({ invoiceId: "4", companyTotal: "1.2345" }),
    row({ invoiceId: "5", currencyCode: "kwd" }),
    row({ invoiceId: "1" }),
    row({ invoiceId: "x" }),
  ]);
  assert.deepEqual(records.map(r => r.legacyInvoiceId), ["1"]);
  assert.deepEqual(rejected, [
    { invoiceId: "2", kind: "unknown_status" }, { invoiceId: "3", kind: "invalid_date" },
    { invoiceId: "4", kind: "invalid_total" }, { invoiceId: "5", kind: "invalid_currency" },
    { invoiceId: "1", kind: "duplicate_invoice_id" }, { invoiceId: "x", kind: "invalid_id" },
  ]);
});

test("LEGACY_INVOICE_FLAGS invoices on cancelled or draft transfers are imported and flagged; deleted rows are kept", () => {
  const { records, flagged } = mapLegacyInvoices([
    row({ invoiceId: "1", transferStatus: LEGACY_TRANSFER_STATUS.cancel }),
    row({ invoiceId: "2", transferStatus: LEGACY_TRANSFER_STATUS.initiated }),
    row({ invoiceId: "3", transferStatus: LEGACY_TRANSFER_STATUS.cancel, transferDeleted: true }),
    row({ invoiceId: "4", invoiceDeleted: true }),
  ]);
  assert.deepEqual(records.map(r => [r.legacyInvoiceId, r.deleted]), [["1", false], ["2", false], ["3", true], ["4", true]]);
  assert.deepEqual(flagged, [{ invoiceId: "1", kind: "invoice_on_cancelled_transfer" }, { invoiceId: "2", kind: "invoice_on_draft_transfer" }]);
});

test("LEGACY_INVOICE_RECONCILE clean import: counts and sums by company, currency and status match exactly", () => {
  const source = [
    row({ invoiceId: "1", companyTotal: "0.1" }),
    row({ invoiceId: "2", companyTotal: "0.2" }),
    row({ invoiceId: "3", invoiceStatus: "paid", companyTotal: "10" }),
    row({ invoiceId: "4", companyId: "8", currencyCode: "BHD", companyTotal: "5.555", parentTransferId: "500" }),
    row({ invoiceId: "5", invoiceDeleted: true, companyTotal: "999" }),
  ];
  const report = reconcileLegacyInvoices(source, mapLegacyInvoices(source).records);
  assert.equal(report.clean, true);
  assert.deepEqual(report.totals, {
    "7|KWD|paid": { source: { count: 1, sum: "10.000" }, target: { count: 1, sum: "10.000" } },
    "7|KWD|unpaid": { source: { count: 2, sum: "0.300" }, target: { count: 2, sum: "0.300" } },
    "8|BHD|unpaid": { source: { count: 1, sum: "5.555" }, target: { count: 1, sum: "5.555" } },
  }, "deleted invoices are excluded from the finance totals");
  assert.deepEqual([report.missingInTarget, report.extraInTarget, report.changed], [[], [], []]);
});

test("LEGACY_INVOICE_DIFF missing, extra, changed and rejected rows make the report unclean, by id only", () => {
  const source = [row({ invoiceId: "1" }), row({ invoiceId: "2" }), row({ invoiceId: "3" })];
  const imported = mapLegacyInvoices(source).records;
  const tampered: LegacyInvoiceRecord[] = [
    imported[0]!,
    { ...imported[1]!, total: d("125.501") },
    { ...imported[0]!, invoiceNumber: "LEGACY-9", legacyInvoiceId: "9" },
  ];
  const report = reconcileLegacyInvoices(source, tampered);
  assert.equal(report.clean, false);
  assert.deepEqual(report.missingInTarget, ["LEGACY-3"]);
  assert.deepEqual(report.extraInTarget, ["LEGACY-9"]);
  assert.deepEqual(report.changed, ["LEGACY-2"]);
  assert.equal(JSON.stringify(report).includes("Synthetic"), false);

  const totalsOnly = reconcileLegacyInvoices(source, imported.map(r => r.invoiceNumber === "LEGACY-1" ? { ...r, status: "paid" as const } : r));
  assert.deepEqual(totalsOnly.changed, ["LEGACY-1"]);
  assert.equal(totalsOnly.clean, false);

  const rejectedOnly = reconcileLegacyInvoices([...source, row({ invoiceId: "4", invoiceStatus: "void" })], imported);
  assert.deepEqual(rejectedOnly.rejected, [{ invoiceId: "4", kind: "unknown_status" }]);
  assert.equal(rejectedOnly.clean, false, "a rejected row is an unexplained difference");
});
