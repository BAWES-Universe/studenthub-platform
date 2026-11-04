import { createHash } from "node:crypto";
import { projectApprovedProfile } from "./profile.js";
import type { ApprovedProfileAdapter } from "./types.js";
import {
  createSafeWrite,
  type BrowserBaseline,
  type ConfirmRequest,
  type ConfirmResult,
  type PreviewRequest,
  type PreviewResult,
  type SafeWriteClock,
  type SafeWriteSecret,
  type SafeWriteStore,
} from "@studenthub/safe-write-contract";

export const PERSON_SELF_EDIT_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "drivingLicence", "jobSearchStatus", "phone", "handle", "nationality", "university", "kuwaitiMother"] as const;
export type PersonSelfEditField = (typeof PERSON_SELF_EDIT_FIELDS)[number];

export const PERSON_PROFILE_MINIMUM_AGE = 16;
export const SHU372_RULES = Object.freeze({
  displayName: Object.freeze({ maxLength: 255, allowClear: false, accepts: ["Noor Al-Sabah", "Abdul-Aziz Al Saud", "O'Brien Smith", "St.John Smith", "نور الصباح"], refuses: ["Noor", "Ahmed 3", " Noor Al-Sabah", "Noor  Al-Sabah", "Noor\u00a0Al-Sabah", "O''Brien Smith", ".Noor Smith", "Noor. Smith"] }),
  arabicName: Object.freeze({ maxLength: 255, allowClear: true, accepts: ["نور الصباح", ""], refuses: ["نور", "Noor Al-Sabah", "نور  الصباح", "نور\u00a0الصباح"] }),
  objective: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Build welcoming customer experiences", ""], refuses: [" a", "a  b", "a\u00a0\u00a0b"] }),
  intro: Object.freeze({ maxLength: 5_000, allowClear: true, accepts: ["Student and part-time retail teammate.", "", "a"], refuses: ["a  b", " a"] }),
  preferredTime: Object.freeze({ maxLength: 100, allowClear: true, accepts: ["Weekday evenings", ""], refuses: ["Weekday  evenings", " evenings", "Build teams\u00a0", "Weekday\u00a0\u00a0evenings"] }),
  gender: Object.freeze({ maxLength: 6, allowClear: false, accepts: ["male", "female", "other"], refuses: ["", "1", "Male"] }),
  birthDate: Object.freeze({ maxLength: 10, allowClear: false, accepts: ["2000-02-29"], refuses: ["", "2000-02-30", "2010-10-31"] }),
  drivingLicence: Object.freeze({ maxLength: 5, allowClear: false, accepts: ["true", "false"], refuses: ["", "yes", "1"] }),
  jobSearchStatus: Object.freeze({ maxLength: 14, allowClear: false, accepts: ["not_looking", "active", "open_to_offers"], refuses: ["", "looking", "1"] }),
  phone: Object.freeze({ maxLength: 32, allowClear: true, accepts: ["+96550000000", "+442071838750", ""], refuses: ["+1234567", "+1234567890123456", "phone"] }),
  handle: Object.freeze({ maxLength: 30, allowClear: true, accepts: ["noor-al-sabah", "noor_2026", "noor.sabah", ""], refuses: ["no", "1noor", "noor al-sabah", "-noor"] }),
  nationality: Object.freeze({ maxLength: 36, allowClear: false, accepts: ["11111111-1111-4111-8111-111111111111"], refuses: ["", "Kuwait", "not-an-id"] }),
  university: Object.freeze({ maxLength: 36, allowClear: true, accepts: ["22222222-2222-4222-8222-222222222222", ""], refuses: ["University", "not-an-id"] }),
  kuwaitiMother: Object.freeze({ maxLength: 5, allowClear: true, accepts: ["true", "false", ""], refuses: ["yes", "1"] }),
} satisfies Record<PersonSelfEditField, { maxLength: number; allowClear: boolean; accepts: readonly string[]; refuses: readonly string[] }>);

