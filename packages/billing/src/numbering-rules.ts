export interface InvoiceNumberRequest {
  readonly accountId: string;
  readonly accountPrefix: string;
  readonly period: string;
}

/** A prefix is permanently bound to one account, across all periods. */
export function validateNumberRequest(input: InvoiceNumberRequest): void {
  if (typeof input.accountId !== "string" || input.accountId.trim() !== input.accountId || !/^[\w-]{1,128}$/.test(input.accountId)
    || typeof input.accountPrefix !== "string" || input.accountPrefix.trim() !== input.accountPrefix || !/^[A-Z][A-Z0-9-]{0,31}$/.test(input.accountPrefix)
    || /^LEGACY(?:-|$)/.test(input.accountPrefix)
    || typeof input.period !== "string" || input.period.trim() !== input.period || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new TypeError("invalid invoice numbering request");
  }
}
