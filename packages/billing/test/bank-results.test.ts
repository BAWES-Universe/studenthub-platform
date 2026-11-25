import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bankAmount, planBankResult, readBankResultSheet,
  type BankCandidateLine, type BankCell, type BankRecordedPayment, type BankSheetResult,
} from "../src/bank-results.js";
import { parseDecimalString } from "../src/decimal-string.js";

// Synthetic rows only: ids, accounts, amounts and references are made up.
const d = (value: string) => parseDecimalString(value, 3);
const line = (over: Partial<BankCandidateLine> = {}): BankCandidateLine => ({
  lineId: "L1", transferId: "T1", paid: false, paidAmount: d("120.500"), currency: "KWD",
  beneficiaryAccount: "ACC-1", ...over,
});
const rec = (lineId: string, reference: string, over: Partial<BankRecordedPayment> = {}): BankRecordedPayment => ({
  lineId, reference, account: "ACC-1", amount: d("120.500"), currency: "KWD", ...over,
});
const AUB_HEAD = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
const aub = (...rows: BankCell[][]): BankCell[][] => [[], AUB_HEAD, ...rows];
const KFH_HEAD = ["Beneficiary Account", "Amount", "Transfer Currency", "Refrence Number"];
const kfh = (...rows: BankCell[][]): BankCell[][] => [...Array.from({ length: 8 }, () => ["bank banner"]), KFH_HEAD, ...rows];
const read = (sheet: BankSheetResult) => {
  assert.equal(sheet.kind, "read");
  return sheet as Extract<BankSheetResult, { kind: "read" }>;
};

test("BANK_AMOUNT keeps exact three places and refuses what it would have to round", () => {
  assert.equal(bankAmount("120.5"), "120.500");
  assert.equal(bankAmount(120.5), "120.500");
  assert.equal(bankAmount("1,250"), "1250.000");
  assert.equal(bankAmount(""), null);
  assert.equal(bankAmount(null), null);
  assert.equal(bankAmount("1,250,000.5"), "1250000.500");
  for (const bad of ["1.2345", "-1", "abc", "1e3", "01", "120,50", "1,25", ",250", "1,2500", "0,250", "1,250.5,0"]) assert.throws(() => bankAmount(bad), TypeError);
});

test("BANK_SHEET_AUB reads legacy row 2 headers, statuses and the echoed line id", () => {
  const sheet = read(readBankResultSheet("aub", aub(
    ["SUCCESS", "CONF-1", "T1", "L1"],
    [null, null, null, null],
    ["FAIL", "rejected", "T1", "L2"],
    ["", "x", "T1", "L3"],
    ["PENDING", "x", "T1", "L4"],
  )));
  assert.deepEqual(sheet.rows.map((r) => [r.rowNumber, r.outcome, r.lineRef, r.reference]), [
    [3, "success", "L1", "CONF-1"], [5, "fail", "L2", "rejected"],
  ]);
  assert.deepEqual(sheet.rejected, [{ rowNumber: 6, problem: "missing_status" }, { rowNumber: 7, problem: "unknown_status" }]);
});

test("BANK_SHEET_REFUSED a file without the legacy headers or rows is refused whole", () => {
  assert.deepEqual(readBankResultSheet("aub", [[], ["Status", "Credit Narrative"]]),
    { kind: "refused", code: "missing_headers", missing: ["Status Description"] });
  assert.deepEqual(readBankResultSheet("aub", aub()), { kind: "refused", code: "no_rows" });
  assert.equal(readBankResultSheet("kfh", aub(["SUCCESS", "C", "T", "L"])).kind, "refused");
});

test("BANK_SHEET_KFH reads legacy row 9 headers; no status column means success", () => {
  const sheet = read(readBankResultSheet("kfh", kfh(
    ["ACC-1", 120.5, "KWD", "REF-1"],
    ["ACC-2", "1.2345", "KWD", "REF-2"],
    ["", "10", "KWD", "REF-3"],
  )));
  assert.deepEqual(sheet.rows, [{ rowNumber: 10, outcome: "success", lineRef: null, reference: "REF-1", account: "ACC-1", amount: "120.500", currency: "KWD" }]);
  assert.deepEqual(sheet.rejected, [{ rowNumber: 11, problem: "invalid_amount" }, { rowNumber: 12, problem: "missing_match_key" }]);
});

