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

export const PERSON_SELF_EDIT_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "nationality", "university", "drivingLicence", "jobSearchStatus"] as const;
export type PersonSelfEditField = (typeof PERSON_SELF_EDIT_FIELDS)[number];
export const PERSON_PROFILE_MINIMUM_AGE = 16;

export const SHU372_RULES = Object.freeze({
  displayName: Object.freeze({ maxLength: 255, allowClear: false, accepts: ["Noor Al-Sabah", "Abdul-Aziz Al Saud", "O'Brien Smith", "St.John Smith", "نور الصباح"], refuses: ["Noor", "Ahmed 3", " Noor Al-Sabah", "Noor  Al-Sabah", "Noor\u00a0Al-Sabah", "O''Brien Smith", ".Noor Smith", "Noor. Smith"] }),
  arabicName: Object.freeze({ maxLength: 255, allowClear: true, accepts: ["نور الصباح", ""], refuses: ["نور", "Noor Al-Sabah", "نور  الصباح", "نور\u00a0الصباح"] }),
  objective: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Build welcoming customer experiences", ""], refuses: [" a", "a  b", "a\u00a0\u00a0b"] }),
  intro: Object.freeze({ maxLength: 5_000, allowClear: true, accepts: ["Student and part-time retail teammate.", "", "a"], refuses: ["a  b", " a"] }),
  preferredTime: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Weekday evenings", ""], refuses: ["Weekday  evenings", " evenings", "Build teams\u00a0", "Weekday\u00a0\u00a0evenings"] }),
} satisfies Partial<Record<PersonSelfEditField, { maxLength: number; allowClear: boolean; accepts: readonly string[]; refuses: readonly string[] }>>);

const FORBIDDEN = /[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const NAME = /^[\p{L}\p{M}]+(?:['.-][\p{L}\p{M}]+)*(?: [\p{L}\p{M}]+(?:['.-][\p{L}\p{M}]+)*)+$/u;
const ARABIC_LETTER = /[\u0621-\u063a\u0641-\u064a\u066e-\u066f\u0671-\u06d3\u06fa-\u06fc]/u;

export function normalizePersonSelfEditValue(field: PersonSelfEditField, value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (field === "gender") return ["male", "female", "other"].includes(value) ? value : null;
  if (field === "drivingLicence") return value === "true" || value === "false" ? value : null;
  if (field === "jobSearchStatus") return ["not_looking", "active", "open_to_offers"].includes(value) ? value : null;
  if (field === "nationality" || field === "university") return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
  if (field === "birthDate") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    const today = new Date(), cutoff = new Date(Date.UTC(today.getUTCFullYear() - PERSON_PROFILE_MINIMUM_AGE, today.getUTCMonth(), today.getUTCDate()));
    return date <= cutoff ? value : null;
  }
  const normalized = value.normalize("NFC");
  const rule = SHU372_RULES[field];
  if (!rule) return null;
  if ([...normalized].length > rule.maxLength || FORBIDDEN.test(normalized)) return null;
  if (normalized === "") return rule.allowClear ? "" : null;
  if (normalized !== normalized.trim() || /\s{2}/u.test(normalized)) return null;
  if ((field === "displayName" || field === "arabicName") && !NAME.test(normalized)) return null;
  if (field === "arabicName" && !ARABIC_LETTER.test(normalized)) return null;
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
