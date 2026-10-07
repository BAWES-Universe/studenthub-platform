import type { FinanceReferenceResolver } from "./types.js";

/**
 * Bank-detail validation for payment (FI-13). Pure: persistence and the
 * safe-write operation that stores these values arrive in a later F1 slice.
 */

/** ISO 13616 lengths for the countries StudentHub pays into; other countries fall back to the generic 15–34 bound. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  KW: 30, SA: 24, AE: 23, BH: 22, QA: 29, OM: 23, JO: 30, EG: 29, LB: 28, GB: 22,
};

/** Upper-case IBAN without spaces, or undefined when the format or the mod-97 checksum fails. */
export function normalizeIban(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const iban = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return undefined;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return undefined;
  return ibanChecksumValid(iban) ? iban : undefined;
}

/** ISO 7064 mod 97-10: move the first four characters to the end, letters become 10–35, remainder must be 1. */
export function ibanChecksumValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Beneficiary name as a bank file carries it: printable, single-spaced, at most 70 characters. */
export function normalizeBeneficiaryName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (cleaned.length < 2 || cleaned.length > 70 || /[\p{Cc}\p{Cf}]/u.test(cleaned)) return undefined;
  return cleaned;
}

export interface BankDetails {
  readonly bankId: string;
  readonly iban: string;
  readonly beneficiaryName: string;
}

export class BankDetailError extends Error {
  constructor(readonly code: "invalid_bank_details" | "invalid_bank" | "invalid_iban" | "invalid_beneficiary_name" | "reference_unavailable",
    readonly status: 400 | 503) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Closed input; the bank must be an active SHU-166 catalogue bank. */
export async function validateBankDetails(input: unknown, banks: FinanceReferenceResolver): Promise<BankDetails> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BankDetailError("invalid_bank_details", 400);
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["bankId", "iban", "beneficiaryName"].includes(key))) throw new BankDetailError("invalid_bank_details", 400);
  if (typeof raw.bankId !== "string" || !UUID.test(raw.bankId)) throw new BankDetailError("invalid_bank", 400);
  const iban = normalizeIban(raw.iban);
  if (iban === undefined) throw new BankDetailError("invalid_iban", 400);
  const beneficiaryName = normalizeBeneficiaryName(raw.beneficiaryName);
  if (beneficiaryName === undefined) throw new BankDetailError("invalid_beneficiary_name", 400);
  const bankId = raw.bankId.toLowerCase();
  let bank: { readonly status: "active" | "deleted" } | undefined;
  try { bank = await banks.resolve("bank", bankId); } catch { throw new BankDetailError("reference_unavailable", 503); }
  if (bank?.status !== "active") throw new BankDetailError("invalid_bank", 400);
  return Object.freeze({ bankId, iban, beneficiaryName });
}