test("BANK_PLAN_BY_ID success pays, fail unpays an unpaid line, replays are duplicates", () => {
  const sheet = read(readBankResultSheet("aub", aub(
    ["SUCCESS", "CONF-1", "T1", "L1"],
    ["FAIL", "bad iban", "T2", "L2"],
    ["SUCCESS", "CONF-3", "T2", "L3"],
    ["FAIL", "bounced", "T4", "L4"],
  )));
  const plan = planBankResult(sheet, [
    line(), line({ lineId: "L2", transferId: "T2" }),
    line({ lineId: "L3", transferId: "T2", paid: true }), line({ lineId: "L4", transferId: "T4", paid: true }),
  ], [rec("L3", "CONF-3"), rec("L4", "OLD")]);
  assert.deepEqual(plan.decisions, [
    { kind: "pay", rowNumber: 3, lineId: "L1", transferId: "T1", reference: "CONF-1" },
    { kind: "unpay", rowNumber: 4, lineId: "L2", transferId: "T2" },
    { kind: "duplicate", rowNumber: 5, lineId: "L3" },
    { kind: "hold", rowNumber: 6, reason: "paid_line_failed", lineIds: ["L4"] },
  ]);
  assert.deepEqual(plan.transferIds, ["T1", "T2"]);
});

test("BANK_PLAN_HOLDS unsafe rows are held for a person, never guessed", () => {
  const sheet = read(readBankResultSheet("aub", aub(
    ["SUCCESS", "CONF-1", "T1", "NOPE"],
    ["SUCCESS", "CONF-2", "T1", "L1"],
    ["SUCCESS", "CONF-3", "T1", "L1"],
    ["SUCCESS", "CONF-4", "T1", "L2"],
    ["MAYBE", "x", "T1", "L3"],
  )));
  const plan = planBankResult(sheet, [line(), line({ lineId: "L2", paid: true })], [rec("L2", "OTHER")]);
  assert.deepEqual(plan.decisions.map((x) => [x.rowNumber, x.kind, x.kind === "hold" ? x.reason : ""]), [
    [3, "hold", "unmatched"], [4, "hold", "line_listed_twice"], [5, "hold", "line_listed_twice"], [6, "hold", "already_paid"], [7, "hold", "rejected_row"],
  ]);
  assert.deepEqual(plan.transferIds, []);
});

test("BANK_PLAN_FALLBACK account match pays one, holds ties, mismatches and repeats", () => {
  const sheet = read(readBankResultSheet("kfh", kfh(
    ["ACC-1", "120.5", "KWD", "R1"],
    ["ACC-2", "50", "KWD", "R2"],
    ["ACC-1", "120.5", "KWD", "R3"],
    ["ACC-3", "70", "KWD", "R4"],
    ["ACC-4", "9", "KWD", "R5"],
    ["ACC-1", "120.5", "USD", "R6"],
  )));
  const plan = planBankResult(sheet, [
    line(),
    line({ lineId: "L2", beneficiaryAccount: "ACC-2", paidAmount: d("50.000") }),
    line({ lineId: "L3", beneficiaryAccount: "ACC-2", paidAmount: d("50.000"), transferId: "T9" }),
    line({ lineId: "L4", beneficiaryAccount: "ACC-3", paidAmount: d("70.000"), paid: true }),
  ], [rec("L4", "R4", { account: "ACC-3", amount: d("70.000") })]);
  assert.deepEqual(plan.decisions, [
    { kind: "hold", rowNumber: 10, reason: "line_listed_twice", lineIds: ["L1"] },
    { kind: "hold", rowNumber: 11, reason: "ambiguous", lineIds: ["L2", "L3"] },
    { kind: "hold", rowNumber: 12, reason: "line_listed_twice", lineIds: ["L1"] },
    { kind: "duplicate", rowNumber: 13, lineId: "L4" },
    { kind: "hold", rowNumber: 14, reason: "unmatched", lineIds: [] },
    { kind: "hold", rowNumber: 15, reason: "unmatched", lineIds: [] },
  ]);
  assert.deepEqual(plan.transferIds, []);
});

