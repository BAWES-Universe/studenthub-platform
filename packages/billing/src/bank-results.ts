/** Bank result files (F5), pure part. Source: legacy TransferController::actionImportExcel
 * (AUB result workbook) and TransferFile::process()/populateEntries (KFH workbook).
 * Inbound only: StudentHub reads what the bank reports and never moves money.
 * No DB, clock, filesystem or transport. The store applies a plan inside the
 * transfer lifecycle transaction; this module only reads rows and decides.
 *
 * Deliberate change from legacy: a row that cannot be matched safely is held for
 * a person instead of failing the whole file. Matching uses the line id the
 * outbound file wrote first; the KFH beneficiary-account match is a fallback and
 * holds on any tie instead of taking the newest line.
 */
import { parseDecimalString, type DecimalString } from "./decimal-string.js";

export type BankResultFormat = "aub" | "kfh";
export type BankResultOutcome = "success" | "fail";
export type BankCell = string | number | null | undefined;

export interface BankResultRow {
  /** 1-based row number in the sheet, for the person reviewing a held row. */
  readonly rowNumber: number;
  readonly outcome: BankResultOutcome;
  /** Line id written by the outbound file, when the bank echoes it back. */
  readonly lineRef: string | null;
  /** Bank's confirmation or reference number for this payment. */
  readonly reference: string | null;
  readonly account: string | null;
  readonly amount: DecimalString | null;
  readonly currency: string | null;
}

export type BankRowProblem = "missing_status" | "unknown_status" | "invalid_amount" | "missing_match_key";
export interface BankRowRejected { readonly rowNumber: number; readonly problem: BankRowProblem }

export type BankSheetResult =
  | { readonly kind: "read"; readonly rows: readonly BankResultRow[]; readonly rejected: readonly BankRowRejected[] }
  | { readonly kind: "refused"; readonly code: "missing_headers" | "no_rows"; readonly missing?: readonly string[] };

interface Layout {
  readonly headerRow: number;
  readonly required: readonly string[];
  readonly status: string | null;
  readonly lineRef: string | null;
  readonly reference: string;
  readonly account: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
}

/** Header rows and names as legacy reads them (AUB: row 2; KFH: row 9, no status column). */
const LAYOUTS: Readonly<Record<BankResultFormat, Layout>> = {
  aub: {
    headerRow: 2, required: ["Status", "Status Description", "Credit Narrative"],
    status: "Status", lineRef: "Credit Narrative", reference: "Status Description",
    account: null, amount: null, currency: null,
  },
  kfh: {
    headerRow: 9, required: ["Beneficiary Account", "Amount", "Transfer Currency", "Refrence Number"],
    status: null, lineRef: null, reference: "Refrence Number",
    account: "Beneficiary Account", amount: "Amount", currency: "Transfer Currency",
  },
};

export const MAX_BANK_RESULT_ROWS = 10000;

function text(cell: BankCell): string | null {
  if (cell === null || cell === undefined) return null;
  const value = (typeof cell === "number" ? (Number.isFinite(cell) ? String(cell) : "") : cell).trim();
  return value === "" ? null : value;
}

/** Bank amounts to exact 3-place text. Numbers come from the sheet reader; up to
 * 3 decimals only, never rounded, so a 4th decimal is refused instead of hidden. */
export function bankAmount(cell: BankCell): DecimalString | null {
  const raw = text(cell);
  if (raw === null) return null;
  const plain = raw.replaceAll(",", "");
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,3}))?$/u.exec(plain);
  if (!match) throw new TypeError("invalid bank amount");
  return parseDecimalString(`${match[1]}.${(match[2] ?? "").padEnd(3, "0")}`, 3);
}

/** Read sheet cells (row arrays, row 1 first) in one of the legacy layouts. */
export function readBankResultSheet(format: BankResultFormat, cells: readonly (readonly BankCell[])[]): BankSheetResult {
  const layout = LAYOUTS[format];
  const header = (cells[layout.headerRow - 1] ?? []).map((cell) => text(cell));
  const index = new Map<string, number>();
  header.forEach((name, i) => { if (name !== null && !index.has(name)) index.set(name, i); });
  const missing = layout.required.filter((name) => !index.has(name));
  if (missing.length) return { kind: "refused", code: "missing_headers", missing };
  const at = (row: readonly BankCell[], name: string | null): BankCell => (name === null ? null : row[index.get(name)!]);

  const rows: BankResultRow[] = [];
  const rejected: BankRowRejected[] = [];
  for (let i = layout.headerRow; i < cells.length; i++) {
    const row = cells[i] ?? [];
    if (row.every((cell) => text(cell) === null)) continue;
    const rowNumber = i + 1;
    let outcome: BankResultOutcome = "success";
    if (layout.status !== null) {
      const status = text(at(row, layout.status));
      if (status === null) { rejected.push({ rowNumber, problem: "missing_status" }); continue; }
      if (status === "SUCCESS") outcome = "success";
      else if (status === "FAIL") outcome = "fail";
      else { rejected.push({ rowNumber, problem: "unknown_status" }); continue; }
    }
    let amount: DecimalString | null;
    try { amount = bankAmount(at(row, layout.amount)); } catch { rejected.push({ rowNumber, problem: "invalid_amount" }); continue; }
    const lineRef = text(at(row, layout.lineRef));
    const account = text(at(row, layout.account));
    const currency = text(at(row, layout.currency));
    if (lineRef === null && (account === null || amount === null || currency === null)) {
      rejected.push({ rowNumber, problem: "missing_match_key" });
      continue;
    }
    rows.push({ rowNumber, outcome, lineRef, reference: text(at(row, layout.reference)), account, amount, currency });
  }
  if (rows.length + rejected.length === 0) return { kind: "refused", code: "no_rows" };
  if (rows.length + rejected.length > MAX_BANK_RESULT_ROWS) throw new RangeError("bank result file has too many rows");
  return { kind: "read", rows, rejected };
}

