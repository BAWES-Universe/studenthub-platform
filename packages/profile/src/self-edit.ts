import { createSafeWrite, type FieldPolicy, type SafeWriteClock, type SafeWriteImplementation, type SafeWriteSecret, type SafeWriteStore } from "@studenthub/safe-write-contract";

export const PROFILE_EDIT_FIELDS = ["display_name", "arabic_name", "objective", "introduction", "preferred_time"] as const;
export type ProfileEditField = typeof PROFILE_EDIT_FIELDS[number];
export const PROFILE_EDIT_LIMITS: Readonly<Record<ProfileEditField, number>> = Object.freeze({
  display_name: 255, arabic_name: 255, objective: 100, introduction: 5_000, preferred_time: 100,
});
const OPTIONAL = new Set<ProfileEditField>(["arabic_name", "objective", "introduction", "preferred_time"]);
const FORBIDDEN = /[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufffe\uffff]/u;
const WORD = /\p{L}[\p{L}\p{M}]*/gu;
const ARABIC_LETTER = /\p{Script=Arabic}/u;

export function normalizeProfileEdit(field: ProfileEditField, input: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof input !== "string") return { ok: false, reason: "Enter a value." };
  const value = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!value && !OPTIONAL.has(field)) return { ok: false, reason: "Enter at least two words." };
  if ([...value].length > PROFILE_EDIT_LIMITS[field]) return { ok: false, reason: `Use ${PROFILE_EDIT_LIMITS[field]} characters or fewer.` };
  if (FORBIDDEN.test(value)) return { ok: false, reason: "Remove unsupported characters." };
  if ((field === "display_name" || field === "arabic_name") && value) {
    if ((value.match(WORD) ?? []).length < 2) return { ok: false, reason: "Enter at least two words." };
    if (field === "arabic_name" && !ARABIC_LETTER.test(value)) return { ok: false, reason: "Use an Arabic-script letter." };
  }
  return { ok: true, value };
}

export function profileEditPolicy(field: ProfileEditField): FieldPolicy {
  return Object.freeze({ allowed: Object.freeze([field]), maxValueLength: PROFILE_EDIT_LIMITS[field], allowClear: OPTIONAL.has(field) });
}

export function buildProfileEditWrite(input: { store: SafeWriteStore; secret: SafeWriteSecret; field: ProfileEditField; clock?: SafeWriteClock }): SafeWriteImplementation {
  return createSafeWrite({ store: input.store, secret: input.secret, policy: profileEditPolicy(input.field), ...(input.clock ? { clock: input.clock } : {}) });
}