test("BANK_PLAN_CHECKS an echoed id with a different amount or currency is held", () => {
  const rows = { kind: "read" as const, rejected: [], rows: [
    { rowNumber: 3, outcome: "success" as const, lineRef: "L1", reference: "C1", account: null, amount: d("99.000"), currency: "KWD" },
    { rowNumber: 4, outcome: "success" as const, lineRef: "L2", reference: "C2", account: null, amount: null, currency: "USD" },
    { rowNumber: 5, outcome: "fail" as const, lineRef: null, reference: "C", account: "ACC-1", amount: d("120.500"), currency: "KWD" },
  ] };
  const plan = planBankResult(rows, [line(), line({ lineId: "L2" })], []);
  assert.deepEqual(plan.decisions.map((x) => x.kind === "hold" ? x.reason : x.kind), ["amount_mismatch", "currency_mismatch", "unmatched"]);
  assert.deepEqual(plan.transferIds, []);
  assert.throws(() => planBankResult(rows, [line(), line()], []), TypeError);
});

test("BANK_PLAN_REPLAY a recorded confirmation is resolved before any unpaid fallback", () => {
  // L1 was paid by R1 in an earlier file; L2 is a later unpaid line with the same account, amount and currency.
  const lines = [line({ paid: true }), line({ lineId: "L2", transferId: "T2" })];
  const replay = read(readBankResultSheet("kfh", kfh(["ACC-1", "120.5", "KWD", "R1"])));
  assert.deepEqual(planBankResult(replay, lines, [rec("L1", "R1")]).decisions,
    [{ kind: "duplicate", rowNumber: 10, lineId: "L1" }]);
  // Same history, as if L1 is no longer a candidate (closed transfer): still a replay, never pays L2.
  assert.deepEqual(planBankResult(replay, [lines[1]!], [rec("L1", "R1")]).decisions,
    [{ kind: "duplicate", rowNumber: 10, lineId: "L1" }]);
  // Fresh reference control: the same row with a new confirmation pays the open line.
  const fresh = read(readBankResultSheet("kfh", kfh(["ACC-1", "120.5", "KWD", "R9"])));
  assert.deepEqual(planBankResult(fresh, lines, [rec("L1", "R1")]).decisions,
    [{ kind: "pay", rowNumber: 10, lineId: "L2", transferId: "T2", reference: "R9" }]);
});