/** A pay line as the store sees it when the file is applied. */
export interface BankCandidateLine {
  readonly lineId: string;
  readonly transferId: string;
  readonly paid: boolean;
  /** Frozen amount paid to the person, 3 places. */
  readonly paidAmount: DecimalString;
  readonly currency: string;
  readonly beneficiaryAccount: string | null;
  readonly confirmationId: string | null;
}

export type BankHoldReason =
  | "rejected_row" | "unmatched" | "ambiguous" | "amount_mismatch" | "currency_mismatch"
  | "already_paid" | "line_listed_twice";

export type BankRowDecision =
  | { readonly kind: "pay"; readonly rowNumber: number; readonly lineId: string; readonly transferId: string; readonly reference: string | null }
  | { readonly kind: "unpay"; readonly rowNumber: number; readonly lineId: string; readonly transferId: string; readonly wasPaid: boolean }
  | { readonly kind: "duplicate"; readonly rowNumber: number; readonly lineId: string }
  | { readonly kind: "hold"; readonly rowNumber: number; readonly reason: BankHoldReason; readonly lineIds: readonly string[] };

export interface BankResultPlan {
  readonly decisions: readonly BankRowDecision[];
  /** Transfers touched by pay or unpay, sorted, for the lifecycle step. */
  readonly transferIds: readonly string[];
}

const hold = (rowNumber: number, reason: BankHoldReason, lineIds: readonly string[] = []): BankRowDecision =>
  ({ kind: "hold", rowNumber, reason, lineIds: [...lineIds].sort() });

/** Decide every row against the candidate lines. Pure; same input, same plan. */
export function planBankResult(sheet: Extract<BankSheetResult, { kind: "read" }>, lines: readonly BankCandidateLine[]): BankResultPlan {
  const byId = new Map<string, BankCandidateLine>();
  for (const line of lines) {
    if (byId.has(line.lineId)) throw new TypeError("duplicate candidate line");
    byId.set(line.lineId, line);
  }
  const claimed = new Set<string>();
  const decisions: BankRowDecision[] = sheet.rejected.map((r) => hold(r.rowNumber, "rejected_row"));

  for (const row of sheet.rows) {
    let line: BankCandidateLine | undefined;
    if (row.lineRef !== null) {
      line = byId.get(row.lineRef);
      if (!line) { decisions.push(hold(row.rowNumber, "unmatched")); continue; }
      if (row.currency !== null && row.currency !== line.currency) { decisions.push(hold(row.rowNumber, "currency_mismatch", [line.lineId])); continue; }
      if (row.amount !== null && row.amount !== line.paidAmount) { decisions.push(hold(row.rowNumber, "amount_mismatch", [line.lineId])); continue; }
    } else {
      if (row.outcome === "fail") { decisions.push(hold(row.rowNumber, "unmatched")); continue; }
      const same = (l: BankCandidateLine) => l.beneficiaryAccount === row.account && l.paidAmount === row.amount && l.currency === row.currency;
      const unpaid = lines.filter((l) => !l.paid && same(l));
      const open = unpaid.filter((l) => !claimed.has(l.lineId));
      if (open.length > 1) { decisions.push(hold(row.rowNumber, "ambiguous", open.map((l) => l.lineId))); continue; }
      if (open.length === 0 && unpaid.length > 0) { decisions.push(hold(row.rowNumber, "line_listed_twice", unpaid.map((l) => l.lineId))); continue; }
      if (open.length === 0) {
        const done = row.reference === null ? [] : lines.filter((l) => l.paid && same(l) && l.confirmationId === row.reference);
        if (done.length === 1) decisions.push({ kind: "duplicate", rowNumber: row.rowNumber, lineId: done[0]!.lineId });
        else decisions.push(hold(row.rowNumber, done.length > 1 ? "ambiguous" : "unmatched", done.map((l) => l.lineId)));
        continue;
      }
      line = open[0]!;
    }
    if (claimed.has(line.lineId)) { decisions.push(hold(row.rowNumber, "line_listed_twice", [line.lineId])); continue; }
    claimed.add(line.lineId);
    if (row.outcome === "fail") {
      decisions.push({ kind: "unpay", rowNumber: row.rowNumber, lineId: line.lineId, transferId: line.transferId, wasPaid: line.paid });
    } else if (line.paid) {
      decisions.push(row.reference !== null && line.confirmationId === row.reference
        ? { kind: "duplicate", rowNumber: row.rowNumber, lineId: line.lineId }
        : hold(row.rowNumber, "already_paid", [line.lineId]));
    } else {
      decisions.push({ kind: "pay", rowNumber: row.rowNumber, lineId: line.lineId, transferId: line.transferId, reference: row.reference });
    }
  }
  decisions.sort((a, b) => a.rowNumber - b.rowNumber);
  const transferIds = [...new Set(decisions.flatMap((d) => (d.kind === "pay" || d.kind === "unpay" ? [d.transferId] : [])))].sort();
  return { decisions, transferIds };
}
