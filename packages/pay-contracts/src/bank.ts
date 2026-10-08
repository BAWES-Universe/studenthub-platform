import type { FinanceReferenceResolver } from "./types.js";

/**
 * Bank-detail validation for payment (FI-13). Pure: persistence and the
 * safe-write operation that stores these values arrive in a later F1 slice.
 */

/** ISO 13616 registry lengths; a country missing here has no IBAN and is refused. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22,
  GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30,
  KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20,
  MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Upper-case IBAN without spaces, or undefined when the format or the mod-97 checksum fails. */
export function normalizeIban(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const iban = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return undefined;
  if (iban.length !== IBAN_LENGTHS[iban.slice(0, 2)]) return undefined;
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

/** Closed input, normalized without any lookup. Whether the bank exists is `validateBankDetails`'s question. */
export function normalizeBankDetails(input: unknown): BankDetails {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BankDetailError("invalid_bank_details", 400);
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["bankId", "iban", "beneficiaryName"].includes(key))) throw new BankDetailError("invalid_bank_details", 400);
  if (typeof raw.bankId !== "string" || !UUID.test(raw.bankId)) throw new BankDetailError("invalid_bank", 400);
  const iban = normalizeIban(raw.iban);
  if (iban === undefined) throw new BankDetailError("invalid_iban", 400);
  const beneficiaryName = normalizeBeneficiaryName(raw.beneficiaryName);
  if (beneficiaryName === undefined) throw new BankDetailError("invalid_beneficiary_name", 400);
  return Object.freeze({ bankId: raw.bankId.toLowerCase(), iban, beneficiaryName });
}

/** Closed input; the bank must be an active SHU-166 catalogue bank. */
export async function validateBankDetails(input: unknown, banks: FinanceReferenceResolver): Promise<BankDetails> {
  const { bankId, iban, beneficiaryName } = normalizeBankDetails(input);
  let bank: { readonly status: "active" | "deleted" } | undefined;
  try { bank = await banks.resolve("bank", bankId); } catch { throw new BankDetailError("reference_unavailable", 503); }
  if (bank?.status !== "active") throw new BankDetailError("invalid_bank", 400);
  return Object.freeze({ bankId, iban, beneficiaryName });
}
