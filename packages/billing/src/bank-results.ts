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
}

export type BankHoldReason =
  | "rejected_row" | "unmatched" | "ambiguous" | "amount_mismatch" | "currency_mismatch"
  | "already_paid" | "line_listed_twice" | "reference_conflict" | "missing_reference" | "paid_line_failed";

/** A bank confirmation already recorded on a paid line, from ANY earlier file or
 * transfer. Looked up by reference only; never a candidate to apply. */
export interface BankRecordedPayment {
  readonly lineId: string;
  readonly reference: string;
  readonly account: string | null;
  readonly amount: DecimalString;
  readonly currency: string;
}

export type BankRowDecision =
  | { readonly kind: "pay"; readonly rowNumber: number; readonly lineId: string; readonly transferId: string; readonly reference: string | null }
  | { readonly kind: "unpay"; readonly rowNumber: number; readonly lineId: string; readonly transferId: string }
  | { readonly kind: "duplicate"; readonly rowNumber: number; readonly lineId: string }
  | { readonly kind: "hold"; readonly rowNumber: number; readonly reason: BankHoldReason; readonly lineIds: readonly string[] };

export interface BankResultPlan {
  readonly decisions: readonly BankRowDecision[];
  /** Transfers touched by pay or unpay, sorted, for the lifecycle step. */
  readonly transferIds: readonly string[];
}

const hold = (rowNumber: number, reason: BankHoldReason, lineIds: readonly string[] = []): BankRowDecision =>
  ({ kind: "hold", rowNumber, reason, lineIds: [...lineIds].sort() });

/** Decide every row. `lines` are the candidates a row may apply to; `recorded`
 * is the separate history of confirmations already applied, so a replayed row is
 * recognised before any unpaid fallback can claim a different line. Pure; same
 * input, same plan. */
export function planBankResult(
  sheet: Extract<BankSheetResult, { kind: "read" }>,
  lines: readonly BankCandidateLine[],
  recorded: readonly BankRecordedPayment[],
): BankResultPlan {
  const byId = new Map<string, BankCandidateLine>();
  for (const line of lines) {
    if (byId.has(line.lineId)) throw new TypeError("duplicate candidate line");
    byId.set(line.lineId, line);
  }
  // A reference carried by more than one success row is contradictory as a group:
  // hold every row in it, so row order never decides which line is paid.
  const uses = new Map<string, number>();
  for (const row of sheet.rows) {
    if (row.outcome === "success" && row.reference !== null) uses.set(row.reference, (uses.get(row.reference) ?? 0) + 1);
  }
  const decisions: BankRowDecision[] = sheet.rejected.map((r) => hold(r.rowNumber, "rejected_row"));

  for (const row of sheet.rows) {
    // A success row's reference is the bank's confirmation: resolve its provenance first.
    const prior = row.outcome === "success" && row.reference !== null
      ? recorded.filter((r) => r.reference === row.reference) : [];
    if (row.outcome === "success" && row.reference !== null && uses.get(row.reference)! > 1) {
      decisions.push(hold(row.rowNumber, "reference_conflict", prior.map((r) => r.lineId)));
      continue;
    }
    let line: BankCandidateLine | undefined;
    if (row.lineRef !== null) {
      line = byId.get(row.lineRef);
      if (!line) { decisions.push(hold(row.rowNumber, prior.length ? "reference_conflict" : "unmatched", prior.map((r) => r.lineId))); continue; }
      if (row.currency !== null && row.currency !== line.currency) { decisions.push(hold(row.rowNumber, "currency_mismatch", [line.lineId])); continue; }
      if (row.amount !== null && row.amount !== line.paidAmount) { decisions.push(hold(row.rowNumber, "amount_mismatch", [line.lineId])); continue; }
      if (prior.length) {
        const replay = prior.length === 1 && prior[0]!.lineId === line.lineId && line.paid;
        decisions.push(replay ? { kind: "duplicate", rowNumber: row.rowNumber, lineId: line.lineId }
          : hold(row.rowNumber, "reference_conflict", [...new Set([line.lineId, ...prior.map((r) => r.lineId)])]));
        continue;
      }
    } else {
      if (row.outcome === "fail") { decisions.push(hold(row.rowNumber, "unmatched")); continue; }
      // Without an echoed id, only the bank's reference proves a row is new; no reference, no fallback.
      if (row.reference === null) { decisions.push(hold(row.rowNumber, "missing_reference")); continue; }
      if (prior.length) {
        const p = prior[0]!;
        const replay = prior.length === 1 && p.account === row.account && p.amount === row.amount && p.currency === row.currency;
        decisions.push(replay ? { kind: "duplicate", rowNumber: row.rowNumber, lineId: p.lineId }
          : hold(row.rowNumber, "reference_conflict", prior.map((r) => r.lineId)));
        continue;
      }
      const same = (l: BankCandidateLine) => l.beneficiaryAccount === row.account && l.paidAmount === row.amount && l.currency === row.currency;
      const unpaid = lines.filter((l) => !l.paid && same(l));
      if (unpaid.length > 1) { decisions.push(hold(row.rowNumber, "ambiguous", unpaid.map((l) => l.lineId))); continue; }
      if (unpaid.length === 0) { decisions.push(hold(row.rowNumber, "unmatched")); continue; }
      line = unpaid[0]!;
    }
    if (row.outcome === "fail") {
      // A FAIL for a line already paid may be an old file replayed: a person decides.
      decisions.push(line.paid ? hold(row.rowNumber, "paid_line_failed", [line.lineId])
        : { kind: "unpay", rowNumber: row.rowNumber, lineId: line.lineId, transferId: line.transferId });
    } else if (line.paid) {
      decisions.push(hold(row.rowNumber, "already_paid", [line.lineId]));
    } else {
      decisions.push({ kind: "pay", rowNumber: row.rowNumber, lineId: line.lineId, transferId: line.transferId, reference: row.reference });
    }
  }
  // A line that more than one row would act on is contradictory as a group: hold
  // every such row, so row order never decides which outcome a line gets.
  const acting = new Map<string, number>();
  for (const x of decisions) if (x.kind !== "hold") acting.set(x.lineId, (acting.get(x.lineId) ?? 0) + 1);
  for (let i = 0; i < decisions.length; i++) {
    const x = decisions[i]!;
    if (x.kind !== "hold" && acting.get(x.lineId)! > 1) decisions[i] = hold(x.rowNumber, "line_listed_twice", [x.lineId]);
  }
  decisions.sort((a, b) => a.rowNumber - b.rowNumber);
  const transferIds = [...new Set(decisions.flatMap((d) => (d.kind === "pay" || d.kind === "unpay" ? [d.transferId] : [])))].sort();
  return { decisions, transferIds };
}
