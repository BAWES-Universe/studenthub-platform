import { CIVIL_ID_DECISIONS, type CivilIdCountry } from "./decisions.js";

export type CivilIdErrorCode = "civil_id_country_unsupported" | "civil_id_format_invalid"
  | "civil_id_expiry_invalid" | "civil_id_duplicate" | "civil_id_unavailable"
  | "civil_id_request_invalid" | "civil_id_review_changed" | "not_found"
  | "civil_id_ocr_failed" | "civil_id_ocr_unreadable";

/** Never attach a cause, SQL detail, provider response, or input to this error. */
export class CivilIdError extends Error {
  constructor(readonly code: CivilIdErrorCode) {
    super(code);
    this.name = "CivilIdError";
  }
}

export function normalizeCivilId(country: unknown, value: unknown): {
  countryCode: CivilIdCountry; civilIdNumber: string;
} {
  if (typeof country !== "string" || !Object.hasOwn(CIVIL_ID_DECISIONS.digitCounts, country)) {
    throw new CivilIdError("civil_id_country_unsupported");
  }
  if (typeof value !== "string") throw new CivilIdError("civil_id_format_invalid");
  const number = value.trim().replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)));
  const countryCode = country as CivilIdCountry;
  if (!/^[0-9]+$/.test(number) || number.length !== CIVIL_ID_DECISIONS.digitCounts[countryCode]) {
    throw new CivilIdError("civil_id_format_invalid");
  }
  return { countryCode, civilIdNumber: number };
}
