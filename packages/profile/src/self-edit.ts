import type { FieldPolicy } from "@studenthub/safe-write-contract";

export const PERSON_PROFILE_FIELDS = ["name", "name_ar", "objective", "intro", "preferred_time"] as const;
export type PersonProfileField = typeof PERSON_PROFILE_FIELDS[number];

export const PERSON_PROFILE_LIMITS: Readonly<Record<PersonProfileField, number>> = Object.freeze({
  name: 255, name_ar: 255, objective: 100, intro: 5_000, preferred_time: 100,
});

export const PERSON_PROFILE_POLICY: FieldPolicy = Object.freeze({
  allowed: PERSON_PROFILE_FIELDS,
  // createSafeWrite measures UTF-16 units. Route values are encoded into one
  // code point per unit before calling it, so this remains a code-point bound.
  maxValueLength: 10_000,
});

export type SelfEditValidation = { ok: true; value: string } | { ok: false; reason: string };

const forbidden = /[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufdd0-\ufdef\ufffe\uffff]/u;
const arabicLetter = /\p{Script=Arabic}/u;
const letter = /\p{Letter}/u;

/** Normalisation shared by the JSON and browser routes. Empty means clear. */
export function validatePersonProfileValue(field: PersonProfileField, input: unknown): SelfEditValidation {
  if (typeof input !== "string") return { ok: false, reason: "Enter text." };
  const value = input.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (value === "") return { ok: true, value };
  if (Array.from(value).length > PERSON_PROFILE_LIMITS[field]) return { ok: false, reason: `Use ${PERSON_PROFILE_LIMITS[field]} characters or fewer.` };
  if (forbidden.test(value) || /[\p{Cs}\p{Co}\p{Cn}]/u.test(value)) return { ok: false, reason: "Remove unsupported characters." };
  if ((field === "name" || field === "name_ar") && (!letter.test(value) || !value.includes(" "))) {
    return { ok: false, reason: "Enter at least two names." };
  }
  if (field === "name_ar" && !arabicLetter.test(value)) return { ok: false, reason: "Enter a name containing an Arabic letter." };
  return { ok: true, value };
}

/** Safe-write compares UTF-16 lengths; reject astral text unless its encoded length is safe. */
export function safeWriteValue(value: string): string { return Array.from(value).join(""); }
