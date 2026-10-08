import { createHash } from "node:crypto";
import {
  createSafeWrite, type ConfirmRequest, type FieldPolicy, type PreviewRequest, type SafeWriteClock,
  type SafeWriteImplementation, type SafeWriteSecret, type SafeWriteStore,
} from "@studenthub/safe-write-contract";

import { BankDetailError, validateBankDetails, type BankDetails } from "./bank.js";
import type { FinanceReferenceResolver } from "./types.js";

/**
 * SHU-182 (F1): a candidate's own bank details through the SHU-82 safe write.
 *
 * Bank, IBAN and beneficiary name change together or not at all, so they are
 * ONE contract field whose value is the canonical JSON of the validated triple.
 * A preview and its token therefore cover the whole set, and no confirm can
 * pair a new IBAN with an old bank.
 */
export const BANK_DETAILS_FIELD = "bank_details" as const;
export const BANK_DETAILS_POLICY: FieldPolicy = Object.freeze({
  allowed: Object.freeze([BANK_DETAILS_FIELD]),
  maxValueLength: 512,
});

/** The only value shape the field stores: keys sorted, values already normalized. */
export function bankDetailsValue(details: BankDetails): string {
  return JSON.stringify({ bankId: details.bankId, beneficiaryName: details.beneficiaryName, iban: details.iban });
}

/** The stored value back as typed details, or undefined for anything not produced by `bankDetailsValue`. */
export function parseBankDetailsValue(value: string): BankDetails | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.bankId !== "string" || typeof raw.iban !== "string" || typeof raw.beneficiaryName !== "string") return undefined;
  const details = { bankId: raw.bankId, iban: raw.iban, beneficiaryName: raw.beneficiaryName };
  return bankDetailsValue(details) === value ? Object.freeze(details) : undefined;
}

export interface CandidateGrantRow { readonly role: string }

/** Only a person holding a candidate grant has bank details to keep. */
export function candidateBankOwnerDecision(rows: readonly CandidateGrantRow[]): boolean {
  return rows.some((row) => row.role === "candidate");
}

function ref(domain: string, value: string): string {
  return createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex");
}
export const bankDetailsRecordRef = (principalId: string): string => ref("candidate-bank-details-record", principalId);

/**
 * Whether a value may be written. Production checks the triple against the
 * catalogue; the contract's own conformance run, which uses its own field and
 * values, passes `acceptAnyBankDetailsValue`.
 */
export type BankDetailsValueCheck = (value: string) => Promise<boolean>;

export function catalogueBankDetailsCheck(banks: FinanceReferenceResolver): BankDetailsValueCheck {
  return async (value) => {
    const details = parseBankDetailsValue(value);
    if (details === undefined) return false;
    try {
      return bankDetailsValue(await validateBankDetails(details, banks)) === value;
    } catch (error) {
      // An unreachable catalogue is not a bad value: let it fail the request.
      if (error instanceof BankDetailError && error.status === 400) return false;
      throw error;
    }
  };
}

export const acceptAnyBankDetailsValue: BankDetailsValueCheck = async () => true;

export interface BankDetailsBuildInput {
  readonly store: SafeWriteStore;
  readonly secret: SafeWriteSecret;
  readonly check: BankDetailsValueCheck;
  readonly policy?: FieldPolicy;
  readonly clock?: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
}

/** Production and conformance both enter through this exact builder. */
export function buildBankDetailsWrite(input: BankDetailsBuildInput): SafeWriteImplementation {
  const implementation = createSafeWrite({
    store: input.store, secret: input.secret, policy: input.policy ?? BANK_DETAILS_POLICY,
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: input.tokenLifetimeMs }),
  });
  // Checked at preview so a person never approves a value that cannot be stored,
  // and again at confirm because the bank can be retired in between.
  const checked = async (request: PreviewRequest | ConfirmRequest) =>
    typeof request.change?.value === "string" && await input.check(request.change.value);
  return {
    preview: async (request) => await checked(request) ? implementation.preview(request) : { ok: false, reason: "invalid_value" },
    confirm: async (request) => await checked(request) ? implementation.confirm(request) : { ok: false, reason: "invalid_value" },
  };
}