const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const NAME = /^[\p{L}\p{M}]+(?:['.-][\p{L}\p{M}]+)*(?: [\p{L}\p{M}]+(?:['.-][\p{L}\p{M}]+)*)+$/u;
const ARABIC_LETTER = /[\u0621-\u063a\u0641-\u064a\u066e-\u066f\u0671-\u06d3\u06fa-\u06fc]/u;

export function validPersonBirthDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validBirthDate(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!validPersonBirthDate(value)) return false;
  const minimum = new Date(`${today}T00:00:00.000Z`); minimum.setUTCFullYear(minimum.getUTCFullYear() - PERSON_PROFILE_MINIMUM_AGE);
  return date <= minimum;
}

export function kuwaitDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isPersonProfileMinimumAge(value: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && validBirthDate(value, today);
}

export type PersonSelfEditInvalidReason = "required" | "length" | "name" | "arabic_name" | "spacing" | "characters" | "date" | "future" | "minimum_age" | "choice" | "contact_unavailable";
export type PersonSelfEditValidation = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: PersonSelfEditInvalidReason };

/** Canonical validation never trims, collapses or truncates the person's input. */
export function validatePersonSelfEditValue(field: PersonSelfEditField, value: unknown, today: string, options: { readonly contactAvailable?: boolean } = {}): PersonSelfEditValidation {
  if (typeof value !== "string") return { ok: false, reason: "characters" };
  let normalized = value.normalize("NFC");
  const rule = SHU372_RULES[field];
  if ([...normalized].length > rule.maxLength) return { ok: false, reason: "length" };
  if (FORBIDDEN.test(normalized)) return { ok: false, reason: "characters" };
  if (normalized === "") return rule.allowClear ? { ok: true, value: "" } : { ok: false, reason: "required" };
  if (field === "phone") {
    normalized = normalized.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, character => String(character.charCodeAt(0) % 16));
    if (!/^[+0-9 ()-]+$/.test(normalized)) return { ok: false, reason: "characters" };
    if (normalized.trim() !== normalized) return { ok: false, reason: "spacing" };
    const compact = normalized.replace(/[ ()-]/g, "");
    const international = compact.startsWith("+") || compact.startsWith("00");
    const digits = compact.startsWith("+") ? compact.slice(1) : compact.startsWith("00") ? compact.slice(2) : compact;
    normalized = digits.length === 8 && !international ? `+965${digits}` : international || digits.startsWith("965") ? `+${digits}` : compact;
  }
  if (field === "gender" && !["male", "female", "other"].includes(normalized)) return { ok: false, reason: "choice" };
  if (field === "birthDate") {
    if (!validPersonBirthDate(normalized) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return { ok: false, reason: "date" };
    if (normalized > today) return { ok: false, reason: "future" };
    if (!validBirthDate(normalized, today)) return { ok: false, reason: "minimum_age" };
  }
  if (field === "drivingLicence" && !["true", "false"].includes(normalized)) return { ok: false, reason: "choice" };
  if (field === "jobSearchStatus" && !["not_looking", "active", "open_to_offers"].includes(normalized)) return { ok: false, reason: "choice" };
  if (field === "phone" && !/^\+[0-9]{8,15}$/.test(normalized)) return { ok: false, reason: "characters" };
  if (field === "handle") normalized = normalized.toLowerCase();
  if (field === "handle" && !/^[a-z][a-z0-9._-]{2,29}$/.test(normalized)) return { ok: false, reason: "characters" };
  if ((field === "nationality" || (field === "university" && normalized !== "")) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) return { ok: false, reason: "choice" };
  if (field === "kuwaitiMother" && !["true", "false"].includes(normalized)) return { ok: false, reason: "choice" };
  if (normalized !== normalized.trim() || /\s{2}/u.test(normalized)) return { ok: false, reason: "spacing" };
  if ((field === "displayName" || field === "arabicName") && !NAME.test(normalized)) return { ok: false, reason: "name" };
  if (field === "arabicName" && !ARABIC_LETTER.test(normalized)) return { ok: false, reason: "arabic_name" };
  if ((field === "phone" || field === "handle") && options.contactAvailable === false) return { ok: false, reason: "contact_unavailable" };
  return { ok: true, value: normalized };
}

