import {
  createSafeWrite,
  type ConfirmRequest,
  type ConfirmResult,
  type PreviewRequest,
  type PreviewResult,
  type SafeWriteClock,
  type SafeWriteSecret,
  type SafeWriteStore,
} from "@studenthub/safe-write-contract";

export const PERSON_SELF_EDIT_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime"] as const;
export type PersonSelfEditField = (typeof PERSON_SELF_EDIT_FIELDS)[number];

export const SHU372_RULES = Object.freeze({
  displayName: Object.freeze({ maxLength: 255, allowClear: false, accepts: ["Noor Al-Sabah", "نور الصباح"], refuses: ["Noor", " Noor Al-Sabah", "Noor  Al-Sabah"] }),
  arabicName: Object.freeze({ maxLength: 255, allowClear: false, accepts: ["نور الصباح", "Noor Al-Sabah"], refuses: ["نور", "نور  الصباح"] }),
  objective: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Build welcoming customer experiences", ""], refuses: [" a", "a  b"] }),
  intro: Object.freeze({ maxLength: 5_000, allowClear: true, accepts: ["Student and part-time retail teammate.", "", "a"], refuses: ["a  b", " a"] }),
  preferredTime: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Weekday evenings", ""], refuses: ["Weekday  evenings", " evenings"] }),
} satisfies Record<PersonSelfEditField, { maxLength: number; allowClear: boolean; accepts: readonly string[]; refuses: readonly string[] }>);

const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

export function normalizePersonSelfEditValue(field: PersonSelfEditField, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC");
  const rule = SHU372_RULES[field];
  if ([...normalized].length > rule.maxLength || FORBIDDEN.test(normalized)) return null;
  if (normalized === "") return rule.allowClear ? "" : null;
  if (normalized !== normalized.trim() || normalized.includes("  ")) return null;
  if ((field === "displayName" || field === "arabicName") && normalized.split(" ").length < 2) return null;
  return normalized;
}

export function createPersonSelfEdit(options: {
  readonly store: SafeWriteStore;
  readonly secret: SafeWriteSecret;
  readonly clock?: SafeWriteClock;
}) {
  const safeWrite = createSafeWrite({
    ...options,
    policy: { allowed: PERSON_SELF_EDIT_FIELDS, maxValueLength: 5_000, allowClear: true },
  });
  const normalize = <T extends PreviewRequest | ConfirmRequest>(request: T): T | null => {
    if (!PERSON_SELF_EDIT_FIELDS.includes(request.change.field as PersonSelfEditField)) return request;
    const value = normalizePersonSelfEditValue(request.change.field as PersonSelfEditField, request.change.value);
    return value === null ? null : { ...request, change: { ...request.change, value } };
  };
  return Object.freeze({
    async preview(request: PreviewRequest): Promise<PreviewResult> {
      const normalized = normalize(request);
      return normalized ? safeWrite.preview(normalized) : { ok: false, reason: "invalid_value" };
    },
    async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
      const normalized = normalize(request);
      return normalized ? safeWrite.confirm(normalized) : { ok: false, reason: "invalid_value" };
    },
  });
}
