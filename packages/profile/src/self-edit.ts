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

export const PERSON_SELF_EDIT_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "nationality", "university", "drivingLicence", "kuwaitiMother", "jobSearchStatus"] as const;
export type PersonSelfEditField = (typeof PERSON_SELF_EDIT_FIELDS)[number];
export const PERSON_PROFILE_MINIMUM_AGE = 16;

function kuwaitDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export const SHU372_RULES = Object.freeze({
  displayName: Object.freeze({ maxLength: 255, allowClear: false, accepts: ["Noor Al-Sabah", "Abdul-Aziz Al Saud", "O'Brien Smith", "St.John Smith", "نور الصباح"], refuses: ["Noor", "Ahmed 3", " Noor Al-Sabah", "Noor  Al-Sabah", "Noor\u00a0Al-Sabah", "O''Brien Smith", ".Noor Smith", "Noor. Smith"] }),
  arabicName: Object.freeze({ maxLength: 255, allowClear: true, accepts: ["نور الصباح", ""], refuses: ["نور", "Noor Al-Sabah", "نور  الصباح", "نور\u00a0الصباح"] }),
  objective: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Build welcoming customer experiences", ""], refuses: [" a", "a  b", "a\u00a0\u00a0b"] }),
  intro: Object.freeze({ maxLength: 5_000, allowClear: true, accepts: ["Student and part-time retail teammate.", "", "a"], refuses: ["a  b", " a"] }),
  preferredTime: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Weekday evenings", ""], refuses: ["Weekday  evenings", " evenings", "Build teams\u00a0", "Weekday\u00a0\u00a0evenings"] }),
  gender: Object.freeze({ maxLength: 6, allowClear: false, accepts: ["male", "female", "other"], refuses: ["Male", ""] }),
  birthDate: Object.freeze({ maxLength: 10, allowClear: false, accepts: ["2000-02-29"], refuses: ["2000-02-30", "01-01-2000", ""] }),
  nationality: Object.freeze({ maxLength: 36, allowClear: false, accepts: ["11111111-1111-4111-8111-111111111111"], refuses: ["Kuwait", ""] }),
  university: Object.freeze({ maxLength: 36, allowClear: true, accepts: ["22222222-2222-4222-8222-222222222222", ""], refuses: ["University", "none"] }),
  drivingLicence: Object.freeze({ maxLength: 5, allowClear: false, accepts: ["true", "false"], refuses: ["yes", ""] }),
  kuwaitiMother: Object.freeze({ maxLength: 5, allowClear: true, accepts: ["true", "false", ""], refuses: ["yes"] }),
  jobSearchStatus: Object.freeze({ maxLength: 14, allowClear: false, accepts: ["not_looking", "active", "open_to_offers"], refuses: ["looking", ""] }),
} satisfies Record<PersonSelfEditField, { maxLength: number; allowClear: boolean; accepts: readonly string[]; refuses: readonly string[] }>);

const FORBIDDEN = /[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const NAME = /^[\p{L}\p{M}]+(?:['.-][\p{L}\p{M}]+)*(?: [\p{L}\p{M}]+(?:['.-][\p{L}\p{M}]+)*)+$/u;
const ARABIC_LETTER = /[\u0621-\u063a\u0641-\u064a\u066e-\u066f\u0671-\u06d3\u06fa-\u06fc]/u;

export function normalizePersonSelfEditValue(field: PersonSelfEditField, value: unknown, today = new Date().toISOString().slice(0,10)): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC");
  if (field === "university" && normalized === "not-listed") return "";
  const rule = SHU372_RULES[field];
  if ([...normalized].length > rule.maxLength || FORBIDDEN.test(normalized)) return null;
  if (normalized === "") return rule.allowClear ? "" : null;
  if (field === "gender" && !["male", "female", "other"].includes(normalized)) return null;
  if (field === "drivingLicence" || field === "kuwaitiMother") return normalized === "true" || normalized === "false" ? normalized : null;
  if (field === "jobSearchStatus" && !["not_looking", "active", "open_to_offers"].includes(normalized)) return null;
  if ((field === "nationality" || field === "university") && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) return null;
  if (field === "birthDate") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
    const [y,m,d] = normalized.split("-").map(Number), parsed = new Date(Date.UTC(y!,m!-1,d));
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m!-1 || parsed.getUTCDate() !== d) return null;
    const cutoff = new Date(`${today}T00:00:00.000Z`); cutoff.setUTCFullYear(cutoff.getUTCFullYear()-PERSON_PROFILE_MINIMUM_AGE);
    if (normalized > cutoff.toISOString().slice(0,10)) return null;
  }
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
    const value = normalizePersonSelfEditValue(request.change.field as PersonSelfEditField, request.change.value,
      kuwaitDate(options.clock?.now() ?? new Date()));
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