export function normalizePersonSelfEditValue(field: PersonSelfEditField, value: unknown, today: string): string | null {
  const result = validatePersonSelfEditValue(field, value, today);
  return result.ok ? result.value : null;
}

export const PERSON_FALLBACK_COMPARISON_V1 = "profile-fallback-v1";

/**
 * Read only when no platform-owned override (including an explicit clear) is shown.
 * U2b must use the same reader for rendering the baseline and for saving it.
 * Revision identifies digest policy, not snapshot freshness. The projector still
 * enforces its fixed approved source revision without alteration or bypass.
 */
export function createPersonImportedFallbackReader(options: {
  readonly source: ApprovedProfileAdapter;
  readonly today?: () => string;
}) {
  const digest = (parts: readonly unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return Object.freeze({
    async read(principalId: string, field: PersonSelfEditField): Promise<BrowserBaseline["shownFallback"]> {
      const link = await options.source.resolveLink(principalId);
      if (link.kind === "unconfigured") return null;
      if (link.kind !== "linked") throw new Error("Approved profile link unavailable");
      const row = await options.source.readCandidate(link.candidateRef);
      if (row === undefined) throw new Error("Approved profile snapshot unavailable");
      const profile = projectApprovedProfile(row, options.today?.() ?? kuwaitDate(new Date()));
      const shown = profile.fields[field];
      if (!shown || shown.state !== "available") return null;
      return Object.freeze({
        sourceRef: digest(["profile-fallback-source-v1", link.candidateRef, shown.provenance.sourceField]),
        valueDigest: digest(["profile-fallback-value-v1", shown.value]),
        revision: PERSON_FALLBACK_COMPARISON_V1,
      });
    },
  });
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
  const clock = options.clock ?? { now: () => new Date() };
  const normalize = <T extends PreviewRequest | ConfirmRequest>(request: T): T | null => {
    if (!PERSON_SELF_EDIT_FIELDS.includes(request.change.field as PersonSelfEditField)) return request;
    const value = normalizePersonSelfEditValue(request.change.field as PersonSelfEditField, request.change.value, kuwaitDate(clock.now()));
    return value === null ? null : { ...request, change: { ...request.change, value } };
  };
  return Object.freeze({
    async preview(request: PreviewRequest): Promise<PreviewResult> {
      const normalized = normalize(request);
      if (normalized && (normalized.change.field === "phone" || normalized.change.field === "handle") && normalized.change.value !== "") {
        const availability = options.store as SafeWriteStore & { contactValueAvailable?: (field: "phone" | "handle", value: string) => Promise<boolean> };
        if (availability.contactValueAvailable && !await availability.contactValueAvailable(normalized.change.field, normalized.change.value)) return { ok: false, reason: "invalid_value" };
      }
      if (normalized && (normalized.change.field === "nationality" || normalized.change.field === "university" || normalized.change.field === "kuwaitiMother")) {
        const availability = options.store as SafeWriteStore & { originValueAvailable?: (field: "nationality" | "university" | "kuwaitiMother", value: string) => Promise<boolean> };
        if (availability.originValueAvailable && !await availability.originValueAvailable(normalized.change.field, normalized.change.value)) return { ok: false, reason: "invalid_value" };
      }
      return normalized ? safeWrite.preview(normalized) : { ok: false, reason: "invalid_value" };
    },
    async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
      const normalized = normalize(request);
      return normalized ? safeWrite.confirm(normalized) : { ok: false, reason: "invalid_value" };
    },
  });
}
