/** Offline ABK XLSX candidate. No selection, settlement, persistence or delivery. */
/** Source-derived Yii 2.0.51 labels, NOT the ignored controller `label` strings. */
export const ABK_SOURCE_HEADERS = [
  "Debit Account", "Name", "IBAN", "Beneficiary Bank Address", "Beneficiary Bank Name",
  "Beneficiary Bank Branch Id", "Beneficiary City", "Beneficiary Country", "Beneficiary Address 1",
  "Beneficiary Address 2", "Txn Currency", "Amount", "Type", "Beneficiary Bank Identifier",
  "Purpose Of Transfer", "Payment Details", "Charge",
] as const;
export interface AbkLine {
  readonly tcId: string;
  readonly currency: "KWD";
  /** Final approved amount, already rounded to fils by the owning payroll lane. */
  readonly amount: string;
  readonly beneficiaryName: string;
  readonly beneficiaryIban: string;
  readonly snapshotBank: { readonly ibanCode: string; readonly swiftCode: string };
  /** Preserve the legacy distinction between current candidate and transfer snapshot. */
  readonly candidate: null | {
    readonly bankAccountName: string;
    readonly bank: null | { readonly abkCode: string };
  };
}
export type AbkCell = string | number | null;
export interface AbkWorkbookSpec {
  readonly sheetName: string;
  readonly rows: readonly (readonly AbkCell[])[];
}
export interface AbkFormatContract {
  /** Explicit layout contract; source-derived labels available as ABK_SOURCE_HEADERS. */
  readonly headers: readonly string[];
  readonly sheetName: string;
  readonly debitAccount: string;
}
export interface AbkXlsxEncoder {
  /** Must emit actual OOXML, preserve text identifiers and never infer formulas. */
  encode(spec: AbkWorkbookSpec): Promise<Uint8Array>;
}

function text(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32767 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function abkWorkbookSpec(lines: readonly AbkLine[], contract: AbkFormatContract): AbkWorkbookSpec {
  if (!Array.isArray(contract.headers) || contract.headers.length !== 17) throw new Error("Exactly 17 explicit headers required");
  const headers = contract.headers.map((v) => text(v, "header"));
  const sheetName = text(contract.sheetName, "sheet name");
  if (sheetName.length > 31 || /[\\/?*\[\]:]/u.test(sheetName) || sheetName.startsWith("'") || sheetName.endsWith("'")) throw new Error("Invalid sheet name");
  const debit = text(contract.debitAccount, "debit account");
  if (!lines.length || lines.length > 10000) throw new Error("Candidate supports 1..10000 lines");
  const seen = new Set<string>();
  const rows: AbkCell[][] = [headers];
  for (const line of lines) {
    const id = text(line.tcId, "tcId");
    if (seen.has(id)) throw new Error("Duplicate tcId");
    seen.add(id);
    if (line.currency !== "KWD") throw new Error("ABK candidate is KWD only");
    // Limit to 15 decimal digits, avoiding silent Excel precision loss. No rounding here.
    if (typeof line.amount !== "string" || !/^(0|[1-9]\d{0,11})\.\d{3}$/u.test(line.amount)) throw new Error("Invalid amount: require nonnegative fixed 3dp within Excel precision");
    const iban = text(line.beneficiaryIban, "beneficiary IBAN");
    const withinBank = text(line.snapshotBank.ibanCode, "bank IBAN code") === "ABKK";
    const swift = text(line.snapshotBank.swiftCode, "SWIFT");
    // Exact legacy extractAccountNumber operation, NOT a general IBAN validator.
    const account = withinBank ? iban.slice(8).replaceAll("000000000", "") : iban;
    text(account, "extracted account");
    const name = line.candidate === null ? text(line.beneficiaryName, "beneficiary name") : text(line.candidate.bankAccountName, "candidate account name");
    const bankCode = line.candidate?.bank == null ? null : text(line.candidate.bank.abkCode, "ABK bank code").padStart(3, "0");
    rows.push([debit, name, account, "KW", bankCode, "KW", "KW", "Kuwait", "KW", "KW", "KWD", Number(line.amount), withinBank ? "Within Bank" : "Local Transfers", swift + "XXX", "Bill Settlement", "S " + id, "OUR"]);
  }
  return { sheetName, rows };
}

/** Bytes only. Caller owns batch identity, audit, authorization and expiring read links. */
export async function generateAbkWorkbook(lines: readonly AbkLine[], contract: AbkFormatContract, encoder: AbkXlsxEncoder): Promise<Uint8Array> {
  const bytes = await encoder.encode(abkWorkbookSpec(lines, contract));
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw new Error("Encoder did not return XLSX ZIP bytes");
  return bytes;
}
