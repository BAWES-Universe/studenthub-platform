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

// Generated with Node 22.22.0 (Unicode 16.0) from
// /\p{Script=Arabic}/u && /\p{Letter}/u. Migration 0211 lists the same
// ranges, and SHU372_RULES compares both over every Unicode scalar value.
export const ARABIC_LETTER_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x620,0x63f],[0x641,0x64a],[0x66e,0x66f],[0x671,0x6d3],[0x6d5,0x6d5],[0x6e5,0x6e6],
  [0x6ee,0x6ef],[0x6fa,0x6fc],[0x6ff,0x6ff],[0x750,0x77f],[0x870,0x887],[0x889,0x88f],
  [0x8a0,0x8c9],[0xfb50,0xfbb1],[0xfbd3,0xfd3d],[0xfd50,0xfd8f],[0xfd92,0xfdc7],
  [0xfdf0,0xfdfb],[0xfe70,0xfe74],[0xfe76,0xfefc],[0x10ec2,0x10ec7],[0x1ee00,0x1ee03],
  [0x1ee05,0x1ee1f],[0x1ee21,0x1ee22],[0x1ee24,0x1ee24],[0x1ee27,0x1ee27],
  [0x1ee29,0x1ee32],[0x1ee34,0x1ee37],[0x1ee39,0x1ee39],[0x1ee3b,0x1ee3b],
  [0x1ee42,0x1ee42],[0x1ee47,0x1ee47],[0x1ee49,0x1ee49],[0x1ee4b,0x1ee4b],
  [0x1ee4d,0x1ee4f],[0x1ee51,0x1ee52],[0x1ee54,0x1ee54],[0x1ee57,0x1ee57],
  [0x1ee59,0x1ee59],[0x1ee5b,0x1ee5b],[0x1ee5d,0x1ee5d],[0x1ee5f,0x1ee5f],
  [0x1ee61,0x1ee62],[0x1ee64,0x1ee64],[0x1ee67,0x1ee6a],[0x1ee6c,0x1ee72],
  [0x1ee74,0x1ee77],[0x1ee79,0x1ee7c],[0x1ee7e,0x1ee7e],[0x1ee80,0x1ee89],
  [0x1ee8b,0x1ee9b],[0x1eea1,0x1eea3],[0x1eea5,0x1eea9],[0x1eeab,0x1eebb],
];

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
  if (field === "arabicName" && !Array.from(value).some(char => {
    const point=char.codePointAt(0)!;
    return ARABIC_LETTER_CODE_POINT_RANGES.some(([low,high])=>point>=low&&point<=high);
  })) {
    return { ok: false, reason: "Enter a name containing an Arabic letter." };
  }
  return { ok: true, value, cleared: false };
}

export function selfEditMaxValueLength(field: SelfEditField): number {
  // createSafeWrite counts UTF-16. Every accepted code point may be a surrogate pair.
  return LIMITS[field] * 2;
}
