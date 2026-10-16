import type { Role } from "@studenthub/contracts";
import { CatalogueError } from "./catalogue.js";

export const BANK_TRANSFER_TYPES = ["local", "international", "within_bank"] as const;
export type BankTransferType = typeof BANK_TRANSFER_TYPES[number];

export interface BankPaymentDetails {
  readonly bankId: string;
  readonly swiftCode: string;
  readonly ibanBankCode: string;
  readonly abkCode: string;
  readonly transferType: BankTransferType;
  readonly updatedAt: string;
}

export function normalizeBankPaymentDetails(value: unknown): Omit<BankPaymentDetails, "bankId" | "updatedAt"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogueError("invalid_bank_payment_details", 400);
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "abkCode,ibanBankCode,swiftCode,transferType"
    || typeof raw.swiftCode !== "string" || typeof raw.ibanBankCode !== "string"
    || typeof raw.abkCode !== "string" || typeof raw.transferType !== "string") {
    throw new CatalogueError("invalid_bank_payment_details", 400);
  }
  const swiftCode = raw.swiftCode.trim().toUpperCase();
  const ibanBankCode = raw.ibanBankCode.trim().toUpperCase();
  const abkCode = raw.abkCode.trim().toUpperCase();
  const transferType = raw.transferType.trim();
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swiftCode)) throw new CatalogueError("invalid_swift_code", 400);
  if (!/^[A-Z0-9]{4}$/.test(ibanBankCode)) throw new CatalogueError("invalid_iban_bank_code", 400);
  if (!/^(100|[1-9]?[0-9])$/.test(abkCode)) throw new CatalogueError("invalid_abk_code", 400);
  if (!(BANK_TRANSFER_TYPES as readonly string[]).includes(transferType)) throw new CatalogueError("invalid_transfer_type", 400);
  return Object.freeze({ swiftCode, ibanBankCode, abkCode, transferType: transferType as BankTransferType });
}

export function canWriteBankPaymentDetails(role: Role): boolean {
  return role === "admin";
}
