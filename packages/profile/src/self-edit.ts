// 0183 and pay-contracts are the canonical generated Unicode-16 list. The
// root build produces this dependency before profile (see the typecheck order).
import { BENEFICIARY_NAME_FORBIDDEN_RANGES } from "@studenthub/pay-contracts";

export const SELF_EDIT_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime"] as const;
export type SelfEditField = typeof SELF_EDIT_FIELDS[number];
// PostgreSQL text cannot contain NUL and the parser refuses it below, making
// this an out-of-band contract value rather than something a person can type.
export const SELF_EDIT_CLEAR = "\0";

const LIMITS: Readonly<Record<SelfEditField, number>> = Object.freeze({
  displayName: 255, arabicName: 255, objective: 100, intro: 5_000, preferredTime: 100,
});

export type SelfEditParseResult = { readonly ok: true; readonly value: string; readonly cleared: boolean }
  | { readonly ok: false; readonly reason: string };

function forbidden(value: string): boolean {
  return Array.from(value).some(char => {
    const point = char.codePointAt(0)!;
    return point === 0 || BENEFICIARY_NAME_FORBIDDEN_RANGES.some(([low, high]) => point >= low && point <= high);
  });
}

/** The sole application rule mirrored by 0211. Input is normalized before preview. */
export function parseSelfEditValue(field: SelfEditField, input: unknown): SelfEditParseResult {
  if (typeof input !== "string") return { ok: false, reason: "Enter a text value." };
  if (input.length === 0) return { ok: true, value: SELF_EDIT_CLEAR, cleared: true };
  const value = input.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = Array.from(value).length;
  if (length === 0) return { ok: false, reason: "Enter a value or leave the field empty to clear it." };
  if (length > LIMITS[field]) return { ok: false, reason: `Use ${LIMITS[field]} characters or fewer.` };
  if (forbidden(value)) return { ok: false, reason: "Remove unsupported characters." };
  if ((field === "displayName" || field === "arabicName") && !value.includes(" ")) {
    return { ok: false, reason: "Enter at least two names." };
  }
  if (field === "arabicName" && !Array.from(value).some(char => /\p{Script=Arabic}/u.test(char) && /\p{Letter}/u.test(char))) {
    return { ok: false, reason: "Enter a name containing an Arabic letter." };
  }
  return { ok: true, value, cleared: false };
}

export function selfEditMaxValueLength(field: SelfEditField): number {
  // createSafeWrite counts UTF-16. Every accepted code point may be a surrogate pair.
  return LIMITS[field] * 2;
}