test("BANK_PLAN_PROVENANCE contradictory or non-unique references are held", () => {
  const lines = [line({ lineId: "L2", transferId: "T2" })];
  const row = read(readBankResultSheet("kfh", kfh(["ACC-1", "120.5", "KWD", "R1"])));
  const reason = (plan: ReturnType<typeof planBankResult>) => plan.decisions.map((x) => x.kind === "hold" ? `${x.reason}:${x.lineIds.join(",")}` : x.kind);
  assert.deepEqual(reason(planBankResult(row, lines, [rec("L1", "R1", { amount: d("99.000") })])), ["reference_conflict:L1"]);
  assert.deepEqual(reason(planBankResult(row, lines, [rec("L1", "R1"), rec("L7", "R1")])), ["reference_conflict:L1,L7"]);
  // One fresh reference on two independently matchable rows: both held, in either row order.
  const two = [line({ lineId: "L2", transferId: "T2" }), line({ lineId: "L3", transferId: "T3", beneficiaryAccount: "ACC-3" })];
  for (const order of [[["ACC-1", "120.5", "KWD", "R5"], ["ACC-3", "120.5", "KWD", "R5"]], [["ACC-3", "120.5", "KWD", "R5"], ["ACC-1", "120.5", "KWD", "R5"]]]) {
    const plan = planBankResult(read(readBankResultSheet("kfh", kfh(...order))), two, []);
    assert.deepEqual(reason(plan), ["reference_conflict:", "reference_conflict:"]);
    assert.deepEqual(plan.transferIds, []);
  }
  const byIdTwice = read(readBankResultSheet("aub", aub(["SUCCESS", "R6", "T2", "L2"], ["SUCCESS", "R6", "T3", "L3"])));
  assert.deepEqual(reason(planBankResult(byIdTwice, two, [])), ["reference_conflict:", "reference_conflict:"]);
  // By id: a confirmation already recorded on another line is held, not applied to this one.
  const byId = read(readBankResultSheet("aub", aub(["SUCCESS", "R1", "T2", "L2"])));
  assert.deepEqual(reason(planBankResult(byId, lines, [rec("L1", "R1")])), ["reference_conflict:L1,L2"]);
  const paid = [line({ lineId: "L2", transferId: "T2", paid: true })];
  assert.deepEqual(reason(planBankResult(byId, paid, [rec("L2", "R1")])), ["duplicate"]);
  assert.deepEqual(reason(planBankResult(byId, paid, [])), ["already_paid:L2"]);
  // By id, the recorded line on a closed transfer (not a candidate): a replay, not a conflict.
  assert.deepEqual(reason(planBankResult(byId, [], [rec("L2", "R1")])), ["duplicate"]);
  assert.deepEqual(reason(planBankResult(byId, [], [rec("L9", "R1")])), ["reference_conflict:L9"]);
});

test("BANK_PLAN_NO_REFERENCE an account match without a bank reference is held, never paid", () => {
  // L1 was paid earlier; a blank-reference replay must not pay the later equivalent L2.
  const lines = [line({ paid: true }), line({ lineId: "L2", transferId: "T2" })];
  const replay = read(readBankResultSheet("kfh", kfh(["ACC-1", "120.5", "KWD", ""])));
  const plan = planBankResult(replay, lines, [rec("L1", "R1")]);
  assert.deepEqual(plan.decisions, [{ kind: "hold", rowNumber: 10, reason: "missing_reference", lineIds: [] }]);
  assert.deepEqual(plan.transferIds, []);
  // An echoed line id still works without a reference.
  const byId = read(readBankResultSheet("aub", aub(["SUCCESS", "", "T2", "L2"])));
  assert.deepEqual(planBankResult(byId, lines, []).decisions,
    [{ kind: "pay", rowNumber: 3, lineId: "L2", transferId: "T2", reference: null }]);
});

test("BANK_PLAN_SAME_LINE rows acting on one line are all held, in either row order", () => {
  const rows = [["FAIL", "bad iban", "T1", "L1"], ["SUCCESS", "C1", "T1", "L1"]];
  for (const order of [rows, [...rows].reverse()]) {
    const plan = planBankResult(read(readBankResultSheet("aub", aub(...order))), [line()], []);
    assert.deepEqual(plan.decisions.map((x) => x.kind === "hold" ? x.reason : x.kind), ["line_listed_twice", "line_listed_twice"]);
    assert.deepEqual(plan.transferIds, []);
  }
  // Two fallback rows with different references on the one matching line: both held.
  const kfhRows = [["ACC-1", "120.5", "KWD", "R1"], ["ACC-1", "120.5", "KWD", "R2"]];
  for (const order of [kfhRows, [...kfhRows].reverse()]) {
    const plan = planBankResult(read(readBankResultSheet("kfh", kfh(...order))), [line()], []);
    assert.deepEqual(plan.decisions.map((x) => x.kind === "hold" ? x.reason : x.kind), ["line_listed_twice", "line_listed_twice"]);
  }
  // Control: one row for the line still pays it.
  const one = planBankResult(read(readBankResultSheet("aub", aub(["SUCCESS", "C1", "T1", "L1"]))), [line()], []);
  assert.deepEqual(one.decisions.map((x) => x.kind), ["pay"]);
});
